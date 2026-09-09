/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { LeaveType } from '@workspace/contracts'
import * as XLSX from 'xlsx'
import { parseImportWorkbook } from './import-parse'

// Reading a spreadsheet fails quietly when it fails at all: a shifted column
// or a date read as a number produces plausible rows that book leave on the
// wrong days. These pin the mapping against the real reference headers, and
// pin which tab is read as what.

const workbook = (sheets: Record<string, unknown[][]>): ArrayBuffer => {
  const book = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

const EMPLOYEE_HEADER = [
  'Employee email *',
  'Full name (reference)',
  'Employment start date *\n(YYYY-MM-DD)',
  'Country *\n(ISO-2)',
  'Vacation days/year *\n(policy terms)',
  'Sick days/year *\n(policy terms)',
  'Vacation days carried\ninto 2026-01-01\n(factual, verbatim)',
  'Expected vacation balance\nat 2026-08-01\n(reconciliation)',
]

const HISTORY_HEADER = [
  'Employee email *',
  'Type *\n(vacation / sick)',
  'Start date *\n(YYYY-MM-DD)',
  'End date *\n(YYYY-MM-DD)',
  'Submitted on\n(blank = start date)',
  'Approved on\n(blank = submitted)',
  'Approved by, email\n(blank = defaults)',
  'Working days\n(reconciliation)',
]

const EMPLOYEE_ROW = [
  'anna@example.com',
  'Anna Ivanova',
  '2020-03-02',
  'ua',
  25,
  5,
  7,
  14.5,
]

const HISTORY_ROW = [
  'anna@example.com',
  'vacation',
  '2026-03-02',
  '2026-03-06',
  '2026-02-20',
  '',
  'manager@example.com',
  5,
]

describe('parseImportWorkbook', () => {
  it('reads both sheets of one book and ignores the instructions tab', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [EMPLOYEE_HEADER, EMPLOYEE_ROW],
        Requests: [HISTORY_HEADER, HISTORY_ROW],
        Instructions: [['Fill this in'], ['Never data']],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.sheets).toEqual({
      employees: 'Employees',
      requests: 'Requests',
    })
    expect(parsed.employees).toEqual([
      {
        email: 'anna@example.com',
        displayName: 'Anna Ivanova',
        employmentStartDate: '2020-03-02',
        countryCode: 'UA',
        vacationDaysPerYear: 25,
        sickDaysPerYear: 5,
        carriedOverVacationDays: 7,
        expectedVacationBalance: 14.5,
        expectedSickBalance: undefined,
      },
    ])
    expect(parsed.history).toEqual([
      {
        email: 'anna@example.com',
        leaveType: LeaveType.Vacation,
        startDate: '2026-03-02',
        endDate: '2026-03-06',
        submittedAt: '2026-02-20',
        approvedAt: undefined,
        approverEmail: 'manager@example.com',
        workingDays: 5,
      },
    ])
  })

  it('finds renamed tabs by their headers', () => {
    const parsed = parseImportWorkbook(
      workbook({
        'Лист 1': [EMPLOYEE_HEADER, EMPLOYEE_ROW],
        'Лист 2': [HISTORY_HEADER, HISTORY_ROW],
      }),
    )

    expect(parsed.employees).toHaveLength(1)
    expect(parsed.history).toHaveLength(1)
    expect(parsed.sheets).toEqual({ employees: 'Лист 1', requests: 'Лист 2' })
  })

  it('accepts a book with only one of the two sheets', () => {
    const profilesOnly = parseImportWorkbook(
      workbook({ Employees: [EMPLOYEE_HEADER, EMPLOYEE_ROW] }),
    )
    const historyOnly = parseImportWorkbook(
      workbook({ Requests: [HISTORY_HEADER, HISTORY_ROW] }),
    )

    expect(profilesOnly.employees).toHaveLength(1)
    expect(profilesOnly.history).toEqual([])
    expect(profilesOnly.issues).toEqual([])
    expect(historyOnly.history).toHaveLength(1)
    expect(historyOnly.employees).toEqual([])
    expect(historyOnly.issues).toEqual([])
  })

  it('says so when the book holds neither sheet', () => {
    const parsed = parseImportWorkbook(
      workbook({ Notes: [['Nothing to see here']] }),
    )

    expect(parsed.employees).toEqual([])
    expect(parsed.history).toEqual([])
    expect(parsed.issues[0]?.message).toContain('Neither an Employees')
  })

  it('accepts a date Excel turned into a serial number', () => {
    // 43892 is 2020-03-02 in Excel's serial calendar — what a column becomes
    // once somebody opens the file and lets the spreadsheet reformat it.
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          ['anna@example.com', 'Anna', 43892, 'UA', 25, 5, '', ''],
        ],
      }),
    )

    expect(parsed.employees[0]?.employmentStartDate).toBe('2020-03-02')
  })

  it('names the row when a date cannot be read at all', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          ['anna@example.com', 'Anna', 'sometime in March', 'UA', 25, 5, '', ''],
        ],
      }),
    )

    expect(parsed.employees).toEqual([])
    expect(parsed.issues).toEqual([
      {
        row: 2,
        message:
          'anna@example.com: the employment start date is missing or unreadable.',
      },
    ])
  })

  it('reports a numeric cell it cannot read instead of dropping the figure', () => {
    // The office trackers write free text in numeric columns. Dropped, the
    // carryover travels as an absent field, the server reads it as zero, and
    // the employee opens the year with none of their 7.5 days.
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          [
            'anna@example.com',
            'Anna',
            '2020-03-02',
            'UA',
            25,
            5,
            '7,5 дн.',
            '1 234',
          ],
        ],
      }),
    )

    expect(parsed.issues).toEqual([
      {
        row: 2,
        message:
          'anna@example.com: the "Vacation days carried over" cell reads "7,5 дн.", which is not a number, so it was NOT read. Write a plain figure like 7.5, or leave the cell empty.',
      },
      {
        row: 2,
        message:
          'anna@example.com: the "Expected vacation balance" cell reads "1 234", which is not a number, so it was NOT read. Write a plain figure like 7.5, or leave the cell empty.',
      },
    ])
    // The row itself is still read: the operator fixes the cell, not the file.
    expect(parsed.employees[0]).toMatchObject({
      email: 'anna@example.com',
      vacationDaysPerYear: 25,
      carriedOverVacationDays: undefined,
      expectedVacationBalance: undefined,
    })
  })

  it('names the required allowance cell it could not read, and drops the row', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          ['anna@example.com', 'Anna', '2020-03-02', 'UA', '25 дней', 5, '', ''],
        ],
      }),
    )

    expect(parsed.employees).toEqual([])
    expect(parsed.issues.map((issue) => issue.message)).toEqual([
      'anna@example.com: the "Vacation days/year" cell reads "25 дней", which is not a number, so it was NOT read. Write a plain figure like 7.5, or leave the cell empty.',
      'anna@example.com: the vacation and sick allowances must both be numbers.',
    ])
  })

  it('reports an unreadable working-days cell on the Requests sheet', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          HISTORY_HEADER,
          [
            'anna@example.com',
            'vacation',
            '2026-03-02',
            '2026-03-06',
            '',
            '',
            '',
            '5 дней',
          ],
        ],
      }),
    )

    expect(parsed.issues[0]?.message).toContain(
      'the "Working days" cell reads "5 дней"',
    )
    expect(parsed.history[0]?.workingDays).toBeUndefined()
  })

  it('keeps an empty numeric cell meaning absent', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          ['anna@example.com', 'Anna', '2020-03-02', 'UA', 25, 5, '', ''],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]?.carriedOverVacationDays).toBeUndefined()
  })

  it('rejects a leave type the system does not have', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          HISTORY_HEADER,
          ['anna@example.com', 'day off', '2026-03-02', '2026-03-06', '', '', '', ''],
        ],
      }),
    )

    expect(parsed.history).toEqual([])
    expect(parsed.issues[0]?.message).toContain('vacation or sick')
  })

  it('skips a trailing note but still reports a row that lost its address', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          EMPLOYEE_HEADER,
          EMPLOYEE_ROW,
          ['Generated from the office tracker on 2026-08-06.'],
          ['not-an-address', 'Boris', '2021-01-04', 'UA', 25, 5, '', ''],
        ],
      }),
    )

    expect(parsed.employees.map((row) => row.email)).toEqual([
      'anna@example.com',
      // A row filling several columns is data, so it is kept and its address
      // is left for the server to reject against the directory.
      'not-an-address',
    ])
    expect(parsed.issues).toEqual([])
  })

  it('reads a zero in a text column as an empty cell', () => {
    // Cleared cells in Excel often come back as 0, and "No account for
    // approver 0" was the result on every row of such a column.
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          HISTORY_HEADER,
          ['anna@example.com', 'vacation', '2026-03-02', '2026-03-06', 0, 0, 0, 0],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.history[0]).toMatchObject({
      approverEmail: undefined,
    })
  })

  it('treats a zero in a date column as an empty cell', () => {
    // Excel reads 0 as day zero of 1900; left alone it became a submission
    // date of 1900-01-00 and the engine refused the row with a message about
    // the employment start date.
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          HISTORY_HEADER,
          ['anna@example.com', 'vacation', '2026-03-02', '2026-03-06', 0, 0, '', 5],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.history[0]).toMatchObject({
      startDate: '2026-03-02',
      submittedAt: undefined,
      approvedAt: undefined,
    })
  })

  it('reads the part-day cell as the map the domain takes', () => {
    // ONE cell per row: the same date:hours spelling the availability query
    // carries, because a leave's shape has to fit a row somebody edits by hand.
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          [...HISTORY_HEADER, 'Hours\n(date:hours, blank = whole days)'],
          [...HISTORY_ROW, '2026-03-03:4, 2026-03-04:2'],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.history[0]?.hoursByDate).toEqual({
      '2026-03-03': 4,
      '2026-03-04': 2,
    })
  })

  it('accepts the dotted dates the trackers write inside the hours cell', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          [...HISTORY_HEADER, 'Part-day hours'],
          [...HISTORY_ROW, '3.03.2026:4'],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.history[0]?.hoursByDate).toEqual({ '2026-03-03': 4 })
  })

  it('refuses a cell that states two lengths for one date', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          [...HISTORY_HEADER, 'Hours'],
          [...HISTORY_ROW, '2026-03-03:4,2026-03-03:2'],
        ],
      }),
    )

    expect(parsed.history).toEqual([])
    expect(parsed.issues[0]?.message).toContain('could not be read')
  })

  it('leaves the map absent when the hours cell is blank', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [[...HISTORY_HEADER, 'Hours'], [...HISTORY_ROW, '']],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.history[0]?.hoursByDate).toBeUndefined()
  })

  it('refuses a row whose hours cell cannot be read rather than booking whole days', () => {
    // Reading it as whole days would import more leave than the tracker
    // recorded, which is the one failure this parser must never have.
    const parsed = parseImportWorkbook(
      workbook({
        Requests: [
          [...HISTORY_HEADER, 'Hours'],
          [...HISTORY_ROW, '2026-03-03: half a day'],
        ],
      }),
    )

    expect(parsed.history).toEqual([])
    expect(parsed.issues[0]?.message).toContain(
      'the hours cell could not be read at "2026-03-03: half a day"',
    )
  })

  it('refuses a sheet whose columns are not the template', () => {
    const parsed = parseImportWorkbook(
      workbook({ Employees: [['Name', 'Days'], ['Anna', 25]] }),
    )

    expect(parsed.employees).toEqual([])
    expect(parsed.issues[0]?.message).toContain('missing these columns')
  })

  it('reads the whole policy offer, ceiling included', () => {
    // The exact headers the reference workbook writes. The ceiling used to
    // match nothing, so the import minted an uncapped policy and a 25-day
    // offer grew past its 30-day ceiling on the sixth year of service.
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [
            'Employee email *',
            'Employment start date *\n(YYYY-MM-DD)',
            'Country *\n(ISO-2)',
            'Vacation days/year *\n(policy terms)',
            'Sick days/year *\n(policy terms)',
            'Annual increase,\ndays/year\n(blank = none)',
            'Vacation ceiling with\nthe increase, days\n(blank = no ceiling)',
            'Probation,\nmonths\n(blank = none)',
            'Paid sick during\nprobation\n(yes / no)',
          ],
          ['anna@example.com', '2020-10-18', 'UA', 25, 5, 1, 30, 3, 'no'],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]).toMatchObject({
      vacationDaysPerYear: 25,
      vacationAnnualIncrement: 1,
      vacationIncrementCapDays: 30,
      probationMonths: 3,
      paidSickDuringProbation: false,
    })
  })

  it('reads the cadence of the rise, and its aliases, blank meaning every year', () => {
    // Without this column the file could only say "+5", and a policy that
    // rises every three years had to be built by hand in the catalog.
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [
            'Employee email *',
            'Employment start date *\n(YYYY-MM-DD)',
            'Country *\n(ISO-2)',
            'Vacation days/year *\n(policy terms)',
            'Sick days/year *\n(policy terms)',
            'Annual increase (+days at each rise)',
            'Increase every (years, blank = every year)',
          ],
          ['anna@example.com', '2020-10-18', 'UA', 15, 5, 5, 3],
          ['boris@example.com', '2020-10-18', 'UA', 15, 5, 5, ''],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]?.vacationIncrementEveryYears).toBe(3)
    // Blank stays absent rather than becoming 1: the server reads an absent
    // period as every year, and a file with no such column at all must mean
    // the same thing.
    expect(parsed.employees[1]?.vacationIncrementEveryYears).toBeUndefined()

    for (const header of ['Increment every, years', 'Increase period (years)']) {
      const alias = parseImportWorkbook(
        workbook({
          Employees: [
            [
              'Employee email *',
              'Employment start date *\n(YYYY-MM-DD)',
              'Country *\n(ISO-2)',
              'Vacation days/year *\n(policy terms)',
              'Sick days/year *\n(policy terms)',
              'Annual increase',
              header,
            ],
            ['anna@example.com', '2020-10-18', 'UA', 15, 5, 5, 2],
          ],
        }),
      )
      expect(alias.issues).toEqual([])
      expect(alias.employees[0]?.vacationIncrementEveryYears).toBe(2)
    }
  })

  it('reads the year vacation norm reference and leaves it absent when blank', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [
            'Employee email *',
            'Employment start date *\n(YYYY-MM-DD)',
            'Country *\n(ISO-2)',
            'Vacation days/year *\n(policy terms)',
            'Sick days/year *\n(policy terms)',
            'Annual increase,\ndays/year\n(blank = none)',
            'Increase every\nN years\n(blank = every year)',
            'Increase cap, days\n(blank = none)',
            'Year vacation norm\n(reference)',
          ],
          ['karl@example.com', '2023-08-28', 'TR', 15, 5, 2, '', 25, 21],
          ['flat@example.com', '2020-01-01', 'UA', 25, 5, '', '', '', ''],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]).toMatchObject({
      vacationDaysPerYear: 15,
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 25,
      expectedYearVacationDays: 21,
    })
    expect(parsed.employees[1]!.expectedYearVacationDays).toBeUndefined()
  })

  it('reads the assigned holiday calendar and inherits the country when blank', () => {
    // A TR-office employee working by the Ukrainian schedule: the calendar
    // column decouples "where they are" from "which days are working days".
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [
            'Employee email *',
            'Employment start date *\n(YYYY-MM-DD)',
            'Country *\n(ISO-2)',
            'Holiday calendar\n(blank = country)',
            'Vacation days/year *\n(policy terms)',
            'Sick days/year *\n(policy terms)',
          ],
          ['tabakov@example.com', '2014-09-11', 'TR', 'ua', 25, 5],
          ['amet@example.com', '2004-04-22', 'TR', '', 25, 5],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.employees[0]).toMatchObject({
      countryCode: 'TR',
      holidayCalendarCountryCode: 'UA',
    })
    expect(parsed.employees[1]!.countryCode).toBe('TR')
    expect(parsed.employees[1]!.holidayCalendarCountryCode).toBeUndefined()
  })

  it('reports a column whose values nobody read', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [...EMPLOYEE_HEADER, 'Vacation cieling, days'],
          [...EMPLOYEE_ROW, 30],
        ],
      }),
    )

    expect(parsed.employees).toHaveLength(1)
    expect(parsed.issues[0]?.message).toContain('vacation cieling, days')
    expect(parsed.issues[0]?.message).toContain('NOT read')
  })

  it('stays quiet about commentary columns and empty template columns', () => {
    const parsed = parseImportWorkbook(
      workbook({
        Employees: [
          [...EMPLOYEE_HEADER, 'Spare column'],
          [...EMPLOYEE_ROW, ''],
        ],
        Requests: [
          [...HISTORY_HEADER, 'Comment (reference\nonly, not imported)'],
          [...HISTORY_ROW, 'taken as two halves'],
        ],
      }),
    )

    expect(parsed.issues).toEqual([])
  })
})
