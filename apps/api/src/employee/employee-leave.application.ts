/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import {
  CommandHandler,
  EventBus,
  type ICommandHandler,
  QueryHandler,
  type IQueryHandler,
} from '@nestjs/cqrs'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import {
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
  isRealIsoDate,
  isValidEmail,
  normalizeEmail,
} from '@workspace/contracts'
import type {
  CountryDto,
  CreateLeaveRequestDto,
  EmployeeDashboardDto,
  HolidayCalendarDto,
  LeaveApprovalActionDto,
  LeaveAvailabilityPreviewDto,
  LeaveAvailabilityQueryDto,
  LeaveRequestDetailDto,
  LeaveRequestFormContextDto,
  LeaveRequestHistoryDto,
  ListHolidaysQueryDto,
  LeaveRequestViewerContextDto,
  ListMyLeaveRequestsQueryDto,
  ModifyLeaveRequestDto,
} from '@workspace/contracts'
import {
  LeaveDomainNotFoundError,
  LeaveDomainService,
  LeaveDomainValidationError,
} from '../domain/leave-domain.service'
import { describeViewerContextForDetail } from '../domain/leave-viewer-context'
import { toAuditActor } from '../domain/audit-log.service'
import {
  publishLeaveRequestApprovedEmail,
  publishLeaveRequestAutoApprovedEmail,
  publishLeaveRequestRejectedEmail,
  publishLeaveRequestSubmittedEmail,
} from '../notifications/leave-request-email-events'

export class GetEmployeeDashboardQuery {
  constructor(readonly currentUser?: UserProfileType) {}
}

export class ListMyLeaveRequestsQuery {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly filters: ListMyLeaveRequestsQueryDto,
  ) {}
}

export class ListHolidayCalendarsQuery {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly filters: ListHolidaysQueryDto,
  ) {}
}

export class ListCountriesQuery {
  constructor(readonly currentUser?: UserProfileType) {}
}

export class GetLeaveRequestDetailQuery {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly requestId: string,
  ) {}
}

export class GetLeaveRequestFormContextQuery {
  constructor(readonly currentUser?: UserProfileType) {}
}

export class SubmitLeaveRequestCommand {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly input: CreateLeaveRequestDto,
  ) {}
}

export class DecideLeaveRequestCommand {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly requestId: string,
    readonly input: LeaveApprovalActionDto,
  ) {}
}

export class CancelLeaveRequestCommand {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly requestId: string,
  ) {}
}

export class ModifyLeaveRequestCommand {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly requestId: string,
    readonly input: ModifyLeaveRequestDto,
  ) {}
}

export class PreviewLeaveAvailabilityQuery {
  constructor(
    readonly currentUser: UserProfileType | undefined,
    readonly input: LeaveAvailabilityQueryDto,
  ) {}
}

@Injectable()
export class EmployeeLeaveApplicationService {
  constructor(
    @Inject(LeaveDomainService)
    private readonly leaveDomain: LeaveDomainService,
    @Inject(EventBus)
    private readonly eventBus: EventBus,
  ) {}

  async getEmployeeDashboard(
    currentUser?: UserProfileType,
  ): Promise<EmployeeDashboardDto> {
    const user = await this.requireProvisionedUser(currentUser)
    return this.runDomain(() => this.leaveDomain.getEmployeeDashboard(user.id))
  }

  // Public holidays are reference data, not personal data: any provisioned
  // employee may read ANY country's calendars. That is deliberate — the request
  // calendar shades the employee's own country, but the upcoming per-country
  // holidays page browses others, and gating by the caller's own country would
  // make that page impossible to build on this endpoint.
  async listHolidayCalendars(
    currentUser: UserProfileType | undefined,
    filters: ListHolidaysQueryDto,
  ): Promise<HolidayCalendarDto[]> {
    await this.requireProvisionedUser(currentUser)
    return this.runDomain(() => this.leaveDomain.listHolidayCalendars(filters))
  }

  // The reserved country list (the countries table), read-only reference data
  // the holidays page needs to populate its country picker. Same reasoning as
  // listHolidayCalendars: any provisioned employee may read it, so it lives on
  // an employee route instead of behind the admin guard the write side uses.
  async listCountries(
    currentUser: UserProfileType | undefined,
  ): Promise<CountryDto[]> {
    await this.requireProvisionedUser(currentUser)
    return this.runDomain(() => this.leaveDomain.listCountries())
  }

  async listMyLeaveRequests(
    currentUser: UserProfileType | undefined,
    filters: ListMyLeaveRequestsQueryDto,
  ): Promise<LeaveRequestHistoryDto> {
    const user = await this.requireProvisionedUser(currentUser)
    return this.runDomain(() => this.leaveDomain.getLeaveRequestHistory(user.id, filters))
  }

  // Directory + defaults for the request composer's approver/CC pickers. Any
  // provisioned employee may read it: it exposes only colleague identity
  // (name + email), which every recipient of a leave request sees anyway, and
  // the defaults preview mirrors what submit folds in regardless of payload.
  async getLeaveRequestFormContext(
    currentUser?: UserProfileType,
  ): Promise<LeaveRequestFormContextDto> {
    const user = await this.requireProvisionedUser(currentUser)
    return this.runDomain(() =>
      this.leaveDomain.getLeaveRequestFormContext(user.id),
    )
  }

  async submitLeaveRequest(
    currentUser: UserProfileType | undefined,
    input: CreateLeaveRequestDto,
  ): Promise<LeaveRequestDetailDto> {
    const user = await this.requireProvisionedUser(currentUser)
    // Validate and whitelist the client payload BEFORE touching the domain.
    // Spreading the raw body would let a caller inject server-owned fields
    // (requestId, requesterUserId, submittedAt); we only forward known fields.
    const command = this.parseCreateLeaveRequest(input)
    // Self-addressed recipients are refused by the domain, which owns the
    // requester's canonical address and the merged recipient list. Checking the
    // token email here too would be a second answer to the same question.
    const request = await this.runDomain(() =>
      this.leaveDomain.submitLeaveRequest({
        requesterUserId: user.id,
        leaveType: command.leaveType,
        startDate: command.startDate,
        endDate: command.endDate,
        comment: command.comment,
        approverEmails: command.approverEmails,
        ccEmails: command.ccEmails,
        ...(command.hoursByDate !== undefined
          ? { hoursByDate: command.hoursByDate }
          : {}),
        audit: toAuditActor(user),
      }),
    )

    // Announce the submission so the notification handler can email approvers.
    // Without this publish the LeaveRequestSubmittedEvent handler never fires.
    // A request the domain already approved (approval optional, nobody
    // addressed) has no approver to ask: sending the approval request would
    // only mint a failed delivery row, so the CC recipients get the copy
    // notice and the requester gets the approved email off it.
    await this.publishSubmissionEmails(request, user.id, command)

    return this.withViewerContext(user, request)
  }

  /**
   * Propose new dates for an approved leave. Ownership is checked here (the
   * domain re-checks it too); everything else — whether the leave may still be
   * changed at all, whether the new dates fit — belongs to the domain, which
   * enforces the same rules for every caller.
   */
  async modifyLeaveRequest(
    currentUser: UserProfileType | undefined,
    requestId: string,
    input: ModifyLeaveRequestDto,
  ): Promise<LeaveRequestDetailDto> {
    const user = await this.requireProvisionedUser(currentUser)
    const original = await this.runDomain(() =>
      this.leaveDomain.getLeaveRequestDetail(requestId),
    )
    if (original.requesterUserId !== user.id) {
      throw new ForbiddenException(
        'You can only modify your own leave request.',
      )
    }
    // Same whitelisting as create: never spread the raw body, and no leaveType
    // (it is locked to the original's).
    const command = this.parseModifyLeaveRequest(input)
    const replacement = await this.runDomain(() =>
      this.leaveDomain.submitLeaveRequestModification({
        originalRequestId: requestId,
        requesterUserId: user.id,
        startDate: command.startDate,
        endDate: command.endDate,
        ...(command.comment !== undefined ? { comment: command.comment } : {}),
        approverEmails: command.approverEmails,
        ccEmails: command.ccEmails,
        ...(command.hoursByDate !== undefined
          ? { hoursByDate: command.hoursByDate }
          : {}),
        audit: toAuditActor(user),
      }),
    )

    // Same events as a fresh submission: the approvers of the REPLACEMENT need
    // the same email, deep-linked to the request they must now decide — or, if
    // it settled on its own, the same copy notice.
    await this.publishSubmissionEmails(replacement, user.id, command)

    return replacement
  }

  // The one place that decides which emails a new submission produces, shared
  // by create and modify so the two can never drift apart.
  private async publishSubmissionEmails(
    detail: LeaveRequestDetailDto,
    employeeId: string,
    command: { approverEmails: string[]; ccEmails: string[] },
  ): Promise<void> {
    // The workday length every one of these emails renders its day figures
    // against, carried ON the event so the message describes the leave against
    // the workday in force when it was filed.
    const hoursPerDay = await this.leaveDomain.getWorkdayHours()
    if (detail.status === LeaveRequestStatus.Pending) {
      publishLeaveRequestSubmittedEmail(this.eventBus, {
        detail,
        employeeId,
        approverEmails: command.approverEmails,
        ccEmails: command.ccEmails,
        hoursPerDay,
      })
      return
    }
    publishLeaveRequestAutoApprovedEmail(this.eventBus, {
      detail,
      employeeId,
      hoursPerDay,
    })
    publishLeaveRequestApprovedEmail(this.eventBus, detail, 'System', hoursPerDay)
  }

  // What the composer checks a picked period against before offering submit.
  async previewLeaveAvailability(
    currentUser: UserProfileType | undefined,
    input: LeaveAvailabilityQueryDto,
  ): Promise<LeaveAvailabilityPreviewDto> {
    const user = await this.requireProvisionedUser(currentUser)
    if (!Object.values(LeaveType).includes(input.leaveType)) {
      throw new BadRequestException('A valid leave type is required.')
    }
    if (!isRealIsoDate(input.startDate)) {
      throw new BadRequestException('startDate must be a valid calendar date.')
    }
    if (!isRealIsoDate(input.endDate)) {
      throw new BadRequestException('endDate must be a valid calendar date.')
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate.')
    }
    // This query validates its own input rather than going through a parse*
    // helper, so the hours map is guarded here explicitly: the preview is a
    // door into the same domain conversion the submit body reaches.
    const hoursByDate = this.parseHoursByDate(
      input.hoursByDate,
      input.startDate,
      input.endDate,
      'hours',
    )
    return this.runDomain(() =>
      this.leaveDomain.previewLeaveAvailability({
        userId: user.id,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.excludeRequestId !== undefined
          ? { excludeRequestId: input.excludeRequestId }
          : {}),
        ...(hoursByDate !== undefined ? { hoursByDate } : {}),
      }),
    )
  }

  async cancelLeaveRequest(
    currentUser: UserProfileType | undefined,
    requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    const user = this.requireAuthenticatedUser(currentUser)
    const request = await this.runDomain(() =>
      this.leaveDomain.getLeaveRequestDetail(requestId),
    )
    if (request.requesterUserId !== user.id) {
      throw new ForbiddenException(
        'You can only cancel your own leave request.',
      )
    }

    const cancelled = await this.runDomain(() =>
      this.leaveDomain.cancelLeaveRequest({
        requestId,
        actorUserId: user.id,
        actorDisplayName: user.name ?? user.email,
        audit: toAuditActor(user),
      }),
    )

    return this.withViewerContext(user, cancelled)
  }

  // Reject malformed payloads with a 400 before any balance is held.
  private parseCreateLeaveRequest(input: CreateLeaveRequestDto): {
    leaveType: LeaveType
    startDate: string
    endDate: string
    comment?: string
    approverEmails: string[]
    ccEmails: string[]
    hoursByDate?: Record<string, number>
  } {
    if (!Object.values(LeaveType).includes(input.leaveType)) {
      throw new BadRequestException('A valid leave type is required.')
    }
    if (!isRealIsoDate(input.startDate)) {
      throw new BadRequestException('startDate must be a valid calendar date.')
    }
    if (!isRealIsoDate(input.endDate)) {
      throw new BadRequestException('endDate must be a valid calendar date.')
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate.')
    }

    const approverEmails = this.parseEmailList(input.approverEmails, 'approver')
    const ccEmails = this.parseEmailList(input.ccEmails, 'CC')
    // Deliberately no approver-count minimum here: the domain folds the
    // settings defaults into the payload and enforces "at least one 'to'
    // approver other than the requester" AFTER that merge. A pre-merge check
    // would wrongly reject submissions already covered by a default approver.

    const hoursByDate = this.parseHoursByDate(
      input.hoursByDate,
      input.startDate,
      input.endDate,
      'hoursByDate',
    )

    return {
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      approverEmails,
      ccEmails,
      ...(hoursByDate !== undefined ? { hoursByDate } : {}),
    }
  }

  // A modification carries the same payload as a create minus the leave type,
  // which stays the original's.
  private parseModifyLeaveRequest(input: ModifyLeaveRequestDto): {
    startDate: string
    endDate: string
    comment?: string
    approverEmails: string[]
    ccEmails: string[]
    hoursByDate?: Record<string, number>
  } {
    if (!isRealIsoDate(input.startDate)) {
      throw new BadRequestException('startDate must be a valid calendar date.')
    }
    if (!isRealIsoDate(input.endDate)) {
      throw new BadRequestException('endDate must be a valid calendar date.')
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate.')
    }

    const hoursByDate = this.parseHoursByDate(
      input.hoursByDate,
      input.startDate,
      input.endDate,
      'hoursByDate',
    )

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      approverEmails: this.parseEmailList(input.approverEmails, 'approver'),
      ccEmails: this.parseEmailList(input.ccEmails, 'CC'),
      ...(hoursByDate !== undefined ? { hoursByDate } : {}),
    }
  }

  // SHAPE only, like parseEmailList beside it: what a payload has to be before
  // the domain can even look at it. Which dates are actually bookable and how
  // many hours a workday has are the domain's rules, and they are checked there
  // against the request's resolved working days and the org's setting; a copy
  // of them here would be a second answer to the same question.
  // `label` names the field the CALLER sent, because the same checks guard two
  // spellings of one payload: `hoursByDate` in a submit body and the compact
  // `hours` list on the availability query. A refusal that names the other
  // spelling sends the reader looking for a field they never wrote.
  private parseHoursByDate(
    value: unknown,
    startDate: string,
    endDate: string,
    label: string,
  ): Record<string, number> | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(
        `${label} must be an object keyed by calendar date.`,
      )
    }

    const hoursByDate: Record<string, number> = {}
    for (const [date, hours] of Object.entries(value)) {
      if (!isRealIsoDate(date)) {
        throw new BadRequestException(
          `${label} must be keyed by valid calendar dates.`,
        )
      }
      if (date < startDate || date > endDate) {
        throw new BadRequestException(
          `${label} names ${date}, which is outside the requested period.`,
        )
      }
      // Integer covers finite and non-NaN: a fractional hour has no meaning on
      // the grid, and a NaN would reach the books as a null portion.
      if (typeof hours !== 'number' || !Number.isInteger(hours)) {
        throw new BadRequestException(
          `${label} values must be whole numbers of hours.`,
        )
      }
      hoursByDate[date] = hours
    }
    return hoursByDate
  }

  private parseEmailList(value: unknown, label: string): string[] {
    if (value === undefined || value === null) {
      return []
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${label} recipients must be a list.`)
    }

    const normalized: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !isValidEmail(entry)) {
        throw new BadRequestException(
          `${label} recipients must be valid email addresses.`,
        )
      }
      normalized.push(normalizeEmail(entry))
    }
    return normalized
  }

  async getLeaveRequestDetail(
    currentUser: UserProfileType | undefined,
    requestId: string,
  ): Promise<LeaveRequestDetailDto> {
    const user = this.requireAuthenticatedUser(currentUser)
    const request = await this.runDomain(() => this.leaveDomain.getLeaveRequestDetail(requestId))
    // Build the viewer context once: it answers both the read gate (any standing
    // but Unrelated may view) and the authority the client renders from. Read
    // access and the standing classification are one question, so they read one
    // answer, kept in step with the decide check and the review page.
    const viewer = this.viewerContextFor(user, request)
    if (viewer.standing === LeaveRequestViewerStanding.Unrelated) {
      throw new ForbiddenException('You are not allowed to view this leave request.')
    }

    return { ...request, viewer }
  }

  async decideLeaveRequest(
    currentUser: UserProfileType | undefined,
    requestId: string,
    input: LeaveApprovalActionDto,
  ): Promise<LeaveRequestDetailDto> {
    const user = this.requireAuthenticatedUser(currentUser)
    const request = await this.runDomain(() => this.leaveDomain.getLeaveRequestDetail(requestId))
    if (!this.canDecideRequest(user, request)) {
      throw new ForbiddenException('You are not allowed to decide this leave request.')
    }

    // Whitelist the decision payload: never spread the raw body, so a client
    // cannot inject server-owned fields (e.g. a forged decidedAt that would
    // back/forward-date the audit trail and balance ledger).
    const commentPart =
      input.comment !== undefined ? { comment: input.comment } : {}

    // A designated 'to' approver casts one vote toward the all-approvers gate.
    // This endpoint has exactly ONE meaning; it never overrides the gate. An
    // override is a different act with different semantics, so it travels on its
    // own route (POST /admin/leave-requests/:requestId/force-decision) instead of
    // being inferred from the caller's role — the payload is identical either
    // way, so the caller could not otherwise say which one they meant.
    const decided = await this.runDomain(() =>
      this.leaveDomain.decideLeaveRequest({
        action: input.action,
        ...commentPart,
        requestId,
        actorUserId: user.id,
        actorDisplayName: user.name ?? user.email,
        actorEmail: user.email,
        audit: toAuditActor(user),
      }),
    )

    if (
      decided.status === LeaveRequestStatus.Approved ||
      decided.status === LeaveRequestStatus.Rejected
    ) {
      // The workday length the email renders its figures against, read once
      // for whichever of the two the decision produced.
      const hoursPerDay = await this.leaveDomain.getWorkdayHours()
      publishLeaveRequestApprovedEmail(
        this.eventBus,
        decided,
        user.name ?? user.email,
        hoursPerDay,
      )
      publishLeaveRequestRejectedEmail(
        this.eventBus,
        decided,
        user.name ?? user.email,
        hoursPerDay,
      )
    }

    return this.withViewerContext(user, decided)
  }

  // Answer "may this caller act on this request?" once, on the server, and ship
  // it with the request. The review page is reached by one link shared by every
  // recipient, so without this the client has to guess from the approver rows —
  // which is how a cc recipient ended up being offered the decision form.
  private withViewerContext(
    currentUser: UserProfileType,
    request: LeaveRequestDetailDto,
  ): LeaveRequestDetailDto {
    return {
      ...request,
      viewer: this.viewerContextFor(currentUser, request),
    }
  }

  // Delegates every rule to the shared describeViewerContextForDetail, so this
  // surface and the admin console read one policy rather than two look-alikes.
  private viewerContextFor(
    currentUser: UserProfileType,
    request: LeaveRequestDetailDto,
  ): LeaveRequestViewerContextDto {
    return describeViewerContextForDetail(currentUser, request)
  }

  private requireAuthenticatedUser(currentUser?: UserProfileType): UserProfileType {
    if (!currentUser) {
      throw new UnauthorizedException('Authentication required.')
    }

    return currentUser
  }

  private async requireProvisionedUser(
    currentUser?: UserProfileType,
  ): Promise<UserProfileType> {
    const user = this.requireAuthenticatedUser(currentUser)
    try {
      await this.leaveDomain.getUser(user.id)
      return user
    } catch (error) {
      this.throwMappedDomainError(error)
    }
  }

  // The enforcement point for POST /approval. It reads the SAME flag the
  // clients render their buttons from, so a surface can never offer an action
  // this would refuse.
  private canDecideRequest(
    currentUser: UserProfileType,
    request: LeaveRequestDetailDto,
  ): boolean {
    return this.viewerContextFor(currentUser, request).canDecide
  }

  private async runDomain<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.throwMappedDomainError(error)
    }
  }

  private throwMappedDomainError(error: unknown): never {
    // A missing request is a 404; a missing/unprovisioned user is a 401.
    if (error instanceof LeaveDomainNotFoundError) {
      if (error.message.startsWith('Unknown user:')) {
        throw new UnauthorizedException('Authenticated user is not provisioned.')
      }
      throw new NotFoundException(error.message)
    }

    // Every semantic rule violation surfaces as a 400.
    if (error instanceof LeaveDomainValidationError) {
      throw new BadRequestException(error.message)
    }

    throw error
  }
}

@QueryHandler(GetEmployeeDashboardQuery)
export class GetEmployeeDashboardHandler
  implements IQueryHandler<GetEmployeeDashboardQuery, EmployeeDashboardDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(query: GetEmployeeDashboardQuery): Promise<EmployeeDashboardDto> {
    return this.employeeLeave.getEmployeeDashboard(query.currentUser)
  }
}

@QueryHandler(ListHolidayCalendarsQuery)
export class ListHolidayCalendarsHandler
  implements IQueryHandler<ListHolidayCalendarsQuery, HolidayCalendarDto[]>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(query: ListHolidayCalendarsQuery): Promise<HolidayCalendarDto[]> {
    return this.employeeLeave.listHolidayCalendars(query.currentUser, query.filters)
  }
}

@QueryHandler(ListCountriesQuery)
export class ListCountriesHandler
  implements IQueryHandler<ListCountriesQuery, CountryDto[]>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(query: ListCountriesQuery): Promise<CountryDto[]> {
    return this.employeeLeave.listCountries(query.currentUser)
  }
}

@QueryHandler(ListMyLeaveRequestsQuery)
export class ListMyLeaveRequestsHandler
  implements IQueryHandler<ListMyLeaveRequestsQuery, LeaveRequestHistoryDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(query: ListMyLeaveRequestsQuery): Promise<LeaveRequestHistoryDto> {
    return this.employeeLeave.listMyLeaveRequests(
      query.currentUser,
      query.filters,
    )
  }
}

@QueryHandler(GetLeaveRequestDetailQuery)
export class GetLeaveRequestDetailHandler
  implements IQueryHandler<GetLeaveRequestDetailQuery, LeaveRequestDetailDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(query: GetLeaveRequestDetailQuery): Promise<LeaveRequestDetailDto> {
    return this.employeeLeave.getLeaveRequestDetail(
      query.currentUser,
      query.requestId,
    )
  }
}

@QueryHandler(GetLeaveRequestFormContextQuery)
export class GetLeaveRequestFormContextHandler
  implements
    IQueryHandler<GetLeaveRequestFormContextQuery, LeaveRequestFormContextDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    query: GetLeaveRequestFormContextQuery,
  ): Promise<LeaveRequestFormContextDto> {
    return this.employeeLeave.getLeaveRequestFormContext(query.currentUser)
  }
}

@CommandHandler(SubmitLeaveRequestCommand)
export class SubmitLeaveRequestHandler
  implements ICommandHandler<SubmitLeaveRequestCommand, LeaveRequestDetailDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    command: SubmitLeaveRequestCommand,
  ): Promise<LeaveRequestDetailDto> {
    return this.employeeLeave.submitLeaveRequest(
      command.currentUser,
      command.input,
    )
  }
}

@CommandHandler(DecideLeaveRequestCommand)
export class DecideLeaveRequestHandler
  implements ICommandHandler<DecideLeaveRequestCommand, LeaveRequestDetailDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    command: DecideLeaveRequestCommand,
  ): Promise<LeaveRequestDetailDto> {
    return this.employeeLeave.decideLeaveRequest(
      command.currentUser,
      command.requestId,
      command.input,
    )
  }
}

@CommandHandler(CancelLeaveRequestCommand)
export class CancelLeaveRequestHandler
  implements ICommandHandler<CancelLeaveRequestCommand, LeaveRequestDetailDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    command: CancelLeaveRequestCommand,
  ): Promise<LeaveRequestDetailDto> {
    return this.employeeLeave.cancelLeaveRequest(
      command.currentUser,
      command.requestId,
    )
  }
}

@CommandHandler(ModifyLeaveRequestCommand)
export class ModifyLeaveRequestHandler
  implements ICommandHandler<ModifyLeaveRequestCommand, LeaveRequestDetailDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    command: ModifyLeaveRequestCommand,
  ): Promise<LeaveRequestDetailDto> {
    return this.employeeLeave.modifyLeaveRequest(
      command.currentUser,
      command.requestId,
      command.input,
    )
  }
}

@QueryHandler(PreviewLeaveAvailabilityQuery)
export class PreviewLeaveAvailabilityHandler
  implements
    IQueryHandler<PreviewLeaveAvailabilityQuery, LeaveAvailabilityPreviewDto>
{
  constructor(
    @Inject(EmployeeLeaveApplicationService)
    private readonly employeeLeave: EmployeeLeaveApplicationService,
  ) {}

  async execute(
    query: PreviewLeaveAvailabilityQuery,
  ): Promise<LeaveAvailabilityPreviewDto> {
    return this.employeeLeave.previewLeaveAvailability(
      query.currentUser,
      query.input,
    )
  }
}

export const employeeLeaveHandlers = [
  GetEmployeeDashboardHandler,
  ListHolidayCalendarsHandler,
  ListCountriesHandler,
  ListMyLeaveRequestsHandler,
  GetLeaveRequestDetailHandler,
  GetLeaveRequestFormContextHandler,
  SubmitLeaveRequestHandler,
  DecideLeaveRequestHandler,
  CancelLeaveRequestHandler,
  ModifyLeaveRequestHandler,
  PreviewLeaveAvailabilityHandler,
] as const
