/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import { CommandBus, QueryBus } from '@nestjs/cqrs'
import { CurrentUser } from '@trusted-modules/auth-oidc-nest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import type {
  CreateLeaveRequestDto,
  LeaveApprovalActionDto,
  LeaveAvailabilityPreviewDto,
  LeaveAvailabilityQueryDto,
  LeaveRequestDetailDto,
  LeaveRequestFormContextDto,
  LeaveRequestHistoryDto,
  ListMyLeaveRequestsQueryDto,
  ModifyLeaveRequestDto,
} from '@workspace/contracts'
import {
  LeaveRequestStatus,
  LeaveType,
  isRealIsoDate,
} from '@workspace/contracts'
import { emptyToUndefined } from '../common/parse'
import {
  CancelLeaveRequestCommand,
  DecideLeaveRequestCommand,
  GetLeaveRequestDetailQuery,
  GetLeaveRequestFormContextQuery,
  ListMyLeaveRequestsQuery,
  ModifyLeaveRequestCommand,
  PreviewLeaveAvailabilityQuery,
  SubmitLeaveRequestCommand,
} from './employee-leave.application'

@Controller('leave-requests')
export class EmployeeLeaveController {
  constructor(
    @Inject(CommandBus)
    private readonly commandBus: CommandBus,
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
  ) {}

  @Get('me')
  listMyRequests(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LeaveRequestHistoryDto> {
    return this.queryBus.execute(
      new ListMyLeaveRequestsQuery(
        currentUser,
        parseListMyRequestsQuery(status, from, to),
      ),
    )
  }

  // Static segment, so it MUST stay declared above the ':requestId' route or
  // Nest would try to load a request with id "form-context".
  @Get('form-context')
  getLeaveRequestFormContext(
    @CurrentUser() currentUser: UserProfileType | undefined,
  ): Promise<LeaveRequestFormContextDto> {
    return this.queryBus.execute(
      new GetLeaveRequestFormContextQuery(currentUser),
    )
  }

  // Likewise static: keep it above ':requestId'. Would this period be accepted,
  // and how much room do its months have? The composer asks before submitting
  // so the employee sees the answer while they can still change the dates.
  @Get('availability')
  previewAvailability(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Query('leaveType') leaveType?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('excludeRequestId') excludeRequestId?: string,
    @Query('hours') hours?: unknown,
  ): Promise<LeaveAvailabilityPreviewDto> {
    return this.queryBus.execute(
      new PreviewLeaveAvailabilityQuery(
        currentUser,
        parseAvailabilityQuery(
          leaveType,
          startDate,
          endDate,
          excludeRequestId,
          hours,
        ),
      ),
    )
  }

  @Post()
  createLeaveRequest(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Body() body: CreateLeaveRequestDto,
  ): Promise<LeaveRequestDetailDto> {
    return this.commandBus.execute(
      new SubmitLeaveRequestCommand(currentUser, body),
    )
  }

  @Get(':requestId')
  getLeaveRequest(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Param('requestId') requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    return this.queryBus.execute(
      new GetLeaveRequestDetailQuery(currentUser, requestId),
    )
  }

  @Post(':requestId/approval')
  approveLeaveRequest(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Param('requestId') requestId: string,
    @Body() body: LeaveApprovalActionDto,
  ): Promise<LeaveRequestDetailDto> {
    return this.commandBus.execute(
      new DecideLeaveRequestCommand(currentUser, requestId, body),
    )
  }

  @Post(':requestId/cancel')
  cancelLeaveRequest(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Param('requestId') requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    return this.commandBus.execute(
      new CancelLeaveRequestCommand(currentUser, requestId),
    )
  }

  // Returns the REPLACEMENT request, which is what now needs approval. The
  // original keeps its approval until every approver has approved this one.
  @Post(':requestId/modify')
  modifyLeaveRequest(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Param('requestId') requestId: string,
    @Body() body: ModifyLeaveRequestDto,
  ): Promise<LeaveRequestDetailDto> {
    return this.commandBus.execute(
      new ModifyLeaveRequestCommand(currentUser, requestId, body),
    )
  }
}

// The availability query arrives as loose strings; the leave type is checked
// here so an unknown value fails as a bad request rather than reaching the
// projection. Dates are validated in the application service alongside the
// create path, keeping one set of date messages.
function parseAvailabilityQuery(
  leaveType: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
  excludeRequestId: string | undefined,
  hours: unknown,
): LeaveAvailabilityQueryDto {
  if (
    leaveType === undefined ||
    !Object.values(LeaveType).includes(leaveType as LeaveType)
  ) {
    throw new BadRequestException('leaveType must be a valid leave type.')
  }
  if (!startDate || !endDate) {
    throw new BadRequestException('startDate and endDate are required.')
  }
  const hoursByDate = parseHoursQuery(hours)
  return {
    leaveType: leaveType as LeaveType,
    startDate,
    endDate,
    ...(excludeRequestId ? { excludeRequestId } : {}),
    ...(hoursByDate !== undefined ? { hoursByDate } : {}),
  }
}

// The part-day shape rides this GET as a compact 'date:hours' list
// (2026-08-05:4,2026-08-06:2) rather than as an encoded JSON object: an
// availability URL is read in logs and typed by hand, and the map is a handful
// of dates by construction. Only the PAIRS are decoded here; the dates, the
// hours and their relation to the period are validated in the application
// service, which owns the same checks for the submit body.
function parseHoursQuery(
  // Not `string`: Express hands Nest a string[] for a repeated ?hours=a&hours=b,
  // and this endpoint answers a malformed period with a refusal, never with a
  // crash inside a helper that assumed a string.
  hours: unknown,
): Record<string, number> | undefined {
  if (hours !== undefined && typeof hours !== 'string') {
    throw new BadRequestException(
      'hours must be supplied once, as a comma-separated list of date:hours pairs.',
    )
  }
  const raw = emptyToUndefined(hours)
  if (raw === undefined) {
    return undefined
  }
  // A null-prototype map so every key is an ordinary own property: written into
  // a plain object literal, '__proto__' would hit Object.prototype's setter and
  // vanish, and the date checks downstream would never see the entry they are
  // there to refuse.
  const hoursByDate: Record<string, number> = Object.create(null)
  for (const pair of raw.split(',')) {
    const parts = pair.split(':')
    const [date, value] = parts
    if (parts.length !== 2 || !date || value === undefined || !/^\d+$/.test(value)) {
      throw new BadRequestException(
        'hours must be a comma-separated list of date:hours pairs, for example 2026-08-05:4.',
      )
    }
    hoursByDate[date] = Number(value)
  }
  return hoursByDate
}

// Query-string values arrive as strings; validate them before they reach the
// domain. The date bounds must be real calendar dates so a garbage value can
// never quietly widen or void the overlap filter.
function parseListMyRequestsQuery(
  status: string | undefined,
  from: string | undefined,
  to: string | undefined,
): ListMyLeaveRequestsQueryDto {
  const query: ListMyLeaveRequestsQueryDto = {}

  const statusValue = emptyToUndefined(status)
  if (statusValue !== undefined) {
    if (
      !Object.values(LeaveRequestStatus).includes(
        statusValue as LeaveRequestStatus,
      )
    ) {
      throw new BadRequestException('status must be a valid leave request status.')
    }
    query.status = statusValue as LeaveRequestStatus
  }

  const from_ = parseDateBound(from, 'from')
  if (from_ !== undefined) {
    query.from = from_
  }
  const to_ = parseDateBound(to, 'to')
  if (to_ !== undefined) {
    query.to = to_
  }

  return query
}

function parseDateBound(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined
  }
  if (!isRealIsoDate(value)) {
    throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date.`)
  }
  return value
}
