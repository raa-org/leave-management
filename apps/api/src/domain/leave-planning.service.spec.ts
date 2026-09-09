/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  CarryoverCapMode,
  CarryoverPolicy,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveDomainService } from './leave-domain.service'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { NotificationService } from './notification.service'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'

// Calendar anchors used throughout: every range below starts on a Monday of
// 2026 and covers whole weeks, so "working days" is simply 5 per week and the
// arithmetic in each assertion stays readable.
const JUNE_WEEK = { startDate: '2026-06-01', endDate: '2026-06-05' } // 5 days
const AUGUST_FORTNIGHT = { startDate: '2026-08-03', endDate: '2026-08-14' } // 10
const AUGUST_WEEK = { startDate: '2026-08-03', endDate: '2026-08-07' } // 5
const AUGUST_WEEK_LATER = { startDate: '2026-08-10', endDate: '2026-08-14' } // 5
const SEPTEMBER_FORTNIGHT = { startDate: '2026-09-07', endDate: '2026-09-18' } // 10
const DECEMBER_FORTNIGHT = { startDate: '2026-12-07', endDate: '2026-12-18' } // 10
const NEXT_JANUARY_PAIR = { startDate: '2027-01-04', endDate: '2027-01-05' } // 2
const NEXT_JANUARY_WEEK = { startDate: '2027-01-04', endDate: '2027-01-08' } // 5
const NEXT_JANUARY_MONTH = { startDate: '2027-01-04', endDate: '2027-01-29' } // 20
// Across the New Year: Mon 12-28..Thu 12-31 = 4 working days in 2026, then
// Fri 01-01, Mon 01-04, Tue 01-05 = 3 in 2027 (the seeded calendars hold no
// holidays, so working days are simply weekdays).
const NEW_YEAR_SPAN = { startDate: '2026-12-28', endDate: '2027-01-05' } // 4+3

// Every anchor above was picked to sit in the FUTURE, because forward planning
// is what this file is about. Most calls here carry their own timestamp, but a
// few (removeLeaveRequestApprover is the one that bites) have no such parameter
// and read the wall clock instead — so once real time drifted past 3 August
// 2026 the suite started refusing changes to leave that had "already started".
//
// Pinning the clock rather than pushing the anchors forward is the fix that
// does not rot: a later date would simply move the deadline. The instant sits
// after the last submission and decision the fixtures stamp (2 April) and
// before the earliest leave they book (1 June), which is the relationship the
// assertions assume.
const NOW = '2026-04-15T12:00:00.000Z'

describe('LeaveDomainService forward planning', () => {
  let dataSource: DataSource
  let service: LeaveDomainService

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource?.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    // ClockService reads TEST_TOOLING_ENABLED once, at construction, and
    // refuses to be set when it is off — so the flag is on just long enough to
    // build a clock this spec can pin.
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    delete process.env['TEST_TOOLING_ENABLED']
    clock.setNow(NOW)
    service = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
  })

  // 24 vacation days a year = exactly 2 a month, so a projection is easy to
  // state: by the end of month M an employee has 2*M days.
  const settings = (
    overrides: {
      carryoverPolicy?: CarryoverPolicy
      carryoverCapDays?: number
      carryoverCapMode?: CarryoverCapMode
      carryoverCapPercent?: number
      defaultVacationDays?: number
    } = {},
  ) => ({
    defaultVacationDays: overrides.defaultVacationDays ?? 24,
    defaultSickDays: 12,
    defaultApproverEmails: [],
    defaultCcApproverEmails: [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    // Pinned rather than left undefined: the service default is the company
    // policy (capped at 50%), so a fixture that says nothing about carryover
    // means "no carryover" here.
    carryoverPolicy: overrides.carryoverPolicy ?? CarryoverPolicy.None,
    carryoverCapDays: overrides.carryoverCapDays ?? 0,
    carryoverCapMode: overrides.carryoverCapMode,
    carryoverCapPercent: overrides.carryoverCapPercent,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  const seedEmployee = async (
    options: {
      carryoverPolicy?: CarryoverPolicy
      carryoverCapMode?: CarryoverCapMode
      carryoverCapPercent?: number
      defaultVacationDays?: number
      approvers?: string[]
      years?: number[]
      employmentStartDate?: string
      // When the system met this user. Defaults to New Year 2026; a test that
      // needs an earlier year to be the system's OWN history (not the trivially
      // settled pre-provisioning kind) must date the meeting into it.
      createdAt?: string
    } = {},
  ) => {
    await service.updateLeaveSettings(
      settings(
        options.carryoverPolicy
          ? {
              carryoverPolicy: options.carryoverPolicy,
              carryoverCapMode: options.carryoverCapMode,
              carryoverCapPercent: options.carryoverCapPercent,
              defaultVacationDays: options.defaultVacationDays,
            }
          : { defaultVacationDays: options.defaultVacationDays },
      ),
    )
    for (const year of options.years ?? [2026]) {
      await seedHolidayCalendar(service, { year })
    }
    const user = await service.upsertUser({
      userId: testUuid('planner'),
      email: 'planner@example.com',
      displayName: 'Planner',
      countryCode: 'UA',
      employmentStartDate: options.employmentStartDate ?? '2026-01-01',
      createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
    })
    for (const email of options.approvers ?? ['lead@example.com']) {
      await service.upsertUser({
        userId: testUuid('appr-' + email),
        email,
        displayName: email,
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
    return user
  }

  const submit = (
    userId: string,
    period: { startDate: string; endDate: string },
    submittedAt: string,
    options: { leaveType?: LeaveType; approverEmails?: string[] } = {},
  ) =>
    service.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: options.leaveType ?? LeaveType.Vacation,
      ...period,
      approverEmails: options.approverEmails ?? ['lead@example.com'],
      ccEmails: [],
      submittedAt,
    })

  const decide = (
    requestId: string,
    email: string,
    action: LeaveApprovalAction,
    when: string,
  ) =>
    service.decideLeaveRequest({
      requestId,
      actorUserId: testUuid('appr-' + email),
      actorDisplayName: email,
      actorEmail: email,
      action,
      decidedAt: when,
    })

  const approve = async (
    requestId: string,
    emails: string[],
    when: string,
  ) => {
    let latest
    for (const email of emails) {
      latest = await decide(requestId, email, LeaveApprovalAction.Approve, when)
    }
    return latest!
  }

  const allocationFor = (userId: string, year: number) =>
    dataSource.getRepository(LeaveAllocationEntity).findOneBy({
      userId,
      leaveType: LeaveType.Vacation,
      year,
    })

  // ------------------------------------------------------------ projection ---

  it('accepts an August request submitted in March, when only March has accrued', async () => {
    const user = await seedEmployee()

    const request = await submit(
      user.userId,
      AUGUST_FORTNIGHT,
      '2026-03-02T09:00:00.000Z',
    )

    expect(request.status).toBe(LeaveRequestStatus.Pending)
    expect(request.requestedDays).toBe(10)
    const balance = await service.getBalance(user.userId, LeaveType.Vacation)
    // Six days accrued by March, ten held for August: the hold deliberately
    // runs ahead of accrual, which the old bookable floor made impossible.
    expect(balance).toMatchObject({ accruedDays: 6, onHoldDays: 10 })
  })

  it('funds what the year covers by then and takes the rest unpaid', async () => {
    const user = await seedEmployee()

    // Ten days in June against the twelve accrued by then would all be paid;
    // the same ten days in April run out after the eight April will have.
    const request = await submit(
      user.userId,
      { startDate: '2026-04-06', endDate: '2026-04-17' },
      '2026-03-02T09:00:00.000Z',
    )

    expect(request).toMatchObject({
      status: LeaveRequestStatus.Pending,
      requestedDays: 10,
      paidDays: 8,
      unpaidDays: 2,
    })
    expect(request.unpaidDates).toEqual(['2026-04-16', '2026-04-17'])
    // Only the paid days are held; the unpaid ones never touch the balance.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 8 })
  })

  it('judges each day cumulatively against everything already booked', async () => {
    const user = await seedEmployee()
    const inMarch = '2026-03-02T09:00:00.000Z'

    // December first: ten days, comfortably inside the full annual 24.
    await submit(user.userId, DECEMBER_FORTNIGHT, inMarch)
    // June next: five days by June (12 accrued) and fifteen by December (24).
    const june = await submit(user.userId, JUNE_WEEK, inMarch)
    expect(june).toMatchObject({ paidDays: 5, unpaidDays: 0 })

    // Ten more in August would stand at 25 days by year end against 24, so the
    // twenty-fifth is the one that goes unpaid.
    const august = await submit(user.userId, AUGUST_FORTNIGHT, inMarch)
    expect(august).toMatchObject({ paidDays: 9, unpaidDays: 1 })
    expect(august.unpaidDates).toEqual(['2026-08-14'])
  })

  it('leaves an already booked leave funded exactly as it was submitted', async () => {
    const user = await seedEmployee()
    const inMarch = '2026-03-02T09:00:00.000Z'

    // June is submitted first and takes the days it needs. August, submitted
    // second, is the one that pays for the shortfall even though its dates
    // come later: whoever booked first keeps their funding.
    const june = await submit(user.userId, JUNE_WEEK, inMarch)
    await submit(user.userId, DECEMBER_FORTNIGHT, inMarch)
    await submit(user.userId, AUGUST_FORTNIGHT, inMarch)

    const refetched = await service.getLeaveRequestDetail(june.requestId)
    expect(refetched).toMatchObject({ paidDays: 5, unpaidDays: 0 })
  })

  it('credits sick leave up front, so a future sick request is bookable from month one', async () => {
    const user = await seedEmployee()

    const request = await submit(
      user.userId,
      { startDate: '2026-11-02', endDate: '2026-11-06' },
      '2026-02-02T09:00:00.000Z',
      { leaveType: LeaveType.Sick },
    )

    expect(request.status).toBe(LeaveRequestStatus.Pending)
  })

  it('lets accrual heal a balance whose holds run ahead of it', async () => {
    const user = await seedEmployee()
    await submit(user.userId, AUGUST_FORTNIGHT, '2026-03-02T09:00:00.000Z')

    // The monthly accrual entry must still post while accrued - held is
    // negative; the old ledger invariant would have thrown here.
    await service.refreshBalances(user.userId, '2026-09-01T09:00:00.000Z')

    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ accruedDays: 18, onHoldDays: 10 })
  })

  // ------------------------------------------------------- planning horizon ---

  it('books into next year and materializes its allocation without a carryover', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })

    const request = await submit(
      user.userId,
      NEXT_JANUARY_PAIR,
      '2026-11-02T09:00:00.000Z',
    )

    expect(request.status).toBe(LeaveRequestStatus.Pending)
    const nextYear = await allocationFor(user.userId, 2027)
    // Created early so the hold has somewhere to live, but its carryover is
    // not knowable while 2026 is still running.
    expect(nextYear).toMatchObject({
      totalDays: 24,
      carriedOverDays: 0,
      carryoverFinalized: false,
    })
    // This year's balance is untouched: the hold belongs to 2027.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0 })
  })

  it('pays next-January leave only as far as next January will have accrued', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })

    // With no carryover, January of any year funds two days, no matter how
    // much is left over in December.
    const request = await submit(
      user.userId,
      NEXT_JANUARY_WEEK,
      '2026-11-02T09:00:00.000Z',
    )

    expect(request).toMatchObject({ paidDays: 2, unpaidDays: 3 })
    expect(request.unpaidDates).toEqual([
      '2027-01-06',
      '2027-01-07',
      '2027-01-08',
    ])
  })

  it('refuses to plan beyond the end of next year', async () => {
    const user = await seedEmployee({ years: [2026, 2027, 2028] })

    await expect(
      submit(
        user.userId,
        { startDate: '2028-01-03', endDate: '2028-01-07' },
        '2026-11-02T09:00:00.000Z',
      ),
    ).rejects.toThrow(/only be planned up to the end of 2027/)
  })

  // ------------------------------------------------------------- carryover ---

  it('funds next-year leave from the carryover this year is projected to leave', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    const inNovember = '2026-11-02T09:00:00.000Z'

    // Twenty days next January only fit because all 24 of this year's days
    // are projected to roll over.
    const january = await submit(user.userId, NEXT_JANUARY_MONTH, inNovember)
    expect(january.status).toBe(LeaveRequestStatus.Pending)

    // Ten days this December would leave only 14 to roll over, which no longer
    // covers the January leave already booked against it. December pays for
    // that itself: six days it can still spare, four unpaid. January keeps
    // every day it was funded with.
    const december = await submit(user.userId, DECEMBER_FORTNIGHT, inNovember)
    expect(december).toMatchObject({ paidDays: 6, unpaidDays: 4 })
    expect(
      await service.getLeaveRequestDetail(january.requestId),
    ).toMatchObject({ paidDays: 20, unpaidDays: 0 })
  })

  it('funds next-year leave from the floored percent carryover', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })

    // Half of this year's 24 days roll over, so next January can pay for 12
    // carried days plus the 2 it accrues itself. The rest goes unpaid.
    const january = await submit(
      user.userId,
      NEXT_JANUARY_MONTH,
      '2026-11-02T09:00:00.000Z',
    )
    expect(january).toMatchObject({ paidDays: 14, unpaidDays: 6 })

    // Once the year actually turns, the books land exactly where the forecast
    // promised: the projection and the close read the same cap.
    await service.refreshBalances(user.userId, '2027-01-05T09:00:00.000Z')
    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 12,
      carryoverFinalized: true,
    })
  })

  it('funds next-year leave from the prorated allowance-percent ceiling', async () => {
    // Hired in April, so 2026 accrues 9/12 of the 24-day allowance = 18 days
    // and takes none. The ceiling is a share of what the shortened year could
    // EARN (floor(18 / 2) = 9), never of the whole 24-day norm — so January
    // pays for 9 carried days plus the 2 it accrues itself.
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 50,
      employmentStartDate: '2026-04-01',
    })

    const january = await submit(
      user.userId,
      NEXT_JANUARY_MONTH,
      '2026-11-02T09:00:00.000Z',
    )
    expect(january).toMatchObject({ paidDays: 11, unpaidDays: 9 })

    // The books then land exactly where the forecast promised. This is the
    // invariant the shared applyCarryoverPolicy exists for: the projection and
    // the close must read the same ceiling off the same prorated base.
    await service.refreshBalances(user.userId, '2027-01-05T09:00:00.000Z')
    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 9,
      carryoverFinalized: true,
    })
  })

  it('carries a fractional leftover whole when it sits under the prorated ceiling', async () => {
    // A ceiling, not a grant — and what floors is the CEILING, never the
    // result. Hired in April on 25 days: 18.75 accrue, the ceiling is
    // floor(18.75 / 2) = 9, and ten approved December days leave 8.75. That
    // sits under the ceiling, so the lot moves, quarter day included, exactly
    // as Days and Full would have carried it.
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 50,
      defaultVacationDays: 25,
      employmentStartDate: '2026-04-01',
    })

    const december = await submit(
      user.userId,
      DECEMBER_FORTNIGHT,
      '2026-11-02T09:00:00.000Z',
    )
    expect(december).toMatchObject({ paidDays: 10, unpaidDays: 0 })
    await approve(
      december.requestId,
      ['lead@example.com'],
      '2026-11-03T09:00:00.000Z',
    )

    await service.refreshBalances(user.userId, '2027-01-05T09:00:00.000Z')
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 8.75],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 8.75],
    ])
    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 8.75,
      carryoverFinalized: true,
    })
  })

  it('percent policy still burns the whole sick tranche', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })
    await service.refreshBalances(user.userId, '2027-01-05T09:00:00.000Z')

    // The per-type gate outranks the cap: sick carries nothing under any
    // policy, while vacation on the same account carries its half.
    expect(await closeRowsFor(user.userId, LeaveType.Sick)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 12],
    ])
    expect(
      (await closeRowsFor(user.userId, LeaveType.Vacation)).map(
        ([reason]) => reason,
      ),
    ).toEqual([
      LeaveBalanceChangeReason.CarryoverOut,
      LeaveBalanceChangeReason.Expired,
      LeaveBalanceChangeReason.CarryoverIn,
    ])
  })

  it('settles a pre-created allocation carryover once the year begins', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    await submit(user.userId, NEXT_JANUARY_PAIR, '2026-11-02T09:00:00.000Z')

    // Nobody logged in over the new year, so 2026 stopped accruing in
    // November. The first refresh of 2027 must still carry over the FULL
    // year: it tops 2026 up to twelve months before reading its leftover.
    await service.refreshBalances(user.userId, '2027-01-05T09:00:00.000Z')

    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 24,
      carryoverFinalized: true,
    })
    const balance2027 = await dataSource
      .getRepository('leave_balances')
      .findOneBy({ userId: user.userId, leaveType: LeaveType.Vacation, year: 2027 })
    // Two accrued for January plus the 24 rolled over.
    expect(Number(balance2027?.['accruedDays'])).toBe(26)
  })

  // ------------------------------------------------------- New Year spans ---

  it('funds each side of a New Year span from its own year', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // Policy None: nothing rolls over, so 2027 has accrued exactly 2 days by
    // 5 January. The four December days ride 2026's plentiful balance; two of
    // the three January days fit 2027's, the third goes unpaid.
    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
    )
    expect(request).toMatchObject({
      requestedDays: 7,
      paidDays: 6,
      unpaidDays: 1,
    })
    expect(
      (await service.getLeaveRequestDetail(request.requestId)).unpaidDates,
    ).toEqual(['2027-01-05'])

    // One hold per year, each dated to its year's first paid day and sized to
    // its own share: 4 on 2026, 2 on 2027.
    const holds = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    )
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Hold)
      .map((entry) => [entry.effectiveDate, entry.deltaDays])
    expect(holds).toEqual([
      ['2026-12-28', 4],
      ['2027-01-01', 2],
    ])
  })

  it('lets carryover fund the January side of a span, December days first', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    const inNovember = '2026-11-02T09:00:00.000Z'
    // Twenty-two working days booked right after the span (Jan 6 → Feb 4):
    // funded by the 24 days 2026 is projected to leave behind plus early-2027
    // accrual.
    await submit(
      user.userId,
      { startDate: '2027-01-06', endDate: '2027-02-04' },
      inNovember,
    )

    // The span's four December days shrink that projected carryover 24 → 20.
    // With the booking's 22 days standing, the January side now fits only two
    // more (20 carried + 4 accrued by early February = 24): Jan 1 and Jan 4
    // stay paid, Jan 5 goes unpaid — while every December day stays paid. The
    // carryover feedback runs THROUGH the candidate itself, day by day in date
    // order.
    const span = await submit(user.userId, NEW_YEAR_SPAN, inNovember)
    expect(span).toMatchObject({ paidDays: 6, unpaidDays: 1 })
    expect(
      (await service.getLeaveRequestDetail(span.requestId)).unpaidDates,
    ).toEqual(['2027-01-05'])
  })

  it('spends each day of a span into the year it falls in', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-11-03T09:00:00.000Z',
    )

    // Live through the whole span: the December days spend 2026, the January
    // days spend 2027 — each Spent row's own date proves which year it hit,
    // and the paid January days follow their holds into the new year.
    await service.refreshBalances(user.userId, '2027-02-01T09:00:00.000Z')
    const spends = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    )
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Spent)
      .map((entry) => entry.effectiveDate)
    expect(spends).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-04',
    ])
  })

  it('closes the year between the days it ends and the days it begins', async () => {
    // Full carryover, so the close books the whole double entry: days leaving
    // 2026 and the same days arriving in 2027.
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-11-03T09:00:00.000Z',
    )

    // One refresh covering the whole span AND the year close. Insertion order
    // is what the timeline shows, so the close has to sit exactly where it
    // happened: after the last December day was taken, before the first
    // January one — which also means the January days are funded by a
    // carryover that already arrived, never spent against an empty new year.
    await service.refreshBalances(user.userId, '2027-02-01T09:00:00.000Z')

    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    const boundary = timeline
      .filter(
        (entry) =>
          entry.reason !== LeaveBalanceChangeReason.Accrual &&
          entry.reason !== LeaveBalanceChangeReason.Hold,
      )
      .map((entry) => [entry.reason, entry.effectiveDate])
    expect(boundary).toEqual([
      [LeaveBalanceChangeReason.Spent, '2026-12-28'],
      [LeaveBalanceChangeReason.Spent, '2026-12-29'],
      [LeaveBalanceChangeReason.Spent, '2026-12-30'],
      [LeaveBalanceChangeReason.Spent, '2026-12-31'],
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31'],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01'],
      [LeaveBalanceChangeReason.Spent, '2027-01-01'],
      [LeaveBalanceChangeReason.Spent, '2027-01-04'],
      [LeaveBalanceChangeReason.Spent, '2027-01-05'],
    ])

    // No row was ever filed against a balance it had not been given: every
    // frozen snapshot on the way through is a figure that really stood.
    for (const entry of timeline) {
      expect(entry.availableDays).toBeGreaterThanOrEqual(0)
    }
  })

  it('releases a cancelled span back into both years', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-11-03T09:00:00.000Z',
    )
    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: user.userId,
      actorDisplayName: 'Planner',
      occurredAt: '2026-11-10T09:00:00.000Z',
    })

    // One release per year holding anything: 4 back to 2026, 2 back to 2027.
    const releases = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    )
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Release)
      .map((entry) => entry.deltaDays)
    expect(releases.sort()).toEqual([2, 4])
  })

  it('blocks a span while the far year has no holiday calendar', async () => {
    // Only 2026 is configured. The submit refusal and the preview blocker both
    // name the missing year and ask for an administrator.
    const user = await seedEmployee({ years: [2026] })
    await expect(
      submit(user.userId, NEW_YEAR_SPAN, '2026-11-02T09:00:00.000Z'),
    ).rejects.toThrow(/No holiday calendar is configured for UA 2027/)

    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...NEW_YEAR_SPAN,
      asOfIso: '2026-11-02T09:00:00.000Z',
    })
    expect(preview.feasible).toBe(false)
    expect(preview.blockers).toEqual([
      {
        code: 'holiday_calendar_missing',
        message:
          'No holiday calendar is configured for UA 2027. Please contact an administrator.',
      },
    ])
  })

  it('previews a span with an outlook covering both touched years', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...NEW_YEAR_SPAN,
      asOfIso: '2026-11-02T09:00:00.000Z',
    })

    expect(preview.feasible).toBe(true)
    expect(preview).toMatchObject({
      requestedDays: 7,
      paidDays: 6,
      unpaidDays: 1,
    })
    // Every outlook row is stamped with its year, and both years are present:
    // (year, month) is what identifies January of 2027 vs January of 2026.
    const years = new Set(preview.monthlyOutlook.map((row) => row.year))
    expect(years).toEqual(new Set([2026, 2027]))
    expect(
      preview.monthlyOutlook.some(
        (row) => row.year === 2027 && row.month === 1,
      ),
    ).toBe(true)
    // The January side leans on projected carryover, which now rides on the
    // per-year block: this year's carryover out is the next year's opening
    // (policy None: zero).
    expect(preview.years[0]?.carryoverOutDays).toBe(0)
    expect(preview.years[1]?.carriedOverDays).toBe(0)
  })

  // ----- per-year projections ---

  it('projects both horizon years even when the range stays inside one', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...AUGUST_WEEK,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    expect(preview.currentYear).toBe(2026)
    expect(preview.years.map((year) => year.year)).toEqual([2026, 2027])
    // 6 accrued by March, 16 by the leave in August, 24 by year end; the five
    // requested days leave 19 to carry under a Full policy.
    expect(preview.years[0]).toMatchObject({
      year: 2026,
      accruedDays: 6,
      projectedAccruedByLeave: 16,
      lastLeaveDay: '2026-08-07',
      projectedYearEndAccrual: 24,
      committedDays: 0,
      requestedDays: 5,
      paidDays: 5,
      unpaidDays: 0,
      carryoverProjected: false,
      carryoverOutDays: 19,
    })
    // The year the request never touches is projected all the same, and its
    // "by the leave" figure falls back to the year end: this is what lets the
    // composer show where next year's opening balance comes from.
    expect(preview.years[1]).toMatchObject({
      year: 2027,
      carriedOverDays: 19,
      carryoverProjected: true,
      accruedDays: 0,
      requestedDays: 0,
      projectedYearEndAccrual: 43,
      projectedAccruedByLeave: 43,
    })
    expect(preview.years[1]?.lastLeaveDay).toBeUndefined()
  })

  it('splits a New Year span across the two years it charges', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...NEW_YEAR_SPAN,
      asOfIso: '2026-11-02T09:00:00.000Z',
    })

    expect(preview.years[0]).toMatchObject({
      year: 2026,
      requestedDays: 4,
      paidDays: 4,
      unpaidDays: 0,
      lastLeaveDay: '2026-12-31',
      carryoverOutDays: 0,
    })
    expect(preview.years[1]).toMatchObject({
      year: 2027,
      requestedDays: 3,
      paidDays: 2,
      unpaidDays: 1,
      lastLeaveDay: '2027-01-05',
      carriedOverDays: 0,
    })
    // The per-year split is the aggregate, redistributed: nothing invented and
    // nothing lost between the two.
    expect(
      preview.years.reduce((sum, year) => sum + year.requestedDays, 0),
    ).toBe(preview.requestedDays)
    for (const year of preview.years) {
      expect(year.paidDays + year.unpaidDays).toBe(year.requestedDays)
    }
    // What this year hands over is what the next one opens on: one figure,
    // reported from both sides.
    expect(preview.years[1]?.carriedOverDays).toBe(
      preview.years[0]?.carryoverOutDays,
    )
  })

  it('keeps this year in a next-year preview, with the carryover it hands over', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...NEXT_JANUARY_WEEK,
      asOfIso: '2026-11-02T09:00:00.000Z',
    })

    // This year takes none of the leave, yet it is the year that funds half of
    // it: 24 untouched days, half of them carried.
    expect(preview.years[0]).toMatchObject({
      year: 2026,
      requestedDays: 0,
      projectedAccruedByLeave: 24,
      projectedYearEndAccrual: 24,
      carryoverOutDays: 12,
    })
    // 12 carried in, plus January's own tranche by the 8th.
    expect(preview.years[1]).toMatchObject({
      year: 2027,
      carriedOverDays: 12,
      carryoverProjected: true,
      projectedAccruedByLeave: 14,
      requestedDays: 5,
      paidDays: 5,
      unpaidDays: 0,
    })
  })

  it('counts the composed request once, never as a commitment of its own', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    await submit(user.userId, AUGUST_WEEK, '2026-03-02T09:00:00.000Z')
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...AUGUST_WEEK_LATER,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    const thisYear = preview.years[0]
    // The pending August request, and only it: the five days being composed
    // are reported as requestedDays, not folded in here as well.
    expect(thisYear).toMatchObject({
      year: 2026,
      committedDays: 5,
      requestedDays: 5,
      paidDays: 5,
    })
    // The identity the composer draws its year-end rows from. It is asserted
    // rather than the bare 14 so a change to what the fold folds in breaks a
    // test instead of quietly double-charging the request in the UI.
    const leftover =
      (thisYear?.projectedYearEndAccrual ?? 0) -
      (thisYear?.spentDays ?? 0) -
      (thisYear?.committedDays ?? 0) -
      (thisYear?.paidDays ?? 0)
    expect(leftover).toBe(14)
    expect(thisYear?.carryoverOutDays).toBe(14)
  })

  it('never carries sick leave out of a year, whatever the policy', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Sick,
      ...AUGUST_WEEK,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    // The tranche is granted up front, so the year has real headroom: the zero
    // below is the per-type gate, not an empty balance.
    expect(preview.years[0]).toMatchObject({
      year: 2026,
      accruedDays: 12,
      projectedYearEndAccrual: 12,
      carryoverOutDays: 0,
    })
    expect(preview.years[1]).toMatchObject({
      year: 2027,
      carriedOverDays: 0,
      carryoverOutDays: 0,
    })
  })

  it('still reports both years when a blocker stops the range', async () => {
    // No 2027 calendar, so the span cannot be priced at all.
    const user = await seedEmployee({ years: [2026] })
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...NEW_YEAR_SPAN,
      asOfIso: '2026-11-02T09:00:00.000Z',
    })

    expect(preview.feasible).toBe(false)
    expect(preview.blockers.map((blocker) => blocker.code)).toContain(
      'holiday_calendar_missing',
    )
    // A range that cannot be booked still has a balance story to tell.
    expect(preview.years.map((year) => year.year)).toEqual([2026, 2027])
    expect(preview.years.every((year) => year.requestedDays === 0)).toBe(true)
    expect(preview.years[0]?.projectedYearEndAccrual).toBe(24)
  })

  it('caps a span by the horizon of its END date', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // Starts inside the horizon (2027) but runs into 2028: refused by its far
    // end, exactly as the server-side guard words it.
    await expect(
      submit(
        user.userId,
        { startDate: '2027-12-27', endDate: '2028-01-03' },
        '2026-11-02T09:00:00.000Z',
      ),
    ).rejects.toThrow(/planned up to the end of 2027/)
  })

  it('excludes each year\'s own holidays from a span', async () => {
    await service.updateLeaveSettings(settings())
    await seedHolidayCalendar(service, { year: 2026 })
    // 1 January is a holiday in the 2027 calendar: the span loses that day —
    // 4 in December + 2 in January.
    await seedHolidayCalendar(service, {
      year: 2027,
      holidays: [{ date: '2027-01-01', name: 'New Year' }],
    })
    const user = await service.upsertUser({
      userId: testUuid('planner'),
      email: 'planner@example.com',
      displayName: 'Planner',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('appr-lead@example.com'),
      email: 'lead@example.com',
      displayName: 'lead@example.com',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
    )
    expect(request.requestedDays).toBe(6)
  })

  it('pairs a same-days modification across the boundary without double-charging', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // A December-only booking, approved, then proposed to stretch across the
    // boundary. While the replacement waits, December must be charged once —
    // the pair's worst case per year — not once per member.
    const original = await submit(
      user.userId,
      { startDate: '2026-12-28', endDate: '2026-12-31' },
      '2026-11-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-11-03T09:00:00.000Z',
    )
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...NEW_YEAR_SPAN,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-11-10T09:00:00.000Z',
    })

    // Both members hold their own days (original 4 in 2026; replacement 4+2),
    // but the projection charges December once: a third booking that fits
    // December's remaining 16 days (24 accrued - 4 committed - 4 span) still
    // sees 16, not 12.
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-12-01',
      endDate: '2026-12-04',
      asOfIso: '2026-11-12T09:00:00.000Z',
    })
    expect(preview.feasible).toBe(true)
    expect(preview).toMatchObject({ paidDays: 4, unpaidDays: 0 })

    // Approving the replacement releases the original's December-only hold
    // and leaves the span's per-year holds standing.
    await approve(
      replacement.requestId,
      ['lead@example.com'],
      '2026-11-15T09:00:00.000Z',
    )
    expect(
      await service.getLeaveRequestDetail(original.requestId),
    ).toMatchObject({ status: LeaveRequestStatus.Superseded })
  })

  // ------------------------------------------------------------ year close ---

  const closeRowsFor = async (userId: string, leaveType: LeaveType) =>
    (await service.getBalanceTimeline(userId, leaveType))
      .filter((entry) =>
        [
          LeaveBalanceChangeReason.CarryoverOut,
          LeaveBalanceChangeReason.Expired,
          LeaveBalanceChangeReason.CarryoverIn,
        ].includes(entry.reason),
      )
      .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays])

  it('books the year close as double entry: out of the old year, into the new', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    await service.refreshBalances(user.userId, '2026-12-15T09:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    // Full policy, nothing taken: all 24 leave 2026 and arrive in 2027 —
    // nothing burns. Out is dated to the day it settles (Dec 31), in to the
    // day it lands (Jan 1).
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 24],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 24],
    ])
    // No double count: 2027's accrual rows carry only its own monthly tranche,
    // even though the accrual target includes the carryover.
    const accruals2027 = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter(
      (entry) =>
        entry.reason === LeaveBalanceChangeReason.Accrual &&
        entry.effectiveDate.startsWith('2027'),
    )
    expect(accruals2027.map((entry) => entry.deltaDays)).toEqual([2])
  })

  it('burns the whole leftover under the None policy, sick tranche included', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    await service.refreshBalances(user.userId, '2026-12-15T09:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    // Vacation: 24 accrued, none taken, policy None — all of it expires, and
    // the burn is a ledger row anyone can read, not a silent reset.
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 24],
    ])
    // Sick: the untouched 12-day tranche expires the same way.
    expect(await closeRowsFor(user.userId, LeaveType.Sick)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 12],
    ])
  })

  it('never carries sick leave, whatever the policy says', async () => {
    // Sick is re-granted in full every January; carrying its leftover on top
    // would compound the allowance year over year. The vacation side of the
    // same account carries in full, proving the gate is per type, not global.
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    expect(await closeRowsFor(user.userId, LeaveType.Sick)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 12],
    ])
    expect(
      (await closeRowsFor(user.userId, LeaveType.Vacation)).map(
        (row) => row[0],
      ),
    ).toEqual([
      LeaveBalanceChangeReason.CarryoverOut,
      LeaveBalanceChangeReason.CarryoverIn,
    ])
  })

  it('closes a dormant account correctly on its first-ever touch of the new year', async () => {
    // Nobody pre-created the 2027 allocation (no next-year booking) and nobody
    // logged in over the boundary. The single January refresh must both top
    // 2026 up to twelve months AND settle its carryover — the old code let
    // ensureAllocation finalize from the under-accrued November figure.
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    await service.refreshBalances(user.userId, '2026-11-10T09:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 24,
      carryoverFinalized: true,
    })
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 24],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 24],
    ])
  })

  it('settles a year that ended before the system met the user trivially', async () => {
    // Hired 1 December but entered into the system on 5 January: the system
    // never lived through 2026 and does not reconstruct it — no December
    // accrual, no expiry, no carryover. Its memory of a user starts the year
    // the account was created; whatever remained of an earlier year is the
    // history import's (or an admin adjustment's) to bring, never the
    // engine's to fabricate.
    await service.updateLeaveSettings(settings())
    await seedHolidayCalendar(service, { year: 2026 })
    await seedHolidayCalendar(service, { year: 2027 })
    const user = await service.upsertUser({
      userId: testUuid('planner'),
      email: 'planner@example.com',
      displayName: 'Planner',
      countryCode: 'UA',
      employmentStartDate: '2026-12-01',
      createdAt: '2027-01-05T09:00:00.000Z',
    })

    const vacationRows = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays])
    // 2027 accrues normally from January (the anchor predates the year, so it
    // is a plain full year) — and that is where the books BEGIN.
    expect(vacationRows).toEqual(
      expect.arrayContaining([
        [LeaveBalanceChangeReason.Accrual, '2027-01-01', 2],
      ]),
    )
    const sickRows = (
      await service.getBalanceTimeline(user.userId, LeaveType.Sick)
    ).map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays])
    for (const [reason, effectiveDate] of [...vacationRows, ...sickRows]) {
      expect(String(effectiveDate) >= '2027-01-01').toBe(true)
      expect(reason).not.toBe(LeaveBalanceChangeReason.CarryoverIn)
    }
  })

  it('closes a skipped calendar year with real books, not a silent freeze', async () => {
    // Active in 2026, untouched through ALL of 2027, first read in 2028. The
    // 2027 allocation never existed; the close must materialize it, accrue its
    // full year, and settle both boundaries — not mistake the gap for a closed
    // year and freeze it at zero.
    const user = await seedEmployee({
      years: [2026, 2027, 2028],
      employmentStartDate: '2026-01-01',
    })
    await service.refreshBalances(user.userId, '2026-06-15T09:00:00.000Z')
    await service.refreshBalances(user.userId, '2028-06-15T09:00:00.000Z')

    const rows = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    const accruedIn = (year: string) =>
      rows
        .filter(
          (entry) =>
            entry.reason === LeaveBalanceChangeReason.Accrual &&
            entry.effectiveDate.startsWith(year),
        )
        .reduce((sum, entry) => sum + entry.deltaDays, 0)
    // The slept-through year accrued its whole allowance during the close…
    expect(accruedIn('2027')).toBeCloseTo(24)
    // …and both boundaries expired their leftovers visibly (policy None).
    expect(
      rows
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Expired)
        .map((entry) => [entry.effectiveDate, entry.deltaDays]),
    ).toEqual([
      ['2026-12-31', 24],
      ['2027-12-31', 24],
    ])
  })

  it('leaves a closed year closed: nothing re-accrues into it', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')
    const rowCount = async () =>
      (await service.getBalanceTimeline(user.userId, LeaveType.Vacation)).length

    // The close reduced 2026's accrued below its cumulative target. A second
    // refresh — and the accrual it drives for the current year — must not
    // "heal" the closed year back.
    const before = await rowCount()
    await service.refreshBalances(user.userId, '2027-01-11T09:00:00.000Z')
    expect(await rowCount()).toBe(before)
  })

  it('funds a backdated request into a closed year only with what truly remained', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // Live through the boundary: policy None, so all 24 of 2026 burnt.
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    // Booking last December retroactively: the days are gone — burnt — so the
    // request is accepted but unpaid. Before the close reduced the balance,
    // these days would have been judged against the untouched 24 and come out
    // paid, the same days that a Full policy would simultaneously be funding
    // January with: the double-spend this kills.
    const backdated = await submit(
      user.userId,
      DECEMBER_FORTNIGHT,
      '2027-01-12T09:00:00.000Z',
    )
    expect(backdated).toMatchObject({ paidDays: 0, unpaidDays: 10 })
  })

  it('excludes held days from the close and releases them back into the closed year', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // Five December days pending at the boundary: they are neither carried nor
    // burnt — their request is still someone's to decide.
    const pending = await submit(
      user.userId,
      { startDate: '2026-12-21', endDate: '2026-12-25' },
      '2026-12-01T09:00:00.000Z',
    )
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    // 24 accrued − 5 held = 19 expire; the 5 stay on hold.
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 19],
    ])

    // Rejection after the close returns the 5 into the CLOSED year — bookable
    // only by backdated leave, never carried. No new close rows appear.
    await decide(
      pending.requestId,
      'lead@example.com',
      LeaveApprovalAction.Reject,
      '2027-01-12T09:00:00.000Z',
    )
    expect(await closeRowsFor(user.userId, LeaveType.Vacation)).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 19],
    ])
    const releases = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Release)
    expect(releases.map((entry) => entry.deltaDays)).toEqual([5])
  })

  it('closes a skipped year chain oldest first', async () => {
    const user = await seedEmployee({
      years: [2026, 2027, 2028],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    // Booking into 2027 during 2026 materializes the 2027 allocation early…
    await submit(user.userId, NEXT_JANUARY_PAIR, '2026-11-02T09:00:00.000Z')
    // …and the account then sleeps until 2028: both 2026→2027 and 2027→2028
    // must settle, oldest first, each carry feeding the next.
    await service.refreshBalances(user.userId, '2028-01-10T09:00:00.000Z')

    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carryoverFinalized: true,
    })
    const allocation2028 = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId: user.userId, leaveType: LeaveType.Vacation, year: 2028 })
    expect(allocation2028).toMatchObject({ carryoverFinalized: true })
    // 2026 leaves 24; 2027 accrues its own 24 on top and spends 2 (the January
    // pair), so 46 roll into 2028.
    expect(Number(allocation2028?.carriedOverDays)).toBeCloseTo(46)
  })

  it('ships the year-close rows to the admin detail, requests or none', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    await service.refreshBalances(user.userId, '2027-01-10T09:00:00.000Z')

    // No leave requests exist, so the folded per-request timelines would be
    // empty — the shipped ledger is the only surface that can carry the close.
    const detail = await service.getAdminEmployeeDetail(user.userId)
    expect(detail.requestHistory).toHaveLength(0)
    expect(
      detail.balanceTimeline.filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.Expired,
      ).length,
    ).toBeGreaterThanOrEqual(2) // vacation and sick both burnt
  })

  // ---------------------------------------------------------- cancellation ---

  it('cancels an approved leave that has not started and returns the days', async () => {
    const user = await seedEmployee()
    const request = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    const cancelled = await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: user.userId,
      actorDisplayName: user.displayName,
      occurredAt: '2026-07-01T09:00:00.000Z',
    })

    expect(cancelled.status).toBe(LeaveRequestStatus.Cancelled)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0 })
    const releases = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Release)
    expect(releases).toHaveLength(1)
    expect(releases[0]?.deltaDays).toBe(5)
  })

  it('refuses to cancel an approved leave once it has started', async () => {
    const user = await seedEmployee()
    const request = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    await expect(
      service.cancelLeaveRequest({
        requestId: request.requestId,
        actorUserId: user.userId,
        actorDisplayName: user.displayName,
        // The morning of the first leave day: already begun.
        occurredAt: '2026-08-03T06:00:00.000Z',
      }),
    ).rejects.toThrow(/already started/)
  })

  // ------------------------------------------------------------- supersede ---

  it('replaces an approved leave once every approver has approved the change', async () => {
    const user = await seedEmployee({
      approvers: ['lead@example.com', 'hr@example.com'],
    })
    const original = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
      { approverEmails: ['lead@example.com', 'hr@example.com'] },
    )
    await approve(
      original.requestId,
      ['lead@example.com', 'hr@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...AUGUST_WEEK_LATER,
      approverEmails: ['lead@example.com', 'hr@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    expect(replacement.status).toBe(LeaveRequestStatus.Pending)
    expect(replacement.supersedesRequestId).toBe(original.requestId)
    expect(replacement.supersedes?.startDate).toBe(AUGUST_WEEK.startDate)
    // Both are held while the change is undecided: the employee keeps the
    // leave they had booked until the new dates are agreed.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 10 })
    const stillApproved = await service.getLeaveRequestDetail(original.requestId)
    expect(stillApproved.status).toBe(LeaveRequestStatus.Approved)
    expect(stillApproved.modificationPending).toBe(true)

    const approved = await approve(
      replacement.requestId,
      ['lead@example.com', 'hr@example.com'],
      '2026-04-02T09:00:00.000Z',
    )

    expect(approved.status).toBe(LeaveRequestStatus.Approved)
    const swapped = await service.getLeaveRequestDetail(original.requestId)
    expect(swapped.status).toBe(LeaveRequestStatus.Superseded)
    expect(swapped.supersededByRequestId).toBe(replacement.requestId)
    // Exactly one set of days is held after the swap.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 5 })
  })

  it('leaves the original approved when the change is rejected', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...AUGUST_WEEK_LATER,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    await decide(
      replacement.requestId,
      'lead@example.com',
      LeaveApprovalAction.Reject,
      '2026-04-02T09:00:00.000Z',
    )

    const original2 = await service.getLeaveRequestDetail(original.requestId)
    expect(original2.status).toBe(LeaveRequestStatus.Approved)
    expect(original2.modificationPending).toBeUndefined()
    // Only the replacement's hold went back.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 5 })
  })

  it('refuses to approve a change once the leave it replaces has started', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...AUGUST_WEEK_LATER,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    await expect(
      decide(
        replacement.requestId,
        'lead@example.com',
        LeaveApprovalAction.Approve,
        // The original week is under way; swapping now would release days
        // already lived through.
        '2026-08-05T09:00:00.000Z',
      ),
    ).rejects.toThrow(/already started/)

    // The whole decision rolled back: the vote was not recorded either.
    const untouched = await service.getLeaveRequestDetail(replacement.requestId)
    expect(untouched.status).toBe(LeaveRequestStatus.Pending)
    expect(untouched.approvers[0]?.decision).toBe('pending')
  })

  it('allows only one modification to await approval at a time', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    const modify = (period: { startDate: string; endDate: string }) =>
      service.submitLeaveRequestModification({
        originalRequestId: original.requestId,
        requesterUserId: user.userId,
        ...period,
        approverEmails: ['lead@example.com'],
        ccEmails: [],
        submittedAt: '2026-04-01T09:00:00.000Z',
      })
    await modify(AUGUST_WEEK_LATER)

    await expect(modify(SEPTEMBER_FORTNIGHT)).rejects.toThrow(
      /already awaiting approval/,
    )
    // And the leave itself cannot be called off while its change is undecided.
    await expect(
      service.cancelLeaveRequest({
        requestId: original.requestId,
        actorUserId: user.userId,
        actorDisplayName: user.displayName,
        occurredAt: '2026-04-02T09:00:00.000Z',
      }),
    ).rejects.toThrow(/Cancel the modification first/)
  })

  it('checks a change as if the leave it replaces were already released', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      AUGUST_FORTNIGHT,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    // Ten days in September on top of the ten in August would be twenty by
    // September against eighteen accrued; the replacement fits only because
    // the original's days are excluded from the count.
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...SEPTEMBER_FORTNIGHT,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    expect(replacement.status).toBe(LeaveRequestStatus.Pending)
  })

  it('performs the swap when removing the last blocking approver settles the change', async () => {
    const user = await seedEmployee({
      approvers: ['lead@example.com', 'hr@example.com'],
    })
    const original = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
      { approverEmails: ['lead@example.com'] },
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...AUGUST_WEEK_LATER,
      approverEmails: ['lead@example.com', 'hr@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })
    await decide(
      replacement.requestId,
      'lead@example.com',
      LeaveApprovalAction.Approve,
      '2026-04-02T09:00:00.000Z',
    )

    // Removing the outstanding approver settles the gate on this path, which
    // must run the same swap the ordinary approval would have.
    const settled = await service.removeLeaveRequestApprover({
      requestId: replacement.requestId,
      email: 'hr@example.com',
      actorUserId: testUuid('appr-lead@example.com'),
      actorDisplayName: 'Admin',
    })

    expect(settled.status).toBe(LeaveRequestStatus.Approved)
    expect(
      (await service.getLeaveRequestDetail(original.requestId)).status,
    ).toBe(LeaveRequestStatus.Superseded)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 5 })
  })

  // ---------------------------------------------------------- admin guards ---

  it('refuses an allocation cut that would strand leave already planned', async () => {
    const user = await seedEmployee()
    await submit(user.userId, DECEMBER_FORTNIGHT, '2026-03-02T09:00:00.000Z')

    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 8,
      }),
    ).rejects.toThrow(/Allocation cannot be lowered/)

    // A cut the plan still fits under goes through, even though it leaves the
    // balance holding more days than have accrued so far.
    await service.setEmployeeAllocation({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 12,
    })
    const allocation = await allocationFor(user.userId, 2026)
    expect(allocation?.totalDays).toBe(12)
  })

  it('refuses to cut a FUTURE year below what is already booked into it', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })
    // Twenty days next December, which next year's full allowance covers.
    await submit(
      user.userId,
      { startDate: '2027-12-06', endDate: '2027-12-31' },
      '2026-06-15T09:00:00.000Z',
    )

    // Nothing has accrued in 2027 yet, so this cut moves no accrued figure at
    // all — the guard has to run on the allocation itself, not on the delta.
    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2027,
        totalDays: 5,
      }),
    ).rejects.toThrow(/Allocation cannot be lowered/)
  })

  it('refuses to edit a PAST year once its carryover has been settled', async () => {
    const user = await seedEmployee({
      years: [2025, 2026],
      employmentStartDate: '2025-01-01',
      // The account must have existed in 2025 for that year to be the
      // system's own history and close for REAL — a year that ended before
      // the system met the user is settled trivially and never stamped
      // closed.
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    // A backdated request into last year, still awaiting a decision. Its very
    // submission refreshes balances, which CLOSES 2025: the leftover is carried
    // or expired at a figure computed from the allocation as it stood.
    await submit(
      user.userId,
      { startDate: '2025-11-03', endDate: '2025-11-14' },
      '2026-06-15T09:00:00.000Z',
    )

    // Editing a settled year would either resurrect burnt days or strand the
    // successor's already-booked carryover, so the refusal is total — stronger
    // than the old "not below commitments" rule this scenario used to pin.
    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2025,
        totalDays: 8,
      }),
    ).rejects.toThrow(/2025 leave year is closed/)
  })

  it('charges a leave awaiting a change once, not once per row', async () => {
    const user = await seedEmployee()
    // Fifteen of the twenty-four days, booked for December.
    const original = await submit(
      user.userId,
      { startDate: '2026-12-01', endDate: '2026-12-21' },
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    // Shifted by a week, same length.
    await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      startDate: '2026-12-07',
      endDate: '2026-12-25',
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    // Whichever half wins, the year owes 15 days, leaving room for a week in
    // June. Counting both halves would put 30 days against a 24-day year and
    // freeze all further planning until the change is decided.
    const june = await submit(
      user.userId,
      JUNE_WEEK,
      '2026-04-02T09:00:00.000Z',
    )
    expect(june.status).toBe(LeaveRequestStatus.Pending)
  })

  it('settles the carryover of a year that was skipped entirely', async () => {
    const user = await seedEmployee({
      years: [2026, 2027],
      carryoverPolicy: CarryoverPolicy.Full,
    })
    // Books into 2027 while 2026 is still running, creating 2027 unfinalized.
    await submit(user.userId, NEXT_JANUARY_PAIR, '2026-11-02T09:00:00.000Z')

    // Then nobody touches the account until 2028: 2028's own allocation is
    // created finalized, and a backwards walk would stop there and leave 2027
    // waiting for a carryover forever.
    await service.refreshBalances(user.userId, '2028-02-01T09:00:00.000Z')

    expect(await allocationFor(user.userId, 2027)).toMatchObject({
      carriedOverDays: 24,
      carryoverFinalized: true,
    })
  })

  // ------------------------------------------------------ availability API ---

  it('reports a workable period with its month-by-month headroom', async () => {
    const user = await seedEmployee()

    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...AUGUST_FORTNIGHT,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    expect(preview).toMatchObject({
      feasible: true,
      requestedDays: 10,
      blockers: [],
      leaveYear: 2026,
    })
    // Sixteen days will have accrued by the end of August, so all ten are paid.
    expect(preview).toMatchObject({ paidDays: 10, unpaidDays: 0 })
    expect(preview.unpaidNotice).toBeUndefined()
    expect(preview.monthlyOutlook[7]).toMatchObject({
      month: 8,
      projectedAccruedDays: 16,
      committedDays: 10,
      remainingDays: 6,
    })
  })

  it('reports the split of a period the balance cannot fully cover', async () => {
    const user = await seedEmployee()

    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-04-06',
      endDate: '2026-04-17',
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    // Running past the balance is no longer a refusal, so nothing blocks.
    expect(preview.feasible).toBe(true)
    expect(preview.blockers).toEqual([])
    expect(preview).toMatchObject({ paidDays: 8, unpaidDays: 2 })
    expect(preview.unpaidDates).toEqual(['2026-04-16', '2026-04-17'])
    expect(preview.unpaidNotice).toBe(
      'Your projected balance covers 8d of these 10d; the other 2d would be unpaid.',
    )
  })

  it('names overlapping requests when the previewed period collides with one', async () => {
    const user = await seedEmployee()
    await submit(user.userId, AUGUST_WEEK, '2026-03-02T09:00:00.000Z')

    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-05',
      endDate: '2026-08-12',
      asOfIso: '2026-03-02T09:00:00.000Z',
    })

    expect(preview.feasible).toBe(false)
    expect(preview.blockers).toEqual([
      {
        code: 'overlapping_request',
        message: 'This period overlaps an existing leave request:',
        overlappingRequests: [
          {
            startDate: AUGUST_WEEK.startDate,
            endDate: AUGUST_WEEK.endDate,
            status: LeaveRequestStatus.Pending,
          },
        ],
      },
    ])
  })

  it('freezes the same split the preview promised', async () => {
    const user = await seedEmployee()
    const period = { startDate: '2026-04-06', endDate: '2026-04-17' }
    const asOf = '2026-03-02T09:00:00.000Z'

    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...period,
      asOfIso: asOf,
    })
    const request = await submit(user.userId, period, asOf)

    expect(request.paidDays).toBe(preview.paidDays)
    expect(request.unpaidDates).toEqual(preview.unpaidDates)
  })

  it('excludes the leave being modified from the preview it is checked against', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      AUGUST_FORTNIGHT,
      '2026-03-02T09:00:00.000Z',
    )

    // Counted naively, August's ten days leave September short by two.
    const naive = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...SEPTEMBER_FORTNIGHT,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })
    expect(naive).toMatchObject({ paidDays: 8, unpaidDays: 2 })

    // As a change to August, those days come back and September is fully paid.
    const asModification = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...SEPTEMBER_FORTNIGHT,
      excludeRequestId: original.requestId,
      asOfIso: '2026-03-02T09:00:00.000Z',
    })
    expect(asModification).toMatchObject({ paidDays: 10, unpaidDays: 0 })
  })

  // -------------------------------------------------------- paid vs unpaid ---

  it('funds the days after a month boundary with the accrual that arrives on it', async () => {
    const user = await seedEmployee()

    // Six days accrued by March, eight by April. A period straddling the
    // boundary runs out on 31 March and picks the funding back up in April, so
    // the unpaid days are the two the balance genuinely cannot reach — not
    // everything after the first shortfall.
    const request = await submit(
      user.userId,
      { startDate: '2026-03-23', endDate: '2026-04-03' },
      '2026-03-02T09:00:00.000Z',
    )

    expect(request).toMatchObject({
      requestedDays: 10,
      paidDays: 8,
      unpaidDays: 2,
    })
    expect(request.unpaidDates).toEqual(['2026-03-31', '2026-04-03'])
  })

  it('takes a whole request unpaid when the year grants nothing', async () => {
    const user = await seedEmployee()
    await service.setEmployeeAllocation({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 0,
    })

    const request = await submit(
      user.userId,
      AUGUST_WEEK,
      '2026-03-02T09:00:00.000Z',
    )

    expect(request).toMatchObject({ paidDays: 0, unpaidDays: 5 })
    // Nothing was held, so the ledger has no entry to explain: a request the
    // balance never touched leaves the balance alone.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0 })
    const holds = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Hold)
    expect(holds).toEqual([])
  })

  it('credits sick leave up front, so its unpaid days start past the annual allowance', async () => {
    const user = await seedEmployee()

    // Twelve sick days a year and a January start date, so the whole tranche
    // is available from January: a fifteen-day sick leave is paid up to twelve
    // and unpaid after that.
    const request = await submit(
      user.userId,
      { startDate: '2026-09-07', endDate: '2026-09-25' },
      '2026-02-02T09:00:00.000Z',
      { leaveType: LeaveType.Sick },
    )

    expect(request).toMatchObject({ requestedDays: 15, paidDays: 12, unpaidDays: 3 })
  })

  it('spends only the paid days as the leave elapses', async () => {
    const user = await seedEmployee()
    const request = await submit(
      user.userId,
      { startDate: '2026-03-23', endDate: '2026-04-03' },
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    // Well past the last leave day: every day has elapsed.
    await service.reconcileApprovedLeave({ asOfIso: '2026-05-01T09:00:00.000Z' })

    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ spentDays: 8, onHoldDays: 0 })
    const detail = await service.getLeaveRequestDetail(request.requestId)
    const consumed = detail.activity.filter(
      (entry) => entry.action === 'consumed',
    )
    // The cursor covers every day, paid or not, so the leave counts as
    // started; only eight of them moved the balance.
    expect(consumed).toHaveLength(10)
    expect(
      consumed.filter((entry) => entry.comment?.includes('(unpaid)')),
    ).toHaveLength(2)
    const spends = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Spent)
    expect(spends).toHaveLength(8)
    expect(spends.map((entry) => entry.effectiveDate)).not.toContain(
      '2026-03-31',
    )
  })

  it('releases only the held days when a partly unpaid leave is cancelled', async () => {
    const user = await seedEmployee()
    const request = await submit(
      user.userId,
      { startDate: '2026-04-06', endDate: '2026-04-17' },
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      request.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: user.userId,
      actorDisplayName: user.displayName,
      occurredAt: '2026-03-10T09:00:00.000Z',
    })

    const releases = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Release)
    expect(releases).toHaveLength(1)
    expect(releases[0]?.deltaDays).toBe(8)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0 })
  })

  it('re-splits a modification and keeps the frozen split of what it replaces', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      { startDate: '2026-04-06', endDate: '2026-04-17' },
      '2026-03-02T09:00:00.000Z',
    )
    expect(original).toMatchObject({ paidDays: 8, unpaidDays: 2 })
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )

    // Moving the same ten days to August, where sixteen will have accrued,
    // turns the unpaid tail back into paid days.
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...AUGUST_FORTNIGHT,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-20T09:00:00.000Z',
    })

    expect(replacement).toMatchObject({ paidDays: 10, unpaidDays: 0 })
    // The original keeps the funding it was given until the swap happens.
    expect(
      await service.getLeaveRequestDetail(original.requestId),
    ).toMatchObject({ paidDays: 8, unpaidDays: 2 })

    await approve(
      replacement.requestId,
      ['lead@example.com'],
      '2026-03-21T09:00:00.000Z',
    )

    // Only the replacement's ten days are held once the original released its
    // eight.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 10 })
  })

  it('charges a leave awaiting a change by its paid days, not its raw length', async () => {
    const user = await seedEmployee()
    const original = await submit(
      user.userId,
      JUNE_WEEK,
      '2026-03-02T09:00:00.000Z',
    )
    await approve(
      original.requestId,
      ['lead@example.com'],
      '2026-03-03T09:00:00.000Z',
    )
    // A longer replacement that the year cannot fully fund: ten days in
    // April, of which only three are still payable after June's five.
    await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      startDate: '2026-04-06',
      endDate: '2026-04-17',
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-04T09:00:00.000Z',
    })

    // December is judged against the worst case of the pair, counted in paid
    // days, rather than against both of them at once.
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      ...DECEMBER_FORTNIGHT,
      asOfIso: '2026-03-05T09:00:00.000Z',
    })
    expect(preview).toMatchObject({ paidDays: 10, unpaidDays: 0 })
  })

  it('still refuses an allocation cut below the days already funded', async () => {
    const user = await seedEmployee()
    await submit(user.userId, AUGUST_FORTNIGHT, '2026-03-02T09:00:00.000Z')

    // Ten paid days stand committed in August, so the allocation has to still
    // accrue ten by then: fourteen a year reaches only 9.33 and is refused
    // rather than quietly reclassifying a funded day as unpaid.
    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 14,
      }),
    ).rejects.toThrow(/committed/)

    // Fifteen accrues exactly ten by August, which the commitment fits into.
    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 15,
      }),
    ).resolves.toBeDefined()
  })
})
