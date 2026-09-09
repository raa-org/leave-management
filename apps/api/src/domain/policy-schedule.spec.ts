/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { LeaveType } from '@workspace/contracts'
import { roundDays } from './day-math'
import {
  carryoverCapBaseDays,
  deriveYearSchedule,
  legacyScheduleFromTotal,
  pieceTargetDays,
  scheduleYearEndTotal,
  vacationRateForYear,
} from './policy-schedule'
import type {
  MembershipRowInput,
  PolicyTermsInput,
  PolicyYearSchedule,
} from './policy-schedule'

const policy = (
  policyId: string,
  vacationDays: number,
  sickDays: number,
  overrides: Partial<PolicyTermsInput> = {},
): PolicyTermsInput => ({
  policyId,
  name: policyId,
  vacationDays,
  sickDays,
  vacationAnnualIncrement: 0,
  vacationIncrementEveryYears: 1,
  vacationIncrementCapDays: null,
  ...overrides,
})

const row = (
  policyId: string,
  effectiveFrom: string,
  overrides: Partial<MembershipRowInput> = {},
): MembershipRowInput => ({
  policyId,
  effectiveFrom,
  effectiveTo: null,
  supersededByRowId: null,
  ...overrides,
})

const byId = (...policies: PolicyTermsInput[]): Map<string, PolicyTermsInput> =>
  new Map(policies.map((terms) => [terms.policyId, terms]))

const ownership = (schedule: PolicyYearSchedule | null): string[] =>
  (schedule?.segments ?? []).map(
    (segment) =>
      `${segment.policyId}:${segment.firstMonth}-${segment.lastMonth}`,
  )

describe('vacationRateForYear', () => {
  it('applies increment steps anchored to the hire year, with the cap', () => {
    const terms = policy('p', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 35,
    })
    expect(vacationRateForYear(terms, 2026, 2026)).toBe(25)
    expect(vacationRateForYear(terms, 2019, 2026)).toBe(35) // 25 + 2*7 = 39, capped
    expect(vacationRateForYear(terms, 2024, 2026)).toBe(29)
  })

  it('yields the base rate when the hire date is unknown', () => {
    const terms = policy('p', 25, 5, { vacationAnnualIncrement: 2 })
    expect(vacationRateForYear(terms, null, 2030)).toBe(25)
  })

  it('steps once per completed period: +5 every 3 years from a 2024 hire', () => {
    const terms = policy('p', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })
    expect(vacationRateForYear(terms, 2024, 2024)).toBe(25)
    expect(vacationRateForYear(terms, 2024, 2025)).toBe(25)
    expect(vacationRateForYear(terms, 2024, 2026)).toBe(25)
    expect(vacationRateForYear(terms, 2024, 2027)).toBe(30)
    expect(vacationRateForYear(terms, 2024, 2030)).toBe(35)
  })

  it('never fires a period longer than the career', () => {
    const terms = policy('p', 20, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 40,
    })
    for (let year = 2000; year <= 2039; year++) {
      expect(vacationRateForYear(terms, 2000, year)).toBe(20)
    }
    expect(vacationRateForYear(terms, 2000, 2040)).toBe(25)
  })

  it('expresses a ONE-OFF rise as a period plus a cap of base + increment', () => {
    const terms = policy('p', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
      vacationIncrementCapDays: 30,
    })
    expect(
      [2024, 2025, 2026, 2027, 2028, 2030, 2040].map((year) =>
        vacationRateForYear(terms, 2024, year),
      ),
    ).toEqual([25, 25, 25, 30, 30, 30, 30])
  })

  // Clamping the elapsed years AFTER the division would floor a negative
  // quotient to -2 and hand back base - 2*increment, which the caller writes
  // into leave_allocations.totalDays.
  it('gives a hire date in the future the base rate, never a negative one', () => {
    const terms = policy('p', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })
    expect(vacationRateForYear(terms, 2031, 2026)).toBe(25)
    expect(vacationRateForYear(terms, 2100, 2026)).toBe(25)
  })

  it('yields the base rate for an unknown hire date under a period, not NaN', () => {
    const terms = policy('p', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })
    const rate = vacationRateForYear(terms, null, 2030)
    expect(Number.isNaN(rate)).toBe(false)
    expect(rate).toBe(25)
  })

  // Every policy written before the period existed carries 1, so period 1 must
  // reproduce the pre-period formula for every combination, not just typical
  // ones.
  it('reproduces the every-year formula exactly at period 1', () => {
    for (const increment of [0, 1, 2, 5, 0.5]) {
      for (const cap of [null, 30, 35]) {
        for (const hireYear of [2019, 2024, 2026, 2030]) {
          for (let year = 2024; year <= 2032; year++) {
            const terms = policy('p', 25, 5, {
              vacationAnnualIncrement: increment,
              vacationIncrementEveryYears: 1,
              vacationIncrementCapDays: cap,
            })
            const grown = 25 + increment * Math.max(0, year - hireYear)
            expect(vacationRateForYear(terms, hireYear, year)).toBe(
              roundDays(cap === null ? grown : Math.min(grown, cap)),
            )
          }
        }
      }
    }
  })
})

describe('deriveYearSchedule', () => {
  it('returns null for an empty timeline (legacy fallback)', () => {
    expect(deriveYearSchedule(2026, [], byId(), '2019-01-01')).toBeNull()
  })

  it('ignores superseded rows', () => {
    const schedule = deriveYearSchedule(
      2026,
      [
        row('erased', '2026-03-01', { supersededByRowId: 'x' }),
        row('live', '2026-05-01'),
      ],
      byId(policy('erased', 10, 0), policy('live', 25, 5)),
      '2019-01-01',
    )
    expect(ownership(schedule)).toEqual(['live:1-12'])
  })

  it('extends the earliest membership backward in time', () => {
    const schedule = deriveYearSchedule(
      2026,
      [row('p1', '2026-06-15')],
      byId(policy('p1', 25, 5)),
      '2019-01-01',
    )
    expect(ownership(schedule)).toEqual(['p1:1-12'])
    expect(schedule?.changedDuringYear).toBe(false)
  })

  it('snaps a mid-month boundary by the half-month rule (31-day month: day 17 owns, day 18 does not)', () => {
    const policies = byId(policy('old', 15, 5), policy('new', 25, 5))
    const owns = deriveYearSchedule(
      2026,
      [row('old', '2020-01-01', { effectiveTo: '2026-07-17' }), row('new', '2026-07-17')],
      policies,
      '2019-01-01',
    )
    expect(ownership(owns)).toEqual(['old:1-6', 'new:7-12'])
    const late = deriveYearSchedule(
      2026,
      [row('old', '2020-01-01', { effectiveTo: '2026-07-18' }), row('new', '2026-07-18')],
      policies,
      '2019-01-01',
    )
    expect(ownership(late)).toEqual(['old:1-7', 'new:8-12'])
  })

  it('uses the 30-day and February thresholds of the shared half-month rule', () => {
    const policies = byId(policy('old', 15, 5), policy('new', 25, 5))
    expect(
      ownership(
        deriveYearSchedule(
          2026,
          [row('old', '2020-01-01'), row('new', '2026-06-16')],
          policies,
          '2019-01-01',
        ),
      ),
    ).toEqual(['old:1-5', 'new:6-12'])
    expect(
      ownership(
        deriveYearSchedule(
          2026,
          [row('old', '2020-01-01'), row('new', '2026-06-17')],
          policies,
          '2019-01-01',
        ),
      ),
    ).toEqual(['old:1-6', 'new:7-12'])
    // Non-leap February: day 15 owns the month, day 16 does not.
    expect(
      ownership(
        deriveYearSchedule(
          2026,
          [row('old', '2020-01-01'), row('new', '2026-02-15')],
          policies,
          '2019-01-01',
        ),
      ),
    ).toEqual(['old:1-1', 'new:2-12'])
    // Leap February (2028): day 16 still owns the month.
    expect(
      ownership(
        deriveYearSchedule(
          2028,
          [row('old', '2020-01-01'), row('new', '2028-02-16')],
          policies,
          '2019-01-01',
        ),
      ),
    ).toEqual(['old:1-1', 'new:2-12'])
  })

  it('gives a second-half-of-December boundary nothing this year and the whole next year', () => {
    const policies = byId(policy('old', 15, 5), policy('new', 25, 5))
    const timeline = [
      row('old', '2020-01-01', { effectiveTo: '2026-12-20' }),
      row('new', '2026-12-20'),
    ]
    expect(ownership(deriveYearSchedule(2026, timeline, policies, '2019-01-01'))).toEqual([
      'old:1-12',
    ])
    expect(ownership(deriveYearSchedule(2027, timeline, policies, '2019-01-01'))).toEqual([
      'new:1-12',
    ])
  })

  it('lets the later boundary win when two snap into the same month', () => {
    const policies = byId(
      policy('base', 15, 5),
      policy('a', 20, 5),
      policy('b', 25, 5),
    )
    const schedule = deriveYearSchedule(
      2026,
      [
        row('base', '2020-01-01', { effectiveTo: '2026-07-05' }),
        row('a', '2026-07-05', { effectiveTo: '2026-07-10' }),
        row('b', '2026-07-10'),
      ],
      policies,
      '2019-01-01',
    )
    expect(ownership(schedule)).toEqual(['base:1-6', 'b:7-12'])
  })

  it('throws when a referenced policy is not loaded', () => {
    expect(() =>
      deriveYearSchedule(2026, [row('ghost', '2020-01-01')], byId(), '2019-01-01'),
    ).toThrow('ghost')
  })
})

describe('pieceTargetDays', () => {
  it('degenerates bit-identically to the scalar formula for single-segment years', () => {
    for (const totalDays of [0, 10, 15, 20, 24, 25, 28, 33.5]) {
      for (let hireMonth = 1; hireMonth <= 12; hireMonth++) {
        for (let months = 0; months <= 13 - hireMonth; months++) {
          const schedule = legacyScheduleFromTotal(totalDays)
          const scalarVacation =
            months <= 0 ? 0 : roundDays(roundDays((totalDays * months) / 12) + 3)
          expect(
            pieceTargetDays(LeaveType.Vacation, schedule, 3, hireMonth, months),
          ).toBe(scalarVacation)
          const scalarSick =
            months <= 0
              ? 0
              : roundDays(roundDays((totalDays * (13 - hireMonth)) / 12) + 0)
          expect(
            pieceTargetDays(LeaveType.Sick, schedule, 0, hireMonth, months),
          ).toBe(scalarSick)
        }
      }
    }
  })

  it('spreads the remainder across a mid-year rate change: 15 to 25 at July lands exactly on 20', () => {
    const schedule: PolicyYearSchedule = {
      segments: [
        { policyId: 'old', policyName: 'old', vacationRate: 15, sickBase: 5, firstMonth: 1, lastMonth: 6 },
        { policyId: 'new', policyName: 'new', vacationRate: 25, sickBase: 5, firstMonth: 7, lastMonth: 12 },
      ],
      changedDuringYear: true,
    }
    const target = (m: number): number =>
      pieceTargetDays(LeaveType.Vacation, schedule, 0, 1, m)
    const deltas: number[] = []
    let accrued = 0
    for (let m = 1; m <= 12; m++) {
      const delta = roundDays(target(m) - accrued)
      deltas.push(delta)
      accrued = roundDays(accrued + delta)
    }
    expect(target(6)).toBe(7.5)
    expect(target(7)).toBe(9.583)
    expect(deltas.slice(6)).toEqual([
      2.083, 2.084, 2.083, 2.083, 2.084, 2.083,
    ])
    expect(accrued).toBe(20.0)
    expect(scheduleYearEndTotal(LeaveType.Vacation, schedule)).toBe(20.0)
  })

  it('is monotone in months across a mixed schedule', () => {
    const schedule: PolicyYearSchedule = {
      segments: [
        { policyId: 'a', policyName: 'a', vacationRate: 25, sickBase: 5, firstMonth: 1, lastMonth: 3 },
        { policyId: 'b', policyName: 'b', vacationRate: 0, sickBase: 0, firstMonth: 4, lastMonth: 9 },
        { policyId: 'c', policyName: 'c', vacationRate: 12, sickBase: 3, firstMonth: 10, lastMonth: 12 },
      ],
      changedDuringYear: true,
    }
    let previous = 0
    for (let m = 1; m <= 12; m++) {
      const target = pieceTargetDays(LeaveType.Vacation, schedule, 2, 1, m)
      expect(target).toBeGreaterThanOrEqual(previous)
      previous = target
    }
  })

  it('sizes the sick tranche by the segment owning the m-th employed month', () => {
    const schedule: PolicyYearSchedule = {
      segments: [
        { policyId: 'nosick', policyName: 'nosick', vacationRate: 15, sickBase: 0, firstMonth: 1, lastMonth: 8 },
        { policyId: 'sick', policyName: 'sick', vacationRate: 25, sickBase: 5, firstMonth: 9, lastMonth: 12 },
      ],
      changedDuringYear: true,
    }
    expect(pieceTargetDays(LeaveType.Sick, schedule, 0, 1, 8)).toBe(0)
    // The loop reaching September re-tranches to the new policy's allowance.
    expect(pieceTargetDays(LeaveType.Sick, schedule, 0, 1, 9)).toBe(5)
    // A mid-year hire prorates the same tranche by the hire month.
    expect(pieceTargetDays(LeaveType.Sick, schedule, 0, 6, 4)).toBe(
      roundDays((5 * (13 - 6)) / 12),
    )
  })

  it('returns 0 for zero employed months regardless of carryover', () => {
    expect(
      pieceTargetDays(LeaveType.Vacation, legacyScheduleFromTotal(25), 10, 1, 0),
    ).toBe(0)
  })

  it('folds a sticky admin adjustment into the cumulative target', () => {
    const schedule = legacyScheduleFromTotal(24)
    // 6 months under 24/yr → 12, plus admin +3 → 15.
    expect(pieceTargetDays(LeaveType.Vacation, schedule, 0, 1, 6, 3)).toBe(15)
    // Debits lower the target so monthly accrual will not re-grant them.
    expect(pieceTargetDays(LeaveType.Vacation, schedule, 0, 1, 6, -2)).toBe(10)
    // Pre-employment months still preserve a booked admin offset (carry is zeroed).
    expect(pieceTargetDays(LeaveType.Vacation, schedule, 5, 1, 0, 4)).toBe(4)
  })
})

describe('scheduleYearEndTotal', () => {
  it('uses the December owner for sick and the weighted year for vacation', () => {
    const schedule: PolicyYearSchedule = {
      segments: [
        { policyId: 'a', policyName: 'a', vacationRate: 15, sickBase: 10, firstMonth: 1, lastMonth: 8 },
        { policyId: 'b', policyName: 'b', vacationRate: 25, sickBase: 0, firstMonth: 9, lastMonth: 12 },
      ],
      changedDuringYear: true,
    }
    expect(scheduleYearEndTotal(LeaveType.Vacation, schedule)).toBe(
      roundDays((15 * 8 + 25 * 4) / 12),
    )
    expect(scheduleYearEndTotal(LeaveType.Sick, schedule)).toBe(0)
  })
})

describe('carryoverCapBaseDays', () => {
  const single = legacyScheduleFromTotal(25)

  it('matches scheduleYearEndTotal exactly for a prior-year hire', () => {
    // The identity that keeps every full-year employee unchanged: a hire
    // anchored before the year collapses to hireMonth 1, and the earned
    // target over months 1..12 IS the weighted year-end total.
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2024-05-10', 0),
    ).toBe(scheduleYearEndTotal(LeaveType.Vacation, single))
  })

  it('prorates the hire year by the effective hire month', () => {
    // July 1: six employed months of a 25-day year earn 12.5.
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-07-01', 0),
    ).toBe(12.5)
    // The half-month rule decides the boundary: employed 15 of July's 31 days
    // still counts the month; three days later the clock starts in August.
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-07-17', 0),
    ).toBe(12.5)
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-07-20', 0),
    ).toBe(roundDays((25 * 5) / 12))
  })

  it('weights a blended hire year from the hire month only', () => {
    // The reason the base is pieceTargetDays and not scheduleYearEndTotal
    // times an employed-months ratio: a February hire under a 12-day policy
    // that hands over to a 24-day one in August must be measured by the
    // months they actually lived (6 * 12 + 5 * 24) / 12 = 16, not by the
    // pre-hire January the blended annual figure still weights.
    const blended: PolicyYearSchedule = {
      segments: [
        { policyId: 'p1', policyName: 'p1', vacationRate: 12, sickBase: 5, firstMonth: 1, lastMonth: 7 },
        { policyId: 'p2', policyName: 'p2', vacationRate: 24, sickBase: 5, firstMonth: 8, lastMonth: 12 },
      ],
      changedDuringYear: true,
    }
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, blended, 2026, '2026-02-01', 0),
    ).toBe(roundDays((12 * 6 + 24 * 5) / 12))
  })

  it('adds manual adjustments on top of the earned base', () => {
    // Owner decision: an admin credit moves the ceiling's denominator, in the
    // hire year and the full year alike.
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-01-01', 3),
    ).toBe(28)
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-07-01', 3),
    ).toBe(15.5)
  })

  it('folds to the manual adjustment alone when no month ever counted', () => {
    // Null anchor (the projection may pass one; the close never does), a hire
    // after the year, and a second-half-December hire all land on months 0,
    // where only an admin credit can fund the year - and the base says so.
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, null, 0),
    ).toBe(0)
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2027-03-01', 5),
    ).toBe(5)
    expect(
      carryoverCapBaseDays(LeaveType.Vacation, single, 2026, '2026-12-20', 5),
    ).toBe(5)
  })
})
