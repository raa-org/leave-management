/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  EmployeeProfileStatus,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import type {
  AdminEmployeeDetailDto,
  LeaveBalanceDto,
  LeavePolicyDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import * as XLSX from 'xlsx'
import { parseImportWorkbook } from './import-parse'
import {
  EMPLOYEE_EXPORT_HEADERS,
  HISTORY_EXPORT_HEADERS,
  buildExportSheets,
  exportWorkbookFilename,
} from './export-workbook'
import type { ExportEmployeeSource, ExportSheets } from './export-workbook'

// The export's one promise is the round trip: a file written here reads back
// through parseImportWorkbook issue-free with the same values. So the tests
// do exactly that — write the sheets into a real workbook and hand it to the
// real parser, rather than asserting cell positions the parser might not
// share.

const toWorkbookBuffer = (sheets: ExportSheets): ArrayBuffer => {
  const book = XLSX.utils.book_new()
  if (sheets.employees) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet(sheets.employees),
      'Employees',
    )
  }
  if (sheets.requests) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet(sheets.requests),
      'Requests',
    )
  }
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

const balance = (
  leaveType: LeaveType,
  overrides: Partial<LeaveBalanceDto> = {},
): LeaveBalanceDto => ({
  leaveType,
  totalDays: 25,
  availableDays: 10,
  onHoldDays: 0,
  spentDays: 0,
  accruedDays: 10,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
})

const request = (
  overrides: Partial<LeaveRequestDetailDto> = {},
): LeaveRequestDetailDto => ({
  requestId: 'request-1',
  leaveType: LeaveType.Vacation,
  status: LeaveRequestStatus.Approved,
  startDate: '2026-03-02',
  endDate: '2026-03-06',
  requestedDays: 5,
  paidDays: 5,
  unpaidDays: 0,
  heldDays: 0,
  submittedAt: '2026-02-20T10:00:00.000Z',
  requesterUserId: 'user-1',
  requesterDisplayName: 'Anna Ivanova',
  approvers: [],
  activity: [],
  balanceTimeline: [],
  unpaidDates: [],
  hoursPerDay: 8,
  ...overrides,
})

const detail = (
  overrides: Partial<AdminEmployeeDetailDto> = {},
): AdminEmployeeDetailDto => ({
  employeeId: 'employee-1',
  displayName: 'Anna Ivanova',
  email: 'anna@example.com',
  roleNames: [AppRoleName.Employee],
  active: true,
  profileStatus: EmployeeProfileStatus.Ready,
  employmentStartDate: '2020-03-02',
  countryCode: 'UA',
  projects: [],
  policyId: 'policy-1',
  policyName: 'Standard UA',
  balances: [balance(LeaveType.Vacation), balance(LeaveType.Sick)],
  requestHistory: [],
  balanceTimeline: [],
  generatedAt: '2026-08-01T00:00:00.000Z',
  hoursPerDay: 8,
  ...overrides,
})

const policy = (overrides: Partial<LeavePolicyDto> = {}): LeavePolicyDto => ({
  policyId: 'policy-1',
  name: 'Standard UA',
  vacationDays: 25,
  sickDays: 5,
  vacationAnnualIncrement: 0,
  vacationIncrementEveryYears: 1,
  probationMonths: 0,
  paidSickDuringProbation: false,
  effectiveFrom: '2020-01-01',
  isDefault: false,
  termsFingerprint: 'fp-1',
  memberCount: 1,
  scheduledInCount: 0,
  createdAt: '2020-01-01T00:00:00.000Z',
  ...overrides,
})

const approvedByManager = [
  {
    email: 'cc@example.com',
    kind: ApproverKind.Cc,
    decision: ApproverDecision.Pending,
  },
  {
    email: 'manager@example.com',
    kind: ApproverKind.To,
    decision: ApproverDecision.Approved,
    decidedAt: '2026-02-21T08:00:00.000Z',
  },
]

// The full-featured person: every optional term set, carryover, and a history
// that mixes in-year approved leave with rows the export must skip.
const anna = (): ExportEmployeeSource => ({
  detail: detail({
    // Assigned calendar differing from the country: must survive the
    // export-import round trip, or the re-imported profile would silently
    // fall back to the country's holidays.
    holidayCalendarCountryCode: 'PL',
    balances: [
      balance(LeaveType.Vacation, {
        accruedDays: 16.33,
        spentDays: 5,
        onHoldDays: 2,
        carriedOverDays: 7,
      }),
      balance(LeaveType.Sick, {
        accruedDays: 5,
        spentDays: 1,
        onHoldDays: 0,
      }),
    ],
    requestHistory: [
      request({
        requestId: 'request-1',
        startDate: '2026-03-02',
        endDate: '2026-03-06',
        submittedAt: '2026-02-20T10:00:00.000Z',
        decidedAt: '2026-02-21T08:00:00.000Z',
        approvers: approvedByManager,
      }),
      // In-year and approved, but nobody's yes on record and no settle date:
      // both cells must come out blank, not invented.
      request({
        requestId: 'request-2',
        leaveType: LeaveType.Sick,
        startDate: '2026-01-12',
        endDate: '2026-01-13',
        requestedDays: 2,
        submittedAt: '2026-01-10T09:00:00.000Z',
        approvers: [
          {
            email: 'manager@example.com',
            kind: ApproverKind.To,
            decision: ApproverDecision.Pending,
          },
        ],
      }),
      // Still pending — not history yet.
      request({
        requestId: 'request-3',
        status: LeaveRequestStatus.Pending,
        startDate: '2026-09-07',
        endDate: '2026-09-11',
      }),
      // Approved, but the year before the one being exported.
      request({
        requestId: 'request-4',
        startDate: '2025-07-01',
        endDate: '2025-07-04',
        requestedDays: 4,
        submittedAt: '2025-06-20T10:00:00.000Z',
      }),
    ],
  }),
  policy: policy({
    vacationAnnualIncrement: 1,
    vacationIncrementCapDays: 30,
    probationMonths: 3,
    paidSickDuringProbation: true,
  }),
})

// No employment start date: no Employees row can be written, but the leave on
// record is still real history.
const boris = (): ExportEmployeeSource => ({
  detail: detail({
    employeeId: 'employee-2',
    displayName: 'Boris Petrov',
    email: 'boris@example.com',
    employmentStartDate: undefined,
    requestHistory: [
      request({
        requestId: 'request-5',
        startDate: '2026-05-04',
        endDate: '2026-05-08',
        submittedAt: '2026-04-20T10:00:00.000Z',
        decidedAt: '2026-04-21T08:00:00.000Z',
        approvers: approvedByManager,
      }),
    ],
  }),
  policy: policy(),
})

const ALL_ON = {
  year: 2026,
  includeEmployees: true,
  includeBalances: true,
  includeHistory: true,
}

describe('export headers', () => {
  it('pins the template spellings, hints included, that the parser resolves', () => {
    // The parenthetical hints and required-markers are template guidance for a
    // human editing the file; normalizeHeader strips them before matching, and
    // the round-trip test below proves every column still resolves.
    expect(EMPLOYEE_EXPORT_HEADERS).toEqual([
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
    ])
    expect(HISTORY_EXPORT_HEADERS).toEqual([
      'Employee email *',
      'Type * (vacation / sick)',
      'Start date * (YYYY-MM-DD)',
      'End date * (YYYY-MM-DD)',
      'Submitted on (blank = start date)',
      'Approved on (blank = submitted)',
      'Approved by, email (blank = defaults)',
      'Working days (for reconciliation)',
      'Hours (date:hours, blank = whole days)',
    ])
  })
})

describe('buildExportSheets', () => {
  it('round-trips a stepped rise, so a reset and re-import keeps the cadence', () => {
    // The export IS the restore path: a period dropped here would come back as
    // "+5 every year" and grant three times the growth.
    const sheets = buildExportSheets(
      [
        {
          ...anna(),
          policy: policy({
            vacationDays: 15,
            vacationAnnualIncrement: 5,
            vacationIncrementEveryYears: 3,
            vacationIncrementCapDays: 30,
          }),
        },
      ],
      ALL_ON,
    )
    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]).toMatchObject({
      vacationDaysPerYear: 15,
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
      vacationIncrementCapDays: 30,
    })
  })

  it('round-trips through the import parser without a single issue', () => {
    const sheets = buildExportSheets([anna(), boris()], ALL_ON)
    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))

    expect(parsed.issues).toEqual([])
    expect(parsed.sheets).toEqual({
      employees: 'Employees',
      requests: 'Requests',
    })

    // Anna comes back exactly as she went in; Boris wrote no profile row.
    expect(parsed.employees).toEqual([
      {
        email: 'anna@example.com',
        displayName: 'Anna Ivanova',
        employmentStartDate: '2020-03-02',
        countryCode: 'UA',
        holidayCalendarCountryCode: 'PL',
        vacationDaysPerYear: 25,
        sickDaysPerYear: 5,
        vacationAnnualIncrement: 1,
        vacationIncrementCapDays: 30,
        probationMonths: 3,
        paidSickDuringProbation: true,
        policyName: 'Standard UA',
        carriedOverVacationDays: 7,
        // accrued - spent - held, rounded past the float dust:
        // 16.33 - 5 - 2 and 5 - 1 - 0.
        expectedVacationBalance: 9.33,
        expectedSickBalance: 4,
      },
    ])
    expect(sheets.leftOut).toEqual(['boris@example.com'])

    // Only the in-year approved leave, chronological, Boris's included.
    expect(parsed.history).toEqual([
      {
        email: 'anna@example.com',
        leaveType: LeaveType.Sick,
        startDate: '2026-01-12',
        endDate: '2026-01-13',
        submittedAt: '2026-01-10',
        approvedAt: undefined,
        approverEmail: undefined,
        workingDays: 2,
      },
      {
        email: 'anna@example.com',
        leaveType: LeaveType.Vacation,
        startDate: '2026-03-02',
        endDate: '2026-03-06',
        submittedAt: '2026-02-20',
        approvedAt: '2026-02-21',
        approverEmail: 'manager@example.com',
        workingDays: 5,
      },
      {
        email: 'boris@example.com',
        leaveType: LeaveType.Vacation,
        startDate: '2026-05-04',
        endDate: '2026-05-08',
        submittedAt: '2026-04-20',
        approvedAt: '2026-04-21',
        approverEmail: 'manager@example.com',
        workingDays: 5,
      },
    ])
    expect(sheets.requestCount).toBe(3)
  })

  it('round-trips a part-day request as the hours it was booked for', () => {
    // The restore path: reset, then re-import the exported book. Without the
    // hours cell every shortened day would come back whole, and the balance
    // would be short by the difference for good.
    const source = anna()
    source.detail.requestHistory = [
      request({
        requestId: 'request-6',
        startDate: '2026-03-02',
        endDate: '2026-03-06',
        // Tuesday half a day, Wednesday two hours; the other three whole.
        dayPortions: { '2026-03-04': 0.25, '2026-03-03': 0.5 },
        requestedDays: 3.75,
        submittedAt: '2026-02-20T10:00:00.000Z',
        decidedAt: '2026-02-21T08:00:00.000Z',
        approvers: approvedByManager,
      }),
    ]
    const sheets = buildExportSheets([source], ALL_ON)
    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))

    expect(parsed.issues).toEqual([])
    expect(parsed.history).toEqual([
      {
        email: 'anna@example.com',
        leaveType: LeaveType.Vacation,
        startDate: '2026-03-02',
        endDate: '2026-03-06',
        submittedAt: '2026-02-20',
        approvedAt: '2026-02-21',
        approverEmail: 'manager@example.com',
        // The COST, not the five dates the period covers.
        workingDays: 3.75,
        // Calendar order, whatever order the portions arrived in, and back as
        // the whole hours the domain will re-freeze into the same portions.
        hoursByDate: { '2026-03-03': 4, '2026-03-04': 2 },
      },
    ])
    // The cell itself, so the file a person opens reads as the parser's list.
    const hoursCell = HISTORY_EXPORT_HEADERS.length - 1
    expect(sheets.requests?.[1]?.[hoursCell]).toBe('2026-03-03:4,2026-03-04:2')
  })

  it('round-trips a carryover that carries an accrual remainder', () => {
    // The other half of the restore cycle: accrual mints twelfths of a day, so
    // allocation.carriedOverDays is routinely a figure like 14.583 (25 * 7/12)
    // and that is what this column writes. Read back as anything else, or
    // refused on the way in, the reset-and-reimport path loses the remainder.
    const source = anna()
    source.detail.balances = [
      balance(LeaveType.Vacation, {
        accruedDays: 14.583,
        carriedOverDays: 14.583,
      }),
      balance(LeaveType.Sick),
    ]
    const parsed = parseImportWorkbook(
      toWorkbookBuffer(buildExportSheets([source], ALL_ON)),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]?.carriedOverVacationDays).toBe(14.583)
  })

  it('writes a blank hours cell for a leave of whole days', () => {
    const sheets = buildExportSheets([anna()], ALL_ON)

    const hoursCell = HISTORY_EXPORT_HEADERS.length - 1
    expect(sheets.requests?.slice(1).map((row) => row[hoursCell])).toEqual([
      '',
      '',
    ])
    expect(
      parseImportWorkbook(toWorkbookBuffer(sheets)).history.every(
        (row) => row.hoursByDate === undefined,
      ),
    ).toBe(true)
  })

  it('leaves a person without a policy out of the roster but keeps their leave', () => {
    const source = anna()
    const sheets = buildExportSheets([{ detail: source.detail }], ALL_ON)
    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))

    expect(sheets.leftOut).toEqual(['anna@example.com'])
    expect(parsed.employees).toEqual([])
    expect(parsed.history).toHaveLength(2)
  })

  it('writes blank expectation cells when balances are excluded', () => {
    const sheets = buildExportSheets([anna()], {
      ...ALL_ON,
      includeBalances: false,
    })
    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]).toMatchObject({
      expectedVacationBalance: undefined,
      expectedSickBalance: undefined,
      // The factual carryover is not an expectation — it stays.
      carriedOverVacationDays: 7,
    })
  })

  it('omits the Employees sheet entirely when the roster is excluded', () => {
    const sheets = buildExportSheets([anna(), boris()], {
      ...ALL_ON,
      includeEmployees: false,
    })

    expect(sheets.employees).toBeUndefined()
    // Nobody is left out of a file that lists nobody.
    expect(sheets.leftOut).toEqual([])

    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))
    expect(parsed.sheets.employees).toBeUndefined()
    expect(parsed.employees).toEqual([])
    expect(parsed.history).toHaveLength(3)
    expect(parsed.issues).toEqual([])
  })

  it('omits the Requests sheet entirely when history is excluded', () => {
    const sheets = buildExportSheets([anna()], {
      ...ALL_ON,
      includeHistory: false,
    })

    expect(sheets.requests).toBeUndefined()
    expect(sheets.requestCount).toBe(0)

    const parsed = parseImportWorkbook(toWorkbookBuffer(sheets))
    expect(parsed.sheets.requests).toBeUndefined()
    expect(parsed.history).toEqual([])
    expect(parsed.employees).toHaveLength(1)
    expect(parsed.issues).toEqual([])
  })

  it('returns no sheets at all when both are excluded', () => {
    const sheets = buildExportSheets([anna()], {
      ...ALL_ON,
      includeEmployees: false,
      includeHistory: false,
    })

    expect(sheets).toEqual({
      employees: undefined,
      requests: undefined,
      leftOut: [],
      requestCount: 0,
    })
  })
})

describe('exportWorkbookFilename', () => {
  it('names the file for the year it covers', () => {
    expect(exportWorkbookFilename(2026)).toBe('leave-export-2026.xlsx')
  })
})
