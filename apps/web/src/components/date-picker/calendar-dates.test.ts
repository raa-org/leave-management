/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  chargeableDates,
  costOfDates,
  countChargeableDays,
  isoToLocalDate,
  localDateToIso,
} from './calendar-dates'

// The web tsconfig types the app as browser-only (`types: ["vite/client"]`), and
// pulling @types/node in for one spec would weaken that on purpose-built browser
// code. These specs run under the node environment, where `process` exists, so
// declare just the sliver we touch. Node re-reads TZ on each Date construction,
// which is what makes the per-zone assertions below possible.
declare const process: { env: { TZ?: string } }

// Extreme offsets on both sides of UTC plus a zone whose DST transition happens
// AT midnight — the three shapes that break naive `new Date(iso)` /
// `toISOString()` conversion.
const ZONES = [
  'UTC',
  'Pacific/Kiritimati', // +14
  'Pacific/Niue', // -11
  'America/Santiago', // DST changes at midnight
  'Europe/Kyiv',
]

const originalTz = process.env.TZ

afterAll(() => {
  process.env.TZ = originalTz
})

function isoSequence(startIso: string, days: number): string[] {
  const dates: string[] = []
  const cursor = new Date(`${startIso}T00:00:00.000Z`)
  for (let index = 0; index < days; index += 1) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

describe('calendar-dates', () => {
  it('round-trips every date of 2026 in every timezone', () => {
    const dates = isoSequence('2026-01-01', 365)

    for (const zone of ZONES) {
      process.env.TZ = zone
      const mismatches = dates.filter((iso) => localDateToIso(isoToLocalDate(iso)) !== iso)
      expect(mismatches, `round-trip failed in ${zone}`).toEqual([])
    }
  })

  it('keeps the calendar day stable rather than the instant', () => {
    // The same calendar date must render as the same day everywhere. A UTC-based
    // conversion would report 2026-08-11 in Pacific/Niue.
    for (const zone of ZONES) {
      process.env.TZ = zone
      const date = isoToLocalDate('2026-08-12')
      expect(date.getFullYear()).toBe(2026)
      expect(date.getMonth()).toBe(7)
      expect(date.getDate()).toBe(12)
    }
  })

  it('round-trips a year below 100 without remapping it into the 1900s', () => {
    process.env.TZ = 'UTC'
    expect(localDateToIso(isoToLocalDate('0099-01-05'))).toBe('0099-01-05')
  })

  describe('countChargeableDays', () => {
    it('excludes weekends', () => {
      process.env.TZ = 'UTC'
      // Wed 2026-08-12 .. Mon 2026-08-17: Sat 15 and Sun 16 are free.
      expect(countChargeableDays('2026-08-12', '2026-08-17', new Set())).toBe(4)
    })

    it('excludes official holidays as well as weekends', () => {
      process.env.TZ = 'UTC'
      expect(
        countChargeableDays('2026-08-12', '2026-08-17', new Set(['2026-08-13'])),
      ).toBe(3)
    })

    it('counts a single working day as one', () => {
      process.env.TZ = 'UTC'
      expect(countChargeableDays('2026-08-12', '2026-08-12', new Set())).toBe(1)
    })

    it('reports zero for a single day that is a weekend or a holiday', () => {
      process.env.TZ = 'UTC'
      // 2026-08-15 is a Saturday. The server rejects such a request outright, so
      // the composer has to be able to say so before submitting.
      expect(countChargeableDays('2026-08-15', '2026-08-15', new Set())).toBe(0)
      expect(
        countChargeableDays('2026-08-12', '2026-08-12', new Set(['2026-08-12'])),
      ).toBe(0)
    })

    it('reports zero for an empty or inverted period', () => {
      process.env.TZ = 'UTC'
      expect(countChargeableDays('', '', new Set())).toBe(0)
      expect(countChargeableDays('2026-08-17', '2026-08-12', new Set())).toBe(0)
    })

    it('counts across a year boundary', () => {
      process.env.TZ = 'UTC'
      // Mon 2026-12-28 .. Mon 2027-01-04: Sat 2 and Sun 3 are free.
      expect(countChargeableDays('2026-12-28', '2027-01-04', new Set())).toBe(6)
    })

    it('stays a count of DATES however short the days are booked', () => {
      process.env.TZ = 'UTC'
      // The no-working-days rule the server refuses on, and the submit gate
      // that mirrors it, are both about whether there is a chargeable date at
      // all - never about what the dates cost.
      expect(countChargeableDays('2026-08-12', '2026-08-14', new Set())).toBe(3)
    })
  })

  describe('chargeableDates', () => {
    it('lists the working dates in order', () => {
      process.env.TZ = 'UTC'
      // Wed 12 .. Mon 17 August 2026, with Thursday a public holiday.
      expect(
        chargeableDates('2026-08-12', '2026-08-17', new Set(['2026-08-13'])),
      ).toEqual(['2026-08-12', '2026-08-14', '2026-08-17'])
    })

    it('answers empty for a range that is not a range', () => {
      process.env.TZ = 'UTC'
      expect(chargeableDates('', '', new Set())).toEqual([])
      expect(chargeableDates('2026-08-17', '2026-08-12', new Set())).toEqual([])
    })
  })

  describe('costOfDates', () => {
    const DATES = ['2026-08-12', '2026-08-13', '2026-08-14']

    it('prices an untouched selection as whole days', () => {
      expect(costOfDates(DATES, {}, 8)).toBe(3)
    })

    it('prices a shortened date as its hours', () => {
      // Two whole days plus four hours of the third.
      expect(costOfDates(DATES, { '2026-08-14': 4 }, 8)).toBe(2.5)
      // Two hours, a whole day, four hours.
      expect(
        costOfDates(DATES, { '2026-08-12': 2, '2026-08-14': 4 }, 8),
      ).toBe(1.75)
    })

    it('quantizes once, at the end, to the three decimals the books store', () => {
      // A seven-hour workday stores one hour as 0.143, a shade over a seventh:
      // summing the quantized portions and quantizing again must not drift.
      expect(
        costOfDates(DATES, { '2026-08-12': 1, '2026-08-13': 1 }, 7),
      ).toBe(1.286)
    })

    it('ignores hours booked against dates the range does not charge', () => {
      // A stale entry left behind by a moved range prices nothing: the server
      // refuses such a date outright, so it must never reach the payload.
      expect(costOfDates(DATES, { '2026-08-15': 4 }, 8)).toBe(3)
    })

    it('costs nothing when there is nothing to charge', () => {
      expect(costOfDates([], { '2026-08-12': 4 }, 8)).toBe(0)
    })
  })
})
