/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Pure calendar/number helpers shared by the leave domain and the policy
// engine. Everything here used to live module-private in leave-domain.service
// and was lifted out (like roundDays before it) so the policy schedule module
// can use THE SAME implementations: a second copy of the rounding or of the
// half-month rule would let the policy math and the books disagree.

// How many decimals a day quantity keeps. Three, because leave is bookable by
// the hour: an eight-hour workday makes one hour 0.125 days, and two decimals
// would quantize a five-hour absence (0.625d) into 0.63d. Every numeric day
// column declares this same scale (entities/day-column.ts) — the books pre-round
// to it, and Postgres would silently round anything finer on write, so the two
// must never drift apart.
export const DAY_DECIMALS = 3

const DAY_SCALE = 10 ** DAY_DECIMALS

// Rounding for day quantities — THE canonical rounding every day figure passes
// through before persistence or comparison.
export function roundDays(value: number): number {
  return Math.round(value * DAY_SCALE) / DAY_SCALE
}

// How long a workday is when nothing says otherwise. Only a default: the real
// figure is a setting (leave_settings.hoursPerDay), because it is the divisor
// that turns a booking in hours into a fraction of a day.
export const DEFAULT_HOURS_PER_DAY = 8

// A booking in hours as a fraction of a day: 2h of an 8h day is 0.25. Quantized
// like every other day figure, but by MAGNITUDE, so that removing an hour is
// exactly the negative of adding one. roundDays alone is not symmetric (it
// breaks ties upward, so 0.0625 quantizes to 0.063 while -0.0625 quantizes to
// -0.062), and an admin correction that cannot undo itself would leave a
// thousandth of a day on the books every time it was reversed.
export function hoursToDayPortion(
  hours: number,
  hoursPerDay: number = DEFAULT_HOURS_PER_DAY,
): number {
  const magnitude = roundDays(Math.abs(hours) / hoursPerDay)
  return hours < 0 ? -magnitude : magnitude
}

// The inverse, for display and for the hours an editor round-trips. Rounded to
// whole hours: portions are only ever minted from whole hours, and a stored
// figure that drifted off the grid should still read as the hour it meant.
export function dayPortionToHours(
  portion: number,
  hoursPerDay: number = DEFAULT_HOURS_PER_DAY,
): number {
  return Math.round(portion * hoursPerDay)
}

// Whether a day figure sits on the bookable grid: whether it is exactly what
// some whole number of hours becomes here. Every portion the domain accepts
// must pass this, because a figure between two hours is one no employee can
// have taken and no editor can round-trip.
//
// Stated as that round trip rather than as "value times hoursPerDay is a whole
// number", because the case that matters is a workday whose hour does not fit
// three decimals: an hour of a 7-hour day is stored as 0.143, which reads back
// as 1.001 hours, and it is nevertheless the exact figure the booking path
// mints for one hour there.
export function isOnHourGrid(
  value: number,
  hoursPerDay: number = DEFAULT_HOURS_PER_DAY,
): boolean {
  const rounded = roundDays(value)
  return (
    hoursToDayPortion(dayPortionToHours(rounded, hoursPerDay), hoursPerDay) ===
    rounded
  )
}

// The largest grid figure that does not exceed `value`: what an employee can
// actually book out of a balance carrying an accrual remainder. 12.333 days of
// an 8h workday floors to 12.25 (12 days and 2 hours), never to 12.
//
// The hour count is settled by the SAME conversion the grid check uses, not by
// dividing and quantizing separately. Where an hour does not fit three decimals
// (a 7-hour day stores one hour as 0.143, which is a shade more than a seventh)
// a balance of exactly N stored hours reads as marginally less than N/hoursPerDay,
// and a plain floor of the product would hand back one hour fewer than the
// employee holds.
export function floorToHourGrid(
  value: number,
  hoursPerDay: number = DEFAULT_HOURS_PER_DAY,
): number {
  let hours = Math.floor(value * hoursPerDay + 1e-9)
  while (hoursToDayPortion(hours + 1, hoursPerDay) <= value + 1e-9) {
    hours += 1
  }
  return hoursToDayPortion(hours, hoursPerDay)
}

// THE notation for a day figure a person reads: days and hours against the
// org's workday. 2.5 of an 8h day is "2d 4h", 0.625 is "5h", 3 is "3d", 0 is
// "0d". No leading "0d" under a day and no trailing "0h" on a whole one, so the
// common cases stay as short as the bare day count they replace.
//
// FLOORED to the hour grid first. Request costs already sit on the grid, so
// there the floor changes nothing; balances carry the remainder accrual leaves
// behind (25/12 a month), and flooring them is the standing rule that an
// employee is never shown more than they can actually take. What the floor
// drops is by definition under an hour, and the full allocation is still
// reached by December, so nothing is lost but the display.
//
// The exact figure is deliberately NOT spelled out here: surfaces with room for
// it (a tooltip, a secondary line) render the raw value themselves rather than
// asking this for a second variant.
//
// hoursPerDay is required, not defaulted: every caller renders for a specific
// org, and the settings row is the only place its workday length is stated.
export function formatDayAmount(value: number, hoursPerDay: number): string {
  if (!Number.isFinite(value)) {
    return '0d'
  }
  const magnitude = Math.abs(value)
  // The whole/part split is taken from ONE hour count rather than from a
  // separate floor and remainder, so a workday whose hour does not fit three
  // decimals (0.143 for a 7-hour day) cannot lose an hour to the second
  // conversion.
  const hours = dayPortionToHours(
    floorToHourGrid(magnitude, hoursPerDay),
    hoursPerDay,
  )
  const days = Math.floor(hours / hoursPerDay)
  const remainder = hours - days * hoursPerDay
  const sign = value < 0 ? '-' : ''
  if (days === 0 && remainder === 0) {
    return `${sign}0d`
  }
  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (remainder > 0) {
    parts.push(`${remainder}h`)
  }
  return `${sign}${parts.join(' ')}`
}

// How much of one leaveDays entry the employee is away for, read index by
// index. An EMPTY dayPortions means every date is a full day: that is what
// every request filed before leave could be booked by the hour carries, and it
// is why neither the column nor the read side needed a backfill. THE single
// home of that idiom: spelled out at each site instead, it fails silently
// rather than loudly (a bare sum over an empty array is 0, which posts a
// zero-day hold and leaves the balance short for good).
export function portionAt(dayPortions: readonly number[], index: number): number {
  return dayPortions.length === 0 ? 1 : (dayPortions[index] ?? 1)
}

// The same portions keyed by DATE rather than by position. Every consumer that
// works from a subset of a request's dates (the unpaid ones, one year's share,
// the days that have elapsed) has lost the index the array is aligned to, and
// re-deriving it from the subset is exactly the index shear this map exists to
// prevent.
export function portionMap(
  leaveDays: readonly string[],
  dayPortions: readonly number[],
): Map<string, number> {
  const portions = new Map<string, number>()
  leaveDays.forEach((day, index) => {
    portions.set(day, portionAt(dayPortions, index))
  })
  return portions
}

// What a set of dates costs against such a map: the amount, never the count. A
// date the map does not know is a full day, the same reading an absent portion
// gets everywhere else. Quantized once, at the end, like every day figure.
export function sumPortions(
  dates: Iterable<string>,
  portions: ReadonlyMap<string, number>,
): number {
  let total = 0
  for (const date of dates) {
    total += portions.get(date) ?? 1
  }
  return roundDays(total)
}

// 1-based month of a 'YYYY-MM-DD' date string.
export function monthOfIsoDate(isoDate: string): number {
  return Number.parseInt(isoDate.slice(5, 7), 10)
}

// Day of the month of a 'YYYY-MM-DD' date string.
export function dayOfMonthIsoDate(isoDate: string): number {
  return Number.parseInt(isoDate.slice(8, 10), 10)
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// How long a calendar month is, leap year included. The single source for it:
// the half-month hire rule and the month-end date helper both read this.
export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0)
}

// The half-month rule: the first month a date "owns", given a start date
// inside the leave year — a hire owns its first month only when at least half
// of it is still ahead. May return 13 (a second-half-of-December date owns
// nothing that year) — consumers must handle it. The SAME rule snaps a policy
// membership boundary to month ownership, so a transfer and a hire slice
// months identically.
export function effectiveHireMonth(year: number, anchorDate: string): number {
  const month = monthOfIsoDate(anchorDate)
  const monthLength = daysInMonth(year, month)
  const daysEmployed = monthLength - dayOfMonthIsoDate(anchorDate) + 1
  return daysEmployed >= Math.floor(monthLength / 2) ? month : month + 1
}
