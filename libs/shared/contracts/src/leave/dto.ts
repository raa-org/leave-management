/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  CarryoverCapMode,
  CarryoverPolicy,
  EmployeeProfileFilter,
  EmployeeProfileStatus,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
} from './enums'

export interface LeaveBalanceDto {
  leaveType: LeaveType
  totalDays: number
  availableDays: number
  onHoldDays: number
  spentDays: number
  accruedDays: number
  // Days rolled in from the prior year; already included in accruedDays and
  // totalDays' target, surfaced separately so the explainer can name them.
  carriedOverDays?: number
  // What is still bookable for the REST of this leave year: the days that will
  // have accrued by Dec 31 (plus carryover) minus spent and minus every day
  // already committed to a pending or approved request. Since forward planning
  // lets holds run ahead of accrual, this — not availableDays — is the number
  // an employee plans against.
  projectedRemainingDays?: number
  // True when the policy engine blended this year across a mid-year transfer:
  // totalDays is then the piecewise year-end total, which may match no single
  // policy's advertised terms — surfaces the "Policy changed during {year}"
  // hint next to the denominator.
  policyChangedDuringYear?: boolean
  updatedAt: string
}

export interface LeaveBalanceChangeDto {
  effectiveDate: string
  leaveType: LeaveType
  deltaDays: number
  availableDays: number
  onHoldDays: number
  spentDays: number
  reason: LeaveBalanceChangeReason
  note?: string
}

export interface LeaveRequestApprovalRecipientDto {
  email: string
  kind: ApproverKind
  displayName?: string
  // Per-approver progress (kind='to' only); cc recipients stay 'pending'.
  decision?: ApproverDecision
  decidedAt?: string
}

export interface LeaveRequestActivityDto {
  actorUserId?: string
  actorDisplayName: string
  action: string
  occurredAt: string
  comment?: string
}

export interface LeaveRequestSummaryDto {
  requestId: string
  leaveType: LeaveType
  status: LeaveRequestStatus
  startDate: string
  endDate: string
  requestedDays: number
  // How the request is funded, frozen when it was submitted. Days the projected
  // balance could not cover are unpaid: they are never held, never spent, and
  // never come back. paidDays + unpaidDays === requestedDays.
  paidDays: number
  unpaidDays: number
  // Paid days still RESERVED rather than taken: a request's days move from
  // held to spent one at a time as each leave day passes. Without it a client
  // can only guess the movement from the status, which reads "on hold" long
  // after the leave was lived through — and always so for imported history.
  heldDays: number
  submittedAt: string
  comment?: string
  // How much of each date the employee is away for, keyed by ISO date. ONLY
  // dates that are not whole appear, so an absent or empty map means an
  // ordinary whole-day request: the same idiom unpaidDates and the storage
  // column already carry. Values are fractions of a day on the hour grid.
  //
  // The FROZEN portions, never hours. The stored portion is the truth the books
  // were written from; hours are a rendering of it through the CURRENT workday
  // length (LeaveRequestDetailDto.hoursPerDay), which can change after a
  // request is frozen. A client renders hours from it, and the modification
  // composer converts it back to the hours it prefills, which is right because
  // the replacement will be priced with the current setting.
  //
  // On the SUMMARY rather than only the detail because a modification pair
  // embeds each counterpart as a summary (supersedes / supersededBy), and the
  // before/after an approver decides on is a different booking when the same
  // week has a day shortened.
  dayPortions?: Record<string, number>
  // Set on a REPLACEMENT: the approved request these new dates will replace
  // once every approver signs off. The leave type is inherited from it.
  supersedesRequestId?: string
  // Set on an ORIGINAL that has a replacement, whether still awaiting approval
  // (modificationPending) or already applied (status Superseded).
  supersededByRequestId?: string
  // True while a replacement for this request awaits re-approval. The original
  // stays Approved meanwhile and cannot be cancelled or modified again.
  modificationPending?: boolean
}

// How the authenticated caller relates to a request they are allowed to read.
// Only the reason they may (or may not) act on it — never a second opinion the
// client could form on its own: matching the caller against the approver rows
// needs server-side email normalization, the role claims and the "never decide
// your own request" rule, so the server answers it once and the client obeys.
// The server's single answer to "how does this caller stand on this request,
// and what may they do about it right now?" — computed once, obeyed by every
// surface. canDecide and canOverride are NOT mutually exclusive: an admin who
// is an approver and has not yet voted has both. When both are true the caller
// acts as the approver (offer the vote, canDecide), never the override — the
// approver hat takes precedence.
export interface LeaveRequestViewerContextDto {
  // The caller's standing on this request — who they are here, not what they may
  // do. Drives the explanatory copy and read access (an Unrelated caller is
  // denied); never derive action rights from it, the flags below are the
  // authority. Administrator here is a per-request standing (an admin with no
  // other involvement), distinct from the RBAC admin role.
  standing: LeaveRequestViewerStanding
  // True only when a decision submitted right now would be accepted: the caller
  // is a 'to' approver on someone else's request, the request is still Pending,
  // and they have not voted yet. Clients render the action form from this flag
  // alone — no status or own-vote re-checks.
  canDecide: boolean
  // True only when an administrator override submitted right now would be
  // accepted: the caller holds the admin role, the request is still Pending, and
  // is not their own (nobody decides their own). Being an approver does NOT
  // remove it — a voted admin-approver may still override, they just act as the
  // approver first while their vote is unspent (see canDecide precedence above).
  // Derived from the admin ROLE, not the standing: a copied admin is 'copied',
  // so the client cannot tell a copied administrator from a copied employee and
  // must read this flag rather than infer override rights from the standing. The
  // override endpoint accepts exactly this combination — the admin role (checked
  // at the controller) plus pending and not-your-own (re-checked in the domain
  // under its row lock) — so "would be accepted" is exact.
  canOverride: boolean
  // The caller's OWN cast vote — absent until they are a 'to' approver who has
  // voted; a Pending row is "no vote", so when present the decision is always a
  // real one (hence the narrowed type). This is what lets a surface report the
  // caller's own decision back to them, and its presence is why canDecide is
  // false: a vote is cast once. Named ownVote because request.decidedAt one
  // level up means something else — when the whole request settled.
  ownVote?: {
    decision: Exclude<ApproverDecision, ApproverDecision.Pending>
    decidedAt?: string
  }
}

export interface LeaveRequestDetailDto extends LeaveRequestSummaryDto {
  requesterUserId: string
  requesterDisplayName: string
  approvers: LeaveRequestApprovalRecipientDto[]
  activity: LeaveRequestActivityDto[]
  // The requester's whole ledger for THIS leave type (not just this request's
  // rows), ordered by when each movement happened, oldest first — the rows this
  // request wrote are found by the request id stamped into their note.
  balanceTimeline: LeaveBalanceChangeDto[]
  // The working days of this request the balance does not fund, frozen at
  // submit. Not necessarily a trailing run: accrual arriving mid-request funds
  // the days after it, so an unpaid stretch can sit before a paid one. Empty
  // when the whole request is paid.
  unpaidDates: string[]
  // How long a workday is (LeaveSettingsDto.hoursPerDay): the divisor that
  // turns requestedDays and dayPortions above into days and hours. Carried on
  // the request itself because this DTO is what the approval review page, the
  // request detail and the history all render from, and none of them fetches
  // the dashboard or the administrator-only settings endpoint. Without it a
  // deep link from an approval email renders every figure against the default
  // eight while the email that led there used the org's real workday.
  hoursPerDay: number
  decisionComment?: string
  decidedAt?: string
  // Counterpart snapshots embedded server-side so no client needs a second
  // fetch: an approver of a replacement is not necessarily an approver of the
  // original, so fetching it directly would be forbidden.
  supersedes?: LeaveRequestSummaryDto
  supersededBy?: LeaveRequestSummaryDto
  // Populated by the application layer, which knows the caller; the domain
  // builds this DTO in many viewer-agnostic places and leaves it absent. Absent
  // must therefore read as "no authority": never render actions without it.
  viewer?: LeaveRequestViewerContextDto
}

// Modification of an approved, not-yet-started request. Creates a NEW linked
// request that goes through full re-approval while the original stays approved.
// leaveType is deliberately absent: it is locked to the original's.
export interface ModifyLeaveRequestDto {
  startDate: string
  endDate: string
  comment?: string
  approverEmails: string[]
  ccEmails: string[]
  // The part-day shape of the NEW absence, in whole hours (see
  // CreateLeaveRequestDto). Like leaveType it is not inherited: a modification
  // re-states the whole shape, so an absent map means every new date is a full
  // day rather than "keep the original's hours".
  hoursByDate?: Record<string, number>
}

// Reasons the range cannot be booked at all. Running past the projected balance
// is NOT one of them: those days are simply unpaid (see unpaidDates below).
export type LeaveAvailabilityBlockerCode =
  | 'overlapping_request'
  | 'holiday_calendar_missing'
  | 'no_working_days'
  | 'beyond_planning_horizon'
  | 'profile_not_ready'

export interface LeaveAvailabilityOverlappingRequestDto {
  startDate: string
  endDate: string
  status: LeaveRequestStatus
}

export interface LeaveAvailabilityBlockerDto {
  code: LeaveAvailabilityBlockerCode
  // Server-authored sentence for the composer to render verbatim. For most
  // codes this matches the submit rejection; for overlapping_request it is a
  // short headline and overlappingRequests carries the per-request detail.
  message: string
  // Present when code is overlapping_request: every pending or approved request
  // whose period intersects the queried range.
  overlappingRequests?: LeaveAvailabilityOverlappingRequestDto[]
}

// One month of a leave year's projection, for the composer's outlook strip.
export interface LeaveMonthOutlookDto {
  // The calendar year this month belongs to. A cross-year preview projects
  // every year the range touches, so month numbers repeat and (year, month)
  // is the row's identity.
  year: number
  month: number
  // Days accrued by the end of this month (vacation: pro rata month by month;
  // sick: the up-front tranche, itself prorated by the hire month), including
  // carryover.
  projectedAccruedDays: number
  // Spent days plus every committed day through this month, including the PAID
  // days of the previewed request (unpaid days never charge the balance).
  committedDays: number
  // projectedAccruedDays - committedDays; negative when the plan does not fit.
  remainingDays: number
}

/**
 * One leave year as the preview projects it: what the year holds today, what it
 * will hold by the time the leave is taken, and what it hands to the next year
 * once the leave is charged against it.
 *
 * Every figure is server-authored, and each states below whether the request
 * being composed is already counted in it. The composer does its arithmetic on
 * these numbers rather than rebuilding them from the balance snapshot, which
 * knows only the current year and counts a leave awaiting a change twice.
 */
export interface LeaveYearProjectionDto {
  year: number
  // The year's allocation with carryover NOT folded in: carryover is added on
  // top, so the full entitlement is totalDays + carriedOverDays.
  totalDays: number
  // Days rolled in from the prior year. Already inside accruedDays for a year
  // that has begun, and inside every projected figure below for any year.
  carriedOverDays: number
  // True when carriedOverDays is a forecast of what the prior year will leave
  // behind rather than a settled figure, which is to say this year has not
  // begun. It is also how a client tells the two apart without a clock.
  carryoverProjected: boolean
  // What has accrued in THIS year as of today. Zero for a year that has not
  // begun, which is why a future year is read through the projected figures
  // below and never through this one.
  accruedDays: number
  // Days already taken and consumed in this year.
  spentDays: number
  // Days committed to pending or approved requests in this year, EXCLUDING the
  // request being composed, which the composer adds back itself. A count of
  // days rather than a balance figure: unlike LeaveBalanceDto.onHoldDays it is
  // not doubled while a modification awaits approval, so this is the number to
  // plan against.
  committedDays: number
  // What will have accrued by the last day this request occupies in this year.
  // When the request does not touch this year there is no such day and this
  // falls back to projectedYearEndAccrual, the whole year still being ahead.
  // lastLeaveDay tells the two cases apart.
  projectedAccruedByLeave: number
  // The day projectedAccruedByLeave is measured at: the request's last WORKING
  // day inside this year, which only the server can pick since it holds the
  // holiday calendar. Absent when the request does not touch this year.
  lastLeaveDay?: string
  // What will have accrued by 31 December of this year.
  projectedYearEndAccrual: number
  // The request's working days that fall in this year. Zero for a year the
  // range does not touch. These sum to requestedDays, except for a range
  // reaching past the planning horizon, whose out-of-horizon days have no year
  // here to be counted in.
  requestedDays: number
  // How this year's share of the request would be funded if it were submitted
  // now. paidDays + unpaidDays === requestedDays for this year.
  paidDays: number
  unpaidDays: number
  // What this year is projected to hand to the next one under the configured
  // policy, the request's paid days already charged against it. Always 0 for
  // sick leave, which carries nothing whatever the policy says. Absent for a
  // year already closed, whose real carryover is settled in the books and is
  // not re-derived from a forecast here, so absent must never be read as zero.
  carryoverOutDays?: number
}

export interface LeaveAvailabilityQueryDto {
  leaveType: LeaveType
  startDate: string
  endDate: string
  // Modify mode: the approved request whose days are excluded from the
  // feasibility and overlap checks, since they are released on the swap.
  excludeRequestId?: string
  // The part-day shape being composed, in whole hours (see
  // CreateLeaveRequestDto). Priced exactly as a submission of the same map
  // would be, which is the whole point of the preview: the panel must not be
  // able to show a split submit would not freeze.
  hoursByDate?: Record<string, number>
}

export interface LeaveAvailabilityPreviewDto {
  leaveType: LeaveType
  leaveYear: number
  startDate: string
  endDate: string
  // Server-computed working days of the range (weekends and holidays excluded).
  requestedDays: number
  // How this range would be funded if it were submitted now, computed by the
  // same code the submit endpoint freezes onto the request.
  paidDays: number
  unpaidDays: number
  // The exact days that would be unpaid, so the composer can mark them on the
  // calendar. Not necessarily a trailing run: accrual arriving mid-request funds
  // the days after it.
  unpaidDates: string[]
  // Server-authored sentence describing the split, rendered verbatim; absent
  // when the whole range is paid.
  unpaidNotice?: string
  feasible: boolean
  // Empty when feasible; ordered most-blocking first.
  blockers: LeaveAvailabilityBlockerDto[]
  // First payable day under the requester's probation window, present while
  // any requested day falls inside it. Display-only companion to the forced
  // unpaid split (probation days ride unpaidDates/unpaidNotice) — NEVER a
  // blocker: probation submissions stay legal as unpaid.
  probationEnd?: string
  // Month by month, for the years the RANGE TOUCHES only. Deliberately a
  // narrower set of years than `years` below, which covers the whole horizon.
  monthlyOutlook: LeaveMonthOutlookDto[]
  // Every leave year the projection covers, ascending: always this year and
  // next, plus any earlier year a backdated range charges. Deliberately NOT
  // limited to the years the range touches, since the composer shows the years
  // side by side however short the picked range is, and a January request has
  // to explain which carryover funds it. Never runs past the planning horizon,
  // where no allocation is set and the numbers would be fiction. Always
  // populated, blockers or not: a range that cannot be booked still has a
  // balance story.
  years: LeaveYearProjectionDto[]
  // Today's leave year in the EMPLOYEE's timezone, which is how a client tells
  // which entry of `years` has begun. It cannot work this out from generatedAt
  // (a UTC instant) or from leaveYear (the year the range STARTS in), and must
  // not try: on New Year's Eve the three disagree.
  currentYear: number
  generatedAt: string
}

export interface LeaveRequestHistoryDto {
  requests: LeaveRequestDetailDto[]
  // Ordered by when each movement happened, oldest first (see
  // EmployeeDashboardDto.balanceTimeline).
  balanceTimeline: LeaveBalanceChangeDto[]
  // The divisor for every day figure on the history page (see
  // LeaveRequestDetailDto.hoursPerDay). Carried on the envelope as well as on
  // each request because the balance timeline belongs to no request, and a
  // history with no requests at all still renders ledger amounts.
  hoursPerDay: number
  // The canonical server instant the balances/timeline were computed to. The
  // client anchors its "as of" display and staleness checks to this, never to
  // its own clock.
  generatedAt: string
}

export interface EmployeeDashboardDto {
  employeeId: string
  displayName: string
  roleNames: AppRoleName[]
  generatedAt: string
  // Backend-computed readiness of the profile card; anything but Ready means
  // nothing accrues and submissions are blocked (PendingSetup: an admin has
  // not completed the profile; NotStartedYet: the start date is in the future).
  profileStatus: EmployeeProfileStatus
  // Display-only (e.g. the NotStartedYet notice names the date); the UI must
  // derive no state from it — profileStatus is the single readiness signal.
  employmentStartDate?: string
  // Years with a CONFIGURED holiday calendar for the employee's effective
  // holiday country (see holidayCalendarCountryCode; empty when none is set or
  // nothing configured). Lets the composer warn and disable submission for a
  // year the backend would reject anyway — the backend guard in submitLeaveRequest
  // remains the enforcer.
  holidayCalendarYears: number[]
  // How long a workday is (LeaveSettingsDto.hoursPerDay), the divisor every day
  // figure is rendered as days and hours against. Display-only, like
  // holidayCalendarYears: the server owns the conversion that mints portions.
  //
  // It rides on the dashboard because that is the one response every employee
  // page loads. The composer's form context carries it too, for the hours
  // editor; without it here the approver's detail page and the history would
  // have no divisor to render an amount with at all.
  hoursPerDay: number
  // The employee's assigned country (absent when no location is set). Office /
  // timezone facts only — holiday shading uses holidayCalendarCountryCode when
  // set, otherwise this code.
  countryCode?: string
  // Explicit holiday-calendar override. Absent or null means "use countryCode".
  holidayCalendarCountryCode?: string
  // Display-only policy facts (the holidayCalendarYears pattern: UI informs,
  // the backend enforces). policyName labels the current group; probationEndsOn
  // is present while the employee's probation window is still running.
  policyName?: string
  probationEndsOn?: string
  balances: LeaveBalanceDto[]
  pendingRequests: LeaveRequestSummaryDto[]
  recentActivity: LeaveRequestActivityDto[]
}

export interface CreateLeaveRequestDto {
  leaveType: LeaveType
  startDate: string
  endDate: string
  comment?: string
  approverEmails: string[]
  ccEmails: string[]
  // Part-day bookings: ISO date -> WHOLE HOURS away on that date. A date the
  // map does not name, and an absent map, mean a full day, so an ordinary
  // request never carries this field.
  //
  // The wire speaks HOURS and never fractions of a day: the divisor is the
  // org's workday length (LeaveRequestFormContextDto.hoursPerDay), which the
  // server owns, so a client cannot mint a fraction the server would not have.
  // Every named date must be a working day of the period: a weekend, a public
  // holiday or a date outside the range is refused, never dropped.
  hoursByDate?: Record<string, number>
}

// Directory entry for the composer's approver/CC pickers: identity only, the
// same shallow projection the admin option list uses (no balances, no roles).
export interface UserOptionDto {
  userId: string
  displayName: string
  email: string
}

// A settings-default recipient as previewed in the request composer. The
// server folds these into every submission regardless of the client payload,
// so the form renders them as locked entries the requester cannot remove.
// displayName is present only when the email matches a provisioned user.
export interface DefaultRecipientDto {
  email: string
  displayName?: string
}

// Everything the request composer needs to render directory-backed pickers:
// the selectable users (everyone except the caller — self-approval is
// rejected at submit) and the settings defaults the submit path will fold in,
// previewed with the same normalization, dedup, and caller exclusion the
// submit-time merge applies.
export interface LeaveRequestFormContextDto {
  users: UserOptionDto[]
  defaultApprovers: DefaultRecipientDto[]
  defaultCc: DefaultRecipientDto[]
  // The org's approval mode (LeaveSettingsDto.approvalRequired). False means
  // the composer may submit with no approver at all, and such a request is
  // approved automatically. Carried explicitly rather than inferred from an
  // empty defaultApprovers: that array is also empty in required mode when no
  // defaults are configured, and the two states must not render alike.
  approvalRequired: boolean
  // How long a workday is (LeaveSettingsDto.hoursPerDay): the divisor that
  // turns the hours in CreateLeaveRequestDto.hoursByDate into fractions of a
  // day. Published here because the composer has to offer the same grid the
  // server enforces, and the settings endpoint that owns the figure is
  // administrator-only.
  hoursPerDay: number
}

export interface LeaveApprovalActionDto {
  action: LeaveApprovalAction
  comment?: string
}

export interface CountryDto {
  code: string
  name: string
  // The IANA timezone this country's office runs on. Decides which calendar day
  // a leave day is spent on AND the accrual boundaries for users in this
  // country, so it is a
  // choice, not a label: a multi-zone country has no single right answer.
  // On update, ABSENT MEANS UNCHANGED (never "reset to the catalog default").
  // A submitted value must be one of the country's catalog timezones, or the
  // value already stored for it; anything else is refused with 400
  // `country_timezone_not_available`.
  timezone?: string
  // How many employees this country is assigned to. Read-only: the server
  // computes it and ignores it on write. Present so a console can say why a
  // country cannot be removed BEFORE the attempt, rather than only reporting
  // the refusal afterwards. Removing a country that still has employees is
  // refused with 409 `country_in_use`, which also carries the counts.
  assignedUsers?: number
}

// One entry of the canonical country catalog (code -> name + timezones), served
// to the admin country picker so countries are chosen from a list, not typed.
export interface CountryCatalogEntryDto {
  code: string
  name: string
  // Default/representative IANA timezone for the country (the head of
  // `timezones`); used when the admin does not pick a specific zone.
  timezone: string
  // Full pickable list of the country's IANA timezones (a country can span
  // several), with the default `timezone` first. Never empty.
  timezones: string[]
}

export interface HolidayEntryDto {
  // Server-assigned uuid; omitted on write (the server generates it). Holidays
  // hang off a calendar, so the entry no longer carries a countryCode.
  holidayId?: string
  date: string
  name: string
}

// One country's official-holiday calendar for a single leave year. Multiple
// years of the same country coexist, each with its own calendarId.
export interface HolidayCalendarDto {
  calendarId: string
  country: CountryDto
  year: number
  name: string | null
  // Set when this calendar was cloned from another year's calendar.
  sourceCalendarId?: string | null
  holidays: HolidayEntryDto[]
}

export interface LeaveSettingsDto {
  defaultVacationDays: number
  defaultSickDays: number
  // Whether a leave request needs a human decision at all. True (the default)
  // is the classic behavior: a submission must carry at least one 'to'
  // approver and defaultApproverEmails are folded onto every request. False
  // makes approval optional: the deciding defaults are kept but NOT applied,
  // a submission that ends up with no 'to' approver is approved by the system
  // at once, and one the employee addresses to someone still waits for them.
  // defaultCcApproverEmails are folded in either way: a copied recipient never
  // decides anything, so nothing about them conflicts with automatic approval.
  // Optional on write (absent leaves the stored value alone); always populated
  // on read.
  approvalRequired?: boolean
  defaultApproverEmails: string[]
  defaultCcApproverEmails: string[]
  // How unused days roll into the next leave year. Under `capped`,
  // carryoverCapMode picks which cap applies: carryoverCapDays for a fixed
  // limit, or carryoverCapPercent (0..100, floored to whole days) as a share
  // of either the leftover (`percent`) or the year's earned entitlement
  // (`percent_of_total`, hire-month prorated in the year of joining). Optional
  // on write (defaults: capped at 50 percent of the leftover); always
  // populated on read.
  carryoverPolicy?: CarryoverPolicy
  carryoverCapDays?: number
  carryoverCapMode?: CarryoverCapMode
  carryoverCapPercent?: number
  // The org-wide fallback timezone: for an employee with no country, or whose
  // country carries no zone. A leave day is spent at midnight on this calendar.
  // Absent on write means "leave the stored zone alone". A submitted value must
  // be a zone the server's runtime can resolve, or the value already stored;
  // anything else, a fixed offset like '+03:00' included, is refused with 400
  // `default_timezone_not_recognized`.
  defaultTimezone?: string
  // How many hours a full workday is, org-wide: the divisor that turns a
  // booking in hours into a fraction of a day (at 8, two hours off is 0.25 of
  // a day). A whole number of hours, 1..24. Absent on write means "leave the
  // stored length alone"; always populated on read.
  hoursPerDay?: number
  countries: CountryDto[]
  holidayCalendars: HolidayCalendarDto[]
  updatedAt: string
}

// Holidays are decoupled from the settings write: they are managed through the
// dedicated holiday endpoints (a settings save never touches calendars), so the
// old destructive clear-and-reinsert is gone.
export interface UpdateLeaveSettingsDto
  extends Omit<LeaveSettingsDto, 'holidayCalendars'> {}

export interface ListMyLeaveRequestsQueryDto {
  status?: LeaveRequestStatus
  // Inclusive overlap of the request period with [from, to] ('YYYY-MM-DD'):
  // a request matches when its dates touch the window. Either end may be
  // omitted to leave that side open.
  from?: string
  to?: string
}

// One row per leave request carrying its LIVE status (not a per-event history),
// ordered by most recent timeline activity. lastAction/lastActivityAt describe
// the latest event on the request.
export interface AdminActivityFeedItemDto {
  requestId: string
  employeeId: string
  employeeDisplayName: string
  status: LeaveRequestStatus
  leaveType: LeaveType
  startDate: string
  endDate: string
  requestedDays: number
  // The funding split frozen on the request; see LeaveRequestSummaryDto.
  paidDays: number
  unpaidDays: number
  // Paid days still RESERVED rather than taken: a request's days move from
  // held to spent one at a time as each leave day passes. Without it a client
  // can only guess the movement from the status, which reads "on hold" long
  // after the leave was lived through — and always so for imported history.
  heldDays: number
  submittedAt: string
  lastAction: string
  lastActivityAt: string
  // The admin reading the feed may also be an approver on some of these rows.
  // Without this the console cannot tell those rows apart and offers everyone
  // the override dialog — including approvers, whose own vote is the thing the
  // override would bypass. Same contract as the request detail: absent means no
  // authority.
  viewer?: LeaveRequestViewerContextDto
}

// Request counts by live status for the whole filtered population (every
// active filter applies), independent of pagination — the items list is only
// the visible page.
export interface AdminActivityFeedTotalsDto {
  total: number
  pending: number
  approved: number
  rejected: number
  cancelled: number
  // Approved requests replaced by a re-approved modification. Optional so
  // fixtures written before forward planning stay valid; counted in `total`.
  superseded?: number
}

export interface AdminActivityFeedDto {
  items: AdminActivityFeedItemDto[]
  // Present on first-page responses only (no cursor); load-more pages omit it
  // and clients keep the totals they already have.
  totals?: AdminActivityFeedTotalsDto
  // Opaque keyset cursor — pass nextCursor back verbatim to fetch the next
  // page; never construct it client-side.
  nextCursor?: string
  // The divisor for the day figures on every row (see
  // LeaveRequestDetailDto.hoursPerDay). The activity console fetches nothing
  // else that knows the org's workday, and it prints server-authored notes
  // carrying the real one beside figures it renders itself.
  hoursPerDay: number
}

export interface AdminActivityQueryDto {
  cursor?: string
  limit?: number
  // Optional narrowing filters; all supplied filters combine with AND and must
  // stay identical across cursor pages of one listing.
  employeeId?: string
  // Matches requests where this email is a deciding ('to') approver; compared
  // case-insensitively. CC watchers do not count.
  approverEmail?: string
  status?: LeaveRequestStatus
  leaveType?: LeaveType
  // Inclusive leave-period overlap: a request matches when its [startDate,
  // endDate] intersects [from, to]. Either bound may be supplied alone.
  from?: string
  to?: string
}

// Lightweight directory projection for filter dropdowns. Unlike the employee
// list, fetching options must not trigger per-user balance refresh/hydration.
export interface AdminEmployeeOptionDto {
  employeeId: string
  displayName: string
  email: string
}

// One project a user belongs to (via user_project_memberships). `projectId` is
// the LOCAL projects.id, not the OIDC externalId — it is what the directory
// project filter expects back.
export interface AdminEmployeeProjectDto {
  projectId: string
  name: string
  // The member's role on this project (user_project_memberships.roleOnProject,
  // from OIDC), shown as their "position". Absent on the lightweight list rows,
  // populated on the employee detail. Empty string when the mirror has no role.
  position?: string
}

// Deliberately shallow: the directory list carries only what its cards render
// (identity, roles, project/country, latest request status). Balances and
// request history are per-employee detail — see AdminEmployeeDetailDto.
export interface AdminEmployeeListItemDto {
  employeeId: string
  displayName: string
  email: string
  roleNames: AppRoleName[]
  // Whether the account is active. The LDAP sync deactivates departed users
  // (active=false) but never deletes them, and deactivated rows stay listed so
  // an admin can resolve conflicts and reactivate — so the directory must be
  // able to mark them. Drives the "Inactive" badge and the deactivate/reactivate
  // control.
  active: boolean
  // Whether the admin still has to finish the profile card. PendingSetup means
  // country or employment start date is missing — neither the LDAP sync nor SSO
  // ever fills those, so freshly-synced accounts land here until an admin
  // completes them. Same status the detail card shows, so list and card agree;
  // lets the directory flag which accounts need attention.
  profileStatus: EmployeeProfileStatus
  // The assigned country's code (FK to countries.code); resolve the display
  // name against the filter options (or the countries list).
  countryCode?: string
  // Always present — empty for a user with no memberships — so clients never
  // branch on undefined.
  projects: AdminEmployeeProjectDto[]
  // The employee's current leave policy group (chip + filter in the
  // directory). Absent only before the engine bootstrap has enrolled the user.
  policyId?: string
  policyName?: string
  // When the current membership began, for the member list inside a policy.
  policySince?: string
  // A future-dated transfer already recorded: the employee is on `policyName`
  // today and leaves for this one on that date.
  policyScheduled?: { policyName: string; effectiveFrom: string }
  // First payable day, present only while the probation window is still
  // running. Display-only, like the dashboard's copy of it.
  probationEndsOn?: string
  latestRequest?: LeaveRequestSummaryDto
}

// Choices for the directory's Country and Project dropdowns. `countries` holds
// only the countries actually assigned to someone (offering an unused one
// could only ever filter the directory down to nothing); `projects` is the
// whole mirrored catalog, so a project with no members can still be picked and
// visibly return no one.
export interface AdminEmployeeFilterOptionsDto {
  countries: CountryDto[]
  projects: AdminEmployeeProjectDto[]
  // The whole policy catalog for the directory's Policy filter (a policy with
  // no members can be picked and visibly return no one, like projects).
  policies: Array<{ policyId: string; name: string }>
}

// Directory-wide counters for the header cards. Computed only on the first
// page (no cursor) and independent of every list filter and of pagination.
export interface AdminEmployeeTotalsDto {
  // Role-holder counts among ACTIVE accounts, same semantics as the Role
  // filter: every account holds at least one role, an admin-only account
  // counts only under administrators, and a deactivated account counts in
  // neither — deactivation keeps the role rows, but the cards answer for
  // the working directory. `accounts` below is the one counter that
  // includes deactivated rows.
  employees: number
  administrators: number
  // All user rows, deactivated included. Role-holder counts undercount an
  // account-level operation, so anything priced in accounts (the directory
  // reset's deletion cost) reads this one.
  accounts: number
  // Employees with at least one pending request — deliberately NOT "latest
  // request is pending": an older request can still await review after a
  // newer one was already decided.
  pendingReview: number
}

export interface AdminEmployeeListDto {
  items: AdminEmployeeListItemDto[]
  totals?: AdminEmployeeTotalsDto
  nextCursor?: string
  // The divisor for the balance meters on every row (see
  // LeaveRequestDetailDto.hoursPerDay).
  hoursPerDay: number
}

export interface AdminEmployeesQueryDto {
  search?: string
  roleName?: AppRoleName
  // Exact countries.code match on the employee's assigned country.
  countryCode?: string
  // Matches employees holding a membership in this project (projects.id).
  projectId?: string
  // Matches employees whose CURRENT policy (the live membership covering
  // today) is this one.
  policyId?: string
  // Employment status: true lists only active accounts, false only deactivated
  // ones. Absent means both — the filter has to tell "not asked for" apart from
  // "asked for the deactivated ones".
  active?: boolean
  // Which profile cards to list, judged on the raw columns rather than on the
  // computed badge — see EmployeeProfileFilter for why the two differ.
  profile?: EmployeeProfileFilter
  // Inclusive bounds on the employment start date ('YYYY-MM-DD'); either may be
  // supplied alone to leave that side open. The caller names both days, so this
  // filter reads no clock — "who starts from tomorrow" is asked by passing
  // tomorrow, not by a server-side notion of today.
  //
  // An employee with no start date matches NEITHER bound, so combining a range
  // with profile=missing_start_date answers with an empty list. That is the
  // literal answer to a contradictory question, not a widened one.
  employmentStartDateFrom?: string
  employmentStartDateTo?: string
  // All supplied filters combine with AND and must stay identical across the
  // cursor pages of one listing — they are part of what the cursor addresses.
  cursor?: string
  limit?: number
}

export interface AdminEmployeeDetailDto {
  employeeId: string
  displayName: string
  email: string
  roleNames: AppRoleName[]
  // Whether the account is active. Deactivated (departed) users stay visible so
  // an admin can resolve sync conflicts and reactivate; drives the Inactive
  // status and the deactivate/reactivate control on the card.
  active: boolean
  // Backend-computed readiness (same signal as EmployeeDashboardDto
  // .profileStatus): anything but Ready means nothing accrues and submissions
  // are blocked. The UI must not re-derive this from the raw fields below —
  // they are display-only (e.g. to show which field is still empty).
  profileStatus: EmployeeProfileStatus
  employmentStartDate?: string
  // Office / location: the assigned country's code (FK to countries.code).
  // Resolve the display name against the countries list.
  countryCode?: string
  // Explicit holiday-calendar override. Absent or null means "use countryCode".
  holidayCalendarCountryCode?: string
  // Projects the employee belongs to, each with the member's position
  // (roleOnProject). Read-only here — memberships are mirrored from OIDC.
  // Always present (empty for a user with no memberships).
  projects: AdminEmployeeProjectDto[]
  // The employee's current leave policy group; the full membership timeline
  // comes from the dedicated policy endpoint (EmployeePolicyDto).
  policyId?: string
  policyName?: string
  balances: LeaveBalanceDto[]
  requestHistory: LeaveRequestDetailDto[]
  // The employee's WHOLE balance ledger (both leave types) — the same stream
  // LeaveRequestHistoryDto.balanceTimeline carries. Shipped here because the
  // per-request timelines cannot reconstruct it: year-close rows (carryover
  // in/out, expiry) belong to no request. Ordered by when each movement
  // HAPPENED, oldest first; effectiveDate is the day a movement belongs to,
  // not the sort key, and may go backwards between neighbouring rows.
  balanceTimeline: LeaveBalanceChangeDto[]
  // Canonical server instant the balances were computed to (see
  // LeaveRequestHistoryDto.generatedAt).
  generatedAt: string
  // The divisor for every day figure on the employee profile (see
  // LeaveRequestDetailDto.hoursPerDay). The admin console has no dashboard
  // fetch, and only its Settings page reads the endpoint that owns the figure,
  // so without it here the profile renders against the default eight.
  //
  // Also the grid the balance correction on this page has to MINT its amount
  // on: the server refuses a correction that is not a whole number of hours at
  // this workday, so the stepper's step and the snap of a typed figure take
  // their divisor from here rather than from a display fallback.
  hoursPerDay: number
}

// Admin per-employee edits. Optional fields so the same endpoint can update one
// or more attributes in a single PATCH. `employmentStartDate` and `countryCode`
// each accept a value or null (clear the override); an absent field is left
// untouched. `countryCode` must reference an existing country.
export interface UpdateEmployeeAdminDto {
  employmentStartDate?: string | null
  countryCode?: string | null
  // An existing country's code whose holiday calendar should drive leave-day
  // counting, or null to fall back to countryCode. Must reference a country
  // that already has at least one configured holiday calendar.
  holidayCalendarCountryCode?: string | null
}

// Admin deactivate/reactivate of an employee. Separate from
// UpdateEmployeeAdminDto because `active` is a distinct concern: it never rides
// in a profile edit (which must never touch it), it is the only way to resolve a
// sync conflict, and it audits its own reactivated/deactivated event.
export interface SetEmployeeActiveDto {
  // Target state: true reactivates, false deactivates.
  active: boolean
}

// Admin override of a user's annual allocation for one leave type. `year`
// defaults to the current leave year when omitted.
// DEPRECATED by the policy engine: the endpoint is removed once the policy
// panel replaces the allocation editor — every per-user exception becomes a
// policy.
export interface UpdateEmployeeAllocationDto {
  leaveType: LeaveType
  totalDays: number
  year?: number
}

// Admin one-shot vacation balance correction for the current open leave year.
// The sign is add (positive) or remove (negative). note is required and is
// written into the balance ledger and the audit row.
export interface AdjustEmployeeVacationBalanceDto {
  // Signed days on the hour grid: positive adds, negative removes. Non-zero,
  // and a whole number of hours at the org's hoursPerDay (0.125 is one hour of
  // an eight-hour day), so an admin correction can match a part-day booking an
  // employee actually took.
  deltaDays: number
  note: string
}

// ------------------------------------------------ leave policy groups -----

// A leave policy group: the terms of an offer, assigned to users via
// memberships. Terms are IMMUTABLE after creation — "editing" terms is a
// supersede (create the corrected policy, transfer members); only name,
// description and effectiveTo ever change in place, and the default flag only
// via the dedicated default-swap endpoint.
export interface LeavePolicyDto {
  policyId: string
  name: string
  description?: string
  vacationDays: number
  sickDays: number
  // +N vacation days every vacationIncrementEveryYears calendar years of
  // employment (steps anchored to the hire year, landing on 1 January);
  // 0 = no automatic revision.
  vacationAnnualIncrement: number
  // Years between two increment steps; 1 = every year. Always 1 when the
  // increment is 0, so an inert period cannot describe two identical offers.
  vacationIncrementEveryYears: number
  // Upper bound the increment may grow vacationDays to; absent = uncapped.
  vacationIncrementCapDays?: number
  probationMonths: number
  // When true, sick requests during probation stay paid; vacation days inside
  // the probation window are always forced unpaid.
  paidSickDuringProbation: boolean
  effectiveFrom: string
  // Absent = active forever. Setting it is refused while open members remain
  // without a scheduled successor transfer.
  effectiveTo?: string
  isDefault: boolean
  // Server-computed canonical terms fingerprint (duplicate detection).
  termsFingerprint: string
  // Live open memberships / future-dated scheduled transfers into the policy.
  memberCount: number
  scheduledInCount: number
  createdAt: string
}

export interface CreateLeavePolicyDto {
  name: string
  description?: string
  vacationDays: number
  sickDays: number
  vacationAnnualIncrement?: number
  // Absent = 1 (every year).
  vacationIncrementEveryYears?: number
  vacationIncrementCapDays?: number
  probationMonths?: number
  paidSickDuringProbation?: boolean
  effectiveFrom: string
  effectiveTo?: string
}

// Terms are immutable — only these fields may change (see LeavePolicyDto).
// `null` clears description/effectiveTo; an absent field is left untouched.
export interface UpdateLeavePolicyDto {
  name?: string
  description?: string | null
  effectiveTo?: string | null
}

// One row of a user's policy membership timeline. Intervals are half-open
// [effectiveFrom, effectiveTo); effectiveTo absent = the open (current or
// scheduled-into) row. superseded marks rows erased by a retroactive backdated
// transfer — kept for the audit trail, ignored by resolution, rendered
// struck-through.
export interface PolicyMembershipDto {
  membershipId: string
  policyId: string
  policyName: string
  effectiveFrom: string
  effectiveTo?: string
  superseded: boolean
  assignedByUserId?: string
  note?: string
  createdAt: string
}

// How a backdated transfer treats the period between its date and today:
// 'retroactive' recomputes the whole affected open period as if the new policy
// had applied (anchor: Jan 1 of the date's year, floored at the hire date);
// 'prospective' keeps everything earned before the date as computed under the
// old policy and applies the new terms from the date on.
export type PolicyTransferMode = 'retroactive' | 'prospective'

// Move an employee to a policy (or a new inline-created one — exactly one of
// policyId / newPolicy) effective on any date: past (mode required), today
// (immediate) or future (scheduled).
export interface TransferEmployeePolicyDto {
  policyId?: string
  newPolicy?: CreateLeavePolicyDto
  effectiveDate: string
  // Required when effectiveDate is in the past; forbidden otherwise.
  mode?: PolicyTransferMode
  note?: string
}

// A pending or approved request the transfer collides with: either it blocks
// the transfer (committed paid days exceed the target the transfer would set)
// or it falls inside the new policy's probation window (informational — the
// frozen split stays paid).
export interface PolicyTransferRequestRefDto {
  requestId: string
  leaveType: LeaveType
  startDate: string
  endDate: string
  paidDays: number
}

// One ledger adjustment the transfer would post, per (leave type, year).
export interface PolicyTransferAdjustmentDto {
  year: number
  leaveType: LeaveType
  // Signed: positive grants days now, negative removes them.
  delta: number
  newYearTotal: number
}

// Read-only dry run of a transfer, rendered by the transfer dialog BEFORE the
// write: what it would adjust, what blocks it, and which paid requests fall
// inside the new policy's probation window. The write path re-checks — this is
// UX, not enforcement.
export interface PolicyTransferPreflightDto {
  feasible: boolean
  blockingRequests: PolicyTransferRequestRefDto[]
  probationWarnings: PolicyTransferRequestRefDto[]
  perYearAdjustments: PolicyTransferAdjustmentDto[]
  // The anchor actually applied — a retroactive mode snaps to Jan 1 of the
  // year (floored at the hire date) and rate changes snap to month boundaries,
  // so this may differ from the picked date and must be shown, never assumed.
  appliedFrom: string
  // Present on a refusal that can offer a later permissible date (the backdate
  // range touched a closed year).
  earliestPermissibleDate?: string
}

// The employee-profile policy panel payload.
export interface EmployeePolicyDto {
  current: PolicyMembershipDto
  // Present while a future-dated transfer is pending.
  scheduled?: PolicyMembershipDto
  // Present when the current policy defines a probation window for this
  // employee; active = today is still inside it.
  probation?: {
    endsOn: string
    active: boolean
  }
  history: PolicyMembershipDto[]
}

export interface ListHolidaysQueryDto {
  countryCode?: string
  year?: number
}

// Non-destructive upsert of ONE (country, year) calendar: it replaces only that
// calendar's holidays and leaves every other calendar untouched.
export interface UpdateHolidayCalendarDto {
  countryCode: string
  year: number
  name?: string | null
  holidays: HolidayEntryDto[]
}

// Copy a source (country, year) calendar into a new target year, shifting each
// holiday date by the year delta. Records provenance via sourceCalendarId.
export interface CloneHolidayCalendarDto {
  countryCode: string
  sourceYear: number
  targetYear: number
  name?: string | null
}
