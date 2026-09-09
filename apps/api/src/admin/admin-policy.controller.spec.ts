/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,

} from 'vitest'
import type { DataSource } from 'typeorm'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { PATH_METADATA, GUARDS_METADATA } from '@nestjs/common/constants'
import { JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { AppRoleName, AuditEventType, LeaveType } from '@workspace/contracts'
import { AdminPolicyController } from './admin-policy.controller'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { NotificationService } from '../domain/notification.service'
import { LeavePolicyMembershipEntity } from '../domain/entities/leave-policy-membership.entity'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'

// Stage 5: the admin HTTP surface of the policy engine. Same harness as the
// other admin controller specs — a real Postgres, real services, hand-built
// profiles (the guards never run here, so authorization is asserted by
// calling the methods with a non-admin profile).

let dataSource: DataSource
let service: LeaveDomainService
let auditLog: AuditLogService
let controller: AdminPolicyController
let clock: ClockService
let adminUser: UserProfileType
let employeeUser: UserProfileType

const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-07-15T12:00:00.000Z'

const createPolicy = (
  name: string,
  vacationDays: number,
  sickDays: number,
  extra: Record<string, unknown> = {},
) =>
  controller.createPolicy(adminUser, {
    name,
    vacationDays,
    sickDays,
    effectiveFrom: '2026-01-01',
    ...extra,
  } as never)

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
  auditLog = new AuditLogService(dataSource, clock)
  service = new LeaveDomainService(
    dataSource,
    auditLog,
    clock,
    new NotificationService(dataSource, clock),
  )
  controller = new AdminPolicyController(service)
  await service.updateLeaveSettings({
    defaultVacationDays: 25,
    defaultSickDays: 5,
    defaultApproverEmails: [],
    defaultCcApproverEmails: [],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: T0,
  })
  await seedHolidayCalendar(service, { year: 2026 })
  const admin = await service.upsertUser({
    userId: testUuid('policy-admin'),
    email: 'policy-admin@example.com',
    displayName: 'Policy Admin',
    countryCode: 'UA',
    employmentStartDate: '2020-01-01',
    createdAt: T0,
  })
  const employee = await service.upsertUser({
    userId: testUuid('policy-employee'),
    email: 'policy-employee@example.com',
    displayName: 'Policy Employee',
    countryCode: 'UA',
    employmentStartDate: '2026-01-01',
    createdAt: '2025-12-20T00:00:00.000Z',
  })
  adminUser = {
    id: admin.userId,
    email: admin.email,
    name: admin.displayName,
    roles: [AppRoleName.Employee, AppRoleName.Administrator],
  }
  employeeUser = {
    id: employee.userId,
    email: employee.email,
    name: employee.displayName,
    roles: [AppRoleName.Employee],
  }
})

describe('AdminPolicyController', () => {
  it('registers the admin prefix, the auth guard and literal routes before parameterized ones', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPolicyController)).toBe(
      'admin',
    )
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminPolicyController),
    ).toEqual([JwtAuthGuard])
    const methods = Object.getOwnPropertyNames(AdminPolicyController.prototype)
    expect(methods.indexOf('setDefaultPolicy')).toBeLessThan(
      methods.indexOf('updatePolicy'),
    )
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminPolicyController.prototype.setDefaultPolicy,
      ),
    ).toBe('policies/default')
  })

  it('creates a policy, refuses a duplicate deal with the twin identity, and refuses a repeated name', async () => {
    const created = await createPolicy('Standard', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 35,
      probationMonths: 3,
    })
    expect(created.name).toBe('Standard')
    expect(created.memberCount).toBe(0)
    expect(created.termsFingerprint).toBe(
      'v=25.00;s=5.00;vi=2.00;vc=35.00;p=3;ps=0',
    )

    // Identical terms under a different name: refused, and the payload names
    // the existing policy so the dialog can offer it.
    const duplicate = createPolicy('Standard copy', 25, 5, {
      vacationAnnualIncrement: 2,
      vacationIncrementCapDays: 35,
      probationMonths: 3,
    })
    await expect(duplicate).rejects.toBeInstanceOf(ConflictException)
    await duplicate.catch((error: ConflictException) => {
      const body = error.getResponse() as Record<string, unknown>
      expect(body['code']).toBe('duplicate_policy_terms')
      expect(body['existingPolicyId']).toBe(created.policyId)
      expect(body['existingPolicyName']).toBe('Standard')
    })

    await expect(createPolicy('standard', 10, 0)).rejects.toThrowError(
      'already exists',
    )
    // The inert flag combination is refused so dedup stays canonical.
    await expect(
      createPolicy('Bad flag', 15, 5, { paidSickDuringProbation: true }),
    ).rejects.toThrowError('probation period')
  })

  it('stores a periodic increment, fingerprints its period and refuses its twin', async () => {
    const every3 = await createPolicy('Ukraine 15+5/3yr', 15, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 3,
      vacationIncrementCapDays: 25,
    })
    expect(every3.vacationIncrementEveryYears).toBe(3)
    expect(every3.termsFingerprint).toBe(
      'v=15.00;s=5.00;vi=5.00;vc=25.00;p=0;ps=0;vy=3',
    )

    // The same deal under another name is a duplicate.
    await expect(
      createPolicy('Ukraine copy', 15, 5, {
        vacationAnnualIncrement: 5,
        vacationIncrementEveryYears: 3,
        vacationIncrementCapDays: 25,
      }),
    ).rejects.toBeInstanceOf(ConflictException)

    // A different period is a different deal, so it is NOT a duplicate.
    const every2 = await createPolicy('Ukraine 15+5/2yr', 15, 5, {
      vacationAnnualIncrement: 5,
      vacationIncrementEveryYears: 2,
      vacationIncrementCapDays: 25,
    })
    expect(every2.termsFingerprint).toBe(
      'v=15.00;s=5.00;vi=5.00;vc=25.00;p=0;ps=0;vy=2',
    )
  })

  it('coerces an inert period to 1 so it cannot mint a behavioral twin', async () => {
    // No increment: period 3 behaves exactly like period 1, so it is stored as
    // 1 and collides with the plain deal instead of fingerprinting apart.
    const flat = await createPolicy('Flat 20+5', 20, 5, {
      vacationIncrementEveryYears: 3,
    })
    expect(flat.vacationIncrementEveryYears).toBe(1)
    expect(flat.termsFingerprint).toBe('v=20.00;s=5.00;vi=0.00;vc=none;p=0;ps=0')
    await expect(
      createPolicy('Flat 20+5 again', 20, 5, {
        vacationIncrementEveryYears: 7,
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('refuses a period that is not a whole number of years from 1 to 50', async () => {
    for (const period of [0, -1, 2.5, 51]) {
      await expect(
        createPolicy(`Bad period ${period}`, 20, 5, {
          vacationAnnualIncrement: 2,
          vacationIncrementEveryYears: period,
        }),
      ).rejects.toThrowError('vacationIncrementEveryYears')
      // The refusal lives in the domain, not only in the HTTP validator: the
      // history import mints policies without passing through a controller,
      // and a period of 0 divides by zero in the rate formula.
      await expect(
        service.createPolicy({
          name: `Bad domain period ${period}`,
          vacationDays: 20,
          sickDays: 5,
          vacationAnnualIncrement: 2,
          vacationIncrementEveryYears: period,
          effectiveFrom: '2026-01-01',
        }),
      ).rejects.toThrowError('vacationIncrementEveryYears')
    }
    // Both ends of the range are accepted.
    expect(
      (
        await createPolicy('Period 1', 20, 5, {
          vacationAnnualIncrement: 2,
          vacationIncrementEveryYears: 1,
        })
      ).vacationIncrementEveryYears,
    ).toBe(1)
    expect(
      (
        await createPolicy('Period 50', 20, 5, {
          vacationAnnualIncrement: 2,
          vacationIncrementEveryYears: 50,
        })
      ).vacationIncrementEveryYears,
    ).toBe(50)
  })

  it('refuses term edits through the patch route', async () => {
    const policy = await createPolicy('Patchable', 20, 5)
    await expect(
      controller.updatePolicy(adminUser, policy.policyId, {
        vacationDays: 30,
      } as never),
    ).rejects.toThrowError('immutable')
    // The period is a term too: absent from termFields it would be the one
    // term a PATCH could silently rewrite.
    const patchPeriod = controller.updatePolicy(adminUser, policy.policyId, {
      vacationIncrementEveryYears: 3,
    } as never)
    await expect(patchPeriod).rejects.toThrowError('immutable')
    await expect(patchPeriod).rejects.toThrowError('vacationIncrementEveryYears')
    const renamed = await controller.updatePolicy(adminUser, policy.policyId, {
      name: 'Renamed',
      description: 'why it exists',
    })
    expect(renamed.name).toBe('Renamed')
  })

  it('refuses retirement while a membership would outlive the policy', async () => {
    const policy = await createPolicy('Retiring', 20, 5)
    const other = await createPolicy('Successor', 22, 5)
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: policy.policyId,
      effectiveDate: '2026-07-15',
    })
    await expect(
      controller.updatePolicy(adminUser, policy.policyId, {
        effectiveTo: '2026-12-31',
      }),
    ).rejects.toThrowError('would outlive it')

    // With the member scheduled out before that date, retirement is allowed.
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: other.policyId,
      effectiveDate: '2026-09-01',
    })
    const retired = await controller.updatePolicy(adminUser, policy.policyId, {
      effectiveTo: '2026-12-31',
    })
    expect(retired.effectiveTo).toBe('2026-12-31')
    // A retiring policy takes no new members and cannot become the default.
    await expect(
      controller.setDefaultPolicy(adminUser, { policyId: policy.policyId }),
    ).rejects.toThrowError('never expire')
  })

  it('swaps the default flag atomically', async () => {
    const first = await createPolicy('First default', 20, 5)
    const second = await createPolicy('Second default', 22, 5)
    await controller.setDefaultPolicy(adminUser, { policyId: first.policyId })
    const after = await controller.setDefaultPolicy(adminUser, {
      policyId: second.policyId,
    })
    expect(after.filter((policy) => policy.isDefault)).toHaveLength(1)
    expect(after.find((policy) => policy.isDefault)?.policyId).toBe(
      second.policyId,
    )
  })

  it('deletes only a never-referenced policy', async () => {
    const unused = await createPolicy('Unused', 12, 3)
    const used = await createPolicy('Used', 14, 3)
    const fallback = await createPolicy('Fallback', 16, 3)
    await controller.setDefaultPolicy(adminUser, {
      policyId: fallback.policyId,
    })
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: used.policyId,
      effectiveDate: '2026-07-15',
    })

    expect(await controller.deletePolicy(adminUser, unused.policyId)).toEqual({
      deleted: true,
    })
    await expect(
      controller.deletePolicy(adminUser, used.policyId),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      controller.deletePolicy(adminUser, fallback.policyId),
    ).rejects.toThrowError('default policy cannot be deleted')
  })

  it('transfers through the endpoint, previews without writing, and reports the timeline', async () => {
    const from = await createPolicy('From 15', 15, 5)
    const to = await createPolicy('To 25', 25, 5)
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: from.policyId,
      effectiveDate: '2026-07-15',
    })

    const membershipRepo = dataSource.getRepository(LeavePolicyMembershipEntity)
    const before = await membershipRepo.count()
    const preflight = await controller.preflightPolicyTransfer(
      adminUser,
      employeeUser.id,
      { policyId: to.policyId, effectiveDate: '2026-07-15' },
    )
    expect(preflight.feasible).toBe(true)
    expect(preflight.appliedFrom).toBe('2026-07-15')
    expect(await membershipRepo.count()).toBe(before)

    const detail = await controller.transferEmployeePolicy(
      adminUser,
      employeeUser.id,
      { policyId: to.policyId, effectiveDate: '2026-07-15' },
    )
    expect(detail.policyName).toBe('To 25')
    const timeline = await controller.getEmployeePolicy(
      adminUser,
      employeeUser.id,
    )
    expect(timeline.current.policyName).toBe('To 25')
    expect(timeline.history).toHaveLength(2)
  })

  it('creates the policy inline and schedules a transfer, then cancels it', async () => {
    const current = await createPolicy('Current', 15, 5)
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: current.policyId,
      effectiveDate: '2026-07-15',
    })
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      newPolicy: {
        name: 'Inline created',
        vacationDays: 28,
        sickDays: 5,
        effectiveFrom: '2026-01-01',
      },
      effectiveDate: '2026-10-01',
    })
    const scheduled = await controller.getEmployeePolicy(
      adminUser,
      employeeUser.id,
    )
    expect(scheduled.scheduled?.policyName).toBe('Inline created')

    await controller.cancelScheduledTransfer(adminUser, employeeUser.id)
    const afterCancel = await controller.getEmployeePolicy(
      adminUser,
      employeeUser.id,
    )
    expect(afterCancel.scheduled).toBeUndefined()
    expect(afterCancel.current.policyName).toBe('Current')
  })

  it('audits a transfer the committed-days guard blocks and answers 400', async () => {
    const generous = await createPolicy('Generous', 25, 5)
    const tiny = await createPolicy('Tiny', 1, 0)
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: generous.policyId,
      effectiveDate: '2026-07-15',
    })
    await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-03',
      endDate: '2026-08-14',
      approverEmails: ['policy-admin@example.com'],
      ccEmails: [],
      submittedAt: NOW,
    })

    const blocked = controller.transferEmployeePolicy(
      adminUser,
      employeeUser.id,
      {
        policyId: tiny.policyId,
        effectiveDate: '2026-01-01',
        mode: 'retroactive',
      },
    )
    await expect(blocked).rejects.toBeInstanceOf(BadRequestException)
    const page = await auditLog.getAdminAuditLogs({ limit: 50 })
    expect(
      page.items.some(
        (item) =>
          item.eventType === AuditEventType.PolicyMembershipTransferBlocked,
      ),
    ).toBe(true)
  })

  it('reports the earliest permissible date when a backdate reaches too far', async () => {
    // The policy itself must be old enough, so the refusal is the engine's
    // backdate floor rather than the policy's own validity window.
    const policy = await createPolicy('Backdate target', 22, 5, {
      effectiveFrom: '2020-01-01',
    })
    const attempt = controller.transferEmployeePolicy(
      adminUser,
      employeeUser.id,
      {
        policyId: policy.policyId,
        effectiveDate: '2025-06-01',
        mode: 'retroactive',
      },
    )
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException)
    await attempt.catch((error: BadRequestException) => {
      const body = error.getResponse() as Record<string, unknown>
      expect(body['code']).toBe('backdate_out_of_range')
      expect(body['earliestPermissibleDate']).toBe('2026-01-01')
    })
  })

  it('surfaces the policy on the directory list, its filter options and the dashboard', async () => {
    const policy = await createPolicy('Directory policy', 18, 4, {
      probationMonths: 12,
    })
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: policy.policyId,
      effectiveDate: '2026-07-15',
    })

    const list = await service.getAdminEmployeeList({})
    const row = list.items.find((item) => item.employeeId === employeeUser.id)
    expect(row?.policyName).toBe('Directory policy')
    // The member list inside a policy renders these three, all folded out of
    // the page's existing membership batch.
    expect(row?.policySince).toBe('2026-07-15')
    expect(row?.probationEndsOn).toBe('2027-01-01')
    expect(row?.policyScheduled).toBeUndefined()

    // A future-dated transfer labels the row without becoming its policy.
    const next = await createPolicy('Scheduled destination', 20, 5)
    await controller.transferEmployeePolicy(adminUser, employeeUser.id, {
      policyId: next.policyId,
      effectiveDate: '2026-10-01',
    })
    const scheduledRow = (await service.getAdminEmployeeList({})).items.find(
      (item) => item.employeeId === employeeUser.id,
    )
    expect(scheduledRow?.policyName).toBe('Directory policy')
    expect(scheduledRow?.policyScheduled).toEqual({
      policyName: 'Scheduled destination',
      effectiveFrom: '2026-10-01',
    })

    const filtered = await service.getAdminEmployeeList({
      policyId: policy.policyId,
    })
    expect(filtered.items.map((item) => item.employeeId)).toEqual([
      employeeUser.id,
    ])
    const options = await service.getAdminEmployeeFilterOptions()
    expect(options.policies.map((entry) => entry.name)).toContain(
      'Directory policy',
    )
    const dashboard = await service.getEmployeeDashboard(employeeUser.id)
    expect(dashboard.policyName).toBe('Directory policy')
    expect(dashboard.probationEndsOn).toBe('2027-01-01')
  })

  it('refuses every route to a non-administrator', async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => controller.getPolicies(employeeUser),
      () => createPolicyAs(employeeUser),
      () => controller.setDefaultPolicy(employeeUser, { policyId: 'x' }),
      () => controller.updatePolicy(employeeUser, 'x', { name: 'y' }),
      () => controller.deletePolicy(employeeUser, 'x'),
      () => controller.getEmployeePolicy(employeeUser, employeeUser.id),
      () =>
        controller.preflightPolicyTransfer(employeeUser, employeeUser.id, {
          policyId: 'x',
          effectiveDate: '2026-07-15',
        }),
      () =>
        controller.transferEmployeePolicy(employeeUser, employeeUser.id, {
          policyId: 'x',
          effectiveDate: '2026-07-15',
        }),
      () => controller.cancelScheduledTransfer(employeeUser, employeeUser.id),
    ]
    for (const call of calls) {
      // Wrapped in a promise chain: the guard throws SYNCHRONOUSLY from the
      // non-async handlers, so a bare call() would escape .rejects.
      await expect(Promise.resolve().then(call)).rejects.toThrowError(
        'Administrator access required.',
      )
    }
  })
})

const createPolicyAs = (user: UserProfileType) =>
  controller.createPolicy(user, {
    name: 'Nope',
    vacationDays: 1,
    sickDays: 1,
    effectiveFrom: '2026-01-01',
  })
