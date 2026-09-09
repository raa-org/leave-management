/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  EmployeeProfileStatus,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
  type EmployeeDashboardDto,
  type LeaveRequestDetailDto,
  type LeaveRequestFormContextDto,
  type LeaveRequestHistoryDto,
} from '@workspace/contracts'
import { EmployeeDashboardPage, EmployeeDashboardPageContent } from './EmployeeDashboardPage'
import {
  BalanceKpiGrid,
  BalanceMeter,
  RequestFundingWindow,
  RangeLine,
  requestDraw,
  restExplanation,
} from './employee-ui'
import { fundingOf, keepFundingYears } from './leave-year-model'
import { LeaveHistoryPage, LeaveHistoryPageContent } from './LeaveHistoryPage'
import { LeaveRequestDetailPageContent } from './LeaveRequestDetailPage'
import { RequestDetailApiError, fetchLeaveRequestDetail } from './employee-api'
import {
  bookableDaysOf,
  calendarNoticeFor,
  configureWorkdayHours,
  formatDate,
  formatDayMonth,
  formatWeekdayDayMonth,
} from '../../lib/leave-format'
import {
  INITIAL_PARTIAL_DAYS,
  LeaveRequestPage,
  LeaveRequestPageContent,
  buildModifyHoursPrefill,
  hasRequiredApprover,
  hoursPayloadFor,
  partialDaysReducer,
  pruneHoursByDate,
  pruneLockedEmails,
  requestImpactFor,
  sameHoursByDate,
  submitNoteFor,
  type PartialDaysState,
} from './LeaveRequestPage'
import {
  costOfDates,
  partialDaysSummary,
  selectionSummary,
} from '../../components/date-picker'
import {
  createEmployeeFeatureStore,
  employeeFeatureActions,
} from './employee-feature.store'

const dashboardFixture: EmployeeDashboardDto = {
  employeeId: 'employee-1',
  displayName: 'Maya Chen',
  roleNames: [AppRoleName.Employee],
  generatedAt: '2026-07-01T09:00:00.000Z',
  profileStatus: EmployeeProfileStatus.Ready,
  holidayCalendarYears: [2026],
  hoursPerDay: 8,
  countryCode: 'UA',
  balances: [
    {
      leaveType: LeaveType.Vacation,
      totalDays: 24,
      availableDays: 15,
      onHoldDays: 3,
      spentDays: 6,
      accruedDays: 18,
      updatedAt: '2026-07-01T09:00:00.000Z',
    },
    {
      leaveType: LeaveType.Sick,
      totalDays: 10,
      availableDays: 8,
      onHoldDays: 0,
      spentDays: 2,
      accruedDays: 10,
      updatedAt: '2026-07-01T09:00:00.000Z',
    },
  ],
  pendingRequests: [
    {
      requestId: 'req-pending',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Pending,
      startDate: '2026-08-12',
      endDate: '2026-08-15',
      requestedDays: 3,
      paidDays: 3,
      unpaidDays: 0,
      heldDays: 3,
      submittedAt: '2026-07-01T09:15:00.000Z',
      comment: 'Family travel',
    },
  ],
  recentActivity: [
    {
      actorDisplayName: 'Maya Chen',
      action: 'Submitted leave request',
      occurredAt: '2026-07-01T09:15:00.000Z',
      comment: 'Waiting for approval',
    },
  ],
}

// Approved requests overlapping the dashboard's 14-day upcoming window
// (generatedAt 2026-07-01 → window 2026-07-01..2026-07-15).
const upcomingHistoryFixture: LeaveRequestHistoryDto = {
  hoursPerDay: 8,
  requests: [
    {
      hoursPerDay: 8,
      requestId: 'req-upcoming',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Maya Chen',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Approved,
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      submittedAt: '2026-06-20T08:00:00.000Z',
      comment: 'Summer break',
      approvers: [],
      activity: [],
      balanceTimeline: [],
      unpaidDates: [],
    },
  ],
  balanceTimeline: [],
  generatedAt: '2026-07-01T09:00:00.000Z',
}

const holidayCalendarsFixture = [
  {
    calendarId: 'cal-ua-2026',
    country: { code: 'UA', name: 'Ukraine' },
    year: 2026,
    name: 'Ukraine 2026',
    holidays: [{ date: '2026-07-07', name: 'Statehood Day' }],
  },
]

// URL-routed fetch mock for dashboard-page tests: the dashboard fetch also
// triggers the chained upcoming queries (approved window + holiday calendars),
// so all three endpoints must answer.
function dashboardFetchMock(dashboard: EmployeeDashboardDto) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/dashboard/me')) {
      return jsonResponse(dashboard)
    }
    if (url.includes('/api/holiday-calendars')) {
      return jsonResponse(holidayCalendarsFixture)
    }
    if (url.includes('/api/leave-requests/me')) {
      return jsonResponse(upcomingHistoryFixture)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

const historyFixture: LeaveRequestHistoryDto = {
  hoursPerDay: 8,
  requests: [
    {
      hoursPerDay: 8,
      requestId: 'req-approved',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Maya Chen',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Approved,
      startDate: '2026-06-10',
      endDate: '2026-06-12',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      unpaidDates: [],
      submittedAt: '2026-05-20T08:00:00.000Z',
      comment: 'Quarter-end reset',
      decisionComment: 'Approved, coverage arranged.',
      decidedAt: '2026-05-22T10:00:00.000Z',
      approvers: [
        {
          email: 'manager@example.com',
          kind: ApproverKind.To,
          displayName: 'Manager',
          decision: ApproverDecision.Approved,
          decidedAt: '2026-05-22T10:00:00.000Z',
        },
        {
          email: 'hr@example.com',
          kind: ApproverKind.Cc,
          displayName: 'HR',
          decision: ApproverDecision.Pending,
        },
      ],
      activity: [
        {
          actorDisplayName: 'Maya Chen',
          action: 'Submitted leave request',
          occurredAt: '2026-05-20T08:00:00.000Z',
        },
        {
          actorDisplayName: 'Manager',
          action: 'Approved leave request',
          occurredAt: '2026-05-22T10:00:00.000Z',
        },
      ],
      balanceTimeline: [
        {
          effectiveDate: '2026-05-20',
          leaveType: LeaveType.Vacation,
          deltaDays: -2,
          availableDays: 15,
          onHoldDays: 2,
          spentDays: 4,
          reason: LeaveBalanceChangeReason.Hold,
          note: 'Held for request req-approved',
        },
        {
          // The leave was lived through: the hold turned into spend, one day
          // at a time, and this is the figure the request left behind.
          effectiveDate: '2026-06-10',
          leaveType: LeaveType.Vacation,
          deltaDays: -2,
          availableDays: 15,
          onHoldDays: 0,
          spentDays: 6,
          reason: LeaveBalanceChangeReason.Spent,
          note: 'Consumed approved leave day 2026-06-10 for request req-approved',
        },
      ],
    },
  ],
  balanceTimeline: [
    {
      effectiveDate: '2026-05-20',
      leaveType: LeaveType.Vacation,
      deltaDays: -2,
      availableDays: 15,
      onHoldDays: 2,
      spentDays: 4,
      reason: LeaveBalanceChangeReason.Hold,
      note: 'Held for request req-approved',
    },
    {
      effectiveDate: '2026-06-10',
      leaveType: LeaveType.Vacation,
      deltaDays: -2,
      availableDays: 15,
      onHoldDays: 0,
      spentDays: 6,
      reason: LeaveBalanceChangeReason.Spent,
      note: 'Consumed approved leave day 2026-06-10 for request req-approved',
    },
  ],
  generatedAt: '2026-07-01T09:00:00.000Z',
}

// History-page fixture with a second, pending request that exercises the
// prototype card anatomy: 5 deciding approvers (folds behind "+2 more"),
// 4 CC recipients (max+1 — renders unfolded), and a cancel affordance.
// Deliberately separate from historyFixture, which composer tests reuse.
const historyWindowFixture: LeaveRequestHistoryDto = {
  ...historyFixture,
  // The snapshot instant postdates every submission it contains.
  generatedAt: '2026-07-22T09:00:00.000Z',
  requests: [
    ...historyFixture.requests,
    {
      hoursPerDay: 8,
      requestId: 'req-window-rejected',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Maya Chen',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Rejected,
      startDate: '2026-07-02',
      endDate: '2026-07-03',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      submittedAt: '2026-06-25T14:12:00.000Z',
      decisionComment: 'Coverage conflict, please resubmit.',
      decidedAt: '2026-06-26T10:05:00.000Z',
      approvers: [
        {
          email: 'manager@example.com',
          kind: ApproverKind.To,
          decision: ApproverDecision.Rejected,
          decidedAt: '2026-06-26T10:05:00.000Z',
        },
      ],
      activity: [
        {
          actorDisplayName: 'Maya Chen',
          action: 'Submitted leave request',
          occurredAt: '2026-06-25T14:12:00.000Z',
        },
      ],
      balanceTimeline: [],
      unpaidDates: [],
    },
    {
      hoursPerDay: 8,
      requestId: 'req-window-pending',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Maya Chen',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Pending,
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      requestedDays: 4,
      paidDays: 4,
      unpaidDays: 0,
      heldDays: 4,
      submittedAt: '2026-07-21T09:15:00.000Z',
      comment: 'Conference follow-up trip',
      // The serializer always sends a decision (Pending until someone acts).
      approvers: [
        {
          email: 'manager@example.com',
          kind: ApproverKind.To,
          displayName: 'Manager',
          decision: ApproverDecision.Pending,
        },
        { email: 'team.lead@example.com', kind: ApproverKind.To, decision: ApproverDecision.Pending },
        { email: 'robin.finance@example.com', kind: ApproverKind.To, decision: ApproverDecision.Pending },
        { email: 'anna.hr@example.com', kind: ApproverKind.To, decision: ApproverDecision.Pending },
        { email: 'lena.qa@example.com', kind: ApproverKind.To, decision: ApproverDecision.Pending },
        { email: 'hr@example.com', kind: ApproverKind.Cc, decision: ApproverDecision.Pending },
        { email: 'people.ops@example.com', kind: ApproverKind.Cc, decision: ApproverDecision.Pending },
        { email: 'office@example.com', kind: ApproverKind.Cc, decision: ApproverDecision.Pending },
        { email: 'assist@example.com', kind: ApproverKind.Cc, decision: ApproverDecision.Pending },
      ],
      activity: [
        {
          actorDisplayName: 'Maya Chen',
          action: 'Submitted leave request',
          occurredAt: '2026-07-21T09:15:00.000Z',
        },
      ],
      balanceTimeline: [],
      unpaidDates: [],
    },
  ],
}

const formContextFixture: LeaveRequestFormContextDto = {
  users: [
    { userId: 'user-manager', displayName: 'Manager', email: 'manager@example.com' },
    { userId: 'user-hr', displayName: 'HR', email: 'hr@example.com' },
    { userId: 'user-peer', displayName: 'Peer Colleague', email: 'peer@example.com' },
  ],
  // One resolved default (a provisioned user) and one bare address, so tests
  // cover both locked-chip labels: display name and raw email.
  defaultApprovers: [{ email: 'lead@example.com', displayName: 'Lena Lead' }],
  defaultCc: [{ email: 'people-ops@example.com' }],
  approvalRequired: true,
  hoursPerDay: 8,
}

const createdRequestFixture: LeaveRequestDetailDto = {
  hoursPerDay: 8,
  requestId: 'req-new',
  requesterUserId: 'employee-1',
  requesterDisplayName: 'Maya Chen',
  leaveType: LeaveType.Vacation,
  status: LeaveRequestStatus.Pending,
  startDate: '2026-09-01',
  endDate: '2026-09-05',
  requestedDays: 4,
  paidDays: 4,
  unpaidDays: 0,
  heldDays: 4,
  submittedAt: '2026-07-02T08:30:00.000Z',
  comment: 'Late summer break',
  approvers: [
    { email: 'manager@example.com', kind: ApproverKind.To, displayName: 'Manager' },
    { email: 'hr@example.com', kind: ApproverKind.Cc, displayName: 'HR' },
  ],
  activity: [
    {
      actorDisplayName: 'Maya Chen',
      action: 'Submitted leave request',
      occurredAt: '2026-07-02T08:30:00.000Z',
    },
  ],
  balanceTimeline: [],
  unpaidDates: [],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function renderWithStore(
  store: ReturnType<typeof createEmployeeFeatureStore>,
  element: ReactNode,
  route: string,
): string {
  return renderToString(
    <MemoryRouter initialEntries={[route]}>
      <Provider store={store}>{element}</Provider>
    </MemoryRouter>,
  )
}

function normalizeServerMarkup(markup: string): string {
  return markup.split('<!-- -->').join('')
}

// Composer store whose context fetch serves the given dashboard (and the
// shared historyFixture), already dispatched and settled — the common setup
// for LeaveRequestPageContent render tests.
async function createComposerStore(dashboard: EmployeeDashboardDto) {
  const store = createEmployeeFeatureStore(
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/dashboard/me')) {
        return jsonResponse(dashboard)
      }
      if (url.includes('/api/leave-requests/form-context')) {
        return jsonResponse(formContextFixture)
      }
      return jsonResponse(historyFixture)
    }) as typeof fetch,
  )
  store.dispatch(employeeFeatureActions.requestContextRequested())
  await flushAsyncWork()
  return store
}

describe('employee pages', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the dashboard from the employee dashboard endpoint', async () => {
    const fetchMock = dashboardFetchMock(dashboardFixture)
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    // Second tick lets the chained upcoming fetches (fired on
    // dashboardReceived) settle too.
    await flushAsyncWork()

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/dashboard/me'))
    expect(store.getState().dashboard.data).toEqual(dashboardFixture)

    // The upcoming resource queries the approved-overlap window derived from
    // the server's generatedAt, plus the employee-country calendars.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/leave-requests/me?status=approved&from=2026-07-01&to=2026-07-15'),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/holiday-calendars?countryCode=UA'),
    )
    expect(store.getState().upcoming.status).toBe('succeeded')

    const markup = normalizeServerMarkup(
      renderWithStore(store, <EmployeeDashboardPageContent />, '/employee/dashboard'),
    )

    // Hero greets by first name; the stable page label stays in the breadcrumb
    // (asserted via its testid — the word "Dashboard" alone also matches the
    // sidebar nav label).
    expect(markup).toContain('Good ')
    expect(markup).toContain(', Maya')
    expect(markup).toContain('shell-breadcrumb')
    expect(markup).toContain('refreshes automatically')

    // KPI tiles replace the old balances card.
    expect(markup).toContain('Vacation available')
    expect(markup).toContain('Sick available')
    expect(markup).toContain('Taken this year')
    expect(markup).toContain('accrued so far')
    expect(markup).not.toContain('carried over from last year')

    // Upcoming timeline merges the approved request and the public holiday.
    expect(markup).toContain('Upcoming')
    expect(markup).toContain('Statehood Day')
    expect(markup).toContain('Public holiday')
    expect(markup).toContain('upcoming-leave-2026-07-03')

    // Pending request column with its actions; both dashboard columns deep-link
    // to the request detail page.
    expect(markup).toContain('Family travel')
    expect(markup).toContain('Cancel request')
    expect(markup).toContain('href="/employee/history/req-pending"')
    expect(markup).toContain('href="/employee/history/req-upcoming"')

    // A ready profile with a configured current-year calendar shows neither the
    // setup placeholder nor the calendar warning.
    expect(markup).not.toContain('profile-pending-state')
    expect(markup).not.toContain('dashboard-calendar-warning')
    // No policy on the fixture (a pre-cutover account), so no policy line.
    expect(markup).not.toContain('dashboard-policy-line')
  })

  it('warns about probation on the dashboard, without naming the policy', async () => {
    const withPolicy: EmployeeDashboardDto = {
      ...dashboardFixture,
      policyName: 'Standard',
      probationEndsOn: '2026-09-01',
    }
    const store = createEmployeeFeatureStore(
      dashboardFetchMock(withPolicy) as typeof fetch,
    )

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    await flushAsyncWork()

    const markup = normalizeServerMarkup(
      renderWithStore(store, <EmployeeDashboardPageContent />, '/employee/dashboard'),
    )

    expect(markup).toContain('dashboard-policy-line')
    expect(markup).toContain(`On probation until ${formatDate('2026-09-01')}`)
    // The policy name is an internal grouping, not something the employee can
    // act on, and the numbers it implies are already on the balance tiles.
    expect(markup).not.toContain('Your leave policy')
    expect(markup).not.toContain('Standard')
  })

  it('degrades the upcoming timeline gracefully when its fetches fail', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/dashboard/me')) {
        return jsonResponse(dashboardFixture)
      }
      // Both chained upcoming endpoints go down; the dashboard itself is fine.
      return new Response('upstream unavailable', { status: 502 })
    })
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    await flushAsyncWork()

    expect(store.getState().dashboard.status).toBe('succeeded')
    expect(store.getState().upcoming.status).toBe('failed')

    const markup = normalizeServerMarkup(
      renderWithStore(store, <EmployeeDashboardPageContent />, '/employee/dashboard'),
    )
    // KPI tiles and pending requests render regardless; the Upcoming card
    // shows its soft warning instead of rows.
    expect(markup).toContain('Vacation available')
    expect(markup).toContain('Family travel')
    expect(markup).toContain('upcoming timeline could not be loaded')
    expect(markup).not.toContain('upcoming-timeline')
  })

  it('skips the holiday-calendar fetch when the employee has no country', async () => {
    const noCountryDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      countryCode: undefined,
    }
    const fetchMock = dashboardFetchMock(noCountryDashboard)
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    await flushAsyncWork()

    const calls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(calls.some((url) => url.includes('/api/holiday-calendars'))).toBe(false)
    expect(store.getState().upcoming.status).toBe('succeeded')
    expect(store.getState().upcoming.data?.holidayCalendars).toEqual([])

    const markup = normalizeServerMarkup(
      renderWithStore(store, <EmployeeDashboardPageContent />, '/employee/dashboard'),
    )
    // The leave half of the timeline still renders without holidays.
    expect(markup).toContain('upcoming-leave-2026-07-03')
    expect(markup).not.toContain('Statehood Day')
  })

  it('warns on the dashboard when the current year has no holiday calendar', async () => {
    const noCurrentYearCalendar: EmployeeDashboardDto = {
      ...dashboardFixture,
      // Configured for 2027 only; current year (generatedAt 2026-07-01) missing.
      holidayCalendarYears: [2027],
    }
    const store = createEmployeeFeatureStore(
      dashboardFetchMock(noCurrentYearCalendar) as typeof fetch,
    )
    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    await flushAsyncWork()

    const markup = normalizeServerMarkup(
      renderWithStore(store, <EmployeeDashboardPageContent />, '/employee/dashboard'),
    )
    // The banner appears above the KPI tiles, which stay fully visible.
    expect(markup).toContain('dashboard-calendar-warning')
    expect(markup).toContain('current year (2026')
    expect(markup).toContain('Vacation available')
  })

  it('replaces the employee pages with the setup notice while the profile card is incomplete', async () => {
    const pendingDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      profileStatus: EmployeeProfileStatus.PendingSetup,
    }
    const fetchMock = dashboardFetchMock(pendingDashboard)
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()

    // Dashboard: the setup notice REPLACES the content — no balances, no
    // pending requests, no activity.
    const dashboardMarkup = renderWithStore(
      store,
      <EmployeeDashboardPageContent />,
      '/employee/dashboard',
    )
    expect(dashboardMarkup).toContain('profile-pending-state')
    expect(dashboardMarkup).toContain('contact your administrator')
    // No balance grid, no pending-request cards, no activity feed. (The word
    // "Balances" also lives in the nav sidebar, so match content markers.)
    expect(dashboardMarkup).not.toContain('Family travel')
    expect(dashboardMarkup).not.toContain('Pending requests')
    expect(dashboardMarkup).not.toContain('Recent activity')

    // The request composer shares the same DTO: the whole form is replaced by
    // the same notice (the backend rejects submissions anyway).
    const composerStore = await createComposerStore(pendingDashboard)

    const requestMarkup = renderWithStore(
      composerStore,
      <LeaveRequestPageContent />,
      '/employee/request',
    )
    expect(requestMarkup).toContain('profile-pending-state')
    expect(requestMarkup).not.toContain('data-testid="leave-request-submit"')
    expect(requestMarkup).not.toContain('leave-request-calendar')
  })

  it('shows the not-started notice with the start date for a future-dated employee', async () => {
    const notStartedDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      profileStatus: EmployeeProfileStatus.NotStartedYet,
      employmentStartDate: '2026-09-01',
    }
    const fetchMock = dashboardFetchMock(notStartedDashboard)
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()

    const markup = renderWithStore(
      store,
      <EmployeeDashboardPageContent />,
      '/employee/dashboard',
    )
    // Same full-page replacement, but the message explains the future start
    // instead of blaming an unfinished setup.
    expect(markup).toContain('profile-pending-state')
    expect(markup).toContain('Employment starts soon')
    expect(markup).toContain('Your employment starts on')
    expect(markup).not.toContain('still being set up')
    expect(markup).not.toContain('Family travel')
  })

  it('replaces the composer immediately when no holiday calendar is configured at all', async () => {
    const noCalendarDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      holidayCalendarYears: [],
    }
    const composerStore = await createComposerStore(noCalendarDashboard)

    const markup = renderWithStore(
      composerStore,
      <LeaveRequestPageContent />,
      '/employee/request',
    )
    // Known on page load — no date picking required to see the problem.
    expect(markup).toContain('calendar-missing-state')
    expect(markup).toContain('contact your administrator')
    expect(markup).not.toContain('data-testid="leave-request-submit"')
    expect(markup).not.toContain('leave-request-calendar')
  })

  it('warns on page load when the current year has no holiday calendar', async () => {
    // Calendars exist (2027), but the CURRENT year per the server's
    // generatedAt (2026-07-01) is not configured — the employee sees the
    // warning immediately, while the form stays usable for configured years.
    const futureOnlyDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      holidayCalendarYears: [2027],
    }
    const composerStore = await createComposerStore(futureOnlyDashboard)

    const markup = normalizeServerMarkup(
      renderWithStore(composerStore, <LeaveRequestPageContent />, '/employee/request'),
    )
    expect(markup).toContain('current-year-calendar-warning')
    expect(markup).toContain('current year (2026')
    // The composer itself is NOT replaced: a 2027 request is legitimate. The
    // inline calendar renders with its footer hint, so the check is not just
    // for a wrapper testid.
    expect(markup).toContain('leave-request-calendar')
    expect(markup).toContain('Pick a start date. A single day is fine too.')
    expect(markup).toContain('data-testid="leave-request-submit"')
    // The composer offers the hours editor, closed, on a workday the form
    // context published: without it the employee can only book whole days.
    expect(markup).toContain('Partial days')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('8h = a full working day.')
  })

  it('counts a settings default approver toward the submit requirement', () => {
    // The submit gate behind canSubmit: a default 'to' approver alone must
    // enable submission (the server accepts a defaults-only payload), while
    // no approver from either source must keep it disabled.
    expect(hasRequiredApprover([], [], true)).toBe(false)
    expect(hasRequiredApprover(['manager@example.com'], [], true)).toBe(true)
    expect(hasRequiredApprover([], [{ email: 'lead@example.com' }], true)).toBe(
      true,
    )
    // With approval optional there is nothing to require: an empty form is a
    // legitimate submission the server approves on the spot.
    expect(hasRequiredApprover([], [], false)).toBe(true)
  })

  it('prunes draft picks that a refreshed context promoted into locked defaults', () => {
    const locked = new Set(['lead@example.com'])
    expect(
      pruneLockedEmails(['lead@example.com', 'peer@example.com'], locked),
    ).toEqual(['peer@example.com'])
    // Identity is preserved when nothing changes, so the state setter bails.
    const untouched = ['peer@example.com']
    expect(pruneLockedEmails(untouched, locked)).toBe(untouched)
  })

  it('orders the submit note by what to resolve first and never contradicts canSubmit', () => {
    const ready = {
      hasApprover: true,
      hasDates: true,
      chargeableDays: 3,
      pickedYearMissing: false,
    }
    expect(submitNoteFor({ ...ready, hasApprover: false })).toBe(
      'At least one approver is required before submission.',
    )
    // Approver outranks dates: with neither, the approver message wins.
    expect(
      submitNoteFor({ ...ready, hasApprover: false, hasDates: false }),
    ).toBe('At least one approver is required before submission.')
    expect(submitNoteFor({ ...ready, hasDates: false })).toBe(
      'Pick the leave date(s) to continue.',
    )
    expect(submitNoteFor({ ...ready, chargeableDays: 0 })).toBe(
      'The selected range contains no working days.',
    )
    expect(submitNoteFor({ ...ready, pickedYearMissing: true })).toBe(
      'The selected year has no holiday calendar yet.',
    )
    // A range crossing into an unconfigured year gets its own message; the
    // start year's gap outranks it when both apply.
    expect(submitNoteFor({ ...ready, endYearMissing: true })).toBe(
      'The selected range runs into a year with no holiday calendar yet.',
    )
    expect(
      submitNoteFor({ ...ready, pickedYearMissing: true, endYearMissing: true }),
    ).toBe('The selected year has no holiday calendar yet.')
    // Working days outrank the calendar-year notice when both block.
    expect(
      submitNoteFor({ ...ready, chargeableDays: 0, pickedYearMissing: true }),
    ).toBe('The selected range contains no working days.')
    expect(submitNoteFor(ready)).toBe('Ready to submit.')
    // Unpaid days do not block, so the note stays a readiness note; it just
    // says the price before the button beside it is pressed.
    expect(submitNoteFor({ ...ready, unpaidDays: 3 })).toBe(
      'Ready to submit. 3d of this request will be unpaid.',
    )
    // A real blocker still outranks it, and no longer blames the balance.
    expect(
      submitNoteFor({ ...ready, unpaidDays: 3, availabilityBlocked: true }),
    ).toBe('These dates cannot be booked; the notice above says why.')
    // Probation refines the unpaid note with the date pay starts. It never
    // adds a note of its own, and never outranks a blocker.
    expect(
      submitNoteFor({ ...ready, unpaidDays: 3, probationEnd: '2026-09-01' }),
    ).toBe(
      `Ready to submit. 3d of this request will be unpaid. Paid leave starts ${formatDate('2026-09-01')}.`,
    )
    expect(submitNoteFor({ ...ready, probationEnd: '2026-09-01' })).toBe(
      'Ready to submit.',
    )
    expect(
      submitNoteFor({
        ...ready,
        unpaidDays: 3,
        probationEnd: '2026-09-01',
        availabilityBlocked: true,
      }),
    ).toBe('These dates cannot be booked; the notice above says why.')
  })

  it('announces an automatic approval alongside the unpaid warning, not instead of it', () => {
    const ready = {
      hasApprover: true,
      hasDates: true,
      chargeableDays: 3,
      pickedYearMissing: false,
    }
    expect(submitNoteFor({ ...ready, willAutoApprove: true })).toBe(
      'Ready to submit. No approvers are required; this request will be approved automatically.',
    )
    // The regression this guards: the unpaid branch used to return early, so a
    // request that was both unpaid and unapproved never mentioned the latter.
    expect(
      submitNoteFor({ ...ready, willAutoApprove: true, unpaidDays: 3 }),
    ).toBe(
      'Ready to submit. 3d of this request will be unpaid. No approvers are required; this request will be approved automatically.',
    )
    // Someone was named under the same optional mode: an ordinary approval.
    expect(submitNoteFor({ ...ready, willAutoApprove: false })).toBe(
      'Ready to submit.',
    )
    // A blocker still outranks it.
    expect(
      submitNoteFor({ ...ready, willAutoApprove: true, chargeableDays: 0 }),
    ).toBe('The selected range contains no working days.')
  })

  it('nets held days out of every user-facing available figure', () => {
    // Client mirror of the server's bookableDays: the DTO's availableDays only
    // nets spent, so the user-facing "available" subtracts holds on top.
    expect(bookableDaysOf({ availableDays: 5, onHoldDays: 3 })).toBe(2)
    expect(bookableDaysOf({ availableDays: 15, onHoldDays: 0 })).toBe(15)
    // Fully-reserved balances clamp at zero, never a negative day count.
    expect(bookableDaysOf({ availableDays: 2, onHoldDays: 3 })).toBe(0)
  })

  it('derives what this request leaves unpaid from the balance snapshot', () => {
    const balances = dashboardFixture.balances
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '',
        endDate: '',
        costDays: 0,
        balances,
      }),
    ).toEqual({ kind: 'empty' })
    // Dates picked, but every day is a weekend/holiday.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-07-04',
        endDate: '2026-07-05',
        costDays: 0,
        balances,
      }),
    ).toEqual({ kind: 'zero-cost' })
    // Fixture vacation carries no projection, so it falls back to BOOKABLE:
    // availableDays 15 minus 3 on hold = 12, which covers three days over.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-05',
        costDays: 3,
        balances,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 0, fromServer: false })
    // Past what the year can fund, the excess is unpaid rather than an
    // overdraft: the count is what the balance cannot reach, 20 - 12.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-09-11',
        costDays: 20,
        balances,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 8, fromServer: false })
    // A change costs the difference only: the days it hands back count too.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-09-11',
        costDays: 20,
        balances,
        replacedDays: 5,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 3, fromServer: false })
    // With a projection the year-end figure wins over today's bookable one.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-09-11',
        costDays: 20,
        balances: [{ ...balances[0]!, projectedRemainingDays: 18 }],
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 2, fromServer: false })
    // No balance at all: nothing can be funded.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Sick,
        startDate: '2026-08-03',
        endDate: '2026-08-04',
        costDays: 2,
        balances: [],
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 2, fromServer: false })
  })

  it('prefers the server split over its own estimate, and only for the dates it covers', () => {
    const balances = dashboardFixture.balances
    const preview = {
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-03',
      endDate: '2026-08-28',
      // The COST the server priced, which is what says whether its verdict is
      // about the shape the form now holds.
      requestedDays: 10,
      unpaidDays: 3,
    }
    // The server judges each day against the accrual due on it, which this
    // year-end arithmetic can only approximate, so its verdict wins.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-28',
        costDays: 10,
        balances,
        preview,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 3, fromServer: true })
    // A verdict for OTHER dates is not a verdict about these ones.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
        costDays: 10,
        balances,
        preview,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 0, fromServer: false })
    // Nor is a verdict for the same dates a verdict about the same request
    // once a day of it has been shortened: the local estimate stands in until
    // the server has priced THIS shape.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-28',
        costDays: 9.5,
        balances,
        preview,
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 0, fromServer: false })
  })

  it('summarizes the inline calendar selection through its states', () => {
    // Month names come from the shared formatter, not literals, so the
    // expectations hold on any default ICU locale.
    const jul24 = formatDayMonth('2026-07-24')
    const jul25 = formatDayMonth('2026-07-25')
    const jul26 = formatDayMonth('2026-07-26')
    const jul27 = formatDayMonth('2026-07-27')
    // Empty, open (anchor set), settled single day, settled range, zero-cost.
    expect(selectionSummary({ startDate: '', endDate: '' }, null, 0)).toEqual({
      text: 'Pick a start date. A single day is fine too.',
      warn: false,
    })
    expect(
      selectionSummary(
        { startDate: '2026-07-24', endDate: '2026-07-24' },
        '2026-07-24',
        1,
      ),
    ).toEqual({
      text: `${jul24} · 1 working day so far. Pick the end date or submit a single day.`,
      warn: false,
    })
    // First click on a weekend: an open anchor never warns (the range may
    // still grow to cover working days), it just counts zero so far.
    expect(
      selectionSummary(
        { startDate: '2026-07-25', endDate: '2026-07-25' },
        '2026-07-25',
        0,
      ),
    ).toEqual({
      text: `${jul25} · 0 working days so far. Pick the end date or submit a single day.`,
      warn: false,
    })
    expect(
      selectionSummary({ startDate: '2026-07-24', endDate: '2026-07-24' }, null, 1),
    ).toEqual({ text: `${jul24} · 1 working day`, warn: false })
    expect(
      selectionSummary({ startDate: '2026-07-24', endDate: '2026-07-27' }, null, 2),
    ).toEqual({ text: `${jul24} → ${jul27} · 2 working days`, warn: false })
    // A weekend-only settled range warns: the server would reject it and the
    // submit button is gated on the same count.
    expect(
      selectionSummary({ startDate: '2026-07-25', endDate: '2026-07-26' }, null, 0),
    ).toEqual({ text: `${jul25} → ${jul26} · no working days in this range`, warn: true })
    // A New Year crossing names each end's own year; the compact year-less
    // pair would silently read as one year.
    expect(
      selectionSummary({ startDate: '2026-12-28', endDate: '2027-01-05' }, null, 7),
    ).toEqual({
      text: `${formatDate('2026-12-28')} → ${formatDate('2027-01-05')} · 7 working days`,
      warn: false,
    })
  })

  it('prints the year on both ends of a range only when it crosses the New Year', () => {
    const crossing = normalizeServerMarkup(
      renderToString(
        <RangeLine startDate="2026-12-25" endDate="2027-01-05" daysLabel="8d" />,
      ),
    )
    expect(crossing).toContain(formatDate('2026-12-25'))
    expect(crossing).toContain(formatDate('2027-01-05'))

    const single = normalizeServerMarkup(
      renderToString(
        <RangeLine startDate="2026-07-24" endDate="2026-07-27" daysLabel="2d" />,
      ),
    )
    expect(single).toContain(formatDayMonth('2026-07-24'))
    expect(single).not.toContain(formatDate('2026-07-24'))
    expect(single).toContain(formatDate('2026-07-27'))
  })

  // The four dashboard tiles print the figure and its unit as separate styled
  // parts, so they render the notation rather than calling formatDays. They
  // must still read exactly what formatDays would.
  it('prints a sub-day KPI headline without a leading zero-day', () => {
    // The headline of one tile. The unit spans in there ARE the notation; the
    // figures themselves animate up from zero, so only the units are stable in
    // server markup.
    const headlineOf = (markup: string, testId: string): string => {
      const head = markup.slice(markup.indexOf(`data-testid="${testId}-amount"`))
      return head.slice(0, head.indexOf('</p>'))
    }
    const gridFor = (availableDays: number): string =>
      normalizeServerMarkup(
        renderToString(
          <BalanceKpiGrid
            balances={[
              {
                leaveType: LeaveType.Vacation,
                totalDays: 24,
                availableDays,
                onHoldDays: 0,
                spentDays: 0,
                accruedDays: availableDays,
                updatedAt: '2026-07-01T09:00:00.000Z',
              },
            ]}
            pendingCount={0}
            hoursPerDay={8}
          />,
        ),
      )

    // Half a day available is "4h" in the app's one notation. The tile used to
    // spell it "0d 4h" while every figure beside it dropped the empty days
    // part - including the tile's own aria-label, which goes through
    // formatDays.
    const half = headlineOf(gridFor(0.5), 'kpi-vacation')
    expect(half).toContain('>h</span>')
    expect(half).not.toContain('>d</span>')
    expect(gridFor(0.5)).toContain('Vacation: 4h available')

    // A whole amount is unchanged: days, no trailing hours.
    const whole = headlineOf(gridFor(3), 'kpi-vacation')
    expect(whole).toContain('>d</span>')
    expect(whole).not.toContain('>h</span>')

    // ...and so is nothing at all, which is the one "0d".
    const none = headlineOf(gridFor(0), 'kpi-vacation')
    expect(none).toContain('>d</span>')
    expect(none).not.toContain('>h</span>')
  })

  it('names last year leftover beside the annual total on the vacation KPI', () => {
    const markup = normalizeServerMarkup(
      renderToString(
        <BalanceKpiGrid
          balances={[
            {
              ...dashboardFixture.balances[0]!,
              carriedOverDays: 7,
              accruedDays: 25,
              availableDays: 22,
              onHoldDays: 0,
              spentDays: 3,
            },
            dashboardFixture.balances[1]!,
          ]}
          pendingCount={0}
          hoursPerDay={8}
        />,
      ),
    )
    // "accrued so far" is what the entitlement earned: the DTO's 25d counts
    // the 7d carryover, which the line already names beside the total.
    expect(markup).toContain(
      'of 24d total + 7d carried over from last year · accrues monthly · 18d accrued so far',
    )
    expect(markup).toContain(
      'of 24d total + 7d carried over from last year',
    )
    expect(markup).not.toContain('carried over from last year · credited up front')
  })

  it('renders the balance meter with a preview segment only while composing', () => {
    const vacation = dashboardFixture.balances[0]!
    // With a draft selection: the preview legend appears and the aria-label
    // names it after the standing figures.
    const withPreview = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={vacation} previewDays={4} />),
    )
    expect(withPreview).toContain('this request affects')
    // Every figure in the label is in the days-and-hours notation, the request
    // size included: it used to be the one bare decimal on the page, so a
    // screen reader announced "0.5" where the legend beside it said "4h".
    expect(withPreview).toContain(
      'Vacation: 12d available, 3d on hold, 6d spent, 4d affected by this request, 3d still to accrue',
    )
    // The header explains the pale unaccrued track (fixture: accrued 18 of
    // 24), so the legend keeps a single line without an extra chip.
    expect(withPreview).toContain('18d of 24d accrued')
    // Without one: no preview legend, and the aria skips the request part.
    const bare = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={vacation} previewDays={0} />),
    )
    expect(bare).not.toContain('this request')
    expect(bare).toContain(
      'Vacation: 12d available, 3d on hold, 6d spent, 3d still to accrue',
    )
    // Zero-value legend chips hide (their bar segment is absent too): the
    // sick fixture (8 available, 0 hold, 2 spent, accrued in full) renders
    // no zero chip and keeps the plain total header.
    const sick = dashboardFixture.balances[1]!
    const sickMarkup = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={sick} previewDays={0} />),
    )
    expect(sickMarkup).toContain('10d total')
    // Matched as the chip's own markup, not as a bare substring: a loose '0d'
    // also matches things like the '90deg' inside a gradient, so the assertion
    // would fail on a stylesheet change that has nothing to do with chips.
    expect(sickMarkup).toContain('>8d</b>')
    expect(sickMarkup).toContain('>2d</b>')
    expect(sickMarkup).not.toContain('>0d</b>')
    // An overdrawn preview stretches the denominator instead of overflowing:
    // no segment may render wider than the track.
    const overdrawn = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={vacation} previewDays={40} />),
    )
    const widths = [...overdrawn.matchAll(/width:([\d.]+)%/g)].map(([, w]) => Number(w))
    expect(widths.length).toBeGreaterThan(0)
    for (const width of widths) {
      expect(width).toBeLessThanOrEqual(100)
    }
  })

  it('still draws the bar for a zero allowance that has days spent', async () => {
    // Somebody moved onto a no-leave policy mid-year keeps the days they
    // already took. Hiding the bar left the card reading "0 days · 5d spent"
    // with nothing to explain it.
    const store = createEmployeeFeatureStore(
      dashboardFetchMock({
        ...dashboardFixture,
        balances: [
          dashboardFixture.balances[0]!,
          {
            leaveType: LeaveType.Sick,
            totalDays: 0,
            availableDays: 0,
            onHoldDays: 0,
            spentDays: 5,
            accruedDays: 5,
            updatedAt: '2026-07-01T09:00:00.000Z',
          },
        ],
      }) as typeof fetch,
    )
    store.dispatch(employeeFeatureActions.dashboardRequested())
    await flushAsyncWork()
    await flushAsyncWork()

    const markup = renderWithStore(
      store,
      <EmployeeDashboardPageContent />,
      '/employee/dashboard',
    )

    expect(markup).toContain(
      'Sick leave: 0d available, 0d on hold, 5d spent, of 0d total',
    )
  })

  it('shows a mid-year joiner the share of the sick allowance they never earn', () => {
    // Sick leave is credited up front but prorated by the hire month, so a
    // joiner's balance carries an unaccrued remainder just like vacation does:
    // the header must explain the pale track rather than claim the full total.
    const proratedSick = {
      ...dashboardFixture.balances[1]!,
      availableDays: 5,
      spentDays: 0,
      accruedDays: 5,
    }
    const markup = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={proratedSick} previewDays={0} />),
    )
    expect(markup).toContain('5d of 10d accrued')
    expect(markup).not.toContain('10d total')
    expect(markup).toContain(
      'Sick leave: 5d available, 0d on hold, 0d spent, 5d still to accrue',
    )
  })

  it('names last year leftover beside the annual total on the balance meter', () => {
    // On the DTO contract (availableDays = accruedDays − spentDays): the base
    // fixture's 15d available belongs to its carry-less 18d accrued, so the
    // carried variant restates it or the head note and the tail would pin two
    // figures that cannot both be true of one balance.
    const carried = {
      ...dashboardFixture.balances[0]!,
      carriedOverDays: 7,
      availableDays: 12,
    }
    const meter = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={carried} previewDays={0} />),
    )
    // The DTO's 18d accrued counts the 7d carryover: the note splits it back
    // into the two named parts, 11d earned of the 24d entitlement + 7d carried.
    expect(meter).toContain('11d of 24d accrued + 7d carried over from last year')
    expect(meter).not.toContain('24d total + 7d')
    // The tail measures against the whole pool (24 + 7): 31 − 9 bookable −
    // 3 held − 6 spent = 13 still to accrue, agreeing with the head note
    // (11 earned of 24 leaves 13), not the 3 the bare total gave.
    expect(meter).toContain(
      'Vacation: 9d available, 3d on hold, 6d spent, 13d still to accrue',
    )

    const fullyAccrued = normalizeServerMarkup(
      renderToString(
        <BalanceMeter
          balance={{ ...carried, accruedDays: 31, availableDays: 25 }}
          previewDays={0}
        />,
      ),
    )
    expect(fullyAccrued).toContain('24d total + 7d carried over from last year')

    // Tiles hide the accrued-of-total note, but still name the leftover.
    const tile = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={carried} variant="tile" />),
    )
    expect(tile).toContain('11d of 24d accrued + 7d carried over from last year')
  })

  it('measures the unaccrued tail against the pool, not the bare annual total', () => {
    // The reported defect, verbatim: 25d annual, 7d carried, 23.667d accrued
    // (16.667 earned + the carryover), 8d spent. The meter used to read the
    // pool as 25d and claim only 1d 2h had yet to accrue with 17d free to
    // plan, while the projection beside it said 24d left this year.
    const carried = {
      ...dashboardFixture.balances[0]!,
      totalDays: 25,
      carriedOverDays: 7,
      accruedDays: 23.667,
      availableDays: 15.667,
      onHoldDays: 0,
      spentDays: 8,
    }
    const meter = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={carried} previewDays={0} />),
    )
    expect(meter).toContain(
      '16d 5h of 25d accrued + 7d carried over from last year',
    )
    expect(meter).toContain(
      'Vacation: 15d 5h available, 0d on hold, 8d spent, 8d 2h still to accrue',
    )

    // The tail tooltip goes through a portal renderToString never paints, so
    // its copy is pinned on the pure function with the same figures.
    expect(
      restExplanation({
        rest: 8.333,
        totalDays: 32,
        spent: 8,
        onHold: 0,
        requested: 0,
      }),
    ).toBe(
      '8d 2h of your allowance has yet to accrue this year. ' +
        'In all, 24d of the year stay free to plan between now and 31 December.',
    )
  })

  it('rounds both ends of the bar even when one band fills it, or a request marks it', () => {
    // A sick balance earned for the whole year may sit entirely in one band.
    // That band is both the first and the last, so it has to carry all four
    // corners.
    const sick = { ...dashboardFixture.balances[1]!, onHoldDays: 0, spentDays: 0 }
    const lone = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={sick} previewDays={0} />),
    )
    expect(lone).toContain('border-top-left-radius:6px')
    expect(lone).toContain('border-bottom-left-radius:6px')
    expect(lone).toContain('border-top-right-radius:6px')
    expect(lone).toContain('border-bottom-right-radius:6px')

    // And with a request on it: the dashed marking is a sibling of the bands,
    // so rounding driven by :last-of-type would hand the right corners to the
    // marking and square off the end of the bar.
    const marked = normalizeServerMarkup(
      renderToString(<BalanceMeter balance={sick} previewDays={2} />),
    )
    expect(marked).toContain('border-top-right-radius:6px')
    expect(marked).toContain('border-bottom-right-radius:6px')
  })

  it('funds a request from the accrual it waits for, then from today', () => {
    // Nothing arriving: the request draws on today's balance alone.
    expect(
      requestDraw({ availableNow: 12, arrivingByThen: 0, requestedDays: 4 }),
    ).toEqual({ fromArriving: 0, fromAvailable: 4, unpaid: 0, covered: 4 })

    // The case the whole feature exists for: 2 days today, 14 more landing
    // before December, a 10-day December request. It is paid for by the
    // arriving days first, so only 0 of today's balance is touched.
    expect(
      requestDraw({ availableNow: 2, arrivingByThen: 14, requestedDays: 10 }),
    ).toEqual({ fromArriving: 10, fromAvailable: 0, unpaid: 0, covered: 10 })

    // A request larger than what arrives spills over into today's days.
    expect(
      requestDraw({ availableNow: 12, arrivingByThen: 4, requestedDays: 10 }),
    ).toEqual({ fromArriving: 4, fromAvailable: 6, unpaid: 0, covered: 10 })

    // Beyond both pools the excess is unpaid rather than clamped away, and the
    // marking covers only the days the balance actually pays for.
    expect(
      requestDraw({ availableNow: 2, arrivingByThen: 3, requestedDays: 40 }),
    ).toEqual({ fromArriving: 3, fromAvailable: 2, unpaid: 35, covered: 5 })

    // Fractional accrual keeps two decimals, matching the server's rounding.
    expect(
      requestDraw({ availableNow: 0, arrivingByThen: 16.67, requestedDays: 10 }),
    ).toEqual({ fromArriving: 10, fromAvailable: 0, unpaid: 0, covered: 10 })
  })

  it('takes the server split over its own estimate of the shortfall', () => {
    // The local arithmetic sees 16 days of room and would call all ten paid;
    // the server walked the range day by day and found three it cannot fund.
    expect(
      requestDraw({
        availableNow: 2,
        arrivingByThen: 14,
        requestedDays: 10,
        unpaidDays: 3,
      }),
    ).toEqual({ fromArriving: 7, fromAvailable: 0, unpaid: 3, covered: 7 })

    // Nothing funded at all: the marking disappears rather than covering days
    // the balance never pays for.
    expect(
      requestDraw({
        availableNow: 8,
        arrivingByThen: 0,
        requestedDays: 5,
        unpaidDays: 5,
      }),
    ).toEqual({ fromArriving: 0, fromAvailable: 0, unpaid: 5, covered: 0 })

    // A stale figure larger than the selection clamps to it.
    expect(
      requestDraw({
        availableNow: 8,
        arrivingByThen: 0,
        requestedDays: 3,
        unpaidDays: 9,
      }),
    ).toEqual({ fromArriving: 0, fromAvailable: 0, unpaid: 3, covered: 0 })
  })

  // A shared fixture builder for the funding window: the December side of the
  // sandbox's cross-year scenario, with holds that already borrowed forward.
  const decemberSide = (over: Partial<Parameters<typeof fundingOf>[0]> = {}) =>
    fundingOf({
      year: 2026,
      totalDays: 25,
      carriedOverDays: 0,
      carryoverProjected: false,
      accruedDays: 14.58,
      spentDays: 3,
      committedDays: 15,
      projectedAccruedByLeave: 25,
      projectedYearEndAccrual: 25,
      requestedDays: 4,
      paidDays: 4,
      unpaidDays: 0,
      carryoverOutDays: 1,
      ...over,
    })
  const januarySide = (over: Partial<Parameters<typeof fundingOf>[0]> = {}) =>
    fundingOf({
      year: 2027,
      totalDays: 25,
      carriedOverDays: 1,
      carryoverProjected: true,
      accruedDays: 0,
      spentDays: 0,
      committedDays: 0,
      projectedAccruedByLeave: 3.08,
      projectedYearEndAccrual: 26,
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      carryoverOutDays: 12,
      ...over,
    })

  it('splits the funding window at the New Year seam, sides proportional to days', () => {
    const markup = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow
          leaveType={LeaveType.Vacation}
          years={[decemberSide(), januarySide()]}
        />,
      ),
    )

    // Sides weigh their days: 7 for December's pool, 3.08 for January's.
    expect(markup).toContain('flex:7 1 0')
    expect(markup).toContain('flex:3.08 1 0')
    expect(markup).toContain('1 Jan 2027')
    // The caps say which year pays for what.
    const caps = markup.slice(
      markup.indexOf('funding-cap-2026'),
      markup.indexOf('funding-side-2026'),
    )
    // Two sides share the bill, so each caption says which year it is.
    expect(caps).toContain('2026 pays for ')
    expect(caps).toContain('>4d</b>')
    expect(caps).toContain('2027 pays for ')
    expect(caps).toContain('>2d</b>')
    // The chip is the NET figure; the gross one is the defect this view fixes.
    expect(markup).toContain('>+7d</b> free by the leave dates')
    expect(markup).not.toContain('>+10d</b>')
    // The carried day is its own band on the receiving year, once.
    expect(markup).toContain('>+1d</b> carried over from 2026')
    expect(markup).toContain('>+2d</b> accrues by the leave')
  })

  it('names leftover that is reserved to fund already-booked next-year leave', () => {
    const years = keepFundingYears(
      [
        fundingOf({
          year: 2026,
          totalDays: 15,
          carriedOverDays: 0,
          carryoverProjected: false,
          accruedDays: 15,
          spentDays: 0,
          committedDays: 4,
          projectedAccruedByLeave: 15,
          projectedYearEndAccrual: 15,
          requestedDays: 2,
          paidDays: 1,
          unpaidDays: 1,
          carryoverOutDays: 5,
        }),
        fundingOf({
          year: 2027,
          totalDays: 15,
          carriedOverDays: 5,
          carryoverProjected: true,
          accruedDays: 0,
          spentDays: 0,
          committedDays: 5,
          projectedAccruedByLeave: 7,
          projectedYearEndAccrual: 20,
          requestedDays: 0,
          paidDays: 0,
          unpaidDays: 0,
          carryoverOutDays: 10,
        }),
      ],
      2026,
    )
    const markup = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow leaveType={LeaveType.Vacation} years={years} />,
      ),
    )

    expect(markup).toContain('2026 pays for ')
    expect(markup).toContain('>1d</b>')
    expect(markup).toContain('1d unpaid')
    expect(markup).toContain('2027 holds ')
    expect(markup).toContain('already booked')
    expect(markup).toContain('>10d</b> reserved to fund 2027')
    expect(markup).toContain('>5d</b> already booked')
  })

  it('keeps captions natural width so a collapsed year cannot push its neighbour', () => {
    // The year is contracted to the last day: its side collapses to a sliver,
    // and its caption must not be squeezed into the neighbour's. This is the
    // sandbox regression pinned as a test.
    const markup = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow
          leaveType={LeaveType.Vacation}
          years={[
            decemberSide({
              spentDays: 10,
              committedDays: 15,
              requestedDays: 0,
              paidDays: 0,
              carryoverOutDays: 0,
            }),
            januarySide({
              carriedOverDays: 0,
              projectedAccruedByLeave: 2.08,
              projectedYearEndAccrual: 25,
              requestedDays: 10,
              paidDays: 2,
              unpaidDays: 8,
              carryoverOutDays: 11,
            }),
          ]}
        />,
      ),
    )

    // Both captions render in full, side by side, pinned to the edges.
    const caps = markup.slice(
      markup.indexOf('funding-cap-2026'),
      markup.indexOf('funding-side-2026'),
    )
    expect(caps).toContain('2026 pays for ')
    expect(caps).toContain('>0d</b>')
    expect(caps).toContain('2027 pays for ')
    expect(caps).toContain('8d unpaid')
    expect(markup).toContain('justify-content:space-between')
    // The stub's flex appears on exactly one element: the bar side, never
    // mirrored onto a caption. Counted by the -ms- prefix because emotion
    // expands one flex declaration into three prefixed copies.
    expect((markup.match(/-ms-flex:0\.14 1 0/g) ?? []).length).toBe(1)
    // And the ribbon says out loud why that side is empty.
    expect(markup).toContain('2026 has nothing left to fund this request')
  })

  it('runs unpaid days past the funded pool as an overflow band', () => {
    // 12 bookable, 20 requested: the pool covers 12 and 8 run past it.
    const single = decemberSide({
      accruedDays: 21,
      spentDays: 6,
      committedDays: 3,
      projectedAccruedByLeave: 21,
      projectedYearEndAccrual: 24,
      totalDays: 24,
      requestedDays: 20,
      paidDays: 12,
      unpaidDays: 8,
      carryoverOutDays: 0,
    })
    const markup = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow leaveType={LeaveType.Vacation} years={[single]} />,
      ),
    )

    // The track is the pool's share of the side; the unpaid band sits past it.
    expect(markup).toContain(`width:${(12 / 20) * 100}%`)
    expect(markup).toContain(`width:${(8 / 20) * 100}%`)
    expect(markup).toContain('margin-left:2px')
    expect(markup).toContain('border-radius:0 6px 6px 0')
    // The dashed outline encloses the whole request, funded and unpaid alike.
    expect(markup).toContain('dashed')
    expect(markup).toContain('>8d</b> unpaid')
    expect(markup).toContain('rgba(224, 79, 57, 0.85)')
    // One year, no seam, and the caption does not name the year: with a single
    // side there is nothing to tell apart, and the calendar already says when.
    expect(markup).not.toContain('1 Jan')
    expect((markup.match(/funding-cap-/g) ?? []).length).toBe(1)
    expect(markup).toContain('Pays for ')
    expect(markup).not.toContain('2026 pays for')

    // Nothing of the sort when the pool covers the request.
    const funded = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow
          leaveType={LeaveType.Vacation}
          years={[decemberSide({ committedDays: 2, carryoverOutDays: 0 })]}
        />,
      ),
    )
    expect(funded).not.toContain('unpaid')
  })

  it('leaves an untouched year without the request outline and says it feeds the carryover', () => {
    // The whole leave is next January: this year charges nothing, but it is
    // where the carryover funding those days comes from.
    const markup = normalizeServerMarkup(
      renderToString(
        <RequestFundingWindow
          leaveType={LeaveType.Vacation}
          years={[
            decemberSide({
              committedDays: 2,
              requestedDays: 0,
              paidDays: 0,
              carryoverOutDays: 10,
            }),
            januarySide({
              carriedOverDays: 10,
              projectedAccruedByLeave: 12.08,
              projectedYearEndAccrual: 35,
              requestedDays: 10,
              paidDays: 10,
            }),
          ]}
        />,
      ),
    )

    const caps = markup.slice(
      markup.indexOf('funding-cap-2026'),
      markup.indexOf('funding-side-2026'),
    )
    expect(caps).toContain('feeds 10d carryover')
    // The dashed request outline marks only the side the request touches.
    const side2026 = markup.slice(
      markup.indexOf('funding-side-2026'),
      markup.indexOf('funding-side-2027'),
    )
    // The request outline is the 1.5px dashed box; the 2px dashed seam rule
    // legitimately sits inside this slice and must not trip the assertion.
    expect(side2026).not.toContain('1.5px dashed')
    expect((markup.match(/this request/g) ?? []).length).toBe(1)
    // The untouched year's arriving chip names the year end, not leave dates.
    expect(markup).toContain('by the year end')
  })

  it('classifies calendar notices with at-most-one result and correct priority', () => {
    // Shared classifier behind the composer alerts, the submit disable, and
    // the dashboard banner. Fixture has [2026] configured, generatedAt 2026.
    expect(calendarNoticeFor('2027-01-05', dashboardFixture)).toEqual({
      kind: 'picked-year-missing',
      year: 2027,
    })
    expect(calendarNoticeFor('2026-08-12', dashboardFixture)).toBeNull()
    // No date picked: current year decides (configured here -> no notice).
    expect(calendarNoticeFor('', dashboardFixture)).toBeNull()
    expect(
      calendarNoticeFor('', { ...dashboardFixture, holidayCalendarYears: [2027] }),
    ).toEqual({ kind: 'current-year-missing', year: 2026 })
    // Empty configuration outranks everything, date picked or not.
    expect(
      calendarNoticeFor('2026-08-12', { ...dashboardFixture, holidayCalendarYears: [] }),
    ).toEqual({ kind: 'none-configured' })
    // Unknown context never pre-blocks — the backend guard is the enforcer.
    expect(calendarNoticeFor('2027-01-05', undefined)).toBeNull()

    // A range crossing into an unconfigured year is blocked by its END: the
    // start year is fine, the far side is what has no calendar.
    expect(
      calendarNoticeFor('2026-12-25', dashboardFixture, '2027-01-05'),
    ).toEqual({ kind: 'end-year-missing', year: 2027 })
    // Both years configured: the crossing is clean.
    expect(
      calendarNoticeFor(
        '2026-12-25',
        { ...dashboardFixture, holidayCalendarYears: [2026, 2027] },
        '2027-01-05',
      ),
    ).toBeNull()
    // The start year's own gap still outranks the end-year rule.
    expect(
      calendarNoticeFor('2027-12-28', dashboardFixture, '2028-01-04'),
    ).toEqual({ kind: 'picked-year-missing', year: 2027 })
    // A single-year range never triggers the end-year branch.
    expect(
      calendarNoticeFor('2026-08-12', dashboardFixture, '2026-08-14'),
    ).toBeNull()
  })

  it('submits a new leave request with approver and cc recipients', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes('/api/dashboard/me')) {
        return jsonResponse(dashboardFixture)
      }

      if (url.includes('/api/leave-requests/form-context')) {
        return jsonResponse(formContextFixture)
      }

      if (url.includes('/api/leave-requests/me')) {
        return jsonResponse(historyFixture)
      }

      if (url.includes('/api/leave-requests') && init?.method === 'POST') {
        return jsonResponse(createdRequestFixture)
      }

      throw new Error(`Unexpected request: ${url}`)
    })
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.requestContextRequested())
    await flushAsyncWork()

    store.dispatch(
      employeeFeatureActions.requestSubmitted({
        leaveType: LeaveType.Vacation,
        startDate: '2026-09-01',
        endDate: '2026-09-05',
        comment: 'Late summer break',
        approverEmails: ['manager@example.com'],
        ccEmails: ['hr@example.com'],
      }),
    )
    await flushAsyncWork()

    const submitCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(submitCall).toBeDefined()
    expect(String(submitCall?.[0])).toContain('/api/leave-requests')
    expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
      leaveType: LeaveType.Vacation,
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      comment: 'Late summer break',
      approverEmails: ['manager@example.com'],
      ccEmails: ['hr@example.com'],
    })

    const markup = normalizeServerMarkup(
      renderWithStore(store, <LeaveRequestPageContent />, '/employee/request'),
    )

    expect(markup).toContain('Submitted vacation request')
    // Settings defaults render as locked, non-removable chips: a resolved user
    // shows their display name, an unmatched address shows the raw email.
    expect(markup).toContain('Included automatically by company policy')
    expect(markup).toContain('Lena Lead')
    expect(markup).toContain('people-ops@example.com')
    // The submit note reflects the form state at render time: this render has
    // no dates picked (the submission above went through the store directly).
    expect(markup).toContain('Pick the leave date(s) to continue.')
    // The inline calendar renders directly in the page markup (no popover).
    // '>Clear</button>' pins the calendar footer button specifically: the
    // Autocomplete clear indicators render as aria-label/title attributes
    // with an SVG child, so a bare 'Clear' would match those vacuously.
    expect(markup).toContain('leave-request-calendar')
    expect(markup).toContain('Public holiday')
    expect(markup).toContain('>Clear</button>')
    // Leave-type segmented control: exactly one option pressed, the other
    // not, with the type hint below; the prototype's Compensation control is
    // deliberately not ported.
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('Vacation spends your vacation balance (accrues monthly).')
    expect(markup).not.toContain('Compensation')
    // Right rail: meter bars with floored legend figures from the fixture
    // (vacation availableDays 15 minus 3 on hold = 12 bookable; accrued 18
    // of 24 in the header) and the live impact card's empty state.
    expect(markup).toContain('18d of 24d accrued')
    expect(markup).toContain('Vacation: 12d available, 3d on hold, 6d spent')
    expect(markup).toContain('Nothing selected yet')
  })

  it('refreshes the pending chip and on-hold balance after a successful submit', async () => {
    // The server reflects the new request on the next dashboard read: one more
    // pending request and a higher vacation on-hold figure.
    const updatedDashboard: EmployeeDashboardDto = {
      ...dashboardFixture,
      balances: dashboardFixture.balances.map((balance) =>
        balance.leaveType === LeaveType.Vacation
          ? { ...balance, onHoldDays: 7 }
          : balance,
      ),
      pendingRequests: [
        ...dashboardFixture.pendingRequests,
        {
          requestId: 'req-new',
          leaveType: LeaveType.Vacation,
          status: LeaveRequestStatus.Pending,
          startDate: '2026-09-01',
          endDate: '2026-09-05',
          requestedDays: 4,
          paidDays: 4,
          unpaidDays: 0,
          heldDays: 4,
          submittedAt: '2026-07-02T08:30:00.000Z',
        },
      ],
    }

    let submitted = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes('/api/leave-requests') && init?.method === 'POST') {
        submitted = true
        return jsonResponse(createdRequestFixture)
      }

      if (url.includes('/api/dashboard/me')) {
        return jsonResponse(submitted ? updatedDashboard : dashboardFixture)
      }

      if (url.includes('/api/leave-requests/form-context')) {
        return jsonResponse(formContextFixture)
      }

      if (url.includes('/api/leave-requests/me')) {
        return jsonResponse(historyFixture)
      }

      throw new Error(`Unexpected request: ${url}`)
    })
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.requestContextRequested())
    await flushAsyncWork()

    // Before submitting, the workspace shows the single seeded pending request.
    expect(store.getState().requestComposer.dashboard?.pendingRequests).toHaveLength(1)

    store.dispatch(
      employeeFeatureActions.requestSubmitted({
        leaveType: LeaveType.Vacation,
        startDate: '2026-09-01',
        endDate: '2026-09-05',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    )
    // Two async hops: the POST, then the automatic context refetch it triggers.
    await flushAsyncWork()
    await flushAsyncWork()
    await flushAsyncWork()

    const composer = store.getState().requestComposer
    expect(composer.submitStatus).toBe('succeeded')
    // Content stays visible (not flashed back to the full-page loader) and the
    // pending chip + on-hold balance reflect the new request without a reload.
    expect(composer.contextStatus).toBe('succeeded')
    expect(composer.dashboard?.pendingRequests).toHaveLength(2)
    expect(
      composer.dashboard?.balances.find(
        (balance) => balance.leaveType === LeaveType.Vacation,
      )?.onHoldDays,
    ).toBe(7)

    // The dashboard endpoint was read twice: the initial load and the refresh.
    const dashboardCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/dashboard/me'),
    )
    expect(dashboardCalls).toHaveLength(2)
  })

  it('loads request history and applies the date window through the history endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse(historyWindowFixture))
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(employeeFeatureActions.historyRequested({}))
    await flushAsyncWork()
    // The date window round-trips; status filtering is client-side, so the
    // page never sends `status=`.
    store.dispatch(
      employeeFeatureActions.historyRequested({
        from: '2026-01-01',
        to: '2026-12-31',
      }),
    )
    await flushAsyncWork()

    const lastHistoryCall =
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]
    expect(String(lastHistoryCall)).toContain('/api/leave-requests/me')
    expect(String(lastHistoryCall)).not.toContain('status=')
    expect(String(lastHistoryCall)).toContain('from=2026-01-01')
    expect(String(lastHistoryCall)).toContain('to=2026-12-31')

    const markup = normalizeServerMarkup(
      renderWithStore(store, <LeaveHistoryPageContent />, '/employee/history'),
    )

    expect(markup).toContain('Request history')
    // Card anatomy: quoted note, decision banner, recipient groups.
    expect(markup).toContain('Quarter-end reset')
    expect(markup).toContain('Approved, coverage arranged.')
    expect(markup).toContain('manager@example.com')
    expect(markup).toContain('CC')
    expect(markup).toContain('hr@example.com')
    // Status pills carry window-scoped counts (3 requests: 1 approved,
    // 1 pending, 1 rejected) — pin the count bubble next to each label.
    expect(markup).toMatch(/All<span[^>]*>3</)
    expect(markup).toMatch(/Pending<span[^>]*>1</)
    expect(markup).toMatch(/Approved<span[^>]*>1</)
    expect(markup).toMatch(/Rejected<span[^>]*>1</)
    expect(markup).toMatch(/Cancelled<span[^>]*>0</)
    // The long approver list folds behind "+2 more" (5 voters, 3 shown)...
    expect(markup).toContain('+2 more')
    expect(markup).not.toContain('lena.qa@example.com')
    // ...while the 4 CC recipients are max+1 and render unfolded (folding one
    // chip would save nothing).
    expect(markup).toContain('assist@example.com')
    expect(markup).not.toContain('+1 more')
    // Rejected card: error-tinted pill + the warning decision banner.
    expect(markup).toContain('Coverage conflict, please resubmit.')
    // Pending card keeps its cancel affordance.
    expect(markup).toContain('cancel-request-req-window-pending')
    // All three requests render under the default All pill, each linking to
    // its detail page.
    expect(markup).toContain('history-request-req-approved')
    expect(markup).toContain('history-request-req-window-pending')
    expect(markup).toContain('history-request-req-window-rejected')
    expect(markup).toContain('href="/employee/history/req-approved"')
    expect(markup).toContain('href="/employee/history/req-window-pending"')
  })

  it('renders the pending request detail page from a seeded request', () => {
    const pendingDetail = historyWindowFixture.requests.find(
      (request) => request.requestId === 'req-window-pending',
    )!
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-window-pending']}>
          <LeaveRequestDetailPageContent
            requestId="req-window-pending"
            initialRequest={pendingDetail}
          />
        </MemoryRouter>,
      ),
    )

    // Hero + metrics: type, status pill, and the all-approvers gate.
    expect(markup).toContain('Vacation')
    expect(markup).toContain('Pending')
    expect(markup).toContain('0/5 approved')
    expect(markup).toContain('every approver must approve')
    expect(markup).toContain('waiting on 5 approvers')
    // Summary: quoted note, pending gate notice, cancel affordance.
    expect(markup).toContain('Conference follow-up trip')
    expect(markup).toContain('detail-pending-gate')
    expect(markup).toContain('cancel-request-req-window-pending')
    // Routing: per-approver rows with awaiting states + CC block (4 = max+1,
    // renders unfolded).
    expect(markup).toContain('routing-manager@example.com')
    expect(markup).toContain('awaiting decision')
    expect(markup).toContain('CC · notified only')
    expect(markup).toContain('assist@example.com')
    // Activity trail.
    expect(markup).toContain('Submitted leave request')
    // Balance impact: the status-derived hold movement plus the note (the DTO
    // timeline is the whole ledger, never rendered as request history).
    expect(markup).toContain('Placed on hold')
    expect(markup).toContain('−4d')
    expect(markup).toContain('released back to available')
    expect(markup).not.toContain('No balance movement')
  })

  // The request detail is reachable by deep link and by hard reload, so the
  // dashboard fetch that used to set the display divisor may never have run.
  describe('rendered straight from the request payload', () => {
    afterEach(() => {
      configureWorkdayHours(8)
    })

    it('reads the org workday off the request rather than the default', () => {
      // A seven-hour org: two and a half days is 17 hours, which reads 2d 3h.
      // Against the eight-hour fallback it read 2d 4h, disagreeing with the
      // server-authored figures printed elsewhere on the same request.
      const request = {
        ...historyFixture.requests[0]!,
        hoursPerDay: 7,
        requestedDays: 2.5,
        paidDays: 2.5,
        unpaidDays: 0,
        heldDays: 2.5,
        dayPortions: { '2026-06-12': 0.5 },
      }
      const markup = normalizeServerMarkup(
        renderToString(
          <MemoryRouter initialEntries={[`/employee/history/${request.requestId}`]}>
            <LeaveRequestDetailPageContent
              requestId={request.requestId}
              initialRequest={request}
            />
          </MemoryRouter>,
        ),
      )

      expect(markup).toContain('2d 3h')
      expect(markup).not.toContain('2d 4h')
    })

    it('names which date is short, and stays silent when none is', () => {
      const base = historyFixture.requests[0]!
      const shortened = normalizeServerMarkup(
        renderToString(
          <MemoryRouter initialEntries={[`/employee/history/${base.requestId}`]}>
            <LeaveRequestDetailPageContent
              requestId={base.requestId}
              initialRequest={{
                ...base,
                requestedDays: 2.5,
                paidDays: 2.5,
                unpaidDays: 0,
                heldDays: 2.5,
                dayPortions: { '2026-06-12': 0.5 },
              }}
            />
          </MemoryRouter>,
        ),
      )
      expect(shortened).toContain('part-day-shape')
      expect(shortened).toContain(formatWeekdayDayMonth('2026-06-12'))
      expect(shortened).toContain('4h')

      // An ordinary whole-day request gets no row at all: no empty label, no
      // "0h".
      const whole = normalizeServerMarkup(
        renderToString(
          <MemoryRouter initialEntries={[`/employee/history/${base.requestId}`]}>
            <LeaveRequestDetailPageContent
              requestId={base.requestId}
              initialRequest={base}
            />
          </MemoryRouter>,
        ),
      )
      expect(whole).not.toContain('part-day-shape')
      expect(whole).not.toContain('Part day')
    })
  })

  it('shows leave that has already been taken as consumed, not still on hold', () => {
    // Every row the data import writes is in the past, and an approved request
    // used to read "placed on hold" forever because the card was derived from
    // the status rather than from what the request still holds.
    const taken = {
      ...historyFixture.requests[0]!,
      heldDays: 0,
    }
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-approved']}>
          <LeaveRequestDetailPageContent
            requestId="req-approved"
            initialRequest={taken}
          />
        </MemoryRouter>,
      ),
    )

    expect(markup).toContain('Placed on hold')
    expect(markup).toContain('Consumed as leave taken')
    // Spent day by day, not in one stroke: the row says over what span.
    expect(markup).toContain('one day at a time')
    // And the running figures are the ones this request left behind, not
    // today's: a page about a past leave should read as history.
    expect(markup).toContain('Vacation balance after this request:')
    expect(markup).toContain('6d spent')
  })

  it('reads the movements off the ledger even without the request figures', () => {
    // A server built before heldDays existed sends nothing, and subtracting
    // undefined printed "-NaNd". The ledger rows the request itself wrote are
    // the truthful source anyway, so the card no longer depends on the field.
    const { heldDays: _dropped, ...withoutField } = historyFixture.requests[0]!
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-approved']}>
          <LeaveRequestDetailPageContent
            requestId="req-approved"
            initialRequest={withoutField as typeof historyFixture.requests[0]}
          />
        </MemoryRouter>,
      ),
    )

    expect(markup).not.toContain('NaN')
    expect(markup).toContain('Placed on hold')
    expect(markup).toContain('Consumed as leave taken')
  })

  it('shows a partly taken request as both consumed and still held', () => {
    // Half the leave has passed: one spend row against a two-day hold.
    const halfTaken = {
      ...historyFixture.requests[0]!,
      heldDays: 1,
      balanceTimeline: [
        historyFixture.requests[0]!.balanceTimeline[0]!,
        {
          ...historyFixture.requests[0]!.balanceTimeline[1]!,
          deltaDays: -1,
        },
      ],
    }
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-approved']}>
          <LeaveRequestDetailPageContent
            requestId="req-approved"
            initialRequest={halfTaken}
          />
        </MemoryRouter>,
      ),
    )

    expect(markup).toContain('Consumed as leave taken')
    expect(markup).toContain('still held for the dates ahead')
  })

  it('renders a decided request with the decision banner and no cancel', () => {
    const approvedDetail = historyFixture.requests[0]!
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-approved']}>
          <LeaveRequestDetailPageContent
            requestId="req-approved"
            initialRequest={approvedDetail}
          />
        </MemoryRouter>,
      ),
    )

    expect(markup).toContain('Approved, coverage arranged.')
    expect(markup).not.toContain('cancel-request-')
    expect(markup).not.toContain('detail-pending-gate')
    // Gate reflects the decided approver, and the routing row shows the
    // decision with its timestamp.
    expect(markup).toContain('1/1 approved')
    expect(markup).toContain('Approved ·')
    // Balance card: the movement rows plus the snapshot THIS REQUEST left
    // behind — its last ledger row, which is the spend (available 15, nothing
    // left on hold), not whatever the account did afterwards.
    expect(markup).toContain('Placed on hold')
    // The fixture's leave has been lived through, so the card reports the
    // consumption rather than a hold that is still pending.
    expect(markup).toContain('Consumed as leave taken')
    expect(markup).toContain('Vacation balance after this request:')
    expect(markup).toContain('15d available')
    expect(markup).toContain('spend from the balance')
  })

  it('renders an automatically approved request without inventing approvers', () => {
    // The shape optional mode produces: approved, no deciding approver, and a
    // CC recipient who was copied rather than asked. Every one of these lines
    // used to read as if a single person had decided it.
    const approvedDetail = historyFixture.requests[0]!
    const autoApproved: LeaveRequestDetailDto = {
      ...approvedDetail,
      requestId: 'req-auto',
      status: LeaveRequestStatus.Approved,
      decisionComment: 'Processed automatically',
      approvers: [
        {
          email: 'hr@example.com',
          kind: ApproverKind.Cc,
          decision: ApproverDecision.Pending,
        },
      ],
      activity: [
        {
          actorDisplayName: 'Maya Chen',
          action: 'submitted',
          occurredAt: '2026-07-21T09:15:00.000Z',
        },
        {
          actorDisplayName: 'System',
          action: 'auto-approved',
          occurredAt: '2026-07-21T09:15:00.000Z',
          comment: 'Processed automatically',
        },
      ],
    }
    const markup = normalizeServerMarkup(
      renderToString(
        <MemoryRouter initialEntries={['/employee/history/req-auto']}>
          <LeaveRequestDetailPageContent
            requestId="req-auto"
            initialRequest={autoApproved}
          />
        </MemoryRouter>,
      ),
    )

    expect(markup).toContain('Processed automatically')
    expect(markup).toContain('approved automatically')
    expect(markup).toContain('No approval was required')
    expect(markup).toContain('No approvers were asked to decide this request.')
    // The copied recipient is still listed, as the one thing that did happen.
    expect(markup).toContain('CC · notified only')
    expect(markup).toContain('hr@example.com')
    // And none of the single-approver wording survives.
    expect(markup).not.toContain('0/0 approved')
    expect(markup).not.toContain('single approver decides')
    expect(markup).not.toContain('A single approver decides.')
  })

  it('words detail errors by HTTP status', async () => {
    const { errorCopy } = await import('./LeaveRequestDetailPage')
    expect(errorCopy({ message: 'x', httpStatus: 404 }).title).toBe('Request not found')
    expect(errorCopy({ message: 'x', httpStatus: 403 }).message).toBe(
      'You can only open your own leave requests.',
    )
    expect(errorCopy({ message: 'server exploded' }).message).toBe('server exploded')
  })

  it('carries the HTTP status on detail fetch failures', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Leave request not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(
      fetchLeaveRequestDetail('missing-id', fetchMock as typeof fetch),
    ).rejects.toMatchObject({
      name: 'RequestDetailApiError',
      status: 404,
      message: 'Leave request not found',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/leave-requests/missing-id'),
    )
    // The class is exported for instanceof checks on the page.
    expect(new RequestDetailApiError('x', 403).status).toBe(403)
  })

  it('distinguishes an empty window from an empty account history', async () => {
    const emptyHistory: LeaveRequestHistoryDto = {
      ...historyFixture,
      requests: [],
    }
    const store = createEmployeeFeatureStore(
      vi.fn(async () => jsonResponse(emptyHistory)) as typeof fetch,
    )

    store.dispatch(employeeFeatureActions.historyRequested({}))
    await flushAsyncWork()
    let markup = normalizeServerMarkup(
      renderWithStore(store, <LeaveHistoryPageContent />, '/employee/history'),
    )
    expect(markup).toContain('No requests yet')

    store.dispatch(
      employeeFeatureActions.historyRequested({ from: '2026-01-01', to: '2026-01-31' }),
    )
    await flushAsyncWork()
    markup = normalizeServerMarkup(
      renderWithStore(store, <LeaveHistoryPageContent />, '/employee/history'),
    )
    expect(markup).toContain('No requests in this period')
  })

  it('page wrappers render under a router without additional props', () => {
    const dashboardMarkup = renderToString(
      <MemoryRouter initialEntries={['/employee/dashboard']}>
        <EmployeeDashboardPage />
      </MemoryRouter>,
    )
    const requestMarkup = renderToString(
      <MemoryRouter initialEntries={['/employee/request']}>
        <LeaveRequestPage />
      </MemoryRouter>,
    )
    const historyMarkup = renderToString(
      <MemoryRouter initialEntries={['/employee/history']}>
        <LeaveHistoryPage />
      </MemoryRouter>,
    )

    expect(dashboardMarkup).toContain('Leave dashboard')
    // One name everywhere: the h1 matches the crumb and the sidebar item.
    expect(requestMarkup).toContain('New request')
    expect(historyMarkup).toContain('Request history')
  })
})

// The composer's part-day state, which is what turns a picked range into the
// map the submission freezes. Every transition is a reducer action, so the
// whole flow is covered here rather than through a DOM these specs have no
// access to (node environment, no jsdom).
describe('the request composer booking part of a day', () => {
  const WEEK = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
  const reduce = (
    state: PartialDaysState,
    ...actions: Parameters<typeof partialDaysReducer>[1][]
  ): PartialDaysState => actions.reduce(partialDaysReducer, state)

  it('carries only the shortened dates into the payload', () => {
    const state = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
      { kind: 'hours-set', date: '2026-08-06', hours: 2, hoursPerDay: 8 },
    )

    expect(hoursPayloadFor(WEEK, state.hoursByDate, 8)).toEqual({
      '2026-08-05': 4,
      '2026-08-06': 2,
    })
    // An untouched selection sends no map at all, so an ordinary request goes
    // over the wire exactly as it always did.
    expect(hoursPayloadFor(WEEK, {}, 8)).toBeUndefined()
  })

  it('drops a date back out of the payload once it is a whole day again', () => {
    const state = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
      // Stepped back up to a full day: the map only ever names shortened ones.
      { kind: 'hours-set', date: '2026-08-05', hours: 8, hoursPerDay: 8 },
    )

    expect(state.hoursByDate).toEqual({})
    expect(hoursPayloadFor(WEEK, state.hoursByDate, 8)).toBeUndefined()
  })

  it('clamps a stepper to the hours a day can hold', () => {
    const state = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'hours-set', date: '2026-08-05', hours: 0, hoursPerDay: 8 },
    )
    // Nothing under an hour: a date booked for none of itself is a date left
    // out of the range, and the server refuses zero outright.
    expect(state.hoursByDate).toEqual({ '2026-08-05': 1 })
    expect(
      partialDaysReducer(state, {
        kind: 'hours-set',
        date: '2026-08-05',
        hours: 99,
        hoursPerDay: 8,
      }).hoursByDate,
    ).toEqual({})
  })

  it('resets every date to a full day when the switch goes off', () => {
    const shortened = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
    )
    const off = partialDaysReducer(shortened, { kind: 'toggled', open: false })

    expect(off).toEqual(INITIAL_PARTIAL_DAYS)
    expect(hoursPayloadFor(WEEK, off.hoursByDate, 8)).toBeUndefined()
    // ...and the cost goes back to the whole week it was before.
    expect(costOfDates(WEEK, off.hoursByDate, 8)).toBe(5)
  })

  it('reprices the selection as the steppers move', () => {
    let state = INITIAL_PARTIAL_DAYS
    expect(costOfDates(WEEK, state.hoursByDate, 8)).toBe(5)

    state = partialDaysReducer(state, {
      kind: 'hours-set',
      date: '2026-08-05',
      hours: 4,
      hoursPerDay: 8,
    })
    expect(costOfDates(WEEK, state.hoursByDate, 8)).toBe(4.5)

    state = partialDaysReducer(state, {
      kind: 'hours-set',
      date: '2026-08-06',
      hours: 2,
      hoursPerDay: 8,
    })
    // Three whole days, plus half of one and a quarter of another.
    expect(costOfDates(WEEK, state.hoursByDate, 8)).toBe(3.75)
  })

  it('forgets hours booked for dates a moved range no longer charges', () => {
    const state = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
      { kind: 'hours-set', date: '2026-08-07', hours: 2, hoursPerDay: 8 },
      // The range was shortened to Mon-Wed. The server refuses hours booked
      // against a date the request does not cover rather than dropping them.
      { kind: 'pruned', dates: WEEK.slice(0, 3), hoursPerDay: 8 },
    )

    expect(state.hoursByDate).toEqual({ '2026-08-05': 4 })
    // The switch stays where the employee left it: the dates it is about are
    // still in the range.
    expect(state.open).toBe(true)
  })

  it('leaves the state untouched when a prune changes nothing', () => {
    // Identity, not equality: the pruning effect runs after every range edit,
    // and a new object each time would re-render (and re-preview) forever.
    const state = reduce(INITIAL_PARTIAL_DAYS, {
      kind: 'hours-set',
      date: '2026-08-05',
      hours: 4,
      hoursPerDay: 8,
    })
    expect(
      partialDaysReducer(state, { kind: 'pruned', dates: WEEK, hoursPerDay: 8 }),
    ).toBe(state)
    expect(pruneHoursByDate(state.hoursByDate, WEEK, 8)).toBe(state.hoursByDate)
  })

  it('clamps the hours into a workday an administrator has shortened', () => {
    // Six hours booked, then the org moves to a five-hour day: the entry has
    // to land on something the server will still accept.
    expect(pruneHoursByDate({ '2026-08-05': 6 }, WEEK, 5)).toEqual({})
    expect(pruneHoursByDate({ '2026-08-05': 6 }, WEEK, 7)).toEqual({
      '2026-08-05': 6,
    })
  })

  it('clears the editor once the draft has been submitted', () => {
    const state = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
      { kind: 'cleared' },
    )

    expect(state).toEqual(INITIAL_PARTIAL_DAYS)
  })

  it('closes the editor when the range no longer charges anything', () => {
    // Clear. The calendar disables the switch with no working day in the
    // range, so an editor left open hangs there with no rows above a control
    // that cannot put it away - a panel the employee can neither use nor
    // close. It closes and forgets its hours instead.
    const cleared = reduce(
      INITIAL_PARTIAL_DAYS,
      { kind: 'toggled', open: true },
      { kind: 'hours-set', date: '2026-08-05', hours: 4, hoursPerDay: 8 },
      { kind: 'pruned', dates: [], hoursPerDay: 8 },
    )
    expect(cleared).toEqual(INITIAL_PARTIAL_DAYS)

    // Same for a range of weekends only, which charges nothing either.
    expect(
      reduce(
        INITIAL_PARTIAL_DAYS,
        { kind: 'toggled', open: true },
        { kind: 'pruned', dates: [], hoursPerDay: 8 },
      ).open,
    ).toBe(false)

    // ...and identity is still preserved when there was nothing to close, so
    // the prune that follows every range edit cannot loop.
    expect(
      partialDaysReducer(INITIAL_PARTIAL_DAYS, {
        kind: 'pruned',
        dates: [],
        hoursPerDay: 8,
      }),
    ).toBe(INITIAL_PARTIAL_DAYS)
  })

  describe('prefilling a change to an approved leave', () => {
    it('converts the frozen portions through the CURRENT workday', () => {
      // Half a day and a quarter, booked when a day was eight hours.
      const state = partialDaysReducer(INITIAL_PARTIAL_DAYS, {
        kind: 'prefilled',
        dayPortions: { '2026-08-05': 0.5, '2026-08-06': 0.25 },
        hoursPerDay: 8,
      })

      expect(state).toEqual({
        open: true,
        hoursByDate: { '2026-08-05': 4, '2026-08-06': 2 },
      })
    })

    it('lands an off-grid portion on an hour that can be submitted', () => {
      // The org moved to a seven-hour day after the leave was frozen, so half
      // of one is three and a half hours - which nothing can book. Rounded to
      // the nearest whole hour, the server's own inverse, so the editor shows
      // the same figure the request's detail page does.
      expect(
        buildModifyHoursPrefill({ '2026-08-05': 0.5 }, 7),
      ).toEqual({ '2026-08-05': 4 })
      // A portion too small to reach an hour still has to be bookable.
      expect(
        buildModifyHoursPrefill({ '2026-08-05': 0.02 }, 8),
      ).toEqual({ '2026-08-05': 1 })
      // ...and one that rounds up to a whole day is simply not a part day.
      expect(buildModifyHoursPrefill({ '2026-08-05': 0.99 }, 8)).toEqual({})
    })

    it('opens closed for an ordinary whole-day leave', () => {
      // An absent portions map is what every whole-day request carries.
      expect(
        partialDaysReducer(INITIAL_PARTIAL_DAYS, {
          kind: 'prefilled',
          hoursPerDay: 8,
        }),
      ).toEqual(INITIAL_PARTIAL_DAYS)
    })
  })

  it('tells a shortened day apart from the leave it is changing', () => {
    // The no-op gate: same dates and same comment is no longer the same
    // request once a day of it has been shortened, and a gate that ignored
    // the hours would leave the button dead with nothing to explain it.
    const original = { '2026-08-05': 0.5 }
    expect(
      sameHoursByDate(
        buildModifyHoursPrefill(original, 8),
        buildModifyHoursPrefill(original, 8),
      ),
    ).toBe(true)
    expect(
      sameHoursByDate({ '2026-08-05': 4 }, { '2026-08-05': 2 }),
    ).toBe(false)
    expect(sameHoursByDate(undefined, {})).toBe(true)
    expect(sameHoursByDate(undefined, { '2026-08-05': 4 })).toBe(false)
  })

  it('prices the impact against what the balance can actually fund', () => {
    // Half a day left, half a day booked: fully paid. The whole-day floor this
    // used to apply told the same employee the whole request was unpaid.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-05',
        endDate: '2026-08-05',
        costDays: 0.5,
        balances: [
          { ...dashboardFixture.balances[0]!, projectedRemainingDays: 0.5 },
        ],
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 0, fromServer: false })
    // Two hours short of what a day and a half costs.
    expect(
      requestImpactFor({
        hoursPerDay: 8,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-05',
        endDate: '2026-08-06',
        costDays: 1.5,
        balances: [
          { ...dashboardFixture.balances[0]!, projectedRemainingDays: 1.25 },
        ],
      }),
    ).toEqual({ kind: 'costed', unpaidDays: 0.25, fromServer: false })
  })

  it('summarizes the cost of a mixed selection for the calendar footer', () => {
    // The prototype's shapes: one repeated part-day length is named, several
    // different ones are only counted.
    expect(partialDaysSummary([8, 8, 4, 4, 8], 8)).toBe('4d (3 full + 2 × 4h)')
    expect(partialDaysSummary([4, 4], 8)).toBe('1d (2 × 4h)')
    expect(partialDaysSummary([4, 2, 8], 8)).toBe('1d 6h (mixed hours)')
    // Nothing to add when every date is whole: the day count already IS the
    // cost, and a second figure saying so is noise.
    expect(partialDaysSummary([8, 8], 8)).toBeNull()
    expect(partialDaysSummary([], 8)).toBeNull()
  })

  it('appends the cost to a settled selection only', () => {
    const jul24 = formatDayMonth('2026-07-24')
    const jul27 = formatDayMonth('2026-07-27')
    expect(
      selectionSummary(
        { startDate: '2026-07-24', endDate: '2026-07-27' },
        null,
        2,
        '1d 4h (1 full + 1 × 4h)',
      ),
    ).toEqual({
      text: `${jul24} → ${jul27} · 2 working days · 1d 4h (1 full + 1 × 4h)`,
      warn: false,
    })
    // While the range is still being drawn the count is explicitly "so far",
    // and a cost beside it would read as final.
    expect(
      selectionSummary(
        { startDate: '2026-07-24', endDate: '2026-07-24' },
        '2026-07-24',
        1,
        '4h',
      ).text,
    ).toBe(`${jul24} · 1 working day so far. Pick the end date or submit a single day.`)
  })
})
