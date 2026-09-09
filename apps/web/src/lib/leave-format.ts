/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ApproverDecision,
  ApproverKind,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import type {
  LeaveRequestApprovalRecipientDto,
  LeaveRequestSummaryDto,
} from '@workspace/contracts'

// Single source of truth for rendering leave data. Two deliberately different
// rules:
//  - Calendar dates (`YYYY-MM-DD`: leave start/end, effective dates, holidays)
//    are rendered in the viewer's locale but PINNED to UTC, so the day never
//    shifts in a negative-offset viewer yet the day/month order still matches the
//    viewer's system (and the instant timestamps below).
//  - Instants (submission/approval/activity/audit timestamps) are rendered in
//    the VIEWER'S OWN locale and timezone via toLocaleString (the browser
//    recalculates from the UTC value the server stores), so both the format
//    (day/month order, 12h vs 24h) and the clock match the user's system.
// Never pass a `YYYY-MM-DD` date-only string to formatDateTime — local rendering
// would shift it a day.

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// Spelled-out date for the dashboard hero ("Wednesday, July 1, 2026").
// Pinned to UTC so it names the same day the Upcoming window/"Today" chips are
// computed from (dashboard-insights.ts does its day math in UTC) — otherwise a
// negative-offset viewer near midnight would see the hero and the chips
// disagree about what "today" is.
export function formatLongDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDateTime(value: string): string {
  // Medium date + short time in the viewer's locale/timezone. Compact (no
  // seconds) and, because the zone is the viewer's own, the abbreviation is left
  // implicit rather than spelled out.
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// A compact "how long ago" label for a server ISO timestamp, computed as a
// delta against the supplied wall-clock instant (epoch ms). Used only as a
// freshness hint next to server data; the authoritative figures always come
// straight from the server, so a skewed client clock only nudges this label.
export function formatRelativeTime(value: string, nowMs: number): string {
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) {
    return ''
  }
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000))
  if (seconds < 45) {
    return 'just now'
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours} h ago`
  }
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

// Short day+month ("Jul 24") for compact range starts; UTC-pinned like every
// calendar date.
export function formatDayMonth(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

// Short day+month for an INSTANT (submittedAt and friends): rendered in the
// viewer's own timezone per the instants rule above — pinning it to UTC could
// name the wrong day for a non-UTC viewer.
export function formatDayMonthLocal(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

// Weekday-led day+month ("Mon, Sep 7") for the per-day hours editor, whose rows
// all sit inside one picked range: the year is on the calendar right above them
// and repeating it on every row would crowd the stepper beside it.
export function formatWeekdayDayMonth(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

// Weekday-led calendar date ("Tue, Jul 28, 2026") for holiday rows.
export function formatWeekdayDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatDate(startDate)
  }
  return `${formatDate(startDate)} to ${formatDate(endDate)}`
}

// How long a workday is here, the divisor the DISPLAY formatters below render a
// day figure against. Module state rather than a parameter on ~130 call sites:
// it is one org-wide number that changes only when an administrator changes it.
// The default is the server's own (leave_settings.hoursPerDay defaults to 8).
//
// A FALLBACK, not the source of truth. The divisor travels with the data: every
// response that carries day figures publishes its own `hoursPerDay`, and a page
// adopts the one from its own payload (adoptWorkdayHours) before it renders. The
// module value covers only the surfaces that have no payload of their own, and
// the instant before the first response arrives.
//
// NO MATH MAY READ IT. Snapping, stepping, grid checks and bookable ceilings
// decide what the server will accept, and a page that renders against the wrong
// divisor is a cosmetic bug while a form that MINTS against the wrong one is
// refused outright. Those paths take the divisor as an explicit argument, from
// the payload that carries the figures they are working on.
let workdayHours = 8

// Point the display formatters at the org's real workday. Ignores anything that
// is not a usable hour count, so a partial or stale payload cannot make every
// day figure on screen collapse to zero.
export function configureWorkdayHours(hours: number | undefined): void {
  if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0) {
    workdayHours = hours
  }
}

// What a page calls with the divisor from its OWN payload, taking back the one
// in force. Called during render rather than from an effect, so the very first
// paint of a deep link (an approval email lands straight on the review page) is
// already against the right workday and never against the default; the value is
// org-wide, so re-applying the same number on every render settles nothing that
// a later payload could disagree with.
//
// Use the RETURNED number for anything that computes rather than renders.
export function adoptWorkdayHours(hours: number | undefined): number {
  configureWorkdayHours(hours)
  return workdayHours
}

export function workdayHoursOf(): number {
  return workdayHours
}

// THE notation for a day figure, matching the server's formatDayAmount
// (apps/api/src/domain/day-math.ts) exactly for the same input: days and hours
// against the org's workday. 2.5 of an 8h day is "2d 4h", 0.625 is "5h", 3 is
// "3d", 0 is "0d". No leading "0d" under a day, no trailing "0h" on a whole one.
//
// FLOORED to the hour grid first, which is the standing rule that an employee
// is never shown more than they can take: request costs already sit on the grid
// so nothing moves there, while a balance carrying accrual's sub-hour remainder
// reads as the hours it can actually fund. The leftover minutes stay on the
// books and surface in exactBookableTooltip, so a chip never promises 2d 1h
// when only 2d can be taken.
export function formatDays(value: number): string {
  if (!Number.isFinite(value)) {
    return '0d'
  }
  const hours = floorToHourGrid(Math.abs(value), workdayHours)
  const days = Math.floor(hours / workdayHours)
  const remainder = hours - days * workdayHours
  const sign = value < 0 ? '-' : ''
  if (days === 0 && remainder === 0) {
    return `${sign}0d`
  }
  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (remainder > 0) {
    parts.push(`${remainder}h`)
  }
  return `${sign}${parts.join(' ')}`
}

// Last year's leftover, named beside an annual total so "32d of 25d total" is
// not a paradox: the extra days sit on top of this year's allowance, they are
// not a share of it. Empty when nothing carried, so existing "of 25d total"
// copy stays intact.
export function carriedOverFromLastYearSuffix(carriedOverDays?: number): string {
  const carried = carriedOverDays ?? 0
  if (carried <= 0) {
    return ''
  }
  return ` + ${formatDays(carried)} carried over from last year`
}

// The whole hours a day amount holds, mirroring the server's floorToHourGrid +
// dayPortionToHours. Counted UP from the plain floor rather than divided once,
// because a workday whose hour does not fit three decimals (a 7-hour day stores
// one hour as 0.143, a shade over a seventh) would otherwise lose the last hour
// the employee actually holds.
function floorToHourGrid(value: number, hoursPerDay: number): number {
  let hours = Math.floor(value * hoursPerDay + 1e-9)
  while (hoursToDays(hours + 1, hoursPerDay) <= value + 1e-9) {
    hours += 1
  }
  return hours
}

// One hour count as a fraction of a day, quantized to the server's three
// decimals so the grid this module walks is the same one the books store.
// Mirrors hoursToDayPortion (apps/api/src/domain/day-math.ts), magnitude first
// so that removing an hour is exactly the negative of adding one.
//
// hoursPerDay is a PARAMETER here, defaulted to the display divisor: the
// composer prices its draft against the workday the form context published, and
// that value is the one the server will divide by when it freezes the request.
export function hoursToDays(
  hours: number,
  hoursPerDay: number = workdayHours,
): number {
  const magnitude = roundDays(Math.abs(hours) / hoursPerDay)
  return hours < 0 ? -magnitude : magnitude
}

// Three decimals: the scale the books store a day figure at, mirroring the
// server's roundDays. Leave is bookable by the hour, so two decimals would
// quantize one hour of an eight-hour day (0.125) into 0.13 and take the figure
// off the grid the server enforces. Arithmetic hygiene, never a display
// rounding - what a person reads goes through formatDays.
export function roundDays(value: number): number {
  return Math.round(value * 1000) / 1000
}

// The inverse: the whole hours a day amount stands for, mirroring the server's
// dayPortionToHours. Rounded, not floored, because a stored portion that drifted
// off the grid should still read as the hour it was minted from.
export function daysToWholeHours(
  value: number,
  hoursPerDay: number = workdayHours,
): number {
  return Math.round(value * hoursPerDay)
}

// A day amount snapped to the NEAREST bookable hour, for the one editor that
// takes a day figure typed by hand (the admin balance correction). The server
// refuses anything off the grid outright, so a typed 0.37 has to become the
// three hours it was meant to be before it is offered for confirmation.
export function snapDaysToHourGrid(
  value: number,
  hoursPerDay: number = workdayHours,
): number {
  return Number.isFinite(value)
    ? hoursToDays(daysToWholeHours(value, hoursPerDay), hoursPerDay)
    : 0
}

// The same floored amount as formatDays, but as its two parts, for the few
// places that style the number and its unit differently (the dashboard KPI
// tiles animate the figure). Callers must render exactly these two parts and
// nothing else, or the screen stops agreeing with formatDays.
export function splitDayAmount(value: number): { days: number; hours: number } {
  const total = Number.isFinite(value)
    ? floorToHourGrid(Math.max(0, value), workdayHours)
    : 0
  const days = Math.floor(total / workdayHours)
  return { days, hours: total - days * workdayHours }
}

// A request's size together with how it is funded. A fully paid request reads
// as the plain figure it always did; a fully unpaid one says so without a
// pointless "0d paid".
export function formatDaySplit(paidDays: number, unpaidDays: number): string {
  const total = formatDays(paidDays + unpaidDays)
  if (unpaidDays <= 0) {
    return total
  }
  if (paidDays <= 0) {
    return `${total} unpaid`
  }
  return `${total} (${formatDays(paidDays)} paid + ${formatDays(unpaidDays)} unpaid)`
}

// A day amount floored to the bookable hour grid: the largest figure on the
// server's grid that does not exceed `value`. What the floor leaves behind is
// under an hour, stays in the balance, and the full allocation is still reached
// by December, so no days are ever lost.
//
// hoursPerDay is required, and never defaulted to the display fallback: this is
// a bookable ceiling. It decides how much an admin correction may remove and how
// much of a request a year's pool can fund, and against the wrong divisor it
// mints figures the server refuses.
export function floorDays(value: number, hoursPerDay: number): number {
  return hoursToDays(floorToHourGrid(value, hoursPerDay), hoursPerDay)
}

// The dates of a request that are NOT whole days, in calendar order, from the
// frozen portions the DTO publishes. An absent or empty map is an ordinary
// whole-day request and yields nothing, which is the idiom every surface
// rendering a shape relies on to stay quiet: no empty row, no "0h".
//
// A portion at or above a full day is dropped rather than listed: the map is
// meant to carry only the shortened dates, and a whole one has nothing to say.
export function partDayEntries(
  dayPortions?: Record<string, number>,
): { date: string; portion: number }[] {
  return Object.entries(dayPortions ?? {})
    .filter(
      ([, portion]) => Number.isFinite(portion) && portion > 0 && portion < 1,
    )
    .map(([date, portion]) => ({ date, portion }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

// The part-day shape as one line, in the app's day notation: "Sep 7 4h · Sep 8
// 2h". Empty for a whole-day request, so a caller can render nothing at all
// rather than a row saying there is nothing to say.
export function describeDayShape(dayPortions?: Record<string, number>): string {
  return partDayEntries(dayPortions)
    .map(({ date, portion }) => `${formatDayMonth(date)} ${formatDays(portion)}`)
    .join(' · ')
}

// Whether two requests book the same part-day shape. Portions are already
// quantized to the books' three decimals on both sides, so this is an equality
// check over the shortened dates only.
export function sameDayShape(
  left?: Record<string, number>,
  right?: Record<string, number>,
): boolean {
  const a = partDayEntries(left)
  const b = partDayEntries(right)
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.date === b[index]?.date && entry.portion === b[index]?.portion,
    )
  )
}

// Exact day figure (three decimals, the server's own day scale, no trailing
// zeros) for tooltips that reveal the precise accrued value behind a floored
// headline. The one renderer that deliberately does NOT floor.
export function formatDaysExact(value: number): string {
  return `${roundDays(value)}d`
}

// Hover copy when the stored figure still holds leftover minutes: the books
// keep 2.083d, the screen shows 2d. Whole hours (8.25d = 8d 2h) need no note.
export function exactBookableTooltip(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined
  }
  const magnitude = Math.abs(value)
  const floored = hoursToDays(floorToHourGrid(magnitude, workdayHours))
  if (Math.abs(roundDays(magnitude) - roundDays(floored)) < 0.0005) {
    return undefined
  }
  const sign = value < 0 ? '-' : ''
  return `${sign}${formatDaysExact(magnitude)} on the books; ${sign}${formatDays(magnitude)} can be booked.`
}

// A figure on a LEDGER, where the column has to add up. Same days-and-hours
// notation as formatDays ("2h", "1d 4h", "8d 2h") — never a decimal day count.
//
// Accrual almost never sits on the hour grid. Flooring each addend independently
// (LRS-53) dropped a leftover fraction from every row and kept it in the total:
// "17d + 2d 2h = 19d 3h". Snapping to the nearest hour first makes the column
// checkable in the same notation the rest of the app uses: 17.083d reads
// "17d 1h", 2.292d reads "2d 2h", and they sum to "19d 3h". Bookable headlines
// still floor through formatDays so a chip never promises more than can be taken;
// when the two disagree, the fine print says so.
export function formatLedgerDays(value: number): string {
  if (!Number.isFinite(value)) {
    return '0d'
  }
  return formatDays(snapDaysToHourGrid(value))
}

// Whole hours a day figure actually holds: leftover minutes are not a
// bookable hour, so 2.083d is 16h (2d), not 17h (2d 1h).
function completeHours(days: number): number {
  if (!Number.isFinite(days) || days === 0) {
    return 0
  }
  const sign = days < 0 ? -1 : 1
  return sign * floorToHourGrid(Math.abs(days), workdayHours)
}

/**
 * The hours a movement actually added or removed on the bookable grid:
 * completeHours(after) − completeHours(before). Independent rounding of
 * each monthly twelfth prints "+2d 1h" eight times (17d) while August only
 * holds 16d 5h; this is the difference of the two running totals, so
 * January is +2d, February +2d 1h, and eight of them sum to 16d 5h.
 */
export function formatCompleteHoursDelta(
  afterDays: number,
  beforeDays: number,
): string {
  const step = completeHours(afterDays) - completeHours(beforeDays)
  const amount = formatDays(hoursToDays(Math.abs(step)))
  if (step > 0) {
    return `+${amount}`
  }
  if (step < 0) {
    return `−${amount}`
  }
  return amount
}

// Full weekday name of a calendar date ("Tuesday"), UTC-pinned like every
// calendar-date formatter in the app.
export function formatWeekdayLong(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  })
}

// Client mirror of the server's single "bookable" definition (bookableDays in
// leave-domain.service.ts: accrued - onHold - spent). The DTO's availableDays
// nets only spent - days reserved by holds are surfaced separately - so what a
// new request can actually consume right now is available minus on hold.
// Every user-facing "available" figure reads this, or it overstates while a
// pending request holds days. Clamped at zero: a fully-reserved balance reads
// as nothing available, never as a negative day count.
export function bookableDaysOf(balance: {
  availableDays: number
  onHoldDays: number
}): number {
  return Math.max(balance.availableDays - balance.onHoldDays, 0)
}

// The two named parts of an accrued figure. The DTO's accruedDays counts last
// year's carryover (the carryover_in ledger row seeds the year's counter), but
// "accrued" on screen means earned from THIS year's entitlement, so every
// surface splits the figure back before display.
//
// The carried part is capped by what the balance still holds - a negative
// correction can eat into the carryover, and naming days the balance no longer
// has would leave the reader summing terms to more than the total. It is also
// floored to the hour grid it is DISPLAYED at, so the two parts, each shown
// through formatDays, always read back as exactly the accrued figure beside
// them: the sub-hour remainder stays with the earned part rather than being
// dropped twice.
export function accruedSplitOf(balance: {
  accruedDays: number
  carriedOverDays?: number
}): { earnedDays: number; carriedDays: number } {
  const accrued = Math.max(balance.accruedDays, 0)
  const carried = Math.max(balance.carriedOverDays ?? 0, 0)
  const carriedDays = floorDays(Math.min(accrued, carried), workdayHours)
  return {
    earnedDays: Math.max(roundDays(accrued - carriedDays), 0),
    carriedDays,
  }
}

export function formatLeaveType(leaveType: LeaveType | string): string {
  return leaveType === LeaveType.Sick ? 'Sick leave' : 'Vacation'
}

export function formatStatus(status: LeaveRequestStatus | string): string {
  switch (status) {
    case LeaveRequestStatus.Approved:
      return 'Approved'
    case LeaveRequestStatus.Rejected:
      return 'Rejected'
    case LeaveRequestStatus.Cancelled:
      return 'Cancelled'
    case LeaveRequestStatus.Pending:
      return 'Pending'
    case LeaveRequestStatus.Superseded:
      return 'Superseded'
    default:
      return String(status).charAt(0).toUpperCase() + String(status).slice(1)
  }
}

export function getStatusColor(
  status: LeaveRequestStatus | string,
): 'warning' | 'success' | 'error' | 'info' | 'default' {
  switch (status) {
    case LeaveRequestStatus.Approved:
      return 'success'
    case LeaveRequestStatus.Rejected:
      return 'error'
    case LeaveRequestStatus.Pending:
      return 'warning'
    // Not a failure and not a cancellation: the leave happened, under other
    // dates. Its own colour keeps it distinct from a withdrawn request.
    case LeaveRequestStatus.Superseded:
      return 'info'
    default:
      return 'default'
  }
}

// Calendar year of an ISO date or timestamp ('YYYY-MM-DD' / full ISO), or
// null for a blank/partial value. Mirrors the backend's getYearFromIsoDate —
// the leave year of a request derives from its start date.
export function yearFromIso(value: string): number | null {
  return value.length >= 4 ? Number(value.slice(0, 4)) : null
}

// True when an inclusive range crosses a calendar-year boundary. Drives the
// "print the year on both ends" rendering rule: "Dec 25 → Jan 5, 2027" silently
// files both ends under 2027, so a crossing range names each end's own year.
export function spansYears(startIso: string, endIso: string): boolean {
  const start = yearFromIso(startIso)
  return start !== null && start !== yearFromIso(endIso)
}

// At most ONE calendar notice applies at a time; the return type makes that
// exclusivity (and the priority order) structural. The backend submit guard
// remains the enforcer — this is the advisory pre-check the employee pages
// render. Unknown context (no dashboard yet) never pre-blocks: fail-open.
export type CalendarNotice =
  // No calendar configured for ANY year: nothing can be submitted.
  | { kind: 'none-configured' }
  // The picked start date's year has no calendar: block this submission.
  | { kind: 'picked-year-missing'; year: number }
  // The start year is configured but the range runs into a year that is not:
  // block this submission — a cross-year request needs both calendars.
  | { kind: 'end-year-missing'; year: number }
  // Nothing picked yet, but the current year (per the server clock) has no
  // calendar: warn up front, other configured years are still submittable.
  | { kind: 'current-year-missing'; year: number }

export function calendarNoticeFor(
  startDate: string,
  dashboard?: { holidayCalendarYears: number[]; generatedAt: string },
  endDate = '',
): CalendarNotice | null {
  if (!dashboard) {
    return null
  }
  const { holidayCalendarYears, generatedAt } = dashboard
  if (holidayCalendarYears.length === 0) {
    return { kind: 'none-configured' }
  }
  const pickedYear = yearFromIso(startDate)
  if (pickedYear !== null) {
    if (!holidayCalendarYears.includes(pickedYear)) {
      return { kind: 'picked-year-missing', year: pickedYear }
    }
    // A range crossing into later years needs each of THEIR calendars too;
    // flag the first one missing.
    const endYear = yearFromIso(endDate)
    if (endYear !== null) {
      for (let year = pickedYear + 1; year <= endYear; year += 1) {
        if (!holidayCalendarYears.includes(year)) {
          return { kind: 'end-year-missing', year }
        }
      }
    }
    return null
  }
  const currentYear = yearFromIso(generatedAt)
  return currentYear !== null && !holidayCalendarYears.includes(currentYear)
    ? { kind: 'current-year-missing', year: currentYear }
    : null
}

// Progress of the all-approvers gate: a request is approved only once EVERY
// 'to' approver has approved, and a single rejection ends it. Only 'to' rows
// vote — cc recipients are copied and stay pending forever, so counting them
// would make the gate look permanently unmet. A row with no `decision` yet is
// pending (the DTO field is optional).
export type ApproverGateSummary = {
  total: number
  approved: number
  rejected: number
  label: string
}

export function summarizeApproverGate(
  approvers: LeaveRequestApprovalRecipientDto[],
  // Tells the two zero-voter cases apart: a request the system approved
  // because nobody had to decide it, versus one whose approvers were stripped.
  // Optional so a caller without the request at hand keeps the older label.
  status?: LeaveRequestStatus,
): ApproverGateSummary {
  const voters = approvers.filter(
    (approver) => approver.kind === ApproverKind.To,
  )
  const total = voters.length
  const approved = voters.filter(
    (approver) => approver.decision === ApproverDecision.Approved,
  ).length
  const rejected = voters.filter(
    (approver) => approver.decision === ApproverDecision.Rejected,
  ).length

  let label: string
  if (total === 0 && status === LeaveRequestStatus.Approved) {
    label = 'Approved automatically (no approvers required)'
  } else if (total === 0) {
    label = 'No primary approvers remain on this request'
  } else if (rejected > 0) {
    label = `Rejected by ${rejected} of ${total} approvers`
  } else if (approved === total) {
    label = `Approved by all ${total} approvers`
  } else {
    label = `Approved by ${approved} of ${total} approvers`
  }

  return { total, approved, rejected, label }
}

// A single recipient's standing on a request, shared by every surface that
// lists approval recipients so the same row never reads differently on two
// screens. Copied recipients never vote, so they get no decision state at all
// rather than a misleading "pending". An undecided 'to' row is "awaiting" only
// while the request is open: a rejection or cancellation closes the request
// without touching the other rows, and nothing is awaited from them anymore.
export function describeApproverStanding(
  approver: Pick<LeaveRequestApprovalRecipientDto, 'kind' | 'decision'>,
  requestStatus: LeaveRequestStatus,
): string {
  if (approver.kind !== ApproverKind.To) {
    return 'Copied recipient'
  }

  switch (approver.decision) {
    case ApproverDecision.Approved:
      return 'Primary approver — approved'
    case ApproverDecision.Rejected:
      return 'Primary approver — rejected'
    default:
      return requestStatus === LeaveRequestStatus.Pending
        ? 'Primary approver — awaiting decision'
        : 'Primary approver'
  }
}

// How far ahead leave may be planned, mirroring the backend guard: this year
// and the next. Advisory only, so the composer can say so before the attempt.
const PLANNING_HORIZON_YEARS = 1

export function horizonNoticeFor(
  startDate: string,
  generatedAt?: string,
  endDate = '',
): { kind: 'beyond-horizon'; maxYear: number } | null {
  const pickedYear = yearFromIso(startDate)
  const currentYear = generatedAt ? yearFromIso(generatedAt) : null
  if (pickedYear === null || currentYear === null) {
    return null
  }
  const maxYear = currentYear + PLANNING_HORIZON_YEARS
  // The END is what must clear the horizon (mirrors the server): a range
  // starting inside it but running past its last day is still beyond.
  const reach = Math.max(pickedYear, yearFromIso(endDate) ?? pickedYear)
  return reach > maxYear ? { kind: 'beyond-horizon', maxYear } : null
}

// A request the requester can still call off themselves. Pending is simply
// withdrawn; an approved booking can be called off only while it has not
// started, and not while a change to it is awaiting approval. The backend
// enforces all of this — this decides whether the button is worth offering.
// `asOf` is the server instant the page was rendered from, never a local clock.
export function canCancelRequest(
  request: Pick<
    LeaveRequestSummaryDto,
    'status' | 'startDate' | 'modificationPending'
  >,
  asOf: string,
): boolean {
  if (request.status === LeaveRequestStatus.Pending) {
    return true
  }
  return (
    request.status === LeaveRequestStatus.Approved &&
    !request.modificationPending &&
    request.startDate > asOf.slice(0, 10)
  )
}

// Only an approved, not-yet-started booking can be changed, and only one
// change at a time. A pending request needs no re-approval flow: it can be
// cancelled and submitted again.
export function canModifyRequest(
  request: Pick<
    LeaveRequestSummaryDto,
    'status' | 'startDate' | 'modificationPending'
  >,
  asOf: string,
): boolean {
  return (
    request.status === LeaveRequestStatus.Approved &&
    !request.modificationPending &&
    request.startDate > asOf.slice(0, 10)
  )
}

// What an approver is actually being asked to agree to: the difference between
// the booking that stands and the one proposed. Rows are always in the same
// order so the card reads consistently, with `changed` driving the emphasis.
export type ModificationDiffLine = {
  label: string
  before: string
  after: string
  changed: boolean
}

type ModificationSide = Pick<
  LeaveRequestSummaryDto,
  | 'startDate'
  | 'endDate'
  | 'requestedDays'
  | 'paidDays'
  | 'unpaidDays'
  | 'comment'
  | 'dayPortions'
>

export function summarizeModificationDiff(
  original: ModificationSide,
  replacement: ModificationSide,
): ModificationDiffLine[] {
  const dayDelta = replacement.requestedDays - original.requestedDays
  const fundingChanged =
    original.paidDays !== replacement.paidDays ||
    original.unpaidDays !== replacement.unpaidDays
  const originalShape = partDayEntries(original.dayPortions)
  const replacementShape = partDayEntries(replacement.dayPortions)
  const shapeChanged = !sameDayShape(
    original.dayPortions,
    replacement.dayPortions,
  )
  return [
    {
      label: 'Period',
      before: formatDateRange(original.startDate, original.endDate),
      after: formatDateRange(replacement.startDate, replacement.endDate),
      changed:
        original.startDate !== replacement.startDate ||
        original.endDate !== replacement.endDate,
    },
    {
      label: 'Working days',
      before: formatDays(original.requestedDays),
      after:
        dayDelta === 0
          ? formatDays(replacement.requestedDays)
          : `${formatDays(replacement.requestedDays)} (${dayDelta > 0 ? '+' : ''}${formatDays(dayDelta)})`,
      changed: dayDelta !== 0,
    },
    // Only when one of the two sides has a shortened day. Without this line a
    // change that moves hours BETWEEN dates keeping the same total reads as no
    // change at all: the period is the same, the day count is the same, and the
    // funding is the same, yet it is a different absence and the approver is
    // being asked to agree to it.
    // An EMPTY map is a whole-day request, exactly like an absent one, so the
    // row is offered on the entries rather than on the field being present.
    ...(originalShape.length > 0 || replacementShape.length > 0
      ? [
          {
            label: 'Part days',
            before: describeDayShape(original.dayPortions) || 'Whole days',
            after: describeDayShape(replacement.dayPortions) || 'Whole days',
            changed: shapeChanged,
          },
        ]
      : []),
    // Only when one of the two sides has unpaid days: the approver is agreeing
    // to how the leave is funded, not just to its dates, and a change of dates
    // can move days out of the balance. A change between two fully paid
    // requests has nothing to say here.
    ...(original.unpaidDays > 0 || replacement.unpaidDays > 0
      ? [
          {
            label: 'Funding',
            before: formatDaySplit(original.paidDays, original.unpaidDays),
            after: formatDaySplit(replacement.paidDays, replacement.unpaidDays),
            changed: fundingChanged,
          },
        ]
      : []),
    {
      label: 'Note',
      before: original.comment ?? 'None',
      after: replacement.comment ?? 'None',
      changed: (original.comment ?? '') !== (replacement.comment ?? ''),
    },
  ]
}

export function formatBalanceReason(reason: LeaveBalanceChangeReason): string {
  switch (reason) {
    case LeaveBalanceChangeReason.Accrual:
      return 'Accrual'
    case LeaveBalanceChangeReason.Hold:
      return 'Placed on hold'
    case LeaveBalanceChangeReason.Release:
      return 'Released back to available'
    case LeaveBalanceChangeReason.Spent:
      return 'Consumed as leave taken'
    case LeaveBalanceChangeReason.CarryoverIn:
      return 'Carried over from last year'
    case LeaveBalanceChangeReason.CarryoverOut:
      return 'Carried over to next year'
    case LeaveBalanceChangeReason.Expired:
      return 'Expired at year end'
    case LeaveBalanceChangeReason.Adjustment:
    default:
      return 'Manual adjustment'
  }
}
