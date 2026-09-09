/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { In, IsNull } from 'typeorm'
import type { DataSource, EntityManager } from 'typeorm'
import {
  AppRoleName,
  LeaveApprovalAction,
  LeaveRequestStatus,
  LeaveType,
  NotificationType,
} from '@workspace/contracts'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveDomainService } from './leave-domain.service'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { NotificationService } from './notification.service'
import { NotificationEntity } from './entities/notification.entity'

// The notification write path: who is told what, and when nobody is told.
// Everything here runs against a real Postgres, because the whole guarantee is
// that a notification commits atomically with the change it announces.
describe('leave notifications', () => {
  let dataSource: DataSource
  let service: LeaveDomainService
  let notifications: NotificationService

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource?.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    const clock = new ClockService()
    notifications = new NotificationService(dataSource, clock)
    service = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      notifications,
    )
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(service)
  })

  const addUser = (key: string, email: string, displayName: string) =>
    service.upsertUser({
      userId: testUuid(key),
      email,
      displayName,
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

  const rowsFor = (recipientUserId: string) =>
    dataSource.getRepository(NotificationEntity).find({
      where: { recipientUserId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    })

  // Defaults to the root manager (committed state); pass a transaction manager to
  // read what that transaction can see before it commits.
  const countAll = (manager: EntityManager = dataSource.manager) =>
    manager.getRepository(NotificationEntity).count()

  // Ask rows on a request whose question is still open. Zero on any request
  // that reached its outcome — the invariant the whole resolve-on-write design
  // rests on (and what makes superseding an approved request safe: an approved
  // request never carries an open ask to leak). Only the two ask types are
  // counted: an outcome row IS an answer, carries no question, and so is
  // expected to sit there unresolved forever.
  const openRowCount = (requestId: string) =>
    dataSource.getRepository(NotificationEntity).count({
      where: {
        requestId,
        resolvedAt: IsNull(),
        type: In([
          NotificationType.ApprovalNeeded,
          NotificationType.ApprovalProgressed,
        ]),
      },
    })

  // `day` varies because a requester may not hold two overlapping requests; it
  // is otherwise irrelevant to what these tests assert.
  const submit = (
    requesterUserId: string,
    approverEmails: string[],
    ccEmails: string[] = [],
    day = '2026-01-05',
  ) =>
    service.submitLeaveRequest({
      requesterUserId,
      leaveType: LeaveType.Vacation,
      startDate: day,
      endDate: day,
      approverEmails,
      ccEmails,
      submittedAt: '2026-01-02T09:00:00.000Z',
    })

  it('tells the to-approvers who are app users, and silently skips those who are not', async () => {
    // The most important case: approver rows are email-keyed and submit never
    // validates them against users, so an address with no user must produce no
    // notification WITHOUT failing the submission.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'ghost@example.com',
    ])

    expect(request.status).toBe(LeaveRequestStatus.Pending)
    const leadRows = await rowsFor(lead.userId)
    expect(leadRows).toHaveLength(1)
    expect(leadRows[0]).toMatchObject({
      type: NotificationType.ApprovalNeeded,
      requestId: request.requestId,
      // Stamped with the mutation's own instant, not a fresh clock read.
      occurredAt: '2026-01-02T09:00:00.000Z',
      readAt: null,
      // For an approval-needed row the actor is the requester (drives the avatar).
      actorLabel: 'Employee',
    })
    expect(leadRows[0]?.summary).toContain('Employee')
    // The unresolved approver produced nothing at all, and no row leaked.
    expect(await countAll()).toBe(1)
  })

  it('tells the approvers when part of the leave they are signing off is unpaid', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await service.setEmployeeAllocation({
      userId: employee.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 0,
    })

    await submit(employee.userId, ['lead@example.com'], [], '2026-01-05')

    const [row] = await rowsFor(lead.userId)
    expect(row?.summary).toContain('(1d of 1d unpaid)')
  })

  it('tells the approvers only the held days came back when a partly unpaid leave is cancelled', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await service.setEmployeeAllocation({
      userId: employee.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 0,
    })
    const request = await submit(employee.userId, ['lead@example.com'])
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T09:00:00.000Z',
    })

    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: employee.userId,
      actorDisplayName: 'Employee',
      occurredAt: '2026-01-04T09:00:00.000Z',
    })

    const cancelled = (await rowsFor(lead.userId)).find(
      (row) => row.type === NotificationType.RequestCancelled,
    )
    // Nothing was ever held, so the old "the days went back to their balance"
    // sentence would have been a plain untruth.
    expect(cancelled?.summary).toContain('no days were held from their balance')

    // The approver's ask stays closed by their own vote: cancelling an approved
    // leave is news (the row above), never a rewrite of how they decided.
    const ask = (await rowsFor(lead.userId)).find(
      (row) => row.type === NotificationType.ApprovalNeeded,
    )
    expect(ask?.resolutionText).toContain('approved')
    expect(ask?.resolvedByUserId).toBe(lead.userId)
  })

  it('never tells a cc recipient, who has no decision to make', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const hr = await addUser('hr-1', 'hr@example.com', 'HR')

    await submit(employee.userId, ['lead@example.com'], ['hr@example.com'])

    expect(await rowsFor(lead.userId)).toHaveLength(1)
    expect(await rowsFor(hr.userId)).toHaveLength(0)
  })

  it('tells the requester about a partial approval that left the request pending', async () => {
    // Pins the trap: a non-final approve leaves status Pending and decidedAt
    // null, so a status-driven notify would swallow this event entirely.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    const afterFirst = await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('lead-1'),
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })

    expect(afterFirst.status).toBe(LeaveRequestStatus.Pending)
    expect(afterFirst.decidedAt).toBeUndefined()
    const rows = await rowsFor(employee.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe(NotificationType.ApprovalProgressed)
    expect(rows[0]?.summary).toContain('1 of 2')

    // The last outstanding approval closes the gate.
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('dir-1'),
      actorDisplayName: 'Director',
      actorEmail: 'dir@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T11:00:00.000Z',
    })
    const afterSecond = await rowsFor(employee.userId)
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond[1]?.type).toBe(NotificationType.RequestApproved)
    // The final approval belongs to everyone who signed off, in vote order —
    // not to whoever happened to vote last.
    expect(afterSecond[1]?.summary).toBe(
      'Team Lead and Director approved your vacation request for 2026-01-05 to 2026-01-05',
    )
  })

  it('tells the requester about a rejection and about an override, reason included', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const admin = await addUser('admin-1', 'admin@example.com', 'Admin')

    const rejected = await submit(employee.userId, ['lead@example.com'])
    await service.decideLeaveRequest({
      requestId: rejected.requestId,
      actorUserId: testUuid('lead-1'),
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Reject,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })
    const afterReject = await rowsFor(employee.userId)
    expect(afterReject).toHaveLength(1)
    expect(afterReject[0]?.type).toBe(NotificationType.RequestRejected)
    // For a decision event the actor is the approver who decided, not the requester.
    expect(afterReject[0]?.actorLabel).toBe('Team Lead')

    const overridden = await submit(employee.userId, ['lead@example.com'])
    await service.forceDecideLeaveRequest({
      requestId: overridden.requestId,
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
      action: LeaveApprovalAction.Approve,
      comment: 'Approver left the company',
      decidedAt: '2026-01-04T10:00:00.000Z',
    })
    const afterForce = await rowsFor(employee.userId)
    expect(afterForce).toHaveLength(2)
    expect(afterForce[1]?.type).toBe(NotificationType.RequestApproved)
    // The approver rows stay pending after an override, so this sentence is the
    // only account the requester gets of why they were bypassed.
    expect(afterForce[1]?.summary).toContain('force-approved')
    expect(afterForce[1]?.summary).toContain('Approver left the company')
  })

  it('tells the requester only when removing an approver actually settles the request', async () => {
    // This path reaches Approved WITHOUT ever calling decideLeaveRequest, so a
    // notify driven only off decide/forceDecide would lose the news entirely.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await addUser('dir-1', 'dir@example.com', 'Director')
    const admin = await addUser('admin-1', 'admin@example.com', 'Admin')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])

    // Nobody has approved yet: removing one leaves the other outstanding, so the
    // request stays Pending and the requester hears nothing.
    const stillPending = await service.removeLeaveRequestApprover({
      requestId: request.requestId,
      email: 'dir@example.com',
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
    })
    expect(stillPending.status).toBe(LeaveRequestStatus.Pending)
    expect(await rowsFor(employee.userId)).toHaveLength(0)

    const second = await submit(
      employee.userId,
      ['lead@example.com', 'dir@example.com'],
      [],
      '2026-01-06',
    )
    await service.decideLeaveRequest({
      requestId: second.requestId,
      actorUserId: testUuid('lead-1'),
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })
    // Now removing the last blocker completes the gate.
    const promoted = await service.removeLeaveRequestApprover({
      requestId: second.requestId,
      email: 'dir@example.com',
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
    })
    expect(promoted.status).toBe(LeaveRequestStatus.Approved)
    const rows = await rowsFor(employee.userId)
    expect(rows.at(-1)?.type).toBe(NotificationType.RequestApproved)
    expect(rows.at(-1)?.summary).toContain('removed approver')
  })

  it('cancelling a pending request closes the ask and delivers the news as its own row', async () => {
    // Two rows, two jobs: the ask resolves (chip + counters; its frozen text
    // keeps rendering under the request's own date) and the retraction itself
    // arrives as a fresh unread request_cancelled row — the attention signal
    // (badge, chime, Updates tab) rides the news, never the rewrite.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')

    const request = await submit(employee.userId, ['lead@example.com'])
    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: employee.userId,
      actorDisplayName: 'Employee',
      occurredAt: '2026-01-03T09:00:00.000Z',
    })

    const leadRows = await rowsFor(lead.userId)
    expect(leadRows).toHaveLength(2)
    const [ask, news] = leadRows
    expect(ask).toMatchObject({
      type: NotificationType.ApprovalNeeded,
      resolvedAt: '2026-01-03T09:00:00.000Z',
      resolvedByUserId: employee.userId,
      resolvedByLabel: 'Employee',
    })
    expect(ask?.resolutionText).toBe(
      'cancelled the vacation request for 2026-01-05 to 2026-01-05 — no decision is needed',
    )
    // The frozen ask sentence survives; only the resolution half was written.
    expect(ask?.summary).toContain('needs your approval')
    // The news row carries the cancel's own instant and starts unread.
    expect(news).toMatchObject({
      type: NotificationType.RequestCancelled,
      occurredAt: '2026-01-03T09:00:00.000Z',
      readAt: null,
      actorLabel: 'Employee',
    })
    // The news states the fact alone; "no decision is needed" lives on the ASK
    // resolution, because a voter receives this same row.
    expect(news?.summary).toBe(
      'Employee cancelled the vacation request for 2026-01-05 to 2026-01-05',
    )
    // The person who cancelled is not told about their own action.
    expect(await rowsFor(employee.userId)).toHaveLength(0)
  })

  it('a voter still hears about a pending cancel, and their own resolution stays theirs', async () => {
    // The voter's ask closed at vote time, so the resolve sweep cannot reach
    // them — the news row is the ONLY channel telling them the request is
    // gone, and their recorded vote must not be rewritten by the cancel.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })
    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: employee.userId,
      actorDisplayName: 'Employee',
      occurredAt: '2026-01-03T11:00:00.000Z',
    })

    const leadRows = await rowsFor(lead.userId)
    expect(leadRows.map((row) => row.type)).toEqual([
      NotificationType.ApprovalNeeded,
      NotificationType.RequestCancelled,
    ])
    // The vote's own resolution is untouched by the cancel.
    expect(leadRows[0]).toMatchObject({
      resolvedAt: '2026-01-03T10:00:00.000Z',
      resolvedByUserId: lead.userId,
      resolutionText:
        "approved Employee's vacation request for 2026-01-05 to 2026-01-05",
    })
    expect(leadRows[1]?.readAt).toBeNull()
    expect(leadRows[1]?.summary).toContain('cancelled the vacation request')

    // The still-open ask resolves as cancelled AND its holder gets the news.
    const directorRows = await rowsFor(director.userId)
    expect(directorRows.map((row) => row.type)).toEqual([
      NotificationType.ApprovalNeeded,
      NotificationType.RequestCancelled,
    ])
    expect(directorRows[0]?.resolutionText).toContain('cancelled')
    expect(await openRowCount(request.requestId)).toBe(0)
  })

  it("a vote closes only the voter's own ask; the final vote leaves nothing open", async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })

    // The voter's question is spent; the other approver is still genuinely
    // asked, and the requester's progress row is live history, not stale.
    const [leadAsk] = await rowsFor(lead.userId)
    expect(leadAsk).toMatchObject({
      resolvedAt: '2026-01-03T10:00:00.000Z',
      resolvedByUserId: lead.userId,
      resolvedByLabel: 'Team Lead',
      resolutionText:
        "approved Employee's vacation request for 2026-01-05 to 2026-01-05",
    })
    expect((await rowsFor(director.userId))[0]?.resolvedAt).toBeNull()
    const progressed = (await rowsFor(employee.userId)).find(
      (row) => row.type === NotificationType.ApprovalProgressed,
    )
    expect(progressed?.resolvedAt).toBeNull()

    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: director.userId,
      actorDisplayName: 'Director',
      actorEmail: 'dir@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T11:00:00.000Z',
    })

    // Each approver's row names their OWN vote; the progress trail closed with
    // the final decision. An approved request holds no open row — which is also
    // what makes superseding an approved original safe later.
    expect((await rowsFor(director.userId))[0]?.resolvedByUserId).toBe(
      director.userId,
    )
    const progressedAfter = (await rowsFor(employee.userId)).find(
      (row) => row.type === NotificationType.ApprovalProgressed,
    )
    expect(progressedAfter?.resolvedByUserId).toBe(director.userId)
    expect(progressedAfter?.resolutionText).toBe(
      "approved Employee's vacation request for 2026-01-05 to 2026-01-05",
    )
    expect(await openRowCount(request.requestId)).toBe(0)
  })

  it("a rejection tells the other approvers their decision is no longer needed", async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Reject,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })

    // The voter's own row records their vote plainly; the bystander's names the
    // rejecter AND says why their ask went away.
    expect((await rowsFor(lead.userId))[0]?.resolutionText).toBe(
      "rejected Employee's vacation request for 2026-01-05 to 2026-01-05",
    )
    const [directorAsk] = await rowsFor(director.userId)
    expect(directorAsk).toMatchObject({
      resolvedByUserId: lead.userId,
      resolvedByLabel: 'Team Lead',
      resolutionText:
        "rejected Employee's vacation request for 2026-01-05 to 2026-01-05 — your decision is no longer needed",
    })
    expect(await openRowCount(request.requestId)).toBe(0)
  })

  it('an override closes every open row in one sweep, in plain wording', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')
    const admin = await addUser('admin-1', 'admin@example.com', 'Admin')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    // One approver has voted; their row must keep naming THEIR vote after the
    // override — history is not rewritten by whoever finishes the request.
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })
    await service.forceDecideLeaveRequest({
      requestId: request.requestId,
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
      action: LeaveApprovalAction.Reject,
      comment: 'Dates clash with the release',
      decidedAt: '2026-01-03T11:00:00.000Z',
    })

    expect((await rowsFor(lead.userId))[0]).toMatchObject({
      resolvedByUserId: lead.userId,
      resolutionText:
        "approved Employee's vacation request for 2026-01-05 to 2026-01-05",
    })
    expect((await rowsFor(director.userId))[0]).toMatchObject({
      resolvedByUserId: admin.userId,
      resolvedByLabel: 'Admin',
      // Plain verb — the recipient needs the outcome and who settled it, not
      // the mechanism ("force").
      resolutionText:
        "rejected Employee's vacation request for 2026-01-05 to 2026-01-05",
    })
    const progressed = (await rowsFor(employee.userId)).find(
      (row) => row.type === NotificationType.ApprovalProgressed,
    )
    expect(progressed?.resolvedByUserId).toBe(admin.userId)
    expect(await openRowCount(request.requestId)).toBe(0)
  })

  it("removing an approver voids that approver's ask and nobody else's", async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')
    const admin = await addUser('admin-1', 'admin@example.com', 'Admin')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.removeLeaveRequestApprover({
      requestId: request.requestId,
      email: 'dir@example.com',
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
    })

    expect((await rowsFor(director.userId))[0]).toMatchObject({
      resolvedByUserId: admin.userId,
      resolvedByLabel: 'Admin',
      resolutionText:
        "removed you as an approver of Employee's vacation request for 2026-01-05 to 2026-01-05",
    })
    // The remaining approver is still genuinely asked.
    expect((await rowsFor(lead.userId))[0]?.resolvedAt).toBeNull()
  })

  it('resolution never touches readAt in either direction', async () => {
    // "Read" means exactly "the recipient opened this row". Closing a question
    // neither reads it for them nor un-reads what they have already seen.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const director = await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    const leadNotificationId = (await rowsFor(lead.userId))[0]?.id as string
    await notifications.markRead(lead.userId, leadNotificationId)
    const readAtBefore = (await rowsFor(lead.userId))[0]?.readAt
    expect(readAtBefore).not.toBeNull()

    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: employee.userId,
      actorDisplayName: 'Employee',
      occurredAt: '2026-01-03T09:00:00.000Z',
    })

    // The read row stayed read, the unread row stayed unread; both resolved.
    const [leadRow] = await rowsFor(lead.userId)
    expect(leadRow?.readAt).toBe(readAtBefore)
    expect(leadRow?.resolvedAt).not.toBeNull()
    const [directorRow] = await rowsFor(director.userId)
    expect(directorRow?.readAt).toBeNull()
    expect(directorRow?.resolvedAt).not.toBeNull()
  })

  it('never notifies the actor about their own action', async () => {
    // removeLeaveRequestApprover has no self guard of its own, unlike decide and
    // forceDecide, so an admin acting on their OWN request would be told about
    // it if the filter were at the call sites instead of in recordMany.
    const admin = await addUser('admin-1', 'admin@example.com', 'Admin')
    await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await addUser('dir-1', 'dir@example.com', 'Director')

    const own = await submit(admin.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.decideLeaveRequest({
      requestId: own.requestId,
      actorUserId: testUuid('lead-1'),
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })
    const before = (await rowsFor(admin.userId)).length

    await service.removeLeaveRequestApprover({
      requestId: own.requestId,
      email: 'dir@example.com',
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
    })

    // The removal promoted their own request, but they did it themselves.
    expect(await rowsFor(admin.userId)).toHaveLength(before)
  })

  it('writes no notification when the transaction it belongs to rolls back', async () => {
    // THE reason record() takes the caller's manager: a notification must not be
    // able to exist without its cause.
    //
    // Asserted by rolling back the caller's OWN transaction rather than by
    // failing a submit: every throw inside submitLeaveRequest happens BEFORE it
    // records anything (recordMany is its last mutating statement), so a failed
    // submit would never reach the write and the test would pass without
    // exercising the guarantee at all.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const request = await submit(employee.userId, ['lead@example.com'])
    const before = await countAll()

    await expect(
      dataSource.transaction(async (manager) => {
        await notifications.record(manager, {
          recipientUserId: lead.userId,
          actorUserId: employee.userId,
          actorLabel: 'Employee',
          type: NotificationType.ApprovalNeeded,
          requestId: request.requestId,
          occurredAt: '2026-01-02T09:00:00.000Z',
          summary: 'should not survive',
        })
        // Proves the row was really written on this manager before the rollback.
        expect(await countAll(manager)).toBe(before + 1)
        throw new Error('the mutation failed after notifying')
      }),
    ).rejects.toThrowError('the mutation failed after notifying')

    expect(await countAll()).toBe(before)
  })

  it('backfills a first-time approver so their centre is not empty on arrival', async () => {
    // An approver with no user row gets nothing at submit time. Without the
    // backfill, signing in for the first time would show an empty centre for a
    // request that is genuinely waiting on them.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const pending = await submit(employee.userId, ['newcomer@example.com'])
    expect(await countAll()).toBe(0)

    const newcomer = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-newcomer',
      email: 'newcomer@example.com',
      displayName: 'Newcomer',
      countryCode: 'UA',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-03T08:00:00.000Z',
    })

    const rows = await rowsFor(newcomer.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: NotificationType.ApprovalNeeded,
      requestId: pending.requestId,
      // The ask happened at submit time, not at sign-in: the feed must say so.
      occurredAt: '2026-01-02T09:00:00.000Z',
      // Backfilled with the requester's name, so the avatar is right on arrival.
      actorLabel: 'Employee',
    })

    // Signing in again must not duplicate it.
    await service.findOrCreateUserFromIdentity({
      subject: 'oidc-newcomer',
      email: 'newcomer@example.com',
      displayName: 'Newcomer',
      countryCode: 'UA',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-04T08:00:00.000Z',
    })
    expect(await rowsFor(newcomer.userId)).toHaveLength(1)
  })

  it('stops serving a progress row once it resolves, in the list and in the count', async () => {
    // The outcome's own row carries the news; serving the closed progress
    // trail beside it would tell the requester the same thing twice. Excluded
    // from unreadCount too, or the badge would demand a read the panel has
    // nothing to show for. The row itself stays in the table.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await addUser('dir-1', 'dir@example.com', 'Director')

    const request = await submit(employee.userId, [
      'lead@example.com',
      'dir@example.com',
    ])
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: lead.userId,
      actorDisplayName: 'Team Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T10:00:00.000Z',
    })

    // Mid-flight the open progress row is genuinely feed material.
    const midway = await notifications.getNotifications(employee.userId)
    expect(midway.items).toHaveLength(1)
    expect(midway.items[0]?.type).toBe(NotificationType.ApprovalProgressed)
    expect(midway.unreadCount).toBe(1)

    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('dir-1'),
      actorDisplayName: 'Director',
      actorEmail: 'dir@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-03T11:00:00.000Z',
    })

    // The final vote resolved the progress row: only the outcome row is served,
    // and the never-read progress row no longer counts as unread.
    const settled = await notifications.getNotifications(employee.userId)
    expect(settled.items.map((item) => item.type)).toEqual([
      NotificationType.RequestApproved,
    ])
    expect(settled.unreadCount).toBe(1)
    // Still in the journal — hidden from the feed, not deleted.
    expect(await rowsFor(employee.userId)).toHaveLength(2)

    // A resolved approval_NEEDED row keeps flowing: how the ask was settled IS
    // the approver's news.
    const leadFeed = await notifications.getNotifications(lead.userId)
    expect(leadFeed.items).toHaveLength(1)
    // Exact instant, not a null-check: the DTO omits the field when absent and
    // undefined would slip past a not-toBeNull assert.
    expect(leadFeed.items[0]?.resolvedAt).toBe('2026-01-03T10:00:00.000Z')
    // Their vote spent their ask, so no decision waits on them anymore.
    expect(leadFeed.openAskCount).toBe(0)
  })

  it('serves a newest-first window with a table-wide unread count, and marks read per recipient', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await submit(employee.userId, ['lead@example.com'], [], '2026-01-05')
    await submit(employee.userId, ['lead@example.com'], [], '2026-01-06')

    const initial = await notifications.getNotifications(lead.userId)
    expect(initial.items).toHaveLength(2)
    expect(initial.unreadCount).toBe(2)
    expect(initial.openAskCount).toBe(2)

    const first = initial.items[0]?.notificationId as string
    const afterRead = await notifications.getNotifications(lead.userId)
    await notifications.markRead(lead.userId, first)
    expect((await notifications.getNotifications(lead.userId)).unreadCount).toBe(1)
    expect(afterRead.unreadCount).toBe(2)

    // Someone else's id matches nothing: the id never confers access.
    await notifications.markRead(employee.userId, initial.items[1]?.notificationId as string)
    expect((await notifications.getNotifications(lead.userId)).unreadCount).toBe(1)

    await notifications.markAllRead(lead.userId)
    const caughtUp = await notifications.getNotifications(lead.userId)
    expect(caughtUp.unreadCount).toBe(0)
    // Reading is not deciding: both requests still wait on the lead, so the
    // bell's work indicator stays lit after every row is read.
    expect(caughtUp.openAskCount).toBe(2)
  })

  it('pages the feed newest-first with a keyset cursor and table-wide counts', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    // One real request satisfies the FK; the 51 rows are the journal under test.
    const request = await submit(employee.userId, ['lead@example.com'], [], '2026-01-05')
    const repo = dataSource.getRepository(NotificationEntity)
    await repo.delete({ recipientUserId: lead.userId })

    await repo.save(
      Array.from({ length: 51 }, (_, index) =>
        repo.create({
          id: testUuid(`n-${index}`),
          occurredAt: new Date(Date.UTC(2026, 0, 2, 9, 0, index)).toISOString(),
          recipientUserId: lead.userId,
          type: NotificationType.ApprovalNeeded,
          actorLabel: 'Employee',
          requestId: request.requestId,
          summary: `Ask ${index}`,
          readAt: null,
          resolvedAt: null,
          resolvedByUserId: null,
          resolvedByLabel: null,
          resolutionText: null,
        }),
      ),
    )

    const first = await notifications.getNotifications(lead.userId)
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toBeTypeOf('string')
    expect(first.unreadCount).toBe(51)
    expect(first.openAskCount).toBe(51)
    // Newest first: the last-inserted second wins.
    expect(first.items[0]?.summary).toBe('Ask 50')
    expect(first.items[49]?.summary).toBe('Ask 1')

    const second = await notifications.getNotifications(lead.userId, {
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.summary).toBe('Ask 0')
    expect(second.nextCursor).toBeUndefined()
    // Counts stay table-wide on every page.
    expect(second.unreadCount).toBe(51)
    expect(second.openAskCount).toBe(51)
  })

  it('splits a page across rows sharing one instant without skipping or duplicating', async () => {
    // Ties are the NORM, not an edge: recordMany stamps sibling rows with the
    // same mutation instant, so a page boundary will routinely fall between
    // rows whose occurredAt is identical and only the id breaks the tie.
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    const request = await submit(employee.userId, ['lead@example.com'], [], '2026-01-05')
    const repo = dataSource.getRepository(NotificationEntity)
    await repo.delete({ recipientUserId: lead.userId })

    await repo.save(
      Array.from({ length: 52 }, (_, index) =>
        repo.create({
          id: testUuid(`tie-${index}`),
          // ONE instant for all 52 rows: ordering inside the page and the
          // cursor's continuation both ride the id alone.
          occurredAt: '2026-01-02T09:00:00.000Z',
          recipientUserId: lead.userId,
          type: NotificationType.ApprovalNeeded,
          actorLabel: 'Employee',
          requestId: request.requestId,
          summary: `Tie ${index}`,
          readAt: null,
          resolvedAt: null,
          resolvedByUserId: null,
          resolvedByLabel: null,
          resolutionText: null,
        }),
      ),
    )

    const first = await notifications.getNotifications(lead.userId)
    const second = await notifications.getNotifications(lead.userId, {
      cursor: first.nextCursor,
    })
    expect(first.items).toHaveLength(50)
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBeUndefined()
    const ids = [...first.items, ...second.items].map(
      (item) => item.notificationId,
    )
    // Every row exactly once across the boundary.
    expect(new Set(ids).size).toBe(52)
  })

  it('serves the first page again for a cursor it cannot decode', async () => {
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')
    const lead = await addUser('lead-1', 'lead@example.com', 'Team Lead')
    await submit(employee.userId, ['lead@example.com'], [], '2026-01-05')

    const garbled = await notifications.getNotifications(lead.userId, {
      cursor: 'not-a-cursor',
    })
    const first = await notifications.getNotifications(lead.userId)
    // Malformed input degrades to page one, never to an error or an empty
    // feed — the client treats "no new rows" as feed-exhausted on its own.
    expect(garbled.items.map((item) => item.notificationId)).toEqual(
      first.items.map((item) => item.notificationId),
    )
  })

  it('an automatically approved request writes no notifications, and its cancel tells nobody', async () => {
    // With approval optional the request has NO approvers: no asks exist, the
    // requester is the actor of their own approval (self-filtered), and the
    // approved-cancel news loop runs over an empty approver list.
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      approvalRequired: false,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const employee = await addUser('emp-1', 'emp@example.com', 'Employee')

    const request = await submit(employee.userId, [])
    expect(request.status).toBe(LeaveRequestStatus.Approved)
    expect(await countAll()).toBe(0)

    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: employee.userId,
      actorDisplayName: 'Employee',
      occurredAt: '2026-01-03T09:00:00.000Z',
    })
    expect(await countAll()).toBe(0)
    expect(await openRowCount(request.requestId)).toBe(0)
  })
})
