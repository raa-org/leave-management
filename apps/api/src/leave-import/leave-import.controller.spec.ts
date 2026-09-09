/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { AppRoleName, LeaveType } from '@workspace/contracts'
import type { ImportEmployeeResultDto } from '@workspace/contracts'
import { LeaveImportController } from './leave-import.controller'
import type { LeaveImportService } from './leave-import.service'

// The controller's whole job: gate on the administrator role, whitelist the
// body field by field, and hand the outcome back in the body.

const admin = {
  id: 'admin-1',
  name: 'Import admin',
  email: 'admin@example.com',
  roles: [AppRoleName.Administrator],
} as unknown as UserProfileType

const employee = {
  id: 'user-1',
  name: 'Anna',
  email: 'anna@example.com',
  roles: [AppRoleName.Employee],
} as unknown as UserProfileType

const validBody = {
  fn: 'user-data',
  targetYear: 2026,
  mode: 'add',
  employee: {
    email: 'anna@example.com',
    employmentStartDate: '2020-03-02',
    countryCode: 'ua',
    vacationDaysPerYear: 25,
    sickDaysPerYear: 5,
    carriedOverVacationDays: 7,
  },
  history: [
    {
      email: 'anna@example.com',
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
    },
  ],
}

const buildController = (
  overrides: Partial<LeaveImportService> = {},
): {
  controller: LeaveImportController
  service: LeaveImportService
} => {
  const service = {
    validate: vi.fn(async () => ({
      ok: true,
      unknownEmails: [],
      employees: [],
      issues: [],
      policiesToCreate: [],
      policiesToReuse: [],
    })),
    previewEmployee: vi.fn(
      async (): Promise<ImportEmployeeResultDto> => ({
        status: 'skipped',
        email: 'anna@example.com',
        reasons: [],
      }),
    ),
    applyEmployee: vi.fn(
      async (): Promise<ImportEmployeeResultDto> => ({
        status: 'skipped',
        email: 'anna@example.com',
        reasons: [],
      }),
    ),
    recordImportCompleted: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LeaveImportService
  return { controller: new LeaveImportController(service), service }
}

describe('LeaveImportController', () => {
  it('refuses every route to a non-administrator', async () => {
    const { controller, service } = buildController()

    await expect(controller.validate(employee, validBody)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(controller.preview(employee, validBody)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(controller.apply(employee, validBody)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(
      controller.complete(employee, {
        fn: 'user-data',
        targetYear: 2026,
        mode: 'add',
        applied: [],
        skipped: [],
        failed: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(service.validate).not.toHaveBeenCalled()
  })

  it('passes the whitelisted payload and the acting admin to the service', async () => {
    const { controller, service } = buildController()

    await controller.apply(admin, {
      ...validBody,
      // Server-owned fields a client must never be able to set.
      audit: { userId: 'someone-else', label: 'forged' },
      suppressNotifications: false,
      employee: { ...validBody.employee, userId: 'forged' },
    })

    expect(service.applyEmployee).toHaveBeenCalledTimes(1)
    const [payload, actor] = (service.applyEmployee as unknown as {
      mock: { calls: unknown[][] }
    }).mock.calls[0]!
    expect(payload).toEqual({
      fn: 'user-data',
      targetYear: 2026,
      mode: 'add',
      employee: {
        email: 'anna@example.com',
        displayName: undefined,
        employmentStartDate: '2020-03-02',
        // Normalized on the way in, matching the stored casing.
        countryCode: 'UA',
        vacationDaysPerYear: 25,
        sickDaysPerYear: 5,
        carriedOverVacationDays: 7,
        expectedVacationBalance: undefined,
        expectedSickBalance: undefined,
      },
      history: [
        {
          email: 'anna@example.com',
          leaveType: LeaveType.Vacation,
          startDate: '2026-03-02',
          endDate: '2026-03-06',
          submittedAt: undefined,
          approvedAt: undefined,
          approverEmail: undefined,
          workingDays: undefined,
        },
      ],
      policyName: undefined,
    })
    expect(actor).toMatchObject({
      userId: 'admin-1',
      email: 'admin@example.com',
    })
  })

  it('rejects a malformed body before the service is reached', async () => {
    const { controller, service } = buildController()

    await expect(
      controller.validate(admin, { ...validBody, mode: 'merge' }),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      controller.validate(admin, { ...validBody, targetYear: 'soon' }),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      controller.preview(admin, {
        ...validBody,
        history: [{ ...validBody.history[0], leaveType: 'sabbatical' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(service.validate).not.toHaveBeenCalled()
  })

  it('returns the service outcome verbatim, in the body', async () => {
    const failure: ImportEmployeeResultDto = {
      status: 'failed',
      email: 'anna@example.com',
      message: 'No holiday calendar is configured for UA 2026.',
    }
    const { controller } = buildController({
      applyEmployee: vi.fn(async () => failure) as never,
    })

    await expect(controller.apply(admin, validBody)).resolves.toEqual(failure)
  })
})
