/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { LeaveRequestStatus } from '@workspace/contracts'
import { filterByStatus, historyDateBounds, statusCounts } from './history-filters'

const requests = [
  { requestId: 'a', status: LeaveRequestStatus.Pending },
  { requestId: 'b', status: LeaveRequestStatus.Approved },
  { requestId: 'c', status: LeaveRequestStatus.Approved },
  { requestId: 'd', status: LeaveRequestStatus.Rejected },
  { requestId: 'e', status: LeaveRequestStatus.Cancelled },
]

describe('history filters', () => {
  it('counts every status over the loaded window', () => {
    expect(statusCounts(requests)).toEqual({
      all: 5,
      pending: 1,
      approved: 2,
      rejected: 1,
      cancelled: 1,
    })
    expect(statusCounts([])).toEqual({
      all: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
    })
  })

  it('finds the span of the history for the calendar bounds', () => {
    expect(
      historyDateBounds([
        { startDate: '2026-06-10', endDate: '2026-06-12' },
        { startDate: '2026-01-05', endDate: '2026-01-06' },
        { startDate: '2026-09-01', endDate: '2026-09-05' },
      ]),
    ).toEqual({ min: '2026-01-05', max: '2026-09-05' })
    expect(historyDateBounds([])).toBeNull()
  })

  it('filters by a picked status and passes everything through for All', () => {
    expect(filterByStatus(requests, LeaveRequestStatus.Approved).map((r) => r.requestId)).toEqual([
      'b',
      'c',
    ])
    expect(filterByStatus(requests).map((r) => r.requestId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(filterByStatus(requests, LeaveRequestStatus.Pending)).toHaveLength(1)
  })
})
