/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  AdminActivityFeedDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import {
  ApproverKind,
  LeaveApprovalAction,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
} from '@workspace/contracts'
import { createAdminApiClient } from './admin-api'
import { applyDecisionToFeed } from './admin-formatters'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('admin decision api client', () => {
  it('GETs one leave request from the admin surface', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ requestId: 'request-1' }),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await client.getLeaveRequestDetail('request-1')

    const [url, init] = fetchMock.mock.calls[0]
    // The console stays on /api/admin/* so it never depends on the employee
    // module's authorization branch.
    expect(String(url)).toContain('/api/admin/leave-requests/request-1')
    expect(init).toBeUndefined()
  })

  it('POSTs an override with its mandatory reason', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ requestId: 'request-1' }),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await client.forceDecideRequest('request-1', {
      action: LeaveApprovalAction.Approve,
      comment: 'Approver left the company',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(
      '/api/admin/leave-requests/request-1/force-decision',
    )
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      action: LeaveApprovalAction.Approve,
      comment: 'Approver left the company',
    })
  })

  it('surfaces the server message verbatim so the override reason rule reaches the dialog', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            message:
              'comment is required: record why the approver gate is being overridden.',
          },
          false,
          400,
        ),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await expect(
      client.forceDecideRequest('request-1', {
        action: LeaveApprovalAction.Approve,
      }),
    ).rejects.toThrowError('comment is required')
  })
})

describe('applyDecisionToFeed', () => {
  const feed = (): AdminActivityFeedDto => ({
    hoursPerDay: 8,
    items: [
      {
        requestId: 'request-1',
        employeeId: 'employee-1',
        employeeDisplayName: 'Alex Morgan',
        status: LeaveRequestStatus.Pending,
        leaveType: LeaveType.Vacation,
        startDate: '2026-07-10',
        endDate: '2026-07-10',
        requestedDays: 1,
        paidDays: 1,
        unpaidDays: 0,
        heldDays: 1,
        submittedAt: '2026-07-01T09:30:00.000Z',
        lastAction: 'submitted',
        lastActivityAt: '2026-07-01T09:30:00.000Z',
      },
      {
        requestId: 'request-2',
        employeeId: 'employee-2',
        employeeDisplayName: 'Sam Rivera',
        status: LeaveRequestStatus.Pending,
        leaveType: LeaveType.Sick,
        startDate: '2026-07-20',
        endDate: '2026-07-20',
        requestedDays: 1,
        paidDays: 1,
        unpaidDays: 0,
        heldDays: 1,
        submittedAt: '2026-07-02T09:30:00.000Z',
        lastAction: 'submitted',
        lastActivityAt: '2026-07-02T09:30:00.000Z',
      },
    ],
    totals: { total: 2, pending: 2, approved: 0, rejected: 0, cancelled: 0 },
    nextCursor: 'request-2',
  })

  const decided = (
    status: LeaveRequestStatus,
    action: string,
  ): LeaveRequestDetailDto => ({
    hoursPerDay: 8,
    requestId: 'request-1',
    leaveType: LeaveType.Vacation,
    status,
    startDate: '2026-07-10',
    endDate: '2026-07-10',
    requestedDays: 1,
    paidDays: 1,
    unpaidDays: 0,
    heldDays: 1,
    submittedAt: '2026-07-01T09:30:00.000Z',
    requesterUserId: 'employee-1',
    requesterDisplayName: 'Alex Morgan',
    approvers: [{ email: 'lead@example.com', kind: ApproverKind.To }],
    // Oldest-first, so the newest entry is last.
    activity: [
      {
        actorDisplayName: 'Alex Morgan',
        action: 'submitted',
        occurredAt: '2026-07-01T09:30:00.000Z',
      },
      {
        actorDisplayName: 'Admin',
        action,
        occurredAt: '2026-07-03T11:00:00.000Z',
      },
    ],
    balanceTimeline: [],
    unpaidDates: [],
    decidedAt: '2026-07-03T11:00:00.000Z',
  })

  it('moves the decided row and its counters, leaving other rows alone', () => {
    const next = applyDecisionToFeed(
      feed(),
      decided(LeaveRequestStatus.Approved, 'force-approved'),
    )

    expect(next.items[0]).toMatchObject({
      requestId: 'request-1',
      status: LeaveRequestStatus.Approved,
      lastAction: 'force-approved',
      lastActivityAt: '2026-07-03T11:00:00.000Z',
    })
    expect(next.items[1]).toEqual(feed().items[1])
    // The counter must actually move: spreading the old feed without naming
    // `totals` would silently carry the stale numbers through.
    expect(next.totals).toEqual({
      total: 2,
      pending: 1,
      approved: 1,
      rejected: 0,
      cancelled: 0,
    })
    // Paging is preserved — the whole point of not refetching.
    expect(next.nextCursor).toBe('request-2')
  })

  it('is idempotent, so a repeated report cannot drift the counters', () => {
    const once = applyDecisionToFeed(
      feed(),
      decided(LeaveRequestStatus.Rejected, 'force-rejected'),
    )
    const twice = applyDecisionToFeed(
      once,
      decided(LeaveRequestStatus.Rejected, 'force-rejected'),
    )

    expect(twice).toBe(once)
    expect(twice.totals).toEqual({
      total: 2,
      pending: 1,
      approved: 0,
      rejected: 1,
      cancelled: 0,
    })
  })

  it('ignores a request that is not on the loaded pages', () => {
    const original = feed()
    const elsewhere = {
      ...decided(LeaveRequestStatus.Approved, 'force-approved'),
      requestId: 'request-99',
    }

    expect(applyDecisionToFeed(original, elsewhere)).toBe(original)
  })

  it('patches the row without totals on a load-more page', () => {
    // Cursor pages omit totals; the row must still update.
    const paged: AdminActivityFeedDto = {
      hoursPerDay: 8,
      items: feed().items }
    const next = applyDecisionToFeed(
      paged,
      decided(LeaveRequestStatus.Approved, 'force-approved'),
    )

    expect(next.items[0]?.status).toBe(LeaveRequestStatus.Approved)
    expect(next.totals).toBeUndefined()
  })

  it('refreshes the row viewer from the response, dropping a stale canOverride', () => {
    // The pending row carried canOverride:true (it was overridable). After the
    // override settles it, the patched row must adopt the response's fresh
    // viewer (canOverride:false), not keep the stale true that would re-offer a
    // spent override — see rowActionFor's status-first gate for the UI effect.
    const stale: AdminActivityFeedDto = {
      hoursPerDay: 8,
      items: [
        {
          ...feed().items[0]!,
          viewer: {
            standing: LeaveRequestViewerStanding.Administrator,
            canDecide: false,
            canOverride: true,
          },
        },
      ],
    }
    const next = applyDecisionToFeed(stale, {
      ...decided(LeaveRequestStatus.Approved, 'force-approved'),
      viewer: {
        standing: LeaveRequestViewerStanding.Administrator,
        canDecide: false,
        canOverride: false,
      },
    })

    expect(next.items[0]?.viewer).toEqual({
      standing: LeaveRequestViewerStanding.Administrator,
      canDecide: false,
      canOverride: false,
    })
  })
})
