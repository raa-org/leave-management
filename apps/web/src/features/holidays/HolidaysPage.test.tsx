/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Provider } from 'react-redux'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  AppRoleName,
  EmployeeProfileStatus,
  type CountryDto,
  type EmployeeDashboardDto,
  type HolidayCalendarDto,
} from '@workspace/contracts'
import { createAppStore } from '../../store'
import { formatWeekdayLong } from '../../lib/leave-format'
import { employeeFeatureActions } from '../employee/employee-feature.store'
import { holidaysActions } from './holidays.store'
import { HolidayList, HolidaysPageContent } from './HolidaysPage'

// PL first on purpose: "Ukraine" appearing in the summary then proves the
// dashboard-country preselect actually worked, not just "first option wins".
const COUNTRIES: CountryDto[] = [
  { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
  { code: 'UA', name: 'Ukraine', timezone: 'Europe/Kyiv' },
]

const UA_2026: HolidayCalendarDto = {
  calendarId: 'UA-2026',
  year: 2026,
  name: null,
  country: { code: 'UA', name: 'Ukraine', timezone: 'Europe/Kyiv' },
  holidays: [
    { date: '2026-01-01', name: 'New Year' },
    { date: '2026-01-07', name: 'Orthodox Christmas' },
    // Within 14 days of the dashboard clock (2026-07-01) -> the "soon" pill.
    { date: '2026-07-10', name: 'Statehood Day' },
    // Beyond the window -> no pill.
    { date: '2026-08-24', name: 'Independence Day' },
  ],
}

// Minimal READY dashboard: pins the current year (2026) and the UA preselect.
const dashboardFixture: EmployeeDashboardDto = {
  employeeId: 'employee-1',
  displayName: 'Maya Chen',
  roleNames: [AppRoleName.Employee],
  generatedAt: '2026-07-01T09:00:00.000Z',
  profileStatus: EmployeeProfileStatus.Ready,
  holidayCalendarYears: [2026],
  hoursPerDay: 8,
  countryCode: 'UA',
  balances: [],
  pendingRequests: [],
  recentActivity: [],
}

const emptyHistory = { requests: [], generatedAt: '2026-07-01T09:00:00.000Z' }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The dashboard intent chains the upcoming epic, which fetches the request
// history and the holiday calendars again - one URL handler serves both that
// chain and the holidays epic.
function makeFetchMock(calendars: HolidayCalendarDto[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/countries')) {
      return jsonResponse(COUNTRIES)
    }
    if (url.includes('/api/dashboard/me')) {
      return jsonResponse(dashboardFixture)
    }
    if (url.includes('/api/holiday-calendars')) {
      return jsonResponse(calendars)
    }
    if (url.includes('/api/leave-requests/me')) {
      return jsonResponse(emptyHistory)
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch
}

async function flushAsyncWork() {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
}

const normalizeServerMarkup = (markup: string) => markup.replace(/<!-- -->/g, '')

async function renderHolidaysPage(calendars: HolidayCalendarDto[]) {
  const store = createAppStore({ fetchImpl: makeFetchMock(calendars) })
  // Effects never run under renderToString, so the test pre-warms the store
  // with the same intents the page dispatches on mount.
  store.dispatch(holidaysActions.countriesNeeded())
  store.dispatch(employeeFeatureActions.dashboardRequested())
  store.dispatch(holidaysActions.countryCalendarsNeeded('UA'))
  await flushAsyncWork()

  return normalizeServerMarkup(
    renderToString(
      <MemoryRouter initialEntries={['/employee/holidays']}>
        <Provider store={store}>
          <HolidaysPageContent />
        </Provider>
      </MemoryRouter>,
    ),
  )
}

describe('holidays page', () => {
  it('renders the year grid with the summary, legend, and month count pills', async () => {
    const markup = await renderHolidaysPage([UA_2026])

    // Summary: the count and the DASHBOARD-preselected country (PL is listed
    // first, so "Ukraine" here proves the preselect, not option order).
    expect(markup).toMatch(/>4<\/b> public holidays in/)
    expect(markup).toContain('Ukraine, 2026')

    // Legend labels: in calendar mode these render only in the legend row
    // (the list view's table headers are not mounted).
    expect(markup).toContain('Public holiday')
    expect(markup).toContain('Weekend')
    expect(markup).toContain('Today')

    // Mini month captions: bare month names with a count pill for January's
    // two holidays; a zero pill never renders. '>January<' pins the caption
    // TEXT NODE - the aria-labels ("January 2026") sit inside quoted
    // attributes and never match this shape.
    expect(markup).toContain('>January<')
    expect(markup).toMatch(/hc-count[^>]*>2</)
    expect(markup).not.toMatch(/hc-count[^>]*>0</)

    // Holiday cells: shaded modifier class + the name reaching the cell's
    // aria-label via the Day override (the closed tooltip renders nothing).
    expect(markup).toContain('dp-holiday')
    expect(markup).toContain('Independence Day')

    // Today ring pinned to the SERVER clock (2026-07-01), not the wall
    // clock: the data attributes name the exact day, so losing the today
    // prop fails this even while the real clock is still in 2026.
    expect(markup).toContain('data-day="2026-07-01"')
    expect(markup).toContain('data-today="true"')

    // Single-letter weekday header.
    expect(markup).toContain('>M</th>')

    // Controls: the select carries its testid, the stepper its labels.
    expect(markup).toContain('holidays-country-select')
    expect(markup).toContain('Previous year')
    expect(markup).toContain('aria-pressed="true"')
  })

  it('shows the not-filled warning for a configured country without that year', async () => {
    // The endpoint answers with NO calendars: the entry succeeds with an
    // empty year map, which is a confirmed "not filled", not a loading gap.
    const markup = await renderHolidaysPage([])

    expect(markup).toContain('holidays-not-filled')
    expect(markup).toContain(
      'The holiday calendar for Ukraine in 2026 has not been filled in yet.',
    )
    expect(markup).toContain('Pick another year, or contact your administrator')
    expect(markup).toContain('No calendar configured for')
    // The legend explains nothing when no grid is shown.
    expect(markup).not.toContain('Weekend')
  })

  it('renders the list view with weekday column and a soon pill inside the window', () => {
    const markup = normalizeServerMarkup(
      renderToString(<HolidayList holidays={UA_2026.holidays} todayIso="2026-07-01" />),
    )

    expect(markup).toContain('New Year')
    // Composed via the same formatter so the expectation holds on any ICU
    // default locale (house pattern).
    expect(markup).toContain(formatWeekdayLong('2026-01-01'))
    expect(markup).toContain('Statehood Day')
    // Exactly ONE pill: 2026-07-10 is inside the 14-day window, the others
    // are not.
    expect(markup.match(/>soon</g)).toHaveLength(1)
  })

  it('renders no soon pill without a server clock', () => {
    // A holiday guaranteed inside a hypothetical CLIENT-clock window: if the
    // component ever fell back to the wall clock instead of requiring the
    // server-provided todayIso, this date would light up on any run date.
    const clientTomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const markup = normalizeServerMarkup(
      renderToString(
        <HolidayList holidays={[{ date: clientTomorrow, name: 'Fallback probe' }]} />,
      ),
    )
    expect(markup).not.toContain('>soon<')
  })
})
