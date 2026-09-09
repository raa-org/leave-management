/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { CountryDto, HolidayCalendarDto } from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'
import { parseJsonResponse, type FetchLike } from '../../lib/http'

/**
 * Every configured holiday calendar for one country, all years at once.
 *
 * Deliberately not per-year: a country is a handful of calendars, and fetching
 * the whole country means paging the request calendar across a year boundary
 * costs nothing. The endpoint also accepts `year`, which the upcoming
 * per-country holidays page can use for a deep link.
 */
export async function fetchHolidayCalendars(
  countryCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<HolidayCalendarDto[]> {
  return parseJsonResponse<HolidayCalendarDto[]>(
    await fetchImpl(
      apiUrl(`/api/holiday-calendars?countryCode=${encodeURIComponent(countryCode)}`),
    ),
  )
}

/**
 * The reserved country list (the countries table), for the holidays page's
 * country picker. Read-only reference data any provisioned employee may read —
 * served from the employee route, not the admin one that also writes countries.
 */
export async function fetchCountries(
  fetchImpl: FetchLike = fetch,
): Promise<CountryDto[]> {
  return parseJsonResponse<CountryDto[]>(await fetchImpl(apiUrl('/api/countries')))
}
