/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import type { CountryDto, HolidayCalendarDto } from '@workspace/contracts'
import { createAppStore } from '../../store'
import {
  createInitialHolidaysState,
  holidaysActions,
  holidaysReducer,
  selectCountries,
  selectHolidayCalendar,
  selectHolidayCountry,
  selectHolidayDates,
} from './holidays.store'

function calendar(
  year: number,
  countryCode: string,
  holidays: { date: string; name: string }[],
): HolidayCalendarDto {
  return {
    calendarId: `${countryCode}-${year}`,
    year,
    name: null,
    country: { code: countryCode, name: countryCode, timezone: 'Europe/Kyiv' },
    holidays,
  }
}

const UA_2026 = calendar(2026, 'UA', [
  { date: '2026-01-01', name: 'New Year' },
  { date: '2026-08-24', name: 'Independence Day' },
])
const UA_2027 = calendar(2027, 'UA', [{ date: '2027-01-01', name: 'New Year' }])

describe('holidays slice', () => {
  it('treats the intent action as a no-op so the epic can own the decision', () => {
    const state = createInitialHolidaysState()
    const next = holidaysReducer(state, holidaysActions.countryCalendarsNeeded('UA'))

    // Identity, not just equality: a new object here would make the epic's own
    // freshness read race the reducer, and would re-render every consumer on
    // every render pass.
    expect(next).toBe(state)
  })

  it('keys calendars by country and year', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026, UA_2027],
        fetchedAt: 1_000,
      }),
    )

    expect(selectHolidayCalendar({ holidays: state }, 'UA', 2026)).toEqual(UA_2026)
    expect(selectHolidayCalendar({ holidays: state }, 'UA', 2027)).toEqual(UA_2027)
  })

  it('reads a missing year of a loaded country as "no calendar configured"', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026],
        fetchedAt: 1_000,
      }),
    )

    // A real answer, not a hole in the cache: status is succeeded and the year
    // is simply absent.
    expect(selectHolidayCountry({ holidays: state }, 'UA')?.status).toBe('succeeded')
    expect(selectHolidayCalendar({ holidays: state }, 'UA', 2030)).toBeUndefined()
  })

  it('normalizes the country code on read', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026],
        fetchedAt: 1_000,
      }),
    )

    expect(selectHolidayDates({ holidays: state }, ' ua ')).toEqual([
      '2026-01-01',
      '2026-08-24',
    ])
  })

  it('hands out one stable per-country reference for hooks to memoize on', () => {
    // What the hooks subscribe to. useSelector compares by reference, so this
    // has to be the SAME object across calls on unchanged state — the
    // flattening selectors below allocate and would re-render the subscriber
    // on every unrelated store change.
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026],
        fetchedAt: 1_000,
      }),
    )
    const store = { holidays: state }

    expect(selectHolidayCountry(store, 'UA')).toBe(
      selectHolidayCountry(store, 'UA'),
    )
    expect(selectHolidayDates(store, 'UA')).not.toBe(
      selectHolidayDates(store, 'UA'),
    )
  })

  it('flattens holiday dates across years', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026, UA_2027],
        fetchedAt: 1_000,
      }),
    )

    expect(selectHolidayDates({ holidays: state }, 'UA').sort()).toEqual([
      '2026-01-01',
      '2026-08-24',
      '2027-01-01',
    ])
  })

  it('keeps the last good snapshot when a revalidation fails', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026],
        fetchedAt: 1_000,
      }),
    )
    state = holidaysReducer(state, holidaysActions.countryCalendarsRequested('UA'))
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsFailed({ countryCode: 'UA', error: 'boom' }),
    )

    // Stale shading beats no shading.
    const entry = selectHolidayCountry({ holidays: state }, 'UA')
    expect(entry?.status).toBe('failed')
    expect(entry?.error).toBe('boom')
    expect(selectHolidayDates({ holidays: state }, 'UA')).toEqual([
      '2026-01-01',
      '2026-08-24',
    ])
  })

  it('isolates countries from each other', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsReceived({
        countryCode: 'UA',
        calendars: [UA_2026],
        fetchedAt: 1_000,
      }),
    )
    state = holidaysReducer(
      state,
      holidaysActions.countryCalendarsFailed({ countryCode: 'PL', error: 'boom' }),
    )

    // One country failing must not blank another — the future per-country page
    // can have several open at once.
    expect(selectHolidayCountry({ holidays: state }, 'UA')?.status).toBe('succeeded')
    expect(selectHolidayCountry({ holidays: state }, 'PL')?.status).toBe('failed')
    expect(selectHolidayDates({ holidays: state }, 'UA')).toHaveLength(2)
  })

  it('returns nothing for an unknown or absent country', () => {
    const state = createInitialHolidaysState()
    expect(selectHolidayDates({ holidays: state }, undefined)).toEqual([])
    expect(selectHolidayCountry({ holidays: state }, 'PL')).toBeUndefined()
    // Also safe against a store that has no holidays slice at all.
    expect(selectHolidayDates({}, 'UA')).toEqual([])
  })
})

const COUNTRIES: CountryDto[] = [
  { code: 'PL', name: 'Poland' },
  { code: 'UA', name: 'Ukraine' },
]

describe('holidays countries slice', () => {
  it('defaults to an idle, empty resource', () => {
    // Safe both with and without a holidays slice present.
    expect(selectCountries({})).toEqual({ status: 'idle', items: [] })
    expect(selectCountries({ holidays: createInitialHolidaysState() })).toEqual({
      status: 'idle',
      items: [],
    })
  })

  it('treats countriesNeeded as a no-op intent so the epic owns the decision', () => {
    const state = createInitialHolidaysState()
    expect(holidaysReducer(state, holidaysActions.countriesNeeded())).toBe(state)
  })

  it('moves requested -> received', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(state, holidaysActions.countriesRequested())
    expect(state.countries.status).toBe('loading')

    state = holidaysReducer(state, holidaysActions.countriesReceived(COUNTRIES))
    expect(selectCountries({ holidays: state })).toEqual({
      status: 'succeeded',
      items: COUNTRIES,
    })
  })

  it('records a failure without dropping the items already loaded', () => {
    let state = createInitialHolidaysState()
    state = holidaysReducer(state, holidaysActions.countriesReceived(COUNTRIES))
    state = holidaysReducer(state, holidaysActions.countriesFailed('boom'))

    const entry = selectCountries({ holidays: state })
    expect(entry.status).toBe('failed')
    expect(entry.error).toBe('boom')
    // A failed revalidation keeps the last good list on screen.
    expect(entry.items).toEqual(COUNTRIES)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Two async hops (fetch, then response.json), so flush more than once.
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function countCountryCalls(fetchImpl: ReturnType<typeof vi.fn>): number {
  return fetchImpl.mock.calls.filter((call) =>
    String(call[0]).includes('/api/countries'),
  ).length
}

describe('countries epic', () => {
  it('fetches the reserved list once and caches it', async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).includes('/api/countries')
        ? jsonResponse(COUNTRIES)
        : new Response(null, { status: 204 }),
    )
    const store = createAppStore({ fetchImpl: fetchImpl as unknown as typeof fetch })

    store.dispatch(holidaysActions.countriesNeeded())
    await flush()

    expect(selectCountries(store.getState())).toEqual({
      status: 'succeeded',
      items: COUNTRIES,
    })
    expect(countCountryCalls(fetchImpl)).toBe(1)

    // A second intent after success does not refetch (fetch-once-per-session).
    store.dispatch(holidaysActions.countriesNeeded())
    await flush()
    expect(countCountryCalls(fetchImpl)).toBe(1)
  })

  it('dedupes a burst of intents into a single request', async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).includes('/api/countries')
        ? jsonResponse(COUNTRIES)
        : new Response(null, { status: 204 }),
    )
    const store = createAppStore({ fetchImpl: fetchImpl as unknown as typeof fetch })

    // React StrictMode mounts twice; both intents land before the first request
    // resolves. Only one fetch must go out.
    store.dispatch(holidaysActions.countriesNeeded())
    store.dispatch(holidaysActions.countriesNeeded())
    await flush()

    expect(countCountryCalls(fetchImpl)).toBe(1)
    expect(selectCountries(store.getState()).status).toBe('succeeded')
  })

  it('surfaces the server message on failure', async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).includes('/api/countries')
        ? jsonResponse({ message: 'nope' }, 500)
        : new Response(null, { status: 204 }),
    )
    const store = createAppStore({ fetchImpl: fetchImpl as unknown as typeof fetch })

    store.dispatch(holidaysActions.countriesNeeded())
    await flush()

    const entry = selectCountries(store.getState())
    expect(entry.status).toBe('failed')
    expect(entry.error).toBe('nope')
  })
})
