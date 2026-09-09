/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ApproverKind,
  LeaveRequestStatus,
  LeaveType,
  type LeaveAvailabilityPreviewDto,
  type LeaveRequestDetailDto,
} from '@workspace/contracts'
import { buildModifyPrefill } from './LeaveRequestPage'
import { AvailabilityNotices } from './employee-ui'
import {
  createEmployeeFeatureStore,
  employeeFeatureActions,
} from './employee-feature.store'

// The debounce on the availability epic is 250ms, so these waits have to clear
// it; everything else settles on a microtask.
async function flushAsyncWork(ms = 0) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

function errorResponse(message: string): Response {
  return {
    ok: false,
    status: 400,
    json: async () => ({ message }),
  } as unknown as Response
}

const approvedLeave: LeaveRequestDetailDto = {
  hoursPerDay: 8,
  requestId: 'req-approved',
  requesterUserId: 'employee-1',
  requesterDisplayName: 'Maya Chen',
  leaveType: LeaveType.Sick,
  status: LeaveRequestStatus.Approved,
  startDate: '2026-08-03',
  endDate: '2026-08-07',
  requestedDays: 5,
  paidDays: 5,
  unpaidDays: 0,
  heldDays: 5,
  submittedAt: '2026-03-02T09:00:00.000Z',
  comment: 'Recovery',
  approvers: [
    { email: 'manager@example.com', kind: ApproverKind.To },
    { email: 'policy@example.com', kind: ApproverKind.To },
    { email: 'hr@example.com', kind: ApproverKind.Cc },
  ],
  activity: [],
  balanceTimeline: [],
  unpaidDates: [],
}

const previewFixture: LeaveAvailabilityPreviewDto = {
  leaveType: LeaveType.Vacation,
  leaveYear: 2026,
  startDate: '2026-08-03',
  endDate: '2026-08-14',
  requestedDays: 10,
  paidDays: 10,
  unpaidDays: 0,
  unpaidDates: [],
  feasible: true,
  blockers: [],
  monthlyOutlook: [],
  // One honest year rather than an empty array: the server always projects at
  // least this year and next, so a fixture that says otherwise would teach a
  // shape the API never emits.
  years: [
    {
      year: 2026,
      totalDays: 24,
      carriedOverDays: 0,
      carryoverProjected: false,
      accruedDays: 6,
      spentDays: 0,
      committedDays: 0,
      projectedAccruedByLeave: 16,
      lastLeaveDay: '2026-08-14',
      projectedYearEndAccrual: 24,
      requestedDays: 10,
      paidDays: 10,
      unpaidDays: 0,
      carryoverOutDays: 0,
    },
  ],
  currentYear: 2026,
  generatedAt: '2026-03-02T09:00:00.000Z',
}

describe('buildModifyPrefill', () => {
  it('opens the form on the leave being changed, keeping its type and approvers', () => {
    const prefill = buildModifyPrefill(approvedLeave, [], [])

    expect(prefill).toEqual({
      leaveType: LeaveType.Sick,
      startDate: '2026-08-03',
      endDate: '2026-08-07',
      comment: 'Recovery',
      approverEmails: ['manager@example.com', 'policy@example.com'],
      ccEmails: ['hr@example.com'],
    })
  })

  it('drops approvers that policy now adds on its own, so no chip duplicates a locked one', () => {
    const prefill = buildModifyPrefill(
      approvedLeave,
      [{ email: 'policy@example.com' }],
      [{ email: 'hr@example.com' }],
    )

    expect(prefill.approverEmails).toEqual(['manager@example.com'])
    expect(prefill.ccEmails).toEqual([])
  })

  it('keeps an approver of the original who is only a CC default', () => {
    // Pooling the two locked lists dropped this person from the approvers,
    // and with approval optional that turns a change to a human-approved
    // leave into one the system approves the moment it is submitted.
    const prefill = buildModifyPrefill(
      approvedLeave,
      [],
      [{ email: 'manager@example.com' }],
    )

    expect(prefill.approverEmails).toContain('manager@example.com')
    // The same address is not offered as a CC pick: the locked chip covers it.
    expect(prefill.ccEmails).not.toContain('manager@example.com')
  })

  it('leaves the comment empty rather than undefined when the leave had none', () => {
    const prefill = buildModifyPrefill(
      { ...approvedLeave, comment: undefined },
      [],
      [],
    )

    expect(prefill.comment).toBe('')
  })
})

describe('availability preview state', () => {
  it('keeps the previous verdict on screen while the next one loads', async () => {
    const store = createEmployeeFeatureStore(
      vi.fn(async () => jsonResponse(previewFixture)) as typeof fetch,
    )

    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
      }),
    )
    await flushAsyncWork(300)
    expect(store.getState().requestComposer.availability).toMatchObject({
      status: 'succeeded',
      data: { feasible: true },
    })

    // A second question about a different range must not blank the panel: the
    // employee keeps reading the previous answer until the new one lands.
    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-09-07',
        endDate: '2026-09-18',
      }),
    )
    expect(store.getState().requestComposer.availability).toMatchObject({
      status: 'loading',
      data: { feasible: true },
    })
  })

  it('asks about the committed range and carries the exclusion in modify mode', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(previewFixture),
    )
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
        excludeRequestId: 'req-approved',
      }),
    )
    await flushAsyncWork(300)

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/api/leave-requests/availability')
    expect(url).toContain('leaveType=vacation')
    expect(url).toContain('startDate=2026-08-03')
    expect(url).toContain('excludeRequestId=req-approved')
  })

  it('asks about the very hours the submission will freeze', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(previewFixture),
    )
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
        hoursByDate: { '2026-08-05': 4, '2026-08-06': 2 },
      }),
    )
    await flushAsyncWork(300)

    // One compact list, sent once: the endpoint refuses a repeated `hours`
    // rather than guessing which copy is meant, and it is the same map the
    // submit body carries, so the panel cannot predict a split submit would
    // not produce.
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://test')
    expect(url.searchParams.getAll('hours')).toEqual([
      '2026-08-05:4,2026-08-06:2',
    ])
  })

  it('leaves the hours off a whole-day question entirely', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(previewFixture),
    )
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
        hoursByDate: {},
      }),
    )
    await flushAsyncWork(300)

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('hours=')
  })

  it('fails open: a preview that cannot load leaves no verdict behind', async () => {
    const store = createEmployeeFeatureStore(
      vi.fn(async () => errorResponse('Preview unavailable')) as typeof fetch,
    )

    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
      }),
    )
    await flushAsyncWork(300)

    const availability = store.getState().requestComposer.availability
    expect(availability.status).toBe('failed')
    expect(availability.data).toBeUndefined()
  })

  it('clears the verdict when the composer is left', async () => {
    const store = createEmployeeFeatureStore(
      vi.fn(async () => jsonResponse(previewFixture)) as typeof fetch,
    )
    store.dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-14',
      }),
    )
    await flushAsyncWork(300)

    store.dispatch(employeeFeatureActions.requestSubmissionReset())

    expect(store.getState().requestComposer.availability).toEqual({
      status: 'idle',
    })
    expect(store.getState().requestComposer.modify).toBeUndefined()
  })
})

describe('submitting a change to approved leave', () => {
  const replacement: LeaveRequestDetailDto = {
    ...approvedLeave,
    requestId: 'req-replacement',
    status: LeaveRequestStatus.Pending,
    startDate: '2026-08-10',
    endDate: '2026-08-14',
    supersedesRequestId: 'req-approved',
  }

  it('posts the new dates to the modify route and refreshes the workspace', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(replacement)
      }
      return jsonResponse(
        String(input).includes('/api/dashboard/me') ? {} : { requests: [] },
      )
    })
    const store = createEmployeeFeatureStore(fetchMock as typeof fetch)

    store.dispatch(
      employeeFeatureActions.modificationSubmitted({
        requestId: 'req-approved',
        payload: {
          startDate: '2026-08-10',
          endDate: '2026-08-14',
          comment: 'Shifted a week',
          approverEmails: ['manager@example.com'],
          ccEmails: [],
        },
      }),
    )
    await flushAsyncWork()

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(String(post?.[0])).toContain('/api/leave-requests/req-approved/modify')
    // The leave type is deliberately absent: it stays the original's.
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      startDate: '2026-08-10',
      endDate: '2026-08-14',
      comment: 'Shifted a week',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
    })

    const composer = store.getState().requestComposer
    expect(composer.submitStatus).toBe('succeeded')
    // The REPLACEMENT comes back, linked to the leave it will replace.
    expect(composer.createdRequest?.supersedesRequestId).toBe('req-approved')
    // And the workspace refetched, so balances and history reflect it.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/api/dashboard/me'),
      ),
    ).toBe(true)
  })

  it('surfaces the server refusal verbatim', async () => {
    const store = createEmployeeFeatureStore(
      vi.fn(async () =>
        errorResponse('A modification for this leave is already awaiting approval.'),
      ) as typeof fetch,
    )

    store.dispatch(
      employeeFeatureActions.modificationSubmitted({
        requestId: 'req-approved',
        payload: {
          startDate: '2026-08-10',
          endDate: '2026-08-14',
          approverEmails: [],
          ccEmails: [],
        },
      }),
    )
    await flushAsyncWork()

    expect(store.getState().requestComposer.submitError).toBe(
      'A modification for this leave is already awaiting approval.',
    )
  })

  it('loads the leave being changed into the composer', async () => {
    const store = createEmployeeFeatureStore(
      vi.fn(async () => jsonResponse(approvedLeave)) as typeof fetch,
    )

    store.dispatch(employeeFeatureActions.modifyContextRequested('req-approved'))
    await flushAsyncWork()

    expect(store.getState().requestComposer.modify).toMatchObject({
      requestId: 'req-approved',
      status: 'succeeded',
      original: { startDate: '2026-08-03' },
    })
  })
})

describe('availability notices', () => {
  it('renders the server sentence about unpaid days without calling the dates blocked', () => {
    const markup = renderToString(
      <AvailabilityNotices
        status="succeeded"
        preview={{
          ...previewFixture,
          paidDays: 7,
          unpaidDays: 3,
          unpaidDates: ['2026-08-12', '2026-08-13', '2026-08-14'],
          unpaidNotice:
            'Your projected balance covers 7 of these 10 day(s); the other 3 would be unpaid.',
        }}
      />,
    )

    // Verbatim, because the composer never paraphrases a server rule.
    expect(markup).toContain(
      'Your projected balance covers 7 of these 10 day(s); the other 3 would be unpaid.',
    )
    expect(markup).toContain('availability-unpaid')
    // Not a refusal: nothing here is a blocker, and the range stays bookable.
    expect(markup).not.toContain('availability-blocked')
  })

  it('says nothing at all when the balance covers the whole range', () => {
    expect(
      renderToString(
        <AvailabilityNotices status="succeeded" preview={previewFixture} />,
      ),
    ).toBe('')
  })

  it('still refuses the dates a real blocker names', () => {
    const markup = renderToString(
      <AvailabilityNotices
        status="succeeded"
        preview={{
          ...previewFixture,
          feasible: false,
          blockers: [
            {
              code: 'overlapping_request',
              message: 'This period overlaps an existing leave request:',
              overlappingRequests: [
                {
                  startDate: '2026-07-15',
                  endDate: '2026-07-18',
                  status: LeaveRequestStatus.Approved,
                },
              ],
            },
          ],
        }}
      />,
    )

    expect(markup).toContain('availability-blocked')
    expect(markup).toContain('This period overlaps an existing leave request:')
    expect(markup).toContain('availability-overlap-details')
    expect(markup).toContain('Approved')
  })
})
