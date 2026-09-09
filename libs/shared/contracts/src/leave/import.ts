/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveType } from './enums'

/**
 * The pre-go-live data import: an admin uploads the office trackers, converted
 * into two flat row sets, and the engine replays them so the system starts
 * with real balances.
 *
 * Two rules shape every contract here:
 *  - The import NEVER creates users. People enter the system through LDAP
 *    (login auto-provision, the scheduled pass, the manual sync button), so an
 *    unknown address is reported, not provisioned.
 *  - Nothing is written before the operator has seen the computed effect. The
 *    wizard validates, then previews per employee, then applies per employee —
 *    and the preview runs the SAME code as the apply inside a transaction that
 *    is rolled back, so what it shows is what happens.
 */

// What a run carried, derived from the workbook rather than chosen by the
// operator. One book holds both sheets — Employees (one row per person) and
// Requests (one row per leave) — and a run applies each employee's profile and
// their leave in ONE transaction, which is also why the order can no longer be
// got wrong. A book with only one of the sheets is still legitimate: profiles
// alone before the history is ready, or a later year's leave on top of
// profiles already in place.
export type ImportFunction = 'combined' | 'user-data' | 'leave-history'

// Add fills what is missing and appends; Override rebuilds the target year for
// the employees the file names (and only those), re-seeds the opening
// carryover and replays the rows on top.
export type ImportMode = 'add' | 'override'

// One employee's terms and opening figures, straight from the user-data sheet.
// Day counts are ANNUAL policy terms, not prorated: the engine prorates a
// mid-year hire itself, so a prorated figure would be prorated twice.
export interface EmployeeImportRowDto {
  email: string
  displayName?: string
  employmentStartDate: string
  countryCode: string
  // The calendar the person WORKS by, when it differs from their country --
  // a TR-office employee following the Ukrainian holiday schedule. Blank
  // inherits the country. Never cleared by the import: a blank cell leaves
  // whatever an administrator assigned untouched.
  holidayCalendarCountryCode?: string
  // The policy's TERMS, not one year's figure: the engine derives the year
  // from them, so a mid-year hire must carry the annual base rather than the
  // prorated number a tracker shows.
  vacationDaysPerYear: number
  sickDaysPerYear: number
  // The rest of the offer. Left blank they mean "no annual rise, no probation",
  // which is what a flat policy is.
  vacationAnnualIncrement?: number
  // Years between two rises; blank = every year. Only meaningful with an
  // increment, and ignored without one (a period alone changes nothing).
  vacationIncrementEveryYears?: number
  vacationIncrementCapDays?: number
  probationMonths?: number
  paidSickDuringProbation?: boolean
  // An existing policy by name takes precedence over the terms: a deal already
  // agreed in the catalog is joined rather than re-derived from the row, and
  // the file only says who belongs there. The terms are then compared and any
  // disagreement is reported.
  policyName?: string
  // What the terms above should grant for the TARGET year - a reference only,
  // never written. Validation recomputes the year's rate from base, increment,
  // period and cap and warns on a mismatch, so a hand-written seniority
  // ladder is proven against the tracker's own figure before anything runs.
  expectedYearVacationDays?: number
  // Days carried into January 1 of the target year, imported verbatim: the
  // carryover policy was already applied by whoever kept the tracker, so the
  // engine records the fact rather than recomputing it.
  carriedOverVacationDays?: number
  // The tracker's own balance on the snapshot date, used only to reconcile the
  // computed result against the source. Never changes what is written.
  expectedVacationBalance?: number
  expectedSickBalance?: number
}

// One approved leave from the history sheet. Dates are ISO; a blank submitted
// date falls back to the start date and a blank approval date to the
// submission, which is how the trackers recorded leave that was agreed in
// person.
export interface LeaveHistoryImportRowDto {
  email: string
  leaveType: LeaveType
  startDate: string
  endDate: string
  submittedAt?: string
  approvedAt?: string
  approverEmail?: string
  // The tracker's own figure for what this leave COST, in days. Reconciliation
  // only: the engine prices the leave itself from the calendar and the hours
  // below. It is a cost rather than a count of dates because a date can be
  // booked for part of a day, and because the export writes the request's own
  // requestedDays here; for whole-day leave the two readings agree, which is
  // every row of every file written before leave could be booked by the hour.
  workingDays?: number
  // How many WHOLE HOURS of each date this leave took, keyed by ISO date. Only
  // dates that are not whole need an entry; an absent map means every working
  // date of the period is a full day, which is what the trackers recorded
  // before day-offs were kept in hours.
  //
  // In the workbook this is ONE cell, a comma-separated `DATE:HOURS` list
  // (`2026-08-05:4,2026-08-06:2`), the spelling the availability query already
  // uses for the same shape. The web parser turns it into this map, so the
  // wire carries the same object the domain takes on submit.
  hoursByDate?: Record<string, number>
}

export type ImportRowIssueSeverity = 'error' | 'warning'

// A finding tied to a row (or to an employee, when rowIndex is absent).
// Errors block the employee; warnings travel with the preview and the result.
export interface ImportRowIssueDto {
  email: string
  rowIndex?: number
  severity: ImportRowIssueSeverity
  message: string
}

// A policy the run will mint, grouped from the terms tuples in the file. The
// engine dedups by terms fingerprint, so employees sharing terms share one
// policy — the preview names them so the operator can see the grouping before
// anything is created.
export interface PolicyToCreateDto {
  // The server's identity for this group of terms, OPAQUE to the client: it is
  // the only key that separates two offers sharing a vacation and sick base
  // (say "+2 every year" from "+5 every 3 years"), and rederiving it in the
  // browser would mean reimplementing the writer's canonicalization. The wizard
  // uses it as the React key, as the key of the operator's chosen names, and to
  // merge the same group across validation batches.
  termsFingerprint: string
  // The terms as the POLICY will hold them, quantized to the day the books
  // keep.
  vacationDaysPerYear: number
  sickDaysPerYear: number
  // The name the policy will REALLY be minted under: the one the file states
  // when it states one, else the derived suggestion, with a collision against
  // the catalog (and against the file's own earlier mints) already numbered
  // away (" (2)"). It replaced a `suggestedName` that named only the derived
  // form, which is exactly the value that could be a lie.
  plannedName: string
  // Who chose plannedName. 'file' means the row's own policy column, which the
  // server treats as authoritative.
  nameSource: 'file' | 'suggested'
  // Whether the wizard may offer a rename field for this group. NOT the same as
  // nameSource === 'suggested': a derived name that another row of the file
  // points AT by name cannot be renamed either, since renaming it would split
  // the group at apply time.
  renameable: boolean
  memberEmails: string[]
}

// A policy that already exists and will simply take members.
export interface PolicyToReuseDto {
  policyId: string
  policyName: string
  // The terms of the POLICY, which after a name match are not the row's.
  vacationDaysPerYear: number
  sickDaysPerYear: number
  // Which rule joined it: the name the file states, or the terms the row
  // carries. A name match happens even when the terms disagree, and a row that
  // states a name can still be matched by TERMS: a live policy already holding
  // those terms under another name is joined before any name is minted.
  matchedBy: 'name' | 'terms'
  // The policy's validity window is closed, so the enrollment will refuse every
  // member listed here. The validation reports one blocking error per member,
  // so the run cannot start on it.
  retired: boolean
  // The row states terms the policy does not hold. The catalog wins; the
  // per-employee issues name the terms that disagree.
  termsDiffer: boolean
  memberEmails: string[]
}

export interface ImportValidationReportDto {
  // False when at least one error was found: the wizard blocks the preview
  // step until the file is fixed (or the offending rows are dropped).
  ok: boolean
  // Addresses with no account. The wizard offers a directory sync and a
  // re-validation; still unknown after that, the rows are ignored.
  unknownEmails: string[]
  // Employees the file names and the run can act on, in file order.
  employees: string[]
  issues: ImportRowIssueDto[]
  policiesToCreate: PolicyToCreateDto[]
  policiesToReuse: PolicyToReuseDto[]
  // How long a workday is (LeaveSettingsDto.hoursPerDay): the divisor for every
  // day figure the preview cards render. Carried on the validation report
  // because validation always runs first, and the import wizard is its own
  // route: it never fetches the settings endpoint that owns the figure.
  hoursPerDay: number
}

// What the run will do to one employee — the preview card's payload, and the
// same shape the apply returns once it has done it.
export interface ImportEmployeePlanDto {
  email: string
  displayName: string
  // Profile fields the run will write (absent when nothing changes).
  employmentStartDate?: string
  countryCode?: string
  policy: {
    policyName: string
    vacationDaysPerYear: number
    sickDaysPerYear: number
    // True while the policy is still to be minted (the batch creates it once,
    // however many employees share the terms).
    willBeCreated: boolean
    // Set when a hand-assigned policy timeline is left alone (add mode).
    keptExisting?: boolean
  }
  carriedOverVacationDays: number
  requests: ImportRequestOutcomeDto[]
  // Balances the engine computes once the replay is settled, next to the
  // figures the tracker expected.
  reconciliation: ImportReconciliationDto[]
  issues: ImportRowIssueDto[]
}

export interface ImportRequestOutcomeDto {
  leaveType: LeaveType
  startDate: string
  endDate: string
  // What the engine priced this leave at, in days (weekends and holidays
  // already excluded). An AMOUNT, not a count of dates: two half days are one
  // day of leave, so this is the figure the row's own workingDays is compared
  // against.
  workingDays: number
  // Days the balance could not fund, or that fall inside probation. Not a
  // failure: the engine books them unpaid, exactly as it would live.
  unpaidDays: number
  status: 'imported' | 'skipped'
  // Why a row was skipped (an overlap with leave already on record, most
  // often) — always set when status is 'skipped'.
  reason?: string
}

export interface ImportReconciliationDto {
  leaveType: LeaveType
  // Accrued minus spent as of the comparison day.
  computedBalance: number
  // Days already agreed for later dates. The system holds them; a hand-kept
  // tracker usually deducted them on approval, so the comparable figure is
  // computedBalance - committedDays.
  committedDays: number
  expectedBalance?: number
  // (computed - committed) - expected, when the file carried an expectation.
  delta?: number
  // The day the comparison was made on: the file's snapshot date when it gave
  // one, today otherwise.
  asOf: string
}

// Per-employee preview/apply result. A discriminated union so the wizard reads
// the outcome from the body, not from an HTTP status (the ldap-sync idiom).
export type ImportEmployeeResultDto =
  | { status: 'ok'; plan: ImportEmployeePlanDto }
  | { status: 'applied'; plan: ImportEmployeePlanDto }
  | { status: 'skipped'; email: string; reasons: string[] }
  | { status: 'failed'; email: string; message: string }

export interface ValidateImportRequestDto {
  fn: ImportFunction
  targetYear: number
  mode: ImportMode
  // The day the source file's balances were taken. The reconciliation is
  // computed as of this date, not as of today: a tracker exported on the 1st
  // and imported on the 6th differs by a month of accrual, and comparing the
  // two would report a discrepancy where there is none.
  snapshotDate?: string
  employees?: EmployeeImportRowDto[]
  history?: LeaveHistoryImportRowDto[]
}

// One employee's slice of the run: the wizard posts these one at a time, which
// keeps every request small, gives the operator live progress, and makes each
// employee its own transaction.
export interface ImportEmployeeRequestDto {
  fn: ImportFunction
  targetYear: number
  mode: ImportMode
  // See ValidateImportRequestDto.snapshotDate.
  snapshotDate?: string
  employee?: EmployeeImportRowDto
  history?: LeaveHistoryImportRowDto[]
  // The name the operator settled on for a policy about to be minted.
  policyName?: string
}

// The run summary, written to the audit trail when the wizard finishes.
export interface ImportBatchSummaryDto {
  fn: ImportFunction
  targetYear: number
  mode: ImportMode
  applied: string[]
  skipped: string[]
  failed: string[]
}
