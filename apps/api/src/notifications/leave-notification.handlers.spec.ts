/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import 'reflect-metadata'
import {
  SendCommunicationEmailCommand,
  type SendEmailResult,
} from '@trusted-modules/communication-email-core'
import type { LeaveRequestDetailDto } from '@workspace/contracts'
import {
  LeaveRequestAutoApprovedEvent,
  LeaveRequestStatus,
  LeaveRequestSubmittedEvent,
  LeaveType,
  NotificationDeliveryStatus,
} from '@workspace/contracts'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { DataSource } from 'typeorm'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import { NotificationService } from '../domain/notification.service'
import { LeaveNotificationDeliveryStore } from './leave-notification.delivery-store'
import { NotificationDeliveryEntity } from './notification-delivery.entity'
import {
  LeaveRequestAutoApprovedNotificationHandler,
  LeaveRequestSubmittedNotificationHandler,
} from './leave-notification.handlers'
import {
  type EmailCommandExecutor,
  LeaveNotificationService,
} from './leave-notification.service'

describe('Leave notification handlers', () => {
  let dataSource: DataSource
  let leaveDomain: LeaveDomainService
  let deliveryStore: LeaveNotificationDeliveryStore
  let commandExecutor: StubEmailCommandExecutor
  let notificationService: LeaveNotificationService
  let submittedHandler: LeaveRequestSubmittedNotificationHandler

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    const clock = new ClockService()
    leaveDomain = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    deliveryStore = new LeaveNotificationDeliveryStore(
      dataSource.getRepository(NotificationDeliveryEntity),
    )
    commandExecutor = new StubEmailCommandExecutor()
    notificationService = new LeaveNotificationService(
      commandExecutor,
      leaveDomain,
      deliveryStore,
      {
        approvalReviewBaseUrl: 'https://leave.example.test/review',
      },
    )
    submittedHandler = new LeaveRequestSubmittedNotificationHandler(
      notificationService,
    )

    await seedLeaveDomain(leaveDomain)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('merges request recipients with default settings and sends an approval email command', async () => {
    const request = await createPendingLeaveRequest(leaveDomain)
    const event = toSubmittedEvent(request)

    await submittedHandler.handle(event)

    expect(commandExecutor.commands).toHaveLength(1)
    const command = commandExecutor.commands[0]
    expect(command).toBeInstanceOf(SendCommunicationEmailCommand)

    const payload = command.payload
    const to = getRecipientEmails(payload.to)
    const cc = getRecipientEmails(payload.cc)

    expect(to).toEqual([
      'manager@example.com',
      'lead@example.com',
      'director@example.com',
    ])
    expect(cc).toEqual(['hr@example.com', 'finance@example.com'])
    expect(payload.subject).toBe(
      'Approval needed for Alex Employee',
    )
    expect(payload.text).toBeUndefined()
    expect(payload.html).toContain(
      `https://leave.example.test/review/${request.requestId}`,
    )

    // The journal row is queued with the same merged recipients the command
    // carried. It is already resolved by the time the handler returns: the send
    // result closes the row out in the same call, so Pending is no longer a
    // state anyone observes from outside.
    expect(await deliveryStore.getLatestForRequest(request.requestId)).toMatchObject({
      requestId: request.requestId,
      to,
      cc,
      status: NotificationDeliveryStatus.Sent,
    })
  })

  it('builds the approval link against the SPA approval-review route by default', async () => {
    // No approvalReviewBaseUrl override: the link must target the real SPA route
    // (/employee/approval/review/:id), not a route that does not exist.
    const service = new LeaveNotificationService(
      commandExecutor,
      leaveDomain,
      deliveryStore,
    )
    const submitted = new LeaveRequestSubmittedNotificationHandler(service)
    const request = await createPendingLeaveRequest(leaveDomain)

    await submitted.handle(toSubmittedEvent(request))

    const payload = commandExecutor.commands[0].payload
    expect(payload.html).toContain(`/employee/approval/review/${request.requestId}`)
  })

  it('does not duplicate the mount sub-path when FRONTEND_URL already includes BASE_PATH', async () => {
    vi.stubEnv('FRONTEND_URL', 'https://host.example/runtime/abc/')
    vi.stubEnv('BASE_PATH', '/runtime/abc')
    const service = new LeaveNotificationService(
      commandExecutor,
      leaveDomain,
      deliveryStore,
    )
    const submitted = new LeaveRequestSubmittedNotificationHandler(service)
    const request = await createPendingLeaveRequest(leaveDomain)

    await submitted.handle(toSubmittedEvent(request))

    const payload = commandExecutor.commands[0].payload
    expect(payload.html).toContain(
      `https://host.example/runtime/abc/employee/approval/review/${request.requestId}`,
    )
    expect(payload.html).not.toContain('/runtime/abc/runtime/abc')
  })

  it('records the send result against the row it queued', async () => {
    const request = await createPendingLeaveRequest(leaveDomain)

    await submittedHandler.handle(toSubmittedEvent(request))

    expect(await deliveryStore.getLatestForRequest(request.requestId)).toMatchObject({
      requestId: request.requestId,
      status: NotificationDeliveryStatus.Sent,
      messageId: 'message-1',
    })
  })

  it('records a dispatch failure against the row it queued', async () => {
    const request = await createPendingLeaveRequest(leaveDomain)
    commandExecutor.failure = new Error('SMTP offline')

    await submittedHandler.handle(toSubmittedEvent(request))

    expect(await deliveryStore.getLatestForRequest(request.requestId)).toMatchObject({
      requestId: request.requestId,
      status: NotificationDeliveryStatus.Failed,
      errorMessage: 'SMTP offline',
    })
  })

  it('keeps two requests from one employee to one approver set apart', async () => {
    // The subject carries no request id, and both requests address the same
    // approvers, so subject + recipients cannot tell these two apart. Each
    // outcome must still land on the row its own send produced.
    const first = await createPendingLeaveRequest(leaveDomain)
    const second = await createPendingLeaveRequest(leaveDomain, {
      startDate: '2026-06-17',
      endDate: '2026-06-18',
    })

    await submittedHandler.handle(toSubmittedEvent(first))
    await submittedHandler.handle(toSubmittedEvent(second))

    // Same subject on both, which is the whole point of the test.
    expect(commandExecutor.commands[0].payload.subject).toBe(
      commandExecutor.commands[1].payload.subject,
    )

    const firstRows = await deliveryStore.listForRequest(first.requestId)
    const secondRows = await deliveryStore.listForRequest(second.requestId)
    expect(firstRows).toHaveLength(1)
    expect(secondRows).toHaveLength(1)
    expect(firstRows[0]).toMatchObject({
      status: NotificationDeliveryStatus.Sent,
      messageId: 'message-1',
    })
    expect(secondRows[0]).toMatchObject({
      status: NotificationDeliveryStatus.Sent,
      messageId: 'message-2',
    })
  })

  it('names the addresses the mail server refused instead of reporting a clean send', async () => {
    const request = await createPendingLeaveRequest(leaveDomain)
    commandExecutor.resultOverrides.push({
      accepted: ['manager@example.com'],
      rejected: ['lead@example.com'],
    })

    await submittedHandler.handle(toSubmittedEvent(request))

    // Someone did receive it, so the delivery is Sent; the refused address is
    // recorded rather than silently dropped.
    expect(await deliveryStore.getLatestForRequest(request.requestId)).toMatchObject({
      status: NotificationDeliveryStatus.Sent,
      errorMessage: 'Rejected by the mail server: lead@example.com',
    })
  })

  it('treats a send nobody accepted as a failure', async () => {
    const request = await createPendingLeaveRequest(leaveDomain)
    commandExecutor.resultOverrides.push({
      accepted: [],
      rejected: ['manager@example.com', 'lead@example.com'],
    })

    await submittedHandler.handle(toSubmittedEvent(request))

    expect(await deliveryStore.getLatestForRequest(request.requestId)).toMatchObject({
      status: NotificationDeliveryStatus.Failed,
      errorMessage:
        'Rejected by the mail server: manager@example.com, lead@example.com',
    })
  })

  // The copy notice for a request the system approved on its own. It is the CC
  // recipients' ONLY signal: the approval request is deliberately not sent for
  // a request nobody can decide, and the approved mail goes to the requester.
  describe('the auto-approval copy notice', () => {
    const autoApprove = async () => {
      await leaveDomain.updateLeaveSettings({
        defaultVacationDays: 24,
        defaultSickDays: 12,
        approvalRequired: false,
        defaultApproverEmails: ['manager@example.com'],
        defaultCcApproverEmails: ['hr@example.com'],
        countries: [{ code: 'UA', name: 'Ukraine' }],
        updatedAt: '2026-05-01T00:00:00.000Z',
      })
      return leaveDomain.submitLeaveRequest({
        requesterUserId: testUuid('employee-1'),
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: [],
        ccEmails: [],
        comment: 'Family trip',
        submittedAt: '2026-06-01T09:30:00.000Z',
      })
    }

    const toAutoApprovedEvent = (request: LeaveRequestDetailDto) =>
      new LeaveRequestAutoApprovedEvent(
        request.requestId,
        request.requesterUserId,
        request.leaveType,
        request.startDate,
        request.endDate,
        request.requestedDays,
        request.approvers
          .filter((recipient) => recipient.kind === 'cc')
          .map((recipient) => recipient.email),
        request.decidedAt ?? request.submittedAt,
        request.paidDays,
        request.unpaidDays,
        8,
      )

    it('mails the copied recipients once and journals the delivery', async () => {
      const request = await autoApprove()
      expect(request.status).toBe(LeaveRequestStatus.Approved)
      const handler = new LeaveRequestAutoApprovedNotificationHandler(
        notificationService,
      )

      await handler.handle(toAutoApprovedEvent(request))

      expect(commandExecutor.commands).toHaveLength(1)
      const payload = commandExecutor.commands[0]!.payload
      // Addressed TO the copied recipients: there is no approver to put in
      // front of them, and a cc-only envelope would read as a blind copy.
      expect(getRecipientEmails(payload.to)).toEqual(['hr@example.com'])
      expect(getRecipientEmails(payload.cc)).toEqual([])
      // Observer voice, never the approval-request wording.
      expect(payload.subject).toBe('Alex Employee booked Vacation')
      expect(payload.html).not.toContain('Approval needed')
      expect(payload.html).toContain('approved')
      expect(payload.html).toContain(
        `https://leave.example.test/review/${request.requestId}`,
      )

      expect(
        await deliveryStore.getLatestForRequest(request.requestId),
      ).toMatchObject({
        requestId: request.requestId,
        to: ['hr@example.com'],
        cc: [],
        status: NotificationDeliveryStatus.Sent,
      })
    })

    it('records a dispatch failure instead of losing it to a log line', async () => {
      const request = await autoApprove()
      commandExecutor.failure = new Error('smtp unreachable')
      const handler = new LeaveRequestAutoApprovedNotificationHandler(
        notificationService,
      )

      await handler.handle(toAutoApprovedEvent(request))

      expect(
        await deliveryStore.getLatestForRequest(request.requestId),
      ).toMatchObject({
        status: NotificationDeliveryStatus.Failed,
        errorMessage: 'smtp unreachable',
      })
    })

    it('sends nothing, and journals nothing, when nobody is copied', async () => {
      await leaveDomain.updateLeaveSettings({
        defaultVacationDays: 24,
        defaultSickDays: 12,
        approvalRequired: false,
        defaultApproverEmails: [],
        defaultCcApproverEmails: [],
        countries: [{ code: 'UA', name: 'Ukraine' }],
        updatedAt: '2026-05-01T00:00:00.000Z',
      })
      const request = await leaveDomain.submitLeaveRequest({
        requesterUserId: testUuid('employee-1'),
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: [],
        ccEmails: [],
        submittedAt: '2026-06-01T09:30:00.000Z',
      })
      const handler = new LeaveRequestAutoApprovedNotificationHandler(
        notificationService,
      )

      await handler.handle(toAutoApprovedEvent(request))

      // No recipients is not a failure: there is no row to show for it.
      expect(commandExecutor.commands).toHaveLength(0)
      expect(
        await deliveryStore.getLatestForRequest(request.requestId),
      ).toBeUndefined()
    })
  })
})

class StubEmailCommandExecutor implements EmailCommandExecutor {
  readonly commands: SendCommunicationEmailCommand[] = []
  failure?: Error
  // Applied to the nth send in order; sends past the end get a plain accepted
  // result. The real command returns this shape, and the service now reads it,
  // so a stub returning undefined would leave the whole path untested.
  readonly resultOverrides: Array<Partial<SendEmailResult>> = []
  private sends = 0

  async execute<TResult = unknown>(command: unknown): Promise<TResult> {
    if (command instanceof SendCommunicationEmailCommand) {
      this.commands.push(command)
    }

    if (this.failure) {
      throw this.failure
    }

    const index = this.sends++
    const result: SendEmailResult = {
      ok: true,
      // Distinct per send, so a test can tell which row got whose outcome.
      messageId: `message-${index + 1}`,
      accepted: [],
      rejected: [],
      pending: [],
      response: '250 OK',
      envelope: { to: [] },
      ...this.resultOverrides[index],
    }
    return result as TResult
  }
}

async function seedLeaveDomain(
  leaveDomain: LeaveDomainService,
): Promise<void> {
  await leaveDomain.updateLeaveSettings({
    defaultVacationDays: 24,
    defaultSickDays: 12,
    defaultApproverEmails: ['manager@example.com', 'director@example.com'],
    defaultCcApproverEmails: ['finance@example.com', 'lead@example.com'],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: '2026-05-01T00:00:00.000Z',
  })

  await seedHolidayCalendar(leaveDomain)

  await leaveDomain.upsertUser({
    userId: testUuid('employee-1'),
    email: 'alex.employee@example.com',
    displayName: 'Alex Employee',
    countryCode: 'UA',
    employmentStartDate: '2026-01-01',
    createdAt: '2026-05-01T00:00:00.000Z',
  })
}

function createPendingLeaveRequest(
  leaveDomain: LeaveDomainService,
  // Same employee, same approvers by default; only the period moves, so two
  // requests remain indistinguishable by subject and recipients.
  period: { startDate: string; endDate: string } = {
    startDate: '2026-06-10',
    endDate: '2026-06-11',
  },
): Promise<LeaveRequestDetailDto> {
  return leaveDomain.submitLeaveRequest({
    requesterUserId: testUuid('employee-1'),
    leaveType: LeaveType.Vacation,
    startDate: period.startDate,
    endDate: period.endDate,
    approverEmails: ['manager@example.com', 'lead@example.com'],
    ccEmails: ['hr@example.com', 'director@example.com'],
    comment: 'Family trip',
    submittedAt: '2026-06-01T09:30:00.000Z',
  })
}

function toSubmittedEvent(request: LeaveRequestDetailDto) {
  const to = request.approvers
    .filter((recipient) => recipient.kind === 'to')
    .map((recipient) => recipient.email)
  const cc = request.approvers
    .filter((recipient) => recipient.kind === 'cc')
    .map((recipient) => recipient.email)

  return new LeaveRequestSubmittedEvent(
    request.requestId,
    request.requesterUserId,
    request.leaveType,
    request.startDate,
    request.endDate,
    request.requestedDays,
    to,
    cc,
    request.submittedAt,
    request.paidDays,
    request.unpaidDays,
    8,
  )
}

function getRecipientEmails(
  recipients:
    | string
    | { email: string }
    | Array<string | { email: string }>
    | undefined,
): string[] {
  if (!recipients) {
    return []
  }

  if (Array.isArray(recipients)) {
    return recipients.map((recipient) =>
      typeof recipient === 'string' ? recipient : recipient.email,
    )
  }

  return [typeof recipients === 'string' ? recipients : recipients.email]
}
