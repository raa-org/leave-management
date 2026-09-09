/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveYearProjectionDto } from '@workspace/contracts'
import {
  chargeableDates,
  costOfDates,
} from '../../components/date-picker/calendar-dates'
import { floorDays, roundDays, yearFromIso } from '../../lib/leave-format'

/**
 * One leave year reduced to the quantities a balance bar and a funding receipt
 * both draw on. The single place this arithmetic lives, so the two surfaces
 * cannot tell the reader different stories about the same year.
 *
 * The figure that matters most here is `arrivingNetDays`. The accrual still to
 * land is not all free: forward planning lets leave already booked run ahead of
 * what has accrued, and those days are spoken for the moment they land. Showing
 * the gross figure is what made the old legend overrun the year's own total and
 * an unpaid day look like a contradiction.
 */
export type YearFunding = {
  year: number
  /** Has not begun: nothing has accrued and the carryover is still a forecast. */
  future: boolean
  totalDays: number
  spentDays: number
  /** Days held by OTHER requests; the one being composed is never in here. */
  onHoldDays: number
  /** Accrued, not committed to anything. Zero for a year not yet begun. */
  availableNow: number
  /** How far leave already booked has run past what has accrued. */
  deficitDays: number
  /** Carried in from the prior year, drawn as its own band on a future year. */
  carryInDays: number
  /** Accrual still to land before the leave, before the deficit is taken out. */
  arrivingGrossDays: number
  /** ...and after it: what this request can actually reach. */
  arrivingNetDays: number
  /** Everything this request may draw on in this year. */
  poolDays: number
  /** The request's own days in this year. Zero for a year it never touches. */
  requestedDays: number
  paidDays: number
  unpaidDays: number
  /** Of the pool, what is still free once this request is charged. */
  freeAfterRequest: number
  /** What the year has left on 31 December, this request included. */
  leftoverAtYearEnd: number
  /** What survives into the next year under the policy. */
  carryOutDays: number
  /** The rest of the leftover: kept out of the next year by the cap. */
  expiringDays: number
  /** False when the request never touches this year and only feeds its carryover. */
  touched: boolean
  /** Pending or already-taken leave in this year, other than the one being composed. */
  holdsBookedLeave: boolean
  /**
   * Next year already holds booked leave that this year's leftover must fund
   * via carryover. The reason 11 "free" days cannot all be taken in December.
   */
  fundsBookedCarryover: boolean
}

/**
 * Reduce a server-projected year to the figures above.
 *
 * The one subtlety is the carryover, and it is easy to draw twice. The accrual
 * target already includes the days carried in, so `projectedAccruedByLeave`
 * contains them. For a year that has begun they also sit inside `accruedDays`
 * and the subtraction cancels them; for a year that has not, `accruedDays` is
 * zero and they would be counted both as the carry band and inside the arriving
 * band. `carryInDays` is therefore taken out explicitly, keyed on the server's
 * own `carryoverProjected` rather than on any clock the client owns.
 */
export function fundingOf(year: LeaveYearProjectionDto): YearFunding {
  const spent = Math.max(year.spentDays, 0)
  const committed = Math.max(year.committedDays, 0)
  const accrued = Math.max(year.accruedDays, 0)
  const carryIn = year.carryoverProjected ? Math.max(year.carriedOverDays, 0) : 0

  const availableNow = Math.max(roundDays(accrued - spent - committed), 0)
  const deficit = Math.max(roundDays(spent + committed - accrued), 0)
  const arrivingGross = Math.max(
    roundDays(year.projectedAccruedByLeave - accrued - carryIn),
    0,
  )
  const arrivingNet = Math.max(roundDays(arrivingGross - deficit), 0)
  const pool = roundDays(carryIn + availableNow + arrivingNet)

  const carryOut = Math.max(year.carryoverOutDays ?? 0, 0)
  const leftover = roundDays(
    year.projectedYearEndAccrual - spent - committed - year.paidDays,
  )
  // Not a second run of the carryover policy, which the client does not hold:
  // the leftover the year ends on, minus the server's own verdict on how much
  // of it survives.
  const expiring = Math.max(roundDays(leftover - carryOut), 0)

  return {
    year: year.year,
    future: year.carryoverProjected,
    totalDays: Math.max(year.totalDays, 0),
    spentDays: spent,
    onHoldDays: committed,
    availableNow,
    deficitDays: deficit,
    carryInDays: carryIn,
    arrivingGrossDays: arrivingGross,
    arrivingNetDays: arrivingNet,
    poolDays: pool,
    requestedDays: Math.max(year.requestedDays, 0),
    paidDays: Math.max(year.paidDays, 0),
    unpaidDays: Math.max(year.unpaidDays, 0),
    freeAfterRequest: Math.max(roundDays(pool - year.paidDays), 0),
    leftoverAtYearEnd: Math.max(leftover, 0),
    carryOutDays: carryOut,
    expiringDays: expiring,
    touched: year.requestedDays > 0,
    holdsBookedLeave: spent > 0 || committed > 0,
    fundsBookedCarryover: false,
  }
}

/**
 * Which years the composer draws: this one always, any year the request
 * charges, and a later year that already holds booked leave — because this
 * year's leftover is spoken for as its carryover (LRS-53 case 2). Without
 * that last clause a December request hid 2027, labelled the leftover
 * "free after approval", and left "only 1 of 11 days paid" unexplained.
 */
export function keepFundingYears(
  fundings: readonly YearFunding[],
  currentYear?: number,
): YearFunding[] {
  const visible = fundings.filter(
    (funding) =>
      funding.touched ||
      funding.year === currentYear ||
      funding.holdsBookedLeave,
  )
  return visible.map((funding) => ({
    ...funding,
    fundsBookedCarryover:
      funding.carryOutDays > 0 &&
      visible.some(
        (row) => row.year === funding.year + 1 && row.holdsBookedLeave,
      ),
  }))
}

/**
 * The years to draw a bar for, in order.
 *
 * Which years appear: this one always (it is where next year's carryover comes
 * from), any later year the request charges, and a later year that already
 * holds booked leave so this year's leftover is not drawn as free. A request
 * that stays inside this year and does not compete with next year's bookings
 * still keeps a single bar.
 *
 * Where the request's own day counts come from: the server when its verdict
 * describes the dates on the form, and the local calendar otherwise. The bands
 * are the server's either way, so during the debounce the marking tracks the
 * calendar while the bands are a round trip behind, which is the trade the
 * composer already makes everywhere else.
 */
export function buildYearMeters(input: {
  years?: readonly LeaveYearProjectionDto[]
  currentYear?: number
  localDaysByYear: ReadonlyMap<number, number>
  fromServer: boolean
  // The org's workday, from the composer's own form context. Required because
  // the floor below is a bookable ceiling, not a rendering: it decides how much
  // of the request a year's pool pays for.
  hoursPerDay: number
}): YearFunding[] {
  const years = input.years ?? []
  return keepFundingYears(
    years.map((year) => {
      if (input.fromServer) {
        return fundingOf(year)
      }
      const requested = input.localDaysByYear.get(year.year) ?? 0
      // Priced against the year with this request taken back out, so the pool
      // it is measured against is the same one the server would use.
      const bare = fundingOf({
        ...year,
        requestedDays: 0,
        paidDays: 0,
        unpaidDays: 0,
      })
      // Floored to the BOOKABLE HOUR GRID, which is the same grid the server
      // charges on: anything coarser would disagree with the preview that is
      // about to replace this estimate, and tell an employee with half a day
      // left that they have nothing. A pool of 3.08 funds 3d 0h at an
      // eight-hour workday; the remaining 0.08 is under an hour and buys
      // nothing, here or on the server.
      const paid = Math.min(requested, floorDays(bare.poolDays, input.hoursPerDay))
      return fundingOf({
        ...year,
        requestedDays: requested,
        paidDays: paid,
        unpaidDays: roundDays(requested - paid),
      })
    }),
    input.currentYear,
  )
}

/**
 * What a range COSTS, split by the year each working day falls in. The
 * optimistic path: it answers within the frame the dates change in, where the
 * server's own split is a round trip behind.
 *
 * A day amount, not a date count: a date the employee shortened costs its hours
 * as a fraction of a day. Left out, `hoursByDate` prices every date whole,
 * which is what an untouched selection is.
 */
export function chargeableDaysByYear(
  startDate: string,
  endDate: string,
  holidayDates: ReadonlySet<string>,
  hoursByDate: Readonly<Record<string, number>>,
  // Required, like every other divisor a cost is computed with: defaulting it to
  // the display fallback is how a caller silently prices a 7-hour org's leave on
  // an 8-hour grid, which is the one thing this app must never do quietly.
  hoursPerDay: number,
): Map<number, number> {
  const byYear = new Map<number, number>()
  if (!startDate || !endDate || endDate < startDate) {
    return byYear
  }
  const firstYear = yearFromIso(startDate)
  const lastYear = yearFromIso(endDate)
  if (firstYear === null || lastYear === null) {
    return byYear
  }
  for (let year = firstYear; year <= lastYear; year += 1) {
    const from = year === firstYear ? startDate : `${year}-01-01`
    const to = year === lastYear ? endDate : `${year}-12-31`
    const cost = costOfDates(
      chargeableDates(from, to, holidayDates),
      hoursByDate,
      hoursPerDay,
    )
    if (cost > 0) {
      byYear.set(year, cost)
    }
  }
  return byYear
}
