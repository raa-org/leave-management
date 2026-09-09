/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  floorToHourGrid,
  formatDayAmount,
  hoursToDayPortion,
  isOnHourGrid,
  portionAt,
  portionMap,
  sumPortions,
} from './day-math'

describe('formatDayAmount', () => {
  it('renders an amount as days and hours against the workday', () => {
    expect(formatDayAmount(2.5, 8)).toBe('2d 4h')
    expect(formatDayAmount(12.25, 8)).toBe('12d 2h')
  })

  it('drops the leading days under one day and the trailing hours on a whole one', () => {
    expect(formatDayAmount(0.625, 8)).toBe('5h')
    expect(formatDayAmount(0.125, 8)).toBe('1h')
    expect(formatDayAmount(3, 8)).toBe('3d')
    expect(formatDayAmount(1, 8)).toBe('1d')
  })

  it('renders nothing as "0d" rather than as an empty string', () => {
    expect(formatDayAmount(0, 8)).toBe('0d')
    // A balance with less than an hour left has nothing bookable in it.
    expect(formatDayAmount(0.08, 8)).toBe('0d')
  })

  it('floors an off-grid balance to the hours it can actually fund', () => {
    // The remainder accrual leaves behind (25/12 a month) is not bookable, and
    // the standing rule is that nobody is shown more than they can take.
    expect(formatDayAmount(12.333, 8)).toBe('12d 2h')
    expect(formatDayAmount(16.667, 8)).toBe('16d 5h')
  })

  it('reads against the org own workday, not a fixed eight hours', () => {
    // Half a six-hour day is three hours, not four.
    expect(formatDayAmount(2.5, 6)).toBe('2d 3h')
    // An hour of a seven-hour day is stored as 0.143, a shade over a seventh,
    // and must still read as exactly one hour.
    expect(formatDayAmount(hoursToDayPortion(1, 7), 7)).toBe('1h')
    expect(formatDayAmount(hoursToDayPortion(22, 7), 7)).toBe('3d 1h')
  })

  it('carries the sign on the magnitude, so a removal reads like its addition', () => {
    expect(formatDayAmount(-2.5, 8)).toBe('-2d 4h')
    expect(formatDayAmount(-0.125, 8)).toBe('-1h')
  })

  it('renders a figure that is not a number as nothing', () => {
    expect(formatDayAmount(Number.NaN, 8)).toBe('0d')
  })
})

describe('portionAt', () => {
  it('reads an empty portions array as full days', () => {
    // Every request filed before leave could be booked by the hour carries an
    // empty array, and each of its dates is a whole day.
    expect(portionAt([], 0)).toBe(1)
    expect(portionAt([], 7)).toBe(1)
  })

  it('reads a portion by its position in the frozen day list', () => {
    expect(portionAt([1, 0.5, 0.125], 1)).toBe(0.5)
    expect(portionAt([1, 0.5, 0.125], 2)).toBe(0.125)
  })

  it('reads a position past the end as a full day', () => {
    // A short array is a row written by something that did not know about
    // portions; the dates it does not cover are ordinary whole days.
    expect(portionAt([0.5], 3)).toBe(1)
  })
})

describe('portionMap', () => {
  it('keys the portions by date so a subset can still be priced', () => {
    const portions = portionMap(['2026-03-02', '2026-03-03'], [1, 0.5])
    expect(portions.get('2026-03-02')).toBe(1)
    expect(portions.get('2026-03-03')).toBe(0.5)
  })

  it('prices every date as a full day when no portions were frozen', () => {
    const portions = portionMap(['2026-03-02', '2026-03-03'], [])
    expect([...portions.values()]).toEqual([1, 1])
  })
})

describe('sumPortions', () => {
  it('costs a subset of the dates, not their number', () => {
    const portions = portionMap(
      ['2026-03-02', '2026-03-03', '2026-03-04'],
      [1, 0.5, 0.25],
    )
    expect(sumPortions(['2026-03-03', '2026-03-04'], portions)).toBe(0.75)
  })

  it('sums whole days to the count they used to be', () => {
    const days = ['2026-03-02', '2026-03-03', '2026-03-04']
    expect(sumPortions(days, portionMap(days, []))).toBe(3)
  })

  it('quantizes once, at the end', () => {
    // Three hours of an eight-hour day is 0.375; eight of them are a whole 3
    // days rather than the 2.999... a floating sum would leave behind.
    const days = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const portions = new Map(days.map((day) => [day, 0.375]))
    expect(sumPortions(days, portions)).toBe(3)
  })

  it('prices a date the map does not know as a full day', () => {
    expect(sumPortions(['2026-03-05'], new Map())).toBe(1)
  })
})

describe('isOnHourGrid', () => {
  it('accepts what whole hours of an eight-hour day become, and nothing between', () => {
    expect(isOnHourGrid(0.125, 8)).toBe(true)
    expect(isOnHourGrid(2.5, 8)).toBe(true)
    expect(isOnHourGrid(0.1, 8)).toBe(false)
    // The remainder accrual leaves behind is not a figure anyone can book.
    expect(isOnHourGrid(12.333, 8)).toBe(false)
  })

  it('accepts an hour of a workday whose hour does not fit three decimals', () => {
    // 0.143 reads back as 1.001 hours, yet it is exactly what one hour of a
    // seven-hour day is stored as, so a grid that rejected it would refuse the
    // figures the booking path itself mints.
    expect(hoursToDayPortion(1, 7)).toBe(0.143)
    expect(isOnHourGrid(0.143, 7)).toBe(true)
    expect(isOnHourGrid(0.15, 7)).toBe(false)
  })
})

describe('the hour grid under negation and flooring', () => {
  it('makes removing an hour the exact negative of adding one', () => {
    // A sixteen-hour day puts one hour on a tie (0.0625), and roundDays breaks
    // ties upward, so quantizing the signed value would accept +0.063 but only
    // -0.062: adding an hour and taking it back would leave a thousandth of a
    // day on the books, and no reversal could ever clear it.
    for (const hoursPerDay of [7, 8, 16, 24]) {
      for (const hours of [1, 3, 5]) {
        const added = hoursToDayPortion(hours, hoursPerDay)
        expect(hoursToDayPortion(-hours, hoursPerDay)).toBe(-added)
        expect(isOnHourGrid(-added, hoursPerDay)).toBe(true)
      }
    }
  })

  it('floors to the hours a balance actually holds, not one fewer', () => {
    expect(floorToHourGrid(12.333, 8)).toBe(12.25)
    expect(floorToHourGrid(12.375, 8)).toBe(12.375)
    // Where an hour does not fit three decimals the stored figure is a shade
    // under its exact share, so dividing and flooring separately would hand
    // back one hour fewer than the employee holds.
    for (const hoursPerDay of [7, 9, 11, 16]) {
      for (const hours of [1, 5, 23]) {
        const held = hoursToDayPortion(hours, hoursPerDay)
        expect(floorToHourGrid(held, hoursPerDay)).toBe(held)
      }
    }
  })
})
