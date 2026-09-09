/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { isoToLocalDate, localDateToIso } from './calendar-dates'

// The single picker has no branching logic worth rendering (the calendar is a
// portal, empty under SSR). Its only load-bearing behaviour is the value<->Date
// mapping it hands to react-day-picker, which is the shared helper pair. This
// pins the exact conversions the component relies on.
describe('DateField value <-> Date mapping', () => {
  it('maps an ISO value to the local Date the calendar selects, and back', () => {
    const iso = '2026-08-12'
    const selected = isoToLocalDate(iso)
    expect(selected.getFullYear()).toBe(2026)
    expect(selected.getMonth()).toBe(7)
    expect(selected.getDate()).toBe(12)
    // What onSelect writes back for that same day is byte-identical.
    expect(localDateToIso(selected)).toBe(iso)
  })

  it('round-trips without shifting a day, regardless of ISO', () => {
    for (const iso of ['2026-01-01', '2026-12-31', '2027-02-28', '2024-02-29']) {
      expect(localDateToIso(isoToLocalDate(iso))).toBe(iso)
    }
  })
})
