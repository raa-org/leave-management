/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type {
  LeaveAvailabilityPreviewDto,
  LeaveYearProjectionDto,
} from '@workspace/contracts'
import { LeaveType } from '@workspace/contracts'
import { buildRequestReceipt } from './request-receipt'

function projectedYear(
  overrides: Partial<LeaveYearProjectionDto> = {},
): LeaveYearProjectionDto {
  return {
    year: 2026,
    totalDays: 25,
    carriedOverDays: 0,
    carryoverProjected: false,
    accruedDays: 14.58,
    spentDays: 3,
    committedDays: 15,
    projectedAccruedByLeave: 25,
    projectedYearEndAccrual: 25,
    requestedDays: 0,
    paidDays: 0,
    unpaidDays: 0,
    carryoverOutDays: 0,
    ...overrides,
  }
}

function previewOf(
  overrides: Partial<LeaveAvailabilityPreviewDto> = {},
): LeaveAvailabilityPreviewDto {
  return {
    leaveType: LeaveType.Vacation,
    leaveYear: 2026,
    startDate: '2026-12-21',
    endDate: '2026-12-31',
    requestedDays: 8,
    paidDays: 7,
    unpaidDays: 1,
    unpaidDates: ['2026-12-31'],
    feasible: true,
    blockers: [],
    monthlyOutlook: [],
    years: [projectedYear({ requestedDays: 8, paidDays: 7, unpaidDays: 1 })],
    currentYear: 2026,
    generatedAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  }
}

// The form and the preview agree unless a case says otherwise.
function build(
  preview: LeaveAvailabilityPreviewDto,
  overrides: Partial<Parameters<typeof buildRequestReceipt>[0]> = {},
) {
  return buildRequestReceipt({
    leaveType: preview.leaveType,
    startDate: preview.startDate,
    endDate: preview.endDate,
    chargeableDays: preview.requestedDays,
    preview,
    previewStatus: 'succeeded',
    ...overrides,
  })
}

const rowsOf = (receipt: ReturnType<typeof buildRequestReceipt>, year: number) =>
  receipt.kind === 'receipt'
    ? (receipt.sections.find((section) => section.year === year)?.rows ?? [])
    : []

const valueOf = (
  receipt: ReturnType<typeof buildRequestReceipt>,
  year: number,
  key: string,
) => rowsOf(receipt, year).find((row) => row.key === key)?.value

describe('buildRequestReceipt', () => {
  it('names the days existing holds have already borrowed, in fine print', () => {
    const receipt = build(previewOf())

    expect(receipt.kind).toBe('receipt')
    if (receipt.kind !== 'receipt') return
    expect(receipt.sections).toHaveLength(1)
    // One year touched, so the heading does not name it: the calendar beside
    // this card already does.
    expect(receipt.sections[0]?.heading).toBe('Pays for 7d of 8d')
    expect(valueOf(receipt, 2026, 'available')).toBe('0d')
    // The chip figure and the receipt row are the same net number.
    expect(valueOf(receipt, 2026, 'arriving')).toBe('+7d')
    expect(valueOf(receipt, 2026, 'pool')).toBe('7d')
    expect(valueOf(receipt, 2026, 'unpaid')).toBe('1d')
    expect(rowsOf(receipt, 2026).find((row) => row.key === 'available')?.finePrint).toBe(
      'Leave already booked has borrowed 3d 3h from accrual still to come.',
    )
    // The arriving row answers the borrowed note: the gross figure, and the
    // part of it that goes to repaying the days already taken.
    expect(
      rowsOf(receipt, 2026).find((row) => row.key === 'arriving')?.finePrint,
    ).toContain('of it repays days already borrowed')
    expect(receipt.verdict).toEqual({
      tone: 'partial',
      label: '1d of 8d unpaid',
    })
  })

  it('bridges two years by spending the carryover in one and receiving it in the next', () => {
    const receipt = build(
      previewOf({
        startDate: '2026-12-28',
        endDate: '2027-01-05',
        requestedDays: 6,
        paidDays: 6,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({ requestedDays: 4, paidDays: 4, carryoverOutDays: 1 }),
          projectedYear({
            year: 2027,
            carriedOverDays: 1,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 3.08,
            projectedYearEndAccrual: 26,
            requestedDays: 2,
            paidDays: 2,
            carryoverOutDays: 12,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.sections.map((section) => section.year)).toEqual([2026, 2027])
    // The split is stated by the headings themselves, once each.
    expect(receipt.sections.map((section) => section.heading)).toEqual([
      '2026 · pays for 4d',
      '2027 · pays for 2d',
    ])
    // The same day leaves one section and arrives in the next: that pairing is
    // the whole point of splitting the receipt by year.
    expect(valueOf(receipt, 2026, 'carry-out')).toBe('1d')
    expect(valueOf(receipt, 2027, 'carried-in')).toBe('+1d')
    expect(valueOf(receipt, 2026, 'leftover')).toBe('3d')
    expect(valueOf(receipt, 2026, 'expires')).toBe('2d')
    // Next January brings 2.08 of its own; the carried day is NOT counted again
    // inside it. Floor to complete hours: 2.08d is +2d, 3.08d pool is 3d.
    expect(valueOf(receipt, 2027, 'arriving')).toBe('+2d')
    expect(valueOf(receipt, 2027, 'pool')).toBe('3d')
    expect(valueOf(receipt, 2027, 'free-after')).toBe('1d')
    expect(
      rowsOf(receipt, 2027).find((row) => row.key === 'arriving')?.title,
    ).toContain('build up month by month')
    expect(receipt.verdict).toEqual({ tone: 'paid', label: 'Fully paid' })
  })

  it('keeps this year as a section when it only funds the carryover', () => {
    const receipt = build(
      previewOf({
        startDate: '2027-01-11',
        endDate: '2027-01-22',
        requestedDays: 10,
        paidDays: 10,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({ committedDays: 2, carryoverOutDays: 10 }),
          projectedYear({
            year: 2027,
            carriedOverDays: 10,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 12.08,
            projectedYearEndAccrual: 35,
            requestedDays: 10,
            paidDays: 10,
            carryoverOutDays: 12,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.sections[0]?.heading).toBe('2026 · funds the carryover')
    // Nothing is charged here, so there is no "this request takes" row and the
    // section's only sum is what the year ends free with.
    expect(valueOf(receipt, 2026, 'takes')).toBeUndefined()
    expect(rowsOf(receipt, 2026).find((row) => row.key === 'pool')?.label).toBe(
      'Free at year end',
    )
    expect(valueOf(receipt, 2026, 'carry-out')).toBe('10d')
    expect(receipt.sections[1]?.heading).toBe('2027 · pays for 10d')
  })

  it('says a year has nothing to give rather than staying silent', () => {
    const receipt = build(
      previewOf({
        startDate: '2027-01-11',
        endDate: '2027-01-22',
        requestedDays: 10,
        paidDays: 2,
        unpaidDays: 8,
        unpaidDates: [],
        years: [
          projectedYear({ spentDays: 10, committedDays: 15 }),
          projectedYear({
            year: 2027,
            carriedOverDays: 0,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 2.08,
            projectedYearEndAccrual: 25,
            requestedDays: 10,
            paidDays: 2,
            unpaidDays: 8,
            carryoverOutDays: 11,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.sections[0]?.heading).toBe('2026 · nothing to give')
    // The zero rows are rendered, muted: they are the explanation for the
    // unpaid days below, not noise to hide.
    expect(valueOf(receipt, 2026, 'arriving')).toBe('+0d')
    expect(valueOf(receipt, 2026, 'carry-out')).toBe('0d')
    expect(valueOf(receipt, 2027, 'carried-in')).toBe('+0d')
    // The leftover 0.08 cannot be booked, so the row floors to 0d. The exact
    // figure is on hover, not in the headline.
    expect(valueOf(receipt, 2027, 'free-after')).toBe('0d')
    expect(receipt.verdict).toEqual({ tone: 'partial', label: '8d of 10d unpaid' })
  })

  it('says nothing about accrual when none is due before the leave', () => {
    // Booking inside the month whose tranche already posted: the whole year is
    // accrued as far as this leave reaches, and nothing is committed ahead of
    // it. "+0d arriving" over a sum that restates the line above it is three
    // rows to say one number, so neither is drawn.
    const receipt = build(
      previewOf({
        startDate: '2026-08-13',
        endDate: '2026-08-13',
        requestedDays: 0.25,
        paidDays: 0.25,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({
            accruedDays: 16.67,
            spentDays: 0,
            committedDays: 0.25,
            projectedAccruedByLeave: 16.67,
            requestedDays: 0.25,
            paidDays: 0.25,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    const keys = rowsOf(receipt, 2026).map((row) => row.key)
    expect(keys).not.toContain('arriving')
    expect(keys).not.toContain('pool')
    // What is left of the ledger still reads as a subtraction, in hours.
    expect(valueOf(receipt, 2026, 'available')).toBe('16d 3h')
    expect(valueOf(receipt, 2026, 'takes')).toBe('-2h')
    expect(valueOf(receipt, 2026, 'free-after')).toBe('16d 1h')
    expect(receipt.verdict).toEqual({ tone: 'paid', label: 'Fully paid' })
  })

  it('turns red only when the balance pays for nothing at all', () => {
    const receipt = build(
      previewOf({
        requestedDays: 10,
        paidDays: 0,
        unpaidDays: 10,
        years: [
          projectedYear({ requestedDays: 10, paidDays: 0, unpaidDays: 10 }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.verdict).toEqual({ tone: 'unpaid', label: 'All 10d unpaid' })
    expect(receipt.sections[0]?.heading).toBe('Pays for none of 10d')
  })

  it('holds its place before the first answer and keeps the last one while the next loads', () => {
    expect(
      buildRequestReceipt({
        leaveType: LeaveType.Vacation,
        startDate: '2026-12-21',
        endDate: '2026-12-31',
        chargeableDays: 8,
        previewStatus: 'loading',
      }).kind,
    ).toBe('pending')
    expect(
      buildRequestReceipt({
        leaveType: LeaveType.Vacation,
        startDate: '2026-12-21',
        endDate: '2026-12-31',
        chargeableDays: 8,
        previewStatus: 'failed',
      }).kind,
    ).toBe('unavailable')

    // A verdict for other dates keeps its rows on screen, dimmed, but must not
    // keep claiming those dates are fully paid.
    const stale = build(previewOf(), { endDate: '2027-01-09' })
    if (stale.kind !== 'receipt') throw new Error('expected a receipt')
    expect(stale.stale).toBe(true)
    expect(stale.verdict).toEqual({
      tone: 'checking',
      label: 'Checking these dates',
    })
    // The rows still describe the dates the server answered for, so the block
    // stays self-consistent while it waits for the new verdict.
    expect(stale.sections[0]?.heading).toBe('Pays for 7d of 8d')
  })

  it('goes stale when a stepper reprices the very same dates', () => {
    // Part-day booking makes the period an incomplete identity: the server
    // priced eight days, the form now costs seven and a half, and the receipt
    // must dim rather than keep publishing a split for a shape nobody holds.
    const repriced = build(previewOf(), { costDays: 7.5 })
    if (repriced.kind !== 'receipt') throw new Error('expected a receipt')
    expect(repriced.stale).toBe(true)
    expect(repriced.verdict.tone).toBe('checking')

    // The verdict for the shape actually on the form is not stale.
    const matching = build(previewOf(), { costDays: 8 })
    expect(matching.kind === 'receipt' && matching.stale).toBe(false)
    // A composer that books whole days only passes no cost and is judged on
    // its period alone, exactly as before.
    const wholeDays = build(previewOf())
    expect(wholeDays.kind === 'receipt' && wholeDays.stale).toBe(false)
  })

  it('keeps the states that spend nothing as plain sentences', () => {
    const empty = buildRequestReceipt({
      leaveType: LeaveType.Vacation,
      startDate: '',
      endDate: '',
      chargeableDays: 0,
      previewStatus: 'idle',
    })
    expect(empty).toEqual({
      kind: 'empty',
      message:
        'Nothing selected yet. Weekends and public holidays inside the range are free; they never spend balance.',
    })

    const zero = buildRequestReceipt({
      leaveType: LeaveType.Vacation,
      startDate: '2026-08-08',
      endDate: '2026-08-09',
      chargeableDays: 0,
      previewStatus: 'succeeded',
    })
    expect(zero.kind).toBe('zero-cost')
  })

  it('credits the leave being changed once, in fine print, never as a row', () => {
    // The preview was fetched with excludeRequestId, so every figure is already
    // net of the give-back: a row for it would count those days twice.
    const receipt = build(previewOf(), { replacedDays: 5 })

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(rowsOf(receipt, 2026).map((row) => row.key)).not.toContain('replaced')
    expect(
      rowsOf(receipt, 2026).find((row) => row.key === 'available')?.finePrint,
    ).toContain('Already counts the 5d the leave you are changing hands back.')
    expect(valueOf(receipt, 2026, 'pool')).toBe('7d')
  })

  it('names the year only when more than one of them pays', () => {
    // A single-year request reads in the context the calendar already gives.
    expect(
      build(previewOf()).kind === 'receipt'
        ? (build(previewOf()) as { sections: { heading: string }[] }).sections[0]
            ?.heading
        : '',
    ).not.toContain('2026')

    // The moment two years share the bill, saying which is the whole point.
    const crossing = build(
      previewOf({
        startDate: '2026-12-28',
        endDate: '2027-01-05',
        requestedDays: 6,
        paidDays: 6,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({ requestedDays: 4, paidDays: 4, carryoverOutDays: 1 }),
          projectedYear({
            year: 2027,
            carriedOverDays: 1,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 3.08,
            projectedYearEndAccrual: 26,
            requestedDays: 2,
            paidDays: 2,
            carryoverOutDays: 12,
          }),
        ],
      }),
    )
    if (crossing.kind !== 'receipt') throw new Error('expected a receipt')
    expect(crossing.sections.map((section) => section.heading)).toEqual([
      '2026 · pays for 4d',
      '2027 · pays for 2d',
    ])
  })

  it('gives every year its own section, however many the range touches', () => {
    const receipt = build(
      previewOf({
        years: [
          projectedYear({ requestedDays: 2, paidDays: 2 }),
          projectedYear({ year: 2027, requestedDays: 3, paidDays: 3 }),
          projectedYear({ year: 2028, requestedDays: 3, paidDays: 3 }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    // The old prose degraded to a plain card whenever the range was not exactly
    // two adjacent years; the receipt simply lists what the server projected.
    expect(receipt.sections.map((section) => section.year)).toEqual([
      2026, 2027, 2028,
    ])
    expect(receipt.sections[2]?.heading).toBe('2028 · pays for 3d')
  })

  it('floors accrual headlines and keeps the exact figure on the row for hover (LRS-53)', () => {
    // 17.083d is 16 complete hours past 17d, so the headline is 17d; 2.292d
    // is 2d 2h; the pool 19.375d is already on the hour grid as 19d 3h.
    const receipt = build(
      previewOf({
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        requestedDays: 2,
        paidDays: 2,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({
            accruedDays: 17.083,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 19.375,
            requestedDays: 2,
            paidDays: 2,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(valueOf(receipt, 2026, 'available')).toBe('17d')
    expect(valueOf(receipt, 2026, 'arriving')).toBe('+2d 2h')
    expect(valueOf(receipt, 2026, 'pool')).toBe('19d 3h')
    expect(rowsOf(receipt, 2026).find((row) => row.key === 'available')?.rawDays).toBe(
      17.083,
    )
  })

  it('shows next year when leftover is reserved to fund booked carryover (LRS-53)', () => {
    // 15d year, 4d already held for late December, 11d looking free. A 2-day
    // request in early December is paid for 1d: the other 10 must remain so
    // 5d can carry into January's already-approved leave.
    const receipt = build(
      previewOf({
        startDate: '2026-12-03',
        endDate: '2026-12-04',
        requestedDays: 2,
        paidDays: 1,
        unpaidDays: 1,
        unpaidDates: ['2026-12-04'],
        years: [
          projectedYear({
            totalDays: 15,
            accruedDays: 15,
            spentDays: 0,
            committedDays: 4,
            projectedAccruedByLeave: 15,
            projectedYearEndAccrual: 15,
            requestedDays: 2,
            paidDays: 1,
            unpaidDays: 1,
            carryoverOutDays: 5,
          }),
          projectedYear({
            year: 2027,
            carriedOverDays: 5,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 5,
            projectedAccruedByLeave: 7,
            projectedYearEndAccrual: 20,
            requestedDays: 0,
            paidDays: 0,
            carryoverOutDays: 10,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.sections.map((section) => section.year)).toEqual([2026, 2027])
    expect(receipt.sections[0]?.heading).toBe('2026 · pays for 1d of 2d')
    expect(receipt.sections[1]?.heading).toBe('2027 · already booked')
    expect(valueOf(receipt, 2026, 'available')).toBe('11d')
    expect(valueOf(receipt, 2026, 'takes')).toBe('-2d')
    expect(valueOf(receipt, 2026, 'unpaid')).toBe('1d')
    expect(valueOf(receipt, 2026, 'leftover')).toBe('10d')
    expect(valueOf(receipt, 2026, 'carry-out')).toBe('5d')
    expect(valueOf(receipt, 2026, 'free-after')).toBeUndefined()
    expect(
      rowsOf(receipt, 2026).find((row) => row.key === 'leftover')?.finePrint,
    ).toContain('Not free to book later this year')
    expect(
      rowsOf(receipt, 2026).find((row) => row.key === 'carry-out')?.finePrint,
    ).toContain('Needed to fund leave already booked in 2027')
    expect(valueOf(receipt, 2027, 'carried-in')).toBe('+5d')
    expect(rowsOf(receipt, 2027).find((row) => row.key === 'arriving')?.label).toBe(
      'Still to accrue in 2027',
    )
  })

  it('explains 2027 remaining accrual as allowance minus already-booked days', () => {
    // Dec 23 2026, one paid day. 2027 already holds 6d; its 15d allowance plus
    // 5d carried is 20d. The +9d is not "by 23 Dec 2026": 15d still accrues in
    // 2027, 6d of it is already borrowed, 9d remains (5 + 15 - 6 = 14 free).
    const receipt = build(
      previewOf({
        startDate: '2026-12-23',
        endDate: '2026-12-23',
        requestedDays: 1,
        paidDays: 1,
        unpaidDays: 0,
        unpaidDates: [],
        years: [
          projectedYear({
            totalDays: 15,
            accruedDays: 15,
            spentDays: 0,
            committedDays: 4,
            projectedAccruedByLeave: 15,
            projectedYearEndAccrual: 15,
            requestedDays: 1,
            paidDays: 1,
            unpaidDays: 0,
            carryoverOutDays: 5,
          }),
          projectedYear({
            year: 2027,
            totalDays: 15,
            carriedOverDays: 5,
            carryoverProjected: true,
            accruedDays: 0,
            spentDays: 0,
            committedDays: 6,
            projectedAccruedByLeave: 20,
            projectedYearEndAccrual: 20,
            requestedDays: 0,
            paidDays: 0,
            unpaidDays: 0,
            carryoverOutDays: 10,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(receipt.sections[1]?.heading).toBe('2027 · already booked')
    expect(valueOf(receipt, 2027, 'carried-in')).toBe('+5d')
    expect(valueOf(receipt, 2027, 'arriving')).toBe('+9d')
    expect(rowsOf(receipt, 2027).find((row) => row.key === 'arriving')?.label).toBe(
      'Still to accrue in 2027',
    )
    expect(
      rowsOf(receipt, 2027).find((row) => row.key === 'arriving')?.finePrint,
    ).toBe('15d will accrue; 6d of it repays days already borrowed.')
    expect(
      rowsOf(receipt, 2027).find((row) => row.key === 'arriving')?.title,
    ).toContain('9d is what remains after those bookings')
    expect(valueOf(receipt, 2027, 'pool')).toBe('14d')
  })

  it('explains that a working day is paid in full or unpaid in full (LRS-53)', () => {
    const receipt = build(
      previewOf({
        startDate: '2026-12-01',
        endDate: '2026-12-14',
        requestedDays: 8.875,
        paidDays: 8.75,
        unpaidDays: 0.125,
        unpaidDates: ['2026-12-14'],
        years: [
          projectedYear({
            accruedDays: 8.75,
            spentDays: 0,
            committedDays: 0,
            projectedAccruedByLeave: 8.75,
            requestedDays: 8.875,
            paidDays: 8.75,
            unpaidDays: 0.125,
          }),
        ],
      }),
    )

    if (receipt.kind !== 'receipt') throw new Error('expected a receipt')
    expect(valueOf(receipt, 2026, 'unpaid')).toBe('1h')
    expect(
      rowsOf(receipt, 2026).find((row) => row.key === 'unpaid')?.finePrint,
    ).toContain('paid in full or unpaid in full')
  })
})
