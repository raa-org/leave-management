/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import { EventBus } from '@nestjs/cqrs'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser, JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import type {
  AdminActivityFeedDto,
  AdminActivityFeedItemDto,
  AdminAuditLogPageDto,
  AdminEmployeeDetailDto,
  AdminEmployeeFilterOptionsDto,
  AdminEmployeeListDto,
  AdminEmployeeOptionDto,
  AdjustEmployeeVacationBalanceDto,
  CloneHolidayCalendarDto,
  CountryCatalogEntryDto,
  CountryDto,
  HolidayCalendarDto,
  HolidayEntryDto,
  LeaveApprovalActionDto,
  LeaveRequestDetailDto,
  LeaveSettingsDto,
  ListHolidaysQueryDto,
  SetEmployeeActiveDto,
  UpdateEmployeeAdminDto,
  UpdateHolidayCalendarDto,
  UpdateLeaveSettingsDto,
} from '@workspace/contracts'
import {
  AppRoleName,
  AuditCategory,
  AuditEventType,
  CarryoverCapMode,
  CarryoverPolicy,
  EmployeeProfileFilter,
  LeaveApprovalAction,
  LeaveRequestStatus,
  LeaveType,
  isRealIsoDate,
  isValidEmail,
  normalizeCountryCode,
} from '@workspace/contracts'
import { emptyToUndefined } from '../common/parse'
import {
  parseOptionalBoolean,
  parseOptionalPositiveInteger,
} from '../common/query-params'
import {
  CountryInUseError,
  CountryTimezoneNotAvailableError,
  DefaultTimezoneNotRecognizedError,
  LeaveDomainNotFoundError,
  LeaveDomainService,
  LeaveDomainValidationError,
} from '../domain/leave-domain.service'
import { AuditLogService, toAuditActor } from '../domain/audit-log.service'
import { listCountryCatalog, lookupCountry } from '../domain/country-catalog'
import { UUID_PATTERN } from '../domain/keyset-cursor'
import {
  describeViewerContext,
  describeViewerContextForDetail,
  isAdministrator,
} from '../domain/leave-viewer-context'
import { publishLeaveRequestApprovedEmail, publishLeaveRequestRejectedEmail } from '../notifications/leave-request-email-events'
import { LeaveNotificationService } from '../notifications/leave-notification.service'

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminLeaveController {
  constructor(
    private readonly leaveDomainService: LeaveDomainService,
    private readonly auditLogService: AuditLogService,
    private readonly eventBus: EventBus,
    private readonly leaveNotifications: LeaveNotificationService,
  ) {}

  @Get('activity')
  async getActivity(
    @CurrentUser() user: UserProfileType,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('employeeId') employeeId?: string,
    @Query('approverEmail') approverEmail?: string,
    @Query('status') status?: string,
    @Query('leaveType') leaveType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AdminActivityFeedDto> {
    this.assertAdministrator(user)

    const feed = await this.leaveDomainService.getAdminActivity({
      cursor,
      limit: parseOptionalPositiveInteger(limit, 'limit'),
      employeeId: parseOptionalUuid(employeeId, 'employeeId'),
      approverEmail: parseOptionalEmail(approverEmail, 'approverEmail'),
      status: parseOptionalEnumValue(status, LeaveRequestStatus, 'status'),
      leaveType: parseOptionalEnumValue(leaveType, LeaveType, 'leaveType'),
      from: parseOptionalIsoDate(from, 'from'),
      to: parseOptionalIsoDate(to, 'to'),
    })

    return { ...feed, items: await this.withViewerContext(user, feed.items) }
  }

  /**
   * Tells the console which rows the reading admin is personally an approver
   * on. An admin is not only an admin: on a request that names them, their
   * standing is "approver", and the console must route them to the review page
   * to cast their vote rather than offering to override the very gate they are
   * part of. Without this the feed cannot tell those rows apart.
   */
  private async withViewerContext(
    user: UserProfileType,
    items: AdminActivityFeedItemDto[],
  ): Promise<AdminActivityFeedItemDto[]> {
    const recipientsByRequest =
      await this.leaveDomainService.loadApproversForRequests(
        items.map((item) => item.requestId),
      )

    return items.map((item) => ({
      ...item,
      viewer: describeViewerContext({
        caller: user,
        requesterUserId: item.employeeId,
        status: item.status,
        recipients: recipientsByRequest.get(item.requestId) ?? [],
      }),
    }))
  }

  @Get('audit')
  getAudit(
    @CurrentUser() user: UserProfileType,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('category') category?: string,
    @Query('eventType') eventType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AdminAuditLogPageDto> {
    this.assertAdministrator(user)

    return this.auditLogService.getAdminAuditLogs({
      cursor,
      limit: parseOptionalPositiveInteger(limit, 'limit'),
      userId: parseOptionalUuid(userId, 'userId'),
      category: parseOptionalEnumValue(
        category,
        AuditCategory,
        'category',
        'audit category',
      ),
      eventType: parseOptionalEnumValue(
        eventType,
        AuditEventType,
        'eventType',
        'audit event type',
      ),
      from: parseOptionalTimestamp(from, 'from'),
      to: parseOptionalTimestamp(to, 'to'),
    })
  }

  @Get('employees')
  getEmployees(
    @CurrentUser() user: UserProfileType,
    @Query('search') search?: string,
    @Query('roleName') roleName?: string,
    @Query('countryCode') countryCode?: string,
    @Query('projectId') projectId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    // Appended rather than grouped with the other filters: the spec calls this
    // handler positionally, so an inserted parameter would silently shift them.
    // That is not hypothetical -- policyId below was grouped next to projectId
    // on its own branch, and merging the two silently moved every argument
    // after it by one. Nothing failed to compile; the tests simply started
    // reading the account filter as the page limit.
    @Query('active') active?: string,
    @Query('profile') profile?: string,
    @Query('employmentStartDateFrom') employmentStartDateFrom?: string,
    @Query('employmentStartDateTo') employmentStartDateTo?: string,
    @Query('policyId') policyId?: string,
  ): Promise<AdminEmployeeListDto> {
    this.assertAdministrator(user)

    const normalizedCountry = emptyToUndefined(countryCode)

    return this.leaveDomainService.getAdminEmployeeList({
      search,
      roleName: parseOptionalEnumValue(
        roleName,
        AppRoleName,
        'roleName',
        'application role',
      ),
      // Normalized like every other country input so a lowercase 'ua' from a
      // hand-built URL still matches the stored code.
      countryCode: normalizedCountry
        ? normalizeCountryCode(normalizedCountry)
        : undefined,
      projectId: parseOptionalUuid(projectId, 'projectId'),
      policyId: parseOptionalUuid(policyId, 'policyId'),
      active: parseOptionalBoolean(active, 'active'),
      profile: parseOptionalEnumValue(
        profile,
        EmployeeProfileFilter,
        'profile',
        'profile filter',
      ),
      employmentStartDateFrom: parseOptionalIsoDate(
        employmentStartDateFrom,
        'employmentStartDateFrom',
      ),
      employmentStartDateTo: parseOptionalIsoDate(
        employmentStartDateTo,
        'employmentStartDateTo',
      ),
      cursor: emptyToUndefined(cursor),
      limit: parseOptionalPositiveInteger(limit, 'limit'),
    })
  }

  // Declared before employees/:employeeId so Nest does not swallow 'options'
  // as an employee id. Lightweight projection for filter dropdowns — unlike
  // the employee list it triggers no per-user balance refresh or hydration.
  @Get('employees/options')
  getEmployeeOptions(
    @CurrentUser() user: UserProfileType,
  ): Promise<AdminEmployeeOptionDto[]> {
    this.assertAdministrator(user)
    return this.leaveDomainService.getAdminEmployeeOptions()
  }

  // Same literal-before-param rule as employees/options above: declared here so
  // 'filter-options' is not matched as an employee id.
  @Get('employees/filter-options')
  getEmployeeFilterOptions(
    @CurrentUser() user: UserProfileType,
  ): Promise<AdminEmployeeFilterOptionsDto> {
    this.assertAdministrator(user)
    return this.leaveDomainService.getAdminEmployeeFilterOptions()
  }

  @Get('employees/:employeeId')
  async getEmployeeDetail(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    try {
      return await this.leaveDomainService.getAdminEmployeeDetail(employeeId)
    } catch (error) {
      if (error instanceof LeaveDomainNotFoundError) {
        throw new NotFoundException(`Unknown employee: ${employeeId}`)
      }
      throw error
    }
  }

  @Patch('employees/:employeeId')
  async updateEmployee(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
    @Body() input: UpdateEmployeeAdminDto,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    const updates = validateEmployeeUpdate(input)
    try {
      // One atomic update: a rejected country must not leave the start date
      // half-written when both fields are sent in the same PATCH.
      await this.leaveDomainService.updateEmployeeAdmin({
        userId: employeeId,
        ...updates,
        audit: toAuditActor(user),
      })
      return await this.leaveDomainService.getAdminEmployeeDetail(employeeId)
    } catch (error) {
      if (error instanceof LeaveDomainNotFoundError) {
        throw new NotFoundException(`Unknown employee: ${employeeId}`)
      }
      if (error instanceof LeaveDomainValidationError) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  // Deactivate / reactivate an employee. Separate from the profile PATCH above
  // because `active` is a distinct concern (the profile edit never touches it),
  // and the only way to resolve a sync conflict on the app side.
  @Patch('employees/:employeeId/active')
  async setEmployeeActive(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
    @Body() input: SetEmployeeActiveDto,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    if (typeof input?.active !== 'boolean') {
      throw new BadRequestException('A boolean "active" is required.')
    }
    try {
      // The self-lockout guard (an admin cannot deactivate themselves) lives in
      // the domain so every caller is covered; it surfaces as a validation error.
      await this.leaveDomainService.setEmployeeActive({
        userId: employeeId,
        active: input.active,
        audit: toAuditActor(user),
      })
      return await this.leaveDomainService.getAdminEmployeeDetail(employeeId)
    } catch (error) {
      if (error instanceof LeaveDomainNotFoundError) {
        throw new NotFoundException(`Unknown employee: ${employeeId}`)
      }
      if (error instanceof LeaveDomainValidationError) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  // The per-user allocation editor is gone: every allowance comes from a
  // leave policy now, and a per-person exception is a policy of its own. The
  // route stays registered so a stale client gets a clear 410 naming the
  // replacement instead of a puzzling 404.
  @Put('employees/:employeeId/allocation')
  setEmployeeAllocation(
    @CurrentUser() user: UserProfileType,
  ): never {
    this.assertAdministrator(user)
    throw new GoneException(
      'Per-employee allocations are managed through leave policies now. Use PUT /api/admin/employees/:employeeId/policy to move the employee to a policy with the intended terms.',
    )
  }

  @Post('employees/:employeeId/vacation-balance')
  async adjustEmployeeVacationBalance(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
    @Body() input: AdjustEmployeeVacationBalanceDto,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    try {
      const { detail, deltaDays, note, hoursPerDay } =
        await this.leaveDomainService.adjustEmployeeVacationBalance({
          userId: employeeId,
          deltaDays: input.deltaDays,
          note: input.note,
          audit: toAuditActor(user),
        })
      await this.leaveNotifications.notifyVacationBalanceAdjusted({
        detail,
        employeeUserId: employeeId,
        actorDisplayName: user.name?.trim() || user.email,
        deltaDays,
        note,
        hoursPerDay,
      })
      return detail
    } catch (error) {
      if (error instanceof LeaveDomainNotFoundError) {
        throw new NotFoundException(`Unknown employee: ${employeeId}`)
      }
      if (error instanceof LeaveDomainValidationError) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }

  @Get('countries')
  getCountries(@CurrentUser() user: UserProfileType): Promise<CountryDto[]> {
    this.assertAdministrator(user)
    return this.leaveDomainService.listCountries()
  }

  // The canonical country catalog (code -> name + timezone) so the admin picks a
  // country from a list instead of typing code/name/timezone by hand.
  @Get('country-catalog')
  getCountryCatalog(
    @CurrentUser() user: UserProfileType,
  ): CountryCatalogEntryDto[] {
    this.assertAdministrator(user)
    return listCountryCatalog()
  }

  // Lets the console show WHO is about to be overruled (the approvers and their
  // decisions) before an override settles the request. Admins can already read
  // the same DTO through the employee detail route, but keeping the console on
  // /admin/* means it does not depend on that module's authorization branch.
  @Get('leave-requests/:requestId')
  async getLeaveRequest(
    @CurrentUser() user: UserProfileType,
    @Param('requestId') requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    this.assertAdministrator(user)
    try {
      const detail = await this.leaveDomainService.getLeaveRequestDetail(requestId)
      // Attach the caller's viewer, like the force-decision response and the
      // feed: the override dialog gates its submit on viewer.canOverride, so the
      // console reads the server's answer rather than re-deriving it from status.
      return { ...detail, viewer: describeViewerContextForDetail(user, detail) }
    } catch (error) {
      throw this.mapRequestError(error, requestId)
    }
  }

  @Post('leave-requests/:requestId/force-decision')
  async forceDecision(
    @CurrentUser() user: UserProfileType,
    @Param('requestId') requestId: string,
    @Body() input: LeaveApprovalActionDto,
  ): Promise<LeaveRequestDetailDto> {
    // Stays first: an unauthorized caller must never learn the payload shape.
    this.assertAdministrator(user)
    const { action, comment } = validateForceDecision(input)
    try {
      const detail = await this.leaveDomainService.forceDecideLeaveRequest({
        requestId,
        actorUserId: user.id,
        actorDisplayName: user.name ?? user.email,
        action,
        audit: toAuditActor(user),
        comment,
      })
      // The workday length the email renders its figures against, read once
      // for whichever of the two the decision produced.
      const hoursPerDay = await this.leaveDomainService.getWorkdayHours()
      publishLeaveRequestApprovedEmail(
        this.eventBus,
        detail,
        user.name ?? user.email,
        hoursPerDay,
      )
      publishLeaveRequestRejectedEmail(
        this.eventBus,
        detail,
        user.name ?? user.email,
        hoursPerDay,
      )
      // Attach the caller's viewer context, like every other detail-returning
      // surface: on a now-settled request canOverride is false, so the feed's
      // optimistic patch refreshes the row's authority from this response
      // instead of carrying the stale canOverride that offered the override.
      return { ...detail, viewer: describeViewerContextForDetail(user, detail) }
    } catch (error) {
      throw this.mapRequestError(error, requestId)
    }
  }

  @Delete('leave-requests/:requestId/approvers')
  async removeApprover(
    @CurrentUser() user: UserProfileType,
    @Param('requestId') requestId: string,
    @Body() input: { email?: string },
  ): Promise<LeaveRequestDetailDto> {
    this.assertAdministrator(user)
    const email =
      typeof input?.email === 'string' ? input.email.trim() : ''
    if (email === '') {
      throw new BadRequestException('email is required.')
    }
    try {
      const detail = await this.leaveDomainService.removeLeaveRequestApprover({
        requestId,
        email,
        actorUserId: user.id,
        actorDisplayName: user.name ?? user.email,
        audit: toAuditActor(user),
      })
      publishLeaveRequestApprovedEmail(
        this.eventBus,
        detail,
        user.name ?? user.email,
        await this.leaveDomainService.getWorkdayHours(),
      )
      return detail
    } catch (error) {
      throw this.mapRequestError(error, requestId)
    }
  }

  private mapValidationError(error: unknown): unknown {
    if (error instanceof LeaveDomainValidationError) {
      return new BadRequestException(error.message)
    }
    return error
  }

  // A settings save can now be refused over a timezone, so the client needs
  // more than a sentence: the code lets it branch, and the extra fields let it
  // name the offending value or offer the way out.
  private mapSettingsError(error: unknown): unknown {
    if (error instanceof CountryTimezoneNotAvailableError) {
      return new BadRequestException({
        message: error.message,
        code: 'country_timezone_not_available',
        countryCode: error.countryCode,
        allowedTimezones: error.allowedTimezones,
      })
    }
    if (error instanceof CountryInUseError) {
      // 409 rather than 400, matching `policy_in_use`: the payload is well
      // formed, the state is what forbids it. Both counts travel so the console
      // can name what is in the way without a second round trip.
      return new ConflictException({
        message: error.message,
        code: 'country_in_use',
        countryCode: error.countryCode,
        assignedUsers: error.assignedUsers,
        holidayCalendars: error.holidayCalendars,
      })
    }
    if (error instanceof DefaultTimezoneNotRecognizedError) {
      // No allowedTimezones here: the org default is not scoped to a country,
      // so the candidate list is every IANA zone the client's own runtime
      // knows, which the client is better placed to offer than the server.
      return new BadRequestException({
        message: error.message,
        code: 'default_timezone_not_recognized',
        timezone: error.timezone,
      })
    }
    return this.mapValidationError(error)
  }

  private mapRequestError(error: unknown, requestId: string): unknown {
    if (error instanceof LeaveDomainNotFoundError) {
      return new NotFoundException(`Unknown leave request: ${requestId}`)
    }
    if (error instanceof LeaveDomainValidationError) {
      return new BadRequestException(error.message)
    }
    return error
  }

  @Get('settings')
  getSettings(@CurrentUser() user: UserProfileType): Promise<LeaveSettingsDto> {
    this.assertAdministrator(user)
    return this.leaveDomainService.getLeaveSettings()
  }

  @Put('settings')
  updateSettings(
    @CurrentUser() user: UserProfileType,
    @Body() input: UpdateLeaveSettingsDto,
  ): Promise<LeaveSettingsDto> {
    this.assertAdministrator(user)
    // Stays synchronous up to the service call: validateSettings throws before
    // any promise exists, which is the contract the controller specs assert.
    return this.leaveDomainService
      .updateLeaveSettings(validateSettings(input), toAuditActor(user))
      .catch((error: unknown) => {
        throw this.mapSettingsError(error)
      })
  }

  @Get('holidays')
  listHolidays(
    @CurrentUser() user: UserProfileType,
    @Query('countryCode') countryCode?: string,
    @Query('year') year?: string,
  ): Promise<HolidayCalendarDto[]> {
    this.assertAdministrator(user)

    // Calendars are stored under canonical (trimmed uppercase) codes, so the
    // read side must normalize the same way the write side does.
    const query: ListHolidaysQueryDto = {
      countryCode:
        countryCode === undefined ? undefined : normalizeCountryCode(countryCode),
      year: parseOptionalPositiveInteger(year, 'year'),
    }

    return this.leaveDomainService.listHolidayCalendars(query)
  }

  @Put('holidays')
  async updateHolidayCalendar(
    @CurrentUser() user: UserProfileType,
    @Body() input: UpdateHolidayCalendarDto,
  ): Promise<HolidayCalendarDto> {
    this.assertAdministrator(user)
    try {
      return await this.leaveDomainService.replaceHolidayCalendar({
        ...validateHolidayCalendar(input),
        audit: toAuditActor(user),
      })
    } catch (error) {
      throw this.mapValidationError(error)
    }
  }

  @Post('holidays/clone')
  async cloneHolidayCalendar(
    @CurrentUser() user: UserProfileType,
    @Body() input: CloneHolidayCalendarDto,
  ): Promise<HolidayCalendarDto> {
    this.assertAdministrator(user)
    try {
      return await this.leaveDomainService.cloneHolidayCalendar({
        ...validateCloneHolidayCalendar(input),
        audit: toAuditActor(user),
      })
    } catch (error) {
      throw this.mapValidationError(error)
    }
  }

  @Delete('holidays')
  deleteHolidayCalendar(
    @CurrentUser() user: UserProfileType,
    @Query('countryCode') countryCode?: string,
    @Query('year') year?: string,
  ): Promise<void> {
    this.assertAdministrator(user)
    if (typeof countryCode !== 'string' || countryCode.trim() === '') {
      throw new BadRequestException('countryCode is required.')
    }
    const parsedYear = parseOptionalPositiveInteger(year, 'year')
    if (parsedYear === undefined) {
      throw new BadRequestException('year is required.')
    }
    return this.leaveDomainService.deleteHolidayCalendar({
      // Match the canonical stored casing, mirroring the PUT/clone endpoints.
      countryCode: normalizeCountryCode(countryCode),
      year: parsedYear,
      audit: toAuditActor(user),
    })
  }

  private assertAdministrator(user: UserProfileType): void {
    // Trust the roles carried on the authenticated profile, matching the
    // frontend gate. The administrator role is granted per login by the
    // Keycloak role (derived from the leaverequest-app directory groups)
    // mapped in AuthOidcUserProfileMapper; user_roles
    // only mirrors it (synced at login, stale between logins), so access
    // checks must stay on the profile roles, not the DB. The predicate itself
    // is the shared isAdministrator, so this gate, the viewer context, and the
    // employee service all read one definition of "holds the admin role".
    if (!isAdministrator(user.roles)) {
      throw new ForbiddenException('Administrator access required.')
    }
  }
}

// Filter values land in SQL against uuid/date-typed columns; reject bad shapes
// here so a malformed filter is a 400, not a Postgres cast failure (500).
function parseOptionalUuid(
  rawValue: string | undefined,
  fieldName: string,
): string | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${fieldName} must be a valid id.`)
  }
  return value
}

function parseOptionalIsoDate(
  rawValue: string | undefined,
  fieldName: string,
): string | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  if (!isRealIsoDate(value)) {
    throw new BadRequestException(
      `${fieldName} must be a valid calendar date (YYYY-MM-DD).`,
    )
  }
  return value
}

// A malformed value would not break SQL (the column is varchar), but it can
// only ever match nothing — reject it up front instead of returning a
// confusingly empty feed.
function parseOptionalEmail(
  rawValue: string | undefined,
  fieldName: string,
): string | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  if (!isValidEmail(value)) {
    throw new BadRequestException(
      `${fieldName} must be a valid email address.`,
    )
  }
  return value
}

// The audit range bounds are bound raw against a timestamptz column, so only
// forms BOTH sides parse identically are allowed: a calendar date or an
// ISO-8601 timestamp. Bare Date.parse is not enough — it accepts strings
// Postgres rejects (a Date#toString like 'Wed Jul 01 2026 00:00:00 GMT+0300
// (…)', or '12'), which would turn the intended 400 into a cast-error 500.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/

function parseOptionalTimestamp(
  rawValue: string | undefined,
  fieldName: string,
): string | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  // The pattern pins the shape; Date.parse then rejects impossible
  // combinations the pattern cannot see (e.g. month 13).
  if (!ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(
      `${fieldName} must be an ISO-8601 date or timestamp.`,
    )
  }
  return value
}

function parseOptionalEnumValue<T extends string>(
  rawValue: string | undefined,
  enumObject: Record<string, T>,
  fieldName: string,
  description = 'value',
): T | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  if (!Object.values(enumObject).includes(value as T)) {
    throw new BadRequestException(`${fieldName} must be a valid ${description}.`)
  }
  return value as T
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer.`)
  }
}

function assertIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BadRequestException(
      `${field} must be an integer between ${min} and ${max}.`,
    )
  }
}

function assertStringList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestException(`${field} must be a list of strings.`)
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Default approver/cc lists are folded into every request's approver rows, so a
// malformed default becomes an un-clearable 'to' row under the all-approvers
// gate. Validate the shape here at settings-save time.
function assertEmailList(value: unknown, field: string): void {
  assertStringList(value, field)
  for (const item of value as string[]) {
    if (!EMAIL_PATTERN.test(item.trim())) {
      throw new BadRequestException(`${field} must contain valid email addresses.`)
    }
  }
}

// An override settles a request past approvers who were explicitly asked to
// decide it, and it deliberately leaves their rows 'pending', so the written
// reason is the only account of why. Unlike an approver's vote, it is required.
function validateForceDecision(input: LeaveApprovalActionDto): {
  action: LeaveApprovalAction
  comment: string
} {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  if (!Object.values(LeaveApprovalAction).includes(input.action)) {
    throw new BadRequestException('action must be approve or reject.')
  }
  if (input.comment !== undefined && typeof input.comment !== 'string') {
    throw new BadRequestException('comment must be a string.')
  }
  // An omitted comment and a whitespace-only one are the same mistake, so they
  // get the same message; only a wrong type reports a type error.
  const comment = (input.comment ?? '').trim()
  if (comment === '') {
    throw new BadRequestException(
      'comment is required: record why the approver gate is being overridden.',
    )
  }
  return { action: input.action, comment }
}

function validateCountry(country: unknown): CountryDto {
  if (
    typeof country !== 'object' ||
    country === null ||
    typeof (country as CountryDto).code !== 'string' ||
    (country as CountryDto).code.trim() === '' ||
    typeof (country as CountryDto).name !== 'string'
  ) {
    throw new BadRequestException('Each country must have a code and a name.')
  }
  const dto = country as CountryDto
  if (dto.timezone !== undefined && typeof dto.timezone !== 'string') {
    throw new BadRequestException('A country timezone must be a string.')
  }
  // Built explicitly rather than spread: spreading let any key the client
  // invented ride into the domain, and now also drops `assignedUsers`, which
  // GET computes and a console hands straight back. An empty zone is dropped,
  // so it reaches the service as "absent", which means unchanged rather than
  // reset.
  const timezone = dto.timezone?.trim()
  return {
    code: normalizeCountryCode(dto.code),
    name: dto.name,
    ...(timezone ? { timezone } : {}),
  }
}

function assertCalendarYear(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 2000 ||
    (value as number) > 3000
  ) {
    throw new BadRequestException(`${field} must be a valid calendar year.`)
  }
  return value as number
}

function validateHolidayEntries(
  holidays: unknown,
  year: number,
): HolidayEntryDto[] {
  if (!Array.isArray(holidays)) {
    throw new BadRequestException('holidays must be a list.')
  }

  return holidays.map((holiday) => {
    const entry = holiday as HolidayEntryDto
    if (typeof entry !== 'object' || entry === null) {
      throw new BadRequestException('Each holiday must be an object.')
    }
    if (!isRealIsoDate(entry.date)) {
      throw new BadRequestException('Each holiday date must be a valid calendar date.')
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new BadRequestException('Each holiday must have a name.')
    }
    // A holiday belongs to a per-year calendar: its date must fall in that year.
    if (Number.parseInt(entry.date.slice(0, 4), 10) !== year) {
      throw new BadRequestException(`Each holiday must fall in ${year}.`)
    }
    return entry
  })
}

function validateSettings(input: UpdateLeaveSettingsDto): UpdateLeaveSettingsDto {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  assertNonNegativeInteger(input.defaultVacationDays, 'defaultVacationDays')
  assertNonNegativeInteger(input.defaultSickDays, 'defaultSickDays')
  assertEmailList(input.defaultApproverEmails, 'defaultApproverEmails')
  assertEmailList(input.defaultCcApproverEmails, 'defaultCcApproverEmails')
  if (
    input.approvalRequired !== undefined &&
    typeof input.approvalRequired !== 'boolean'
  ) {
    throw new BadRequestException('approvalRequired must be a boolean.')
  }
  if (
    input.carryoverPolicy !== undefined &&
    !Object.values(CarryoverPolicy).includes(input.carryoverPolicy)
  ) {
    throw new BadRequestException('carryoverPolicy must be a valid policy.')
  }
  if (input.carryoverCapDays !== undefined) {
    assertNonNegativeInteger(input.carryoverCapDays, 'carryoverCapDays')
  }
  if (
    input.carryoverCapMode !== undefined &&
    !Object.values(CarryoverCapMode).includes(input.carryoverCapMode)
  ) {
    throw new BadRequestException(
      'carryoverCapMode must be a valid carryover cap mode.',
    )
  }
  if (input.carryoverCapPercent !== undefined) {
    assertIntegerInRange(input.carryoverCapPercent, 'carryoverCapPercent', 0, 100)
  }
  // Whole hours, and a day that fits in one: the value divides every booking in
  // hours, so a zero or a fraction would put figures on the books that no
  // employee can have taken.
  if (input.hoursPerDay !== undefined) {
    assertIntegerInRange(input.hoursPerDay, 'hoursPerDay', 1, 24)
  }
  // Only the type, as with a country timezone: whether the string names a zone
  // this runtime can resolve is the domain's call, because only the domain can
  // let the value already in the database back in.
  if (
    input.defaultTimezone !== undefined &&
    typeof input.defaultTimezone !== 'string'
  ) {
    throw new BadRequestException('The default timezone must be a string.')
  }

  if (!Array.isArray(input.countries)) {
    throw new BadRequestException('countries must be a list.')
  }
  input.countries = input.countries.map(validateCountry)

  // Holidays are no longer part of the settings payload: they are managed
  // through the dedicated holiday endpoints so a settings save never wipes them.
  return input
}

// Partial admin edit: each field is applied only when present in the body, so a
// single PATCH can update the start date, the location, or both. An absent field
// is left untouched; at least one supported field must be provided.

type EmployeeUpdate = {
  employmentStartDate?: string | null
  countryCode?: string | null
  holidayCalendarCountryCode?: string | null
}

function validateEmployeeUpdate(input: UpdateEmployeeAdminDto): EmployeeUpdate {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }

  const updates: EmployeeUpdate = {}

  if ('employmentStartDate' in input) {
    const value = input.employmentStartDate
    if (value === null) {
      updates.employmentStartDate = null
    } else if (isRealIsoDate(value)) {
      updates.employmentStartDate = value
    } else {
      throw new BadRequestException(
        'employmentStartDate must be a valid calendar date or null.',
      )
    }
  }

  if ('countryCode' in input) {
    const value = input.countryCode
    if (value === null) {
      updates.countryCode = null
    } else if (typeof value === 'string' && value.trim() !== '') {
      updates.countryCode = value.trim()
    } else {
      throw new BadRequestException(
        'countryCode must be a non-empty string or null.',
      )
    }
  }

  if ('holidayCalendarCountryCode' in input) {
    const value = input.holidayCalendarCountryCode
    if (value === null) {
      updates.holidayCalendarCountryCode = null
    } else if (typeof value === 'string' && value.trim() !== '') {
      updates.holidayCalendarCountryCode = value.trim()
    } else {
      throw new BadRequestException(
        'holidayCalendarCountryCode must be a non-empty string or null.',
      )
    }
  }

  if (
    updates.employmentStartDate === undefined &&
    updates.countryCode === undefined &&
    updates.holidayCalendarCountryCode === undefined
  ) {
    throw new BadRequestException(
      'Provide employmentStartDate, countryCode, and/or holidayCalendarCountryCode to update.',
    )
  }

  return updates
}

function assertOptionalName(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new BadRequestException('name must be a string.')
  }
}

/**
 * The canonical code for a country that actually exists.
 *
 * Saving a calendar CREATES the country if it is missing, and the catalog has
 * no zone for a code it does not recognise -- so an invented code used to mint
 * a permanent `timezone = NULL` row, which nobody can repair afterwards because
 * the settings picker offers no zones for a country that is not in the catalog.
 * Every other path that can create a country (directory sync, identity login,
 * the admin profile edit) already checks the code first; these two did not.
 */
function assertKnownCountryCode(code: string): string {
  const entry = lookupCountry(code)
  if (!entry) {
    throw new BadRequestException(
      `Unknown country: ${normalizeCountryCode(code)}`,
    )
  }
  return entry.code
}

function validateHolidayCalendar(
  input: UpdateHolidayCalendarDto,
): UpdateHolidayCalendarDto {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  if (typeof input.countryCode !== 'string' || input.countryCode.trim() === '') {
    throw new BadRequestException('countryCode is required.')
  }
  input.countryCode = assertKnownCountryCode(input.countryCode)
  const year = assertCalendarYear(input.year, 'year')
  assertOptionalName(input.name)
  input.holidays = validateHolidayEntries(input.holidays, year)
  return input
}

function validateCloneHolidayCalendar(
  input: CloneHolidayCalendarDto,
): CloneHolidayCalendarDto {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  if (typeof input.countryCode !== 'string' || input.countryCode.trim() === '') {
    throw new BadRequestException('countryCode is required.')
  }
  const sourceYear = assertCalendarYear(input.sourceYear, 'sourceYear')
  const targetYear = assertCalendarYear(input.targetYear, 'targetYear')
  assertOptionalName(input.name)
  return {
    ...input,
    countryCode: assertKnownCountryCode(input.countryCode),
    sourceYear,
    targetYear,
  }
}
