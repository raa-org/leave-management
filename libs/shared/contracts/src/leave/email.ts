/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Shared email helpers so the backend domain, notification service, and the
// web app all normalize and validate addresses the same way.

/** Trim surrounding whitespace and lowercase an email for comparison/storage. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Deliberately pragmatic: a single "@", non-empty local part, and a dotted
// domain. Not RFC 5322-complete, but enough to reject the obvious garbage the
// approver/CC inputs would otherwise accept.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** True when the value looks like a valid email address. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim())
}
