/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, IsNull, type EntityManager } from 'typeorm'
import {
  AuditEventType,
  LeaveApprovalAction,
  LeaveType,
  type EmployeeImportRowDto,
  type ImportBatchSummaryDto,
  type ImportEmployeePlanDto,
  type ImportEmployeeRequestDto,
  type ImportEmployeeResultDto,
  type ImportReconciliationDto,
  type ImportRequestOutcomeDto,
  type ImportRowIssueDto,
  type ImportValidationReportDto,
  type LeaveHistoryImportRowDto,
  type PolicyToCreateDto,
  type PolicyToReuseDto,
  type ValidateImportRequestDto,
} from '@workspace/contracts'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import {
  floorToHourGrid,
  formatDayAmount,
  roundDays,
} from '../domain/day-math'
import {
  LeaveDomainNotFoundError,
  LeaveDomainService,
  LeaveDomainValidationError,
} from '../domain/leave-domain.service'
import type {
  AuditActor,
  RepostableLeaveRequestSnapshot,
} from '../domain/leave-domain.types'
import { LeavePolicyEntity } from '../domain/entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from '../domain/entities/leave-policy-membership.entity'
import {
  policyTermsFingerprint,
  roundPolicyTerm,
  type LeavePolicyTerms,
} from '../domain/policy-fingerprint'
import {
  describePolicyTermsMismatch,
  policyCatalogEntry,
  resolvePolicy,
  suggestPolicyName,
  type PolicyCatalogEntry,
} from '../domain/policy-resolution'
import { vacationRateForYear } from '../domain/policy-schedule'

// Later-year bookings an override wipe lifted out, waiting for the file's rows
// to rebuild the target year underneath them.
type RepostQueue = RepostableLeaveRequestSnapshot[]

/**
 * THE reading of one file row as policy terms, for the preview and the apply
 * alike. Both paths call it, which is the whole point: while the preview
 * fingerprinted its own guess at the terms it grouped rows into policies the
 * apply would then mint differently, and the operator approved a grouping that
 * never happened: two people shown on one policy landing on two, or, worse,
 * two different offers shown as one row and renamed together.
 *
 * Values travel as the file wrote them; only the two coercions the writer
 * itself performs are applied, because they decide identity:
 *  - an increment period is inert without an increment, and left standing it
 *    would fingerprint a flat policy differently from its twin;
 *  - the paid-sick flag is inert without a probation window, and the writer
 *    REFUSES that pair rather than coercing it.
 * Everything else (the ranges, the day quantum, a period that is not a whole
 * number) is validated by normalizePolicyTerms on the way in, so a bad cell
 * fails the employee loudly instead of being rounded into something legal here.
 */
export function policyTermsFromImportRow(
  row: EmployeeImportRowDto,
): LeavePolicyTerms {
  const vacationAnnualIncrement = row.vacationAnnualIncrement ?? 0
  const probationMonths = row.probationMonths ?? 0
  return {
    vacationDays: row.vacationDaysPerYear,
    sickDays: row.sickDaysPerYear,
    vacationAnnualIncrement,
    // Quantized before the test, exactly as the writer decides it: an
    // increment of 0.001 IS zero to a policy term, so its period is inert too.
    vacationIncrementEveryYears:
      roundPolicyTerm(vacationAnnualIncrement) === 0
        ? 1
        : (row.vacationIncrementEveryYears ?? 1),
    vacationIncrementCapDays: row.vacationIncrementCapDays ?? null,
    probationMonths,
    paidSickDuringProbation:
      probationMonths > 0 ? (row.paidSickDuringProbation ?? false) : false,
  }
}

/**
 * The pre-go-live data import.
 *
 * The engine is deliberately thin: it replays each employee's real history
 * through the ORDINARY submit and approve machinery, so accrual, the
 * paid/unpaid split, probation, holds, spends and the year close are all
 * computed by the same code live usage exercises. The import only supplies
 * what the engine cannot derive — the policy enrollment from the hire date,
 * the years accounted before the system existed, and the opening carryover —
 * and refuses to invent anything else. That is also why a run doubles as an
 * end-to-end test of the balance engine: a wrong accrual shows up as a
 * reconciliation delta against the source tracker before anything is written.
 *
 * Three guarantees shape the flow:
 *  - Nothing is created that is not in the file, and never a user: people
 *    enter through LDAP only.
 *  - Preview IS apply, run inside a transaction that is rolled back, so the
 *    operator approves the actual effect rather than a description of it.
 *  - One transaction per employee: a failure takes that employee down alone,
 *    and the operator retries them after fixing the row.
 */
@Injectable()
export class LeaveImportService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly leaveDomain: LeaveDomainService,
    private readonly auditLog: AuditLogService,
    private readonly clock: ClockService,
  ) {}

  // Signals a preview: the pipeline has run to completion and its result is
  // carried out of the transaction that is about to be rolled back.
  private static readonly PREVIEW_ROLLBACK = Symbol('import-preview-rollback')

  async validate(
    input: ValidateImportRequestDto,
    actor: AuditActor,
  ): Promise<ImportValidationReportDto> {
    const issues: ImportRowIssueDto[] = []
    const unknownEmails: string[] = []
    const employees: string[] = []
    const employeeRows = input.employees ?? []
    const historyRows = input.history ?? []

    return this.dataSource.transaction(async (manager) => {
      // The divisor every hours cell is judged against, read once: it decides
      // what a whole day is, and it is also what the report carries out to the
      // wizard's cards.
      const hoursPerDay = await this.leaveDomain.getWorkdayHoursTx(manager)
      const knownEmails = new Map<string, string>()
      const resolve = async (email: string): Promise<string | undefined> => {
        const key = email.trim().toLowerCase()
        if (knownEmails.has(key)) {
          return knownEmails.get(key)
        }
        const user = await this.leaveDomain.findUserByEmailTx(manager, email)
        if (!user) {
          if (!unknownEmails.includes(email)) {
            unknownEmails.push(email)
          }
          return undefined
        }
        knownEmails.set(key, user.userId)
        return user.userId
      }

      for (const [index, row] of employeeRows.entries()) {
        const userId = await resolve(row.email)
        if (!userId) {
          issues.push({
            email: row.email,
            rowIndex: index,
            severity: 'warning',
            message:
              'No account with this address. Run a directory sync and validate again; if it is still missing, the row is ignored.',
          })
          continue
        }
        employees.push(row.email)
        issues.push(...this.validateEmployeeRow(row, index, input.targetYear))
      }

      const byEmail = new Map<string, LeaveHistoryImportRowDto[]>()
      for (const [index, row] of historyRows.entries()) {
        const userId = await resolve(row.email)
        if (!userId) {
          issues.push({
            email: row.email,
            rowIndex: index,
            severity: 'warning',
            message:
              'No account with this address. Run a directory sync and validate again; if it is still missing, the row is ignored.',
          })
          continue
        }
        if (!employees.includes(row.email)) {
          employees.push(row.email)
        }
        issues.push(
          ...this.validateHistoryRow(row, index, input.targetYear, hoursPerDay),
        )
        // Which dates the leave actually charges is a calendar question, so it
        // is asked here rather than in the pure row check above, and only for
        // the rows that name hours, which are the only ones that can get it
        // wrong. A weekend or a holiday in the hours cell would otherwise reach
        // the replay and take the whole employee down at preview time.
        issues.push(
          ...(await this.validateHoursAgainstCalendar(
            manager,
            row,
            index,
            employeeRows,
          )),
        )
        const bucket = byEmail.get(row.email) ?? []
        bucket.push(row)
        byEmail.set(row.email, bucket)

        if (row.approverEmail) {
          const approver = await this.leaveDomain.findUserByEmailTx(
            manager,
            row.approverEmail,
          )
          if (!approver) {
            issues.push({
              email: row.email,
              rowIndex: index,
              severity: 'warning',
              message: `No account for approver ${row.approverEmail}; the leave will be recorded as agreed outside the system, with no named approver.`,
            })
          }
        }
      }

      // Overlaps inside the file itself: the engine refuses two requests over
      // the same day, so the file must be split before it is replayed.
      for (const [email, rows] of byEmail) {
        const sorted = [...rows].sort((a, b) =>
          a.startDate.localeCompare(b.startDate),
        )
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i]!.startDate <= sorted[i - 1]!.endDate) {
            issues.push({
              email,
              severity: 'error',
              message: `Overlapping rows: ${sorted[i - 1]!.startDate}..${sorted[i - 1]!.endDate} and ${sorted[i]!.startDate}..${sorted[i]!.endDate}. Split them so no day is covered twice.`,
            })
          }
        }
      }

      // Rows keep their place in the SHEET while the ones with no account drop
      // out: the resolver is replayed in file order, and an issue it raises has
      // to point at the row the operator is looking at.
      const { policiesToCreate, policiesToReuse, issues: policyIssues } =
        await this.groupPolicies(
          manager,
          employeeRows
            .map((row, rowIndex) => ({ row, rowIndex }))
            .filter(({ row }) => employees.includes(row.email)),
        )
      issues.push(...policyIssues)

      return {
        ok: !issues.some((issue) => issue.severity === 'error'),
        unknownEmails,
        employees,
        issues,
        policiesToCreate,
        policiesToReuse,
        // The wizard's own route fetches nothing else that knows the org's
        // workday, and validation always runs before any preview card is
        // rendered, so this is where the divisor reaches it.
        hoursPerDay,
      }
    })
  }

  /**
   * Run the whole per-employee pipeline and throw it away: the operator sees
   * the real computed effect (working days, unpaid splits, resulting balances)
   * before a single row is committed.
   */
  async previewEmployee(
    input: ImportEmployeeRequestDto,
    actor: AuditActor,
  ): Promise<ImportEmployeeResultDto> {
    let captured: ImportEmployeeResultDto | null = null
    try {
      await this.dataSource.transaction(async (manager) => {
        captured = await this.runEmployee(manager, input, actor)
        throw LeaveImportService.PREVIEW_ROLLBACK
      })
    } catch (error) {
      if (error !== LeaveImportService.PREVIEW_ROLLBACK) {
        return this.toFailure(input, error)
      }
    }
    if (!captured) {
      return {
        status: 'failed',
        email: this.emailOf(input),
        message: 'The preview produced no result.',
      }
    }
    return captured
  }

  async applyEmployee(
    input: ImportEmployeeRequestDto,
    actor: AuditActor,
  ): Promise<ImportEmployeeResultDto> {
    try {
      const result = await this.dataSource.transaction((manager) =>
        this.runEmployee(manager, input, actor),
      )
      return result.status === 'ok'
        ? { status: 'applied', plan: result.plan }
        : result
    } catch (error) {
      return this.toFailure(input, error)
    }
  }

  /**
   * The run summary. Per-employee acts audit under their own event types (a
   * replayed request looks like a submitted request, because it is one), so
   * this is the only row the import adds a vocabulary for — the place an
   * administrator later asks "what did that import touch".
   */
  async recordImportCompleted(
    summary: ImportBatchSummaryDto,
    actor: AuditActor,
  ): Promise<void> {
    const occurredAt = this.clock.nowIso()
    await this.auditLog.record(this.dataSource.manager, {
      actor,
      eventType: AuditEventType.ImportCompleted,
      occurredAt,
      entityType: 'import',
      summary:
        `Imported ${describeImportFunction(summary.fn)} for ${summary.targetYear} ` +
        `(${summary.mode}): ${summary.applied.length} applied, ${summary.skipped.length} skipped, ${summary.failed.length} failed`,
      after: {
        function: summary.fn,
        targetYear: summary.targetYear,
        mode: summary.mode,
        applied: summary.applied,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    })
  }

  // ------------------------------------------------------------- pipeline ---

  private async runEmployee(
    manager: EntityManager,
    input: ImportEmployeeRequestDto,
    actor: AuditActor,
  ): Promise<ImportEmployeeResultDto> {
    const email = this.emailOf(input)
    const user = await this.leaveDomain.findUserByEmailTx(manager, email)
    if (!user) {
      return {
        status: 'skipped',
        email,
        reasons: [
          'No account with this address; the import never creates users. Run a directory sync and try again.',
        ],
      }
    }

    const issues: ImportRowIssueDto[] = []
    const plan: ImportEmployeePlanDto = {
      email,
      displayName: user.displayName,
      policy: {
        policyName: '',
        vacationDaysPerYear: 0,
        sickDaysPerYear: 0,
        willBeCreated: false,
      },
      carriedOverVacationDays: 0,
      requests: [],
      reconciliation: [],
      issues,
    }

    let repost: RepostQueue = []
    if (input.employee) {
      repost = await this.applyUserData(
        manager,
        input,
        user.userId,
        plan,
        issues,
        actor,
      )
    } else {
      // A history-only run reads the terms already on record, so the card can
      // still name the policy the replay will charge against.
      plan.policy = {
        ...(await this.readCurrentPolicy(manager, user.userId)),
        willBeCreated: false,
        keptExisting: true,
      }
    }

    const history = input.history ?? []
    if (history.length > 0) {
      await this.replayHistory(manager, input, user.userId, plan, issues, actor)
    }
    for (const snapshot of repost) {
      await this.leaveDomain.repostRequestMechanicallyTx(manager, snapshot)
    }

    const now = this.clock.nowIso()
    await this.leaveDomain.settleBalancesTx(manager, user.userId, now)
    // An employee who used the system before the import keeps the year totals
    // of the policy they were on then, while accrual already follows the newly
    // assigned one — a year that reads "12 of 15" with 16.67 days accrued.
    // Re-resolving those totals is what an ordinary policy transfer does after
    // a membership change, and the import owes the same.
    //
    // It runs LAST, once the replay has settled: the monthly accrual writes
    // one ledger row per month, each dated to the month it belongs to, and a
    // re-anchor performed before them would collapse the lot into a single
    // adjustment dated today — leaving the year impossible to reconstruct as
    // of any earlier day, which is exactly what the reconciliation reads.
    await this.leaveDomain.resyncAllocationsAfterImportTx(
      manager,
      user.userId,
      now,
    )
    plan.reconciliation = await this.reconcile(
      manager,
      user.userId,
      input.employee,
      input.targetYear,
      input.snapshotDate,
      now.slice(0, 10),
    )

    return { status: 'ok', plan }
  }

  private async applyUserData(
    manager: EntityManager,
    input: ImportEmployeeRequestDto,
    userId: string,
    plan: ImportEmployeePlanDto,
    issues: ImportRowIssueDto[],
    actor: AuditActor,
  ): Promise<RepostQueue> {
    const row = input.employee!
    const user = await this.leaveDomain.findUserByEmailTx(manager, row.email)
    if (!user) {
      return []
    }

    // The profile first: the policy resolver and every accrual read the hire
    // date, so it must be in place before the enrollment is written.
    const patch: {
      employmentStartDate?: string
      countryCode?: string
      holidayCalendarCountryCode?: string
    } = {}
    if (user.employmentStartDate !== row.employmentStartDate) {
      patch.employmentStartDate = row.employmentStartDate
      plan.employmentStartDate = row.employmentStartDate
    }
    if (!user.countryCode) {
      patch.countryCode = row.countryCode
      plan.countryCode = row.countryCode
    } else if (user.countryCode !== row.countryCode) {
      // The directory owns this column: writing over it here would be undone
      // by the next sync pass, so the disagreement is reported instead.
      issues.push({
        email: row.email,
        severity: 'warning',
        message: `The directory has ${user.countryCode} for this account and the file says ${row.countryCode}. The country is synced from LDAP, so it was left as it is — change it in the directory if the file is right.`,
      })
    }
    // The working calendar is import-owned (no sync source ever writes it),
    // so a value in the file is applied outright — it must land BEFORE the
    // replay, which counts every request's working days by it. A blank cell
    // deliberately changes nothing: inheritance is the default and clearing
    // an administrator's assignment stays a by-hand act.
    if (
      row.holidayCalendarCountryCode !== undefined &&
      row.holidayCalendarCountryCode !==
        (user.holidayCalendarCountryCode ?? undefined)
    ) {
      patch.holidayCalendarCountryCode = row.holidayCalendarCountryCode
    }
    if (Object.keys(patch).length > 0) {
      await this.leaveDomain.updateEmployeeAdminTx(manager, {
        userId,
        ...patch,
        audit: actor,
      })
    }

    const rowTerms = policyTermsFromImportRow(row)
    const policy = await this.leaveDomain.findOrCreatePolicyByTermsTx(
      manager,
      {
        name:
          row.policyName?.trim() ||
          input.policyName ||
          suggestPolicyName(rowTerms),
        ...rowTerms,
        effectiveFrom: row.employmentStartDate,
        createdByUserId: actor.userId ?? undefined,
        audit: actor,
      },
      { matchByName: Boolean(row.policyName?.trim()) },
    )
    if (policy.termsMismatch) {
      issues.push({
        email: row.email,
        severity: 'warning',
        message: describePolicyTermsMismatch(
          policy.policyName,
          policy.termsMismatch,
        ),
      })
    }
    plan.policy = {
      policyName: policy.policyName,
      // The terms of the POLICY, never the row's: a row that names a catalog
      // policy loses its own figures to it (the warning above says so), and a
      // card pairing that policy's name with the file's day counts describes a
      // deal nobody is on. Same reading as the history-only path, which takes
      // them off the policy already on record.
      vacationDaysPerYear: policy.terms.vacationDays,
      sickDaysPerYear: policy.terms.sickDays,
      willBeCreated: policy.created,
    }

    const membership = await this.leaveDomain.assignHistoricalMembershipTx(
      manager,
      {
        userId,
        policyId: policy.policyId,
        effectiveFrom: row.employmentStartDate,
        assignedByUserId: actor.userId ?? userId,
        mode: input.mode,
        audit: actor,
      },
    )
    if (membership.outcome === 'skipped') {
      plan.policy.keptExisting = true
      issues.push({
        email: row.email,
        severity: 'warning',
        message:
          'An administrator already set this employee up on a policy by hand, so the enrollment was left alone. Import in override mode to replace it.',
      })
    }

    let repost: RepostQueue = []
    if (input.mode === 'override') {
      const wiped = await this.leaveDomain.resetUserLeaveDataFromYearTx(
        manager,
        { userId, fromYear: input.targetYear, audit: actor },
      )
      repost = wiped.repost
    }

    // Quantized here as well as by the seed below, so the card promises the
    // figure the books will hold rather than the finer one the file stated.
    const carried = roundDays(row.carriedOverVacationDays ?? 0)
    await this.leaveDomain.seedCarryoverHistoryTx(manager, {
      userId,
      targetYear: input.targetYear,
      carriedOverVacationDays: carried,
      audit: actor,
    })
    plan.carriedOverVacationDays = carried
    // Later-year bookings the wipe lifted out: they go back once the file's
    // rows have rebuilt the target year underneath them.
    return repost
  }

  private async replayHistory(
    manager: EntityManager,
    input: ImportEmployeeRequestDto,
    userId: string,
    plan: ImportEmployeePlanDto,
    issues: ImportRowIssueDto[],
    actor: AuditActor,
  ): Promise<void> {
    // The org's workday length, for the report sentences below: an import that
    // lands part-day leave must state the amounts the way every other surface
    // does.
    const hoursPerDay = await this.leaveDomain.getWorkdayHoursTx(manager)
    // Chronological, because that is what makes the replay honest: each
    // submission sees the accrual and the balance the employee really had on
    // the day they asked.
    const rows = [...(input.history ?? [])].sort((left, right) => {
      const leftAt = left.submittedAt ?? left.startDate
      const rightAt = right.submittedAt ?? right.startDate
      return leftAt.localeCompare(rightAt) || left.startDate.localeCompare(right.startDate)
    })

    for (const row of rows) {
      const overlapping = await this.leaveDomain.findOverlappingRequestsTx(
        manager,
        userId,
        row.startDate,
        row.endDate,
      )
      if (overlapping.length > 0) {
        plan.requests.push({
          leaveType: row.leaveType,
          startDate: row.startDate,
          endDate: row.endDate,
          workingDays: 0,
          unpaidDays: 0,
          status: 'skipped',
          reason: `Leave is already on record for ${overlapping[0]!.startDate}..${overlapping[0]!.endDate}.`,
        })
        continue
      }

      const submittedAt = this.instant(row.submittedAt ?? row.startDate)
      const decidedAt = this.instant(row.approvedAt ?? row.submittedAt ?? row.startDate)
      const approver = row.approverEmail
        ? await this.leaveDomain.findUserByEmailTx(manager, row.approverEmail)
        : undefined
      // Whoever really signed off is recorded as the decider — but only when
      // the file names them and they hold an account. Leave agreed in person,
      // or by somebody who has since left, names nobody: it is submitted
      // unaddressed and settles through the system's own automatic approval,
      // which records the fact without inventing an author for it.
      const decider =
        approver && approver.userId !== userId
          ? { userId: approver.userId, label: approver.displayName }
          : null

      const detail = await this.leaveDomain.submitLeaveRequestTx(
        manager,
        {
          requesterUserId: userId,
          leaveType: row.leaveType,
          startDate: row.startDate,
          endDate: row.endDate,
          // The approver rows are a record of who signed off, not a gate the
          // replay waits on: the force-decision below settles it outright.
          approverEmails: decider ? [approver!.email] : [],
          ccEmails: [],
          submittedAt,
          audit: actor,
          // The shape of the absence, in the hours the tracker recorded. The
          // domain converts them against the org's workday and freezes the
          // portions beside the dates, so an imported part-day leave is
          // indistinguishable from one booked in the app.
          ...(row.hoursByDate !== undefined
            ? { hoursByDate: row.hoursByDate }
            : {}),
        },
        { suppressNotifications: true, historical: true },
      )
      if (detail.status !== 'approved' && decider) {
        await this.leaveDomain.forceDecideLeaveRequestTx(manager, {
          requestId: detail.requestId,
          actorUserId: decider.userId,
          actorDisplayName: decider.label,
          action: LeaveApprovalAction.Approve,
          comment: 'Approved before the system was in use (history import)',
          decidedAt,
          audit: actor,
          suppressNotifications: true,
        })
      }

      // The request's own unpaid AMOUNT, not how many dates carry it: a date
      // can cost less than a whole day, so the two do not agree.
      const unpaidDays = detail.unpaidDays
      plan.requests.push({
        leaveType: row.leaveType,
        startDate: row.startDate,
        endDate: row.endDate,
        workingDays: detail.requestedDays,
        unpaidDays,
        status: 'imported',
      })
      // Like against like: the file's column states what the leave COST, and
      // requestedDays is what the engine priced it at. Both are amounts, so a
      // part-day row is not reported merely for being one, which is what
      // comparing a cost against a count of DATES would do.
      //
      // A tolerance rather than the equality this used to be, because the two
      // sides no longer write the same number of decimals: a tracker keeping
      // two of them writes 4.63 for the 4.625 the engine priced, and that is
      // rounding. One HOUR is where it stops being rounding, since neither side
      // can record anything finer.
      if (
        row.workingDays !== undefined &&
        !isUnderOneHour(row.workingDays - detail.requestedDays, hoursPerDay)
      ) {
        issues.push({
          email: row.email,
          severity: 'warning',
          message: `${row.startDate}..${row.endDate}: the file records ${row.workingDays} day(s) of leave, the engine priced it at ${formatDayAmount(detail.requestedDays, hoursPerDay)}.`,
        })
      }
      if (unpaidDays > 0) {
        issues.push({
          email: row.email,
          severity: 'warning',
          message: `${row.startDate}..${row.endDate}: ${formatDayAmount(unpaidDays, hoursPerDay)} are unpaid: the balance on that date could not fund them (or they fall inside probation).`,
        })
      }
    }

  }

  /**
   * The computed balance next to the figure the tracker expected — measured on
   * the file's snapshot day when it gave one. Comparing a file exported on the
   * 1st against a balance that has since accrued another month would report a
   * discrepancy in every row and hide the real ones.
   */
  private async reconcile(
    manager: EntityManager,
    userId: string,
    row: EmployeeImportRowDto | undefined,
    targetYear: number,
    snapshotDate: string | undefined,
    today: string,
  ): Promise<ImportReconciliationDto[]> {
    const asOf = snapshotDate ?? today
    const entries: ImportReconciliationDto[] = []
    for (const leaveType of [LeaveType.Vacation, LeaveType.Sick]) {
      const balance = await this.leaveDomain.readBalanceAsOfTx(
        manager,
        userId,
        leaveType,
        targetYear,
        asOf,
      )
      const expected =
        leaveType === LeaveType.Vacation
          ? row?.expectedVacationBalance
          : row?.expectedSickBalance
      const comparable = balance.availableDays - balance.committedDays
      entries.push({
        leaveType,
        computedBalance: balance.availableDays,
        committedDays: balance.committedDays,
        expectedBalance: expected ?? undefined,
        // Loose comparison on purpose: an empty cell reaches a non-HTTP caller
        // as null, and comparing a balance against "no expectation" would
        // report every such employee as off by their whole balance.
        //
        // Quantized to the books' own three decimals, not to two: an hour of an
        // eight-hour day is 0.125, and rounding that delta to 0.13 states a
        // difference the books never held, on the very figure the card now
        // judges by the hour.
        delta: expected == null ? undefined : roundDays(comparable - expected),
        asOf,
      })
    }
    return entries
  }

  // -------------------------------------------------------------- helpers ---

  private async readCurrentPolicy(
    manager: EntityManager,
    userId: string,
  ): Promise<{
    policyName: string
    vacationDaysPerYear: number
    sickDaysPerYear: number
  }> {
    const membership = await manager
      .getRepository(LeavePolicyMembershipEntity)
      .findOne({
        where: { userId, supersededByRowId: IsNull(), effectiveTo: IsNull() },
      })
    const policy = membership
      ? await manager
          .getRepository(LeavePolicyEntity)
          .findOneBy({ id: membership.policyId })
      : null
    return {
      policyName: policy?.name ?? 'not enrolled',
      vacationDaysPerYear: policy?.vacationDays ?? 0,
      sickDaysPerYear: policy?.sickDays ?? 0,
    }
  }

  private validateEmployeeRow(
    row: EmployeeImportRowDto,
    index: number,
    targetYear: number,
  ): ImportRowIssueDto[] {
    const issues: ImportRowIssueDto[] = []
    const push = (severity: 'error' | 'warning', message: string): void => {
      issues.push({ email: row.email, rowIndex: index, severity, message })
    }
    if (!isIsoDate(row.employmentStartDate)) {
      push('error', 'The employment start date must be a YYYY-MM-DD date.')
    } else if (row.employmentStartDate > `${targetYear}-12-31`) {
      push(
        'error',
        `The employment starts after ${targetYear}; nothing can be imported into that year.`,
      )
    }
    if (!/^[A-Z]{2}$/.test(row.countryCode)) {
      push('error', 'The country must be a two-letter ISO code, e.g. UA.')
    }
    if (
      row.holidayCalendarCountryCode !== undefined &&
      !/^[A-Z]{2}$/.test(row.holidayCalendarCountryCode)
    ) {
      push(
        'error',
        'The holiday calendar must be a two-letter ISO code, e.g. UA, or left blank to inherit the country.',
      )
    }
    for (const [label, value] of [
      ['vacation', row.vacationDaysPerYear],
      ['sick', row.sickDaysPerYear],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 365) {
        push('error', `The ${label} allowance must be a number between 0 and 365.`)
      }
    }
    // Policy terms are the policy's IDENTITY: they are quantized to two
    // decimals before the fingerprint is taken, so a finer figure is stored as
    // something the file does not say. Reported rather than refused, because a
    // prorated cell (25*10/12) is a legitimate thing to find in a tracker and
    // the operator has to decide whether the rounded term is the offer.
    for (const [label, value] of [
      ['vacation allowance', row.vacationDaysPerYear],
      ['sick allowance', row.sickDaysPerYear],
      ['annual increase', row.vacationAnnualIncrement],
      ['increase cap', row.vacationIncrementCapDays],
    ] as const) {
      if (
        value !== undefined &&
        Number.isFinite(value) &&
        roundPolicyTerm(value) !== value
      ) {
        push(
          'warning',
          `The ${label} of ${value} is stored to two decimals, so the policy will grant ${roundPolicyTerm(value)}. State the figure the offer really carries if that is not what it means.`,
        )
      }
    }
    // Probation is counted in whole months (the engine truncates), so half a
    // month is a figure the file states and the system cannot hold.
    const probation = row.probationMonths
    if (
      probation !== undefined &&
      Number.isFinite(probation) &&
      !Number.isInteger(probation)
    ) {
      push('error', 'The probation length must be a whole number of months.')
    }
    // The rise period is whole years and it DIVIDES the elapsed ones, so a
    // fraction or a zero is not a figure the engine can hold at all. Caught
    // here as well as in the writer, so the file is fixed before a run starts
    // rather than one employee at a time.
    //
    // Only for a row that actually carries a rise: policyTermsFromImportRow
    // throws an inert period away before the writer ever sees it, so a
    // converted tracker that writes 0 (or 99) in the "Increase every" column
    // for everyone who has no rise would otherwise block the whole run over
    // cells that change nothing. The zero test is quantized exactly as that
    // coercion is, so the two cannot disagree about an increment of 0.001.
    const everyYears = row.vacationIncrementEveryYears
    if (
      roundPolicyTerm(row.vacationAnnualIncrement ?? 0) !== 0 &&
      everyYears !== undefined &&
      Number.isFinite(everyYears) &&
      (!Number.isInteger(everyYears) || everyYears < 1 || everyYears > 50)
    ) {
      push(
        'error',
        'The increase period must be a whole number of years between 1 and 50.',
      )
    }
    // The reference figure a seniority ladder is proven against: what the
    // stated terms grant for the TARGET year, recomputed with the engine's own
    // formula. A mismatch means the base, increment, period or cap does not
    // reproduce the tracker's norm - exactly the mistake a hand-written
    // ladder makes silently, since every other check would still pass.
    if (
      row.expectedYearVacationDays !== undefined &&
      Number.isFinite(row.expectedYearVacationDays) &&
      isIsoDate(row.employmentStartDate)
    ) {
      const yearRate = vacationRateForYear(
        {
          policyId: '',
          name: '',
          vacationDays: row.vacationDaysPerYear,
          sickDays: row.sickDaysPerYear,
          vacationAnnualIncrement: row.vacationAnnualIncrement ?? 0,
          vacationIncrementEveryYears: row.vacationIncrementEveryYears ?? 1,
          vacationIncrementCapDays: row.vacationIncrementCapDays ?? null,
        },
        Number.parseInt(row.employmentStartDate.slice(0, 4), 10),
        targetYear,
      )
      if (roundPolicyTerm(yearRate) !== roundPolicyTerm(row.expectedYearVacationDays)) {
        push(
          'warning',
          `The stated terms give ${yearRate} vacation days for ${targetYear}, but the file expects ${row.expectedYearVacationDays}. Check the base, the increase, its period and the cap.`,
        )
      }
    }
    // A carryover is a BALANCE, not a booking, and the two are held to
    // different quanta. The hour grid constrains what a person TAKES; a balance
    // carries whatever accrual left behind, and accrual mints twelfths of a day
    // (25 * 7/12 = 14.583), which is what the engine computes, what it stores
    // in allocation.carriedOverDays, and what the export writes back into this
    // very column. Holding this cell to the hour grid would therefore refuse
    // the system's own export and break the reset-and-reimport restore cycle,
    // besides rejecting the 14.58 an ordinary tracker writes.
    //
    // The real limit is the DAY QUANTUM, the three decimals the books hold: a
    // finer figure is quantized on the way in, so it is reported with the
    // figure that will actually be stored, exactly as a policy term is.
    const carried = row.carriedOverVacationDays ?? 0
    if (!Number.isFinite(carried) || carried < 0 || carried > 365) {
      push('error', 'The carried-over days must be a number between 0 and 365.')
    } else if (roundDays(carried) !== carried) {
      push(
        'warning',
        `The carried-over days of ${carried} are stored to three decimals, so ${roundDays(carried)} will be carried in. State the figure the prior year really left if that is not what it means.`,
      )
    }
    return issues
  }

  private validateHistoryRow(
    row: LeaveHistoryImportRowDto,
    index: number,
    targetYear: number,
    hoursPerDay: number,
  ): ImportRowIssueDto[] {
    const issues: ImportRowIssueDto[] = []
    const push = (severity: 'error' | 'warning', message: string): void => {
      issues.push({ email: row.email, rowIndex: index, severity, message })
    }
    if (row.leaveType !== LeaveType.Vacation && row.leaveType !== LeaveType.Sick) {
      push('error', `Unknown leave type: ${String(row.leaveType)}.`)
    }
    if (!isIsoDate(row.startDate) || !isIsoDate(row.endDate)) {
      push('error', 'The dates must be YYYY-MM-DD.')
      return issues
    }
    if (row.endDate < row.startDate) {
      push('error', 'The end date is before the start date.')
    }
    if (!row.startDate.startsWith(String(targetYear))) {
      push(
        'error',
        `The leave starts in ${row.startDate.slice(0, 4)}, but the import targets ${targetYear}.`,
      )
    }
    if (row.submittedAt && !isIsoDate(row.submittedAt)) {
      push('error', 'The submission date must be YYYY-MM-DD.')
    }
    if (row.approvedAt && !isIsoDate(row.approvedAt)) {
      push('error', 'The approval date must be YYYY-MM-DD.')
    }
    if (row.submittedAt && row.submittedAt > row.startDate) {
      push(
        'warning',
        'The leave was recorded as submitted after it began; the replay keeps the dates as given.',
      )
    }
    // The hours cell, judged against the org's workday. The same rules the
    // domain applies when it freezes the portions, checked here so the file
    // can be corrected before a preview is computed rather than after an
    // employee fails on it.
    for (const [date, hours] of Object.entries(row.hoursByDate ?? {})) {
      if (!isIsoDate(date)) {
        push('error', `The hours name ${date}, which is not a YYYY-MM-DD date.`)
        continue
      }
      if (date < row.startDate || date > row.endDate) {
        push(
          'error',
          `The hours name ${date}, which is outside the leave's ${row.startDate}..${row.endDate}.`,
        )
        continue
      }
      if (!Number.isInteger(hours) || hours < 1 || hours > hoursPerDay) {
        push(
          'error',
          `The hours booked for ${date} must be a whole number between 1 and ${hoursPerDay} (a full working day). Leave a date out of the cell to book it whole.`,
        )
      }
    }
    return issues
  }

  /**
   * The dates an hours cell names, against the calendar the replay will price
   * the leave by. A weekend, a public holiday or a date the period does not
   * reach charges nothing, so hours booked on it are hours the file believes
   * are taken and the system would never record.
   *
   * The calendar is resolved exactly as the submission core resolves it, with
   * the file's own assignment taking precedence: the run writes that column
   * before it replays anything, so validating against the stored one would
   * judge the row by a calendar that is about to be replaced. The file's own
   * COUNTRY closes the chain for the same reason, mirroring applyUserData,
   * which writes it onto an account the directory left without one: on a first
   * import that is the only calendar there is, and stopping one link short
   * left this check doing nothing on precisely the run it exists for.
   */
  private async validateHoursAgainstCalendar(
    manager: EntityManager,
    row: LeaveHistoryImportRowDto,
    index: number,
    employeeRows: EmployeeImportRowDto[],
  ): Promise<ImportRowIssueDto[]> {
    const dates = Object.keys(row.hoursByDate ?? {})
    if (dates.length === 0 || !isIsoDate(row.startDate) || !isIsoDate(row.endDate)) {
      return []
    }
    const user = await this.leaveDomain.findUserByEmailTx(manager, row.email)
    if (!user) {
      return []
    }
    const fileRow = employeeRows.find(
      (candidate) =>
        candidate.email.trim().toLowerCase() === row.email.trim().toLowerCase(),
    )
    const countryCode =
      fileRow?.holidayCalendarCountryCode ??
      user.holidayCalendarCountryCode ??
      user.countryCode ??
      fileRow?.countryCode ??
      undefined
    if (!countryCode) {
      // Nothing names a calendar: a history-only run against an account the
      // directory created without a country. The replay will refuse that
      // employee for the same reason, and guessing a calendar here would
      // invent working days.
      return []
    }
    const working = new Set(
      await this.leaveDomain.resolveWorkingDatesTx(manager, {
        startDate: row.startDate,
        endDate: row.endDate,
        countryCode,
      }),
    )
    return dates
      .filter((date) => !working.has(date))
      .map((date) => ({
        email: row.email,
        rowIndex: index,
        severity: 'error' as const,
        message: `The hours name ${date}, which this leave does not charge: it is a weekend, a public holiday in the ${countryCode} calendar, or outside ${row.startDate}..${row.endDate}.`,
      }))
  }

  /**
   * What the run will do to the policy catalog, decided by the very resolver
   * the apply writes through (policy-resolution.ts) rather than by a second
   * reading of the file. While this predicted from the row's TERMS alone it
   * promised policies that were joined instead, threw away names the operator
   * typed, and waved through rows that the enrollment then refused.
   *
   * Rows are replayed IN FILE ORDER against a catalog that GROWS: every planned
   * mint is appended as a synthetic entry, so the second row carrying those
   * terms joins it exactly as the apply's second transaction will, and the name
   * ladder counts the file's own mints alongside the catalog's names.
   *
   * Advisory by nature: the catalog is read outside the writer's advisory lock,
   * so a policy created between validation and the run can still move an
   * answer. The per-employee preview of step 3 runs the real pipeline in a
   * rolled-back transaction and stays the authority.
   */
  private async groupPolicies(
    manager: EntityManager,
    rows: readonly { row: EmployeeImportRowDto; rowIndex: number }[],
  ): Promise<{
    policiesToCreate: PolicyToCreateDto[]
    policiesToReuse: PolicyToReuseDto[]
    issues: ImportRowIssueDto[]
  }> {
    const catalog: PolicyCatalogEntry[] = (
      await manager.getRepository(LeavePolicyEntity).find()
    ).map(policyCatalogEntry)
    const create = new Map<string, PolicyToCreateDto>()
    const reuse = new Map<string, PolicyToReuseDto>()
    const issues: ImportRowIssueDto[] = []
    // Which create group a synthetic catalog entry stands for. A row landing on
    // a policy the file is only ABOUT to mint belongs to that group; listing it
    // as reused would name a policy that does not exist yet.
    const plannedGroups = new Map<string, string>()

    for (const { row, rowIndex } of rows) {
      const resolution = resolvePolicy(
        {
          // Only the file's own column. The operator's chosen names are read
          // OFF this report by the wizard, so they cannot also be an input to
          // it; on the apply they arrive per employee as input.policyName.
          ...(row.policyName?.trim() ? { fileName: row.policyName } : {}),
          terms: policyTermsFromImportRow(row),
          effectiveFrom: row.employmentStartDate,
        },
        catalog,
      )

      // Stated as "not a join" rather than as the two mint kinds, so the rest
      // of the loop reads as a join without a cast: the mint kinds share one
      // member of the union and excluding them by name leaves it standing.
      if (
        resolution.kind !== 'join-by-name' &&
        resolution.kind !== 'join-by-terms'
      ) {
        const termsFingerprint = policyTermsFingerprint(resolution.terms)
        create.set(termsFingerprint, {
          // The client keys the operator's chosen names off this, so it must be
          // the fingerprint the apply will mint under, not a display key.
          termsFingerprint,
          // The QUANTIZED figures, which are the ones the policy will hold.
          vacationDaysPerYear: resolution.terms.vacationDays,
          sickDaysPerYear: resolution.terms.sickDays,
          plannedName: resolution.plannedName,
          nameSource: resolution.kind === 'mint-file-name' ? 'file' : 'suggested',
          // A name the file states is not the wizard's to change: it travels on
          // the row itself and outranks anything typed here. A derived name
          // stays editable until another row of the file points at it by name,
          // which the join below then takes away.
          renameable: resolution.kind === 'mint-derived-name',
          memberEmails: [row.email],
        })
        const plannedPolicyId = `planned:${termsFingerprint}`
        plannedGroups.set(plannedPolicyId, termsFingerprint)
        catalog.push({
          policyId: plannedPolicyId,
          name: resolution.plannedName,
          termsFingerprint,
          terms: resolution.terms,
          // In force by construction: nothing the run mints is born retired.
          effectiveTo: null,
        })
        continue
      }

      const mismatch =
        resolution.kind === 'join-by-name' ? resolution.termsMismatch : undefined
      if (mismatch) {
        issues.push({
          email: row.email,
          rowIndex,
          severity: 'warning',
          // The apply's own sentence, from the shared builder: one fact, one
          // wording, whichever surface reports it.
          message: describePolicyTermsMismatch(resolution.policyName, mismatch),
        })
      }

      const plannedGroup = plannedGroups.get(resolution.policyId)
      const group = plannedGroup ? create.get(plannedGroup) : undefined
      if (group) {
        group.memberEmails.push(row.email)
        if (resolution.kind === 'join-by-name') {
          // The file itself asks for this name, so renaming the group would
          // split it at apply time: this row would look the typed name up, miss
          // it, and mint a policy of its own.
          group.renameable = false
        }
        continue
      }

      if (resolution.retired) {
        // Blocking, not a warning: assignHistoricalMembershipTx refuses a
        // retired policy outright, so the run would fail on this employee at
        // step 3 naming a policy the preview never showed. Same convention the
        // file-level overlap check already follows, and the same sentence the
        // enrollment throws.
        issues.push({
          email: row.email,
          rowIndex,
          severity: 'error',
          message:
            `Policy "${resolution.policyName}" is retired and cannot take new members. ` +
            'Point the row at a policy that is in force, or reopen that one, before the run.',
        })
      }

      const existing = reuse.get(resolution.policyId)
      if (existing) {
        existing.memberEmails.push(row.email)
        // The stronger claim wins: a policy asked for BY NAME was asked for by
        // name however many other rows merely landed on its terms.
        if (resolution.kind === 'join-by-name') {
          existing.matchedBy = 'name'
        }
        existing.termsDiffer = existing.termsDiffer || Boolean(mismatch)
        continue
      }
      reuse.set(resolution.policyId, {
        policyId: resolution.policyId,
        policyName: resolution.policyName,
        // The terms of the POLICY, never the row's: after a name match the
        // row's own figures are not the deal anyone ends up on.
        vacationDaysPerYear: resolution.terms.vacationDays,
        sickDaysPerYear: resolution.terms.sickDays,
        matchedBy: resolution.kind === 'join-by-name' ? 'name' : 'terms',
        retired: resolution.retired,
        termsDiffer: Boolean(mismatch),
        memberEmails: [row.email],
      })
    }
    return {
      policiesToCreate: [...create.values()],
      policiesToReuse: [...reuse.values()],
      issues,
    }
  }

  // Dates in the trackers are days, not instants. Noon keeps a backdated
  // submission inside its own day in every timezone the company works in.
  private instant(day: string): string {
    return `${day}T12:00:00.000Z`
  }

  private emailOf(input: ImportEmployeeRequestDto): string {
    return input.employee?.email ?? input.history?.[0]?.email ?? ''
  }

  private toFailure(
    input: ImportEmployeeRequestDto,
    error: unknown,
  ): ImportEmployeeResultDto {
    if (
      error instanceof LeaveDomainValidationError ||
      error instanceof LeaveDomainNotFoundError
    ) {
      return {
        status: 'failed',
        email: this.emailOf(input),
        message: error.message,
      }
    }
    throw error
  }
}

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)

/**
 * Whether a difference between two day figures is rounding noise. ONE HOUR is
 * the whole threshold, replacing the "under one day is benign" doctrine the
 * reconciliation was read by everywhere: leave is bookable by the hour and no
 * finer, so nothing either side can record is smaller than that, and a whole
 * day of tolerance hid a five-hour error inside the noise.
 *
 * Stated as a floor to the hour grid, which is exactly how the wizard's card
 * decides the same question, so the server and the screen cannot reach
 * different verdicts about one delta.
 */
const isUnderOneHour = (delta: number, hoursPerDay: number): boolean =>
  floorToHourGrid(Math.abs(delta), hoursPerDay) === 0

const describeImportFunction = (fn: string): string => {
  switch (fn) {
    case 'user-data':
      return 'employee profiles'
    case 'leave-history':
      return 'leave history'
    default:
      return 'employee profiles and leave history'
  }
}
