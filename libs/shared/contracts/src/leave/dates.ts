/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// A real calendar date: correct shape AND round-trips (rejects e.g.
// 2026-02-30). Single shared implementation so every surface — admin filter
// validation, employee submissions — agrees on what a valid date is.
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// Saturday (6) or Sunday (0) in UTC. All employees work a fixed Mon-Fri week, so
// weekends never consume leave balance regardless of country. Shared because the
// API CHARGES by this rule (resolveLeaveDays) and the web request calendar
// SHADES by it; a second copy would let the two drift the day the workweek
// becomes configurable. UTC-based on purpose: the input is a calendar date, not
// an instant, so the viewer's zone must not shift which day this is.
export function isWeekendIso(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()
  return day === 0 || day === 6
}
