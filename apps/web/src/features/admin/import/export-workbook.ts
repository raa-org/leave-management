/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ApproverDecision,
  ApproverKind,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import type {
  AdminEmployeeDetailDto,
  LeaveBalanceDto,
  LeavePolicyDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import {
  daysToWholeHours,
  partDayEntries,
  roundDays,
} from '../../../lib/leave-format'

/**
 * Writing the workbook the import reads.
 *
 * The export is the import's mirror: the same two sheets (Employees, Requests)
 * under the same headers import-parse.ts resolves, so a file written here
 * round-trips through parseImportWorkbook without a single issue. That is the
 * whole point — the export doubles as a template for the next import and as a
 * backup that can be replayed into a fresh system, and the only way to keep
 * that promise honest is to spell the columns exactly as the parser reads
 * them (the test feeds one into the other).
 *
 * Pure rows, no XLSX and no DOM: this module builds arrays-of-arrays and the
 * page's hook feeds them to XLSX.utils.aoa_to_sheet and does the write and the
 * download. Keeping the heavy dependency and the Blob plumbing out of here is
 * what leaves the mapping unit-testable in the node test environment, same as
 * employees-csv.ts. Unlike that CSV export, no formula-injection guard is
 * needed: an aoa string cell is written as a string cell, which Excel
 * displays but never evaluates — only a CSV leaves the cell type for the
 * spreadsheet to guess.
 */

// Canonical spellings of the import parser's candidate lists (matching there
// is case-insensitive and prefix-based, but the canon keeps the file readable
// as a template). Each array IS the sheet's header row.
// The hints in parentheses and the required-markers are for the human editing
// the file as a template: the parser strips `(...)` and `*` before matching
// (normalizeHeader), so these spellings still resolve to the same columns.
export const EMPLOYEE_EXPORT_HEADERS: readonly string[] = [
  'Employee email *',
  'Full name',
  'Employment start date (YYYY-MM-DD)',
  'Country (code)',
  'Holiday calendar (blank = country)',
  'Vacation days/year *',
  'Sick days/year *',
  'Annual increase (+days at each rise)',
  'Increase every (years, blank = every year)',
  'Increase cap (days)',
  'Probation (months)',
  'Paid sick during probation (yes/no)',
  'Leave policy',
  'Vacation days carried over (from the prior year)',
  'Expected vacation balance (as of the snapshot date)',
  'Expected sick balance (as of the snapshot date)',
]

export const HISTORY_EXPORT_HEADERS: readonly string[] = [
  'Employee email *',
  'Type * (vacation / sick)',
  'Start date * (YYYY-MM-DD)',
  'End date * (YYYY-MM-DD)',
  'Submitted on (blank = start date)',
  'Approved on (blank = submitted)',
  'Approved by, email (blank = defaults)',
  'Working days (for reconciliation)',
  'Hours (date:hours, blank = whole days)',
]

// One exportable person: the admin detail (profile, balances, history) plus
// the policy whose terms the Employees row states. The policy travels
// separately because the detail only names the policy — the terms live in the
// policy catalog.
export interface ExportEmployeeSource {
  detail: AdminEmployeeDetailDto
  policy?: LeavePolicyDto
}

export interface ExportOptions {
  // The leave year the Requests sheet covers (a request belongs to the year
  // its start date falls in, same as the import replays it).
  year: number
  includeEmployees: boolean
  includeBalances: boolean
  includeHistory: boolean
}

export interface ExportSheets {
  // Arrays-of-arrays, header row included, ready for aoa_to_sheet. A sheet the
  // options excluded is absent, not empty — the hook appends only what exists.
  employees?: Array<Array<string | number>>
  requests?: Array<Array<string | number>>
  // Emails that produced no Employees row (no start date, or no policy to take
  // the terms from) — surfaced so the page can say who the file is missing
  // instead of shipping a silently shorter roster.
  leftOut: string[]
  // Request rows written (header excluded), for the page's summary line.
  requestCount: number
}

/**
 * What the import's reconciliation expects to find on its snapshot date:
 * accrued minus spent minus held — the engine's computedBalance minus
 * committedDays. Deliberately NOT availableDays: that figure may be measured
 * against the year-end total rather than what has accrued so far, and the
 * reconciliation would then flag every mid-year export as off.
 *
 * Quantized to the books' own three decimals, so float dust from the pro-rata
 * accrual never lands in a cell and the figure still round-trips: leave is
 * bookable by the hour, and the two decimals this used to write turned one hour
 * of an eight-hour day (0.125) into 0.13 - a balance the import would then
 * reconcile against and report as off.
 */
const expectedBalance = (balance: LeaveBalanceDto): number =>
  roundDays(balance.accruedDays - balance.spentDays - balance.onHoldDays)

const employeeRow = (
  source: ExportEmployeeSource,
  options: ExportOptions,
): Array<string | number> | undefined => {
  const { detail, policy } = source
  // Without a start date the import cannot accrue, and without a policy there
  // are no terms to state — either way the row would fail validation, so the
  // person is reported (leftOut) rather than written half-empty.
  if (!detail.employmentStartDate || !policy) {
    return undefined
  }
  const vacation = detail.balances.find(
    (balance) => balance.leaveType === LeaveType.Vacation,
  )
  const sick = detail.balances.find(
    (balance) => balance.leaveType === LeaveType.Sick,
  )
  return [
    detail.email,
    detail.displayName,
    // Already the ISO yyyy-mm-dd string the parser's date reader accepts.
    detail.employmentStartDate,
    detail.countryCode ?? '',
    // The assigned working calendar; blank means "inherits the country", so
    // the export writes blank rather than repeating the country code.
    detail.holidayCalendarCountryCode ?? '',
    policy.vacationDays,
    policy.sickDays,
    // Zero means "no automatic revision" — the import spells that as a blank
    // column, so the export does too (a written 0 would read as a real term).
    policy.vacationAnnualIncrement || '',
    // Blank is every year, the reading of a file that has no such column at
    // all, so only a real period is written.
    policy.vacationIncrementEveryYears > 1
      ? policy.vacationIncrementEveryYears
      : '',
    policy.vacationIncrementCapDays ?? '',
    policy.probationMonths || '',
    policy.paidSickDuringProbation ? 'yes' : 'no',
    detail.policyName ?? policy.name,
    vacation?.carriedOverDays ?? '',
    options.includeBalances && vacation ? expectedBalance(vacation) : '',
    options.includeBalances && sick ? expectedBalance(sick) : '',
  ]
}

interface RequestRow {
  email: string
  startDate: string
  cells: Array<string | number>
}

const requestRows = (
  detail: AdminEmployeeDetailDto,
  year: number,
): RequestRow[] =>
  detail.requestHistory
    // Only settled, in-year leave: the import replays approved requests, and a
    // pending / rejected / cancelled row would be re-decided rather than
    // recorded. A request belongs to the year its start date opens.
    .filter(
      (request) =>
        request.status === LeaveRequestStatus.Approved &&
        request.startDate.startsWith(`${year}-`),
    )
    .map((request) => ({
      email: detail.email,
      startDate: request.startDate,
      cells: [
        detail.email,
        // The enum values ARE the parser's spellings (vacation / sick).
        request.leaveType,
        request.startDate,
        request.endDate,
        request.submittedAt.slice(0, 10),
        approvedOn(request),
        approvedBy(request),
        // The COST, which is what the reconciliation column means: a week with
        // one half day is 4.5, not 5.
        request.requestedDays,
        partDayHours(request, detail.hoursPerDay),
      ],
    }))

/**
 * The part-day shape as the parser's `date:hours` cell. Without it the reset
 * and re-import cycle that serves as this system's restore path would flatten
 * every shortened day back into a whole one.
 *
 * Built from the request's FROZEN portions through the CURRENT workday length,
 * which is the only divisor the file can carry. The two agree for every request
 * booked under the setting in force, and that is the round trip the export
 * promises. They stop agreeing if the org changes hoursPerDay after a request
 * was frozen: half a day exported under a seven-hour day is written as the 4
 * hours it rounds to, and re-imports as four sevenths. Nothing in a flat file
 * can preserve a fraction minted by a divisor that no longer exists, so the
 * shape is re-expressed in today's hours rather than silently mis-stated in
 * yesterday's.
 */
const partDayHours = (
  request: LeaveRequestDetailDto,
  hoursPerDay: number,
): string =>
  partDayEntries(request.dayPortions)
    .map(({ date, portion }) => `${date}:${daysToWholeHours(portion, hoursPerDay)}`)
    .join(',')

const approvedOn = (request: LeaveRequestDetailDto): string =>
  request.decidedAt?.slice(0, 10) ?? ''

// The first approver who actually said yes; cc recipients never decide, and a
// blank cell lets the import fall back to its default approver.
const approvedBy = (request: LeaveRequestDetailDto): string =>
  request.approvers.find(
    (approver) =>
      approver.kind === ApproverKind.To &&
      approver.decision === ApproverDecision.Approved,
  )?.email ?? ''

export function buildExportSheets(
  sources: ExportEmployeeSource[],
  options: ExportOptions,
): ExportSheets {
  const leftOut: string[] = []
  let employees: Array<Array<string | number>> | undefined
  if (options.includeEmployees) {
    employees = [[...EMPLOYEE_EXPORT_HEADERS]]
    for (const source of sources) {
      const row = employeeRow(source, options)
      if (row) {
        employees.push(row)
      } else {
        leftOut.push(source.detail.email)
      }
    }
  }

  let requests: Array<Array<string | number>> | undefined
  let requestCount = 0
  if (options.includeHistory) {
    // Every source contributes history — a person left out of the Employees
    // sheet still has real leave on record, and a history row needs nothing
    // but the address and the dates.
    const rows = sources.flatMap((source) =>
      requestRows(source.detail, options.year),
    )
    // Chronological, then by address: the same input always writes the same
    // file, and a person's leaves read together within each day.
    rows.sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        a.email.localeCompare(b.email),
    )
    requestCount = rows.length
    requests = [[...HISTORY_EXPORT_HEADERS], ...rows.map((row) => row.cells)]
  }

  return { employees, requests, leftOut, requestCount }
}

// Named for the year it covers, not the day it was made: two exports of the
// same year are the same file when nothing changed, and should collide.
export function exportWorkbookFilename(year: number): string {
  return `leave-export-${year}.xlsx`
}
