/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  HolidayCalendarDto,
  LeaveBalanceDto,
  LeaveRequestSummaryDto,
} from '@workspace/contracts'
import { LeaveType } from '@workspace/contracts'
import { formatDate } from '../../lib/leave-format'

// Pure derivations behind the redesigned dashboard: the greeting, the
// 14-day "Upcoming" timeline (approved leave + public holidays), and the KPI
// aggregates. No React, no IO — everything unit-testable with plain values.

const DAY_MS = 86_400_000

// How far ahead the Upcoming timeline looks. Two weeks keeps the list short
// and personally relevant; the full picture lives in history/holidays pages.
export const UPCOMING_HORIZON_DAYS = 14

// 'YYYY-MM-DD' (UTC) from a date-only or full ISO string. Calendar dates in
// this app are UTC-pinned (see lib/leave-format.ts), so slicing the ISO form
// of the instant is the correct day extraction.
export function isoDateOnly(value: string): string {
  if (value.length <= 10) {
    return value
  }
  return new Date(value).toISOString().slice(0, 10)
}

function utcMs(dateOnly: string): number {
  const [year, month, day] = dateOnly.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

// Whole days from `fromDateOnly` to `toDateOnly` (UTC math, DST-proof).
// Positive when `to` is later.
export function daysBetween(fromDateOnly: string, toDateOnly: string): number {
  return Math.round((utcMs(toDateOnly) - utcMs(fromDateOnly)) / DAY_MS)
}

export function addDays(dateOnly: string, days: number): string {
  return new Date(utcMs(dateOnly) + days * DAY_MS).toISOString().slice(0, 10)
}

// The inclusive [from, to] window the upcoming resource queries, derived from
// the server's generatedAt so the client clock never decides what "soon" means.
export function upcomingWindow(
  generatedAt: string,
  horizonDays: number = UPCOMING_HORIZON_DAYS,
): { from: string; to: string } {
  const from = isoDateOnly(generatedAt)
  return { from, to: addDays(from, horizonDays) }
}

export type UpcomingEntry = {
  kind: 'leave' | 'holiday'
  // The day the row is anchored and sorted on: the leave start date or the
  // holiday date.
  date: string
  // Days from "today" (server) to `date`; 0 = today, negative = the leave is
  // already running (started before today but still overlaps the window).
  inDays: number
  title: string
  // Leave rows carry their request for linking/labels; holiday rows only a name.
  request?: LeaveRequestSummaryDto
}

// Merge approved leave and public holidays into one date-sorted timeline.
// `requests` is expected to be the approved-status overlap query for the same
// window; entries are still re-checked against [today, today+horizon] so a
// wider payload cannot leak rows. Defensive about shapes: a missing list
// renders as an empty timeline rather than crashing the dashboard.
export function buildUpcomingTimeline(
  requests: LeaveRequestSummaryDto[] | undefined,
  holidayCalendars: HolidayCalendarDto[] | undefined,
  generatedAt: string,
  horizonDays: number = UPCOMING_HORIZON_DAYS,
): UpcomingEntry[] {
  const today = isoDateOnly(generatedAt)
  const horizon = addDays(today, horizonDays)

  const leaveEntries: UpcomingEntry[] = (requests ?? [])
    .filter((request) => request.endDate >= today && request.startDate <= horizon)
    .map((request) => ({
      kind: 'leave' as const,
      date: request.startDate,
      inDays: daysBetween(today, request.startDate),
      title: request.leaveType === LeaveType.Sick ? 'Sick leave' : 'Vacation',
      request,
    }))

  const holidayEntries: UpcomingEntry[] = (holidayCalendars ?? [])
    .flatMap((calendar) => calendar?.holidays ?? [])
    .filter((holiday) => holiday.date >= today && holiday.date <= horizon)
    .map((holiday) => ({
      kind: 'holiday' as const,
      date: holiday.date,
      inDays: daysBetween(today, holiday.date),
      title: holiday.name,
    }))

  return [...leaveEntries, ...holidayEntries].sort((left, right) =>
    left.date === right.date
      ? left.kind.localeCompare(right.kind)
      : left.date < right.date
        ? -1
        : 1,
  )
}

// "In 2 days" / "Today" / "Ongoing" chip label for an upcoming row.
export function inDaysLabel(inDays: number): string {
  if (inDays < 0) {
    return 'Ongoing'
  }
  if (inDays === 0) {
    return 'Today'
  }
  if (inDays === 1) {
    return 'Tomorrow'
  }
  return `In ${inDays} days`
}

// The hero subtitle's "next time off" fragment: the first upcoming leave row
// that has not started yet. Holidays do not count as "your time off".
export function nextTimeOff(entries: UpcomingEntry[]): UpcomingEntry | undefined {
  return entries.find((entry) => entry.kind === 'leave' && entry.inDays >= 0)
}

// The hero's "next time off" sentence fragment for a non-negative inDays.
export function startsLabel(inDays: number): string {
  if (inDays === 0) {
    return 'starts today'
  }
  if (inDays === 1) {
    return 'starts tomorrow'
  }
  return `starts in ${inDays} days`
}

// Local-clock greeting bucket. Display-only (the figures below all come from
// the server), so the viewer's own morning/evening is the right frame.
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return 'Good morning'
  }
  if (hour >= 12 && hour < 18) {
    return 'Good afternoon'
  }
  return 'Good evening'
}

export function firstNameOf(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0]
  return first || displayName
}

export type BalanceKpiTotals = {
  vacation?: LeaveBalanceDto
  sick?: LeaveBalanceDto
  onHoldTotal: number
  spentTotal: number
  spentVacation: number
  spentSick: number
}

export function aggregateBalanceTotals(balances: LeaveBalanceDto[]): BalanceKpiTotals {
  const vacation = balances.find((balance) => balance.leaveType === LeaveType.Vacation)
  const sick = balances.find((balance) => balance.leaveType === LeaveType.Sick)
  return {
    vacation,
    sick,
    onHoldTotal: balances.reduce((sum, balance) => sum + balance.onHoldDays, 0),
    spentTotal: balances.reduce((sum, balance) => sum + balance.spentDays, 0),
    spentVacation: vacation?.spentDays ?? 0,
    spentSick: sick?.spentDays ?? 0,
  }
}

/**
 * The one policy fact an employee can act on: that they are still inside a
 * probation window, so leave booked before it ends is unpaid.
 *
 * The policy's NAME is deliberately not shown. It names an internal grouping
 * ("Migrated 25+5"), not a promise to the reader, and the numbers it implies
 * are already on the balance tiles in a form the employee can use. Probation
 * changes what they will be paid, so it stays.
 *
 * Comes from the server (the UI informs, the backend enforces); no probation
 * means no line.
 */
export function probationNoticeLine(
  probationEndsOn: string | undefined,
): string | null {
  return probationEndsOn
    ? `On probation until ${formatDate(probationEndsOn)}; leave taken before then is unpaid.`
    : null
}
