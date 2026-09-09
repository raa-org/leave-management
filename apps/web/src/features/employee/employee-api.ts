/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  CreateLeaveRequestDto,
  EmployeeDashboardDto,
  LeaveAvailabilityPreviewDto,
  LeaveAvailabilityQueryDto,
  LeaveRequestDetailDto,
  LeaveRequestFormContextDto,
  LeaveRequestHistoryDto,
  ListMyLeaveRequestsQueryDto,
  ModifyLeaveRequestDto,
} from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'
import { parseJsonResponse, type FetchLike } from '../../lib/http'
import { configureWorkdayHours } from '../../lib/leave-format'

export async function fetchEmployeeDashboard(
  fetchImpl: FetchLike = fetch,
): Promise<EmployeeDashboardDto> {
  const response = await fetchImpl(apiUrl('/api/dashboard/me'))
  const dashboard = await parseJsonResponse<EmployeeDashboardDto>(response)
  // The one response every employee page loads, so this is where the display
  // divisor is set for the whole app. Point the renderers at it here rather
  // than in a component: a day figure can be rendered by any of a hundred
  // call sites, and none of them should have to hold the setting.
  configureWorkdayHours(dashboard.hoursPerDay)
  return dashboard
}

// Directory + settings-default recipients for the composer's approver/CC
// pickers. Served per caller: the users list excludes the requester and the
// defaults preview mirrors what the server folds into every submission.
export async function fetchLeaveRequestFormContext(
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestFormContextDto> {
  const response = await fetchImpl(apiUrl('/api/leave-requests/form-context'))
  return parseJsonResponse<LeaveRequestFormContextDto>(response)
}

export async function fetchLeaveRequestHistory(
  filters: ListMyLeaveRequestsQueryDto,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestHistoryDto> {
  const searchParams = new URLSearchParams()

  if (filters.status) {
    searchParams.set('status', filters.status)
  }

  if (filters.from) {
    searchParams.set('from', filters.from)
  }

  if (filters.to) {
    searchParams.set('to', filters.to)
  }

  const query = searchParams.toString()
  const path = query.length > 0 ? `/api/leave-requests/me?${query}` : '/api/leave-requests/me'
  const response = await fetchImpl(apiUrl(path))
  return parseJsonResponse<LeaveRequestHistoryDto>(response)
}

export async function submitLeaveRequest(
  input: CreateLeaveRequestDto,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(apiUrl('/api/leave-requests'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  return parseJsonResponse<LeaveRequestDetailDto>(response)
}

// Would the server accept this period, and how much room do its months have?
// Asked while the employee is still picking dates, so the answer arrives
// before they submit rather than as a rejection afterwards.
export async function fetchAvailabilityPreview(
  query: LeaveAvailabilityQueryDto,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveAvailabilityPreviewDto> {
  const searchParams = new URLSearchParams({
    leaveType: query.leaveType,
    startDate: query.startDate,
    endDate: query.endDate,
  })
  if (query.excludeRequestId) {
    searchParams.set('excludeRequestId', query.excludeRequestId)
  }
  // The part-day shape rides this GET as one compact 'date:hours' list, which
  // is the spelling the endpoint parses (parseHoursQuery): an availability URL
  // is read in logs and typed by hand, and the map is a handful of dates by
  // construction. Sent ONCE, never as a repeated parameter - the endpoint
  // refuses a repeated one rather than guessing which copy is meant.
  const hoursByDate = query.hoursByDate
  if (hoursByDate && Object.keys(hoursByDate).length > 0) {
    searchParams.set(
      'hours',
      Object.entries(hoursByDate)
        .map(([date, hours]) => `${date}:${hours}`)
        .join(','),
    )
  }
  const response = await fetchImpl(
    apiUrl(`/api/leave-requests/availability?${searchParams.toString()}`),
  )
  return parseJsonResponse<LeaveAvailabilityPreviewDto>(response)
}

// Detail fetch errors keep the HTTP status: the detail page words 403/404
// differently from a generic failure, and parseJsonResponse drops the code.
export class RequestDetailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'RequestDetailApiError'
  }
}

export async function fetchLeaveRequestDetail(
  requestId: string,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(
    apiUrl(`/api/leave-requests/${encodeURIComponent(requestId)}`),
  )
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      await parseJsonResponse<never>(response)
    } catch (error) {
      if (error instanceof Error && error.message.trim().length > 0) {
        message = error.message
      }
    }
    throw new RequestDetailApiError(message, response.status)
  }
  return parseJsonResponse<LeaveRequestDetailDto>(response)
}

// Propose new dates for an approved leave. Returns the REPLACEMENT request:
// the original keeps its approval until every approver approves this one.
export async function modifyLeaveRequest(
  requestId: string,
  input: ModifyLeaveRequestDto,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(
    apiUrl(`/api/leave-requests/${encodeURIComponent(requestId)}/modify`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )

  return parseJsonResponse<LeaveRequestDetailDto>(response)
}

export async function cancelLeaveRequest(
  requestId: string,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(
    apiUrl(`/api/leave-requests/${encodeURIComponent(requestId)}/cancel`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )

  return parseJsonResponse<LeaveRequestDetailDto>(response)
}
