/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  LeaveRequestStatus,
  LeaveType,
  type HolidayCalendarDto,
  type LeaveRequestSummaryDto,
} from '@workspace/contracts'
import {
  addDays,
  aggregateBalanceTotals,
  buildUpcomingTimeline,
  daysBetween,
  firstNameOf,
  greetingFor,
  inDaysLabel,
  isoDateOnly,
  nextTimeOff,
  probationNoticeLine,
  startsLabel,
  upcomingWindow,
} from './dashboard-insights'

function approvedRequest(
  overrides: Partial<LeaveRequestSummaryDto>,
): LeaveRequestSummaryDto {
  return {
    requestId: 'req-1',
    leaveType: LeaveType.Vacation,
    status: LeaveRequestStatus.Approved,
    startDate: '2026-07-03',
    endDate: '2026-07-06',
    requestedDays: 2,
    paidDays: 2,
    unpaidDays: 0,
    heldDays: 2,
    submittedAt: '2026-06-20T08:00:00.000Z',
    ...overrides,
  }
}

function calendar(holidays: { date: string; name: string }[]): HolidayCalendarDto {
  return {
    calendarId: 'cal-1',
    country: { code: 'UA', name: 'Ukraine' },
    year: 2026,
    name: 'Ukraine 2026',
    holidays,
  }
}

describe('dashboard insights', () => {
  it('extracts UTC date-only values and does day math across month boundaries', () => {
    expect(isoDateOnly('2026-07-01T09:00:00.000Z')).toBe('2026-07-01')
    expect(isoDateOnly('2026-07-01')).toBe('2026-07-01')
    expect(addDays('2026-07-25', 14)).toBe('2026-08-08')
    expect(daysBetween('2026-07-01', '2026-07-15')).toBe(14)
    expect(daysBetween('2026-07-15', '2026-07-01')).toBe(-14)
    // DST-irrelevant UTC math: the late-March window keeps whole days.
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
  })

  it('derives the upcoming window from the server timestamp', () => {
    expect(upcomingWindow('2026-07-01T09:00:00.000Z')).toEqual({
      from: '2026-07-01',
      to: '2026-07-15',
    })
  })

  it('merges approved leave and holidays into one date-sorted timeline', () => {
    const entries = buildUpcomingTimeline(
      [approvedRequest({})],
      [calendar([{ date: '2026-07-07', name: 'Statehood Day' }])],
      '2026-07-01T09:00:00.000Z',
    )
    expect(entries.map((entry) => `${entry.kind}:${entry.date}`)).toEqual([
      'leave:2026-07-03',
      'holiday:2026-07-07',
    ])
    expect(entries[0]!.inDays).toBe(2)
    expect(entries[1]!.title).toBe('Statehood Day')
  })

  it('keeps ongoing leave that started before today and drops out-of-window rows', () => {
    const entries = buildUpcomingTimeline(
      [
        approvedRequest({ requestId: 'ongoing', startDate: '2026-06-28', endDate: '2026-07-02' }),
        approvedRequest({ requestId: 'far', startDate: '2026-08-20', endDate: '2026-08-22' }),
      ],
      [calendar([{ date: '2026-08-24', name: 'Independence Day' }])],
      '2026-07-01T09:00:00.000Z',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.request?.requestId).toBe('ongoing')
    expect(entries[0]!.inDays).toBeLessThan(0)
    expect(inDaysLabel(entries[0]!.inDays)).toBe('Ongoing')
  })

  it('is defensive about missing payload shapes', () => {
    expect(buildUpcomingTimeline(undefined, undefined, '2026-07-01T09:00:00.000Z')).toEqual([])
    expect(
      buildUpcomingTimeline([], [calendar([])], '2026-07-01T09:00:00.000Z'),
    ).toEqual([])
  })

  it('picks the next not-yet-started leave as "next time off"', () => {
    const entries = buildUpcomingTimeline(
      [
        approvedRequest({ requestId: 'ongoing', startDate: '2026-06-28', endDate: '2026-07-02' }),
        approvedRequest({ requestId: 'next', startDate: '2026-07-05', endDate: '2026-07-08' }),
      ],
      [calendar([{ date: '2026-07-03', name: 'Some Holiday' }])],
      '2026-07-01T09:00:00.000Z',
    )
    // Holidays and already-running leave never count as "your next time off".
    expect(nextTimeOff(entries)?.request?.requestId).toBe('next')
  })

  it('labels proximity in words', () => {
    expect(inDaysLabel(0)).toBe('Today')
    expect(inDaysLabel(1)).toBe('Tomorrow')
    expect(inDaysLabel(6)).toBe('In 6 days')
    expect(inDaysLabel(-2)).toBe('Ongoing')
    expect(startsLabel(0)).toBe('starts today')
    expect(startsLabel(1)).toBe('starts tomorrow')
    expect(startsLabel(5)).toBe('starts in 5 days')
  })

  it('buckets the greeting by hour', () => {
    expect(greetingFor(6)).toBe('Good morning')
    expect(greetingFor(11)).toBe('Good morning')
    expect(greetingFor(12)).toBe('Good afternoon')
    expect(greetingFor(17)).toBe('Good afternoon')
    expect(greetingFor(19)).toBe('Good evening')
    expect(greetingFor(3)).toBe('Good evening')
  })

  it('takes the first name from a display name', () => {
    expect(firstNameOf('Maya Chen')).toBe('Maya')
    expect(firstNameOf('  Maya  ')).toBe('Maya')
    expect(firstNameOf('Cher')).toBe('Cher')
  })

  it('aggregates KPI totals across balances', () => {
    const totals = aggregateBalanceTotals([
      {
        leaveType: LeaveType.Vacation,
        totalDays: 24,
        availableDays: 15,
        onHoldDays: 3,
        spentDays: 6,
        accruedDays: 18,
        updatedAt: '2026-07-01T09:00:00.000Z',
      },
      {
        leaveType: LeaveType.Sick,
        totalDays: 10,
        availableDays: 8,
        onHoldDays: 0,
        spentDays: 2,
        accruedDays: 10,
        updatedAt: '2026-07-01T09:00:00.000Z',
      },
    ])
    expect(totals.onHoldTotal).toBe(3)
    expect(totals.spentTotal).toBe(8)
    expect(totals.spentVacation).toBe(6)
    expect(totals.spentSick).toBe(2)
    expect(totals.vacation?.accruedDays).toBe(18)
  })
})

describe('probationNoticeLine', () => {
  it('warns while a probation window is still running', () => {
    const line = probationNoticeLine('2026-09-01')
    expect(line).toContain('On probation until')
    expect(line).toContain('unpaid')
  })

  it('says nothing when there is no probation', () => {
    expect(probationNoticeLine(undefined)).toBeNull()
  })

  it('never names the policy', () => {
    // The name is an internal grouping ("Migrated 25+5"), not a promise the
    // reader can act on; the numbers it implies are already on the tiles.
    expect(probationNoticeLine('2026-09-01')).not.toContain('policy')
  })
})
