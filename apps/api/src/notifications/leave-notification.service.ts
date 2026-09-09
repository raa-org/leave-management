/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { CommandBus } from '@nestjs/cqrs'
import {
  SendCommunicationEmailCommand,
  type SendEmailResult,
} from '@trusted-modules/communication-email-core'
import type {
  AdminEmployeeDetailDto,
  LeaveRequestApprovalRecipientDto,
} from '@workspace/contracts'
import {
  ApproverKind,
  LeaveRequestApprovedEvent,
  LeaveRequestAutoApprovedEvent,
  LeaveRequestRejectedEvent,
  LeaveRequestSubmittedEvent,
  LeaveType,
} from '@workspace/contracts'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { buildApprovalRequestEmail } from './email/templates/approval-request'
import { buildAutoApprovedCopiedEmail } from './email/templates/auto-approved-copied'
import { buildRequestApprovedEmployeeEmail } from './email/templates/request-approved-employee'
import { decidingApproverLabels } from './email/templates/shared'
import { buildRequestRejectedEmployeeEmail } from './email/templates/request-rejected-employee'
import { buildVacationBalanceAdjustedEmployeeEmail } from './email/templates/vacation-balance-adjusted-employee'
import {
  LeaveNotificationDeliveryStore,
  type LeaveNotificationDeliveryRecord,
} from './leave-notification.delivery-store'

const DEFAULT_FRONTEND_URL = 'http://localhost:4200'
const APPROVAL_REVIEW_ROUTE = '/employee/approval/review'
const EMPLOYEE_REQUEST_ROUTE = '/employee/history'
const EMPLOYEE_BALANCE_ROUTE = '/employee/balance'

export const LEAVE_NOTIFICATIONS_CONFIG = Symbol('LEAVE_NOTIFICATIONS_CONFIG')

export interface LeaveNotificationsConfig {
  approvalReviewBaseUrl?: string
}

export interface EmailCommandExecutor {
  execute<TResult = unknown>(command: unknown): Promise<TResult>
}

@Injectable()
export class LeaveNotificationService {
  private readonly logger = new Logger(LeaveNotificationService.name)

  constructor(
    @Inject(CommandBus)
    private readonly commandBus: EmailCommandExecutor,
    @Inject(LeaveDomainService)
    private readonly leaveDomain: LeaveDomainService,
    @Inject(LeaveNotificationDeliveryStore)
    private readonly deliveryStore: LeaveNotificationDeliveryStore,
    @Optional()
    @Inject(LEAVE_NOTIFICATIONS_CONFIG)
    private readonly config?: LeaveNotificationsConfig,
  ) {}

  async sendApprovalRequest(
    event: LeaveRequestSubmittedEvent,
  ): Promise<LeaveNotificationDeliveryRecord> {
    const request = await this.leaveDomain.getLeaveRequestDetail(event.requestId)
    // Address the email to exactly the request's authorized approvers (which
    // already fold in the settings defaults). This guarantees every recipient
    // can actually open and decide the request instead of hitting a 403.
    const to = recipientsByKind(request.approvers, ApproverKind.To)
    const cc = recipientsByKind(request.approvers, ApproverKind.Cc).filter(
      (email) => !to.includes(email),
    )
    const approvalUrl = this.buildApprovalReviewUrl(event.requestId)
    const queuedAt = event.submittedAt
    const { subject, html } = buildApprovalRequestEmail({
      requestId: event.requestId,
      requesterDisplayName: request.requesterDisplayName,
      leaveType: request.leaveType,
      startDate: event.startDate,
      endDate: event.endDate,
      requestedDays: event.requestedDays,
      paidDays: event.paidDays,
      unpaidDays: event.unpaidDays,
      hoursPerDay: event.hoursPerDay,
      comment: request.comment,
      approvalUrl,
    })
    const tracked = await this.deliveryStore.trackPending({
      requestId: event.requestId,
      subject,
      to,
      cc,
      approvalUrl,
      queuedAt,
    })

    if (to.length === 0) {
      this.logger.error(
        `Leave request ${event.requestId} has no approval recipients; email not sent.`,
      )
      return (
        (await this.deliveryStore.markFailedById(
          tracked.deliveryId,
          'No approval recipients configured.',
          queuedAt,
        )) ?? tracked
      )
    }

    // The command returns the send result, so the row this method queued is
    // closed out by its own primary key. Nothing is matched back by subject and
    // recipients, which two requests from one employee to one approver set
    // share exactly.
    let result: SendEmailResult
    try {
      result = await this.commandBus.execute<SendEmailResult>(
        new SendCommunicationEmailCommand({
          to,
          ...(cc.length > 0 ? { cc } : {}),
          subject,
          html,
        }),
      )
    } catch (error) {
      this.logger.error(
        `Failed to dispatch approval email for leave request ${event.requestId}: ${toErrorMessage(error)}`,
      )
      return (
        (await this.deliveryStore.markFailedById(
          tracked.deliveryId,
          toErrorMessage(error),
          new Date().toISOString(),
        )) ?? tracked
      )
    }

    return (
      (await this.deliveryStore.markSentById(tracked.deliveryId, {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      })) ?? tracked
    )
  }

  /**
   * The copy notice for a request the system approved on its own. CC
   * recipients are folded onto every request under either approval mode, but
   * the approval-request email is deliberately not sent for an approver-less
   * request (there is nobody to ask) and the approved email addresses only the
   * requester — so without this they would hear nothing at all.
   *
   * Journalled like the approval request, not dispatched like an employee
   * email: this one goes to addresses an admin configured, and a refusal has
   * to be visible in the delivery log rather than only in a server log line.
   */
  async sendAutoApprovedCopyNotice(
    event: LeaveRequestAutoApprovedEvent,
  ): Promise<LeaveNotificationDeliveryRecord | undefined> {
    const to = event.ccEmails
      .map((email) => email.trim().toLowerCase())
      .filter((email, index, all) => email !== '' && all.indexOf(email) === index)
    if (to.length === 0) {
      // Nobody is copied: not a failure, and no delivery row to show for it.
      return undefined
    }

    const request = await this.leaveDomain.getLeaveRequestDetail(event.requestId)
    const requestUrl = this.buildApprovalReviewUrl(event.requestId)
    const { subject, html } = buildAutoApprovedCopiedEmail({
      requestId: event.requestId,
      requesterDisplayName: request.requesterDisplayName,
      leaveType: event.leaveType,
      startDate: event.startDate,
      endDate: event.endDate,
      requestedDays: event.requestedDays,
      paidDays: event.paidDays,
      unpaidDays: event.unpaidDays,
      hoursPerDay: event.hoursPerDay,
      ...(request.comment !== undefined ? { comment: request.comment } : {}),
      requestUrl,
    })
    const tracked = await this.deliveryStore.trackPending({
      requestId: event.requestId,
      subject,
      to,
      cc: [],
      approvalUrl: requestUrl,
      queuedAt: event.decidedAt,
    })

    let result: SendEmailResult
    try {
      result = await this.commandBus.execute<SendEmailResult>(
        new SendCommunicationEmailCommand({ to, subject, html }),
      )
    } catch (error) {
      this.logger.error(
        `Failed to dispatch the auto-approval copy notice for leave request ${event.requestId}: ${toErrorMessage(error)}`,
      )
      return (
        (await this.deliveryStore.markFailedById(
          tracked.deliveryId,
          toErrorMessage(error),
          new Date().toISOString(),
        )) ?? tracked
      )
    }

    return (
      (await this.deliveryStore.markSentById(tracked.deliveryId, {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      })) ?? tracked
    )
  }

  async sendEmployeeApprovedNotification(
    event: LeaveRequestApprovedEvent,
  ): Promise<void> {
    const employee = await this.leaveDomain.getUser(event.requesterUserId)
    const request = await this.leaveDomain.getLeaveRequestDetail(event.requestId)
    const to = employee.email.trim().toLowerCase()
    if (!to) {
      this.logger.error(
        `Leave request ${event.requestId}: requester has no email; approval notification not sent.`,
      )
      return
    }

    const { subject, html } = buildRequestApprovedEmployeeEmail({
      employeeDisplayName: request.requesterDisplayName,
      leaveType: event.leaveType,
      startDate: event.startDate,
      endDate: event.endDate,
      requestedDays: event.requestedDays,
      // Off the detail rather than the event: the approved/rejected events carry
      // no split, and this handler already holds the request it was frozen on.
      paidDays: request.paidDays,
      unpaidDays: request.unpaidDays,
      hoursPerDay: event.hoursPerDay,
      actorDisplayName: event.actorDisplayName,
      approverLabels: decidingApproverLabels(request.approvers),
      requestUrl: this.buildEmployeeRequestUrl(event.requestId),
    })

    await this.dispatchEmployeeEmail(event.requestId, to, subject, html)
  }

  async sendEmployeeRejectedNotification(
    event: LeaveRequestRejectedEvent,
  ): Promise<void> {
    const employee = await this.leaveDomain.getUser(event.requesterUserId)
    const request = await this.leaveDomain.getLeaveRequestDetail(event.requestId)
    const to = employee.email.trim().toLowerCase()
    if (!to) {
      this.logger.error(
        `Leave request ${event.requestId}: requester has no email; rejection notification not sent.`,
      )
      return
    }

    const { subject, html } = buildRequestRejectedEmployeeEmail({
      employeeDisplayName: request.requesterDisplayName,
      leaveType: event.leaveType,
      startDate: event.startDate,
      endDate: event.endDate,
      requestedDays: event.requestedDays,
      hoursPerDay: event.hoursPerDay,
      actorDisplayName: event.actorDisplayName,
      requestUrl: this.buildEmployeeRequestUrl(event.requestId),
      comment: event.comment,
    })

    await this.dispatchEmployeeEmail(event.requestId, to, subject, html)
  }

  // After adjust commit: mail employee; failures are logged, never roll back.
  async notifyVacationBalanceAdjusted(input: {
    detail: AdminEmployeeDetailDto
    employeeUserId: string
    actorDisplayName: string
    deltaDays: number
    note: string
    // The workday length the adjustment was audited against, straight off the
    // domain result: the email must state the change in the same figure.
    hoursPerDay: number
  }): Promise<void> {
    const employee = await this.leaveDomain.getUser(input.employeeUserId)
    const to = employee.email.trim().toLowerCase()
    if (!to) {
      this.logger.error(
        `Vacation balance adjustment for ${input.employeeUserId}: no email; notification not sent.`,
      )
      return
    }

    const vacation = input.detail.balances.find(
      (balance) => balance.leaveType === LeaveType.Vacation,
    )
    const { subject, html } = buildVacationBalanceAdjustedEmployeeEmail({
      employeeDisplayName: input.detail.displayName || employee.displayName,
      actorDisplayName: input.actorDisplayName,
      deltaDays: input.deltaDays,
      note: input.note,
      hoursPerDay: input.hoursPerDay,
      ...(vacation
        ? {
            availableDays: vacation.availableDays - vacation.onHoldDays,
            accruedDays: vacation.accruedDays,
          }
        : {}),
      balanceUrl: this.buildEmployeeBalanceUrl(),
    })

    try {
      await this.commandBus.execute(
        new SendCommunicationEmailCommand({ to, subject, html }),
      )
    } catch (error) {
      this.logger.error(
        `Failed to dispatch vacation balance email for ${input.employeeUserId}: ${toErrorMessage(error)}`,
      )
    }
  }

  private async dispatchEmployeeEmail(
    requestId: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    try {
      await this.commandBus.execute(
        new SendCommunicationEmailCommand({
          to,
          subject,
          html,
        }),
      )
    } catch (error) {
      this.logger.error(
        `Failed to dispatch employee email for leave request ${requestId}: ${toErrorMessage(error)}`,
      )
    }
  }

  // Build the link that opens the SPA approve/reject surface. The base can be
  // set explicitly (config or LEAVE_APPROVAL_REVIEW_BASE_URL); otherwise it is
  // derived from FRONTEND_URL + BASE_PATH so the link resolves both in local
  // dev and behind the runtime sub-path proxy.
  private buildApprovalReviewUrl(requestId: string): string {
    const base = this.resolveApprovalReviewBaseUrl()
    return `${base.replace(/\/+$/, '')}/${encodeURIComponent(requestId)}`
  }

  private buildEmployeeRequestUrl(requestId: string): string {
    return `${this.resolveAppRoot()}${EMPLOYEE_REQUEST_ROUTE}/${encodeURIComponent(requestId)}`
  }

  private buildEmployeeBalanceUrl(): string {
    return `${this.resolveAppRoot()}${EMPLOYEE_BALANCE_ROUTE}`
  }

  private resolveAppRoot(): string {
    const configured =
      this.config?.approvalReviewBaseUrl?.trim() ||
      process.env.LEAVE_APPROVAL_REVIEW_BASE_URL?.trim()
    if (configured) {
      return configured
        .replace(/\/employee\/approval\/review\/?$/, '')
        .replace(/\/approval\/review\/?$/, '')
        .replace(/\/review\/?$/, '')
        .replace(/\/+$/, '')
    }

    const origin = (
      process.env.FRONTEND_URL?.trim() || DEFAULT_FRONTEND_URL
    ).replace(/\/+$/, '')
    const rawBasePath = (process.env.BASE_PATH?.trim() ?? '').replace(/\/+$/, '')
    // Guarantee a single leading slash so origin + basePath is never joined
    // without a separator (e.g. 'https://h' + 'runtime/abc').
    const basePath =
      rawBasePath && !rawBasePath.startsWith('/') ? `/${rawBasePath}` : rawBasePath
    // FRONTEND_URL in the deployed runtime already includes the mount sub-path
    // (which equals BASE_PATH). Only append BASE_PATH when the origin does not
    // already end with it, so the prefix is never duplicated.
    const appRoot =
      basePath && !origin.endsWith(basePath) ? `${origin}${basePath}` : origin
    return appRoot.replace(/\/+$/, '')
  }

  private resolveApprovalReviewBaseUrl(): string {
    const configured =
      this.config?.approvalReviewBaseUrl?.trim() ||
      process.env.LEAVE_APPROVAL_REVIEW_BASE_URL?.trim()
    if (configured) {
      return configured.replace(/\/+$/, '')
    }
    return `${this.resolveAppRoot()}${APPROVAL_REVIEW_ROUTE}`
  }
}

function recipientsByKind(
  approvers: LeaveRequestApprovalRecipientDto[],
  kind: ApproverKind,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const approver of approvers) {
    if (approver.kind !== kind) {
      continue
    }
    const normalized = approver.email.trim().toLowerCase()
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown email dispatch error.'
}
