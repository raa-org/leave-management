/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser, JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import { ClockService } from '../domain/clock.service'
import { toAuditActor } from '../domain/audit-log.service'
import { isAdministrator } from '../domain/leave-viewer-context'
import {
  DirectoryConflictError,
  LeaveDomainNotFoundError,
  LeaveDomainService,
  LeaveDomainValidationError,
} from '../domain/leave-domain.service'

// Test-only endpoint payloads. Kept local (not in shared contracts): this route
// is a QA/staging affordance, not part of the product API surface.
interface TestToolingStateDto {
  enabled: boolean
  now: string
  offsetMs: number
}

interface SetTestToolingDto {
  now?: string
  offsetMs?: number
}

interface ResetUserDto {
  userId?: string
}

interface ResetUserResultDto {
  userId: string
  displayName: string
}

interface ResetDirectoryDto {
  keep?: string[]
  all?: boolean
  clearAudit?: boolean
}

interface ResetDirectoryResultDto {
  deletedUsers: number
  deletedRequests: number
  deletedLedgerEntries: number
  deletedDeliveries: number
  clearedAuditLogs: number
}

/**
 * Administrator-only test tooling: the shiftable "Time-travelling" server clock
 * (move the whole leave domain to another date so accrual and spend can be
 * exercised up to year-end without waiting), plus destructive reset affordances
 * — reset one user's leave data, or wipe the user population for a clean LDAP
 * sync run. Guarded twice: every endpoint 404s unless TEST_TOOLING_ENABLED=true
 * (so the route is indistinguishable from "not found" in production), and
 * ClockService itself refuses clock mutations when the flag is off.
 */
@Controller('admin/test-tooling')
@UseGuards(JwtAuthGuard)
export class TestToolingController {
  constructor(
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(LeaveDomainService) private readonly leaveDomain: LeaveDomainService,
  ) {}

  @Get()
  getState(@CurrentUser() user: UserProfileType): TestToolingStateDto {
    this.assertEnabledAndAdmin(user)
    return this.state()
  }

  @Post()
  setClock(
    @CurrentUser() user: UserProfileType,
    @Body() body: SetTestToolingDto,
  ): TestToolingStateDto {
    this.assertEnabledAndAdmin(user)
    try {
      if (typeof body?.now === 'string') {
        this.clock.setNow(body.now)
      } else if (typeof body?.offsetMs === 'number') {
        this.clock.setOffsetMs(body.offsetMs)
      } else {
        throw new BadRequestException(
          'Provide either "now" (ISO timestamp) or "offsetMs" (number).',
        )
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error
      }
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid test-tooling input.',
      )
    }
    return this.state()
  }

  @Delete()
  reset(@CurrentUser() user: UserProfileType): TestToolingStateDto {
    this.assertEnabledAndAdmin(user)
    this.clock.reset()
    return this.state()
  }

  // Wipe one user's leave requests + balance/ledger back to a clean slate so a
  // scenario can be re-run. Guarded exactly like the clock endpoints.
  @Post('reset-user')
  async resetUser(
    @CurrentUser() user: UserProfileType,
    @Body() body: ResetUserDto,
  ): Promise<ResetUserResultDto> {
    this.assertEnabledAndAdmin(user)
    if (typeof body?.userId !== 'string' || body.userId.trim() === '') {
      throw new BadRequestException('A userId is required.')
    }
    try {
      const record = await this.leaveDomain.resetUserLeaveData({
        userId: body.userId,
        audit: toAuditActor(user),
      })
      return { userId: record.userId, displayName: record.displayName }
    } catch (error) {
      if (error instanceof LeaveDomainNotFoundError) {
        throw new NotFoundException(`Unknown user: ${body.userId}`)
      }
      throw error
    }
  }

  // Wipe the user population so an LDAP sync can be observed from a clean slate:
  // `keep` (emails) preserves individuals, and wiping everyone must be confirmed
  // with `all: true` so a bodyless request cannot do it. `clearAudit` also
  // empties the audit_logs table. Guarded exactly like the clock endpoints.
  @Post('reset-directory')
  async resetDirectory(
    @CurrentUser() user: UserProfileType,
    @Body() body: ResetDirectoryDto,
  ): Promise<ResetDirectoryResultDto> {
    this.assertEnabledAndAdmin(user)
    const keep = body?.keep
    if (
      keep !== undefined &&
      (!Array.isArray(keep) ||
        // A blank entry protects nobody and normalizes to an empty address,
        // which would otherwise surface as a refusal naming no one at all.
        keep.some((email) => typeof email !== 'string' || email.trim() === ''))
    ) {
      throw new BadRequestException(
        '"keep" must be an array of non-blank email strings.',
      )
    }
    // The booleans are validated as strictly as `keep`: a string "true" (an
    // untyped curl, a form) coerced to false would refuse the wipe with
    // "requires all=true" — a baffling answer to a caller who did pass it.
    const all = body?.all
    if (all !== undefined && typeof all !== 'boolean') {
      throw new BadRequestException('"all" must be a boolean.')
    }
    const clearAudit = body?.clearAudit
    if (clearAudit !== undefined && typeof clearAudit !== 'boolean') {
      throw new BadRequestException('"clearAudit" must be a boolean.')
    }
    try {
      // Defaulting is the domain's to own, so the validated optionals travel
      // as-is rather than being defaulted a second time here.
      return await this.leaveDomain.resetDirectory({
        keep,
        all,
        clearAudit,
        audit: toAuditActor(user),
      })
    } catch (error) {
      // Losing to a concurrent sync or writer is a temporary state, not a bad
      // request: 409 tells the caller the same call works once things settle.
      if (error instanceof DirectoryConflictError) {
        throw new ConflictException(error.message)
      }
      // A contradictory or unconfirmed request, a keep address matching nobody,
      // or the tooling flag being off is a caller mistake, not a server fault.
      if (error instanceof LeaveDomainValidationError) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  private state(): TestToolingStateDto {
    return {
      enabled: this.clock.isTestToolingEnabled(),
      now: this.clock.nowIso(),
      offsetMs: this.clock.getOffsetMs(),
    }
  }

  private assertEnabledAndAdmin(user: UserProfileType): void {
    // Check enabled FIRST and 404, so in production (test tooling off) the route
    // is indistinguishable from a non-existent one regardless of the caller's role.
    if (!this.clock.isTestToolingEnabled()) {
      throw new NotFoundException()
    }
    if (!isAdministrator(user.roles)) {
      throw new ForbiddenException('Administrator access required.')
    }
  }
}
