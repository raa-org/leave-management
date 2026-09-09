/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { endOfDayUtc, localDayIso } from './workday'

describe('endOfDayUtc', () => {
  it('ends a day at its own midnight (Kyiv winter, UTC+2)', () => {
    expect(endOfDayUtc('2026-02-03', 'Europe/Kyiv').toISOString()).toBe(
      '2026-02-03T22:00:00.000Z',
    )
  })

  it('is DST-correct (Kyiv summer, UTC+3)', () => {
    expect(endOfDayUtc('2026-07-15', 'Europe/Kyiv').toISOString()).toBe(
      '2026-07-15T21:00:00.000Z',
    )
  })

  it('uses the offset in force at the END of the day, across a spring shift', () => {
    // Kyiv moves +2 -> +3 on 29 March 2026. The 28th ends at the 29th's
    // midnight, which is still +2; the 29th itself ends at +3.
    expect(endOfDayUtc('2026-03-28', 'Europe/Kyiv').toISOString()).toBe(
      '2026-03-28T22:00:00.000Z',
    )
    expect(endOfDayUtc('2026-03-29', 'Europe/Kyiv').toISOString()).toBe(
      '2026-03-29T21:00:00.000Z',
    )
  })

  it('crosses the UTC date line for a zone behind UTC', () => {
    // Los Angeles midnight is the next UTC day, which is exactly why the
    // instant cannot be derived from the day string alone.
    expect(endOfDayUtc('2026-08-05', 'America/Los_Angeles').toISOString()).toBe(
      '2026-08-06T07:00:00.000Z',
    )
  })

  it('ends the last day of a month and of a year correctly', () => {
    expect(endOfDayUtc('2026-01-31', 'Europe/Kyiv').toISOString()).toBe(
      '2026-01-31T22:00:00.000Z',
    )
    expect(endOfDayUtc('2026-12-31', 'Europe/Kyiv').toISOString()).toBe(
      '2026-12-31T22:00:00.000Z',
    )
    // A leap day, so the arithmetic cannot be a naive date-string increment.
    expect(endOfDayUtc('2028-02-29', 'Europe/Kyiv').toISOString()).toBe(
      '2028-02-29T22:00:00.000Z',
    )
  })

  it('falls back to the default timezone on an unrecognized zone', () => {
    expect(endOfDayUtc('2026-02-03', 'Not/AZone').toISOString()).toBe(
      '2026-02-03T22:00:00.000Z',
    )
  })
})

describe('localDayIso', () => {
  it('is already the next year for a zone ahead of UTC', () => {
    // The two hours in which UTC and Kyiv disagree about the year. Accrual
    // reads the day, so on this instant the new leave year has begun.
    expect(localDayIso('2026-12-31T22:00:00.000Z', 'Europe/Kyiv')).toBe(
      '2027-01-01',
    )
    expect(localDayIso('2026-12-31T21:59:59.000Z', 'Europe/Kyiv')).toBe(
      '2026-12-31',
    )
  })

  it('is still the old year for a zone behind UTC', () => {
    expect(localDayIso('2027-01-01T01:00:00.000Z', 'America/New_York')).toBe(
      '2026-12-31',
    )
    expect(localDayIso('2027-01-01T05:00:00.000Z', 'America/New_York')).toBe(
      '2027-01-01',
    )
  })

  it('is DST-correct: the month flips an hour earlier in Kyiv summer', () => {
    // Kyiv is UTC+3 in July, so 21:30 UTC is already August there. A fixed
    // offset would put the tranche in the wrong month one night a year.
    expect(localDayIso('2026-07-31T21:30:00.000Z', 'Europe/Kyiv')).toBe(
      '2026-08-01',
    )
    expect(localDayIso('2026-07-31T20:30:00.000Z', 'Europe/Kyiv')).toBe(
      '2026-07-31',
    )
  })

  it('handles the far side of the date line', () => {
    expect(localDayIso('2026-06-30T23:30:00.000Z', 'Pacific/Kiritimati')).toBe(
      '2026-07-01',
    )
  })

  it('falls back to the default timezone on an unrecognized zone', () => {
    expect(localDayIso('2026-12-31T22:00:00.000Z', 'Not/AZone')).toBe(
      '2027-01-01',
    )
  })
})
