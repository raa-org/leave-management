/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The Postgres LISTEN/NOTIFY channel the notification write path announces on.
//
// Lives in domain/ rather than notifications/ so the write side (NotificationService)
// can import it without inverting the module direction: notifications/ already
// imports domain/, never the other way round.
export const LEAVE_NOTIFICATIONS_CHANNEL = 'leave_notifications'

// Deliberately ONLY identifiers. NOTIFY payloads are capped at 8000 bytes, and
// more importantly the stream is a signal, not a data channel: the client
// refetches a server-computed snapshot, so a notification's body can never leak
// through the bus to the wrong listener.
export type LeaveNotificationSignal = {
  userId: string
  id: string
}

export function encodeSignal(signal: LeaveNotificationSignal): string {
  return JSON.stringify(signal)
}

// Anything unexpected yields null rather than throwing: a malformed payload must
// not be able to kill the shared listener for every connected user.
export function decodeSignal(
  raw: string | undefined,
): LeaveNotificationSignal | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LeaveNotificationSignal).userId === 'string' &&
      typeof (parsed as LeaveNotificationSignal).id === 'string'
    ) {
      return parsed as LeaveNotificationSignal
    }
    return null
  } catch {
    return null
  }
}
