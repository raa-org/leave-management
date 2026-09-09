/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { AppRoleName } from './enums'

// The kind of change an audit event represents. Drives how the UI renders the
// before/after payload: `create` shows only `after`, `delete` shows only
// `before`, `update`/`state_change` show a field-level diff, `login` has neither.
export enum AuditActionKind {
  Create = 'create',
  Update = 'update',
  Delete = 'delete',
  StateChange = 'state_change',
  Login = 'login',
}

// Broad grouping used to filter the audit log in the UI. One event type maps to
// exactly one category.
export enum AuditCategory {
  Auth = 'auth',
  Role = 'role',
  Employee = 'employee',
  LeaveRequest = 'leave_request',
  Approval = 'approval',
  Settings = 'settings',
  Country = 'country',
  Holiday = 'holiday',
  Policy = 'policy',
  // Events only a directory sync pass can produce: the per-run summary, a pass
  // that ended without a usable read (it crashed, or the directory came back
  // empty), and the deactivated-but-still-listed conflict. The accounts a pass
  // creates, updates, or deactivates keep their own categories — those event
  // types are shared with the login path and with an admin acting by hand, and
  // one event type maps to exactly one category.
  LdapSync = 'ldap_sync',
  // The pre-go-live data import. Only the per-run summary lives here: what the
  // import does to an employee (profile edits, policy enrollment, replayed
  // requests) audits under the categories those acts already have, so an
  // employee's own trail reads the same whether a human or the import did it.
  Import = 'import',
}

// Every distinct audited event. The string values are stable identifiers stored
// in the database (native pg enum) and must not be renamed without a migration.
export enum AuditEventType {
  // Authentication & provisioning
  UserLogin = 'user.login',
  UserProvisioned = 'user.provisioned',
  UserProfileSynced = 'user.profile_synced',
  UserRolesAssigned = 'user.roles_assigned',
  // A deactivated account attempted to sign in and was refused.
  UserLoginRefused = 'user.login_refused',
  // Retiring an account, and the directory sync's own lifecycle.
  // Created/updated users reuse user.provisioned / user.profile_synced with the
  // "LDAP sync" system actor; the events below are what retiring an account and
  // running a pass add on top.
  //
  // Written by the sync when a person leaves the directory, and by an admin
  // retiring an account by hand — the actor tells the two apart.
  UserDeactivated = 'user.deactivated',
  // The admin-side manual reactivation, and the only reactivation path there
  // is: a pass never brings an account back by itself.
  UserReactivated = 'user.reactivated',
  // A deactivated user is still present in the directory: the sync changes
  // nothing and flags the disagreement for manual resolution.
  UserSyncConflict = 'user.sync_conflict',
  // A login's stable subject and its email resolve to DIFFERENT user rows —
  // one identity claiming two records (only reachable via manual DB tampering
  // now that mail is single-valued). The sign-in is refused and nothing is
  // written; the row split needs manual resolution.
  UserIdentityConflict = 'user.identity_conflict',
  // One summary entry per sync run, carrying the counters.
  LdapSyncCompleted = 'ldap_sync.completed',
  // A pass that ended without a usable read: it crashed (LDAP unreachable,
  // database error), or the directory came back empty, which is modelled as a
  // failure so a broken filter cannot read as a healthy pass. Written OUTSIDE
  // the sync's transaction — that transaction is rolled back, so an entry
  // inside it would vanish and leave "failed" indistinguishable from "never
  // ran" in the audit UI.
  LdapSyncFailed = 'ldap_sync.failed',
  // Employee profile (admin-managed)
  EmployeeProfileUpdated = 'employee.profile_updated',
  EmployeeAllocationUpdated = 'employee.allocation_updated',
  // Admin manual ± on the current open vacation year (sticky offset + ledger).
  EmployeeBalanceAdjusted = 'employee.balance_adjusted',
  // Test tooling: wipe one employee's requests + balances back to a clean slate
  EmployeeLeaveDataReset = 'employee.leave_data_reset',
  // Leave request lifecycle
  LeaveRequestSubmitted = 'leave_request.submitted',
  LeaveRequestCancelled = 'leave_request.cancelled',
  LeaveRequestApproved = 'leave_request.approved',
  LeaveRequestRejected = 'leave_request.rejected',
  LeaveRequestForceApproved = 'leave_request.force_approved',
  LeaveRequestForceRejected = 'leave_request.force_rejected',
  // System approval at submission time, when the org made approval optional
  // and the request ended up addressed to no deciding approver.
  LeaveRequestAutoApproved = 'leave_request.auto_approved',
  LeaveRequestApproverRemoved = 'leave_request.approver_removed',
  // A modification of an approved request was submitted (creates the linked
  // replacement) and, once every approver signed off, replaced the original.
  LeaveRequestModificationSubmitted = 'leave_request.modification_submitted',
  LeaveRequestSuperseded = 'leave_request.superseded',
  // Leave policy groups (engine). ALL RESERVED (no writer yet): the writers
  // land with the domain engine and its admin endpoints; the pg enum is
  // extended ahead of time because adding values later is a heavyweight
  // migration.
  PolicyCreated = 'policy.created',
  PolicyUpdated = 'policy.updated',
  PolicySuperseded = 'policy.superseded',
  // Hard delete of a never-referenced policy; retiring a used one goes
  // through effectiveTo and audits as policy.updated.
  PolicyDeleted = 'policy.deleted',
  PolicyDefaultChanged = 'policy.default_changed',
  // Auto-enrollment into the default group at provisioning.
  PolicyMembershipAssigned = 'policy.membership_assigned',
  PolicyMembershipTransferred = 'policy.membership_transferred',
  PolicyMembershipTransferScheduled = 'policy.membership_transfer_scheduled',
  PolicyMembershipTransferScheduleCanceled = 'policy.membership_transfer_schedule_canceled',
  // A transfer refused because committed (held + spent) days exceed the target
  // the transfer would set.
  PolicyMembershipTransferBlocked = 'policy.membership_transfer_blocked',
  // A backdated transfer, either mode; the payload carries mode, the nominal
  // date, the applied anchor, superseded row ids and the per-year adjustments.
  PolicyMembershipBackdated = 'policy.membership_backdated',
  // The engine wrote/updated an allocation row from a policy (year birth,
  // transfer sweep, hire-date change re-resolution).
  PolicyAllocationMaterialized = 'policy.allocation_materialized',
  // One summary entry per import run: the function, target year, mode, the
  // counters, and the list of employees the run touched.
  ImportCompleted = 'import.completed',
  // Settings, countries, holiday calendars (admin)
  SettingsUpdated = 'settings.updated',
  CountryCreated = 'country.created',
  CountryUpdated = 'country.updated',
  CountryDeleted = 'country.deleted',
  HolidayCalendarReplaced = 'holiday_calendar.replaced',
  HolidayCalendarCloned = 'holiday_calendar.cloned',
  HolidayCalendarDeleted = 'holiday_calendar.deleted',
}

// A JSON snapshot of the audited object (only the domain-meaningful fields, not
// internal columns). `null` when the state does not exist (before a create /
// after a delete).
export type AuditStateSnapshot = Record<string, unknown>

// One changed field for the compact diff view. `before`/`after` hold the raw
// values (primitive, array, or nested object) so the UI can render old -> new.
export interface AuditFieldChangeDto {
  field: string
  before: unknown
  after: unknown
}

export interface AdminAuditLogItemDto {
  auditId: string
  occurredAt: string
  eventType: AuditEventType
  category: AuditCategory
  action: AuditActionKind
  // Actor is null for system-generated events (e.g. accrual reconciliation);
  // `actorLabel` then carries a literal such as 'System'.
  actorUserId?: string
  actorLabel: string
  actorEmail?: string
  // Roles the actor held at the moment of the action, snapshotted because the
  // `administrator` role is granted per-login by Keycloak; user_roles only
  // mirrors it as of the user's latest login.
  actorRoles: AppRoleName[]
  // The user the event is about (subject). May equal the actor (self-service)
  // or differ (admin acting on an employee). Absent for system-wide events.
  targetUserId?: string
  targetLabel?: string
  entityType: string
  entityId?: string
  summary: string
  // Full snapshots before/after the change. `before` is null for creations and
  // logins; `after` is null for deletions and logins.
  before?: AuditStateSnapshot | null
  after?: AuditStateSnapshot | null
  // Pre-computed field-level diff for update/state-change events.
  changedFields?: AuditFieldChangeDto[]
  // Optional deep-link to a leave request when the event concerns one.
  requestId?: string
}

export interface AdminAuditLogPageDto {
  items: AdminAuditLogItemDto[]
  nextCursor?: string
}

export interface AdminAuditLogQueryDto {
  cursor?: string
  limit?: number
  // Matches events where the user is EITHER the actor OR the target. Powers the
  // per-employee audit view opened from the employee directory.
  userId?: string
  category?: AuditCategory
  eventType?: AuditEventType
  // Inclusive ISO date-time bounds on occurredAt.
  from?: string
  to?: string
}
