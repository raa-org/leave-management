/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser, JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import { AppRoleName } from '@workspace/contracts'
import type {
  DirectorySyncResultDto,
  DirectorySyncStatusDto,
} from '@workspace/contracts'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { describeDirectorySyncFailure } from './directory-sync-failure'
import type { LdapSyncConfig } from './ldap-sync.config'
import type { LdapSyncService } from './ldap-sync.service'
import { LDAP_SYNC_CONFIG, LDAP_SYNC_SERVICE } from './ldap-sync.tokens'

/**
 * Manual, admin-only trigger for the LDAP directory sync. Scheduled runs
 * go through the same LdapSyncService; this endpoint is the
 * "run it now and show me the report" path — and the way the first production
 * pass is done consciously (POST it, read the lifecycle row) before handing the
 * feature over to cron.
 *
 * The advisory lock inside the domain transaction guarantees a manual click can
 * never overlap a scheduled pass: whichever loses gets `already-running`.
 */
@Controller('admin/ldap-sync')
@UseGuards(JwtAuthGuard)
export class LdapSyncController {
  private readonly logger = new Logger(LdapSyncController.name)

  constructor(
    // Null when LDAP_SYNC_ENABLED is not 'true': the feature is configured off
    // in this deployment, so the module's factory built no client/service.
    @Inject(LDAP_SYNC_SERVICE) private readonly sync: LdapSyncService | null,
    @Inject(LeaveDomainService) private readonly domain: LeaveDomainService,
    @Inject(LDAP_SYNC_CONFIG) private readonly config: LdapSyncConfig,
  ) {}

  /**
   * What the directory page needs before it can offer a sync: whether this
   * deployment has the feature at all.
   *
   * Unlike POST this never answers 409 for a disabled feature — `enabled: false`
   * IS the answer, and the web hides the button on it. A 409 here would force
   * the caller to read a failure as a normal state.
   */
  @Get()
  status(@CurrentUser() user: UserProfileType): DirectorySyncStatusDto {
    // Authorized first, on the same reasoning as the POST below.
    if (!user.roles.includes(AppRoleName.Administrator)) {
      throw new ForbiddenException('Administrator access required.')
    }

    // Read from the config, which is what the deployment actually declared. The
    // null service is downstream of the same flag today, but it answers "is a
    // client wired up", and a future reason for it to be absent would quietly
    // turn into "this company has no directory".
    return { enabled: this.config.enabled }
  }

  @Post()
  // 200, not the POST default 201: none of the outcomes creates a resource
  // (already-running and empty-directory change nothing), and the client
  // branches on the body's `status`, not the status code.
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() user: UserProfileType,
  ): Promise<DirectorySyncResultDto> {
    // Authorize FIRST: whether the sync is enabled is a deployment detail a
    // non-admin has no business learning, so a non-admin always gets 403 —
    // never a 409 that would confirm the feature exists.
    if (!user.roles.includes(AppRoleName.Administrator)) {
      throw new ForbiddenException('Administrator access required.')
    }
    // A real, documented endpoint that is simply switched off here: 409, not a
    // 404 that would pretend the route does not exist. The web only shows the
    // button when enabled, so this mostly guards direct calls.
    if (!this.sync) {
      throw new ConflictException(
        'Directory sync is disabled (LDAP_SYNC_ENABLED is not set).',
      )
    }

    try {
      // Synchronous by design: the caller (an admin, watching the button's
      // spinner) waits for the full pass and gets the report back.
      // already-running and empty-directory are normal outcomes, returned as
      // status — not errors.
      return await this.sync.runSync()
    } catch (error) {
      // A crashed manual run must leave a trace. The domain transaction
      // (if one opened) has already rolled back, so this writes on the
      // non-transactional manager — the same writer the scheduler's catch uses.
      const message = error instanceof Error ? error.message : String(error)
      // Worded once and used twice: the administrator's screen and the audit
      // row must not disagree about what failed.
      const summary = describeDirectorySyncFailure(error)
      // The server log carries the raw cause with its stack: an operator
      // reading logs needs the host and the driver error that the admin's
      // screen deliberately does not show.
      this.logger.error(
        `Manual directory sync failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      )
      // Best-effort: when the crash cause is the DB being down, this trace write
      // fails too. Swallow it (logging the miss) so the caller still gets the
      // clean 500 below rather than the raw persistence error — a failing trace
      // must never replace the failure it was meant to record.
      try {
        await this.domain.recordDirectorySyncFailed({
          error: message,
          summary,
        })
      } catch (auditError) {
        this.logger.error(
          `Failed to record the ldap_sync.failed lifecycle row after a sync ` +
            `crash (original error: ${message}): ${
              auditError instanceof Error ? auditError.message : String(auditError)
            }`,
        )
      }
      // Names the cause, not the plumbing: the admin learns whether this is
      // theirs to fix or the directory administrator's, while hosts, ports and
      // base DNs stay in the audit trail and the log line above.
      throw new InternalServerErrorException(summary)
    }
  }
}
