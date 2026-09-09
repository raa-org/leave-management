/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  AdminEmployeeDetailDto,
  CloneHolidayCalendarDto,
  CreateLeaveRequestDto,
  DirectorySyncReportDto,
  HolidayCalendarDto,
  LeaveApprovalActionDto,
  LeaveAvailabilityQueryDto,
  LeaveBalanceDto,
  LeaveRequestDetailDto,
  LeaveSettingsDto,
  ModifyLeaveRequestDto,
  PolicyTransferMode,
  UpdateHolidayCalendarDto,
} from '@workspace/contracts'
import { AppRoleName, LeaveType } from '@workspace/contracts'
import type { LeaveApprovalDecisionEntity } from './entities/leave-approval-decision.entity'
import type { LeaveRequestEntity } from './entities/leave-request.entity'
import type { LeaveRequestActivityEntity } from './entities/leave-request-activity.entity'
import type { LeaveRequestApproverEntity } from './entities/leave-request-approver.entity'

export interface LeaveDomainUserRecord {
  userId: string
  subject?: string
  email: string
  normalizedEmail: string
  displayName: string
  countryCode?: string
  // The assigned working calendar, when it differs from the country.
  holidayCalendarCountryCode?: string
  employmentStartDate?: string
  createdAt: string
  updatedAt: string
}

// The party that performed an audited action, captured at write time. Roles are
// snapshotted because the `administrator` role is granted per-login by Keycloak
// and never persisted, so it cannot be reconstructed from the DB afterwards.
// `userId` is null for system-generated events (e.g. accrual reconciliation).
export interface AuditActor {
  userId: string | null
  label: string
  email: string | null
  roles: AppRoleName[]
}

// Admin per-employee edit. Each field is applied only when present, and the
// whole update runs in one transaction so a rejected value (e.g. an unknown
// country) never leaves another field half-written.
export interface UpdateEmployeeAdminInput {
  userId: string
  // ISO date (YYYY-MM-DD) or null to clear; omit to leave unchanged.
  employmentStartDate?: string | null
  // An existing country's code (FK to countries.code) or null to clear the
  // assigned location; omit to leave unchanged.
  countryCode?: string | null
  // ISO country code of the holiday calendar to use for leave-day counting, or
  // null to fall back to countryCode; omit to leave unchanged.
  holidayCalendarCountryCode?: string | null
  // Per-user working-day override (employee-local 'HH:mm') or null to clear
  // (fall back to the settings default); omit to leave unchanged. The timezone
  // is derived from the country, so the schedule applies in the employee's tz.
  audit?: AuditActor
}

export interface SetEmployeeActiveInput {
  userId: string
  // Target state: true reactivates, false deactivates. Applied idempotently.
  active: boolean
  audit?: AuditActor
}

export interface SetEmployeeAllocationInput {
  userId: string
  leaveType: LeaveType
  year: number
  totalDays: number
  setByUserId?: string
  note?: string
  audit?: AuditActor
}

// Admin sticky ± on the current open vacation year.
export interface AdjustEmployeeVacationBalanceInput {
  userId: string
  deltaDays: number
  note: string
  audit?: AuditActor
}

export interface AdjustEmployeeVacationBalanceResult {
  detail: AdminEmployeeDetailDto
  deltaDays: number
  note: string
  // The workday length the adjustment was checked and audited against, handed
  // back so the employee's email states the change in the same days-and-hours
  // figure the audit row froze rather than re-reading a setting that may have
  // moved in between.
  hoursPerDay: number
}

// Move an employee to another leave policy, effective on any date: future =
// scheduled (lazy, no scheduler), today = immediate, past = backdated (mode
// required: 'retroactive' recomputes the whole open period from Jan 1 of the
// current leave year / the hire date; 'prospective' keeps everything before
// the date as computed and applies the new terms from it).
export interface TransferEmployeePolicyInput {
  userId: string
  policyId: string
  // ISO date (YYYY-MM-DD). Backdates are limited to the CURRENT leave year
  // and never precede the employment start date.
  effectiveDate: string
  // Required when effectiveDate is in the past; forbidden otherwise.
  mode?: PolicyTransferMode
  note?: string
  assignedByUserId?: string
  audit?: AuditActor
}

export interface CancelScheduledPolicyTransferInput {
  userId: string
  audit?: AuditActor
}

// Create a policy. Terms are immutable after creation, so this is the only
// place they are supplied; the server canonicalizes and fingerprints them.
export interface CreateLeavePolicyInput {
  name: string
  description?: string
  vacationDays: number
  sickDays: number
  vacationAnnualIncrement?: number
  // Years between two increment steps; absent = 1 (every year).
  vacationIncrementEveryYears?: number
  vacationIncrementCapDays?: number | null
  probationMonths?: number
  paidSickDuringProbation?: boolean
  effectiveFrom: string
  effectiveTo?: string | null
  createdByUserId?: string
  audit?: AuditActor
}

// Non-term edits only (terms are immutable). `null` clears description or the
// retirement date; an absent field is left untouched.
export interface UpdatePolicyInput {
  policyId: string
  name?: string
  description?: string | null
  effectiveTo?: string | null
  audit?: AuditActor
}

// Read-only dry run of transferEmployeePolicy: same validations, zero writes.
export interface PreflightPolicyTransferInput {
  userId: string
  policyId: string
  effectiveDate: string
  mode?: PolicyTransferMode
}

// Test tooling: wipe one user's leave requests + balance cache + ledger back to
// a clean slate (the user row and their admin-set allocations are kept).
export interface ResetUserLeaveDataInput {
  userId: string
  audit?: AuditActor
}

// ---------------------------------------------------------------------------
// History import primitives. All are transaction-scoped (Tx) and reachable
// only from domain-level callers — the import service composes them inside
// ONE transaction per employee; nothing here is exposed over HTTP.

// Plain historical enrollment from the hire date (never a retroactive
// transfer — supersession is a correction mechanism, not a recording one).
// Replaces the provisioning auto-enrollment; a hand-assigned timeline is only
// replaced in override mode.
export interface AssignHistoricalMembershipInput {
  userId: string
  policyId: string
  // The hire date: the timeline must govern every imported year.
  effectiveFrom: string
  assignedByUserId: string
  mode: 'add' | 'override'
  audit: AuditActor
}

// Settle every pre-import year as externally accounted (zero entitlement,
// closed, finalized) and seed the target year's opening carryover verbatim —
// the factual number from the source tracker, policy math already applied
// by the humans who ran it.
export interface SeedCarryoverHistoryInput {
  userId: string
  targetYear: number
  carriedOverVacationDays: number
  audit: AuditActor
}

// Override-mode wipe with a year floor: everything from `fromYear` on is
// re-derivable (file rows for the target year, mechanical re-post for later
// years), earlier years are untouched history.
export interface ResetUserLeaveDataFromYearInput {
  userId: string
  fromYear: number
  audit: AuditActor
}

// A later-year request lifted out of an override wipe, to be put back
// verbatim once the target year has been rebuilt. Entity rows are carried as
// they were read: the re-post rewrites only the accounting.
export interface RepostableLeaveRequestSnapshot {
  request: LeaveRequestEntity
  approvers: LeaveRequestApproverEntity[]
  decisions: LeaveApprovalDecisionEntity[]
  activities: LeaveRequestActivityEntity[]
}

export interface LeaveBalanceRecord {
  leaveType: LeaveType
  totalDays: number
  availableDays: number
  onHoldDays: number
  spentDays: number
  accruedDays: number
  updatedAt: string
}

export interface UpsertUserInput {
  userId?: string
  email: string
  displayName: string
  subject?: string
  // Optional. The auditSource decides how "no value" is treated (see the merge
  // in upsertUserTx): for the DIRECTORY source the value is authoritative, so a
  // null (LDAP had no usable country) CLEARS the stored code; every other source
  // keeps the stored code when it offers none, so for them null and undefined
  // are equivalent. Typed `string | null` only so the directory source can pass
  // an explicit null.
  countryCode?: string | null
  // Accrual anchor set at provisioning so a mid-year joiner is prorated from
  // their first accrual. Admins can also change it later via updateEmployeeAdmin.
  employmentStartDate?: string
  createdAt?: string
  // Roles snapshotted onto the identity path's audit entries (the signing-in
  // user is their own actor). NEVER persisted by the upsert itself — user_roles
  // rows are written only by findOrCreateUserFromIdentity's role mirror (or
  // assignUserRoles). Meaningless outside auditSource 'identity'.
  roles?: AppRoleName[]
}

/**
 * One employee as the directory (LDAP) sync hands them to the domain — already
 * mapped and validated by the ldap-sync layer (the domain never sees raw LDAP
 * entries).
 */
export interface DirectoryUserInput {
  email: string
  displayName: string
  /**
   * Validated ISO 3166-1 alpha-2 code, or null when the directory value was
   * absent/unusable. Null CLEARS the stored country: LDAP is the source of
   * truth, so the DB must equal it — an absent/invalid `l` removes any stored
   * code. (This differs from the identity path, where a missing token claim
   * KEEPS the stored code, because that claim is routinely stripped in transit.)
   */
  countryCode: string | null
  /**
   * Roles mirrored literally from the lrs-* groups that admitted this person
   * into the batch: employee for the employees group, administrator for the
   * admins group, both for both. Never empty by construction — an entry in
   * neither group is not an app user and never reaches the domain — and
   * required rather than defaulted, so a caller cannot quietly hand over a
   * batch the roles were never derived for.
   */
  roleNames: AppRoleName[]
}

/**
 * Outcome of one directory sync pass. Defined in shared contracts (the manual
 * endpoint returns it verbatim); aliased here so domain code keeps its own
 * name. Feeds the run log, the manual-run report, and the audit summary.
 */
export type DirectorySyncReport = DirectorySyncReportDto

export interface FindOrCreateIdentityInput {
  subject: string
  email: string
  displayName: string
  countryCode?: string
  occurredAt?: string
  // Roles carried on the login token, snapshotted onto the login/provision audit
  // entries (the actor is the user signing in).
  roles?: AppRoleName[]
}

export interface SubmitLeaveRequestInput extends CreateLeaveRequestDto {
  requestId?: string
  requesterUserId: string
  submittedAt?: string
  audit?: AuditActor
}

// Proposed replacement for an APPROVED, not-yet-started request. The leave type
// is not part of the input: it is locked to the original's, so a type change
// means cancelling and submitting a fresh request.
export interface SubmitLeaveRequestModificationInput
  extends ModifyLeaveRequestDto {
  originalRequestId: string
  requesterUserId: string
  requestId?: string
  submittedAt?: string
  audit?: AuditActor
}

// Read-only feasibility report for one candidate period, backing the composer's
// availability panel. Reports what submit would reject with instead of throwing.
export interface PreviewLeaveAvailabilityInput extends LeaveAvailabilityQueryDto {
  userId: string
  asOfIso?: string
}

export interface DecideLeaveRequestInput extends LeaveApprovalActionDto {
  requestId: string
  actorUserId: string
  actorDisplayName: string
  // The acting approver is matched by normalized email against the kind='to'
  // rows (approver rows are email-keyed and predate user resolution).
  actorEmail: string
  decidedAt?: string
  audit?: AuditActor
}

// Admin override that bypasses the per-approver gate (e.g. a departed approver
// blocks the request). Sets the request status directly without fabricating
// per-approver decisions.
export interface ForceDecideLeaveRequestInput extends LeaveApprovalActionDto {
  requestId: string
  actorUserId: string
  actorDisplayName: string
  decidedAt?: string
  audit?: AuditActor
  // Domain-only, like decidedAt: the HTTP layer builds this input field by
  // field and never spreads the body, so a client cannot set it. The history
  // import replays years-old decisions — minting a notification-center row for
  // each would bury every mailbox in stale news, so the importer opts out.
  suppressNotifications?: boolean
}

// Admin removal of a 'to' approver from a pending request (e.g. one who left).
// Refuses to remove the last approver; re-evaluates the gate afterwards.
export interface RemoveLeaveRequestApproverInput {
  requestId: string
  email: string
  actorUserId: string
  actorDisplayName: string
  audit?: AuditActor
}

export interface CancelLeaveRequestInput {
  requestId: string
  actorUserId: string
  actorDisplayName: string
  comment?: string
  occurredAt?: string
  audit?: AuditActor
}

export interface ReconcileApprovedLeaveInput {
  // Full ISO instant ("now"); a leave day is spent once the end of the
  // employee's working day (in the employee's timezone) has passed relative to it.
  asOfIso: string
  userId?: string
}

export interface CalculateRequestedDaysInput {
  startDate: string
  endDate: string
  countryCode?: string
}

export interface AssignUserRolesInput {
  userId: string
  roleNames: AppRoleName[]
  // Stamps the user_roles.assigned audit entry. The login path passes its own
  // occurredAt so the role change and the login it came from correlate
  // chronologically; defaults to the clock when omitted.
  occurredAt?: string
}

export interface ReplaceHolidayCalendarInput extends UpdateHolidayCalendarDto {
  countryName?: string
  audit?: AuditActor
}

export interface CloneHolidayCalendarInput extends CloneHolidayCalendarDto {
  countryName?: string
  audit?: AuditActor
}

export interface DeleteHolidayCalendarInput {
  countryCode: string
  year: number
  audit?: AuditActor
}

export interface LeaveDomainSnapshot {
  users: LeaveDomainUserRecord[]
  balances: Record<string, LeaveBalanceDto[]>
  requests: LeaveRequestDetailDto[]
  settings: LeaveSettingsDto
  holidays: HolidayCalendarDto[]
}
