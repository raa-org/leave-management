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
import { BackfillLeavePolicies1785447000000 } from '../database/migrations/1785447000000-BackfillLeavePolicies'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'

// Stage 3: the cutover data migration. The acceptance contract: after minting
// and enrolling, the first accrual pass posts ZERO adjustment rows and no
// balance moves by a cent — the minted zero-increment policies resolve to
// exactly the stored totalDays, and the single-segment formula degenerates
// bit-identically.

let dataSource: DataSource
let service: LeaveDomainService

const T0 = '2026-01-01T00:00:00.000Z'
const SETTLE_AT = '2026-07-15T12:00:00.000Z'
const AFTER_CUTOVER = '2026-07-20T12:00:00.000Z'

const runMigration = async (): Promise<void> => {
  const runner = dataSource.createQueryRunner()
  try {
    await new BackfillLeavePolicies1785447000000().up(runner)
  } finally {
    await runner.release()
  }
}

const seedEmployee = async (slug: string): Promise<string> => {
  const user = await service.upsertUser({
    userId: testUuid(`user-${slug}`),
    email: `${slug}@example.com`,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate: '2026-01-01',
    createdAt: '2025-12-20T00:00:00.000Z',
  })
  return user.userId
}

const balancesOf = async (
  userId: string,
): Promise<Array<[LeaveType, number, number, number]>> => {
  const rows = await dataSource
    .getRepository(LeaveBalanceEntity)
    .find({ where: { userId, year: 2026 }, order: { leaveType: 'ASC' } })
  return rows.map((row) => [
    row.leaveType,
    row.accruedDays,
    row.onHoldDays,
    row.spentDays,
  ])
}

const adjustmentsOf = async (userId: string): Promise<number> => {
  const vacation = await service.getBalanceTimeline(userId, LeaveType.Vacation)
  const sick = await service.getBalanceTimeline(userId, LeaveType.Sick)
  return [...vacation, ...sick].filter(
    (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
  ).length
}

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

describe('BackfillLeavePolicies cutover migration', () => {
  it('mints, enrolls, stamps and scrubs without moving a single balance', async () => {
    // A lives on the settings defaults; B carries an admin override plus a
    // forward-booked 2027 row with the stale eager-carryover residue; C shares
    // B's tuple so the dedup must land them in ONE policy.
    const a = await seedEmployee('legacy-a')
    const b = await seedEmployee('override-b')
    const c = await seedEmployee('override-c')
    await service.refreshBalances(a, SETTLE_AT)
    for (const userId of [b, c]) {
      await service.setEmployeeAllocation({
        userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 10,
      })
    }
    await dataSource.getRepository(LeaveAllocationEntity).save({
      id: testUuid('forward-2027-b'),
      userId: b,
      year: 2027,
      leaveType: LeaveType.Vacation,
      totalDays: 10,
      carriedOverDays: 14.58,
      carryoverFinalized: false,
      closedAt: null,
      accrualStartDate: null,
      setByUserId: null,
      sourcePolicyId: null,
      note: null,
      createdAt: SETTLE_AT,
      updatedAt: SETTLE_AT,
    })
    const before = {
      a: await balancesOf(a),
      b: await balancesOf(b),
      c: await balancesOf(c),
    }
    // B and C legitimately carry one adjustment row from the override fixture
    // itself; the cutover contract is that the count does not GROW.
    const adjustmentsBefore = {
      a: await adjustmentsOf(a),
      b: await adjustmentsOf(b),
      c: await adjustmentsOf(c),
    }

    await runMigration()

    // The DEFAULT policy carries the settings terms, and its SQL-built
    // fingerprint is byte-equal to the TS canonicalizer's output.
    const policies = await dataSource.getRepository(LeavePolicyEntity).find()
    const defaultPolicy = policies.find((policy) => policy.isDefault)
    expect(defaultPolicy?.name).toBe('Default')
    expect(defaultPolicy?.vacationDays).toBe(25)
    expect(defaultPolicy?.sickDays).toBe(5)
    expect(defaultPolicy?.termsFingerprint).toBe(
      policyTermsFingerprint({
        vacationDays: 25,
        sickDays: 5,
        vacationAnnualIncrement: 0,
        vacationIncrementEveryYears: 1,
        vacationIncrementCapDays: null,
        probationMonths: 0,
        paidSickDuringProbation: false,
      }),
    )
    const migrated = policies.filter((policy) =>
      policy.name.startsWith('Migrated '),
    )
    expect(migrated.map((policy) => policy.name)).toEqual(['Migrated 10+5'])

    const membershipRepo = dataSource.getRepository(LeavePolicyMembershipEntity)
    const membershipOf = async (userId: string) =>
      membershipRepo.findOneBy({ userId })
    const aMembership = await membershipOf(a)
    expect(aMembership?.policyId).toBe(defaultPolicy?.id)
    expect(aMembership?.effectiveFrom).toBe('2026-01-01')
    expect(aMembership?.note).toBe('Engine cutover')
    const bMembership = await membershipOf(b)
    const cMembership = await membershipOf(c)
    expect(bMembership?.policyId).toBe(migrated[0]?.id)
    expect(cMembership?.policyId).toBe(migrated[0]?.id)

    const allocationRepo = dataSource.getRepository(LeaveAllocationEntity)
    const aVacation = await allocationRepo.findOneBy({
      userId: a,
      leaveType: LeaveType.Vacation,
      year: 2026,
    })
    expect(aVacation?.sourcePolicyId).toBe(defaultPolicy?.id)
    const forward = await allocationRepo.findOneBy({
      userId: b,
      year: 2027,
      leaveType: LeaveType.Vacation,
    })
    expect(forward?.carriedOverDays).toBe(0)
    expect(forward?.totalDays).toBe(10)
    expect(forward?.sourcePolicyId).toBe(migrated[0]?.id)

    // THE acceptance assertion: the first post-cutover read adjusts nothing.
    const expectedAdjustments = { a: adjustmentsBefore.a, b: adjustmentsBefore.b, c: adjustmentsBefore.c }
    for (const [key, userId] of [
      ['a', a],
      ['b', b],
      ['c', c],
    ] as const) {
      await service.refreshBalances(userId, AFTER_CUTOVER)
      expect(await adjustmentsOf(userId)).toBe(expectedAdjustments[key])
    }
    expect(await balancesOf(a)).toEqual(before.a)
    expect(await balancesOf(b)).toEqual(before.b)
    expect(await balancesOf(c)).toEqual(before.c)
  })

  it('is idempotent: a second run changes nothing', async () => {
    const a = await seedEmployee('idem-a')
    await service.refreshBalances(a, SETTLE_AT)
    await runMigration()
    const policiesAfterFirst = await dataSource
      .getRepository(LeavePolicyEntity)
      .count()
    const membershipsAfterFirst = await dataSource
      .getRepository(LeavePolicyMembershipEntity)
      .count()

    await runMigration()

    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(
      policiesAfterFirst,
    )
    expect(
      await dataSource.getRepository(LeavePolicyMembershipEntity).count(),
    ).toBe(membershipsAfterFirst)
  })
})
