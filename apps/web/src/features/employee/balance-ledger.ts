/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveBalanceChangeDto } from '@workspace/contracts'
import { LeaveBalanceChangeReason, type LeaveType } from '@workspace/contracts'

/**
 * The display sign of a ledger delta. The server records deltaDays as a
 * POSITIVE MAGNITUDE for every reason except Adjustment (hold passes the
 * requested days, spent passes per-day units, release the remaining held
 * days); only adjustments arrive signed. So the direction comes from the
 * REASON: holds and consumption take days away, accruals and releases give
 * them back, adjustments speak for themselves.
 */
export function signedDeltaDays(entry: LeaveBalanceChangeDto): number {
  switch (entry.reason) {
    case LeaveBalanceChangeReason.Hold:
    case LeaveBalanceChangeReason.Spent:
    // Year close, old-year side: days leaving for the next year, and days the
    // policy burnt. Both drain the year they sit in.
    case LeaveBalanceChangeReason.CarryoverOut:
    case LeaveBalanceChangeReason.Expired:
      return -Math.abs(entry.deltaDays)
    case LeaveBalanceChangeReason.Accrual:
    case LeaveBalanceChangeReason.Release:
    // Year close, new-year side: the carried days arriving.
    case LeaveBalanceChangeReason.CarryoverIn:
      return Math.abs(entry.deltaDays)
    default:
      return entry.deltaDays
  }
}

/**
 * Newest-first copy of the server's ledger. The API returns the whole ledger
 * ascending by insertion (createdAt, the stable timeline order - effectiveDate
 * is only a calendar date, so it cannot be the sort key); the server appends in
 * the order the movements happened, so reversing genuinely puts the newest
 * movement first.
 */
export function ledgerRows(timeline: LeaveBalanceChangeDto[]): LeaveBalanceChangeDto[] {
  return [...timeline].reverse()
}

/** UTC-pinned "July 2026" label for a ledger month separator. */
export function ledgerMonthLabel(dateIso: string): string {
  return new Date(`${dateIso.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString(
    undefined,
    { month: 'long', year: 'numeric', timeZone: 'UTC' },
  )
}

export type LedgerGroup = {
  label: string
  items: LeaveBalanceChangeDto[]
}

/**
 * Month separators over a newest-first ledger: "This month" for the server
 * clock's month (generatedAt), month-name labels otherwise. Groups are formed
 * by ADJACENCY, not by bucketing: the insertion order is the truthful timeline
 * and the running figures on each row only make sense in it, so a month that
 * genuinely reappears gets its label repeated rather than having its entries
 * silently reordered into one bucket.
 *
 * The server files a catch-up chronologically, so in practice a month appears
 * once; the adjacency rule is what keeps this honest if one ever does not.
 */
export function ledgerGroups(
  items: LeaveBalanceChangeDto[],
  generatedAt: string,
): LedgerGroup[] {
  const currentMonth = generatedAt.slice(0, 7)
  const groups: LedgerGroup[] = []
  for (const item of items) {
    const label =
      item.effectiveDate.slice(0, 7) === currentMonth
        ? 'This month'
        : ledgerMonthLabel(item.effectiveDate)
    const last = groups[groups.length - 1]
    if (last && last.label === label) {
      last.items.push(item)
    } else {
      groups.push({ label, items: [item] })
    }
  }
  return groups
}

export type LedgerTypeSection = {
  leaveType: LeaveType
  groups: LedgerGroup[]
}

/**
 * The ledger split into one section per leave type, month separators inside
 * each.
 *
 * The server returns the whole ledger in insertion order, and an accrual pass
 * writes every vacation row before every sick row. Grouping by month adjacency
 * over that stream therefore emitted "January 2026" once for vacation and
 * again for sick, so an unfiltered timeline appeared to both start and end in
 * January with no explanation of why. Each type's own stream is chronological;
 * the two are simply not interleaved with each other.
 *
 * Sections keep the order the types are first encountered, so the newest
 * movement still leads the page.
 */
export function ledgerTypeSections(
  items: LeaveBalanceChangeDto[],
  generatedAt: string,
): LedgerTypeSection[] {
  const order: LeaveType[] = []
  const byType = new Map<LeaveType, LeaveBalanceChangeDto[]>()
  for (const item of items) {
    const bucket = byType.get(item.leaveType)
    if (bucket) {
      bucket.push(item)
    } else {
      order.push(item.leaveType)
      byType.set(item.leaveType, [item])
    }
  }
  return order.map((leaveType) => ({
    leaveType,
    groups: ledgerGroups(byType.get(leaveType) ?? [], generatedAt),
  }))
}

/** Client-side ledger filters: null means "all" on either axis. */
export function filterLedger(
  items: LeaveBalanceChangeDto[],
  leaveType: LeaveType | null,
  reason: LeaveBalanceChangeReason | null,
): LeaveBalanceChangeDto[] {
  return items.filter(
    (item) =>
      (leaveType === null || item.leaveType === leaveType) &&
      (reason === null || item.reason === reason),
  )
}
