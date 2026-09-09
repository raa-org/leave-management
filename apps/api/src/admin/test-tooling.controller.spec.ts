/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { AppRoleName } from '@workspace/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource } from 'typeorm'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import {
  DirectorySyncInProgressError,
  LeaveDomainService,
} from '../domain/leave-domain.service'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import { NotificationService } from '../domain/notification.service'
import { UserEntity } from '../domain/entities/user.entity'
import { LeaveBalanceChangeEntity } from '../domain/entities/leave-balance-change.entity'
import { TestToolingController } from './test-tooling.controller'

describe('TestToolingController', () => {
  let dataSource: DataSource
  let service: LeaveDomainService
  let adminUser: UserProfileType
  let employeeUser: UserProfileType

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource?.destroy()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // ClockService reads TEST_TOOLING_ENABLED once, at construction — so a
  // controller is always built AFTER the flag is set, exactly like a process
  // booted with that environment.
  function makeService(): LeaveDomainService {
    const clock = new ClockService()
    return new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
  }

  function buildController(
    enabled: boolean,
    domain?: LeaveDomainService,
  ): TestToolingController {
    vi.stubEnv('TEST_TOOLING_ENABLED', enabled ? 'true' : 'false')
    return new TestToolingController(new ClockService(), domain ?? makeService())
  }

  beforeEach(async () => {
    await truncateAll(dataSource)
    // Seeding needs a tooling-enabled service of its own: the domain refuses a
    // reset outright when the flag is off.
    vi.stubEnv('TEST_TOOLING_ENABLED', 'true')
    service = makeService()

    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const adminRecord = await service.upsertUser({
      userId: testUuid('tt-admin'),
      email: 'admin@example.com',
      displayName: 'Admin User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.assignUserRoles({
      userId: adminRecord.userId,
      roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
    })
    const employeeRecord = await service.upsertUser({
      userId: testUuid('tt-employee'),
      email: 'employee@example.com',
      displayName: 'Employee User',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    adminUser = {
      id: adminRecord.userId,
      email: adminRecord.email,
      name: adminRecord.displayName,
      roles: [AppRoleName.Employee, AppRoleName.Administrator],
    }
    employeeUser = {
      id: employeeRecord.userId,
      email: employeeRecord.email,
      name: employeeRecord.displayName,
      roles: [AppRoleName.Employee],
    }
  })

  it('404s every reset-directory call while the tooling flag is off, admin or not', async () => {
    const controller = buildController(false)

    await expect(
      controller.resetDirectory(adminUser, { all: true }),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      controller.resetDirectory(employeeUser, { all: true }),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(await dataSource.getRepository(UserEntity).count()).toBe(2)
  })

  it('403s a non-administrator when the tooling flag is on', async () => {
    const controller = buildController(true)

    await expect(
      controller.resetDirectory(employeeUser, { all: true }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(await dataSource.getRepository(UserEntity).count()).toBe(2)
  })

  it('400s malformed keep/all/clearAudit payloads before touching the domain', async () => {
    const controller = buildController(true)
    const malformed = [
      { keep: 'admin@example.com' },
      { keep: [42] },
      // A blank address protects nobody; refused here so the caller is told
      // which field is wrong instead of getting a refusal naming no one.
      { keep: [''] },
      { keep: ['   '] },
      { all: 'true' },
      { clearAudit: 1 },
    ] as never[]

    for (const body of malformed) {
      await expect(
        controller.resetDirectory(adminUser, body),
      ).rejects.toBeInstanceOf(BadRequestException)
    }

    expect(await dataSource.getRepository(UserEntity).count()).toBe(2)
  })

  it('400s an unconfirmed full wipe, and a keep list contradicting all=true', async () => {
    const controller = buildController(true)

    await expect(controller.resetDirectory(adminUser, {})).rejects.toThrow(
      /requires all=true/,
    )
    await expect(
      controller.resetDirectory(adminUser, {
        keep: ['employee@example.com'],
        all: true,
      }),
    ).rejects.toThrow(/all=true confirms deleting EVERY user/)

    expect(await dataSource.getRepository(UserEntity).count()).toBe(2)
  })

  it('409s when the domain reports a directory conflict', async () => {
    // The lock itself is exercised in the domain spec; what this pins is the
    // error-to-status mapping, so the domain is stubbed rather than raced.
    const contended = {
      resetDirectory: () =>
        Promise.reject(
          new DirectorySyncInProgressError('a directory sync is running'),
        ),
    } as unknown as LeaveDomainService
    const controller = buildController(true, contended)

    await expect(
      controller.resetDirectory(adminUser, { all: true }),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(await dataSource.getRepository(UserEntity).count()).toBe(2)
  })

  it('wipes the population on a confirmed request and reports what it removed', async () => {
    const controller = buildController(true)
    // Seeding an employee with a start date accrues into the ledger, so the
    // expected count is read from the table rather than assumed: the assertion
    // is that the reported counters match what was actually there.
    const ledgerRepo = dataSource.getRepository(LeaveBalanceChangeEntity)
    const ledgerBefore = await ledgerRepo.count()
    expect(ledgerBefore).toBeGreaterThan(0)

    const result = await controller.resetDirectory(adminUser, {
      all: true,
      clearAudit: true,
    })

    expect(result).toMatchObject({
      deletedUsers: 2,
      deletedRequests: 0,
      deletedLedgerEntries: ledgerBefore,
      deletedDeliveries: 0,
    })
    expect(result.clearedAuditLogs).toBeGreaterThan(0)
    expect(await dataSource.getRepository(UserEntity).count()).toBe(0)
    expect(await ledgerRepo.count()).toBe(0)
  })

  it('keeps the listed user and deletes the rest', async () => {
    const controller = buildController(true)

    const result = await controller.resetDirectory(adminUser, {
      keep: ['employee@example.com'],
    })

    expect(result.deletedUsers).toBe(1)
    const remaining = await dataSource.getRepository(UserEntity).find()
    expect(remaining.map((user) => user.normalizedEmail)).toEqual([
      'employee@example.com',
    ])
  })
})
