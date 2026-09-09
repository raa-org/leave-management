/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import {
  LeaveDomainService,
  LeaveDomainValidationError,
} from './leave-domain.service'
import { NotificationService } from './notification.service'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeaveBalanceChangeEntity } from './entities/leave-balance-change.entity'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from './entities/leave-policy-membership.entity'
import { NotificationEntity } from './entities/notification.entity'
import { LeaveRequestEntity } from './entities/leave-request.entity'
import { policyTermsFingerprint } from './policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// The history-import primitives. Together they must reproduce, from a plain
// enrollment plus one opening figure, exactly what live usage would have
// produced — and leave the ordinary engine (accrual, holds, year close) the
// only thing computing balances.

let dataSource: DataSource
let service: LeaveDomainService
let clock: ClockService

const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-08-06T09:00:00.000Z'

const IMPORT_ACTOR = {
  userId: null,
  label: 'Import admin',
  email: 'admin@example.com',
  roles: [],
}

const seedPolicy = async (
  slug: string,
  vacationDays: number,
  sickDays: number,
  overrides: Partial<LeavePolicyEntity> = {},
): Promise<string> => {
  const id = testUuid(`policy-${slug}`)
  await dataSource.getRepository(LeavePolicyEntity).save({
    id,
    name: slug,
    description: null,
    vacationDays,
    sickDays,
    vacationAnnualIncrement: 0,
    vacationIncrementEveryYears: 1,
    vacationIncrementCapDays: null,
    probationMonths: 0,
    paidSickDuringProbation: false,
    effectiveFrom: '2015-01-01',
    effectiveTo: null,
    isDefault: false,
    termsFingerprint: policyTermsFingerprint({
      vacationDays,
      sickDays,
      vacationAnnualIncrement: overrides.vacationAnnualIncrement ?? 0,
      vacationIncrementEveryYears: overrides.vacationIncrementEveryYears ?? 1,
      vacationIncrementCapDays: overrides.vacationIncrementCapDays ?? null,
      probationMonths: overrides.probationMonths ?? 0,
      paidSickDuringProbation: overrides.paidSickDuringProbation ?? false,
    }),
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  })
  return id
}

const seedEmployee = async (
  slug: string,
  employmentStartDate: string,
): Promise<string> => {
  const user = await service.upsertUser({
    userId: testUuid(`user-${slug}`),
    email: `${slug}@example.com`,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate,
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  return user.userId
}

const membershipsOf = (userId: string) =>
  dataSource.getRepository(LeavePolicyMembershipEntity).find({
    where: { userId },
    order: { effectiveFrom: 'ASC', createdAt: 'ASC' },
  })

const allocationOf = (userId: string, leaveType: LeaveType, year: number) =>
  dataSource
    .getRepository(LeaveAllocationEntity)
    .findOneBy({ userId, leaveType, year })

const balanceOf = (userId: string, leaveType: LeaveType, year: number) =>
  dataSource
    .getRepository(LeaveBalanceEntity)
    .findOneBy({ userId, leaveType, year })

const ledgerOf = (userId: string) =>
  dataSource.getRepository(LeaveBalanceChangeEntity).find({
    where: { userId },
    order: { createdAt: 'ASC' },
  })

// Replay one approved leave the way the import service will: submit with the
// historical instant, then force-approve it, both with notifications off.
const replayApprovedLeave = async (
  userId: string,
  leaveType: LeaveType,
  startDate: string,
  endDate: string,
  submittedAt: string,
): Promise<string> => {
  return dataSource.transaction(async (manager) => {
    const detail = await service.submitLeaveRequestTx(
      manager,
      {
        requesterUserId: userId,
        leaveType,
        startDate,
        endDate,
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt,
        audit: IMPORT_ACTOR,
      },
      { suppressNotifications: true },
    )
    await service.forceDecideLeaveRequestTx(manager, {
      requestId: detail.requestId,
      actorUserId: testUuid('user-approver'),
      actorDisplayName: 'Import admin',
      action: LeaveApprovalAction.Approve,
      comment: 'History import',
      decidedAt: submittedAt,
      audit: IMPORT_ACTOR,
      suppressNotifications: true,
    })
    return detail.requestId
  })
}

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
  await service.updateLeaveSettings({
    defaultVacationDays: 25,
    defaultSickDays: 5,
    defaultApproverEmails: [],
    defaultCcApproverEmails: [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: T0,
  })
  // The approver the replay force-decides as: force-decide refuses a
  // self-decision, so it must be somebody other than the requester.
  await service.upsertUser({
    userId: testUuid('user-approver'),
    email: 'manager@example.com',
    displayName: 'Manager',
    countryCode: 'UA',
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  // Empty calendars: the source trackers count plain weekdays, and submit
  // refuses a year with no calendar row at all.
  await seedHolidayCalendar(service, { countryCode: 'UA', year: 2026 })
  await seedHolidayCalendar(service, { countryCode: 'UA', year: 2027 })
})

describe('notification suppression', () => {
  it('writes no notification rows for a replayed submit and force-approval', async () => {
    const userId = await seedEmployee('quiet', '2020-03-02')
    const policyId = await seedPolicy('quiet-25-5', 25, 5)
    await dataSource.transaction((manager) =>
      service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2020-03-02',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      }),
    )

    await replayApprovedLeave(
      userId,
      LeaveType.Vacation,
      '2026-03-02',
      '2026-03-06',
      '2026-02-20T09:00:00.000Z',
    )

    const notifications = await dataSource
      .getRepository(NotificationEntity)
      .count()
    expect(notifications).toBe(0)
  })

  it('still notifies on the ordinary path', async () => {
    const userId = await seedEmployee('loud', '2020-03-02')
    const policyId = await seedPolicy('loud-25-5', 25, 5)
    await dataSource.transaction((manager) =>
      service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2020-03-02',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      }),
    )

    await service.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-09-07',
      endDate: '2026-09-11',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
    })

    const notifications = await dataSource
      .getRepository(NotificationEntity)
      .count()
    expect(notifications).toBe(1)
  })
})

describe('assignHistoricalMembershipTx', () => {
  it('replaces the provisioning auto-enrollment with a hire-dated row', async () => {
    await seedPolicy('default-15-5', 15, 5, {
      id: testUuid('policy-default-15-5'),
      isDefault: true,
    })
    const userId = await seedEmployee('enrolled', '2019-06-03')
    const before = await membershipsOf(userId)
    expect(before).toHaveLength(1)
    expect(before[0]?.assignedByUserId).toBeNull()

    const policyId = await seedPolicy('target-25-5', 25, 5)
    const result = await dataSource.transaction((manager) =>
      service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2019-06-03',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      }),
    )

    expect(result.outcome).toBe('assigned')
    const after = await membershipsOf(userId)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      policyId,
      effectiveFrom: '2019-06-03',
      effectiveTo: null,
      note: 'History import',
    })
  })

  it('is idempotent: a second identical run keeps the row', async () => {
    const userId = await seedEmployee('twice', '2021-02-01')
    const policyId = await seedPolicy('twice-25-5', 25, 5)
    const assign = () =>
      dataSource.transaction((manager) =>
        service.assignHistoricalMembershipTx(manager, {
          userId,
          policyId,
          effectiveFrom: '2021-02-01',
          assignedByUserId: testUuid('user-approver'),
          mode: 'add',
          audit: IMPORT_ACTOR,
        }),
      )

    const first = await assign()
    const second = await assign()

    expect(first.outcome).toBe('assigned')
    expect(second.outcome).toBe('kept')
    expect(second.membershipRowId).toBe(first.membershipRowId)
    expect(await membershipsOf(userId)).toHaveLength(1)
  })

  it('keeps a hand-assigned timeline in add mode and replaces it in override', async () => {
    const userId = await seedEmployee('curated', '2018-01-09')
    const curatedPolicy = await seedPolicy('curated-23-5', 23, 5)
    const importPolicy = await seedPolicy('curated-25-5', 25, 5)
    await dataSource.getRepository(LeavePolicyMembershipEntity).save({
      id: testUuid('membership-curated'),
      userId,
      policyId: curatedPolicy,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      supersededByRowId: null,
      assignedByUserId: testUuid('user-approver'),
      note: 'Set by an administrator',
      createdAt: T0,
      updatedAt: T0,
    })

    const skipped = await dataSource.transaction((manager) =>
      service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId: importPolicy,
        effectiveFrom: '2018-01-09',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      }),
    )
    expect(skipped.outcome).toBe('skipped')
    expect((await membershipsOf(userId))[0]?.policyId).toBe(curatedPolicy)

    const replaced = await dataSource.transaction((manager) =>
      service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId: importPolicy,
        effectiveFrom: '2018-01-09',
        assignedByUserId: testUuid('user-approver'),
        mode: 'override',
        audit: IMPORT_ACTOR,
      }),
    )
    expect(replaced.outcome).toBe('assigned')
    const rows = await membershipsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      policyId: importPolicy,
      effectiveFrom: '2018-01-09',
    })
  })

  it('refuses a retired policy', async () => {
    const userId = await seedEmployee('retired', '2020-01-06')
    const policyId = await seedPolicy('retired-25-5', 25, 5, {
      effectiveTo: '2025-12-31',
    })

    await expect(
      dataSource.transaction((manager) =>
        service.assignHistoricalMembershipTx(manager, {
          userId,
          policyId,
          effectiveFrom: '2020-01-06',
          assignedByUserId: testUuid('user-approver'),
          mode: 'add',
          audit: IMPORT_ACTOR,
        }),
      ),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)
  })
})

describe('seedCarryoverHistoryTx', () => {
  const seedUser = async (slug: string, hireDate: string, carried: number) => {
    const userId = await seedEmployee(slug, hireDate)
    const policyId = await seedPolicy(`${slug}-25-5`, 25, 5)
    await dataSource.transaction(async (manager) => {
      await service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: hireDate,
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      })
      await service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: carried,
        audit: IMPORT_ACTOR,
      })
    })
    return userId
  }

  it('settles pre-import years and books the opening carryover on January 1', async () => {
    const userId = await seedUser('seeded', '2019-04-15', 7)

    const settled = await allocationOf(userId, LeaveType.Vacation, 2023)
    expect(settled).toMatchObject({
      totalDays: 0,
      carriedOverDays: 0,
      carryoverFinalized: true,
      sourcePolicyId: null,
    })
    expect(settled?.closedAt).not.toBeNull()

    const target = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(target).toMatchObject({
      totalDays: 25,
      carriedOverDays: 7,
      carryoverFinalized: true,
    })
    expect(target?.closedAt).toBeNull()

    const carryIn = (await ledgerOf(userId)).filter(
      (row) => row.reason === LeaveBalanceChangeReason.CarryoverIn,
    )
    expect(carryIn).toHaveLength(1)
    expect(carryIn[0]).toMatchObject({
      year: 2026,
      effectiveDate: '2026-01-01',
      deltaDays: 7,
      leaveType: LeaveType.Vacation,
    })
  })

  it('produces no phantom carryover when the engine later refreshes', async () => {
    const userId = await seedUser('no-phantom', '2019-04-15', 7)

    await service.refreshBalances(userId)

    const ledger = await ledgerOf(userId)
    const closes = ledger.filter(
      (row) =>
        row.reason === LeaveBalanceChangeReason.CarryoverOut ||
        row.reason === LeaveBalanceChangeReason.Expired,
    )
    expect(closes).toHaveLength(0)
    expect(
      ledger.filter(
        (row) => row.reason === LeaveBalanceChangeReason.CarryoverIn,
      ),
    ).toHaveLength(1)

    // Seeded carryover plus the accrual due by August (25 * 8/12 = 16.67).
    const balance = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(balance?.accruedDays).toBeCloseTo(7 + 16.67, 2)
  })

  it('is a no-op when the same figure is seeded twice', async () => {
    const userId = await seedUser('resettle', '2019-04-15', 7)

    const again = await dataSource.transaction((manager) =>
      service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 7,
        audit: IMPORT_ACTOR,
      }),
    )

    expect(again.outcome).toBe('kept')
    const carryIn = (await ledgerOf(userId)).filter(
      (row) => row.reason === LeaveBalanceChangeReason.CarryoverIn,
    )
    expect(carryIn).toHaveLength(1)
  })

  it('refuses to re-base a year that already holds leave', async () => {
    const userId = await seedUser('rebased', '2019-04-15', 7)
    await replayApprovedLeave(
      userId,
      LeaveType.Vacation,
      '2026-03-02',
      '2026-03-06',
      '2026-02-20T09:00:00.000Z',
    )

    await expect(
      dataSource.transaction((manager) =>
        service.seedCarryoverHistoryTx(manager, {
          userId,
          targetYear: 2026,
          carriedOverVacationDays: 9,
          audit: IMPORT_ACTOR,
        }),
      ),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)
  })

  it('seeds the real opening over the years the engine settled trivially', async () => {
    // A hire date years before the account existed used to make the first
    // balance read materialize every employed year and carry a phantom
    // leftover forward. The system-epoch rule killed that at the source: the
    // walk settles pre-provisioning years trivially, so the engine derives
    // NOTHING to carry — and the seed is the only writer of the opening.
    const userId = await seedEmployee('phantom', '2019-04-15')
    await service.refreshBalances(userId)
    const phantom = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(phantom?.carriedOverDays ?? 0).toBe(0)

    const policyId = await seedPolicy('phantom-25-5', 25, 5)
    await dataSource.transaction(async (manager) => {
      await service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2019-04-15',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      })
      await service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 7,
        audit: IMPORT_ACTOR,
      })
    })
    await service.refreshBalances(userId)

    expect(
      (await allocationOf(userId, LeaveType.Vacation, 2026))?.carriedOverDays,
    ).toBe(7)
    const carryIn = (await ledgerOf(userId)).filter(
      (row) => row.reason === LeaveBalanceChangeReason.CarryoverIn,
    )
    expect(carryIn).toHaveLength(1)
    expect(carryIn[0]?.deltaDays).toBe(7)
    const balance = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(balance?.accruedDays).toBeCloseTo(7 + 16.67, 2)
  })

  it('refuses carryover for an employee hired inside the target year', async () => {
    const userId = await seedEmployee('fresh', '2026-02-17')
    const policyId = await seedPolicy('fresh-15-5', 15, 5)

    await expect(
      dataSource.transaction(async (manager) => {
        await service.assignHistoricalMembershipTx(manager, {
          userId,
          policyId,
          effectiveFrom: '2026-02-17',
          assignedByUserId: testUuid('user-approver'),
          mode: 'add',
          audit: IMPORT_ACTOR,
        })
        await service.seedCarryoverHistoryTx(manager, {
          userId,
          targetYear: 2026,
          carriedOverVacationDays: 4,
          audit: IMPORT_ACTOR,
        })
      }),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)
  })
})

describe('resetUserLeaveDataFromYearTx + repostRequestMechanicallyTx', () => {
  it('rebuilds the target year and restores later-year requests unchanged', async () => {
    const userId = await seedEmployee('rebuild', '2020-03-02')
    const policyId = await seedPolicy('rebuild-25-5', 25, 5)
    await dataSource.transaction(async (manager) => {
      await service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2020-03-02',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      })
      await service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 5,
        audit: IMPORT_ACTOR,
      })
    })
    const targetYearRequest = await replayApprovedLeave(
      userId,
      LeaveType.Vacation,
      '2026-03-02',
      '2026-03-06',
      '2026-02-20T09:00:00.000Z',
    )
    const laterYearRequest = await replayApprovedLeave(
      userId,
      LeaveType.Vacation,
      '2027-03-01',
      '2027-03-05',
      '2026-07-01T09:00:00.000Z',
    )
    await service.refreshBalances(userId)
    const before = {
      balance2026: await balanceOf(userId, LeaveType.Vacation, 2026),
      balance2027: await balanceOf(userId, LeaveType.Vacation, 2027),
      later: await dataSource
        .getRepository(LeaveRequestEntity)
        .findOneBy({ id: laterYearRequest }),
    }

    // The override cycle: wipe from the target year, re-seed, replay the file
    // row, then put the later-year booking back.
    await dataSource.transaction(async (manager) => {
      const wiped = await service.resetUserLeaveDataFromYearTx(manager, {
        userId,
        fromYear: 2026,
        audit: IMPORT_ACTOR,
      })
      expect(wiped.repost).toHaveLength(1)
      expect(wiped.clearedRequests).toBe(2)
      await service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 5,
        audit: IMPORT_ACTOR,
      })
      const detail = await service.submitLeaveRequestTx(
        manager,
        {
          requestId: targetYearRequest,
          requesterUserId: userId,
          leaveType: LeaveType.Vacation,
          startDate: '2026-03-02',
          endDate: '2026-03-06',
          approverEmails: ['manager@example.com'],
          ccEmails: [],
          submittedAt: '2026-02-20T09:00:00.000Z',
          audit: IMPORT_ACTOR,
        },
        { suppressNotifications: true },
      )
      await service.forceDecideLeaveRequestTx(manager, {
        requestId: detail.requestId,
        actorUserId: testUuid('user-approver'),
        actorDisplayName: 'Import admin',
        action: LeaveApprovalAction.Approve,
        comment: 'History import',
        decidedAt: '2026-02-20T09:00:00.000Z',
        audit: IMPORT_ACTOR,
        suppressNotifications: true,
      })
      for (const snapshot of wiped.repost) {
        await service.repostRequestMechanicallyTx(manager, snapshot)
      }
    })
    await service.refreshBalances(userId)

    const after = {
      balance2026: await balanceOf(userId, LeaveType.Vacation, 2026),
      balance2027: await balanceOf(userId, LeaveType.Vacation, 2027),
      later: await dataSource
        .getRepository(LeaveRequestEntity)
        .findOneBy({ id: laterYearRequest }),
    }

    expect(after.balance2026?.accruedDays).toBeCloseTo(
      before.balance2026?.accruedDays ?? -1,
      2,
    )
    expect(after.balance2026?.spentDays).toBeCloseTo(
      before.balance2026?.spentDays ?? -1,
      2,
    )
    expect(after.balance2026?.onHoldDays).toBeCloseTo(
      before.balance2026?.onHoldDays ?? -1,
      2,
    )
    expect(after.balance2027?.onHoldDays).toBeCloseTo(
      before.balance2027?.onHoldDays ?? -1,
      2,
    )
    // The later-year booking is back verbatim: same id, same frozen days,
    // same status.
    expect(after.later).toMatchObject({
      id: laterYearRequest,
      status: LeaveRequestStatus.Approved,
      leaveDays: before.later?.leaveDays,
      unpaidLeaveDays: before.later?.unpaidLeaveDays,
      startDate: '2027-03-01',
      endDate: '2027-03-05',
    })
    expect(await dataSource.getRepository(NotificationEntity).count()).toBe(0)
  })

  it('leaves years before the floor untouched', async () => {
    const userId = await seedEmployee('floor', '2020-03-02')
    const policyId = await seedPolicy('floor-25-5', 25, 5)
    await dataSource.transaction(async (manager) => {
      await service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2020-03-02',
        assignedByUserId: testUuid('user-approver'),
        mode: 'add',
        audit: IMPORT_ACTOR,
      })
      await service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 3,
        audit: IMPORT_ACTOR,
      })
    })

    await dataSource.transaction((manager) =>
      service.resetUserLeaveDataFromYearTx(manager, {
        userId,
        fromYear: 2026,
        audit: IMPORT_ACTOR,
      }),
    )

    const settled = await allocationOf(userId, LeaveType.Vacation, 2024)
    expect(settled).toMatchObject({ carryoverFinalized: true, totalDays: 0 })
    expect(settled?.closedAt).not.toBeNull()
    const target = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(target).toMatchObject({
      carriedOverDays: 0,
      carryoverFinalized: false,
    })
  })
})
