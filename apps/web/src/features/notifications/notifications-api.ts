/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { NotificationListDto } from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'
import { parseJsonResponse, type FetchLike } from '../../lib/http'

// Every call returns a server-computed page (items + table-wide counts +
// optional nextCursor), so the client never does count arithmetic of its own
// and the badge can never disagree with the list it sits above.

export type FetchNotificationsOptions = {
  // Opaque keyset cursor from a previous page's nextCursor. Omit for the
  // newest page (initial load, SSE refetch, mark-read snapshot).
  cursor?: string
}

export async function fetchNotifications(
  fetchImpl: FetchLike = fetch,
  options: FetchNotificationsOptions = {},
): Promise<NotificationListDto> {
  const params = new URLSearchParams()
  if (options.cursor) {
    params.set('cursor', options.cursor)
  }
  const query = params.toString()
  return parseJsonResponse<NotificationListDto>(
    await fetchImpl(
      apiUrl(`/api/notifications${query ? `?${query}` : ''}`),
    ),
  )
}

export async function markNotificationRead(
  notificationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<NotificationListDto> {
  return parseJsonResponse<NotificationListDto>(
    await fetchImpl(
      apiUrl(`/api/notifications/${encodeURIComponent(notificationId)}/read`),
      { method: 'POST' },
    ),
  )
}

export async function markAllNotificationsRead(
  fetchImpl: FetchLike = fetch,
): Promise<NotificationListDto> {
  return parseJsonResponse<NotificationListDto>(
    await fetchImpl(apiUrl('/api/notifications/read-all'), { method: 'POST' }),
  )
}

// The stream URL. Built through apiUrl like every other call so it resolves both
// under `vite dev` and behind the sub-path mount.
export function notificationStreamUrl(): string {
  return apiUrl('/api/notifications/stream')
}
