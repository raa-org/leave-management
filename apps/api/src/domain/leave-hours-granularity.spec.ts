/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataSource } from 'typeorm'
import {
  AuditEventType,
  CarryoverPolicy,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
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
import { LeaveRequestEntity } from './entities/leave-request.entity'

// Leave booked by the HOUR. Everything here turns on one distinction the rest
// of the suite cannot see, because every request it files costs exactly as many
// days as it covers dates: a request's COST and its DATES are two different
// quantities now, and the books must speak the first while the calendar, the
// spend cursor and the elapsed-day guards keep speaking the second.
//
// The wire carries WHOLE HOURS per date and the server owns the divisor
// (leave_settings.hoursPerDay), so every fixture below books hours and asserts
// days: 4 hours of an 8-hour day is half a day of balance, and nothing in a
// payload can make it anything else.

// Anchors: whole Mon-Fri weeks of 2026 with no holidays seeded, so "working
// days" is simply the weekdays and every assertion below is about what those
// days COST, never about which dates they are.
const JUNE_WEEK = { startDate: '2026-06-01', endDate: '2026-06-05' }
const JUNE_WEEK_LATER = { startDate: '2026-06-08', endDate: '2026-06-12' }
const JUNE_WEEK_LAST = { startDate: '2026-06-15', endDate: '2026-06-19' }
// Mon 12-28..Thu 12-31 in 2026, then Fri 01-01, Mon 01-04, Tue 01-05 in 2027.
const NEW_YEAR_SPAN = { startDate: '2026-12-28', endDate: '2027-01-05' }

// Pinned like the planning spec's: the fixtures book leave in June and December
// 2026, and the guards that read the wall clock (cancel, modify) only mean what
// these cases were written to mean while "now" sits before the leave starts.
const NOW = '2026-04-15T12:00:00.000Z'
const IN_MARCH = '2026-03-02T09:00:00.000Z'

describe('LeaveDomainService leave booked by the hour', () => {
  let dataSource: DataSource
  let service: LeaveDomainService
  let clock: ClockService

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource?.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    // ClockService reads TEST_TOOLING_ENABLED once, at construction, and
    // refuses to be set when it is off, so the flag is on for exactly that call.
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
  })

  // 24 vacation days a year = exactly 2 a month, so "what the year has earned
  // by month M" is 2*M and a fixture can say how much room it means to leave.
  const settings = (
    overrides: { defaultVacationDays?: number; hoursPerDay?: number } = {},
  ) => ({
    defaultVacationDays: overrides.defaultVacationDays ?? 24,
    defaultSickDays: 12,
    defaultApproverEmails: [],
    defaultCcApproverEmails: [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    carryoverPolicy: CarryoverPolicy.None,
    carryoverCapDays: 0,
    ...(overrides.hoursPerDay !== undefined
      ? { hoursPerDay: overrides.hoursPerDay }
      : {}),
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  const seedEmployee = async (
    options: {
      defaultVacationDays?: number
      hoursPerDay?: number
      years?: number[]
    } = {},
  ) => {
    await service.updateLeaveSettings(
      settings({
        ...(options.defaultVacationDays !== undefined
          ? { defaultVacationDays: options.defaultVacationDays }
          : {}),
        ...(options.hoursPerDay !== undefined
          ? { hoursPerDay: options.hoursPerDay }
          : {}),
      }),
    )
    for (const year of options.years ?? [2026]) {
      await seedHolidayCalendar(service, { year })
    }
    const user = await service.upsertUser({
      userId: testUuid('hourly'),
      email: 'hourly@example.com',
      displayName: 'Hourly',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('hourly-lead'),
      email: 'lead@example.com',
      displayName: 'Lead',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    return user
  }

  const submit = (
    userId: string,
    period: { startDate: string; endDate: string },
    submittedAt: string,
    options: {
      hoursByDate?: Record<string, number>
      leaveType?: LeaveType
    } = {},
  ) =>
    service.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: options.leaveType ?? LeaveType.Vacation,
      ...period,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt,
      ...(options.hoursByDate !== undefined
        ? { hoursByDate: options.hoursByDate }
        : {}),
    })

  const approve = (requestId: string, when: string) =>
    service.decideLeaveRequest({
      requestId,
      actorUserId: testUuid('hourly-lead'),
      actorDisplayName: 'Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: when,
    })

  const balanceFor = (userId: string, year: number) =>
    dataSource.getRepository(LeaveBalanceEntity).findOneBy({
      userId,
      leaveType: LeaveType.Vacation,
      year,
    })

  const requestRow = (requestId: string) =>
    dataSource.getRepository(LeaveRequestEntity).findOneBy({ id: requestId })

  const ledger = (userId: string) =>
    dataSource.getRepository(LeaveBalanceChangeEntity).find({
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    })

  // ------------------------------------------------------------- the cost ---

  it('prices a week with two half days at four days, holds four, and spends each date as it elapses', async () => {
    const user = await seedEmployee()

    // The motivating case: away all week, but only the mornings of Wednesday
    // and Thursday. Five dates, four days of leave.
    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 4, '2026-06-04': 4 },
    })

    expect(request).toMatchObject({
      status: LeaveRequestStatus.Pending,
      requestedDays: 4,
      paidDays: 4,
      unpaidDays: 0,
    })
    // The DATES are untouched by the hours: the absence still covers the week,
    // which is what the calendar, the overlap check and the spend cursor read.
    expect((await requestRow(request.requestId))?.leaveDays).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ])
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 4, spentDays: 0 })

    await approve(request.requestId, '2026-03-03T09:00:00.000Z')

    // Each date is spent as it elapses, for what it cost: the two half days
    // draw 0.5 each, and the hold falls by the same amount rather than by one.
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-06-02T23:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 2, spentDays: 2 })

    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-06-03T23:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 1.5, spentDays: 2.5 })

    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-06-05T23:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0, spentDays: 4 })

    // One spend row per date, each carrying that date's own cost.
    const spent = (await ledger(user.userId)).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Spent,
    )
    expect(spent.map((entry) => [entry.effectiveDate, entry.deltaDays])).toEqual(
      [
        ['2026-06-01', 1],
        ['2026-06-02', 1],
        ['2026-06-03', 0.5],
        ['2026-06-04', 0.5],
        ['2026-06-05', 1],
      ],
    )
    // The whole-day rows still read exactly as every row filed before leave
    // could be booked by the hour; only the part days have anything to add.
    expect(spent[0]?.note).toBe(
      `Consumed approved leave day 2026-06-01 for request ${request.requestId}`,
    )
    expect(spent[2]?.note).toBe(
      `Consumed 4h of approved leave day 2026-06-03 for request ${request.requestId}`,
    )
  })

  it('books a single two-hour absence as a quarter of a day, end to end', async () => {
    const user = await seedEmployee()

    const request = await submit(
      user.userId,
      { startDate: '2026-06-01', endDate: '2026-06-01' },
      IN_MARCH,
      { hoursByDate: { '2026-06-01': 2 } },
    )

    expect(request).toMatchObject({
      requestedDays: 0.25,
      paidDays: 0.25,
      unpaidDays: 0,
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 0.25 })

    await approve(request.requestId, '2026-03-03T09:00:00.000Z')
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-06-01T23:00:00.000Z',
    })

    // Six days accrued by March, a quarter of one spent: what is left is the
    // remainder of a day, not a whole one.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      accruedDays: 6,
      onHoldDays: 0,
      spentDays: 0.25,
      availableDays: 5.75,
    })
  })

  it('funds a date whole or not at all, and never splits one across the shortfall', async () => {
    // Three days a year = a quarter of a day a month, so by April the year has
    // earned exactly 1.0 and the fixture can leave a shortfall smaller than a
    // single date's cost.
    const user = await seedEmployee({ defaultVacationDays: 3 })

    // Wed 4h (0.5), Thu 2h (0.25), Fri 4h (0.5), Mon 2h (0.25). The walk funds
    // the first two (0.75), cannot fit Friday's half day in the 0.25 that is
    // left, and then funds Monday, which does fit.
    const request = await submit(
      user.userId,
      { startDate: '2026-04-01', endDate: '2026-04-06' },
      IN_MARCH,
      {
        hoursByDate: {
          '2026-04-01': 4,
          '2026-04-02': 2,
          '2026-04-03': 4,
          '2026-04-06': 2,
        },
      },
    )

    expect(request.requestedDays).toBe(1.5)
    // Friday goes WHOLLY unpaid and carries its whole 0.5 with it: a date is
    // funded or it is not, and the 0.25 the year still had is simply not
    // enough to buy half of it.
    expect(request.unpaidDates).toEqual(['2026-04-03'])
    expect(request.paidDays).toBe(1)
    expect(request.unpaidDays).toBe(0.5)
    // The DTO's own promise, which only a subtraction can keep exact.
    expect(request.paidDays + request.unpaidDays).toBe(request.requestedDays)
    // Only the paid part is held.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 1 })
  })

  it('holds and releases a cross-year part-day request per year, priced not counted', async () => {
    const user = await seedEmployee({ years: [2026, 2027] })

    // 2026: three whole days plus a half (3.5). 2027: New Year's Day whole,
    // then two half days (2.0), which is what January will have earned.
    const request = await submit(
      user.userId,
      NEW_YEAR_SPAN,
      '2026-11-02T09:00:00.000Z',
      {
        hoursByDate: {
          '2026-12-31': 4,
          '2027-01-04': 4,
          '2027-01-05': 4,
        },
      },
    )

    expect(request).toMatchObject({
      requestedDays: 5.5,
      paidDays: 5.5,
      unpaidDays: 0,
    })
    expect(await balanceFor(user.userId, 2026)).toMatchObject({
      onHoldDays: 3.5,
    })
    expect(await balanceFor(user.userId, 2027)).toMatchObject({
      onHoldDays: 2,
    })

    const holds = (await ledger(user.userId)).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Hold,
    )
    expect(holds.map((entry) => [entry.year, entry.deltaDays])).toEqual([
      [2026, 3.5],
      [2027, 2],
    ])
    // The note names the year's share as an amount, so a reader landing on the
    // 3.5-day hold row is told which part of the 5.5 it is.
    expect(holds[0]?.note).toContain('3d 4h of 5d 4h paid, the 2026 share')

    await approve(request.requestId, '2026-11-03T09:00:00.000Z')
    await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: user.userId,
      actorDisplayName: 'Hourly',
      occurredAt: '2026-11-10T09:00:00.000Z',
    })

    // Given back exactly what each year held: a release that counted dates
    // would credit 4 days to 2026 and 3 to 2027, days the request never took.
    const releases = (await ledger(user.userId)).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Release,
    )
    expect(releases.map((entry) => [entry.year, entry.deltaDays])).toEqual([
      [2026, 3.5],
      [2027, 2],
    ])
    expect(await balanceFor(user.userId, 2026)).toMatchObject({ onHoldDays: 0 })
    expect(await balanceFor(user.userId, 2027)).toMatchObject({ onHoldDays: 0 })
  })

  // --------------------------------------------------- cancel and modify ---

  it('counts elapsed DATES on the started guard, however little they cost', async () => {
    const user = await seedEmployee()

    // Monday is a two-hour absence: a quarter of a day of balance, but a whole
    // date of the leave.
    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-01': 2 },
    })
    await approve(request.requestId, '2026-03-03T09:00:00.000Z')
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-06-01T23:00:00.000Z',
    })

    // The cursor is a count of DATES and the ledger is an amount: one date has
    // gone, and it took 0.25 days with it. Were the cursor holding the amount,
    // Math.round(0.25) would be zero and both guards below would let a leave
    // that has already begun be cancelled or re-dated.
    const row = await requestRow(request.requestId)
    expect(row?.spentDaysConsumed).toBe(1)
    expect(row?.remainingHeldDays).toBe(4)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ spentDays: 0.25 })

    await expect(
      service.cancelLeaveRequest({
        requestId: request.requestId,
        actorUserId: user.userId,
        actorDisplayName: 'Hourly',
        occurredAt: '2026-06-02T09:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)

    await expect(
      service.submitLeaveRequestModification({
        originalRequestId: request.requestId,
        requesterUserId: user.userId,
        startDate: JUNE_WEEK_LATER.startDate,
        endDate: JUNE_WEEK_LATER.endDate,
        approverEmails: ['lead@example.com'],
        ccEmails: [],
        submittedAt: '2026-06-02T09:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)
  })

  it('re-states the whole shape on a modification and swaps the holds at their own prices', async () => {
    const user = await seedEmployee()

    const original = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 4, '2026-06-04': 4 },
    })
    await approve(original.requestId, '2026-03-03T09:00:00.000Z')

    // The replacement carries its OWN hours. Nothing is inherited: the dates it
    // does not name are whole days, including the ones that were half days on
    // the original.
    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      startDate: JUNE_WEEK_LATER.startDate,
      endDate: JUNE_WEEK_LATER.endDate,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
      hoursByDate: { '2026-06-08': 2 },
    })
    expect(replacement.requestedDays).toBe(4.25)

    await approve(replacement.requestId, '2026-04-02T09:00:00.000Z')

    // The swap releases the original at the price it was held at, so the
    // balance ends up holding the replacement and nothing else.
    expect(
      await service.getLeaveRequestDetail(original.requestId),
    ).toMatchObject({ status: LeaveRequestStatus.Superseded })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ onHoldDays: 4.25 })
    const releases = (await ledger(user.userId)).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Release,
    )
    expect(releases.map((entry) => entry.deltaDays)).toEqual([4])
  })

  it('shows the re-funded shape in the audit diff even when the dates and the total do not move', async () => {
    const user = await seedEmployee()

    const original = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-01': 4, '2026-06-02': 4 },
    })
    await approve(original.requestId, '2026-03-03T09:00:00.000Z')

    // Same dates, same 4 days, the half days moved to the end of the week: the
    // only thing that changed is which date costs what.
    await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      ...JUNE_WEEK,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
      hoursByDate: { '2026-06-04': 4, '2026-06-05': 4 },
    })

    const audit = await new AuditLogService(dataSource, clock).getAdminAuditLogs(
      {
        userId: user.userId,
        eventType: AuditEventType.LeaveRequestModificationSubmitted,
      },
    )
    expect(audit.items[0]?.before?.['dayPortions']).toEqual([
      0.5, 0.5, 1, 1, 1,
    ])
  })

  // -------------------------------------------------------- the read side ---

  it('names the part days on the detail and says nothing about the whole ones', async () => {
    const user = await seedEmployee()

    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 4, '2026-06-04': 2 },
    })

    // requestedDays says the week costs 3.75 days; only this says which of the
    // five dates the missing 1.25 is on, which is what an approver deciding it
    // and a composer prefilling a modification both need.
    expect(request.requestedDays).toBe(3.75)
    expect(request.dayPortions).toEqual({
      '2026-06-03': 0.5,
      '2026-06-04': 0.25,
    })

    // Answered to whoever reads the request later, not only to the submitter.
    const detail = await service.getLeaveRequestDetail(request.requestId)
    expect(detail.dayPortions).toEqual({
      '2026-06-03': 0.5,
      '2026-06-04': 0.25,
    })

    // The employee's history and the admin's employee view are built by the
    // same mapper, so no surface can go blind on its own.
    const history = await service.getLeaveRequestHistory(user.userId)
    expect(history.requests[0]?.dayPortions).toEqual({
      '2026-06-03': 0.5,
      '2026-06-04': 0.25,
    })
  })

  it('leaves the field off an ordinary whole-day request entirely', async () => {
    const user = await seedEmployee()

    // The case that matters most, because it is every request filed before
    // leave could be booked by the hour: absent means whole, so a client that
    // never heard of part days keeps reading the same payload it always did.
    const plain = await submit(user.userId, JUNE_WEEK, IN_MARCH)
    expect(Object.hasOwn(plain, 'dayPortions')).toBe(false)
    expect(
      Object.hasOwn(
        await service.getLeaveRequestDetail(plain.requestId),
        'dayPortions',
      ),
    ).toBe(false)

    // Whole days spelled out are still whole days: a composer may send the
    // entire shape of an absence, and what comes back is the ordinary request
    // it always was.
    const spelled = await submit(user.userId, JUNE_WEEK_LATER, IN_MARCH, {
      hoursByDate: { '2026-06-08': 8, '2026-06-09': 8 },
    })
    expect(spelled.requestedDays).toBe(5)
    expect(Object.hasOwn(spelled, 'dayPortions')).toBe(false)
  })

  it('publishes the frozen portion, so a later change of the workday cannot rewrite it', async () => {
    const user = await seedEmployee({ hoursPerDay: 6 })

    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 3 },
    })
    expect(request.dayPortions).toEqual({ '2026-06-03': 0.5 })

    // The org moves to an eight-hour day. Half a day is what the books were
    // written from and half a day is what the detail keeps saying; only the
    // hours a client renders off it move (three then, four now), which is also
    // the figure a modification composer should prefill, since the replacement
    // will be priced with the new setting.
    await service.updateLeaveSettings(settings({ hoursPerDay: 8 }))

    const detail = await service.getLeaveRequestDetail(request.requestId)
    expect(detail.dayPortions).toEqual({ '2026-06-03': 0.5 })
    expect(detail.requestedDays).toBe(4.5)
  })

  it('shows the replacement its own shape after a modification, never the original one', async () => {
    const user = await seedEmployee()

    const original = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 4, '2026-06-04': 4 },
    })
    await approve(original.requestId, '2026-03-03T09:00:00.000Z')

    const replacement = await service.submitLeaveRequestModification({
      originalRequestId: original.requestId,
      requesterUserId: user.userId,
      startDate: JUNE_WEEK_LATER.startDate,
      endDate: JUNE_WEEK_LATER.endDate,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
      hoursByDate: { '2026-06-08': 2 },
    })

    // The replacement's detail is what its approver decides on, so it carries
    // the shape they are being asked to agree to.
    expect(replacement.dayPortions).toEqual({ '2026-06-08': 0.25 })
    // The original keeps the shape it was frozen with and never acquires the
    // replacement's: both are read from their own rows.
    expect(
      (await service.getLeaveRequestDetail(original.requestId)).dayPortions,
    ).toEqual({ '2026-06-03': 0.5, '2026-06-04': 0.5 })

    await approve(replacement.requestId, '2026-04-02T09:00:00.000Z')

    // A modification that names no hours is a whole-day absence again, so the
    // field goes away rather than carrying the previous shape forward.
    const wholeAgain = await service.submitLeaveRequestModification({
      originalRequestId: replacement.requestId,
      requesterUserId: user.userId,
      ...JUNE_WEEK_LAST,
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-03T09:00:00.000Z',
    })
    expect(Object.hasOwn(wholeAgain, 'dayPortions')).toBe(false)
  })

  // ------------------------------------------------------------- refusals ---

  it('refuses hours on a date the request does not actually cover', async () => {
    const user = await seedEmployee()

    // A weekend inside the range: the composer that sent it believes those
    // hours are booked, so the answer is a refusal and not a silent full day.
    await expect(
      submit(
        user.userId,
        { startDate: '2026-06-01', endDate: '2026-06-07' },
        IN_MARCH,
        { hoursByDate: { '2026-06-06': 4 } },
      ),
    ).rejects.toThrow(/2026-06-06.*not a working day/)

    // A public holiday is excluded from the working days for the same reason a
    // weekend is, and answers the same way.
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-06-03', name: 'Observed Holiday' }],
    })
    await expect(
      submit(user.userId, JUNE_WEEK, IN_MARCH, {
        hoursByDate: { '2026-06-03': 4 },
      }),
    ).rejects.toThrow(/2026-06-03.*not a working day/)

    // Outside the period entirely.
    await expect(
      submit(user.userId, JUNE_WEEK, IN_MARCH, {
        hoursByDate: { '2026-06-08': 4 },
      }),
    ).rejects.toThrow(/2026-06-08.*not a working day/)
  })

  it('refuses an hours value that is not a whole bookable number of hours', async () => {
    const user = await seedEmployee()

    for (const hours of [4.5, 0, -2, 9]) {
      await expect(
        submit(user.userId, JUNE_WEEK, IN_MARCH, {
          hoursByDate: { '2026-06-03': hours },
        }),
      ).rejects.toThrow(/must be a whole number between 1 and 8/)
    }

    // The whole workday is accepted and means exactly that, so a composer may
    // send the full shape of an absence without special-casing its full days.
    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 8 },
    })
    expect(request.requestedDays).toBe(5)
    // Normalized away entirely: an all-whole-day request is stored exactly like
    // one filed before leave could be booked by the hour.
    expect((await requestRow(request.requestId))?.dayPortions).toEqual([])
  })

  it('divides by the org workday length, not by a hardcoded eight', async () => {
    const user = await seedEmployee({ hoursPerDay: 6 })

    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 3 },
    })
    expect(request.requestedDays).toBe(4.5)

    // Seven hours is more than this org's day, so it is not a bookable figure
    // here even though it would be at eight.
    await expect(
      submit(user.userId, JUNE_WEEK_LATER, IN_MARCH, {
        hoursByDate: { '2026-06-08': 7 },
      }),
    ).rejects.toThrow(/must be a whole number between 1 and 6/)
  })

  // -------------------------------------------------------------- preview ---

  it('previews the same split the submission freezes, hours included', async () => {
    const user = await seedEmployee({ defaultVacationDays: 3 })

    const hoursByDate = {
      '2026-04-01': 4,
      '2026-04-02': 2,
      '2026-04-03': 4,
      '2026-04-06': 2,
    }
    const preview = await service.previewLeaveAvailability({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-04-01',
      endDate: '2026-04-06',
      asOfIso: IN_MARCH,
      hoursByDate,
    })

    expect(preview).toMatchObject({
      requestedDays: 1.5,
      paidDays: 1,
      unpaidDays: 0.5,
      feasible: true,
    })
    expect(preview.unpaidDates).toEqual(['2026-04-03'])
    expect(preview.unpaidNotice).toContain(
      'Each working day is paid in full or unpaid in full',
    )
    // The per-year row prices the same range the same way.
    expect(preview.years.find((year) => year.year === 2026)).toMatchObject({
      requestedDays: 1.5,
      paidDays: 1,
      unpaidDays: 0.5,
    })

    // What the panel promised is what the request froze: the preview exists so
    // the composer cannot show a split the server would not have written.
    const request = await submit(
      user.userId,
      { startDate: '2026-04-01', endDate: '2026-04-06' },
      IN_MARCH,
      { hoursByDate },
    )
    expect(request.requestedDays).toBe(preview.requestedDays)
    expect(request.paidDays).toBe(preview.paidDays)
    expect(request.unpaidDays).toBe(preview.unpaidDays)
    expect(request.unpaidDates).toEqual(preview.unpaidDates)
  })

  it('refuses hours on the preview exactly as the submission refuses them', async () => {
    const user = await seedEmployee()

    await expect(
      service.previewLeaveAvailability({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-01',
        endDate: '2026-06-07',
        asOfIso: IN_MARCH,
        hoursByDate: { '2026-06-06': 4 },
      }),
    ).rejects.toThrow(/2026-06-06.*not a working day/)
  })

  // ----------------------------------------------------- admin adjustment ---

  it('adjusts a vacation balance by a fraction of a day on the hour grid', async () => {
    const user = await seedEmployee()
    clock.setNow('2026-06-15T12:00:00.000Z')
    await service.getBalances(user.userId)

    // Four hours: the correction an admin needs when what they are correcting
    // is a four-hour booking.
    await service.adjustEmployeeVacationBalance({
      userId: user.userId,
      deltaDays: 0.5,
      note: 'Half a day back after the office closed early',
    })

    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
      })
    expect(allocation?.manualAdjustmentDays).toBe(0.5)
    const adjustments = (await ledger(user.userId)).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
    )
    expect(adjustments.map((entry) => entry.deltaDays)).toEqual([0.5])

    // The audit sentence reads in the product's one notation for an amount;
    // "0.5 vacation days" would be a figure nobody could check against a
    // booking.
    const audit = await new AuditLogService(dataSource, clock).getAdminAuditLogs(
      { userId: user.userId, eventType: AuditEventType.EmployeeBalanceAdjusted },
    )
    expect(audit.items[0]?.summary).toContain('Added 4h of vacation')

    // A whole-day correction still reads exactly as it always has.
    await service.adjustEmployeeVacationBalance({
      userId: user.userId,
      deltaDays: -2,
      note: 'Clawback',
    })
    const afterDebit = await new AuditLogService(
      dataSource,
      clock,
    ).getAdminAuditLogs({
      userId: user.userId,
      eventType: AuditEventType.EmployeeBalanceAdjusted,
    })
    expect(afterDebit.items[0]?.summary).toContain('Removed 2d of vacation')
  })

  it('accepts an adjustment of an hour whose share of the day does not fit three decimals', async () => {
    const user = await seedEmployee({ hoursPerDay: 7 })

    // An hour of a seven-hour day is stored as 0.143 of a day, which is what
    // the booking path mints for it.
    const request = await submit(user.userId, JUNE_WEEK, IN_MARCH, {
      hoursByDate: { '2026-06-03': 1 },
    })
    expect(request.requestedDays).toBe(4.143)

    // The admin lever has to speak the same figures, or it could not correct
    // the booking above: an hour is on the grid here even though 0.143 times
    // seven is not exactly one.
    clock.setNow('2026-06-15T12:00:00.000Z')
    await service.getBalances(user.userId)
    await service.adjustEmployeeVacationBalance({
      userId: user.userId,
      deltaDays: 0.143,
      note: 'One hour back',
    })
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
      })
    expect(allocation?.manualAdjustmentDays).toBe(0.143)
  })

  it('refuses an adjustment that lands between two hours', async () => {
    const user = await seedEmployee()
    clock.setNow('2026-06-15T12:00:00.000Z')
    await service.getBalances(user.userId)

    // A tenth of a day is nothing an employee could ever book or an editor
    // round-trip, so it has no business in the ledger.
    await expect(
      service.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: 0.1,
        note: 'Off the grid',
      }),
    ).rejects.toThrow(/whole number of hours/)

    await expect(
      service.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: 0,
        note: 'Nothing at all',
      }),
    ).rejects.toBeInstanceOf(LeaveDomainValidationError)
  })
})
