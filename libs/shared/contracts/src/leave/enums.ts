/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

export enum AppRoleName {
  Employee = 'employee',
  Administrator = 'administrator',
}

export enum LeaveType {
  Vacation = 'vacation',
  Sick = 'sick',
}

export enum LeaveRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
  // An approved booking replaced by a fully re-approved modification. Terminal:
  // its hold was released in the same transaction that approved the
  // replacement, so the days now sit on the replacement instead.
  Superseded = 'superseded',
}

export enum LeaveApprovalAction {
  Approve = 'approve',
  Reject = 'reject',
}

// Whether an approver must act on the request (to) or is only copied (cc).
export enum ApproverKind {
  To = 'to',
  Cc = 'cc',
}

// Per-approver progress on a request. Only kind='to' rows advance past Pending;
// cc rows stay Pending forever.
export enum ApproverDecision {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

// The authenticated caller's standing on ONE request, by precedence of
// involvement (requester > approver > copied > administrator > unrelated). A
// standing, not a permission — what the caller may DO comes from the canDecide
// / canOverride flags, which read the admin role directly. Named "standing" and
// not "role" on purpose: the Administrator value here is a per-request standing,
// distinct from the RBAC AppRoleName.Administrator.
export enum LeaveRequestViewerStanding {
  Requester = 'requester',
  Approver = 'approver',
  Copied = 'copied',
  Administrator = 'administrator',
  // No relationship to this request and not an admin — exactly the set the
  // read gate denies (view access requires standing !== Unrelated). An internal
  // sentinel, never serialized to a client (such a caller is refused before any
  // DTO is built): it keeps describeStanding safe to call for ANY caller, so
  // Administrator is claimed from the admin role and never assigned by elimination.
  Unrelated = 'unrelated',
}

// Lifecycle of a single notification delivery attempt.
export enum NotificationDeliveryStatus {
  Pending = 'pending',
  Sent = 'sent',
  Failed = 'failed',
}

export enum LeaveBalanceChangeReason {
  Accrual = 'accrual',
  Hold = 'hold',
  Release = 'release',
  Spent = 'spent',
  Adjustment = 'adjustment',
  // Year close, written as double-entry bookkeeping the first time a new leave
  // year is read: the old year's leftover LEAVES it (carryover_out) and, when
  // the policy keeps any of it, ARRIVES in the new year (carryover_in); the
  // part the policy does not keep is burnt (expired). Three reasons rather
  // than one because the client derives each row's sign from its reason, and
  // a burn is not a transfer.
  CarryoverIn = 'carryover_in',
  CarryoverOut = 'carryover_out',
  Expired = 'expired',
}

// Whether the employee's profile card is complete enough for leave accrual.
// Computed by the backend (single place for the readiness rule) so the UI only
// renders the state and never re-derives the business condition.
export enum EmployeeProfileStatus {
  // Profile is set up and employment has begun; accrual and request
  // submission work normally.
  Ready = 'ready',
  // An admin has not finished the profile card yet (e.g. no employment start
  // date): nothing accrues and submissions are blocked until it is completed.
  PendingSetup = 'pending_setup',
  // The profile is complete but the employment start date is still in the
  // future: nothing accrues and submissions are blocked until that date.
  NotStartedYet = 'not_started_yet',
}

// Which profile cards the employee directory should list. Every value is one
// predicate over the raw profile columns, and none of them compares a date, so
// this filter needs no as-of day and puts none in the cursor. The listing that
// carries it still reads a clock — each row's badge is judged against the
// employee's own calendar day — but that is the badge's business, not this
// filter's.
//
// Deliberately NOT EmployeeProfileStatus above: that one answers "can this
// person request and use leave today", which is a question about a calendar
// day in the employee's own timezone. Complete here is therefore WIDER than
// Ready there — an employee whose card is filled in but whose first day is next
// month is Complete for this filter and NotStartedYet on the badge beside it.
// The two are different questions and must stay separate types.
export enum EmployeeProfileFilter {
  // Anything still missing: the union of the two below, and the population an
  // admin means by "who do I still have to fill in".
  MissingAny = 'missing_any',
  // No employment start date — the accrual anchor is absent.
  MissingStartDate = 'missing_start_date',
  // No country — the holiday calendar that decides which days are paid is
  // unselected.
  MissingCountry = 'missing_country',
  // Both profile inputs are present. Says nothing about whether employment has
  // begun; see the note above.
  Complete = 'complete',
}

export enum CarryoverPolicy {
  // Unused days are forfeited at year end.
  None = 'none',
  // Unused days carry over up to a cap, whose shape carryoverCapMode picks:
  // a fixed carryoverCapDays, or carryoverCapPercent of one of two bases.
  Capped = 'capped',
  // All unused days carry over.
  Full = 'full',
}

// What the `capped` policy measures the cap against. Both percent modes read
// the same carryoverCapPercent and both floor the figure they derive from it;
// they differ only in what the percentage is taken OF.
export enum CarryoverCapMode {
  // The cap is a fixed number of days (carryoverCapDays).
  Days = 'days',
  // The cap is a share of the leftover (carryoverCapPercent), floored to
  // whole days so a carried balance is never fractional. Scales with how much
  // the employee did not use: a small leftover carries a small share of itself.
  Percent = 'percent',
  // The cap is a share of the year's EARNED entitlement, not of what survived
  // it: hire-month prorated in the year of joining (half-month rule, same as
  // accrual) and manual adjustments included. 50% of a 25-day policy gives a
  // full-year employee a 12-day ceiling, while a July hire who could only earn
  // 12.5 gets floor(12.5 * 0.5) = 6 — the ceiling scales with what the year
  // could actually grant. A CEILING and not a grant — a leftover below it
  // carries whole, fraction included, the same way `days` behaves when its
  // cap does not bind.
  PercentOfTotal = 'percent_of_total',
}
