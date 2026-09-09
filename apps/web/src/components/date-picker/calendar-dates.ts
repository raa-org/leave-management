/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { isWeekendIso } from '@workspace/contracts'
import { hoursToDays, roundDays } from '../../lib/leave-format'

/**
 * Convert a calendar date ('YYYY-MM-DD') to the local `Date` the calendar grid
 * renders, and back.
 *
 * Both directions go through LOCAL date components on purpose. `new Date(iso)`
 * parses as UTC midnight, which renders as the previous day west of Greenwich;
 * `toISOString()` re-serializes in UTC, which reports the next day east of it.
 * Either one silently shifts the submitted dates by a day for a large share of
 * users, so neither appears here.
 */
export function isoToLocalDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  // Years below 100 are otherwise remapped into the 1900s by the Date
  // constructor, which would break the round-trip.
  date.setFullYear(year)
  return date
}

export function localDateToIso(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The dates of an inclusive period that spend leave balance: calendar days that
 * are neither a weekend nor an official holiday, in order.
 *
 * A client-side preview of the server's own rule (`resolveLeaveDays`), sharing
 * `isWeekendIso` with it so the two cannot disagree about what a weekend is.
 * The server stays authoritative — this only lets the employee see the cost
 * before submitting instead of after.
 */
export function chargeableDates(
  startIso: string,
  endIso: string,
  holidayDates: ReadonlySet<string>,
): string[] {
  if (!startIso || !endIso || endIso < startIso) {
    return []
  }

  const dates: string[] = []
  const cursor = isoToLocalDate(startIso)
  const end = isoToLocalDate(endIso)
  while (cursor <= end) {
    const iso = localDateToIso(cursor)
    if (!isWeekendIso(iso) && !holidayDates.has(iso)) {
      dates.push(iso)
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return dates
}

/**
 * How many DATES a period charges. Deliberately a count and not a cost: it
 * answers "is there a working day in here at all", which is what the server's
 * no-working-days refusal and the submit gate are about, and it is the same
 * answer whether or not the employee booked part days.
 *
 * What the period COSTS is `costOfDates` below - once a date can be booked by
 * the hour the two figures part ways, and every caller means exactly one of
 * them.
 */
export function countChargeableDays(
  startIso: string,
  endIso: string,
  holidayDates: ReadonlySet<string>,
): number {
  return chargeableDates(startIso, endIso, holidayDates).length
}

/**
 * What those dates cost in days: a date the employee shortened costs its hours
 * as a fraction of a day, every other date a full one. The optimistic figure
 * the composer prices its draft with until the server's preview for these exact
 * dates comes back.
 *
 * Mirrors the server's own reading of a portion map (day-math.sumPortions): a
 * date the map does not name is whole, and the total is quantized once, at the
 * end, to the three decimals the books store.
 */
export function costOfDates(
  dates: readonly string[],
  hoursByDate: Readonly<Record<string, number>>,
  hoursPerDay: number,
): number {
  let total = 0
  for (const date of dates) {
    const hours = hoursByDate[date]
    total += hours === undefined ? 1 : hoursToDays(hours, hoursPerDay)
  }
  return roundDays(total)
}
