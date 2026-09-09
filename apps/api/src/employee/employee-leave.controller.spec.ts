/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { EventBus } from '@nestjs/cqrs'
import { TypeOrmModule } from '@nestjs/typeorm'
import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  LeaveApprovalAction,
  LeaveRequestApprovedEvent,
  LeaveRequestAutoApprovedEvent,
  LeaveRequestStatus,
  LeaveRequestSubmittedEvent,
  LeaveRequestViewerStanding,
  LeaveType,
} from '@workspace/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataSource } from 'typeorm'
import {
  testDataSourceOptions,
  truncateAll,
} from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { ClockService } from '../domain/clock.service'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { EmployeeModule } from './employee.module'

interface TestRequest {
  header(name: string): string | undefined
  user?: {
    id: string
    email: string
    name?: string
    roles: string[]
  }
}

@Module({
  imports: [TypeOrmModule.forRoot(testDataSourceOptions), EmployeeModule],
})
class TestEmployeeAppModule {}

// These endpoints stamp their own timestamps from the wall clock — nothing
// crosses the wire to say when "now" is — so the fixtures below only mean what
// they were written to mean while the clock sits between them: April leave in
// the past, August leave still to come. Real time drifted past 3 August 2026
// and the change-an-approved-leave case started being refused for leave that
// had "already started".
//
// Pinning is the fix that does not rot; moving the August anchors forward would
// only set a new expiry date. The instant keeps every fixture on the side of
// "now" its assertions were written for.
const NOW = '2026-05-01T12:00:00.000Z'

// The seeded employee, as the auth middleware above expects to receive them.
const employeeHeaders = {
  'x-user-id': testUuid('employee-1'),
  'x-user-email': 'alex.employee@example.com',
  'x-user-name': 'Alex Employee',
}

describe('Employee leave workflow endpoints', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>
  let dataSource: DataSource
  let leaveDomain: LeaveDomainService
  let clock: ClockService
  let baseUrl: string

  beforeAll(async () => {
    // ClockService reads TEST_TOOLING_ENABLED once, at construction, and
    // refuses to be set when it is off. Nest builds every provider while
    // creating the app, so the flag is on for exactly that call.
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    app = await NestFactory.create(TestEmployeeAppModule, { logger: false })
    delete process.env['TEST_TOOLING_ENABLED']
    app.use((req: TestRequest, _res: unknown, next: () => void) => {
      const userId = req.header('x-user-id')
      const email = req.header('x-user-email')
      if (userId && email) {
        // Roles default to none when the header is absent: a test that does not
        // opt in must never drift into an administrator code path.
        const rolesHeader = req.header('x-user-roles')
        req.user = {
          id: userId,
          email,
          ...(req.header('x-user-name')
            ? { name: req.header('x-user-name') as string }
            : {}),
          roles: rolesHeader
            ? rolesHeader
                .split(',')
                .map((role) => role.trim())
                .filter(Boolean)
            : [],
        }
      }
      next()
    })
    await app.listen(0)

    dataSource = app.get(DataSource)
    leaveDomain = app.get(LeaveDomainService)
    clock = app.get(ClockService)

    const address = app.getHttpServer().address() as { port: number }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    clock.setNow(NOW)
    await seedLeaveDomain(leaveDomain)
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 for unauthenticated employee routes', async () => {
    const dashboardResponse = await fetch(`${baseUrl}/dashboard/me`)
    expect(dashboardResponse.status).toBe(401)

    const historyResponse = await fetch(`${baseUrl}/leave-requests/me`)
    expect(historyResponse.status).toBe(401)

    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(401)

    const detailResponse = await fetch(`${baseUrl}/leave-requests/test-request`)
    expect(detailResponse.status).toBe(401)

    const formContextResponse = await fetch(
      `${baseUrl}/leave-requests/form-context`,
    )
    expect(formContextResponse.status).toBe(401)

    const approvalResponse = await fetch(
      `${baseUrl}/leave-requests/test-request/approval`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      },
    )
    expect(approvalResponse.status).toBe(401)

    const holidaysResponse = await fetch(`${baseUrl}/holiday-calendars?countryCode=UA`)
    expect(holidaysResponse.status).toBe(401)

    const countriesResponse = await fetch(`${baseUrl}/countries`)
    expect(countriesResponse.status).toBe(401)
  })

  it('serves the reserved country list to any provisioned employee', async () => {
    // A second country so the sort order is observable (Poland before Ukraine).
    await leaveDomain.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: ['manager@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [
        { code: 'PL', name: 'Poland' },
        { code: 'UA', name: 'Ukraine' },
      ],
      updatedAt: '2026-04-01T00:00:00.000Z',
    })

    // No x-user-roles header: a plain provisioned employee, NOT an administrator.
    // Serving this list without the admin guard is the whole reason the route
    // exists alongside /admin/countries.
    const response = await fetch(`${baseUrl}/countries`, {
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
      },
    })
    expect(response.status).toBe(200)

    const countries = (await response.json()) as Array<{
      code: string
      name: string
    }>
    // Sorted by name (Poland < Ukraine), the reserved list, not the catalog.
    expect(countries.map((country) => country.code)).toEqual(['PL', 'UA'])
    expect(countries.map((country) => country.name)).toEqual(['Poland', 'Ukraine'])
  })

  it('serves holiday calendars by country to any provisioned employee', async () => {
    // seedLeaveDomain seeds a CONFIRMED-EMPTY calendar (it only has to satisfy
    // the submission guard), so the dates the request calendar shades have to be
    // seeded here explicitly.
    await seedHolidayCalendar(leaveDomain, {
      countryCode: 'UA',
      year: 2026,
      holidays: [
        { date: '2026-08-24', name: 'Independence Day' },
        { date: '2026-01-01', name: 'New Year' },
      ],
    })

    const authHeaders = {
      'x-user-id': testUuid('employee-1'),
      'x-user-email': 'alex.employee@example.com',
      'x-user-name': 'Alex Employee',
    }

    // Lowercase on the wire: calendars are stored under canonical codes, so the
    // read side must normalize exactly like the write side.
    const response = await fetch(`${baseUrl}/holiday-calendars?countryCode=ua`, {
      headers: authHeaders,
    })
    expect(response.status).toBe(200)

    const calendars = (await response.json()) as Array<{
      year: number
      country: { code: string }
      holidays: Array<{ date: string; name: string }>
    }>
    expect(calendars).toHaveLength(1)
    expect(calendars[0]?.year).toBe(2026)
    expect(calendars[0]?.country.code).toBe('UA')
    expect(calendars[0]?.holidays.map((holiday) => holiday.date)).toEqual([
      '2026-01-01',
      '2026-08-24',
    ])

    // Reference data, not personal data: no admin role is involved, and an
    // unconfigured country is an empty list rather than an error.
    const otherCountry = await fetch(`${baseUrl}/holiday-calendars?countryCode=PL`, {
      headers: authHeaders,
    })
    expect(otherCountry.status).toBe(200)
    expect(await otherCountry.json()).toEqual([])

    const badYear = await fetch(
      `${baseUrl}/holiday-calendars?countryCode=UA&year=nonsense`,
      { headers: authHeaders },
    )
    expect(badYear.status).toBe(400)
  })

  it('serves dashboard, self history, detail, submission, and approval flows for authenticated users', async () => {
    const authHeaders = {
      'x-user-id': testUuid('employee-1'),
      'x-user-email': 'alex.employee@example.com',
      'x-user-name': 'Alex Employee',
    }

    const dashboardResponse = await fetch(`${baseUrl}/dashboard/me`, {
      headers: authHeaders,
    })
    expect(dashboardResponse.status).toBe(200)
    // Balances accrue lazily against the current month, so assert the shape and
    // invariants (available == accrued before any hold) rather than a fixed
    // month-dependent figure.
    const dashboard = (await dashboardResponse.json()) as {
      employeeId: string
      displayName: string
      countryCode?: string
      balances: Array<{
        leaveType: LeaveType
        totalDays: number
        availableDays: number
        accruedDays: number
        onHoldDays: number
      }>
    }
    expect(dashboard).toMatchObject({
      employeeId: testUuid('employee-1'),
      displayName: 'Alex Employee',
      // The cache key the request calendar fetches holiday shading with. Derived
      // from the same user row as holidayCalendarYears, so the two always name
      // the same country.
      countryCode: 'UA',
    })
    const vacation = dashboard.balances.find(
      (balance) => balance.leaveType === LeaveType.Vacation,
    )
    expect(vacation?.totalDays).toBe(24)
    expect(vacation?.onHoldDays).toBe(0)
    expect(vacation?.availableDays).toBe(vacation?.accruedDays)
    expect((vacation?.availableDays ?? 0) > 0).toBe(true)

    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-11',
        comment: 'Spring vacation',
        approverEmails: ['manager@example.com'],
        ccEmails: ['hr@example.com'],
      }),
    })
    expect(createResponse.status).toBe(201)
    const createdRequest = (await createResponse.json()) as {
      requestId: string
      status: LeaveRequestStatus
      requestedDays: number
    }
    expect(createdRequest.status).toBe(LeaveRequestStatus.Pending)
    // 2026-04-10 is a Friday and 04-11 a Saturday, so only the Friday is a
    // working day; the weekend is excluded from the balance cost.
    expect(createdRequest.requestedDays).toBe(1)

    const historyResponse = await fetch(`${baseUrl}/leave-requests/me`, {
      headers: authHeaders,
    })
    expect(historyResponse.status).toBe(200)
    await expect(historyResponse.json()).resolves.toMatchObject({
      requests: [
        expect.objectContaining({
          requestId: createdRequest.requestId,
          status: LeaveRequestStatus.Pending,
        }),
      ],
    })

    // Date-range filter (inclusive overlap). The request is a single day,
    // 2026-04-10.
    const overlapping = await fetch(
      `${baseUrl}/leave-requests/me?from=2026-04-01&to=2026-04-30`,
      { headers: authHeaders },
    )
    expect(overlapping.status).toBe(200)
    expect((await overlapping.json()).requests).toHaveLength(1)

    const afterWindow = await fetch(
      `${baseUrl}/leave-requests/me?from=2026-05-01`,
      { headers: authHeaders },
    )
    expect(afterWindow.status).toBe(200)
    expect((await afterWindow.json()).requests).toHaveLength(0)

    const beforeWindow = await fetch(
      `${baseUrl}/leave-requests/me?to=2026-03-31`,
      { headers: authHeaders },
    )
    expect(beforeWindow.status).toBe(200)
    expect((await beforeWindow.json()).requests).toHaveLength(0)

    const badRange = await fetch(`${baseUrl}/leave-requests/me?from=not-a-date`, {
      headers: authHeaders,
    })
    expect(badRange.status).toBe(400)

    const detailResponse = await fetch(
      `${baseUrl}/leave-requests/${createdRequest.requestId}`,
      { headers: authHeaders },
    )
    expect(detailResponse.status).toBe(200)
    await expect(detailResponse.json()).resolves.toMatchObject({
      requestId: createdRequest.requestId,
      approvers: [
        expect.objectContaining({ email: 'manager@example.com', kind: ApproverKind.To }),
        expect.objectContaining({ email: 'hr@example.com', kind: ApproverKind.Cc }),
      ],
    })

    const approvalResponse = await fetch(
      `${baseUrl}/leave-requests/${createdRequest.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': testUuid('manager-1'),
          'x-user-email': 'manager@example.com',
          'x-user-name': 'Manager',
        },
        body: JSON.stringify({
          action: LeaveApprovalAction.Approve,
          comment: 'Approved',
        }),
      },
    )
    expect(approvalResponse.status).toBe(201)
    await expect(approvalResponse.json()).resolves.toMatchObject({
      requestId: createdRequest.requestId,
      status: LeaveRequestStatus.Approved,
      decisionComment: 'Approved',
    })
  })

  it('forbids an employee from approving their own leave request', async () => {
    const authHeaders = {
      'x-user-id': testUuid('employee-1'),
      'x-user-email': 'alex.employee@example.com',
      'x-user-name': 'Alex Employee',
    }

    // A real approver, not the requester: self-listing is refused at submit now
    // (see the self-recipient test below), so the requester reaches the decision
    // endpoint as a non-approver, which is what this test is about.
    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-11',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const selfApproval = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      },
    )
    expect(selfApproval.status).toBe(403)
  })

  it('refuses an administrator who is not an approver on the decision endpoint', async () => {
    // This endpoint casts a vote toward the all-approvers gate, so it is for
    // designated approvers only. An admin overrides from the admin console
    // instead. Before the endpoint carried a single meaning, this same call
    // silently force-approved the request.
    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const adminApproval = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'x-user-id': testUuid('admin-1'),
          'x-user-email': 'admin@example.com',
          'x-user-roles': AppRoleName.Administrator,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      },
    )
    expect(adminApproval.status).toBe(403)

    // Reading the same request with the SAME identity must still succeed: that
    // is what proves the administrator role really is in play above (an admin
    // is neither the requester nor an approver here, so a dropped role would
    // 403 this too and the assertion above would pass vacuously). It also pins
    // the split: admins keep read access, they just do not get a vote.
    const detail = await fetch(`${baseUrl}/leave-requests/${created.requestId}`, {
      headers: {
        'x-user-id': testUuid('admin-1'),
        'x-user-email': 'admin@example.com',
        'x-user-roles': AppRoleName.Administrator,
      },
    })
    expect(detail.status).toBe(200)
    // The request is untouched: no status change, no fabricated decision.
    await expect(detail.json()).resolves.toMatchObject({
      status: LeaveRequestStatus.Pending,
    })
  })

  it('tells each viewer of a request whether they may decide it', async () => {
    // The approval email links every recipient to the same page, so the detail
    // payload is the only thing that can tell an approver from a copied
    // recipient. Without it the page offered the decision form to whoever
    // opened the link and let them discover the 403 by pressing Approve.
    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-14',
        endDate: '2026-04-14',
        approverEmails: ['manager@example.com'],
        ccEmails: ['hr@example.com'],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const readAs = (userId: string, email: string, roles?: string) =>
      fetch(`${baseUrl}/leave-requests/${created.requestId}`, {
        headers: {
          'x-user-id': userId,
          'x-user-email': email,
          ...(roles ? { 'x-user-roles': roles } : {}),
        },
      })

    // Mixed case on purpose: the caller's authority is decided by the server's
    // email normalization, which is exactly what the client cannot reproduce.
    const copiedDetail = await readAs(testUuid('hr-1'), 'HR@Example.com')
    expect(copiedDetail.status).toBe(200)
    // canOverride pinned false: a copied NON-admin must never carry override
    // authority, and omitting it here would let that escalation pass the
    // endpoint boundary silently.
    await expect(copiedDetail.json()).resolves.toMatchObject({
      viewer: {
        standing: LeaveRequestViewerStanding.Copied,
        canDecide: false,
        canOverride: false,
      },
    })

    // ...and the payload does not merely describe a restriction the endpoint
    // would decline to enforce.
    const copiedApproval = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'x-user-id': testUuid('hr-1'),
          'x-user-email': 'hr@example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      },
    )
    expect(copiedApproval.status).toBe(403)

    const approverDetail = await readAs(testUuid('manager-1'), 'manager@example.com')
    expect(approverDetail.status).toBe(200)
    await expect(approverDetail.json()).resolves.toMatchObject({
      viewer: {
        standing: LeaveRequestViewerStanding.Approver,
        canDecide: true,
        canOverride: false,
      },
    })

    // The requester reads their own request through the same page and must not
    // be offered the form either: no one decides their own request.
    const requesterDetail = await readAs(testUuid('employee-1'), 'alex.employee@example.com')
    expect(requesterDetail.status).toBe(200)
    await expect(requesterDetail.json()).resolves.toMatchObject({
      viewer: {
        standing: LeaveRequestViewerStanding.Requester,
        canDecide: false,
        canOverride: false,
      },
    })

    const adminDetail = await readAs(
      testUuid('admin-1'),
      'admin@example.com',
      AppRoleName.Administrator,
    )
    expect(adminDetail.status).toBe(200)
    // An uninvolved admin on a pending request: no vote, but the override is
    // theirs. This is the only end-to-end check of canOverride on the employee
    // detail endpoint (the review page reads it from here).
    await expect(adminDetail.json()).resolves.toMatchObject({
      viewer: {
        standing: LeaveRequestViewerStanding.Administrator,
        canDecide: false,
        canOverride: true,
      },
    })
  })

  it('holds the request at pending until every to-approver has approved', async () => {
    // The second approver decides, so like the seeded manager they must be a
    // provisioned app user for their decision to reference a real actor.
    await leaveDomain.upsertUser({
      userId: testUuid('lead-1'),
      email: 'lead@example.com',
      displayName: 'Team Lead',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-04-01T00:00:00.000Z',
    })

    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: ['manager@example.com', 'lead@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const decide = (userKey: string, email: string) =>
      fetch(`${baseUrl}/leave-requests/${created.requestId}/approval`, {
        method: 'POST',
        headers: {
          'x-user-id': testUuid(userKey),
          'x-user-email': email,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      })

    // First vote: recorded on the approver, but the request stays Pending.
    const first = await decide('manager-1', 'manager@example.com')
    expect(first.status).toBe(201)
    const afterFirst = (await first.json()) as {
      status: LeaveRequestStatus
      decidedAt?: string
      approvers: Array<{ email: string; decision?: ApproverDecision }>
      viewer?: { canDecide: boolean }
    }
    expect(afterFirst.status).toBe(LeaveRequestStatus.Pending)
    expect(afterFirst.decidedAt).toBeUndefined()
    // The gate is still open, but this voter is spent: their vote is cast.
    expect(afterFirst.viewer?.canDecide).toBe(false)
    expect(
      afterFirst.approvers.find((a) => a.email === 'manager@example.com')
        ?.decision,
    ).toBe(ApproverDecision.Approved)
    expect(
      afterFirst.approvers.find((a) => a.email === 'lead@example.com')?.decision,
    ).toBe(ApproverDecision.Pending)

    // Second and last vote closes the gate. The response must not claim the
    // voter can still decide: the request it describes is no longer Pending,
    // and a client rendering the form from this flag would earn a 400.
    const second = await decide('lead-1', 'lead@example.com')
    expect(second.status).toBe(201)
    await expect(second.json()).resolves.toMatchObject({
      status: LeaveRequestStatus.Approved,
      viewer: { canDecide: false },
    })
  })

  it('spends an approver s vote once and refuses a second one', async () => {
    // Two approvers so the request stays Pending after the first vote: the
    // refusal below must come from the vote being spent, not from the request
    // being closed.
    await leaveDomain.upsertUser({
      userId: testUuid('lead-1'),
      email: 'lead@example.com',
      displayName: 'Team Lead',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-04-01T00:00:00.000Z',
    })

    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-16',
        endDate: '2026-04-16',
        approverEmails: ['manager@example.com', 'lead@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const approval = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'x-user-id': testUuid('manager-1'),
          'x-user-email': 'manager@example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: LeaveApprovalAction.Approve }),
      },
    )
    expect(approval.status).toBe(201)

    // The vote is cast, so the detail withdraws the authority and reports the
    // decision back instead — that sentence is what explains the missing form.
    const voterDetail = await fetch(`${baseUrl}/leave-requests/${created.requestId}`, {
      headers: {
        'x-user-id': testUuid('manager-1'),
        'x-user-email': 'manager@example.com',
      },
    })
    expect(voterDetail.status).toBe(200)
    const voterView = (await voterDetail.json()) as {
      status: LeaveRequestStatus
      viewer?: {
        canDecide: boolean
        ownVote?: { decision?: ApproverDecision; decidedAt?: string }
      }
    }
    expect(voterView.status).toBe(LeaveRequestStatus.Pending)
    expect(voterView.viewer?.canDecide).toBe(false)
    expect(voterView.viewer?.ownVote?.decision).toBe(ApproverDecision.Approved)
    expect(voterView.viewer?.ownVote?.decidedAt).toEqual(expect.any(String))

    // ...and the endpoint enforces it, so the flag is not a suggestion the API
    // would happily contradict. Before this, a second click silently revised
    // the decision.
    const secondAttempt = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'x-user-id': testUuid('manager-1'),
          'x-user-email': 'manager@example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: LeaveApprovalAction.Reject }),
      },
    )
    expect(secondAttempt.status).toBe(403)

    // The co-approver has not voted, so they keep their authority and get no
    // standing of their own: the field reports the CALLER's vote, never the
    // request's progress.
    const otherDetail = await fetch(`${baseUrl}/leave-requests/${created.requestId}`, {
      headers: {
        'x-user-id': testUuid('lead-1'),
        'x-user-email': 'lead@example.com',
      },
    })
    expect(otherDetail.status).toBe(200)
    const otherView = (await otherDetail.json()) as {
      viewer?: { canDecide: boolean; ownVote?: { decision?: ApproverDecision } }
    }
    expect(otherView.viewer?.canDecide).toBe(true)
    expect(otherView.viewer?.ownVote).toBeUndefined()

    // The refusal above did not disturb the recorded decision or the gate.
    const afterRefusal = (await (
      await fetch(`${baseUrl}/leave-requests/${created.requestId}`, {
        headers: {
          'x-user-id': testUuid('lead-1'),
          'x-user-email': 'lead@example.com',
        },
      })
    ).json()) as {
      status: LeaveRequestStatus
      approvers: Array<{ email: string; decision?: ApproverDecision }>
    }
    expect(afterRefusal.status).toBe(LeaveRequestStatus.Pending)
    expect(
      afterRefusal.approvers.find((a) => a.email === 'manager@example.com')
        ?.decision,
    ).toBe(ApproverDecision.Approved)
  })

  it('refuses a second vote at the domain, under the row lock', async () => {
    // The HTTP path above refuses a repeat via the pre-transaction snapshot. But
    // two concurrent votes could both pass that snapshot and only serialize
    // inside the transaction, so the domain must ALSO refuse under its row lock —
    // that is the authoritative guard against a double-click quietly flipping a
    // recorded decision. Calling the domain directly bypasses the app-layer
    // check and exercises exactly that guard.
    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-20',
        endDate: '2026-04-20',
        approverEmails: ['manager@example.com', 'lead@example.com'],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { requestId: string }

    const vote = () =>
      leaveDomain.decideLeaveRequest({
        requestId: created.requestId,
        actorUserId: testUuid('manager-1'),
        actorDisplayName: 'Manager',
        actorEmail: 'manager@example.com',
        action: LeaveApprovalAction.Approve,
        comment: 'Approved',
      })

    await vote()
    // The request is still Pending (a co-approver is outstanding), so it is only
    // the already-decided row — not a closed request — that turns the second
    // vote away.
    await expect(vote()).rejects.toThrowError('already decided')
  })

  it('refuses a request that names its own requester as an approver', async () => {
    // An approver list containing the requester builds a gate that can never be
    // met: nobody decides their own request. Refused outright rather than
    // silently dropped, so the requester sees the name go.
    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-17',
        endDate: '2026-04-17',
        // Mixed case on purpose: the check runs on normalized addresses.
        approverEmails: ['manager@example.com', 'Alex.Employee@EXAMPLE.com'],
        ccEmails: [],
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('yourself as a recipient'),
    })
  })

  it('ignores a client-supplied decidedAt on the approval decision', async () => {
    const create = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-11',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    const created = (await create.json()) as { requestId: string }

    const decision = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}/approval`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': testUuid('manager-1'),
          'x-user-email': 'manager@example.com',
        },
        body: JSON.stringify({
          action: LeaveApprovalAction.Reject,
          decidedAt: '2000-01-01T00:00:00.000Z',
        }),
      },
    )
    expect(decision.status).toBe(201)
    const decided = (await decision.json()) as { decidedAt?: string }
    expect(decided.decidedAt).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it('rejects a submission with an invalid approver email', async () => {
    const authHeaders = {
      'x-user-id': testUuid('employee-1'),
      'x-user-email': 'alex.employee@example.com',
      'content-type': 'application/json',
    }

    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-11',
        approverEmails: ['not-an-email'],
        ccEmails: [],
      }),
    })
    expect(response.status).toBe(400)
  })

  it('serves the request form context: directory minus the caller, defaults minus the caller', async () => {
    // A plain provisioned employee, no admin role: the directory route must be
    // readable without the admin guard, unlike /admin/employees/options.
    const response = await fetch(`${baseUrl}/leave-requests/form-context`, {
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
      },
    })
    expect(response.status).toBe(200)

    const context = (await response.json()) as {
      users: Array<{ userId: string; displayName: string; email: string }>
      defaultApprovers: Array<{ email: string; displayName?: string }>
      defaultCc: Array<{ email: string; displayName?: string }>
    }
    // Everyone except the caller (self-approval is rejected at submit).
    expect(context.users).toEqual([
      {
        userId: testUuid('manager-1'),
        displayName: 'Manager',
        email: 'manager@example.com',
      },
    ])
    // The seeded default approver resolves to a provisioned user, so the
    // preview carries their display name; the default CC address has no user
    // row and stays a bare email (still a valid default).
    expect(context.defaultApprovers).toEqual([
      { email: 'manager@example.com', displayName: 'Manager' },
    ])
    expect(context.defaultCc).toEqual([{ email: 'hr@example.com' }])
  })

  it('excludes the caller from the defaults preview, mirroring the submit merge', async () => {
    // The manager IS the settings default approver: their own preview must not
    // list them (submit drops the requester from the merged approvers).
    const response = await fetch(`${baseUrl}/leave-requests/form-context`, {
      headers: {
        'x-user-id': testUuid('manager-1'),
        'x-user-email': 'manager@example.com',
      },
    })
    expect(response.status).toBe(200)

    const context = (await response.json()) as {
      users: Array<{ email: string }>
      defaultApprovers: Array<{ email: string }>
      defaultCc: Array<{ email: string }>
    }
    expect(context.users.map((user) => user.email)).toEqual([
      'alex.employee@example.com',
    ])
    expect(context.defaultApprovers).toEqual([])
    expect(context.defaultCc).toEqual([{ email: 'hr@example.com' }])
  })

  it('accepts a submission with no client approvers when a settings default covers it', async () => {
    const createResponse = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: [],
        ccEmails: [],
      }),
    })
    expect(createResponse.status).toBe(201)

    const created = (await createResponse.json()) as {
      requestId: string
      approvers: Array<{ email: string; kind: ApproverKind }>
    }
    // The merged approvers are exactly the settings defaults.
    expect(created.approvers).toEqual([
      expect.objectContaining({
        email: 'manager@example.com',
        kind: ApproverKind.To,
      }),
      expect.objectContaining({ email: 'hr@example.com', kind: ApproverKind.Cc }),
    ])
  })

  it('still rejects a submission with no approvers at all', async () => {
    // No client approvers AND no settings defaults: the post-merge domain gate
    // is the enforcer now that the app layer no longer pre-checks the payload.
    await leaveDomain.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-04-01T00:00:00.000Z',
    })

    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('employee-1'),
        'x-user-email': 'alex.employee@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: [],
        ccEmails: [],
      }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      message: 'Leave request must have at least one approver other than the requester.',
    })
  })

  it('auto-approves an approver-less submission when approval is optional, and emails accordingly', async () => {
    // The whole point of the branch in publishSubmissionEmails: the approval
    // request must NOT be published (its handler would mint a permanently
    // failed delivery row for a request nobody can decide), the CC copy notice
    // must be, and the requester still gets the approved mail.
    await leaveDomain.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      approvalRequired: false,
      defaultApproverEmails: ['manager@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-04-01T00:00:00.000Z',
    })

    const published: unknown[] = []
    const subscription = app
      .get(EventBus)
      .subscribe((event: unknown) => published.push(event))
    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: [],
        ccEmails: [],
      }),
    })
    subscription.unsubscribe()

    expect(response.status).toBe(201)
    const created = (await response.json()) as {
      status: string
      decisionComment?: string
      approvers: Array<{ email: string; kind: ApproverKind }>
      activity: Array<{ action: string; actorDisplayName: string }>
    }
    expect(created.status).toBe(LeaveRequestStatus.Approved)
    expect(created.decisionComment).toBe('Processed automatically')
    // The deciding default is not applied; the CC default always is.
    expect(created.approvers).toEqual([
      expect.objectContaining({ email: 'hr@example.com', kind: ApproverKind.Cc }),
    ])
    expect(created.activity.map((entry) => entry.action)).toEqual([
      'submitted',
      'auto-approved',
    ])

    expect(
      published.some((event) => event instanceof LeaveRequestSubmittedEvent),
    ).toBe(false)
    const copyNotice = published.find(
      (event): event is LeaveRequestAutoApprovedEvent =>
        event instanceof LeaveRequestAutoApprovedEvent,
    )
    expect(copyNotice?.ccEmails).toEqual(['hr@example.com'])
    const approved = published.find(
      (event): event is LeaveRequestApprovedEvent =>
        event instanceof LeaveRequestApprovedEvent,
    )
    expect(approved?.actorDisplayName).toBe('System')
  })

  it('keeps the ordinary approval mail path when an approver is named under the same setting', async () => {
    await leaveDomain.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      approvalRequired: false,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-04-01T00:00:00.000Z',
    })

    const published: unknown[] = []
    const subscription = app
      .get(EventBus)
      .subscribe((event: unknown) => published.push(event))
    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-15',
        endDate: '2026-06-16',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    subscription.unsubscribe()

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      status: LeaveRequestStatus.Pending,
    })
    expect(
      published.some((event) => event instanceof LeaveRequestSubmittedEvent),
    ).toBe(true)
    expect(
      published.some((event) => event instanceof LeaveRequestAutoApprovedEvent),
    ).toBe(false)
  })

  it('rejects a submission whose only approver is the requester via the defaults', async () => {
    // The manager is the sole default approver and submits their own request:
    // the self-exclusion leaves zero 'to' approvers, so the gate rejects it.
    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: {
        'x-user-id': testUuid('manager-1'),
        'x-user-email': 'manager@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        approverEmails: [],
        ccEmails: [],
      }),
    })
    expect(response.status).toBe(400)
  })

  it('answers the availability question on its own route, not as a request id', async () => {
    // 'availability' is a static segment sharing a prefix with ':requestId'.
    // If it ever slipped below that route, this would 404 as an unknown
    // request instead of returning a verdict.
    const response = await fetch(
      `${baseUrl}/leave-requests/availability?leaveType=vacation&startDate=2026-08-03&endDate=2026-08-07`,
      { headers: employeeHeaders },
    )
    expect(response.status).toBe(200)

    const preview = (await response.json()) as {
      requestedDays: number
      feasible: boolean
      monthlyOutlook: Array<{ month: number }>
      currentYear: number
      years: Array<{ year: number; requestedDays: number }>
    }
    expect(preview.requestedDays).toBe(5)
    expect(preview.feasible).toBe(true)
    expect(preview.monthlyOutlook).toHaveLength(12)
    // The per-year block survives serialization, this year and next. Asserted
    // relative to the payload's own currentYear: this spec runs on the real
    // clock, so the arithmetic belongs to the domain spec, not here.
    expect(preview.years.map((year) => year.year)).toEqual([
      preview.currentYear,
      preview.currentYear + 1,
    ])
    expect(
      preview.years.find((year) => year.year === preview.currentYear)
        ?.requestedDays,
    ).toBe(5)
  })

  it('accepts a request the balance cannot fund and reports its unpaid days', async () => {
    // Nothing allocated for the year, so nothing can be funded: the whole
    // request is unpaid, and the endpoint takes it rather than refusing.
    await leaveDomain.setEmployeeAllocation({
      userId: testUuid('employee-1'),
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 0,
    })

    const response = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-07',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      status: LeaveRequestStatus.Pending,
      requestedDays: 5,
      paidDays: 0,
      unpaidDays: 5,
    })
  })

  it('answers the availability question with the split, not a refusal', async () => {
    await leaveDomain.setEmployeeAllocation({
      userId: testUuid('employee-1'),
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 0,
    })

    const response = await fetch(
      `${baseUrl}/leave-requests/availability?leaveType=vacation&startDate=2026-08-03&endDate=2026-08-07`,
      { headers: employeeHeaders },
    )
    expect(response.status).toBe(200)

    const preview = (await response.json()) as {
      feasible: boolean
      blockers: unknown[]
      paidDays: number
      unpaidDays: number
      unpaidDates: string[]
      unpaidNotice?: string
    }
    expect(preview.feasible).toBe(true)
    expect(preview.blockers).toEqual([])
    expect(preview.paidDays).toBe(0)
    expect(preview.unpaidDays).toBe(5)
    expect(preview.unpaidDates).toHaveLength(5)
    expect(preview.unpaidNotice).toContain('unpaid')
  })

  it('rejects an availability question that names no valid leave type', async () => {
    const response = await fetch(
      `${baseUrl}/leave-requests/availability?leaveType=holiday&startDate=2026-08-03&endDate=2026-08-07`,
      { headers: employeeHeaders },
    )
    expect(response.status).toBe(400)
  })

  it('refuses a malformed hours list instead of pricing the period as whole days', async () => {
    const period =
      'leaveType=vacation&startDate=2026-08-03&endDate=2026-08-07'
    const ask = (query: string) =>
      fetch(`${baseUrl}/leave-requests/availability?${period}&${query}`, {
        headers: employeeHeaders,
      })

    // Express hands a repeated key over as an array, which used to reach a
    // string helper and answer 500 on what is plainly a client mistake.
    expect((await ask('hours=2026-08-03:4&hours=2026-08-04:2')).status).toBe(
      400,
    )
    // '__proto__' written into a plain object literal hits the prototype
    // setter and disappears, so the date checks never saw the entry they exist
    // to refuse and the employee was quoted a whole-day cost for a shape the
    // submission would have rejected.
    expect((await ask('hours=__proto__:4')).status).toBe(400)
    expect((await ask('hours=2026-08-03:0')).status).toBe(400)
    expect((await ask('hours=nonsense')).status).toBe(400)
  })

  it('names the field the caller actually sent when it refuses hours', async () => {
    const response = await fetch(
      `${baseUrl}/leave-requests/availability?leaveType=vacation&startDate=2026-08-03&endDate=2026-08-07&hours=2026-09-01:4`,
      { headers: employeeHeaders },
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain('hours names 2026-09-01')
    expect(body.message).not.toContain('hoursByDate')
  })

  it('serves the part-day shape as JSON, and no such key for a whole-day request', async () => {
    const submitted = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-07',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        hoursByDate: { '2026-08-05': 4, '2026-08-06': 2 },
      }),
    })
    expect(submitted.status).toBe(201)

    // The wire speaks hours in and PORTIONS out: a client renders hours from
    // the portion through the workday length it already holds, and the portion
    // is what the request was priced at whatever that setting becomes later.
    const created = (await submitted.json()) as {
      requestId: string
      requestedDays: number
      dayPortions?: Record<string, number>
    }
    expect(created.requestedDays).toBe(3.75)
    expect(created.dayPortions).toEqual({
      '2026-08-05': 0.5,
      '2026-08-06': 0.25,
    })

    // Every recipient reaches the request through the deep link, so the shape
    // has to survive the read as well as the write.
    const detail = await fetch(
      `${baseUrl}/leave-requests/${created.requestId}`,
      { headers: employeeHeaders },
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      dayPortions: { '2026-08-05': 0.5, '2026-08-06': 0.25 },
    })

    // A whole-day request carries no such key at all, which is the payload
    // every client already renders.
    const whole = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-10',
        endDate: '2026-08-14',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    expect(whole.status).toBe(201)
    const wholeBody = (await whole.json()) as Record<string, unknown>
    expect(Object.hasOwn(wholeBody, 'dayPortions')).toBe(false)
  })

  it('routes a change to an approved leave through re-approval, and only for its owner', async () => {
    const submitted = await fetch(`${baseUrl}/leave-requests`, {
      method: 'POST',
      headers: { ...employeeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-07',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
      }),
    })
    const original = (await submitted.json()) as { requestId: string }
    await leaveDomain.decideLeaveRequest({
      requestId: original.requestId,
      actorUserId: testUuid('manager-1'),
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
    })

    // Someone else's leave is not theirs to change.
    const forbidden = await fetch(
      `${baseUrl}/leave-requests/${original.requestId}/modify`,
      {
        method: 'POST',
        headers: {
          'x-user-id': testUuid('manager-1'),
          'x-user-email': 'manager@example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          startDate: '2026-08-10',
          endDate: '2026-08-14',
          approverEmails: ['manager@example.com'],
          ccEmails: [],
        }),
      },
    )
    expect(forbidden.status).toBe(403)

    const response = await fetch(
      `${baseUrl}/leave-requests/${original.requestId}/modify`,
      {
        method: 'POST',
        headers: { ...employeeHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          startDate: '2026-08-10',
          endDate: '2026-08-14',
          approverEmails: ['manager@example.com'],
          ccEmails: [],
        }),
      },
    )
    expect(response.status).toBe(201)

    // What comes back is the REPLACEMENT, awaiting approval and carrying the
    // original with it so the approver can see both sets of dates.
    const replacement = (await response.json()) as {
      requestId: string
      status: LeaveRequestStatus
      supersedesRequestId?: string
      supersedes?: { startDate: string }
    }
    expect(replacement.status).toBe(LeaveRequestStatus.Pending)
    expect(replacement.supersedesRequestId).toBe(original.requestId)
    expect(replacement.supersedes?.startDate).toBe('2026-08-03')
    expect(replacement.requestId).not.toBe(original.requestId)

    // And the leave it replaces is still approved, flagged as under change.
    const history = await fetch(`${baseUrl}/leave-requests/me`, {
      headers: employeeHeaders,
    })
    const { requests } = (await history.json()) as {
      requests: Array<{
        requestId: string
        status: LeaveRequestStatus
        modificationPending?: boolean
      }>
    }
    expect(
      requests.find((request) => request.requestId === original.requestId),
    ).toMatchObject({
      status: LeaveRequestStatus.Approved,
      modificationPending: true,
    })
  })
})

async function seedLeaveDomain(
  leaveDomain: LeaveDomainService,
): Promise<void> {
  await leaveDomain.updateLeaveSettings({
    defaultVacationDays: 24,
    defaultSickDays: 12,
    defaultApproverEmails: ['manager@example.com'],
    defaultCcApproverEmails: ['hr@example.com'],
    countries: [{ code: 'UA', name: 'Ukraine' }],
    updatedAt: '2026-04-01T00:00:00.000Z',
  })

  await seedHolidayCalendar(leaveDomain)

  // Provisioning seeds and accrues balances up to the creation date; the read
  // paths accrue further to the current month on demand.
  await leaveDomain.upsertUser({
    userId: testUuid('employee-1'),
    email: 'alex.employee@example.com',
    displayName: 'Alex Employee',
    countryCode: 'UA',
    employmentStartDate: '2026-01-01',
    createdAt: '2026-04-01T00:00:00.000Z',
  })

  // The approver is an app user too (provisioned at their OIDC login in prod);
  // provision them here so their decision references a real actor.
  await leaveDomain.upsertUser({
    userId: testUuid('manager-1'),
    email: 'manager@example.com',
    displayName: 'Manager',
    countryCode: 'UA',
    employmentStartDate: '2026-01-01',
    createdAt: '2026-04-01T00:00:00.000Z',
  })
}
