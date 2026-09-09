/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IsNull } from 'typeorm'
import type { DataSource } from 'typeorm'
import { LeaveRequestStatus, LeaveType } from '@workspace/contracts'
import type {
  EmployeeImportRowDto,
  ImportEmployeeRequestDto,
  LeaveHistoryImportRowDto,
} from '@workspace/contracts'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { NotificationService } from '../domain/notification.service'
import { LeaveAllocationEntity } from '../domain/entities/leave-allocation.entity'
import { LeavePolicyEntity } from '../domain/entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from '../domain/entities/leave-policy-membership.entity'
import { LeaveRequestEntity } from '../domain/entities/leave-request.entity'
import { LeaveRequestApproverEntity } from '../domain/entities/leave-request-approver.entity'
import { NotificationEntity } from '../domain/entities/notification.entity'
import { UserEntity } from '../domain/entities/user.entity'
import { policyTermsFingerprint } from '../domain/policy-fingerprint'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveImportService } from './leave-import.service'

// The import service end to end, against a real database: what it validates,
// what a preview shows without writing, and what an apply leaves behind.

let dataSource: DataSource
let domain: LeaveDomainService
let service: LeaveImportService
let clock: ClockService

const NOW = '2026-08-06T09:00:00.000Z'
const ADMIN = {
  userId: testUuid('user-admin'),
  label: 'Import admin',
  email: 'admin@example.com',
  roles: [],
}

const employeeRow = (
  overrides: Partial<EmployeeImportRowDto> = {},
): EmployeeImportRowDto => ({
  email: 'anna@example.com',
  displayName: 'Anna',
  employmentStartDate: '2020-03-02',
  countryCode: 'UA',
  vacationDaysPerYear: 25,
  sickDaysPerYear: 5,
  carriedOverVacationDays: 7,
  ...overrides,
})

const historyRow = (
  overrides: Partial<LeaveHistoryImportRowDto> = {},
): LeaveHistoryImportRowDto => ({
  email: 'anna@example.com',
  leaveType: LeaveType.Vacation,
  startDate: '2026-03-02',
  endDate: '2026-03-06',
  submittedAt: '2026-02-20',
  approvedAt: '2026-02-21',
  approverEmail: 'manager@example.com',
  workingDays: 5,
  ...overrides,
})

const request = (
  overrides: Partial<ImportEmployeeRequestDto> = {},
): ImportEmployeeRequestDto => ({
  fn: 'user-data',
  targetYear: 2026,
  mode: 'add',
  ...overrides,
})

const seedDirectoryUser = async (
  slug: string,
  email: string,
  employmentStartDate?: string,
): Promise<string> => {
  const user = await domain.upsertUser({
    userId: testUuid(`user-${slug}`),
    email,
    displayName: slug,
    countryCode: 'UA',
    employmentStartDate,
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  return user.userId
}

const countRows = async (): Promise<{
  requests: number
  policies: number
  notifications: number
}> => ({
  requests: await dataSource.getRepository(LeaveRequestEntity).count(),
  policies: await dataSource.getRepository(LeavePolicyEntity).count(),
  notifications: await dataSource.getRepository(NotificationEntity).count(),
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
  const auditLog = new AuditLogService(dataSource, clock)
  domain = new LeaveDomainService(
    dataSource,
    auditLog,
    clock,
    new NotificationService(dataSource, clock),
  )
  service = new LeaveImportService(dataSource, domain, auditLog, clock)
  await domain.updateLeaveSettings({
    defaultVacationDays: 25,
    defaultSickDays: 5,
    defaultApproverEmails: [],
    defaultCcApproverEmails: [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  await seedDirectoryUser('manager', 'manager@example.com')
  await seedDirectoryUser('admin', 'admin@example.com')
  await seedHolidayCalendar(domain, { countryCode: 'UA', year: 2026 })
  await seedHolidayCalendar(domain, { countryCode: 'UA', year: 2027 })
})

describe('validate', () => {
  it('reports unknown addresses without failing the file', async () => {
    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [employeeRow({ email: 'ghost@example.com' })],
      },
      ADMIN,
    )

    expect(report.unknownEmails).toEqual(['ghost@example.com'])
    expect(report.employees).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.issues[0]?.message).toContain('directory sync')
  })

  it('proves a seniority ladder against the year norm reference', async () => {
    // Karlovskii's ladder: 15 base, +2 a year since 2023, capped at 25 —
    // 21 for 2026. A stated 21 must pass silently; a ladder that does NOT
    // reproduce the tracker's figure must be called out, because every other
    // check would still wave it through.
    await seedDirectoryUser('karl', 'karl@example.com')
    const ladder = employeeRow({
      email: 'karl@example.com',
      employmentStartDate: '2023-08-28',
      vacationDaysPerYear: 15,
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 25,
      carriedOverVacationDays: undefined,
    })

    const good = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [{ ...ladder, expectedYearVacationDays: 21 }],
      },
      ADMIN,
    )
    expect(
      good.issues.filter((issue) => issue.message.includes('vacation days for 2026')),
    ).toEqual([])

    const bad = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [{ ...ladder, expectedYearVacationDays: 23 }],
      },
      ADMIN,
    )
    const warning = bad.issues.find((issue) =>
      issue.message.includes('vacation days for 2026'),
    )
    expect(warning?.severity).toBe('warning')
    expect(warning?.message).toContain('give 21 vacation days for 2026')
    expect(warning?.message).toContain('expects 23')
  })

  it('groups employees into the policies a run would mint', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')
    await seedDirectoryUser('vera', 'vera@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          employeeRow(),
          employeeRow({ email: 'boris@example.com' }),
          employeeRow({
            email: 'vera@example.com',
            vacationDaysPerYear: 15,
            sickDaysPerYear: 0,
          }),
        ],
      },
      ADMIN,
    )

    expect(report.policiesToCreate).toHaveLength(2)
    const [twentyFive, fifteen] = report.policiesToCreate
    expect(twentyFive?.memberEmails).toEqual([
      'anna@example.com',
      'boris@example.com',
    ])
    // Nothing in the file names a policy, so the server derives the name and
    // the wizard may still change it.
    expect(twentyFive?.plannedName).toBe('Imported 25+5')
    expect(twentyFive?.nameSource).toBe('suggested')
    expect(twentyFive?.renameable).toBe(true)
    expect(fifteen?.memberEmails).toEqual(['vera@example.com'])
  })

  it('refuses history rows that overlap each other or miss the target year', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const report = await service.validate(
      {
        fn: 'leave-history',
        targetYear: 2026,
        mode: 'add',
        history: [
          historyRow({ startDate: '2026-03-02', endDate: '2026-03-06' }),
          historyRow({ startDate: '2026-03-05', endDate: '2026-03-10' }),
          historyRow({ startDate: '2025-11-03', endDate: '2025-11-07' }),
        ],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    const messages = report.issues.map((issue) => issue.message)
    expect(messages.some((message) => message.includes('Overlapping rows'))).toBe(
      true,
    )
    expect(
      messages.some((message) => message.includes('the import targets 2026')),
    ).toBe(true)
  })
})

describe('preview', () => {
  it('computes the whole effect and writes nothing', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const before = await countRows()

    const result = await service.previewEmployee(
      request({ employee: employeeRow(), history: [historyRow()] }),
      ADMIN,
    )

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(result.plan.policy).toMatchObject({
      policyName: 'Imported 25+5',
      willBeCreated: true,
    })
    expect(result.plan.carriedOverVacationDays).toBe(7)
    expect(result.plan.requests[0]).toMatchObject({
      workingDays: 5,
      unpaidDays: 0,
      status: 'imported',
    })
    expect(result.plan.employmentStartDate).toBe('2020-03-02')
    expect(await countRows()).toEqual(before)
  })

  it('matches what the apply then produces', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const payload = request({
      employee: employeeRow(),
      history: [historyRow()],
    })

    const preview = await service.previewEmployee(payload, ADMIN)
    const applied = await service.applyEmployee(payload, ADMIN)

    expect(preview.status).toBe('ok')
    expect(applied.status).toBe('applied')
    if (preview.status !== 'ok' || applied.status !== 'applied') {
      return
    }
    expect(applied.plan.requests).toEqual(preview.plan.requests)
    expect(applied.plan.reconciliation).toEqual(preview.plan.reconciliation)
    expect(applied.plan.carriedOverVacationDays).toBe(
      preview.plan.carriedOverVacationDays,
    )
  })
})

describe('apply', () => {
  it('enrolls, seeds the carryover and replays the history without notifying anyone', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({ employee: employeeRow(), history: [historyRow()] }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    const counts = await countRows()
    expect(counts.requests).toBe(1)
    expect(counts.notifications).toBe(0)
    const balances = await domain.getBalances(userId)
    const vacation = balances.find(
      (balance) => balance.leaveType === LeaveType.Vacation,
    )
    // Seeded carryover 7 + accrual through August (25 * 8/12) - 5 spent days.
    expect(vacation?.availableDays).toBeCloseTo(7 + 16.67 - 5, 2)
  })

  it('counts working days by the assigned calendar, not the country', async () => {
    // The Tabakov case: TR in the directory, works by the Ukrainian schedule.
    // His sick day lands on a Turkish public holiday — on the country's
    // calendar that request holds zero working days and the whole employee
    // fails; the assigned calendar is what makes it a plain working day.
    await domain.updateLeaveSettings({
      defaultVacationDays: 25,
      defaultSickDays: 5,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [
        { code: 'UA', name: 'Ukraine' },
        { code: 'TR', name: 'Turkey' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(domain, {
      countryCode: 'TR',
      year: 2026,
      holidays: [{ date: '2026-04-23', name: 'National Sovereignty Day' }],
    })
    const users = dataSource.getRepository(UserEntity)
    for (const [slug, email] of [
      ['tabakov', 'tabakov@example.com'],
      ['amet', 'amet@example.com'],
    ] as const) {
      await domain.upsertUser({
        userId: testUuid(`user-${slug}`),
        email,
        displayName: slug,
        countryCode: 'TR',
        createdAt: '2026-08-01T00:00:00.000Z',
      })
    }
    const holidaySick = (email: string) =>
      historyRow({
        email,
        leaveType: LeaveType.Sick,
        startDate: '2026-04-23',
        endDate: '2026-04-23',
        workingDays: 1,
      })

    // Without an assigned calendar the TR holiday swallows the whole request.
    const byCountry = await service.applyEmployee(
      request({
        employee: employeeRow({ email: 'amet@example.com', countryCode: 'TR' }),
        history: [holidaySick('amet@example.com')],
      }),
      ADMIN,
    )
    expect(byCountry.status).toBe('failed')

    // With it, the day is an ordinary Ukrainian working day.
    const byCalendar = await service.applyEmployee(
      request({
        employee: employeeRow({
          email: 'tabakov@example.com',
          countryCode: 'TR',
          holidayCalendarCountryCode: 'UA',
        }),
        history: [holidaySick('tabakov@example.com')],
      }),
      ADMIN,
    )
    expect(byCalendar.status).toBe('applied')
    const tabakov = await users.findOneBy({ id: testUuid('user-tabakov') })
    expect(tabakov?.holidayCalendarCountryCode).toBe('UA')

    // A blank cell on a later run changes nothing: inheritance is the
    // default, and clearing an assignment stays a by-hand act.
    const rerun = await service.applyEmployee(
      request({
        employee: employeeRow({
          email: 'tabakov@example.com',
          countryCode: 'TR',
        }),
        history: [],
      }),
      ADMIN,
    )
    expect(rerun.status).toBe('applied')
    const kept = await users.findOneBy({ id: testUuid('user-tabakov') })
    expect(kept?.holidayCalendarCountryCode).toBe('UA')
  })

  it('never creates a user', async () => {
    const result = await service.applyEmployee(
      request({ employee: employeeRow({ email: 'ghost@example.com' }) }),
      ADMIN,
    )

    expect(result).toMatchObject({ status: 'skipped' })
    if (result.status === 'skipped') {
      expect(result.reasons[0]).toContain('never creates users')
    }
  })

  it('skips a row whose days are already on record, so a re-run is a no-op', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const payload = request({
      employee: employeeRow(),
      history: [historyRow()],
    })

    await service.applyEmployee(payload, ADMIN)
    const second = await service.applyEmployee(payload, ADMIN)

    expect(second.status).toBe('applied')
    if (second.status !== 'applied') {
      return
    }
    expect(second.plan.requests[0]).toMatchObject({ status: 'skipped' })
    expect(second.plan.requests[0]?.reason).toContain('already on record')
    expect((await countRows()).requests).toBe(1)
  })

  it('imports the history of a zero-terms employee as unpaid', async () => {
    const userId = await seedDirectoryUser('zera', 'zera@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          email: 'zera@example.com',
          vacationDaysPerYear: 0,
          sickDaysPerYear: 0,
          carriedOverVacationDays: 0,
        }),
        history: [historyRow({ email: 'zera@example.com' })],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.requests[0]).toMatchObject({
      workingDays: 5,
      unpaidDays: 5,
      status: 'imported',
    })
    const balances = await domain.getBalances(userId)
    expect(
      balances.find((balance) => balance.leaveType === LeaveType.Vacation)
        ?.availableDays,
    ).toBe(0)
  })

  it('records leave that names no approver as agreed outside the system', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow(),
        history: [historyRow({ approverEmail: undefined })],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.requests[0]).toMatchObject({
      status: 'imported',
      workingDays: 5,
    })
    const stored = await dataSource
      .getRepository(LeaveRequestEntity)
      .findOneBy({ requesterUserId: userId })
    expect(stored?.status).toBe(LeaveRequestStatus.Approved)
    expect(stored?.decisionComment).toContain('Agreed before the system')
    // Nobody is credited with a decision they did not make, and the live
    // default approvers are not dragged into a request from the past.
    const approvers = await dataSource
      .getRepository(LeaveRequestApproverEntity)
      .findBy({ requestId: stored!.id })
    expect(approvers).toEqual([])
  })

  it('still records the approver the file names', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    await service.applyEmployee(
      request({ employee: employeeRow(), history: [historyRow()] }),
      ADMIN,
    )

    const stored = await dataSource
      .getRepository(LeaveRequestEntity)
      .findOneBy({ requesterUserId: userId })
    const approvers = await dataSource
      .getRepository(LeaveRequestApproverEntity)
      .findBy({ requestId: stored!.id })
    expect(approvers.map((row) => row.email)).toEqual(['manager@example.com'])
    expect(stored?.status).toBe(LeaveRequestStatus.Approved)
  })

  it('imports an employee who is also the administrator running the import', async () => {
    // The importing admin cannot approve their own leave, and before the
    // unaddressed path existed this row was skipped outright.
    await seedDirectoryUser('admin2', 'admin2@example.com')
    const adminActor = {
      userId: testUuid('user-admin2'),
      label: 'Import admin',
      email: 'admin2@example.com',
      roles: [],
    }

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({ email: 'admin2@example.com' }),
        history: [historyRow({ email: 'admin2@example.com', approverEmail: undefined })],
      }),
      adminActor,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.requests[0]).toMatchObject({ status: 'imported' })
  })

  it('re-resolves year totals left behind by an earlier policy', async () => {
    // The employee used the system before the import, so their 2026 allocation
    // already exists — and ensureAllocation never revisits a row that exists.
    // Without a re-resolve the dashboard reads "of 25 total" while accrual
    // follows the imported 19.
    const userId = await seedDirectoryUser('anna', 'anna@example.com')
    await domain.updateEmployeeAdmin({
      userId,
      employmentStartDate: '2020-03-02',
    })
    await domain.refreshBalances(userId)
    const before = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(before?.totalDays).toBe(25)

    await service.applyEmployee(
      request({
        employee: employeeRow({
          vacationDaysPerYear: 19,
          carriedOverVacationDays: 0,
        }),
      }),
      ADMIN,
    )

    const after = await dataSource
      .getRepository(LeaveAllocationEntity)
      .find({ where: { userId, year: 2026 } })
    expect(
      after.find((row) => row.leaveType === LeaveType.Vacation)?.totalDays,
    ).toBe(19)
    expect(
      after.find((row) => row.leaveType === LeaveType.Sick)?.totalDays,
    ).toBe(5)
    // The stored figure and the accrual now come from the same policy.
    const balances = await domain.getBalances(userId)
    const vacation = balances.find(
      (balance) => balance.leaveType === LeaveType.Vacation,
    )
    expect(vacation?.totalDays).toBe(19)
    expect(vacation?.accruedDays).toBeCloseTo(19 * (8 / 12), 2)
  })

  it('pays history the accrual curve would have refused, up to the annual limit', async () => {
    // The office trackers hand out the year's entitlement and let the balance
    // run negative until the monthly accrual catches up, so leave taken in
    // March against a year that had earned three days was paid in full at the
    // time. The replay must not invent unpaid days nobody was docked for.
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          vacationDaysPerYear: 15,
          carriedOverVacationDays: 0,
        }),
        history: [
          historyRow({ startDate: '2026-03-02', endDate: '2026-03-06' }),
          historyRow({ startDate: '2026-03-09', endDate: '2026-03-13' }),
        ],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    // Ten days by mid March, when a 15-day year has accrued barely four.
    expect(result.plan.requests.map((row) => row.unpaidDays)).toEqual([0, 0])
    const stored = await dataSource
      .getRepository(LeaveRequestEntity)
      .find({ where: { requesterUserId: userId } })
    expect(stored.flatMap((row) => row.unpaidLeaveDays)).toEqual([])
  })

  it('leaves days beyond the annual limit unpaid', async () => {
    // The limit is what history still respects: the sick tranche is five days,
    // and the sixth was unpaid in the tracker too.
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({ sickDaysPerYear: 5 }),
        history: [
          historyRow({
            leaveType: LeaveType.Sick,
            startDate: '2026-02-02',
            endDate: '2026-02-06',
          }),
          historyRow({
            leaveType: LeaveType.Sick,
            startDate: '2026-03-02',
            endDate: '2026-03-03',
          }),
        ],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.requests.map((row) => row.unpaidDays)).toEqual([0, 2])
    const balances = await domain.getBalances(userId)
    expect(
      balances.find((balance) => balance.leaveType === LeaveType.Sick)
        ?.spentDays,
    ).toBe(5)
  })

  it('mints a policy with the full terms the file states', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          vacationDaysPerYear: 25,
          vacationAnnualIncrement: 1,
          probationMonths: 3,
          paidSickDuringProbation: false,
        }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    const policy = await dataSource
      .getRepository(LeavePolicyEntity)
      .findOneBy({ vacationDays: 25, vacationAnnualIncrement: 1 })
    expect(policy).toMatchObject({
      probationMonths: 3,
      paidSickDuringProbation: false,
    })
    // The name has to carry the terms that distinguish it, or a second policy
    // differing only by its rise collides on the catalog's name check.
    expect(policy?.name).toContain('+1/yr')
    expect(policy?.name).toContain('3m probation')
  })

  it('puts the employee in the policy the file names, terms notwithstanding', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')
    const named = await dataSource.getRepository(LeavePolicyEntity).save({
      id: testUuid('policy-named'),
      name: 'Senior engineers',
      description: null,
      vacationDays: 28,
      sickDays: 5,
      vacationAnnualIncrement: 0,
      vacationIncrementCapDays: null,
      probationMonths: 0,
      paidSickDuringProbation: false,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      isDefault: false,
      termsFingerprint: 'named-28-5',
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          policyName: 'senior engineers',
          vacationDaysPerYear: 25,
        }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.policy.policyName).toBe('Senior engineers')
    // The disagreement travels as a warning naming the term that disagrees:
    // the catalog decides, the operator is told what it decided.
    expect(
      result.plan.issues.some((issue) =>
        issue.message.includes('vacation days 28 rather than 25'),
      ),
    ).toBe(true)
    const membership = await dataSource
      .getRepository(LeavePolicyMembershipEntity)
      .findOneBy({ userId, supersededByRowId: IsNull() })
    expect(membership?.policyId).toBe(named.id)
  })

  it('states the day counts of the policy joined, not the ones the file states', async () => {
    // The card used to pair the joined policy's NAME with the row's own
    // figures, so a file saying 25+5 against a catalog policy granting 28+8 was
    // reviewed as "Senior engineers, 25 vacation + 5 sick": a deal nobody is
    // on, and the one figure an operator checks the import by.
    await seedDirectoryUser('anna', 'anna@example.com')
    await dataSource.getRepository(LeavePolicyEntity).save({
      id: testUuid('policy-named'),
      name: 'Senior engineers',
      description: null,
      vacationDays: 28,
      sickDays: 8,
      vacationAnnualIncrement: 0,
      vacationIncrementCapDays: null,
      probationMonths: 0,
      paidSickDuringProbation: false,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      isDefault: false,
      termsFingerprint: policyTermsFingerprint({
        vacationDays: 28,
        sickDays: 8,
        vacationAnnualIncrement: 0,
        vacationIncrementEveryYears: 1,
        vacationIncrementCapDays: null,
        probationMonths: 0,
        paidSickDuringProbation: false,
      }),
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          policyName: 'Senior engineers',
          vacationDaysPerYear: 25,
          sickDaysPerYear: 5,
        }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.policy).toMatchObject({
      policyName: 'Senior engineers',
      vacationDaysPerYear: 28,
      sickDaysPerYear: 8,
      willBeCreated: false,
    })
  })

  it('reports a reconciliation delta against the tracker figure', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({ expectedVacationBalance: 10 }),
        history: [historyRow()],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    const vacation = result.plan.reconciliation.find(
      (entry) => entry.leaveType === LeaveType.Vacation,
    )
    expect(vacation?.expectedBalance).toBe(10)
    expect(vacation?.delta).toBeCloseTo(7 + 16.67 - 5 - 10, 2)
  })

  it('warns when the file and the calendar disagree on working days', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow(),
        history: [historyRow({ workingDays: 4 })],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(
      result.plan.issues.some((issue) =>
        issue.message.includes('the engine priced it at 5d'),
      ),
    ).toBe(true)
  })

  it('stays quiet when the file rounded its own figure by less than an hour', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow(),
        // Four days and five hours, written 4.63 by a tracker keeping two
        // decimals; the engine prices it at 4.625.
        history: [
          historyRow({
            hoursByDate: { '2026-03-06': 5 },
            workingDays: 4.63,
          }),
        ],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.requests[0]?.workingDays).toBe(4.625)
    expect(
      result.plan.issues.some((issue) => issue.message.includes('priced it at')),
    ).toBe(false)
  })

  it('reports a working-days gap of a whole hour, which the old day threshold hid', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow(),
        // The file claims the whole day the engine priced at three hours: five
        // hours of disagreement, and under one day.
        history: [
          historyRow({ hoursByDate: { '2026-03-06': 3 }, workingDays: 5 }),
        ],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(
      result.plan.issues.some((issue) =>
        issue.message.includes(
          'the file records 5 day(s) of leave, the engine priced it at 4d 3h',
        ),
      ),
    ).toBe(true)
  })

  it('rebuilds the target year in override mode and keeps later-year leave', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')
    await service.applyEmployee(
      request({ employee: employeeRow(), history: [historyRow()] }),
      ADMIN,
    )
    // A booking the file does not cover: made in the app for next year.
    await domain.submitLeaveRequest({
      requesterUserId: userId,
      leaveType: LeaveType.Vacation,
      startDate: '2027-03-01',
      endDate: '2027-03-05',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
    })
    const laterYearId = (
      await dataSource
        .getRepository(LeaveRequestEntity)
        .findOneBy({ startDate: '2027-03-01' })
    )?.id

    const result = await service.applyEmployee(
      request({
        mode: 'override',
        employee: employeeRow({ carriedOverVacationDays: 3 }),
        history: [historyRow({ startDate: '2026-04-06', endDate: '2026-04-10' })],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.carriedOverVacationDays).toBe(3)
    expect(result.plan.requests[0]).toMatchObject({
      startDate: '2026-04-06',
      status: 'imported',
    })
    const requests = await dataSource.getRepository(LeaveRequestEntity).find()
    // The March row is gone (the year was rebuilt), April is in, and the 2027
    // booking survived untouched.
    expect(requests.map((row) => row.startDate).sort()).toEqual([
      '2026-04-06',
      '2027-03-01',
    ])
    expect(requests.find((row) => row.id === laterYearId)?.startDate).toBe(
      '2027-03-01',
    )
  })
})

// The owner's rule for the pre-go-live history: it is imported exactly as the
// trackers record it, to the hour. These pin the whole path: the cell's map
// reaching the domain, what it freezes, and what it costs the balance.
describe('part-day history', () => {
  it('freezes the hours the file states and charges the priced amount', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        employee: employeeRow(),
        history: [
          historyRow({
            // Mon-Fri, with Tuesday half a day and Wednesday two hours.
            hoursByDate: { '2026-03-03': 4, '2026-03-04': 2 },
            workingDays: 3.75,
          }),
        ],
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    // 3 whole days + 4h + 2h, not the five dates the period covers.
    expect(result.plan.requests[0]).toMatchObject({
      workingDays: 3.75,
      status: 'imported',
    })
    expect(result.plan.issues).toEqual([])

    const stored = await dataSource
      .getRepository(LeaveRequestEntity)
      .findOneBy({ startDate: '2026-03-02' })
    expect(stored?.leaveDays).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ])
    expect(stored?.dayPortions).toEqual([1, 0.5, 0.25, 1, 1])
    expect(Number(stored?.requestedDays)).toBe(3.75)

    // And the balance moved by the AMOUNT, not by the number of dates.
    const balances = await domain.getBalances(userId)
    const vacation = balances.find(
      (balance) => balance.leaveType === LeaveType.Vacation,
    )
    expect(vacation?.availableDays).toBeCloseTo(7 + 16.67 - 3.75, 2)
  })

  it('refuses hours the workday cannot hold', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const report = await service.validate(
      {
        fn: 'leave-history',
        targetYear: 2026,
        mode: 'add',
        history: [
          historyRow({ hoursByDate: { '2026-03-03': 2.5 } }),
          historyRow({
            startDate: '2026-04-06',
            endDate: '2026-04-10',
            hoursByDate: { '2026-04-07': 9 },
          }),
        ],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    const messages = report.issues.map((issue) => issue.message)
    expect(
      messages.filter((message) =>
        message.includes('must be a whole number between 1 and 8'),
      ),
    ).toHaveLength(2)
  })

  it('refuses hours on a date the leave does not charge', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedHolidayCalendar(domain, {
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-03-05', name: 'Test holiday' }],
    })

    const report = await service.validate(
      {
        fn: 'leave-history',
        targetYear: 2026,
        mode: 'add',
        history: [
          // Saturday, a seeded holiday, and a date past the end of the leave.
          historyRow({
            startDate: '2026-03-02',
            endDate: '2026-03-09',
            hoursByDate: { '2026-03-07': 4 },
          }),
          historyRow({
            startDate: '2026-04-06',
            endDate: '2026-04-10',
            hoursByDate: { '2026-04-13': 4 },
          }),
          historyRow({
            startDate: '2026-05-04',
            endDate: '2026-05-08',
            hoursByDate: { '2026-03-05': 4 },
          }),
        ],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    const messages = report.issues.map((issue) => issue.message)
    expect(
      messages.some((message) =>
        message.includes('The hours name 2026-03-07, which this leave does not charge'),
      ),
    ).toBe(true)
    expect(
      messages.some((message) =>
        message.includes("The hours name 2026-04-13, which is outside the leave's"),
      ),
    ).toBe(true)
    expect(
      messages.some((message) =>
        message.includes("The hours name 2026-03-05, which is outside the leave's"),
      ),
    ).toBe(true)
  })

  it('refuses an hours holiday on a first import, where only the file names the country', async () => {
    // The account as LDAP left it: no country, so nothing on record names a
    // calendar. The run itself writes the file's code onto the profile and
    // then replays against THAT calendar, so validation has to resolve it the
    // same way; reading only the stored columns left this check silent on
    // exactly the run it exists for.
    await domain.upsertUser({
      userId: testUuid('user-anna'),
      email: 'anna@example.com',
      displayName: 'anna',
      createdAt: '2026-08-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(domain, {
      countryCode: 'PL',
      year: 2026,
      holidays: [{ date: '2026-03-04', name: 'Test holiday' }],
    })

    const report = await service.validate(
      {
        fn: 'combined',
        targetYear: 2026,
        mode: 'add',
        employees: [employeeRow({ countryCode: 'PL' })],
        history: [historyRow({ hoursByDate: { '2026-03-04': 4 } })],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.message.includes(
          'The hours name 2026-03-04, which this leave does not charge',
        ),
      ),
    ).toBe(true)
    expect(
      report.issues.some((issue) =>
        issue.message.includes('a public holiday in the PL calendar'),
      ),
    ).toBe(true)
  })

  it('refuses a holiday named in the hours of a leave that spans it', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedHolidayCalendar(domain, {
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-03-04', name: 'Test holiday' }],
    })

    const report = await service.validate(
      {
        fn: 'leave-history',
        targetYear: 2026,
        mode: 'add',
        history: [historyRow({ hoursByDate: { '2026-03-04': 4 } })],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.message.includes(
          'The hours name 2026-03-04, which this leave does not charge',
        ),
      ),
    ).toBe(true)
  })
})

// The preview's grouping IS the apply's grouping: both read the row through
// policyTermsFromImportRow, so what the operator approves on screen is what the
// catalog gets. Before that, the preview fingerprinted four of the six terms as
// their defaults and grouped by the two allowances alone.
describe('policy grouping by the row terms', () => {
  const steppedRow = (email: string): EmployeeImportRowDto =>
    employeeRow({
      email,
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
    })

  it('splits offers that share a base but differ in the rise', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')
    await seedDirectoryUser('vera', 'vera@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          // Flat, every year, and every three years: one 25+5 base, three deals.
          employeeRow(),
          employeeRow({
            email: 'boris@example.com',
            vacationAnnualIncrement: 5,
          }),
          steppedRow('vera@example.com'),
        ],
      },
      ADMIN,
    )

    expect(report.policiesToCreate).toHaveLength(3)
    expect(
      report.policiesToCreate.map((policy) => policy.memberEmails),
    ).toEqual([
      ['anna@example.com'],
      ['boris@example.com'],
      ['vera@example.com'],
    ])
    expect(report.policiesToCreate.map((policy) => policy.plannedName)).toEqual([
      'Imported 25+5',
      'Imported 25+5, +5/yr',
      'Imported 25+5, +5/3yr',
    ])
    // The period is the last component and only the stepped deal carries it.
    expect(report.policiesToCreate[1]?.termsFingerprint).toBe(
      'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0',
    )
    expect(report.policiesToCreate[2]?.termsFingerprint).toBe(
      'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0;vy=3',
    )
  })

  it('mints the policy under the very fingerprint the preview showed', async () => {
    await seedDirectoryUser('vera', 'vera@example.com')
    const row = steppedRow('vera@example.com')

    const report = await service.validate(
      { fn: 'user-data', targetYear: 2026, mode: 'add', employees: [row] },
      ADMIN,
    )
    const applied = await service.applyEmployee(
      request({ employee: row }),
      ADMIN,
    )

    expect(applied.status).toBe('applied')
    const created = await dataSource
      .getRepository(LeavePolicyEntity)
      .findOneBy({ termsFingerprint: report.policiesToCreate[0]!.termsFingerprint })
    expect(created?.vacationIncrementEveryYears).toBe(3)
    expect(created?.vacationAnnualIncrement).toBe(5)
    // Nothing else was minted: the preview promised exactly this one policy.
    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(1)
  })

  it('applies the operator name to the group it was typed for, not to its base twin', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('vera', 'vera@example.com')

    // The wizard sends the chosen name with the employee it belongs to; the
    // second row shares the 25+5 base and must keep its own terms and name.
    const named = await service.applyEmployee(
      request({
        employee: steppedRow('vera@example.com'),
        policyName: 'Senior UA',
      }),
      ADMIN,
    )
    const other = await service.applyEmployee(
      request({ employee: employeeRow() }),
      ADMIN,
    )

    expect(named.status).toBe('applied')
    expect(other.status).toBe('applied')
    if (named.status !== 'applied' || other.status !== 'applied') {
      return
    }
    expect(named.plan.policy.policyName).toBe('Senior UA')
    expect(other.plan.policy.policyName).toBe('Imported 25+5')
    const policies = await dataSource.getRepository(LeavePolicyEntity).find()
    expect(policies).toHaveLength(2)
    expect(
      policies.find((policy) => policy.name === 'Senior UA')
        ?.vacationIncrementEveryYears,
    ).toBe(3)
    expect(
      policies.find((policy) => policy.name === 'Imported 25+5')
        ?.vacationIncrementEveryYears,
    ).toBe(1)
  })

  it('refuses a period the writer cannot hold rather than rounding it into one', async () => {
    await seedDirectoryUser('vera', 'vera@example.com')

    // Blocked at validation, so the file is fixed before the run starts.
    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          employeeRow({
            email: 'vera@example.com',
            vacationAnnualIncrement: 5,
            vacationIncrementEveryYears: 0,
          }),
        ],
      },
      ADMIN,
    )
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.message).toContain(
      'whole number of years between 1 and 50',
    )

    const result = await service.previewEmployee(
      request({
        employee: employeeRow({
          email: 'vera@example.com',
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 2.5,
        }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') {
      return
    }
    expect(result.message).toContain('whole number between 1 and 50')
  })

  it('ignores the period column on a row that carries no rise', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')

    // A converted tracker fills "Increase every" for everyone, including the
    // sixty people whose deal never rises. An inert period is thrown away
    // before the writer sees it, so refusing these rows would block a whole run
    // over cells that change nothing.
    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          employeeRow({ vacationIncrementEveryYears: 0 }),
          // An increment that quantizes to nothing IS no increment, so its
          // period is inert too: the row-level test and the coercion agree.
          employeeRow({
            email: 'boris@example.com',
            vacationAnnualIncrement: 0.001,
            vacationIncrementEveryYears: 99.5,
          }),
        ],
      },
      ADMIN,
    )

    expect(report.ok).toBe(true)
    // Both rows are the same flat 25+5 deal, so they cannot fingerprint apart.
    expect(report.policiesToCreate).toHaveLength(1)
    expect(report.policiesToCreate[0]?.termsFingerprint).toBe(
      'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
    )

    // The same cell on a row that DOES rise is still refused: there the period
    // decides how often the days arrive.
    const rising = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          employeeRow({
            vacationAnnualIncrement: 5,
            vacationIncrementEveryYears: 0,
          }),
        ],
      },
      ADMIN,
    )
    expect(rising.ok).toBe(false)
    expect(rising.issues[0]?.message).toContain(
      'whole number of years between 1 and 50',
    )

    const applied = await service.applyEmployee(
      request({ employee: employeeRow({ vacationIncrementEveryYears: 0 }) }),
      ADMIN,
    )

    expect(applied.status).toBe('applied')
    expect(
      await dataSource.getRepository(LeavePolicyEntity).findOneBy({
        termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
      }),
    ).toMatchObject({
      vacationAnnualIncrement: 0,
      vacationIncrementEveryYears: 1,
    })
  })

  it('reports every term the named policy holds differently, the period included', async () => {
    const userId = await seedDirectoryUser('vera', 'vera@example.com')
    // The round trip an operator actually performs: the export gives every row
    // its policy name, so a file edited in the "Increase every" column comes
    // back naming a catalog policy whose rule it no longer matches.
    const named = await dataSource.getRepository(LeavePolicyEntity).save({
      id: testUuid('policy-senior'),
      name: 'Senior UA',
      description: null,
      vacationDays: 25,
      sickDays: 5,
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
      vacationIncrementCapDays: null,
      probationMonths: 0,
      paidSickDuringProbation: false,
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      isDefault: false,
      termsFingerprint: 'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0;vy=3',
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = await service.applyEmployee(
      request({
        employee: employeeRow({
          email: 'vera@example.com',
          policyName: 'Senior UA',
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 1,
        }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(
      result.plan.issues.find((issue) => issue.message.includes('Senior UA'))
        ?.message,
    ).toContain('increase period in years 3 rather than 1')
    // The catalog decides: no near-twin was minted, and the rule that governs
    // the employee is the one the catalog holds, not the one the file states.
    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(1)
    const membership = await dataSource
      .getRepository(LeavePolicyMembershipEntity)
      .findOneBy({ userId, supersededByRowId: IsNull() })
    expect(membership?.policyId).toBe(named.id)
    expect(
      (
        await dataSource
          .getRepository(LeavePolicyEntity)
          .findOneBy({ id: named.id })
      )?.vacationIncrementEveryYears,
    ).toBe(3)
  })
})

/**
 * The preview describes what the APPLY will do, because both run resolvePolicy
 * over the same rules. Every case here is one where the two used to disagree:
 * the preview predicted from the row's terms alone while the apply resolves by
 * the file's name first, so it promised policies that were joined instead, kept
 * a rename box for names that could not be changed, and waved through rows the
 * enrollment then refused.
 */
describe('policy preview parity with the apply', () => {
  const seedPolicy = async (input: {
    name: string
    vacationDays?: number
    sickDays?: number
    effectiveFrom?: string
    effectiveTo?: string
  }): Promise<string> => {
    const policy = await domain.createPolicy({
      name: input.name,
      vacationDays: input.vacationDays ?? 25,
      sickDays: input.sickDays ?? 5,
      effectiveFrom: input.effectiveFrom ?? '2015-01-01',
      effectiveTo: input.effectiveTo ?? null,
      audit: ADMIN,
    })
    return policy.policyId
  }

  const validateRows = async (
    employees: EmployeeImportRowDto[],
  ): Promise<Awaited<ReturnType<LeaveImportService['validate']>>> =>
    service.validate(
      { fn: 'user-data', targetYear: 2026, mode: 'add', employees },
      ADMIN,
    )

  it('tells an increment and a probation apart from their flat twin, preview and apply agreeing', async () => {
    // The old defect this pins against: grouping used to fingerprint every
    // row with hardcoded flat terms (increment 0, no cap, no probation), so a
    // 25+5 row carrying +2/yr previewed as "reuse the flat 25+5" and then
    // minted a brand-new policy at apply time. Preview and run now share one
    // resolver, and these three rows prove it on both sides.
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')
    await seedDirectoryUser('vera', 'vera@example.com')
    const flatId = await seedPolicy({ name: 'Flat 25+5' })
    const rising = employeeRow({
      vacationDaysPerYear: 25,
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 30,
      carriedOverVacationDays: undefined,
    })
    const probation = employeeRow({
      email: 'boris@example.com',
      probationMonths: 3,
      carriedOverVacationDays: undefined,
    })
    const flat = employeeRow({
      email: 'vera@example.com',
      carriedOverVacationDays: undefined,
    })

    const report = await validateRows([rising, probation, flat])

    // The extra terms set both rows apart from the flat twin: two mints, and
    // only the genuinely flat row lands on the existing policy.
    expect(report.policiesToCreate).toHaveLength(2)
    expect(
      report.policiesToCreate.map((policy) => policy.termsFingerprint).sort(),
    ).toEqual([
      'v=25.00;s=5.00;vi=0.00;vc=none;p=3;ps=0',
      'v=25.00;s=5.00;vi=2.00;vc=30.00;p=0;ps=0',
    ])
    expect(report.policiesToReuse).toHaveLength(1)
    expect(report.policiesToReuse[0]).toMatchObject({
      policyId: flatId,
      matchedBy: 'terms',
      memberEmails: ['vera@example.com'],
    })

    // The apply lands exactly where the preview said: the incremented row
    // mints its policy, the flat row joins the existing one, nothing else
    // appears in the catalog.
    const before = await dataSource.getRepository(LeavePolicyEntity).count()
    expect((await service.applyEmployee(request({ employee: rising }), ADMIN)).status).toBe('applied')
    expect((await service.applyEmployee(request({ employee: flat }), ADMIN)).status).toBe('applied')
    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(before + 1)
    const minted = await dataSource.getRepository(LeavePolicyEntity).findOneBy({
      termsFingerprint: 'v=25.00;s=5.00;vi=2.00;vc=30.00;p=0;ps=0',
    })
    expect(minted).toMatchObject({
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 30,
    })
    const veraMembership = await dataSource
      .getRepository(LeavePolicyMembershipEntity)
      .findOneBy({ userId: testUuid('user-vera'), supersededByRowId: IsNull() })
    expect(veraMembership?.policyId).toBe(flatId)
  })

  it('previews a named row on an existing policy as reuse, and applies it as one', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const policyId = await seedPolicy({ name: 'Senior UA', vacationDays: 28 })
    const row = employeeRow({ policyName: 'Senior UA' })

    const report = await validateRows([row])

    expect(report.policiesToCreate).toEqual([])
    expect(report.policiesToReuse).toEqual([
      {
        policyId,
        policyName: 'Senior UA',
        // The catalog's figures, not the row's 25: after a name match the row's
        // own numbers are not the deal anybody ends up on.
        vacationDaysPerYear: 28,
        sickDaysPerYear: 5,
        matchedBy: 'name',
        retired: false,
        termsDiffer: true,
        memberEmails: ['anna@example.com'],
      },
    ])
    // The disagreement is a warning in the words the apply uses, not a blocker.
    expect(report.ok).toBe(true)
    const warned = report.issues.find((issue) =>
      issue.message.includes('Senior UA'),
    )
    expect(warned?.severity).toBe('warning')
    expect(warned?.message).toContain('vacation days 28 rather than 25')

    const applied = await service.applyEmployee(request({ employee: row }), ADMIN)

    expect(applied.status).toBe('applied')
    if (applied.status !== 'applied') {
      return
    }
    expect(applied.plan.policy).toMatchObject({
      policyName: 'Senior UA',
      vacationDaysPerYear: 28,
      willBeCreated: false,
    })
    expect(applied.plan.issues[0]?.message).toBe(warned?.message)
    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(1)
  })

  it('previews a named row with no matching policy exactly as the apply mints it', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const row = employeeRow({ policyName: 'Contractors' })

    const report = await validateRows([row])

    expect(report.policiesToCreate).toEqual([
      {
        termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
        vacationDaysPerYear: 25,
        sickDaysPerYear: 5,
        plannedName: 'Contractors',
        nameSource: 'file',
        // The file decides the name, so the wizard has nothing to offer: the
        // typed value would lose to the row's own column anyway.
        renameable: false,
        memberEmails: ['anna@example.com'],
      },
    ])

    const applied = await service.applyEmployee(
      // The operator's name travels too, and still loses to the column.
      request({ employee: row, policyName: 'Something else' }),
      ADMIN,
    )

    expect(applied.status).toBe('applied')
    const policies = await dataSource.getRepository(LeavePolicyEntity).find()
    expect(policies.map((policy) => policy.name)).toEqual(['Contractors'])
  })

  it('offers exactly one rename, for the group whose name is not in the file', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')

    const report = await validateRows([
      employeeRow({ policyName: 'Contractors', vacationDaysPerYear: 20 }),
      employeeRow({ email: 'boris@example.com' }),
    ])

    expect(
      report.policiesToCreate.map((policy) => [
        policy.plannedName,
        policy.renameable,
      ]),
    ).toEqual([
      ['Contractors', false],
      ['Imported 25+5', true],
    ])
  })

  it('takes the rename away from a derived name another row asks for by name', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')

    // The second row points at the name the first row's group will be minted
    // under. Renaming that group would split it at apply time, so the box goes.
    const report = await validateRows([
      employeeRow(),
      employeeRow({ email: 'boris@example.com', policyName: 'imported 25+5' }),
    ])

    expect(report.policiesToCreate).toHaveLength(1)
    expect(report.policiesToCreate[0]).toMatchObject({
      plannedName: 'Imported 25+5',
      nameSource: 'suggested',
      renameable: false,
      memberEmails: ['anna@example.com', 'boris@example.com'],
    })
  })

  it('gives two rows naming one absent policy a single group', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')

    const rows = [
      employeeRow({ policyName: 'Contractors', vacationDaysPerYear: 20 }),
      employeeRow({
        email: 'boris@example.com',
        policyName: 'Contractors',
        vacationDaysPerYear: 20,
      }),
    ]
    const report = await validateRows(rows)

    expect(report.policiesToCreate).toHaveLength(1)
    expect(report.policiesToCreate[0]?.memberEmails).toEqual([
      'anna@example.com',
      'boris@example.com',
    ])

    for (const employee of rows) {
      expect((await service.applyEmployee(request({ employee }), ADMIN)).status).toBe(
        'applied',
      )
    }
    // The growing catalog is what makes the two rows one group: the second row
    // joins what the first is about to mint, exactly as the second transaction
    // of the apply joins what the first one created.
    expect(await dataSource.getRepository(LeavePolicyEntity).count()).toBe(1)
  })

  it('joins the live twin the terms point at, whatever name the file states', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    const policyId = await seedPolicy({ name: 'Standard UA' })

    // Found while the resolver was built: a name absent from the catalog does
    // NOT mint under itself while a live policy holds the row's terms. The
    // apply joins that policy and drops the name in silence, so the preview has
    // to say "matched on the terms" rather than promise a "Contractors".
    const report = await validateRows([employeeRow({ policyName: 'Contractors' })])

    expect(report.policiesToCreate).toEqual([])
    expect(report.policiesToReuse[0]).toMatchObject({
      policyId,
      policyName: 'Standard UA',
      matchedBy: 'terms',
      termsDiffer: false,
    })
  })

  it('blocks a row pointing at a retired policy, in the words the apply uses', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedPolicy({
      name: 'Legacy UA',
      vacationDays: 28,
      effectiveTo: '2024-12-31',
    })
    const row = employeeRow({ policyName: 'Legacy UA' })

    const report = await validateRows([row])

    // Blocking, by the same convention as the file's overlapping rows: without
    // it the run reaches step 3 and fails there, naming a policy the preview
    // never showed.
    expect(report.ok).toBe(false)
    const blocker = report.issues.find(
      (issue) => issue.severity === 'error' && issue.email === 'anna@example.com',
    )
    expect(blocker?.message).toContain(
      'Policy "Legacy UA" is retired and cannot take new members.',
    )
    expect(report.policiesToReuse[0]).toMatchObject({
      policyName: 'Legacy UA',
      matchedBy: 'name',
      retired: true,
    })

    const applied = await service.applyEmployee(request({ employee: row }), ADMIN)

    expect(applied.status).toBe('failed')
    if (applied.status !== 'failed') {
      return
    }
    expect(applied.message).toContain(
      'Policy "Legacy UA" is retired and cannot take new members.',
    )
  })

  it('blocks terms colliding with an expired twin, and mints outside its window', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')
    await seedPolicy({
      name: 'Standard 2024',
      effectiveFrom: '2024-01-01',
      effectiveTo: '2024-12-31',
    })

    // createPolicyTx refuses to mint around a twin whose window still covers
    // the hire date, so the apply sits on the expired policy and the
    // enrollment then refuses the employee.
    const inside = await validateRows([
      employeeRow({ employmentStartDate: '2024-06-01' }),
    ])
    expect(inside.ok).toBe(false)
    expect(
      inside.issues.some((issue) => issue.message.includes('Standard 2024')),
    ).toBe(true)
    expect(inside.policiesToReuse[0]).toMatchObject({
      policyName: 'Standard 2024',
      matchedBy: 'terms',
      retired: true,
    })

    // Past the window, re-introducing the era's terms is legitimate.
    const outside = await validateRows([
      employeeRow({ email: 'boris@example.com', employmentStartDate: '2025-01-01' }),
    ])
    expect(outside.ok).toBe(true)
    expect(outside.policiesToCreate[0]?.plannedName).toBe('Imported 25+5')
  })

  it('plans the numbered name the writer will really use', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    // A policy holding the derived name under DIFFERENT terms: the name rule
    // cannot join it, so the mint climbs the ladder rather than colliding.
    await seedPolicy({ name: 'imported 25+5', vacationDays: 18 })

    const report = await validateRows([employeeRow()])

    expect(report.policiesToCreate[0]?.plannedName).toBe('Imported 25+5 (2)')

    const applied = await service.applyEmployee(
      request({ employee: employeeRow() }),
      ADMIN,
    )

    expect(applied.status).toBe('applied')
    if (applied.status !== 'applied') {
      return
    }
    expect(applied.plan.policy.policyName).toBe('Imported 25+5 (2)')
  })
})

// Figures the books cannot hold exactly. The import used to take them and
// quantize them out of sight; every one of these must now say so. Which
// quantum applies depends on what the figure IS: a booking sits on the hour
// grid, a policy term on two decimals, and a balance on the day quantum, since
// accrual mints twelfths of a day into it.
describe('unrepresentable figures', () => {
  it('carries in an accrual remainder verbatim, off the hour grid as it is', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    // What a 25-day allowance leaves after seven months: 25 * 7/12. The engine
    // computes this figure itself, so the file may state it and the books must
    // hold it exactly.
    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [employeeRow({ carriedOverVacationDays: 14.583 })],
      },
      ADMIN,
    )
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])

    const result = await service.applyEmployee(
      request({ employee: employeeRow({ carriedOverVacationDays: 14.583 }) }),
      ADMIN,
    )
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    expect(result.plan.carriedOverVacationDays).toBe(14.583)
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(Number(allocation?.carriedOverDays)).toBe(14.583)
  })

  it('quantizes a carryover finer than the books and names what it will store', async () => {
    const userId = await seedDirectoryUser('anna', 'anna@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [employeeRow({ carriedOverVacationDays: 7.30051 })],
      },
      ADMIN,
    )

    // A judgement about the prior year, not an error: the file still imports.
    expect(report.ok).toBe(true)
    expect(
      report.issues.some((issue) =>
        issue.message.includes(
          'The carried-over days of 7.30051 are stored to three decimals, so 7.301 will be carried in',
        ),
      ),
    ).toBe(true)

    const result = await service.applyEmployee(
      request({ employee: employeeRow({ carriedOverVacationDays: 7.30051 }) }),
      ADMIN,
    )
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    // The card promises the figure the books hold, not the finer one stated.
    expect(result.plan.carriedOverVacationDays).toBe(7.301)
    const allocation = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(Number(allocation?.carriedOverDays)).toBe(7.301)
  })

  it('refuses a carryover that is not a number, negative or absurd', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')
    await seedDirectoryUser('boris', 'boris@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [
          employeeRow({ carriedOverVacationDays: -1 }),
          employeeRow({
            email: 'boris@example.com',
            carriedOverVacationDays: 4000,
          }),
        ],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    expect(
      report.issues.filter((issue) =>
        issue.message.includes(
          'The carried-over days must be a number between 0 and 365',
        ),
      ),
    ).toHaveLength(2)
  })

  it('re-imports the carryover its own export writes back, off-grid and all', async () => {
    // The restore cycle: reset, then import the exported book. The export
    // writes allocation.carriedOverDays into the carryover column, so whatever
    // the engine can store there the import must be able to read back.
    const userId = await seedDirectoryUser('anna', 'anna@example.com')
    await service.applyEmployee(
      request({ employee: employeeRow({ carriedOverVacationDays: 14.583 }) }),
      ADMIN,
    )
    const stored = Number(
      (
        await dataSource
          .getRepository(LeaveAllocationEntity)
          .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
      )?.carriedOverDays,
    )

    const roundTrip = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'override',
        employees: [employeeRow({ carriedOverVacationDays: stored })],
      },
      ADMIN,
    )

    expect(roundTrip.ok).toBe(true)
    expect(roundTrip.issues).toEqual([])

    const reapplied = await service.applyEmployee(
      request({
        mode: 'override',
        employee: employeeRow({ carriedOverVacationDays: stored }),
      }),
      ADMIN,
    )
    expect(reapplied.status).toBe('applied')
    const after = await dataSource
      .getRepository(LeaveAllocationEntity)
      .findOneBy({ userId, leaveType: LeaveType.Vacation, year: 2026 })
    expect(Number(after?.carriedOverDays)).toBe(14.583)
  })

  it('names the figure a policy term will actually be stored as', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        // A prorated cell (25 * 10/12) written out in full.
        employees: [employeeRow({ vacationDaysPerYear: 20.8333 })],
      },
      ADMIN,
    )

    // A judgement about the offer, not an error: the file still imports.
    expect(report.ok).toBe(true)
    expect(
      report.issues.some((issue) =>
        issue.message.includes(
          'The vacation allowance of 20.8333 is stored to two decimals, so the policy will grant 20.83',
        ),
      ),
    ).toBe(true)
  })

  it('refuses a probation length that is not whole months', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const report = await service.validate(
      {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        employees: [employeeRow({ probationMonths: 1.5 })],
      },
      ADMIN,
    )

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.message.includes('whole number of months'),
      ),
    ).toBe(true)
  })

  it('keeps the reconciliation delta at the books three decimals', async () => {
    await seedDirectoryUser('anna', 'anna@example.com')

    const result = await service.applyEmployee(
      request({
        // An expectation exactly one hour under the granted sick tranche: at
        // two decimals the delta read 0.13, a figure neither side holds, on the
        // very number the card now judges by the hour.
        employee: employeeRow({ expectedSickBalance: 4.875 }),
      }),
      ADMIN,
    )

    expect(result.status).toBe('applied')
    if (result.status !== 'applied') {
      return
    }
    const sick = result.plan.reconciliation.find(
      (entry) => entry.leaveType === LeaveType.Sick,
    )
    expect(sick?.delta).toBe(0.125)
  })
})


// The import legitimately leaves a balance OVERDRAWN: the office trackers let
// leave run ahead of the accrual curve until the monthly tranches catch up.
// That state must read as transient, not broken. A guard that compared what
// was spent against what has accrued BY TODAY branded these employees broken
// for months: every composer candidate came back fully unpaid (even one placed
// where the curve has long caught up), and every admin re-anchor refused. The
// yardstick is what the year will EVER accrue.
describe('imported overdraft and forward planning', () => {
  // Yana's shape: 15-day policy, hired 2024, 13 weekday leaves booked by
  // August while only 10 have accrued. Every date below is a plain weekday
  // (the seeded calendar is confirmed-empty), so the engine prices the rows
  // at exactly the stated working days.
  const importOverdrawn = async (): Promise<string> => {
    const userId = await seedDirectoryUser('yana', 'yana@example.com')
    const day = (
      startDate: string,
      endDate: string,
      workingDays: number,
    ): LeaveHistoryImportRowDto =>
      historyRow({
        email: 'yana@example.com',
        startDate,
        endDate,
        workingDays,
        submittedAt: undefined,
        approvedAt: undefined,
      })
    const result = await service.applyEmployee(
      request({
        fn: 'combined',
        employee: employeeRow({
          email: 'yana@example.com',
          displayName: 'Yana',
          employmentStartDate: '2024-04-02',
          vacationDaysPerYear: 15,
          sickDaysPerYear: 5,
          carriedOverVacationDays: undefined,
        }),
        history: [
          day('2026-01-26', '2026-01-27', 2),
          day('2026-01-30', '2026-01-30', 1),
          day('2026-03-06', '2026-03-12', 5),
          day('2026-04-29', '2026-04-29', 1),
          day('2026-06-19', '2026-06-19', 1),
          day('2026-06-25', '2026-06-26', 2),
          day('2026-06-29', '2026-06-29', 1),
        ],
      }),
      ADMIN,
    )
    expect(result.status).toBe('applied')
    return userId
  }

  it('funds a request placed where the curve catches up, and only that one', async () => {
    const userId = await importOverdrawn()

    const balance = await domain.getBalance(userId, LeaveType.Vacation)
    expect(balance.spentDays).toBeCloseTo(13)
    expect(balance.accruedDays).toBeCloseTo(10)

    // December: 15 will have accrued by then, 13 of it already taken - both
    // days are funded even though the balance reads -3 today.
    const december = await domain.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-12-30',
      endDate: '2026-12-31',
    })
    expect(december.blockers).toEqual([])
    expect(december.requestedDays).toBe(2)
    expect(december.paidDays).toBe(2)
    expect(december.unpaidDays).toBe(0)

    // Next week the curve still reads 10 against 13 spent: unpaid, as before.
    const nearTerm = await domain.previewLeaveAvailability({
      userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-10',
      endDate: '2026-08-11',
    })
    expect(nearTerm.paidDays).toBe(0)
    expect(nearTerm.unpaidDays).toBe(2)
  })

  it('re-anchors freely while the year can absorb the overdraft, refuses when it cannot', async () => {
    const userId = await importOverdrawn()

    // A prior-year start-date correction leaves the 2026 curve at 15 >= 13:
    // legal, and refused before the guard measured against year end.
    await domain.updateEmployeeAdmin({
      userId,
      employmentStartDate: '2024-05-01',
    })
    expect(
      (await domain.getUser(userId))?.employmentStartDate,
    ).toBe('2024-05-01')

    // Moving the start into July 2026 prorates the year to 7.5 days: what is
    // already spent can never accrue, and the guard names the year-end figure.
    await expect(
      domain.updateEmployeeAdmin({
        userId,
        employmentStartDate: '2026-07-01',
      }),
    ).rejects.toThrow(/you would have committed/)
  })
})
