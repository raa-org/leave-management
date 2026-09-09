/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import { LeaveType } from '@workspace/contracts'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { LeaveDomainService } from './leave-domain.service'
import { NotificationService } from './notification.service'
import { LeavePolicyEntity } from './entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from './entities/leave-policy-membership.entity'
import { policyTermsFingerprint } from './policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// Stage 4: the probation gate. Days inside the governing policy's probation
// window are FORCED into the unpaid split — never rejected, never a blocker —
// and the preview mirrors the frozen request exactly.

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
      vacationAnnualIncrement: 0,
      vacationIncrementEveryYears: 1,
      vacationIncrementCapDays: null,
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
    createdAt: '2025-12-20T00:00:00.000Z',
  })
  return user.userId
}

const submit = (
  userId: string,
  leaveType: LeaveType,
  startDate: string,
  endDate: string,
  submittedAt: string,
) =>
  service.submitLeaveRequest({
    requesterUserId: userId,
    leaveType,
    startDate,
    endDate,
    approverEmails: ['probation-approver@example.com'],
    ccEmails: [],
    submittedAt,
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
  await seedHolidayCalendar(service, { year: 2026 })
  await service.upsertUser({
    userId: testUuid('user-probation-approver'),
    email: 'probation-approver@example.com',
    displayName: 'Approver',
    countryCode: 'UA',
    employmentStartDate: '2020-01-01',
    createdAt: T0,
  })
})

describe('probation gate', () => {
  it('forces the days before the window end unpaid and pays the rest from the balance', async () => {
    clock.setNow('2026-08-20T12:00:00.000Z')
    const policy = await seedPolicy('prob-3mo', 25, 5, { probationMonths: 3 })
    const userId = await seedEmployee('newbie', '2026-06-01')
    await seedMembership('nb', userId, policy, '2026-06-01')

    // Probation window [Jun 1, Sep 1): the August days are forced unpaid, the
    // September days go through the balance walk and are covered.
    const detail = await submit(
      userId,
      LeaveType.Vacation,
      '2026-08-25',
      '2026-09-04',
      '2026-08-20T12:00:00.000Z',
    )
    expect(detail.requestedDays).toBe(9)
    expect(detail.unpaidDates).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-31',
    ])
    expect(detail.paidDays).toBe(4)
    expect(detail.unpaidDays).toBe(5)
  })

  it('applies the paid-sick-during-probation flag per policy, vacation always forced', async () => {
    clock.setNow('2026-07-01T12:00:00.000Z')
    const strict = await seedPolicy('strict-sick', 25, 5, {
      probationMonths: 3,
    })
    const lenient = await seedPolicy('lenient-sick', 25, 5, {
      probationMonths: 3,
      paidSickDuringProbation: true,
    })
    const strictUser = await seedEmployee('strict-user', '2026-06-01')
    const lenientUser = await seedEmployee('lenient-user', '2026-06-01')
    await seedMembership('st', strictUser, strict, '2026-06-01')
    await seedMembership('le', lenientUser, lenient, '2026-06-01')

    const strictSick = await submit(
      strictUser,
      LeaveType.Sick,
      '2026-07-06',
      '2026-07-07',
      '2026-07-01T12:00:00.000Z',
    )
    expect(strictSick.unpaidDays).toBe(2)
    expect(strictSick.paidDays).toBe(0)

    const lenientSick = await submit(
      lenientUser,
      LeaveType.Sick,
      '2026-07-06',
      '2026-07-07',
      '2026-07-01T12:00:00.000Z',
    )
    expect(lenientSick.unpaidDays).toBe(0)
    expect(lenientSick.paidDays).toBe(2)

    // Vacation is forced regardless of the sick flag.
    const lenientVacation = await submit(
      lenientUser,
      LeaveType.Vacation,
      '2026-07-08',
      '2026-07-09',
      '2026-07-01T12:00:00.000Z',
    )
    expect(lenientVacation.unpaidDays).toBe(2)
  })

  it('does not re-probate a veteran whose window has long passed', async () => {
    clock.setNow('2026-07-15T12:00:00.000Z')
    const policy = await seedPolicy('vet-prob', 25, 5, { probationMonths: 3 })
    const userId = await seedEmployee('veteran', '2026-01-01')
    await seedMembership('vet', userId, policy, '2026-01-01')

    const detail = await submit(
      userId,
      LeaveType.Vacation,
      '2026-07-20',
      '2026-07-22',
      '2026-07-15T12:00:00.000Z',
    )
    expect(detail.unpaidDays).toBe(0)
    expect(detail.paidDays).toBe(3)
  })

  it('resolves the window per day across a scheduled transfer boundary', async () => {
    clock.setNow('2026-08-20T12:00:00.000Z')
    const probation = await seedPolicy('cross-prob', 25, 5, {
      probationMonths: 6,
    })
    const free = await seedPolicy('cross-free', 25, 5)
    const userId = await seedEmployee('crosser', '2026-06-01')
    await seedMembership('cr-old', userId, probation, '2026-06-01', '2026-09-01')
    await seedMembership('cr-new', userId, free, '2026-09-01')

    // The probation window would run to Dec 1, but the September days are
    // governed by the no-probation policy: only the August days are forced.
    const detail = await submit(
      userId,
      LeaveType.Vacation,
      '2026-08-28',
      '2026-09-03',
      '2026-08-20T12:00:00.000Z',
    )
    expect(detail.unpaidDates).toEqual(['2026-08-28', '2026-08-31'])
    expect(detail.paidDays).toBe(3)
  })

  it('previews exactly what submit freezes, with the probation sentence and end date', async () => {
    clock.setNow('2026-08-20T12:00:00.000Z')
    const policy = await seedPolicy('parity-prob', 25, 5, {
      probationMonths: 3,
    })
    const userId = await seedEmployee('parity', '2026-06-01')
    await seedMembership('pa', userId, policy, '2026-06-01')

    const preview = await service.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-25',
      endDate: '2026-09-04',
      asOfIso: '2026-08-20T12:00:00.000Z',
    })
    expect(preview.feasible).toBe(true)
    expect(preview.probationEnd).toBe('2026-09-01')
    expect(preview.unpaidNotice).toContain('probation')
    expect(preview.unpaidNotice).toContain('2026-09-01')

    const detail = await submit(
      userId,
      LeaveType.Vacation,
      '2026-08-25',
      '2026-09-04',
      '2026-08-20T12:00:00.000Z',
    )
    expect(detail.unpaidDates).toEqual(preview.unpaidDates)
    expect(detail.paidDays).toBe(preview.paidDays)
    expect(detail.unpaidDays).toBe(preview.unpaidDays)
  })

  it('reports the forced days as unpaid in the per-year rows too, not only in the header', async () => {
    clock.setNow('2026-12-01T12:00:00.000Z')
    await seedHolidayCalendar(service, { year: 2027 })
    const policy = await seedPolicy('year-end-prob', 25, 5, {
      probationMonths: 3,
    })
    const userId = await seedEmployee('year-ender', '2026-10-01')
    await seedMembership('ye', userId, policy, '2026-10-01')

    // A range that crosses BOTH boundaries at once: the probation window ends
    // with the year, so 2026 holds only forced days and 2027 only days the
    // balance walk judged.
    const preview = await service.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-12-28',
      endDate: '2027-01-05',
      asOfIso: '2026-12-01T12:00:00.000Z',
    })

    expect(preview.probationEnd).toBe('2027-01-01')
    const y2026 = preview.years.find((year) => year.year === 2026)
    const y2027 = preview.years.find((year) => year.year === 2027)
    // The 2026 row is built from the MERGED unpaid set. Built from the balance
    // walk's own list, as it once was, the forced days would be reported as
    // paid on this row while the header called them unpaid, and the year's
    // other commitments would be under-reported by the same amount.
    expect(y2026).toMatchObject({ requestedDays: 4, paidDays: 0, unpaidDays: 4 })
    expect(y2027?.requestedDays).toBe(3)

    // The rows and the header are one arithmetic, on one screen.
    const sum = (pick: (year: (typeof preview.years)[number]) => number) =>
      preview.years.reduce((total, year) => total + pick(year), 0)
    expect(sum((year) => year.requestedDays)).toBe(preview.requestedDays)
    expect(sum((year) => year.paidDays)).toBe(preview.paidDays)
    expect(sum((year) => year.unpaidDays)).toBe(preview.unpaidDays)
  })

  it('applies no probation to users outside the policy engine', async () => {
    clock.setNow('2026-07-15T12:00:00.000Z')
    const userId = await seedEmployee('legacy', '2026-06-01')
    const detail = await submit(
      userId,
      LeaveType.Vacation,
      '2026-07-20',
      '2026-07-21',
      '2026-07-15T12:00:00.000Z',
    )
    expect(detail.unpaidDays).toBe(0)
  })
})
