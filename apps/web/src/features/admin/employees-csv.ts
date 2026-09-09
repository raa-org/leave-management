/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Pure CSV projection of the admin employee directory. Deliberately free of
// DOM and network access: the download plumbing (Blob + object URL) lives in
// the page, so this module stays unit-testable in the node test environment.
import type {
  AdminEmployeeListItemDto,
  CountryDto,
} from '@workspace/contracts'
import { countryLabel, formatRoleName, formatStatus } from './admin-formatters'

export const EMPLOYEE_CSV_HEADERS = [
  'Name',
  'Email',
  'Roles',
  'Country',
  'Projects',
  // The employee's current leave policy. Empty for anyone the engine has not
  // enrolled yet (pre-cutover rows).
  'Policy',
  'Latest request status',
  'Latest request dates',
] as const

// Multi-valued cells (roles, projects) are joined with '; ' rather than ',' so
// a spreadsheet shows one column even before the quoting is honoured.
const LIST_SEPARATOR = '; '

// Excel/Sheets execute a cell that starts with one of these, so a name like
// '=cmd|...' would run on open. Prefixing with an apostrophe forces the cell
// to be read as text; the apostrophe is not part of the stored value.
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@'])

// One CSV field: always quoted (so a comma, quote or newline inside survives a
// round-trip) with embedded quotes doubled, per RFC 4180.
export function escapeCsvField(value: string): string {
  const guarded =
    value.length > 0 && FORMULA_TRIGGERS.has(value.charAt(0))
      ? `'${value}`
      : value
  return `"${guarded.replace(/"/g, '""')}"`
}

export function toCsvRow(fields: readonly string[]): string {
  return fields.map(escapeCsvField).join(',')
}

// Dates are emitted as the raw ISO 'YYYY-MM-DD' values, not the UI's localized
// labels: an export is read by machines and by people in other locales, and
// ISO is the only form that sorts and parses the same everywhere.
function latestRequestDates(employee: AdminEmployeeListItemDto): string {
  const latest = employee.latestRequest
  if (!latest) {
    return ''
  }
  return latest.startDate === latest.endDate
    ? latest.startDate
    : `${latest.startDate} to ${latest.endDate}`
}

export function buildEmployeesCsv(
  employees: readonly AdminEmployeeListItemDto[],
  countries: readonly CountryDto[] = [],
): string {
  const rows = [
    toCsvRow(EMPLOYEE_CSV_HEADERS),
    ...employees.map((employee) =>
      toCsvRow([
        employee.displayName,
        employee.email,
        employee.roleNames.map(formatRoleName).join(LIST_SEPARATOR),
        countryLabel(employee.countryCode, countries),
        employee.projects.map((project) => project.name).join(LIST_SEPARATOR),
        employee.policyName ?? '',
        // Roles and status carry the SAME labels as the directory rows, so the
        // file reads like the screen it came from. Dates stay ISO (above)
        // because those are parsed, not just read.
        employee.latestRequest ? formatStatus(employee.latestRequest.status) : '',
        latestRequestDates(employee),
      ]),
    ),
  ]
  // Trailing newline: POSIX tools treat a file without one as a partial line.
  return `${rows.join('\r\n')}\r\n`
}

// Timestamped so repeated exports do not overwrite each other in the browser's
// download folder.
export function employeesCsvFilename(now: Date): string {
  return `employees-${now.toISOString().slice(0, 10)}.csv`
}
