/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveRequestStatus } from '@workspace/contracts'

// Client-side status filtering for the history page. The date window is
// server-filtered (inclusive overlap on /api/leave-requests/me); the status
// pill then slices the loaded window instantly, and each pill's count bubble
// describes the window population (prototype behavior).

type WithStatus = { status: LeaveRequestStatus | string }

export type HistoryStatusCounts = {
  all: number
  pending: number
  approved: number
  rejected: number
  cancelled: number
}

export function statusCounts(requests: readonly WithStatus[]): HistoryStatusCounts {
  const counts: HistoryStatusCounts = {
    all: requests.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
  }
  for (const request of requests) {
    switch (request.status) {
      case LeaveRequestStatus.Pending:
        counts.pending += 1
        break
      case LeaveRequestStatus.Approved:
        counts.approved += 1
        break
      case LeaveRequestStatus.Rejected:
        counts.rejected += 1
        break
      case LeaveRequestStatus.Cancelled:
        counts.cancelled += 1
        break
      default:
        break
    }
  }
  return counts
}

export function filterByStatus<T extends WithStatus>(
  requests: readonly T[],
  status?: LeaveRequestStatus,
): T[] {
  if (!status) {
    return [...requests]
  }
  return requests.filter((request) => request.status === status)
}

// The span of the user's history: first start date to last end date across
// the requests ('YYYY-MM-DD' compare well as strings). The date-range filter
// pins its selectable bounds to this so the calendar cannot wander into
// months with nothing to find. Null for an empty history.
export function historyDateBounds(
  requests: readonly { startDate: string; endDate: string }[],
): { min: string; max: string } | null {
  if (requests.length === 0) {
    return null
  }
  let min = requests[0]!.startDate
  let max = requests[0]!.endDate
  for (const request of requests) {
    if (request.startDate < min) {
      min = request.startDate
    }
    if (request.endDate > max) {
      max = request.endDate
    }
  }
  return { min, max }
}
