/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  LeaveBalanceChangeReason,
  LeaveType,
  type LeaveBalanceChangeDto,
} from '@workspace/contracts'
import {
  filterLedger,
  ledgerGroups,
  ledgerMonthLabel,
  ledgerRows,
  ledgerTypeSections,
  signedDeltaDays,
} from './balance-ledger'

function entry(
  effectiveDate: string,
  reason: LeaveBalanceChangeReason,
  leaveType = LeaveType.Vacation,
): LeaveBalanceChangeDto {
  return {
    effectiveDate,
    leaveType,
    deltaDays: 1,
    availableDays: 10,
    onHoldDays: 0,
    spentDays: 0,
    reason,
  }
}

describe('balance ledger helpers', () => {
  it('splits the ledger per leave type so a month cannot appear twice', () => {
    // The shape the server actually sends: an accrual pass writes every
    // vacation row, then every sick row. Grouped as one stream, January showed
    // up at the top AND at the bottom with nothing saying why.
    const rows = [
      entry('2026-03-01', LeaveBalanceChangeReason.Accrual),
      entry('2026-02-01', LeaveBalanceChangeReason.Accrual),
      entry('2026-01-01', LeaveBalanceChangeReason.Accrual),
      entry('2026-03-01', LeaveBalanceChangeReason.Accrual, LeaveType.Sick),
      entry('2026-01-01', LeaveBalanceChangeReason.Accrual, LeaveType.Sick),
    ]

    // What it used to do, kept as the reason this helper exists.
    expect(
      ledgerGroups(rows, '2026-07-23T10:00:00.000Z').map((group) => group.label),
    ).toEqual(['March 2026', 'February 2026', 'January 2026', 'March 2026', 'January 2026'])

    const sections = ledgerTypeSections(rows, '2026-07-23T10:00:00.000Z')
    expect(sections.map((section) => section.leaveType)).toEqual([
      LeaveType.Vacation,
      LeaveType.Sick,
    ])
    for (const section of sections) {
      const labels = section.groups.map((group) => group.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
    expect(sections[1]!.groups.map((group) => group.label)).toEqual([
      'March 2026',
      'January 2026',
    ])
  })

  it('emits one section when the ledger holds a single leave type', () => {
    const sections = ledgerTypeSections(
      [entry('2026-03-01', LeaveBalanceChangeReason.Accrual)],
      '2026-07-23T10:00:00.000Z',
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.groups[0]!.items).toHaveLength(1)
  })

  it('reverses the ascending server order without mutating the input', () => {
    const timeline = [
      entry('2026-05-01', LeaveBalanceChangeReason.Accrual),
      entry('2026-06-01', LeaveBalanceChangeReason.Hold),
    ]
    const rows = ledgerRows(timeline)
    expect(rows.map((row) => row.effectiveDate)).toEqual(['2026-06-01', '2026-05-01'])
    // The store's array must stay untouched.
    expect(timeline[0]!.effectiveDate).toBe('2026-05-01')
  })

  it('labels the server-clock month as "This month" and others by name', () => {
    const rows = [
      entry('2026-07-20', LeaveBalanceChangeReason.Hold),
      entry('2026-07-02', LeaveBalanceChangeReason.Accrual),
      entry('2026-06-10', LeaveBalanceChangeReason.Spent),
    ]
    const groups = ledgerGroups(rows, '2026-07-23T10:00:00.000Z')
    expect(groups.map((group) => group.label)).toEqual([
      'This month',
      ledgerMonthLabel('2026-06-10'),
    ])
    expect(groups[0]!.items).toHaveLength(2)
    expect(groups[1]!.items).toHaveLength(1)
  })

  it('groups by adjacency, honestly repeating a label when insertion interleaves months', () => {
    // The server files a catch-up chronologically, so this interleaving should
    // not reach the page — but if it ever does, the timeline order is still the
    // truth (the running figures on each row are frozen in it), so the label
    // repeats rather than the entries being reordered into one bucket.
    const rows = [
      entry('2026-07-20', LeaveBalanceChangeReason.Hold),
      entry('2026-06-10', LeaveBalanceChangeReason.Spent),
      entry('2026-07-01', LeaveBalanceChangeReason.Accrual),
    ]
    const groups = ledgerGroups(rows, '2026-07-23T10:00:00.000Z')
    expect(groups.map((group) => group.label)).toEqual([
      'This month',
      ledgerMonthLabel('2026-06-10'),
      'This month',
    ])
  })

  it('produces distinct, year-bearing month labels', () => {
    // Non-circular anchors so a broken formatter cannot pass by echoing
    // itself: the label carries the year and differs across month and year.
    expect(ledgerMonthLabel('2026-06-10')).toContain('2026')
    expect(ledgerMonthLabel('2026-06-10')).not.toBe(ledgerMonthLabel('2026-05-10'))
    expect(ledgerMonthLabel('2026-06-10')).not.toBe(ledgerMonthLabel('2025-06-10'))
  })

  it('derives the delta sign from the reason, not the DTO magnitude', () => {
    // The server ships positive magnitudes for hold/spent/release/accrual and
    // a signed value only for adjustment.
    const base = entry('2026-07-01', LeaveBalanceChangeReason.Hold)
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Hold, deltaDays: 3 })).toBe(-3)
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Spent, deltaDays: 1 })).toBe(-1)
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Accrual, deltaDays: 2 })).toBe(2)
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Release, deltaDays: 3 })).toBe(3)
    // Adjustments arrive signed and pass through unchanged, either direction.
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Adjustment, deltaDays: 2 })).toBe(2)
    expect(signedDeltaDays({ ...base, reason: LeaveBalanceChangeReason.Adjustment, deltaDays: -2 })).toBe(-2)
  })

  it('filters by leave type and reason independently, null meaning all', () => {
    const rows = [
      entry('2026-07-01', LeaveBalanceChangeReason.Accrual, LeaveType.Vacation),
      entry('2026-07-02', LeaveBalanceChangeReason.Hold, LeaveType.Sick),
      entry('2026-07-03', LeaveBalanceChangeReason.Hold, LeaveType.Vacation),
    ]
    expect(filterLedger(rows, null, null)).toHaveLength(3)
    expect(filterLedger(rows, LeaveType.Sick, null)).toHaveLength(1)
    expect(
      filterLedger(rows, null, LeaveBalanceChangeReason.Hold).map(
        (row) => row.effectiveDate,
      ),
    ).toEqual(['2026-07-02', '2026-07-03'])
    expect(
      filterLedger(rows, LeaveType.Vacation, LeaveBalanceChangeReason.Hold),
    ).toHaveLength(1)
    expect(
      filterLedger(rows, LeaveType.Sick, LeaveBalanceChangeReason.Accrual),
    ).toHaveLength(0)
  })
})
