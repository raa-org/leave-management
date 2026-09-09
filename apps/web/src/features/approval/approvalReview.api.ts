/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  LeaveApprovalActionDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'

export class ApprovalReviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApprovalReviewApiError'
  }
}

type FetchLike = typeof fetch

export async function fetchApprovalReviewRequest(
  requestId: string,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(apiUrl(`/api/leave-requests/${requestId}`), {
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw await createApiError(
      response,
      'Unable to load the leave request for review.',
    )
  }

  return response.json() as Promise<LeaveRequestDetailDto>
}

export async function submitApprovalReviewDecision(
  requestId: string,
  input: LeaveApprovalActionDto,
  fetchImpl: FetchLike = fetch,
): Promise<LeaveRequestDetailDto> {
  const response = await fetchImpl(
    apiUrl(`/api/leave-requests/${requestId}/approval`),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )

  if (!response.ok) {
    throw await createApiError(
      response,
      'Unable to submit the approval decision.',
    )
  }

  return response.json() as Promise<LeaveRequestDetailDto>
}

async function createApiError(
  response: Response,
  fallbackMessage: string,
): Promise<ApprovalReviewApiError> {
  const contentType = response.headers.get('content-type') ?? ''
  let message = fallbackMessage

  if (contentType.includes('application/json')) {
    const payload = (await response.json()) as {
      message?: string | string[]
      error?: string
    }
    if (Array.isArray(payload.message) && payload.message.length > 0) {
      message = payload.message.join(', ')
    } else if (typeof payload.message === 'string' && payload.message.trim()) {
      message = payload.message
    } else if (typeof payload.error === 'string' && payload.error.trim()) {
      message = payload.error
    }
  } else {
    const text = (await response.text()).trim()
    if (text) {
      message = text
    }
  }

  return new ApprovalReviewApiError(message, response.status)
}
