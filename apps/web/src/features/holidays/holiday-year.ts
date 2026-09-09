/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { CountryDto, HolidayCalendarDto } from '@workspace/contracts'
import { normalizeCountryCode } from '@workspace/contracts'

/**
 * The set of official-holiday dates ('YYYY-MM-DD') for ONE calendar (a single
 * country+year). Unlike selectHolidayDates, which flattens every year, the
 * holidays page shades one year at a time — so the calendar grid and the list
 * describe exactly the year the switcher selected.
 */
export function holidayDateSet(
  calendar: HolidayCalendarDto | undefined,
): Set<string> {
  return new Set((calendar?.holidays ?? []).map((holiday) => holiday.date))
}

/**
 * The years offered by the year switcher: the union of the country's CONFIGURED
 * years and the current year, most recent first.
 *
 * The current year is always included even when it has no calendar, so the
 * employee can land on it and see the "not filled yet" notice — restricting the
 * switcher to configured years would make that case unreachable except when a
 * country has no calendars at all.
 */
export function availableYears(
  calendarsByYear: Record<number, HolidayCalendarDto>,
  currentYear: number,
): number[] {
  const years = new Set<number>(
    Object.keys(calendarsByYear).map((year) => Number(year)),
  )
  years.add(currentYear)
  return [...years].sort((left, right) => right - left)
}

/**
 * The year to select first: the current year when it is offered, otherwise the
 * most recent configured year. Falls back to the current year for an empty list
 * (which availableYears never produces, but callers may).
 */
export function resolveDefaultYear(years: number[], currentYear: number): number {
  if (years.includes(currentYear)) {
    return currentYear
  }
  // `years` is sorted descending by availableYears; the first is the latest.
  return years[0] ?? currentYear
}

/**
 * Whether a holiday is coming up soon: today (inclusive) through `windowDays`
 * days ahead. Drives the list view's "soon" pill. ISO date strings compare
 * lexicographically and the difference is computed in UTC, so the arithmetic
 * is timezone-free - no local-time Date construction.
 */
export function isUpcomingSoon(
  dateIso: string,
  todayIso: string,
  windowDays = 14,
): boolean {
  if (dateIso < todayIso) {
    return false
  }
  const diffDays =
    (Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) /
    86_400_000
  return diffDays <= windowDays
}

/**
 * The country to select first: the employee's own country when it is in the
 * reserved list, otherwise the first country. Returns the code AS STORED in the
 * list so the picker's value matches an option exactly. undefined when the list
 * is empty.
 */
export function resolveDefaultCountry(
  countries: CountryDto[],
  employeeCountryCode?: string,
): string | undefined {
  if (employeeCountryCode) {
    const normalized = normalizeCountryCode(employeeCountryCode)
    const match = countries.find(
      (country) => normalizeCountryCode(country.code) === normalized,
    )
    if (match) {
      return match.code
    }
  }
  return countries[0]?.code
}
