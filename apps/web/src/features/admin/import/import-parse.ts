/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveType } from '@workspace/contracts'
import type {
  EmployeeImportRowDto,
  LeaveHistoryImportRowDto,
} from '@workspace/contracts'
import * as XLSX from 'xlsx'

/**
 * Reading the office trackers' converted file.
 *
 * ONE workbook carries the whole import: an **Employees** sheet (a row per
 * person: profile, policy terms, opening carryover) and a **Requests** sheet
 * (a row per leave). Keeping them as two sheets rather than one flat table is
 * deliberate — a person with twelve leaves would otherwise repeat their
 * profile twelve times, and the first disagreement between those copies would
 * have no honest answer. Keeping them in ONE book is equally deliberate: the
 * order can no longer be got wrong, and each employee's profile and leave are
 * applied together.
 *
 * Sheets are found by name, falling back to their headers, so a book saved
 * with translated tab names still reads. A book with only one of the two is
 * legitimate: profiles before the history is ready, or a later year's leave on
 * top of profiles already in place.
 *
 * Everything here is pure — no React, no fetch — so the mapping and its edge
 * cases are testable on their own, which matters because the failure mode of a
 * spreadsheet parser is silently reading the wrong column.
 */

// Structural problems: a missing column, an unreadable date, a row with no
// address. Reported per row (1-based, as the operator sees them in Excel) so
// the file can be fixed rather than guessed at.
export interface ParseIssue {
  row: number
  message: string
}

// Header spellings the converter produces, lowercased and stripped of the
// parenthetical hints and asterisks the reference files carry.
const EMPLOYEE_COLUMNS = {
  email: ['employee email'],
  displayName: ['full name'],
  employmentStartDate: ['employment start date'],
  countryCode: ['country'],
  holidayCalendarCountryCode: ['holiday calendar', 'work calendar', 'calendar'],
  vacationDaysPerYear: ['vacation days/year', 'vacation days per year'],
  sickDaysPerYear: ['sick days/year', 'sick days per year'],
  vacationAnnualIncrement: ['annual increase', 'annual increment'],
  // The cadence of the rise. Blank is every year, which is what every file
  // written before the period existed means.
  vacationIncrementEveryYears: [
    'increase every',
    'increment every',
    'increase period',
  ],
  vacationIncrementCapDays: [
    'vacation ceiling',
    'increase cap',
    'increment cap',
  ],
  probationMonths: ['probation'],
  paidSickDuringProbation: ['paid sick during probation', 'sick paid during'],
  policyName: ['leave policy', 'policy name'],
  // What the stated terms should grant for the TARGET year - a reference the
  // validation recomputes from base, increment, period and cap, so a
  // hand-written seniority ladder is proven against the tracker's figure.
  expectedYearVacationDays: [
    'year vacation norm',
    'year norm',
    'vacation norm for',
  ],
  carriedOverVacationDays: ['vacation days carried'],
  expectedVacationBalance: ['expected vacation balance'],
  expectedSickBalance: ['expected sick balance'],
} as const

const HISTORY_COLUMNS = {
  email: ['employee email'],
  leaveType: ['type'],
  startDate: ['start date'],
  endDate: ['end date'],
  submittedAt: ['submitted on'],
  approvedAt: ['approved on'],
  approverEmail: ['approved by'],
  workingDays: ['working days'],
  hoursByDate: ['hours', 'part-day hours', 'part day hours'],
} as const

// Columns the reference workbook carries for the operator's eyes only. Naming
// them is what lets the unrecognized-column warning stay quiet about the ones
// that are ignored on purpose and loud about everything else.
const COMMENTARY_COLUMNS = ['comment', 'note', 'примечание', 'коментар']

type ColumnMap<TKey extends string> = Partial<Record<TKey, number>>

const normalizeHeader = (value: unknown): string =>
  String(value ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const matchColumns = <TKey extends string>(
  header: unknown[],
  spec: Record<TKey, readonly string[]>,
): ColumnMap<TKey> => {
  const map: ColumnMap<TKey> = {}
  header.forEach((cell, index) => {
    const label = normalizeHeader(cell)
    if (!label) {
      return
    }
    for (const key of Object.keys(spec) as TKey[]) {
      if (map[key] !== undefined) {
        continue
      }
      if (spec[key].some((candidate) => label.startsWith(candidate))) {
        map[key] = index
      }
    }
  })
  return map
}

const cell = (row: unknown[], index: number | undefined): unknown =>
  index === undefined ? undefined : row[index]

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim()

/**
 * A text cell that should be blank when it holds nothing. Spreadsheets are
 * generous with zeros — a cleared cell in a numeric-looking column, a formula
 * that resolved to nothing, a column filled down one row too far — and a "0"
 * read as an address produced "No account for approver 0" on every such row.
 */
const optionalText = (value: unknown): string | undefined => {
  const raw = text(value)
  return raw === '' || raw === '0' ? undefined : raw
}

/**
 * A yes/no cell. Spreadsheets carry these as anything from a checkbox's TRUE
 * to a hand-typed "yes", and an unreadable one means "not stated" rather than
 * "no" — the caller decides what absence means.
 */
const boolean = (value: unknown): boolean | undefined => {
  const raw = text(value).toLowerCase()
  if (raw === '') {
    return undefined
  }
  if (['true', 'yes', 'y', '1', 'да', '+'].includes(raw)) {
    return true
  }
  if (['false', 'no', 'n', '0', 'нет', '-'].includes(raw)) {
    return false
  }
  return undefined
}

const number = (value: unknown): number | undefined => {
  const raw = text(value).replace(',', '.')
  if (raw === '') {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

// Where a numeric cell sits, for the issue an unreadable one raises: the row
// as the operator sees it in Excel, and whose row it is.
interface CellContext {
  row: number
  email: string
  issues: ParseIssue[]
}

/**
 * THE reader for every numeric column. A cell that holds something this cannot
 * read is REPORTED, never dropped: the office trackers carry free text in
 * numeric columns ("7,5 дн.", "—", "1 234", "50%"), and a dropped value travels
 * as an absent field, which the server reads as nothing: a carryover of 7.5
 * days becomes an employee opening the year with none, silently. A genuinely
 * EMPTY cell still means absent, which is how an optional column is left out.
 */
const numberCell = (
  value: unknown,
  column: string,
  context: CellContext,
): number | undefined => {
  const parsed = number(value)
  if (parsed === undefined && text(value) !== '') {
    context.issues.push({
      row: context.row,
      message: `${context.email}: the "${column}" cell reads "${text(value)}", which is not a number, so it was NOT read. Write a plain figure like 7.5, or leave the cell empty.`,
    })
  }
  return parsed
}

/**
 * Dates arrive two ways: as the text the converter writes (YYYY-MM-DD), or as
 * an Excel serial number if someone opened the file and let the spreadsheet
 * "helpfully" reformat a column. Both are accepted; anything else is reported
 * rather than guessed, because a misread date silently books leave on the
 * wrong days.
 */
const isoDate = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (value instanceof Date) {
    return serialToIso(XLSX.SSF.parse_date_code(dateToSerial(value)))
  }
  // A cleared cell in a date column comes back as 0, which Excel's calendar
  // reads as "day zero of 1900". Left alone it became a submission date of
  // 1900-01-00, and the engine then refused the row with "employment starts
  // on ..." — a baffling message for a file that names no date at all.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? serialToIso(XLSX.SSF.parse_date_code(value)) : undefined
  }
  const raw = text(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }
  const dotted = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (dotted) {
    return `${dotted[3]}-${dotted[2]!.padStart(2, '0')}-${dotted[1]!.padStart(2, '0')}`
  }
  return undefined
}

/**
 * The part-day cell: `2026-08-05:4,2026-08-06:2`, whole hours per date. ONE
 * cell rather than a column per date, because a leave's shape has to fit a
 * spreadsheet row somebody edits by hand, and this is the spelling the same
 * map already travels under on the availability query.
 *
 * Returns an error STRING rather than a partial map: a cell that cannot be read
 * says nothing trustworthy about the shape of the absence, and reading it as
 * whole days would import more leave than the tracker recorded. Only the
 * spelling is judged here: whether the hours fit the workday, and whether the
 * dates are ones the period actually charges, are the server's checks, because
 * only it knows how long a workday is and which dates are holidays.
 */
const hoursList = (
  value: unknown,
): { hoursByDate?: Record<string, number>; error?: string } => {
  const raw = text(value)
  if (raw === '') {
    return {}
  }
  const hoursByDate: Record<string, number> = {}
  for (const pair of raw.split(',')) {
    // A trailing or doubled comma loses nothing, so it is not worth refusing a
    // row over; everything else must be a readable pair.
    if (text(pair) === '') {
      continue
    }
    const parts = pair.split(':')
    if (parts.length !== 2) {
      return { error: pair.trim() }
    }
    const date = isoDate(text(parts[0]))
    const hours = text(parts[1])
    if (!date || !/^\d+$/.test(hours) || Number(hours) < 1) {
      return { error: pair.trim() }
    }
    // One date, one figure: a repeated date means the cell states two different
    // lengths for the same day, and taking the last would silently pick one.
    if (hoursByDate[date] !== undefined) {
      return { error: pair.trim() }
    }
    hoursByDate[date] = Number(hours)
  }
  return Object.keys(hoursByDate).length > 0 ? { hoursByDate } : {}
}

const dateToSerial = (date: Date): number =>
  (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000

const serialToIso = (
  parsed: { y: number; m: number; d: number } | null,
): string | undefined => {
  // Day zero and the 1900 epoch itself are artefacts of an empty cell, never a
  // date anybody typed.
  if (!parsed || parsed.d < 1 || parsed.y < 1970) {
    return undefined
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}`
}


// A trailing note ("Generated from the tracker on ...") sits in the first
// column with the rest of the row empty. Skipping it silently is safe, and
// distinguishing it from a typo matters: a row that fills several columns but
// carries no address is a mistake worth reporting, not a comment.
const isNoteRow = (raw: unknown[], email: string): boolean =>
  !email.includes('@') &&
  raw.filter((value) => text(value) !== '').length <= 1

const readSheet = (
  workbook: XLSX.WorkBook,
  name: string | undefined,
): unknown[][] => {
  if (!name) {
    return []
  }
  const sheet = workbook.Sheets[name]
  if (!sheet) {
    return []
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
  })
}

const headerOf = (workbook: XLSX.WorkBook, name: string): unknown[] =>
  readSheet(workbook, name)[0] ?? []

/**
 * Which tab holds what. The reference workbook names them Employees and
 * Requests; anything else is matched on the header row, so a renamed tab is
 * still found and an Instructions tab is never mistaken for data.
 */
const locateSheets = (
  workbook: XLSX.WorkBook,
): { employees?: string; requests?: string } => {
  const byName = (candidates: string[]): string | undefined =>
    workbook.SheetNames.find((name) =>
      candidates.includes(name.trim().toLowerCase()),
    )
  const located = {
    employees: byName(['employees', 'employee', 'сотрудники']),
    requests: byName(['requests', 'request', 'leave', 'заявки']),
  }
  for (const name of workbook.SheetNames) {
    if (name === located.employees || name === located.requests) {
      continue
    }
    const header = headerOf(workbook, name)
    const columns = matchColumns(header, EMPLOYEE_COLUMNS)
    const requestColumns = matchColumns(header, HISTORY_COLUMNS)
    // The type column is what separates the two: only a leave row declares
    // vacation or sick.
    if (!located.requests && requestColumns.leaveType !== undefined) {
      located.requests = name
      continue
    }
    if (!located.employees && columns.employmentStartDate !== undefined) {
      located.employees = name
    }
  }
  return located
}

export interface ParsedImportWorkbook {
  employees: EmployeeImportRowDto[]
  history: LeaveHistoryImportRowDto[]
  issues: ParseIssue[]
  // Which sheets were actually found, so the page can say what it read.
  sheets: { employees?: string; requests?: string }
}

/** The whole import in one read: both sheets, in one pass. */
export const parseImportWorkbook = (
  data: ArrayBuffer,
): ParsedImportWorkbook => {
  const workbook = XLSX.read(data, { type: 'array', cellDates: false })
  const sheets = locateSheets(workbook)
  const issues: ParseIssue[] = []

  const employees = sheets.employees
    ? parseEmployeeRows(readSheet(workbook, sheets.employees), issues)
    : []
  const history = sheets.requests
    ? parseHistoryRows(readSheet(workbook, sheets.requests), issues)
    : []

  if (!sheets.employees && !sheets.requests) {
    issues.push({
      row: 1,
      message:
        'Neither an Employees nor a Requests sheet was found. Use the reference workbook as the template.',
    })
  }
  return { employees, history, issues, sheets }
}

const missingColumns = <TKey extends string>(
  map: ColumnMap<TKey>,
  required: readonly TKey[],
): TKey[] => required.filter((key) => map[key] === undefined)

/**
 * Columns that carry values nobody read. A required column missing is caught
 * above; the dangerous case is an OPTIONAL one whose header drifted — the
 * policy ceiling spelled "Vacation ceiling with the increase" against a
 * mapping that only knew "Increase cap" was dropped without a word, and the
 * import then minted an uncapped policy that grew a 25-day offer to 31. A
 * value present in the file and absent from the run must never be silent.
 */
const unreadColumns = <TKey extends string>(
  sheet: unknown[][],
  map: ColumnMap<TKey>,
): string[] => {
  const read = new Set(Object.values(map) as number[])
  const labels: string[] = []
  ;(sheet[0] ?? []).forEach((header, index) => {
    const label = normalizeHeader(header)
    if (
      !label ||
      read.has(index) ||
      COMMENTARY_COLUMNS.some((ignored) => label.startsWith(ignored))
    ) {
      return
    }
    // A header with nothing under it is an empty template column, not a loss.
    if (sheet.slice(1).some((row) => text(row[index]) !== '')) {
      labels.push(label)
    }
  })
  return labels
}

const reportUnreadColumns = <TKey extends string>(
  sheet: unknown[][],
  map: ColumnMap<TKey>,
  sheetName: string,
  issues: ParseIssue[],
): void => {
  const unread = unreadColumns(sheet, map)
  if (unread.length > 0) {
    issues.push({
      row: 1,
      message: `The ${sheetName} sheet has column(s) this import does not recognize, and their values were NOT read: ${unread.join(', ')}. Check the spelling against the reference workbook.`,
    })
  }
}

const parseEmployeeRows = (
  sheet: unknown[][],
  issues: ParseIssue[],
): EmployeeImportRowDto[] => {
  const rows: EmployeeImportRowDto[] = []
  const header = sheet[0] ?? []
  const map = matchColumns(header, EMPLOYEE_COLUMNS)
  const missing = missingColumns(map, [
    'email',
    'employmentStartDate',
    'countryCode',
    'vacationDaysPerYear',
    'sickDaysPerYear',
  ])
  if (missing.length > 0) {
    issues.push({
      row: 1,
      message: `The Employees sheet is missing these columns: ${missing.join(', ')}. Use the reference workbook as the template.`,
    })
    return rows
  }
  reportUnreadColumns(sheet, map, 'Employees', issues)

  sheet.slice(1).forEach((raw, index) => {
    const rowNumber = index + 2
    const email = text(cell(raw, map.email))
    if (!email || isNoteRow(raw, email)) {
      return
    }
    const startDate = isoDate(cell(raw, map.employmentStartDate))
    if (!startDate) {
      issues.push({
        row: rowNumber,
        message: `${email}: the employment start date is missing or unreadable.`,
      })
      return
    }
    const at: CellContext = { row: rowNumber, email, issues }
    const vacation = numberCell(
      cell(raw, map.vacationDaysPerYear),
      'Vacation days/year',
      at,
    )
    const sick = numberCell(
      cell(raw, map.sickDaysPerYear),
      'Sick days/year',
      at,
    )
    // The policy terms come from nowhere else, so without them there is no row
    // to import. An unreadable cell was named just above; this states what it
    // cost, and covers the blank cell that says nothing at all.
    if (vacation === undefined || sick === undefined) {
      issues.push({
        row: rowNumber,
        message: `${email}: the vacation and sick allowances must both be numbers.`,
      })
      return
    }
    rows.push({
      email,
      displayName: optionalText(cell(raw, map.displayName)),
      employmentStartDate: startDate,
      countryCode: text(cell(raw, map.countryCode)).toUpperCase(),
      holidayCalendarCountryCode: optionalText(
        cell(raw, map.holidayCalendarCountryCode),
      )?.toUpperCase(),
      vacationDaysPerYear: vacation,
      sickDaysPerYear: sick,
      // The rest of the offer, all optional: a blank column set means a flat
      // policy, which is what most of them are.
      vacationAnnualIncrement: numberCell(
        cell(raw, map.vacationAnnualIncrement),
        'Annual increase',
        at,
      ),
      vacationIncrementEveryYears: numberCell(
        cell(raw, map.vacationIncrementEveryYears),
        'Increase every',
        at,
      ),
      vacationIncrementCapDays: numberCell(
        cell(raw, map.vacationIncrementCapDays),
        'Increase cap',
        at,
      ),
      probationMonths: numberCell(
        cell(raw, map.probationMonths),
        'Probation',
        at,
      ),
      paidSickDuringProbation: boolean(cell(raw, map.paidSickDuringProbation)),
      // A named policy that already exists wins over the terms; see the
      // contract note on EmployeeImportRowDto.
      policyName: optionalText(cell(raw, map.policyName)),
      expectedYearVacationDays: numberCell(
        cell(raw, map.expectedYearVacationDays),
        'Year vacation norm',
        at,
      ),
      carriedOverVacationDays: numberCell(
        cell(raw, map.carriedOverVacationDays),
        'Vacation days carried over',
        at,
      ),
      expectedVacationBalance: numberCell(
        cell(raw, map.expectedVacationBalance),
        'Expected vacation balance',
        at,
      ),
      expectedSickBalance: numberCell(
        cell(raw, map.expectedSickBalance),
        'Expected sick balance',
        at,
      ),
    })
  })

  return rows
}

const LEAVE_TYPES: Record<string, LeaveType> = {
  vacation: LeaveType.Vacation,
  sick: LeaveType.Sick,
}

const parseHistoryRows = (
  sheet: unknown[][],
  issues: ParseIssue[],
): LeaveHistoryImportRowDto[] => {
  const rows: LeaveHistoryImportRowDto[] = []
  const header = sheet[0] ?? []
  const map = matchColumns(header, HISTORY_COLUMNS)
  const missing = missingColumns(map, [
    'email',
    'leaveType',
    'startDate',
    'endDate',
  ])
  if (missing.length > 0) {
    issues.push({
      row: 1,
      message: `The Requests sheet is missing these columns: ${missing.join(', ')}. Use the reference workbook as the template.`,
    })
    return rows
  }
  reportUnreadColumns(sheet, map, 'Requests', issues)

  sheet.slice(1).forEach((raw, index) => {
    const rowNumber = index + 2
    const email = text(cell(raw, map.email))
    if (!email || isNoteRow(raw, email)) {
      return
    }
    const leaveType = LEAVE_TYPES[text(cell(raw, map.leaveType)).toLowerCase()]
    if (!leaveType) {
      issues.push({
        row: rowNumber,
        message: `${email}: the leave type must be either vacation or sick.`,
      })
      return
    }
    const startDate = isoDate(cell(raw, map.startDate))
    const endDate = isoDate(cell(raw, map.endDate))
    if (!startDate || !endDate) {
      issues.push({
        row: rowNumber,
        message: `${email}: the start and end dates must both be readable dates.`,
      })
      return
    }
    const hours = hoursList(cell(raw, map.hoursByDate))
    if (hours.error !== undefined) {
      issues.push({
        row: rowNumber,
        message: `${email}: the hours cell could not be read at "${hours.error}". Write it as a comma-separated list of date:hours pairs, for example 2026-08-05:4,2026-08-06:2, or leave it blank for whole days.`,
      })
      return
    }
    rows.push({
      email,
      leaveType,
      startDate,
      endDate,
      submittedAt: isoDate(cell(raw, map.submittedAt)),
      approvedAt: isoDate(cell(raw, map.approvedAt)),
      approverEmail: optionalText(cell(raw, map.approverEmail)),
      workingDays: numberCell(cell(raw, map.workingDays), 'Working days', {
        row: rowNumber,
        email,
        issues,
      }),
      // Absent, not empty: an empty map would travel to the server as "every
      // date is whole", which is the same reading but a different payload, and
      // the domain treats an absent map as the ordinary case.
      ...(hours.hoursByDate ? { hoursByDate: hours.hoursByDate } : {}),
    })
  })

  return rows
}
