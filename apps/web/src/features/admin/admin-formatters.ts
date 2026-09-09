/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  AdminActivityFeedDto,
  AdminActivityFeedItemDto,
  AdminAuditLogItemDto,
  AdminAuditLogPageDto,
  AdminEmployeeListDto,
  AppRoleName,
  CountryDto,
  HolidayCalendarDto,
  LeaveBalanceDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import {
  AuditCategory,
  AuditEventType,
  CarryoverCapMode,
  CarryoverPolicy,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import {
  describeApproverStanding,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDaySplit,
  formatDays,
  formatLeaveType,
  formatStatus,
  getStatusColor,
  summarizeApproverGate,
} from '../../lib/leave-format'
import type { ApproverGateSummary } from '../../lib/leave-format'

// Shared, UTC-consistent formatters (single implementation) plus admin-only
// role formatting. This is an explicit allowlist, not `export *`: a new
// leave-format export is invisible here until it is added below.
export {
  describeApproverStanding,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDaySplit,
  formatDays,
  formatLeaveType,
  formatStatus,
  getStatusColor,
  summarizeApproverGate,
}
export type { ApproverGateSummary }

export function formatRoleName(roleName: AppRoleName): string {
  return roleName.charAt(0).toUpperCase() + roleName.slice(1)
}

// Human-readable label for a stored country code. Returns '' when no code is
// set, otherwise the matched country name, falling back to the raw code so an
// unknown (or not-yet-loaded) code shows the code itself rather than a blank.
export function countryLabel(
  code: string | undefined,
  countries: readonly CountryDto[],
): string {
  if (!code) {
    return ''
  }
  return countries.find((country) => country.code === code)?.name ?? code
}

// A COUNT of things (requests, employees), grouped for the viewer's locale.
// NOT a day amount: one decimal would render four hours of an eight-hour day as
// 0.5 and one hour as 0.1. Every day figure goes through formatDays.
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value)
}

// The carryover rule as one sentence, for the settings card's footer note. Takes
// the draft's raw strings (the steppers hold text) and clamps them the way the
// payload builder does, so the note states the rule that would actually be
// saved rather than the half-typed one. Lives here, not in the page, because
// the web tests run without a DOM: a pure function is the only assertable form.
export function describeCarryoverRule(
  policy: CarryoverPolicy,
  capMode: CarryoverCapMode,
  capDays: string,
  capPercent: string,
): string {
  if (policy === CarryoverPolicy.None) {
    return 'Unused days are forfeited at year end.'
  }
  if (policy === CarryoverPolicy.Full) {
    return 'All unused days carry over.'
  }
  const percent = Math.min(100, Math.max(0, Math.trunc(Number(capPercent) || 0)))
  switch (capMode) {
    case CarryoverCapMode.Percent:
      return `Capped at ${percent}% of unused days per employee, rounded down to whole days.`
    // Spelled out as a ceiling ("no more than"), because this is the mode an
    // admin can misread as a grant: 50% of a 25-day allowance caps a full-year
    // employee at 12 days, it does not hand 12 days to someone who has 3 left.
    // "Prorated by hire date" because a mid-year joiner's ceiling is a share
    // of what their shortened year could actually earn, not of the full norm.
    case CarryoverCapMode.PercentOfTotal:
      return `Capped at ${percent}% of each employee's annual allowance, prorated by hire date in their first year and rounded down to whole days: nobody carries more than that, however much they left unused.`
    default:
      return `Capped at ${Math.max(0, Math.trunc(Number(capDays) || 0))} days per employee.`
  }
}

// Counts by live status for the filtered population (from feed.totals, not the
// visible page). Totals arrive with the first page only; cursor pages omit them.
export function summarizeActivity(feed: AdminActivityFeedDto): Array<{
  label: string
  value: string
}> {
  const totals = feed.totals ?? {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
  }
  return [
    { label: 'Total requests', value: formatNumber(totals.total) },
    { label: 'Pending', value: formatNumber(totals.pending) },
    { label: 'Approved', value: formatNumber(totals.approved) },
    { label: 'Rejected', value: formatNumber(totals.rejected) },
    { label: 'Cancelled', value: formatNumber(totals.cancelled) },
    // Bookings replaced by an approved change. Shown only where they exist, so
    // an installation that never uses modifications keeps its four cards.
    ...(totals.superseded
      ? [{ label: 'Superseded', value: formatNumber(totals.superseded) }]
      : []),
  ]
}

// Fold a decided request back into the loaded feed, in place. Deliberately NOT
// a refetch: reloading the feed drops every page "Load more" appended, so a
// request decided on page 3 would vanish from under the admin.
export function applyDecisionToFeed(
  feed: AdminActivityFeedDto,
  detail: LeaveRequestDetailDto,
): AdminActivityFeedDto {
  const existing = feed.items.find(
    (item) => item.requestId === detail.requestId,
  )
  // Unknown row, or a no-op re-report: returning the feed untouched keeps the
  // totals arithmetic below idempotent.
  if (!existing || existing.status === detail.status) {
    return feed
  }

  // buildRequestDetail returns activity oldest-first, so the newest entry is
  // last. If that ordering ever flips, the row would show a stale action.
  const latest = detail.activity[detail.activity.length - 1]
  const patched: AdminActivityFeedItemDto = {
    ...existing,
    status: detail.status,
    lastAction: latest?.action ?? existing.lastAction,
    lastActivityAt:
      latest?.occurredAt ?? detail.decidedAt ?? existing.lastActivityAt,
    // Refresh the authority from the decision response, never carry the old
    // one: the request just went terminal, so its stale canOverride would keep
    // offering an override that now 400s (see rowActionFor's status-first gate).
    viewer: detail.viewer,
  }
  const items = feed.items.map((item) =>
    item.requestId === detail.requestId ? patched : item,
  )

  // Load-more pages carry no totals, so only move counters we actually hold.
  const totals = feed.totals
  if (!totals) {
    return { ...feed, items }
  }
  const from = statusBucket(existing.status)
  const to = statusBucket(detail.status)
  return {
    ...feed,
    items,
    totals: {
      ...totals,
      [from]: Math.max(0, totals[from] - 1),
      [to]: totals[to] + 1,
    },
  }
}

// Maps a request status onto its counter in the feed totals.
function statusBucket(
  status: LeaveRequestStatus,
): 'pending' | 'approved' | 'rejected' | 'cancelled' {
  switch (status) {
    case LeaveRequestStatus.Approved:
      return 'approved'
    case LeaveRequestStatus.Rejected:
      return 'rejected'
    case LeaveRequestStatus.Cancelled:
      return 'cancelled'
    case LeaveRequestStatus.Pending:
    default:
      return 'pending'
  }
}

// Full enum lists for the activity feed filter dropdowns.
export const LEAVE_STATUS_OPTIONS: Array<{
  value: LeaveRequestStatus
  label: string
}> = Object.values(LeaveRequestStatus).map((status) => ({
  value: status,
  label: formatStatus(status),
}))

export const LEAVE_TYPE_OPTIONS: Array<{ value: LeaveType; label: string }> =
  Object.values(LeaveType).map((leaveType) => ({
    value: leaveType,
    label: formatLeaveType(leaveType),
  }))

export function summarizeEmployees(list: AdminEmployeeListDto): Array<{
  label: string
  value: string
}> {
  // The server's directory-wide totals are the only correct source: the
  // loaded items are a filtered, paginated window, and re-deriving counts
  // from them would also re-encode a different pendingReview metric. Zeros
  // (matching summarizeActivity) cover the pre-load empty state.
  const totals = list.totals ?? {
    employees: 0,
    administrators: 0,
    accounts: 0,
    pendingReview: 0,
  }

  return [
    { label: 'Employees', value: formatNumber(totals.employees) },
    { label: 'Administrators', value: formatNumber(totals.administrators) },
    { label: 'Awaiting review', value: formatNumber(totals.pendingReview) },
  ]
}

export function summarizeBalances(balances: LeaveBalanceDto[]): Array<{
  label: string
  value: string
  detail: string
}> {
  return balances.map((balance) => ({
    label: formatLeaveType(balance.leaveType),
    value: formatDays(balance.availableDays),
    detail: `${formatDays(balance.spentDays)} spent • ${formatDays(balance.onHoldDays)} on hold`,
  }))
}

export function formatRequestDateRange(request: LeaveRequestDetailDto): string {
  return formatDateRange(request.startDate, request.endDate)
}

export function sortCalendars(calendars: HolidayCalendarDto[]): HolidayCalendarDto[] {
  return [...calendars].sort(
    (left, right) =>
      left.country.name.localeCompare(right.country.name) ||
      left.year - right.year,
  )
}

// -------------------------------------------------------------- audit logs ----

const AUDIT_EVENT_LABELS: Record<AuditEventType, string> = {
  [AuditEventType.UserLogin]: 'Signed in',
  [AuditEventType.UserProvisioned]: 'Account provisioned',
  [AuditEventType.UserProfileSynced]: 'Profile synced',
  [AuditEventType.UserRolesAssigned]: 'Roles updated',
  [AuditEventType.UserLoginRefused]: 'Sign-in refused',
  [AuditEventType.UserDeactivated]: 'Account deactivated',
  [AuditEventType.UserReactivated]: 'Account reactivated',
  [AuditEventType.UserSyncConflict]: 'Directory sync conflict',
  [AuditEventType.UserIdentityConflict]: 'Identity conflict',
  [AuditEventType.LdapSyncCompleted]: 'Directory sync completed',
  [AuditEventType.LdapSyncFailed]: 'Directory sync failed',
  [AuditEventType.EmployeeProfileUpdated]: 'Employee profile updated',
  [AuditEventType.EmployeeAllocationUpdated]: 'Allocation updated',
  [AuditEventType.EmployeeBalanceAdjusted]: 'Vacation balance adjusted',
  [AuditEventType.EmployeeLeaveDataReset]: 'Leave data reset',
  [AuditEventType.LeaveRequestSubmitted]: 'Leave requested',
  [AuditEventType.LeaveRequestCancelled]: 'Leave cancelled',
  [AuditEventType.LeaveRequestApproved]: 'Leave approved',
  [AuditEventType.LeaveRequestRejected]: 'Leave rejected',
  [AuditEventType.LeaveRequestForceApproved]: 'Leave force-approved',
  [AuditEventType.LeaveRequestForceRejected]: 'Leave force-rejected',
  [AuditEventType.LeaveRequestAutoApproved]: 'Leave auto-approved',
  [AuditEventType.LeaveRequestApproverRemoved]: 'Approver removed',
  [AuditEventType.LeaveRequestModificationSubmitted]: 'Leave change requested',
  [AuditEventType.LeaveRequestSuperseded]: 'Leave replaced',
  [AuditEventType.PolicyCreated]: 'Policy created',
  [AuditEventType.PolicyUpdated]: 'Policy updated',
  [AuditEventType.PolicySuperseded]: 'Policy superseded',
  [AuditEventType.PolicyDeleted]: 'Policy deleted',
  [AuditEventType.PolicyDefaultChanged]: 'Default policy changed',
  [AuditEventType.PolicyMembershipAssigned]: 'Policy assigned',
  [AuditEventType.PolicyMembershipTransferred]: 'Policy transferred',
  [AuditEventType.PolicyMembershipTransferScheduled]: 'Policy transfer scheduled',
  [AuditEventType.PolicyMembershipTransferScheduleCanceled]: 'Policy transfer cancelled',
  [AuditEventType.PolicyMembershipTransferBlocked]: 'Policy transfer blocked',
  [AuditEventType.PolicyMembershipBackdated]: 'Policy transfer backdated',
  [AuditEventType.PolicyAllocationMaterialized]: 'Allocation materialized',
  [AuditEventType.ImportCompleted]: 'Data import run',
  [AuditEventType.SettingsUpdated]: 'Settings updated',
  [AuditEventType.CountryCreated]: 'Country added',
  [AuditEventType.CountryUpdated]: 'Country renamed',
  [AuditEventType.CountryDeleted]: 'Country removed',
  [AuditEventType.HolidayCalendarReplaced]: 'Holiday calendar saved',
  [AuditEventType.HolidayCalendarCloned]: 'Holiday calendar cloned',
  [AuditEventType.HolidayCalendarDeleted]: 'Holiday calendar deleted',
}

const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  [AuditCategory.Auth]: 'Authentication',
  [AuditCategory.Role]: 'Roles',
  [AuditCategory.Employee]: 'Employee',
  [AuditCategory.LeaveRequest]: 'Leave request',
  [AuditCategory.Approval]: 'Approval',
  [AuditCategory.Settings]: 'Settings',
  [AuditCategory.Country]: 'Country',
  [AuditCategory.Holiday]: 'Holiday',
  [AuditCategory.Policy]: 'Policy',
  // Matches the event labels above; `ldap_sync` is the stored value only. The
  // actor on the same row keeps its own "LDAP sync" label — that one names who
  // wrote the row, not the grouping it falls into.
  [AuditCategory.LdapSync]: 'Directory sync',
  [AuditCategory.Import]: 'Data import',
}

export function formatAuditEventType(eventType: AuditEventType): string {
  return AUDIT_EVENT_LABELS[eventType] ?? eventType
}

export function formatAuditCategory(category: AuditCategory): string {
  return AUDIT_CATEGORY_LABELS[category] ?? category
}

// The full list, for the category filter dropdown.
export const AUDIT_CATEGORY_OPTIONS: Array<{ value: AuditCategory; label: string }> =
  Object.values(AuditCategory).map((category) => ({
    value: category,
    label: formatAuditCategory(category),
  }))

// Render a before/after JSON value as a compact human string.
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '(empty)'
    }
    return value
      .map((entry) =>
        entry !== null && typeof entry === 'object'
          ? JSON.stringify(entry)
          : String(entry),
      )
      .join(', ')
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

// Prettify a snapshot field name (camelCase / snake_case -> Title Case words).
export function formatAuditFieldName(field: string): string {
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function summarizeAuditLogs(page: AdminAuditLogPageDto): Array<{
  label: string
  value: string
}> {
  const actors = new Set(
    page.items.map((item) => item.actorUserId ?? item.actorLabel),
  )
  const affected = new Set(
    page.items
      .map((item) => item.targetUserId)
      .filter((id): id is string => Boolean(id)),
  )
  return [
    { label: 'Visible events', value: formatNumber(page.items.length) },
    { label: 'Distinct actors', value: formatNumber(actors.size) },
    { label: 'Employees affected', value: formatNumber(affected.size) },
  ]
}

// The most descriptive name available for a focused user, derived from the
// entries where they appear as actor or target (the URL only carries an id).
export function focusedUserLabel(
  items: AdminAuditLogItemDto[],
  userId: string,
): string | undefined {
  for (const item of items) {
    if (item.targetUserId === userId && item.targetLabel) {
      return item.targetLabel
    }
    if (item.actorUserId === userId) {
      return item.actorLabel
    }
  }
  return undefined
}
