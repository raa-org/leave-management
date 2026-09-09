/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { CountryDto, HolidayCalendarDto } from '@workspace/contracts'
import {
  availableYears,
  holidayDateSet,
  isUpcomingSoon,
  resolveDefaultCountry,
  resolveDefaultYear,
} from './holiday-year'

function calendar(
  year: number,
  holidays: { date: string; name: string }[] = [],
): HolidayCalendarDto {
  return {
    calendarId: `UA-${year}`,
    year,
    name: null,
    country: { code: 'UA', name: 'Ukraine', timezone: 'Europe/Kyiv' },
    holidays,
  }
}

function byYear(...calendars: HolidayCalendarDto[]): Record<number, HolidayCalendarDto> {
  return Object.fromEntries(calendars.map((cal) => [cal.year, cal]))
}

describe('holidayDateSet', () => {
  it('returns the calendar year dates as a set', () => {
    const set = holidayDateSet(
      calendar(2026, [
        { date: '2026-01-01', name: 'New Year' },
        { date: '2026-08-24', name: 'Independence Day' },
      ]),
    )
    expect([...set].sort()).toEqual(['2026-01-01', '2026-08-24'])
  })

  it('is empty for an undefined calendar', () => {
    expect(holidayDateSet(undefined).size).toBe(0)
  })
})

describe('availableYears', () => {
  it('unions configured years with the current year, newest first', () => {
    expect(availableYears(byYear(calendar(2025), calendar(2026)), 2026)).toEqual([
      2026, 2025,
    ])
  })

  it('includes the current year even when it has no calendar', () => {
    // So the employee can land on the current year and see the "not filled"
    // notice instead of the year being unreachable.
    expect(availableYears(byYear(calendar(2024), calendar(2025)), 2026)).toEqual([
      2026, 2025, 2024,
    ])
  })

  it('returns just the current year when nothing is configured', () => {
    expect(availableYears({}, 2026)).toEqual([2026])
  })
})

describe('resolveDefaultYear', () => {
  it('prefers the current year when offered', () => {
    expect(resolveDefaultYear([2026, 2025], 2026)).toBe(2026)
  })

  it('falls back to the latest configured year otherwise', () => {
    expect(resolveDefaultYear([2025, 2024], 2026)).toBe(2025)
  })

  it('falls back to the current year for an empty list', () => {
    expect(resolveDefaultYear([], 2026)).toBe(2026)
  })
})

describe('resolveDefaultCountry', () => {
  const countries: CountryDto[] = [
    { code: 'PL', name: 'Poland' },
    { code: 'UA', name: 'Ukraine' },
  ]

  it("prefers the employee's own country when it is in the list", () => {
    expect(resolveDefaultCountry(countries, 'UA')).toBe('UA')
  })

  it('matches the employee country case-insensitively and returns the stored code', () => {
    expect(resolveDefaultCountry(countries, ' ua ')).toBe('UA')
  })

  it('falls back to the first country when the employee has none or an unknown one', () => {
    expect(resolveDefaultCountry(countries, undefined)).toBe('PL')
    expect(resolveDefaultCountry(countries, 'DE')).toBe('PL')
  })

  it('returns undefined for an empty list', () => {
    expect(resolveDefaultCountry([], 'UA')).toBeUndefined()
  })
})

describe('isUpcomingSoon', () => {
  it('marks today and dates inside the window', () => {
    expect(isUpcomingSoon('2026-07-01', '2026-07-01')).toBe(true)
    expect(isUpcomingSoon('2026-07-10', '2026-07-01')).toBe(true)
    // Boundary: exactly 14 days ahead is still soon.
    expect(isUpcomingSoon('2026-07-15', '2026-07-01')).toBe(true)
  })

  it('rejects the past and dates beyond the window', () => {
    expect(isUpcomingSoon('2026-06-30', '2026-07-01')).toBe(false)
    expect(isUpcomingSoon('2026-07-16', '2026-07-01')).toBe(false)
  })

  it('crosses month boundaries in UTC arithmetic', () => {
    expect(isUpcomingSoon('2026-08-02', '2026-07-20')).toBe(true)
    expect(isUpcomingSoon('2026-08-04', '2026-07-20')).toBe(false)
  })

  it('honors a custom window', () => {
    expect(isUpcomingSoon('2026-07-03', '2026-07-01', 1)).toBe(false)
    expect(isUpcomingSoon('2026-07-02', '2026-07-01', 1)).toBe(true)
  })
})
