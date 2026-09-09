/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  ApproverKind,
  AuditEventType,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { LeaveDomainService } from './leave-domain.service'
import { NotificationService } from './notification.service'
import { AuditLogEntity } from './entities/audit-log.entity'
import { LeaveApprovalDecisionEntity } from './entities/leave-approval-decision.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeaveRequestEntity } from './entities/leave-request.entity'
import { NotificationEntity } from './entities/notification.entity'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// The org-wide approval mode. Required is the classic behavior. Optional stops
// folding the DECIDING defaults onto submissions and approves a request nobody
// was addressed to, in the transaction that created it — while the CC defaults
// keep being folded in either way, because a copied recipient never decides.

let dataSource: DataSource
let service: LeaveDomainService
let clock: ClockService

const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-07-01T12:00:00.000Z'

const settings = async (input: {
  approvalRequired?: boolean
  defaultApproverEmails?: string[]
  defaultCcApproverEmails?: string[]
}) => {
  await service.updateLeaveSettings({
    defaultVacationDays: 25,
    defaultSickDays: 5,
    ...(input.approvalRequired !== undefined
      ? { approvalRequired: input.approvalRequired }
      : {}),
    defaultApproverEmails: input.defaultApproverEmails ?? [],
    defaultCcApproverEmails: input.defaultCcApproverEmails ?? [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: T0,
  })
}

const seedEmployee = async (slug: string): Promise<string> => {
  const user = await service.upsertUser({
    userId: testUuid(`user-${slug}`),
    email: `${slug}@example.com`,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate: '2024-01-01',
    createdAt: '2025-12-20T00:00:00.000Z',
  })
  return user.userId
}

const submit = (
  userId: string,
  approverEmails: string[] = [],
  ccEmails: string[] = [],
  startDate = '2026-08-03',
  endDate = '2026-08-05',
) =>
  service.submitLeaveRequest({
    requesterUserId: userId,
    leaveType: LeaveType.Vacation,
    startDate,
    endDate,
    approverEmails,
    ccEmails,
    submittedAt: NOW,
  })

beforeAll(async () => {
  dataSource = await initTestDataSource()
})

afterAll(async () => {
  await dataSource?.destroy()
})

beforeEach(async () => {
  await truncateAll(dataSource)
  process.env['TEST_TOOLING_ENABLED'] = 'true'
  clock = new ClockService()
  delete process.env['TEST_TOOLING_ENABLED']
  clock.setNow(NOW)
  service = new LeaveDomainService(
    dataSource,
    new AuditLogService(dataSource, clock),
    clock,
    new NotificationService(dataSource, clock),
  )
  await settings({})
  await seedHolidayCalendar(service, { year: 2026 })
  for (const slug of ['approver', 'hr']) {
    await service.upsertUser({
      userId: testUuid(`user-${slug}`),
      email: `${slug}@example.com`,
      displayName: slug,
      countryCode: 'UA',
      employmentStartDate: '2020-01-01',
      createdAt: T0,
    })
  }
})

describe('approval required (the default)', () => {
  it('refuses a submission nobody would decide and folds the deciding defaults in', async () => {
    const employee = await seedEmployee('classic')

    await expect(submit(employee)).rejects.toThrowError(
      'Leave request must have at least one approver other than the requester.',
    )

    await settings({ defaultApproverEmails: ['approver@example.com'] })
    const detail = await submit(employee)
    expect(detail.status).toBe(LeaveRequestStatus.Pending)
    expect(detail.approvers.map((approver) => approver.email)).toEqual([
      'approver@example.com',
    ])
  })
})

describe('approval optional', () => {
  it('approves an unaddressed submission on the spot and leaves the holds alone', async () => {
    await settings({
      approvalRequired: false,
      defaultApproverEmails: ['approver@example.com'],
    })
    const employee = await seedEmployee('solo')

    const detail = await submit(employee)

    // The deciding default is NOT folded in: it is what makes the automatic
    // approval reachable at all.
    expect(detail.approvers).toHaveLength(0)
    expect(detail.status).toBe(LeaveRequestStatus.Approved)
    expect(detail.decisionComment).toBe('Processed automatically')
    expect(detail.decidedAt).toBe(NOW)
    expect(detail.activity.map((entry) => entry.action)).toEqual([
      'submitted',
      'auto-approved',
    ])
    expect(detail.activity[1]?.actorDisplayName).toBe('System')

    const row = await dataSource
      .getRepository(LeaveRequestEntity)
      .findOneByOrFail({ id: detail.requestId })
    // The admin feed reads this snapshot, and addActivity skips it for system
    // events, so the decision has to stamp it explicitly.
    expect(row.lastAction).toBe('auto-approved')
    expect(row.lastActivityAt).toBe(NOW)

    // No human decided, so no per-approver decision is fabricated.
    expect(
      await dataSource
        .getRepository(LeaveApprovalDecisionEntity)
        .countBy({ requestId: detail.requestId }),
    ).toBe(0)
    // The requester is the actor; a notification to themselves is suppressed.
    expect(await dataSource.getRepository(NotificationEntity).count()).toBe(0)

    const audit = await dataSource
      .getRepository(AuditLogEntity)
      .findBy({ eventType: AuditEventType.LeaveRequestAutoApproved })
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actorUserId).toBeNull()

    // Approval never moved the books before and does not now: the paid days
    // stay held until they elapse.
    expect(row.remainingHeldDays).toBe(3)
    const balance = await dataSource
      .getRepository(LeaveBalanceEntity)
      .findOneByOrFail({
        userId: employee,
        leaveType: LeaveType.Vacation,
        year: 2026,
      })
    expect(balance.onHoldDays).toBe(3)
  })

  it('still waits for an approver the employee names voluntarily', async () => {
    // The stored deciding default is configured on purpose: naming somebody
    // must not drag it back into the merge, or the request would route to a
    // person the composer never previewed.
    await settings({
      approvalRequired: false,
      defaultApproverEmails: ['approver@example.com'],
    })
    const employee = await seedEmployee('voluntary')

    const detail = await submit(employee, ['hr@example.com'])

    expect(detail.status).toBe(LeaveRequestStatus.Pending)
    expect(detail.approvers.map((approver) => approver.email)).toEqual([
      'hr@example.com',
    ])
    expect(
      await dataSource
        .getRepository(AuditLogEntity)
        .countBy({ eventType: AuditEventType.LeaveRequestAutoApproved }),
    ).toBe(0)
    // And the named approver is notified exactly as they always were.
    expect(await dataSource.getRepository(NotificationEntity).count()).toBe(1)
  })

  it('copies the CC defaults onto an automatically approved request', async () => {
    await settings({
      approvalRequired: false,
      defaultApproverEmails: ['approver@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
    })
    const employee = await seedEmployee('copied')

    const detail = await submit(employee)

    expect(detail.status).toBe(LeaveRequestStatus.Approved)
    // Copied, not asked: one cc row, no deciding row.
    expect(
      detail.approvers.map((approver) => [approver.email, approver.kind]),
    ).toEqual([['hr@example.com', ApproverKind.Cc]])
    // A cc recipient never votes, so their presence cannot hold the request.
    expect(detail.decisionComment).toBe('Processed automatically')
  })

  it('keeps an address configured in both default lists as a copied recipient', async () => {
    // The mode branch lives in the ARGUMENTS to the merge. Moved to a filter
    // after it, this address would vanish from the CC preview while submit
    // still wrote it as a locked cc row.
    await settings({
      approvalRequired: false,
      defaultApproverEmails: ['hr@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
    })
    const employee = await seedEmployee('both-lists')

    const context = await service.getLeaveRequestFormContext(employee)
    expect(context.defaultApprovers).toEqual([])
    expect(context.defaultCc.map((recipient) => recipient.email)).toEqual([
      'hr@example.com',
    ])

    const detail = await submit(employee)
    expect(
      detail.approvers.map((approver) => [approver.email, approver.kind]),
    ).toEqual([['hr@example.com', ApproverKind.Cc]])
    expect(detail.status).toBe(LeaveRequestStatus.Approved)
  })

  it('lets the employee promote a CC default to the deciding approver', async () => {
    await settings({
      approvalRequired: false,
      defaultCcApproverEmails: ['hr@example.com'],
    })
    const employee = await seedEmployee('promoter')

    const detail = await submit(employee, ['hr@example.com'])

    // 'to' wins over 'cc' for one address, so the request waits for them
    // instead of approving itself.
    expect(detail.status).toBe(LeaveRequestStatus.Pending)
    expect(
      detail.approvers.map((approver) => [approver.email, approver.kind]),
    ).toEqual([['hr@example.com', ApproverKind.To]])
  })

  it('swaps the original in one call when an approver-less change is submitted', async () => {
    await settings({ approvalRequired: false })
    const employee = await seedEmployee('mover')

    const original = await submit(employee)
    expect(original.status).toBe(LeaveRequestStatus.Approved)

    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: employee,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      approverEmails: [],
      ccEmails: [],
      submittedAt: '2026-07-02T12:00:00.000Z',
    })

    expect(replacement.status).toBe(LeaveRequestStatus.Approved)
    const originalRow = await dataSource
      .getRepository(LeaveRequestEntity)
      .findOneByOrFail({ id: original.requestId })
    expect(originalRow.status).toBe(LeaveRequestStatus.Superseded)
    expect(originalRow.remainingHeldDays).toBe(0)
    const balance = await dataSource
      .getRepository(LeaveBalanceEntity)
      .findOneByOrFail({
        userId: employee,
        leaveType: LeaveType.Vacation,
        year: 2026,
      })
    expect(balance.onHoldDays).toBe(3)

    // No 'modification-requested' trace: the supersede happened in the same
    // instant, and that entry (written last) is what the admin feed reads.
    const originalDetail = await service.getLeaveRequestDetail(
      original.requestId,
    )
    expect(originalDetail.activity.map((entry) => entry.action)).toEqual([
      'submitted',
      'auto-approved',
      'superseded',
    ])
    expect(originalRow.lastAction).toBe('superseded')
  })

  it('releases the hold when an automatically approved leave is cancelled', async () => {
    await settings({ approvalRequired: false })
    const employee = await seedEmployee('canceller')

    const detail = await submit(employee)
    const cancelled = await service.cancelLeaveRequest({
      requestId: detail.requestId,
      actorUserId: employee,
      actorDisplayName: 'canceller',
      occurredAt: '2026-07-03T12:00:00.000Z',
    })

    expect(cancelled.status).toBe(LeaveRequestStatus.Cancelled)
    const balance = await dataSource
      .getRepository(LeaveBalanceEntity)
      .findOneByOrFail({
        userId: employee,
        leaveType: LeaveType.Vacation,
        year: 2026,
      })
    expect(balance.onHoldDays).toBe(0)
  })
})

describe('the composer context', () => {
  it('reports the mode and previews only the defaults that will be applied', async () => {
    await settings({
      approvalRequired: false,
      defaultApproverEmails: ['approver@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
    })
    const employee = await seedEmployee('context')

    const optional = await service.getLeaveRequestFormContext(employee)
    expect(optional.approvalRequired).toBe(false)
    // The deciding default is not previewed because it is not applied; the CC
    // default is previewed because it is.
    expect(optional.defaultApprovers).toEqual([])
    expect(optional.defaultCc.map((recipient) => recipient.email)).toEqual([
      'hr@example.com',
    ])

    await settings({
      approvalRequired: true,
      defaultApproverEmails: ['approver@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
    })
    const required = await service.getLeaveRequestFormContext(employee)
    expect(required.approvalRequired).toBe(true)
    expect(required.defaultApprovers.map((recipient) => recipient.email)).toEqual(
      ['approver@example.com'],
    )
  })
})

describe('the settings write', () => {
  it('keeps the stored mode when a neighbouring card saves without it', async () => {
    await settings({
      approvalRequired: false,
      defaultCcApproverEmails: ['hr@example.com'],
    })

    // A card that does not own the mode omits it; absence must not be read as
    // a command to switch approvals back on.
    await service.updateLeaveSettings({
      defaultVacationDays: 25,
      defaultSickDays: 5,
      defaultApproverEmails: [],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: T0,
    })

    const saved = await service.getLeaveSettings()
    expect(saved.approvalRequired).toBe(false)
  })

  it('audits the switch, because it changes what happens to every request', async () => {
    await settings({ approvalRequired: false })

    const audit = await dataSource
      .getRepository(AuditLogEntity)
      .findBy({ eventType: AuditEventType.SettingsUpdated })
    const entry = audit.at(-1)
    expect(entry?.beforeState).toMatchObject({ approvalRequired: true })
    expect(entry?.afterState).toMatchObject({ approvalRequired: false })
  })
})
