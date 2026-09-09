/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import {
  AppRoleName,
  ApproverDecision,
  AuditActionKind,
  AuditCategory,
  AuditEventType,
  CarryoverCapMode,
  EmployeeProfileFilter,
  LeaveApprovalAction,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
} from '@workspace/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventBus } from '@nestjs/cqrs'
import type { DataSource } from 'typeorm'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedMembership, seedProject } from '../test-support/projects'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { AuditLogService } from '../domain/audit-log.service'
import { ClockService } from '../domain/clock.service'
import { NotificationService } from '../domain/notification.service'
import { AdminLeaveController } from './admin-leave.controller'

describe('AdminLeaveController', () => {
  let dataSource: DataSource
  let service: LeaveDomainService
  let controller: AdminLeaveController
  let adminUser: UserProfileType
  let employeeUser: UserProfileType

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    await dataSource.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    const clock = new ClockService()
    const auditLog = new AuditLogService(dataSource, clock)
    service = new LeaveDomainService(
      dataSource,
      auditLog,
      clock,
      new NotificationService(dataSource, clock),
    )
    controller = new AdminLeaveController(service, auditLog, {
      publish: vi.fn(),
    } as unknown as EventBus, {
      notifyVacationBalanceAdjusted: vi.fn().mockResolvedValue(undefined),
    } as never)

    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: ['approver@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-05-01T00:00:00.000Z',
    })
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-05-01', name: 'Labour Day' }],
    })

    const adminRecord = await service.upsertUser({
      userId: testUuid('admin-1'),
      email: 'admin@example.com',
      displayName: 'Admin User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-05-01T00:00:00.000Z',
    })
    await service.assignUserRoles({
      userId: adminRecord.userId,
      roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
    })

    const employeeRecord = await service.upsertUser({
      userId: testUuid('employee-1'),
      email: 'employee@example.com',
      displayName: 'Employee User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-05-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: employeeRecord.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-05-04',
      endDate: '2026-05-05',
      approverEmails: ['approver@example.com'],
      ccEmails: ['hr@example.com'],
      comment: 'Family trip',
      submittedAt: '2026-05-02T09:00:00.000Z',
    })

    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: adminRecord.userId,
      actorDisplayName: adminRecord.displayName,
      actorEmail: 'approver@example.com',
      action: LeaveApprovalAction.Approve,
      comment: 'Approved',
      decidedAt: '2026-05-02T10:00:00.000Z',
    })

    // The controller gates on the roles carried by the authenticated profile
    // (the JWT/profile-mapper union), so reflect that here.
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

  it('registers the admin route prefix and protects the controller with JwtAuthGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminLeaveController)).toBe('admin')
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminLeaveController)).toEqual([
      JwtAuthGuard,
    ])
  })

  it('maps the expected GET, PUT and PATCH routes without the runtime /api prefix', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.updateEmployee),
    ).toBe('employees/:employeeId')
    expect(
      Reflect.getMetadata(METHOD_METADATA, AdminLeaveController.prototype.updateEmployee),
    ).toBe(RequestMethod.PATCH)
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.setEmployeeAllocation,
      ),
    ).toBe('employees/:employeeId/allocation')
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminLeaveController.prototype.setEmployeeAllocation,
      ),
    ).toBe(RequestMethod.PUT)
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.setEmployeeActive,
      ),
    ).toBe('employees/:employeeId/active')
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminLeaveController.prototype.setEmployeeActive,
      ),
    ).toBe(RequestMethod.PATCH)
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.adjustEmployeeVacationBalance,
      ),
    ).toBe('employees/:employeeId/vacation-balance')
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminLeaveController.prototype.adjustEmployeeVacationBalance,
      ),
    ).toBe(RequestMethod.POST)
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.forceDecision,
      ),
    ).toBe('leave-requests/:requestId/force-decision')
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminLeaveController.prototype.forceDecision,
      ),
    ).toBe(RequestMethod.POST)
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.removeApprover,
      ),
    ).toBe('leave-requests/:requestId/approvers')
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminLeaveController.prototype.removeApprover,
      ),
    ).toBe(RequestMethod.DELETE)
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.getActivity),
    ).toBe('activity')
    expect(
      Reflect.getMetadata(METHOD_METADATA, AdminLeaveController.prototype.getActivity),
    ).toBe(RequestMethod.GET)

    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.getEmployees),
    ).toBe('employees')
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.getEmployeeDetail),
    ).toBe('employees/:employeeId')
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.getSettings),
    ).toBe('settings')
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.updateSettings),
    ).toBe('settings')
    expect(
      Reflect.getMetadata(METHOD_METADATA, AdminLeaveController.prototype.updateSettings),
    ).toBe(RequestMethod.PUT)

    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.listHolidays),
    ).toBe('holidays')
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminLeaveController.prototype.updateHolidayCalendar),
    ).toBe('holidays')
    expect(
      Reflect.getMetadata(METHOD_METADATA, AdminLeaveController.prototype.updateHolidayCalendar),
    ).toBe(RequestMethod.PUT)
  })

  it('lets an administrator override an employee employment start date but not clear it', async () => {
    const set = await controller.updateEmployee(adminUser, employeeUser.id, {
      employmentStartDate: '2026-07-01',
    })
    expect(set.employmentStartDate).toBe('2026-07-01')

    const detail = await controller.getEmployeeDetail(adminUser, employeeUser.id)
    expect(detail.employmentStartDate).toBe('2026-07-01')

    // Clearing a set start date is forbidden: the accrual anchor may only be
    // corrected, never removed (domain guard), so the stored date survives.
    await expect(
      controller.updateEmployee(adminUser, employeeUser.id, {
        employmentStartDate: null,
      }),
    ).rejects.toThrowError('cannot be cleared')
    const afterClearAttempt = await controller.getEmployeeDetail(
      adminUser,
      employeeUser.id,
    )
    expect(afterClearAttempt.employmentStartDate).toBe('2026-07-01')

    await expect(
      controller.updateEmployee(employeeUser, employeeUser.id, {
        employmentStartDate: '2026-07-01',
      }),
    ).rejects.toThrowError('Administrator access required.')

    await expect(
      controller.updateEmployee(adminUser, employeeUser.id, {
        employmentStartDate: '2026-02-30',
      }),
    ).rejects.toThrowError('employmentStartDate must be a valid calendar date or null.')

    await expect(
      controller.updateEmployee(adminUser, testUuid('nobody'), {
        employmentStartDate: '2026-07-01',
      }),
    ).rejects.toThrowError('Unknown employee')
  })

  it('lets an administrator assign, switch, and clear an employee location', async () => {
    // Seeded with UA; add PL so we can switch between two real countries.
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: ['approver@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [
        { code: 'UA', name: 'Ukraine' },
        { code: 'PL', name: 'Poland' },
      ],
      updatedAt: '2026-05-01T00:00:00.000Z',
    })

    const initial = await controller.getEmployeeDetail(adminUser, employeeUser.id)
    expect(initial.countryCode).toBe('UA')

    const listed = await controller.getCountries(adminUser)
    expect(listed.map((country) => country.code).sort()).toEqual(['PL', 'UA'])

    const switched = await controller.updateEmployee(adminUser, employeeUser.id, {
      countryCode: 'PL',
    })
    expect(switched.countryCode).toBe('PL')

    const cleared = await controller.updateEmployee(adminUser, employeeUser.id, {
      countryCode: null,
    })
    expect(cleared.countryCode).toBeUndefined()

    // An unknown country is rejected rather than silently created.
    await expect(
      controller.updateEmployee(adminUser, employeeUser.id, {
        countryCode: 'ZZ',
      }),
    ).rejects.toThrowError('Unknown country: ZZ')

    // A single PATCH can update the start date and location together.
    const both = await controller.updateEmployee(adminUser, employeeUser.id, {
      employmentStartDate: '2026-03-01',
      countryCode: 'UA',
    })
    expect(both.employmentStartDate).toBe('2026-03-01')
    expect(both.countryCode).toBe('UA')

    // A combined PATCH is atomic: rejecting the country must leave the
    // (valid) start date in the same request unwritten.
    await expect(
      controller.updateEmployee(adminUser, employeeUser.id, {
        employmentStartDate: '2026-09-09',
        countryCode: 'ZZ',
      }),
    ).rejects.toThrowError('Unknown country: ZZ')
    const afterFailed = await controller.getEmployeeDetail(adminUser, employeeUser.id)
    expect(afterFailed.employmentStartDate).toBe('2026-03-01')
    expect(afterFailed.countryCode).toBe('UA')

    // An empty patch is rejected.
    await expect(
      controller.updateEmployee(adminUser, employeeUser.id, {}),
    ).rejects.toThrowError('Provide employmentStartDate')

    // Non-administrators cannot list countries (the guard throws synchronously,
    // matching getSettings/getEmployees).
    expect(() => controller.getCountries(employeeUser)).toThrowError(
      'Administrator access required.',
    )
  })

  it('answers the retired allocation endpoint with 410 naming its replacement', () => {
    // The route stays registered so a stale client is told where the
    // capability went instead of getting a puzzling 404.
    expect(() => controller.setEmployeeAllocation(adminUser)).toThrow(
      GoneException,
    )
    expect(() => controller.setEmployeeAllocation(adminUser)).toThrow(
      /leave policies/,
    )
    // The guard still runs first: a non-admin learns nothing about the route.
    expect(() => controller.setEmployeeAllocation(employeeUser)).toThrow(
      'Administrator access required.',
    )
  })

  it('exposes admin force-decision and approver removal for a blocked request', async () => {
    const req = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      approverEmails: ['lead@example.com', 'gone@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-20T09:00:00.000Z',
    })

    // Remove a departed approver; the request stays Pending (others undecided).
    const afterRemove = await controller.removeApprover(adminUser, req.requestId, {
      email: 'gone@example.com',
    })
    expect(afterRemove.status).toBe(LeaveRequestStatus.Pending)
    expect(
      afterRemove.approvers.some((a) => a.email === 'gone@example.com'),
    ).toBe(false)

    // Force-approve past the remaining undecided approvers.
    const forced = await controller.forceDecision(adminUser, req.requestId, {
      action: LeaveApprovalAction.Approve,
      comment: 'override',
    })
    expect(forced.status).toBe(LeaveRequestStatus.Approved)

    // Guards: non-admin and empty email are rejected.
    await expect(
      controller.forceDecision(employeeUser, req.requestId, {
        action: LeaveApprovalAction.Approve,
      }),
    ).rejects.toThrowError('Administrator access required.')
    await expect(
      controller.removeApprover(adminUser, req.requestId, { email: '' }),
    ).rejects.toThrowError('email is required')
  })

  it('refuses an override without a written reason', async () => {
    const req = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-02',
      endDate: '2026-06-02',
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-20T09:00:00.000Z',
    })

    // An omitted reason and a blank one report the same thing.
    await expect(
      controller.forceDecision(adminUser, req.requestId, {
        action: LeaveApprovalAction.Approve,
      }),
    ).rejects.toThrowError('comment is required')
    await expect(
      controller.forceDecision(adminUser, req.requestId, {
        action: LeaveApprovalAction.Approve,
        comment: '   ',
      }),
    ).rejects.toThrowError('comment is required')
    // Only a wrong type reports a type error.
    await expect(
      controller.forceDecision(adminUser, req.requestId, {
        action: LeaveApprovalAction.Approve,
        comment: 42 as unknown as string,
      }),
    ).rejects.toThrowError('comment must be a string.')

    const detail = await controller.getLeaveRequest(adminUser, req.requestId)
    expect(detail.status).toBe(LeaveRequestStatus.Pending)
  })

  it('serves leave request detail to an administrator and refuses everyone else', async () => {
    const req = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-03',
      endDate: '2026-06-03',
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-20T09:00:00.000Z',
    })

    const detail = await controller.getLeaveRequest(adminUser, req.requestId)
    expect(detail).toMatchObject({
      requestId: req.requestId,
      status: LeaveRequestStatus.Pending,
    })
    // The console reads the gate from here, so the approvers must come with it.
    expect(detail.approvers.map((approver) => approver.email)).toContain(
      'lead@example.com',
    )
    // Detail carries the caller's viewer, like every other detail response: the
    // override dialog gates its submit on this, not on raw status. An uninvolved
    // admin on a pending request may override.
    expect(detail.viewer).toMatchObject({
      canOverride: true,
      canDecide: false,
    })

    // The method is async, so the guard surfaces as a rejection, not a throw.
    await expect(
      controller.getLeaveRequest(employeeUser, req.requestId),
    ).rejects.toThrowError('Administrator access required.')
    await expect(
      controller.getLeaveRequest(adminUser, testUuid('missing-request')),
    ).rejects.toThrowError('Unknown leave request')
  })

  it('returns administrator activity, employee data, settings, and holidays for an administrator', async () => {
    // The feed is request-centric: the single request appears once with its
    // live (approved) status, so there is no further page to cursor into.
    const activity = await controller.getActivity(adminUser, undefined, '1')
    expect(activity.items).toHaveLength(1)
    expect(activity.items[0]).toMatchObject({
      employeeId: employeeUser.id,
      status: LeaveRequestStatus.Approved,
      lastAction: 'approved',
    })
    expect(activity.totals).toEqual({
      total: 1,
      pending: 0,
      approved: 1,
      rejected: 0,
      cancelled: 0,
      superseded: 0,
    })
    expect(activity.nextCursor).toBeUndefined()

    const employees = await controller.getEmployees(
      adminUser,
      'employee',
      AppRoleName.Employee,
    )
    expect(employees.items).toHaveLength(1)
    expect(employees.items[0]).toMatchObject({
      employeeId: employeeUser.id,
      email: employeeUser.email,
    })

    const detail = await controller.getEmployeeDetail(adminUser, employeeUser.id)
    expect(detail).toMatchObject({
      employeeId: employeeUser.id,
      email: employeeUser.email,
    })
    expect(detail.requestHistory).toHaveLength(1)
    // No memberships seeded for this employee -> always an array, never
    // undefined.
    expect(detail.projects).toEqual([])

    const settings = await controller.getSettings(adminUser)
    expect(settings.defaultVacationDays).toBe(24)
    expect(settings.countries[0]?.code).toBe('UA')

    const updatedSettings = await controller.updateSettings(adminUser, {
      ...settings,
      defaultVacationDays: 26,
      updatedAt: '2026-05-03T00:00:00.000Z',
    })
    expect(updatedSettings.defaultVacationDays).toBe(26)

    const holidays = await controller.listHolidays(adminUser, 'UA', '2026')
    expect(holidays).toHaveLength(1)
    expect(holidays[0]?.holidays[0]?.date).toBe('2026-05-01')

    const updatedCalendar = await controller.updateHolidayCalendar(adminUser, {
      countryCode: 'UA',
      year: 2026,
      holidays: [
        {
          date: '2026-12-25',
          name: 'Winter Holiday',
        },
      ],
    })
    expect(updatedCalendar.year).toBe(2026)
    expect(updatedCalendar.holidays).toEqual([
      expect.objectContaining({
        date: '2026-12-25',
        name: 'Winter Holiday',
      }),
    ])
    // holidayId is now a server-assigned uuid, not the client's natural key.
    expect(updatedCalendar.holidays[0]?.holidayId).toBeTypeOf('string')
  })

  it('tells the console where the reading admin personally stands on each row', async () => {
    // The console offers an override, which bypasses the approver gate. On a
    // row the reading admin is an approver of, that is the wrong door: they
    // hold a vote in the very gate it would bypass. The feed can only tell
    // those rows apart if the server says so per row.
    const ownRequest = await service.submitLeaveRequest({
      requesterUserId: adminUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      approverEmails: ['employee@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-03T09:00:00.000Z',
    })

    const approverRequest = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-05-12',
      endDate: '2026-05-12',
      // Mixed case on purpose: the row match runs on normalized addresses.
      approverEmails: ['Admin@Example.com'],
      ccEmails: [],
      submittedAt: '2026-05-03T10:00:00.000Z',
    })

    // A pending request the admin has no stake in: not its requester, not an
    // approver. This is the row an override IS for.
    const uninvolvedRequest = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-05-13',
      endDate: '2026-05-13',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-03T10:30:00.000Z',
    })

    const feed = await controller.getActivity(adminUser)
    const viewerFor = (requestId: string) =>
      feed.items.find((item) => item.requestId === requestId)?.viewer

    // Their own request: nobody decides their own, so neither route is offered.
    expect(viewerFor(ownRequest.requestId)).toEqual({
      standing: LeaveRequestViewerStanding.Requester,
      canDecide: false,
      canOverride: false,
    })
    // A request naming them: being an admin-approver, they hold BOTH — a vote
    // and the override. The vote takes precedence (the client offers Review),
    // but the override stays available while the vote is unspent.
    expect(viewerFor(approverRequest.requestId)).toEqual({
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: true,
      canOverride: true,
    })
    // The seeded request (startDate 2026-05-04, names approver@example.com, not
    // them) is already decided: an uninvolved admin, but the override is withheld
    // because it is no longer pending. Located by its distinctive seed date, not
    // a positional index, so a change to feed ordering cannot silently retarget.
    const settledViewer = feed.items.find(
      (item) => item.startDate === '2026-05-04',
    )?.viewer
    expect(settledViewer?.standing).toBe(LeaveRequestViewerStanding.Administrator)
    expect(settledViewer?.canOverride).toBe(false)
    // The uninvolved pending request: the server itself grants the override,
    // end to end — not a standing the client re-interprets.
    expect(viewerFor(uninvolvedRequest.requestId)).toEqual({
      standing: LeaveRequestViewerStanding.Administrator,
      canDecide: false,
      canOverride: true,
    })

    // Their vote is now spent (canDecide gone), but the admin hat keeps the
    // override: a lone admin who has voted can still change the outcome. This is
    // the deadlock fix — the override does NOT disappear with the vote.
    await service.decideLeaveRequest({
      requestId: approverRequest.requestId,
      actorUserId: adminUser.id,
      actorDisplayName: adminUser.name ?? adminUser.email,
      actorEmail: adminUser.email,
      action: LeaveApprovalAction.Approve,
      comment: 'Approved',
      decidedAt: '2026-05-03T11:00:00.000Z',
    })

    const afterVote = await controller.getActivity(adminUser)
    // toEqual (not toMatchObject) on the whole viewer: this deadlock-fix state is
    // the load-bearing claim, so pin the exact shape — a spurious field or a
    // wrong decidedAt must fail, matching how the sibling assertions above are
    // written.
    expect(
      afterVote.items.find(
        (item) => item.requestId === approverRequest.requestId,
      )?.viewer,
    ).toEqual({
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: false,
      canOverride: true,
      ownVote: {
        decision: ApproverDecision.Approved,
        decidedAt: '2026-05-03T11:00:00.000Z',
      },
    })
  })

  it('binds canOverride to what the force-decision endpoint actually accepts', async () => {
    // canOverride is a PREDICTION the client renders its override button from;
    // the force-decision endpoint enforces the real rule independently
    // (assertAdministrator + the domain's pending/not-requester guards). This
    // test pins that the flag and the endpoint agree — a divergence would offer
    // a button that 403s, or hide a capability the API still grants.
    const overridable = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      // A Monday: the request needs at least one working day to be accepted.
      startDate: '2026-06-22',
      endDate: '2026-06-22',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-04T09:00:00.000Z',
    })
    const ownRequest = await service.submitLeaveRequest({
      requesterUserId: adminUser.id,
      leaveType: LeaveType.Vacation,
      // A Tuesday, likewise a working day.
      startDate: '2026-06-23',
      endDate: '2026-06-23',
      approverEmails: ['employee@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-04T10:00:00.000Z',
    })

    const feed = await controller.getActivity(adminUser)
    const viewerFor = (requestId: string) =>
      feed.items.find((item) => item.requestId === requestId)?.viewer
    // The seeded request (2026-05-04) is already Approved before this test runs.
    const settled = feed.items.find((item) => item.startDate === '2026-05-04')!

    // The three cases the flag distinguishes: uninvolved-admin-on-pending (true),
    // your-own-request (false), already-settled (false).
    expect(viewerFor(overridable.requestId)?.canOverride).toBe(true)
    expect(viewerFor(ownRequest.requestId)?.canOverride).toBe(false)
    expect(settled.viewer?.canOverride).toBe(false)

    const override = (requestId: string) =>
      controller.forceDecision(adminUser, requestId, {
        action: LeaveApprovalAction.Approve,
        comment: 'override',
      })

    // canOverride true → the endpoint accepts and settles the request, and the
    // response carries a REFRESHED viewer: the request is now terminal, so the
    // override authority the feed offered is gone (canOverride:false). This is
    // what applyDecisionToFeed reads to drop the row's stale canOverride.
    const overridden = await override(overridable.requestId)
    expect(overridden.status).toBe(LeaveRequestStatus.Approved)
    expect(overridden.viewer).toMatchObject({
      canOverride: false,
      canDecide: false,
    })
    // canOverride false because it is the admin's own request → refused.
    await expect(override(ownRequest.requestId)).rejects.toThrowError(
      'your own leave request',
    )
    // canOverride false because it is no longer pending → refused.
    await expect(override(settled.requestId)).rejects.toThrowError(
      'Only pending leave requests can be decided',
    )
  })

  it('refuses a request that addresses its own requester', async () => {
    // A self-listed 'to' row could never clear the all-approvers gate, and a
    // self-listed cc row is stripped before the notification goes out — so the
    // copy the requester thinks they arranged would never arrive. Both are
    // refused at submit rather than silently dropped.
    await expect(
      service.submitLeaveRequest({
        requesterUserId: employeeUser.id,
        leaveType: LeaveType.Vacation,
        startDate: '2026-05-13',
        endDate: '2026-05-13',
        approverEmails: ['Employee@Example.com'],
        ccEmails: [],
        submittedAt: '2026-05-03T09:00:00.000Z',
      }),
    ).rejects.toThrowError('yourself as a recipient')

    await expect(
      service.submitLeaveRequest({
        requesterUserId: employeeUser.id,
        leaveType: LeaveType.Vacation,
        startDate: '2026-05-14',
        endDate: '2026-05-14',
        approverEmails: ['approver@example.com'],
        ccEmails: ['employee@example.com'],
        submittedAt: '2026-05-03T09:00:00.000Z',
      }),
    ).rejects.toThrowError('yourself as a recipient')

    // The settings defaults are a different matter: the requester did not
    // choose them and cannot edit them, so their own address is dropped there
    // rather than blocking the submission.
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: ['approver@example.com', 'employee@example.com'],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-05-01T00:00:00.000Z',
    })
    const accepted = await service.submitLeaveRequest({
      requesterUserId: employeeUser.id,
      leaveType: LeaveType.Vacation,
      startDate: '2026-05-15',
      endDate: '2026-05-15',
      approverEmails: ['approver@example.com'],
      ccEmails: [],
      submittedAt: '2026-05-03T09:00:00.000Z',
    })
    expect(
      accepted.approvers.map((recipient) => recipient.email),
    ).not.toContain('employee@example.com')
  })

  it('applies the activity feed filters and passes them through to the query', async () => {
    const filtered = await controller.getActivity(
      adminUser,
      undefined,
      undefined,
      employeeUser.id,
      'Approver@Example.com',
      LeaveRequestStatus.Approved,
      LeaveType.Vacation,
      '2026-05-04',
      '2026-05-05',
    )
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]?.employeeId).toBe(employeeUser.id)

    // The status filter narrows the totals cards along with the page.
    const pendingView = await controller.getActivity(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      LeaveRequestStatus.Pending,
    )
    expect(pendingView.items).toHaveLength(0)
    expect(pendingView.totals).toEqual({
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      superseded: 0,
    })

    // The CC watcher is not an approver.
    const byCcEmail = await controller.getActivity(
      adminUser,
      undefined,
      undefined,
      undefined,
      'hr@example.com',
    )
    expect(byCcEmail.items).toHaveLength(0)
  })

  // getActivity is async, so its synchronous filter validation surfaces as a
  // rejected promise — assert with .rejects. The parse guards still run before
  // any DB call, so a bad filter is refused before it reaches SQL.
  it('rejects malformed activity feed filters with a 400 before they reach SQL', async () => {
    await expect(
      controller.getActivity(adminUser, undefined, undefined, 'not-a-uuid'),
    ).rejects.toThrowError('employeeId must be a valid id.')
    await expect(
      controller.getActivity(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        'sleeping',
      ),
    ).rejects.toThrowError('status must be a valid value.')
    await expect(
      controller.getActivity(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'jury-duty',
      ),
    ).rejects.toThrowError('leaveType must be a valid value.')
    await expect(
      controller.getActivity(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '2026-02-30',
      ),
    ).rejects.toThrowError('from must be a valid calendar date (YYYY-MM-DD).')
    await expect(
      controller.getActivity(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'next week',
      ),
    ).rejects.toThrowError('to must be a valid calendar date (YYYY-MM-DD).')
    await expect(
      controller.getActivity(
        adminUser,
        undefined,
        undefined,
        undefined,
        'not-an-email',
      ),
    ).rejects.toThrowError('approverEmail must be a valid email address.')
  })

  it('serves the lightweight employee options projection for filter dropdowns', async () => {
    // Static segment must be registered before employees/:employeeId, or the
    // param route would swallow 'options' as an employee id.
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.getEmployeeOptions,
      ),
    ).toBe('employees/options')
    // Nest registers routes in method declaration order and Express matches
    // first, so the static route must be DECLARED before the param route —
    // class method order is what actually keeps this endpoint reachable.
    const methodOrder = Object.getOwnPropertyNames(AdminLeaveController.prototype)
    expect(methodOrder.indexOf('getEmployeeOptions')).toBeGreaterThan(-1)
    expect(methodOrder.indexOf('getEmployeeOptions')).toBeLessThan(
      methodOrder.indexOf('getEmployeeDetail'),
    )

    const options = await controller.getEmployeeOptions(adminUser)
    expect(options).toEqual([
      {
        employeeId: adminUser.id,
        displayName: 'Admin User',
        email: 'admin@example.com',
      },
      {
        employeeId: employeeUser.id,
        displayName: 'Employee User',
        email: 'employee@example.com',
      },
    ])
  })

  it('filters the employee directory by project and country, and serves the filter options', async () => {
    // Same literal-before-param rule as employees/options: without it Nest
    // would match 'filter-options' as an employee id.
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminLeaveController.prototype.getEmployeeFilterOptions,
      ),
    ).toBe('employees/filter-options')
    const methodOrder = Object.getOwnPropertyNames(AdminLeaveController.prototype)
    expect(methodOrder.indexOf('getEmployeeFilterOptions')).toBeGreaterThan(-1)
    expect(methodOrder.indexOf('getEmployeeFilterOptions')).toBeLessThan(
      methodOrder.indexOf('getEmployeeDetail'),
    )

    // Both seeded users are in UA; give the admin a second country so the
    // country filter has something to exclude.
    await service.upsertUser({
      userId: testUuid('admin-1'),
      email: 'admin@example.com',
      displayName: 'Admin User',
      countryCode: 'PL',
      createdAt: '2026-05-01T00:00:00.000Z',
    })
    await seedProject(dataSource, 'apollo', 'Apollo')
    await seedProject(dataSource, 'zephyr', 'Zephyr')
    await seedMembership(dataSource, 'employee-1', 'apollo')
    await seedMembership(dataSource, 'admin-1', 'zephyr')

    const filterOptions = await controller.getEmployeeFilterOptions(adminUser)
    expect(filterOptions.countries.map((country) => country.code)).toEqual([
      'PL',
      'UA',
    ])
    expect(filterOptions.projects.map((project) => project.name)).toEqual([
      'Apollo',
      'Zephyr',
    ])
    const apolloId = filterOptions.projects[0]?.projectId ?? ''

    // Project filter (5th positional arg) narrows the directory.
    const byProject = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      apolloId,
    )
    expect(byProject.items.map((item) => item.employeeId)).toEqual([
      employeeUser.id,
    ])
    expect(byProject.items[0]?.projects).toEqual([
      { projectId: apolloId, name: 'Apollo' },
    ])
    expect(byProject.items[0]?.countryCode).toBe('UA')

    // The employee detail carries the same membership as the list rows, plus
    // the member's position (roleOnProject) which the lightweight list omits.
    const detail = await controller.getEmployeeDetail(adminUser, employeeUser.id)
    expect(detail.projects).toEqual([
      { projectId: apolloId, name: 'Apollo', position: 'member' },
    ])

    // Policy filter, the LAST positional arg: new filters are appended to the
    // route rather than grouped with their relatives, because every call here
    // is positional and an inserted parameter shifts the rest in silence. An
    // unknown-but-valid uuid narrows to nobody, which proves the parameter
    // reaches the query at all: it used to be declared nowhere on the route and
    // was silently dropped.
    const byPolicy = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '11111111-2222-4333-8444-555555555555',
    )
    expect(byPolicy.items).toEqual([])
    // The validator throws SYNCHRONOUSLY, before the handler returns a
    // promise, so this asserts on the call rather than on a rejection.
    expect(() =>
      controller.getEmployees(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'not-a-uuid',
      ),
    ).toThrow(BadRequestException)

    // Country filter, accepted case-insensitively (normalizeCountryCode).
    const byCountry = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      'pl',
    )
    expect(byCountry.items.map((item) => item.employeeId)).toEqual([
      adminUser.id,
    ])

    // Combined with the existing search + role filters, all ANDed.
    const combined = await controller.getEmployees(
      adminUser,
      'employee@',
      AppRoleName.Employee,
      'UA',
      apolloId,
    )
    expect(combined.items.map((item) => item.employeeId)).toEqual([
      employeeUser.id,
    ])
    // The same employee, but asked for in the other country -> no rows.
    const contradictory = await controller.getEmployees(
      adminUser,
      'employee@',
      AppRoleName.Employee,
      'PL',
      apolloId,
    )
    expect(contradictory.items).toEqual([])

    // A malformed project id 400s before it reaches SQL.
    expect(() =>
      controller.getEmployees(
        adminUser,
        undefined,
        undefined,
        undefined,
        'not-a-uuid',
      ),
    ).toThrowError('projectId must be a valid id.')

    // Both new routes stay administrator-only.
    expect(() =>
      controller.getEmployeeFilterOptions(employeeUser),
    ).toThrowError(ForbiddenException)
  })

  it('filters the employee directory by account status, refusing anything but true/false', async () => {
    // Account status is the 7th positional parameter; both seeded users are
    // active.
    const active = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    )
    expect(active.items.map((item) => item.employeeId)).toEqual([
      adminUser.id,
      employeeUser.id,
    ])

    // 'false' is a filter in its own right, not the absence of one: it asks for
    // the deactivated accounts, of which there are none here. The assertion
    // above equals the unfiltered listing and would still pass if the parsed
    // value never reached the query; this one narrows, so it only passes when
    // the parameter is actually wired.
    const deactivated = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'false',
    )
    expect(deactivated.items).toEqual([])

    // Anything else 400s rather than being coerced. '1' and 'yes' are the
    // reason the parser is not fail-closed like the env-var reader: there they
    // would have quietly become false and listed the deactivated accounts.
    for (const value of ['1', 'yes', 'True']) {
      expect(() =>
        controller.getEmployees(
          adminUser,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          value,
        ),
      ).toThrowError('active must be true or false.')
    }
  })

  it('filters the employee directory by profile and employment start, refusing malformed values', async () => {
    // Profile and the two date bounds follow `active`, so this walks the tail
    // of the positional list. Both seeded users hold a complete card and a
    // 2026-01-01 start date.
    const complete = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      EmployeeProfileFilter.Complete,
    )
    expect(complete.items.map((item) => item.employeeId)).toEqual([
      adminUser.id,
      employeeUser.id,
    ])

    // The narrowing direction, so the assertion above cannot pass on a filter
    // that never reached the query.
    const missing = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      EmployeeProfileFilter.MissingAny,
    )
    expect(missing.items).toEqual([])

    // Each date bound travels under its own name; a window past both start
    // dates comes back empty.
    const startedLater = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-06-01',
    )
    expect(startedLater.items).toEqual([])
    const startedEarlier = await controller.getEmployees(
      adminUser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-06-01',
    )
    expect(startedEarlier.items.map((item) => item.employeeId)).toEqual([
      adminUser.id,
      employeeUser.id,
    ])

    expect(() =>
      controller.getEmployees(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'almost_complete',
      ),
    ).toThrowError('profile must be a valid profile filter.')

    // A date that parses as a pattern but is not a real day is refused here,
    // never handed to SQL as a comparison operand.
    for (const bad of ['2026-02-31', '01-03-2026', 'today']) {
      expect(() =>
        controller.getEmployees(
          adminUser,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          bad,
        ),
      ).toThrowError(
        'employmentStartDateFrom must be a valid calendar date (YYYY-MM-DD).',
      )
    }
  })

  it('rejects malformed audit filters with a 400 before they reach SQL', async () => {
    expect(() =>
      controller.getAudit(adminUser, undefined, undefined, 'not-a-uuid'),
    ).toThrowError('userId must be a valid id.')

    const auditFrom = (from: string) =>
      controller.getAudit(
        adminUser,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        from,
      )
    expect(() => auditFrom('garbage')).toThrowError(
      'from must be an ISO-8601 date or timestamp.',
    )
    // Date.parse accepts these, Postgres does not — they must 400, not 500.
    expect(() =>
      auditFrom('Wed Jul 01 2026 00:00:00 GMT+0300 (Eastern European Summer Time)'),
    ).toThrowError('from must be an ISO-8601 date or timestamp.')
    expect(() => auditFrom('12')).toThrowError(
      'from must be an ISO-8601 date or timestamp.',
    )

    // The accepted ISO forms reach SQL and bind cleanly.
    await expect(auditFrom('2026-05-01')).resolves.toBeDefined()
    await expect(auditFrom('2026-05-01T10:00:00.000Z')).resolves.toBeDefined()
    await expect(auditFrom('2026-05-01T10:00:00+03:00')).resolves.toBeDefined()
  })

  it('maps a clone conflict to a 400 instead of a 500', async () => {
    await controller.updateHolidayCalendar(adminUser, {
      countryCode: 'UA',
      year: 2027,
      holidays: [{ date: '2027-05-01', name: 'Labour Day' }],
    })
    // Target year already exists -> domain validation error -> BadRequest.
    await expect(
      controller.cloneHolidayCalendar(adminUser, {
        countryCode: 'UA',
        sourceYear: 2026,
        targetYear: 2027,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects non-administrators before exposing admin data', () => {
    expect(() => controller.getSettings(employeeUser)).toThrowError(
      ForbiddenException,
    )
    expect(() => controller.getEmployees(employeeUser)).toThrowError(
      ForbiddenException,
    )
  })

  it('records an audit trail with actor, target, and before/after state', async () => {
    // The beforeEach already produced settings, holiday, role, submission, and
    // approval events; assert they landed with the right shape.
    const page = await controller.getAudit(adminUser)
    const types = page.items.map((item) => item.eventType)
    expect(types).toContain(AuditEventType.SettingsUpdated)
    expect(types).toContain(AuditEventType.HolidayCalendarReplaced)
    expect(types).toContain(AuditEventType.LeaveRequestSubmitted)
    expect(types).toContain(AuditEventType.LeaveRequestApproved)

    const submitted = page.items.find(
      (item) => item.eventType === AuditEventType.LeaveRequestSubmitted,
    )
    expect(submitted?.action).toBe(AuditActionKind.Create)
    expect(submitted?.targetUserId).toBe(employeeUser.id)
    expect(submitted?.after).toBeTruthy()
    expect(submitted?.before ?? null).toBeNull()

    const approved = page.items.find(
      (item) => item.eventType === AuditEventType.LeaveRequestApproved,
    )
    expect(approved?.action).toBe(AuditActionKind.StateChange)
    expect(approved?.actorUserId).toBe(adminUser.id)
    // The approval flipped Pending -> Approved; the diff captures the transition.
    const statusChange = approved?.changedFields?.find(
      (change) => change.field === 'status',
    )
    expect(statusChange?.before).toBe(LeaveRequestStatus.Pending)
    expect(statusChange?.after).toBe(LeaveRequestStatus.Approved)
  })

  it('returns the audit feed newest-first', async () => {
    const page = await controller.getAudit(adminUser)
    const times = page.items.map((item) => item.occurredAt)
    const sorted = [...times].sort((left, right) =>
      left < right ? 1 : left > right ? -1 : 0,
    )
    expect(times).toEqual(sorted)
  })

  it('filters the audit trail by category', async () => {
    const page = await controller.getAudit(
      adminUser,
      undefined,
      undefined,
      undefined,
      AuditCategory.Settings,
    )
    expect(page.items.length).toBeGreaterThan(0)
    expect(
      page.items.every((item) => item.category === AuditCategory.Settings),
    ).toBe(true)
  })

  it('scopes the audit trail to one user as actor or subject', async () => {
    const page = await controller.getAudit(
      adminUser,
      undefined,
      undefined,
      employeeUser.id,
    )
    expect(page.items.length).toBeGreaterThan(0)
    expect(
      page.items.every(
        (item) =>
          item.actorUserId === employeeUser.id ||
          item.targetUserId === employeeUser.id,
      ),
    ).toBe(true)
    // The employee's own submission is in scope; a company-wide settings edit is not.
    expect(
      page.items.some(
        (item) => item.eventType === AuditEventType.LeaveRequestSubmitted,
      ),
    ).toBe(true)
    expect(
      page.items.some((item) => item.category === AuditCategory.Settings),
    ).toBe(false)
  })

  it('audits an admin employee-profile edit with before/after', async () => {
    await controller.updateEmployee(adminUser, employeeUser.id, {
      employmentStartDate: '2026-01-15',
    })
    const page = await controller.getAudit(
      adminUser,
      undefined,
      undefined,
      employeeUser.id,
      AuditCategory.Employee,
    )
    const profile = page.items.find(
      (item) => item.eventType === AuditEventType.EmployeeProfileUpdated,
    )
    expect(profile?.actorUserId).toBe(adminUser.id)
    expect(profile?.targetUserId).toBe(employeeUser.id)
    const change = profile?.changedFields?.find(
      (entry) => entry.field === 'employmentStartDate',
    )
    expect(change?.after).toBe('2026-01-15')
  })

  it('forbids non-administrators from reading the audit trail', () => {
    expect(() => controller.getAudit(employeeUser)).toThrowError(
      ForbiddenException,
    )
  })

  it('paginates the audit feed with a stable keyset cursor', async () => {
    const first = await controller.getAudit(adminUser, undefined, '2')
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()

    const second = await controller.getAudit(adminUser, first.nextCursor, '2')
    expect(second.items.length).toBeGreaterThan(0)

    // Pages do not overlap and the second page is strictly older (newest-first).
    const firstIds = new Set(first.items.map((item) => item.auditId))
    expect(second.items.every((item) => !firstIds.has(item.auditId))).toBe(true)
    const firstOldest = first.items.at(-1)!.occurredAt
    expect(second.items.every((item) => item.occurredAt <= firstOldest)).toBe(true)
  })

  it('rejects a non-string country timezone synchronously', async () => {
    const settings = await controller.getSettings(adminUser)
    expect(() =>
      controller.updateSettings(adminUser, {
        ...settings,
        countries: [
          { code: 'US', name: 'United States', timezone: 42 as never },
        ],
      }),
    ).toThrow('A country timezone must be a string.')
  })

  it('maps an unavailable country timezone to a 400 naming the alternatives', async () => {
    const settings = await controller.getSettings(adminUser)
    // The seeded countries stay in the payload: dropping them would be a
    // removal, and this test must refuse over the zone, not over that.
    const attempt = controller.updateSettings(adminUser, {
      ...settings,
      countries: [
        ...settings.countries,
        { code: 'US', name: 'United States', timezone: 'Europe/Kyiv' },
      ],
    })
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException)
    await attempt.catch((error: unknown) => {
      const body = (error as BadRequestException).getResponse() as Record<
        string,
        unknown
      >
      expect(body['code']).toBe('country_timezone_not_available')
      expect(body['countryCode']).toBe('US')
      expect(body['allowedTimezones']).toContain('America/Los_Angeles')
    })
  })

  it('round-trips a pinned country zone through GET then PUT', async () => {
    // Proves the other settings cards cannot trip the new refusal: whatever GET
    // hands back is always accepted straight back in. US is ADDED to the
    // roster rather than replacing it, because replacing it would drop the
    // seeded country out from under its employees.
    const before = await controller.getSettings(adminUser)
    await controller.updateSettings(adminUser, {
      ...before,
      countries: [
        ...before.countries,
        { code: 'US', name: 'United States', timezone: 'America/Los_Angeles' },
      ],
    })
    const loaded = await controller.getSettings(adminUser)
    const saved = await controller.updateSettings(adminUser, loaded)
    // Named rather than positional: the roster keeps every other row too.
    expect(
      saved.countries.find((country) => country.code === 'US')?.timezone,
    ).toBe('America/Los_Angeles')
  })

  it('refuses to remove a country its employees are still assigned to', async () => {
    // The database would not stop this: users.countryCode is ON DELETE SET
    // NULL, so the removal succeeds and blanks the country of everyone in it,
    // which drops them into PendingSetup and blocks every leave request they
    // try to submit. This refusal is the only thing standing in the way.
    const settings = await controller.getSettings(adminUser)
    const attempt = controller.updateSettings(adminUser, {
      ...settings,
      defaultVacationDays: 30,
      countries: [],
    })
    await expect(attempt).rejects.toBeInstanceOf(ConflictException)
    await attempt.catch((error: unknown) => {
      const body = (error as ConflictException).getResponse() as Record<
        string,
        unknown
      >
      expect(body['code']).toBe('country_in_use')
      expect(body['countryCode']).toBe('UA')
      expect(body['assignedUsers']).toBe(2)
      expect(String(body['message'])).toContain('2 employees are assigned to it')
    })

    // Refused inside the transaction, so nothing about the save survives: the
    // country is still there and the unrelated field it travelled with is not.
    const after = await controller.getSettings(adminUser)
    expect(after.countries.map((country) => country.code)).toContain('UA')
    expect(after.defaultVacationDays).toBe(settings.defaultVacationDays)
  })

  it('reports how many employees each country holds, so a console can say why', async () => {
    const settings = await controller.getSettings(adminUser)
    expect(
      settings.countries.find((country) => country.code === 'UA')
        ?.assignedUsers,
    ).toBe(2)
    // Computed on read and ignored on write: handing it straight back is not a
    // way to rewrite it.
    const saved = await controller.updateSettings(adminUser, {
      ...settings,
      countries: settings.countries.map((country) => ({
        ...country,
        assignedUsers: 99,
      })),
    })
    expect(
      saved.countries.find((country) => country.code === 'UA')?.assignedUsers,
    ).toBe(2)
  })

  it('refuses to mint a country from an invented code on a calendar save', async () => {
    // Saving a calendar creates the country when it is missing, and the catalog
    // has no zone for a code it does not recognise -- so this used to leave a
    // permanent timezone-less country that the settings picker cannot repair,
    // quietly putting anyone assigned to it on the org-wide midnight.
    // Both endpoints are async and funnel their validator through a catch, so
    // the refusal arrives as a rejection rather than a synchronous throw.
    await expect(
      controller.updateHolidayCalendar(adminUser, {
        countryCode: 'ZZ',
        year: 2026,
        name: null,
        holidays: [],
      }),
    ).rejects.toThrow('Unknown country: ZZ')
    await expect(
      controller.cloneHolidayCalendar(adminUser, {
        countryCode: 'ZZ',
        sourceYear: 2026,
        targetYear: 2027,
      }),
    ).rejects.toThrow('Unknown country: ZZ')

    // The country was never created.
    const settings = await controller.getSettings(adminUser)
    expect(settings.countries.map((country) => country.code)).not.toContain('ZZ')
  })

  it('rejects a non-string default timezone synchronously', async () => {
    const settings = await controller.getSettings(adminUser)
    expect(() =>
      controller.updateSettings(adminUser, {
        ...settings,
        defaultTimezone: 42 as never,
      }),
    ).toThrow('The default timezone must be a string.')
  })

  it('maps an unresolvable default timezone to a 400 naming the value', async () => {
    const settings = await controller.getSettings(adminUser)
    const attempt = controller.updateSettings(adminUser, {
      ...settings,
      defaultTimezone: 'Mars/Olympus',
    })
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException)
    await attempt.catch((error: unknown) => {
      const body = (error as BadRequestException).getResponse() as Record<
        string,
        unknown
      >
      expect(body['code']).toBe('default_timezone_not_recognized')
      expect(body['timezone']).toBe('Mars/Olympus')
    })
    // Refused, not stored: the whole save rolls back with it.
    expect((await controller.getSettings(adminUser)).defaultTimezone).toBe(
      settings.defaultTimezone,
    )
  })

  it('refuses a fixed offset, which would keep the wrong midnight all winter', async () => {
    const settings = await controller.getSettings(adminUser)
    await expect(
      controller.updateSettings(adminUser, {
        ...settings,
        defaultTimezone: '+03:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('round-trips the default timezone through GET then PUT', async () => {
    await controller.updateSettings(adminUser, {
      ...(await controller.getSettings(adminUser)),
      defaultTimezone: 'Europe/Warsaw',
    })
    const loaded = await controller.getSettings(adminUser)
    expect(loaded.defaultTimezone).toBe('Europe/Warsaw')
    expect((await controller.updateSettings(adminUser, loaded)).defaultTimezone).toBe(
      'Europe/Warsaw',
    )
  })

  it('leaves the stored zone alone when the payload omits it', async () => {
    // Every card on the settings page sends the whole object, so absence must
    // not read as "reset to Kyiv" -- that would move everyone's midnight from
    // an unrelated save.
    await controller.updateSettings(adminUser, {
      ...(await controller.getSettings(adminUser)),
      defaultTimezone: 'Europe/Warsaw',
    })
    const { defaultTimezone: _omitted, ...withoutZone } =
      await controller.getSettings(adminUser)
    expect(
      (await controller.updateSettings(adminUser, withoutZone)).defaultTimezone,
    ).toBe('Europe/Warsaw')
  })

  // Validation runs before the domain call, so these reject synchronously.
  it('rejects an invalid carryover cap mode', async () => {
    const settings = await controller.getSettings(adminUser)
    expect(() =>
      controller.updateSettings(adminUser, {
        ...settings,
        carryoverCapMode: 'weeks' as never,
      }),
    ).toThrow('carryoverCapMode must be a valid carryover cap mode.')
  })

  it('rejects an out-of-range carryover cap percent', async () => {
    const settings = await controller.getSettings(adminUser)
    for (const percent of [-1, 101, 12.5, '50' as never]) {
      expect(() =>
        controller.updateSettings(adminUser, {
          ...settings,
          carryoverCapPercent: percent,
        }),
      ).toThrow('carryoverCapPercent must be an integer between 0 and 100.')
    }

    // Both ends of the range are legal and round-trip back out.
    for (const percent of [0, 100]) {
      expect(
        await controller.updateSettings(adminUser, {
          ...settings,
          carryoverCapMode: CarryoverCapMode.Percent,
          carryoverCapPercent: percent,
        }),
      ).toMatchObject({
        carryoverCapMode: CarryoverCapMode.Percent,
        carryoverCapPercent: percent,
      })
    }
  })

  describe('setEmployeeActive', () => {
    const auditFor = (eventType: AuditEventType) =>
      new AuditLogService(dataSource, new ClockService()).getAdminAuditLogs({
        eventType,
      })

    it('deactivates then reactivates, auditing each with the admin as actor', async () => {
      const deactivated = await controller.setEmployeeActive(
        adminUser,
        employeeUser.id,
        { active: false },
      )
      expect(deactivated.active).toBe(false)
      const dEvents = await auditFor(AuditEventType.UserDeactivated)
      expect(dEvents.items).toHaveLength(1)
      expect(dEvents.items[0]?.actorLabel).toBe('Admin User')
      expect(dEvents.items[0]?.targetUserId).toBe(employeeUser.id)

      const reactivated = await controller.setEmployeeActive(
        adminUser,
        employeeUser.id,
        { active: true },
      )
      expect(reactivated.active).toBe(true)
      const rEvents = await auditFor(AuditEventType.UserReactivated)
      expect(rEvents.items).toHaveLength(1)
      expect(rEvents.items[0]?.actorLabel).toBe('Admin User')
    })

    it('refuses a non-administrator with 403', async () => {
      await expect(
        controller.setEmployeeActive(employeeUser, employeeUser.id, {
          active: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('refuses an admin deactivating their own account with 400', async () => {
      await expect(
        controller.setEmployeeActive(adminUser, adminUser.id, { active: false }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('does not block an admin setting their own account active (only self-deactivation is guarded)', async () => {
      // Self-deactivation is refused, so an admin is never inactive and this is
      // inherently a no-op; it exists only to prove the guard does not over-reach
      // to block active:true for self.
      const result = await controller.setEmployeeActive(adminUser, adminUser.id, {
        active: true,
      })
      expect(result.active).toBe(true)
    })

    it('rejects a non-boolean active with 400', async () => {
      await expect(
        controller.setEmployeeActive(adminUser, employeeUser.id, {
          active: 'yes' as unknown as boolean,
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('returns 404 for an unknown employee', async () => {
      await expect(
        controller.setEmployeeActive(adminUser, testUuid('nope'), {
          active: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})
