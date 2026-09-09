/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { AdminEmployeeListItemDto } from '@workspace/contracts'
import {
  AppRoleName,
  EmployeeProfileStatus,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import {
  buildEmployeesCsv,
  employeesCsvFilename,
  escapeCsvField,
} from './employees-csv'

// Split a CSV back into rows/fields so the assertions describe the parsed
// value, not the quoting. Deliberately a tiny reader (no dependency): it is
// what proves a field survived the round-trip.
function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv.charAt(index)
    if (quoted) {
      if (char === '"') {
        if (csv.charAt(index + 1) === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && csv.charAt(index + 1) === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const employee = (
  overrides: Partial<AdminEmployeeListItemDto> = {},
): AdminEmployeeListItemDto => ({
  employeeId: 'employee-1',
  displayName: 'Alex Morgan',
  email: 'alex@example.com',
  roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
  active: true,
  profileStatus: EmployeeProfileStatus.Ready,
  countryCode: 'US',
  projects: [{ projectId: 'project-1', name: 'Apollo' }],
  policyName: 'Standard',
  latestRequest: {
    requestId: 'request-1',
    leaveType: LeaveType.Vacation,
    status: LeaveRequestStatus.Pending,
    startDate: '2026-07-10',
    endDate: '2026-07-12',
    requestedDays: 2,
    paidDays: 2,
    unpaidDays: 0,
    heldDays: 2,
    submittedAt: '2026-07-01T09:30:00.000Z',
  },
  ...overrides,
})

const countries = [
  { code: 'US', name: 'United States' },
  { code: 'UA', name: 'Ukraine' },
]

describe('buildEmployeesCsv', () => {
  it('writes the header and one row per employee, resolving the country name', () => {
    const rows = parseCsv(buildEmployeesCsv([employee()], countries))

    expect(rows[0]).toEqual([
      'Name',
      'Email',
      'Roles',
      'Country',
      'Projects',
      'Policy',
      'Latest request status',
      'Latest request dates',
    ])
    expect(rows[1]).toEqual([
      'Alex Morgan',
      'alex@example.com',
      'Employee; Administrator',
      'United States',
      'Apollo',
      'Standard',
      'Pending',
      '2026-07-10 to 2026-07-12',
    ])
    expect(rows).toHaveLength(2)
  })

  it('round-trips a field containing a comma, a quote and a newline', () => {
    const rows = parseCsv(
      buildEmployeesCsv(
        [
          employee({
            displayName: 'Morgan, Alex "Al"\nSenior',
            projects: [
              { projectId: 'project-1', name: 'Apollo, Phase "2"' },
              { projectId: 'project-2', name: 'Zephyr' },
            ],
          }),
        ],
        countries,
      ),
    )

    expect(rows).toHaveLength(2)
    expect(rows[1]?.[0]).toBe('Morgan, Alex "Al"\nSenior')
    expect(rows[1]?.[4]).toBe('Apollo, Phase "2"; Zephyr')
  })

  it('neutralizes spreadsheet formula injection with a leading apostrophe', () => {
    const rows = parseCsv(
      buildEmployeesCsv(
        [
          employee({
            displayName: '=HYPERLINK("http://evil","click")',
            email: '+1@example.com',
            projects: [
              { projectId: 'project-1', name: '-2+3' },
              { projectId: 'project-2', name: '@SUM(A1)' },
            ],
          }),
        ],
        countries,
      ),
    )

    expect(rows[1]?.[0]).toBe('\'=HYPERLINK("http://evil","click")')
    expect(rows[1]?.[1]).toBe("'+1@example.com")
    // Only the FIELD's first character triggers the guard, so the joined
    // project cell is prefixed once, at the front.
    expect(rows[1]?.[4]).toBe("'-2+3; @SUM(A1)")
  })

  it('writes empty cells for an employee with no projects and no requests', () => {
    const rows = parseCsv(
      buildEmployeesCsv(
        [
          employee({
            projects: [],
            policyName: undefined,
            latestRequest: undefined,
            countryCode: undefined,
          }),
        ],
        countries,
      ),
    )

    expect(rows[1]).toEqual([
      'Alex Morgan',
      'alex@example.com',
      'Employee; Administrator',
      '',
      '',
      '',
      '',
      '',
    ])
  })

  it('falls back to the raw country code when the name is unknown', () => {
    const rows = parseCsv(
      buildEmployeesCsv([employee({ countryCode: 'ZZ' })], countries),
    )

    expect(rows[1]?.[3]).toBe('ZZ')
  })

  it('collapses a single-day request to one date', () => {
    const rows = parseCsv(
      buildEmployeesCsv(
        [
          employee({
            latestRequest: {
              ...employee().latestRequest!,
              startDate: '2026-07-10',
              endDate: '2026-07-10',
              requestedDays: 1,
              paidDays: 1,
              unpaidDays: 0,
              heldDays: 1,
            },
          }),
        ],
        countries,
      ),
    )

    expect(rows[1]?.[7]).toBe('2026-07-10')
  })

  it('emits only the header row for an empty directory', () => {
    expect(parseCsv(buildEmployeesCsv([], countries))).toHaveLength(1)
  })
})

describe('escapeCsvField', () => {
  it('always quotes and doubles embedded quotes', () => {
    expect(escapeCsvField('plain')).toBe('"plain"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('')).toBe('""')
  })
})

describe('employeesCsvFilename', () => {
  it('stamps the UTC date so repeated exports do not collide', () => {
    expect(employeesCsvFilename(new Date('2026-07-23T22:15:00.000Z'))).toBe(
      'employees-2026-07-23.csv',
    )
  })
})
