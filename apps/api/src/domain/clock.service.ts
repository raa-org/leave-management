/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Injectable, Logger } from '@nestjs/common'

/**
 * The single source of "now" for the leave domain. Every timestamp the domain
 * stamps itself (accrual as-of, spend recognition, submission/decision time,
 * dashboard generatedAt, audit occurredAt) flows through here instead of calling
 * `new Date()` directly.
 *
 * In production it returns the real wall clock. In non-production, when
 * `TEST_TOOLING_ENABLED=true`, an administrator can shift the clock by an in-memory
 * offset so the WHOLE system behaves as if it were another date — letting QA
 * walk accrual and spend forward to year-end without physically waiting. The
 * offset is process-local and cleared on restart.
 *
 * Two safety layers keep this out of production: the offset is only honored when
 * the env flag is on (`effectiveOffsetMs`), and the mutators refuse outright when
 * it is off (`assertEnabled`). The flag must never be set in a production
 * environment.
 */
@Injectable()
export class ClockService {
  private readonly logger = new Logger(ClockService.name)
  private readonly testToolingEnabled =
    process.env['TEST_TOOLING_ENABLED'] === 'true'
  // Milliseconds added to the real clock; 0 means real time. Only applied when
  // the test clock is enabled.
  private offsetMs = 0

  /** Current instant, shifted by the test-tooling offset when enabled. */
  now(): Date {
    return new Date(Date.now() + this.effectiveOffsetMs())
  }

  /** Current instant as an ISO-8601 string (the domain's timestamp contract). */
  nowIso(): string {
    return this.now().toISOString()
  }

  // Deliberately no today(): a calendar day only means something in a
  // timezone, and the one that matters is the employee's, not the server's.
  // Use localDayIso(clock.nowIso(), tz) — see LeaveDomainService.resolveAsOfTx.

  isTestToolingEnabled(): boolean {
    return this.testToolingEnabled
  }

  /** The offset actually in effect (0 unless the test clock is enabled and set). */
  getOffsetMs(): number {
    return this.effectiveOffsetMs()
  }

  /**
   * Shift the clock so that `now()` returns approximately `targetIso` and then
   * keeps ticking from there. Refused when the test clock is disabled, so it can
   * never take effect in production.
   */
  setNow(targetIso: string): void {
    this.assertEnabled()
    const target = new Date(targetIso)
    if (Number.isNaN(target.getTime())) {
      throw new Error(`Invalid test-tooling timestamp: ${targetIso}`)
    }
    this.offsetMs = target.getTime() - Date.now()
    this.logger.warn(
      `Test clock set to ${target.toISOString()} (offset ${this.offsetMs} ms).`,
    )
  }

  /** Shift the clock by a raw millisecond offset from real time. */
  setOffsetMs(offsetMs: number): void {
    this.assertEnabled()
    if (!Number.isFinite(offsetMs)) {
      throw new Error(`Invalid test-tooling offset: ${String(offsetMs)}`)
    }
    this.offsetMs = offsetMs
    this.logger.warn(`Test clock offset set to ${offsetMs} ms.`)
  }

  /** Return to real time. */
  reset(): void {
    this.offsetMs = 0
    this.logger.warn('Test clock reset to real time.')
  }

  private effectiveOffsetMs(): number {
    return this.testToolingEnabled ? this.offsetMs : 0
  }

  private assertEnabled(): void {
    if (!this.testToolingEnabled) {
      throw new Error(
        'Test tooling is disabled (TEST_TOOLING_ENABLED is not "true").',
      )
    }
  }
}
