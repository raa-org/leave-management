/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { LeaveYearProjectionDto } from '@workspace/contracts'
import {
  buildYearMeters,
  chargeableDaysByYear,
  fundingOf,
} from './leave-year-model'

// A year the server has projected. Defaults describe an untouched, fully
// accrued 2026; each case overrides only what it is about.
function projectedYear(
  overrides: Partial<LeaveYearProjectionDto> = {},
): LeaveYearProjectionDto {
  return {
    year: 2026,
    totalDays: 25,
    carriedOverDays: 0,
    carryoverProjected: false,
    accruedDays: 14.58,
    spentDays: 0,
    committedDays: 0,
    projectedAccruedByLeave: 25,
    projectedYearEndAccrual: 25,
    requestedDays: 0,
    paidDays: 0,
    unpaidDays: 0,
    carryoverOutDays: 0,
    ...overrides,
  }
}

// The eight scenarios the prototype was reviewed against, transcribed with the
// figures it was reviewed with. They are the reference for this arithmetic, so
// the expectations below are the prototype's rather than this file's.
const SCENARIOS = {
  // Healthy balance, leave this week: nothing arrives before it.
  nowOk: projectedYear({
    spentDays: 3,
    committedDays: 2,
    projectedAccruedByLeave: 14.58,
    requestedDays: 2,
    paidDays: 2,
  }),
  // Booked ahead: four more tranches land before the leave.
  aheadOk: projectedYear({
    spentDays: 3,
    committedDays: 2,
    projectedAccruedByLeave: 22.91,
    requestedDays: 12,
    paidDays: 12,
  }),
  // Short right now: the pool cannot cover the whole range.
  nowShort: projectedYear({
    spentDays: 6,
    committedDays: 6,
    projectedAccruedByLeave: 16.66,
    requestedDays: 7,
    paidDays: 4,
    unpaidDays: 3,
  }),
  // December, with holds that already borrowed from accrual still to come.
  decemberDeficit: projectedYear({
    spentDays: 3,
    committedDays: 15,
    requestedDays: 8,
    paidDays: 7,
    unpaidDays: 1,
  }),
  // The 2026 side of a New Year span, under a capped 50% policy.
  crossThisYear: projectedYear({
    spentDays: 3,
    committedDays: 15,
    requestedDays: 4,
    paidDays: 4,
    carryoverOutDays: 1,
  }),
  // ...and its 2027 side: 1 day carried in, plus January's own tranche.
  crossNextYear: projectedYear({
    year: 2027,
    carriedOverDays: 1,
    carryoverProjected: true,
    accruedDays: 0,
    projectedAccruedByLeave: 3.08,
    projectedYearEndAccrual: 26,
    requestedDays: 2,
    paidDays: 2,
    carryoverOutDays: 12,
  }),
  // The whole leave is next January, so this year only feeds the carryover.
  feedsCarryover: projectedYear({
    spentDays: 3,
    committedDays: 2,
    requestedDays: 0,
    paidDays: 0,
    carryoverOutDays: 10,
  }),
  // The year is contracted to the last day: nothing is left to hand over.
  nothingToGive: projectedYear({
    spentDays: 10,
    committedDays: 15,
    requestedDays: 0,
    paidDays: 0,
    carryoverOutDays: 0,
  }),
}

describe('fundingOf', () => {
  it('nets out the days leave already booked has borrowed from the future', () => {
    const funding = fundingOf(SCENARIOS.decemberDeficit)

    // Holds run 3.42 past what has accrued, so of the 10.42 still to land only
    // 7 are free. Reporting the gross figure is the defect this fixes.
    expect(funding).toMatchObject({
      availableNow: 0,
      deficitDays: 3.42,
      arrivingGrossDays: 10.42,
      arrivingNetDays: 7,
      poolDays: 7,
    })
  })

  it('leaves the arriving figure alone when nothing is over-committed', () => {
    const funding = fundingOf(SCENARIOS.aheadOk)

    expect(funding.deficitDays).toBe(0)
    expect(funding.arrivingNetDays).toBe(funding.arrivingGrossDays)
    expect(funding).toMatchObject({ availableNow: 9.58, poolDays: 17.91 })
  })

  it('zeroes the arriving figure when holds have taken all of it', () => {
    const funding = fundingOf(SCENARIOS.nothingToGive)

    expect(funding).toMatchObject({
      availableNow: 0,
      deficitDays: 10.42,
      arrivingGrossDays: 10.42,
      // Every day still to land is already spoken for: this request reaches
      // none of it, which is why its January days go unpaid.
      arrivingNetDays: 0,
      poolDays: 0,
    })
  })

  it('draws bands that always add up to the accrual due by the leave dates', () => {
    // The property behind the bar, not one example of it: the legend can only
    // overrun the track if this identity breaks.
    for (const [name, year] of Object.entries(SCENARIOS)) {
      const funding = fundingOf(year)
      const drawn =
        funding.spentDays +
        funding.onHoldDays +
        funding.carryInDays +
        funding.availableNow +
        funding.arrivingNetDays
      expect(
        Math.abs(drawn - year.projectedAccruedByLeave),
        `${name} bands must close on the projected accrual`,
      ).toBeLessThan(0.005)
    }
  })

  it('counts a projected carryover once, as its own band and not inside the arriving days', () => {
    const funding = fundingOf(SCENARIOS.crossNextYear)

    // The accrual target already contains the carried day, so drawing the
    // difference raw would put it in both bands and promise 3.08 of accrual
    // where January only brings 2.08.
    expect(funding).toMatchObject({
      carryInDays: 1,
      arrivingNetDays: 2.08,
      availableNow: 0,
      poolDays: 3.08,
    })
  })

  it('keeps a settled carryover inside the accrued figure', () => {
    // A year that has begun already counts its carryover in accruedDays, so it
    // gets no band of its own and must not be subtracted a second time.
    const funding = fundingOf(
      projectedYear({ carriedOverDays: 3, carryoverProjected: false }),
    )

    expect(funding.carryInDays).toBe(0)
    expect(funding.availableNow).toBe(14.58)
  })

  it('derives what the year end burns from the leftover the policy did not keep', () => {
    // 7 free, 4 taken, 3 left; the capped half carries and the rest expires.
    expect(fundingOf(SCENARIOS.crossThisYear)).toMatchObject({
      leftoverAtYearEnd: 3,
      carryOutDays: 1,
      expiringDays: 2,
    })
    // Untouched by the request, so the whole 20 is the year's own leftover.
    expect(fundingOf(SCENARIOS.feedsCarryover)).toMatchObject({
      leftoverAtYearEnd: 20,
      carryOutDays: 10,
      expiringDays: 10,
    })
  })

  it('reports what is left of the pool once this request is charged', () => {
    expect(fundingOf(SCENARIOS.nowOk)).toMatchObject({
      poolDays: 9.58,
      freeAfterRequest: 7.58,
      touched: true,
    })
    // Unpaid days are not charged to the pool: only the paid ones are.
    expect(fundingOf(SCENARIOS.nowShort)).toMatchObject({
      poolDays: 4.66,
      freeAfterRequest: 0.66,
    })
  })

  it('marks a year the request never touches', () => {
    expect(fundingOf(SCENARIOS.feedsCarryover).touched).toBe(false)
    expect(fundingOf(SCENARIOS.nowOk).touched).toBe(true)
  })
})

describe('buildYearMeters', () => {
  it('keeps one bar while the request stays inside this year', () => {
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [SCENARIOS.nowOk, SCENARIOS.crossNextYear],
      currentYear: 2026,
      localDaysByYear: new Map(),
      fromServer: true,
    })

    // 2027 is projected by the server all the same, but nothing charges it and
    // it is not this year, so it gets no bar of its own.
    expect(meters.map((meter) => meter.year)).toEqual([2026, 2027])
    expect(
      buildYearMeters({
        hoursPerDay: 8,
        years: [
          SCENARIOS.nowOk,
          { ...SCENARIOS.crossNextYear, requestedDays: 0, paidDays: 0 },
        ],
        currentYear: 2026,
        localDaysByYear: new Map(),
        fromServer: true,
      }).map((meter) => meter.year),
    ).toEqual([2026])
  })

  it('keeps next year on screen when it already holds booked leave', () => {
    // LRS-53 case 2: a December request does not touch 2027, but 2027 already
    // holds the January side of an approved New Year span. Hiding that year
    // labelled this year's leftover "free after approval".
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [
        projectedYear({
          totalDays: 15,
          accruedDays: 15,
          spentDays: 0,
          committedDays: 4,
          projectedAccruedByLeave: 15,
          projectedYearEndAccrual: 15,
          requestedDays: 2,
          paidDays: 1,
          unpaidDays: 1,
          carryoverOutDays: 5,
        }),
        projectedYear({
          year: 2027,
          carriedOverDays: 5,
          carryoverProjected: true,
          accruedDays: 0,
          spentDays: 0,
          committedDays: 5,
          projectedAccruedByLeave: 7,
          projectedYearEndAccrual: 20,
          requestedDays: 0,
          paidDays: 0,
          carryoverOutDays: 10,
        }),
      ],
      currentYear: 2026,
      localDaysByYear: new Map(),
      fromServer: true,
    })

    expect(meters.map((meter) => meter.year)).toEqual([2026, 2027])
    expect(meters[0]).toMatchObject({
      fundsBookedCarryover: true,
      leftoverAtYearEnd: 10,
      carryOutDays: 5,
    })
    expect(meters[1]).toMatchObject({
      touched: false,
      holdsBookedLeave: true,
    })
  })

  it('keeps this year on screen even when only next year is charged', () => {
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [SCENARIOS.feedsCarryover, SCENARIOS.crossNextYear],
      currentYear: 2026,
      localDaysByYear: new Map(),
      fromServer: true,
    })

    // This year takes none of the leave, but it is where the carryover the
    // January days lean on comes from, so it stays.
    expect(meters.map((meter) => meter.year)).toEqual([2026, 2027])
    expect(meters[0]?.touched).toBe(false)
    expect(meters[0]?.carryOutDays).toBe(10)
  })

  it('counts the request locally until the server has answered for these dates', () => {
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [SCENARIOS.decemberDeficit],
      currentYear: 2026,
      // A different range from the one the stale preview describes.
      localDaysByYear: new Map([[2026, 10]]),
      fromServer: false,
    })

    // The pool is 7, so seven days are funded and three run past it. The
    // server's own 8/7/1 split is for other dates and is ignored.
    expect(meters[0]).toMatchObject({
      requestedDays: 10,
      paidDays: 7,
      unpaidDays: 3,
      poolDays: 7,
    })
  })

  it('charges down to the hour, leaving only what is under one behind', () => {
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [SCENARIOS.crossNextYear],
      currentYear: 2026,
      localDaysByYear: new Map([[2027, 5]]),
      fromServer: false,
    })

    // A pool of 3.08 pays for three days: the 0.08 is under an hour of an
    // eight-hour day and buys nothing, here or on the server.
    expect(meters[0]).toMatchObject({
      poolDays: 3.08,
      paidDays: 3,
      unpaidDays: 2,
    })
  })

  it('funds a part day out of a pool that cannot reach a whole one', () => {
    const meters = buildYearMeters({
      hoursPerDay: 8,
      years: [projectedYear({ accruedDays: 0.5, projectedAccruedByLeave: 0.5 })],
      currentYear: 2026,
      localDaysByYear: new Map([[2026, 1]]),
      fromServer: false,
    })

    // Half a day accrued funds half a day of leave. The whole-day floor this
    // spec used to pin reported the same employee as having nothing at all,
    // and the receipt then disagreed with the server's own preview.
    expect(meters[0]).toMatchObject({
      poolDays: 0.5,
      paidDays: 0.5,
      unpaidDays: 0.5,
    })
  })

  it('answers empty before the first preview arrives', () => {
    expect(
      buildYearMeters({
        hoursPerDay: 8,
        currentYear: 2026,
        localDaysByYear: new Map([[2026, 5]]),
        fromServer: false,
      }),
    ).toEqual([])
  })
})

describe('chargeableDaysByYear', () => {
  it('splits a New Year span by the year each working day falls in', () => {
    // 28-31 Dec are Mon-Thu, 1 Jan is a holiday, 4-5 Jan are Mon-Tue.
    const holidays = new Set(['2027-01-01'])

    expect(chargeableDaysByYear('2026-12-28', '2027-01-05', holidays, {}, 8)).toEqual(
      new Map([
        [2026, 4],
        [2027, 2],
      ]),
    )
  })

  it('keeps a single-year range on one entry', () => {
    expect(
      chargeableDaysByYear('2026-08-03', '2026-08-07', new Set(), {}, 8),
    ).toEqual(new Map([[2026, 5]]))
  })

  it('splits the COST, so a shortened day charges its year less', () => {
    // 30-31 Dec are Wed-Thu, 1 Jan is a holiday, 4 Jan is a Monday. Four hours
    // on the 31st and two on the 4th: each year is charged what it funds, not
    // how many dates it holds.
    expect(
      chargeableDaysByYear(
        '2026-12-30',
        '2027-01-04',
        new Set(['2027-01-01']),
        { '2026-12-31': 4, '2027-01-04': 2 },
        8,
      ),
    ).toEqual(
      new Map([
        [2026, 1.5],
        [2027, 0.25],
      ]),
    )
  })

  it('answers empty for a range that is not a range', () => {
    expect(chargeableDaysByYear('', '', new Set(), {}, 8).size).toBe(0)
    expect(
      chargeableDaysByYear('2026-08-07', '2026-08-03', new Set(), {}, 8).size,
    ).toBe(0)
  })
})
