/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { ThemeProvider } from '@mui/material/styles'
import type {
  AdminActivityFeedDto,
  AdminActivityFeedItemDto,
  AdminAuditLogPageDto,
  AdminEmployeeDetailDto,
  AdminEmployeeListDto,
  HolidayCalendarDto,
  LeavePolicyDto,
  LeaveSettingsDto,
} from '@workspace/contracts'
import {
  AppRoleName,
  ApproverDecision,
  AuditActionKind,
  AuditCategory,
  AuditEventType,
  CarryoverCapMode,
  CarryoverPolicy,
  EmployeeProfileStatus,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
} from '@workspace/contracts'
import theme from '../../theme'
import { countUpFrame, steppedDaysValue } from '../employee/employee-ui'
import AdminActivityPage, {
  activityFiltersFromSearchParams,
  activityFiltersToSearchParams,
  appendActivityPage,
  rowActionFor,
  type ActivityFilters,
  type FeedState,
} from './AdminActivityPage'
import AdminAuditLogsPage from './AdminAuditLogsPage'
import AdminEmployeesPage from './AdminEmployeesPage'
import AdminEmployeeProfilePage, {
  distinguishingRoles,
  vacationCorrectionGrid,
} from './AdminEmployeeProfilePage'
import { isOnHourGrid } from '../../../../api/src/domain/day-math'
import { configureWorkdayHours, workdayHoursOf } from '../../lib/leave-format'
import AdminSettingsPage from './AdminSettingsPage'
import { formatDate } from './admin-formatters'

function renderWithProviders(ui: ReactElement, location = '/admin/activity') {
  return renderToStaticMarkup(
    <StaticRouter location={location}>
      <ThemeProvider theme={theme}>{ui}</ThemeProvider>
    </StaticRouter>,
  )
}

const sampleActivity: AdminActivityFeedDto = {
  hoursPerDay: 8,
  items: [
    {
      requestId: 'request-1',
      employeeId: 'employee-1',
      employeeDisplayName: 'Alex Morgan',
      status: LeaveRequestStatus.Pending,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-10',
      endDate: '2026-07-12',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      submittedAt: '2026-07-01T09:30:00.000Z',
      lastAction: 'submitted',
      lastActivityAt: '2026-07-01T09:30:00.000Z',
      // The reading admin is not on this request, so overriding is theirs to do.
      viewer: {
        standing: LeaveRequestViewerStanding.Administrator,
        canDecide: false,
        canOverride: true,
      },
    },
    // A pending row the reading admin is an approver on, vote unspent. The feed
    // reader is always an admin, so canOverride is true here too — but canDecide
    // wins, and the console routes them to the review page to vote.
    {
      requestId: 'request-3',
      employeeId: 'employee-3',
      employeeDisplayName: 'Jordan Lee',
      status: LeaveRequestStatus.Pending,
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-03',
      endDate: '2026-08-04',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      submittedAt: '2026-07-03T09:30:00.000Z',
      lastAction: 'submitted',
      lastActivityAt: '2026-07-03T09:30:00.000Z',
      viewer: {
        standing: LeaveRequestViewerStanding.Approver,
        canDecide: true,
        canOverride: true,
      },
    },
    // A pending row the admin is an approver on AND has already voted on. The
    // vote is spent (canDecide false), but the admin hat keeps the override
    // (canOverride true) — the deadlock fix — so the row offers Decide.
    {
      requestId: 'request-4',
      employeeId: 'employee-4',
      employeeDisplayName: 'Robin Fox',
      status: LeaveRequestStatus.Pending,
      leaveType: LeaveType.Sick,
      startDate: '2026-08-10',
      endDate: '2026-08-10',
      requestedDays: 1,
      paidDays: 1,
      unpaidDays: 0,
      heldDays: 1,
      submittedAt: '2026-07-04T09:30:00.000Z',
      lastAction: 'approved',
      lastActivityAt: '2026-07-04T10:00:00.000Z',
      viewer: {
        standing: LeaveRequestViewerStanding.Approver,
        canDecide: false,
        canOverride: true,
        ownVote: {
          decision: ApproverDecision.Approved,
          decidedAt: '2026-07-04T10:00:00.000Z',
        },
      },
    },
    // A settled row, so both branches of the row action are covered.
    {
      requestId: 'request-2',
      employeeId: 'employee-2',
      employeeDisplayName: 'Sam Rivera',
      status: LeaveRequestStatus.Approved,
      leaveType: LeaveType.Sick,
      startDate: '2026-07-20',
      endDate: '2026-07-20',
      requestedDays: 1,
      paidDays: 1,
      unpaidDays: 0,
      heldDays: 1,
      submittedAt: '2026-07-02T09:30:00.000Z',
      lastAction: 'force-approved',
      lastActivityAt: '2026-07-02T10:00:00.000Z',
    },
  ],
  // Matches the rows above: three pending, one approved.
  totals: { total: 4, pending: 3, approved: 1, rejected: 0, cancelled: 0 },
  nextCursor: 'request-1',
}

const sampleAuditLogs: AdminAuditLogPageDto = {
  items: [
    {
      auditId: 'audit-1',
      occurredAt: '2026-07-02T10:00:00.000Z',
      eventType: AuditEventType.LeaveRequestApproved,
      category: AuditCategory.Approval,
      action: AuditActionKind.StateChange,
      actorUserId: 'admin-1',
      actorLabel: 'Sam Admin',
      actorEmail: 'sam@example.com',
      actorRoles: [AppRoleName.Employee, AppRoleName.Administrator],
      targetUserId: 'employee-1',
      targetLabel: 'Alex Morgan',
      entityType: 'leave_request',
      entityId: 'request-1',
      summary: "Sam Admin approved Alex Morgan's leave request",
      before: { status: 'pending' },
      after: { status: 'approved' },
      changedFields: [{ field: 'status', before: 'pending', after: 'approved' }],
      requestId: 'request-1',
    },
    {
      auditId: 'audit-2',
      occurredAt: '2026-07-01T09:30:00.000Z',
      eventType: AuditEventType.LeaveRequestSubmitted,
      category: AuditCategory.LeaveRequest,
      action: AuditActionKind.Create,
      actorUserId: 'employee-1',
      actorLabel: 'Alex Morgan',
      actorEmail: 'alex@example.com',
      actorRoles: [AppRoleName.Employee],
      targetUserId: 'employee-1',
      targetLabel: 'Alex Morgan',
      entityType: 'leave_request',
      entityId: 'request-1',
      summary: 'Submitted vacation leave 2026-07-10 to 2026-07-12 (2 day(s))',
      after: { status: 'pending', leaveType: 'vacation' },
      requestId: 'request-1',
    },
  ],
  nextCursor: 'cursor-2',
}

const sampleEmployees: AdminEmployeeListDto = {
  hoursPerDay: 8,
  items: [
    {
      employeeId: 'employee-1',
      displayName: 'Alex Morgan',
      email: 'alex@example.com',
      roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
      active: true,
      // Same account as sampleEmployeeDetail below, so the two must agree:
      // neither country nor start date is set, which is what PendingSetup
      // means. A list row and the card beside it describing one employee
      // differently is the very thing the flags exist to prevent.
      profileStatus: EmployeeProfileStatus.PendingSetup,
      projects: [{ projectId: 'project-1', name: 'Apollo' }],
      policyId: 'policy-1',
      policyName: 'Standard',
      latestRequest: {
        requestId: 'request-1',
        leaveType: LeaveType.Vacation,
        status: LeaveRequestStatus.Pending,
        startDate: '2026-07-10',
        endDate: '2026-07-12',
        requestedDays: 2,
        paidDays: 2,
        unpaidDays: 0,
        heldDays: 2,
        submittedAt: '2026-07-01T09:30:00.000Z',
      },
    },
  ],
  totals: { employees: 1, administrators: 1, accounts: 1, pendingReview: 1 },
}

// The per-request timelines still repeat the WHOLE ledger for their
// user+leave-type (that is their server shape), but the Balance tab no longer
// folds them: the detail payload ships the real ledger separately, because
// year-close rows (carryover, expiry) belong to no request.
const sampleVacationLedger = [
  {
    effectiveDate: '2026-06-30',
    // A 15-day year accrues 1.25 a month: the ledger is an audit surface and
    // must print the figure it stored, not a one-decimal 1.3 that would make
    // eight of these look like 10.4 against a balance of 10.
    leaveType: LeaveType.Vacation,
    deltaDays: 1.25,
    availableDays: 18,
    onHoldDays: 0,
    spentDays: 6,
    reason: LeaveBalanceChangeReason.Accrual,
    note: 'Monthly vacation accrual',
  },
  {
    effectiveDate: '2026-07-01',
    leaveType: LeaveType.Vacation,
    deltaDays: 2,
    availableDays: 18,
    onHoldDays: 2,
    spentDays: 6,
    reason: LeaveBalanceChangeReason.Hold,
    note: 'Pending approval hold',
  },
]

const sampleEmployeeDetail: AdminEmployeeDetailDto = {
  hoursPerDay: 8,
  employeeId: 'employee-1',
  displayName: 'Alex Morgan',
  email: 'alex@example.com',
  roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
  active: true,
  profileStatus: EmployeeProfileStatus.PendingSetup,
  projects: [{ projectId: 'project-1', name: 'Apollo', position: 'Staff Engineer' }],
  balances: [
    {
      leaveType: LeaveType.Vacation,
      totalDays: 24,
      availableDays: 16,
      onHoldDays: 2,
      spentDays: 6,
      accruedDays: 18,
      // 2 of the 18 accrued rolled in from last year; the header chip's
      // denominator must therefore read 26, not 24.
      carriedOverDays: 2,
      // Year pool 26 minus 6 spent minus 2 committed.
      projectedRemainingDays: 18,
      updatedAt: '2026-07-01T09:30:00.000Z',
    },
  ],
  requestHistory: [
    {
      hoursPerDay: 8,
      requestId: 'request-1',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Alex Morgan',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Pending,
      startDate: '2026-07-10',
      endDate: '2026-07-12',
      requestedDays: 2,
      paidDays: 2,
      unpaidDays: 0,
      heldDays: 2,
      unpaidDates: [],
      submittedAt: '2026-07-01T09:30:00.000Z',
      approvers: [],
      activity: [
        {
          actorDisplayName: 'Alex Morgan',
          action: 'submitted',
          occurredAt: '2026-07-01T09:30:00.000Z',
        },
      ],
      balanceTimeline: sampleVacationLedger,
      comment: 'Family travel',
    },
    {
      hoursPerDay: 8,
      requestId: 'request-2',
      requesterUserId: 'employee-1',
      requesterDisplayName: 'Alex Morgan',
      leaveType: LeaveType.Vacation,
      status: LeaveRequestStatus.Approved,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      requestedDays: 1,
      paidDays: 1,
      unpaidDays: 0,
      heldDays: 1,
      unpaidDates: [],
      submittedAt: '2026-05-20T09:30:00.000Z',
      approvers: [],
      activity: [
        {
          actorDisplayName: 'Alex Morgan',
          action: 'submitted',
          occurredAt: '2026-05-20T09:30:00.000Z',
        },
      ],
      // The same ledger again — per-request timelines legitimately repeat.
      balanceTimeline: sampleVacationLedger,
    },
  ],
  // The employee's REAL ledger, shipped whole: the two vacation movements once
  // each, plus a year-close pair no request could ever carry.
  balanceTimeline: [
    {
      effectiveDate: '2025-12-31',
      leaveType: LeaveType.Vacation,
      deltaDays: 3,
      availableDays: 0,
      onHoldDays: 0,
      spentDays: 21,
      reason: LeaveBalanceChangeReason.Expired,
      note: 'Expired at the end of 2025',
    },
    ...sampleVacationLedger,
  ],
  generatedAt: '2026-07-01T09:30:00.000Z',
}

// The markup of one directory row, found by the name it shows. Flag assertions
// have to name the employee they are about: page-wide counts would also pass
// for a build that hangs the right number of flags on the wrong people. Rows
// are the only <button> elements carrying a name (the preview header is a link),
// so splitting on the tag is enough to isolate one.
function employeeRowMarkup(html: string, displayName: string): string {
  for (const chunk of html.split('<button').slice(1)) {
    const end = chunk.indexOf('</button>')
    const row = end === -1 ? chunk : chunk.slice(0, end)
    if (row.includes(displayName)) {
      return row
    }
  }
  return ''
}

// The full <button> element of one profile tab, so count badges and the
// selected state can be asserted on the right tab rather than page-wide.
function profileTabMarkup(html: string, tab: string): string {
  const match = new RegExp(
    `<button[^>]*id="employee-tab-${tab}"[^>]*>[\\s\\S]*?</button>`,
  ).exec(html)
  return match ? match[0] : ''
}

const sampleHolidayCalendars: HolidayCalendarDto[] = [
  {
    calendarId: 'calendar-us-2026',
    country: { code: 'US', name: 'United States' },
    year: 2026,
    name: 'US 2026',
    holidays: [
      {
        holidayId: 'us-1',
        date: '2026-07-04',
        name: 'Independence Day',
      },
    ],
  },
]

const sampleSettings: LeaveSettingsDto = {
  defaultVacationDays: 24,
  defaultSickDays: 12,
  defaultApproverEmails: ['manager@example.com'],
  defaultCcApproverEmails: ['peopleops@example.com'],
  countries: [
    { code: 'US', name: 'United States', timezone: 'America/New_York' },
  ],
  holidayCalendars: sampleHolidayCalendars,
  updatedAt: '2026-07-01T09:30:00.000Z',
}

describe('admin pages', () => {
  it('renders the activity page summary and feed content', () => {
    const html = renderWithProviders(
      <AdminActivityPage
        initialFeed={sampleActivity}
        initialEmployees={sampleEmployees.items}
      />,
    )

    expect(html).toContain('Administrator activity')
    expect(html).toContain('Alex Morgan')
    expect(html).toContain('Total requests')
    expect(html).toContain('Pending')
    expect(html).toContain('Approved')
    expect(html).toContain('Rejected')
    expect(html).toContain('Cancelled')
    expect(html).toContain('Load more requests')
    // Raw identifiers are tucked behind a collapsed "Show details" disclosure
    // (unmountOnExit, closed by default) instead of cluttering the row, so the
    // raw employee UUID is genuinely absent from the default feed markup.
    expect(html).toContain('Show details')
    expect(html).not.toContain('employee-1')
    // Filter controls: employee, approver, status, leave type, date range.
    // (A closed MUI Select renders only its label, not the option list.)
    expect(html).toContain('>Employee<')
    expect(html).toContain('>Approver<')
    expect(html).toContain('>Status<')
    expect(html).toContain('>Leave type<')
    expect(html).toContain('Leave range')
    // Feed row type pill (renders only via the pill; a closed Select emits
    // only its label, so this cannot be satisfied by the Leave type filter).
    expect(html).toContain('Vacation')
  })

  it('restores activity feed filters from the URL query string', () => {
    const html = renderWithProviders(
      <AdminActivityPage initialFeed={sampleActivity} />,
      '/admin/activity?status=pending&approverEmail=lead%40example.com&from=2026-07-01&to=2026-07-31',
    )

    expect(html).toContain('Filters (4)')
    expect(html).toContain('Clear filters')
  })

  it('decides a pending request in the console and only links out for settled ones', () => {
    const html = renderWithProviders(<AdminActivityPage initialFeed={sampleActivity} />)

    // The pending row the admin is NOT on is decided HERE: it must not send
    // them to the approver review surface, which would reject them.
    expect(html).toContain('Decide')
    expect(html).not.toContain('/admin/approval/review/request-1')
    // The pending row the admin IS an approver on goes the other way: they vote
    // on the review page, and must never be offered a dialog that bypasses the
    // gate they are part of.
    expect(html).toContain('/admin/approval/review/request-3')
    expect(html).toContain('Review')
    // The settled row has no decision to make, so opening it is safe.
    expect(html).toContain('Open request')
    expect(html).toContain('/admin/approval/review/request-2')
    // request-4 (a voted admin-approver) now decides HERE too: the deadlock fix
    // keeps the override, so it renders a console Decide button, NOT a review
    // link — same as request-1.
    expect(html).not.toContain('/admin/approval/review/request-4')
    // Two Decide (request-1 uninvolved admin, request-4 voted admin-approver);
    // one Review (request-3 unvoted admin-approver, vote over override); one Open
    // (request-2 settled). Counted because the label is the only distinguisher.
    expect(countOccurrences(html, '>Decide<')).toBe(2)
    expect(countOccurrences(html, '>Review<')).toBe(1)
    expect(countOccurrences(html, 'Open request')).toBe(1)
    // Nothing is asserted about the dialog here: it renders into a portal, which
    // is empty under renderToStaticMarkup whether or not it is open, so any such
    // assertion would pass unconditionally.
  })

  // The row action is a thin mapping of the two server-computed authority flags
  // — the "who may do what" judgement lives in the backend describeViewerContext
  // (unit-tested there), so the client never re-derives it from the role. The
  // role field is deliberately set to values that would MISLEAD a role-based
  // reader, to prove only the flags are consulted.
  it('maps the row action from the server authority flags, not the role', () => {
    const base = sampleActivity.items[0]!
    const pendingWith = (viewer: AdminActivityFeedItemDto['viewer']) => ({
      ...base,
      status: LeaveRequestStatus.Pending,
      viewer,
    })

    // canDecide wins: the reader votes on the review page.
    expect(
      rowActionFor(
        pendingWith({
          standing: LeaveRequestViewerStanding.Approver,
          canDecide: true,
          canOverride: false,
        }),
      ),
    ).toBe('review')
    // canOverride: the console offers the override dialog — even though the role
    // here is Copied, which a role-based check might have blocked.
    expect(
      rowActionFor(
        pendingWith({
          standing: LeaveRequestViewerStanding.Copied,
          canDecide: false,
          canOverride: true,
        }),
      ),
    ).toBe('decide')
    // Neither flag: read-only, even though the role is Administrator — a
    // role-based allowlist would wrongly have offered the override here.
    expect(
      rowActionFor(
        pendingWith({
          standing: LeaveRequestViewerStanding.Administrator,
          canDecide: false,
          canOverride: false,
        }),
      ),
    ).toBe('open')
    // No viewer on a pending row reads as no authority — view only, never a
    // status-derived "reload to decide" guess.
    expect(rowActionFor(pendingWith(undefined))).toBe('open')
    // A settled row is only ever openable; the server would not set either flag.
    expect(
      rowActionFor({
        ...base,
        status: LeaveRequestStatus.Approved,
        viewer: {
          standing: LeaveRequestViewerStanding.Administrator,
          canDecide: false,
          canOverride: false,
        },
      }),
    ).toBe('open')
    // Terminal status wins over a STALE canOverride: after an optimistic
    // override the row flips to Approved but may still carry canOverride: true;
    // the button must not re-offer a spent override (would 400 on submit).
    expect(
      rowActionFor({
        ...base,
        status: LeaveRequestStatus.Approved,
        viewer: {
          standing: LeaveRequestViewerStanding.Administrator,
          canDecide: false,
          canOverride: true,
        },
      }),
    ).toBe('open')
  })

  it('renders the directory with the compact employee preview', () => {
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={sampleEmployeeDetail}
      />,
    )

    expect(html).toContain('Employee directory')
    // Export was removed for now; the two option-backed filters are not offered
    // until their options have loaded. Asserted on the field LABELS, not the
    // menu items: a Select's options live in a portal, which renders nothing
    // under renderToStaticMarkup.
    expect(html).not.toContain('Export CSV')
    expect(html).not.toContain('>Project</label>')
    expect(html).not.toContain('>Country</label>')
    // Account, Profile and the employment range need no loaded options, so all
    // three are offered from the first render — no props required to get them.
    expect(html).toContain('>Account</label>')
    expect(html).toContain('>Profile</label>')
    expect(html).toContain('>Employment start</label>')
    // The directory opens on the active population, so the Account select shows
    // its choice rather than "All accounts". A Select renders the chosen
    // option's text into the trigger even though the menu itself is a portal.
    expect(html).toContain('>Active</div>')
    expect(html).not.toContain('>All accounts</div>')
    // The selects that ARE at "all" say so instead of rendering an empty box:
    // MUI draws a chosen '' as a zero-width space unless displayEmpty is on,
    // which reads as a control that failed rather than one showing everything.
    expect(html).toContain('>All roles</div>')
    expect(html).toContain('>All profiles</div>')
    // ...and with every filter still at its default there is nothing to clear,
    // so the reset offers itself only once something is chosen.
    expect(html).not.toContain('Clear filters')

    // The compact read-only preview: a fact label, and the deep link into the
    // standalone profile page via the clickable header (editing, request
    // history and the audit trail all live there now). The explicit "Open full
    // profile" / "Audit trail" buttons were removed — the header is the entry.
    expect(html).toContain('Employee ID')
    expect(html).toContain('/admin/employees/employee-1')
    // The fixture is active, so the header link names the employee and nothing
    // else — the trailing quote keeps this from matching the inactive variant.
    expect(html).toContain('aria-label="Open the full profile of Alex Morgan"')
    // A project name shows in the directory row subline.
    expect(html).toContain('Apollo')
    // The latest request status pill (Pending).
    expect(html).toContain('Pending')
    // The policy is NOT on the directory row: the name is the policy's only
    // identity, so a row for someone on "Migrated 25+5" spent its width
    // repeating a cutover artifact. The profile page still names it.
    expect(html).not.toContain('Standard')
  })

  it('offers the Policy filter once its options have loaded', () => {
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={sampleEmployeeDetail}
        initialFilterOptions={{
          countries: [],
          projects: [],
          policies: [{ policyId: 'policy-1', name: 'Standard' }],
        }}
      />,
    )

    // The LABEL, not the menu items: a Select's options live in a portal.
    expect(html).toContain('>Policy</label>')
  })

  it('loads older directory pages on scroll instead of a Load more button', () => {
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={{ ...sampleEmployees, nextCursor: 'cursor-next' }}
        initialEmployeeDetail={sampleEmployeeDetail}
      />,
    )
    expect(html).not.toContain('Load more')
    expect(html).toContain(sampleEmployees.items[0]?.displayName as string)
  })

  it('flags inactive and needs-setup accounts in the directory list', () => {
    // The shared fixture is the active + pending case; the other three
    // combinations are derived from it, one field at a time.
    const [pendingEmployee] = sampleEmployees.items
    const completeCard = {
      profileStatus: EmployeeProfileStatus.Ready,
      countryCode: 'US',
      employmentStartDate: '2026-02-09',
    }
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={{
          ...sampleEmployees,
          items: [
            pendingEmployee,
            {
              ...pendingEmployee,
              ...completeCard,
              employeeId: 'employee-2',
              displayName: 'Dana Cole',
              email: 'dana@example.com',
            },
            {
              ...pendingEmployee,
              ...completeCard,
              employeeId: 'employee-3',
              displayName: 'Robin Fox',
              email: 'robin@example.com',
              active: false,
            },
            // The common outcome of a sync: the account was never completed and
            // its owner has since left. Inactive only — the unfinished card of a
            // departed employee is not an admin to-do.
            {
              ...pendingEmployee,
              employeeId: 'employee-4',
              displayName: 'Sam Rivera',
              email: 'sam@example.com',
              active: false,
            },
          ],
        }}
        initialEmployeeDetail={sampleEmployeeDetail}
      />,
    )

    // Asserted per row: which employee wears which flag is the whole claim, and
    // page-wide counts would also hold if the flags landed on the wrong people.
    expect(employeeRowMarkup(html, 'Alex Morgan')).toContain('>Needs setup<')
    expect(employeeRowMarkup(html, 'Alex Morgan')).not.toContain('>Inactive<')
    expect(employeeRowMarkup(html, 'Dana Cole')).not.toContain('>Needs setup<')
    expect(employeeRowMarkup(html, 'Dana Cole')).not.toContain('>Inactive<')
    expect(employeeRowMarkup(html, 'Robin Fox')).toContain('>Inactive<')
    expect(employeeRowMarkup(html, 'Robin Fox')).not.toContain('>Needs setup<')
    expect(employeeRowMarkup(html, 'Sam Rivera')).toContain('>Inactive<')
    expect(employeeRowMarkup(html, 'Sam Rivera')).not.toContain('>Needs setup<')
    // Only Administrator earns a role chip — employee is the norm, and its
    // chip would decorate every row here.
    expect(html).not.toContain('>Employee<')
    expect(html).toContain('>Administrator<')
  })

  it('marks a deactivated employee in the directory preview', () => {
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={{ ...sampleEmployeeDetail, active: false }}
      />,
    )

    // The listed row is active, so an Inactive flag on the page can only come
    // from the preview header — which is what this test is about.
    expect(employeeRowMarkup(html, 'Alex Morgan')).not.toContain('>Inactive<')
    expect(html).toContain('>Inactive<')
    // The header's own label decides what a screen reader announces for the
    // link, so the state has to be in it and not only in the flag beside it.
    expect(html).toContain(
      'aria-label="Open the full profile of Alex Morgan (inactive account)"',
    )
    // The Profile fact names the pending card for what it is instead of
    // claiming employment merely has not started yet.
    expect(html).toContain('Needs setup')
    expect(html).not.toContain('Not started yet')
  })

  it('offers the project and country filters once their options are loaded', () => {
    const html = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={sampleEmployeeDetail}
        initialFilterOptions={{
          countries: [{ code: 'US', name: 'United States' }],
          projects: [{ projectId: 'project-1', name: 'Apollo' }],
          policies: [{ policyId: 'policy-1', name: 'Standard' }],
        }}
      />,
    )

    expect(html).toContain('>Project</label>')
    expect(html).toContain('>Country</label>')
  })

  it('offers the directory sync only where the deployment has one', () => {
    const withSync = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={sampleEmployeeDetail}
        initialDirectorySyncStatus={{ enabled: true }}
      />,
    )

    expect(withSync).toContain('Sync from LDAP')
    // The result alert's live region is mounted from the start and empty at
    // rest: a region inserted together with its first message would be silent
    // to a screen reader.
    expect(withSync).toContain('role="status"')
    expect(withSync).not.toContain('MuiAlert-root')

    const withoutSync = renderWithProviders(
      <AdminEmployeesPage
        initialEmployees={sampleEmployees}
        initialEmployeeDetail={sampleEmployeeDetail}
        initialDirectorySyncStatus={{ enabled: false }}
      />,
    )

    // Nothing about syncing is shown when the feature is off — the button would
    // only lead to a guaranteed 409.
    expect(withoutSync).not.toContain('Sync from LDAP')
  })

  it('renders the employee profile tab bar with counts', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sampleEmployeeDetail} />,
    )

    expect(html).toContain('role="tablist"')
    expect(profileTabMarkup(html, 'profile')).toContain('Profile')
    expect(profileTabMarkup(html, 'balance')).toContain('Balance')
    expect(profileTabMarkup(html, 'requests')).toContain('Requests')
    expect(profileTabMarkup(html, 'audit')).toContain('Audit')
    // The Timeline tab merged into Balance and no longer exists.
    expect(profileTabMarkup(html, 'timeline')).toBe('')

    // Count badge: the fixture has two requests.
    expect(sampleEmployeeDetail.requestHistory).toHaveLength(2)
    expect(profileTabMarkup(html, 'requests')).toContain('>2</span>')
    // Only Requests (and Audit, once its events load) carry a badge.
    expect(profileTabMarkup(html, 'profile')).not.toContain('</span>')
    expect(profileTabMarkup(html, 'balance')).not.toContain('</span>')
    expect(profileTabMarkup(html, 'audit')).not.toContain('</span>')
  })

  it('opens the employee profile on the Profile tab', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sampleEmployeeDetail} />,
    )

    expect(profileTabMarkup(html, 'profile')).toContain('aria-selected="true"')
    expect(profileTabMarkup(html, 'requests')).toContain('aria-selected="false"')
    // The Profile pane is the reworked sectioned panel plus the pending-setup
    // warning...
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('id="employee-tabpanel-profile"')
    // ...with the prototype's sections and the inline Employment Edit toggle.
    expect(html).toContain('Employment')
    expect(html).toContain('Projects and positions')
    // A leave day is spent at midnight in the employee's own timezone, so
    // there is no per-employee working-day window to edit any more.
    expect(html).not.toContain('Work schedule')
    // The per-user allocation editor is gone; the policy panel replaced it.
    expect(html).toContain('Leave policy')
    expect(html).toContain('>Edit<')
    // The always-on "Manage employee" editor card is gone.
    expect(html).not.toContain('Manage employee')
    // ...and no other pane is mounted.
    expect(html).not.toContain('id="employee-tabpanel-requests"')
    expect(html).not.toContain('Family travel')
    expect(html).not.toContain('/admin/activity/audit?userId=employee-1')
  })

  it('labels a pending profile "Needs setup" in the profile header', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sampleEmployeeDetail} />,
    )

    // The fixture is PendingSetup: header chip and Profile-status fact must say
    // the card needs finishing, not that employment has not started yet.
    expect(html).toContain('>Needs setup<')
    expect(html).not.toContain('Not started yet')
    expect(html).not.toContain('>Employee<')
    expect(html).toContain('>Administrator<')
  })

  it('labels a profile whose employment has not begun', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={{
          ...sampleEmployeeDetail,
          profileStatus: EmployeeProfileStatus.NotStartedYet,
          employmentStartDate: '2027-02-09',
          countryCode: 'US',
        }}
      />,
    )

    // A complete card with a future start date is its own state: nothing for an
    // admin to finish, so it must not borrow the pending card's wording.
    expect(html).toContain('>Not started yet<')
    expect(html).not.toContain('Needs setup')
  })

  it('chips only the roles that set an account apart', () => {
    // Asserted on the rule itself: every fixture account is an administrator,
    // so a rendering check alone cannot tell "filters by role" apart from
    // "keeps one end of the list".
    expect(distinguishingRoles([AppRoleName.Employee])).toEqual([])
    expect(distinguishingRoles([AppRoleName.Administrator])).toEqual([
      AppRoleName.Administrator,
    ])
    expect(
      distinguishingRoles([AppRoleName.Administrator, AppRoleName.Employee]),
    ).toEqual([AppRoleName.Administrator])
  })

  it('renders the employee ledger on the Balance tab, year-close rows included', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialTab="balance"
      />,
    )

    // The Timeline tab merged into Balance; its movements render there now.
    expect(html).toContain('id="employee-tabpanel-balance"')
    expect(html).toContain('Balance movements')
    // The real ledger, not a fold of the per-request timelines: each movement
    // renders once even though both requests carry the same two rows.
    expect(html.split('Monthly vacation accrual')).toHaveLength(2)
    expect(html.split('Pending approval hold')).toHaveLength(2)
    // The year-close row belongs to NO request — only the shipped ledger can
    // surface it. Grouped under a year-bearing month header, since the row
    // itself prints only day and month.
    expect(html).toContain('Expired at year end')
    expect(html).toContain('Expired at the end of 2025')
    expect(html).toContain('December 2025')
    // Shared LedgerRow markup: the audit triple after the hold (18 - 2 = 16
    // bookable available, 2 on hold, 6 spent).
    expect(html).toContain('>16d</b> avail')
    expect(html).toContain('>2d</b> hold')
    expect(html).toContain('>6d</b> spent')
    // The stored delta, exactly: 1.25 of a day IS ten hours, so it reads as
    // the hours it was rather than as a decimal nobody books in.
    expect(html).toContain('+1d 2h')
  })

  it('shows the empty balance movements notice when no movements exist', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={{
          ...sampleEmployeeDetail,
          balanceTimeline: [],
        }}
        initialTab="balance"
      />,
    )

    expect(html).toContain(
      'No balance movements have been recorded for this employee yet.',
    )
  })

  it('shows the request history on the Requests tab', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialTab="requests"
      />,
    )

    expect(html).toContain('id="employee-tabpanel-requests"')
    // The compact prototype .req-row: leave type + quoted requester comment +
    // the "submitted" subline. There is no "Latest activity" block any more.
    expect(html).toContain('Family travel')
    expect(html).toContain('Submitted')
    expect(html).not.toContain('Latest activity')
  })

  it('deep-links into the employee Audit tab', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialTab="audit"
      />,
    )

    expect(html).toContain('id="employee-tabpanel-audit"')
    // Per-employee audit deep-link on the audit pane.
    expect(html).toContain('/admin/activity/audit?userId=employee-1')
    // The pane leads with the prototype's heading over the inline events list.
    expect(html).toContain('Events affecting this employee')
  })

  it('renders the balance meters and movements on the Balance tab', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialTab="balance"
      />,
    )

    expect(html).toContain('id="employee-tabpanel-balance"')
    // The section heading above the meter grid.
    expect(html).toContain('Balances')
    // A balance meter detail: the leave-type label and the bookable headline
    // (16 available − 2 on hold = 14 bookable), in the days-and-hours notation.
    expect(html).toContain('Vacation')
    expect(html).toContain('14d</b> available')
    // The former Timeline is folded in below the meters: its heading and a
    // folded ledger movement both render on the same pane.
    expect(html).toContain('Balance movements')
    expect(html).toContain('Monthly vacation accrual')
    // The caption pair under each meter: accrued-and-spendable today next to
    // what the whole year still holds (the server's projection).
    expect(html).toContain('14d available now')
    expect(html).toContain('18d left this year')
    // The Adjust block repeats the year figure beside the live one.
    expect(html).toContain('· 18d left this year')
  })

  it('shows the year pool, carryover included, as the header chip denominator', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialTab="balance"
      />,
    )

    // Bookable 14 (16 available − 2 on hold) over 26 (24 annual + 2 carried),
    // NOT over the carry-less 24 the chip used to show. The leftover is named
    // beside that pool so 26 is not a mystery figure.
    expect(html).toContain('14')
    expect(html).toContain('/26d')
    expect(html).not.toContain('/24d')
    expect(html).toContain('2d carried over from last year')
  })

  it('renders the inline audit events and the audit tab badge count', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialAuditEvents={sampleAuditLogs}
        initialTab="audit"
      />,
    )

    expect(html).toContain('id="employee-tabpanel-audit"')
    expect(html).toContain('Events affecting this employee')
    // Inline events rendered via the shared AuditLogEntry: an event-type label
    // and a summary (the apostrophe-free one, since markup escapes ').
    expect(html).toContain('Leave approved')
    expect(html).toContain('Sam Admin')
    expect(html).toContain('Submitted vacation leave 2026-07-10 to 2026-07-12')
    // The Audit tab shows a badge with the fetched event count (two events).
    expect(sampleAuditLogs.items).toHaveLength(2)
    expect(profileTabMarkup(html, 'audit')).toContain('>2</span>')
    // Both foot links survive alongside the inline list.
    expect(html).toContain('/admin/activity/audit?userId=employee-1')
    expect(html).toContain('Open the full audit log')
  })

  it('flags missing employment start date and location as required on the profile', () => {
    // sampleEmployeeDetail has neither employmentStartDate nor countryCode. The
    // editor (and its pending-setup warning) now live on the profile page.
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sampleEmployeeDetail} />,
    )

    expect(html).toContain('Not set')
    expect(html).toContain('Required: employment start date and location not set.')
    expect(html).toContain('cannot submit leave requests')
  })

  it('omits the accrual note when only the location is missing', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={{
          ...sampleEmployeeDetail,
          employmentStartDate: '2026-02-09',
        }}
      />,
    )

    expect(html).toContain('Required: location not set.')
    expect(html).not.toContain('does not accrue')
  })

  it('shows the stored start date and location without the required warning', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={{
          ...sampleEmployeeDetail,
          profileStatus: EmployeeProfileStatus.Ready,
          employmentStartDate: '2026-02-09',
          countryCode: 'US',
        }}
        initialCountries={[{ code: 'US', name: 'United States' }]}
      />,
    )

    // Expected via the same formatter the page uses: formatDate renders in the
    // host locale (pinned to UTC), so an exact literal would be locale-fragile.
    expect(html).toContain(formatDate('2026-02-09'))
    expect(html).toContain('United States')
    expect(html).not.toContain('Not set')
    expect(html).not.toContain('cannot submit leave requests')
  })

  it('renders the audit logs page with events and before/after affordances', () => {
    const html = renderWithProviders(
      <AdminAuditLogsPage initialAuditLogs={sampleAuditLogs} />,
    )

    expect(html).toContain('Audit logs')
    expect(html).toContain('Leave approved')
    expect(html).toContain('Sam Admin')
    // The category pill (renders its label directly in static markup).
    expect(html).toContain('Leave request')
    // State-change event exposes a before/after diff; the create shows only after.
    expect(html).toContain('Show before / after')
    expect(html).toContain('Show created values')
    expect(html).toContain('Load older events')
  })

  it('pills a directory-sync run with its own category', () => {
    const html = renderWithProviders(
      <AdminAuditLogsPage
        initialAuditLogs={{
          items: [
            {
              auditId: 'audit-sync',
              occurredAt: '2026-07-03T02:00:00.000Z',
              eventType: AuditEventType.LdapSyncCompleted,
              category: AuditCategory.LdapSync,
              action: AuditActionKind.Create,
              actorLabel: 'LDAP sync',
              actorRoles: [],
              entityType: 'directory_sync',
              summary: 'Directory sync completed: 1 created, 0 updated',
              after: { created: ['jane@example.com'] },
            },
          ],
        }}
      />,
    )

    // The pill carries the category label on its own, so the assertion cannot
    // be satisfied by the event label ("Directory sync completed") next to it.
    expect(html).toContain('Directory sync</span>')
  })

  it('scopes the audit logs page to a single employee', () => {
    const html = renderWithProviders(
      <AdminAuditLogsPage userId="employee-1" initialAuditLogs={sampleAuditLogs} />,
    )

    expect(html).toContain('Showing the audit trail for')
    expect(html).toContain('Alex Morgan')
    expect(html).toContain('Clear filter')
  })

  it('renders settings and holiday management panels', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
      />,
    )

    // The prototype's hero: "Settings", with a strapline that names what the
    // three tabs decide. It used to read "Leave settings" over a promise about
    // default balances, which no card on any tab sets any more.
    expect(html).toContain('Settings')
    expect(html).toContain('move a whole year of leave in and out of the system')
    // The tabs name what they hold; Policies is the default view.
    expect(html).toContain('Policies')
    expect(html).toContain('Countries and holiday calendars')
    expect(html).toContain('Import and export')
    // The General sub-tab is now split into separate prototype cards, each
    // with its own Save. Assert each card's title renders. ('Default approvers'
    // is both a card title and a field label — either satisfies this.)
    // Leave defaults is gone: allowances belong to leave policies now.
    expect(html).not.toContain('Leave defaults')
    expect(html).toContain('Year-end carryover')
    // Countries and the work schedule moved to the other tab.
    expect(html).not.toContain('Default work schedule')
    expect(html).toContain('Default approvers')
    // Per-card Save buttons (teal) instead of the single combined "Save settings".
    // ('Save defaults' went with the Leave defaults card.)
    expect(html).toContain('Save policy')
    expect(html).toContain('Save approvers')
    // Default approver/CC pickers select from the user directory; the stored
    // emails render as chips inside the fields (here unresolved, so raw
    // addresses show until the directory request settles).
    expect(html).toContain('Default CC recipients')
    expect(html).toContain('manager@example.com')
    expect(html).toContain('peopleops@example.com')
  })

  it('reaches the import wizard through the initialView seam', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="import"
      />,
    )

    // The wizard's rail and first step; the other tabs' cards must not render
    // behind it. The export card IS also in the markup (kept mounted so a run
    // survives a glance at Export), so the active view is pinned by the
    // data-active-view seam, not by content strings.
    expect(html).toContain('data-active-view="import"')
    expect(html).toContain('Source file')
    expect(html).toContain('Choose workbook')
    expect(html).not.toContain('Year-end carryover')
  })

  it('reaches the export view through the initialView seam', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="export"
      />,
    )

    expect(html).toContain('data-active-view="export"')
    expect(html).toContain('What to include')
    expect(html).toContain('Download workbook')
  })

  it('offers the two approval modes and says approval is required by default', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{ ...sampleSettings, approvalRequired: true }}
        initialHolidayCalendars={sampleHolidayCalendars}
      />,
    )

    expect(html).toContain('Approval required')
    expect(html).toContain('Approval optional')
    // The warning belongs to the optional mode only; in required mode the
    // deciding list is applied and nothing is inert.
    expect(html).not.toContain('Approval is optional.')
    expect(html).not.toContain('Default approvers (not applied)')
    expect(html).toContain('Approval required · 1 deciding · 1 copied')
  })

  it('marks the deciding defaults inert while approval is optional, never the CC list', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{ ...sampleSettings, approvalRequired: false }}
        initialHolidayCalendars={sampleHolidayCalendars}
      />,
    )

    // The one way this setting could mislead: a stored deciding list that is
    // no longer routed to anyone has to say so where it is edited.
    expect(html).toContain('Approval is optional.')
    expect(html).toContain('Default approvers (not applied)')
    expect(html).toContain(
      'Kept, but not applied while approval is optional.',
    )
    // CC is applied under either mode, so it is never marked inert.
    expect(html).toContain('Copied on every new leave request under either approval mode')
    expect(html).toContain(
      'Approval optional · deciding defaults kept, not applied · 1 copied on every request',
    )
    // Both lists keep their stored values: switching modes is reversible.
    expect(html).toContain('manager@example.com')
    expect(html).toContain('peopleops@example.com')
  })

  it('renders the capped carryover panel with the percent controls', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{
          ...sampleSettings,
          carryoverPolicy: CarryoverPolicy.Capped,
          carryoverCapMode: CarryoverCapMode.Percent,
          carryoverCapPercent: 50,
        }}
        initialHolidayCalendars={sampleHolidayCalendars}
      />,
    )

    // Capped reveals the cap row as one sentence, "Carry over at most N Unit",
    // where the segmented control IS the unit. The footer states the rule in
    // words, rounding included.
    expect(html).toContain('Carry over at most')
    expect(html).toContain('aria-label="Carryover cap unit"')
    expect(html).toContain('aria-label="Percent carried over"')
    expect(html).toContain(
      'Capped at 50% of unused days per employee, rounded down to whole days.',
    )
    // The days-mode control is not rendered at all while percent is selected.
    expect(html).not.toContain('Days carried over')
    // Both percent bases are offered, and their labels carry the base — it is
    // the only thing that tells them apart.
    expect(html).toContain('% of unused')
    expect(html).toContain('% of allowance')
  })

  it('states the allowance-percent cap as a ceiling, not a grant', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{
          ...sampleSettings,
          carryoverPolicy: CarryoverPolicy.Capped,
          carryoverCapMode: CarryoverCapMode.PercentOfTotal,
          carryoverCapPercent: 50,
        }}
        initialHolidayCalendars={sampleHolidayCalendars}
      />,
    )

    // Same shared stepper as the other percent mode; only the note changes, and
    // it has to say the cap is an upper bound so nobody reads it as "everyone
    // carries half their allowance" - and that a mid-year joiner's first-year
    // ceiling is a share of their prorated entitlement, not of the full norm.
    expect(html).toContain('aria-label="Percent carried over"')
    expect(html).not.toContain('Days carried over')
    expect(html).toContain(
      "Capped at 50% of each employee&#x27;s annual allowance, prorated by hire date in their first year and rounded down to whole days: nobody carries more than that, however much they left unused.",
    )
  })

  it('lists countries with their zone and calendar standing', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    // The roster is the landing view: who we employ people in, the zone their
    // day ends in, and whether their calendars exist.
    expect(html).toContain('Countries you employ people in')
    expect(html).toContain('United States')
    expect(html).toContain('America/New_York')
    expect(html).toContain('1 calendar')
    expect(html).toContain('2026')
    expect(html).toContain('Add country')
    expect(html).toContain('Manage calendar')
    // The editor lives one drill-in away, and the aside that used to duplicate
    // this list is gone.
    expect(html).not.toContain('All calendars')
    expect(html).not.toContain('Calendar name (optional)')
    expect(html).not.toContain('Add holiday')
    expect(html).not.toContain('Save calendar')
    // The policies panel is not mounted on this sub-tab...
    expect(html).not.toContain('Year-end carryover')
    // ...but the parked work schedule lives here, in both modes.
    expect(html).not.toContain('Default work schedule')
  })

  it('offers a calendar-less country an Add calendar drill-in', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{
          ...sampleSettings,
          countries: [
            ...sampleSettings.countries,
            { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
          ],
        }}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    expect(html).toContain('Poland')
    expect(html).toContain('Europe/Warsaw')
    expect(html).toContain('No calendar yet')
    // "Manage" would over-promise for a country with nothing to manage.
    expect(html).toContain('Add calendar')
  })

  it('refuses to remove a country that still owns calendars', () => {
    // The server declines the delete and the row used to reappear with no
    // explanation, so the refusal is stated before the click instead. The
    // reason rides on the label rather than a title: MUI sets pointer-events:
    // none on a disabled button, so a tooltip there is never reachable.
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{
          ...sampleSettings,
          countries: [
            ...sampleSettings.countries,
            { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
          ],
        }}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    const removeUs = /<button[^>]*aria-label="Remove United States[^"]*"[^>]*>/.exec(html)
    const removePl = /<button[^>]*aria-label="Remove Poland[^"]*"[^>]*>/.exec(html)
    expect(removeUs?.[0]).toContain('disabled')
    expect(removeUs?.[0]).toContain('holiday calendar')
    expect(removePl?.[0]).not.toContain('disabled')
  })

  it('refuses to remove a country its employees are still assigned to', () => {
    // The blocker nothing else would show: users.countryCode is ON DELETE SET
    // NULL, so this removal does not fail loudly, it strips the country from
    // those people and leaves them unable to submit leave at all.
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={{
          ...sampleSettings,
          countries: [
            ...sampleSettings.countries,
            {
              code: 'PL',
              name: 'Poland',
              timezone: 'Europe/Warsaw',
              assignedUsers: 3,
            },
          ],
        }}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    // Poland owns no calendars, so employees are the only thing in the way.
    const removePl = /<button[^>]*aria-label="Remove Poland[^"]*"[^>]*>/.exec(html)
    expect(removePl?.[0]).toContain('disabled')
    expect(removePl?.[0]).toContain('3 employees are still assigned to it')
    // The way out is part of it: a reason with no remedy is half an answer.
    expect(removePl?.[0]).toContain('move them to other countries')
    // The count is NOT a column of its own: the row stayed as it was, and the
    // reason lives on the control that is greyed out.
    expect(html).not.toContain('No employees')
  })

  it('replaces the roster with one country calendar editor when drilled in', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
        initialCalendarCountry="US"
      />,
    )

    expect(html).toContain('United States holiday calendars')
    expect(html).toContain('All countries')
    // Year selection is teal chips + an "Add year" affordance; the selected
    // year (2026) renders as a chip and the "Holidays" rows-head carries the
    // summary.
    expect(html).toContain('Leave year')
    expect(html).toContain('Add year')
    expect(html).toContain('2026')
    expect(html).toContain('Holidays')
    expect(html).toContain('Calendar name (optional)')
    expect(html).toContain('Add holiday')
    expect(html).toContain('Save calendar')
    // The info note explains the thing being edited, so it lives here.
    expect(html).toContain('automatically skips those days')
    // Replaced, not stacked: the roster is not underneath.
    expect(html).not.toContain('Countries you employ people in')
    expect(html).not.toContain('Manage calendar')
    // Clone-to-year was removed from this UI entirely.
    expect(html).not.toContain('Clone to year')
    // NOTE: holiday rows are populated by an effect, which does not run under
    // renderToStaticMarkup, so the per-row weekday badge and the weekend tally
    // are not asserted here (the list renders empty in SSR).
  })

  it('does not leak source comments into the calendars tab', () => {
    // A "//" comment written in JSX children position is not a comment, it is
    // text. One shipped, and printed a sentence about the prototype's grid
    // between the countries card and the editor.
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    expect(html).not.toContain('// Prototype')
    expect(html).not.toContain('.grid2')
  })

  it('withholds the calendars tab until settings arrive', () => {
    // Without settings the panel is 'idle', and the cards used to render
    // anyway: the countries list claimed there were no countries at all, which
    // reads as a configured empty roster rather than as data still in flight.
    const html = renderWithProviders(
      <AdminSettingsPage
        initialHolidayCalendars={sampleHolidayCalendars}
        initialView="calendars"
      />,
    )

    expect(html).not.toContain('No countries yet')
    // The skeleton card carries the same title and caption as the real one, so
    // the witness has to be a control only the loaded roster renders.
    expect(html).not.toContain('Add country')
    expect(html).toContain('MuiSkeleton')
  })
})

describe('activity filter URL helpers', () => {
  it('round-trips every supported filter through search params', () => {
    const filters: ActivityFilters = {
      employeeId: 'employee-1',
      approverEmail: 'lead@example.com',
      status: LeaveRequestStatus.Pending,
      leaveType: LeaveType.Vacation,
      from: '2026-07-01',
      to: '2026-07-31',
    }

    const serialized = activityFiltersToSearchParams(filters)
    expect(activityFiltersFromSearchParams(serialized)).toEqual(filters)
    expect(serialized.toString()).toBe(
      'employeeId=employee-1&approverEmail=lead%40example.com&status=pending&leaveType=vacation&from=2026-07-01&to=2026-07-31',
    )
  })

  it('drops empty filters and ignores unknown enum values', () => {
    const params = new URLSearchParams('status=not-a-status&leaveType=invalid&employeeId=')
    expect(activityFiltersFromSearchParams(params)).toEqual({
      employeeId: '',
      approverEmail: '',
      status: '',
      leaveType: '',
      from: '',
      to: '',
    })
  })
})

// A load-more page belongs to the listing identified by (appliedFilters,
// cursor); appendActivityPage must drop the page when EITHER moved while the
// request was in flight.
describe('appendActivityPage staleness guard', () => {
  const activityItem = (requestId: string): AdminActivityFeedDto['items'][number] => ({
    requestId,
    employeeId: 'employee-1',
    employeeDisplayName: 'Alex Morgan',
    status: LeaveRequestStatus.Pending,
    leaveType: LeaveType.Vacation,
    startDate: '2026-07-10',
    endDate: '2026-07-12',
    requestedDays: 2,
    paidDays: 2,
    unpaidDays: 0,
    heldDays: 2,
    submittedAt: '2026-07-01T09:30:00.000Z',
    lastAction: 'submitted',
    lastActivityAt: '2026-07-01T09:30:00.000Z',
  })

  const filters: ActivityFilters = {
    employeeId: '',
    approverEmail: '',
    status: '',
    leaveType: '',
    from: '',
    to: '',
  }

  const listing = (appliedFilters: ActivityFilters): FeedState => ({
    status: 'success',
    error: null,
    loadingMore: true,
    data: {
      hoursPerDay: 8,
      items: [activityItem('request-1')],
      totals: { total: 3, pending: 3, approved: 0, rejected: 0, cancelled: 0 },
      nextCursor: 'cursor-x',
    },
    appliedFilters,
  })

  const nextPage: AdminActivityFeedDto = {
    hoursPerDay: 8,
    // request-1 reappears (updated mid-pagination); request-2 is new.
    items: [activityItem('request-1'), activityItem('request-2')],
    nextCursor: 'cursor-y',
  }

  it('appends the page when the listing is unchanged, deduplicating rows', () => {
    const current = listing(filters)
    const result = appendActivityPage(
      current,
      { cursor: 'cursor-x', appliedFilters: filters },
      nextPage,
    )

    expect(result.loadingMore).toBe(false)
    expect(result.data.items.map((item) => item.requestId)).toEqual([
      'request-1',
      'request-2',
    ])
    // Cursor pages omit totals; the first page's totals survive.
    expect(result.data.totals).toEqual(current.data.totals)
    expect(result.data.nextCursor).toBe('cursor-y')
  })

  it('drops the page when a filter change replaced the listing, even if the keyset cursor collided', () => {
    // The filter-change refetch stored a FRESH appliedFilters object and its
    // first page happened to end on the same boundary row (same cursor) —
    // the cursor alone cannot detect this.
    const current = listing({ ...filters, status: LeaveRequestStatus.Pending })
    const result = appendActivityPage(
      current,
      { cursor: 'cursor-x', appliedFilters: filters },
      nextPage,
    )

    expect(result.loadingMore).toBe(false)
    expect(result.data.items.map((item) => item.requestId)).toEqual(['request-1'])
    expect(result.data.nextCursor).toBe('cursor-x')
  })

  it('drops the page when a refresh moved the cursor', () => {
    const current = {
      ...listing(filters),
      data: { ...listing(filters).data, nextCursor: 'cursor-z' },
    }
    const result = appendActivityPage(
      current,
      { cursor: 'cursor-x', appliedFilters: filters },
      nextPage,
    )

    expect(result.loadingMore).toBe(false)
    expect(result.data.items.map((item) => item.requestId)).toEqual(['request-1'])
    expect(result.data.nextCursor).toBe('cursor-z')
  })
})

// Substring counting, because every row in the feed links to the same review
// route: only the action label distinguishes "you may act" from "you may look".
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}


describe('policy catalog inside settings', () => {
  const policy = (
    overrides: Partial<LeavePolicyDto> = {},
  ): LeavePolicyDto => ({
    policyId: 'policy-1',
    name: 'Standard',
    vacationDays: 25,
    sickDays: 5,
    vacationAnnualIncrement: 0,
    vacationIncrementEveryYears: 1,
    probationMonths: 0,
    paidSickDuringProbation: false,
    effectiveFrom: '2026-01-01',
    isDefault: false,
    termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
    memberCount: 0,
    scheduledInCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })

  it('lists the catalog with terms, standing and population', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialPolicies={[
          policy({ isDefault: true, memberCount: 12 }),
          policy({
            policyId: 'policy-2',
            name: 'Senior',
            vacationDays: 30,
            vacationAnnualIncrement: 2,
            vacationIncrementCapDays: 35,
            probationMonths: 3,
            memberCount: 1,
            scheduledInCount: 2,
            effectiveTo: '2026-12-31',
          }),
        ]}
      />,
      '/admin/settings',
    )

    expect(html).toContain('Leave policies')
    expect(html).toContain('Standard')
    expect(html).toContain('Senior')
    // The collapsed row states its terms as the prototype's chips (number +
    // quieter unit), not as a comma-joined sentence.
    expect(html).toContain('25')
    expect(html).toContain('vacation')
    expect(html).toContain('sick')
    expect(html).toContain('+2')
    expect(html).toContain('max 35')
    expect(html).toContain('mo probation')
    expect(html).toContain('12 members')
    expect(html).toContain('1 member, 2 scheduled')
    expect(html).toContain('Default')
    expect(html).toContain(`Retires ${formatDate('2026-12-31')}`)
    // The first policy is expanded, so its terms are spelled out and its
    // members block is mounted.
    expect(html).toContain('Accrues monthly across the leave year')
    expect(html).toContain('Members')
  })

  it('says when a stepped rise lands, since it is not the hire anniversary', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialPolicies={[
          policy({
            name: 'Senior UA',
            vacationDays: 15,
            vacationAnnualIncrement: 5,
            vacationIncrementEveryYears: 3,
            vacationIncrementCapDays: 30,
          }),
        ]}
      />,
      '/admin/settings',
    )

    // The chip carries the cadence, the expanded cell the calendar boundary.
    expect(html).toContain('+5')
    expect(html).toContain('/3yr, max 30')
    expect(html).toContain('Added every 3 years of employment, on 1 January')
  })

  it('explains the empty catalog', () => {
    const html = renderWithProviders(
      <AdminSettingsPage
        initialSettings={sampleSettings}
        initialHolidayCalendars={sampleHolidayCalendars}
        initialPolicies={[]}
      />,
      '/admin/settings',
    )

    expect(html).toContain('No policies yet')
  })
})

describe('AdminEmployeeProfilePage policy panel', () => {
  it('shows the current policy, the probation window and a scheduled transfer', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage
        initialEmployeeDetail={sampleEmployeeDetail}
        initialEmployeePolicy={{
          current: {
            membershipId: 'membership-1',
            policyId: 'policy-1',
            policyName: 'Standard',
            effectiveFrom: '2026-01-01',
            superseded: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          scheduled: {
            membershipId: 'membership-2',
            policyId: 'policy-2',
            policyName: 'Senior',
            effectiveFrom: '2026-09-01',
            superseded: false,
            createdAt: '2026-07-01T00:00:00.000Z',
          },
          probation: { endsOn: '2026-04-01', active: true },
          history: [],
        }}
      />,
      '/admin/employees/employee-1',
    )

    expect(html).toContain('Leave policy')
    expect(html).toContain('Standard')
    expect(html).toContain('On probation until')
    expect(html).toContain('Senior')
    expect(html).toContain('scheduled for')
    // The per-user allocation editor is gone: every exception is a policy now.
    expect(html).not.toContain('Annual allocation')
  })

  it('offers to assign a policy when the employee is not enrolled', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sampleEmployeeDetail} />,
      '/admin/employees/employee-1',
    )

    expect(html).toContain('Not assigned to a policy yet')
  })
})

// The stepper the admin balance correction drives. Whole-day callers (policy
// terms, carryover caps, annual allocations) keep the behaviour they were
// written against; only a caller that opts into a fractional step gets one.
describe('DaysStepper stepping', () => {
  it('still moves and truncates by whole days by default', () => {
    expect(steppedDaysValue('3', 1, { step: 1 })).toBe('4')
    expect(steppedDaysValue('3', -1, { step: 1 })).toBe('2')
    // Half a day of annual entitlement is not a thing, so a typed decimal is
    // truncated before the move, exactly as before.
    expect(steppedDaysValue('3.5', 1, { step: 1 })).toBe('4')
    expect(steppedDaysValue('0', -1, { step: 1 })).toBe('0')
    expect(steppedDaysValue('100', 1, { step: 1, max: 100 })).toBe('100')
  })

  it('moves by one hour when the caller opts into it', () => {
    const hour = { step: 1 / 8 }
    expect(steppedDaysValue('1', 1, hour)).toBe('1.125')
    expect(steppedDaysValue('1.125', -1, hour)).toBe('1')
    expect(steppedDaysValue('0', -1, hour)).toBe('0')
    expect(steppedDaysValue('1', 1, { step: 1 / 8, max: 1 })).toBe('1')
  })

  it('lands on figures the server accepts when an hour does not divide evenly', () => {
    // A seven-hour day stores one hour as 0.143, a shade over a seventh:
    // repeated addition of the STORED figure reaches 1.001 after seven
    // presses and is refused. Snapping to the exact fraction each time is
    // what keeps the value on the grid.
    const hour = { step: 1 / 7 }
    let value = '0'
    for (let press = 0; press < 7; press += 1) {
      value = steppedDaysValue(value, 1, hour)
    }
    expect(value).toBe('1')
    expect(steppedDaysValue('0', 1, hour)).toBe('0.143')
    expect(steppedDaysValue('0.143', 1, hour)).toBe('0.286')
  })
})

// The animated headline on the dashboard KPI tiles.
describe('CountUpNumber frames', () => {
  it('never shows more leave than there is', () => {
    // The rule the whole app renders balances under: rounding 3.6 up would
    // promise a day the balance cannot fund.
    expect(countUpFrame(3.6)).toBe(3)
    expect(countUpFrame(3.4)).toBe(3)
    // Whole figures - which is what splitDayAmount hands the tiles - are
    // unmoved, including the final frame of an animation.
    expect(countUpFrame(3)).toBe(3)
    expect(countUpFrame(0)).toBe(0)
  })
})

// The admin console has no dashboard fetch, and only its Settings tab reads the
// endpoint that owns the org's workday. Every other admin page therefore has to
// take the divisor off its own payload, and the employee profile is the one
// where getting it wrong is more than cosmetic: its balance correction MINTS an
// amount the server checks against that same grid.
describe('the employee profile against a workday other than eight', () => {
  afterEach(() => {
    configureWorkdayHours(8)
  })

  const sevenHourDetail: AdminEmployeeDetailDto = {
    ...sampleEmployeeDetail,
    hoursPerDay: 7,
    balances: [
      {
        ...sampleEmployeeDetail.balances[0]!,
        // Two and a half days: 17 hours at a seven-hour workday (2d 3h) and
        // 20 at an eight-hour one (2d 4h), so the two divisors are told apart
        // by the rendered figure alone.
        availableDays: 2.5,
        onHoldDays: 0,
        accruedDays: 2.5,
        projectedRemainingDays: 2.5,
      },
    ],
  }

  it('renders its day figures against the workday on its own payload', () => {
    const html = renderWithProviders(
      <AdminEmployeeProfilePage initialEmployeeDetail={sevenHourDetail} />,
    )

    expect(html).toContain('2d 3h')
    expect(html).not.toContain('2d 4h')
    // ...and the display fallback the shared formatters read has been pointed
    // at this payload, which is what makes every other figure on the page
    // agree with the server-authored notes printed beside them.
    expect(workdayHoursOf()).toBe(7)
  })

  it('mints a correction on the grid the server will check it against', () => {
    // The defect this replaced: the form read the divisor from module display
    // state, so in a seven-hour org every fractional correction it could
    // produce sat off the server's grid and was refused outright.
    for (const typed of ['0.5', '1.1', '2.37']) {
      const grid = vacationCorrectionGrid(sevenHourDetail, typed, 'add')
      expect(grid.hoursPerDay).toBe(7)
      expect(isOnHourGrid(grid.days, 7)).toBe(true)
      // One press of the stepper is one hour of THIS workday.
      expect(grid.step).toBe(1 / 7)
    }

    // Half a day is four hours snapped, and removal carries the sign.
    expect(vacationCorrectionGrid(sevenHourDetail, '0.5', 'add').days).toBe(0.571)
    expect(
      vacationCorrectionGrid(sevenHourDetail, '0.5', 'remove').signedDelta,
    ).toBe(-0.571)

    // The same typed figure snapped against the eight-hour display fallback is
    // 0.5, which is three and a half hours here: an amount nobody can have
    // taken, and one the server refuses.
    expect(isOnHourGrid(0.5, 7)).toBe(false)
  })
})
