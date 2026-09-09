/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import {
  DataSource,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type EntityManager,
  type EntityTarget,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm'
import type {
  AdminActivityFeedDto,
  AdminActivityFeedItemDto,
  AdminActivityQueryDto,
  AdminEmployeeDetailDto,
  AdminEmployeeFilterOptionsDto,
  AdminEmployeeListDto,
  AdminEmployeeOptionDto,
  AdminEmployeeListItemDto,
  AdminEmployeeProjectDto,
  AdminEmployeesQueryDto,
  AdminEmployeeTotalsDto,
  CountryDto,
  DefaultRecipientDto,
  EmployeeDashboardDto,
  HolidayCalendarDto,
  HolidayEntryDto,
  LeaveAvailabilityBlockerDto,
  LeaveAvailabilityOverlappingRequestDto,
  LeaveAvailabilityPreviewDto,
  LeaveBalanceChangeDto,
  LeaveBalanceDto,
  LeaveMonthOutlookDto,
  LeaveYearProjectionDto,
  LeaveRequestActivityDto,
  LeaveRequestApprovalRecipientDto,
  LeaveRequestDetailDto,
  LeaveRequestFormContextDto,
  LeaveRequestHistoryDto,
  LeaveRequestSummaryDto,
  AuditStateSnapshot,
  EmployeePolicyDto,
  LeavePolicyDto,
  LeaveSettingsDto,
  ListHolidaysQueryDto,
  ListMyLeaveRequestsQueryDto,
  PolicyMembershipDto,
  PolicyTransferAdjustmentDto,
  PolicyTransferPreflightDto,
  PolicyTransferRequestRefDto,
  UpdateLeaveSettingsDto,
} from '@workspace/contracts'
import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  AuditEventType,
  CarryoverCapMode,
  CarryoverPolicy,
  EmployeeProfileFilter,
  EmployeeProfileStatus,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
  NotificationType,
  emptyDirectorySyncReport,
  isValidEmail,
  isWeekendIso,
  normalizeCountryCode,
  normalizeEmail,
} from '@workspace/contracts'
import type {
  AssignUserRolesInput,
  AuditActor,
  CalculateRequestedDaysInput,
  CancelLeaveRequestInput,
  CloneHolidayCalendarInput,
  DecideLeaveRequestInput,
  DeleteHolidayCalendarInput,
  DirectorySyncReport,
  DirectoryUserInput,
  FindOrCreateIdentityInput,
  ForceDecideLeaveRequestInput,
  LeaveDomainSnapshot,
  LeaveDomainUserRecord,
  PreviewLeaveAvailabilityInput,
  ReconcileApprovedLeaveInput,
  RemoveLeaveRequestApproverInput,
  ReplaceHolidayCalendarInput,
  CancelScheduledPolicyTransferInput,
  CreateLeavePolicyInput,
  PreflightPolicyTransferInput,
  UpdatePolicyInput,
  ResetUserLeaveDataInput,
  AssignHistoricalMembershipInput,
  SeedCarryoverHistoryInput,
  ResetUserLeaveDataFromYearInput,
  RepostableLeaveRequestSnapshot,
  SetEmployeeActiveInput,
  SetEmployeeAllocationInput,
  AdjustEmployeeVacationBalanceInput,
  AdjustEmployeeVacationBalanceResult,
  TransferEmployeePolicyInput,
  UpdateEmployeeAdminInput,
  SubmitLeaveRequestInput,
  SubmitLeaveRequestModificationInput,
  UpsertUserInput,
} from './leave-domain.types'
import { AuditLogService, LDAP_SYNC_ACTOR, SYSTEM_ACTOR } from './audit-log.service'
import { ClockService } from './clock.service'
import {
  NotificationService,
  type RecordNotificationInput,
} from './notification.service'
import {
  DEFAULT_TIMEZONE,
  catalogTimezonesFor,
  isKnownTimezone,
  lookupCountry,
} from './country-catalog'
import {
  DEFAULT_HOURS_PER_DAY,
  dayOfMonthIsoDate,
  dayPortionToHours,
  daysInMonth,
  effectiveHireMonth,
  floorToHourGrid,
  formatDayAmount,
  hoursToDayPortion,
  isLeapYear,
  isOnHourGrid,
  monthOfIsoDate,
  portionAt,
  portionMap,
  roundDays,
  sumPortions,
} from './day-math'
import { endOfDayUtc, localDayIso } from './workday'
import {
  policyTermsFingerprint,
  roundPolicyTerm,
  type LeavePolicyTerms,
} from './policy-fingerprint'
import {
  firstFreePolicyName,
  policyCatalogEntry,
  resolvePolicy,
} from './policy-resolution'
import {
  carryoverCapBaseDays,
  deriveYearSchedule,
  legacyScheduleFromTotal,
  pieceTargetDays,
  scheduleYearEndTotal,
  type MembershipRowInput,
  type PolicyTermsInput,
  type PolicyYearSchedule,
} from './policy-schedule'
import {
  UUID_PATTERN,
  clampLimit,
  decodeKeysetCursor,
  keysetWhere,
  keysetWhereAsc,
  takeKeysetPage,
} from './keyset-cursor'
import { CountryEntity } from './entities/country.entity'
import { HolidayEntity } from './entities/holiday.entity'
import { AuditLogEntity } from './entities/audit-log.entity'
import { HolidayCalendarEntity } from './entities/holiday-calendar.entity'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { LeaveApprovalDecisionEntity } from './entities/leave-approval-decision.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeaveBalanceChangeEntity } from './entities/leave-balance-change.entity'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from './entities/leave-policy-membership.entity'
import { LeaveRequestEntity } from './entities/leave-request.entity'
import { LeaveRequestActivityEntity } from './entities/leave-request-activity.entity'
import { LeaveRequestApproverEntity } from './entities/leave-request-approver.entity'
import {
  LeaveSettingsEntity,
  SETTINGS_SINGLETON_ID,
} from './entities/leave-settings.entity'
import { ProjectEntity } from './entities/project.entity'
import { UserEntity } from './entities/user.entity'
import { UserProjectMembershipEntity } from './entities/user-project-membership.entity'
import { UserRoleEntity } from './entities/user-role.entity'
// Outbound-mail table, owned by the notifications module. The directory reset
// is the one domain operation that has to clear it: nothing else can, since it
// carries no user FK for a cascade to follow.
import { NotificationDeliveryEntity } from '../notifications/notification-delivery.entity'

/**
 * Thrown when a lookup targets an entity that does not exist. Controllers map
 * this to HTTP 404 instead of a generic 500.
 */
export class LeaveDomainNotFoundError extends Error {}

/**
 * Thrown when an operation is semantically invalid (bad dates, overlap,
 * unknown leave type, insufficient balance). Controllers map this to HTTP 400.
 */
export class LeaveDomainValidationError extends Error {}

/**
 * A policy transfer whose effective date reaches before the earliest period
 * the engine may rewrite (the employment start date, or Jan 1 of the current
 * leave year — earlier years are settled or settling). Carries the earliest
 * date the transfer WOULD be accepted for, so the UI can offer an informed
 * one-click re-submit instead of a dead end.
 */
export class PolicyTransferClosedPeriodError extends LeaveDomainValidationError {
  constructor(
    message: string,
    readonly earliestPermissibleDate: string,
  ) {
    super(message)
  }
}

/**
 * A policy whose terms already exist on a live policy. Carries the twin so
 * the create dialog can offer "use the existing group instead" rather than a
 * dead end. Controllers map this to 409.
 */
export class DuplicatePolicyTermsError extends LeaveDomainValidationError {
  constructor(
    message: string,
    readonly existingPolicyId: string,
    readonly existingPolicyName: string,
  ) {
    super(message)
  }
}

/**
 * A policy that cannot be hard-deleted because membership history references
 * it. Retiring it (effectiveTo, once members are transferred out) is the
 * supported path. Controllers map this to 409.
 */
export class PolicyInUseError extends LeaveDomainValidationError {}

/**
 * A country timezone the country does not have. Refused rather than quietly
 * replaced with the catalog's primary zone: this value decides when a leave day
 * is recognised as spent and when accrual lands (`resolveTimezoneTx`), and a
 * silent substitution is the exact failure this refusal exists to end -- the UI
 * saying one zone while the database kept another. Carries the assignable zones
 * so a client can offer them. Controllers map this to 400.
 */
export class CountryTimezoneNotAvailableError extends LeaveDomainValidationError {
  constructor(
    message: string,
    readonly countryCode: string,
    readonly allowedTimezones: string[],
  ) {
    super(message)
  }
}

/**
 * A country that cannot be removed because rows still point at it.
 *
 * The users case is the dangerous one, and it is dangerous precisely because
 * the database does NOT stop it: `users.countryCode` is ON DELETE SET NULL, so
 * removing the country succeeds and quietly blanks the country of everyone in
 * it. That drops each of them into PendingSetup, which refuses every leave
 * request they try to submit -- an outage for real people, produced by a save
 * that reported success. The calendars case is the opposite: that foreign key
 * is RESTRICT, so the delete would abort the whole settings save; it used to be
 * skipped in silence, which read to the admin as the row refusing to go away
 * for no reason.
 *
 * Both counts ride along so a client can say which rows are in the way, and how
 * many. Controllers map this to 409: the payload is well formed, the state
 * forbids it.
 */
export class CountryInUseError extends LeaveDomainValidationError {
  constructor(
    message: string,
    readonly countryCode: string,
    readonly assignedUsers: number,
    readonly holidayCalendars: number,
  ) {
    super(message)
  }
}

/**
 * An org-wide default timezone the runtime cannot resolve. Refused rather than
 * stored, because nothing downstream would ever report it: `localDayIso` and
 * `endOfDayUtc` both swallow an unusable zone and fall back to
 * DEFAULT_TIMEZONE, so the setting would read back exactly as saved while every
 * employee whose country has no zone of its own kept spending leave on Kyiv's
 * midnight. Carries the refused value so a client can name it. Controllers map
 * this to 400.
 */
export class DefaultTimezoneNotRecognizedError extends LeaveDomainValidationError {
  constructor(
    message: string,
    readonly timezone: string,
  ) {
    super(message)
  }
}

/**
 * A policy transfer refused because the employee has more committed (held +
 * spent) days than the new terms allow. Distinct from ordinary validation so
 * the controller can audit the refusal before mapping it to 400.
 */
export class PolicyTransferBlockedError extends LeaveDomainValidationError {}

/**
 * Base for directory-wide operations that lost to a concurrent writer. Not a
 * validation error: the request was well-formed and retrying later works, so
 * callers map the whole family to 409.
 */
export class DirectoryConflictError extends Error {}

/**
 * Thrown when a directory-wide operation cannot start because another one holds
 * the sync advisory lock.
 */
export class DirectorySyncInProgressError extends DirectoryConflictError {}

/**
 * Thrown when a directory reset is outrun by a writer the advisory lock does
 * not cover — a submission, an accrual pass, an SSO login — leaving a row
 * whose foreign key blocks the users delete. The transaction rolls back whole,
 * so a retry against the settled population succeeds.
 */
export class DirectoryResetRacedError extends DirectoryConflictError {}

/**
 * Thrown ONLY when a deactivated account attempts to sign in. A dedicated
 * subclass so the auth boundary can map exactly this refusal to a 403 —
 * catching the generic validation error there would also dress up internal
 * data problems (any of the login transaction's balance/accrual guards) as
 * "forbidden" and hide them from 500-based alerting.
 */
export class AccountDeactivatedError extends LeaveDomainValidationError {}

/**
 * Thrown when a sign-in presents no app role at all. Keycloak authenticates
 * the whole staff directory, but application access is granted by the
 * leaverequest-app groups — a token carrying neither the employee nor the
 * admin role belongs to a directory account that is not an app user (guest,
 * test, technical). A dedicated subclass so the auth boundary maps exactly
 * this refusal to a 403 with its own wording, for the same alerting reason
 * as AccountDeactivatedError above.
 */
export class NoApplicationAccessError extends LeaveDomainValidationError {}

/**
 * Thrown when a login's stable subject and its email resolve to DIFFERENT user
 * rows (one identity claiming two records), or when a users unique index
 * (email/subject) rejects the login's write. A dedicated subclass so the auth
 * boundary can map it to a 409 Conflict instead of an opaque 500: it is a data
 * anomaly needing manual resolution, not a transient server fault to page on.
 */
export class LoginIdentityConflictError extends LeaveDomainValidationError {}

/**
 * Application-wide identity of the directory sync's PostgreSQL advisory lock.
 * Arbitrary but stable: every replica computes the same key, so whoever takes
 * it first runs the pass and everyone else skips. Transaction-scoped
 * (pg_try_advisory_xact_lock) and acquired as the FIRST statement of the sync
 * transaction itself: one connection for lock and work, never idle-in-
 * transaction, released by COMMIT/ROLLBACK (or session death) — no unlock
 * call whose failure could leak it.
 *
 * Two takers, both in this file: syncUsersFromDirectory (the pass itself) and
 * resetDirectory (the test-tooling wipe, which must never interleave with a
 * pass). Deliberately NOT exported — the first-statement discipline only holds
 * while every taker lives here, so changing the key or the acquisition point
 * means revisiting both.
 */
const DIRECTORY_SYNC_ADVISORY_LOCK_KEY = 774_201_001

const DEFAULT_VACATION_DAYS = 25
const DEFAULT_SICK_DAYS = 5
// The company policy: half the leftover carries, the rest expires. A fresh
// install is correct before an admin opens the settings page.
const DEFAULT_CARRYOVER_POLICY = CarryoverPolicy.Capped
const DEFAULT_CARRYOVER_CAP_MODE = CarryoverCapMode.Percent
const DEFAULT_CARRYOVER_CAP_PERCENT = 50
// Day-cap default comes from env; admins can override it in settings. A
// malformed value must not become NaN here: it would flow through the cap
// comparison and poison every carryover it touches.
const ENV_CARRYOVER_CAP_DAYS = Number(
  process.env['LEAVE_CARRYOVER_CAP_DAYS'] ?? 0,
)
const DEFAULT_CARRYOVER_CAP_DAYS = Number.isFinite(ENV_CARRYOVER_CAP_DAYS)
  ? Math.max(0, ENV_CARRYOVER_CAP_DAYS)
  : 0
const ALL_LEAVE_TYPES: LeaveType[] = [LeaveType.Vacation, LeaveType.Sick]
// Stamped on the allocation rows the history import owns, so a re-run can tell
// its own settled years from anything the engine or an admin wrote.
const IMPORT_SETTLED_YEAR_NOTE =
  'History import: pre-import year, settled in the source tracker'
const IMPORT_SEEDED_YEAR_NOTE = 'History import: opening carryover seeded'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
// Day figures are quantized to three decimals (roundDays): compare them with a
// tolerance so 16.667 accrued covers a 16.667-day commitment.
const BALANCE_EPSILON = 1e-9
// How far ahead leave may be planned: this year and the next. Beyond that the
// allocation is guesswork (an admin has not set it, and the prior year's
// carryover cannot be known), so the projection would be fiction.
const PLANNING_HORIZON_YEARS = 1
// Safety stop for the carryover finalization walk; a real backlog is a handful
// of years at most, so a longer chain means data we should not silently trust.
const MAX_CARRYOVER_FINALIZATION_YEARS = 10
// Decision comment stamped on a request the system approved because approval
// is optional and nobody was addressed to decide it.
const AUTO_APPROVED_COMMENT = 'Processed automatically'
// Imported leave that names no approver was agreed outside the system, often
// years ago and often in person. Recording it as the importing administrator's
// decision would be a fiction; the system records that it happened and says
// where the fact came from.
const HISTORY_APPROVED_COMMENT =
  'Agreed before the system was in use (recorded by the data import)'

/**
 * The two faces of "now" for one employee: the instant to stamp records with,
 * and the calendar day that instant falls on in THAT employee's timezone.
 *
 * Calendar decisions — which month has accrued, which leave year is current,
 * whether employment has begun — read `day`. Anything written to a timestamp
 * column reads `iso`. The two travel together so they cannot drift apart on the
 * way down a call chain, which is exactly how accrual came to run on UTC months
 * while spend recognition already ran on the employee's own clock.
 */
interface AsOf {
  iso: string
  day: string
}

// An as-of whose day is read straight off the instant, i.e. in UTC. Only for
// paths that materialize a row for a leave year they were already handed rather
// than deciding which year is current — never where the calendar decision is
// the point. Everything on the accrual path goes through resolveAsOfTx instead.
function asOfInstant(iso: string): AsOf {
  return { iso, day: iso.slice(0, 10) }
}

/**
 * Why a country cannot be removed, worded for an administrator rather than for
 * a log: what is still pointing at it, how much of it, and what to do about it.
 * Both blockers can apply at once, and naming only the first would send the
 * admin round the loop twice.
 */
function countryInUseMessage(
  countryName: string,
  assignedUsers: number,
  holidayCalendars: number,
): string {
  const blockers: string[] = []
  if (assignedUsers > 0) {
    blockers.push(
      assignedUsers === 1
        ? '1 employee is assigned to it'
        : `${assignedUsers} employees are assigned to it`,
    )
  }
  if (holidayCalendars > 0) {
    blockers.push(
      holidayCalendars === 1
        ? 'it still has a holiday calendar'
        : `it still has ${holidayCalendars} holiday calendars`,
    )
  }
  const ways: string[] = []
  if (assignedUsers > 0) {
    ways.push('move those employees to another country')
  }
  if (holidayCalendars > 0) {
    ways.push('delete the calendars')
  }
  return `${countryName} cannot be removed: ${blockers.join(', and ')}. To remove it, ${ways.join(' and ')} first.`
}

interface LeaveSettingsState {
  defaultVacationDays: number
  defaultSickDays: number
  approvalRequired: boolean
  defaultApproverEmails: string[]
  defaultCcApproverEmails: string[]
  carryoverPolicy: CarryoverPolicy
  carryoverCapDays: number
  carryoverCapMode: CarryoverCapMode
  carryoverCapPercent: number
  defaultTimezone: string
  // The divisor that turns a booking in hours into a fraction of a day.
  hoursPerDay: number
  updatedAt: string
}

// One committed leave date and what it costs: the portion of a day the
// employee is away for on it. Deliberately NOT the same thing as a request's
// own frozen portion, because a merged worst case (pointwiseMaxSchedule) emits
// synthetic entries whose portion is a cumulative difference, so a schedule
// entry may exceed a whole day and may sit off the hour grid. Only a request's
// portions are grid figures; nothing here may be validated as one.
interface CommittedDay {
  day: string
  portion: number
}

// One leave year as the projection sees it: the inputs, the days committed to
// it, and the accrual curve those days are measured against.
interface YearProjection {
  year: number
  totalDays: number
  // True when the policy engine blended this year across a membership boundary
  // — the annual totalDays then matches no single policy's advertised terms.
  policyChangedDuringYear: boolean
  carriedOverDays: number
  // True when carriedOverDays is a forecast of what this year will leave
  // behind rather than a settled figure (the year has not begun).
  carryoverProjected: boolean
  accruedDays: number
  spentDays: number
  // The dates committed to this year, each with what it costs. A list of
  // entries rather than of dates because the year is charged the SUM of their
  // portions, which stopped being their count the moment leave could be booked
  // by the hour.
  committedEntries: CommittedDay[]
  projectedAt: (dayIso: string) => number
  projectedYearEndAccrual: number
  // What this year is projected to hand to the next one under the configured
  // policy, the candidate's paid days already charged against it. One
  // expression, two readers: the report's scalar (the current year's, which the
  // fold feeds forward) and the per-year figure the preview publishes. Absent
  // for a year already closed, whose real carryover is settled in the books and
  // must not be re-derived from a forecast.
  carryoverOutDays?: number
}

// How a candidate request would be funded: which of its days the balance
// covers and which it does not. Frozen onto the request at submit, reported
// as-is by the preview. Both figures are AMOUNTS, the dates priced by their
// portions, never counts of dates: unpaidDates says which days, paidDays and
// unpaidDays say how much.
interface CandidateSplit {
  paidDays: number
  unpaidDays: number
  // The unpaid days themselves, in date order. Not necessarily a trailing run.
  unpaidDates: string[]
}

interface FeasibilityReport {
  violation: (CommitmentViolation & { year: number }) | null
  projections: Map<number, YearProjection>
  // What the current year is projected to hand to the next one under the
  // configured carryover policy.
  projectedCarriedOverDays: number
  // Present exactly when a candidate was passed. With one, `violation` is
  // always null: whatever the balance could not cover became unpaid instead.
  candidateSplit?: CandidateSplit
}

interface RecordBalanceChangeInput {
  userId: string
  leaveType: LeaveType
  year: number
  reason: LeaveBalanceChangeReason
  effectiveDate: string
  occurredAt: string
  deltaDays: number
  onHoldDelta: number
  spentDelta: number
  accruedDelta: number
  note?: string
}

/**
 * Persistence-backed leave domain. The business rules (lazy accrual, reconcile
 * by frozen leave days, overlap, cancel) are preserved from the previous
 * in-memory version; only the storage was swapped for TypeORM repositories.
 * Compound writes run inside a single transaction; every private helper takes
 * the active EntityManager so the caller controls the transaction boundary.
 *
 * Two deliberate differences from the in-memory version:
 *  - LeaveRequestDetailDto.balanceTimeline is derived from the ledger at read
 *    time (query by user+leaveType) rather than a per-request frozen snapshot.
 *  - Concurrency: per-user balance mutations are NOT yet serialized with row
 *    locks. Under the in-memory Map, Node's single thread made read-modify-write
 *    atomic; with Postgres, two concurrent transactions for the same user could
 *    double-accrue or oversubscribe. Acceptable for this low-concurrency
 *    internal tool; add pessimistic_write locks (or SERIALIZABLE + retry) on the
 *    LeaveBalance rows before productionizing higher concurrency.
 */
@Injectable()
export class LeaveDomainService {
  private readonly logger = new Logger(LeaveDomainService.name)

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // Explicit @Inject: under the test transform (no emitted decorator metadata)
    // Nest resolves only params that carry an injection token, matching the rest
    // of this codebase.
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(NotificationService)
    private readonly notifications: NotificationService,
  ) {}

  private get manager(): EntityManager {
    return this.dataSource.manager
  }

  // ---------------------------------------------------------------- users ----

  async upsertUser(input: UpsertUserInput): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction(
      async (manager) => (await this.upsertUserTx(manager, input)).record,
    )
  }

  /**
   * Single writer for `users` rows. Who gets audited, and as whom, follows the
   * EXPLICIT audit source: 'identity' (the login path) audits with the
   * signing-in user as their own actor; 'directory' (the LDAP sync) audits
   * with LDAP_SYNC_ACTOR and directory-flavored wording; no source (admin/
   * test tooling) audits nothing here. The source is never inferred from the
   * input's shape — see the `roles` doc on UpsertUserInput.
   *
   * A new row is INSERTed whole; an existing row gets a targeted UPDATE of ONLY
   * this source's owned columns, so it can never clobber a column another
   * writer owns — no lock needed. Change detection lives HERE and only here:
   * when no owned column differs, the write is skipped entirely (no updatedAt
   * bump, no audit). `created`/`changed` report what actually happened so
   * callers (the sync's run report) need no re-diff or refetch of their own.
   */
  private async upsertUserTx(
    manager: EntityManager,
    input: UpsertUserInput,
    auditSource?: 'identity' | 'directory',
    // The identity/directory callers already looked the row up (for their own
    // conflict/match logic), so they pass it here — entity or null for a
    // known-new user — and this method skips the re-read. Omitted by the
    // standalone upsertUser, which resolves the row itself.
    preloadedExisting?: UserEntity | null,
  ): Promise<{
    record: LeaveDomainUserRecord
    created: boolean
    changed: boolean
  }> {
    const repo = manager.getRepository(UserEntity)
    const occurredAt = input.createdAt ?? this.clock.nowIso()
    const normalizedEmail = normalizeEmail(input.email)

    // UNLOCKED read. Every write below is a targeted repo.update that
    // names ONLY the columns this source owns, so a stale snapshot can no
    // longer clobber a column another writer owns: the clobbered column is
    // simply never in the generated SQL. The pessimistic_write lock this read
    // used to hold (guarding a full-row save from reverting a concurrent
    // writer's committed columns) is therefore gone. Create/create races stay
    // self-healing — the unique index rejects the loser. The entity found here
    // is reused as-is (no second fetch by id): an explicit userId that finds no
    // row is a new user with that id and must NOT fall through to subject/email.
    let existing: UserEntity | null
    if (preloadedExisting !== undefined) {
      existing = preloadedExisting
    } else if (input.userId) {
      existing = await repo.findOneBy({ id: input.userId })
    } else if (input.subject) {
      existing =
        (await repo.findOneBy({ subject: input.subject })) ??
        (await repo.findOneBy({ normalizedEmail }))
    } else {
      existing = await repo.findOneBy({ normalizedEmail })
    }

    // Country merge, source-aware. The DIRECTORY sync mirrors LDAP: the mapped
    // value is authoritative, so a null (attribute absent/invalid) CLEARS the
    // stored code rather than keeping it — the DB must equal LDAP. Every other
    // source (identity login, programmatic admin/test upsert) KEEPS the stored
    // code when it provides none: the OIDC country claim is routinely stripped
    // before it reaches us, so a login must never wipe what the sync set.
    // ensureCountry (below, on the write path only) upholds the
    // users.countryCode -> countries.code FK for any code that reaches a save.
    const countryCode =
      auditSource === 'directory'
        ? (input.countryCode ?? null)
        : (input.countryCode ?? existing?.countryCode ?? null)

    // A brand-new row: INSERT the whole row. There is no existing row to
    // clobber, so a full-row write is safe, and the provisioning side effects
    // (baseline roles, balances, provision audit with the FULL snapshot) are
    // unchanged from before the ownership refactor.
    if (!existing) {
      const user = repo.create({
        id: input.userId ?? randomUUID(),
        subject: input.subject ?? null,
        email: input.email,
        normalizedEmail,
        displayName: input.displayName,
        countryCode,
        employmentStartDate: input.employmentStartDate ?? null,
        active: true,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      if (countryCode) {
        await this.ensureCountry(manager, countryCode)
      }
      await repo.save(user)

      // Only tooling provisioning (admin/test upsertUser) seeds the baseline
      // here. The identity/login path skips it: findOrCreateUserFromIdentity
      // is the single owner of the token mirror and runs its sync right after
      // this upsert. The directory path skips it too: the sync assigns each
      // record's explicit group-derived roles right after the upsert, and a
      // baseline seeded here would be a second writer the mirror immediately
      // rewrites. Either way a new user's roles are written (and audited,
      // when elevated) exactly once.
      if (auditSource !== 'identity' && auditSource !== 'directory') {
        await this.assignUserRolesTx(manager, {
          userId: user.id,
          roleNames: [...BASELINE_ROLES],
          occurredAt,
        })
      }
      // Enroll into the default policy BEFORE the first balance
      // initialization: ensureAllocation reads the membership timeline to
      // seed totalDays, so the row must exist first. No default policy yet
      // (pre-bootstrap) is a silent no-op — the legacy settings path covers
      // it. One hook covers all three provisioning sources.
      const defaultPolicy = await manager
        .getRepository(LeavePolicyEntity)
        .findOneBy({ isDefault: true })
      const enrolledMembershipId = defaultPolicy ? randomUUID() : null
      if (defaultPolicy && enrolledMembershipId) {
        await manager.getRepository(LeavePolicyMembershipEntity).save({
          id: enrolledMembershipId,
          userId: user.id,
          policyId: defaultPolicy.id,
          effectiveFrom: occurredAt.slice(0, 10),
          effectiveTo: null,
          supersededByRowId: null,
          assignedByUserId: null,
          note: 'Auto-enrolled at provisioning',
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
      }
      await this.initializeBalancesTx(manager, user.id, occurredAt)

      // Who gets audited, and as whom, follows the EXPLICIT source — never
      // inferred from input shape (a stray `roles` on a programmatic upsert
      // must not fabricate a self-login audit trail).
      const actor: AuditActor | null =
        auditSource === 'identity'
          ? {
              userId: user.id,
              label: user.displayName,
              email: user.email,
              roles: input.roles ?? [],
            }
          : auditSource === 'directory'
            ? LDAP_SYNC_ACTOR
            : null
      if (actor) {
        await this.auditLog.record(manager, {
          actor,
          eventType: AuditEventType.UserProvisioned,
          occurredAt,
          target: { userId: user.id, label: user.displayName },
          entityType: 'user',
          entityId: user.id,
          // The summary is the one human-readable place the ORIGIN of the
          // account is recorded — keep the two sources distinguishable.
          summary:
            auditSource === 'directory'
              ? `Provisioned ${user.displayName} from the directory`
              : `Provisioned account for ${user.displayName}`,
          after: snapshotUser(user),
        })
      }
      if (defaultPolicy && enrolledMembershipId) {
        await this.auditLog.record(manager, {
          actor: actor ?? SYSTEM_ACTOR,
          eventType: AuditEventType.PolicyMembershipAssigned,
          occurredAt,
          target: { userId: user.id, label: user.displayName },
          entityType: 'leave_policy_membership',
          entityId: enrolledMembershipId,
          summary: `Enrolled ${user.displayName} into the default policy "${defaultPolicy.name}"`,
          after: {
            policyId: defaultPolicy.id,
            policyName: defaultPolicy.name,
            effectiveFrom: occurredAt.slice(0, 10),
          },
        })
      }

      return { record: userToRecord(user), created: true, changed: true }
    }

    // An existing row: write ONLY the columns this source is the authority for,
    // and only the ones that actually changed. `active` is
    // owned by the deactivation / admin-edit paths and never appear here;
    // `employmentStartDate` is owned only by the programmatic upsert (no audit
    // source — admin/test tooling) and stays out of the identity and directory
    // patches entirely. This is what makes lock discipline unnecessary: a
    // concurrent writer of a column we do not own cannot be reverted, because
    // that column is never named in our UPDATE.
    const ownedColumns: OwnedUserColumn[] =
      auditSource === 'directory'
        ? ['email', 'displayName', 'countryCode']
        : auditSource === 'identity'
          ? ['subject', 'email', 'displayName', 'countryCode']
          : ['subject', 'email', 'displayName', 'countryCode', 'employmentStartDate']

    // Keep the stored spelling when the incoming address is the SAME normalized
    // address (casing-only difference — the IdP and the directory routinely
    // disagree on case); flipping it every time would ping-pong the column, the
    // audit trail, and the approver/notification join key. One address per
    // person means there are no aliases to reconcile — normalized
    // equality is the whole rule. Decided on the UNLOCKED read: a race
    // can flip the spelling at most once, acceptable last-writer-wins on a
    // shared column.
    const keepStoredEmail = normalizedEmail === existing.normalizedEmail

    // Target values for every owned column (same merge rules as before), keyed
    // so the patch and the audit snapshot draw from one source of truth. Per-
    // field types are inferred (email/displayName stay non-null strings) so the
    // patch assignments below type-check against the entity's column types.
    const desired = {
      subject: input.subject ?? existing.subject ?? null,
      email: keepStoredEmail ? existing.email : input.email,
      displayName: input.displayName,
      countryCode,
      employmentStartDate:
        input.employmentStartDate ?? existing.employmentStartDate ?? null,
    }
    const desiredNormalizedEmail = keepStoredEmail
      ? existing.normalizedEmail
      : normalizedEmail

    // Build the patch from owned-AND-changed columns only. `undefined` is never
    // placed in the patch (TypeORM would try to persist it as NULL) — the
    // object is assembled key by key. email and its normalized form move
    // together. `ownedColumns.includes` gates each column so a source only ever
    // writes what it owns.
    const patch: Partial<UserEntity> = {}
    if (
      ownedColumns.includes('subject') &&
      desired.subject !== existing.subject
    ) {
      patch.subject = desired.subject
    }
    if (ownedColumns.includes('email') && desired.email !== existing.email) {
      patch.email = desired.email
      patch.normalizedEmail = desiredNormalizedEmail
    }
    if (
      ownedColumns.includes('displayName') &&
      desired.displayName !== existing.displayName
    ) {
      patch.displayName = desired.displayName
    }
    if (
      ownedColumns.includes('countryCode') &&
      desired.countryCode !== existing.countryCode
    ) {
      patch.countryCode = desired.countryCode
    }
    if (
      ownedColumns.includes('employmentStartDate') &&
      desired.employmentStartDate !== existing.employmentStartDate
    ) {
      patch.employmentStartDate = desired.employmentStartDate
    }

    // The ONE definition of "did the profile change" on the update path: when
    // no owned column differs, skip the write entirely — no updatedAt bump (it
    // stays a real change signal), no audit no-op. Covers unchanged logins and
    // unchanged directory users alike.
    if (Object.keys(patch).length === 0) {
      return { record: userToRecord(existing), created: false, changed: false }
    }

    // Audit before/after are scoped to the SAME owned columns: the row was read
    // without a lock, so a concurrent writer could have changed a column we do
    // NOT own between our read and this UPDATE — including it in the diff would
    // record a before/after the database never went through for our write.
    // `updateEmployeeAdmin` already snapshots exactly its own fields; this
    // brings upsertUserTx in line.
    const before = snapshotOwned(existing, ownedColumns)
    const after = snapshotOwned(desired, ownedColumns)

    if (patch.countryCode != null) {
      await this.ensureCountry(manager, patch.countryCode)
    }
    patch.updatedAt = occurredAt
    await repo.update(existing.id, patch)

    const actor: AuditActor | null =
      auditSource === 'identity'
        ? {
            userId: existing.id,
            label: desired.displayName,
            email: desired.email,
            roles: input.roles ?? [],
          }
        : auditSource === 'directory'
          ? LDAP_SYNC_ACTOR
          : null
    if (actor) {
      const label = desired.displayName
      await this.auditLog.record(manager, {
        actor,
        eventType: AuditEventType.UserProfileSynced,
        occurredAt,
        target: { userId: existing.id, label },
        entityType: 'user',
        entityId: existing.id,
        summary:
          auditSource === 'directory'
            ? `Synced ${label}'s profile from the directory`
            : `Synced ${label}'s profile from the identity provider`,
        before,
        after,
      })
    }

    // Return the merged record so callers need no refetch of their own.
    const updated = repo.create({ ...existing, ...patch })
    return { record: userToRecord(updated), created: false, changed: true }
  }

  /**
   * The identity countryCode originates from an external token claim. It is
   * validated against the country catalog; a real country not yet in the DB is
   * auto-created from the catalog (name + timezone) so an LDAP country like `DE`
   * still sets the user's location. A code that is not a real country is dropped
   * with a warning instead of failing the login.
   */
  private async resolveIdentityCountryCodeTx(
    manager: EntityManager,
    countryCode: string | undefined,
  ): Promise<string | undefined> {
    if (!countryCode) {
      return undefined
    }
    const catalogEntry = lookupCountry(countryCode)
    if (!catalogEntry) {
      this.logger.warn(
        `Ignoring unknown country code "${countryCode}" from identity claims.`,
      )
      return undefined
    }
    // ensureCountry upserts by code, enriched from the catalog, so the row exists
    // (with its timezone) before users.countryCode references it.
    await this.ensureCountry(manager, catalogEntry.code)
    return catalogEntry.code
  }

  async findOrCreateUserFromIdentity(
    input: FindOrCreateIdentityInput,
  ): Promise<LeaveDomainUserRecord & { roleNames: AppRoleName[] }> {
    let outcome
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UserEntity)
      const occurredAt = input.occurredAt ?? this.clock.nowIso()
      // Roles the user presents at login, snapshotted onto this login's audit
      // entries (the audit source is passed explicitly below).
      const roles = input.roles ?? []

      // Unlocked lookups. The login no longer writes `active` anywhere —
      // upsertUserTx('identity') patches only subject/email/displayName/
      // countryCode — so it cannot resurrect a row the sync concurrently
      // deactivates: the two writes touch DISJOINT columns and serialize on the
      // UPDATE's own row-lock, so the row ends active=false AND subject linked.
      // The pessimistic_write lock that used to serialize this read is gone.
      // Residual, accepted: the refusal check below reads active
      // WITHOUT a lock, so a login can read a stale active=true and be admitted
      // (a session issued) in the window before the sync's deactivation commits
      // — a live-JWT concern, never a DB inconsistency. (A row that does not
      // exist yet cannot be matched here; the create/create race with the sync
      // stays self-healing — the unique email index rejects the loser.)
      // Both are always needed for the conflict guard, so run them in parallel.
      const [bySubject, byEmail] = await Promise.all([
        repo.findOneBy({ subject: input.subject }),
        repo.findOneBy({ normalizedEmail: normalizeEmail(input.email) }),
      ])

      // A login may only CREATE a row or FILL IN a row's still-null subject; it
      // must never overwrite an existing row's non-null `subject` or its
      // (normalized) `email`. `subject` is the stable Keycloak sub and
      // `email` is owned by LDAP→sync — neither changes via a login. If matching
      // the token would require either overwrite, the sign-in is a conflict and
      // is refused for LDAP/sync/admin to reconcile:
      //   - subject and email resolve to DIFFERENT rows (a split);
      //   - subject matches but the email changed (would rewrite email) — a
      //     genuine address change, since byEmail null means the normalized form
      //     matched no row (casing-only differences keep byEmail === bySubject);
      //   - email matches a row already owned by ANOTHER subject (would rewrite
      //     that row's subject — account takeover).
      // Legal, NON-refused cases: brand-new (neither found → INSERT), a normal
      // repeat (same row), and adopting a sync-created row whose subject is
      // still null (null → subject link).
      const conflict =
        (bySubject !== null &&
          byEmail !== null &&
          bySubject.id !== byEmail.id) ||
        (bySubject !== null && byEmail === null) ||
        (bySubject === null && byEmail !== null && byEmail.subject !== null)

      if (conflict) {
        const contested = bySubject ?? byEmail
        const summary =
          bySubject && byEmail
            ? `Refused sign-in for ${bySubject.displayName}: subject and email resolve to different accounts (${input.email} belongs to ${byEmail.displayName}) — manual resolution required`
            : bySubject
              ? `Refused sign-in for ${bySubject.displayName}: the account email cannot be changed at sign-in (token ${input.email} ≠ stored ${bySubject.email}) — manual resolution required`
              : `Refused sign-in: ${input.email} already belongs to ${byEmail?.displayName} — manual resolution required`
        await this.auditLog.record(manager, {
          // The signing-in principal is the actor; when its subject has no row
          // yet (takeover attempt) userId is null, like a system actor.
          actor: {
            userId: bySubject?.id ?? null,
            label: bySubject?.displayName ?? input.displayName,
            email: input.email,
            roles,
          },
          eventType: AuditEventType.UserIdentityConflict,
          occurredAt,
          target: {
            userId: contested?.id ?? null,
            label: contested?.displayName ?? null,
          },
          entityType: 'user',
          entityId: contested?.id ?? null,
          summary,
        })
        return { refused: 'identity-conflict' as const }
      }

      // A deactivated account is refused before anything is written: letting
      // the login proceed would resurrect the profile (and its roles) that the
      // directory sync just retired. This transaction wrote ONLY this refusal
      // audit (the country resolution is deferred below, so a refused login
      // leaves no other trace); committing it keeps the audit entry while the
      // thrown error (OUTSIDE the transaction so the rollback cannot swallow
      // this entry) refuses the sign-in.
      const matched = bySubject ?? byEmail
      if (matched && !matched.active) {
        // Routine after an offboarding, but worth a line: a RETIRED person
        // trying to sign in is expected noise, a CURRENT one means the sync
        // deactivated someone it should not have (directory groups/base DN).
        this.logger.warn(
          `Refused sign-in for deactivated account ${matched.email}. ` +
            'Reactivation is an explicit admin action on the employee profile; ' +
            'if this person should be active, check their directory entry and ' +
            'lrs-* group membership.',
        )
        await this.auditLog.record(manager, {
          actor: {
            userId: matched.id,
            label: matched.displayName,
            email: matched.email,
            roles,
          },
          eventType: AuditEventType.UserLoginRefused,
          occurredAt,
          target: { userId: matched.id, label: matched.displayName },
          entityType: 'user',
          entityId: matched.id,
          summary: `Refused sign-in for deactivated account ${matched.displayName}`,
        })
        return { refused: 'deactivated' as const }
      }

      // Application access is granted by the leaverequest-app groups, not by
      // being able to authenticate: Keycloak admits the whole staff directory
      // (guest, test and technical accounts included), so a token carrying no
      // app role belongs to a directory account that is not an app user. It is
      // refused BEFORE anything is written — no row created, no profile
      // patched, no roles mirrored (an existing row keeps whatever roles it
      // has until the directory sync rules on it). Same
      // commit-the-refusal-audit-then-throw shape as the deactivated case
      // above, and deliberately AFTER it: "deactivated" is the more precise
      // answer for a retired account whose token also lost its roles.
      const tokenRoleNames = identityRolesMirror(roles)
      if (tokenRoleNames.length === 0) {
        const label = matched?.displayName ?? input.displayName
        // The audit row answers "what happened"; this names where to look —
        // the role chain has three links and any of them can drop the role.
        this.logger.warn(
          `Refused sign-in for ${input.email}: the token carries no application ` +
            "role. Check the account's membership in the lrs-* groups in LDAP, " +
            'the Keycloak role mapping, and the OIDC_EMPLOYEE_ROLE/' +
            'OIDC_ADMIN_ROLE settings.',
        )
        await this.auditLog.record(manager, {
          actor: {
            userId: matched?.id ?? null,
            label,
            email: input.email,
            roles,
          },
          eventType: AuditEventType.UserLoginRefused,
          occurredAt,
          target: { userId: matched?.id ?? null, label },
          entityType: 'user',
          entityId: matched?.id ?? null,
          summary: `Refused sign-in for ${label}: the token carries no application role`,
        })
        return { refused: 'no-access' as const }
      }

      // Country resolved only now, AFTER the refusal checks (N1): a refused
      // login must write no country row. Still before the users write, so the
      // countries-then-users ordering that avoids the login↔sync deadlock holds
      // (both take their implicit write-locks in the same table order).
      const countryCode = await this.resolveIdentityCountryCodeTx(
        manager,
        input.countryCode,
      )

      const { record } = await this.upsertUserTx(
        manager,
        {
          userId: bySubject?.id ?? byEmail?.id,
          subject: input.subject,
          email: input.email,
          displayName: input.displayName,
          countryCode,
          createdAt: occurredAt,
          roles,
        },
        'identity',
        // Already resolved above for the conflict guard — reuse it (byEmail is
        // null-or-same-row here, so bySubject wins when both are set).
        bySubject ?? byEmail,
      )

      // The signing-in user is their own actor for everything this login writes.
      const actor: AuditActor = {
        userId: record.userId,
        label: record.displayName,
        email: record.email,
        roles,
      }

      // Keycloak (backed by the leaverequest-app LDAP groups) is the source
      // of truth for roles: the token roles are mirrored into user_roles
      // LITERALLY — add and remove, employee and administrator alike, no
      // implied baseline — so admin reporting (directory, counters) reflects
      // who holds which access, and dropping a Keycloak role removes the DB
      // row on the user's next login. No-op (and unaudited) when unchanged.
      // This is the ONLY writer of user_roles on the identity path — for a
      // brand-new user this very call seeds the rows (upsertUserTx skips its
      // baseline grant for the 'identity' audit source). The set is never
      // empty here: an empty mirror was refused above.
      const { roleNames } = await this.assignUserRolesTx(
        manager,
        {
          userId: record.userId,
          roleNames: tokenRoleNames,
          occurredAt,
        },
        actor,
      )

      // Every successful login is audited, regardless of create/update above.
      await this.auditLog.record(manager, {
        actor,
        eventType: AuditEventType.UserLogin,
        occurredAt,
        target: { userId: record.userId, label: record.displayName },
        entityType: 'user',
        entityId: record.userId,
        summary: `${record.displayName} signed in`,
      })

      // A user created right now may ALREADY be a designated approver: approver
      // rows are email-keyed, so a request submitted before this person ever
      // signed in produced no notification for them — there was no user to
      // address. Backfilling in the same transaction that creates them is what
      // makes "an offline recipient finds it at next sign-in" true for a
      // first-time approver too, instead of handing them an empty centre.
      if (!bySubject && !byEmail) {
        await this.backfillApprovalNotificationsTx(manager, record)
      }

      // The synced role set rides along so the auth layer does not have to
      // re-query what this transaction just wrote.
      return { refused: false as const, record: { ...record, roleNames } }
      })
    } catch (error) {
      // Reaching a users unique-index violation here is now a TRANSIENT
      // create/create race: two concurrent first-logins of the same person (or
      // a login racing the sync's insert) both INSERT, and the loser hits
      // uq_users_*. Real conflicts (split / reused address / takeover) are
      // caught by the guard above and never reach the write. So this is
      // retryable — a clean 409 that says "try again", not a raw 23505 that
      // would page on-call.
      if (isUsersUniqueViolation(error)) {
        throw new LoginIdentityConflictError(
          'Your sign-in raced a concurrent update — please try signing in again.',
        )
      }
      throw error
    }

    if (outcome.refused === 'deactivated') {
      throw new AccountDeactivatedError(
        'This account is deactivated — contact your administrator.',
      )
    }
    if (outcome.refused === 'no-access') {
      // Worded apart from the deactivated case: this person was never an app
      // user, and "deactivated" would send them (and support) hunting for an
      // account that does not exist.
      throw new NoApplicationAccessError(
        'This account has no access to the leave request system — contact your administrator.',
      )
    }
    if (outcome.refused === 'identity-conflict') {
      throw new LoginIdentityConflictError(
        'Your sign-in could not be matched to a single account — contact your administrator.',
      )
    }
    return outcome.record
  }

  /**
   * One directory (LDAP) sync pass: upsert everyone the directory reports,
   * deactivate active users who are gone from it, and flag — without touching —
   * deactivated users the directory still lists (the sync never reactivates;
   * that is an explicit admin action). A person is recognized by their one
   * normalized mail address (multivalued mail is rejected at the mapper),
   * so the SSO row and the sync agree on identity by construction. `subject`
   * belongs to the SSO login path and is never written here. Roles ARE
   * written: after each upsert the record's group-derived roles are mirrored
   * onto the row (assignUserRolesTx as LDAP_SYNC_ACTOR) — the same literal
   * rule the login mirror applies to the token, so the two writers converge
   * on the same set instead of fighting.
   *
   * upsertUserTx owns both the writes and the created/updated audit entries
   * (audit source 'directory' selects the LDAP_SYNC_ACTOR and wording); this
   * method adds the conflict/deactivation events and one ldap_sync.completed
   * summary row per pass. The whole pass is one transaction guarded by a
   * transaction-scoped advisory lock taken as its FIRST statement — returns
   * null (untouched database) when another pass holds it; a failure mid-run
   * rolls everything back rather than leaving half a directory.
   *
   * The deactivation phase runs ONLY on a trustworthy batch: any mapper skip
   * (options.skipped) or in-batch duplicate withholds it — absence cannot be
   * distinguished from "present but unreadable" in those passes.
   */
  async syncUsersFromDirectory(
    users: DirectoryUserInput[],
    options: {
      occurredAt?: string
      /**
       * When the LDAP read happened. REQUIRED — rows created at or after this
       * instant (e.g. a new hire's first SSO login racing the pass) are never
       * deactivated: they may legitimately be missing from the older
       * directory snapshot. Only the caller who performed the fetch knows the
       * true value; a silent default would quietly re-open that race.
       */
      fetchedAt: string
      /**
       * Reasons for directory entries the caller could not map (no/invalid
       * mail, missing sn). Any entry here withholds the deactivation phase and
       * lands in the report and the audit summary.
       */
      skipped?: string[]
      /**
       * Non-fatal per-entry warnings from entries that DID map (e.g. an
       * unusable country dropped to null). Purely observational — echoed into
       * the report and audit summary, no effect on the sync itself.
       */
      warnings?: string[]
      /**
       * Full DNs from the lrs-* groups that matched no directory entry (left
       * the staff tree, still in the app groups). REQUIRED, not defaulted:
       * the report promises this field, and a caller that forgot to thread it
       * through would otherwise silently report a clean pass. Echo-only here —
       * the rows such members may still have are deactivated by the ordinary
       * absent-from-batch rule below, not by this list.
       */
      staleAccessMembers: string[]
    },
  ): Promise<DirectorySyncReport | null> {
    const occurredAt = options.occurredAt
    const skipped = options.skipped ?? []
    const warnings = options.warnings ?? []
    const staleAccessMembers = options.staleAccessMembers
    // Chronology is compared NUMERICALLY: fetchedAt is caller-supplied, and a
    // lexicographic string comparison would silently break on a legal ISO
    // variant (no milliseconds, '+02:00' offset). An unparseable value must
    // fail loudly — a garbage fetchedAt would otherwise disable the guard.
    const fetchedAtMs = Date.parse(options.fetchedAt)
    if (Number.isNaN(fetchedAtMs)) {
      throw new LeaveDomainValidationError(
        `Directory sync received an unparseable fetchedAt: ${JSON.stringify(options.fetchedAt)}`,
      )
    }
    // The all-empty base comes from the contracts helper — one source for
    // the runtime shape and every fixture, so a future field cannot be
    // defaulted two different ways in different packages.
    // deactivationWithheld is decided below, once the batch has been
    // deduplicated (false until then, so an early throw can never hand out
    // a report claiming a phase was held back that was never reached); the
    // role lists fill from the user_roles diff each mirror call applies.
    const report: DirectorySyncReport = {
      ...emptyDirectorySyncReport(),
      skipped,
      warnings,
      staleAccessMembers,
    }
    // Defense in depth: the orchestrator already refuses to call this with an
    // empty read, but an empty batch reaching here would deactivate the whole
    // company. A precondition breach must be LOUD — a silent empty report
    // would read as "sync succeeded, nothing to do" to any future caller.
    if (users.length === 0) {
      throw new LeaveDomainValidationError(
        'Directory sync received an empty batch — refusing to act on it.',
      )
    }
    // Same loudness per record: the type documents roleNames as never empty
    // (membership admits a person via at least one group), so an empty set
    // here is a caller bug — and acting on it would strip every role from an
    // account that stays active, refusing its owner at the door while the
    // pass reports success.
    for (const user of users) {
      if (user.roleNames.length === 0) {
        throw new LeaveDomainValidationError(
          `Directory sync received ${user.email} with no roles — refusing the batch.`,
        )
      }
    }

    return this.dataSource.transaction(async (manager) => {
      // Single-runner guarantee, first statement of the work transaction
      // itself: the lock shares the transaction's connection (no second pool
      // slot, no idle-in-transaction window a server timeout could kill) and
      // dies with COMMIT/ROLLBACK — leak-proof by construction.
      if (!(await this.tryDirectorySyncLockTx(manager))) {
        return null
      }

      const repo = manager.getRepository(UserEntity)
      const at = occurredAt ?? this.clock.nowIso()

      // Duplicate canary: LDAP's unique overlay on `mail` is supposed to make
      // two entries with one address impossible, so a duplicate here means
      // that guarantee broke. Skip the affected entries (there is no way to
      // know which one is right); the protection against wrongful
      // deactivation is the withheld deactivation phase below.
      const byEmail = new Map<string, DirectoryUserInput>()
      const duplicated = new Set<string>()
      for (const user of users) {
        const key = normalizeEmail(user.email)
        if (byEmail.has(key)) {
          duplicated.add(key)
          continue
        }
        byEmail.set(key, user)
      }
      for (const email of duplicated) {
        // First raw spelling (byEmail keeps the first occurrence), so the
        // report speaks the same directory casing as every other list.
        const rawEmail = byEmail.get(email)?.email ?? email
        byEmail.delete(email)
        report.duplicateEmails.push(rawEmail)
        this.logger.error(
          `Directory sync: ${rawEmail} appears more than once in the LDAP result — ` +
            'the unique-mail guarantee is broken; entries skipped. ' +
            'Verify the unique overlay with the LDAP administrators.',
        )
      }
      if (byEmail.size === 0) {
        // The dedupe hollowed the batch out entirely — same hazard as an
        // empty read, same loud refusal.
        throw new LeaveDomainValidationError(
          'Directory sync batch contains only duplicated addresses — refusing to act on it.',
        )
      }

      // Presence is keyed by each listed person's ONE normalized address —
      // multivalued mail is rejected at the mapper, so there are no
      // aliases to union. byEmail is already keyed by normalizeEmail(user.email),
      // so its keyset IS the present-address set. A deactivation candidate whose
      // address is absent here is no longer an app user in the directory.
      const presentEmails = new Set(byEmail.keys())

      for (const directoryUser of byEmail.values()) {
        // One address per person, so the single normalizedEmail is the
        // match key and the unique index guarantees at most one row — no
        // In()/ordering/exact-primary tie-break needed. An SSO-provisioned row
        // and this sync agree on that address, so the update lands in place.
        const existing = await repo.findOneBy({
          normalizedEmail: normalizeEmail(directoryUser.email),
        })

        if (existing && !existing.active) {
          report.conflicts.push(directoryUser.email)
          // A deactivated account the directory still admits: a re-hire, or
          // the groups were never cleaned after the deactivation. Ruling is
          // the admin's — reactivate from the employee profile if the person
          // is back, or have the LDAP administrators fix the directory. The
          // sync never reactivates and leaves the stored roles untouched.
          this.logger.warn(
            `${existing.displayName} (${directoryUser.email}) is deactivated here ` +
              'but still listed by the directory groups — a re-hire or a missed ' +
              'directory cleanup. Reactivate from the employee profile, or have ' +
              'the LDAP administrators remove the group membership.',
          )
          await this.auditLog.record(manager, {
            actor: LDAP_SYNC_ACTOR,
            eventType: AuditEventType.UserSyncConflict,
            occurredAt: at,
            target: { userId: existing.id, label: existing.displayName },
            entityType: 'user',
            entityId: existing.id,
            summary:
              `${existing.displayName} is deactivated but present in LDAP — ` +
              'manual resolution required, contact your LDAP administrator',
            // Nothing changed; suppress the derived diff.
            changedFields: [],
          })
          continue
        }

        // upsertUserTx owns the write, the change detection (unchanged users
        // are not rewritten), and the audit; the flags feed the run report.
        const { record, created, changed } = await this.upsertUserTx(
          manager,
          {
            userId: existing?.id,
            email: directoryUser.email,
            displayName: directoryUser.displayName,
            // Pass the mapped value through AS-IS, including null: for the
            // directory source upsertUserTx treats null as "clear" (LDAP is the
            // source of truth), so an absent/invalid `l` removes any stored code
            // instead of leaving a stale one.
            countryCode: directoryUser.countryCode,
            createdAt: at,
          },
          'directory',
          // Matched just above — reuse it instead of re-reading by id.
          existing,
        )
        if (created) {
          report.created.push(directoryUser.email)
        } else if (changed) {
          report.updated.push(directoryUser.email)
        }

        // Mirror the group-derived roles LITERALLY, same add-and-remove sync
        // the login path runs on its token — the two writers apply the same
        // rule from the same source (the lrs-* groups), so they converge
        // instead of ping-ponging. The grant/revoke report comes from the
        // applied diff, never from the input flags, so an unchanged admin is
        // not re-reported every pass (best-effort when a concurrent login of
        // the same person wins half of a mixed diff — see assignUserRolesTx).
        // No-op sets stay unaudited; the bare [employee] first grant is
        // covered by the user.provisioned event like every provisioning
        // source.
        const roleSync = await this.assignUserRolesTx(
          manager,
          {
            userId: record.userId,
            roleNames: directoryUser.roleNames,
            occurredAt: at,
          },
          LDAP_SYNC_ACTOR,
        )
        if (roleSync.changed) {
          if (roleSync.added.includes(AppRoleName.Administrator)) {
            report.adminGranted.push(directoryUser.email)
          }
          if (roleSync.removed.includes(AppRoleName.Administrator)) {
            report.adminRevoked.push(directoryUser.email)
          }
          if (roleSync.added.includes(AppRoleName.Employee)) {
            report.employeeGranted.push(directoryUser.email)
          }
          if (roleSync.removed.includes(AppRoleName.Employee)) {
            report.employeeRevoked.push(directoryUser.email)
          }
          // The ping-pong detector. An SSO-linked person's roles were last
          // written by their login's token mirror, so the sync changing them
          // means the lrs-* groups and the token disagree. Once, right after
          // a group change, that is normal propagation — the token catches
          // up on the next sign-in. Recurring every pass, it means the
          // Keycloak role mapping and the group DNs have drifted apart and
          // the two writers keep undoing each other, while sessions follow
          // the token regardless of what this pass wrote. Nothing but this
          // line spans both writers, so it is the only place the drift can
          // be named.
          if (existing?.subject) {
            this.logger.warn(
              `Directory sync changed the roles of SSO-linked ` +
                `${directoryUser.email} (added [${roleSync.added.join(', ')}], ` +
                `removed [${roleSync.removed.join(', ')}]). If this repeats ` +
                'every pass, the Keycloak role mapping and the lrs-* group ' +
                'DNs disagree — sessions follow the token, so this change ' +
                'does not reach them until the two configs are reconciled.',
            )
          }
        }
      }

      // Departures: every active user absent from the batch. Absence means
      // the person is no longer an app user in the directory — the entry
      // left the staff tree (left the company) OR the person was removed
      // from both lrs-* groups (a deliberate access revocation); both call
      // for the same deactivation, and the wording below names both. Acted
      // on only when the batch is trustworthy: mapper skips and duplicates
      // both mean absence may just be "present but unreadable".
      report.deactivationWithheld = skipped.length > 0 || duplicated.size > 0
      if (!report.deactivationWithheld) {
        const candidates = await repo.findBy({ active: true })
        for (const candidate of candidates) {
          if (presentEmails.has(candidate.normalizedEmail)) {
            continue
          }
          // A row born at/after the LDAP read (first login racing the pass)
          // is not "absent from the directory" — the snapshot just predates
          // it. Never deactivate what the fetch could not have seen.
          if (Date.parse(candidate.createdAt) >= fetchedAtMs) {
            continue
          }
          // Atomic conditional deactivation — no lock, no re-read. The
          // `active: true` predicate is the whole guard: it makes a repeat pass
          // idempotent and serializes on the UPDATE's own row-lock, and because
          // we write ONLY `active`, a concurrent writer of a different column
          // (a login linking its subject) can never be reverted. The createdAt
          // guard already ran against the candidate's immutable createdAt, and a
          // row born after the scan cannot enter this loop at all.
          const result = await repo.update(
            { id: candidate.id, active: true },
            { active: false, updatedAt: at },
          )
          // affected=0 means someone already retired this row between our scan
          // and here — the deactivation did NOT happen, so emitting the audit
          // event or the report line would fabricate a second deactivation and
          // corrupt the journal (and the consecutive-withheld accounting that
          // reads it).
          if (result.affected !== 1) {
            continue
          }
          report.deactivated.push(candidate.email)
          await this.auditLog.record(manager, {
            actor: LDAP_SYNC_ACTOR,
            eventType: AuditEventType.UserDeactivated,
            occurredAt: at,
            target: { userId: candidate.id, label: candidate.displayName },
            entityType: 'user',
            entityId: candidate.id,
            summary:
              `${candidate.displayName} is no longer an app user in the directory ` +
              '(entry gone or removed from the lrs-* groups) — account deactivated',
            // Owned-column snapshot: deactivation writes only `active`, so the
            // before/after carry exactly that flip — built from known values,
            // not a full re-snapshot an unlocked read could make lie about.
            before: { active: true },
            after: { active: false },
          })
        }
      }

      // One summary row per pass so scheduled (cron) runs are visible in the
      // audit UI without any extra reporting surface.
      await this.auditLog.record(manager, {
        actor: LDAP_SYNC_ACTOR,
        eventType: AuditEventType.LdapSyncCompleted,
        occurredAt: at,
        entityType: 'directory_sync',
        summary:
          `Directory sync completed: ${report.created.length} created, ` +
          `${report.updated.length} updated, ${report.deactivated.length} deactivated, ` +
          `${report.adminGranted.length} admin granted, ${report.adminRevoked.length} admin revoked, ` +
          `${report.employeeGranted.length} employee granted, ${report.employeeRevoked.length} employee revoked, ` +
          `${report.conflicts.length} conflict(s), ${report.duplicateEmails.length} duplicate(s), ` +
          `${skipped.length} skipped, ${staleAccessMembers.length} stale group member(s)` +
          (report.deactivationWithheld
            ? ' — deactivation withheld (untrustworthy batch)'
            : ''),
        // The whole report rides along via spread, so a field added to
        // DirectorySyncReport can never silently miss the audit trail the
        // tooling reads. That includes deactivationWithheld, a structured flag
        // rather than just the summary-text note: the consecutive-withheld
        // counter derives its state from the audit log itself and must never
        // parse prose.
        after: { ...report },
      })

      return report
    })
  }

  /**
   * Record a directory-sync pass that crashed, OUTSIDE any transaction — on the
   * non-transactional dataSource.manager, so the row survives even though the
   * work transaction (if one started at all) has already rolled back. This is
   * the cheap observability half: without it, "the pass failed" and "the
   * pass never ran" are indistinguishable in the audit UI, and a directory that
   * is down for a day leaves no trace there. Callers are the manual endpoint's
   * and the scheduler's catch, both of which run after the domain
   * transaction has already unwound — passing a transactional manager here would
   * lose the row to the same rollback that lost the work.
   */
  async recordDirectorySyncFailed(input: {
    /** The raw driver text, for whoever is debugging the connection. */
    error: string
    /** The same failure worded for whoever has to fix it. */
    summary: string
    occurredAt?: string
  }): Promise<void> {
    // The prose carries the worded cause and the raw text goes to the
    // after-state, because this row outlives every other account of the run:
    // the page's alert is gone on reload, and a directory that answers a
    // refused bind with no diagnostic text leaves a driver message that reads
    // in full as "Code: 0x31". A reader of the audit log would have no way to
    // learn from that which of the four owners of a sync failure to go to.
    // reason distinguishes a thrown failure from an empty directory (both land
    // on ldap_sync.failed); the audit log has no severity levels, so the
    // discriminator lives in the structured after-state, not the prose.
    await this.recordDirectorySyncFailure(
      `Directory sync failed: ${input.summary}`,
      { reason: 'error', error: input.error },
      input.occurredAt,
    )
  }

  /**
   * Record a pass that read the directory but found no usable entry. Modeled as
   * ldap_sync.failed rather than ldap_sync.completed on purpose: an unexpectedly
   * empty result is almost always a broken filter or base DN, and recording it
   * as a healthy completion would let exactly that silent failure hide from Root
   * C's "is the sync healthy?" audit query (a filter returning nothing every
   * hour would read as a clean pass forever). The reason flag separates it from
   * a thrown failure. Written outside any transaction because the domain never
   * opened one for this outcome — the orchestrator refuses before ever calling
   * syncUsersFromDirectory.
   */
  async recordDirectorySyncEmpty(input: {
    entriesRead: number
    skipped: string[]
    /**
     * Full DNs of group members matching no staff-tree entry. Carried on
     * this row because it is the only trace such a pass leaves, and the
     * orchestrator's stale warning promises the full list in the audit
     * trail; a completed pass keeps the same promise through its report.
     */
    staleAccessMembers: string[]
    /** Entries in the staff tree but in neither lrs-* group (counted only). */
    nonMembers: number
    occurredAt?: string
  }): Promise<void> {
    const stale = input.staleAccessMembers.length
    await this.recordDirectorySyncFailure(
      `Directory sync read the directory but found no usable entries ` +
        `(${input.entriesRead} read, ${input.skipped.length} skipped${
          stale > 0
            ? `, ${stale} stale group member${stale === 1 ? '' : 's'}`
            : ''
        }) — nothing synced, nobody deactivated`,
      {
        reason: 'empty-directory',
        entriesRead: input.entriesRead,
        skipped: input.skipped,
        staleAccessMembers: input.staleAccessMembers,
        nonMembers: input.nonMembers,
      },
      input.occurredAt,
    )
  }

  /**
   * The single writer of an ldap_sync.failed lifecycle row. Owns the invariants
   * both failure outcomes share, so a third one cannot silently drift from them:
   * the non-transactional manager (the row must survive a rolled-back pass), the
   * LdapSyncFailed event, the 'directory_sync' entity, and the LDAP_SYNC_ACTOR.
   * Callers supply only the human summary and the reason-tagged `after`.
   */
  private async recordDirectorySyncFailure(
    summary: string,
    after: Record<string, unknown>,
    occurredAt?: string,
  ): Promise<void> {
    await this.auditLog.record(this.dataSource.manager, {
      actor: LDAP_SYNC_ACTOR,
      eventType: AuditEventType.LdapSyncFailed,
      ...(occurredAt ? { occurredAt } : {}),
      entityType: 'directory_sync',
      summary,
      after,
    })
  }

  /**
   * Transaction-scoped advisory lock for the directory sync, taken on the
   * caller's transaction connection. False = another pass holds it.
   */
  private async tryDirectorySyncLockTx(
    manager: EntityManager,
  ): Promise<boolean> {
    const rows: Array<{ locked: boolean }> = await manager.query(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [DIRECTORY_SYNC_ADVISORY_LOCK_KEY],
    )
    return rows[0]?.locked === true
  }

  // Notifications for the pending requests a brand-new user was already asked to
  // approve. Stamped with each request's own submittedAt, not "now", so the feed
  // reports when the ask actually happened.
  private async backfillApprovalNotificationsTx(
    manager: EntityManager,
    recipient: LeaveDomainUserRecord,
  ): Promise<void> {
    const approverRows = await manager
      .getRepository(LeaveRequestApproverEntity)
      .find({
        where: { email: recipient.normalizedEmail, kind: ApproverKind.To },
      })
    if (approverRows.length === 0) {
      return
    }

    const requests = await manager.getRepository(LeaveRequestEntity).find({
      where: {
        id: In(approverRows.map((approver) => approver.requestId)),
        status: LeaveRequestStatus.Pending,
      },
    })
    if (requests.length === 0) {
      return
    }

    const requesters = await manager.getRepository(UserEntity).find({
      where: { id: In(requests.map((request) => request.requesterUserId)) },
    })
    const nameByUserId = new Map(
      requesters.map((requester) => [requester.id, requester.displayName]),
    )

    await this.notifications.recordMany(
      manager,
      requests.map((request) => ({
        recipientUserId: recipient.userId,
        actorUserId: request.requesterUserId,
        actorLabel: nameByUserId.get(request.requesterUserId) ?? 'An employee',
        type: NotificationType.ApprovalNeeded,
        requestId: request.id,
        occurredAt: request.submittedAt,
        summary: `${nameByUserId.get(request.requesterUserId) ?? 'An employee'} requests ${formatLeaveTypeLabel(request.leaveType)} from ${request.startDate} to ${request.endDate} and needs your approval`,
      })),
    )
  }

  async getUser(userId: string): Promise<LeaveDomainUserRecord> {
    return userToRecord(await this.requireUser(this.manager, userId))
  }

  async findUserBySubject(
    subject: string,
  ): Promise<LeaveDomainUserRecord | undefined> {
    const user = await this.manager
      .getRepository(UserEntity)
      .findOneBy({ subject })
    return user ? userToRecord(user) : undefined
  }

  async findUserByEmail(
    email: string,
  ): Promise<LeaveDomainUserRecord | undefined> {
    const user = await this.manager
      .getRepository(UserEntity)
      .findOneBy({ normalizedEmail: normalizeEmail(email) })
    return user ? userToRecord(user) : undefined
  }

  async listUsers(): Promise<LeaveDomainUserRecord[]> {
    return this.listUsersTx(this.manager)
  }

  private async listUsersTx(
    manager: EntityManager,
  ): Promise<LeaveDomainUserRecord[]> {
    const users = await manager.getRepository(UserEntity).find()
    return users
      .map(userToRecord)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
  }

  async assignUserRoles(input: AssignUserRolesInput): Promise<AppRoleName[]> {
    return this.dataSource.transaction(async (manager) => {
      const { roleNames } = await this.assignUserRolesTx(manager, input)
      return roleNames
    })
  }

  /**
   * Returns the synced set plus the diff this call computed: `changed` says
   * whether any row was actually written (false for a no-op AND for the loser
   * of a concurrent identical diff), `added`/`removed` name the roles the
   * diff carried. The directory sync builds its grant/revoke report from
   * exactly this — never from the input flags — so an unchanged admin is not
   * re-reported every pass. Attribution is best-effort under a concurrent
   * login of the same person: `changed` aggregates deletes and inserts, so
   * when a login wins one half of a mixed diff the other half still marks
   * the whole computed diff as applied. The stored rows converge either way;
   * only report/audit attribution can name the other writer's half.
   */
  private async assignUserRolesTx(
    manager: EntityManager,
    input: AssignUserRolesInput,
    actor: AuditActor = SYSTEM_ACTOR,
  ): Promise<{
    roleNames: AppRoleName[]
    changed: boolean
    added: AppRoleName[]
    removed: AppRoleName[]
  }> {
    const user = await this.requireUser(manager, input.userId)
    const repo = manager.getRepository(UserRoleEntity)
    // Snapshot the prior set so the audit diff has a real before-state (this
    // path does not otherwise read the old rows). Sorted, like `after` below.
    const before = await this.getUserRoleNamesTx(manager, input.userId)
    const after = Array.from(new Set(input.roleNames)).sort()
    // Unchanged set — the common case now that this runs on every login.
    // Nothing to write, nothing to audit.
    if (snapshotsEqual(after, before)) {
      return { roleNames: before, changed: false, added: [], removed: [] }
    }

    // Diff-sync rather than delete-all + reinsert: untouched rows keep their
    // id/assignedAt (the mirror can answer "since when"), and two concurrent
    // logins applying the same change converge instead of racing the
    // uq_user_roles_user_role unique index — orIgnore() turns the loser's
    // duplicate insert into a no-op.
    const toRemove = before.filter((roleName) => !after.includes(roleName))
    const toAdd = after.filter((roleName) => !before.includes(roleName))
    // Rows THIS transaction actually changed. Under two concurrent logins
    // applying the same diff, the loser's delete matches nothing and its
    // insert is swallowed by orIgnore — it must not write a duplicate audit
    // entry for a change the winner already recorded.
    let changedRows = 0
    if (toRemove.length > 0) {
      const removed = await repo.delete({
        userId: input.userId,
        roleName: In(toRemove),
      })
      changedRows += removed.affected ?? 0
    }
    if (toAdd.length > 0) {
      const inserted = await repo
        .createQueryBuilder()
        .insert()
        .values(
          toAdd.map((roleName) => ({
            id: randomUUID(),
            userId: input.userId,
            roleName,
          })),
        )
        .orIgnore()
        // Explicit RETURNING so raw reflects exactly the rows that survived
        // ON CONFLICT DO NOTHING.
        .returning('id')
        .execute()
      changedRows += inserted.raw.length
    }

    // The bare baseline granted at provisioning is not audited — the
    // `user.provisioned` event already covers a new account. Anything beyond
    // it IS: a new user whose first token already carries `administrator`
    // gets an explicit grant entry (before: []), keeping every appearance of
    // an elevated role in user_roles traceable to ONE user_roles.assigned
    // event, same as later changes.
    const isBaselineProvisionGrant =
      before.length === 0 &&
      snapshotsEqual(after, [...BASELINE_ROLES].sort())
    if (!isBaselineProvisionGrant && changedRows > 0) {
      await this.auditLog.record(manager, {
        actor,
        eventType: AuditEventType.UserRolesAssigned,
        occurredAt: input.occurredAt,
        target: { userId: user.id, label: user.displayName },
        entityType: 'user_roles',
        entityId: user.id,
        summary: `Roles for ${user.displayName} updated`,
        before: { roles: before },
        after: { roles: after },
      })
    }
    return {
      roleNames: after,
      changed: changedRows > 0,
      added: toAdd,
      removed: toRemove,
    }
  }

  async getUserRoleNames(userId: string): Promise<AppRoleName[]> {
    await this.requireUser(this.manager, userId)
    return this.getUserRoleNamesTx(this.manager, userId)
  }

  private async getUserRoleNamesTx(
    manager: EntityManager,
    userId: string,
  ): Promise<AppRoleName[]> {
    const rows = await manager
      .getRepository(UserRoleEntity)
      .findBy({ userId })
    return rows.map((row) => row.roleName).sort()
  }

  // ------------------------------------------------------------- settings ----

  async updateLeaveSettings(
    input: UpdateLeaveSettingsDto,
    audit: AuditActor = SYSTEM_ACTOR,
  ): Promise<LeaveSettingsDto> {
    return this.dataSource.transaction(async (manager) => {
      // Load the prior singleton before overwriting it so the audit entry has a
      // real before-state (this path only ever upserted, never read the old row).
      const beforeSettings = await this.loadSettingsState(manager)
      // The org default zone gets the same treatment a country's zone gets, and
      // for the same reason: it decides when a leave day is spent, here for
      // everyone whose country has no zone pinned to it. The difference is that
      // an unusable value used to be accepted in silence -- the column takes any
      // string, and the readers fall back -- so the console could report a zone
      // the system had never once used.
      //
      // The value already stored is always allowed back in, exactly as with a
      // country's zone: a row written before this check must not lock the admin
      // out of every other card on the page.
      const submittedZone = input.defaultTimezone?.trim()
      if (
        submittedZone !== undefined &&
        submittedZone !== beforeSettings.defaultTimezone &&
        !isKnownTimezone(submittedZone)
      ) {
        throw new DefaultTimezoneNotRecognizedError(
          submittedZone === ''
            ? 'The default timezone cannot be blank.'
            : `${submittedZone} is not a timezone this server can resolve.`,
          submittedZone,
        )
      }
      const nextSettings = {
        defaultVacationDays: input.defaultVacationDays,
        defaultSickDays: input.defaultSickDays,
        // Absent leaves the stored mode alone, for the same reason the default
        // timezone does: every card on the settings page sends the whole
        // object, so reading absence as a command would let an unrelated save
        // switch the whole org's approvals off.
        approvalRequired: input.approvalRequired ?? beforeSettings.approvalRequired,
        defaultApproverEmails: [...input.defaultApproverEmails],
        defaultCcApproverEmails: [...input.defaultCcApproverEmails],
        carryoverPolicy: input.carryoverPolicy ?? DEFAULT_CARRYOVER_POLICY,
        carryoverCapDays: input.carryoverCapDays ?? DEFAULT_CARRYOVER_CAP_DAYS,
        carryoverCapMode: input.carryoverCapMode ?? DEFAULT_CARRYOVER_CAP_MODE,
        carryoverCapPercent:
          input.carryoverCapPercent ?? DEFAULT_CARRYOVER_CAP_PERCENT,
        // Absent means "leave the stored zone alone", never "reset to Kyiv" --
        // the same rule a country's zone follows two loops below, and for the
        // same reason: every card on the settings page sends the whole object,
        // so reading absence as a command would let an unrelated save move
        // everyone's midnight. Stored trimmed, so the value that passed the
        // check is the value that lands. A blank gets here only as one the row
        // already held, and is repaired rather than written back.
        defaultTimezone:
          submittedZone || beforeSettings.defaultTimezone || DEFAULT_TIMEZONE,
        // Absent leaves the stored length alone, never resets it to eight: a
        // configured seven-hour day would otherwise be silently undone by the
        // countries card, and every portion frozen onto a request since would
        // be measured against a workday nobody chose.
        hoursPerDay: input.hoursPerDay ?? beforeSettings.hoursPerDay,
      }
      // Stamp the mutation time on the server: the client-supplied updatedAt is
      // advisory and must never become the source of truth.
      await manager.getRepository(LeaveSettingsEntity).save({
        id: SETTINGS_SINGLETON_ID,
        ...nextSettings,
        updatedAt: this.clock.nowIso(),
      })

      // Only when something actually moved. Every card on the settings page
      // sends the whole object, so pressing Save on an untouched card used to
      // append a row whose before and after were byte-identical -- and the
      // console, finding no field-level diff, rendered both snapshots side by
      // side, which reads as "six fields changed". Country edits keep their own
      // audit events, so skipping here hides nothing.
      const beforeSnapshot = snapshotSettings(beforeSettings)
      const afterSnapshot = snapshotSettings(nextSettings)
      if (JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot)) {
        await this.auditLog.record(manager, {
          actor: audit,
          eventType: AuditEventType.SettingsUpdated,
          entityType: 'leave_settings',
          entityId: String(SETTINGS_SINGLETON_ID),
          summary: 'Updated leave settings',
          before: beforeSnapshot,
          after: afterSnapshot,
        })
      }

      const countryRepo = manager.getRepository(CountryEntity)

      // Non-destructive country sync (upsert by the natural key `code`). Holidays
      // are NOT touched here anymore: calendars are managed through the dedicated
      // holiday endpoints, so a settings save can no longer wipe them (the old
      // holidayRepo.clear() + re-insert is gone).
      const incomingCodes = new Set(
        input.countries.map((country) => normalizeCountryCode(country.code)),
      )
      for (const country of input.countries) {
        const code = normalizeCountryCode(country.code)
        // The name is still canonical from the catalog: it is a label, and a
        // typed one only ever drifts. The TIMEZONE is not, because it is a
        // choice -- a country with several zones has no single right answer,
        // and only the admin knows which office this workspace runs on.
        const entry = lookupCountry(code)
        const name = entry?.name ?? country.name
        const existing = await countryRepo.findOneBy({ code })
        // Absent means "leave it alone", never "reset to the catalog default".
        // Reading absence as a command to reset is what silently reverted a
        // pinned zone on every unrelated settings save.
        const submitted = country.timezone?.trim() || undefined
        const assignable = catalogTimezonesFor(code)
        // The stored value is always allowed back in. Otherwise a future
        // version of the timezone catalog dropping a zone would lock the admin
        // out of saving settings at all, over a value they never touched.
        if (
          submitted !== undefined &&
          !assignable.includes(submitted) &&
          submitted !== existing?.timezone
        ) {
          throw new CountryTimezoneNotAvailableError(
            `${submitted} is not one of ${code}'s timezones.`,
            code,
            assignable,
          )
        }
        const timezone =
          submitted ?? existing?.timezone ?? entry?.timezone ?? null
        if (existing) {
          if (existing.name !== name || existing.timezone !== timezone) {
            const before = {
              code: existing.code,
              name: existing.name,
              timezone: existing.timezone,
            }
            existing.name = name
            existing.timezone = timezone
            await countryRepo.save(existing)
            await this.auditLog.record(manager, {
              actor: audit,
              eventType: AuditEventType.CountryUpdated,
              entityType: 'country',
              entityId: existing.code,
              summary: `Updated country ${existing.code}`,
              before,
              after: {
                code: existing.code,
                name,
                timezone: existing.timezone,
              },
            })
          }
        } else {
          await countryRepo.save(
            countryRepo.create({ id: randomUUID(), code, name, timezone }),
          )
          await this.auditLog.record(manager, {
            actor: audit,
            eventType: AuditEventType.CountryCreated,
            entityType: 'country',
            entityId: code,
            summary: `Added country ${name} (${code})`,
            after: { code, name, timezone },
          })
        }
      }
      // Remove countries dropped from the payload -- but a country with rows
      // still pointing at it is refused, not skipped.
      //
      // Employees first, because that is the case nothing else catches. Their
      // foreign key is ON DELETE SET NULL, so the delete SUCCEEDS and blanks
      // the country of everyone in it; each of them lands in PendingSetup and
      // can no longer submit leave at all. Refusing is the only place that can
      // stop it. Calendars are the reverse: RESTRICT would abort the save, so
      // this used to skip them in silence, which the admin could only read as
      // the row stubbornly reappearing.
      //
      // Counting every user, active or not: `active` mirrors the directory, it
      // is not a delete, and SET NULL destroys a deactivated person's stored
      // country just as permanently.
      const calendarRepo = manager.getRepository(HolidayCalendarEntity)
      for (const stale of await countryRepo.find()) {
        if (incomingCodes.has(stale.code)) {
          continue
        }
        const assignedUsers = await manager
          .getRepository(UserEntity)
          .countBy({ countryCode: stale.code })
        const ownedCalendars = await calendarRepo.countBy({
          countryCode: stale.code,
        })
        if (assignedUsers > 0 || ownedCalendars > 0) {
          throw new CountryInUseError(
            countryInUseMessage(stale.name, assignedUsers, ownedCalendars),
            stale.code,
            assignedUsers,
            ownedCalendars,
          )
        }
        await countryRepo.delete({ id: stale.id })
        await this.auditLog.record(manager, {
          actor: audit,
          eventType: AuditEventType.CountryDeleted,
          entityType: 'country',
          entityId: stale.code,
          summary: `Removed country ${stale.name} (${stale.code})`,
          before: { code: stale.code, name: stale.name },
        })
      }

      return this.getLeaveSettingsTx(manager)
    })
  }

  async getLeaveSettings(): Promise<LeaveSettingsDto> {
    return this.getLeaveSettingsTx(this.manager)
  }

  /**
   * Just the workday length, for a caller that needs the divisor to render day
   * figures as days and hours. Separate from getLeaveSettings, which also lists
   * every country and holiday calendar (a report sentence must not pay for
   * that) and whose hoursPerDay is optional because the same interface doubles
   * as the write payload. This one is always a number.
   */
  async getWorkdayHours(): Promise<number> {
    return this.getWorkdayHoursTx(this.manager)
  }

  /** getWorkdayHours inside a transaction the caller already owns. */
  async getWorkdayHoursTx(manager: EntityManager): Promise<number> {
    return (await this.loadSettingsState(manager)).hoursPerDay
  }

  private async getLeaveSettingsTx(
    manager: EntityManager,
  ): Promise<LeaveSettingsDto> {
    const settings = await this.loadSettingsState(manager)
    return {
      defaultVacationDays: settings.defaultVacationDays,
      defaultSickDays: settings.defaultSickDays,
      approvalRequired: settings.approvalRequired,
      defaultApproverEmails: [...settings.defaultApproverEmails],
      defaultCcApproverEmails: [...settings.defaultCcApproverEmails],
      carryoverPolicy: settings.carryoverPolicy,
      carryoverCapDays: settings.carryoverCapDays,
      carryoverCapMode: settings.carryoverCapMode,
      carryoverCapPercent: settings.carryoverCapPercent,
      defaultTimezone: settings.defaultTimezone,
      hoursPerDay: settings.hoursPerDay,
      countries: await this.listCountriesTx(manager),
      holidayCalendars: await this.listHolidayCalendarsTx(manager),
      updatedAt: settings.updatedAt,
    }
  }

  private async loadSettingsState(
    manager: EntityManager,
  ): Promise<LeaveSettingsState> {
    const row = await manager
      .getRepository(LeaveSettingsEntity)
      .findOneBy({ id: SETTINGS_SINGLETON_ID })
    if (!row) {
      return {
        defaultVacationDays: DEFAULT_VACATION_DAYS,
        defaultSickDays: DEFAULT_SICK_DAYS,
        approvalRequired: true,
        defaultApproverEmails: [],
        defaultCcApproverEmails: [],
        carryoverPolicy: DEFAULT_CARRYOVER_POLICY,
        carryoverCapDays: DEFAULT_CARRYOVER_CAP_DAYS,
        carryoverCapMode: DEFAULT_CARRYOVER_CAP_MODE,
        carryoverCapPercent: DEFAULT_CARRYOVER_CAP_PERCENT,
        defaultTimezone: DEFAULT_TIMEZONE,
        hoursPerDay: DEFAULT_HOURS_PER_DAY,
        updatedAt: new Date(0).toISOString(),
      }
    }
    return {
      defaultVacationDays: row.defaultVacationDays,
      defaultSickDays: row.defaultSickDays,
      // A row written before the column existed reads as null through a stale
      // cached schema; approval stays required until an admin says otherwise.
      approvalRequired: row.approvalRequired ?? true,
      defaultApproverEmails: row.defaultApproverEmails,
      defaultCcApproverEmails: row.defaultCcApproverEmails,
      carryoverPolicy: row.carryoverPolicy,
      carryoverCapDays: row.carryoverCapDays,
      carryoverCapMode: row.carryoverCapMode ?? DEFAULT_CARRYOVER_CAP_MODE,
      carryoverCapPercent:
        row.carryoverCapPercent ?? DEFAULT_CARRYOVER_CAP_PERCENT,
      defaultTimezone: row.defaultTimezone ?? DEFAULT_TIMEZONE,
      // Null only through a stale cached schema, the same way approvalRequired
      // reads above: a workday of no length would divide every booking by zero.
      hoursPerDay: row.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
      updatedAt: row.updatedAt,
    }
  }

  // Non-destructive upsert of ONE (country, year) calendar's holidays.
  async replaceHolidayCalendar(
    input: ReplaceHolidayCalendarInput,
  ): Promise<HolidayCalendarDto> {
    return this.dataSource.transaction(async (manager) => {
      // Snapshot the prior calendar (and its holidays) before the wholesale
      // replace, which otherwise deletes the old holiday rows without reading
      // them — leaving the audit trail no before-state.
      const priorCalendar = await manager
        .getRepository(HolidayCalendarEntity)
        .findOne({
          where: { countryCode: input.countryCode, year: input.year },
          relations: { holidays: true },
        })
      const before = priorCalendar
        ? await this.calendarToDto(manager, priorCalendar)
        : null

      const calendar = await this.upsertHolidayCalendarTx(manager, input)
      const after = await this.calendarToDto(manager, calendar)

      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.HolidayCalendarReplaced,
        entityType: 'holiday_calendar',
        entityId: calendar.id,
        summary: `${before ? 'Updated' : 'Created'} ${input.countryCode} ${input.year} holiday calendar (${after.holidays.length} holiday(s))`,
        before: before ? snapshotCalendar(before) : null,
        after: snapshotCalendar(after),
      })

      return after
    })
  }

  // Copy a source (country, year) calendar into a new target year, shifting each
  // holiday date by the year delta and recording provenance.
  async cloneHolidayCalendar(
    input: CloneHolidayCalendarInput,
  ): Promise<HolidayCalendarDto> {
    return this.dataSource.transaction(async (manager) => {
      if (input.targetYear === input.sourceYear) {
        throw new LeaveDomainValidationError(
          'Clone target year must differ from the source year.',
        )
      }
      const calendarRepo = manager.getRepository(HolidayCalendarEntity)
      const holidayRepo = manager.getRepository(HolidayEntity)
      const source = await calendarRepo.findOne({
        where: { countryCode: input.countryCode, year: input.sourceYear },
        relations: { holidays: true },
      })
      if (!source) {
        throw new LeaveDomainValidationError(
          `No holiday calendar for ${input.countryCode} ${input.sourceYear} to clone.`,
        )
      }
      if (
        await calendarRepo.findOneBy({
          countryCode: input.countryCode,
          year: input.targetYear,
        })
      ) {
        throw new LeaveDomainValidationError(
          `A holiday calendar for ${input.countryCode} ${input.targetYear} already exists.`,
        )
      }
      await this.ensureCountry(manager, input.countryCode)
      const now = this.clock.nowIso()
      const target = await calendarRepo.save(
        calendarRepo.create({
          id: randomUUID(),
          countryCode: input.countryCode,
          year: input.targetYear,
          name: input.name ?? source.name,
          sourceCalendarId: source.id,
          createdAt: now,
          updatedAt: now,
        }),
      )
      // Shift each holiday to the target year; dedupe by shifted date (a Feb-29
      // source can collapse onto Feb-28) to respect the (calendarId, date) unique.
      const shift = input.targetYear - input.sourceYear
      const byDate = new Map<string, HolidayEntity>()
      for (const holiday of source.holidays ?? []) {
        const date = shiftIsoYear(holiday.date, shift)
        byDate.set(
          date,
          holidayRepo.create({
            id: randomUUID(),
            calendarId: target.id,
            date,
            name: holiday.name,
          }),
        )
      }
      if (byDate.size > 0) {
        await holidayRepo.save(Array.from(byDate.values()))
      }

      const dto = await this.calendarToDto(manager, target)
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.HolidayCalendarCloned,
        entityType: 'holiday_calendar',
        entityId: target.id,
        summary: `Cloned ${input.countryCode} ${input.sourceYear} holiday calendar into ${input.targetYear}`,
        after: snapshotCalendar(dto),
      })
      return dto
    })
  }

  // Delete a whole (country, year) calendar; CASCADE removes its holidays.
  async deleteHolidayCalendar(input: DeleteHolidayCalendarInput): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const calendarRepo = manager.getRepository(HolidayCalendarEntity)
      // Load the calendar (and holidays) before deleting so the audit entry can
      // snapshot what was removed; the delete-by-key path never read it.
      const existing = await calendarRepo.findOne({
        where: { countryCode: input.countryCode, year: input.year },
        relations: { holidays: true },
      })
      if (!existing) {
        return
      }
      const before = await this.calendarToDto(manager, existing)
      await calendarRepo.delete({
        countryCode: input.countryCode,
        year: input.year,
      })
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.HolidayCalendarDeleted,
        entityType: 'holiday_calendar',
        entityId: existing.id,
        summary: `Deleted ${input.countryCode} ${input.year} holiday calendar`,
        before: snapshotCalendar(before),
      })
    })
  }

  async listCountries(): Promise<CountryDto[]> {
    return this.listCountriesTx(this.manager)
  }

  // Upsert-by-code: guarantees a country row exists so FKs to countries.code
  // always resolve. Name and timezone are enriched from the country catalog (so
  // an auto-created LDAP country gets a real name + tz); a pre-existing row
  // missing a timezone is backfilled from the catalog. Deliberately backfills
  // ONLY a null zone: an admin who pinned a country to a non-primary office
  // zone must not have it undone by an LDAP-driven upsert.
  private async ensureCountry(
    manager: EntityManager,
    code: string,
  ): Promise<void> {
    const repo = manager.getRepository(CountryEntity)
    const normalized = normalizeCountryCode(code)
    const entry = lookupCountry(normalized)
    const existing = await repo.findOneBy({ code: normalized })
    if (existing) {
      if (!existing.timezone && entry?.timezone) {
        existing.timezone = entry.timezone
        await repo.save(existing)
      }
      return
    }
    await repo.save(
      repo.create({
        id: randomUUID(),
        code: normalized,
        name: entry?.name ?? normalized,
        timezone: entry?.timezone ?? null,
      }),
    )
  }

  private async listCountriesTx(
    manager: EntityManager,
  ): Promise<CountryDto[]> {
    const rows = await manager.getRepository(CountryEntity).find()
    // One grouped count rather than a query per country: the roster is small,
    // but this runs on every settings read. Counts everyone, active or not, to
    // match what the removal guard refuses on.
    //
    // Raw rather than a query builder: `user` is a reserved word in Postgres,
    // so an entity alias of that name lands unquoted in a hand-written select
    // and the statement will not even parse.
    const usageRows: Array<{ code: string; total: string }> = await manager.query(
      'SELECT "countryCode" AS code, COUNT(*) AS total FROM users WHERE "countryCode" IS NOT NULL GROUP BY "countryCode"',
    )
    // COUNT returns bigint, which the driver hands back as a string.
    const usage = new Map(
      usageRows.map((row) => [row.code, Number(row.total)] as const),
    )
    return rows
      .map((row) => ({
        code: row.code,
        name: row.name,
        timezone: orUndefined(row.timezone),
        assignedUsers: usage.get(row.code) ?? 0,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async getHolidayCalendar(
    countryCode: string,
    year: number,
  ): Promise<HolidayCalendarDto | null> {
    return this.dataSource.transaction(async (manager) => {
      const calendar = await manager
        .getRepository(HolidayCalendarEntity)
        .findOne({ where: { countryCode, year }, relations: { holidays: true } })
      return calendar ? this.calendarToDto(manager, calendar) : null
    })
  }

  async listHolidayCalendars(
    query?: ListHolidaysQueryDto,
  ): Promise<HolidayCalendarDto[]> {
    return this.listHolidayCalendarsTx(this.manager, query)
  }

  private async listHolidayCalendarsTx(
    manager: EntityManager,
    query?: ListHolidaysQueryDto,
  ): Promise<HolidayCalendarDto[]> {
    const calendars = await manager.getRepository(HolidayCalendarEntity).find({
      where: {
        ...(query?.countryCode ? { countryCode: query.countryCode } : {}),
        ...(query?.year ? { year: query.year } : {}),
      },
      relations: { holidays: true },
    })
    const dtos = await Promise.all(
      calendars.map((calendar) => this.calendarToDto(manager, calendar)),
    )
    // Group by country, then by year, so the admin list reads naturally.
    return dtos.sort(
      (left, right) =>
        left.country.name.localeCompare(right.country.name) ||
        left.year - right.year,
    )
  }

  // Find-or-create the (countryCode, year) calendar and replace only its
  // holidays. Every other calendar is left untouched.
  private async upsertHolidayCalendarTx(
    manager: EntityManager,
    input: ReplaceHolidayCalendarInput,
  ): Promise<HolidayCalendarEntity> {
    await this.ensureCountry(manager, input.countryCode)
    if (input.countryName) {
      const countryRepo = manager.getRepository(CountryEntity)
      const existing = await countryRepo.findOneBy({ code: input.countryCode })
      if (existing && existing.name !== input.countryName) {
        existing.name = input.countryName
        await countryRepo.save(existing)
      }
    }

    const calendarRepo = manager.getRepository(HolidayCalendarEntity)
    const holidayRepo = manager.getRepository(HolidayEntity)
    const now = this.clock.nowIso()
    let calendar = await calendarRepo.findOneBy({
      countryCode: input.countryCode,
      year: input.year,
    })
    if (!calendar) {
      calendar = await calendarRepo.save(
        calendarRepo.create({
          id: randomUUID(),
          countryCode: input.countryCode,
          year: input.year,
          name: input.name ?? null,
          sourceCalendarId: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
    } else {
      // Distinguish "not provided" (undefined -> keep) from an explicit null
      // (the form's cleared name field -> blank it).
      calendar.name = input.name !== undefined ? input.name : calendar.name
      calendar.updatedAt = now
      await calendarRepo.save(calendar)
    }

    // Replace this calendar's holidays. Dedupe by date (last-wins) and validate
    // each date falls inside the calendar's year (the year guard that a
    // cross-row DB CHECK cannot express is enforced here).
    await holidayRepo.delete({ calendarId: calendar.id })
    const byDate = new Map<string, HolidayEntryDto>()
    for (const holiday of input.holidays) {
      if (getYearFromIsoDate(holiday.date) !== input.year) {
        throw new LeaveDomainValidationError(
          `Holiday ${holiday.date} does not fall in ${input.year}.`,
        )
      }
      byDate.set(holiday.date, holiday)
    }
    const deduped = Array.from(byDate.values())
    if (deduped.length > 0) {
      await holidayRepo.save(
        deduped.map((holiday) =>
          holidayRepo.create({
            id: randomUUID(),
            calendarId: calendar!.id,
            date: holiday.date,
            name: holiday.name,
          }),
        ),
      )
    }
    return calendar
  }

  private async calendarToDto(
    manager: EntityManager,
    calendar: HolidayCalendarEntity,
  ): Promise<HolidayCalendarDto> {
    const countryRow = await manager
      .getRepository(CountryEntity)
      .findOneBy({ code: calendar.countryCode })
    const country: CountryDto = countryRow
      ? { code: countryRow.code, name: countryRow.name }
      : { code: calendar.countryCode, name: calendar.countryCode }
    const holidays =
      calendar.holidays ??
      (await manager
        .getRepository(HolidayEntity)
        .findBy({ calendarId: calendar.id }))
    return {
      calendarId: calendar.id,
      country,
      year: calendar.year,
      name: calendar.name,
      sourceCalendarId: calendar.sourceCalendarId,
      holidays: holidays
        .map((holiday) => ({
          holidayId: holiday.id,
          date: holiday.date,
          name: holiday.name,
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    }
  }

  // Holiday dates for a country across every year the period spans — a
  // request may cross the New Year, so both years' calendars matter.
  private async holidayDatesForPeriod(
    manager: EntityManager,
    countryCode: string,
    startDate: string,
    endDate: string,
  ): Promise<Set<string>> {
    const startYear = getYearFromIsoDate(startDate)
    const endYear = getYearFromIsoDate(endDate)
    const years: number[] = []
    for (let year = startYear; year <= endYear; year += 1) {
      years.push(year)
    }
    const calendars = await manager.getRepository(HolidayCalendarEntity).find({
      where: years.map((year) => ({ countryCode, year })),
      relations: { holidays: true },
    })
    const dates = new Set<string>()
    for (const calendar of calendars) {
      for (const holiday of calendar.holidays ?? []) {
        dates.add(holiday.date)
      }
    }
    return dates
  }

  // ------------------------------------------------------------- balances ----

  async initializeBalancesForUser(
    userId: string,
    occurredAt?: string,
  ): Promise<LeaveBalanceDto[]> {
    const at = occurredAt ?? this.clock.nowIso()
    return this.dataSource.transaction((manager) =>
      this.initializeBalancesTx(manager, userId, at),
    )
  }

  private async initializeBalancesTx(
    manager: EntityManager,
    userId: string,
    occurredAt: string,
  ): Promise<LeaveBalanceDto[]> {
    const user = await this.requireUser(manager, userId)
    const asOf = await this.resolveAsOfTx(manager, user, occurredAt)
    const year = getYearFromIsoDate(asOf.day)
    for (const leaveType of ALL_LEAVE_TYPES) {
      await this.ensureBalance(manager, userId, leaveType, year, asOf)
    }
    // Bring the freshly created ledger up to the current month so a user who
    // signs up mid-year immediately sees the days they have accrued so far.
    await this.refreshBalancesTx(manager, userId, occurredAt)
    return this.buildBalanceDtos(manager, userId, occurredAt)
  }

  /**
   * Bring a user's derived balances up to date as of `asOfIso`: credit the
   * monthly allowance owed up to the current calendar month, close any leave
   * year that has ended, and move approved leave whose dates have passed from
   * hold into spent. Idempotent. This is the single production driver for
   * accrual and consumption; every balance read and submission calls it first.
   *
   * The catch-up replays these IN THE ORDER THEY REALLY HAPPENED, not accruals
   * first and consumption after. Accrual is driven by reads, so one refresh can
   * cover months of dormancy, and the ledger is ordered by insertion (the row
   * carries no instant of its own, only the date it belongs to). Writing every
   * accrual before every spend therefore filed a June leave day after the
   * August accrual: the timeline showed June twice, and the running balance
   * frozen on each row read backwards. So the pass walks the boundaries the
   * balance was due to move at, settling elapsed leave up to each one before
   * that boundary's own rows land.
   */
  async refreshBalances(
    userId: string,
    asOfIso?: string,
  ): Promise<void> {
    const asOf = asOfIso ?? this.clock.nowIso()
    await this.dataSource.transaction((manager) =>
      this.refreshBalancesTx(manager, userId, asOf),
    )
  }

  private async refreshBalancesTx(
    manager: EntityManager,
    userId: string,
    asOfIso: string,
  ): Promise<void> {
    const user = await manager
      .getRepository(UserEntity)
      .findOneBy({ id: userId })
    // Which leave year "now" belongs to is a calendar question, so it is asked
    // of the employee's own calendar: at 00:30 on New Year's night in Kyiv the
    // answer is the new year, even though UTC is still two hours short of it.
    const asOf = await this.resolveAsOfTx(manager, user, asOfIso)
    const year = getYearFromIsoDate(asOf.day)
    const anchor = user?.employmentStartDate ?? null
    for (const leaveType of ALL_LEAVE_TYPES) {
      await this.ensureBalance(manager, userId, leaveType, year, asOf)
    }

    const plan = await this.planCatchUpTx(manager, userId, user, asOf, anchor)
    if (plan.boundaries.length > 0) {
      const settings = await this.loadSettingsState(manager)
      // The employee's own zone, the same one spend recognition uses: a month
      // begins for this person when THEIR midnight strikes, and the boundary
      // has to sit on the same clock as the leave days it separates.
      const tz = await this.resolveTimezoneTx(manager, user, settings)
      for (const day of plan.boundaries) {
        const boundaryYear = getYearFromIsoDate(day)
        const boundaryMonth = monthOfIsoDate(day)
        // The instant the month begins, expressed as the midnight that ENDS the
        // day before it — the same helper, and the same convention, spend
        // recognition is filtered by. Reconcile's `<=` then puts a leave day
        // that ends exactly on that stroke (the last day of the month) in the
        // slice BEFORE the boundary, which is where it belongs.
        const boundaryIso = endOfDayUtc(
          boundaryMonth === 1
            ? `${boundaryYear - 1}-12-31`
            : lastDayOfMonthIso(boundaryYear, boundaryMonth - 1),
          tz,
        ).toISOString()
        await this.reconcileApprovedLeaveTx(manager, {
          userId,
          asOfIso: boundaryIso,
        })
        // The year comes from the BOUNDARY, never from asOf: a January boundary
        // closes the year that just ended and opens the one that just began,
        // which is how the carryover rows land between December's spends and
        // January's.
        for (const leaveType of ALL_LEAVE_TYPES) {
          await this.accrueDueAllowance(
            manager,
            userId,
            leaveType,
            boundaryYear,
            { iso: boundaryIso, day },
            anchor,
          )
        }
      }
    }

    // The tail, at the real instant. It is the safety net rather than the main
    // event: anything the plan could not foresee — a month whose delta only
    // appears once a close has credited the carryover, a year that settles
    // without booking a row — still lands here, exactly as it did before this
    // walk existed. When there is nothing pending at all it is skipped, because
    // the plan above asked the very questions it would ask.
    if (plan.hasPendingWork) {
      for (const leaveType of ALL_LEAVE_TYPES) {
        await this.accrueDueAllowance(
          manager,
          userId,
          leaveType,
          year,
          asOf,
          anchor,
        )
      }
    }
    await this.reconcileApprovedLeaveTx(manager, {
      userId,
      asOfIso,
    })
  }

  /**
   * What the catch-up still owes, without writing any of it.
   *
   * `boundaries` are the moments the balance was due to move at, ascending and
   * deduplicated across leave types: the 1st of every month that still owes an
   * accrual, and the 1st of January of every year whose close will book rows.
   * `hasPendingWork` says whether an accrual pass at the real instant is still
   * needed at all — false means no month is owed and no year awaits its close,
   * so the pass would provably write nothing and the caller can skip it.
   *
   * Every read here is one the accrual pass had to do anyway, which is what
   * lets the common case (nothing owed, just a spend reconcile) stay as cheap
   * as it was before the walk existed.
   */
  private async planCatchUpTx(
    manager: EntityManager,
    userId: string,
    user: UserEntity | null,
    asOf: AsOf,
    anchor: string | null,
  ): Promise<{ boundaries: string[]; hasPendingWork: boolean }> {
    // No employment anchor: nothing accrues and no year can be closed for real,
    // so there is nothing to order. Mirrors the guards in finalizeCarryoverIfDue
    // and accrualScheduleForYear.
    if (!anchor) {
      return { boundaries: [], hasPendingWork: false }
    }
    const currentYear = getYearFromIsoDate(asOf.day)
    const anchorYear = getYearFromIsoDate(anchor)
    // The same floor the close walks to: years that ended before this system
    // met the employee settle trivially, without a single ledger row, so they
    // need no boundary of their own.
    const epochYear = Math.max(
      anchorYear,
      user ? getYearFromIsoDate(user.createdAt.slice(0, 10)) : anchorYear,
    )
    const allocationRepo = manager.getRepository(LeaveAllocationEntity)
    const boundaries = new Set<string>()
    let hasPendingWork = false
    for (const leaveType of ALL_LEAVE_TYPES) {
      // finalizeCarryoverIfDue's own pending query, so the walk offers a
      // boundary for exactly the closes that are going to happen.
      const pending = await allocationRepo.find({
        where: {
          userId,
          leaveType,
          carryoverFinalized: false,
          year: LessThanOrEqual(currentYear),
        },
        order: { year: 'ASC' },
        take: MAX_CARRYOVER_FINALIZATION_YEARS,
      })
      hasPendingWork ||= pending.length > 0
      for (const allocation of pending) {
        if (allocation.year <= epochYear) {
          continue
        }
        boundaries.add(firstOfMonthIso(allocation.year, 1))
        // A close tops the prior year up to its full twelve twelfths before it
        // carries anything over, and those months belong at their own
        // boundaries rather than in a block against the year end. Only for a
        // year already on the books, though: materializing one is a write, and
        // the close does that under its own lock.
        const prior = await allocationRepo.findOneBy({
          userId,
          leaveType,
          year: allocation.year - 1,
        })
        if (!prior || prior.closedAt) {
          continue
        }
        for (const row of await this.planAccrualForYear(
          manager,
          userId,
          leaveType,
          allocation.year - 1,
          asOf,
          anchor,
        )) {
          boundaries.add(row.effectiveDate)
        }
      }
      const owed = await this.planAccrualForYear(
        manager,
        userId,
        leaveType,
        currentYear,
        asOf,
        anchor,
      )
      hasPendingWork ||= owed.length > 0
      for (const row of owed) {
        boundaries.add(row.effectiveDate)
      }
    }
    return { boundaries: [...boundaries].sort(), hasPendingWork }
  }

  async getBalance(
    userId: string,
    leaveType: LeaveType,
  ): Promise<LeaveBalanceDto> {
    return this.dataSource.transaction(async (manager) => {
      const asOf = await this.resolveAsOfTx(manager, userId, this.clock.nowIso())
      const year = getYearFromIsoDate(asOf.day)
      const balance = await this.ensureBalance(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      const allocation = await this.ensureAllocation(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      return balanceToDto(balance, allocation.totalDays)
    })
  }

  /**
   * Today's leave year on THIS employee's calendar — the year an admin edit
   * lands on when the request names no year.
   *
   * Employee-scoped rather than system-scoped, and that is the whole point:
   * the allocation editor is seeded from balances built on the employee's
   * calendar and posts a totalDays with no year of its own. Defaulting on the
   * server's calendar instead would, in the hours where the two disagree, write
   * the new total to a year nobody was looking at and leave the displayed one
   * untouched — a save that reads as ignored.
   */
  async currentLeaveYearFor(userId: string): Promise<number> {
    const asOf = await this.resolveAsOfTx(
      this.manager,
      userId,
      this.clock.nowIso(),
    )
    return getYearFromIsoDate(asOf.day)
  }

  async getBalances(userId: string): Promise<LeaveBalanceDto[]> {
    return this.dataSource.transaction((manager) =>
      this.buildBalanceDtos(manager, userId),
    )
  }

  private async buildBalanceDtos(
    manager: EntityManager,
    userId: string,
    asOfIso?: string,
  ): Promise<LeaveBalanceDto[]> {
    const balances: LeaveBalanceDto[] = []
    const user = await manager
      .getRepository(UserEntity)
      .findOneBy({ id: userId })
    const asOf = await this.resolveAsOfTx(
      manager,
      user,
      asOfIso ?? this.clock.nowIso(),
    )
    const year = getYearFromIsoDate(asOf.day)
    const anchor = user?.employmentStartDate ?? null
    for (const leaveType of ALL_LEAVE_TYPES) {
      const balance = await this.ensureBalance(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      const allocation = await this.ensureAllocation(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      // What is left to plan with for the rest of the year. Now that a hold can
      // sit against days that have not accrued yet, "available" alone no longer
      // answers the question an employee is actually asking.
      const report = await this.evaluatePlannedCommitments(manager, {
        userId,
        leaveType,
        nowDay: asOf.day,
        anchor,
      })
      const projection = report.projections.get(year)
      const displayTotal = roundDays(
        allocation.totalDays +
          (leaveType === LeaveType.Vacation
            ? allocation.manualAdjustmentDays
            : 0),
      )
      balances.push({
        ...balanceToDto(balance, displayTotal),
        carriedOverDays: allocation.carriedOverDays,
        ...(projection
          ? {
              projectedRemainingDays: roundDays(
                projection.projectedYearEndAccrual -
                  projection.spentDays -
                  committedCost(projection.committedEntries),
              ),
              ...(projection.policyChangedDuringYear
                ? { policyChangedDuringYear: true }
                : {}),
            }
          : {}),
      })
    }
    return balances
  }

  async getBalanceTimeline(
    userId: string,
    leaveType?: LeaveType,
  ): Promise<LeaveBalanceChangeDto[]> {
    await this.requireUser(this.manager, userId)
    return this.getBalanceTimelineTx(this.manager, userId, leaveType)
  }

  private async getBalanceTimelineTx(
    manager: EntityManager,
    userId: string,
    leaveType?: LeaveType,
  ): Promise<LeaveBalanceChangeDto[]> {
    const rows = await manager.getRepository(LeaveBalanceChangeEntity).find({
      where: leaveType ? { userId, leaveType } : { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    })
    return rows.map(ledgerToChangeDto)
  }

  /**
   * The policy engine's entry into the accrual math: the year's rate schedule
   * derived from the user's LIVE membership timeline. Returns null when the
   * user has no membership rows at all, and callers then fall back to the
   * pre-engine allocation-clone/settings path.
   *
   * That null branch is PERMANENT, not a migration leftover. In production it
   * is unreachable once the cutover has run (the bootstrap enrolled everyone,
   * and provisioning enrolls each new account), but the spec corpus depends on
   * it: hundreds of cases fabricate entitlements by editing the settings
   * defaults, which policy terms deliberately cannot reproduce because they
   * are immutable. Keeping the fallback keeps those fixtures meaningful.
   */
  private async resolvePolicyScheduleTx(
    manager: EntityManager,
    userId: string,
    year: number,
    anchorDate: string | null,
  ): Promise<PolicyYearSchedule | null> {
    const rows = await manager
      .getRepository(LeavePolicyMembershipEntity)
      .find({
        where: { userId, supersededByRowId: IsNull() },
        order: { effectiveFrom: 'ASC' },
      })
    if (rows.length === 0) {
      return null
    }
    const policyIds = [...new Set(rows.map((membership) => membership.policyId))]
    const policies = await manager
      .getRepository(LeavePolicyEntity)
      .findBy({ id: In(policyIds) })
    const policiesById = new Map<string, PolicyTermsInput>(
      policies.map((policy) => [
        policy.id,
        {
          policyId: policy.id,
          name: policy.name,
          vacationDays: policy.vacationDays,
          sickDays: policy.sickDays,
          vacationAnnualIncrement: policy.vacationAnnualIncrement,
          vacationIncrementEveryYears: policy.vacationIncrementEveryYears,
          vacationIncrementCapDays: policy.vacationIncrementCapDays,
        },
      ]),
    )
    return deriveYearSchedule(
      year,
      rows.map((membership) => ({
        policyId: membership.policyId,
        effectiveFrom: membership.effectiveFrom,
        effectiveTo: membership.effectiveTo,
        supersededByRowId: membership.supersededByRowId,
      })),
      policiesById,
      anchorDate,
    )
  }

  /**
   * The per-day policy timeline for probation gating. Unlike the accrual
   * schedule (month-granular by design), probation and its paid-sick flag
   * follow the exact day a membership boundary names, so the gate reads the
   * raw timeline plus full policy rows. Null = no memberships (the
   * pre-bootstrap legacy state) — no probation exists there.
   */
  private async loadPolicyTimelineTx(
    manager: EntityManager,
    userId: string,
  ): Promise<PolicyTimeline | null> {
    const rows = await manager
      .getRepository(LeavePolicyMembershipEntity)
      .find({
        where: { userId, supersededByRowId: IsNull() },
        order: { effectiveFrom: 'ASC' },
      })
    if (rows.length === 0) {
      return null
    }
    const policies = await manager
      .getRepository(LeavePolicyEntity)
      .findBy({ id: In([...new Set(rows.map((row) => row.policyId))]) })
    return {
      rows,
      policiesById: new Map(policies.map((policy) => [policy.id, policy])),
    }
  }

  /**
   * Ensure a per-(user, leaveType, year) allocation exists. Under the policy
   * engine the year is born from the membership timeline (resolver-first);
   * for users with no memberships yet the legacy seeding survives: clone the
   * prior year's allocation, else the settings default. This is the source of
   * truth for the annual `totalDays` (a derived cache of the policy engine
   * once memberships exist).
   */
  private async ensureAllocation(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf?: AsOf,
  ): Promise<LeaveAllocationEntity> {
    asOf ??= asOfInstant(this.clock.nowIso())
    const occurredAt = asOf.iso
    const repo = manager.getRepository(LeaveAllocationEntity)
    const existing = await repo.findOneBy({ userId, leaveType, year })
    if (existing) {
      return existing
    }
    // Resolver-first: a user with a membership timeline gets the year's
    // totalDays from their policies (increment steps included). The legacy
    // clone-else-settings chain survives only for the no-membership fallback
    // and must stay in lockstep with resolveProjectionInputs.
    const user = await manager
      .getRepository(UserEntity)
      .findOneBy({ id: userId })
    const policySchedule = await this.resolvePolicyScheduleTx(
      manager,
      userId,
      year,
      user?.employmentStartDate ?? null,
    )
    let totalDays: number
    let sourcePolicyId: string | null = null
    let seededNote: string | null = null
    if (policySchedule) {
      totalDays = scheduleYearEndTotal(leaveType, policySchedule)
      const december =
        policySchedule.segments[policySchedule.segments.length - 1]!
      sourcePolicyId = december.policyId
      seededNote = policySchedule.changedDuringYear
        ? `Resolved from policies: ${policySchedule.segments
            .map((segment) => segment.policyName)
            .join(' -> ')}`
        : `Resolved from policy: ${december.policyName}`
    } else {
      const prior = await repo.findOneBy({ userId, leaveType, year: year - 1 })
      const settings = await this.loadSettingsState(manager)
      totalDays = prior
        ? prior.totalDays
        : leaveType === LeaveType.Vacation
          ? settings.defaultVacationDays
          : settings.defaultSickDays
      seededNote = prior ? 'Rolled over from the prior year' : null
    }
    // NEVER finalized here, prior row or not: the year close
    // (finalizeCarryoverIfDue) is the SINGLE place carryover is computed,
    // booked to the ledger, and finalized. Deciding it here would skip the
    // close's prior-year top-up to 12/12 and its ledger rows — exactly the
    // dormant-account hole this used to have. Even the trivial cases (an
    // account's first year, a pre-employment year) are the walk's call: it
    // holds the employment anchor and settles them without materializing
    // anything, while a missing-prior row here says nothing — the prior year
    // may simply never have been touched yet.
    const created = repo.create({
      id: randomUUID(),
      userId,
      year,
      leaveType,
      totalDays,
      carriedOverDays: 0,
      manualAdjustmentDays: 0,
      carryoverFinalized: false,
      accrualStartDate: null,
      setByUserId: null,
      sourcePolicyId,
      note: seededNote,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    return repo.save(created)
  }

  /**
   * CLOSE every year that has begun and still awaits its carryover, oldest
   * first — the single place the year rollover is computed, BOOKED, and
   * finalized. Booking leave into a future year creates its allocation early,
   * when the prior year's leftover is still unknowable; this is the choke
   * point that settles the real figure afterwards.
   *
   * The close is double-entry bookkeeping, so the Balance Timeline tells the
   * whole story on both sides of the boundary:
   *   old year:  carryover_out −K (days that move on), expired −B (days the
   *              policy does not keep — they burn)
   *   new year:  carryover_in  +K
   * After the close the old year's accrued folds exactly to spent + onHold:
   * the leftover has genuinely LEFT it. That is what makes a backdated request
   * into a closed year honest — the days it can still pay with are the days
   * that actually remained, not days that were burnt or are simultaneously
   * funding next-year leave as carryover (the double-spend this kills).
   *
   * Each year is finalized only after topping up its PRIOR year to a full
   * twelve months: a completed year targets 12/12, but nothing forces a refresh
   * in December, so an account dormant since summer would otherwise carry over
   * from an under-accrued balance. Iterative (never recursive) with a hard
   * bound, so an odd chain of unfinalized years cannot walk back indefinitely.
   *
   * The walk only re-lives years the SYSTEM lived through: its floor is the
   * later of the hire year and the year the user row was created. Years
   * before that are settled trivially (zero carryover, no rows) — filling
   * them with real balances is the history import's job, never this walk's.
   */
  private async finalizeCarryoverIfDue(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf: AsOf,
    anchor: string | null,
  ): Promise<void> {
    const currentYear = getYearFromIsoDate(asOf.day)
    if (year > currentYear) {
      return
    }
    // No employment anchor means nothing has ever accrued and no leftover can
    // exist or be computed: leave every year pending rather than settling it
    // trivially, so setting the start date later (possibly into the past)
    // still finds the boundary unsettled. The pending query is one indexed
    // read per refresh — cheap to repeat until the anchor arrives.
    if (!anchor) {
      return
    }
    const anchorYear = getYearFromIsoDate(anchor)
    const repo = manager.getRepository(LeaveAllocationEntity)
    // Every year that has begun and is still waiting for its carryover, oldest
    // first: finalizing an older year changes the leftover the next one carries
    // from. Queried rather than walked backwards from `year`, because a year
    // can be skipped entirely — booking into 2027 during 2026 and then not
    // touching the account until 2028 leaves 2027 unfinalized with 2028 already
    // settled, and a backwards walk would stop at 2028 and never reach it.
    const findPending = () =>
      repo.find({
        where: {
          userId,
          leaveType,
          carryoverFinalized: false,
          year: LessThanOrEqual(currentYear),
        },
        order: { year: 'ASC' },
        take: MAX_CARRYOVER_FINALIZATION_YEARS,
      })
    if ((await findPending()).length === 0) {
      return
    }
    // The system's own memory of a user begins the year the system MET them
    // (the user row's creation), not the year they were hired. Years that
    // ended before that are the history import's territory: it seeds the
    // opening carryover from the source tracker and settles those years as
    // closed zeros. The walk must never re-live them on its own — an admin
    // backdating a start date to 2001, or a test reset scrubbing the import's
    // settled years, would otherwise fabricate two decades of accrual and a
    // carryover chain nobody earned inside this system. Everything from the
    // creation year on IS this system's history (a dormant account still
    // closes its slept-through years for real), so the boundary is the LATER
    // of hire year and creation year. Fetched only on the rare pending path,
    // one primary-key read per settling refresh.
    const walkUser = await manager
      .getRepository(UserEntity)
      .findOneBy({ id: userId })
    const boundaryYear = Math.max(
      anchorYear,
      walkUser ? getYearFromIsoDate(walkUser.createdAt.slice(0, 10)) : anchorYear,
    )
    // The close appends ledger rows, and nothing else serializes two first
    // reads of a fresh year (the submit lock is not taken on the read path):
    // without this, both would post the close and the append-only ledger would
    // carry it twice. Keyed by USER, not (user, leaveType): a per-type close
    // key could deadlock against the per-type submit locks when two types
    // close in one pass. Re-entrant within the transaction, so the second
    // leave type's pass through here is free.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:carryover-close`,
    ])
    // Re-read under the lock: a concurrent transaction may have closed these
    // years while this one waited. Then materialize every missing IN-SYSTEM
    // year between the boundary and each pending one — an account dormant
    // across a whole calendar year has no allocation rows for the years it
    // slept through, yet each of those boundaries still needs a real close.
    // Materialized rows are born unfinalized, so the second read picks them
    // up and the walk settles the chain oldest-first. The floor never dips
    // below the boundary: pre-boundary years get no rows at all.
    for (const allocation of await findPending()) {
      const floor = Math.max(
        boundaryYear,
        allocation.year - MAX_CARRYOVER_FINALIZATION_YEARS,
      )
      for (let missing = allocation.year - 1; missing >= floor; missing -= 1) {
        const exists = await repo.findOneBy({ userId, leaveType, year: missing })
        if (exists) {
          break
        }
        await this.ensureAllocation(manager, userId, leaveType, missing, asOf)
      }
    }
    const pending = (await findPending()).map((allocation) => allocation.year)

    const settings = await this.loadSettingsState(manager)
    const balanceRepo = manager.getRepository(LeaveBalanceEntity)
    for (const target of pending) {
      const priorYear = target - 1
      // A target at or before the boundary has no prior year THIS SYSTEM
      // lived through — either the employee was not yet hired, or the system
      // had not met them and that history belongs to the import. There is
      // nothing to top up, carry or burn. Settle it trivially — zero
      // carryover, no ledger rows, no prior-year materialization — and
      // deliberately do NOT mark the prior year closed: it never existed
      // here.
      if (boundaryYear >= target) {
        const trivial = await repo.findOneBy({ userId, leaveType, year: target })
        if (trivial) {
          trivial.carriedOverDays = 0
          trivial.carryoverFinalized = true
          trivial.updatedAt = asOf.iso
          await repo.save(trivial)
        }
        continue
      }
      // Resolved ONCE per closing year and fed to both the top-up below and
      // the cap base further down: two independent resolves could straddle a
      // concurrently committed membership change and cap the leftover against
      // a schedule the accrual never targeted.
      const priorSchedule = await this.resolvePolicyScheduleTx(
        manager,
        userId,
        priorYear,
        anchor,
      )
      // accrueForYear, not accrueDueAllowance: the latter funnels back into
      // this method, and the pending list already covers the whole chain.
      await this.accrueForYear(
        manager,
        userId,
        leaveType,
        priorYear,
        asOf,
        anchor,
        priorSchedule,
      )
      const allocation = await repo.findOneBy({ userId, leaveType, year: target })
      if (!allocation) {
        continue
      }
      // Leftover = the prior year's still-available days: accrued but neither
      // spent nor held. Held days are deliberately NEITHER carried NOR burnt —
      // their request is still pending; if it is later rejected, the release
      // returns them into the closed year, spendable only by backdated leave.
      const priorBalance = await balanceRepo.findOneBy({
        userId,
        leaveType,
        year: priorYear,
      })
      const leftover = Math.max(
        0,
        roundDays(
          (priorBalance?.accruedDays ?? 0) -
            (priorBalance?.spentDays ?? 0) -
            (priorBalance?.onHoldDays ?? 0),
        ),
      )
      // The closing year's own row, loaded BEFORE the cap is applied because
      // the cap base folds in its manualAdjustmentDays and the membership-less
      // fallback reads its totalDays — and stamped closed further down, from
      // this same object. Never null in practice: the accrueForYear above
      // ensures the prior year's allocation.
      const priorAllocation = await repo.findOneBy({
        userId,
        leaveType,
        year: priorYear,
      })
      // The percent_of_total base is the closing year's EARNED entitlement —
      // hire-month prorated, manual adjustments included — derived from the
      // SAME schedule the top-up above accrued against, so the ceiling can
      // never disagree with the target the leftover was measured toward. For a
      // user without memberships the legacy schedule keeps the stored
      // totalDays as the annual rate (prorated the same way); the old
      // stored-figure read also guarded per-year admin overrides, but that
      // endpoint is gone and a reanchor never preserved them anyway.
      const priorCapBase = carryoverCapBaseDays(
        leaveType,
        priorSchedule ??
          legacyScheduleFromTotal(priorAllocation?.totalDays ?? 0),
        priorYear,
        anchor,
        priorAllocation?.manualAdjustmentDays ?? 0,
      )
      const kept = applyCarryoverPolicy(
        leftover,
        carryoverPolicyFor(leaveType, settings),
        settings,
        priorCapBase,
      )
      const burnt = roundDays(leftover - kept)

      // Out/expired are dated to the old year's LAST day: they settle that
      // year, so they belong in its December group, right beside the accruals
      // they settle — and the old year's ledger then folds to spent + onHold.
      // The instant is the caller's, which on a catch-up is the New Year
      // boundary itself: the close is written between the days the old year
      // ended with and the days the new one begins with.
      if (kept > 0) {
        await this.recordBalanceChange(manager, {
          userId,
          leaveType,
          year: priorYear,
          reason: LeaveBalanceChangeReason.CarryoverOut,
          effectiveDate: `${priorYear}-12-31`,
          occurredAt: asOf.iso,
          deltaDays: kept,
          onHoldDelta: 0,
          spentDelta: 0,
          accruedDelta: -kept,
          note: `Carried over to ${target}`,
        })
      }
      if (burnt > 0) {
        // A hire-year burn under percent_of_total answers to a ceiling that is
        // NOT pct * the annual allowance the dashboard shows — say so in the
        // note, or "50%-of-allowance" beside the burnt days reads as a math
        // error to the one employee group whose ceiling is prorated.
        const proratedHireYear =
          settings.carryoverCapMode === CarryoverCapMode.PercentOfTotal &&
          getYearFromIsoDate(anchor) === priorYear &&
          effectiveHireMonth(priorYear, anchor) > 1
        await this.recordBalanceChange(manager, {
          userId,
          leaveType,
          year: priorYear,
          reason: LeaveBalanceChangeReason.Expired,
          effectiveDate: `${priorYear}-12-31`,
          occurredAt: asOf.iso,
          deltaDays: burnt,
          onHoldDelta: 0,
          spentDelta: 0,
          accruedDelta: -burnt,
          note:
            kept > 0
              ? `Expired at the end of ${priorYear} (over the ${carryoverCapLabel(settings)}${proratedHireYear ? ', prorated for the hire year' : ''})`
              : `Expired at the end of ${priorYear}`,
        })
      }
      if (kept > 0) {
        await this.recordBalanceChange(manager, {
          userId,
          leaveType,
          year: target,
          reason: LeaveBalanceChangeReason.CarryoverIn,
          effectiveDate: `${target}-01-01`,
          occurredAt: asOf.iso,
          deltaDays: kept,
          onHoldDelta: 0,
          spentDelta: 0,
          accruedDelta: kept,
          note: `Carried over from ${priorYear}`,
        })
      }

      // The prior year is now CLOSED: its leftover has been booked out. The
      // marker lives on that year's own row — never inferred from this one —
      // and is what accrueForYear and reanchorAccrual refuse on. The row was
      // loaded above, before the cap that reads its totalDays.
      if (priorAllocation) {
        priorAllocation.closedAt = asOf.iso
        priorAllocation.updatedAt = asOf.iso
        await repo.save(priorAllocation)
      }

      // The allocation's carriedOverDays keeps feeding the accrual TARGET
      // (accrualTargetDays adds it at every cumulative point), while the
      // carryover_in row above already put the same days into accruedDays —
      // so the first month's accrual delta stays exactly one monthly tranche,
      // never the tranche plus the carryover again.
      allocation.carriedOverDays = kept
      allocation.carryoverFinalized = true
      allocation.updatedAt = asOf.iso
      await repo.save(allocation)
    }
  }

  private async ensureBalance(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf?: AsOf,
  ): Promise<LeaveBalanceEntity> {
    asOf ??= asOfInstant(this.clock.nowIso())
    const repo = manager.getRepository(LeaveBalanceEntity)
    const existing = await repo.findOneBy({ userId, leaveType, year })
    if (existing) {
      return existing
    }
    // Start empty; the ledger (accrual entries) is the source of truth for how
    // many days have accrued. Ensure the annual allocation exists (lazy year
    // rollover) even though its totalDays is read separately at display time.
    await this.ensureAllocation(manager, userId, leaveType, year, asOf)
    const created = repo.create({
      id: randomUUID(),
      userId,
      leaveType,
      year,
      accruedDays: 0,
      onHoldDays: 0,
      spentDays: 0,
      updatedAt: asOf.iso,
    })
    return repo.save(created)
  }

  /**
   * Accrue the allowance owed as of `asOf`. Vacation accrues totalDays/12 per
   * month toward a cumulative target of totalDays * month / 12, reaching the
   * full allocation exactly in December with no fractional days lost. Sick
   * leave is credited up front in one tranche, prorated by the months of the
   * year the employee is there for. Both start from the effective hire month
   * (see accrualScheduleForYear for the half-month rule).
   */
  private async accrueDueAllowance(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf: AsOf,
    anchorDate?: string | null,
  ): Promise<void> {
    // Every accrual path passes through here, which makes it the one place a
    // year materialized ahead of time can have its carryover settled once it
    // actually begins. The top-up runs first so the accrual below already sees
    // the final carryover in its target.
    await this.finalizeCarryoverIfDue(
      manager,
      userId,
      leaveType,
      year,
      asOf,
      anchorDate ?? null,
    )
    await this.accrueForYear(manager, userId, leaveType, year, asOf, anchorDate)
  }

  // The accrual itself: bring `year` up to its cumulative target. Split out so
  // finalizeCarryoverIfDue can top up a prior year without re-entering it.
  // `preresolvedSchedule` lets that caller resolve the year's schedule ONCE and
  // feed both this top-up and the carryover cap base from it, so the two can
  // never read the membership timeline at different instants; `undefined`
  // means "resolve here", while an explicit null is a resolver result that
  // already said "no memberships" and must fall through to the legacy schedule
  // without a second resolve.
  private async accrueForYear(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf: AsOf,
    anchorDate?: string | null,
    preresolvedSchedule?: PolicyYearSchedule | null,
  ): Promise<void> {
    const owed = await this.planAccrualForYear(
      manager,
      userId,
      leaveType,
      year,
      asOf,
      anchorDate,
      preresolvedSchedule,
    )
    for (const row of owed) {
      await this.recordBalanceChange(manager, {
        userId,
        leaveType,
        year,
        reason: LeaveBalanceChangeReason.Accrual,
        effectiveDate: row.effectiveDate,
        // The instant is the one the caller is standing at. On a plain refresh
        // that is now; on a catch-up it is the month boundary this row belongs
        // to, because the catch-up walks the boundaries in order and accrues at
        // each of them. Either way it only reaches the balance row's updatedAt —
        // the ledger row itself is ordered by insertion, which is why the walk
        // exists at all.
        occurredAt: asOf.iso,
        deltaDays: row.deltaDays,
        onHoldDelta: 0,
        spentDelta: 0,
        accruedDelta: row.deltaDays,
        note: 'Monthly accrual',
      })
    }
  }

  /**
   * The months `year` still owes as of `asOf`, priced but not written.
   *
   * Every read here is one `accrueForYear` had to do anyway, so planning first
   * and writing after costs nothing extra on the write path — and it lets the
   * catch-up ask "which month boundaries are still pending?" without writing a
   * single row, which is what its chronological walk is built on.
   */
  private async planAccrualForYear(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOf: AsOf,
    anchorDate?: string | null,
    preresolvedSchedule?: PolicyYearSchedule | null,
  ): Promise<Array<{ effectiveDate: string; deltaDays: number }>> {
    const balance = await this.ensureBalance(
      manager,
      userId,
      leaveType,
      year,
      asOf,
    )
    const allocation = await this.ensureAllocation(
      manager,
      userId,
      leaveType,
      year,
      asOf,
    )
    // A CLOSED year accrues nothing more. The close reduced its accrued by the
    // leftover (carried or burnt), so its cumulative target now permanently
    // exceeds its accrued — without this guard any later touch (a backdated
    // submit, another close walking further back) would cheerfully re-accrue
    // the very days that just left. The marker is the year's OWN closedAt,
    // stamped only when its leftover was actually booked — never inferred
    // from a neighbour's state, which can be settled trivially.
    if (allocation.closedAt) {
      return []
    }
    const { hireMonth, months } = accrualScheduleForYear(
      year,
      asOf.day,
      anchorDate,
    )
    const schedule =
      (preresolvedSchedule !== undefined
        ? preresolvedSchedule
        : await this.resolvePolicyScheduleTx(
            manager,
            userId,
            year,
            anchorDate ?? null,
          )) ?? legacyScheduleFromTotal(allocation.totalDays)

    // ONE LEDGER ROW PER MONTH OWED, each dated to the 1st of the month it
    // belongs to. Accrual is driven by reads, so an account left dormant since
    // January owes five months at once in May; posting them as a single entry
    // dated to the day someone happened to log in contradicts the rule the UI
    // states ("accrues monthly") and buries five facts in one row. The catch-up
    // now reads exactly like an account that was never dormant.
    //
    // No high-water mark is needed to stay idempotent. The target is cumulative
    // and the running figure is the balance itself, so on a second pass every
    // covered month computes a delta of zero or less and writes nothing. That
    // also makes the loop self-healing after a manual adjustment: the month the
    // adjustment overshot is skipped, and the remaining months still land the
    // total exactly on target, which is what keeps each row's snapshot in step
    // with the balance row.
    const owed: Array<{ effectiveDate: string; deltaDays: number }> = []
    let accrued = balance.accruedDays
    for (let index = 1; index <= months; index++) {
      const targetAccrued = pieceTargetDays(
        leaveType,
        schedule,
        allocation.carriedOverDays,
        hireMonth,
        // `index`, not `months`: the target is cumulative, so each iteration
        // asks what the year owes by ITS month and the delta is that month's
        // own accrual. Passing the whole count would collapse the year into a
        // single lump row dated to the hire month.
        index,
        allocation.manualAdjustmentDays,
      )
      const delta = roundDays(targetAccrued - accrued)
      if (delta <= 0) {
        continue
      }
      owed.push({
        effectiveDate: firstOfMonthIso(year, hireMonth + index - 1),
        deltaDays: delta,
      })
      accrued = roundDays(accrued + delta)
    }
    return owed
  }

  private async recordBalanceChange(
    manager: EntityManager,
    input: RecordBalanceChangeInput,
  ): Promise<void> {
    const balanceRepo = manager.getRepository(LeaveBalanceEntity)
    // asOfInstant, not a resolved as-of: the leave year is already decided by
    // the caller (input.year), so nothing here asks the calendar a question.
    const balance = await this.ensureBalance(
      manager,
      input.userId,
      input.leaveType,
      input.year,
      asOfInstant(input.occurredAt),
    )
    const nextOnHold = roundDays(balance.onHoldDays + input.onHoldDelta)
    const nextSpent = roundDays(balance.spentDays + input.spentDelta)
    const nextAccrued = roundDays(balance.accruedDays + input.accruedDelta)

    // The three primitives are physical counts and can never go negative.
    // accrued - onHold - spent DELIBERATELY may: forward planning holds days
    // that have not accrued yet (a December booking made in March), so the
    // difference sits negative until the monthly accruals catch up. Nothing is
    // over-subscribed by that: the timeline feasibility check at submit proves
    // every committed day is covered by the accrual due BY THAT DAY, which is
    // a stronger promise than a single as-of-today figure ever was. Spending a
    // day leaves the difference unchanged (hold -1, spent +1), and the
    // onHold >= 0 floor still stops a double release or over-consumption.
    if (nextOnHold < 0 || nextSpent < 0 || nextAccrued < 0) {
      throw new LeaveDomainValidationError(
        'Leave balance change would produce a negative balance.',
      )
    }

    balance.onHoldDays = nextOnHold
    balance.spentDays = nextSpent
    balance.accruedDays = nextAccrued
    balance.updatedAt = input.occurredAt
    await balanceRepo.save(balance)

    const ledgerRepo = manager.getRepository(LeaveBalanceChangeEntity)
    await ledgerRepo.save(
      ledgerRepo.create({
        id: randomUUID(),
        userId: input.userId,
        year: input.year,
        effectiveDate: input.effectiveDate,
        leaveType: input.leaveType,
        deltaDays: roundDays(input.deltaDays),
        accruedDays: balance.accruedDays,
        onHoldDays: balance.onHoldDays,
        spentDays: balance.spentDays,
        reason: input.reason,
        note: input.note ?? null,
      }),
    )
  }

  // ------------------------------------------------ forward planning ---------

  /**
   * The projection inputs for one (user, leaveType, year), read WITHOUT writing
   * anything: the rate schedule comes from the policy resolver (the SAME
   * derivation the accrual loop uses, so a preview for a year nobody has
   * touched yet reports the numbers a submission would materialize — scheduled
   * Jan-1 transfers and increment steps included). The legacy no-membership
   * fallback mirrors ensureAllocation (this year's row, else the prior year's
   * total, else the settings default) and must stay in lockstep with it. A
   * future year's stored carryover is deliberately ignored — it is zero and
   * unfinalized until the year begins; callers pass the projected figure
   * instead.
   */
  private async resolveProjectionInputs(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    anchor: string | null,
  ): Promise<{
    totalDays: number
    schedule: PolicyYearSchedule
    policyChangedDuringYear: boolean
    carriedOverDays: number
    carryoverFinalized: boolean
    accruedDays: number
    spentDays: number
    manualAdjustmentDays: number
  }> {
    const allocationRepo = manager.getRepository(LeaveAllocationEntity)
    const allocation = await allocationRepo.findOneBy({ userId, leaveType, year })
    const policySchedule = await this.resolvePolicyScheduleTx(
      manager,
      userId,
      year,
      anchor,
    )
    let totalDays: number
    if (policySchedule) {
      totalDays = scheduleYearEndTotal(leaveType, policySchedule)
    } else if (allocation) {
      totalDays = allocation.totalDays
    } else {
      const settings = await this.loadSettingsState(manager)
      const prior = await allocationRepo.findOneBy({
        userId,
        leaveType,
        year: year - 1,
      })
      totalDays =
        prior?.totalDays ??
        (leaveType === LeaveType.Vacation
          ? settings.defaultVacationDays
          : settings.defaultSickDays)
    }
    const manualAdjustmentDays =
      leaveType === LeaveType.Vacation
        ? (allocation?.manualAdjustmentDays ?? 0)
        : 0
    const balance = await manager
      .getRepository(LeaveBalanceEntity)
      .findOneBy({ userId, leaveType, year })
    return {
      totalDays: roundDays(totalDays + manualAdjustmentDays),
      schedule: policySchedule ?? legacyScheduleFromTotal(totalDays),
      policyChangedDuringYear: policySchedule?.changedDuringYear ?? false,
      carriedOverDays: allocation?.carryoverFinalized
        ? allocation.carriedOverDays
        : 0,
      carryoverFinalized: allocation?.carryoverFinalized ?? false,
      accruedDays: balance?.accruedDays ?? 0,
      spentDays: balance?.spentDays ?? 0,
      manualAdjustmentDays,
    }
  }

  /**
   * The leave days this user has already committed of one type, grouped by
   * leave year: every PAID day of a pending or approved request that has NOT
   * been consumed yet, each carrying what it costs. Consumed days are excluded
   * because they already live in the balance's spentDays, which seeds the
   * running total; unpaid days are excluded because they never charge the
   * balance at all.
   *
   * A leave awaiting a change counts ONCE, not twice. The original and its
   * pending replacement are two rows for one absence: exactly one of them will
   * survive the approval, so a day belonging to either is counted a single
   * time. Charging for both would let a routine date change swallow the rest
   * of the year's allowance for as long as the approval takes.
   *
   * `excludeRequestIds` drops a request from the picture — used when checking a
   * replacement, whose original will release its days the moment the
   * replacement is approved.
   */
  private async loadCommittedSchedule(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    years: number[],
    excludeRequestIds: string[],
  ): Promise<Map<number, CommittedDay[]>> {
    const withRequests = await this.loadCommittedScheduleWithRequests(
      manager,
      userId,
      leaveType,
      years,
      excludeRequestIds,
    )
    const schedule = new Map<number, CommittedDay[]>()
    for (const [year, entries] of withRequests) {
      // Only the request identity is dropped here; the cost travels on, because
      // what a year owes is the sum of its portions.
      schedule.set(
        year,
        entries.map(({ day, portion }) => ({ day, portion })),
      )
    }
    return schedule
  }

  // The identity-keeping variant: the transfer preflight must name the
  // requests whose days a downgrade cannot cover, so it needs the day ->
  // request mapping the projection deliberately flattens away. NOTE: a
  // superseded original and its pending replacement are charged once as a
  // merged worst case; those synthetic days are attributed to the ORIGINAL's
  // id (the row that survives a rejection).
  private async loadCommittedScheduleWithRequests(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    years: number[],
    excludeRequestIds: string[],
  ): Promise<Map<number, Array<CommittedDay & { requestId: string }>>> {
    const schedule = new Map<
      number,
      Array<CommittedDay & { requestId: string }>
    >()
    for (const year of years) {
      schedule.set(year, [])
    }
    if (years.length === 0) {
      return schedule
    }
    // Date overlap, NOT leaveYear membership: a request anchored in December
    // may carry January days, and filing it by its anchor year alone would
    // hide those days from the next year's projection — leave that year could
    // then be double-booked against. `years` may be non-contiguous (an admin
    // correcting a past year passes extraYears), so the min–max window can
    // over-fetch a gap year; the bucket guard below drops those days, exactly
    // as the old membership query never loaded them.
    const requests = await manager.getRepository(LeaveRequestEntity).find({
      where: {
        requesterUserId: userId,
        leaveType,
        startDate: LessThanOrEqual(`${Math.max(...years)}-12-31`),
        endDate: MoreThanOrEqual(`${Math.min(...years)}-01-01`),
        status: In([LeaveRequestStatus.Pending, LeaveRequestStatus.Approved]),
      },
    })
    const counted = requests.filter(
      (request) => !excludeRequestIds.includes(request.id),
    )
    const daysOf = (request: LeaveRequestEntity): CommittedDay[] =>
      [...remainingPaidDaysByYear(request).values()].flat()
    // Originals whose pending replacement is also in view. Exactly one of the
    // pair will survive, so the pair is charged once, as the worst case either
    // outcome can cost: the pointwise-cumulative maximum of the two day lists,
    // taken PER YEAR. Keeping whichever member has more days is not enough —
    // the shorter one may sit earlier in the year and be the tighter
    // constraint there. Per year rather than over the union, because a January
    // replacement day must never absorb a December original day: each year's
    // charge is the worst case that year itself can end up paying.
    const supersededByPending = new Map<string, LeaveRequestEntity>()
    for (const request of counted) {
      if (
        request.status === LeaveRequestStatus.Pending &&
        request.supersedesRequestId
      ) {
        supersededByPending.set(request.supersedesRequestId, request)
      }
    }

    const paired = new Map<string, CommittedDay[]>()
    const skipped = new Set<string>()
    for (const request of counted) {
      const replacement = supersededByPending.get(request.id)
      if (!replacement) {
        continue
      }
      skipped.add(replacement.id)
      const originalByYear = bucketCommittedByYear(daysOf(request))
      const replacementByYear = bucketCommittedByYear(daysOf(replacement))
      const pairYears = new Set([
        ...originalByYear.keys(),
        ...replacementByYear.keys(),
      ])
      const merged: CommittedDay[] = []
      for (const year of pairYears) {
        merged.push(
          ...pointwiseMaxSchedule(
            originalByYear.get(year) ?? [],
            replacementByYear.get(year) ?? [],
          ),
        )
      }
      paired.set(request.id, merged)
    }

    for (const request of counted) {
      if (skipped.has(request.id)) {
        continue
      }
      // Each day charges the year IT falls in, never the request's anchor.
      for (const entry of paired.get(request.id) ?? daysOf(request)) {
        schedule
          .get(getYearFromIsoDate(entry.day))
          ?.push({ ...entry, requestId: request.id })
      }
    }
    for (const entries of schedule.values()) {
      entries.sort((left, right) => left.day.localeCompare(right.day))
    }
    return schedule
  }

  /**
   * Check every committed leave day against the days that will have accrued by
   * then. This replaces the old "enough available right now" test: a request
   * for August is judged against August's accrual, not today's, which is what
   * makes planning ahead possible without letting anyone outrun their
   * entitlement.
   *
   * Both horizon years are always evaluated, not just the candidate's: next
   * year's projection leans on the carryover this year is expected to leave
   * behind, so a new December request has to be checked against the January
   * leave that carryover is already funding.
   *
   * With a candidate, this is also where the paid/unpaid split is decided.
   * Every input is read once, then a pure fold re-runs over the same numbers
   * while the candidate's days are offered up one at a time in date order: a
   * day is paid when accepting it keeps every year feasible, unpaid when it
   * does not. Walking day by day rather than cutting at the first shortfall is
   * what lets accrual arriving mid-request fund the days after it, so the
   * unpaid days are the ones the balance genuinely cannot cover rather than
   * everything past the first gap. The candidate never displaces days already
   * committed: earlier requests keep the funding they were given.
   */
  private async evaluatePlannedCommitments(
    manager: EntityManager,
    args: {
      userId: string
      leaveType: LeaveType
      // Today in the EMPLOYEE's timezone. The whole projection is day-granular
      // — committed days, the accrual curve, the violation it reports — so it
      // takes a day rather than an instant and never slices one itself.
      nowDay: string
      anchor: string | null
      // The candidate's concrete days; each is judged against the year IT
      // falls in, so a cross-year candidate needs no anchor year here. What
      // each of them COSTS travels separately, keyed by date: leaveDays here is
      // already filtered (probation days never reach this), so an index-aligned
      // array would be sheared against the request's own portions on arrival.
      candidate?: { leaveDays: string[]; portions: ReadonlyMap<string, number> }
      excludeRequestIds?: string[]
      // Years to evaluate beyond the default horizon, e.g. the past year an
      // admin is correcting an allocation for.
      extraYears?: number[]
    },
  ): Promise<FeasibilityReport> {
    const currentYear = getYearFromIsoDate(args.nowDay)
    const years = [...new Set([
      currentYear,
      currentYear + PLANNING_HORIZON_YEARS,
      ...(args.candidate?.leaveDays.map(getYearFromIsoDate) ?? []),
      ...(args.extraYears ?? []),
    ])].sort((left, right) => left - right)

    const schedule = await this.loadCommittedSchedule(
      manager,
      args.userId,
      args.leaveType,
      years,
      args.excludeRequestIds ?? [],
    )
    const settings = await this.loadSettingsState(manager)
    // Every database read happens here, once. The fold below is pure so the
    // candidate's days can be tried against it as many times as the marking
    // walk needs without re-querying anything.
    const inputsByYear = new Map<
      number,
      Awaited<ReturnType<LeaveDomainService['resolveProjectionInputs']>>
    >()
    for (const year of years) {
      inputsByYear.set(
        year,
        await this.resolveProjectionInputs(
          manager,
          args.userId,
          args.leaveType,
          year,
          args.anchor,
        ),
      )
    }

    // What one of the candidate's dates costs. Absent portions read as full
    // days, which is every candidate a caller that knows nothing about hours
    // hands over.
    const priceCandidateDay = (day: string): number =>
      args.candidate?.portions.get(day) ?? 1

    const fold = (
      candidatePaidDays: string[],
    ): Omit<FeasibilityReport, 'candidateSplit'> => {
      const projections = new Map<number, YearProjection>()
      let violation: FeasibilityReport['violation'] = null
      let projectedCarryover = 0

      for (const year of years) {
        const inputs = inputsByYear.get(year)
        if (!inputs) {
          continue
        }
        // A year that has not begun carries over what this year is projected to
        // leave unused; a year already under way uses its settled figure.
        const carriedOverDays =
          year > currentYear ? projectedCarryover : inputs.carriedOverDays
        const accrual: ProjectedAccrualInputs = {
          leaveType: args.leaveType,
          year,
          nowDay: args.nowDay,
          anchor: args.anchor,
          schedule: inputs.schedule,
          carriedOverDays,
          currentAccruedDays: inputs.accruedDays,
          manualAdjustmentDays: inputs.manualAdjustmentDays,
        }
        // A cross-year candidate contributes each day to its own year's
        // committed list. December days land in the current year, where they
        // shrink the projected carryover computed below — which is exactly the
        // figure the January days are then measured against: the feedback is
        // automatic because the fold walks years ascending.
        const candidateHere = candidatePaidDays.filter(
          (day) => getYearFromIsoDate(day) === year,
        )
        const committedEntries =
          candidateHere.length > 0
            ? [
                ...(schedule.get(year) ?? []),
                ...candidateHere.map((day) => ({
                  day,
                  portion: priceCandidateDay(day),
                })),
              ].sort((left, right) => left.day.localeCompare(right.day))
            : (schedule.get(year) ?? [])
        const projectedAt = (day: string): number =>
          projectedAccruedAtDay(accrual, day)
        const projectedYearEndAccrual = projectedAt(`${year}-12-31`)
        // Computed for every year still ahead, not just the current one: the
        // composer draws the next year's carryover band too, and a zero there
        // would read as "all of it expires". A year already closed is left
        // absent instead: what it really handed over is settled in the books.
        const carryoverOutDays =
          year >= currentYear
            ? applyCarryoverPolicy(
                projectedYearEndAccrual -
                  inputs.spentDays -
                  committedCost(committedEntries),
                // The per-type gate, same one the year close applies: a
                // sick-leave projection must not promise a carryover the close
                // will burn.
                carryoverPolicyFor(args.leaveType, settings),
                settings,
                // The same prorated base the close will derive: the year's
                // earned entitlement off the very schedule this fold accrues
                // against, manual adjustments included, so the forecast and
                // the books agree. NOT inputs.totalDays — that figure is the
                // display denominator, un-prorated for a hire year.
                carryoverCapBaseDays(
                  args.leaveType,
                  inputs.schedule,
                  year,
                  args.anchor,
                  inputs.manualAdjustmentDays,
                ),
              )
            : undefined

        projections.set(year, {
          year,
          totalDays: inputs.totalDays,
          policyChangedDuringYear: inputs.policyChangedDuringYear,
          carriedOverDays,
          carryoverProjected: year > currentYear,
          accruedDays: inputs.accruedDays,
          spentDays: inputs.spentDays,
          committedEntries,
          projectedAt,
          projectedYearEndAccrual,
          ...(carryoverOutDays !== undefined ? { carryoverOutDays } : {}),
        })

        if (!violation) {
          // Days already spent must be covered by what the year will EVER
          // accrue. Without this the fold passes vacuously for an employee
          // with no planned leave, which is exactly the state an admin is in
          // when they lower an allocation or move an employment start date
          // backwards. Measured against the YEAR-END curve, not today's
          // accrued figure: an imported tracker history legitimately runs the
          // balance negative until accrual catches up, and judging that
          // transient deficit as broken made every candidate day unpaid (and
          // refused every reanchor) for months. A deficit the year can still
          // absorb is the walk's business, not a violation.
          if (inputs.spentDays > projectedYearEndAccrual + BALANCE_EPSILON) {
            violation = {
              year,
              day: `${year}-12-31`,
              committedByThen: inputs.spentDays,
              projectedByThen: projectedYearEndAccrual,
            }
          } else {
            const found = firstInfeasibleCommittedDay(
              committedEntries,
              inputs.spentDays,
              projectedAt,
            )
            if (found) {
              violation = { year, ...found }
            }
          }
        }

        if (year === currentYear) {
          // The same figure the projection above already carries, never a
          // second computation of it: the next year's carriedOverDays is fed
          // from this scalar, so a drift between the two would put a different
          // carryover in the books than the one the composer drew.
          projectedCarryover = carryoverOutDays ?? 0
        }
      }

      return {
        violation,
        projections,
        projectedCarriedOverDays: projectedCarryover,
      }
    }

    if (!args.candidate) {
      return fold([])
    }

    // Offer the candidate's days up one at a time, earliest first. A day joins
    // the paid set when the whole picture — this year, next year, and the
    // carryover that links them — still holds with it in; otherwise it is
    // unpaid and the walk moves on, because a later day may well be covered by
    // accrual that has not arrived yet on this one.
    //
    // A schedule that is already broken without the candidate (an allocation
    // cut, a moved start date) makes every candidate day unpaid: the fold can
    // never come back clean, and refusing the submission outright is exactly
    // what this feature exists to stop doing.
    const paidDays: string[] = []
    if (fold([]).violation === null) {
      for (const day of args.candidate.leaveDays) {
        if (fold([...paidDays, day]).violation === null) {
          paidDays.push(day)
        }
      }
    }
    const paid = new Set(paidDays)
    const unpaidDates = args.candidate.leaveDays.filter((day) => !paid.has(day))
    return {
      ...fold(paidDays),
      candidateSplit: {
        paidDays: sumPortions(paidDays, args.candidate.portions),
        unpaidDays: sumPortions(unpaidDates, args.candidate.portions),
        unpaidDates,
      },
    }
  }

  /**
   * The paid/unpaid split for leave that ALREADY HAPPENED.
   *
   * Live submissions are measured against the accrual curve: a day is payable
   * when the months elapsed by then have earned it. Replayed history cannot be
   * judged that way. The office trackers hand out the year's entitlement and
   * let the running balance go negative until the accrual catches up, so a
   * March holiday taken against a year that had only earned three days was
   * paid in full at the time. Re-deciding it here would invent unpaid days
   * nobody was ever docked for.
   *
   * What history does still respect is the year's ANNUAL limit: the
   * entitlement plus whatever was carried in, less what the year has already
   * committed. Beyond that the days genuinely were unpaid, which is how the
   * five-day sick tranche keeps its meaning, and how the trackers' own
   * "unpaid" notes reappear without being transcribed.
   *
   * Days are offered in date order, each year counted against its own limit,
   * so a request spanning New Year is charged to the year each day falls in.
   */
  private async splitHistoricalByAnnualLimitTx(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    // The same pair the live twin takes, and for the same reason: the days to
    // offer, and what each of them costs.
    candidate: { leaveDays: string[]; portions: ReadonlyMap<string, number> },
    asOf: AsOf,
    anchor: string | null,
  ): Promise<FeasibilityReport> {
    const remainingByYear = new Map<number, number>()
    for (const year of new Set(candidate.leaveDays.map(getYearFromIsoDate))) {
      const allocation = await this.ensureAllocation(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      const balance = await this.ensureBalance(
        manager,
        userId,
        leaveType,
        year,
        asOf,
      )
      // The entitlement comes from the POLICY, not from the allocation row:
      // that row is a cache, and an employee who used the system before the
      // import still carries the total of whatever policy they were on then
      // (the import re-resolves it, but only once the replay has settled).
      // Reading the stale figure here would hand out days the new terms never
      // granted.
      const schedule = await this.resolvePolicyScheduleTx(
        manager,
        userId,
        year,
        anchor,
      )
      const entitlement = schedule
        ? scheduleYearEndTotal(leaveType, schedule)
        : allocation.totalDays
      const limit = roundDays(entitlement + allocation.carriedOverDays)
      const committed = roundDays(balance.spentDays + balance.onHoldDays)
      remainingByYear.set(year, roundDays(limit - committed))
    }
    const unpaidDates: string[] = []
    let paidDays = 0
    for (const day of [...candidate.leaveDays].sort()) {
      const year = getYearFromIsoDate(day)
      const remaining = remainingByYear.get(year) ?? 0
      // What the day COSTS is what the year's remaining limit has to cover: a
      // half day fits where a whole one does not, and takes only half of it.
      const portion = candidate.portions.get(day) ?? 1
      if (remaining >= portion) {
        remainingByYear.set(year, roundDays(remaining - portion))
        paidDays = roundDays(paidDays + portion)
        continue
      }
      unpaidDates.push(day)
    }
    return {
      violation: null,
      projections: new Map(),
      projectedCarriedOverDays: 0,
      // Amounts on both sides, exactly as the live twin reports them: the same
      // field read by the same callers must not be a cost on one path and a
      // count of dates on the other.
      candidateSplit: {
        paidDays,
        unpaidDays: sumPortions(unpaidDates, candidate.portions),
        unpaidDates,
      },
    }
  }

  // Refuse a change that would leave some committed leave day uncovered. The
  // message names the day and both figures: "not enough balance" is useless
  // advice when the fix is to move or shorten one specific request.
  //
  // This is the ADMIN guard, and its only caller is reanchorAccrual: lowering
  // an allocation or moving a start date must still be refused when it would
  // strand days an employee is already counting on. Submissions do not come
  // through here — they take whatever the balance covers and mark the rest
  // unpaid, which is why this is always called without a candidate.
  private async assertPlannedCommitmentsFeasible(
    manager: EntityManager,
    args: {
      userId: string
      leaveType: LeaveType
      nowDay: string
      anchor: string | null
      candidate?: { leaveDays: string[]; portions: ReadonlyMap<string, number> }
      excludeRequestIds?: string[]
      extraYears?: number[]
      guardMessage?: string
    },
  ): Promise<void> {
    const report = await this.evaluatePlannedCommitments(manager, args)
    if (!report.violation) {
      return
    }
    // The workday length is read only on the refusal path: the figures in the
    // sentence are rendered against it, and the happy path must not pay for a
    // settings read to say nothing.
    const { hoursPerDay } = await this.loadSettingsState(manager)
    const explanation = describeViolation(report.violation, hoursPerDay)
    throw new LeaveDomainValidationError(
      args.guardMessage
        ? `${args.guardMessage} ${explanation}`
        : `Insufficient projected leave balance. ${explanation}`,
    )
  }

  // Postgres advisory lock keyed by (user, leave type), held to the end of the
  // transaction. Feasibility reads the user's other requests and then writes a
  // new one; without this two concurrent submissions could each read a picture
  // that does not yet contain the other and both fit. Scoped per leave type
  // because the balances they consume are per type.
  private async lockUserBalanceForUpdate(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:${leaveType}`,
    ])
  }

  // -------------------------------------------------------------- requests ---

  // How many WORKING DATES a period contains, which is not what a request over
  // that period costs: a date may be booked for part of a day. Named for the
  // dates on purpose, so nothing mistakes it for an amount of leave.
  async countWorkingDates(
    input: CalculateRequestedDaysInput,
  ): Promise<number> {
    return (await this.resolveLeaveDays(this.manager, input)).length
  }

  // The concrete WORKING days covered by a period, in order: every calendar day
  // that is neither a weekend (all employees are on a Mon-Fri schedule) nor an
  // official holiday in the employee's effective holiday calendar. This is the
  // single source of truth for WHICH dates a request covers: hold, spend and
  // the frozen leaveDays all derive from it. What each of them costs is a
  // separate question, answered by the portions frozen beside them.
  private async resolveLeaveDays(
    manager: EntityManager,
    input: CalculateRequestedDaysInput,
  ): Promise<string[]> {
    const dates = enumerateDates(input.startDate, input.endDate)
    const holidaySet = input.countryCode
      ? await this.holidayDatesForPeriod(
          manager,
          input.countryCode,
          input.startDate,
          input.endDate,
        )
      : new Set<string>()
    return dates.filter(
      (date) => !isWeekendIso(date) && !holidaySet.has(date),
    )
  }

  async submitLeaveRequest(
    input: SubmitLeaveRequestInput,
  ): Promise<LeaveRequestDetailDto> {
    return this.dataSource.transaction((manager) =>
      this.createLeaveRequestTx(manager, input, {}),
    )
  }

  /**
   * The importer's door into the submission core: same checks, same writes,
   * but on the CALLER's transaction (the history import wraps one employee's
   * whole timeline in a single transaction) and with the notification rows
   * optionally suppressed — a replayed 2026 submission must not ring anyone's
   * bell at go-live. Never reachable over HTTP; the modification/supersede
   * options stay private to the domain.
   */
  async submitLeaveRequestTx(
    manager: EntityManager,
    input: SubmitLeaveRequestInput,
    opts: { suppressNotifications?: boolean; historical?: boolean } = {},
  ): Promise<LeaveRequestDetailDto> {
    return this.createLeaveRequestTx(manager, input, {
      suppressNotifications: opts.suppressNotifications,
      historical: opts.historical,
    })
  }

  /**
   * The shared submission core: every check, the hold, the request row, the
   * approver rows, the activity/audit/notification writes. A modification
   * (submitLeaveRequestModification) is the same act with two differences, both
   * passed in `opts`: the new request points back at the one it will replace,
   * and the original's own days are excluded from the overlap and feasibility
   * checks because approving the replacement releases them.
   */
  private async createLeaveRequestTx(
    manager: EntityManager,
    input: SubmitLeaveRequestInput,
    opts: {
      supersedesRequestId?: string
      excludeRequestIds?: string[]
      // Replaces the approvers' notification sentence when the submission is a
      // change to an already approved leave. Receives the split, because a
      // change that moves days out of the balance is the approver's business.
      // Both figures are AMOUNTS of leave, not counts of dates, and the
      // workday length rides along so the sentence renders them in the same
      // notation as the one it replaces (the caller has no settings in hand).
      approvalNeededSummary?: (
        requesterName: string,
        split: {
          requestedDays: number
          unpaidDays: number
          hoursPerDay: number
        },
      ) => string
      // History import only (see submitLeaveRequestTx): skips the
      // notification-center rows, and ONLY them — activities and audit rows
      // are written regardless, because the trail must show the import.
      suppressNotifications?: boolean
      // Leave that already happened, replayed from the office tracker. Two
      // things change, both about ADDRESSING rather than accounting: the
      // settings' default recipients are not folded in (a request from last
      // March must not land in the inbox of whoever approves leave today), and
      // a request naming nobody is allowed instead of refused — it settles
      // through the same automatic approval an unaddressed request takes,
      // which records the system as the decider rather than inventing one.
      historical?: boolean
    },
  ): Promise<LeaveRequestDetailDto> {
    const requester = await this.requireUser(manager, input.requesterUserId)
    const submittedAt = input.submittedAt ?? this.clock.nowIso()
    const asOf = await this.resolveAsOfTx(manager, requester, submittedAt)
    // A not-ready profile accrues nothing (see accrualScheduleForYear), so any
    // submission is doomed to fail the balance check — reject it up front
    // with the actual cause instead of a puzzling "insufficient balance".
    const profileStatus = employeeProfileStatus(requester, asOf.day)
    if (profileStatus === EmployeeProfileStatus.PendingSetup) {
      throw new LeaveDomainValidationError(
        'Your profile is not set up yet: the employment start date and country must both be set. Please contact an administrator.',
      )
    }
    if (profileStatus === EmployeeProfileStatus.NotStartedYet) {
      throw new LeaveDomainValidationError(
        `Your employment starts on ${requester.employmentStartDate}; leave requests become available from that date.`,
      )
    }
    if (!ALL_LEAVE_TYPES.includes(input.leaveType)) {
      throw new LeaveDomainValidationError(
        `Unknown leave type: ${String(input.leaveType)}`,
      )
    }

    // The requester may not address themselves: under the all-approvers gate
    // a self-listed 'to' row could never be cleared (no self-approval),
    // wedging the request forever, and a self-listed cc row would be dropped
    // below and silently promise a copy that never arrives. What the REQUESTER
    // asked for is refused outright so they see the name go; the settings
    // defaults, which they did not choose and cannot edit, are dropped quietly
    // further down. Checked here, among the input validations, so a self-listed
    // recipient is named as the cause before the balance/overlap checks can
    // mask it with an unrelated error.
    // One definition of "this address is the requester's own", used both to
    // reject what the requester typed (below) and to drop the requester out of
    // the settings defaults (further down). A single predicate so a future
    // change to the match identity (e.g. the ldapEntryUuid escalation path)
    // cannot update one site and miss the other.
    const isRequesterAddress = (email: string): boolean =>
      normalizeEmail(email) === requester.normalizedEmail

    const requestedRecipients = [
      ...(input.approverEmails ?? []),
      ...(input.ccEmails ?? []),
    ]
    if (requestedRecipients.some(isRequesterAddress)) {
      throw new LeaveDomainValidationError(
        'You cannot add yourself as a recipient of your own request.',
      )
    }

    // Inactive employees cannot receive a request the requester chose
    // explicitly; settings defaults that still list someone deactivated are
    // dropped quietly at the merge below (same pattern as the requester's own
    // address). Load settings once here so the explicit check and the merge
    // share one recipient-user lookup.
    const settings = await this.loadSettingsState(manager)
    const recipientUsers = await this.loadRecipientUsersByEmail(manager, [
      ...(input.approverEmails ?? []),
      ...(input.ccEmails ?? []),
      ...settings.defaultApproverEmails,
      ...settings.defaultCcApproverEmails,
    ])
    assertExplicitRecipientsAreActive(
      input.approverEmails,
      'approver',
      recipientUsers,
    )
    assertExplicitRecipientsAreActive(
      input.ccEmails,
      'CC recipient',
      recipientUsers,
    )

    // The ANCHOR year (year of startDate). A request may span the New Year:
    // each of its days is funded by the year it falls in, so this anchor names
    // the request without deciding where its days charge.
    const leaveYear = getYearFromIsoDate(input.startDate)
    const touchedYears = yearsSpanned(input.startDate, input.endDate)

    // Forward planning stops at the end of next year: beyond that there is no
    // allocation to project against and this year's leftover (the carryover
    // that would fund it) is pure guesswork. The END date is what is capped —
    // a December→January span must clear the horizon with its far end — and
    // only the FUTURE is: backdated requests keep working exactly as before.
    const horizonYear = getYearFromIsoDate(asOf.day) + PLANNING_HORIZON_YEARS
    if (getYearFromIsoDate(input.endDate) > horizonYear) {
      throw new LeaveDomainValidationError(
        `Leave can only be planned up to the end of ${horizonYear}.`,
      )
    }

    // A Ready profile guarantees a country; every year the period touches must
    // have a configured holiday calendar so public holidays are excluded from
    // the paid days. An ABSENT calendar means "not configured yet" (distinct
    // from a deliberately empty one), so refuse rather than silently charge
    // holidays as leave — and name every missing year, since a cross-year
    // request can be blocked by the next year's calendar alone.
    const holidayCalendarCountryCode =
      requester.holidayCalendarCountryCode ?? requester.countryCode ?? null
    if (!holidayCalendarCountryCode) {
      throw new LeaveDomainValidationError(
        'Your profile is not set up yet: the employment start date and country must both be set. Please contact an administrator.',
      )
    }
    const missingCalendarYears: number[] = []
    for (const year of touchedYears) {
      const hasCalendar = await manager
        .getRepository(HolidayCalendarEntity)
        .existsBy({ countryCode: holidayCalendarCountryCode, year })
      if (!hasCalendar) {
        missingCalendarYears.push(year)
      }
    }
    if (missingCalendarYears.length > 0) {
      throw new LeaveDomainValidationError(
        missingCalendarYears
          .map(
            (year) =>
              `No holiday calendar is configured for ${holidayCalendarCountryCode} ${year}. Please contact an administrator.`,
          )
          .join(' '),
      )
    }

    const leaveDays = await this.resolveLeaveDays(manager, {
      startDate: input.startDate,
      endDate: input.endDate,
      countryCode: holidayCalendarCountryCode,
    })
    // Keyed on the DATES, not on the cost: the refusal is about a period that
    // contains no working day at all, and the message says exactly that. Ahead
    // of the hours below so a range with nothing bookable in it is named as
    // such, rather than as an hours entry that landed on a weekend.
    if (leaveDays.length === 0) {
      throw new LeaveDomainValidationError(
        'Leave request must include at least one working day (weekends and public holidays are excluded).',
      )
    }
    // What each of those dates costs, frozen onto the request beside them.
    // Empty portions read as full days, which is what an ordinary submission
    // carries; everything below prices through the map rather than counting
    // dates, so a date booked for part of a day charges only that part. The
    // conversion sits here because it is the first point where the real
    // working dates exist and the last one before anything is priced, held or
    // locked.
    const dayPortions = resolveDayPortions(
      leaveDays,
      input.hoursByDate,
      settings.hoursPerDay,
    )
    const portions = portionMap(leaveDays, dayPortions)
    // What the request COSTS, which is no longer how many dates it covers: two
    // half days are one day of leave.
    const requestedDays = sumPortions(leaveDays, portions)
    // Serialize planning for this (user, leave type) before reading the
    // committed schedule: the split below is a read-then-write, so two
    // simultaneous submissions must not each miss the other. The overlap check
    // runs under the lock for the same reason — nothing downstream refuses a
    // submission any more, so this is the only thing standing between two
    // concurrent submissions of the same dates.
    await this.lockUserBalanceForUpdate(manager, requester.id, input.leaveType)

    const overlappingRequests = await this.findOverlappingRequests(
      manager,
      requester.id,
      input.startDate,
      input.endDate,
      opts.excludeRequestIds ?? [],
    )
    if (overlappingRequests.length > 0) {
      throw new LeaveDomainValidationError(
        formatOverlappingRequestError(overlappingRequests),
      )
    }

    // Bring balances up to the submission date before checking availability so
    // accrued days owed this year are counted. refreshBalancesTx accrues the
    // current year; accrue every year the request touches explicitly in case
    // one differs (a backdated request, or the far side of a New Year span) —
    // for a future year this accrues nothing but still materializes the
    // balance and allocation rows the per-year holds below post against.
    await this.refreshBalancesTx(manager, requester.id, submittedAt)
    for (const year of touchedYears) {
      await this.accrueDueAllowance(
        manager,
        requester.id,
        input.leaveType,
        year,
        asOf,
        requester.employmentStartDate ?? null,
      )
      await this.ensureBalance(
        manager,
        requester.id,
        input.leaveType,
        year,
        asOf,
      )
    }

    // Probation gate: days inside the governing policy's probation window are
    // forced unpaid up front — never a rejection (the request stays legal as
    // unpaid, and unpaid days post no holds, consume no ledger and release
    // nothing). Only the remaining days compete for the balance; the forced
    // ones are unioned back into the frozen split below.
    const policyTimeline = await this.loadPolicyTimelineTx(
      manager,
      requester.id,
    )
    const probation = policyTimeline
      ? probationForcedDays(
          policyTimeline,
          requester.employmentStartDate ?? null,
          input.leaveType,
          leaveDays,
        )
      : { forcedDays: [] as string[] }
    const probationForced = new Set(probation.forcedDays)
    const eligibleDays = leaveDays.filter((day) => !probationForced.has(day))
    // The availability rule: not "are there enough days today" but "which days
    // of this plan are covered by the accrual due by then". That is what lets
    // someone book their summer in March. Days the year cannot cover are not
    // refused any more — they are taken unpaid, and the split is frozen onto
    // the request here so nothing later can move it.
    // Replayed history answers a DIFFERENT question. The rule above asks
    // whether the accrual due by each day covers it, which is right for leave
    // still to come: nobody may book days the year will not have earned. Asked
    // of a day that already happened it rewrites the past more strictly than
    // it was lived — the company granted those days and paid them, months ago,
    // and the office trackers simply let a balance run negative until the
    // monthly accrual caught up. What history must still respect is the ANNUAL
    // limit: the year's entitlement plus whatever was carried into it. Days
    // beyond that were unpaid in reality too (the sick tranche is the usual
    // case), and they stay unpaid here.
    const report = opts.historical
      ? await this.splitHistoricalByAnnualLimitTx(
          manager,
          requester.id,
          input.leaveType,
          { leaveDays: eligibleDays, portions },
          asOf,
          requester.employmentStartDate ?? null,
        )
      : await this.evaluatePlannedCommitments(manager, {
          userId: requester.id,
          leaveType: input.leaveType,
          nowDay: asOf.day,
          anchor: requester.employmentStartDate ?? null,
          candidate: { leaveDays: eligibleDays, portions },
          ...(opts.excludeRequestIds ? { excludeRequestIds: opts.excludeRequestIds } : {}),
        })
    const unpaidLeaveDays = [
      ...probation.forcedDays,
      ...(report.candidateSplit?.unpaidDates ?? []),
    ].sort()
    // A date is funded whole: it is paid or it is unpaid, and it carries its
    // own portion either way. So what the request costs unpaid is that set
    // priced, and the paid figure is the remainder: derived by subtraction,
    // never summed a second time, because paidDays + unpaidDays must equal
    // requestedDays exactly and two independent sums can miss by an ulp.
    const unpaidDays = sumPortions(unpaidLeaveDays, portions)
    const paidDays = roundDays(requestedDays - unpaidDays)

    // Fold the settings defaults into the approvers so the addressees who
    // receive the notification email are exactly the ones authorized to view
    // and decide the request. Drop the requester's own address and inactive
    // employees, which a default list may still contain.
    //
    // The DECIDING defaults are folded in only while approval is required: if
    // they kept applying with approval optional, every request would still
    // carry an approver and nothing could ever be approved automatically. The
    // CC defaults are folded in under either mode — a copied recipient is
    // notified and never decides, so nothing about them conflicts with an
    // automatic approval.
    const isExcludedRecipient = (email: string): boolean =>
      isRequesterAddress(email) ||
      isInactiveKnownUser(email, recipientUsers)
    const approvers = toRecipients(
      [
        ...(input.approverEmails ?? []),
        ...(settings.approvalRequired && !opts.historical
          ? settings.defaultApproverEmails
          : []),
      ],
      [
        ...(input.ccEmails ?? []),
        ...(opts.historical ? [] : settings.defaultCcApproverEmails),
      ],
    ).filter((recipient) => !isExcludedRecipient(recipient.email))
    const toApproverCount = approvers.filter(
      (recipient) => recipient.kind === ApproverKind.To,
    ).length
    if (settings.approvalRequired && toApproverCount === 0 && !opts.historical) {
      throw new LeaveDomainValidationError(
        'Leave request must have at least one approver other than the requester.',
      )
    }
    const requestId = input.requestId ?? randomUUID()

    // Only the paid days are held, ONE HOLD PER YEAR they fall in: each day
    // reserves the balance of its own year, which is the whole meaning of a
    // cross-year request. A request the balance cannot fund at all posts
    // nothing: there is no zero-day hold to release later, and the employee's
    // ledger stays a record of balance movements rather than of requests.
    // Built by the same helper every later per-year movement reads, so the hold
    // posted here and the release given back cannot bucket or price the days
    // differently: nothing is consumed yet, which is what spentDaysConsumed 0
    // says.
    const paidByYear = remainingPaidDaysByYear({
      leaveDays,
      dayPortions,
      unpaidLeaveDays,
      spentDaysConsumed: 0,
    })
    for (const [year, yearPaidDays] of paidByYear) {
      const yearPaidCost = committedCost(yearPaidDays)
      const suffix =
        paidByYear.size > 1
          ? ` (${formatDayAmount(yearPaidCost, settings.hoursPerDay)} of ${formatDayAmount(paidDays, settings.hoursPerDay)} paid, the ${year} share)`
          : unpaidDays > 0
            ? ` (${formatDayAmount(paidDays, settings.hoursPerDay)} of ${formatDayAmount(requestedDays, settings.hoursPerDay)}; the rest is unpaid)`
            : ''
      await this.recordBalanceChange(manager, {
        userId: requester.id,
        leaveType: input.leaveType,
        year,
        reason: LeaveBalanceChangeReason.Hold,
        // The first paid day of THIS year's share, so a January hold reads as
        // January even though the request starts in December.
        effectiveDate: yearPaidDays[0]!.day,
        occurredAt: submittedAt,
        deltaDays: yearPaidCost,
        onHoldDelta: yearPaidCost,
        spentDelta: 0,
        accruedDelta: 0,
        // The request id belongs in the note like it does on every other row
        // a request writes (spend, release): it is the only link the ledger
        // has back to the request, and a reader that cannot find the hold
        // shows a request's page with no opening movement at all.
        note: `Hold for leave request ${input.startDate} to ${input.endDate}${suffix} (request ${requestId})`,
      })
    }

    const requestRepo = manager.getRepository(LeaveRequestEntity)
    const request = requestRepo.create({
      id: requestId,
      requesterUserId: requester.id,
      leaveType: input.leaveType,
      status: LeaveRequestStatus.Pending,
      leaveYear,
      startDate: input.startDate,
      endDate: input.endDate,
      requestedDays,
      submittedAt,
      // Seeded here so the columns are non-nullable; the 'submitted'
      // activity recorded below re-asserts the same values.
      lastAction: 'submitted',
      lastActivityAt: submittedAt,
      comment: input.comment ?? null,
      decisionComment: null,
      decidedAt: null,
      remainingHeldDays: paidDays,
      spentDaysConsumed: 0,
      leaveDays,
      // Frozen with the dates and never separately: everything that later
      // prices this request reads the pair, so a row saved without them would
      // be read back as full days it never was.
      dayPortions,
      unpaidLeaveDays,
      supersedesRequestId: opts.supersedesRequestId ?? null,
    })
    await requestRepo.save(request)

    const approverRepo = manager.getRepository(LeaveRequestApproverEntity)
    if (approvers.length > 0) {
      await approverRepo.save(
        approvers.map((approver) =>
          approverRepo.create({
            id: randomUUID(),
            requestId,
            email: approver.email,
            kind: approver.kind,
            // Left empty on purpose: only a decision writes a name here, and it
            // writes the one its author signed with. Naming an approver at
            // submit would freeze a name nobody has used yet — the read path
            // joins the account's current one instead.
            displayName: null,
          }),
        ),
      )
    }

    await this.addActivity(manager, {
      requestId,
      actorUserId: requester.id,
      action: 'submitted',
      occurredAt: submittedAt,
      comment: input.comment,
    })

    await this.auditLog.record(manager, {
      actor: input.audit ?? {
        userId: requester.id,
        label: requester.displayName,
        email: requester.email,
        roles: [],
      },
      eventType: AuditEventType.LeaveRequestSubmitted,
      occurredAt: submittedAt,
      target: { userId: requester.id, label: requester.displayName },
      entityType: 'leave_request',
      entityId: requestId,
      summary:
        `Submitted ${input.leaveType} leave ${input.startDate} to ${input.endDate} ` +
        `(${describeDaySplit(requestedDays, unpaidDays, settings.hoursPerDay)})`,
      after: snapshotRequest(request),
      requestId,
    })

    // Tell the approvers their decision is needed. Reads back the rows just
    // saved, so cc recipients are excluded and the requester's own address is
    // already gone (it is stripped above). A history-import replay skips this
    // block entirely: the decision it announces was made months ago.
    const approverUserIds = opts.suppressNotifications
      ? []
      : await this.resolveToApproverUserIds(
          manager,
          await this.loadApprovers(manager, requestId),
        )
    await this.notifications.recordMany(
      manager,
      approverUserIds.map((recipientUserId) => ({
        recipientUserId,
        actorUserId: requester.id,
        actorLabel: requester.displayName,
        type: NotificationType.ApprovalNeeded,
        requestId,
        occurredAt: submittedAt,
        summary:
          opts.approvalNeededSummary?.(requester.displayName, {
            requestedDays,
            unpaidDays,
            hoursPerDay: settings.hoursPerDay,
          }) ??
          `${requester.displayName} requests ${formatLeaveTypeLabel(input.leaveType)} from ${input.startDate} to ${input.endDate}` +
            `${unpaidDays > 0 ? ` (${formatDayAmount(unpaidDays, settings.hoursPerDay)} of ${formatDayAmount(requestedDays, settings.hoursPerDay)} unpaid)` : ''}` +
            ' and needs your approval',
      })),
    )

    // Nobody was addressed to decide this one (only reachable while approval
    // is optional), so it settles here, in the transaction that created it,
    // through the one legal path to Approved — a replacement therefore still
    // performs the supersede swap. No per-approver decision is fabricated (the
    // force-decide principle) and no notification-center row is written: the
    // requester is the actor, and self-notifications are suppressed by design.
    // The CC recipients hear about it by email, published by the caller.
    if (toApproverCount === 0) {
      const beforeAutoApprove = snapshotRequest(request)
      const autoComment = opts.historical
        ? HISTORY_APPROVED_COMMENT
        : AUTO_APPROVED_COMMENT
      await this.promoteToApprovedTx(
        manager,
        request,
        submittedAt,
        autoComment,
        SYSTEM_ACTOR,
      )
      await this.addActivity(manager, {
        requestId,
        systemActorLabel: opts.historical ? 'Data import' : 'System',
        action: 'auto-approved',
        occurredAt: submittedAt,
        comment: autoComment,
      })
      // System activities deliberately skip the lastAction/lastActivityAt
      // snapshot (see addActivity); this one IS the decision, so stamp it or
      // the admin feed would keep showing 'submitted' as the newest event.
      request.lastAction = 'auto-approved'
      request.lastActivityAt = submittedAt
      await requestRepo.save(request)
      await this.auditLog.record(manager, {
        actor: SYSTEM_ACTOR,
        eventType: AuditEventType.LeaveRequestAutoApproved,
        occurredAt: submittedAt,
        target: { userId: requester.id, label: requester.displayName },
        entityType: 'leave_request',
        entityId: requestId,
        summary:
          `Approved ${input.leaveType} leave ${input.startDate} to ${input.endDate} automatically ` +
          '(approval is optional and the request named no approver)',
        before: beforeAutoApprove,
        after: snapshotRequest(request),
        requestId,
      })
    }

    return this.buildRequestDetail(manager, request)
  }

  /**
   * What the composer asks before letting someone submit: would this period be
   * accepted, and how much room is there in the months it falls in. Runs the
   * same checks submit runs and REPORTS them instead of throwing, so the panel
   * can never invent a rule the server does not have.
   *
   * One exception, and it is deliberate: a malformed hours map is refused here
   * exactly as submit refuses it. A blocker describes a period the employee can
   * still fix by choosing other dates; hours booked on a weekend describe a
   * composer that built a shape no rule of this server allows, and answering it
   * with a renderable blocker would invite the panel to offer it anyway.
   *
   * It refreshes balances like every other read path: a preview computed from a
   * stale accrued figure would contradict the submission it is meant to
   * predict.
   */
  async previewLeaveAvailability(
    input: PreviewLeaveAvailabilityInput,
  ): Promise<LeaveAvailabilityPreviewDto> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, input.userId)
      const generatedAt = input.asOfIso ?? this.clock.nowIso()
      const asOf = await this.resolveAsOfTx(manager, user, generatedAt)
      const currentYear = getYearFromIsoDate(asOf.day)
      const leaveYear = getYearFromIsoDate(input.startDate)
      const blockers: LeaveAvailabilityBlockerDto[] = []

      const profileStatus = employeeProfileStatus(user, asOf.day)
      if (profileStatus !== EmployeeProfileStatus.Ready) {
        blockers.push({
          code: 'profile_not_ready',
          message:
            profileStatus === EmployeeProfileStatus.NotStartedYet
              ? `Your employment starts on ${user.employmentStartDate}; leave requests become available from that date.`
              : 'Your profile is not set up yet: the employment start date and country must both be set. Please contact an administrator.',
        })
      }
      const horizonYear = currentYear + PLANNING_HORIZON_YEARS
      if (getYearFromIsoDate(input.endDate) > horizonYear) {
        blockers.push({
          code: 'beyond_planning_horizon',
          message: `Leave can only be planned up to the end of ${horizonYear}.`,
        })
      }

      const touchedYears = yearsSpanned(input.startDate, input.endDate)
      const holidayCalendarCountryCode =
        user.holidayCalendarCountryCode ?? user.countryCode ?? null
      let leaveDays: string[] = []
      if (holidayCalendarCountryCode) {
        // One blocker PER missing year: a cross-year request can be blocked by
        // the next year's calendar alone, and the message must say which.
        let anyMissing = false
        for (const year of touchedYears) {
          const hasCalendar = await manager
            .getRepository(HolidayCalendarEntity)
            .existsBy({ countryCode: holidayCalendarCountryCode, year })
          if (!hasCalendar) {
            anyMissing = true
            blockers.push({
              code: 'holiday_calendar_missing',
              message: `No holiday calendar is configured for ${holidayCalendarCountryCode} ${year}. Please contact an administrator.`,
            })
          }
        }
        if (!anyMissing) {
          leaveDays = await this.resolveLeaveDays(manager, {
            startDate: input.startDate,
            endDate: input.endDate,
            countryCode: holidayCalendarCountryCode,
          })
        }
      }
      if (blockers.length === 0 && leaveDays.length === 0) {
        blockers.push({
          code: 'no_working_days',
          message:
            'Leave request must include at least one working day (weekends and public holidays are excluded).',
        })
      }
      // What each resolved date costs, built exactly as the submission core
      // builds it: the preview reports the split submit would freeze, so the
      // two must price a period the same way. Empty portions read as full days.
      //
      // Hours are refused here with the SAME messages submit refuses them with,
      // rather than reported as a blocker: a blocker describes a period the
      // employee can still fix by moving dates, while an hours entry on a
      // weekend is a composer that built a shape the server has no rule for.
      // The conversion is skipped when the range resolved to nothing so the
      // blockers above stay the answer.
      //
      // The workday length is read for EVERY preview, hours or not: the unpaid
      // notice below renders its figures against it, and a whole-day preview
      // still has one.
      const { hoursPerDay } = await this.loadSettingsState(manager)
      let dayPortions: number[] = []
      if (input.hoursByDate !== undefined && leaveDays.length > 0) {
        dayPortions = resolveDayPortions(
          leaveDays,
          input.hoursByDate,
          hoursPerDay,
        )
      }
      const portions = portionMap(leaveDays, dayPortions)

      const excludeRequestIds = input.excludeRequestId
        ? [input.excludeRequestId]
        : []
      const overlappingRequests = await this.findOverlappingRequests(
        manager,
        user.id,
        input.startDate,
        input.endDate,
        excludeRequestIds,
      )
      if (overlappingRequests.length > 0) {
        blockers.push({
          code: 'overlapping_request',
          message: overlappingRequestPreviewMessage(overlappingRequests.length),
          overlappingRequests,
        })
      }

      await this.refreshBalancesTx(manager, user.id, generatedAt)
      // refreshBalancesTx accrues the CURRENT year; every touched year is
      // judged against its own accrual, which submit accrues explicitly too.
      // Skip it and the preview would report a shortfall the submission does
      // not have.
      for (const year of touchedYears) {
        await this.accrueDueAllowance(
          manager,
          user.id,
          input.leaveType,
          year,
          asOf,
          user.employmentStartDate ?? null,
        )
      }
      // The same probation partition the submit path applies, so the preview
      // and the frozen request cannot disagree.
      const policyTimeline = await this.loadPolicyTimelineTx(manager, user.id)
      const probation =
        policyTimeline && leaveDays.length > 0
          ? probationForcedDays(
              policyTimeline,
              user.employmentStartDate ?? null,
              input.leaveType,
              leaveDays,
            )
          : { forcedDays: [] as string[] }
      const probationForced = new Set(probation.forcedDays)
      const eligibleDays = leaveDays.filter(
        (day) => !probationForced.has(day),
      )
      const report = await this.evaluatePlannedCommitments(manager, {
        userId: user.id,
        leaveType: input.leaveType,
        nowDay: asOf.day,
        anchor: user.employmentStartDate ?? null,
        ...(leaveDays.length > 0
          ? { candidate: { leaveDays: eligibleDays, portions } }
          : {}),
        ...(excludeRequestIds.length > 0 ? { excludeRequestIds } : {}),
      })
      // Running past the projected balance is NOT a blocker: those days would
      // be taken unpaid, which the split below reports instead.
      const split = report.candidateSplit
      const unpaidDates = [
        ...probation.forcedDays,
        ...(split?.unpaidDates ?? []),
      ].sort()
      // What the period costs and what of it goes unfunded, both priced from
      // the same map: a date is funded whole, so the unpaid set carries its own
      // portions with it.
      const requestedCost = sumPortions(leaveDays, portions)
      const unpaidCost = sumPortions(unpaidDates, portions)

      // The outlook covers EVERY year the request touches, each row stamped
      // with its own year: a December→January preview needs January's month to
      // exist in the strip, and (year, month) is what identifies it there. It
      // counts the candidate's PAID days only, since unpaid days charge
      // nothing.
      const monthlyOutlook = touchedYears.flatMap((year) => {
        const projection = report.projections.get(year)
        return projection ? buildMonthlyOutlook(projection) : []
      })

      // The candidate's days and its unpaid days, bucketed by the year each
      // falls in. Both lists are ascending and the unpaid list is a filter of
      // the day list, so the difference per year is exactly the paid days the
      // fold marked for that year.
      //
      // The unpaid list is the MERGED one, probation days included, the same
      // set the header total is taken from. Bucketing the fold's own list
      // instead reported a probationer's forced days as paid in the per-year
      // rows and under-reported that year's commitments by the same amount,
      // while the header said otherwise on the same screen.
      const requestedByYear = bucketDaysByYear(leaveDays)
      const unpaidByYear = bucketDaysByYear(unpaidDates)

      // Every year the projection covers, not only the ones the range touches:
      // the composer puts the years side by side however short the range is,
      // and a January request has to show which carryover funds it. Dropped
      // past the horizon, where the allocation is guesswork.
      const years: LeaveYearProjectionDto[] = [...report.projections.values()]
        .filter((projection) => projection.year <= horizonYear)
        .sort((left, right) => left.year - right.year)
        .map((projection) => {
          const requestedHere = requestedByYear.get(projection.year) ?? []
          const requestedCostHere = sumPortions(requestedHere, portions)
          const unpaidHere = sumPortions(
            unpaidByYear.get(projection.year) ?? [],
            portions,
          )
          const paidHere = roundDays(requestedCostHere - unpaidHere)
          const lastLeaveDay = requestedHere.at(-1)
          return {
            year: projection.year,
            totalDays: projection.totalDays,
            carriedOverDays: projection.carriedOverDays,
            carryoverProjected: projection.carryoverProjected,
            accruedDays: projection.accruedDays,
            spentDays: projection.spentDays,
            // The fold folded the candidate's paid days into this list so the
            // accrual curve could be judged with them in. The DTO reports the
            // OTHER commitments, so a composer drawing its own request over the
            // year never charges its days twice.
            committedDays: roundDays(
              committedCost(projection.committedEntries) - paidHere,
            ),
            projectedAccruedByLeave: lastLeaveDay
              ? projection.projectedAt(lastLeaveDay)
              : projection.projectedYearEndAccrual,
            ...(lastLeaveDay ? { lastLeaveDay } : {}),
            projectedYearEndAccrual: projection.projectedYearEndAccrual,
            requestedDays: requestedCostHere,
            paidDays: paidHere,
            unpaidDays: unpaidHere,
            ...(projection.carryoverOutDays !== undefined
              ? { carryoverOutDays: projection.carryoverOutDays }
              : {}),
          }
        })

      return {
        leaveType: input.leaveType,
        leaveYear,
        startDate: input.startDate,
        endDate: input.endDate,
        requestedDays: requestedCost,
        // Derived by subtraction from the merged unpaid set, never taken from
        // the fold's own paid figure: the DTO promises paidDays + unpaidDays
        // === requestedDays, and only a subtraction can keep that exact.
        paidDays: roundDays(requestedCost - unpaidCost),
        unpaidDays: unpaidCost,
        unpaidDates,
        ...(unpaidDates.length > 0
          ? {
              unpaidNotice: [
                probation.forcedDays.length > 0 && probation.probationEnd
                  ? describeProbationDays(
                      sumPortions(probation.forcedDays, portions),
                      probation.probationEnd,
                      hoursPerDay,
                    )
                  : null,
                split && split.unpaidDays > 0
                  ? describeUnpaidDays(
                      input.leaveType,
                      sumPortions(eligibleDays, portions),
                      split.paidDays,
                      hoursPerDay,
                    )
                  : null,
              ]
                .filter((sentence) => sentence !== null)
                .join(' '),
            }
          : {}),
        ...(probation.forcedDays.length > 0 && probation.probationEnd
          ? { probationEnd: probation.probationEnd }
          : {}),
        feasible: blockers.length === 0,
        blockers,
        monthlyOutlook,
        years,
        currentYear,
        generatedAt,
      }
    })
  }

  /**
   * Propose new dates for an APPROVED leave that has not started yet.
   *
   * The change is not applied in place: it is submitted as a NEW request linked
   * back to the original, which keeps its approval (and its days) until every
   * approver has signed off on the replacement. That way a rejected change
   * costs the employee nothing — they still have the leave they had booked —
   * and approvers always decide on a concrete pair of before/after dates.
   *
   * Everything else is an ordinary submission, so it runs through the shared
   * core with the original excluded from the overlap and feasibility checks:
   * its days are released the moment the replacement is approved, so counting
   * them against the employee would refuse most useful changes (shifting a
   * booked week by one day would collide with itself).
   */
  async submitLeaveRequestModification(
    input: SubmitLeaveRequestModificationInput,
  ): Promise<LeaveRequestDetailDto> {
    return this.dataSource.transaction(async (manager) => {
      const original = await this.lockRequestForUpdate(
        manager,
        input.originalRequestId,
      )
      const submittedAt = input.submittedAt ?? this.clock.nowIso()

      if (original.requesterUserId !== input.requesterUserId) {
        throw new LeaveDomainValidationError(
          'You can only modify your own leave request.',
        )
      }
      if (original.status !== LeaveRequestStatus.Approved) {
        throw new LeaveDomainValidationError(
          'Only approved leave requests can be modified. A pending request can be cancelled and submitted again.',
        )
      }
      if (
        submittedAt.slice(0, 10) >= original.startDate ||
        Math.round(original.spentDaysConsumed) > 0
      ) {
        throw new LeaveDomainValidationError(
          'A leave that has already started can no longer be modified. Please contact an administrator.',
        )
      }
      const hasPendingReplacement = await manager
        .getRepository(LeaveRequestEntity)
        .existsBy({
          supersedesRequestId: original.id,
          status: LeaveRequestStatus.Pending,
        })
      if (hasPendingReplacement) {
        throw new LeaveDomainValidationError(
          'A modification for this leave is already awaiting approval.',
        )
      }

      const replacement = await this.createLeaveRequestTx(
        manager,
        {
          requesterUserId: input.requesterUserId,
          // Locked to the original: changing the type is a different leave
          // entirely, so it goes through cancel and re-submit.
          leaveType: original.leaveType,
          startDate: input.startDate,
          endDate: input.endDate,
          approverEmails: input.approverEmails,
          ccEmails: input.ccEmails,
          // Carried like the dates, not inherited from the original: the
          // modification re-states the whole shape of the absence, so an
          // absent map books every new date whole.
          ...(input.hoursByDate !== undefined
            ? { hoursByDate: input.hoursByDate }
            : {}),
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.audit !== undefined ? { audit: input.audit } : {}),
          submittedAt,
        },
        {
          supersedesRequestId: original.id,
          excludeRequestIds: [original.id],
          approvalNeededSummary: (requesterName, split) =>
            `${requesterName} requests a change to an approved ${formatLeaveTypeLabel(original.leaveType)}: ${input.startDate} to ${input.endDate}, previously ${original.startDate} to ${original.endDate}` +
            `${split.unpaidDays > 0 ? ` (${formatDayAmount(split.unpaidDays, split.hoursPerDay)} of ${formatDayAmount(split.requestedDays, split.hoursPerDay)} unpaid)` : ''}` +
            '. Your approval is needed again',
        },
      )

      // Leave a trace on the ORIGINAL too: its holder needs to see, on the
      // leave itself, that a change is pending against it.
      //
      // Skipped entirely when the replacement settled inside this same call
      // (approval optional, nobody addressed): promoteToApprovedTx has already
      // written the terminal 'superseded' entry at this very instant, and a
      // 'modification-requested' written after it would both claim a pending
      // change that no longer exists AND win the lastAction snapshot, because
      // addActivity's guard admits an equal occurredAt. The supersede entry is
      // the truthful last word on this request.
      if (replacement.status !== LeaveRequestStatus.Approved) {
        await this.addActivity(manager, {
          requestId: original.id,
          actorUserId: input.requesterUserId,
          action: 'modification-requested',
          occurredAt: submittedAt,
          comment: `Replacement request ${replacement.requestId} awaiting approval`,
        })
      }

      const requester = await this.requireUser(manager, input.requesterUserId)
      await this.auditLog.record(manager, {
        actor: input.audit ?? {
          userId: requester.id,
          label: requester.displayName,
          email: requester.email,
          roles: [],
        },
        eventType: AuditEventType.LeaveRequestModificationSubmitted,
        occurredAt: submittedAt,
        target: { userId: requester.id, label: requester.displayName },
        entityType: 'leave_request',
        entityId: replacement.requestId,
        summary: `Requested a change to ${original.leaveType} leave ${original.startDate} to ${original.endDate}: now ${input.startDate} to ${input.endDate}`,
        before: snapshotRequest(original),
        after: {
          status: replacement.status,
          leaveType: replacement.leaveType,
          startDate: replacement.startDate,
          endDate: replacement.endDate,
          requestedDays: replacement.requestedDays,
          supersedesRequestId: original.id,
        },
        requestId: replacement.requestId,
      })

      return this.buildRequestDetail(
        manager,
        await this.requireRequest(manager, replacement.requestId),
      )
    })
  }

  /**
   * Flip a request to Approved — and, when it is a REPLACEMENT, carry out the
   * swap in the same breath: the original's hold is released and it becomes
   * Superseded, so the days sit on exactly one request at every instant. Every
   * path that can settle the gate (an approver's final vote, an admin override,
   * removing the last blocking approver) routes through here; a swap that only
   * some of them performed would leave the original holding days for leave
   * nobody is taking.
   *
   * The caller already holds the replacement's row lock; this takes the
   * original's second. That order (replacement, then original) is the ONLY
   * place two request rows are locked at once, so there is no cycle to
   * deadlock on. Any future dual-lock path must follow the same order.
   */
  private async promoteToApprovedTx(
    manager: EntityManager,
    request: LeaveRequestEntity,
    occurredAt: string,
    decisionComment: string | null,
    actor: AuditActor,
  ): Promise<LeaveRequestEntity | null> {
    const requestRepo = manager.getRepository(LeaveRequestEntity)
    let superseded: LeaveRequestEntity | null = null

    if (request.supersedesRequestId) {
      let original = await this.lockRequestForUpdate(
        manager,
        request.supersedesRequestId,
      )
      if (original.status === LeaveRequestStatus.Approved) {
        // Settle the original's consumption first, then re-read it: reconcile
        // writes its own copy of the row, so the guard below must not judge a
        // stale one (and the save further down must not undo those writes).
        await this.reconcileApprovedLeaveTx(manager, {
          userId: original.requesterUserId,
          asOfIso: occurredAt,
        })
        original = await this.requireRequest(manager, original.id)

        // The window closed while this sat awaiting approval. Swapping now
        // would release a hold against days the employee has already taken,
        // so refuse and let the approvers reject it instead. Throwing rolls
        // back the entire decision, including the approver's recorded vote.
        if (
          occurredAt.slice(0, 10) >= original.startDate ||
          Math.round(original.spentDaysConsumed) > 0
        ) {
          throw new LeaveDomainValidationError(
            'The leave this change replaces has already started, so the change can no longer be approved. Reject it and ask the employee to submit a new request.',
          )
        }

        const originalBefore = snapshotRequest(original)
        await this.releaseHold(
          manager,
          original,
          occurredAt,
          `Released hold for superseded request ${original.id}`,
        )
        original.status = LeaveRequestStatus.Superseded
        await requestRepo.save(original)

        await this.addActivity(manager, {
          requestId: original.id,
          actorUserId: request.requesterUserId,
          action: 'superseded',
          occurredAt,
          comment: `Replaced by request ${request.id}`,
        })
        await this.auditLog.record(manager, {
          actor,
          eventType: AuditEventType.LeaveRequestSuperseded,
          occurredAt,
          target: {
            userId: original.requesterUserId,
            label: (await this.requireUser(manager, original.requesterUserId))
              .displayName,
          },
          entityType: 'leave_request',
          entityId: original.id,
          summary: `Replaced ${original.leaveType} leave ${original.startDate} to ${original.endDate} with ${request.startDate} to ${request.endDate}`,
          before: originalBefore,
          after: snapshotRequest(original),
          requestId: original.id,
        })
        superseded = original
      }
      // An original that is no longer Approved (cancelled or already replaced)
      // simply has nothing to swap: the replacement is approved on its own.
    }

    request.status = LeaveRequestStatus.Approved
    request.decidedAt = occurredAt
    request.decisionComment = decisionComment
    await requestRepo.save(request)
    return superseded
  }

  // Release a request's still-held days back to the balance exactly once,
  // ONE RELEASE PER YEAR still holding any: the per-year remainder is derived
  // from the frozen day lists and the consumption cursor — the same split the
  // holds were posted from — so each year gets back exactly what it holds. The
  // caller must already hold the request-row lock and have observed a valid
  // terminal transition, so this cannot double-release.
  private async releaseHold(
    manager: EntityManager,
    request: LeaveRequestEntity,
    occurredAt: string,
    note: string,
  ): Promise<void> {
    if (request.remainingHeldDays <= 0) {
      return
    }
    for (const [year, days] of remainingPaidDaysByYear(request)) {
      // What that year still holds, priced the way it was held: giving back a
      // day per date would credit days the request never took.
      const stillHeld = committedCost(days)
      await this.recordBalanceChange(manager, {
        userId: request.requesterUserId,
        leaveType: request.leaveType,
        year,
        reason: LeaveBalanceChangeReason.Release,
        effectiveDate: occurredAt.slice(0, 10),
        occurredAt,
        deltaDays: stillHeld,
        onHoldDelta: -stillHeld,
        spentDelta: 0,
        accruedDelta: 0,
        note,
      })
    }
    request.remainingHeldDays = 0
    await manager.getRepository(LeaveRequestEntity).save(request)
  }

  async decideLeaveRequest(
    input: DecideLeaveRequestInput,
  ): Promise<LeaveRequestDetailDto> {
    if (
      input.action !== LeaveApprovalAction.Approve &&
      input.action !== LeaveApprovalAction.Reject
    ) {
      throw new LeaveDomainValidationError(
        `Unsupported leave approval action: ${String(input.action)}`,
      )
    }
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(LeaveRequestEntity)
      const request = await this.lockRequestForUpdate(manager, input.requestId)
      if (request.status !== LeaveRequestStatus.Pending) {
        throw new LeaveDomainValidationError(
          'Only pending leave requests can be decided.',
        )
      }
      if (input.actorUserId === request.requesterUserId) {
        throw new LeaveDomainValidationError(
          'You cannot decide your own leave request.',
        )
      }

      // Point-in-time before-state for the audit diff, captured while the request
      // is still Pending (before the decision may flip it to Approved/Rejected).
      const auditBefore = snapshotRequest(request)

      const approvers = await this.loadApprovers(manager, request.id)
      const toApprovers = approvers.filter((approver) => approver.kind === ApproverKind.To)
      if (toApprovers.length === 0) {
        throw new LeaveDomainValidationError(
          'Leave request has no approvers authorized to decide it.',
        )
      }
      const actorEmail = normalizeEmail(input.actorEmail)
      const actingRow = toApprovers.find(
        (approver) => normalizeEmail(approver.email) === actorEmail,
      )
      if (!actingRow) {
        throw new LeaveDomainValidationError(
          'You are not an approver for this leave request.',
        )
      }

      // A vote is cast once. The application layer refuses a second vote from
      // the read snapshot, but that snapshot is taken before this transaction,
      // so two concurrent votes (a double-click, or a retry) could both pass it.
      // This re-check runs under the FOR UPDATE lock taken above, where it is
      // authoritative: whichever vote commits first, the other finds the row
      // already decided here and is rejected rather than silently overwriting it.
      if (actingRow.decision !== ApproverDecision.Pending) {
        throw new LeaveDomainValidationError(
          'You have already decided this leave request.',
        )
      }

      const decidedAt = input.decidedAt ?? this.clock.nowIso()
      const decisionActor: AuditActor = input.audit ?? {
        userId: input.actorUserId,
        label: input.actorDisplayName,
        email: input.actorEmail ?? null,
        roles: [],
      }
      // Set when this approval also replaced an earlier booking, so the
      // requester's notification can say which dates went away.
      let supersededOriginal: LeaveRequestEntity | null = null

      // Immutable log of every action.
      const decisionRepo = manager.getRepository(LeaveApprovalDecisionEntity)
      await decisionRepo.save(
        decisionRepo.create({
          id: randomUUID(),
          requestId: request.id,
          actorUserId: input.actorUserId,
            action: input.action,
          occurredAt: decidedAt,
          comment: input.comment ?? null,
        }),
      )

      // Current per-approver state (last-wins) drives the gate.
      actingRow.decision =
        input.action === LeaveApprovalAction.Approve
          ? ApproverDecision.Approved
          : ApproverDecision.Rejected
      actingRow.decidedAt = decidedAt
      actingRow.decisionComment = input.comment ?? null
      actingRow.actorUserId = input.actorUserId
      // Snapshot the decider's display name: submit knows approvers only by
      // email, and the final-approval sentence names everyone who signed off.
      // The acting row IS the actor's own (matched by their email above).
      actingRow.displayName = input.actorDisplayName
      await manager.getRepository(LeaveRequestApproverEntity).save(actingRow)

      // Progress after recording THIS approver's decision. A non-final
      // approval is labelled with it ('approved (1 of 2)') so the feed's
      // request card never shows a bare 'Approved' next to a Pending chip.
      const approvedToCount = toApprovers.filter(
        (approver) => approver.decision === ApproverDecision.Approved,
      ).length
      const allToApproved = approvedToCount === toApprovers.length
      const action =
        input.action === LeaveApprovalAction.Approve
          ? allToApproved
            ? 'approved'
            : `approved (${approvedToCount} of ${toApprovers.length})`
          : 'rejected'

      if (input.action === LeaveApprovalAction.Reject) {
        // Any single 'to' reject is terminal.
        request.status = LeaveRequestStatus.Rejected
        request.decidedAt = decidedAt
        request.decisionComment = input.comment ?? null
        await requestRepo.save(request)
        await this.releaseHold(
          manager,
          request,
          decidedAt,
          `Released hold for rejected request ${request.id}`,
        )
      } else if (allToApproved) {
        // Promote only when EVERY 'to' approver has approved.
        supersededOriginal = await this.promoteToApprovedTx(
          manager,
          request,
          decidedAt,
          input.comment ?? null,
          decisionActor,
        )
      }
      // Otherwise the request stays Pending awaiting the remaining approvers;
      // request.decidedAt stays null (it records the FINAL decision only).

      await this.addActivity(manager, {
        requestId: request.id,
        actorUserId: input.actorUserId,
        action,
        occurredAt: decidedAt,
        comment: input.comment,
      })

      const requester = await this.requireUser(manager, request.requesterUserId)
      await this.auditLog.record(manager, {
        actor: decisionActor,
        eventType:
          input.action === LeaveApprovalAction.Approve
            ? AuditEventType.LeaveRequestApproved
            : AuditEventType.LeaveRequestRejected,
        occurredAt: decidedAt,
        target: { userId: requester.id, label: requester.displayName },
        entityType: 'leave_request',
        entityId: request.id,
        summary: `${input.actorDisplayName} ${action} ${requester.displayName}'s leave request`,
        before: auditBefore,
        after: snapshotRequest(request),
        requestId: request.id,
      })

      // Tell the requester. Keyed off the LOCAL action/allToApproved, never off
      // request.status: a non-final approval deliberately leaves the request
      // Pending with decidedAt null, so a status-driven branch would silently
      // swallow the "approved (1 of 2)" event.
      //
      // The FINAL approval belongs to everyone who signed off, not to whoever
      // happened to vote last — the sentence names all of them in vote order
      // (the client renders this row impersonally for the same reason).
      const finalApprovalSubject =
        input.action === LeaveApprovalAction.Approve && allToApproved
          ? listApproverNames(
              [...toApprovers]
                .sort((a, b) =>
                  (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''),
                )
                .map((approver) => approver.displayName ?? approver.email),
            )
          : null
      await this.notifications.record(manager, {
        recipientUserId: request.requesterUserId,
        actorUserId: input.actorUserId,
        actorLabel: input.actorDisplayName,
        type:
          input.action === LeaveApprovalAction.Reject
            ? NotificationType.RequestRejected
            : allToApproved
              ? NotificationType.RequestApproved
              : NotificationType.ApprovalProgressed,
        requestId: request.id,
        occurredAt: decidedAt,
        summary: `${finalApprovalSubject ?? input.actorDisplayName} ${action} your ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}${supersededOriginal ? `, replacing the previous dates ${supersededOriginal.startDate} to ${supersededOriginal.endDate}` : ''}`,
      })

      // Close the asks this decision answered. The actor's own ask closes on
      // ANY vote (a vote is cast once, so their question is spent either way);
      // everyone else's only when the decision is terminal. Order matters: the
      // actor's row is closed first with the plain sentence, so the broader
      // reject sweep below — which appends "your decision is no longer
      // needed" — can only reach the OTHER approvers' rows.
      const decisionVerb =
        input.action === LeaveApprovalAction.Approve ? 'approved' : 'rejected'
      const decisionPhrase = `${decisionVerb} ${possessive(requester.displayName)} ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}`
      await this.notifications.resolveOpenRows(manager, {
        requestId: request.id,
        recipientUserId: input.actorUserId,
        types: [NotificationType.ApprovalNeeded],
        resolvedByUserId: input.actorUserId,
        resolvedByLabel: input.actorDisplayName,
        resolutionText: decisionPhrase,
        occurredAt: decidedAt,
      })
      if (input.action === LeaveApprovalAction.Reject) {
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          types: [NotificationType.ApprovalNeeded],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: input.actorDisplayName,
          resolutionText: `${decisionPhrase} — your decision is no longer needed`,
          occurredAt: decidedAt,
        })
      }
      if (input.action === LeaveApprovalAction.Reject || allToApproved) {
        // The requester's progress trail is only over when the request is:
        // after a non-final approval the request IS still in progress, and
        // hiding the "approved (1 of 2)" row then would erase live history.
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          types: [NotificationType.ApprovalProgressed],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: input.actorDisplayName,
          resolutionText: decisionPhrase,
          occurredAt: decidedAt,
        })
      }

      return this.buildRequestDetail(manager, request)
    })
  }

  /**
   * Admin override that bypasses the per-approver gate (e.g. a departed 'to'
   * approver blocks a request). Sets the request status directly and does NOT
   * fabricate per-approver decisions on the approver rows; the override is
   * recorded only in the decision/activity/audit log.
   *
   * A written reason is mandatory: this is the one operation that overrules
   * people who were explicitly asked to approve, and since the approver rows
   * stay 'pending' the reason is the only account of why.
   */
  async forceDecideLeaveRequest(
    input: ForceDecideLeaveRequestInput,
  ): Promise<LeaveRequestDetailDto> {
    return this.dataSource.transaction((manager) =>
      this.forceDecideLeaveRequestTx(manager, input),
    )
  }

  /**
   * Transaction-scoped core of the admin override, exposed for the history
   * import, which settles a whole employee timeline inside ONE transaction
   * (calling the public wrapper from there would open a second connection and
   * deadlock against the advisory locks the outer transaction already holds).
   * Behavior is identical to forceDecideLeaveRequest.
   */
  async forceDecideLeaveRequestTx(
    manager: EntityManager,
    input: ForceDecideLeaveRequestInput,
  ): Promise<LeaveRequestDetailDto> {
    if (
      input.action !== LeaveApprovalAction.Approve &&
      input.action !== LeaveApprovalAction.Reject
    ) {
      throw new LeaveDomainValidationError(
        `Unsupported leave approval action: ${String(input.action)}`,
      )
    }
    // Guarded at runtime rather than by the input type: `comment` is optional on
    // LeaveApprovalActionDto (the gated approver path may legitimately omit it),
    // and this way non-HTTP callers cannot record an unexplained override either.
    const reason = typeof input.comment === 'string' ? input.comment.trim() : ''
    if (reason === '') {
      throw new LeaveDomainValidationError(
        'An override reason is required to bypass the approver gate.',
      )
    }
    {
      const requestRepo = manager.getRepository(LeaveRequestEntity)
      const request = await this.lockRequestForUpdate(manager, input.requestId)
      if (request.status !== LeaveRequestStatus.Pending) {
        throw new LeaveDomainValidationError(
          'Only pending leave requests can be decided.',
        )
      }
      if (input.actorUserId === request.requesterUserId) {
        throw new LeaveDomainValidationError(
          'You cannot decide your own leave request.',
        )
      }

      const auditBefore = snapshotRequest(request)
      const decidedAt = input.decidedAt ?? this.clock.nowIso()
      const approve = input.action === LeaveApprovalAction.Approve
      const action = approve ? 'force-approved' : 'force-rejected'
      const overrideActor: AuditActor = input.audit ?? {
        userId: input.actorUserId,
        label: input.actorDisplayName,
        email: null,
        roles: [],
      }

      const decisionRepo = manager.getRepository(LeaveApprovalDecisionEntity)
      await decisionRepo.save(
        decisionRepo.create({
          id: randomUUID(),
          requestId: request.id,
          actorUserId: input.actorUserId,
            action: input.action,
          occurredAt: decidedAt,
          comment: reason,
        }),
      )
      // An override still goes through the shared promotion, so force-approving
      // a modification performs the same swap (and honours the same
      // already-started guard) as the ordinary gate would.
      let supersededOriginal: LeaveRequestEntity | null = null
      if (approve) {
        supersededOriginal = await this.promoteToApprovedTx(
          manager,
          request,
          decidedAt,
          reason,
          overrideActor,
        )
      } else {
        request.status = LeaveRequestStatus.Rejected
        request.decidedAt = decidedAt
        request.decisionComment = reason
        await requestRepo.save(request)
        await this.releaseHold(
          manager,
          request,
          decidedAt,
          `Released hold for force-rejected request ${request.id}`,
        )
      }

      await this.addActivity(manager, {
        requestId: request.id,
        actorUserId: input.actorUserId,
        action,
        occurredAt: decidedAt,
        comment: reason,
      })

      const requester = await this.requireUser(manager, request.requesterUserId)
      await this.auditLog.record(manager, {
        actor: overrideActor,
        eventType: approve
          ? AuditEventType.LeaveRequestForceApproved
          : AuditEventType.LeaveRequestForceRejected,
        occurredAt: decidedAt,
        target: { userId: requester.id, label: requester.displayName },
        entityType: 'leave_request',
        entityId: request.id,
        summary: `${input.actorDisplayName} force-${approve ? 'approved' : 'rejected'} ${requester.displayName}'s leave request`,
        before: auditBefore,
        after: snapshotRequest(request),
        requestId: request.id,
      })

      // The override settled it outright, so the requester learns the final
      // outcome. The summary names the override and its reason: the approver
      // rows stay 'pending', so this sentence is the only account they get.
      // A history-import replay opts out: the outcome it records is months old.
      if (!input.suppressNotifications) {
        await this.notifications.record(manager, {
          recipientUserId: request.requesterUserId,
          actorUserId: input.actorUserId,
          actorLabel: input.actorDisplayName,
          type: approve
            ? NotificationType.RequestApproved
            : NotificationType.RequestRejected,
          requestId: request.id,
          occurredAt: decidedAt,
          summary: `${input.actorDisplayName} ${action} your ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}${supersededOriginal ? `, replacing the previous dates ${supersededOriginal.startDate} to ${supersededOriginal.endDate}` : ''}: ${reason}`,
        })
      }

      // The override closes every question still open on this request in one
      // sweep: the approvers who never voted and the requester's progress
      // trail alike. Plain verb, no "force" wording — what the recipient needs
      // is the outcome and who settled it, not the mechanism.
      await this.notifications.resolveOpenRows(manager, {
        requestId: request.id,
        types: [
          NotificationType.ApprovalNeeded,
          NotificationType.ApprovalProgressed,
        ],
        resolvedByUserId: input.actorUserId,
        resolvedByLabel: input.actorDisplayName,
        resolutionText: `${approve ? 'approved' : 'rejected'} ${possessive(requester.displayName)} ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}`,
        occurredAt: decidedAt,
      })

      return this.buildRequestDetail(manager, request)
    }
  }

  /**
   * Admin removal of a 'to' approver from a pending request (e.g. one who has
   * left the company and is blocking the gate). Refuses to remove the last
   * approver so the gate can never become vacuous, and re-evaluates the gate:
   * removing the last outstanding blocker completes the approval.
   */
  async removeLeaveRequestApprover(
    input: RemoveLeaveRequestApproverInput,
  ): Promise<LeaveRequestDetailDto> {
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(LeaveRequestEntity)
      const request = await this.lockRequestForUpdate(manager, input.requestId)
      if (request.status !== LeaveRequestStatus.Pending) {
        throw new LeaveDomainValidationError(
          'Only pending leave requests can be modified.',
        )
      }
      const approvers = await this.loadApprovers(manager, request.id)
      const toApprovers = approvers.filter((approver) => approver.kind === ApproverKind.To)
      const targetEmail = normalizeEmail(input.email)
      const target = toApprovers.find(
        (approver) => normalizeEmail(approver.email) === targetEmail,
      )
      if (!target) {
        throw new LeaveDomainValidationError(
          'No such approver on this leave request.',
        )
      }
      if (toApprovers.length <= 1) {
        throw new LeaveDomainValidationError(
          'Cannot remove the last approver from a leave request.',
        )
      }

      await manager
        .getRepository(LeaveRequestApproverEntity)
        .delete({ id: target.id })

      const occurredAt = this.clock.nowIso()
      // Re-evaluate the gate: removing a blocker may complete the approval. One
      // expression drives both the status write and the notification below, so
      // the request can never reach Approved without the requester hearing it —
      // this path settles requests without ever calling decideLeaveRequest.
      const remaining = toApprovers.filter(
        (approver) => approver.id !== target.id,
      )
      const promoted = remaining.every(
        (approver) => approver.decision === ApproverDecision.Approved,
      )
      const removalActor: AuditActor = input.audit ?? {
        userId: input.actorUserId,
        label: input.actorDisplayName,
        email: null,
        roles: [],
      }
      // Removing the last blocker settles the request here, without ever
      // calling decideLeaveRequest — so the swap has to happen on this path
      // too, or an approved modification would leave the original holding days.
      let supersededOriginal: LeaveRequestEntity | null = null
      if (promoted) {
        supersededOriginal = await this.promoteToApprovedTx(
          manager,
          request,
          occurredAt,
          request.decisionComment,
          removalActor,
        )
      }

      await this.addActivity(manager, {
        requestId: request.id,
        actorUserId: input.actorUserId,
        action: 'approver-removed',
        occurredAt,
        comment: target.email,
      })

      const requester = await this.requireUser(manager, request.requesterUserId)
      await this.auditLog.record(manager, {
        actor: removalActor,
        eventType: AuditEventType.LeaveRequestApproverRemoved,
        occurredAt,
        target: { userId: requester.id, label: requester.displayName },
        entityType: 'leave_request_approver',
        entityId: target.id,
        summary: `${input.actorDisplayName} removed approver ${target.email} from ${requester.displayName}'s leave request`,
        before: {
          email: target.email,
          kind: target.kind,
          decision: target.decision,
        },
        requestId: request.id,
      })

      // Only when the removal actually settled the request: a removal that still
      // leaves someone outstanding is administrative housekeeping the requester
      // has no reason to hear about.
      if (promoted) {
        await this.notifications.record(manager, {
          recipientUserId: request.requesterUserId,
          actorUserId: input.actorUserId,
          actorLabel: input.actorDisplayName,
          type: NotificationType.RequestApproved,
          requestId: request.id,
          occurredAt,
          summary: `Your ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate} was approved after ${input.actorDisplayName} removed approver ${target.email}${supersededOriginal ? `, replacing the previous dates ${supersededOriginal.startDate} to ${supersededOriginal.endDate}` : ''}`,
        })
      }

      // The removed approver's ask is void either way — they were told their
      // decision was needed and it no longer is. Their notification rows are
      // keyed by user id, so an approver row whose email never matched an
      // account has no ask to close.
      const removedUser = await manager
        .getRepository(UserEntity)
        .findOneBy({ normalizedEmail: targetEmail })
      if (removedUser) {
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          recipientUserId: removedUser.id,
          types: [NotificationType.ApprovalNeeded],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: input.actorDisplayName,
          resolutionText: `removed you as an approver of ${possessive(requester.displayName)} ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}`,
          occurredAt,
        })
      }
      if (promoted) {
        // The removal settled the request without a decideLeaveRequest call,
        // so the requester's progress trail must be closed here too.
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          types: [NotificationType.ApprovalProgressed],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: input.actorDisplayName,
          resolutionText: `approved ${possessive(requester.displayName)} ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate} after removing approver ${target.email}`,
          occurredAt,
        })
      }

      return this.buildRequestDetail(manager, request)
    })
  }

  async cancelLeaveRequest(
    input: CancelLeaveRequestInput,
  ): Promise<LeaveRequestDetailDto> {
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(LeaveRequestEntity)
      // Lock so a concurrent reject/force cannot double-release the hold.
      const request = await this.lockRequestForUpdate(manager, input.requestId)
      const occurredAt = input.occurredAt ?? this.clock.nowIso()
      await this.assertCancellable(manager, request, occurredAt)

      const auditBefore = snapshotRequest(request)
      const wasApproved = request.status === LeaveRequestStatus.Approved
      request.status = LeaveRequestStatus.Cancelled
      request.decidedAt = occurredAt
      request.decisionComment = input.comment ?? null
      await requestRepo.save(request)

      await this.releaseHold(
        manager,
        request,
        occurredAt,
        `Released hold for cancelled request ${request.id}`,
      )

      await this.addActivity(manager, {
        requestId: request.id,
        actorUserId: input.actorUserId,
        action: 'cancelled',
        occurredAt,
        comment: input.comment,
      })

      await this.auditLog.record(manager, {
        actor: input.audit ?? {
          userId: input.actorUserId,
          label: input.actorDisplayName,
          email: null,
          roles: [],
        },
        eventType: AuditEventType.LeaveRequestCancelled,
        occurredAt,
        target: {
          userId: request.requesterUserId,
          label: input.actorDisplayName,
        },
        entityType: 'leave_request',
        entityId: request.id,
        summary: `Cancelled ${wasApproved ? 'approved ' : ''}${request.leaveType} leave ${request.startDate} to ${request.endDate}`,
        before: auditBefore,
        after: snapshotRequest(request),
        requestId: request.id,
      })

      const requester = await this.requireUser(manager, request.requesterUserId)
      const approverUserIds = await this.resolveToApproverUserIds(
        manager,
        await this.loadApprovers(manager, request.id),
      )
      // The DB display name when the requester cancels their own request, the
      // session-supplied name otherwise — both branches attribute the same way.
      const cancellerLabel =
        input.actorUserId === request.requesterUserId
          ? requester.displayName
          : input.actorDisplayName
      if (wasApproved) {
        // Cancelling an APPROVED leave is genuine news to the approvers: they
        // signed it off, and now the days are released. Their ask rows were
        // already closed by their own votes, so nothing resolves here — this
        // appends the one notification kind the Updates tab carries.
        //
        // Read inside the branch: only this sentence names an amount, and a
        // cancelled pending request has nothing to render it for.
        const { hoursPerDay } = await this.loadSettingsState(manager)
        await this.notifications.recordMany(
          manager,
          approverUserIds.map((recipientUserId) => ({
            recipientUserId,
            actorUserId: input.actorUserId,
            actorLabel: cancellerLabel,
            type: NotificationType.RequestCancelled,
            requestId: request.id,
            occurredAt,
            summary:
              `${cancellerLabel} cancelled the approved ${formatLeaveTypeLabel(request.leaveType)} for ${request.startDate} to ${request.endDate} before it started; ` +
              describeReleasedDays(request, hoursPerDay),
          })),
        )
      } else {
        // Cancelling a PENDING request does two separate things, and they do
        // not repeat each other. The asks RESOLVE — the chip flips to Closed
        // and the row leaves the Action needed counter, while its frozen
        // summary (the original request, under the request's own date) stays
        // the rendered text. The retraction itself is NEWS and rides its own
        // request_cancelled row, sent to EVERY 'to' approver: an approver who
        // already voted has no open ask left to resolve, and this row is the
        // only way they learn the request is gone.
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          types: [NotificationType.ApprovalNeeded],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: cancellerLabel,
          resolutionText: `cancelled the ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate} — no decision is needed`,
          occurredAt,
        })
        // The requester's own progress trail closes too. A resolved progress
        // row is not served by the feed at all — the trail simply ends; the
        // requester needs no row about their own action.
        await this.notifications.resolveOpenRows(manager, {
          requestId: request.id,
          types: [NotificationType.ApprovalProgressed],
          resolvedByUserId: input.actorUserId,
          resolvedByLabel: cancellerLabel,
          resolutionText: `cancelled the ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}`,
          occurredAt,
        })
        // The news states the request's fact and nothing else: "no decision is
        // needed" belongs to the ASK's resolution (addressed to someone whose
        // question was open), not to a row a voter also receives.
        await this.notifications.recordMany(
          manager,
          approverUserIds.map((recipientUserId) => ({
            recipientUserId,
            actorUserId: input.actorUserId,
            actorLabel: cancellerLabel,
            type: NotificationType.RequestCancelled,
            requestId: request.id,
            occurredAt,
            summary: `${cancellerLabel} cancelled the ${formatLeaveTypeLabel(request.leaveType)} request for ${request.startDate} to ${request.endDate}`,
          })),
        )
      }

      return this.buildRequestDetail(manager, request)
    })
  }

  /**
   * Who may still call off a leave. A pending request is simply withdrawn, as
   * before. An APPROVED one may be called off by the employee too, but only
   * while it has not started: once a leave day has been lived through it is
   * spent, and unwinding that is an administrative correction, not a
   * self-service action.
   *
   * The date comparison is the primary rule (a leave "starts" on its start
   * date); spentDaysConsumed is a belt against a clock or reconcile ordering
   * surprise. Dates are compared as UTC calendar days, the same convention the
   * rest of the request surface uses.
   */
  private async assertCancellable(
    manager: EntityManager,
    request: LeaveRequestEntity,
    occurredAt: string,
  ): Promise<void> {
    if (request.status === LeaveRequestStatus.Pending) {
      return
    }
    if (request.status !== LeaveRequestStatus.Approved) {
      throw new LeaveDomainValidationError(
        'Only pending or upcoming approved leave requests can be cancelled.',
      )
    }
    if (
      occurredAt.slice(0, 10) >= request.startDate ||
      Math.round(request.spentDaysConsumed) > 0
    ) {
      throw new LeaveDomainValidationError(
        'An approved leave that has already started can no longer be cancelled. Please contact an administrator.',
      )
    }
    // A replacement is pending against this leave: cancelling the original now
    // would leave the replacement pointing at nothing. Ask for the
    // modification to be withdrawn first, which is one click on the same page.
    const pendingReplacement = await manager
      .getRepository(LeaveRequestEntity)
      .existsBy({
        supersedesRequestId: request.id,
        status: LeaveRequestStatus.Pending,
      })
    if (pendingReplacement) {
      throw new LeaveDomainValidationError(
        'This leave has a modification awaiting approval. Cancel the modification first, then cancel the leave.',
      )
    }
  }

  async reconcileApprovedLeave(
    input: ReconcileApprovedLeaveInput,
  ): Promise<LeaveRequestDetailDto[]> {
    return this.dataSource.transaction(async (manager) => {
      const settled = await this.reconcileApprovedLeaveTx(manager, input)
      const details: LeaveRequestDetailDto[] = []
      for (const request of settled) {
        details.push(await this.buildRequestDetail(manager, request))
      }
      return details
    })
  }

  /**
   * Returns the requests it settled, as ENTITIES. Building a detail DTO per
   * request costs about eight queries, one of them the employee's whole ledger,
   * and both internal callers discard the result — so the mapping lives in the
   * public wrapper above, which is the only caller that reads it. That matters
   * doubly now: the catch-up calls this once per pending month boundary.
   */
  private async reconcileApprovedLeaveTx(
    manager: EntityManager,
    input: ReconcileApprovedLeaveInput,
  ): Promise<LeaveRequestEntity[]> {
    const requestRepo = manager.getRepository(LeaveRequestEntity)
    const candidates = await requestRepo.find({
      where: input.userId
        ? { status: LeaveRequestStatus.Approved, requesterUserId: input.userId }
        : { status: LeaveRequestStatus.Approved },
      // Consume in a deterministic submission order so ledger 'spent' entries
      // are ordered predictably.
      order: { submittedAt: 'ASC', id: 'ASC' },
    })

    // A leave day is spent once the END OF THE EMPLOYEE'S WORKING DAY, in the
    // employee's timezone, has passed relative to `now` (e.g. a Kyiv employee's
    // Dec 31 flips at its own midnight = 22:00 UTC). The ledger entry and
    // activity are dated to the LEAVE DAY itself (effectiveDate) and stamped at
    // that midnight, so a catch-up run keeps each day in its correct day/year
    // and time instead of collapsing onto the reconcile date. leaveDays
    // is ascending and consumed strictly from the front, so per-day entries stay
    // idempotent.
    //
    // That front-prefix cursor is also what makes this SLICEABLE, which the
    // catch-up in refreshBalancesTx relies on: called repeatedly with ascending
    // asOfIso inside one transaction, each call re-reads the cursor its
    // predecessor saved and consumes the next prefix, so the rows written are
    // the same ones a single call at the final instant would write — only
    // interleaved with the accrual and year-close rows at their own instants. A
    // call whose asOf has not moved on writes nothing at all.
    const nowMs = new Date(input.asOfIso).getTime()
    const settings = await this.loadSettingsState(manager)
    const zoneByUser = new Map<string, string>()
    const reconciled: LeaveRequestEntity[] = []
    for (const request of candidates) {
      const tz = await this.resolveSpendZoneTx(
        manager,
        request.requesterUserId,
        settings,
        zoneByUser,
      )
      const alreadyConsumed = Math.round(request.spentDaysConsumed)
      // The portion travels with the date from here: the cursor counts dates,
      // so the index a portion is aligned to is the offset into leaveDays, and
      // recovering it after the filter below would be wrong the day the filter
      // stops being a pure prefix.
      const newlyElapsed = request.leaveDays
        .slice(alreadyConsumed)
        .map((day, offset) => ({
          day,
          portion: portionAt(request.dayPortions, alreadyConsumed + offset),
        }))
        .filter(({ day }) => endOfDayUtc(day, tz).getTime() <= nowMs)
      if (newlyElapsed.length === 0) {
        continue
      }

      // Unpaid days elapse like any other: they pass, the leave moves on, but
      // nothing is drawn from the balance for them, so they post no ledger
      // entry. They still advance the cursor below, which is what tells the
      // cancel and modify guards this leave has started.
      const unpaid = new Set(request.unpaidLeaveDays)
      // An AMOUNT, not a count of dates: it is subtracted from the held
      // remainder below, which was posted in portions.
      let paidElapsed = 0
      for (const { day, portion } of newlyElapsed) {
        const occurredAt = endOfDayUtc(day, tz).toISOString()
        const isPaid = !unpaid.has(day)
        if (isPaid) {
          paidElapsed = roundDays(paidElapsed + portion)
          await this.recordBalanceChange(manager, {
            userId: request.requesterUserId,
            leaveType: request.leaveType,
            // The day's OWN year, not the request's anchor: a January day of a
            // December-anchored request spends the new year's balance, where
            // its hold sits.
            year: getYearFromIsoDate(day),
            reason: LeaveBalanceChangeReason.Spent,
            effectiveDate: day,
            occurredAt,
            deltaDays: portion,
            onHoldDelta: -portion,
            spentDelta: portion,
            accruedDelta: 0,
            // A whole day reads exactly as it always has: these notes are
            // frozen into the ledger and never recomputed, so every row filed
            // until now must keep saying what it said. Only a partial day has
            // anything to add.
            note:
              portion < 1
                ? `Consumed ${formatDayAmount(portion, settings.hoursPerDay)} of approved leave day ${day} for request ${request.id}`
                : `Consumed approved leave day ${day} for request ${request.id}`,
          })
        }

        // The activity is stamped at that midnight so the employee's
        // timeline and the admin feed show each consumed day at the right moment.
        // Partial days say so; a whole day keeps the wording every timeline
        // already shows.
        const portionSuffix =
          portion < 1 ? formatDayAmount(portion, settings.hoursPerDay) : ''
        const parts = [portionSuffix, isPaid ? '' : 'unpaid'].filter(
          (part) => part !== '',
        )
        await this.addActivity(manager, {
          requestId: request.id,
          systemActorLabel: 'System',
          action: 'consumed',
          occurredAt,
          comment:
            parts.length > 0
              ? `Leave day ${day} consumed (${parts.join(', ')})`
              : `Leave day ${day} consumed`,
        })
      }

      // Dates, not cost: the cursor is the slice position above, and the guard
      // that tells cancel and modify this leave has started.
      request.spentDaysConsumed = roundDays(
        request.spentDaysConsumed + newlyElapsed.length,
      )
      // Only paid days were ever held, so only they can be released by elapsing.
      request.remainingHeldDays = roundDays(
        request.remainingHeldDays - paidElapsed,
      )
      await requestRepo.save(request)

      reconciled.push(request)
    }
    return reconciled
  }

  /**
   * The employee's IANA zone, cached for one reconcile pass. A leave day is
   * spent at midnight on this calendar, so the zone is now the only thing spend
   * recognition needs: the per-employee working-day window it used to read is
   * gone, and with it the reason to configure one.
   */
  private async resolveSpendZoneTx(
    manager: EntityManager,
    userId: string,
    settings: LeaveSettingsState,
    cache: Map<string, string>,
  ): Promise<string> {
    const cached = cache.get(userId)
    if (cached) {
      return cached
    }
    const user = await manager
      .getRepository(UserEntity)
      .findOneBy({ id: userId })
    const tz = await this.resolveTimezoneTx(manager, user, settings)
    cache.set(userId, tz)
    return tz
  }

  /**
   * The employee's IANA timezone: their COUNTRY's zone (never the admin's),
   * else the settings default. The single definition, shared by spend
   * recognition and accrual — the two must agree on what day it is for this
   * person, or a leave day could be consumed on one calendar and accrued on
   * another.
   */
  private async resolveTimezoneTx(
    manager: EntityManager,
    user: Pick<UserEntity, 'countryCode'> | null,
    settings: LeaveSettingsState,
  ): Promise<string> {
    if (!user?.countryCode) {
      return settings.defaultTimezone
    }
    const country = await manager
      .getRepository(CountryEntity)
      .findOneBy({ code: user.countryCode })
    return country?.timezone ?? settings.defaultTimezone
  }

  /**
   * `instantIso` paired with the calendar day it falls on for this employee.
   * Every entry point that drives accrual resolves one of these once and passes
   * it down, so a single request cannot disagree with itself about the date.
   * Pass `user` when the caller already holds the row; otherwise it is loaded.
   */
  private async resolveAsOfTx(
    manager: EntityManager,
    userOrId: Pick<UserEntity, 'countryCode'> | string | null,
    instantIso: string,
  ): Promise<AsOf> {
    const user =
      typeof userOrId === 'string'
        ? await manager.getRepository(UserEntity).findOneBy({ id: userOrId })
        : userOrId
    const settings = await this.loadSettingsState(manager)
    const tz = await this.resolveTimezoneTx(manager, user, settings)
    return { iso: instantIso, day: localDayIso(instantIso, tz) }
  }

  async getLeaveRequestDetail(
    requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    const request = await this.requireRequest(this.manager, requestId)
    return this.buildRequestDetail(this.manager, request)
  }

  async getLeaveRequestHistory(
    userId: string,
    query?: ListMyLeaveRequestsQueryDto,
  ): Promise<LeaveRequestHistoryDto> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireUser(manager, userId)
      const generatedAt = this.clock.nowIso()
      await this.refreshBalancesTx(manager, userId, generatedAt)
      const entities = (await this.getUserRequests(manager, userId))
        .filter((request) =>
          query?.status ? request.status === query.status : true,
        )
        .filter((request) => {
          // Inclusive overlap of the request period with [from, to]. Either
          // bound may be absent. 'YYYY-MM-DD' compares correctly as a string.
          if (query?.from && request.endDate < query.from) {
            return false
          }
          if (query?.to && request.startDate > query.to) {
            return false
          }
          return true
        })
        .sort((left, right) =>
          right.submittedAt.localeCompare(left.submittedAt),
        )

      // Read once for the whole response and threaded into every request it
      // carries: one settings row, one query, however long the history is.
      const hoursPerDay = await this.getWorkdayHoursTx(manager)
      const requests: LeaveRequestDetailDto[] = []
      for (const entity of entities) {
        requests.push(await this.buildRequestDetail(manager, entity, hoursPerDay))
      }

      return {
        requests,
        balanceTimeline: await this.getBalanceTimelineTx(manager, userId),
        generatedAt,
        hoursPerDay,
      }
    })
  }

  async getEmployeeDashboard(userId: string): Promise<EmployeeDashboardDto> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, userId)

      // One canonical server instant, threaded through accrual, the year the
      // balances are keyed to, and the timestamp returned to the client — so the
      // frontend can anchor its "as of" display to exactly what was computed
      // (not a second, slightly later, clock read).
      const nowIso = this.clock.nowIso()
      const asOf = await this.resolveAsOfTx(manager, user, nowIso)
      await this.refreshBalancesTx(manager, userId, nowIso)

      const requests = (await this.getUserRequests(manager, userId)).sort(
        (left, right) => right.submittedAt.localeCompare(left.submittedAt),
      )
      // Requests awaiting a decision. A change to an approved leave shows up
      // here as its own pending row (carrying supersedesRequestId), so listing
      // the approved original alongside it would count one change twice.
      const pendingRequests = requests
        .filter((request) => request.status === LeaveRequestStatus.Pending)
        .map(requestSummary)

      const requestIds = requests.map((request) => request.id)
      const activities =
        requestIds.length > 0
          ? await manager.getRepository(LeaveRequestActivityEntity).find({
              where: { requestId: In(requestIds) },
              order: { createdAt: 'ASC', id: 'ASC' },
            })
          : []
      const activityNames = await this.resolveUserNames(
        manager,
        activities
          .map((entry) => entry.actorUserId)
          .filter((id): id is string => id !== null),
      )
      const recentActivity = activities
        .map((entry) => activityToDto(entry, activityNames))
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 10)

      // Years the composer may submit for: those with a configured holiday
      // calendar for the employee's country. The submit guard re-checks this
      // server-side; the list only lets the UI warn before the attempt.
      const holidayCalendarCountryCode =
        user.holidayCalendarCountryCode ?? user.countryCode ?? null
      const holidayCalendarYears = holidayCalendarCountryCode
        ? (
            await manager.getRepository(HolidayCalendarEntity).find({
              where: { countryCode: holidayCalendarCountryCode },
              select: { year: true },
              order: { year: 'ASC' },
            })
          ).map((calendar) => calendar.year)
        : []

      // The org's workday length, published for display only: it is the
      // divisor every day figure on an employee page is rendered as days and
      // hours against, and this is the one response every such page loads.
      const { hoursPerDay } = await this.loadSettingsState(manager)

      // Display-only policy facts (the holidayCalendarYears pattern: the UI
      // informs, the backend enforces).
      const policyFacts = policyFactsOf(
        await this.loadPolicyTimelineTx(manager, user.id),
        asOf.day,
        user.employmentStartDate ?? null,
      )
      const dashboardPolicyFacts = {
        ...(policyFacts.policyName ? { policyName: policyFacts.policyName } : {}),
        ...(policyFacts.probationEndsOn
          ? { probationEndsOn: policyFacts.probationEndsOn }
          : {}),
      }

      return {
        employeeId: user.id,
        displayName: user.displayName,
        roleNames: await this.getUserRoleNamesTx(manager, user.id),
        generatedAt: nowIso,
        profileStatus: employeeProfileStatus(user, asOf.day),
        employmentStartDate: orUndefined(user.employmentStartDate),
        holidayCalendarYears,
        hoursPerDay,
        countryCode: orUndefined(user.countryCode),
        holidayCalendarCountryCode: orUndefined(user.holidayCalendarCountryCode),
        ...dashboardPolicyFacts,
        balances: await this.buildBalanceDtos(manager, user.id, nowIso),
        pendingRequests,
        recentActivity,
      }
    })
  }

  async getAdminActivity(
    query?: AdminActivityQueryDto,
  ): Promise<AdminActivityFeedDto> {
    // Request-centric feed: one row per leave request with its LIVE status (the
    // per-event history stays on the request timeline). Reads ONLY the
    // leave_requests table: ordering and display come from the denormalized
    // (lastAction, lastActivityAt) snapshot maintained by addActivity, the page
    // is keyset-paginated in SQL on (lastActivityAt, id) like the audit log —
    // a positional cursor would re-serve or skip rows when a request is acted
    // on between page fetches. Totals (one GROUP BY) are computed for the
    // first page only; load-more clients already hold them.
    const repo = this.manager.getRepository(LeaveRequestEntity)
    const limit = clampLimit(query?.limit)

    // Applied to the page AND the totals query so the status cards count
    // exactly the filtered population — every filter, status included,
    // behaves the same way.
    const applyFilters = (qb: SelectQueryBuilder<LeaveRequestEntity>): void => {
      if (query?.employeeId) {
        qb.andWhere('request.requesterUserId = :employeeId', {
          employeeId: query.employeeId,
        })
      }
      if (query?.approverEmail) {
        // Approver emails are stored normalized (enforced by the column's
        // normalizedEmailTransformer), so normalizing the input allows an
        // exact, index-friendly match against the (requestId, email) unique
        // index. QueryBuilder parameters bypass transformers, hence the
        // explicit normalizeEmail here. Deciding approvers only (kind='to'),
        // same as the decision flow.
        qb.andWhere(
          (sub) =>
            `EXISTS ${sub
              .subQuery()
              .select('1')
              .from(LeaveRequestApproverEntity, 'approver')
              .where('approver.requestId = request.id')
              .andWhere('approver.kind = :approverKind')
              .andWhere('approver.email = :approverEmail')
              .getQuery()}`,
          {
            approverKind: ApproverKind.To,
            approverEmail: normalizeEmail(query.approverEmail),
          },
        )
      }
      if (query?.leaveType) {
        qb.andWhere('request.leaveType = :leaveType', {
          leaveType: query.leaveType,
        })
      }
      if (query?.status) {
        qb.andWhere('request.status = :status', { status: query.status })
      }
      // Inclusive overlap of the leave period with [from, to].
      if (query?.from) {
        qb.andWhere('request.endDate >= :from', { from: query.from })
      }
      if (query?.to) {
        qb.andWhere('request.startDate <= :to', { to: query.to })
      }
    }

    const pageQb = repo
      .createQueryBuilder('request')
      .orderBy('request.lastActivityAt', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .take(limit + 1)
    applyFilters(pageQb)
    const cursor = decodeKeysetCursor(query?.cursor)
    if (cursor) {
      // Keyset: rows strictly older than the cursor in (lastActivityAt, id)
      // order. A request updated mid-pagination bubbles above the cursor and
      // shows up at the top of a fresh first page instead of appearing twice.
      pageQb.andWhere(keysetWhere('request', 'lastActivityAt'), {
        cursorSortValue: cursor.sortValue,
        cursorId: cursor.id,
      })
    }

    const totalsQb = cursor
      ? undefined
      : repo
          .createQueryBuilder('request')
          .select('request.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .groupBy('request.status')
    if (totalsQb) {
      applyFilters(totalsQb)
    }

    const [rows, statusCounts] = await Promise.all([
      pageQb.getMany(),
      totalsQb?.getRawMany<{ status: LeaveRequestStatus; count: string }>(),
    ])

    const { page, nextCursor } = takeKeysetPage(rows, limit, (last) => ({
      sortValue: last.lastActivityAt,
      id: last.id,
    }))
    const names = await this.resolveUserNames(
      this.manager,
      page.map((request) => request.requesterUserId),
    )

    const items = page.map((request) => ({
      requestId: request.id,
      employeeId: request.requesterUserId,
      employeeDisplayName: names.get(request.requesterUserId) ?? '',
      status: request.status,
      leaveType: request.leaveType,
      startDate: request.startDate,
      endDate: request.endDate,
      requestedDays: request.requestedDays,
      paidDays: paidDaysOf(request),
      unpaidDays: unpaidDaysOf(request),
      heldDays: roundDays(Math.max(0, request.remainingHeldDays)),
      submittedAt: request.submittedAt,
      lastAction: request.lastAction,
      lastActivityAt: request.lastActivityAt,
    }))

    const countFor = (status: LeaveRequestStatus): number =>
      Number(statusCounts?.find((row) => row.status === status)?.count ?? 0)
    const pending = countFor(LeaveRequestStatus.Pending)
    const approved = countFor(LeaveRequestStatus.Approved)
    const rejected = countFor(LeaveRequestStatus.Rejected)
    const cancelled = countFor(LeaveRequestStatus.Cancelled)
    const superseded = countFor(LeaveRequestStatus.Superseded)

    return {
      items,
      totals: statusCounts
        ? {
            total: pending + approved + rejected + cancelled + superseded,
            pending,
            approved,
            rejected,
            cancelled,
            superseded,
          }
        : undefined,
      nextCursor,
      // On every page, not only the first: a load-more response is what the
      // console re-renders from, and the divisor is not something it may drop.
      hoursPerDay: await this.getWorkdayHours(),
    }
  }

  // Lightweight directory projection for the activity-feed filter dropdowns:
  // three columns, sorted in SQL. Unlike getAdminEmployeeList it hydrates no
  // balances/requests, and unlike listUsers it does not load full entities.
  async getAdminEmployeeOptions(): Promise<AdminEmployeeOptionDto[]> {
    const users = await this.manager.getRepository(UserEntity).find({
      select: { id: true, displayName: true, email: true },
      order: { displayName: 'ASC' },
    })
    return users.map((user) => ({
      employeeId: user.id,
      displayName: user.displayName,
      email: user.email,
    }))
  }

  // Directory + defaults preview for the employee request composer. The users
  // list excludes the requester (self-approval is rejected at submit) and
  // inactive employees (they are rejected when chosen explicitly and dropped
  // from defaults at submit). The defaults are previewed through the SAME
  // pipeline the submit merge uses — toRecipients (normalize, dedupe, 'to'
  // beats 'cc') plus the requester and inactive exclusions — so the locked
  // chips the form shows are exactly the rows submit will fold in. Default
  // addresses are matched to users only to decorate them with a display name;
  // an unmatched address is still a valid default.
  async getLeaveRequestFormContext(
    userId: string,
  ): Promise<LeaveRequestFormContextDto> {
    const requester = await this.requireUser(this.manager, userId)
    const users = await this.manager.getRepository(UserEntity).find({
      select: {
        id: true,
        displayName: true,
        email: true,
        normalizedEmail: true,
        active: true,
      },
      order: { displayName: 'ASC' },
    })
    const activeUsers = users.filter((user) => user.active)
    const displayNameByEmail = new Map(
      activeUsers.map((user) => [user.normalizedEmail, user.displayName]),
    )
    const isInactiveKnownUserInDirectory = (email: string): boolean => {
      const normalized = normalizeEmail(email)
      const match = users.find((user) => user.normalizedEmail === normalized)
      return match !== undefined && !match.active
    }
    const toPreview = (
      recipient: LeaveRequestApprovalRecipientDto,
    ): DefaultRecipientDto => {
      const displayName = displayNameByEmail.get(recipient.email)
      return {
        email: recipient.email,
        ...(displayName !== undefined ? { displayName } : {}),
      }
    }

    const settings = await this.loadSettingsState(this.manager)
    // The mode branch belongs in the ARGUMENTS, exactly as at submit: dropping
    // the deciding defaults afterwards would also erase an address that sits in
    // both lists (toRecipients gives 'to' precedence) from the cc preview,
    // while submit would still write it as a locked cc row.
    const defaults = toRecipients(
      settings.approvalRequired ? settings.defaultApproverEmails : [],
      settings.defaultCcApproverEmails,
    ).filter(
      (recipient) =>
        recipient.email !== requester.normalizedEmail &&
        !isInactiveKnownUserInDirectory(recipient.email),
    )

    return {
      users: activeUsers
        .filter((user) => user.id !== requester.id)
        .map((user) => ({
          userId: user.id,
          displayName: user.displayName,
          email: user.email,
        })),
      defaultApprovers: defaults
        .filter((recipient) => recipient.kind === ApproverKind.To)
        .map(toPreview),
      defaultCc: defaults
        .filter((recipient) => recipient.kind === ApproverKind.Cc)
        .map(toPreview),
      approvalRequired: settings.approvalRequired,
      // The composer books part days in HOURS and the server owns the divisor,
      // so the form has to be told how long a workday is. Published on this
      // employee-readable context rather than by opening the settings endpoint,
      // which is administrator-only and carries far more than this figure.
      hoursPerDay: settings.hoursPerDay,
    }
  }

  // A-to-Z keyset-paginated directory page. Filters and ordering live in SQL;
  // per-page role/project/latest-request data is loaded with three batched
  // queries. The former implementation walked every user with a ~16-query
  // cascade (including balance writes on a read path) — balances belong to the
  // per-employee detail, not the list.
  //
  // EVERY filter must narrow in SQL, never in memory afterwards: the page is
  // cut by `take(limit + 1)` before the rows are seen here, so dropping rows
  // after the fact would return short pages and a cursor that skips whatever
  // the discarded rows shadowed.
  async getAdminEmployeeList(
    query?: AdminEmployeesQueryDto,
  ): Promise<AdminEmployeeListDto> {
    // Read-only path: no transaction on purpose. READ COMMITTED gives
    // per-statement snapshots either way, and separate connections let the
    // batched lookups below run in parallel (a transaction would serialize
    // them on its single connection).
    const manager = this.manager
    const limit = clampLimit(query?.limit)
    const cursor = decodeKeysetCursor(query?.cursor, 'text')

    // The sort key is selected back from SQL so the follow-up cursor is
    // byte-identical to what ORDER BY compared — JS toLowerCase() can disagree
    // with PG lower() depending on the database locale (e.g. C ctype leaves
    // non-ASCII untouched), which would silently skip rows across pages.
    const qb = manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .addSelect('LOWER(u."displayName")', 'sort_key')
      // Quoted explicitly because TypeORM's property translation is not
      // guaranteed inside function expressions in ORDER BY.
      .orderBy('LOWER(u."displayName")', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .take(limit + 1)

    const searchTerm = query?.search?.trim()
    if (searchTerm) {
      // Escape LIKE metacharacters so a literal % or _ typed into the search
      // box matches itself instead of acting as a wildcard.
      const escaped = searchTerm.replace(/[\\%_]/g, (match) => `\\${match}`)
      qb.andWhere(
        '(u.displayName ILIKE :searchTerm OR u.email ILIKE :searchTerm)',
        { searchTerm: `%${escaped}%` },
      )
    }
    if (query?.roleName) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM user_roles role WHERE role."userId" = u.id AND role."roleName" = :roleName)',
        { roleName: query.roleName },
      )
    }
    if (query?.countryCode) {
      qb.andWhere('u."countryCode" = :countryCode', {
        countryCode: query.countryCode,
      })
    }
    // Tested for undefined, not truthiness: `false` asks for the deactivated
    // accounts and must not read as "no filter".
    if (query?.active !== undefined) {
      qb.andWhere('u.active = :active', { active: query.active })
    }
    if (query?.profile) {
      qb.andWhere(profileFilterWhere('u', query.profile))
    }
    // Both bounds are calendar days compared against a `date` column, which
    // carries no time of day and no zone — so there is no clock to read, no
    // timezone to resolve, and nothing for the cursor to pin. A row with no
    // start date satisfies neither bound, which is what makes a range asked
    // alongside MissingStartDate answer empty.
    if (query?.employmentStartDateFrom) {
      qb.andWhere('u."employmentStartDate" >= :employmentStartDateFrom', {
        employmentStartDateFrom: query.employmentStartDateFrom,
      })
    }
    if (query?.employmentStartDateTo) {
      qb.andWhere('u."employmentStartDate" <= :employmentStartDateTo', {
        employmentStartDateTo: query.employmentStartDateTo,
      })
    }
    if (query?.projectId) {
      // EXISTS rather than a join for the same reason the role filter uses it:
      // a join would make TypeORM switch `take` to two-phase pagination and
      // break the entities/raw alignment the sort_key readback depends on (see
      // the guard below), besides duplicating rows per membership.
      qb.andWhere(
        'EXISTS (SELECT 1 FROM user_project_memberships membership WHERE membership."userId" = u.id AND membership."projectId" = :projectId)',
        { projectId: query.projectId },
      )
    }
    if (query?.policyId) {
      // The employee's CURRENT policy: the live row covering today. Same
      // EXISTS-not-join rule as the project filter above.
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM leave_policy_memberships pm
           WHERE pm."userId" = u.id
             AND pm."policyId" = :policyId
             AND pm."supersededByRowId" IS NULL
             AND pm."effectiveFrom" <= CURRENT_DATE
             AND (pm."effectiveTo" IS NULL OR pm."effectiveTo" > CURRENT_DATE)
         )`,
        { policyId: query.policyId },
      )
    }
    if (cursor) {
      qb.andWhere(keysetWhereAsc('u', 'LOWER(u."displayName")'), {
        cursorSortValue: cursor.sortValue,
        cursorId: cursor.id,
      })
    }

    const { entities, raw } = await qb.getRawAndEntities<{
      sort_key: string
    }>()
    const { page, nextCursor } = takeKeysetPage(
      entities.map((user, index) => {
        const sortKey = raw[index]?.sort_key
        // Entities and raw rows align 1:1 only while this query has no joins
        // (TypeORM switches to two-phase pagination with joins + take). Fail
        // loudly rather than fall back to JS lowercasing, which would
        // silently reintroduce the locale-dependent cursor skew sort_key
        // exists to prevent.
        if (sortKey === undefined) {
          throw new Error(
            'Employee directory sort key misaligned with entities — did this query gain a join?',
          )
        }
        return { user, sortKey }
      }),
      limit,
      (last) => ({ sortValue: last.sortKey, id: last.user.id }),
    )
    const pageUsers = page.map((row) => row.user)
    const userIds = pageUsers.map((user) => user.id)

    const [roleRows, membershipRows, policyRows, latestRequests, totals] =
      await Promise.all([
        userIds.length
          ? manager.getRepository(UserRoleEntity).findBy({ userId: In(userIds) })
          : Promise.resolve([]),
        // One batched query for the whole page (the `project` relation joins in
        // the names), never one lookup per row.
        userIds.length
          ? manager.getRepository(UserProjectMembershipEntity).find({
              where: { userId: In(userIds) },
              relations: { project: true },
            })
          : Promise.resolve([]),
        // Same batching rule for the policy chip: one query for the page, the
        // `policy` relation joining in the name.
        userIds.length
          ? manager.getRepository(LeavePolicyMembershipEntity).find({
              where: { userId: In(userIds), supersededByRowId: IsNull() },
              relations: { policy: true },
              order: { effectiveFrom: 'ASC' },
            })
          : Promise.resolve([]),
        userIds.length
          ? manager
              .getRepository(LeaveRequestEntity)
              .createQueryBuilder('request')
              .distinctOn(['request.requesterUserId'])
              .where('request.requesterUserId IN (:...userIds)', { userIds })
              .orderBy('request.requesterUserId', 'ASC')
              .addOrderBy('request.submittedAt', 'DESC')
              .addOrderBy('request.id', 'DESC')
              .getMany()
          : Promise.resolve([]),
        // Directory-wide counters only on the first page; later pages reuse
        // the client's copy. They deliberately ignore EVERY list filter
        // — no argument reaches getAdminEmployeeTotals, so a filter added to
        // the query narrows the page and never these. The header cards describe
        // the whole directory, not the filtered window, exactly as they did
        // before any filter existed.
        cursor
          ? Promise.resolve(undefined)
          : this.getAdminEmployeeTotals(manager),
      ])

    const rolesByUser = new Map<string, AppRoleName[]>()
    for (const row of roleRows) {
      const list = rolesByUser.get(row.userId) ?? []
      list.push(row.roleName)
      rolesByUser.set(row.userId, list)
    }
    const projectsByUser = new Map<string, AdminEmployeeProjectDto[]>()
    for (const row of membershipRows) {
      // A membership whose project row vanished is skipped rather than
      // rendered as a nameless chip.
      if (!row.project) {
        continue
      }
      const list = projectsByUser.get(row.userId) ?? []
      list.push({ projectId: row.project.id, name: row.project.name })
      projectsByUser.set(row.userId, list)
    }
    const latestByUser = new Map(
      latestRequests.map((request) => [request.requesterUserId, request]),
    )

    // One clock read for the whole page so every row's profileStatus is judged
    // against the same instant (NotStartedYet vs Ready is a date comparison).
    const nowIso = this.clock.nowIso()
    // ...but resolved to each employee's OWN calendar day, the way the detail
    // card and the rest of the domain do it. A UTC day would let the list and
    // the card disagree across midnight for anyone east of Greenwich, which is
    // exactly what AdminEmployeeListItemDto.profileStatus promises not to do.
    const settings = await this.loadSettingsState(manager)
    const pageCountryCodes = [
      ...new Set(
        pageUsers
          .map((user) => user.countryCode)
          .filter((code): code is string => Boolean(code)),
      ),
    ]
    // One batched country lookup for the page, never one per row.
    const zoneByCountry = new Map(
      (pageCountryCodes.length
        ? await manager
            .getRepository(CountryEntity)
            .findBy({ code: In(pageCountryCodes) })
        : []
      ).map((country) => [country.code, country.timezone]),
    )
    const localDayFor = (user: UserEntity): string =>
      localDayIso(
        nowIso,
        (user.countryCode ? zoneByCountry.get(user.countryCode) : null) ??
          settings.defaultTimezone,
      )
    // The policy governing TODAY per user, on the same per-employee calendar
    // the status above uses. Rows arrive ascending by effectiveFrom: the last
    // one starting on or before today wins, and a lone future row still
    // labels the employee (the earliest membership extends backward).
    // A second pass over the SAME rows carries the facts the member list needs
    // (since when, a transfer already scheduled, the probation window): the
    // batch above loads every live row with its policy, so none of this costs
    // another query.
    const policyByUser = new Map<
      string,
      {
        policyId: string
        name: string
        since: string
        probationMonths: number
        scheduled?: { policyName: string; effectiveFrom: string }
      }
    >()
    for (const row of policyRows) {
      const owner = pageUsers.find((user) => user.id === row.userId)
      if (!row.policy || !owner) {
        continue
      }
      const today = localDayFor(owner)
      if (row.effectiveFrom > today) {
        // A future-dated row is the pending transfer, not the current policy.
        const current = policyByUser.get(row.userId)
        if (current && !current.scheduled) {
          current.scheduled = {
            policyName: row.policy.name,
            effectiveFrom: row.effectiveFrom,
          }
        }
        // The earliest membership extends backward, so a lone future row still
        // labels the employee.
        if (!current) {
          policyByUser.set(row.userId, {
            policyId: row.policy.id,
            name: row.policy.name,
            since: row.effectiveFrom,
            probationMonths: row.policy.probationMonths,
          })
        }
        continue
      }
      policyByUser.set(row.userId, {
        policyId: row.policy.id,
        name: row.policy.name,
        since: row.effectiveFrom,
        probationMonths: row.policy.probationMonths,
      })
    }
    const items: AdminEmployeeListItemDto[] = pageUsers.map((user) => {
      const latest = latestByUser.get(user.id)
      return {
        employeeId: user.id,
        displayName: user.displayName,
        email: user.email,
        roleNames: (rolesByUser.get(user.id) ?? []).sort(),
        active: user.active,
        profileStatus: employeeProfileStatus(user, localDayFor(user)),
        countryCode: orUndefined(user.countryCode),
        projects: (projectsByUser.get(user.id) ?? []).sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
        ...policyFactsForRow(policyByUser.get(user.id), user, localDayFor(user)),
        latestRequest: latest ? requestSummary(latest) : undefined,
      }
    })

    // The divisor the row balance meters render against; the settings row is
    // already loaded above for the per-employee timezone.
    return { items, totals, nextCursor, hoursPerDay: settings.hoursPerDay }
  }

  // Choices for the directory's Country and Project dropdowns. Countries are
  // narrowed to those actually assigned to a user (an unused one could only
  // filter the directory down to nothing); projects are the full mirrored
  // catalog. Like getAdminEmployeeOptions this hydrates nothing per user.
  async getAdminEmployeeFilterOptions(): Promise<AdminEmployeeFilterOptionsDto> {
    const [countries, projects, policies] = await Promise.all([
      this.manager
        .getRepository(CountryEntity)
        .createQueryBuilder('country')
        // EXISTS, not a join: no DISTINCT needed and the row count cannot be
        // multiplied by the number of users in the country.
        .where(
          'EXISTS (SELECT 1 FROM users u WHERE u."countryCode" = country.code)',
        )
        .getMany(),
      this.manager.getRepository(ProjectEntity).find(),
      // The whole catalog, like projects: a policy with no members can still
      // be picked and visibly return no one.
      this.manager.getRepository(LeavePolicyEntity).find(),
    ])

    return {
      // Sorted in JS (localeCompare), matching listCountriesTx, so the option
      // order does not depend on the database collation.
      countries: countries
        .map((country) => ({
          code: country.code,
          name: country.name,
          timezone: orUndefined(country.timezone),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      projects: projects
        .map((project) => ({ projectId: project.id, name: project.name }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      policies: policies
        .map((policy) => ({ policyId: policy.id, name: policy.name }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  private async getAdminEmployeeTotals(
    manager: EntityManager,
  ): Promise<AdminEmployeeTotalsDto> {
    const [employees, administrators, accounts, pendingRow] = await Promise.all([
      // Both role cards count ACTIVE holders of the role — the question the
      // directory's Role filter answers for the working population. An
      // admin-only account must not inflate the Employees card, and a
      // departed admin must not inflate the Administrators card forever:
      // deactivation keeps the role rows (history; reactivation restores
      // them), so without the active filter the cards would only ever grow
      // with attrition. `accounts` below stays the one counter that includes
      // deactivated rows. uq_user_roles_user_role guarantees one row per
      // (user, role), so a row count is a user count.
      this.countActiveRoleHolders(manager, AppRoleName.Employee),
      this.countActiveRoleHolders(manager, AppRoleName.Administrator),
      // Account rows regardless of role, deactivated included — the number an
      // account-level operation (the directory reset) must quote.
      manager.getRepository(UserEntity).count(),
      manager
        .getRepository(LeaveRequestEntity)
        .createQueryBuilder('request')
        .select('COUNT(DISTINCT request."requesterUserId")', 'count')
        .where('request.status = :status', {
          status: LeaveRequestStatus.Pending,
        })
        .getRawOne<{ count: string }>(),
    ])

    return {
      employees,
      administrators,
      accounts,
      pendingReview: Number(pendingRow?.count ?? 0),
    }
  }

  private countActiveRoleHolders(
    manager: EntityManager,
    roleName: AppRoleName,
  ): Promise<number> {
    return manager
      .getRepository(UserRoleEntity)
      .createQueryBuilder('role')
      .innerJoin(UserEntity, 'u', 'u.id = role."userId" AND u.active = true')
      .where('role."roleName" = :roleName', { roleName })
      .getCount()
  }

  async getAdminEmployeeDetail(
    userId: string,
  ): Promise<AdminEmployeeDetailDto> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, userId)
      const generatedAt = this.clock.nowIso()
      const asOf = await this.resolveAsOfTx(manager, user, generatedAt)
      await this.refreshBalancesTx(manager, userId, generatedAt)

      const entities = (await this.getUserRequests(manager, userId)).sort(
        (left, right) => right.submittedAt.localeCompare(left.submittedAt),
      )
      // One read for the whole response (see getLeaveRequestHistory).
      const hoursPerDay = await this.getWorkdayHoursTx(manager)
      const requestHistory: LeaveRequestDetailDto[] = []
      for (const entity of entities) {
        requestHistory.push(
          await this.buildRequestDetail(manager, entity, hoursPerDay),
        )
      }

      // Mirror getAdminEmployeeList's project projection (same repository, same
      // `project` relation join, same name skip + localeCompare ordering), but
      // for the single user in view and carrying `position` (roleOnProject) —
      // the detail card shows each membership's role, the list rows do not.
      const membershipRows = await manager
        .getRepository(UserProjectMembershipEntity)
        .find({ where: { userId }, relations: { project: true } })
      const projects: AdminEmployeeProjectDto[] = membershipRows
        // A membership whose project row vanished is skipped rather than
        // rendered as a nameless chip.
        .filter((row) => row.project)
        .map((row) => ({
          projectId: row.project!.id,
          name: row.project!.name,
          position: row.roleOnProject,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))

      return {
        employeeId: user.id,
        displayName: user.displayName,
        email: user.email,
        roleNames: await this.getUserRoleNamesTx(manager, userId),
        active: user.active,
        profileStatus: employeeProfileStatus(user, asOf.day),
        employmentStartDate: orUndefined(user.employmentStartDate),
        countryCode: orUndefined(user.countryCode),
        holidayCalendarCountryCode: orUndefined(user.holidayCalendarCountryCode),
        projects,
        ...policyFactsOf(
          await this.loadPolicyTimelineTx(manager, userId),
          asOf.day,
        ),
        balances: await this.buildBalanceDtos(manager, userId, generatedAt),
        requestHistory,
        // The whole ledger, not a fold of the per-request timelines: year-close
        // rows (carryover in/out, expiry) belong to no request, and an employee
        // with no requests still has accruals worth showing.
        balanceTimeline: await this.getBalanceTimelineTx(manager, userId),
        generatedAt,
        // Both the divisor the profile's day figures read and the grid its
        // balance correction has to mint an amount on.
        hoursPerDay,
      }
    })
  }

  /**
   * Test tooling: wipe ONE user's leave activity back to a clean slate so a QA
   * scenario can be re-run without provisioning a fresh user. In one transaction
   * it deletes the user's leave_requests (ON DELETE CASCADE removes their
   * approvers / activities / decisions, and SET NULL detaches
   * notification_deliveries) and then the balance cache + ledger, which zeroes
   * the spent / held / accrued counters. Deliberately kept: the user row itself,
   * their admin-set `leave_allocations` (the annual entitlement — clearing it
   * would silently revert totalDays to settings defaults), and the durable
   * `audit_logs` trail (its dangling requestId pointers are harmless). The kept
   * allocation rows are still SCRUBBED of their derived carryover state
   * (carriedOverDays 0, carryoverFinalized false, closedAt null): those fields
   * were justified only by ledger rows this wipe deletes, so leaving them would
   * re-inject the old carryover into fresh accrual rows under whatever policy
   * is configured now, and a surviving closedAt would freeze the year for good
   * (accrueForYear refuses any year that has been closed). Scrubbed, the next
   * read replays every year close from the empty ledger under current settings.
   * Requests
   * and balances MUST go together: leaving requests behind would make the next
   * reconcile debit a hold that no longer exists and wedge every read. The next
   * dashboard/history read re-creates the balances at zero and re-accrues lazily
   * to the current (clock) date. Guarded to non-production by the calling
   * test-tooling controller.
   */
  async resetUserLeaveData(
    input: ResetUserLeaveDataInput,
  ): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, input.userId)

      // Serialize with an in-flight year close, which appends ledger rows under
      // this same key: without it a close could commit its rows after the
      // deletes below scanned, leaving exactly the residue this reset exists to
      // remove. The reset takes only this lock, so it cannot deadlock against
      // the submit path (which takes its per-type lock first, then this one).
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${user.id}:carryover-close`,
      ])

      const requestRepo = manager.getRepository(LeaveRequestEntity)
      const ledgerRepo = manager.getRepository(LeaveBalanceChangeEntity)
      const balanceRepo = manager.getRepository(LeaveBalanceEntity)
      const allocationRepo = manager.getRepository(LeaveAllocationEntity)

      // Snapshot what is being wiped so the audit entry records the magnitude.
      const clearedRequests = await requestRepo.countBy({
        requesterUserId: user.id,
      })
      const clearedLedgerEntries = await ledgerRepo.countBy({
        userId: user.id,
      })
      const reopenedYears = await allocationRepo.countBy({
        userId: user.id,
        closedAt: Not(IsNull()),
      })

      await requestRepo.delete({ requesterUserId: user.id })
      await ledgerRepo.delete({ userId: user.id })
      await balanceRepo.delete({ userId: user.id })
      // Keep the entitlement, drop everything the deleted ledger justified.
      await allocationRepo.update(
        { userId: user.id },
        {
          carriedOverDays: 0,
          manualAdjustmentDays: 0,
          carryoverFinalized: false,
          closedAt: null,
          // sourcePolicyId deliberately survives with the totalDays it
          // describes: the reset keeps the ENTITLEMENT and drops only what
          // the ledger justified, and ensureAllocation never revisits a row
          // that already exists, so clearing the stamp would leave the figure
          // unexplained forever. The replay stays deterministic anyway —
          // policy terms are immutable and membership rows are append-only,
          // so re-accruing under the same live timeline reproduces the same
          // balance.
          updatedAt: this.clock.nowIso(),
        },
      )

      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.EmployeeLeaveDataReset,
        target: { userId: user.id, label: user.displayName },
        entityType: 'user',
        entityId: user.id,
        summary: `Reset ${user.displayName}'s leave data (cleared ${clearedRequests} request(s) and ${clearedLedgerEntries} ledger entr${clearedLedgerEntries === 1 ? 'y' : 'ies'}, reopened ${reopenedYears} closed year(s))`,
        before: {
          requests: clearedRequests,
          ledgerEntries: clearedLedgerEntries,
          closedYears: reopenedYears,
        },
        after: { requests: 0, ledgerEntries: 0, closedYears: 0 },
      })

      return userToRecord(user)
    })
  }

  /**
   * TEST TOOLING — wipe the user population (everyone, or everyone but `keep`) so
   * an LDAP sync can be observed from a clean slate. Destructive and
   * irreversible. Gated twice, like the shiftable clock: the controller 404s
   * unless TEST_TOOLING_ENABLED is on (and demands an administrator), and this
   * method refuses outright when the flag is off — the wipe is far too
   * destructive to leave the controller as its only gate, so any future caller
   * holding this service is refused too.
   *
   * Runs under the directory-sync advisory lock, so a reset and a sync can
   * never interleave; when a sync holds it the reset is refused (retryable)
   * rather than half-applied against a table the sync is repopulating. That
   * lock only excludes the sync and other resets, though: ordinary writers
   * (a submission, an accrual pass, an SSO login provisioning a user) take no
   * lock and can commit mid-reset. Such a row lands on one of the RESTRICT
   * foreign keys and Postgres refuses the users delete (23503) — reported as
   * retryable rather than as a server fault, since the whole transaction rolls
   * back and a second run succeeds. A user provisioned after the users delete
   * took its snapshot simply survives the wipe; run the reset while nobody is
   * signing in if that matters.
   *
   * One transaction. Only the two RESTRICT foreign keys need explicit
   * pre-deletion; deleting the `users` rows then does the rest by schema:
   *   - deleting leave_requests CASCADES leave_request_approvers,
   *     leave_approval_decisions, leave_request_activities and notifications (by
   *     requestId), and SET-NULLs notification_deliveries.requestId;
   *   - deleting users CASCADES user_roles, leave_balances, leave_allocations
   *     (userId), user_project_memberships and notifications (recipientUserId),
   *     and SET-NULLs leave_allocations.setByUserId plus every actorUserId /
   *     targetUserId, audit_logs included.
   * A child table added later with a new RESTRICT FK fails this LOUDLY (23503)
   * rather than leaving orphans; the DB test pins the dependency set.
   *
   * notification_deliveries is the one dependent table no cascade can attribute
   * to a person: it has no user FK at all, only requestId (SET NULL), and names
   * its recipients as plain addresses in `to`/`cc`. So it is emptied wholesale
   * exactly when nobody is kept — with the whole population gone the log has no
   * owner left — and left untouched otherwise, since separating one employee's
   * deliveries would mean matching those address strings.
   *
   * `keep` lists emails to preserve (matched on normalizedEmail). Wiping the
   * whole population is spelled `all: true` — an empty keep list alone is
   * refused, because that is what a bodyless request produces and it must not
   * be enough to delete everyone, and `all: true` alongside a keep list is
   * refused too rather than resolved to one of its two readings. Deleting the
   * caller's own row is fine, SSO re-provisions them on the next login. An
   * address in `keep` that matches nobody is REFUSED rather than ignored: it
   * protects no one, so honouring it silently would delete the very person the
   * caller listed, irreversibly.
   * `clearAudit` empties the whole
   * audit_logs table and is independent of the population delete — it runs even
   * when everyone is kept (default off; the users delete already SET-NULLs the
   * trail's user references, so it otherwise survives with its snapshotted
   * labels). No audit_logs row is written for the reset itself: the trail has no
   * event type for it, and adding one means recreating the eventType pg enum —
   * a heavyweight migration for a row that `clearAudit: true` would delete in
   * the very transaction that wrote it. The run is logged instead.
   */
  async resetDirectory(input: {
    keep?: string[]
    all?: boolean
    clearAudit?: boolean
    audit?: AuditActor
  }): Promise<{
    deletedUsers: number
    deletedRequests: number
    deletedLedgerEntries: number
    deletedDeliveries: number
    clearedAuditLogs: number
  }> {
    if (!this.clock.isTestToolingEnabled()) {
      throw new LeaveDomainValidationError(
        'Directory reset refused: test tooling is disabled (TEST_TOOLING_ENABLED is not "true").',
      )
    }
    const keptEmails = [
      ...new Set((input.keep ?? []).map((email) => normalizeEmail(email))),
    ]
    // Neither reading of the request may be guessed at — see the doc comment.
    if (keptEmails.length === 0 && input.all !== true) {
      throw new LeaveDomainValidationError(
        'Directory reset refused: deleting every user requires all=true. ' +
          'Pass a keep list, or set all=true to confirm the full wipe.',
      )
    }
    if (keptEmails.length > 0 && input.all === true) {
      throw new LeaveDomainValidationError(
        'Directory reset refused: all=true confirms deleting EVERY user, but a keep ' +
          'list was passed too. Drop all=true to keep them, or drop the keep list to wipe everyone.',
      )
    }
    return this.dataSource.transaction(async (manager) => {
      // Must stay the FIRST statement of the transaction (see the key's own
      // comment); transaction-scoped, so commit and rollback both release it.
      if (!(await this.tryDirectorySyncLockTx(manager))) {
        throw new DirectorySyncInProgressError(
          'Directory reset refused: a directory sync is currently running. Retry once it finishes.',
        )
      }

      const userRepo = manager.getRepository(UserEntity)

      // Resolve the keep list BEFORE deleting anything, and refuse an address
      // that matches nobody — see the note above on why it cannot be ignored.
      const keptUsers =
        keptEmails.length > 0
          ? await userRepo.find({
              where: { normalizedEmail: In(keptEmails) },
              select: { id: true, normalizedEmail: true },
            })
          : []
      const unmatched = keptEmails.filter(
        (email) => !keptUsers.some((user) => user.normalizedEmail === email),
      )
      if (unmatched.length > 0) {
        throw new LeaveDomainValidationError(
          `Directory reset refused: no user matches ${unmatched.join(', ')} — ` +
            'that address would have protected nobody.',
        )
      }
      const keptIds = keptUsers.map((user) => user.id)

      // Each delete targets "everyone not kept" directly, so the deleted
      // population is never materialized as an id list (it would otherwise
      // travel as one bind parameter per user). No rows to delete is a plain
      // no-op, so no separate empty case is needed.
      const deleteUnkept = async (
        target: EntityTarget<ObjectLiteral>,
        // A column literal from the call sites below, never caller input.
        column: string,
      ): Promise<number> => {
        const query = manager.createQueryBuilder().delete().from(target)
        if (keptIds.length > 0) {
          query.where(`"${column}" NOT IN (:...keptIds)`, { keptIds })
        }
        const { affected } = await query.execute()
        return affected ?? 0
      }

      // The two RESTRICT tables must precede their users; every other dependent
      // row is removed by the users delete's cascades (see the doc comment).
      const deletedLedgerEntries = await deleteUnkept(
        LeaveBalanceChangeEntity,
        'userId',
      )
      const deletedRequests = await deleteUnkept(
        LeaveRequestEntity,
        'requesterUserId',
      )

      // Emptied only when nobody is kept — see the doc comment.
      let deletedDeliveries = 0
      if (keptIds.length === 0) {
        const purged = await manager
          .createQueryBuilder()
          .delete()
          .from(NotificationDeliveryEntity)
          .execute()
        deletedDeliveries = purged.affected ?? 0
      }

      let clearedAuditLogs = 0
      if (input.clearAudit) {
        const cleared = await manager
          .createQueryBuilder()
          .delete()
          .from(AuditLogEntity)
          .execute()
        clearedAuditLogs = cleared.affected ?? 0
      }

      // A writer the advisory lock does not cover (submission, accrual, SSO
      // login) can commit a child row between the deletes above and this one,
      // and its RESTRICT foreign key then blocks the users delete. Reported as
      // a lost race, not a server fault: the transaction rolls back whole.
      let deletedUsers: number
      try {
        deletedUsers = await deleteUnkept(UserEntity, 'id')
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new DirectoryResetRacedError(
            'Directory reset refused: rows were written for a user being deleted while ' +
              'the reset ran. Nothing was changed — retry once the system is idle.',
          )
        }
        throw error
      }

      this.logger.warn(
        `Test tooling reset-directory by ${input.audit?.label ?? 'system'}: ` +
          `users: ${deletedUsers}, requests: ${deletedRequests}, ` +
          `ledger entries: ${deletedLedgerEntries}, deliveries: ${deletedDeliveries}` +
          (input.clearAudit ? `, audit rows cleared: ${clearedAuditLogs}` : ''),
      )

      return {
        deletedUsers,
        deletedRequests,
        deletedLedgerEntries,
        deletedDeliveries,
        clearedAuditLogs,
      }
    })
  }

  /**
   * Admin per-employee edit of the employment (hire) start date — the accrual
   * anchor — and/or the assigned office / location (a country code, FK to
   * countries.code). Only the fields present on the input are changed; passing
   * null clears the country. The start date can only be set or corrected,
   * never cleared back to null (see the guard below). The whole edit runs in
   * ONE transaction, and the referenced country is validated up front (it must
   * already exist — the caller picks it from the countries list — rather than
   * silently creating a stub row), so a rejected country never leaves the
   * start date half-written.
   */
  async updateEmployeeAdmin(
    input: UpdateEmployeeAdminInput,
  ): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction((manager) =>
      this.updateEmployeeAdminTx(manager, input),
    )
  }

  /**
   * Transaction-scoped core of the admin profile edit, exposed for the history
   * import's hire-date/country backfill (one transaction per employee; a
   * nested transaction would deadlock on held advisory locks). Identical
   * behavior, including the start-date re-anchor.
   */
  async updateEmployeeAdminTx(
    manager: EntityManager,
    input: UpdateEmployeeAdminInput,
  ): Promise<LeaveDomainUserRecord> {
    {
      // Unlocked read: the write below is a targeted repo.update naming
      // ONLY the admin's owned columns (employmentStartDate, countryCode,
      // the profile fields). `active` is never in it, so this path cannot write
      // active=true over a concurrent sync deactivation — the resurrection the
      // pessimistic_write lock used to guard against is impossible by
      // construction. The read still serves the audit `before` and the
      // start-date balance re-anchor.
      const user = await manager.getRepository(UserEntity).findOneBy({
        id: input.userId,
      })
      if (!user) {
        throw new LeaveDomainNotFoundError(`Unknown user: ${input.userId}`)
      }

      // Validate the referenced country before writing anything so the update
      // aborts cleanly instead of committing the other field.
      if (input.countryCode) {
        const country = await manager
          .getRepository(CountryEntity)
          .findOneBy({ code: input.countryCode })
        if (!country) {
          throw new LeaveDomainValidationError(
            `Unknown country: ${input.countryCode}`,
          )
        }
      }

      if (input.holidayCalendarCountryCode) {
        const country = await manager
          .getRepository(CountryEntity)
          .findOneBy({ code: input.holidayCalendarCountryCode })
        if (!country) {
          throw new LeaveDomainValidationError(
            `Unknown country: ${input.holidayCalendarCountryCode}`,
          )
        }
        const hasCalendar = await manager
          .getRepository(HolidayCalendarEntity)
          .existsBy({ countryCode: input.holidayCalendarCountryCode })
        if (!hasCalendar) {
          throw new LeaveDomainValidationError(
            `No holiday calendar is configured for ${input.holidayCalendarCountryCode}. Create one in Settings first.`,
          )
        }
      }

      // Clearing an already-set start date would yank the accrual anchor out
      // from under the year's balance (the re-anchor would wipe it to zero or
      // trip the committed-days guard) — a destructive edit with no business
      // meaning. Reject it outright; a wrong date is fixed by entering the
      // corrected one.
      if (input.employmentStartDate === null && user.employmentStartDate) {
        throw new LeaveDomainValidationError(
          'The employment start date cannot be cleared once set; enter a corrected date instead.',
        )
      }

      const before = {
        employmentStartDate: user.employmentStartDate,
        countryCode: user.countryCode,
        holidayCalendarCountryCode: user.holidayCalendarCountryCode,
      }

      // The start date is the accrual anchor, so changing it changes how many
      // pro-rata days the current year should have accrued. Detect a real change
      // and settle the balance under the OLD anchor first, before we overwrite it.
      const now = this.clock.nowIso()
      const startDateChanged =
        input.employmentStartDate !== undefined &&
        input.employmentStartDate !== user.employmentStartDate
      if (startDateChanged) {
        await this.refreshBalancesTx(manager, input.userId, now)
      }

      // Targeted UPDATE of ONLY the admin's owned columns. The in-memory
      // `user` is mutated in lockstep so the audit `after` and the returned
      // record reflect the merge; the patch carries just the provided fields
      // (plus updatedAt) so no owned column is needlessly rewritten and no
      // non-owned column (active, subject, email, displayName) is ever named.
      const patch: Partial<UserEntity> = { updatedAt: now }
      if (input.employmentStartDate !== undefined) {
        user.employmentStartDate = input.employmentStartDate
        patch.employmentStartDate = input.employmentStartDate
      }
      if (input.countryCode !== undefined) {
        user.countryCode = input.countryCode
        patch.countryCode = input.countryCode
      }
      if (input.holidayCalendarCountryCode !== undefined) {
        const nextCountryCode =
          input.countryCode !== undefined ? input.countryCode : user.countryCode
        const normalized =
          input.holidayCalendarCountryCode &&
          input.holidayCalendarCountryCode === nextCountryCode
            ? null
            : input.holidayCalendarCountryCode
        user.holidayCalendarCountryCode = normalized
        patch.holidayCalendarCountryCode = normalized
      }
      user.updatedAt = now
      await manager.getRepository(UserEntity).update(input.userId, patch)

      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.EmployeeProfileUpdated,
        target: { userId: user.id, label: user.displayName },
        entityType: 'user',
        entityId: user.id,
        summary: `Updated ${user.displayName}'s employee profile`,
        before,
        after: {
          employmentStartDate: user.employmentStartDate,
          countryCode: user.countryCode,
          holidayCalendarCountryCode: user.holidayCalendarCountryCode,
        },
      })

      // Bring the current year's accrued balance in line with the new start
      // date. Two different events hide under "the date changed":
      //   - FIRST-TIME SET (was null): an anchorless profile accrues nothing
      //     at all, so the year is a plain catch-up — run the ordinary
      //     accrual under the new anchor and the ledger reads like the
      //     account was set up on day one, one row per month owed. The
      //     re-anchor below then computes a zero delta and writes nothing.
      //   - CORRECTION (was set): the year already accrued monthly rows
      //     under the old date; the move to the new target is one signed
      //     adjustment entry (accrual on its own only ever moves up, so a
      //     later start date would otherwise never lower the year).
      // Runs after the audit record but in the same transaction: a guard throw
      // rolls back the profile write and its audit entry together.
      if (startDateChanged) {
        if (!before.employmentStartDate) {
          await this.refreshBalancesTx(manager, input.userId, now)
        }
        // Resolved from the SAVED user, so a country change landing in the same
        // call is already reflected in the zone the re-anchor dates itself by.
        const asOf = await this.resolveAsOfTx(manager, user, now)
        const year = getYearFromIsoDate(asOf.day)
        const anchor = user.employmentStartDate ?? null
        for (const leaveType of ALL_LEAVE_TYPES) {
          await this.reanchorAccrual(manager, {
            userId: input.userId,
            leaveType,
            year,
            now: asOf,
            anchor,
            note: 'Re-anchored to updated start date',
            guardMessage:
              'Cannot apply the new start date: the employee has more committed (held + spent) leave days than the recalculated balance allows. Resolve or cancel those leave requests first.',
          })
        }
      }

      return userToRecord(user)
    }
  }

  /**
   * Flip an employee's `active` flag — the admin's manual deactivate/reactivate,
   * and the ONLY way to resolve a sync conflict (a deactivated user who is back
   * in LDAP) on the app side. Deliberately separate from updateEmployeeAdmin,
   * which never touches `active`: a targeted conditional UPDATE of only
   * this column, idempotent and serialized on the row's own lock, so it can
   * neither resurrect a row a concurrent sync is deactivating nor rewrite any
   * other column. Reactivation audits user.reactivated, deactivation
   * user.deactivated — the symmetric pair an admin filters the journal by
   * (distinct from the sync's own deactivation only by the actor), NOT a field
   * diff buried in employee.profile_updated.
   */
  async setEmployeeActive(
    input: SetEmployeeActiveInput,
  ): Promise<LeaveDomainUserRecord> {
    // An admin must not lock themselves out: a deactivated account is refused at
    // sign-in and a re-login cannot undo it. Enforced HERE, not only at the HTTP
    // boundary, so every caller of this single writer is covered. Reactivating
    // yourself is harmless and allowed; a system caller (no audit actor) is
    // never "self".
    if (
      input.active === false &&
      input.audit?.userId != null &&
      input.audit.userId === input.userId
    ) {
      throw new LeaveDomainValidationError(
        'You cannot deactivate your own account.',
      )
    }
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UserEntity)
      const user = await repo.findOneBy({ id: input.userId })
      if (!user) {
        throw new LeaveDomainNotFoundError(`Unknown user: ${input.userId}`)
      }

      const now = this.clock.nowIso()
      // Conditional targeted UPDATE: flip only while the row still holds
      // the prior value, so an already-in-target-state row and a lost race both
      // land on affected=0 and write no audit event — never a fabricated
      // transition, and never a rewrite of a column this path does not own.
      const result = await repo.update(
        { id: input.userId, active: !input.active },
        { active: input.active, updatedAt: now },
      )
      if (result.affected !== 1) {
        // Already active/inactive as asked (or a concurrent writer got there
        // first): return the current row, audit nothing.
        return userToRecord(await repo.findOneByOrFail({ id: input.userId }))
      }

      user.active = input.active
      user.updatedAt = now
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: input.active
          ? AuditEventType.UserReactivated
          : AuditEventType.UserDeactivated,
        target: { userId: user.id, label: user.displayName },
        entityType: 'user',
        entityId: user.id,
        summary: input.active
          ? `Reactivated ${user.displayName}`
          : `Deactivated ${user.displayName}`,
        // Owned-column snapshot: only `active` changed, so before/after carry
        // exactly that flip and StateChange derives the field diff from them.
        before: { active: !input.active },
        after: { active: input.active },
      })

      return userToRecord(user)
    })
  }

  /**
   * Re-anchor a (leaveType, year) accrued balance to the target implied by its
   * inputs — the stored allocation, its carryover, and the accrual anchor (the
   * employment start date) — posting a signed `adjustment` ledger entry for the
   * difference. Accrual on its own only ever moves up, so this is the single
   * place where a changed input translates into a signed correction; per-user
   * mutations of those inputs (start date, allocation) funnel through here.
   * Settings-level edits (default day counts, carryover policy/cap) do NOT:
   * they only shape years/users materialized after the change, so already
   * accrued balances are deliberately left as-is.
   * Refuses to lower accrued below already committed (held + spent) days.
   *
   * TODO(carryover): the target trusts the allocation's materialized
   * carriedOverDays, computed ONCE at year rollover from the prior year's
   * leftover under the then-current anchor and never recomputed. A start-date
   * correction that changes what the prior year should have accrued (or a
   * past-year allocation edit) therefore leaves the current year's carryover
   * stale — phantom or missing days. Dormant while carryoverPolicy defaults to
   * None; when carryover is enabled, re-anchoring must also recompute the
   * current year's carriedOverDays from the corrected prior-year state.
   */
  private async reanchorAccrual(
    manager: EntityManager,
    input: {
      userId: string
      leaveType: LeaveType
      year: number
      now: AsOf
      anchor: string | null
      note: string
      // Caller-specific guard error; the generic fallback names the mechanism
      // but not what the admin should do about it.
      guardMessage?: string
      // The guard protects an ADMINISTRATIVE change: nobody may cut an
      // entitlement below leave the employee has already been promised. The
      // history import is not that — it records what already happened, and a
      // year that really did run past its accrual (the office trackers let a
      // balance go negative until the monthly accrual caught up) must be
      // recordable as it was, not refused.
      skipCommitmentGuard?: boolean
    },
  ): Promise<{ adjustmentDelta: number }> {
    // Same lock a submission takes: this too reads what the employee has
    // planned and then writes against it, so an allocation cut and a
    // submission must not pass each other.
    await this.lockUserBalanceForUpdate(manager, input.userId, input.leaveType)
    const balance = await this.ensureBalance(
      manager,
      input.userId,
      input.leaveType,
      input.year,
      input.now,
    )
    const allocation = await this.ensureAllocation(
      manager,
      input.userId,
      input.leaveType,
      input.year,
      input.now,
    )
    // A closed year cannot be re-anchored: its leftover was already carried or
    // burnt at a figure computed from the allocation as it stood, and healing
    // the year to a new target would either resurrect burnt days or strand the
    // successor's already-booked carryover at a stale figure. Refuse plainly —
    // the admin's lever for a settled past is the current year. The marker is
    // the year's OWN closedAt (set only by a real close), so a year that was
    // merely never touched stays freely correctable.
    if (allocation.closedAt) {
      throw new LeaveDomainValidationError(
        `The ${input.year} leave year is closed: its unused days were already carried over or expired. Adjust the current year instead.`,
      )
    }
    const { hireMonth, months } = accrualScheduleForYear(
      input.year,
      input.now.day,
      input.anchor,
    )
    const policySchedule = await this.resolvePolicyScheduleTx(
      manager,
      input.userId,
      input.year,
      input.anchor,
    )
    // A policy-governed year keeps its cached annual figure in step with the
    // resolver here: this is the one write point every re-anchor (start-date
    // change today, membership mutations in the transfer engine) passes
    // through, so the cache cannot drift without the ledger moving with it.
    if (policySchedule) {
      const yearEndTotal = scheduleYearEndTotal(input.leaveType, policySchedule)
      const december =
        policySchedule.segments[policySchedule.segments.length - 1]!
      if (
        allocation.totalDays !== yearEndTotal ||
        allocation.sourcePolicyId !== december.policyId
      ) {
        allocation.totalDays = yearEndTotal
        allocation.sourcePolicyId = december.policyId
        allocation.updatedAt = input.now.iso
        await manager.getRepository(LeaveAllocationEntity).save(allocation)
      }
    }
    const schedule =
      policySchedule ?? legacyScheduleFromTotal(allocation.totalDays)
    const newTarget = pieceTargetDays(
      input.leaveType,
      schedule,
      allocation.carriedOverDays,
      hireMonth,
      months,
      allocation.manualAdjustmentDays,
    )
    const adjustmentDelta = roundDays(newTarget - balance.accruedDays)
    if (adjustmentDelta !== 0) {
      await this.recordBalanceChange(manager, {
        userId: input.userId,
        leaveType: input.leaveType,
        year: input.year,
        reason: LeaveBalanceChangeReason.Adjustment,
        effectiveDate: input.now.day,
        occurredAt: input.now.iso,
        deltaDays: adjustmentDelta,
        onHoldDelta: 0,
        spentDelta: 0,
        accruedDelta: adjustmentDelta,
        note: input.note,
      })
    }
    // Check what the employee has planned against the allocation as it now
    // stands. This runs even when the accrued figure did not move, because for
    // a year that has not begun it never does: nothing has accrued there yet,
    // so the cut shows up only in what that year is projected to accrue. It
    // also names the adjusted year explicitly, which need not be one of the two
    // the projection walks by default (an admin may correct a past year).
    // A throw rolls the adjustment, and the caller's allocation or profile
    // write, back with it.
    if (input.skipCommitmentGuard) {
      return { adjustmentDelta }
    }
    await this.assertPlannedCommitmentsFeasible(manager, {
      userId: input.userId,
      leaveType: input.leaveType,
      nowDay: input.now.day,
      anchor: input.anchor,
      extraYears: [input.year],
      guardMessage:
        input.guardMessage ??
        'Cannot lower the accrued balance below what the employee has already committed.',
    })
    return { adjustmentDelta }
  }

  // Sticky ± on the current open vacation year (vacation only). Offset lives
  // on allocation.manualAdjustmentDays so monthly accrual keeps it.
  async adjustEmployeeVacationBalance(
    input: AdjustEmployeeVacationBalanceInput,
  ): Promise<AdjustEmployeeVacationBalanceResult> {
    if (!UUID_PATTERN.test(input.userId)) {
      throw new LeaveDomainValidationError('employeeId must be a UUID.')
    }
    // Quantized before anything reads it: the ledger and allocation columns
    // keep three decimals, so an unrounded delta would be stored as a figure
    // the audit snapshot below never saw, and the grid check would pass a
    // value the database then changes.
    const deltaDays = roundDays(Number(input.deltaDays))
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (!note) {
      throw new LeaveDomainValidationError(
        'A comment is required when adjusting vacation balance.',
      )
    }
    // SHAPE only out here, so the common bad payload still fails without
    // opening a transaction. Whether the delta lands on the bookable hour grid
    // depends on the org's workday length, which is read below.
    if (!Number.isFinite(deltaDays) || deltaDays === 0) {
      throw new LeaveDomainValidationError(
        'deltaDays must be a non-zero number of days.',
      )
    }

    // The workday length this adjustment was checked and audited against comes
    // back OUT of the transaction, so the employee's email states the change in
    // the same figure the audit row froze.
    const hoursPerDay = await this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, input.userId)
      if (!user.employmentStartDate) {
        throw new LeaveDomainValidationError(
          'Set the employment start date before adjusting vacation balance.',
        )
      }
      // The admin lever must be able to match what an employee can actually
      // take: leave is bookable by the hour, so a correction of four hours is
      // a legitimate delta and anything between two hours is a figure nobody
      // could ever spend and no editor could round-trip.
      //
      // The message names the same figure the gate accepts, derived by the same
      // conversion the booking path mints portions with: an org whose hour does
      // not fit three decimals must not be told to enter a value that is then
      // refused.
      const settings = await this.loadSettingsState(manager)
      if (!isOnHourGrid(deltaDays, settings.hoursPerDay)) {
        throw new LeaveDomainValidationError(
          `deltaDays must be a whole number of hours (1 hour = ${hoursToDayPortion(1, settings.hoursPerDay)} day at ${settings.hoursPerDay} hours a day).`,
        )
      }
      const now = this.clock.nowIso()
      const asOf = await this.resolveAsOfTx(manager, user, now)
      if (asOf.day < user.employmentStartDate) {
        throw new LeaveDomainValidationError(
          'Vacation balance can be adjusted only after employment has started.',
        )
      }
      const year = getYearFromIsoDate(asOf.day)
      const leaveType = LeaveType.Vacation
      const anchor = user.employmentStartDate

      await this.refreshBalancesTx(manager, input.userId, now)
      await this.accrueDueAllowance(
        manager,
        input.userId,
        leaveType,
        year,
        asOf,
        anchor,
      )

      await this.lockUserBalanceForUpdate(manager, input.userId, leaveType)
      const balance = await this.ensureBalance(
        manager,
        input.userId,
        leaveType,
        year,
        asOf,
      )
      const allocation = await this.ensureAllocation(
        manager,
        input.userId,
        leaveType,
        year,
        asOf,
      )
      if (allocation.closedAt) {
        throw new LeaveDomainValidationError(
          `The ${year} leave year is closed: adjust the current year instead.`,
        )
      }

      const bookable = roundDays(
        balance.accruedDays - balance.onHoldDays - balance.spentDays,
      )
      // The cap is advertised ON THE GRID, and enforced there too. Accrual
      // routinely leaves a sub-hour remainder (12.333 days of an 8h day), and
      // naming that raw figure would send the admin back with a value the grid
      // check above then refuses. What the floor leaves behind is by definition
      // smaller than an hour, so it is not a day anyone could have booked.
      const removable = floorToHourGrid(bookable, settings.hoursPerDay)
      if (deltaDays < 0 && -deltaDays > removable + BALANCE_EPSILON) {
        throw new LeaveDomainValidationError(
          `Cannot remove more than ${formatDayAmount(removable, settings.hoursPerDay)} of available vacation (accrued minus held and spent).`,
        )
      }

      const previousOffset = allocation.manualAdjustmentDays
      const previousAccrued = balance.accruedDays
      allocation.manualAdjustmentDays = roundDays(
        allocation.manualAdjustmentDays + deltaDays,
      )
      allocation.setByUserId = input.audit?.userId ?? null
      allocation.updatedAt = now
      await manager.getRepository(LeaveAllocationEntity).save(allocation)

      await this.recordBalanceChange(manager, {
        userId: input.userId,
        leaveType,
        year,
        reason: LeaveBalanceChangeReason.Adjustment,
        effectiveDate: asOf.day,
        occurredAt: asOf.iso,
        deltaDays,
        onHoldDelta: 0,
        spentDelta: 0,
        accruedDelta: deltaDays,
        note,
      })

      await this.assertPlannedCommitmentsFeasible(manager, {
        userId: input.userId,
        leaveType,
        nowDay: asOf.day,
        anchor,
        extraYears: [year],
        guardMessage:
          'Cannot adjust the vacation balance below what the employee has already committed.',
      })

      const verb = deltaDays > 0 ? 'Added' : 'Removed'
      const magnitude = Math.abs(deltaDays)
      // Days and hours, the same notation every other surface renders an
      // amount in: "0.125 vacation days" was the one figure in this sentence
      // an auditor could not check against anything.
      const magnitudeLabel = `${formatDayAmount(magnitude, settings.hoursPerDay)} of vacation`
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.EmployeeBalanceAdjusted,
        occurredAt: now,
        target: { userId: user.id, label: user.displayName },
        entityType: 'leave_balance',
        entityId: `${user.id}:${leaveType}:${year}`,
        summary: `${verb} ${magnitudeLabel} for ${user.displayName} (${year}): ${note}`,
        before: {
          leaveType,
          year,
          accruedDays: previousAccrued,
          manualAdjustmentDays: previousOffset,
          bookableDays: bookable,
        },
        after: {
          leaveType,
          year,
          accruedDays: roundDays(previousAccrued + deltaDays),
          manualAdjustmentDays: allocation.manualAdjustmentDays,
          bookableDays: roundDays(bookable + deltaDays),
          deltaDays,
          note,
        },
      })

      return settings.hoursPerDay
    })

    return {
      detail: await this.getAdminEmployeeDetail(input.userId),
      deltaDays,
      note,
      hoursPerDay,
    }
  }

  /**
   * Admin override of a user's annual allocation (totalDays) for a leave year.
   *
   * NO LONGER AN HTTP SURFACE: the endpoint answers 410 and every allowance
   * comes from a leave policy (a per-person exception is a policy of its own).
   * The method is retained because the spec corpus fabricates pre-engine
   * states with it, including the cutover acceptance fixture.
   * Re-anchors the year's accrued balance to the new target by posting an
   * explicit `adjustment` ledger entry for the signed difference, so a year that
   * was already accrued self-corrects (accrual on its own only ever moves up).
   * The new total may not be lowered below days already spent or otherwise
   * committed (held + spent).
   */
  async setEmployeeAllocation(
    input: SetEmployeeAllocationInput,
  ): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, input.userId)
      if (!ALL_LEAVE_TYPES.includes(input.leaveType)) {
        throw new LeaveDomainValidationError(
          `Unknown leave type: ${String(input.leaveType)}`,
        )
      }
      if (input.totalDays < 0) {
        throw new LeaveDomainValidationError(
          'Allocation totalDays must not be negative.',
        )
      }

      const now = this.clock.nowIso()
      // The allocation only takes effect through accrual, which is anchored at
      // the employment start date. Without one the re-anchor below would wipe
      // (or refuse to touch) whatever is already accrued, so demand the date
      // first. Deliberately NARROWER than employeeProfileStatus: allocation
      // math never uses the country, so an admin may pre-load an allocation
      // before the country is filled in. A FUTURE date is fine too: the
      // allocation is saved ahead of time and accrual picks it up from the
      // effective hire month.
      if (!user.employmentStartDate) {
        throw new LeaveDomainValidationError(
          'Set the employment start date before editing the allocation: without it the allocation cannot take effect.',
        )
      }
      const anchor = user.employmentStartDate ?? null
      const asOf = await this.resolveAsOfTx(manager, user, now)
      // Only for the ledger note and the audit summary below, which state the
      // new total in days and hours like every other figure a person reads.
      const { hoursPerDay } = await this.loadSettingsState(manager)
      // Bring the balance up to date under the CURRENT allocation before
      // re-anchoring: reconcile approved leave, then accrue the target year to
      // its old target so the adjustment is measured from a settled figure.
      await this.refreshBalancesTx(manager, input.userId, now)
      await this.accrueDueAllowance(
        manager,
        input.userId,
        input.leaveType,
        input.year,
        asOf,
        anchor,
      )
      const balance = await this.ensureBalance(
        manager,
        input.userId,
        input.leaveType,
        input.year,
        asOf,
      )

      if (input.totalDays < balance.spentDays) {
        throw new LeaveDomainValidationError(
          'Allocation cannot be lower than the days already spent.',
        )
      }

      const allocation = await this.ensureAllocation(
        manager,
        input.userId,
        input.leaveType,
        input.year,
        asOf,
      )
      const previousTotalDays = allocation.totalDays
      allocation.totalDays = input.totalDays
      allocation.setByUserId = input.setByUserId ?? null
      allocation.note = input.note ?? 'Admin allocation override'
      allocation.updatedAt = now
      await manager.getRepository(LeaveAllocationEntity).save(allocation)

      // Re-anchor accrued to the target implied by the new allocation. Same
      // transaction, so a guard failure rolls the allocation write back too.
      await this.reanchorAccrual(manager, {
        userId: input.userId,
        leaveType: input.leaveType,
        year: input.year,
        now: asOf,
        anchor,
        note: `Allocation set to ${formatDayAmount(input.totalDays, hoursPerDay)}`,
        guardMessage:
          'Allocation cannot be lowered below already committed (held + spent) days.',
      })

      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.EmployeeAllocationUpdated,
        occurredAt: now,
        target: { userId: user.id, label: user.displayName },
        entityType: 'leave_allocation',
        entityId: `${user.id}:${input.leaveType}:${input.year}`,
        summary: `Set ${user.displayName}'s ${input.leaveType} allocation for ${input.year} to ${formatDayAmount(input.totalDays, hoursPerDay)}`,
        before: {
          leaveType: input.leaveType,
          year: input.year,
          totalDays: previousTotalDays,
        },
        after: {
          leaveType: input.leaveType,
          year: input.year,
          totalDays: input.totalDays,
        },
      })

      return userToRecord(user)
    })
  }

  // -------------------------------------------------------- policy catalog ---

  async listPolicies(): Promise<LeavePolicyDto[]> {
    return this.dataSource.transaction(async (manager) => {
      const today = this.clock.nowIso().slice(0, 10)
      const policies = await manager.getRepository(LeavePolicyEntity).find()
      const memberships = await manager
        .getRepository(LeavePolicyMembershipEntity)
        .find({ where: { supersededByRowId: IsNull(), effectiveTo: IsNull() } })
      return policies
        .map((policy) => {
          const open = memberships.filter((row) => row.policyId === policy.id)
          return {
            ...policyToDto(policy),
            memberCount: open.filter((row) => row.effectiveFrom <= today).length,
            scheduledInCount: open.filter((row) => row.effectiveFrom > today)
              .length,
          }
        })
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            left.name.localeCompare(right.name),
        )
    })
  }

  /**
   * Create a policy. Terms are immutable afterwards, so this is the one place
   * they are validated and fingerprinted: identical terms on a policy that has
   * not expired are refused outright (two groups with the same deal have no
   * distinguishing behavior and turn every terms query into a which-twin
   * question).
   */
  async createPolicy(input: CreateLeavePolicyInput): Promise<LeavePolicyDto> {
    return this.dataSource.transaction((manager) =>
      this.createPolicyTx(manager, input),
    )
  }

  /**
   * Transaction-scoped core of policy creation, exposed for the history
   * import's mint-or-find (createPolicyTx + catch DuplicatePolicyTermsError):
   * the import runs one transaction per employee and must not open a nested
   * one. Takes the catalog advisory lock itself — xact-scoped advisory locks
   * are re-entrant within a session, so a caller already holding it pays
   * nothing.
   */
  async createPolicyTx(
    manager: EntityManager,
    input: CreateLeavePolicyInput,
  ): Promise<LeavePolicyDto> {
    {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'policy:catalog',
      ])
      const terms = normalizePolicyTerms(input)
      const name = input.name.trim()
      if (!name) {
        throw new LeaveDomainValidationError('Policy name must not be empty.')
      }
      const repo = manager.getRepository(LeavePolicyEntity)
      const existing = await repo.find()
      if (
        existing.some(
          (policy) => policy.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new LeaveDomainValidationError(
          `A policy named "${name}" already exists.`,
        )
      }
      const fingerprint = policyTermsFingerprint(terms)
      // An EXPIRED twin does not block: re-introducing an era's terms is
      // legitimate. Only a policy still in force (or one whose window overlaps
      // the new one) collides.
      const twin = existing.find(
        (policy) =>
          policy.termsFingerprint === fingerprint &&
          (policy.effectiveTo === null ||
            policy.effectiveTo >= input.effectiveFrom),
      )
      if (twin) {
        throw new DuplicatePolicyTermsError(
          `A policy with identical terms already exists: "${twin.name}".`,
          twin.id,
          twin.name,
        )
      }
      const now = this.clock.nowIso()
      const created = repo.create({
        id: randomUUID(),
        name,
        description: input.description?.trim() || null,
        ...terms,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        isDefault: false,
        termsFingerprint: fingerprint,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      await repo.save(created)
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyCreated,
        occurredAt: now,
        entityType: 'leave_policy',
        entityId: created.id,
        summary: `Created leave policy "${name}" (${terms.vacationDays}+${terms.sickDays})`,
        after: snapshotPolicy(created),
      })
      return { ...policyToDto(created), memberCount: 0, scheduledInCount: 0 }
    }
  }

  /**
   * Edit the non-term fields. Retiring a policy (effectiveTo) is refused while
   * any live membership would outlive it: resolution must never meet an
   * expired policy that still governs someone, so the members are transferred
   * out first and only then is the window closed.
   */
  async updatePolicy(input: UpdatePolicyInput): Promise<LeavePolicyDto> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'policy:catalog',
      ])
      const repo = manager.getRepository(LeavePolicyEntity)
      const policy = await repo.findOneBy({ id: input.policyId })
      if (!policy) {
        throw new LeaveDomainNotFoundError(`Unknown policy: ${input.policyId}`)
      }
      const before = snapshotPolicy(policy)
      const now = this.clock.nowIso()
      const today = now.slice(0, 10)
      if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name) {
          throw new LeaveDomainValidationError('Policy name must not be empty.')
        }
        const clash = (await repo.find()).find(
          (other) =>
            other.id !== policy.id &&
            other.name.toLowerCase() === name.toLowerCase(),
        )
        if (clash) {
          throw new LeaveDomainValidationError(
            `A policy named "${name}" already exists.`,
          )
        }
        policy.name = name
      }
      if (input.description !== undefined) {
        policy.description = input.description?.trim() || null
      }
      if (input.effectiveTo !== undefined) {
        if (input.effectiveTo !== null) {
          if (policy.isDefault) {
            throw new LeaveDomainValidationError(
              'The default policy cannot be retired: it is the fallback every new employee joins.',
            )
          }
          if (input.effectiveTo < today) {
            throw new LeaveDomainValidationError(
              'A policy can only be retired from today onwards.',
            )
          }
          if (input.effectiveTo < policy.effectiveFrom) {
            throw new LeaveDomainValidationError(
              'The retirement date cannot precede the policy start date.',
            )
          }
          const outliving = await manager
            .getRepository(LeavePolicyMembershipEntity)
            .find({ where: { policyId: policy.id, supersededByRowId: IsNull() } })
          const blocking = outliving.filter(
            (row) =>
              row.effectiveTo === null ||
              row.effectiveTo > input.effectiveTo! ||
              row.effectiveFrom >= input.effectiveTo!,
          )
          if (blocking.length > 0) {
            throw new LeaveDomainValidationError(
              `Cannot retire "${policy.name}" on ${input.effectiveTo}: ${blocking.length} membership(s) would outlive it. Transfer those employees to another policy (or schedule their transfer) first.`,
            )
          }
        }
        policy.effectiveTo = input.effectiveTo
      }
      policy.updatedAt = now
      await repo.save(policy)
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyUpdated,
        occurredAt: now,
        entityType: 'leave_policy',
        entityId: policy.id,
        summary: `Updated leave policy "${policy.name}"`,
        before,
        after: snapshotPolicy(policy),
      })
      const [dto] = await this.listPoliciesTx(manager, policy.id)
      return dto!
    })
  }

  async setDefaultPolicy(input: {
    policyId: string
    audit?: AuditActor
  }): Promise<LeavePolicyDto[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'policy:catalog',
      ])
      const repo = manager.getRepository(LeavePolicyEntity)
      const target = await repo.findOneBy({ id: input.policyId })
      if (!target) {
        throw new LeaveDomainNotFoundError(`Unknown policy: ${input.policyId}`)
      }
      if (target.effectiveTo !== null) {
        throw new LeaveDomainValidationError(
          'A policy that is being retired cannot become the default: the fallback must never expire.',
        )
      }
      if (target.isDefault) {
        return this.listPoliciesTx(manager)
      }
      const now = this.clock.nowIso()
      const previous = await repo.findOneBy({ isDefault: true })
      if (previous) {
        previous.isDefault = false
        previous.updatedAt = now
        await repo.save(previous)
      }
      target.isDefault = true
      target.updatedAt = now
      await repo.save(target)
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyDefaultChanged,
        occurredAt: now,
        entityType: 'leave_policy',
        entityId: target.id,
        summary: `Made "${target.name}" the default leave policy`,
        before: previous ? { policyId: previous.id, name: previous.name } : null,
        after: { policyId: target.id, name: target.name },
      })
      return this.listPoliciesTx(manager)
    })
  }

  /**
   * Hard delete, permitted only while NO membership row ever referenced the
   * policy (R3). A policy people have been on is history: it is retired with
   * effectiveTo instead, which keeps the ledger's provenance intact.
   */
  async deletePolicy(input: {
    policyId: string
    audit?: AuditActor
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'policy:catalog',
      ])
      const repo = manager.getRepository(LeavePolicyEntity)
      const policy = await repo.findOneBy({ id: input.policyId })
      if (!policy) {
        throw new LeaveDomainNotFoundError(`Unknown policy: ${input.policyId}`)
      }
      if (policy.isDefault) {
        throw new PolicyInUseError(
          'The default policy cannot be deleted: it is the fallback every new employee joins.',
        )
      }
      const references = await manager
        .getRepository(LeavePolicyMembershipEntity)
        .countBy({ policyId: policy.id })
      if (references > 0) {
        throw new PolicyInUseError(
          `"${policy.name}" cannot be deleted: ${references} membership record(s) reference it. Retire it instead so the history stays readable.`,
        )
      }
      const now = this.clock.nowIso()
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyDeleted,
        occurredAt: now,
        entityType: 'leave_policy',
        entityId: policy.id,
        summary: `Deleted leave policy "${policy.name}"`,
        before: snapshotPolicy(policy),
      })
      await repo.remove(policy)
    })
  }

  /** The employee-profile policy panel: current, scheduled, probation, history. */
  async getEmployeePolicy(userId: string): Promise<EmployeePolicyDto> {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.requireUser(manager, userId)
      const rows = await manager
        .getRepository(LeavePolicyMembershipEntity)
        .find({ where: { userId }, order: { effectiveFrom: 'ASC' } })
      if (rows.length === 0) {
        throw new LeaveDomainNotFoundError(
          `${user.displayName} is not enrolled in any leave policy yet.`,
        )
      }
      const policies = await manager
        .getRepository(LeavePolicyEntity)
        .findBy({ id: In([...new Set(rows.map((row) => row.policyId))]) })
      const policiesById = new Map(policies.map((policy) => [policy.id, policy]))
      const asOf = await this.resolveAsOfTx(manager, user, this.clock.nowIso())
      const today = asOf.day
      const live = rows.filter((row) => row.supersededByRowId === null)
      const toDto = (row: LeavePolicyMembershipEntity): PolicyMembershipDto => ({
        membershipId: row.id,
        policyId: row.policyId,
        policyName: policiesById.get(row.policyId)?.name ?? 'Unknown policy',
        effectiveFrom: row.effectiveFrom,
        ...(row.effectiveTo ? { effectiveTo: row.effectiveTo } : {}),
        superseded: row.supersededByRowId !== null,
        ...(row.assignedByUserId
          ? { assignedByUserId: row.assignedByUserId }
          : {}),
        ...(row.note ? { note: row.note } : {}),
        createdAt: row.createdAt,
      })
      const currentRow =
        [...live].reverse().find((row) => row.effectiveFrom <= today) ??
        live[0]!
      const scheduledRow = live.find(
        (row) => row.effectiveTo === null && row.effectiveFrom > today,
      )
      const currentPolicy = policiesById.get(currentRow.policyId)
      const probationEnd =
        currentPolicy && currentPolicy.probationMonths > 0 && user.employmentStartDate
          ? addCalendarMonths(
              user.employmentStartDate,
              currentPolicy.probationMonths,
            )
          : null
      return {
        current: toDto(currentRow),
        ...(scheduledRow ? { scheduled: toDto(scheduledRow) } : {}),
        ...(probationEnd
          ? { probation: { endsOn: probationEnd, active: today < probationEnd } }
          : {}),
        history: rows.map(toDto),
      }
    })
  }

  /**
   * Audit a transfer the committed-days guard refused. Its own transaction:
   * the refusal rolled the attempt back, so the record cannot ride along.
   */
  async auditPolicyTransferBlocked(input: {
    userId: string
    policyId: string
    reason: string
    audit?: AuditActor
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager
        .getRepository(UserEntity)
        .findOneBy({ id: input.userId })
      const policy = await manager
        .getRepository(LeavePolicyEntity)
        .findOneBy({ id: input.policyId })
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyMembershipTransferBlocked,
        occurredAt: this.clock.nowIso(),
        ...(user ? { target: { userId: user.id, label: user.displayName } } : {}),
        entityType: 'leave_policy_membership',
        entityId: input.policyId,
        summary: `Blocked transfer of ${user?.displayName ?? input.userId} to policy "${policy?.name ?? input.policyId}"`,
        after: { policyId: input.policyId, reason: input.reason },
      })
    })
  }

  private async listPoliciesTx(
    manager: EntityManager,
    onlyPolicyId?: string,
  ): Promise<LeavePolicyDto[]> {
    const today = this.clock.nowIso().slice(0, 10)
    const policies = await manager
      .getRepository(LeavePolicyEntity)
      .find(onlyPolicyId ? { where: { id: onlyPolicyId } } : {})
    const memberships = await manager
      .getRepository(LeavePolicyMembershipEntity)
      .find({ where: { supersededByRowId: IsNull(), effectiveTo: IsNull() } })
    return policies
      .map((policy) => {
        const open = memberships.filter((row) => row.policyId === policy.id)
        return {
          ...policyToDto(policy),
          memberCount: open.filter((row) => row.effectiveFrom <= today).length,
          scheduledInCount: open.filter((row) => row.effectiveFrom > today)
            .length,
        }
      })
      .sort(
        (left, right) =>
          Number(right.isDefault) - Number(left.isDefault) ||
          left.name.localeCompare(right.name),
      )
  }

  // ------------------------------------------------------ policy transfers ---

  /**
   * Everything the transfer writer and its read-only preflight must agree on:
   * validations, the tense, the applied anchor, and the exact timeline edits.
   * One planner keeps the dialog's dry run and the write path the same
   * computation by construction (the preflight/write parity contract).
   */
  private async planPolicyTransferTx(
    manager: EntityManager,
    input: PreflightPolicyTransferInput,
  ): Promise<{
    user: UserEntity
    targetPolicy: LeavePolicyEntity
    asOf: AsOf
    anchor: string
    tense: 'scheduled' | 'immediate' | 'backdated'
    appliedFrom: string
    liveRows: LeavePolicyMembershipEntity[]
    currentRow: LeavePolicyMembershipEntity | null
    currentPolicyLabel: string
    edits: {
      // The one permitted date edit: closing the open (or straddling-open)
      // row at the boundary.
      closeRow?: { row: LeavePolicyMembershipEntity; at: string }
      // Retroactive mode: live rows fully inside [appliedFrom, inf) are
      // erased from resolution but kept for the audit trail.
      supersedeRows: LeavePolicyMembershipEntity[]
      // A CLOSED row straddling appliedFrom is superseded and replaced by a
      // truncated copy, so history rows are never date-edited.
      replaceClosedRow?: {
        row: LeavePolicyMembershipEntity
        truncatedTo: string
      }
    }
    // The post-mutation timeline as flat resolver inputs (the new open row
    // included) — what the preflight derives schedules from.
    overlayRows: MembershipRowInput[]
  }> {
    const user = await this.requireUser(manager, input.userId)
    if (!user.employmentStartDate) {
      throw new LeaveDomainValidationError(
        'Set the employment start date before changing the policy: without it the terms cannot take effect.',
      )
    }
    const anchor = user.employmentStartDate
    if (!ISO_DATE_PATTERN.test(input.effectiveDate)) {
      throw new LeaveDomainValidationError(
        `Invalid effective date: ${input.effectiveDate}`,
      )
    }
    const targetPolicy = await manager
      .getRepository(LeavePolicyEntity)
      .findOneBy({ id: input.policyId })
    if (!targetPolicy) {
      throw new LeaveDomainNotFoundError(`Unknown policy: ${input.policyId}`)
    }
    if (targetPolicy.effectiveTo !== null) {
      throw new LeaveDomainValidationError(
        `The policy "${targetPolicy.name}" is being retired (its validity ends ${targetPolicy.effectiveTo}) and takes no new members. Transfer to an active policy instead.`,
      )
    }
    if (targetPolicy.effectiveFrom > input.effectiveDate) {
      throw new LeaveDomainValidationError(
        `The policy "${targetPolicy.name}" only takes effect on ${targetPolicy.effectiveFrom}: the transfer cannot start earlier.`,
      )
    }
    const asOf = await this.resolveAsOfTx(manager, user, this.clock.nowIso())
    const today = asOf.day
    const tense =
      input.effectiveDate > today
        ? 'scheduled'
        : input.effectiveDate === today
          ? 'immediate'
          : 'backdated'
    if (tense === 'backdated' && !input.mode) {
      throw new LeaveDomainValidationError(
        'A backdated transfer must state its mode: retroactive (recompute the period) or prospective (new terms from the date on).',
      )
    }
    if (tense !== 'backdated' && input.mode) {
      throw new LeaveDomainValidationError(
        'The transfer mode applies only to backdated transfers; omit it for today or a future date.',
      )
    }
    // Backdates never reach past the current leave year (earlier years are
    // settled or settling — their books do not move) nor before employment.
    const currentYear = getYearFromIsoDate(today)
    const earliestPermissible =
      anchor > `${currentYear}-01-01` ? anchor : `${currentYear}-01-01`
    if (input.effectiveDate < earliestPermissible) {
      throw new PolicyTransferClosedPeriodError(
        `The transfer cannot apply from ${input.effectiveDate}: the earliest permissible date is ${earliestPermissible}.`,
        earliestPermissible,
      )
    }
    const membershipRepo = manager.getRepository(LeavePolicyMembershipEntity)
    const liveRows = await membershipRepo.find({
      where: { userId: input.userId, supersededByRowId: IsNull() },
      order: { effectiveFrom: 'ASC' },
    })
    const scheduledRow = liveRows.find(
      (row) => row.effectiveTo === null && row.effectiveFrom > today,
    )
    if (scheduledRow) {
      throw new LeaveDomainValidationError(
        `A scheduled policy transfer is already pending (effective ${scheduledRow.effectiveFrom}). Cancel it before planning another change.`,
      )
    }
    const openRow =
      liveRows.find((row) => row.effectiveTo === null) ?? null
    const currentRow =
      [...liveRows].reverse().find((row) => row.effectiveFrom <= today) ??
      liveRows[0] ??
      null
    if (currentRow && currentRow.policyId === input.policyId) {
      throw new LeaveDomainValidationError(
        `${user.displayName} is already on the policy "${targetPolicy.name}".`,
      )
    }
    const appliedFrom =
      input.mode === 'retroactive' ? earliestPermissible : input.effectiveDate
    if (
      input.mode === 'prospective' &&
      openRow &&
      appliedFrom <= openRow.effectiveFrom
    ) {
      throw new LeaveDomainValidationError(
        `The prospective mode cannot reach at or before the current membership began (${openRow.effectiveFrom}). Use the retroactive mode to rewrite the recorded timeline.`,
      )
    }

    const edits: {
      closeRow?: { row: LeavePolicyMembershipEntity; at: string }
      supersedeRows: LeavePolicyMembershipEntity[]
      replaceClosedRow?: {
        row: LeavePolicyMembershipEntity
        truncatedTo: string
      }
    } = { supersedeRows: [] }
    if (input.mode === 'retroactive') {
      edits.supersedeRows = liveRows.filter(
        (row) => row.effectiveFrom >= appliedFrom,
      )
      const straddler = liveRows.find(
        (row) =>
          row.effectiveFrom < appliedFrom &&
          (row.effectiveTo === null || row.effectiveTo > appliedFrom),
      )
      if (straddler) {
        if (straddler.effectiveTo === null) {
          edits.closeRow = { row: straddler, at: appliedFrom }
        } else {
          edits.supersedeRows.push(straddler)
          edits.replaceClosedRow = { row: straddler, truncatedTo: appliedFrom }
        }
      }
    } else if (openRow) {
      edits.closeRow = { row: openRow, at: appliedFrom }
    }

    const supersededIds = new Set(edits.supersedeRows.map((row) => row.id))
    const overlayRows: MembershipRowInput[] = liveRows.map((row) => ({
      policyId: row.policyId,
      effectiveFrom: row.effectiveFrom,
      effectiveTo:
        edits.closeRow?.row.id === row.id ? edits.closeRow.at : row.effectiveTo,
      supersededByRowId: supersededIds.has(row.id) ? 'overlay' : null,
    }))
    if (edits.replaceClosedRow) {
      overlayRows.push({
        policyId: edits.replaceClosedRow.row.policyId,
        effectiveFrom: edits.replaceClosedRow.row.effectiveFrom,
        effectiveTo: edits.replaceClosedRow.truncatedTo,
        supersededByRowId: null,
      })
    }
    overlayRows.push({
      policyId: input.policyId,
      effectiveFrom: appliedFrom,
      effectiveTo: null,
      supersededByRowId: null,
    })

    let currentPolicyLabel = 'previous terms'
    if (currentRow) {
      const currentPolicy = await manager
        .getRepository(LeavePolicyEntity)
        .findOneBy({ id: currentRow.policyId })
      currentPolicyLabel = currentPolicy?.name ?? 'previous terms'
    }
    return {
      user,
      targetPolicy,
      asOf,
      anchor,
      tense,
      appliedFrom,
      liveRows,
      currentRow,
      currentPolicyLabel,
      edits,
      overlayRows,
    }
  }

  // The fixed lock order for membership mutations: catalog (so a concurrent
  // policy retirement cannot slip members into a dying policy), then this
  // user's membership timeline, then the per-type balance locks. The
  // documented invariant "per-type first, carryover-close after" is preserved
  // because the close lock is only ever taken inside the settle that follows.
  private async lockPolicyMembership(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'policy:catalog',
    ])
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:policy-membership`,
    ])
    for (const leaveType of ALL_LEAVE_TYPES) {
      await this.lockUserBalanceForUpdate(manager, userId, leaveType)
    }
  }

  // ------------------------------------------- history import primitives ----
  //
  // The pre-go-live import replays each employee's real leave history through
  // the ordinary submit/decide machinery inside ONE transaction per employee.
  // These primitives supply only what the engine cannot derive: the policy
  // enrollment from the hire date, the externally-settled pre-import years,
  // the opening carryover, and (in override mode) the year-bounded wipe with
  // a mechanical re-post of later years. Everything else — accrual, holds,
  // spends, splits, year closes — is produced by the same code paths live
  // usage exercises.

  /**
   * Enroll a user into a policy with a PLAIN historical membership row dated
   * at the hire date (a recording, never a retroactive transfer).
   * The provisioning auto-enrollment (assignedByUserId NULL, dated the
   * provisioning day) is replaced outright — it is minutes-old noise, not
   * history. A hand-curated timeline is honored: 'add' mode reports it and
   * keeps it; 'override' replaces the live rows. Deleting-then-inserting
   * keeps the one-open-row partial unique index satisfied at every step, so
   * the transfer writer's born-closed dance is unnecessary here.
   */
  async assignHistoricalMembershipTx(
    manager: EntityManager,
    input: AssignHistoricalMembershipInput,
  ): Promise<{
    outcome: 'assigned' | 'kept' | 'skipped'
    membershipRowId: string | null
  }> {
    await this.lockPolicyMembership(manager, input.userId)
    const user = await this.requireUser(manager, input.userId)
    const policy = await manager
      .getRepository(LeavePolicyEntity)
      .findOneBy({ id: input.policyId })
    if (!policy) {
      throw new LeaveDomainNotFoundError(`Unknown policy: ${input.policyId}`)
    }
    // Resolution must never meet a policy that does not govern the day: the
    // write is the only place the invariant can be upheld (the resolver
    // deliberately ignores validity windows).
    if (policy.effectiveTo !== null) {
      throw new LeaveDomainValidationError(
        `Policy "${policy.name}" is retired and cannot take new members.`,
      )
    }
    // A policy minted from the terms of one employee starts on THEIR hire
    // date, and the cutover's policies start on the cutover day — yet the same
    // terms governed colleagues hired years earlier. Recording that history
    // opens the window backwards rather than refusing it: the terms are
    // untouched (they are what makes a policy that policy), and reaching
    // further back can strand nobody, since the invariant a validity window
    // protects is about EXPIRY — resolution must never meet a policy that
    // ended while it still governs someone.
    if (policy.effectiveFrom > input.effectiveFrom) {
      const before = { effectiveFrom: policy.effectiveFrom }
      policy.effectiveFrom = input.effectiveFrom
      policy.updatedAt = this.clock.nowIso()
      await manager.getRepository(LeavePolicyEntity).save(policy)
      await this.auditLog.record(manager, {
        actor: input.audit,
        eventType: AuditEventType.PolicyUpdated,
        occurredAt: policy.updatedAt,
        entityType: 'leave_policy',
        entityId: policy.id,
        summary: `Backdated policy "${policy.name}" to ${input.effectiveFrom} so it can hold employment from that date (history import)`,
        before,
        after: { effectiveFrom: policy.effectiveFrom },
      })
    }

    const membershipRepo = manager.getRepository(LeavePolicyMembershipEntity)
    const liveRows = await membershipRepo.find({
      where: { userId: input.userId, supersededByRowId: IsNull() },
      order: { effectiveFrom: 'ASC' },
    })
    const exact =
      liveRows.length === 1 &&
      liveRows[0]!.policyId === input.policyId &&
      liveRows[0]!.effectiveFrom === input.effectiveFrom &&
      liveRows[0]!.effectiveTo === null
    if (exact) {
      return { outcome: 'kept', membershipRowId: liveRows[0]!.id }
    }
    const autoEnrollmentOnly =
      liveRows.length === 1 &&
      liveRows[0]!.assignedByUserId === null &&
      liveRows[0]!.effectiveTo === null
    if (liveRows.length > 0 && !autoEnrollmentOnly) {
      if (input.mode === 'add') {
        return { outcome: 'skipped', membershipRowId: null }
      }
      await membershipRepo.delete({
        userId: input.userId,
        supersededByRowId: IsNull(),
      })
    } else if (liveRows.length > 0) {
      await membershipRepo.delete({ id: liveRows[0]!.id })
    }

    const now = this.clock.nowIso()
    const membershipRowId = randomUUID()
    await membershipRepo.save({
      id: membershipRowId,
      userId: input.userId,
      policyId: input.policyId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      supersededByRowId: null,
      assignedByUserId: input.assignedByUserId,
      note: 'History import',
      createdAt: now,
      updatedAt: now,
    })
    await this.auditLog.record(manager, {
      actor: input.audit,
      eventType: AuditEventType.PolicyMembershipAssigned,
      occurredAt: now,
      target: { userId: user.id, label: user.displayName },
      entityType: 'leave_policy_membership',
      entityId: membershipRowId,
      summary: `Enrolled ${user.displayName} into policy "${policy.name}" from ${input.effectiveFrom} (history import)`,
      after: {
        policyId: policy.id,
        policyName: policy.name,
        effectiveFrom: input.effectiveFrom,
      },
    })
    return { outcome: 'assigned', membershipRowId }
  }

  /**
   * Bring the stored year totals back in line with the policy timeline after
   * the import has re-enrolled someone.
   *
   * ensureAllocation deliberately never revisits a row that already exists, so
   * an employee who used the system before the import keeps the totalDays of
   * whatever policy they were on then — while accrual, which reads the
   * resolver, already follows the NEW one. The result is a year that says "12
   * of 15" while 16.67 days have accrued. This is the same re-materialization
   * a policy transfer performs, reused rather than reinvented: the current
   * year is re-anchored (one signed adjustment when the target really moved)
   * and every open later year has its total and provenance rewritten.
   */
  async resyncAllocationsAfterImportTx(
    manager: EntityManager,
    userId: string,
    occurredAt: string,
  ): Promise<void> {
    const user = await this.requireUser(manager, userId)
    const asOf = await this.resolveAsOfTx(manager, user, occurredAt)
    await this.reanchorAfterMembershipChangeTx(
      manager,
      userId,
      asOf,
      user.employmentStartDate ?? null,
      'Re-resolved from the policy assigned by the data import',
      undefined,
      // A year that really did run past its accrual is a fact to record, not
      // an administrative cut to refuse.
      true,
    )
  }

  /**
   * Settle every pre-import year and seed the target year's opening
   * carryover. Pre-import years get explicitly CLOSED zero allocations
   * (nothing accrues, nothing carries — those years were accounted in the
   * source tracker), which is precisely the state finalizeCarryoverIfDue
   * treats as settled: the walk finds nothing pending and cannot fabricate
   * phantom carryover for years the engine never saw. The target year's
   * allocation is materialized through ensureAllocation (so totalDays and
   * sourcePolicyId resolve from the just-assigned membership), its
   * carriedOverDays is stamped verbatim, and one carryover_in ledger row is
   * booked on January 1 — the same double-entry shape a real year close
   * writes on the incoming side.
   *
   * The engine has usually been here first: the very first balance read
   * settles the pre-provisioning years trivially (the system-epoch rule in
   * finalizeCarryoverIfDue — zero carryover, no rows) and accrues the target
   * year from the anchor. This seed replaces that derived state with the
   * import's own, so it CLEARS the ledger rows and balance caches for every
   * year up to and including the target before writing. Requests are never
   * touched — and a target year that already holds requests is refused rather
   * than silently re-based: their holds and spends are accounted against the
   * figure being replaced, so rebuilding that year is override mode's job.
   *
   * Idempotent: re-seeding the same figure over an already-settled year is a
   * no-op.
   */
  async seedCarryoverHistoryTx(
    manager: EntityManager,
    input: SeedCarryoverHistoryInput,
  ): Promise<{ outcome: 'seeded' | 'kept' }> {
    const user = await this.requireUser(manager, input.userId)
    if (!user.employmentStartDate) {
      throw new LeaveDomainValidationError(
        'The employment start date must be set before seeding leave history.',
      )
    }
    // Serialize with an in-flight year close, exactly like the reset does.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${user.id}:carryover-close`,
    ])
    const anchorYear = getYearFromIsoDate(user.employmentStartDate)
    if (input.targetYear <= anchorYear) {
      // Hired inside (or after) the target year: there is no prior employed
      // year to settle and nothing can have carried in.
      if (roundDays(input.carriedOverVacationDays) > 0) {
        throw new LeaveDomainValidationError(
          `Cannot seed carryover into ${input.targetYear}: the employment starts ${user.employmentStartDate}, so no prior year exists to carry days from.`,
        )
      }
      return { outcome: 'kept' }
    }
    const now = this.clock.nowIso()
    const seeded = roundDays(input.carriedOverVacationDays)
    const allocationRepo = manager.getRepository(LeaveAllocationEntity)

    const target = await allocationRepo.findOneBy({
      userId: user.id,
      leaveType: LeaveType.Vacation,
      year: input.targetYear,
    })
    const alreadySeeded =
      target?.carryoverFinalized === true &&
      target.note === IMPORT_SEEDED_YEAR_NOTE &&
      roundDays(target.carriedOverDays) === seeded
    if (alreadySeeded) {
      return { outcome: 'kept' }
    }
    // A year holding requests cannot be re-based: their holds and spends were
    // accounted against the carryover being replaced. Override mode wipes the
    // year first and then seeds it, which is the supported way to redo one.
    const requestsInScope = await manager
      .getRepository(LeaveRequestEntity)
      .countBy({
        requesterUserId: user.id,
        endDate: MoreThanOrEqual(`${input.targetYear}-01-01`),
      })
    if (requestsInScope > 0) {
      throw new LeaveDomainValidationError(
        `${user.displayName} already has leave from ${input.targetYear} on record; import in override mode to rebuild that year.`,
      )
    }

    // Drop what the engine derived on its own for the years the import now
    // owns. Only derived rows exist here (the guard above proved there are no
    // requests), so nothing a human entered is lost.
    await manager.getRepository(LeaveBalanceChangeEntity).delete({
      userId: user.id,
      year: LessThanOrEqual(input.targetYear),
    })
    await manager.getRepository(LeaveBalanceEntity).delete({
      userId: user.id,
      year: LessThanOrEqual(input.targetYear),
    })

    for (const leaveType of ALL_LEAVE_TYPES) {
      for (let year = anchorYear; year < input.targetYear; year += 1) {
        const existing = await allocationRepo.findOneBy({
          userId: user.id,
          leaveType,
          year,
        })
        const settled = {
          totalDays: 0,
          carriedOverDays: 0,
          carryoverFinalized: true,
          closedAt: now,
          sourcePolicyId: null,
          note: IMPORT_SETTLED_YEAR_NOTE,
          updatedAt: now,
        }
        if (existing) {
          await allocationRepo.update({ id: existing.id }, settled)
        } else {
          await allocationRepo.save(
            allocationRepo.create({
              id: randomUUID(),
              userId: user.id,
              year,
              leaveType,
              accrualStartDate: null,
              setByUserId: null,
              createdAt: now,
              ...settled,
            }),
          )
        }
      }

      const allocation = await this.ensureAllocation(
        manager,
        user.id,
        leaveType,
        input.targetYear,
        asOfInstant(now),
      )
      const carried = leaveType === LeaveType.Vacation ? seeded : 0
      await allocationRepo.update(
        { id: allocation.id },
        {
          carriedOverDays: carried,
          carryoverFinalized: true,
          closedAt: null,
          note: IMPORT_SEEDED_YEAR_NOTE,
          updatedAt: now,
        },
      )
      if (carried > 0) {
        await this.recordBalanceChange(manager, {
          userId: user.id,
          leaveType,
          year: input.targetYear,
          reason: LeaveBalanceChangeReason.CarryoverIn,
          effectiveDate: `${input.targetYear}-01-01`,
          occurredAt: now,
          deltaDays: carried,
          onHoldDelta: 0,
          spentDelta: 0,
          accruedDelta: carried,
          note: 'Imported opening carryover',
        })
      }
    }
    return { outcome: 'seeded' }
  }

  /**
   * Override-mode wipe with a year floor: delete the user's requests, ledger
   * rows and balances from `fromYear` on and reopen those years' allocations,
   * leaving earlier years untouched. Requests that START after `fromYear`
   * (later-year bookings the file does not cover) are snapshotted verbatim
   * before deletion so repostRequestMechanicallyTx can restore them on top of
   * the rebuilt base. The audit trail of the wiped requests survives — only
   * the rows themselves and their derived accounting go.
   */
  async resetUserLeaveDataFromYearTx(
    manager: EntityManager,
    input: ResetUserLeaveDataFromYearInput,
  ): Promise<{
    repost: RepostableLeaveRequestSnapshot[]
    clearedRequests: number
    clearedLedgerEntries: number
    reopenedYears: number
  }> {
    const user = await this.requireUser(manager, input.userId)
    // Same serialization as the full reset: a year close appends ledger rows
    // under this key, and a close committing after our scan would leave the
    // exact residue the wipe exists to remove.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${user.id}:carryover-close`,
    ])
    const fromIso = `${input.fromYear}-01-01`
    const lastDayOfFromYear = `${input.fromYear}-12-31`
    const requestRepo = manager.getRepository(LeaveRequestEntity)
    const ledgerRepo = manager.getRepository(LeaveBalanceChangeEntity)
    const balanceRepo = manager.getRepository(LeaveBalanceEntity)
    const allocationRepo = manager.getRepository(LeaveAllocationEntity)

    // Every request whose period touches `fromYear` or later: frozen leave
    // days live inside [startDate, endDate], so endDate is the intersection
    // test. A December booking spilling into January belongs to the wipe —
    // its January days charge the rebuilt year.
    const affected = await requestRepo.find({
      where: {
        requesterUserId: user.id,
        endDate: MoreThanOrEqual(fromIso),
      },
      order: { startDate: 'ASC' },
    })
    const repost: RepostableLeaveRequestSnapshot[] = []
    for (const request of affected) {
      if (request.startDate <= lastDayOfFromYear) {
        continue
      }
      const requestId = request.id
      repost.push({
        request,
        approvers: await manager
          .getRepository(LeaveRequestApproverEntity)
          .findBy({ requestId }),
        decisions: await manager
          .getRepository(LeaveApprovalDecisionEntity)
          .findBy({ requestId }),
        activities: await manager
          .getRepository(LeaveRequestActivityEntity)
          .findBy({ requestId }),
      })
    }

    const clearedLedgerEntries = await ledgerRepo.countBy({
      userId: user.id,
      year: MoreThanOrEqual(input.fromYear),
    })
    const reopenedYears = await allocationRepo.countBy({
      userId: user.id,
      year: MoreThanOrEqual(input.fromYear),
      closedAt: Not(IsNull()),
    })
    if (affected.length > 0) {
      await requestRepo.delete({ id: In(affected.map((r) => r.id)) })
    }
    await ledgerRepo.delete({
      userId: user.id,
      year: MoreThanOrEqual(input.fromYear),
    })
    await balanceRepo.delete({
      userId: user.id,
      year: MoreThanOrEqual(input.fromYear),
    })
    await allocationRepo.update(
      { userId: user.id, year: MoreThanOrEqual(input.fromYear) },
      {
        carriedOverDays: 0,
        carryoverFinalized: false,
        closedAt: null,
        updatedAt: this.clock.nowIso(),
      },
    )

    await this.auditLog.record(manager, {
      actor: input.audit,
      eventType: AuditEventType.EmployeeLeaveDataReset,
      target: { userId: user.id, label: user.displayName },
      entityType: 'user',
      entityId: user.id,
      summary: `Reset ${user.displayName}'s leave data from ${input.fromYear} (cleared ${affected.length} request(s) and ${clearedLedgerEntries} ledger entr${clearedLedgerEntries === 1 ? 'y' : 'ies'}, reopened ${reopenedYears} closed year(s); ${repost.length} later-year request(s) queued for re-post)`,
      before: {
        fromYear: input.fromYear,
        requests: affected.length,
        ledgerEntries: clearedLedgerEntries,
        closedYears: reopenedYears,
      },
      after: { requests: repost.length, ledgerEntries: 0, closedYears: 0 },
    })

    return {
      repost,
      clearedRequests: affected.length,
      clearedLedgerEntries,
      reopenedYears,
    }
  }

  /**
   * The transaction-scoped reads the import composes its per-employee plan
   * from: the user row it must match (never create), the leave already on
   * record for a period, the balances after the replay has settled, and the
   * settle pass itself. Public only so the import service — which owns the
   * transaction — can ask the same questions the domain asks itself.
   */
  async findUserByEmailTx(
    manager: EntityManager,
    email: string,
  ): Promise<LeaveDomainUserRecord | undefined> {
    const user = await manager
      .getRepository(UserEntity)
      .findOneBy({ normalizedEmail: normalizeEmail(email) })
    return user ? userToRecord(user) : undefined
  }

  async findOverlappingRequestsTx(
    manager: EntityManager,
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<LeaveAvailabilityOverlappingRequestDto[]> {
    return this.findOverlappingRequests(manager, userId, startDate, endDate)
  }

  // The working DATES a period covers, for callers that must judge a date set
  // against the calendar before anything is submitted: the history import
  // checks the dates a row's hours cell names this way, so a weekend or a
  // holiday is reported as a fixable row issue instead of failing the whole
  // employee once the replay reaches the submission core. The SAME resolver
  // that core prices from, so a date missing here is one no request over that
  // period can charge.
  async resolveWorkingDatesTx(
    manager: EntityManager,
    input: CalculateRequestedDaysInput,
  ): Promise<string[]> {
    return this.resolveLeaveDays(manager, input)
  }

  async settleBalancesTx(
    manager: EntityManager,
    userId: string,
    asOfIso: string,
  ): Promise<void> {
    await this.refreshBalancesTx(manager, userId, asOfIso)
  }

  async readBalancesTx(
    manager: EntityManager,
    userId: string,
    asOfIso?: string,
  ): Promise<LeaveBalanceDto[]> {
    return this.buildBalanceDtos(manager, userId, asOfIso)
  }

  /**
   * The balance as it stood on a PAST day, folded from the ledger rather than
   * read from the cache: the cache only knows "now", and comparing a tracker
   * exported on the 1st against a balance that has since accrued another month
   * would report a discrepancy where there is none. Each row is dated by the
   * day it is about (accrual to the 1st of its month, a spend to the leave day
   * itself), so the fold is a plain date filter.
   */
  async readBalanceAsOfTx(
    manager: EntityManager,
    userId: string,
    leaveType: LeaveType,
    year: number,
    asOfDay: string,
  ): Promise<{
    accruedDays: number
    spentDays: number
    availableDays: number
    committedDays: number
  }> {
    // The state at the START of the day: accrual is dated to the 1st of its
    // month, so "the balance on August 1" means the seven months before it —
    // which is what a tracker exported that morning shows.
    const rows = await manager.getRepository(LeaveBalanceChangeEntity).find({
      where: { userId, leaveType, year, effectiveDate: LessThan(asOfDay) },
    })
    let accrued = 0
    let spent = 0
    for (const row of rows) {
      switch (row.reason) {
        case LeaveBalanceChangeReason.Accrual:
        case LeaveBalanceChangeReason.CarryoverIn:
          accrued += row.deltaDays
          break
        case LeaveBalanceChangeReason.CarryoverOut:
        case LeaveBalanceChangeReason.Expired:
          accrued -= row.deltaDays
          break
        case LeaveBalanceChangeReason.Adjustment:
          // Adjustments carry their own sign.
          accrued += row.deltaDays
          break
        case LeaveBalanceChangeReason.Spent:
          spent += row.deltaDays
          break
        default:
          // Holds and releases move days between "available" and "on hold",
          // which a historical balance does not distinguish.
          break
      }
    }
    // Leave already agreed for days after this one. The system holds those days
    // rather than spending them, but a hand-kept tracker usually deducts them
    // the moment the leave is approved — so the comparable figure needs them
    // named separately instead of hidden.
    const requests = await manager.getRepository(LeaveRequestEntity).find({
      where: {
        requesterUserId: userId,
        leaveType,
        status: In([LeaveRequestStatus.Pending, LeaveRequestStatus.Approved]),
      },
    })
    let committed = 0
    for (const request of requests) {
      const unpaid = new Set(request.unpaidLeaveDays)
      request.leaveDays.forEach((day, index) => {
        if (
          day >= asOfDay &&
          getYearFromIsoDate(day) === year &&
          !unpaid.has(day)
        ) {
          // What the day costs, which is what a tracker would have deducted
          // for it.
          committed += portionAt(request.dayPortions, index)
        }
      })
    }

    return {
      accruedDays: roundDays(accrued),
      spentDays: roundDays(spent),
      availableDays: roundDays(accrued - spent),
      committedDays: roundDays(committed),
    }
  }

  /**
   * Mint the policy this row asks for, or hand back the one that already
   * answers it. WHICH policy that is belongs to resolvePolicy (policy-
   * resolution.ts), which the import's preview runs too: this is the writer,
   * not a second opinion, so the plan the operator approved is the plan carried
   * out.
   *
   * The catalog advisory lock is taken FIRST and the catalog is read inside it,
   * so the snapshot the resolver answers over cannot move under the write and
   * two concurrent runs cannot both decide to create. Both catch arms below
   * stay as the belt to that brace, in case the resolver and createPolicyTx
   * ever drift apart.
   */
  async findOrCreatePolicyByTermsTx(
    manager: EntityManager,
    input: CreateLeavePolicyInput,
    // When the file named a policy, that name decides: a deal already agreed
    // in the catalog is joined rather than re-derived from the row, so a file
    // that only says who belongs where cannot mint a near-twin of it. The
    // terms still travel, and the caller is told when they disagree.
    opts: { matchByName?: boolean } = {},
  ): Promise<{
    policyId: string
    policyName: string
    created: boolean
    // The terms the employee ends up GOVERNED by: the catalog's when a policy
    // was joined, the supplied ones when it was minted. The caller reports the
    // deal, and after a name match the row's own figures are not it.
    terms: LeavePolicyTerms
    // Set when the named policy's terms are not the ones supplied. EVERY
    // behaviour-bearing term is compared, not just the two day counts: an
    // export gives every row its policy name, so a file edited in the "Increase
    // every" or the probation column would otherwise be overruled in silence.
    // Both sides travel, plus the terms that actually disagree, because the
    // caller can only name them if it is told which.
    termsMismatch?: {
      catalog: LeavePolicyTerms
      supplied: LeavePolicyTerms
      differing: (keyof LeavePolicyTerms)[]
    }
  }> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'policy:catalog',
    ])
    const catalog = (await manager.getRepository(LeavePolicyEntity).find()).map(
      policyCatalogEntry,
    )
    // Validated here, quantized there: the resolver never refuses, so terms the
    // catalog could not hold must still fail this employee loudly rather than
    // be grouped into something legal.
    const supplied = normalizePolicyTerms(input)
    const resolution = resolvePolicy(
      {
        // input.name has already collapsed the file's name, the operator's and
        // the derived one into the single name to use; matchByName is what says
        // whether the file is the one that stated it.
        ...(opts.matchByName ? { fileName: input.name } : {}),
        chosenName: input.name,
        terms: supplied,
        effectiveFrom: input.effectiveFrom,
      },
      catalog,
    )
    if (
      resolution.kind === 'join-by-name' ||
      resolution.kind === 'join-by-terms'
    ) {
      const termsMismatch =
        resolution.kind === 'join-by-name' ? resolution.termsMismatch : undefined
      return {
        policyId: resolution.policyId,
        policyName: resolution.policyName,
        created: false,
        terms: resolution.terms,
        ...(termsMismatch ? { termsMismatch } : {}),
      }
    }
    // The resolver already numbered the name away from every one the catalog
    // held when it was read; the loop re-numbers only if the write disagrees,
    // which it can no longer do while the lock is held.
    const taken = catalog.map((entry) => entry.name)
    let name = resolution.plannedName
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const created = await this.createPolicyTx(manager, { ...input, name })
        return {
          policyId: created.policyId,
          policyName: created.name,
          created: true,
          terms: resolution.terms,
        }
      } catch (error) {
        if (error instanceof DuplicatePolicyTermsError) {
          // The twin carries these very terms (that is what the refusal means),
          // so the deal reported is the one supplied.
          return {
            policyId: error.existingPolicyId,
            policyName: error.existingPolicyName,
            created: false,
            terms: supplied,
          }
        }
        if (
          error instanceof LeaveDomainValidationError &&
          error.message.includes('already exists')
        ) {
          taken.push(name)
          name = firstFreePolicyName(resolution.nameBase, taken)
          continue
        }
        throw error
      }
    }
    throw new LeaveDomainValidationError(
      `Could not find a free name for the imported policy "${input.name}".`,
    )
  }

  /**
   * Restore one wiped later-year request verbatim on top of a rebuilt base:
   * the row keeps its id, its frozen leaveDays/unpaidLeaveDays split, its
   * status and its timeline rows — history is re-posted, never re-derived.
   * Only the accounting is rebuilt, and only its beginning: the consumption
   * cursor is rewound and the paid days are re-held per year, so the final
   * refreshBalancesTx pass re-consumes the elapsed days through the ordinary
   * reconcile — each spent row lands back on its own day and year. No
   * notifications and no audit rows: the originals survived the wipe.
   */
  async repostRequestMechanicallyTx(
    manager: EntityManager,
    snapshot: RepostableLeaveRequestSnapshot,
  ): Promise<void> {
    const requestRepo = manager.getRepository(LeaveRequestEntity)
    const request = requestRepo.create({
      ...snapshot.request,
      spentDaysConsumed: 0,
      remainingHeldDays: 0,
    })

    const active =
      request.status === LeaveRequestStatus.Approved ||
      request.status === LeaveRequestStatus.Pending
    if (active) {
      // The cursor is rewound above, so every paid date is held again, priced
      // by the portions the row kept, which is why the re-posted hold matches
      // the one releaseHold will later give back.
      const paidByYear = remainingPaidDaysByYear({
        leaveDays: request.leaveDays,
        dayPortions: request.dayPortions,
        unpaidLeaveDays: request.unpaidLeaveDays,
        spentDaysConsumed: 0,
      })
      request.remainingHeldDays = roundDays(
        [...paidByYear.values()].reduce(
          (sum, entries) => sum + committedCost(entries),
          0,
        ),
      )
      await requestRepo.save(request)
      for (const [year, entries] of paidByYear) {
        const yearHeld = committedCost(entries)
        await this.recordBalanceChange(manager, {
          userId: request.requesterUserId,
          leaveType: request.leaveType,
          year,
          reason: LeaveBalanceChangeReason.Hold,
          effectiveDate: request.startDate,
          occurredAt: request.submittedAt,
          deltaDays: yearHeld,
          onHoldDelta: yearHeld,
          spentDelta: 0,
          accruedDelta: 0,
          note: `Re-posted hold for request ${request.id} (override import)`,
        })
      }
    } else {
      await requestRepo.save(request)
    }

    await manager
      .getRepository(LeaveRequestApproverEntity)
      .save(snapshot.approvers.map((row) => ({ ...row })))
    await manager
      .getRepository(LeaveApprovalDecisionEntity)
      .save(snapshot.decisions.map((row) => ({ ...row })))
    await manager
      .getRepository(LeaveRequestActivityEntity)
      .save(snapshot.activities.map((row) => ({ ...row })))
  }

  /**
   * Move an employee to another policy. Every tense runs the same
   * reanchor-on-mutation choreography: settle the balance under the OLD
   * timeline, write the membership rows, then bring each open year to the NEW
   * timeline's target with one signed adjustment per leave type — so accrued
   * equals target after any sequence of mutations. A committed-days guard
   * failure rolls the whole transaction back, membership rows included.
   */
  async transferEmployeePolicy(
    input: TransferEmployeePolicyInput,
  ): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockPolicyMembership(manager, input.userId)
      const now = this.clock.nowIso()
      const plan = await this.planPolicyTransferTx(manager, input)
      // Settle under the OLD timeline first: reconcile, accrue, close — the
      // adjustment below must be measured from a settled figure.
      await this.refreshBalancesTx(manager, input.userId, now)

      const membershipRepo = manager.getRepository(LeavePolicyMembershipEntity)
      if (plan.edits.closeRow) {
        plan.edits.closeRow.row.effectiveTo = plan.edits.closeRow.at
        plan.edits.closeRow.row.updatedAt = plan.asOf.iso
        await membershipRepo.save(plan.edits.closeRow.row)
      }
      // Ordering dance: the one-open-row partial unique index and the
      // supersede FK pull in opposite directions — the old open row must be
      // marked superseded before a second open row may exist, but the mark
      // references the new row. So when an OPEN row is being superseded
      // (retroactive mode), the new row is born transiently CLOSED, the marks
      // are stamped, and only then is it opened; every intermediate state is
      // valid and the whole dance is one transaction.
      const supersedesOpenRow = plan.edits.supersedeRows.some(
        (row) => row.effectiveTo === null,
      )
      const newRowId = randomUUID()
      await membershipRepo.save({
        id: newRowId,
        userId: input.userId,
        policyId: input.policyId,
        effectiveFrom: plan.appliedFrom,
        effectiveTo: supersedesOpenRow ? plan.appliedFrom : null,
        supersededByRowId: null,
        assignedByUserId: input.assignedByUserId ?? null,
        note: input.note ?? null,
        createdAt: plan.asOf.iso,
        updatedAt: plan.asOf.iso,
      })
      for (const row of plan.edits.supersedeRows) {
        row.supersededByRowId = newRowId
        row.updatedAt = plan.asOf.iso
        await membershipRepo.save(row)
      }
      if (supersedesOpenRow) {
        await membershipRepo.update({ id: newRowId }, { effectiveTo: null })
      }
      if (plan.edits.replaceClosedRow) {
        await membershipRepo.save({
          id: randomUUID(),
          userId: input.userId,
          policyId: plan.edits.replaceClosedRow.row.policyId,
          effectiveFrom: plan.edits.replaceClosedRow.row.effectiveFrom,
          effectiveTo: plan.edits.replaceClosedRow.truncatedTo,
          supersededByRowId: null,
          assignedByUserId: plan.edits.replaceClosedRow.row.assignedByUserId,
          note: 'Truncated by a retroactive policy transfer',
          createdAt: plan.asOf.iso,
          updatedAt: plan.asOf.iso,
        })
      }

      const perYearAdjustments = await this.reanchorAfterMembershipChangeTx(
        manager,
        input.userId,
        plan.asOf,
        plan.anchor,
        `Policy transfer: ${plan.currentPolicyLabel} -> ${plan.targetPolicy.name}, effective ${plan.appliedFrom}`,
        input.audit,
      )

      const eventType =
        plan.tense === 'scheduled'
          ? AuditEventType.PolicyMembershipTransferScheduled
          : plan.tense === 'immediate'
            ? AuditEventType.PolicyMembershipTransferred
            : AuditEventType.PolicyMembershipBackdated
      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType,
        occurredAt: now,
        target: { userId: plan.user.id, label: plan.user.displayName },
        entityType: 'leave_policy_membership',
        entityId: newRowId,
        summary:
          plan.tense === 'scheduled'
            ? `Scheduled ${plan.user.displayName}'s transfer to policy "${plan.targetPolicy.name}" effective ${plan.appliedFrom}`
            : plan.tense === 'immediate'
              ? `Moved ${plan.user.displayName} to policy "${plan.targetPolicy.name}"`
              : `Backdated ${plan.user.displayName}'s transfer to policy "${plan.targetPolicy.name}" (${input.mode}) from ${plan.appliedFrom}`,
        before: plan.currentRow
          ? {
              policyId: plan.currentRow.policyId,
              policyName: plan.currentPolicyLabel,
              effectiveFrom: plan.currentRow.effectiveFrom,
            }
          : null,
        after: {
          policyId: input.policyId,
          policyName: plan.targetPolicy.name,
          effectiveFrom: plan.appliedFrom,
          ...(plan.tense === 'backdated'
            ? {
                mode: input.mode,
                nominalDate: input.effectiveDate,
                supersededRowIds: plan.edits.supersedeRows.map((row) => row.id),
                adjustments: perYearAdjustments,
              }
            : {}),
        },
      })

      return userToRecord(plan.user)
    })
  }

  /**
   * Cancel a not-yet-effective scheduled transfer: delete the future-dated
   * row, reopen its predecessor, and reanchor — when a boundary-month read
   * already priced the new rate, the reversal posts the exact opposite
   * adjustment, restoring accrued == target. The committed-days guard applies
   * here too: an employee who already planned against the scheduled policy's
   * projection legitimately blocks the cancellation.
   */
  async cancelScheduledPolicyTransfer(
    input: CancelScheduledPolicyTransferInput,
  ): Promise<LeaveDomainUserRecord> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockPolicyMembership(manager, input.userId)
      const user = await this.requireUser(manager, input.userId)
      const now = this.clock.nowIso()
      const asOf = await this.resolveAsOfTx(manager, user, now)
      await this.refreshBalancesTx(manager, input.userId, now)

      const membershipRepo = manager.getRepository(LeavePolicyMembershipEntity)
      const liveRows = await membershipRepo.find({
        where: { userId: input.userId, supersededByRowId: IsNull() },
        order: { effectiveFrom: 'ASC' },
      })
      const scheduled = liveRows.find(
        (row) => row.effectiveTo === null && row.effectiveFrom > asOf.day,
      )
      if (!scheduled) {
        throw new LeaveDomainValidationError(
          'No scheduled policy transfer to cancel.',
        )
      }
      const scheduledPolicy = await manager
        .getRepository(LeavePolicyEntity)
        .findOneBy({ id: scheduled.policyId })
      // Delete BEFORE reopening the predecessor: two open live rows would
      // violate the one-open-row unique index.
      await membershipRepo.remove(scheduled)
      const predecessor = liveRows.find(
        (row) => row.effectiveTo === scheduled.effectiveFrom,
      )
      if (predecessor) {
        predecessor.effectiveTo = null
        predecessor.updatedAt = asOf.iso
        await membershipRepo.save(predecessor)
      }

      await this.reanchorAfterMembershipChangeTx(
        manager,
        input.userId,
        asOf,
        user.employmentStartDate ?? null,
        `Policy transfer cancelled: schedule to ${scheduledPolicy?.name ?? scheduled.policyId} removed`,
        input.audit,
      )

      await this.auditLog.record(manager, {
        actor: input.audit ?? SYSTEM_ACTOR,
        eventType: AuditEventType.PolicyMembershipTransferScheduleCanceled,
        occurredAt: now,
        target: { userId: user.id, label: user.displayName },
        entityType: 'leave_policy_membership',
        entityId: scheduled.id,
        summary: `Cancelled ${user.displayName}'s scheduled transfer to policy "${scheduledPolicy?.name ?? scheduled.policyId}" (was effective ${scheduled.effectiveFrom})`,
        before: {
          policyId: scheduled.policyId,
          policyName: scheduledPolicy?.name ?? null,
          effectiveFrom: scheduled.effectiveFrom,
        },
      })

      return userToRecord(user)
    })
  }

  // The shared post-mutation pass: reanchor the CURRENT year for both leave
  // types (reanchorAccrual recomputes the target from the live timeline,
  // syncs the allocation cache, posts the signed adjustment and runs the
  // committed-days guard), then refresh the cache of forward-booked future
  // years WITHOUT reanchoring them — a future year's accrual target is 0 as
  // of today, and reanchoring past the as-of year would let a rewound test
  // clock wipe legitimately accrued future-year rows.
  private async reanchorAfterMembershipChangeTx(
    manager: EntityManager,
    userId: string,
    asOf: AsOf,
    anchor: string | null,
    note: string,
    audit?: AuditActor,
    skipCommitmentGuard = false,
  ): Promise<PolicyTransferAdjustmentDto[]> {
    const currentYear = getYearFromIsoDate(asOf.day)
    const adjustments: PolicyTransferAdjustmentDto[] = []
    for (const leaveType of ALL_LEAVE_TYPES) {
      // The committed-days refusal is re-thrown as its own type: it is the one
      // refusal the admin surface audits (policy.membership_transfer_blocked)
      // and renders with a blocking-request list, so it must be
      // distinguishable from ordinary validation.
      const { adjustmentDelta } = await this.reanchorAccrual(manager, {
        userId,
        leaveType,
        year: currentYear,
        now: asOf,
        anchor,
        note,
        skipCommitmentGuard,
        guardMessage:
          'Cannot apply this policy change: the employee has more committed (held + spent) leave days than the new terms allow. Resolve or cancel those requests first, or schedule the change for January 1.',
      }).catch((error: unknown) => {
        if (
          error instanceof LeaveDomainValidationError &&
          error.message.startsWith('Cannot apply this policy change')
        ) {
          throw new PolicyTransferBlockedError(error.message)
        }
        throw error
      })
      if (adjustmentDelta !== 0) {
        const allocation = await manager
          .getRepository(LeaveAllocationEntity)
          .findOneBy({ userId, leaveType, year: currentYear })
        adjustments.push({
          year: currentYear,
          leaveType,
          delta: adjustmentDelta,
          newYearTotal: allocation?.totalDays ?? 0,
        })
      }
    }
    const allocationRepo = manager.getRepository(LeaveAllocationEntity)
    const futureRows = await allocationRepo.find({
      where: { userId, closedAt: IsNull(), year: MoreThan(currentYear) },
      order: { year: 'ASC' },
    })
    // Only for the audit summaries below: read once for the whole sweep rather
    // than per rematerialized year.
    const { hoursPerDay } = await this.loadSettingsState(manager)
    for (const row of futureRows) {
      const schedule = await this.resolvePolicyScheduleTx(
        manager,
        userId,
        row.year,
        anchor,
      )
      if (!schedule) {
        continue
      }
      const total = scheduleYearEndTotal(row.leaveType, schedule)
      const december = schedule.segments[schedule.segments.length - 1]!
      if (
        row.totalDays !== total ||
        row.sourcePolicyId !== december.policyId
      ) {
        const previousTotal = row.totalDays
        row.totalDays = total
        row.sourcePolicyId = december.policyId
        row.updatedAt = asOf.iso
        await allocationRepo.save(row)
        await this.auditLog.record(manager, {
          actor: audit ?? SYSTEM_ACTOR,
          eventType: AuditEventType.PolicyAllocationMaterialized,
          occurredAt: asOf.iso,
          target: { userId },
          entityType: 'leave_allocation',
          entityId: `${userId}:${row.leaveType}:${row.year}`,
          summary: `Rematerialized ${row.leaveType} ${row.year}: ${formatDayAmount(total, hoursPerDay)} from policy "${december.policyName}"`,
          before: { year: row.year, leaveType: row.leaveType, totalDays: previousTotal },
          after: { year: row.year, leaveType: row.leaveType, totalDays: total },
        })
      }
    }
    return adjustments
  }

  /**
   * Read-only dry run of transferEmployeePolicy: identical validations (the
   * same refusals throw), then a zero-write simulation of what the transfer
   * would do — per-year signed adjustments, the requests a downgrade cannot
   * cover (with the post-mutation accrued figure substituted, so downgrades
   * are actually caught), and the paid requests falling inside the target
   * policy's probation window.
   */
  async preflightPolicyTransfer(
    input: PreflightPolicyTransferInput,
  ): Promise<PolicyTransferPreflightDto> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await this.planPolicyTransferTx(manager, input)
      const today = plan.asOf.day
      const currentYear = getYearFromIsoDate(today)
      const nextYear = currentYear + PLANNING_HORIZON_YEARS
      const settings = await this.loadSettingsState(manager)

      // Terms for every policy the overlay references, target included.
      const policyIds = [
        ...new Set([
          ...plan.overlayRows.map((row) => row.policyId),
          input.policyId,
        ]),
      ]
      const policies = await manager
        .getRepository(LeavePolicyEntity)
        .findBy({ id: In(policyIds) })
      const policiesById = new Map<string, PolicyTermsInput>(
        policies.map((policy) => [
          policy.id,
          {
            policyId: policy.id,
            name: policy.name,
            vacationDays: policy.vacationDays,
            sickDays: policy.sickDays,
            vacationAnnualIncrement: policy.vacationAnnualIncrement,
            vacationIncrementEveryYears: policy.vacationIncrementEveryYears,
            vacationIncrementCapDays: policy.vacationIncrementCapDays,
          },
        ]),
      )
      const overlayScheduleFor = (year: number): PolicyYearSchedule =>
        deriveYearSchedule(year, plan.overlayRows, policiesById, plan.anchor)!

      const perYearAdjustments: PolicyTransferAdjustmentDto[] = []
      const blockingIds = new Set<string>()
      let shortfall = false
      for (const leaveType of ALL_LEAVE_TYPES) {
        const live = await this.resolveProjectionInputs(
          manager,
          input.userId,
          leaveType,
          currentYear,
          plan.anchor,
        )
        const { hireMonth, months } = accrualScheduleForYear(
          currentYear,
          today,
          plan.anchor,
        )
        const overlaySchedule = overlayScheduleFor(currentYear)
        const overlayTargetNow = pieceTargetDays(
          leaveType,
          overlaySchedule,
          live.carriedOverDays,
          hireMonth,
          months,
          live.manualAdjustmentDays,
        )
        const liveTargetNow = pieceTargetDays(
          leaveType,
          live.schedule,
          live.carriedOverDays,
          hireMonth,
          months,
          live.manualAdjustmentDays,
        )
        // The settle raises a dormant balance to the live target but never
        // lowers an adjusted-above one; the reanchor then forces it to the
        // overlay target exactly.
        const settledAccrued = Math.max(live.accruedDays, liveTargetNow)
        const delta = roundDays(overlayTargetNow - settledAccrued)
        if (delta !== 0) {
          perYearAdjustments.push({
            year: currentYear,
            leaveType,
            delta,
            newYearTotal: roundDays(
              scheduleYearEndTotal(leaveType, overlaySchedule) +
                live.manualAdjustmentDays,
            ),
          })
        }

        const committed = await this.loadCommittedScheduleWithRequests(
          manager,
          input.userId,
          leaveType,
          [currentYear, nextYear],
          [],
        )
        if (live.spentDays > overlayTargetNow + BALANCE_EPSILON) {
          shortfall = true
        }
        const currentInputs: ProjectedAccrualInputs = {
          leaveType,
          year: currentYear,
          nowDay: today,
          anchor: plan.anchor,
          schedule: overlaySchedule,
          carriedOverDays: live.carriedOverDays,
          manualAdjustmentDays: live.manualAdjustmentDays,
          currentAccruedDays: overlayTargetNow,
        }
        let running = roundDays(live.spentDays)
        const currentEntries = committed.get(currentYear) ?? []
        for (const entry of currentEntries) {
          running = roundDays(running + entry.portion)
          if (
            running >
            projectedAccruedAtDay(currentInputs, entry.day) + BALANCE_EPSILON
          ) {
            blockingIds.add(entry.requestId)
          }
        }
        const nextEntries = committed.get(nextYear) ?? []
        if (nextEntries.length > 0) {
          const overlayNext = overlayScheduleFor(nextYear)
          const projectedNextCarryover = applyCarryoverPolicy(
            roundDays(
              pieceTargetDays(
                leaveType,
                overlaySchedule,
                live.carriedOverDays,
                hireMonth,
                Math.max(0, 13 - hireMonth),
                live.manualAdjustmentDays,
              ) -
                live.spentDays -
                committedCost(currentEntries),
            ),
            carryoverPolicyFor(leaveType, settings),
            settings,
            // The earned entitlement the current year would END on under the
            // proposed membership, not the one it has today: this preview
            // exists to answer what the transfer changes, and a percent_of_total
            // cap moves with the target policy's terms. Hire-month prorated
            // and manual-adjusted through the same helper the real close uses,
            // so the preview's ceiling is the one the close will apply.
            carryoverCapBaseDays(
              leaveType,
              overlaySchedule,
              currentYear,
              plan.anchor,
              live.manualAdjustmentDays,
            ),
          )
          const nextInputs: ProjectedAccrualInputs = {
            leaveType,
            year: nextYear,
            nowDay: today,
            anchor: plan.anchor,
            schedule: overlayNext,
            carriedOverDays: projectedNextCarryover,
            // Next year does not inherit the current year's manual offset —
            // residual days move only via carryover, same as booked leave.
            manualAdjustmentDays: 0,
            currentAccruedDays: 0,
          }
          let runningNext = 0
          for (const entry of nextEntries) {
            runningNext = roundDays(runningNext + entry.portion)
            if (
              runningNext >
              projectedAccruedAtDay(nextInputs, entry.day) + BALANCE_EPSILON
            ) {
              blockingIds.add(entry.requestId)
            }
          }
        }
      }

      // Paid requests whose days fall inside the target policy's probation
      // window: informational (approved splits stay frozen), surfaced so the
      // admin sees them before committing.
      const probationIds = new Set<string>()
      if (plan.targetPolicy.probationMonths > 0) {
        const probationEnd = addCalendarMonths(
          plan.anchor,
          plan.targetPolicy.probationMonths,
        )
        const dayFloor = plan.appliedFrom > today ? plan.appliedFrom : today
        if (probationEnd > dayFloor) {
          for (const leaveType of ALL_LEAVE_TYPES) {
            const committed = await this.loadCommittedScheduleWithRequests(
              manager,
              input.userId,
              leaveType,
              [currentYear, nextYear],
              [],
            )
            for (const entries of committed.values()) {
              for (const entry of entries) {
                if (entry.day >= dayFloor && entry.day < probationEnd) {
                  probationIds.add(entry.requestId)
                }
              }
            }
          }
        }
      }

      const refsFor = async (
        ids: Set<string>,
      ): Promise<PolicyTransferRequestRefDto[]> => {
        if (ids.size === 0) {
          return []
        }
        const requests = await manager
          .getRepository(LeaveRequestEntity)
          .findBy({ id: In([...ids]) })
        return requests.map((request) => ({
          requestId: request.id,
          leaveType: request.leaveType,
          startDate: request.startDate,
          endDate: request.endDate,
          paidDays: paidDaysOf(request),
        }))
      }
      const blockingRequests = await refsFor(blockingIds)
      const probationWarnings = await refsFor(probationIds)
      return {
        feasible: !shortfall && blockingRequests.length === 0,
        blockingRequests,
        probationWarnings,
        perYearAdjustments,
        appliedFrom: plan.appliedFrom,
      }
    })
  }

  async snapshot(): Promise<LeaveDomainSnapshot> {
    return this.dataSource.transaction(async (manager) => {
      const users = await this.listUsersTx(manager)
      const balances: Record<string, LeaveBalanceDto[]> = {}
      for (const user of users) {
        balances[user.userId] = await this.buildBalanceDtos(
          manager,
          user.userId,
        )
      }
      const requestEntities = await manager
        .getRepository(LeaveRequestEntity)
        .find()
      // One read for every request in the snapshot (see getLeaveRequestHistory).
      const hoursPerDay = await this.getWorkdayHoursTx(manager)
      const requests: LeaveRequestDetailDto[] = []
      for (const entity of requestEntities) {
        requests.push(await this.buildRequestDetail(manager, entity, hoursPerDay))
      }
      return {
        users,
        balances,
        requests,
        settings: await this.getLeaveSettingsTx(manager),
        holidays: await this.listHolidayCalendarsTx(manager),
      }
    })
  }

  // --------------------------------------------------------------- helpers ---

  private async requireUser(
    manager: EntityManager,
    userId: string,
  ): Promise<UserEntity> {
    const user = await manager.getRepository(UserEntity).findOneBy({ id: userId })
    if (!user) {
      throw new LeaveDomainNotFoundError(`Unknown user: ${userId}`)
    }
    return user
  }

  private async requireRequest(
    manager: EntityManager,
    requestId: string,
  ): Promise<LeaveRequestEntity> {
    const request = await manager
      .getRepository(LeaveRequestEntity)
      .findOneBy({ id: requestId })
    if (!request) {
      throw new LeaveDomainNotFoundError(`Unknown leave request: ${requestId}`)
    }
    return request
  }

  /**
   * SELECT ... FOR UPDATE on the leave_requests row. Taken as the first
   * statement of every decide/force/cancel/remove-approver transaction so those
   * mutations are strictly serialized per request: concurrent approves can no
   * longer both observe the other still pending (stuck), and reject/cancel can
   * no longer both read remainingHeldDays and release the hold twice. Relations
   * are not loaded so this is a plain row lock. (Gate correctness relies on the
   * READ COMMITTED default: once the lock is acquired, a re-read of the sibling
   * approver rows sees committed decisions.)
   */
  private async lockRequestForUpdate(
    manager: EntityManager,
    requestId: string,
  ): Promise<LeaveRequestEntity> {
    const request = await manager.getRepository(LeaveRequestEntity).findOne({
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!request) {
      throw new LeaveDomainNotFoundError(`Unknown leave request: ${requestId}`)
    }
    return request
  }

  /**
   * The approval recipients of many requests at once, keyed by request id.
   *
   * A lookup, not a policy: it answers "who is on these requests", and the
   * caller decides what that means for whoever is reading. Exists so a page of
   * feed rows costs one query instead of one per row.
   */
  async loadApproversForRequests(
    requestIds: string[],
  ): Promise<Map<string, LeaveRequestApproverEntity[]>> {
    const byRequest = new Map<string, LeaveRequestApproverEntity[]>()
    if (requestIds.length === 0) {
      return byRequest
    }

    const rows = await this.manager
      .getRepository(LeaveRequestApproverEntity)
      .find({
        where: { requestId: In(requestIds) },
        order: { createdAt: 'ASC', id: 'ASC' },
      })

    for (const row of rows) {
      const existing = byRequest.get(row.requestId)
      if (existing) {
        existing.push(row)
      } else {
        byRequest.set(row.requestId, [row])
      }
    }

    return byRequest
  }

  private async loadRecipientUsersByEmail(
    manager: EntityManager,
    emails: string[],
  ): Promise<Map<string, { active: boolean; displayName: string }>> {
    const normalized = [
      ...new Set(
        emails
          .map((email) => normalizeEmail(email))
          .filter((email) => email.length > 0),
      ),
    ]
    if (normalized.length === 0) {
      return new Map()
    }
    const users = await manager.getRepository(UserEntity).find({
      where: { normalizedEmail: In(normalized) },
      select: { normalizedEmail: true, active: true, displayName: true },
    })
    return new Map(
      users.map((user) => [
        user.normalizedEmail,
        { active: user.active, displayName: user.displayName },
      ]),
    )
  }

  private async loadApprovers(
    manager: EntityManager,
    requestId: string,
  ): Promise<LeaveRequestApproverEntity[]> {
    return manager
      .getRepository(LeaveRequestApproverEntity)
      .find({ where: { requestId }, order: { createdAt: 'ASC', id: 'ASC' } })
  }

  /**
   * Resolve the 'to' approvers of a request to app users, on the CALLER'S
   * manager so the lookup sees the in-flight transaction.
   *
   * An address with no user simply yields nothing. That is ordinary, not
   * exceptional: approver rows are email-keyed and submit folds in
   * settings.defaultApproverEmails without ever validating them against users.
   * requireUser would throw and roll back the whole mutation (hold, request,
   * approvers, audit); findUserByEmail reads through the root manager and would
   * miss this transaction entirely. Notifications must never be able to fail a
   * leave decision.
   */
  private async resolveToApproverUserIds(
    manager: EntityManager,
    approvers: LeaveRequestApproverEntity[],
  ): Promise<string[]> {
    const emails = approvers
      .filter((approver) => approver.kind === ApproverKind.To)
      .map((approver) => normalizeEmail(approver.email))
    if (emails.length === 0) {
      return []
    }
    const users = await manager
      .getRepository(UserEntity)
      .find({ where: { normalizedEmail: In(emails) }, select: { id: true } })
    return users.map((user) => user.id)
  }

  // Resolve display names for a set of user ids in one query (used where names
  // are joined from users rather than snapshotted).
  private async resolveUserNames(
    manager: EntityManager,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)]
    const names = new Map<string, string>()
    if (unique.length === 0) {
      return names
    }
    const users = await manager
      .getRepository(UserEntity)
      .find({ where: { id: In(unique) } })
    for (const user of users) {
      names.set(user.id, user.displayName)
    }
    return names
  }

  private async getUserRequests(
    manager: EntityManager,
    userId: string,
  ): Promise<LeaveRequestEntity[]> {
    await this.requireUser(manager, userId)
    return manager.getRepository(LeaveRequestEntity).find({
      where: { requesterUserId: userId },
      // requestId tiebreaker keeps ordering deterministic when two requests
      // share a submittedAt.
      order: { submittedAt: 'ASC', id: 'ASC' },
    })
  }

  // Every pending or approved request whose period intersects the queried range
  // for the same user (any leave type): you cannot be on two leaves at once.
  // `excludeRequestIds` skips a request the caller is about to replace — a
  // modification would otherwise always collide with the leave it modifies.
  private async findOverlappingRequests(
    manager: EntityManager,
    userId: string,
    startDate: string,
    endDate: string,
    excludeRequestIds: string[] = [],
  ): Promise<LeaveAvailabilityOverlappingRequestDto[]> {
    const requests = await manager.getRepository(LeaveRequestEntity).findBy({
      requesterUserId: userId,
    })
    return requests
      .filter(
        (request) =>
          (request.status === LeaveRequestStatus.Pending ||
            request.status === LeaveRequestStatus.Approved) &&
          !excludeRequestIds.includes(request.id) &&
          request.startDate <= endDate &&
          startDate <= request.endDate,
      )
      .map((request) => ({
        startDate: request.startDate,
        endDate: request.endDate,
        status: request.status,
      }))
  }

  // Maintains the request's denormalized (lastAction, lastActivityAt) snapshot
  // — every timeline event MUST go through here so the admin feed stays in
  // sync with the per-request history. (The only other writer is the seed in
  // submitLeaveRequest's insert, which this immediately re-asserts.)
  private async addActivity(
    manager: EntityManager,
    input: {
      requestId: string
      actorUserId?: string
      // Only for system-generated events (no actor user); the actor's name is
      // otherwise joined from users at read time.
      systemActorLabel?: string
      action: string
      occurredAt: string
      comment?: string
    },
  ): Promise<void> {
    const repo = manager.getRepository(LeaveRequestActivityEntity)
    await repo.save(
      repo.create({
        id: randomUUID(),
        requestId: input.requestId,
        actorUserId: input.actorUserId ?? null,
        systemActorLabel: input.systemActorLabel ?? null,
        action: input.action,
        occurredAt: input.occurredAt,
        comment: input.comment ?? null,
      }),
    )
    // System events (no human actor, e.g. the lazy daily 'consumed'
    // reconciliation triggered by page views) stay on the timeline but do NOT
    // touch the snapshot: the admin feed reorders and relabels only on human
    // actions, so a request doesn't bubble up with 'Consumed' replacing the
    // decision just because an employee opened their dashboard.
    if (!input.actorUserId) {
      return
    }
    // Conditional so a backdated event never regresses the snapshot below the
    // newest occurredAt.
    await manager
      .getRepository(LeaveRequestEntity)
      .createQueryBuilder()
      .update()
      .set({ lastAction: input.action, lastActivityAt: input.occurredAt })
      .where('id = :requestId AND "lastActivityAt" <= :occurredAt', {
        requestId: input.requestId,
        occurredAt: input.occurredAt,
      })
      .execute()
  }


  private async buildRequestDetail(
    manager: EntityManager,
    request: LeaveRequestEntity,
    // The org's workday, when the caller already holds it. The two callers that
    // build a WHOLE history in a loop pass it so the settings row is read once
    // per response rather than once per request; everyone else omits it and
    // this reads it itself.
    hoursPerDay?: number,
  ): Promise<LeaveRequestDetailDto> {
    const approvers = await manager
      .getRepository(LeaveRequestApproverEntity)
      .find({ where: { requestId: request.id }, order: { createdAt: 'ASC', id: 'ASC' } })
    const activity = await manager
      .getRepository(LeaveRequestActivityEntity)
      .find({ where: { requestId: request.id }, order: { createdAt: 'ASC', id: 'ASC' } })
    const balanceTimeline = await this.getBalanceTimelineTx(
      manager,
      request.requesterUserId,
      request.leaveType,
    )
    // Names are joined from users, not snapshotted. Resolve the requester plus
    // every activity actor in one lookup.
    const requester = await this.requireUser(manager, request.requesterUserId)
    const actorNames = await this.resolveUserNames(
      manager,
      activity
        .map((entry) => entry.actorUserId)
        .filter((id): id is string => id !== null),
    )
    actorNames.set(requester.id, requester.displayName)

    // Approver rows carry a name of their own only once their owner decides, so
    // an undecided approver would otherwise be rendered from their address
    // alone. Join the user records by email to name them.
    //
    // The two names have different provenance: a decided row holds the name its
    // author's session was signed in with, this map holds the account's current
    // one, and a rename between the two moves only the latter. That is
    // deliberately not reconciled — the point is that every approver is named,
    // not that the two sources are made identical. Deactivated accounts are
    // named too: the row states whose decision is awaited, which stays true
    // after they leave.
    const approverNames = await this.loadRecipientUsersByEmail(
      manager,
      approvers.map((approver) => approver.email),
    )

    // Both ends of a modification pair are embedded here rather than left for
    // the client to fetch: an approver of a replacement is not necessarily an
    // approver of the original, so fetching it directly would be forbidden and
    // the before/after view could not be rendered at all.
    const replacement = await this.findReplacementFor(manager, request.id)
    const original = request.supersedesRequestId
      ? await manager
          .getRepository(LeaveRequestEntity)
          .findOneBy({ id: request.supersedesRequestId })
      : null

    return {
      ...requestSummary(request),
      ...(replacement
        ? {
            supersededByRequestId: replacement.id,
            supersededBy: requestSummary(replacement),
            modificationPending:
              replacement.status === LeaveRequestStatus.Pending,
          }
        : {}),
      ...(original ? { supersedes: requestSummary(original) } : {}),
      requesterUserId: request.requesterUserId,
      requesterDisplayName: requester.displayName,
      approvers: approvers.map((approver) => approverToDto(approver, approverNames)),
      activity: activity.map((entry) => activityToDto(entry, actorNames)),
      balanceTimeline,
      unpaidDates: request.unpaidLeaveDays,
      // The divisor travels with the request: every surface that renders this
      // DTO (the approval review page an emailed link lands on, the request
      // detail, the history) is reachable without any other response that
      // knows the org's workday.
      hoursPerDay: hoursPerDay ?? (await this.getWorkdayHoursTx(manager)),
      decisionComment: request.decisionComment ?? undefined,
      decidedAt: request.decidedAt ?? undefined,
    }
  }

  /**
   * The replacement pointing at this request, if any. A rejected or cancelled
   * replacement is ignored (the original was never affected by it), while a
   * Superseded one is still reported so a chain of successive modifications
   * keeps its trail: the newest live replacement wins.
   */
  private async findReplacementFor(
    manager: EntityManager,
    requestId: string,
  ): Promise<LeaveRequestEntity | null> {
    const candidates = await manager.getRepository(LeaveRequestEntity).find({
      where: {
        supersedesRequestId: requestId,
        status: In([
          LeaveRequestStatus.Pending,
          LeaveRequestStatus.Approved,
          LeaveRequestStatus.Superseded,
        ]),
      },
      order: { submittedAt: 'DESC', id: 'DESC' },
    })
    return candidates[0] ?? null
  }

}

// -------------------------------------------------------------- mappers ------

// The roles tooling provisioning (admin/test upsertUser) seeds for a new
// user, and the set assignUserRolesTx skips auditing as a bare provision
// grant — the two must never drift apart. Neither the identity path nor the
// directory sync uses the seed: a login mirrors its token literally (see
// identityRolesMirror), the sync mirrors each record's group-derived
// roleNames, and both refuse/skip rather than invent a role.
const BASELINE_ROLES: readonly AppRoleName[] = [AppRoleName.Employee]

// The user_roles rows a login should leave behind: exactly the known roles
// the token carried, mirrored literally — being able to authenticate implies
// no role (Keycloak admits the whole staff directory; app access is the
// leaverequest-app groups, which this claim reflects). Token roles are
// filtered against the AppRoleName enum — roleName is a PG enum column, so
// an unexpected value from the IdP must be dropped here rather than fail
// the login.
function identityRolesMirror(
  roles: AppRoleName[] | undefined,
): AppRoleName[] {
  const known = new Set<string>(Object.values(AppRoleName))
  return Array.from(
    new Set((roles ?? []).filter((role) => known.has(role))),
  )
}

function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}

function userToRecord(user: UserEntity): LeaveDomainUserRecord {
  return {
    userId: user.id,
    subject: orUndefined(user.subject),
    email: user.email,
    normalizedEmail: user.normalizedEmail,
    displayName: user.displayName,
    countryCode: orUndefined(user.countryCode),
    holidayCalendarCountryCode: orUndefined(user.holidayCalendarCountryCode),
    employmentStartDate: orUndefined(user.employmentStartDate),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

// ---- audit snapshots (domain-meaningful fields only, for before/after) ----

/**
 * The one definition of "did this audited state change". Relies on snapshots
 * being built by the snapshot* functions below with a fixed key order and no
 * undefined values (JSON.stringify drops undefined keys and is order-
 * sensitive) — which is exactly why every comparison must go through here
 * instead of hand-rolling the stringify pair.
 */
function snapshotsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * True for a Postgres unique-violation (23505) on any `users` unique index
 * (uq_users_normalized_email / uq_users_subject). TypeORM wraps the driver
 * error, so the pg fields may sit on `driverError`; both shapes are checked.
 */
function isUsersUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const driverError =
    (error as { driverError?: unknown }).driverError ?? error
  const code = (driverError as { code?: unknown }).code
  const constraint = (driverError as { constraint?: unknown }).constraint
  return (
    code === '23505' &&
    typeof constraint === 'string' &&
    constraint.startsWith('uq_users')
  )
}

/**
 * True for a Postgres foreign-key violation (23503). Same wrapping caveat as
 * isUsersUniqueViolation: the pg fields may sit on `driverError`.
 */
function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const driverError =
    (error as { driverError?: unknown }).driverError ?? error
  return (driverError as { code?: unknown }).code === '23503'
}

/**
 * Full-row snapshot. Since the ownership refactor this feeds ONLY the
 * `user.provisioned` audit's `after` — a new row's whole initial state, which
 * legitimately shows every column. Update, deactivation and admin-edit paths
 * snapshot just the columns they own (snapshotOwned / inline `active` flip), so
 * an unlocked read of a column they don't write can't skew their audit diff.
 */
function snapshotUser(user: UserEntity): Record<string, unknown> {
  return {
    displayName: user.displayName,
    email: user.email,
    subject: user.subject,
    active: user.active,
    countryCode: user.countryCode,
    employmentStartDate: user.employmentStartDate,
  }
}

/**
 * The `users` columns a single write source is the authority for. Each
 * of upsertUserTx's sources patches ONLY these, so a stale snapshot can never
 * clobber a column another actor owns. `active` is absent by design
 * — they belong to the deactivation and admin-edit paths.
 */
type OwnedUserColumn =
  | 'subject'
  | 'email'
  | 'displayName'
  | 'countryCode'
  | 'employmentStartDate'

/**
 * before/after snapshot narrowed to exactly the columns a writer owns, so a
 * concurrent change to a NON-owned column (read without a lock) never shows up
 * in that writer's audit diff. Fixed key order (the `columns` array) keeps
 * snapshotsEqual/diffSnapshots stable, same contract as snapshotUser.
 */
function snapshotOwned(
  source: Record<OwnedUserColumn, string | null>,
  columns: readonly OwnedUserColumn[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const column of columns) {
    snapshot[column] = source[column]
  }
  return snapshot
}

function snapshotSettings(settings: {
  defaultVacationDays: number
  defaultSickDays: number
  approvalRequired: boolean
  defaultApproverEmails: string[]
  defaultCcApproverEmails: string[]
  carryoverPolicy: CarryoverPolicy
  carryoverCapDays: number
  carryoverCapMode: CarryoverCapMode
  carryoverCapPercent: number
  defaultTimezone: string
  hoursPerDay: number
}): Record<string, unknown> {
  return {
    defaultVacationDays: settings.defaultVacationDays,
    defaultSickDays: settings.defaultSickDays,
    // Switching approvals off changes what happens to every future request:
    // the audit trail has to name the admin who did it.
    approvalRequired: settings.approvalRequired,
    defaultApproverEmails: settings.defaultApproverEmails,
    defaultCcApproverEmails: settings.defaultCcApproverEmails,
    carryoverPolicy: settings.carryoverPolicy,
    carryoverCapDays: settings.carryoverCapDays,
    carryoverCapMode: settings.carryoverCapMode,
    carryoverCapPercent: settings.carryoverCapPercent,
    // The org default zone decides which calendar day a leave day is spent on
    // and which month accrues. It was missing here, so changing it produced an
    // audit row whose before and after matched.
    defaultTimezone: settings.defaultTimezone,
    // The divisor every hour-grained booking is measured against: changing it
    // re-prices what an hour of leave is worth, so the trail names who did it.
    hoursPerDay: settings.hoursPerDay,
  }
}

function snapshotCalendar(calendar: HolidayCalendarDto): Record<string, unknown> {
  return {
    countryCode: calendar.country.code,
    year: calendar.year,
    name: calendar.name,
    holidays: calendar.holidays.map((holiday) => ({
      date: holiday.date,
      name: holiday.name,
    })),
  }
}

function snapshotRequest(request: LeaveRequestEntity): Record<string, unknown> {
  return {
    status: request.status,
    leaveType: request.leaveType,
    startDate: request.startDate,
    endDate: request.endDate,
    requestedDays: request.requestedDays,
    // A change that re-funds the same dates differently is a change worth
    // seeing in the audit diff, so the unpaid days travel with the snapshot.
    // The portions travel for the same reason and are not implied by the two
    // figures above: moving hours between the same dates leaves both the dates
    // and the total untouched, and without this the diff would be empty.
    unpaidLeaveDays: request.unpaidLeaveDays,
    dayPortions: request.dayPortions,
    decidedAt: request.decidedAt,
    decisionComment: request.decisionComment,
  }
}

function balanceToDto(
  balance: LeaveBalanceEntity,
  totalDays: number,
): LeaveBalanceDto {
  return {
    leaveType: balance.leaveType,
    totalDays,
    // Display available nets only spent; reserved days are surfaced separately
    // as onHoldDays. The bookable figure (accrued - onHold - spent) is internal.
    availableDays: roundDays(balance.accruedDays - balance.spentDays),
    onHoldDays: balance.onHoldDays,
    spentDays: balance.spentDays,
    accruedDays: balance.accruedDays,
    updatedAt: balance.updatedAt,
  }
}

function ledgerToChangeDto(
  entry: LeaveBalanceChangeEntity,
): LeaveBalanceChangeDto {
  return {
    effectiveDate: entry.effectiveDate,
    leaveType: entry.leaveType,
    deltaDays: entry.deltaDays,
    availableDays: roundDays(entry.accruedDays - entry.spentDays),
    onHoldDays: entry.onHoldDays,
    spentDays: entry.spentDays,
    reason: entry.reason,
    note: orUndefined(entry.note),
  }
}

function activityToDto(
  entry: LeaveRequestActivityEntity,
  names: Map<string, string>,
): LeaveRequestActivityDto {
  // Real-actor name is joined from users; system events carry systemActorLabel.
  const actorName = entry.actorUserId
    ? names.get(entry.actorUserId)
    : entry.systemActorLabel
  return {
    actorUserId: orUndefined(entry.actorUserId),
    actorDisplayName: actorName ?? '',
    action: entry.action,
    occurredAt: entry.occurredAt,
    comment: orUndefined(entry.comment),
  }
}

// Every place a person's name is stored falls back to their address when none
// was known, so both name sources below can hold one. An address is not a name
// to render: it makes a row repeat its own email and reduces to initials that
// spell a domain. Anything address-shaped therefore counts as no name at all.
function nameOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && !isValidEmail(trimmed) ? trimmed : undefined
}

function approverToDto(
  entry: LeaveRequestApproverEntity,
  // Current names of the approvers' user records, keyed by normalized email.
  liveNames: ReadonlyMap<string, { displayName: string }>,
): LeaveRequestApprovalRecipientDto {
  // The row's own name comes first: a decided row keeps the name its owner was
  // signed in as, not whatever they are called now. An undecided row has none,
  // and takes the account's current name.
  const displayName =
    nameOrUndefined(entry.displayName) ??
    nameOrUndefined(liveNames.get(normalizeEmail(entry.email))?.displayName)
  return {
    email: entry.email,
    kind: entry.kind,
    displayName,
    decision: entry.decision,
    decidedAt: orUndefined(entry.decidedAt),
  }
}

function requestSummary(
  request: LeaveRequestEntity,
): LeaveRequestSummaryDto {
  const dayPortions = partialDayPortions(request)
  return {
    requestId: request.id,
    leaveType: request.leaveType,
    status: request.status,
    startDate: request.startDate,
    endDate: request.endDate,
    requestedDays: request.requestedDays,
    paidDays: paidDaysOf(request),
    unpaidDays: unpaidDaysOf(request),
    // What the request still holds; the rest of its paid days have been spent
    // on the leave dates that have passed.
    heldDays: roundDays(Math.max(0, request.remainingHeldDays)),
    submittedAt: request.submittedAt,
    comment: request.comment ?? undefined,
    // Absent for an ordinary whole-day request, which is what an empty stored
    // column means. On the summary so that the counterparts a modification
    // embeds carry the shape the approver is being asked to compare.
    ...(dayPortions !== undefined ? { dayPortions } : {}),
    ...(request.supersedesRequestId
      ? { supersedesRequestId: request.supersedesRequestId }
      : {}),
  }
}

// Paid days are whatever is left once the unpaid ones are taken out — derived
// rather than stored, so the two figures cannot drift apart. Both sides are
// amounts: an unpaid date carries its own portion, so a half day taken unpaid
// costs the request half a day of unpaid leave.
function paidDaysOf(request: LeaveRequestEntity): number {
  return roundDays(request.requestedDays - unpaidDaysOf(request))
}

// What a request's unpaid dates cost. A date is funded whole, paid or unpaid,
// so pricing the unpaid set is enough to know both halves.
function unpaidDaysOf(
  request: Pick<
    LeaveRequestEntity,
    'leaveDays' | 'dayPortions' | 'unpaidLeaveDays'
  >,
): number {
  return sumPortions(
    request.unpaidLeaveDays,
    portionMap(request.leaveDays, request.dayPortions),
  )
}

// The part-day shape of a request for the wire: only the dates that are not
// whole, and undefined when there are none, so an ordinary request carries no
// such field at all. Read through portionMap rather than off the column, so the
// empty-array idiom is decoded in the one place that owns it. What travels is
// the frozen portion; hoursPerDay is the reader's divisor, not this mapper's.
function partialDayPortions(
  request: Pick<LeaveRequestEntity, 'leaveDays' | 'dayPortions'>,
): Record<string, number> | undefined {
  const partial: Record<string, number> = {}
  for (const [day, portion] of portionMap(
    request.leaveDays,
    request.dayPortions,
  )) {
    if (portion < 1) {
      partial[day] = portion
    }
  }
  return Object.keys(partial).length > 0 ? partial : undefined
}


// ---------------------------------------------------------- pure helpers -----

// roundDays lives in ./day-math — the books' own quantum, three decimals, so an
// hour of leave (0.125 days) survives it. Policy terms are the exception: they
// round with roundPolicyTerm (./policy-fingerprint) because their fingerprint is
// their identity and it quantizes to two.

// The SINGLE definition of profile readiness: whether the employee's card
// holds every profile input leave needs AND employment has begun as of the
// calendar day `asOfDay`. Every consumer — the dashboard status the UI renders
// (full-page pending/not-started states) and the submission/allocation guards —
// derives from this one function, so extending the rule is a change in one
// place.
//
// A day in the EMPLOYEE's timezone, not a UTC instant: a start date is a
// wall-clock date, and slicing one off a UTC instant would leave a new hire
// "not started yet" for the first hours of the very day they start.
//
// Required profile fields: the employment start date (the accrual anchor) and
// the country (selects the holiday calendar that decides which requested days
// are paid). Accrual itself only needs the start date and is gated separately
// in accrualScheduleForYear, so a country-less employee still accrues in the
// background — the country only gates whether leave can be requested/used.
function employeeProfileStatus(
  user: UserEntity,
  asOfDay: string,
): EmployeeProfileStatus {
  if (!user.employmentStartDate || !user.countryCode) {
    return EmployeeProfileStatus.PendingSetup
  }
  // 'YYYY-MM-DD' strings compare lexicographically; a start date after the
  // as-of calendar day means employment has not begun yet.
  return user.employmentStartDate > asOfDay
    ? EmployeeProfileStatus.NotStartedYet
    : EmployeeProfileStatus.Ready
}

// The directory's profile filter as SQL. One presence test per value and no
// bound parameters at all: the whole point of filtering on the raw columns is
// that none of these predicates needs a calendar day, so a listing can page
// across midnight without pinning one.
//
// A blank countryCode is matched as NULL only: the column is a FK to
// countries.code, so an empty code would need a country whose primary key is
// the empty string.
function profileFilterWhere(
  alias: string,
  filter: EmployeeProfileFilter,
): string {
  const startDate = `${alias}."employmentStartDate"`
  const country = `${alias}."countryCode"`

  switch (filter) {
    case EmployeeProfileFilter.MissingAny:
      return `(${startDate} IS NULL OR ${country} IS NULL)`
    case EmployeeProfileFilter.MissingStartDate:
      return `${startDate} IS NULL`
    case EmployeeProfileFilter.MissingCountry:
      return `${country} IS NULL`
    case EmployeeProfileFilter.Complete:
      return `(${startDate} IS NOT NULL AND ${country} IS NOT NULL)`
  }
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)
  if (
    !ISO_DATE_PATTERN.test(startDate) ||
    !ISO_DATE_PATTERN.test(endDate) ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    throw new LeaveDomainValidationError(
      'Invalid ISO date value supplied to leave domain.',
    )
  }
  if (start > end) {
    throw new LeaveDomainValidationError(
      'Leave startDate must be on or before endDate.',
    )
  }

  const dates: string[] = []
  const current = new Date(start)
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

// The accrual schedule of one leave `year` as of the CALENDAR DAY `asOfDay`
// ('YYYY-MM-DD' in the employee's own timezone — see localDayIso): which
// calendar month the accruals start in, and how many of them are owed by then.
//
// A day rather than an instant, deliberately. A date string carries no zone, so
// the month and year can be sliced straight out of it; reading them off a UTC
// instant instead would run three hours behind a Kyiv employee's own calendar —
// last month for the first three hours of every 1st, last year on New Year's
// night.
//
// NO anchor means the profile card is not set up yet, so nothing accrues at all
// — the start date is required input for every entitlement computation, never
// guessed (an admin sets it; accrual then re-anchors). A future year accrues
// nothing; otherwise months run from the hire month (1 for anyone employed
// before the year began) through December for a completed year, or the current
// month for the ongoing year. So a mid-year joiner is prorated instead of being
// granted the whole year.
//
// THE HALF-MONTH RULE decides whether the month someone was hired in counts at
// all: it does only if they were employed for at least half of it, floor(days
// in that month / 2) calendar days counted from the start date through the last
// day of the month. Thresholds are 15 days for a 31- or 30-day month and 14 for
// February, leap or not. Someone hired later than that starts accruing on the
// 1st of the NEXT month instead — the standard payroll convention, and the
// reason this returns an EFFECTIVE hire month rather than the anchor's own.
//
// A hire in the second half of December therefore yields hireMonth 13, for
// which the months clamp below returns 0: nothing accrues that year, and the
// employee starts fresh in January. Consumers must gate on `months` and never
// date anything from `hireMonth` without it, or they would ask for month 13.
function accrualScheduleForYear(
  year: number,
  asOfDay: string,
  anchorDate?: string | null,
): { hireMonth: number; months: number } {
  const none = { hireMonth: 1, months: 0 }
  if (!anchorDate || !ISO_DATE_PATTERN.test(asOfDay)) {
    return none // start date not set: entitlements cannot be computed yet
  }
  const asOfYear = getYearFromIsoDate(asOfDay)
  if (year > asOfYear) {
    return none
  }
  const anchorYear = getYearFromIsoDate(anchorDate)
  if (anchorYear > year) {
    return none // not yet employed during this leave year
  }
  const hireMonth =
    anchorYear === year ? effectiveHireMonth(year, anchorDate) : 1
  const endMonth = year < asOfYear ? 12 : Math.min(12, monthOfIsoDate(asOfDay))
  return { hireMonth, months: Math.max(0, endMonth - hireMonth + 1) }
}

// The cumulative accrual target now lives in ./policy-schedule as
// pieceTargetDays (schedule-aware: per-month rate segments; a single-segment
// year computes bit-identically to the old scalar totalDays formula). It is
// still THE only place the target formula lives — the accrual loop, every
// re-anchor, and the forward projection all call it, or the ledger oscillates.
// Carryover is still added ON TOP of the target, and months <= 0 still zeroes
// it including carriedOverDays (the old TODO(carryover) note about a later
// start-date re-anchor wiping carried days moved with the formula).

// How many of `leftover` days survive into the next year under the configured
// policy. Shared by the real year rollover (finalizeCarryoverIfDue), the
// projected carryover a next-year plan is checked against, and the policy
// transfer preflight, so the three can never drift. What floors is the CAP,
// not the result: `percent` floors the share it computes, and percent_of_total
// floors the ceiling before comparing it with the leftover, so nobody has to
// reason about a cap of half a day. A leftover that is already fractional
// (a mid-year hire accrues 25 * 3/12 = 6.25) still carries whole when no cap
// binds it — exactly as it does under `days` and under CarryoverPolicy.Full.
// The flooring holds even at a 100 percent cap: the ceiling stays whole days,
// so a fractional base burns its fraction (the mode for "everything carries"
// is CarryoverPolicy.Full, not percent_of_total at 100). Each floor takes the
// raw share plus an epsilon: the epsilon keeps binary noise from flooring 5.0
// down to 4, while quantizing the share first (as this once did) would round
// 9.9996 up to a tenth day nobody earned.
//
// `capBaseDays` is the denominator the percent_of_total cap is a share OF:
// the closing year's EARNED entitlement — hire-month prorated in the hire
// year, manual adjustments included — as computed by carryoverCapBaseDays
// (./policy-schedule), never the whole annual allowance. A July hire on a
// 25-day policy with a 50 percent cap gets a ceiling of floor(12.5 * 0.5) = 6,
// not the 12 a full-year colleague gets. It is only read by that mode, but it
// is a required parameter and not an optional one on purpose: every call site
// already knows the figure, and a defaulted 0 would silently cap that mode at
// zero days for any caller that forgot it.
function applyCarryoverPolicy(
  leftover: number,
  policy: CarryoverPolicy,
  cap: Pick<
    LeaveSettingsState,
    'carryoverCapMode' | 'carryoverCapDays' | 'carryoverCapPercent'
  >,
  capBaseDays: number,
): number {
  if (policy === CarryoverPolicy.None) {
    return 0
  }
  const kept = Math.max(0, roundDays(leftover))
  if (policy === CarryoverPolicy.Full) {
    return kept
  }
  switch (cap.carryoverCapMode) {
    // Floored straight off the product, never off a quantized copy of it:
    // rounding first would lift a share of 9.9996 to 10 and hand over a whole
    // day nobody earned. The epsilon only absorbs binary dust so a share that
    // is exactly 10 cannot floor to 9.
    case CarryoverCapMode.Percent:
      return Math.floor(
        (kept * cap.carryoverCapPercent) / 100 + BALANCE_EPSILON,
      )
    // A ceiling, not a grant: the share of the earned entitlement is what the
    // carryover may not EXCEED, so an employee who left less than the ceiling
    // unused still carries only what they actually have. Floored BEFORE the
    // min, so the ceiling itself is whole days. The 0 clamp is not decoration:
    // carryoverCapPercent is a plain int column with no range check, and only
    // this branch can push a negative through a min() into a CARRIED balance.
    case CarryoverCapMode.PercentOfTotal: {
      const ceiling = Math.floor(
        (capBaseDays * cap.carryoverCapPercent) / 100 + BALANCE_EPSILON,
      )
      return roundDays(Math.min(kept, Math.max(0, ceiling)))
    }
    default:
      return roundDays(Math.min(kept, cap.carryoverCapDays))
  }
}

// How the cap reads in a ledger note, so an expired-days row says which rule
// burnt them. The two percent modes must not read alike: an employee looking at
// "50% carryover cap" beside 12 burnt days needs to know which 50% it was.
function carryoverCapLabel(
  settings: Pick<
    LeaveSettingsState,
    'carryoverCapMode' | 'carryoverCapDays' | 'carryoverCapPercent'
  >,
): string {
  switch (settings.carryoverCapMode) {
    case CarryoverCapMode.Percent:
      return `${settings.carryoverCapPercent}% carryover cap`
    case CarryoverCapMode.PercentOfTotal:
      return `${settings.carryoverCapPercent}%-of-allowance carryover cap`
    default:
      return `${settings.carryoverCapDays}-day carryover cap`
  }
}

// The policy that actually applies to THIS leave type. Sick leave never
// carries: it is re-granted in full every January, so carrying a leftover on
// top would compound the allowance year over year — its leftover always burns.
// One gate shared by the year close and the projection fold, so the books and
// the forecast can never disagree about what survives the boundary.
function carryoverPolicyFor(
  leaveType: LeaveType,
  settings: Pick<LeaveSettingsState, 'carryoverPolicy'>,
): CarryoverPolicy {
  return leaveType === LeaveType.Sick
    ? CarryoverPolicy.None
    : settings.carryoverPolicy
}

interface ProjectedAccrualInputs {
  leaveType: LeaveType
  year: number
  // Today's calendar day in the EMPLOYEE's timezone, not a UTC instant: the
  // whole projection is day-granular, and the past/future cut below decides
  // whether a day is measured against reality or against the accrual formula.
  nowDay: string
  anchor: string | null
  // The year's rate schedule (single-segment for legacy/no-membership users),
  // resolved by resolveProjectionInputs from the same timeline the accrual
  // loop reads — a December preview and the January materialization are the
  // same pure function of it.
  schedule: PolicyYearSchedule
  // Materialized for a finalized year, projected for a year not yet begun.
  carriedOverDays: number
  // Sticky admin correction for this leave year (vacation); 0 for sick and for
  // future years that have not inherited one from a prior open year.
  manualAdjustmentDays: number
  // The year's actual accrued days as of now (0 when no balance row exists).
  currentAccruedDays: number
}

// The days that will have accrued by `dayIso` — the yardstick forward planning
// is measured against.
//
// A day that has already happened is measured against REALITY (the balance's
// accrued figure), never against a recomputed historical target: that keeps
// backdated requests exactly as permissive as the old bookable check and lets
// an admin adjustment stand. A future day adds only the increments still
// scheduled between now and then, so the projection is anchored to what the
// employee actually has rather than to a formula that ignores adjustments.
function projectedAccruedAtDay(
  inputs: ProjectedAccrualInputs,
  dayIso: string,
): number {
  if (dayIso <= inputs.nowDay) {
    return roundDays(inputs.currentAccruedDays)
  }
  const targetAt = (at: string): number => {
    const { hireMonth, months } = accrualScheduleForYear(
      inputs.year,
      at,
      inputs.anchor,
    )
    return pieceTargetDays(
      inputs.leaveType,
      inputs.schedule,
      inputs.carriedOverDays,
      hireMonth,
      months,
      inputs.manualAdjustmentDays,
    )
  }
  const scheduledIncrease = Math.max(
    0,
    roundDays(targetAt(dayIso) - targetAt(inputs.nowDay)),
  )
  return roundDays(inputs.currentAccruedDays + scheduledIncrease)
}

export interface CommitmentViolation {
  day: string
  committedByThen: number
  projectedByThen: number
}

// Month-by-month view of one leave year: what will have accrued by the end of
// each month against what stands committed by then. Months before the first
// committed day carry no information for the composer, so the strip starts at
// the earliest of the current month and the first commitment.
function buildMonthlyOutlook(
  projection: YearProjection,
): LeaveMonthOutlookDto[] {
  const outlook: LeaveMonthOutlookDto[] = []
  for (let month = 1; month <= 12; month++) {
    const lastDay = lastDayOfMonthIso(projection.year, month)
    const projectedAccruedDays = projection.projectedAt(lastDay)
    const committedDays = roundDays(
      projection.spentDays +
        committedCost(
          projection.committedEntries.filter((entry) => entry.day <= lastDay),
        ),
    )
    outlook.push({
      year: projection.year,
      month,
      projectedAccruedDays,
      committedDays,
      remainingDays: roundDays(projectedAccruedDays - committedDays),
    })
  }
  return outlook
}

function lastDayOfMonthIso(year: number, month: number): string {
  const day = daysInMonth(year, month)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// The day a month's accrual belongs to: its 1st.
function firstOfMonthIso(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

// The one sentence the composer shows about a split, written from the
// employee's side of it. Deliberately not describeViolation: the day that
// constrained the split may belong to a different request months away, which
// says nothing useful about the period being planned. The exact unpaid days
// travel separately, in unpaidDates.
function describeUnpaidDays(
  leaveType: LeaveType,
  requestedDays: number,
  paidDays: number,
  hoursPerDay: number,
): string {
  const source =
    leaveType === LeaveType.Sick ? 'sick allowance' : 'projected balance'
  const split =
    paidDays <= 0
      ? `Your ${source} does not cover any of these ` +
        `${formatDayAmount(requestedDays, hoursPerDay)}, so the whole request would be unpaid.`
      : `Your ${source} covers ${formatDayAmount(paidDays, hoursPerDay)} of these ` +
        `${formatDayAmount(requestedDays, hoursPerDay)}; the other ` +
        `${formatDayAmount(roundDays(requestedDays - paidDays), hoursPerDay)} would be unpaid.`
  // LRS-53 cases 4–5: a date is funded whole or not at all. When the split
  // involves hours, say so — otherwise shortening a different day looks like
  // the unpaid figure jumping from 1h to 1d for no reason.
  if (
    amountHasHours(requestedDays, hoursPerDay) ||
    amountHasHours(paidDays, hoursPerDay) ||
    amountHasHours(roundDays(requestedDays - paidDays), hoursPerDay)
  ) {
    return (
      `${split} Each working day is paid in full or unpaid in full, ` +
      `so leftover hours cannot cover part of a longer day.`
    )
  }
  return split
}

function amountHasHours(value: number, hoursPerDay: number): boolean {
  const hours = dayPortionToHours(
    floorToHourGrid(Math.abs(value), hoursPerDay),
    hoursPerDay,
  )
  return hours % hoursPerDay !== 0
}

// The one sentence every projection failure is explained with: which day broke,
// how many days would stand committed by then, and how many will have accrued.
function describeViolation(
  violation: CommitmentViolation,
  hoursPerDay: number,
): string {
  return (
    `By ${violation.day} you would have committed ` +
    `${formatDayAmount(violation.committedByThen, hoursPerDay)} but only ` +
    `${formatDayAmount(violation.projectedByThen, hoursPerDay)} will have accrued by then.`
  )
}

function formatIsoDateRange(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate} to ${endDate}`
}

function formatLeaveRequestStatusLabel(status: LeaveRequestStatus): string {
  switch (status) {
    case LeaveRequestStatus.Approved:
      return 'Approved'
    case LeaveRequestStatus.Pending:
      return 'Pending'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1)
  }
}

function overlappingRequestPreviewMessage(count: number): string {
  return count === 1
    ? 'This period overlaps an existing leave request:'
    : 'This period overlaps existing leave requests:'
}

function formatOverlappingRequestDetail(
  request: LeaveAvailabilityOverlappingRequestDto,
): string {
  return `${formatIsoDateRange(request.startDate, request.endDate)} (${formatLeaveRequestStatusLabel(request.status)})`
}

function formatOverlappingRequestError(
  overlappingRequests: LeaveAvailabilityOverlappingRequestDto[],
): string {
  if (overlappingRequests.length === 1) {
    return `Leave request overlaps an existing request: ${formatOverlappingRequestDetail(overlappingRequests[0]!)}.`
  }
  return (
    'Leave request overlaps existing requests:\n' +
    overlappingRequests
      .map((request) => `• ${formatOverlappingRequestDetail(request)}`)
      .join('\n')
  )
}

// What cancelling an approved leave gives back. Only the held days return, so
// a partly unpaid leave must not be announced as if all of it did — and a
// fully unpaid one gives nothing back at all.
function describeReleasedDays(
  request: LeaveRequestEntity,
  hoursPerDay: number,
): string {
  const paidDays = paidDaysOf(request)
  if (paidDays <= 0) {
    return 'no days were held from their balance'
  }
  if (request.unpaidLeaveDays.length === 0) {
    return 'the days went back to their balance'
  }
  return `the ${formatDayAmount(paidDays, hoursPerDay)} that was held went back to their balance`
}

// A request's size for audit and activity copy.
function describeDaySplit(
  requestedDays: number,
  unpaidDays: number,
  hoursPerDay: number,
): string {
  const total = formatDayAmount(requestedDays, hoursPerDay)
  if (unpaidDays <= 0) {
    return total
  }
  return (
    `${total}, ${formatDayAmount(roundDays(requestedDays - unpaidDays), hoursPerDay)} paid, ` +
    `${formatDayAmount(unpaidDays, hoursPerDay)} unpaid`
  )
}

// The worst case a leave and its pending replacement can cost together, as a
// day list: at every date, the higher of the two running counts. One of the
// pair will survive the approval and the other will release its days, but
// which one is not known yet, so the envelope of both is what gets charged.
// Taking the longer list instead would understate the cost whenever the
// shorter one sits earlier in the year and binds there.
function pointwiseMaxSchedule(
  left: CommittedDay[],
  right: CommittedDay[],
): CommittedDay[] {
  const dates = [
    ...new Set([...left, ...right].map((entry) => entry.day)),
  ].sort()
  const costThrough = (entries: CommittedDay[], day: string): number =>
    committedCost(entries.filter((entry) => entry.day <= day))
  // One synthetic entry per date, carrying whatever the envelope still owes by
  // then. Its portion is a cumulative DIFFERENCE, not a date's own cost, so it
  // may exceed a whole day and may sit off the hour grid: this is an envelope,
  // not a request.
  const merged: CommittedDay[] = []
  let emitted = 0
  for (const date of dates) {
    const target = Math.max(costThrough(left, date), costThrough(right, date))
    const owed = roundDays(target - emitted)
    if (owed > 0) {
      merged.push({ day: date, portion: owed })
      emitted = target
    }
  }
  return merged
}

// Walk the committed leave days in date order and find the first one the
// projection cannot cover. Cumulative by construction: the running total is
// what a day is measured against, not any single request's own count.
//
// Committed days here are PAID days only. Days a request could not fund were
// marked unpaid when it was submitted and charge nothing, so a later request
// can be funded past a day an earlier one is taking unpaid.
//
// `baseSpentDays` seeds the running total because already-spent days are no
// longer in any request's day list.
function firstInfeasibleCommittedDay(
  committedEntries: CommittedDay[],
  baseSpentDays: number,
  projectedAt: (dayIso: string) => number,
): CommitmentViolation | null {
  let running = roundDays(baseSpentDays)
  for (const entry of committedEntries) {
    running = roundDays(running + entry.portion)
    const projected = projectedAt(entry.day)
    // Both sides are quantized day figures, so compare with a tolerance rather
    // than letting 16.667 reject a 16.667-day plan.
    if (running > projected + BALANCE_EPSILON) {
      return {
        day: entry.day,
        committedByThen: running,
        projectedByThen: projected,
      }
    }
  }
  return null
}

type RecipientUserLookup = {
  active: boolean
  displayName: string
}

function isInactiveKnownUser(
  email: string,
  knownUsers: Map<string, RecipientUserLookup>,
): boolean {
  const match = knownUsers.get(normalizeEmail(email))
  return match !== undefined && !match.active
}

function assertExplicitRecipientsAreActive(
  emails: string[] | undefined,
  role: 'approver' | 'CC recipient',
  knownUsers: Map<string, RecipientUserLookup>,
): void {
  for (const email of emails ?? []) {
    const match = knownUsers.get(normalizeEmail(email))
    if (match && !match.active) {
      const article = role === 'approver' ? 'an' : 'a'
      throw new LeaveDomainValidationError(
        `You cannot add ${match.displayName} as ${article} ${role}: this account is inactive.`,
      )
    }
  }
}

function toRecipients(
  approverEmails: string[],
  ccEmails: string[],
): LeaveRequestApprovalRecipientDto[] {
  // Normalize, drop blanks, and dedupe. A "to" approver always wins over a "cc"
  // entry for the same address so a recipient never appears twice.
  const recipients = new Map<string, LeaveRequestApprovalRecipientDto>()
  for (const email of approverEmails) {
    const normalized = normalizeEmail(email)
    if (normalized) {
      recipients.set(normalized, { email: normalized, kind: ApproverKind.To })
    }
  }
  for (const email of ccEmails) {
    const normalized = normalizeEmail(email)
    if (normalized && !recipients.has(normalized)) {
      recipients.set(normalized, { email: normalized, kind: ApproverKind.Cc })
    }
  }
  return Array.from(recipients.values())
}

// Reader-facing leave-type wording for notification summaries, which are
// snapshotted as whole sentences rather than re-rendered from the enum later.
function formatLeaveTypeLabel(leaveType: LeaveType): string {
  return leaveType === LeaveType.Sick ? 'sick leave' : 'vacation'
}

// English possessive for a display name inside a resolution sentence:
// "David Brooks' vacation request" but "Alina Garbich's vacation request".
// "A", "A and B", or "A, B and 2 others" — the final-approval sentence names
// the people who signed off, in the order they voted.
function listApproverNames(names: string[]): string {
  if (names.length <= 2) {
    return names.join(' and ')
  }
  const more = names.length - 2
  return `${names[0]}, ${names[1]} and ${more} ${more === 1 ? 'other' : 'others'}`
}

function possessive(name: string): string {
  // Case-insensitive on purpose: directory-sourced display names arrive in
  // whatever case the directory holds ("DAVID BROOKS"), and the apostrophe
  // rule follows the sound, not the letter's case.
  return /s$/i.test(name) ? `${name}'` : `${name}'s`
}

function getYearFromIsoDate(date: string): number {
  return Number.parseInt(date.slice(0, 4), 10)
}

// Every calendar year an inclusive date range touches, ascending. The unit a
// cross-year request is funded in: each of its days draws on the balance of
// the year it falls in, so most per-request bookkeeping loops over this.
function yearsSpanned(startDate: string, endDate: string): number[] {
  const years: number[] = []
  for (
    let year = getYearFromIsoDate(startDate);
    year <= getYearFromIsoDate(endDate);
    year += 1
  ) {
    years.push(year)
  }
  return years
}

// What a list of committed dates costs: their portions summed, quantized once.
// The figure that used to be the list's length, and the one thing a caller may
// never go back to reading off it.
function committedCost(entries: readonly CommittedDay[]): number {
  return roundDays(
    entries.reduce((total, entry) => total + entry.portion, 0),
  )
}

// Ascending entries in, per-year ascending buckets out. The entry twin of
// bucketDaysByYear, for the lists that carry a cost with each date.
function bucketCommittedByYear(
  entries: CommittedDay[],
): Map<number, CommittedDay[]> {
  const buckets = new Map<number, CommittedDay[]>()
  for (const entry of entries) {
    const year = getYearFromIsoDate(entry.day)
    const bucket = buckets.get(year)
    if (bucket) {
      bucket.push(entry)
    } else {
      buckets.set(year, [entry])
    }
  }
  return buckets
}

// Ascending days in, per-year ascending buckets out.
function bucketDaysByYear(days: string[]): Map<number, string[]> {
  const buckets = new Map<number, string[]>()
  for (const day of days) {
    const year = getYearFromIsoDate(day)
    const bucket = buckets.get(year)
    if (bucket) {
      bucket.push(day)
    } else {
      buckets.set(year, [day])
    }
  }
  return buckets
}

// The request's not-yet-consumed PAID days, each with what it costs, bucketed
// by the year it falls in. This is the single home of the invariant every
// per-year movement rides on: remainingHeldDays always equals the summed cost
// of this map, because submit seeds both from the same split and reconcile
// advances the cursor and the scalar in lockstep (leaveDays is ascending and
// days elapse in order, so the consumed prefix is exactly the cursor).
//
// The cursor counts DATES, which is why the slice is taken over leaveDays and
// the portion is read at the date's own index: a half day elapses like any
// other, it just costs less.
function remainingPaidDaysByYear(
  request: Pick<
    LeaveRequestEntity,
    'leaveDays' | 'dayPortions' | 'unpaidLeaveDays' | 'spentDaysConsumed'
  >,
): Map<number, CommittedDay[]> {
  const unpaid = new Set(request.unpaidLeaveDays)
  const consumed = Math.round(request.spentDaysConsumed)
  const remaining: CommittedDay[] = []
  request.leaveDays.forEach((day, index) => {
    if (index < consumed || unpaid.has(day)) {
      return
    }
    remaining.push({ day, portion: portionAt(request.dayPortions, index) })
  })
  return bucketCommittedByYear(remaining)
}

/**
 * What each working date of a request costs, derived from the hours the
 * composer booked on it. THE one place the wire's hours become the books'
 * fractions of a day: the divisor is the org's setting, so no client can mint
 * a portion the server would not have minted itself.
 *
 * Returns an EMPTY array when every date is a full day. That is the idiom the
 * whole read side is written against (day-math.portionAt): empty means
 * ordinary, which is what every request filed before leave could be booked by
 * the hour carries, and what keeps a new whole-day request indistinguishable
 * from them.
 *
 * A named date that the request does not actually cover is REFUSED rather than
 * dropped: the composer that sent it believes those hours are booked, and
 * dropping them would silently file a full day nobody asked for.
 */
function resolveDayPortions(
  leaveDays: readonly string[],
  hoursByDate: Record<string, number> | undefined,
  hoursPerDay: number,
): number[] {
  if (hoursByDate === undefined) {
    return []
  }
  // Read through a Map rather than off the payload object: the keys come from
  // a JSON body, so an inherited property must never answer a lookup.
  const booked = new Map(Object.entries(hoursByDate))
  const workingDays = new Set(leaveDays)
  for (const [date, hours] of booked) {
    if (!workingDays.has(date)) {
      throw new LeaveDomainValidationError(
        `Hours are booked for ${date}, which is not a working day of this leave request (weekends and public holidays are excluded).`,
      )
    }
    // hoursPerDay itself is accepted and means a whole day, so the composer
    // may send the full shape of the absence without special-casing its full
    // days; it normalizes to a portion of 1 below.
    if (!Number.isInteger(hours) || hours < 1 || hours > hoursPerDay) {
      throw new LeaveDomainValidationError(
        `Hours booked for ${date} must be a whole number between 1 and ${hoursPerDay} (a full working day). Leave a date out of the hours to book it whole.`,
      )
    }
  }
  const portions = leaveDays.map((day) => {
    const hours = booked.get(day)
    return hours === undefined ? 1 : hoursToDayPortion(hours, hoursPerDay)
  })
  return portions.every((portion) => portion === 1) ? [] : portions
}

// Terms as the catalog writers accept them, canonicalized once so the stored
// row, the fingerprint and the audit snapshot cannot disagree. Terms round with
// roundPolicyTerm, NOT with the books' roundDays: the fingerprint is the policy's
// identity and it quantizes to two decimals, so a term stored any finer would
// let two different offers share one identity — the import, which reads prorated
// spreadsheet cells like 25*10/12, would silently enrol the second employee in
// the first one's policy.
function normalizePolicyTerms(input: CreateLeavePolicyInput): LeavePolicyTerms {
  const day = (value: number, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new LeaveDomainValidationError(
        `${label} must be a non-negative number.`,
      )
    }
    return roundPolicyTerm(value)
  }
  const vacationDays = day(input.vacationDays, 'vacationDays')
  const sickDays = day(input.sickDays, 'sickDays')
  const vacationAnnualIncrement = day(
    input.vacationAnnualIncrement ?? 0,
    'vacationAnnualIncrement',
  )
  // The period is years, not days, so it is whole and never rounded. It is
  // validated HERE rather than only in the HTTP controller because the history
  // import reaches policy creation without passing through one, and a period of
  // 0 divides by zero in vacationRateForYear.
  const suppliedEveryYears = input.vacationIncrementEveryYears ?? 1
  if (
    !Number.isInteger(suppliedEveryYears) ||
    suppliedEveryYears < 1 ||
    suppliedEveryYears > 50
  ) {
    throw new LeaveDomainValidationError(
      'vacationIncrementEveryYears must be a whole number between 1 and 50.',
    )
  }
  // Without an increment the period is behaviorally inert, and keeping it
  // would give two identical deals distinct fingerprints, minting catalog
  // twins. Same neutralization as paidSickDuringProbation without probation,
  // except that one refuses and this one coerces: an untouched period field is
  // not something the writer chose.
  const vacationIncrementEveryYears =
    vacationAnnualIncrement === 0 ? 1 : suppliedEveryYears
  const vacationIncrementCapDays =
    input.vacationIncrementCapDays === undefined ||
    input.vacationIncrementCapDays === null
      ? null
      : day(input.vacationIncrementCapDays, 'vacationIncrementCapDays')
  if (vacationIncrementCapDays !== null && vacationIncrementCapDays < vacationDays) {
    throw new LeaveDomainValidationError(
      'The increment cap cannot be lower than the base vacation allowance.',
    )
  }
  const probationMonths = input.probationMonths ?? 0
  if (
    !Number.isInteger(probationMonths) ||
    probationMonths < 0 ||
    probationMonths > 24
  ) {
    throw new LeaveDomainValidationError(
      'probationMonths must be a whole number between 0 and 24.',
    )
  }
  const paidSickDuringProbation = input.paidSickDuringProbation ?? false
  // Without a probation window the flag is behaviorally inert, and allowing it
  // would give two identical deals distinct fingerprints — defeating dedup.
  if (paidSickDuringProbation && probationMonths === 0) {
    throw new LeaveDomainValidationError(
      'paidSickDuringProbation only applies to a policy with a probation period.',
    )
  }
  if (!ISO_DATE_PATTERN.test(input.effectiveFrom)) {
    throw new LeaveDomainValidationError(
      `Invalid policy start date: ${input.effectiveFrom}`,
    )
  }
  if (
    input.effectiveTo !== undefined &&
    input.effectiveTo !== null &&
    (!ISO_DATE_PATTERN.test(input.effectiveTo) ||
      input.effectiveTo < input.effectiveFrom)
  ) {
    throw new LeaveDomainValidationError(
      'The policy end date must be a valid date on or after its start date.',
    )
  }
  return {
    vacationDays,
    sickDays,
    vacationAnnualIncrement,
    vacationIncrementEveryYears,
    vacationIncrementCapDays,
    probationMonths,
    paidSickDuringProbation,
  }
}

function policyToDto(
  policy: LeavePolicyEntity,
): Omit<LeavePolicyDto, 'memberCount' | 'scheduledInCount'> {
  return {
    policyId: policy.id,
    name: policy.name,
    ...(policy.description ? { description: policy.description } : {}),
    vacationDays: policy.vacationDays,
    sickDays: policy.sickDays,
    vacationAnnualIncrement: policy.vacationAnnualIncrement,
    vacationIncrementEveryYears: policy.vacationIncrementEveryYears,
    ...(policy.vacationIncrementCapDays !== null
      ? { vacationIncrementCapDays: policy.vacationIncrementCapDays }
      : {}),
    probationMonths: policy.probationMonths,
    paidSickDuringProbation: policy.paidSickDuringProbation,
    effectiveFrom: policy.effectiveFrom,
    ...(policy.effectiveTo ? { effectiveTo: policy.effectiveTo } : {}),
    isDefault: policy.isDefault,
    termsFingerprint: policy.termsFingerprint,
    createdAt: policy.createdAt,
  }
}

function snapshotPolicy(policy: LeavePolicyEntity): AuditStateSnapshot {
  return {
    name: policy.name,
    description: policy.description,
    vacationDays: policy.vacationDays,
    sickDays: policy.sickDays,
    vacationAnnualIncrement: policy.vacationAnnualIncrement,
    vacationIncrementEveryYears: policy.vacationIncrementEveryYears,
    vacationIncrementCapDays: policy.vacationIncrementCapDays,
    probationMonths: policy.probationMonths,
    paidSickDuringProbation: policy.paidSickDuringProbation,
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo,
    isDefault: policy.isDefault,
  }
}

// The user's live membership rows plus the full policy rows they reference —
// what the per-day probation gate resolves against.
interface PolicyTimeline {
  rows: LeavePolicyMembershipEntity[]
  policiesById: Map<string, LeavePolicyEntity>
}

// The policy columns of one directory row, from the membership facts already
// folded out of the page's batch. Kept beside the reduction that feeds it so
// the two cannot drift.
function policyFactsForRow(
  membership:
    | {
        policyId: string
        name: string
        since: string
        probationMonths: number
        scheduled?: { policyName: string; effectiveFrom: string }
      }
    | undefined,
  user: UserEntity,
  today: string,
): Partial<AdminEmployeeListItemDto> {
  if (!membership) {
    return {}
  }
  const probationEnd =
    user.employmentStartDate && membership.probationMonths > 0
      ? addCalendarMonths(user.employmentStartDate, membership.probationMonths)
      : null
  return {
    policyId: membership.policyId,
    policyName: membership.name,
    policySince: membership.since,
    ...(membership.scheduled ? { policyScheduled: membership.scheduled } : {}),
    ...(probationEnd && today < probationEnd
      ? { probationEndsOn: probationEnd }
      : {}),
  }
}

// The display-only policy facts a profile card and the dashboard carry: which
// policy governs today, and (when a hire anchor is supplied) the probation
// window while it is still running.
function policyFactsOf(
  timeline: PolicyTimeline | null,
  today: string,
  employmentStartDate?: string | null,
): { policyId?: string; policyName?: string; probationEndsOn?: string } {
  if (!timeline) {
    return {}
  }
  const policy = governingPolicyAt(timeline, today)
  if (!policy) {
    return {}
  }
  const probationEnd =
    employmentStartDate && policy.probationMonths > 0
      ? addCalendarMonths(employmentStartDate, policy.probationMonths)
      : null
  return {
    policyId: policy.id,
    policyName: policy.name,
    ...(probationEnd && today < probationEnd
      ? { probationEndsOn: probationEnd }
      : {}),
  }
}

// Which policy governs calendar day `day`: the latest live membership
// starting on or before it, with the earliest row extending backward in time
// (the same rules the schedule resolver applies, at day granularity).
function governingPolicyAt(
  timeline: PolicyTimeline,
  day: string,
): LeavePolicyEntity | null {
  const row =
    [...timeline.rows].reverse().find((r) => r.effectiveFrom <= day) ??
    timeline.rows[0] ??
    null
  return row ? (timeline.policiesById.get(row.policyId) ?? null) : null
}

// The probation partition: which of `days` the governing policy's probation
// window forces unpaid. The window is [employment start, start + months) —
// probationEnd is the FIRST PAYABLE day. Sick days escape the forcing when
// the governing policy grants paid sick during probation; vacation never
// does. Resolved per day, so a scheduled transfer out of a probation-bearing
// policy frees exactly the days after its boundary.
function probationForcedDays(
  timeline: PolicyTimeline,
  employmentStartDate: string | null,
  leaveType: LeaveType,
  days: string[],
): { forcedDays: string[]; probationEnd?: string } {
  if (!employmentStartDate) {
    return { forcedDays: [] }
  }
  const forcedDays: string[] = []
  let probationEnd: string | undefined
  for (const day of days) {
    const policy = governingPolicyAt(timeline, day)
    if (!policy || policy.probationMonths <= 0) {
      continue
    }
    if (leaveType === LeaveType.Sick && policy.paidSickDuringProbation) {
      continue
    }
    const windowEnd = addCalendarMonths(
      employmentStartDate,
      policy.probationMonths,
    )
    if (day < windowEnd) {
      forcedDays.push(day)
      if (!probationEnd || windowEnd > probationEnd) {
        probationEnd = windowEnd
      }
    }
  }
  return { forcedDays, ...(probationEnd ? { probationEnd } : {}) }
}

// The composer sentence for probation-forced days; the balance-driven part of
// a split keeps its own sentence (describeUnpaidDays) and the two compose.
function describeProbationDays(
  count: number,
  probationEnd: string,
  hoursPerDay: number,
): string {
  return (
    `${formatDayAmount(count, hoursPerDay)} fall within your probation period ` +
    `and will be unpaid; paid leave starts ${probationEnd}.`
  )
}

// Shift an ISO date (YYYY-MM-DD) by whole calendar months, keeping the
// day-of-month and clamping it to the target month's length (Jan 31 + 1 month
// = Feb 28/29). Drives the probation window: hired the 20th with a 3-month
// probation means paid leave from the 20th three months later.
function addCalendarMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number(part))
  const zeroBased = (month ?? 1) - 1 + months
  const targetYear = (year ?? 0) + Math.floor(zeroBased / 12)
  const targetMonth = ((zeroBased % 12) + 12) % 12 // 0-based, wrap negatives
  const clampedDay = Math.min(day ?? 1, daysInMonth(targetYear, targetMonth + 1))
  return (
    `${String(targetYear).padStart(4, '0')}-` +
    `${String(targetMonth + 1).padStart(2, '0')}-` +
    `${String(clampedDay).padStart(2, '0')}`
  )
}

// Shift an ISO date (YYYY-MM-DD) by a whole number of years, clamping Feb 29 to
// Feb 28 when the target year is not a leap year so the result is always valid.
function shiftIsoYear(isoDate: string, deltaYears: number): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number(part))
  const targetYear = year + deltaYears
  const targetDay = month === 2 && day === 29 && !isLeapYear(targetYear) ? 28 : day
  return (
    `${String(targetYear).padStart(4, '0')}-` +
    `${String(month).padStart(2, '0')}-` +
    `${String(targetDay).padStart(2, '0')}`
  )
}
