/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser, JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import { LeaveType } from '@workspace/contracts'
import type {
  EmployeeImportRowDto,
  ImportBatchSummaryDto,
  ImportEmployeeRequestDto,
  ImportEmployeeResultDto,
  ImportFunction,
  ImportMode,
  ImportValidationReportDto,
  LeaveHistoryImportRowDto,
  ValidateImportRequestDto,
} from '@workspace/contracts'
import { toAuditActor } from '../domain/audit-log.service'
import { isAdministrator } from '../domain/leave-viewer-context'
import { LeaveImportService } from './leave-import.service'

/**
 * The admin data-import surface.
 *
 * Every route is a POST that answers 200 and reports the outcome in the BODY,
 * the same shape the directory sync uses: an import run is a sequence of
 * per-employee outcomes, most of which are neither success nor server error —
 * a skipped row is normal, and a client that had to read HTTP statuses to
 * learn that would be guessing.
 *
 * The wizard drives this one employee at a time. That is what keeps every
 * payload small (no body-size ceiling to raise), gives the operator live
 * progress, and makes each employee its own transaction — a bad row takes
 * itself down and nothing else.
 */
@Controller('admin/import')
@UseGuards(JwtAuthGuard)
export class LeaveImportController {
  constructor(private readonly imports: LeaveImportService) {}

  /**
   * Read-only inspection of a batch of rows: who is unknown to the directory,
   * what is malformed, and which policies the run would mint. Sent in chunks
   * by the wizard, which merges the reports.
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validate(
    @CurrentUser() user: UserProfileType,
    @Body() body: unknown,
  ): Promise<ImportValidationReportDto> {
    this.assertAdministrator(user)
    return this.imports.validate(parseValidateRequest(body), toAuditActor(user))
  }

  /**
   * What the run would do to ONE employee, computed by running it for real
   * inside a transaction that is then rolled back. The card the operator
   * approves therefore describes the actual effect, not a prediction of it.
   */
  @Post('employees/preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @CurrentUser() user: UserProfileType,
    @Body() body: unknown,
  ): Promise<ImportEmployeeResultDto> {
    this.assertAdministrator(user)
    return this.imports.previewEmployee(
      parseEmployeeRequest(body),
      toAuditActor(user),
    )
  }

  @Post('employees/apply')
  @HttpCode(HttpStatus.OK)
  async apply(
    @CurrentUser() user: UserProfileType,
    @Body() body: unknown,
  ): Promise<ImportEmployeeResultDto> {
    this.assertAdministrator(user)
    return this.imports.applyEmployee(
      parseEmployeeRequest(body),
      toAuditActor(user),
    )
  }

  /**
   * Closes a run: writes the one audit row that names the whole batch, so an
   * administrator can later ask what a given import touched without
   * reconstructing it from per-employee entries.
   */
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentUser() user: UserProfileType,
    @Body() body: unknown,
  ): Promise<{ recorded: true }> {
    this.assertAdministrator(user)
    await this.imports.recordImportCompleted(
      parseBatchSummary(body),
      toAuditActor(user),
    )
    return { recorded: true }
  }

  private assertAdministrator(user: UserProfileType): void {
    // Same gate as the other admin controllers: the roles carried on the
    // authenticated profile, read through the shared predicate.
    if (!isAdministrator(user.roles)) {
      throw new ForbiddenException('Administrator access required.')
    }
  }
}

// --------------------------------------------------------------- parsing ---
//
// Bodies are whitelisted field by field, never spread: the domain inputs the
// import composes carry server-owned fields (submittedAt, decidedAt, audit,
// suppressNotifications) that a client must never be able to set.

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('A JSON object is required.')
  }
  return value as Record<string, unknown>
}

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} must be a non-empty string.`)
  }
  return value.trim()
}

const asOptionalString = (
  value: unknown,
  field: string,
): string | undefined => {
  // A zero counts as absent: spreadsheets fill cleared cells in otherwise
  // numeric columns with 0, and an approver address of "0" is nobody.
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 0 ||
    value === '0'
  ) {
    return undefined
  }
  return asString(value, field)
}

const asNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`${field} must be a number.`)
  }
  return parsed
}

const asOptionalNumber = (
  value: unknown,
  field: string,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  return asNumber(value, field)
}

const asFunction = (value: unknown): ImportFunction => {
  if (
    value !== 'combined' &&
    value !== 'user-data' &&
    value !== 'leave-history'
  ) {
    throw new BadRequestException(
      'fn must be "combined", "user-data" or "leave-history".',
    )
  }
  return value
}

const asMode = (value: unknown): ImportMode => {
  if (value !== 'add' && value !== 'override') {
    throw new BadRequestException('mode must be either "add" or "override".')
  }
  return value
}

const asTargetYear = (value: unknown): number => {
  const year = asNumber(value, 'targetYear')
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    throw new BadRequestException('targetYear must be a four-digit year.')
  }
  return year
}

const asLeaveType = (value: unknown): LeaveType => {
  if (value !== LeaveType.Vacation && value !== LeaveType.Sick) {
    throw new BadRequestException(
      `type must be either "${LeaveType.Vacation}" or "${LeaveType.Sick}".`,
    )
  }
  return value
}

const parseEmployeeRow = (value: unknown): EmployeeImportRowDto => {
  const row = asRecord(value)
  return {
    email: asString(row['email'], 'email'),
    displayName: asOptionalString(row['displayName'], 'displayName'),
    employmentStartDate: asString(
      row['employmentStartDate'],
      'employmentStartDate',
    ),
    countryCode: asString(row['countryCode'], 'countryCode').toUpperCase(),
    holidayCalendarCountryCode: asOptionalString(
      row['holidayCalendarCountryCode'],
      'holidayCalendarCountryCode',
    )?.toUpperCase(),
    vacationDaysPerYear: asNumber(
      row['vacationDaysPerYear'],
      'vacationDaysPerYear',
    ),
    sickDaysPerYear: asNumber(row['sickDaysPerYear'], 'sickDaysPerYear'),
    vacationAnnualIncrement: asOptionalNumber(
      row['vacationAnnualIncrement'],
      'vacationAnnualIncrement',
    ),
    // Years, so no day quantum applies; the whole-number range is the writer's
    // (normalizePolicyTerms), which this row reaches through the same door a
    // hand-made policy does.
    vacationIncrementEveryYears: asOptionalNumber(
      row['vacationIncrementEveryYears'],
      'vacationIncrementEveryYears',
    ),
    vacationIncrementCapDays: asOptionalNumber(
      row['vacationIncrementCapDays'],
      'vacationIncrementCapDays',
    ),
    probationMonths: asOptionalNumber(row['probationMonths'], 'probationMonths'),
    paidSickDuringProbation:
      typeof row['paidSickDuringProbation'] === 'boolean'
        ? row['paidSickDuringProbation']
        : undefined,
    policyName:
      typeof row['policyName'] === 'string' && row['policyName'].trim()
        ? row['policyName'].trim()
        : undefined,
    expectedYearVacationDays: asOptionalNumber(
      row['expectedYearVacationDays'],
      'expectedYearVacationDays',
    ),
    carriedOverVacationDays: asOptionalNumber(
      row['carriedOverVacationDays'],
      'carriedOverVacationDays',
    ),
    expectedVacationBalance: asOptionalNumber(
      row['expectedVacationBalance'],
      'expectedVacationBalance',
    ),
    expectedSickBalance: asOptionalNumber(
      row['expectedSickBalance'],
      'expectedSickBalance',
    ),
  }
}

// SHAPE only, like the rest of this file: a map of dates to numbers. Whether
// the hours are whole, fit the workday and name dates the period actually
// charges is decided in the import service, which knows the setting and the
// employee's calendar and reports its findings as row issues an operator can
// act on rather than as a 400 that names one cell of a whole workbook.
const asHoursByDate = (value: unknown): Record<string, number> | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(
      'hoursByDate must be an object keyed by calendar date.',
    )
  }
  const hoursByDate: Record<string, number> = {}
  for (const [date, hours] of Object.entries(value)) {
    hoursByDate[asString(date, 'hoursByDate date')] = asNumber(
      hours,
      `hoursByDate[${date}]`,
    )
  }
  return Object.keys(hoursByDate).length > 0 ? hoursByDate : undefined
}

const parseHistoryRow = (value: unknown): LeaveHistoryImportRowDto => {
  const row = asRecord(value)
  const hoursByDate = asHoursByDate(row['hoursByDate'])
  return {
    email: asString(row['email'], 'email'),
    leaveType: asLeaveType(row['leaveType']),
    startDate: asString(row['startDate'], 'startDate'),
    endDate: asString(row['endDate'], 'endDate'),
    submittedAt: asOptionalString(row['submittedAt'], 'submittedAt'),
    approvedAt: asOptionalString(row['approvedAt'], 'approvedAt'),
    approverEmail: asOptionalString(row['approverEmail'], 'approverEmail'),
    workingDays: asOptionalNumber(row['workingDays'], 'workingDays'),
    ...(hoursByDate !== undefined ? { hoursByDate } : {}),
  }
}

const asArray = (value: unknown, field: string): unknown[] => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an array.`)
  }
  return value
}

export const parseValidateRequest = (
  body: unknown,
): ValidateImportRequestDto => {
  const payload = asRecord(body)
  return {
    fn: asFunction(payload['fn']),
    targetYear: asTargetYear(payload['targetYear']),
    mode: asMode(payload['mode']),
    snapshotDate: asOptionalString(payload['snapshotDate'], 'snapshotDate'),
    employees: asArray(payload['employees'], 'employees').map(parseEmployeeRow),
    history: asArray(payload['history'], 'history').map(parseHistoryRow),
  }
}

export const parseEmployeeRequest = (
  body: unknown,
): ImportEmployeeRequestDto => {
  const payload = asRecord(body)
  const employee = payload['employee']
  return {
    fn: asFunction(payload['fn']),
    targetYear: asTargetYear(payload['targetYear']),
    mode: asMode(payload['mode']),
    snapshotDate: asOptionalString(payload['snapshotDate'], 'snapshotDate'),
    employee:
      employee === undefined || employee === null
        ? undefined
        : parseEmployeeRow(employee),
    history: asArray(payload['history'], 'history').map(parseHistoryRow),
    policyName: asOptionalString(payload['policyName'], 'policyName'),
  }
}

export const parseBatchSummary = (body: unknown): ImportBatchSummaryDto => {
  const payload = asRecord(body)
  const emails = (value: unknown, field: string): string[] =>
    asArray(value, field).map((entry) => asString(entry, field))
  return {
    fn: asFunction(payload['fn']),
    targetYear: asTargetYear(payload['targetYear']),
    mode: asMode(payload['mode']),
    applied: emails(payload['applied'], 'applied'),
    skipped: emails(payload['skipped'], 'skipped'),
    failed: emails(payload['failed'], 'failed'),
  }
}
