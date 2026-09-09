/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { CountryCatalogEntryDto, CountryDto } from '@workspace/contracts'
import {
  countryDraftProblem,
  countryRemovalProblem,
  countryTimezoneOptions,
} from './settings-format'

const catalog: CountryCatalogEntryDto[] = [
  {
    code: 'US',
    name: 'United States',
    timezone: 'America/New_York',
    timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles'],
  },
  {
    code: 'PL',
    name: 'Poland',
    timezone: 'Europe/Warsaw',
    timezones: ['Europe/Warsaw'],
  },
]

describe('countryTimezoneOptions', () => {
  it('offers the country its own zones', () => {
    expect(countryTimezoneOptions(catalog, 'US', undefined)).toEqual([
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
    ])
  })

  it('normalizes the code before looking it up', () => {
    expect(countryTimezoneOptions(catalog, 'pl', undefined)).toEqual([
      'Europe/Warsaw',
    ])
  })

  it('keeps a stored zone the catalog no longer lists', () => {
    // The server accepts the stored value back, so a picker that dropped it
    // would silently rewrite the zone on the next save.
    expect(countryTimezoneOptions(catalog, 'PL', 'Europe/Berlin')).toEqual([
      'Europe/Berlin',
      'Europe/Warsaw',
    ])
  })

  it('falls back to the stored zone when the catalog has not loaded', () => {
    expect(countryTimezoneOptions([], 'US', 'America/Chicago')).toEqual([
      'America/Chicago',
    ])
    expect(countryTimezoneOptions([], 'US', undefined)).toEqual([])
  })
})

describe('countryDraftProblem', () => {
  const rows = [{ code: 'US', name: 'United States' }]

  it('requires a country', () => {
    expect(
      countryDraftProblem(
        { editingCode: null, code: '', name: '', timezone: '' },
        rows,
        catalog,
      ),
    ).toBe('Choose a country.')
  })

  it('refuses adding a country already on the roster', () => {
    expect(
      countryDraftProblem(
        {
          editingCode: null,
          code: 'us',
          name: 'United States',
          timezone: 'America/New_York',
        },
        rows,
        catalog,
      ),
    ).toBe('That country is already on the list.')
  })

  it('lets an existing row be edited without tripping the duplicate rule', () => {
    expect(
      countryDraftProblem(
        {
          editingCode: 'US',
          code: 'US',
          name: 'United States',
          timezone: 'America/Los_Angeles',
        },
        rows,
        catalog,
      ),
    ).toBeNull()
  })

  it('requires a timezone, and one the country actually has', () => {
    expect(
      countryDraftProblem(
        { editingCode: 'US', code: 'US', name: 'United States', timezone: '' },
        rows,
        catalog,
      ),
    ).toBe('Choose a timezone for this country.')
    // Mirrors the server's refusal, so the dialog fails before the round trip
    // with the same reason the API would give.
    expect(
      countryDraftProblem(
        {
          editingCode: 'US',
          code: 'US',
          name: 'United States',
          timezone: 'Europe/Kyiv',
        },
        rows,
        catalog,
      ),
    ).toBe("Europe/Kyiv is not one of US's timezones.")
  })

  it('does not blame the admin when the catalog failed to load', () => {
    expect(
      countryDraftProblem(
        {
          editingCode: 'US',
          code: 'US',
          name: 'United States',
          timezone: 'America/Chicago',
        },
        rows,
        [],
      ),
    ).toBeNull()
  })
})

describe('countryRemovalProblem', () => {
  const country = (over: Partial<CountryDto> = {}): CountryDto => ({
    code: 'PL',
    name: 'Poland',
    timezone: 'Europe/Warsaw',
    ...over,
  })

  it('is silent for a country nothing points at', () => {
    expect(countryRemovalProblem(country({ assignedUsers: 0 }), [])).toBeNull()
    // Absent is not the same as zero, but it must not be read as a blocker:
    // an older server that does not send the count would grey out every row.
    expect(countryRemovalProblem(country(), [])).toBeNull()
  })

  it('names the employees, which nothing else on this page would show', () => {
    // The blocker that matters: users.countryCode is ON DELETE SET NULL, so
    // the database would let this removal through and quietly strip those
    // people of their country.
    expect(countryRemovalProblem(country({ assignedUsers: 3 }), [])).toBe(
      '3 employees are still assigned to it (deactivated accounts included). To remove it, move them to other countries first.',
    )
    expect(countryRemovalProblem(country({ assignedUsers: 1 }), [])).toBe(
      '1 employee is still assigned to it (deactivated accounts included).' +
        ' To remove it, move them to another country first.',
    )
  })

  it('names the calendars', () => {
    // Reads on its own, because this is what a tooltip shows: it opens with a
    // capital and it ends with the way out.
    expect(countryRemovalProblem(country({ assignedUsers: 0 }), [2026])).toBe(
      'It still has a holiday calendar. To remove it, delete the calendar first.',
    )
    expect(
      countryRemovalProblem(country({ assignedUsers: 0 }), [2026, 2027]),
    ).toBe(
      'It still has 2 holiday calendars. To remove it, delete the calendars first.',
    )
  })

  it('names both blockers at once, so the admin is not sent round twice', () => {
    expect(countryRemovalProblem(country({ assignedUsers: 2 }), [2026])).toBe(
      '2 employees are still assigned to it (deactivated accounts included),' +
        ' and it still has a holiday calendar. To remove it, move them to other' +
        ' countries and delete the calendar first.',
    )
  })
})
