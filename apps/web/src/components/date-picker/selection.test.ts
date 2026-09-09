/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { emptySelection, nextSelection, type DateRangeSelection } from './selection'

// The calendar itself cannot be rendered here (node environment, no jsdom, and
// the popover contents never reach the SSR string), so the selection policy
// lives in a pure function precisely so it CAN be covered.
function clickThrough(clicks: string[], from: DateRangeSelection = emptySelection) {
  let state = from
  for (const clicked of clicks) {
    state = nextSelection(state, clicked)
  }
  return state
}

describe('nextSelection', () => {
  it('selects a single day on the first click and leaves it open to extension', () => {
    expect(clickThrough(['2026-08-12'])).toEqual({
      startDate: '2026-08-12',
      endDate: '2026-08-12',
      anchor: '2026-08-12',
    })
  })

  it('toggles the single day off when the same date is clicked again', () => {
    expect(clickThrough(['2026-08-12', '2026-08-12'])).toEqual(emptySelection)
  })

  it('toggles off a SETTLED single day too (seeded from a committed value)', () => {
    // The popover seeds its draft from the committed value with a null anchor;
    // clicking that very day must unselect, not restart.
    expect(
      clickThrough(['2026-08-12'], {
        startDate: '2026-08-12',
        endDate: '2026-08-12',
        anchor: null,
      }),
    ).toEqual(emptySelection)
  })

  it('starts fresh after a toggle-off', () => {
    expect(clickThrough(['2026-08-12', '2026-08-12', '2026-09-05'])).toEqual({
      startDate: '2026-09-05',
      endDate: '2026-09-05',
      anchor: '2026-09-05',
    })
  })

  it('never toggles a settled PERIOD: clicking an endpoint restarts there', () => {
    // A multi-day range must not vanish from one click; only the explicit
    // Clear control wipes it.
    expect(clickThrough(['2026-08-12', '2026-08-15', '2026-08-12'])).toEqual({
      startDate: '2026-08-12',
      endDate: '2026-08-12',
      anchor: '2026-08-12',
    })
  })

  it('extends to a period on the second click', () => {
    expect(clickThrough(['2026-08-12', '2026-08-15'])).toEqual({
      startDate: '2026-08-12',
      endDate: '2026-08-15',
      anchor: null,
    })
  })

  it('sorts the ends when the period is picked backwards', () => {
    expect(clickThrough(['2026-08-15', '2026-08-12'])).toEqual({
      startDate: '2026-08-12',
      endDate: '2026-08-15',
      anchor: null,
    })
  })

  it('restarts instead of stretching when a settled period is clicked past', () => {
    // The whole reason this policy exists: the library would have produced
    // 2026-08-12..2026-09-05 here.
    expect(clickThrough(['2026-08-12', '2026-08-15', '2026-09-05'])).toEqual({
      startDate: '2026-09-05',
      endDate: '2026-09-05',
      anchor: '2026-09-05',
    })
  })

  it('builds a fresh period after restarting', () => {
    expect(
      clickThrough(['2026-08-12', '2026-08-15', '2026-09-05', '2026-09-07']),
    ).toEqual({
      startDate: '2026-09-05',
      endDate: '2026-09-07',
      anchor: null,
    })
  })

  it('spans a year boundary', () => {
    expect(clickThrough(['2026-12-28', '2027-01-04'])).toEqual({
      startDate: '2026-12-28',
      endDate: '2027-01-04',
      anchor: null,
    })
  })

  it('never leaves the range inverted or half-filled, whatever the sequence', () => {
    const dates = ['2026-08-12', '2026-08-15', '2026-09-05', '2026-12-28', '2027-01-04']
    let state: DateRangeSelection = emptySelection

    for (const first of dates) {
      for (const second of dates) {
        for (const third of dates) {
          state = emptySelection
          for (const clicked of [first, second, third]) {
            state = nextSelection(state, clicked)
            // Either cleanly empty (a toggle-off) or fully populated and
            // never inverted - a half-filled or backwards range is
            // unrepresentable whatever the click sequence.
            if (state.startDate === '') {
              expect(state).toEqual(emptySelection)
            } else {
              expect(state.endDate).not.toBe('')
              expect(state.endDate >= state.startDate).toBe(true)
            }
          }
        }
      }
    }
  })
})
