/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  CarryoverCapMode,
  CarryoverPolicy,
  LeaveBalanceChangeReason,
  LeaveType,
} from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import {
  LeaveDomainService,
  LeaveDomainValidationError,
  PolicyTransferClosedPeriodError,
} from './leave-domain.service'
import { NotificationService } from './notification.service'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from './entities/leave-policy-membership.entity'
import { policyTermsFingerprint } from './policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// Stage 2b: the membership writer. Every mutation must leave accrued == the
// new timeline's target (reanchor-on-mutation), and the read-only preflight
// must predict exactly what the writer posts.

let dataSource: DataSource
let service: LeaveDomainService
let clock: ClockService

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

const seedMembership = async (
  slug: string,
  userId: string,
  policyId: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<string> => {
  const id = testUuid(`membership-${slug}`)
  await dataSource.getRepository(LeavePolicyMembershipEntity).save({
    id,
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
  return id
}

const seedEmployee = async (
  slug: string,
  employmentStartDate: string,
  createdAt = '2025-12-20T00:00:00.000Z',
): Promise<string> => {
  const user = await service.upsertUser({
    userId: testUuid(`user-${slug}`),
    email: `${slug}@example.com`,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate,
    createdAt,
  })
  return user.userId
}

const membershipsOf = (
  userId: string,
): Promise<LeavePolicyMembershipEntity[]> =>
  dataSource.getRepository(LeavePolicyMembershipEntity).find({
    where: { userId },
    order: { effectiveFrom: 'ASC', createdAt: 'ASC' },
  })

const vacationAdjustments = async (
  userId: string,
): Promise<Array<[string, number, string | undefined]>> => {
  const timeline = await service.getBalanceTimeline(userId, LeaveType.Vacation)
  return timeline
    .filter((entry) => entry.reason === LeaveBalanceChangeReason.Adjustment)
    .map((entry) => [entry.effectiveDate, entry.deltaDays, entry.note])
}

const accruedOf = async (
  userId: string,
  leaveType: LeaveType,
  year: number,
): Promise<number | undefined> => {
  const balance = await dataSource
    .getRepository(LeaveBalanceEntity)
    .findOneBy({ userId, leaveType, year })
  return balance?.accruedDays
}

beforeAll(async () => {
  dataSource = await initTestDataSource()
})

afterAll(async () => {
  await dataSource?.destroy()
})

beforeEach(async () => {
  await truncateAll(dataSource)
  // The writer resolves "today" from the service clock, so these specs need a
  // shiftable one — same pattern the domain spec uses for its tooling service.
  process.env['TEST_TOOLING_ENABLED'] = 'true'
  clock = new ClockService()
  delete process.env['TEST_TOOLING_ENABLED']
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

describe('transferEmployeePolicy', () => {
  it('applies an immediate mid-year upgrade with one signed adjustment to the piecewise target', async () => {
    clock.setNow('2026-07-01T12:00:00.000Z')
    const userId = await seedEmployee('immediate-up', '2026-01-01')
    const oldPolicy = await seedPolicy('imm-old-15', 15, 5)
    const newPolicy = await seedPolicy('imm-new-25', 25, 5)
    await seedMembership('imm', userId, oldPolicy, '2026-01-01')

    await service.transferEmployeePolicy({
      userId,
      policyId: newPolicy,
      effectiveDate: '2026-07-01',
    })

    // Settled under the old rate to 8.75 by July, re-anchored to the
    // piecewise 9.583 (July flips to the new policy under the half-month rule).
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(9.583)
    const adjustments = await vacationAdjustments(userId)
    expect(adjustments).toEqual([
      [
        '2026-07-01',
        0.833,
        'Policy transfer: imm-old-15 -> imm-new-25, effective 2026-07-01',
      ],
    ])
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(allocation?.totalDays).toBe(20)
    expect(allocation?.sourcePolicyId).toBe(newPolicy)
    // Sick terms are identical on both policies: no sick adjustment.
    expect(await accruedOf(userId, LeaveType.Sick, 2026)).toBe(5)

    clock.setNow('2026-12-15T12:00:00.000Z')
    await service.refreshBalances(userId, '2026-12-15T12:00:00.000Z')
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(20)
  })

  it('rolls the whole transaction back when the committed-days guard refuses a downgrade', async () => {
    clock.setNow('2026-11-05T12:00:00.000Z')
    const userId = await seedEmployee('blocked-down', '2026-01-01')
    const approver = await seedEmployee('blocked-approver', '2026-01-01')
    const bigPolicy = await seedPolicy('big-25', 25, 5)
    const tinyPolicy = await seedPolicy('tiny-5', 5, 0)
    await seedMembership('bd', userId, bigPolicy, '2026-01-01')
    await seedHolidayCalendar(service, { year: 2026 })
    await service.refreshBalances(userId, '2026-11-05T12:00:00.000Z')
    // Ten paid December days, pending: committed against the 25-day terms.
    await service.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-12-07',
      endDate: '2026-12-18',
      approverEmails: ['blocked-approver@example.com'],
      ccEmails: [],
      submittedAt: '2026-11-05T12:00:00.000Z',
    })
    void approver

    const input = {
      userId,
      policyId: tinyPolicy,
      effectiveDate: '2026-01-01',
      mode: 'retroactive' as const,
    }
    const preflight = await service.preflightPolicyTransfer(input)
    expect(preflight.feasible).toBe(false)
    expect(preflight.blockingRequests).toHaveLength(1)
    expect(preflight.blockingRequests[0]?.paidDays).toBe(10)

    await expect(service.transferEmployeePolicy(input)).rejects.toThrow(
      /committed/,
    )
    // The refusal rolled everything back: membership timeline untouched.
    const rows = await membershipsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.policyId).toBe(bigPolicy)
    expect(rows[0]?.supersededByRowId).toBeNull()
    expect(await vacationAdjustments(userId)).toEqual([])
  })

  it('preflight measures next-year leave against the prorated allowance-percent ceiling', async () => {
    // Call site C of applyCarryoverPolicy: the transfer preview projects the
    // current year's carryover under the PROPOSED terms, and its base is the
    // hire-prorated earned entitlement, same as the real close. A July hire on
    // 25 days earns 12.5, so five January days fit under the standing ceiling
    // of floor(12.5 / 2) = 6. Moving them to a 10-day policy shrinks the
    // earnable year to 5 and the ceiling to floor(5 / 2) = 2 - the January
    // booking no longer fits and the preview must say which request breaks.
    // The un-prorated rule would have read floor(10 / 2) = 5 off the whole
    // overlay allowance and waved the transfer through.
    clock.setNow('2026-11-05T12:00:00.000Z')
    const userId = await seedEmployee('preflight-pot', '2026-07-01')
    const approver = await seedEmployee('preflight-pot-approver', '2026-01-01')
    const bigPolicy = await seedPolicy('pf-25', 25, 5)
    const tinyPolicy = await seedPolicy('pf-10', 10, 5)
    await seedMembership('pf', userId, bigPolicy, '2026-07-01')
    await seedHolidayCalendar(service, { year: 2026 })
    await seedHolidayCalendar(service, { year: 2027 })
    await service.updateLeaveSettings({
      defaultVacationDays: 25,
      defaultSickDays: 5,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 50,
      updatedAt: T0,
    })
    await service.refreshBalances(userId, '2026-11-05T12:00:00.000Z')
    // Five paid January days, pending: funded by the projected carryover.
    await service.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: LeaveType.Vacation,
      startDate: '2027-01-04',
      endDate: '2027-01-08',
      approverEmails: ['preflight-pot-approver@example.com'],
      ccEmails: [],
      submittedAt: '2026-11-05T12:00:00.000Z',
    })
    void approver

    const preflight = await service.preflightPolicyTransfer({
      userId,
      policyId: tinyPolicy,
      effectiveDate: '2026-07-01',
      mode: 'retroactive' as const,
    })
    expect(preflight.feasible).toBe(false)
    expect(preflight.blockingRequests).toHaveLength(1)
    expect(preflight.blockingRequests[0]?.paidDays).toBe(5)
  })

  it('schedules a future transfer with zero adjustment and an immediate cache update', async () => {
    clock.setNow('2026-06-15T12:00:00.000Z')
    const userId = await seedEmployee('sched', '2026-01-01')
    const oldPolicy = await seedPolicy('sch-old-15', 15, 5)
    const newPolicy = await seedPolicy('sch-new-25', 25, 5)
    await seedMembership('sch', userId, oldPolicy, '2026-01-01')

    await service.transferEmployeePolicy({
      userId,
      policyId: newPolicy,
      effectiveDate: '2026-09-10',
    })

    // September flips (day 10 of a 30-day month owns it): the year-end cache
    // changes at scheduling time, the target-to-date does not.
    expect(await vacationAdjustments(userId)).toEqual([])
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(allocation?.totalDays).toBe(18.333) // (15*8 + 25*4) / 12
    const rows = await membershipsOf(userId)
    expect(
      rows.map((row) => [row.policyId, row.effectiveFrom, row.effectiveTo]),
    ).toEqual([
      [oldPolicy, '2026-01-01', '2026-09-10'],
      [newPolicy, '2026-09-10', null],
    ])

    clock.setNow('2026-10-15T12:00:00.000Z')
    await service.refreshBalances(userId, '2026-10-15T12:00:00.000Z')
    const timeline = await service.getBalanceTimeline(userId, LeaveType.Vacation)
    const accruals = timeline
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
      .map((entry) => [entry.effectiveDate, entry.deltaDays])
    expect(accruals.slice(-2)).toEqual([
      ['2026-09-01', 2.083], // (15*8 + 25*1)/12 = 12.083, from 10.00
      ['2026-10-01', 2.084], // 14.167 - 12.083
    ])
  })

  it('prices the boundary month on schedule and restores it exactly on cancel', async () => {
    clock.setNow('2026-07-01T12:00:00.000Z')
    const userId = await seedEmployee('cancel', '2026-01-01')
    const oldPolicy = await seedPolicy('cn-old-15', 15, 5)
    const newPolicy = await seedPolicy('cn-new-25', 25, 5)
    await seedMembership('cn', userId, oldPolicy, '2026-01-01')

    await service.transferEmployeePolicy({
      userId,
      policyId: newPolicy,
      effectiveDate: '2026-07-10',
    })
    // July snaps to the new policy, and July is already accrued: the schedule
    // itself prices the flip.
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(9.583)

    clock.setNow('2026-07-05T12:00:00.000Z')
    await service.cancelScheduledPolicyTransfer({ userId })
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(8.75)
    const deltas = (await vacationAdjustments(userId)).map(
      ([, delta]) => delta,
    )
    expect(deltas).toEqual([0.833, -0.833])
    const rows = await membershipsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.effectiveTo).toBeNull()

    await expect(
      service.cancelScheduledPolicyTransfer({ userId }),
    ).rejects.toThrow(/No scheduled/)
  })

  it('refuses a second transfer while one is scheduled', async () => {
    clock.setNow('2026-06-15T12:00:00.000Z')
    const userId = await seedEmployee('resched', '2026-01-01')
    const oldPolicy = await seedPolicy('rs-old', 15, 5)
    const a = await seedPolicy('rs-a', 20, 5)
    const b = await seedPolicy('rs-b', 25, 5)
    await seedMembership('rs', userId, oldPolicy, '2026-01-01')
    await service.transferEmployeePolicy({
      userId,
      policyId: a,
      effectiveDate: '2026-09-01',
    })
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: b,
        effectiveDate: '2026-10-01',
      }),
    ).rejects.toThrow(/already pending/)
  })

  it('backdates retroactively to the hire date: the late-assigned new hire case', async () => {
    const defaultPolicy = await seedPolicy('hire-default', 15, 0, {
      isDefault: true,
    })
    const realPolicy = await seedPolicy('hire-real', 25, 5)
    // Provisioned by the directory 19 days after the hire date: the hook
    // enrolls into the default policy from the provisioning day.
    clock.setNow('2026-06-20T12:00:00.000Z')
    const userId = await seedEmployee(
      'late-hire',
      '2026-06-01',
      '2026-06-20T12:00:00.000Z',
    )
    const afterHook = await membershipsOf(userId)
    expect(afterHook).toHaveLength(1)
    expect(afterHook[0]?.policyId).toBe(defaultPolicy)

    clock.setNow('2026-07-10T12:00:00.000Z')
    const input = {
      userId,
      policyId: realPolicy,
      effectiveDate: '2026-06-01',
      mode: 'retroactive' as const,
    }
    const preflight = await service.preflightPolicyTransfer(input)
    await service.transferEmployeePolicy(input)

    // June + July recomputed as if the real policy had always applied:
    // vacation to roundDays(25*2/12) = 4.167 (was 2.50), sick tranche
    // roundDays(5*7/12) = 2.917 (was 0).
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(4.167)
    expect(await accruedOf(userId, LeaveType.Sick, 2026)).toBe(2.917)
    const rows = await membershipsOf(userId)
    const superseded = rows.find((row) => row.policyId === defaultPolicy)
    const live = rows.find((row) => row.policyId === realPolicy)
    expect(superseded?.supersededByRowId).toBe(live?.id)
    expect(live?.effectiveFrom).toBe('2026-06-01')

    // Preflight/write parity: the dry run predicted exactly these deltas.
    expect(preflight.appliedFrom).toBe('2026-06-01')
    expect(
      preflight.perYearAdjustments.map((adjustment) => [
        adjustment.leaveType,
        adjustment.delta,
      ]),
    ).toEqual([
      [LeaveType.Vacation, 1.667],
      [LeaveType.Sick, 2.917],
    ])
  })

  it('backdates prospectively: history intact, new rate from the date on', async () => {
    clock.setNow('2026-11-05T12:00:00.000Z')
    const userId = await seedEmployee('prospective', '2026-01-01')
    const oldPolicy = await seedPolicy('pr-old-15', 15, 5)
    const newPolicy = await seedPolicy('pr-new-25', 25, 5)
    await seedMembership('pr', userId, oldPolicy, '2026-01-01')
    await service.refreshBalances(userId, '2026-11-05T12:00:00.000Z')
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(13.75)

    await service.transferEmployeePolicy({
      userId,
      policyId: newPolicy,
      effectiveDate: '2026-10-01',
      mode: 'prospective',
    })
    // Oct + Nov re-rated at 25/12: roundDays((15*9 + 25*2)/12) = 15.417.
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(15.417)
    const timeline = await service.getBalanceTimeline(userId, LeaveType.Vacation)
    const accruals = timeline.filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Accrual,
    )
    // January through November monthly rows are untouched history.
    expect(accruals).toHaveLength(11)
    expect(accruals.every((entry) => entry.deltaDays === 1.25)).toBe(true)
  })

  it('refuses the invalid shapes with precise messages', async () => {
    clock.setNow('2026-07-15T12:00:00.000Z')
    const userId = await seedEmployee('refusals', '2026-03-10')
    const oldPolicy = await seedPolicy('rf-old', 15, 5)
    const target = await seedPolicy('rf-new', 25, 5)
    const dying = await seedPolicy('rf-dying', 20, 5, {
      effectiveTo: '2026-12-31',
    })
    await seedMembership('rf', userId, oldPolicy, '2026-03-10')

    // Before the hire date (and thus before the permissible floor).
    const beforeHire = service.transferEmployeePolicy({
      userId,
      policyId: target,
      effectiveDate: '2026-02-01',
      mode: 'retroactive',
    })
    await expect(beforeHire).rejects.toThrow(PolicyTransferClosedPeriodError)
    await beforeHire.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PolicyTransferClosedPeriodError)
      expect(
        (error as PolicyTransferClosedPeriodError).earliestPermissibleDate,
      ).toBe('2026-03-10')
    })
    // A past date without a mode, and a future date with one.
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: target,
        effectiveDate: '2026-06-01',
      }),
    ).rejects.toThrow(/must state its mode/)
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: target,
        effectiveDate: '2026-09-01',
        mode: 'prospective',
      }),
    ).rejects.toThrow(/only to backdated/)
    // A dying policy takes no new members.
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: dying,
        effectiveDate: '2026-07-15',
      }),
    ).rejects.toThrow(/retired/)
    // Prospective cannot reach at or before the recorded membership start.
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: target,
        effectiveDate: '2026-03-10',
        mode: 'prospective',
      }),
    ).rejects.toThrow(/retroactive mode/)
    // Same policy is a no-op.
    await expect(
      service.transferEmployeePolicy({
        userId,
        policyId: oldPolicy,
        effectiveDate: '2026-07-15',
      }),
    ).rejects.toThrow(/already on the policy/)
    await expect(vacationAdjustments(userId)).resolves.toEqual([])
  })

  it('does not enroll new users when no default policy exists', async () => {
    const userId = await seedEmployee('no-default', '2026-01-01')
    expect(await membershipsOf(userId)).toHaveLength(0)
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2025 })
    expect(allocation?.sourcePolicyId ?? null).toBeNull()
  })
})

describe('test-tooling reset under the policy engine', () => {
  it('replays the balance from the recorded membership timeline', async () => {
    clock.setNow('2026-07-01T12:00:00.000Z')
    const userId = await seedEmployee('replay', '2026-01-01')
    const oldPolicy = await seedPolicy('rp-old-15', 15, 5)
    const newPolicy = await seedPolicy('rp-new-25', 25, 5)
    await seedMembership('rp', userId, oldPolicy, '2026-01-01')
    await service.transferEmployeePolicy({
      userId,
      policyId: newPolicy,
      effectiveDate: '2026-07-01',
    })
    clock.setNow('2026-12-15T12:00:00.000Z')
    await service.refreshBalances(userId, '2026-12-15T12:00:00.000Z')
    const before = await accruedOf(userId, LeaveType.Vacation, 2026)
    expect(before).toBe(20)

    await service.resetUserLeaveData({ userId })
    const kept = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    // The reset drops what the ledger justified and keeps the entitlement,
    // so the figure and the policy that explains it survive together.
    expect(kept?.totalDays).toBe(20)
    expect(kept?.sourcePolicyId).toBe(newPolicy)
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBeUndefined()

    await service.refreshBalances(userId, '2026-12-15T12:00:00.000Z')

    // Re-accrued from the SAME membership timeline, so the piecewise total
    // comes back exactly.
    expect(await accruedOf(userId, LeaveType.Vacation, 2026)).toBe(before)
    const replayed = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(replayed?.totalDays).toBe(20)
    expect(replayed?.sourcePolicyId).toBe(newPolicy)
    // The reset never touches membership history.
    expect(await membershipsOf(userId)).toHaveLength(2)
  })
})
