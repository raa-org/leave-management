/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

export type FetchLike = typeof fetch

type ErrorPayload = {
  message?: string | string[]
}

/**
 * Read a JSON response, or throw with the server's own message.
 *
 * Nest reports validation failures as `message: string | string[]`, so both
 * shapes are normalized here and the resulting Error carries text fit to show a
 * user verbatim. Falls back to the raw body, then to the status, so a non-JSON
 * error (a proxy's HTML 502, say) still says something useful.
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T
  }

  let message = `Request failed with status ${response.status}`

  try {
    const payload = (await response.json()) as ErrorPayload
    if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
      message = payload.message
    } else if (Array.isArray(payload.message) && payload.message.length > 0) {
      message = payload.message.join(', ')
    }
  } catch {
    const text = await response.text().catch(() => '')
    if (text.trim().length > 0) {
      message = text
    }
  }

  throw new Error(message)
}
