/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import { LeaveBalanceChangeReason, LeaveType } from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { LeaveDomainService } from './leave-domain.service'
import { NotificationService } from './notification.service'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from './entities/leave-policy-membership.entity'
import { policyTermsFingerprint } from './policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// Stage 2a of the policy engine: the accrual formula reads per-month rate
// segments from the membership timeline. These specs seed policies and
// memberships directly through the repositories — the transfer writer does not
// exist yet — and drive accrual through the same public reads production uses.

let dataSource: DataSource
let service: LeaveDomainService

const T0 = '2026-01-01T00:00:00.000Z'

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
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    isDefault: false,
    termsFingerprint: policyTermsFingerprint({
      vacationDays,
      sickDays,
      vacationAnnualIncrement: overrides.vacationAnnualIncrement ?? 0,
      vacationIncrementEveryYears: overrides.vacationIncrementEveryYears ?? 1,
      vacationIncrementCapDays: overrides.vacationIncrementCapDays ?? null,
      probationMonths: 0,
      paidSickDuringProbation: false,
    }),
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  })
  return id
}

const seedMembership = async (
  slug: string,
  userId: string,
  policyId: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<void> => {
  await dataSource.getRepository(LeavePolicyMembershipEntity).save({
    id: testUuid(`membership-${slug}`),
    userId,
    policyId,
    effectiveFrom,
    effectiveTo,
    supersededByRowId: null,
    assignedByUserId: null,
    note: null,
    createdAt: T0,
    updatedAt: T0,
  })
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
    // Provisioned BEFORE employment starts: the provisioning-time balance
    // initialization then accrues nothing and creates no current-year
    // allocation, so the memberships seeded next fully govern the hire year
    // (mirrors the real flow where enrollment precedes the year's first read).
    createdAt: '2025-12-20T00:00:00.000Z',
  })
  return user.userId
}

const allocationOf = (
  userId: string,
  leaveType: LeaveType,
  year: number,
): Promise<LeaveAllocationEntity | null> =>
  dataSource
    .getRepository(LeaveAllocationEntity)
    .findOneBy({ userId, leaveType, year })

const balanceOf = (
  userId: string,
  leaveType: LeaveType,
  year: number,
): Promise<LeaveBalanceEntity | null> =>
  dataSource
    .getRepository(LeaveBalanceEntity)
    .findOneBy({ userId, leaveType, year })

beforeAll(async () => {
  dataSource = await initTestDataSource()
})

afterAll(async () => {
  await dataSource?.destroy()
})

beforeEach(async () => {
  await truncateAll(dataSource)
  const clock = new ClockService()
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
})

describe('policy engine piecewise accrual', () => {
  it('accrues each month at the owning segment rate across a mid-year boundary', async () => {
    const userId = await seedEmployee('piecewise', '2026-01-01')
    const oldPolicy = await seedPolicy('old-15', 15, 5)
    const newPolicy = await seedPolicy('new-25', 25, 5)
    await seedMembership('pw-old', userId, oldPolicy, '2026-01-01', '2026-07-01')
    await seedMembership('pw-new', userId, newPolicy, '2026-07-01')

    await service.refreshBalances(userId, '2026-12-15T12:00:00.000Z')

    const timeline = await service.getBalanceTimeline(userId, LeaveType.Vacation)
    const accruals = timeline
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
      .map((entry) => [entry.effectiveDate, entry.deltaDays])
    expect(accruals).toEqual([
      ['2026-01-01', 1.25],
      ['2026-02-01', 1.25],
      ['2026-03-01', 1.25],
      ['2026-04-01', 1.25],
      ['2026-05-01', 1.25],
      ['2026-06-01', 1.25],
      ['2026-07-01', 2.083],
      ['2026-08-01', 2.084],
      ['2026-09-01', 2.083],
      ['2026-10-01', 2.083],
      ['2026-11-01', 2.084],
      ['2026-12-01', 2.083],
    ])
    const balance = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(balance?.accruedDays).toBe(20)
    const allocation = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(allocation?.totalDays).toBe(20)
    expect(allocation?.sourcePolicyId).toBe(newPolicy)
    expect(allocation?.note).toContain('old-15')
    expect(allocation?.note).toContain('new-25')
  })

  it('closes a dormant year at the true piecewise total before carrying over', async () => {
    const userId = await seedEmployee('dormant', '2026-01-01')
    const oldPolicy = await seedPolicy('dormant-old', 15, 5)
    const newPolicy = await seedPolicy('dormant-new', 25, 5)
    await seedMembership('do-old', userId, oldPolicy, '2026-01-01', '2026-10-01')
    await seedMembership('do-new', userId, newPolicy, '2026-10-01')

    // The user is never read during 2026; the first read lands in March 2027
    // and must settle 2026 on the schedule that actually governed it.
    await service.refreshBalances(userId, '2027-03-15T12:00:00.000Z')

    const closed = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(closed?.totalDays).toBe(17.5) // (15*9 + 25*3) / 12
    expect(closed?.closedAt).not.toBeNull()
    const timeline = await service.getBalanceTimeline(userId, LeaveType.Vacation)
    const byReason = (reason: LeaveBalanceChangeReason) =>
      timeline.filter((entry) => entry.reason === reason)
    expect(
      byReason(LeaveBalanceChangeReason.CarryoverOut).map((entry) => entry.deltaDays),
    ).toEqual([8]) // floor(17.5 * 50%)
    expect(
      byReason(LeaveBalanceChangeReason.Expired).map((entry) => entry.deltaDays),
    ).toEqual([9.5])
    expect(
      byReason(LeaveBalanceChangeReason.CarryoverIn).map((entry) => entry.deltaDays),
    ).toEqual([8])
    const next = await allocationOf(userId, LeaveType.Vacation, 2027)
    expect(next?.totalDays).toBe(25)
    expect(next?.carriedOverDays).toBe(8)
    expect(next?.sourcePolicyId).toBe(newPolicy)
    const balance = await balanceOf(userId, LeaveType.Vacation, 2027)
    expect(balance?.accruedDays).toBe(14.25) // 8 carried + 25*3/12
  })

  it('materializes the annual increment at the year boundary and matches the December preview', async () => {
    const userId = await seedEmployee('increment', '2026-01-01')
    const policy = await seedPolicy('grow-25', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 35,
    })
    await seedMembership('inc', userId, policy, '2026-01-01')
    await seedHolidayCalendar(service, { year: 2026 })
    await seedHolidayCalendar(service, { year: 2027 })

    await service.refreshBalances(userId, '2026-12-20T12:00:00.000Z')

    const preview = await service.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2027-01-11',
      endDate: '2027-01-12',
      asOfIso: '2026-12-20T12:00:00.000Z',
    })
    const january = preview.monthlyOutlook.find(
      (month) => month.year === 2027 && month.month === 1,
    )
    // 25 accrued in 2026 -> projected carryover floor(25 * 50%) = 12; January
    // 2027 accrues at the INCREMENTED rate 27/12 = 2.25.
    expect(january?.projectedAccruedDays).toBe(14.25)

    await service.refreshBalances(userId, '2027-01-20T12:00:00.000Z')
    const next = await allocationOf(userId, LeaveType.Vacation, 2027)
    expect(next?.totalDays).toBe(27)
    expect(next?.carriedOverDays).toBe(12)
    const balance = await balanceOf(userId, LeaveType.Vacation, 2027)
    // The materialized January figure equals what December previewed.
    expect(balance?.accruedDays).toBe(january?.projectedAccruedDays)
  })

  it('holds a periodic increment flat until the step year, then raises it on 1 January', async () => {
    const userId = await seedEmployee('every-3', '2026-01-01')
    const policy = await seedPolicy('step-25', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })
    await seedMembership('e3', userId, policy, '2026-01-01')
    await seedHolidayCalendar(service, { year: 2026 })
    await seedHolidayCalendar(service, { year: 2027 })

    await service.refreshBalances(userId, '2026-12-20T12:00:00.000Z')
    expect((await allocationOf(userId, LeaveType.Vacation, 2026))?.totalDays).toBe(25)

    // The year boundary WITHOUT a step: 2027 is only the second employment
    // year, so the rate stays 25 and January accrues 25/12, not 30/12.
    const preview = await service.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2027-01-11',
      endDate: '2027-01-12',
      asOfIso: '2026-12-20T12:00:00.000Z',
    })
    const january = preview.monthlyOutlook.find(
      (month) => month.year === 2027 && month.month === 1,
    )
    expect(january?.projectedAccruedDays).toBe(14.083) // 12 carried + 25/12

    await service.refreshBalances(userId, '2027-01-20T12:00:00.000Z')
    expect((await allocationOf(userId, LeaveType.Vacation, 2027))?.totalDays).toBe(25)
    // December's preview and January's materialization still agree.
    expect((await balanceOf(userId, LeaveType.Vacation, 2027))?.accruedDays).toBe(
      january?.projectedAccruedDays,
    )

    // The year boundary WITH the step: 2029 completes the first three-year
    // period, so the allowance rises once, from 1 January.
    await service.refreshBalances(userId, '2029-01-20T12:00:00.000Z')
    expect((await allocationOf(userId, LeaveType.Vacation, 2028))?.totalDays).toBe(25)
    expect((await allocationOf(userId, LeaveType.Vacation, 2029))?.totalDays).toBe(30)
  })

  it('lowers the year rate when a member moves from every 2 years to every 3, keeping what accrued', async () => {
    const userId = await seedEmployee('period-move', '2014-01-01')
    // 12 employment years by 2026: every 2 years gives 6 steps (37), every 3
    // gives 4 (33).
    const every2 = await seedPolicy('every-2', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementEveryYears: 2,
    })
    const every3 = await seedPolicy('every-3-move', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementEveryYears: 3,
    })
    await seedMembership('pm-2', userId, every2, '2026-01-01', '2027-01-01')
    await seedMembership('pm-3', userId, every3, '2027-01-01')

    await service.refreshBalances(userId, '2026-12-15T12:00:00.000Z')
    expect((await allocationOf(userId, LeaveType.Vacation, 2026))?.totalDays).toBe(37)
    // 37 earned this year plus floor(35 * 50%) carried in from 2025, which the
    // every-2 rate opened at 35.
    expect((await balanceOf(userId, LeaveType.Vacation, 2026))?.accruedDays).toBe(54)

    // A year of seniority later, yet the allowance FALLS: 13 years buy 6 steps
    // every 2 years and only 4 every 3.
    await service.refreshBalances(userId, '2027-06-15T12:00:00.000Z')
    const next = await allocationOf(userId, LeaveType.Vacation, 2027)
    expect(next?.totalDays).toBe(33)
    // What the higher rate earned is not clawed back: the year closes on the
    // days actually accrued and carries half of them in.
    expect(next?.carriedOverDays).toBe(27) // floor(54 * 50%)
  })

  it('opens the current year at the cap for a backdated 2001 hire and invents no earlier years', async () => {
    const userId = await seedEmployee('old-timer', '2001-05-01')
    const policy = await seedPolicy('capped-step', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
      vacationIncrementCapDays: 35,
    })
    await seedMembership('ot', userId, policy, '2026-01-01')
    await service.refreshBalances(userId, '2026-06-15T12:00:00.000Z')

    // 25 employment years, 8 completed periods: 65 days, held at the cap.
    expect((await allocationOf(userId, LeaveType.Vacation, 2026))?.totalDays).toBe(35)
    // The engine's epoch is the year the user row was created, not the hire
    // year: no allocation is fabricated for 2001..2024.
    const years = (
      await dataSource
        .getRepository(LeaveAllocationEntity)
        .findBy({ userId, leaveType: LeaveType.Vacation })
    ).map((allocation) => allocation.year)
    expect(Math.min(...years)).toBeGreaterThanOrEqual(2025)

    // Uncapped, the same seniority shows the step count itself: 25 + 8*5.
    const uncapped = await seedEmployee('old-timer-uncapped', '2001-05-01')
    const openPolicy = await seedPolicy('uncapped-step', 25, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })
    await seedMembership('otu', uncapped, openPolicy, '2026-01-01')
    await service.refreshBalances(uncapped, '2026-06-15T12:00:00.000Z')
    expect((await allocationOf(uncapped, LeaveType.Vacation, 2026))?.totalDays).toBe(65)
  })

  it('ratchets the sick tranche: an upgrade re-tranches lazily, a downgrade waits for Jan 1', async () => {
    const upgraded = await seedEmployee('sick-up', '2026-01-01')
    const noSick = await seedPolicy('no-sick', 15, 0)
    const withSick = await seedPolicy('with-sick', 15, 5)
    await seedMembership('su-old', upgraded, noSick, '2026-01-01', '2026-09-01')
    await seedMembership('su-new', upgraded, withSick, '2026-09-01')
    await service.refreshBalances(upgraded, '2026-10-15T12:00:00.000Z')
    const upTimeline = await service.getBalanceTimeline(upgraded, LeaveType.Sick)
    const upAccruals = upTimeline
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
      .map((entry) => [entry.effectiveDate, entry.deltaDays])
    // The tranche lands when the loop reaches the boundary month, dated to it.
    expect(upAccruals).toEqual([['2026-09-01', 5]])

    const downgraded = await seedEmployee('sick-down', '2026-01-01')
    await seedMembership('sd-old', downgraded, withSick, '2026-01-01', '2026-09-01')
    await seedMembership('sd-new', downgraded, noSick, '2026-09-01')
    await service.refreshBalances(downgraded, '2026-10-15T12:00:00.000Z')
    const downBalance = await balanceOf(downgraded, LeaveType.Sick, 2026)
    // Granted in January under the old policy; the September downgrade does
    // not claw it back (accrual only moves up; Jan 1 is the owner's decision).
    expect(downBalance?.accruedDays).toBe(5)
    const downAllocation = await allocationOf(downgraded, LeaveType.Sick, 2026)
    // The cached annual figure is the December owner's allowance.
    expect(downAllocation?.totalDays).toBe(0)
  })

  it('falls back to the legacy settings path for users with no memberships', async () => {
    const userId = await seedEmployee('legacy', '2026-01-01')
    await service.refreshBalances(userId, '2026-03-15T12:00:00.000Z')
    const allocation = await allocationOf(userId, LeaveType.Vacation, 2026)
    expect(allocation?.totalDays).toBe(25)
    expect(allocation?.sourcePolicyId).toBeNull()
    // The provisioning-time 2025 row exists, so the legacy prior-year clone
    // fires exactly as before the engine.
    expect(allocation?.note).toBe('Rolled over from the prior year')
    const balance = await balanceOf(userId, LeaveType.Vacation, 2026)
    expect(balance?.accruedDays).toBe(6.25) // 25 * 3 / 12, unchanged behavior
  })
})
