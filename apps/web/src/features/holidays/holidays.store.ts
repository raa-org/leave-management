/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { CountryDto, HolidayCalendarDto } from '@workspace/contracts'
import { normalizeCountryCode } from '@workspace/contracts'
import type { AnyAction } from 'redux'
import { concat, from, of } from 'rxjs'
import { catchError, exhaustMap, filter, groupBy, map, mergeMap } from 'rxjs/operators'
import { type Epic, ofType } from 'redux-observable'
import type { AppEpicDependencies } from '../employee/employee-feature.store'
import { fetchCountries, fetchHolidayCalendars } from './holidays-api'

export type HolidayCountryEntry = {
  status: 'loading' | 'succeeded' | 'failed'
  error?: string
  // Epoch ms of the snapshot behind `calendarsByYear`, for the freshness gate.
  fetchedAt?: number
  // Exactly one calendar per (country, year) — the same shape the database
  // enforces with uq_holiday_calendars_country_year. A year absent from a
  // `succeeded` entry means "no calendar is configured", which is a real
  // answer, not a gap in the cache.
  calendarsByYear: Record<number, HolidayCalendarDto>
}

// The reserved country list (the countries table) for the holidays page's
// country picker. A single global list, not keyed by country: unlike the
// calendars it is the same for every employee, so a flat async resource fits.
export type CountriesEntry = {
  status: 'idle' | 'loading' | 'succeeded' | 'failed'
  items: CountryDto[]
  error?: string
}

/**
 * Holiday calendars cached BY COUNTRY, never by "the signed-in employee".
 *
 * The request calendar shades the employee's own country, and the per-country
 * holidays page browses any country; keying by country means both warm the same
 * entry, so navigating between them costs zero requests.
 */
export type HolidaysState = {
  byCountry: Record<string, HolidayCountryEntry>
  countries: CountriesEntry
}

const initialState: HolidaysState = {
  byCountry: {},
  countries: { status: 'idle', items: [] },
}

// Holiday calendars change only when an admin edits them, which is rare and
// usually in another session entirely. Long enough to make the cache the normal
// case, short enough that a same-day correction lands without a reload.
export const HOLIDAY_CALENDARS_TTL_MS = 15 * 60_000

type CountryCalendarsReceived = {
  countryCode: string
  calendars: HolidayCalendarDto[]
  fetchedAt: number
}

type CountryCalendarsFailed = {
  countryCode: string
  error: string
}

export const holidaysSlice = createSlice({
  name: 'holidays',
  initialState,
  reducers: {
    // INTENT, not commitment: a deliberate no-op so any number of components
    // can say "I need country X" on every render pass without churning state.
    // The decision to actually fetch (freshness, in-flight) lives in the epic,
    // which can read state$; a component-side guard would have to depend on the
    // very entry it guards and would re-run on every status transition.
    countryCalendarsNeeded(state, _action: PayloadAction<string>) {
      return state
    },
    countryCalendarsRequested(state, action: PayloadAction<string>) {
      const current = state.byCountry[action.payload]
      state.byCountry[action.payload] = {
        status: 'loading',
        // Keep the previous snapshot visible while revalidating: shading must
        // not flicker off just because the TTL expired.
        calendarsByYear: current?.calendarsByYear ?? {},
        fetchedAt: current?.fetchedAt,
      }
    },
    countryCalendarsReceived(state, action: PayloadAction<CountryCalendarsReceived>) {
      const { countryCode, calendars, fetchedAt } = action.payload
      state.byCountry[countryCode] = {
        status: 'succeeded',
        fetchedAt,
        calendarsByYear: Object.fromEntries(
          calendars.map((calendar) => [calendar.year, calendar]),
        ),
      }
    },
    countryCalendarsFailed(state, action: PayloadAction<CountryCalendarsFailed>) {
      const { countryCode, error } = action.payload
      const current = state.byCountry[countryCode]
      state.byCountry[countryCode] = {
        status: 'failed',
        error,
        // A failed revalidation keeps the last good snapshot: stale shading
        // beats no shading.
        calendarsByYear: current?.calendarsByYear ?? {},
        fetchedAt: current?.fetchedAt,
      }
    },
    // INTENT, not commitment (see countryCalendarsNeeded): the page can say "I
    // need the country list" on every mount; the epic decides whether to fetch.
    countriesNeeded(state) {
      return state
    },
    countriesRequested(state) {
      state.countries.status = 'loading'
      state.countries.error = undefined
    },
    countriesReceived(state, action: PayloadAction<CountryDto[]>) {
      state.countries.status = 'succeeded'
      state.countries.items = action.payload
    },
    countriesFailed(state, action: PayloadAction<string>) {
      state.countries.status = 'failed'
      state.countries.error = action.payload
    },
  },
})

export const holidaysActions = holidaysSlice.actions
export const holidaysReducer = holidaysSlice.reducer

export function createInitialHolidaysState(): HolidaysState {
  return holidaysReducer(undefined, { type: '@@INIT' })
}

export type HolidaysPartialState = { holidays?: HolidaysState }

export function selectHolidayCountry(
  state: HolidaysPartialState,
  countryCode: string | undefined,
): HolidayCountryEntry | undefined {
  if (!countryCode) {
    return undefined
  }
  return state.holidays?.byCountry[normalizeCountryCode(countryCode)]
}

/**
 * The calendar for one (country, year), or undefined when none is configured —
 * the read axis the upcoming per-country page needs, and the one the request
 * calendar already uses.
 */
export function selectHolidayCalendar(
  state: HolidaysPartialState,
  countryCode: string | undefined,
  year: number,
): HolidayCalendarDto | undefined {
  return selectHolidayCountry(state, countryCode)?.calendarsByYear[year]
}

/** The reserved country list resource (idle until the page first needs it). */
export function selectCountries(state: HolidaysPartialState): CountriesEntry {
  return state.holidays?.countries ?? { status: 'idle', items: [] }
}

/**
 * The flattening these selectors do, expressed over an ALREADY-SELECTED entry.
 *
 * Both shapes allocate, which makes them unfit to hand straight to useSelector:
 * it compares results by reference, so a fresh array every call re-renders the
 * subscriber on every unrelated store change (and trips react-redux's stability
 * check). Hooks therefore select the country entry — a stable store reference —
 * and derive with these, memoizing on that identity.
 */
export function holidayDatesOf(
  entry: HolidayCountryEntry | undefined,
): string[] {
  if (!entry) {
    return []
  }
  return Object.values(entry.calendarsByYear).flatMap((calendar) =>
    calendar.holidays.map((holiday) => holiday.date),
  )
}

export function holidayNameEntriesOf(
  entry: HolidayCountryEntry | undefined,
): Array<[string, string]> {
  if (!entry) {
    return []
  }
  return Object.values(entry.calendarsByYear).flatMap((calendar) =>
    calendar.holidays.map((holiday): [string, string] => [
      holiday.date,
      holiday.name,
    ]),
  )
}

/** Every known holiday date for a country, flattened across years. */
export function selectHolidayDates(
  state: HolidaysPartialState,
  countryCode: string | undefined,
): string[] {
  return holidayDatesOf(selectHolidayCountry(state, countryCode))
}

/**
 * [date, name] pairs for a country's holidays, flattened across years — the
 * tooltip companion of selectHolidayDates. Read-only: it never triggers a
 * fetch, so pair it with a hook that does (useHolidayDates dispatches the
 * countryCalendarsNeeded intent).
 */
export function selectHolidayNameEntries(
  state: HolidaysPartialState,
  countryCode: string | undefined,
): Array<[string, string]> {
  return holidayNameEntriesOf(selectHolidayCountry(state, countryCode))
}

function isStale(entry: HolidayCountryEntry | undefined, now: number): boolean {
  if (!entry) {
    return true
  }
  if (entry.status === 'loading') {
    return false
  }
  if (entry.status === 'failed') {
    // Retry on the next request rather than wedging the country until reload.
    return true
  }
  return entry.fetchedAt === undefined || now - entry.fetchedAt >= HOLIDAY_CALENDARS_TTL_MS
}

type HolidaysEpic = Epic<
  AnyAction,
  AnyAction,
  HolidaysPartialState,
  AppEpicDependencies
>

const holidayCalendarsEpic: HolidaysEpic = (action$, state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(holidaysActions.countryCalendarsNeeded.type),
    map((action) => normalizeCountryCode((action as PayloadAction<string>).payload)),
    filter((countryCode) => countryCode.length > 0),
    filter((countryCode) =>
      isStale(state$.value.holidays?.byCountry[countryCode], Date.now()),
    ),
    // One in-flight request per country, several countries concurrently. The
    // freshness filter above already skips a country that is loading, but that
    // read races a burst of intents dispatched before the first `requested`
    // reaches the reducer (React StrictMode's double mount does exactly this),
    // so exhaustMap is the guard that actually holds.
    groupBy((countryCode) => countryCode),
    mergeMap((countryGroup) =>
      countryGroup.pipe(
        exhaustMap((countryCode) =>
          concat(
            of(holidaysActions.countryCalendarsRequested(countryCode)),
            from(fetchHolidayCalendars(countryCode, fetchImpl)).pipe(
              map((calendars) =>
                holidaysActions.countryCalendarsReceived({
                  countryCode,
                  calendars,
                  fetchedAt: Date.now(),
                }),
              ),
              catchError((error: unknown) =>
                of(
                  holidaysActions.countryCalendarsFailed({
                    countryCode,
                    error: getErrorMessage(error),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

const countriesEpic: HolidaysEpic = (action$, state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(holidaysActions.countriesNeeded.type),
    // Fetch once per session: skip while a request is in flight or already
    // succeeded. A prior failure retries on the next intent. The country list
    // changes only when an admin edits it, which is rare and in another session.
    filter(() => {
      const status = state$.value.holidays?.countries.status
      return status === undefined || status === 'idle' || status === 'failed'
    }),
    // exhaustMap holds against the burst of intents dispatched before the first
    // `requested` reaches the reducer (React StrictMode's double mount), the same
    // race the calendars epic guards against.
    exhaustMap(() =>
      concat(
        of(holidaysActions.countriesRequested()),
        from(fetchCountries(fetchImpl)).pipe(
          map((countries) => holidaysActions.countriesReceived(countries)),
          catchError((error: unknown) =>
            of(
              holidaysActions.countriesFailed(
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : 'Countries could not be loaded.',
              ),
            ),
          ),
        ),
      ),
    ),
  )

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Holiday calendars could not be loaded.'
}

export const holidaysEpics = [holidayCalendarsEpic, countriesEpic]
