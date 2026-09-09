/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClockService } from './clock.service'

describe('ClockService', () => {
  const originalFlag = process.env['TEST_TOOLING_ENABLED']

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env['TEST_TOOLING_ENABLED']
    } else {
      process.env['TEST_TOOLING_ENABLED'] = originalFlag
    }
    vi.useRealTimers()
  })

  it('returns real time and refuses overrides when the test clock is disabled', () => {
    delete process.env['TEST_TOOLING_ENABLED']
    const clock = new ClockService()

    expect(clock.isTestToolingEnabled()).toBe(false)
    expect(() => clock.setNow('2026-12-31T00:00:00.000Z')).toThrow()
    expect(() => clock.setOffsetMs(1000)).toThrow()
    expect(clock.getOffsetMs()).toBe(0)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T10:00:00.000Z'))
    expect(clock.nowIso()).toBe('2026-07-14T10:00:00.000Z')
  })

  it('shifts now() to a target date and keeps ticking when enabled', () => {
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))

    clock.setNow('2026-12-31T00:00:00.000Z')
    expect(clock.nowIso()).toBe('2026-12-31T00:00:00.000Z')

    // Advancing real time advances the shifted clock by the same amount.
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'))
    expect(clock.nowIso()).toBe('2027-01-01T00:00:00.000Z')

    clock.reset()
    expect(clock.nowIso()).toBe('2026-07-15T00:00:00.000Z')
    expect(clock.getOffsetMs()).toBe(0)
  })

  it('applies a raw millisecond offset when enabled', () => {
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))

    clock.setOffsetMs(24 * 60 * 60 * 1000)
    expect(clock.nowIso()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('rejects an invalid target timestamp', () => {
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    expect(() => clock.setNow('not-a-date')).toThrow()
  })
})
