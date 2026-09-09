/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  holidayDatesOf,
  holidayNameEntriesOf,
  holidaysActions,
  selectHolidayCountry,
  type HolidaysPartialState,
} from './holidays.store'

/**
 * The set of official-holiday dates ('YYYY-MM-DD') for one country, requesting
 * them on first use.
 *
 * Call this from a connected page, not from a presentational component: the
 * calendar takes the resulting set as a plain prop so it stays reusable outside
 * Redux. Dispatching on every mount is safe — `countryCalendarsNeeded` is a
 * reducer no-op and the epic decides whether anything is actually fetched.
 */
export function useHolidayDates(countryCode: string | undefined): Set<string> {
  const dispatch = useDispatch()
  // Select the country's own slice, never the flattened list: useSelector
  // compares by reference, and a selector that flattens allocates a new array
  // on EVERY call — so the page re-rendered whenever any unrelated part of the
  // store moved, and react-redux's stability check reported it. The entry is a
  // plain store reference, stable until that country is actually refetched,
  // which makes it the right thing to memoize the derived Set on.
  const entry = useSelector((state: HolidaysPartialState) =>
    selectHolidayCountry(state, countryCode),
  )

  useEffect(() => {
    if (!countryCode) {
      return
    }
    dispatch(holidaysActions.countryCalendarsNeeded(countryCode))
  }, [countryCode, dispatch])

  return useMemo(() => new Set(holidayDatesOf(entry)), [entry])
}

/**
 * Holiday names keyed by date for one country, for calendar tooltips. Purely a
 * read: it requests nothing, so use it alongside useHolidayDates (which
 * dispatches the fetch intent for the same country).
 */
export function useHolidayNames(
  countryCode: string | undefined,
): Map<string, string> {
  // Same stable-reference rule as useHolidayDates: select the entry, derive
  // here. This one matters twice over — its pairs are nested arrays, so even a
  // shallow equality check on the flattened result would still see a change
  // every time.
  const entry = useSelector((state: HolidaysPartialState) =>
    selectHolidayCountry(state, countryCode),
  )

  return useMemo(() => new Map(holidayNameEntriesOf(entry)), [entry])
}
