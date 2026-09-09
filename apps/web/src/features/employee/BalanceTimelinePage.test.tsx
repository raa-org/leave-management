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
  LeaveBalanceChangeReason,
  LeaveType,
  type EmployeeDashboardDto,
  type LeaveRequestHistoryDto,
} from '@workspace/contracts'
import { ledgerMonthLabel } from './balance-ledger'
import { BalanceTimelinePageContent } from './BalanceTimelinePage'
import {
  createEmployeeFeatureStore,
  employeeFeatureActions,
} from './employee-feature.store'

const dashboardFixture: EmployeeDashboardDto = {
  employeeId: 'employee-1',
  displayName: 'Maya Chen',
  roleNames: [AppRoleName.Employee],
  generatedAt: '2026-07-23T09:00:00.000Z',
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
      updatedAt: '2026-07-23T09:00:00.000Z',
    },
    {
      leaveType: LeaveType.Sick,
      totalDays: 10,
      availableDays: 8,
      onHoldDays: 0,
      spentDays: 2,
      accruedDays: 10,
      updatedAt: '2026-07-23T09:00:00.000Z',
    },
  ],
  pendingRequests: [],
  recentActivity: [],
}

// ASCENDING like the server (oldest movement first); the page must reverse it.
// Server invariants hold on every entry: deltaDays is a POSITIVE MAGNITUDE
// for all reasons except Adjustment (signed), and availableDays is always
// accrued minus spent - the vacation chain replays accrued 12->14->15,
// spent 4 throughout; the sick chain converts one held day to spent.
const historyFixture: LeaveRequestHistoryDto = {
  hoursPerDay: 8,
  requests: [],
  balanceTimeline: [
    {
      effectiveDate: '2026-06-01',
      leaveType: LeaveType.Vacation,
      deltaDays: 2,
      availableDays: 10,
      onHoldDays: 0,
      spentDays: 4,
      reason: LeaveBalanceChangeReason.Accrual,
      note: 'Monthly accrual',
    },
    {
      effectiveDate: '2026-06-20',
      leaveType: LeaveType.Vacation,
      deltaDays: 3,
      availableDays: 10,
      onHoldDays: 3,
      spentDays: 4,
      reason: LeaveBalanceChangeReason.Hold,
      note: 'Pending approval hold',
    },
    {
      effectiveDate: '2026-06-25',
      leaveType: LeaveType.Vacation,
      deltaDays: 3,
      availableDays: 10,
      onHoldDays: 0,
      spentDays: 4,
      reason: LeaveBalanceChangeReason.Release,
      note: 'Request rejected',
    },
    {
      effectiveDate: '2026-07-05',
      leaveType: LeaveType.Sick,
      deltaDays: 1,
      availableDays: 8,
      onHoldDays: 0,
      spentDays: 2,
      reason: LeaveBalanceChangeReason.Spent,
      note: 'Approved leave consumed',
    },
    {
      effectiveDate: '2026-07-10',
      leaveType: LeaveType.Vacation,
      deltaDays: 1,
      availableDays: 11,
      onHoldDays: 0,
      spentDays: 4,
      reason: LeaveBalanceChangeReason.Adjustment,
      note: 'Credited back for working the public holiday',
    },
  ],
  generatedAt: '2026-07-23T09:00:00.000Z',
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetchMock(history: LeaveRequestHistoryDto) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/leave-requests/me')) {
      return jsonResponse(history)
    }
    if (url.includes('/api/dashboard/me')) {
      return jsonResponse(dashboardFixture)
    }
    if (url.includes('/api/holiday-calendars')) {
      // The dashboard intent chains the upcoming epic, which fetches these.
      return jsonResponse([])
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

async function renderBalancePage(
  history: LeaveRequestHistoryDto,
  props?: Parameters<typeof BalanceTimelinePageContent>[0],
) {
  const store = createEmployeeFeatureStore(makeFetchMock(history))
  store.dispatch(employeeFeatureActions.historyRequested({}))
  store.dispatch(employeeFeatureActions.dashboardRequested())
  await flushAsyncWork()

  return normalizeServerMarkup(
    renderToString(
      <MemoryRouter initialEntries={['/employee/balance']}>
        <Provider store={store}>
          <BalanceTimelinePageContent {...props} />
        </Provider>
      </MemoryRouter>,
    ),
  )
}

describe('balance timeline page', () => {
  it('renders the ledger newest-first with month groups, deltas, and after-figures', async () => {
    const markup = await renderBalancePage(historyFixture)

    // Newest first: the adjustment (inserted last) renders before the accrual
    // (inserted first).
    expect(markup.indexOf('Credited back for working the public holiday')).toBeLessThan(
      markup.indexOf('Monthly accrual'),
    )

    // Month separators: the server-clock month plus a named June group.
    expect(markup).toContain('This month')
    expect(markup).toContain(ledgerMonthLabel('2026-06-01'))

    // Every movement type is labeled.
    expect(markup).toContain('Manual adjustment')
    expect(markup).toContain('Consumed as leave taken')
    expect(markup).toContain('Released back to available')
    expect(markup).toContain('Placed on hold')
    expect(markup).toContain('Accrual')

    // Deltas: signs derive from the REASON (the server ships magnitudes),
    // plus in success, minus NEUTRAL with a real minus sign. The hold entry's
    // deltaDays is +3 in the fixture yet must render as −3d.
    expect(markup).toContain('+2d')
    expect(markup).toContain('−3d')
    expect(markup).toContain('−1d')

    // Audit triple shown inline (no tooltip): bookable available (net of
    // held) beside the raw hold and spent. Hold entry -> 10-3=7 avail, 3
    // hold, 4 spent; accrual entry -> 10 avail. Each figure carries its own
    // unit now: "5h" has no bare number to drop it from.
    expect(markup).toContain('>7d</b> avail')
    expect(markup).toContain('>3d</b> hold')
    expect(markup).toContain('>4d</b> spent')
    expect(markup).toContain('>10d</b> avail')

    // The adjustment badge renders as its own text node (the title "Manual
    // adjustment" never matches this shape).
    expect(markup).toContain('>Adjustment<')

    // Count note and the reason filter control. The filter has no label, so
    // its own value is the only thing naming it: an unselected filter that
    // renders blank (the select's default for an empty value) leaves a naked
    // box on the page.
    expect(markup).toContain('5 movements')
    expect(markup).toContain('ledger-reason-select')
    expect(markup).toContain('All movements')

    // Balance tiles: the name, the bar, and the legend under it. The head
    // carries no headline figure - the legend already reads "12d available",
    // and the same number twice in one tile reads as two different facts. The
    // negative assertions kill the variant mutation: the DEFAULT meter head
    // would render '18d of 24 accrued' (vacation) and '10 days total' (sick),
    // which the tile head never does.
    expect(markup).toContain('Vacation: 12d available, 3d on hold, 6d spent')
    expect(markup).toContain('Sick leave: 8d available, 0d on hold, 2d spent')
    expect(markup).toContain('>12d</b> available')
    expect(markup).toContain('>8d</b> available')
    expect(markup).not.toContain('d available<')
    expect(markup).not.toContain('d of 24 accrued')
    expect(markup).not.toContain('10 days total')

    // Filter pills: a three-option leave-type group with "All types" active.
    expect(markup).toContain('All types')
    expect(markup.match(/aria-pressed=/g)).toHaveLength(3)
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1)

    // The filtered-empty notice is not shown while movements exist.
    expect(markup).not.toContain('No movements match these filters.')

    // The nav carries the new Balance section.
    expect(markup).toContain('href="/employee/balance"')
  })

  it('shows the empty state when the ledger has no movements', async () => {
    const markup = await renderBalancePage({
      ...historyFixture,
      balanceTimeline: [],
    })

    expect(markup).toContain('No balance movement')
    expect(markup).toContain('0 movements')
    expect(markup).not.toContain('This month')
  })

  it('shows the filtered-empty notice when a filter matches nothing', async () => {
    // The fixture has no Sick Release entry, so this filter pair empties the
    // list without emptying the ledger.
    const markup = await renderBalancePage(historyFixture, {
      initialTypeFilter: LeaveType.Sick,
      initialReasonFilter: LeaveBalanceChangeReason.Release,
    })

    expect(markup).toContain('No movements match these filters.')
    expect(markup).toContain('0 movements')
    // The full-ledger empty state is a different message and must not appear.
    expect(markup).not.toContain('No balance movement')
  })
})
