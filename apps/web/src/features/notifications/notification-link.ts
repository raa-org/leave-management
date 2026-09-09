/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Where a notification takes you. App-relative: react-router applies the base path.
 *
 * Cross-cutting approval review lives under the active workspace prefix, the
 * same way every other page is scoped to /employee or /admin.
 */
export function notificationLink(notification: { requestId: string }, pathname: string): string {
  const prefix = pathname.startsWith('/admin') ? '/admin' : '/employee'
  return `${prefix}/approval/review/${notification.requestId}`
}
