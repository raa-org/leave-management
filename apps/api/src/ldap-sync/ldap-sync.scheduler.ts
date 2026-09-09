/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { describeDirectorySyncFailure } from './directory-sync-failure'
import type { LdapSyncConfig } from './ldap-sync.config'
import type { LdapSyncService } from './ldap-sync.service'
import { LDAP_SYNC_CONFIG, LDAP_SYNC_SERVICE } from './ldap-sync.tokens'

// Named so the job can be found in the SchedulerRegistry (which keys jobs by
// name).
const LDAP_SYNC_JOB = 'ldap-sync'

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the directory sync on the cron schedule from LDAP_SYNC_CRON. The
 * expression is validated at config load and interpreted in the server's
 * timezone (no timeZone override). Lives next to the manual endpoint and shares
 * the same LdapSyncService.
 *
 * Gated on LDAP_SYNC_ENABLED (the injected service is null when off, so no job
 * is registered) and, independently, on LDAP_SYNC_CRON_ENABLED, which switches
 * off this class alone: nothing else in the module reads it, so the manual
 * admin endpoint keeps working exactly as before. That is the point of the
 * second flag — a developer wants the button, not a pass firing unattended
 * against the corporate directory twice a day.
 *
 * Deliberately does NOT run a pass at boot: registering a
 * CronJob does not fire it, so the first automatic pass is the next scheduled
 * boundary — the first production pass (a large one-off deactivation) is run
 * manually via the endpoint, checked, and only then handed to cron.
 */
@Injectable()
export class LdapSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(LdapSyncScheduler.name)

  constructor(
    @Inject(LDAP_SYNC_SERVICE) private readonly sync: LdapSyncService | null,
    @Inject(LDAP_SYNC_CONFIG) private readonly config: LdapSyncConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly domain: LeaveDomainService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.sync || !this.config.enabled) {
      return
    }
    const { cron, cronEnabled } = this.config.settings
    if (!cronEnabled) {
      // Logged at startup rather than left silent: "why did nothing sync
      // overnight" is otherwise answered only by reading an env file, and the
      // absence of the usual "Directory sync scheduled" line is easy to miss.
      // The expression is echoed so the log says what would have run.
      this.logger.log(
        `Directory sync schedule is off (LDAP_SYNC_CRON_ENABLED=false); ` +
          `${cron} is not armed. Manual runs from the admin console are ` +
          `unaffected.`,
      )
      return
    }
    const job = CronJob.from({
      cronTime: cron,
      // tick() catches everything and never rejects, so returning its promise is
      // safe (cron may or may not await it) and lets tests drive one run.
      onTick: () => this.tick(),
    })
    this.schedulerRegistry.addCronJob(LDAP_SYNC_JOB, job)
    job.start()
    this.logger.log(`Directory sync scheduled: ${cron} (server timezone).`)
  }

  private async tick(): Promise<void> {
    if (!this.sync) {
      return
    }
    try {
      const result = await this.sync.runSync()
      if (result.status === 'already-running') {
        // Normal on multiple replicas / overlap with a manual run: the lock
        // picked another runner. Log only, no audit.
        this.logger.log(
          'Scheduled directory sync: another run holds the lock — skipped.',
        )
      } else {
        // completed / empty-directory already wrote their own lifecycle rows.
        this.logger.log(`Scheduled directory sync: ${result.status}.`)
      }
    } catch (error) {
      const message = toMessage(error)
      // No retry — the next scheduled tick is the retry. Record the crash so a
      // failed scheduled run is visible in the audit UI (best-effort: a failing
      // trace must not stop the cron), then swallow.
      try {
        // A scheduled pass has no screen to word the cause on, so the row is
        // the only place it can be said at all.
        await this.domain.recordDirectorySyncFailed({
          error: message,
          summary: describeDirectorySyncFailure(error),
        })
      } catch (auditError) {
        this.logger.error(
          `Failed to record ldap_sync.failed after a scheduled crash: ${toMessage(auditError)}`,
        )
      }
      this.logger.error(`Scheduled directory sync failed: ${message}`)
    }
  }
}
