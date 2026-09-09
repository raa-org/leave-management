/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  ApproverDecision,
  ApproverKind,
  LeaveRequestStatus,
} from '@workspace/contracts'
import type { LeaveRequestApprovalRecipientDto } from '@workspace/contracts'
import {
  dayPortionToHours,
  formatDayAmount,
  hoursToDayPortion,
  isOnHourGrid,
} from '../../../api/src/domain/day-math'
import {
  accruedSplitOf,
  adoptWorkdayHours,
  canCancelRequest,
  canModifyRequest,
  configureWorkdayHours,
  describeDayShape,
  daysToWholeHours,
  floorDays,
  formatDays,
  formatDaysExact,
  carriedOverFromLastYearSuffix,
  exactBookableTooltip,
  formatLedgerDays,
  formatCompleteHoursDelta,
  formatDayMonth,
  formatDaySplit,
  formatRelativeTime,
  formatStatus,
  getStatusColor,
  horizonNoticeFor,
  hoursToDays,
  partDayEntries,
  roundDays,
  sameDayShape,
  snapDaysToHourGrid,
  spansYears,
  splitDayAmount,
  summarizeApproverGate,
  summarizeModificationDiff,
  workdayHoursOf,
} from './leave-format'

describe('formatRelativeTime', () => {
  const base = '2026-07-14T12:00:00.000Z'
  const baseMs = new Date(base).getTime()

  it('reads recent timestamps as "just now"', () => {
    expect(formatRelativeTime(base, baseMs)).toBe('just now')
    expect(formatRelativeTime(base, baseMs + 30_000)).toBe('just now')
  })

  it('rounds into minutes, hours and days', () => {
    expect(formatRelativeTime(base, baseMs + 5 * 60_000)).toBe('5 min ago')
    expect(formatRelativeTime(base, baseMs + 3 * 60 * 60_000)).toBe('3 h ago')
    expect(formatRelativeTime(base, baseMs + 2 * 24 * 60 * 60_000)).toBe('2 d ago')
  })

  it('never goes negative when the server clock is ahead of the client', () => {
    expect(formatRelativeTime(base, baseMs - 60_000)).toBe('just now')
  })

  it('returns an empty string for an invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date', baseMs)).toBe('')
  })
})

describe('summarizeApproverGate', () => {
  const to = (
    email: string,
    decision?: ApproverDecision,
  ): LeaveRequestApprovalRecipientDto => ({
    email,
    kind: ApproverKind.To,
    ...(decision !== undefined ? { decision } : {}),
  })
  const cc = (email: string): LeaveRequestApprovalRecipientDto => ({
    email,
    kind: ApproverKind.Cc,
    decision: ApproverDecision.Pending,
  })

  it('counts only to-approvers, never copied recipients', () => {
    // A cc row stays pending forever, so counting it would make the gate look
    // permanently unmet.
    const gate = summarizeApproverGate([
      to('lead@example.com', ApproverDecision.Approved),
      to('manager@example.com', ApproverDecision.Pending),
      cc('hr@example.com'),
    ])
    expect(gate).toMatchObject({ total: 2, approved: 1, rejected: 0 })
    expect(gate.label).toBe('Approved by 1 of 2 approvers')
  })

  it('treats a missing decision as pending', () => {
    // `decision` is optional on the DTO.
    const gate = summarizeApproverGate([
      to('lead@example.com', ApproverDecision.Approved),
      to('manager@example.com'),
    ])
    expect(gate).toMatchObject({ total: 2, approved: 1 })
    expect(gate.label).toBe('Approved by 1 of 2 approvers')
  })

  it('reports the gate as met only once every to-approver approved', () => {
    const gate = summarizeApproverGate([
      to('lead@example.com', ApproverDecision.Approved),
      to('manager@example.com', ApproverDecision.Approved),
    ])
    expect(gate.approved).toBe(2)
    expect(gate.label).toBe('Approved by all 2 approvers')
  })

  it('leads with a rejection, since one ends the whole request', () => {
    const gate = summarizeApproverGate([
      to('lead@example.com', ApproverDecision.Approved),
      to('manager@example.com', ApproverDecision.Rejected),
      to('director@example.com', ApproverDecision.Pending),
    ])
    expect(gate).toMatchObject({ total: 3, approved: 1, rejected: 1 })
    expect(gate.label).toBe('Rejected by 1 of 3 approvers')
  })

  it('does not claim unanimity when there is nobody left to approve', () => {
    // Zero voters must not read as "approved by all": approved === total would
    // otherwise be vacuously true.
    const gate = summarizeApproverGate([cc('hr@example.com')])
    expect(gate).toMatchObject({ total: 0, approved: 0, rejected: 0 })
    expect(gate.label).toBe('No primary approvers remain on this request')
  })

  it('tells an automatic approval apart from a request stripped of approvers', () => {
    // The CC-only shape approval-optional mode produces: nobody voted because
    // nobody had to, which must not read as "no approvers remain".
    const gate = summarizeApproverGate(
      [cc('hr@example.com')],
      LeaveRequestStatus.Approved,
    )
    expect(gate).toMatchObject({ total: 0, approved: 0, rejected: 0 })
    expect(gate.label).toBe('Approved automatically (no approvers required)')
    // Any other status keeps the older wording even with a status supplied.
    expect(
      summarizeApproverGate([cc('hr@example.com')], LeaveRequestStatus.Cancelled)
        .label,
    ).toBe('No primary approvers remain on this request')
  })
})

describe('planning predicates', () => {
  const asOf = '2026-07-14T12:00:00.000Z'
  const approved = {
    status: LeaveRequestStatus.Approved,
    startDate: '2026-08-03',
  }

  it('offers cancellation for a pending request and for approved leave that has not started', () => {
    expect(
      canCancelRequest({ status: LeaveRequestStatus.Pending, startDate: '2026-01-05' }, asOf),
    ).toBe(true)
    expect(canCancelRequest(approved, asOf)).toBe(true)
  })

  it('withdraws cancellation once the leave starts, or while a change awaits approval', () => {
    // The start day itself counts as started: the leave is under way.
    expect(canCancelRequest({ ...approved, startDate: '2026-07-14' }, asOf)).toBe(false)
    expect(canCancelRequest({ ...approved, startDate: '2026-07-01' }, asOf)).toBe(false)
    expect(canCancelRequest({ ...approved, modificationPending: true }, asOf)).toBe(false)
    expect(
      canCancelRequest({ status: LeaveRequestStatus.Rejected, startDate: '2026-08-03' }, asOf),
    ).toBe(false)
    expect(
      canCancelRequest({ status: LeaveRequestStatus.Superseded, startDate: '2026-08-03' }, asOf),
    ).toBe(false)
  })

  it('offers a change only for approved leave, unlike cancellation', () => {
    expect(canModifyRequest(approved, asOf)).toBe(true)
    // A pending request needs no re-approval flow: cancel and submit again.
    expect(
      canModifyRequest({ status: LeaveRequestStatus.Pending, startDate: '2026-08-03' }, asOf),
    ).toBe(false)
    expect(canModifyRequest({ ...approved, startDate: '2026-07-14' }, asOf)).toBe(false)
    expect(canModifyRequest({ ...approved, modificationPending: true }, asOf)).toBe(false)
  })

  it('warns only beyond the end of next year, and never without a server instant', () => {
    expect(horizonNoticeFor('2026-12-31', asOf)).toBeNull()
    expect(horizonNoticeFor('2027-12-31', asOf)).toBeNull()
    expect(horizonNoticeFor('2028-01-03', asOf)).toEqual({
      kind: 'beyond-horizon',
      maxYear: 2027,
    })
    expect(horizonNoticeFor('', asOf)).toBeNull()
    expect(horizonNoticeFor('2028-01-03', undefined)).toBeNull()
  })

  it('caps a range by its END date, mirroring the server guard', () => {
    // Starts inside the horizon but runs past its last day: refused by the
    // far end, exactly as the server refuses the submission.
    expect(horizonNoticeFor('2027-12-27', asOf, '2028-01-03')).toEqual({
      kind: 'beyond-horizon',
      maxYear: 2027,
    })
    // A crossing that stays within the horizon is fine.
    expect(horizonNoticeFor('2026-12-28', asOf, '2027-01-05')).toBeNull()
  })
})

describe('spansYears', () => {
  it('detects a New Year crossing and nothing else', () => {
    expect(spansYears('2026-12-25', '2027-01-05')).toBe(true)
    expect(spansYears('2026-08-03', '2026-08-14')).toBe(false)
    expect(spansYears('2026-08-03', '2026-08-03')).toBe(false)
    // Blank inputs never claim a crossing.
    expect(spansYears('', '2027-01-05')).toBe(false)
  })
})

describe('summarizeModificationDiff', () => {
  const original = {
    startDate: '2026-08-03',
    endDate: '2026-08-07',
    requestedDays: 5,
    paidDays: 5,
    unpaidDays: 0,
    comment: 'Family trip',
  }

  it('marks what changed and signs the day difference', () => {
    const [period, days, note] = summarizeModificationDiff(original, {
      startDate: '2026-08-03',
      endDate: '2026-08-12',
      requestedDays: 8,
      paidDays: 8,
      unpaidDays: 0,
      comment: 'Family trip',
    })

    expect(period).toMatchObject({ label: 'Period', changed: true })
    expect(days).toMatchObject({ label: 'Working days', changed: true })
    expect(days?.after).toBe('8d (+3d)')
    expect(note).toMatchObject({ changed: false })
  })

  it('signs a shortened request and reports an added note', () => {
    const [, days, note] = summarizeModificationDiff(
      { ...original, comment: undefined },
      { ...original, endDate: '2026-08-05', requestedDays: 3, comment: 'Shorter now' },
    )

    expect(days?.after).toBe('3d (-2d)')
    expect(note).toMatchObject({ before: 'None', after: 'Shorter now', changed: true })
  })

  it('reports no change at all when the two match', () => {
    expect(
      summarizeModificationDiff(original, original).every((line) => !line.changed),
    ).toBe(true)
  })

  it('shows the funding only once a side of the change has unpaid days', () => {
    // Two fully paid requests have nothing to say about funding, so the table
    // reads exactly as it did before unpaid leave existed.
    expect(
      summarizeModificationDiff(original, { ...original, endDate: '2026-08-12', requestedDays: 8, paidDays: 8 })
        .map((line) => line.label),
    ).toEqual(['Period', 'Working days', 'Note'])

    // Same dates, same length, different funding: the approver is agreeing to
    // days moving out of the balance, which nothing else on the page states.
    const [, , funding] = summarizeModificationDiff(original, {
      ...original,
      paidDays: 2,
      unpaidDays: 3,
    })
    expect(funding).toEqual({
      label: 'Funding',
      before: '5d',
      after: '5d (2d paid + 3d unpaid)',
      changed: true,
    })
  })

  // The case the diff was blind to: the same week, the same total, the hours
  // moved from one afternoon to another. Period, working days and funding are
  // all unchanged, so without a shape row the card reported no change at all
  // for a proposal the approver has to decide.
  it('sees a change that only moves hours between the same dates', () => {
    const shortMonday = {
      ...original,
      requestedDays: 4.5,
      paidDays: 4.5,
      dayPortions: { '2026-08-03': 0.5 },
    }
    const shortFriday = {
      ...shortMonday,
      dayPortions: { '2026-08-07': 0.5 },
    }

    const lines = summarizeModificationDiff(shortMonday, shortFriday)
    expect(lines.map((line) => line.label)).toEqual([
      'Period',
      'Working days',
      'Part days',
      'Note',
    ])
    const shape = lines.find((line) => line.label === 'Part days')
    expect(shape).toEqual({
      label: 'Part days',
      before: `${formatDayMonth('2026-08-03')} 4h`,
      after: `${formatDayMonth('2026-08-07')} 4h`,
      changed: true,
    })
    // ...and it is the ONLY thing that changed, which is the whole point.
    expect(lines.filter((line) => line.changed)).toEqual([shape])
  })

  it('says which whole days a shortened one replaced, and stays quiet otherwise', () => {
    const [, , shape] = summarizeModificationDiff(original, {
      ...original,
      requestedDays: 4.75,
      paidDays: 4.75,
      dayPortions: { '2026-08-05': 0.75 },
    })
    expect(shape).toMatchObject({
      label: 'Part days',
      before: 'Whole days',
      after: `${formatDayMonth('2026-08-05')} 6h`,
      changed: true,
    })

    // An EMPTY map is a whole-day request exactly like an absent one, so a
    // change between two of them offers no row to read.
    expect(
      summarizeModificationDiff(
        { ...original, dayPortions: {} },
        { ...original, dayPortions: {}, endDate: '2026-08-12', requestedDays: 8, paidDays: 8 },
      ).map((line) => line.label),
    ).toEqual(['Period', 'Working days', 'Note'])
  })
})

describe('the part-day shape of a request', () => {
  it('lists only the shortened dates, in calendar order', () => {
    expect(
      partDayEntries({ '2026-08-07': 0.25, '2026-08-03': 0.5 }),
    ).toEqual([
      { date: '2026-08-03', portion: 0.5 },
      { date: '2026-08-07', portion: 0.25 },
    ])
    // A whole day has nothing to say and never appears, however it got in.
    expect(partDayEntries({ '2026-08-03': 1 })).toEqual([])
    expect(partDayEntries({})).toEqual([])
    expect(partDayEntries(undefined)).toEqual([])
  })

  it('reads each date in the same day notation as every other figure', () => {
    expect(describeDayShape({ '2026-08-03': 0.5, '2026-08-04': 0.25 })).toBe(
      `${formatDayMonth('2026-08-03')} 4h · ${formatDayMonth('2026-08-04')} 2h`,
    )
    // Empty, so a surface renders nothing at all rather than a row saying
    // there is nothing to say.
    expect(describeDayShape(undefined)).toBe('')
    expect(describeDayShape({})).toBe('')
  })

  it('compares two shapes by their shortened dates alone', () => {
    expect(sameDayShape({ '2026-08-03': 0.5 }, { '2026-08-03': 0.5 })).toBe(true)
    expect(sameDayShape(undefined, {})).toBe(true)
    expect(sameDayShape({ '2026-08-03': 1 }, undefined)).toBe(true)
    // Same total, different day: a different absence.
    expect(sameDayShape({ '2026-08-03': 0.5 }, { '2026-08-07': 0.5 })).toBe(false)
    expect(sameDayShape({ '2026-08-03': 0.5 }, { '2026-08-03': 0.25 })).toBe(false)
  })
})

describe('formatDaySplit', () => {
  it('spells out the split only when there is one', () => {
    expect(formatDaySplit(10, 0)).toBe('10d')
    expect(formatDaySplit(7, 3)).toBe('10d (7d paid + 3d unpaid)')
    // No pointless "0d paid" when the balance funds none of it.
    expect(formatDaySplit(0, 3)).toBe('3d unpaid')
    expect(formatDaySplit(7.5, 0.5)).toBe('8d (7d 4h paid + 4h unpaid)')
  })
})

// The server freezes these same strings into emails, ledger notes, audit rows
// and notification summaries. A screen that disagrees with the record is worse
// than either being wrong alone, so the two renderers are pinned against each
// other here rather than each against a literal of its own.
describe('the days-and-hours notation', () => {
  // The module keeps the divisor as state, so every test that changes it must
  // hand the default back or it leaks into whatever runs next.
  const withWorkday = (hours: number, run: () => void): void => {
    const previous = workdayHoursOf()
    configureWorkdayHours(hours)
    try {
      run()
    } finally {
      configureWorkdayHours(previous)
    }
  }

  it('matches the server formatter for the same input, on and off the grid', () => {
    for (const hoursPerDay of [4, 6, 7, 8, 12]) {
      withWorkday(hoursPerDay, () => {
        for (const value of [
          0, 0.08, 0.125, 0.5, 0.625, 1, 2.5, 3, 12.25, 12.333, 16.667, 25,
        ]) {
          expect(formatDays(value)).toBe(formatDayAmount(value, hoursPerDay))
        }
      })
    }
  })

  it('renders the cases the notation was approved on', () => {
    expect(formatDays(2.5)).toBe('2d 4h')
    expect(formatDays(0.625)).toBe('5h')
    expect(formatDays(3)).toBe('3d')
    expect(formatDays(0)).toBe('0d')
  })

  it('floors an off-grid balance to what can actually be taken', () => {
    expect(formatDays(12.333)).toBe('12d 2h')
    // Under an hour left is nothing bookable at all.
    expect(formatDays(0.08)).toBe('0d')
  })

  it('reads against a workday other than eight hours', () => {
    withWorkday(6, () => {
      expect(formatDays(2.5)).toBe('2d 3h')
      expect(formatDays(0.5)).toBe('3h')
    })
  })

  it('defaults to an eight-hour day and ignores an unusable setting', () => {
    expect(workdayHoursOf()).toBe(8)
    configureWorkdayHours(undefined)
    configureWorkdayHours(0)
    configureWorkdayHours(Number.NaN)
    expect(workdayHoursOf()).toBe(8)
  })

  // What a page calls with the divisor off its own payload. It hands back the
  // one in force so the page can pass it to anything that computes, and it
  // survives a payload that has not arrived (or arrives broken) by leaving the
  // fallback where it was.
  it('adopts the divisor a payload carries and hands it back', () => {
    withWorkday(8, () => {
      expect(adoptWorkdayHours(7)).toBe(7)
      expect(formatDays(2.5)).toBe('2d 3h')
      expect(adoptWorkdayHours(undefined)).toBe(7)
      expect(adoptWorkdayHours(0)).toBe(7)
    })
    expect(workdayHoursOf()).toBe(8)
  })

  // floorDays takes its divisor as an argument and never reads the module
  // fallback: it is a bookable ceiling, not a rendering.
  it('floors to the hour grid rather than to whole days', () => {
    expect(floorDays(12.333, 8)).toBe(12.25)
    expect(floorDays(12.25, 8)).toBe(12.25)
    expect(floorDays(0.08, 8)).toBe(0)
  })

  it('keeps the exact figure reachable behind the floored headline', () => {
    // Three decimals, the server's own day scale: two would print the accrued
    // remainder as 12.33 and stop being the stored figure.
    expect(formatDaysExact(12.333)).toBe('12.333d')
    expect(formatDaysExact(10)).toBe('10d')
    expect(exactBookableTooltip(2.083)).toBe(
      '2.083d on the books; 2d can be booked.',
    )
    expect(exactBookableTooltip(8.25)).toBeUndefined()
    expect(exactBookableTooltip(10)).toBeUndefined()
  })

  it('splits the same amount the formatter renders', () => {
    expect(splitDayAmount(12.333)).toEqual({ days: 12, hours: 2 })
    expect(splitDayAmount(0.625)).toEqual({ days: 0, hours: 5 })
    expect(splitDayAmount(3)).toEqual({ days: 3, hours: 0 })
  })

  it('prints a ledger step as the complete hours between two running totals', () => {
    // 25d / 12: leftover minutes are not a bookable hour, so January is +2d
    // and February's extra hour lands when the remainder fills. Eight months
    // then sum to August's 16d 5h, not 8 × 2d 1h = 17d.
    expect(formatCompleteHoursDelta(2.083, 0)).toBe('+2d')
    expect(formatCompleteHoursDelta(4.167, 2.083)).toBe('+2d 1h')
    expect(formatCompleteHoursDelta(6.25, 4.167)).toBe('+2d 1h')
    expect(formatCompleteHoursDelta(8.333, 6.25)).toBe('+2d')
    expect(formatCompleteHoursDelta(10.417, 8.333)).toBe('+2d 1h')
    expect(formatCompleteHoursDelta(12.5, 10.417)).toBe('+2d 1h')
    expect(formatCompleteHoursDelta(14.583, 12.5)).toBe('+2d')
    expect(formatCompleteHoursDelta(16.667, 14.583)).toBe('+2d 1h')
    expect(formatDays(16.667)).toBe('16d 5h')
    expect(formatCompleteHoursDelta(7, 10)).toBe('−3d')
    expect(formatCompleteHoursDelta(10, 10)).toBe('0d')
  })

  it('reads a ledger movement in hours, snapping accrual to the nearest hour', () => {
    // Everything an employee causes lands on the grid and reads as hours.
    expect(formatLedgerDays(0.25)).toBe('2h')
    expect(formatLedgerDays(0.625)).toBe('5h')
    expect(formatLedgerDays(1.25)).toBe('1d 2h')
    expect(formatLedgerDays(3)).toBe('3d')
    expect(formatLedgerDays(0)).toBe('0d')
    // A twelfth of a 25-day allowance is no whole number of hours. The
    // nearest hour is 2d 1h, not a decimal day count: QA will not accept
    // "2.083d" on a ledger that otherwise speaks in days and hours.
    expect(formatLedgerDays(2.083)).toBe('2d 1h')
    expect(formatLedgerDays(16.67)).toBe('16d 5h')
    // The leftover fractions of 17.083d and 2.292d become the extra hour in
    // the total, so the column still adds: 17d 1h + 2d 2h = 19d 3h.
    expect(formatLedgerDays(17.083)).toBe('17d 1h')
    expect(formatLedgerDays(2.292)).toBe('2d 2h')
    expect(formatLedgerDays(19.375)).toBe('19d 3h')
    // The sign is the caller's; the grid test reads the magnitude, so a
    // release renders exactly like the hold it undoes.
    expect(formatLedgerDays(-0.625)).toBe('-5h')
  })
})

// The composer prices a draft with these, and the server prices the submission
// with its own. Pinned against each other rather than against literals: a
// client that minted a portion the server would not is the one failure mode
// that reaches the books.
describe('the hour grid', () => {
  it('converts hours to a portion exactly as the server does', () => {
    for (const hoursPerDay of [4, 6, 7, 8, 12]) {
      for (let hours = 1; hours <= hoursPerDay; hours += 1) {
        expect(hoursToDays(hours, hoursPerDay)).toBe(
          hoursToDayPortion(hours, hoursPerDay),
        )
      }
    }
  })

  it('reads a portion back as the server does', () => {
    // The inverse the modification prefill converts a frozen portion with.
    for (const hoursPerDay of [4, 6, 7, 8, 12]) {
      for (const portion of [0.125, 0.25, 0.5, 0.625, 0.143, 1]) {
        expect(daysToWholeHours(portion, hoursPerDay)).toBe(
          dayPortionToHours(portion, hoursPerDay),
        )
      }
    }
  })

  it('takes an hour off exactly as it put one on', () => {
    // Magnitude first, like the server: an admin correction that cannot undo
    // itself would leave a thousandth of a day on the books every reversal.
    for (const hoursPerDay of [6, 7, 8]) {
      for (let hours = 1; hours <= hoursPerDay; hours += 1) {
        expect(hoursToDays(-hours, hoursPerDay)).toBe(
          -hoursToDays(hours, hoursPerDay),
        )
      }
    }
  })

  it('snaps a typed day figure onto the nearest bookable hour', () => {
    // The admin correction takes a figure typed by hand, and the server
    // refuses anything between two hours outright.
    expect(snapDaysToHourGrid(0.5, 8)).toBe(0.5)
    expect(snapDaysToHourGrid(0.37, 8)).toBe(0.375)
    expect(snapDaysToHourGrid(1.1, 8)).toBe(1.125)
    // Under half an hour is nothing at all, which the form reads as no
    // correction rather than as a refusal from the server.
    expect(snapDaysToHourGrid(0.05, 8)).toBe(0)
    expect(snapDaysToHourGrid(Number.NaN, 8)).toBe(0)
  })

  it('quantizes to the three decimals the books store', () => {
    // Two would take one hour of an eight-hour day off the grid entirely.
    expect(roundDays(0.125)).toBe(0.125)
    expect(roundDays(0.1428571)).toBe(0.143)
    expect(roundDays(16.669999999999998)).toBe(16.67)
  })

  // Why a minting path may never read the display fallback: the grid is the
  // SERVER's, and it is a different grid at a different workday. Pinned against
  // the server's own check rather than against literals, because the server is
  // the thing that accepts or refuses the figure.
  it('snaps onto a grid the server accepts only when given the org workday', () => {
    for (const typed of [0.5, 1.1, 2.37, 0.3]) {
      const onSeven = snapDaysToHourGrid(typed, 7)
      expect(isOnHourGrid(onSeven, 7)).toBe(true)
    }
    // Half a day at a seven-hour workday is four hours snapped, which is 0.571.
    expect(snapDaysToHourGrid(0.5, 7)).toBe(0.571)

    // The same figure snapped against the eight-hour default is 0.5 exactly,
    // and a seven-hour org's server refuses it: 0.5 is three and a half hours
    // there, an amount nobody can have taken.
    const onDefault = snapDaysToHourGrid(0.5, 8)
    expect(onDefault).toBe(0.5)
    expect(isOnHourGrid(onDefault, 7)).toBe(false)
  })
})

describe('status rendering', () => {
  it('names a superseded booking and gives it its own colour', () => {
    expect(formatStatus(LeaveRequestStatus.Superseded)).toBe('Superseded')
    // Distinct from cancelled: the leave happened, under other dates.
    expect(getStatusColor(LeaveRequestStatus.Superseded)).toBe('info')
    expect(getStatusColor(LeaveRequestStatus.Cancelled)).toBe('default')
  })
})

describe('carriedOverFromLastYearSuffix', () => {
  it('names last year leftover beside an annual total', () => {
    expect(carriedOverFromLastYearSuffix(7)).toBe(
      ' + 7d carried over from last year',
    )
  })

  it('is empty when nothing carried, so existing total copy stays intact', () => {
    expect(carriedOverFromLastYearSuffix(0)).toBe('')
    expect(carriedOverFromLastYearSuffix(undefined)).toBe('')
    expect(carriedOverFromLastYearSuffix(-1)).toBe('')
  })
})

describe('accruedSplitOf', () => {
  it('takes the carryover back off the DTO accrued figure', () => {
    // The reported defect's balance: 23.667 on the books = 16.667 earned from
    // the 25d entitlement + the 7d that rolled in.
    expect(accruedSplitOf({ accruedDays: 23.667, carriedOverDays: 7 })).toEqual(
      { earnedDays: 16.667, carriedDays: 7 },
    )
    expect(accruedSplitOf({ accruedDays: 18 })).toEqual({
      earnedDays: 18,
      carriedDays: 0,
    })
  })

  it('caps the carried part by what the balance still holds', () => {
    // An admin removal can eat into the carryover itself: 9d taken off a
    // January balance of 2.083 earned + 7 carried leaves 0.083 on the books.
    // Naming "7d carried over" beside "0d accrued" would sum to days the
    // balance no longer has; under an hour left, the carried term drops out.
    expect(accruedSplitOf({ accruedDays: 0.083, carriedOverDays: 7 })).toEqual({
      earnedDays: 0.083,
      carriedDays: 0,
    })
    expect(accruedSplitOf({ accruedDays: 3.5, carriedOverDays: 7 })).toEqual({
      earnedDays: 0,
      carriedDays: 3.5,
    })
  })

  it('keeps the displayed parts summing to the displayed accrued figure', () => {
    // An imported opening carryover can sit off the hour grid (7.301d from
    // the tracker). Flooring each part independently would read one hour
    // short: floor(12.699) + floor(7.301) = 12d 5h + 7d 2h = 19d 7h of a 20d
    // balance. The split floors the carried part first and leaves the
    // sub-hour remainder with the earned one, so the terms a reader can sum
    // reproduce formatDays(20) exactly.
    const split = accruedSplitOf({ accruedDays: 20, carriedOverDays: 7.301 })
    expect(split).toEqual({ earnedDays: 12.75, carriedDays: 7.25 })
    expect(formatDays(split.earnedDays)).toBe('12d 6h')
    expect(formatDays(split.carriedDays)).toBe('7d 2h')
  })
})
