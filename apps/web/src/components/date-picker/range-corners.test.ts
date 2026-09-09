/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { roundedCorners, type Corner } from './range-corners'

// Compact reader: which corners round, as a sorted string like "bl,br".
function corners(iso: string, start: string, end: string): string {
  const result = roundedCorners(iso, start, end)
  return (['tl', 'tr', 'bl', 'br'] as Corner[]).filter((c) => result[c]).join(',')
}

describe('roundedCorners', () => {
  it('rounds every corner of a lone single day', () => {
    expect(corners('2026-07-15', '2026-07-15', '2026-07-15')).toBe('tl,tr,bl,br')
  })

  it('rounds nothing for a day outside the range', () => {
    expect(corners('2026-07-20', '2026-07-08', '2026-07-17')).toBe('')
  })

  describe('a range spanning both months: 2026-07-08 to 2026-08-31', () => {
    const start = '2026-07-08'
    const end = '2026-08-31'

    it('rounds the top-left at the start day', () => {
      // Wed 8: left and top exposed, bottom continues down.
      expect(corners('2026-07-08', start, end)).toBe('tl')
    })

    it('rounds the top corner of a grid right edge (Sun 12) and nothing mid-edge (Sun 19)', () => {
      expect(corners('2026-07-12', start, end)).toBe('tr')
      expect(corners('2026-07-19', start, end)).toBe('')
    })

    it('rounds the top corner of a grid left edge (Mon 13) and the bottom (Mon 27)', () => {
      expect(corners('2026-07-13', start, end)).toBe('tl')
      expect(corners('2026-07-27', start, end)).toBe('bl')
    })

    it('caps each month at the boundary (Jul 31 bottom-right, Aug 1 top-left)', () => {
      // Each month is its own block: Jul 31 rounds where it meets its trailing
      // edge, Aug 1 where it meets its leading edge.
      expect(corners('2026-07-31', start, end)).toBe('br')
      expect(corners('2026-08-01', start, end)).toBe('tl')
    })

    it('rounds the leading corner of the next month (Mon 3 top-left, Sun 2 top-right)', () => {
      expect(corners('2026-08-03', start, end)).toBe('tl')
      expect(corners('2026-08-02', start, end)).toBe('tr')
    })

    it('rounds the bottom corner of a grid right edge (Sun 30)', () => {
      expect(corners('2026-08-30', start, end)).toBe('br')
    })

    it('rounds only the bottom of a lone end day that connects upward (Mon 31)', () => {
      // Aug 31 sits below Aug 24 (in range, same month), so its top is flat and
      // it caps the range on the bottom.
      expect(corners('2026-08-31', start, end)).toBe('bl,br')
    })
  })

  describe('a single-week range keeps square wraps', () => {
    it('rounds only the true ends of a Mon-Fri range', () => {
      // Mon 13 -> Fri 17, all one row: left of Mon, right of Fri, both fully.
      expect(corners('2026-07-13', '2026-07-13', '2026-07-17')).toBe('tl,bl')
      expect(corners('2026-07-17', '2026-07-13', '2026-07-17')).toBe('tr,br')
      expect(corners('2026-07-15', '2026-07-13', '2026-07-17')).toBe('')
    })
  })
})
