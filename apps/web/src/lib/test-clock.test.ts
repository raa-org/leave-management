/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  browserTimezone,
  timezoneOptions,
  wallPartsIn,
  wallTimeIn,
  wallTimeProblem,
  zonedWallTimeToUtc,
} from './test-clock'

describe('zonedWallTimeToUtc', () => {
  it('reads the wall time in the chosen zone, not in UTC', () => {
    // The whole point of the control: midnight in Kyiv is 21:00 the previous
    // day in UTC during summer, which is exactly the boundary an admin aims at
    // when checking whether 5 August gets spent.
    expect(zonedWallTimeToUtc('2026-08-06', '00:00', 'Europe/Kyiv')).toBe(
      '2026-08-05T21:00:00.000Z',
    )
  })

  it('is DST-correct across the same zone', () => {
    // Kyiv is +2 in winter, +3 in summer, so the same wall time is a different
    // instant depending on the date.
    expect(zonedWallTimeToUtc('2026-02-06', '00:00', 'Europe/Kyiv')).toBe(
      '2026-02-05T22:00:00.000Z',
    )
  })

  it('handles a zone behind UTC', () => {
    expect(
      zonedWallTimeToUtc('2026-08-06', '00:00', 'America/Los_Angeles'),
    ).toBe('2026-08-06T07:00:00.000Z')
  })

  it('passes UTC through unchanged', () => {
    expect(zonedWallTimeToUtc('2026-08-06', '13:45', 'UTC')).toBe(
      '2026-08-06T13:45:00.000Z',
    )
  })

  it('refuses input the picker has not filled in', () => {
    expect(zonedWallTimeToUtc('', '00:00', 'Europe/Kyiv')).toBeNull()
    expect(zonedWallTimeToUtc('2026-08-06', '', 'Europe/Kyiv')).toBeNull()
    expect(zonedWallTimeToUtc('06/08/2026', '00:00', 'Europe/Kyiv')).toBeNull()
  })

  it('refuses a zone the runtime does not know', () => {
    expect(zonedWallTimeToUtc('2026-08-06', '00:00', 'Not/AZone')).toBeNull()
  })
})

describe('wallPartsIn', () => {
  it('splits an instant into the fields as the chosen zone reads them', () => {
    // 21:00 UTC is already the next midnight in Kyiv, which is exactly the
    // boundary the panel exists to help an admin land on.
    expect(wallPartsIn('2026-08-05T21:00:00.000Z', 'Europe/Kyiv')).toEqual({
      date: '2026-08-06',
      time: '00:00',
    })
  })

  it('is the inverse of the converter, in every zone the picker offers', () => {
    // The seed and the read-back are the same conversion in two directions, so
    // a value the panel puts into the fields must survive being sent.
    for (const zone of timezoneOptions()) {
      const parts = wallPartsIn('2026-08-04T12:45:00.000Z', zone)
      expect(zonedWallTimeToUtc(parts.date, parts.time, zone)).toBe(
        '2026-08-04T12:45:00.000Z',
      )
    }
  })

  it('never yields the datetime-local shape a date input cannot display', () => {
    // The actual defect: the seed sliced the ISO instant, which produced
    // '2026-08-04T12:45' and made the panel accuse the timezone on first paint.
    const parts = wallPartsIn('2026-08-04T12:45:00.000Z', 'Europe/Kyiv')
    expect(parts.date).not.toContain('T')
    expect(wallTimeProblem(parts.date, parts.time, 'Europe/Kyiv')).toBeNull()
  })

  it('degrades to the raw instant rather than throwing on a bad zone', () => {
    expect(wallPartsIn('2026-08-04T12:45:00.000Z', 'Not/AZone')).toEqual({
      date: '2026-08-04',
      time: '12:45',
    })
  })
})

describe('wallTimeProblem', () => {
  it('is silent when the three inputs make an instant', () => {
    expect(wallTimeProblem('2026-08-06', '00:00', 'Europe/Kyiv')).toBeNull()
  })

  it('names the empty field rather than blaming the zone', () => {
    expect(wallTimeProblem('', '00:00', 'Europe/Kyiv')).toBe('Pick a date')
    expect(wallTimeProblem('2026-08-06', '', 'Europe/Kyiv')).toBe('Pick a time')
  })

  it('names a date the field cannot display, and says how to clear it', () => {
    // The exact shape a datetime-local value leaves behind when the input it
    // belonged to is replaced by a date input and the state survives a reload.
    const problem = wallTimeProblem('2026-08-04T00:00', '00:00', 'Europe/Kyiv')
    expect(problem).toContain('2026-08-04T00:00')
    expect(problem).toContain('Reload')
    // The zone is innocent here and must not be accused.
    expect(problem).not.toContain('timezone')
  })

  it('blames the zone only when the zone is actually the problem', () => {
    expect(wallTimeProblem('2026-08-06', '00:00', 'Not/AZone')).toBe(
      'Not/AZone is not a timezone this browser knows',
    )
  })
})

describe('timezoneOptions', () => {
  it('offers a real list and keeps the current selection in it', () => {
    const options = timezoneOptions(['Antarctica/Troll'])
    expect(options.length).toBeGreaterThan(5)
    expect(options).toContain('Antarctica/Troll')
    // Sorted and de-duplicated, so the picker never shows the same zone twice.
    expect([...new Set(options)]).toEqual(options)
    expect([...options].sort()).toEqual(options)
  })

  it('ignores an empty extra rather than offering a blank option', () => {
    expect(timezoneOptions([''])).not.toContain('')
  })
})

describe('wallTimeIn', () => {
  it('says what an instant reads as on the employee wall clock', () => {
    expect(wallTimeIn('2026-08-05T21:00:00.000Z', 'Europe/Kyiv')).toBe(
      '6 Aug 2026, 00:00',
    )
  })

  it('is a different reading from UTC, and says so by the numbers', () => {
    // The defect this replaces: the panel rendered both lines with a formatter
    // that uses the VIEWER's zone and then labelled one of them "UTC", so a
    // Kyiv admin saw the same clock twice and concluded UTC equalled Kyiv.
    const instant = '2026-08-04T12:54:00.000Z'
    expect(wallTimeIn(instant, 'UTC')).toBe('4 Aug 2026, 12:54')
    expect(wallTimeIn(instant, 'Europe/Kyiv')).toBe('4 Aug 2026, 15:54')
  })

  it('formats the same way whatever the host locale', () => {
    // Assembled from parts, so no ICU version can slip an "at" into the middle
    // of a line the admin is meant to compare with the one above it.
    expect(wallTimeIn('2026-01-09T05:07:00.000Z', 'UTC')).toBe(
      '9 Jan 2026, 05:07',
    )
  })

  it('shows the raw instant rather than passing UTC off as an unknown zone', () => {
    expect(wallTimeIn('2026-08-05T21:00:00.000Z', 'Not/AZone')).toBe(
      '2026-08-05T21:00:00.000Z',
    )
  })
})

describe('browserTimezone', () => {
  it('returns a zone the converter accepts', () => {
    // The two must agree, or the panel greys out Jump for the zone the browser
    // has just named as its own. That is exactly what happened with dayjs,
    // whose tz PARSING path rejected Europe/Kyiv while its conversion path and
    // Intl both accepted it.
    expect(
      zonedWallTimeToUtc('2026-08-06', '00:00', browserTimezone()),
    ).not.toBeNull()
  })

  it('agrees with every zone the picker offers', () => {
    for (const zone of timezoneOptions()) {
      expect(zonedWallTimeToUtc('2026-08-06', '00:00', zone)).not.toBeNull()
    }
  })
})
