/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveType,
} from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { LeaveDomainService } from './leave-domain.service'
import { NotificationService } from './notification.service'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeaveBalanceChangeEntity } from './entities/leave-balance-change.entity'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { policyTermsFingerprint } from './policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// The system epoch: the engine's own memory of a user begins the year the
// system MET them (users.createdAt), never the year they were hired. Years
// before that boundary are the history import's territory — the year-close
// walk settles them trivially (zero carryover, no rows) instead of re-living
// them, so neither a backdated start date nor a test reset can fabricate
// accrual history the system never witnessed. Years from the boundary on are
// real: they close with a genuine top-up and carryover, dormant or not.

let dataSource: DataSource
let service: LeaveDomainService
let clock: ClockService

const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-08-06T09:00:00.000Z'
// The moment the directory sync provisioned every account in these specs.
const MET_AT = '2026-08-01T00:00:00.000Z'

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
      vacationAnnualIncrement: 0,
      vacationIncrementEveryYears: 1,
      vacationIncrementCapDays: null,
      probationMonths: 0,
      paidSickDuringProbation: false,
    }),
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

const seedEmployee = async (
  slug: string,
  employmentStartDate: string | undefined,
): Promise<string> => {
  const user = await service.upsertUser({
    userId: testUuid(`user-${slug}`),
    email: `${slug}@example.com`,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate,
    createdAt: MET_AT,
  })
  return user.userId
}

// "A read happened": the same settle every dashboard/history read drives.
const settle = (userId: string): Promise<void> =>
  dataSource.transaction((manager) =>
    service.settleBalancesTx(manager, userId, clock.nowIso()),
  )

const allocationsOf = (userId: string, leaveType: LeaveType) =>
  dataSource.getRepository(LeaveAllocationEntity).find({
    where: { userId, leaveType },
    order: { year: 'ASC' },
  })

const balanceOf = (userId: string, leaveType: LeaveType, year: number) =>
  dataSource
    .getRepository(LeaveBalanceEntity)
    .findOneBy({ userId, leaveType, year })

const ledgerOf = (userId: string) =>
  dataSource.getRepository(LeaveBalanceChangeEntity).find({
    where: { userId },
    order: { createdAt: 'ASC' },
  })

const ledgerYears = async (userId: string): Promise<number[]> =>
  [...new Set((await ledgerOf(userId)).map((entry) => entry.year))].sort()

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
  // The approver the replayed request is force-decided as: force-decide
  // refuses a self-decision, so it must be somebody other than the requester.
  await service.upsertUser({
    userId: testUuid('user-approver'),
    email: 'manager@example.com',
    displayName: 'Manager',
    countryCode: 'UA',
    createdAt: MET_AT,
  })
  await seedHolidayCalendar(service, { countryCode: 'UA', year: 2026 })
  await seedHolidayCalendar(service, { countryCode: 'UA', year: 2027 })
})

describe('system epoch', () => {
  it('a backdated start date set by hand recalculates only the current year', async () => {
    // Synced from LDAP with no start date, like every real provisioning.
    const userId = await seedEmployee('backdated', undefined)
    await settle(userId)

    // The admin fills the hire date in by hand, a quarter century back.
    await service.updateEmployeeAdmin({
      userId,
      employmentStartDate: '2001-06-15',
      audit: IMPORT_ACTOR,
    })
    await settle(userId)

    // Only the current year exists: no allocation, balance or ledger row was
    // fabricated for 2001-2025, and the current year's inbound carryover was
    // settled trivially at zero.
    const vacation = await allocationsOf(userId, LeaveType.Vacation)
    expect(vacation.map((allocation) => allocation.year)).toEqual([2026])
    expect(vacation[0]!.carryoverFinalized).toBe(true)
    expect(vacation[0]!.carriedOverDays).toBe(0)
    expect(vacation[0]!.closedAt).toBeNull()
    const sick = await allocationsOf(userId, LeaveType.Sick)
    expect(sick.map((allocation) => allocation.year)).toEqual([2026])
    expect(await ledgerYears(userId)).toEqual([2026])
    expect(
      (await ledgerOf(userId)).filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.CarryoverIn,
      ),
    ).toEqual([])
    // January-to-August under the full-year schedule: the anchor predates the
    // year, so the current year itself accrues as a whole year.
    expect((await balanceOf(userId, LeaveType.Vacation, 2026))?.accruedDays).toBe(
      16.667,
    )
    // The SHAPE matters as much as the sum: a first-time set is a plain
    // catch-up through the ordinary accrual, one row per month owed dated to
    // its own 1st — never a single re-anchor adjustment lump.
    const vacationLedger = (await ledgerOf(userId)).filter(
      (entry) => entry.leaveType === LeaveType.Vacation,
    )
    expect(
      vacationLedger
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .map((entry) => entry.effectiveDate),
    ).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
    ])
    expect(
      vacationLedger.filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
      ),
    ).toEqual([])
  })

  it('a reset after an import cannot fabricate the pre-import years, and a re-seed restores the opening', async () => {
    const userId = await seedEmployee('resettled', '2019-04-01')
    const policyId = await seedPolicy('resettled-25-5', 25, 5)
    await dataSource.transaction(async (manager) => {
      await service.assignHistoricalMembershipTx(manager, {
        userId,
        policyId,
        effectiveFrom: '2019-04-01',
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
    // One replayed historical leave, the way the import posts them.
    await dataSource.transaction(async (manager) => {
      const detail = await service.submitLeaveRequestTx(
        manager,
        {
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
    })
    await settle(userId)

    // Sanity: the imported shape is in place before the reset.
    const seeded = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(seeded?.carriedOverDays).toBe(7)
    expect((await balanceOf(userId, LeaveType.Vacation, 2026))?.spentDays).toBe(5)

    await service.resetUserLeaveData({ userId })
    await settle(userId)

    // The wipe scrubbed the import's settled years back to pending — and the
    // walk settled them trivially again instead of re-living them: the ledger
    // holds nothing but the current year's fresh accrual, the opening
    // carryover is gone (it is data, not derivable), and no pre-epoch year
    // gained a single ledger row.
    expect(await ledgerYears(userId)).toEqual([2026])
    expect(
      (await ledgerOf(userId)).filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.CarryoverIn,
      ),
    ).toEqual([])
    const afterReset = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(afterReset?.accruedDays).toBe(16.667)
    expect(afterReset?.spentDays).toBe(0)
    const preYears = await allocationsOf(userId, LeaveType.Vacation)
    for (const allocation of preYears.filter((entry) => entry.year < 2026)) {
      expect(allocation.carryoverFinalized).toBe(true)
      expect(allocation.carriedOverDays).toBe(0)
      expect(allocation.totalDays).toBe(0)
    }

    // The owner's cycle: reset for a clean year, re-import to restore. The
    // seed accepts a re-run (nothing on record anymore) and reinstates the
    // opening figure.
    const reseed = await dataSource.transaction((manager) =>
      service.seedCarryoverHistoryTx(manager, {
        userId,
        targetYear: 2026,
        carriedOverVacationDays: 7,
        audit: IMPORT_ACTOR,
      }),
    )
    expect(reseed.outcome).toBe('seeded')
    await settle(userId)
    const restored = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(restored?.accruedDays).toBe(23.667)
    expect(
      (await ledgerOf(userId)).filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.CarryoverIn,
      ),
    ).toHaveLength(1)
  })

  it('the first in-system year still closes for real at New Year', async () => {
    const userId = await seedEmployee('newyear', '2001-06-15')
    await settle(userId)

    clock.setNow('2027-01-15T09:00:00.000Z')
    await settle(userId)

    // 2026 closed genuinely: topped up to 12/12 and folded — its leftover
    // left as carryover or expired, both dated to its own December 31.
    const vacation2026 = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(vacation2026?.closedAt).not.toBeNull()
    const folded = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(folded?.accruedDays).toBe(0)
    const closing = (await ledgerOf(userId)).filter(
      (entry) =>
        entry.leaveType === LeaveType.Vacation &&
        entry.year === 2026 &&
        (entry.reason === LeaveBalanceChangeReason.CarryoverOut ||
          entry.reason === LeaveBalanceChangeReason.Expired),
    )
    expect(
      Math.round(
        closing.reduce((sum, entry) => sum + Number(entry.deltaDays), 0) * 100,
      ) / 100,
    ).toBe(25)
    const vacation2027 = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2027 })
    expect(vacation2027?.carryoverFinalized).toBe(true)
    // And the close still fabricated nothing before the epoch.
    expect(
      (await ledgerYears(userId)).every((year) => year >= 2026),
    ).toBe(true)
    expect(
      (await allocationsOf(userId, LeaveType.Vacation)).map(
        (allocation) => allocation.year,
      ),
    ).toEqual([2026, 2027])
  })

  it('a dormant in-system year is still materialized and closed for real', async () => {
    const userId = await seedEmployee('dormant', '2026-01-01')
    await settle(userId)

    // Nobody touches the account through all of 2027.
    clock.setNow('2028-02-10T09:00:00.000Z')
    await settle(userId)

    // The slept-through 2027 was materialized and closed genuinely — it is
    // in-system history, dormancy does not turn it into a zero.
    const years = (await allocationsOf(userId, LeaveType.Vacation)).map(
      (allocation) => allocation.year,
    )
    expect(years).toEqual([2026, 2027, 2028])
    const vacation2027 = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2027 })
    expect(vacation2027?.closedAt).not.toBeNull()
    expect(vacation2027?.totalDays).toBe(25)
    const vacation2028 = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2028 })
    expect(vacation2028?.carryoverFinalized).toBe(true)
    // The dormant year really accrued: its close topped it to a full twelve
    // months before carrying over, and nothing exists before the epoch.
    const accrual2027 = (await ledgerOf(userId)).filter(
      (entry) =>
        entry.year === 2027 &&
        entry.reason === LeaveBalanceChangeReason.Accrual,
    )
    expect(accrual2027.length).toBeGreaterThan(0)
    expect((await ledgerYears(userId)).every((year) => year >= 2026)).toBe(true)
  })
})
