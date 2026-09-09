/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { isoToLocalDate, localDateToIso } from './calendar-dates'

export type Corner = 'tl' | 'tr' | 'bl' | 'br'

const NO_CORNERS: Record<Corner, boolean> = { tl: false, tr: false, bl: false, br: false }

function shiftIso(iso: string, days: number): string {
  const date = isoToLocalDate(iso)
  date.setDate(date.getDate() + days)
  return localDateToIso(date)
}

/**
 * Which corners of a day cell to round so a multi-week range reads as one
 * rounded block.
 *
 * A corner rounds only when it is CONVEX on the block's outline: both the cell
 * beside it (left/right) and the cell above/below it are outside the range.
 * That rounds the true silhouette corners (the top and bottom of each grid
 * edge, and the range's own start/end) and leaves every interior edge straight,
 * so consecutive weeks flow together.
 *
 * The month grid, not the calendar, defines the neighbourhood: each month is
 * its own self-contained rounded block, so a neighbour in a DIFFERENT month
 * counts as exposed in every direction (the two grids sit apart on screen, so a
 * band flowing between them would only read as a seam). Within a month:
 *  - The Monday column is always a left edge and the Sunday column a right edge,
 *    even though the range continues onto the next row - a wrap should read as a
 *    rounded edge, not a seam.
 *  - The last day of the month rounds on its trailing side and the first day on
 *    its leading side, capping each month's block at the boundary (Jul 31 on the
 *    right, Aug 1 on the left).
 *
 * Pure and DOM-free so the whole silhouette is unit-testable without rendering.
 */
export function roundedCorners(
  iso: string,
  startIso: string,
  endIso: string,
): Record<Corner, boolean> {
  if (!startIso || !endIso || iso < startIso || iso > endIso) {
    return NO_CORNERS
  }

  const inRange = (value: string) => value >= startIso && value <= endIso
  const sameMonth = (value: string) => value.slice(0, 7) === iso.slice(0, 7)
  // Exposed when the neighbour is off the range, or in another month's grid.
  const off = (value: string) => !inRange(value) || !sameMonth(value)
  const weekday = isoToLocalDate(iso).getDay() // 0 = Sunday, 1 = Monday

  const leftExposed = weekday === 1 || off(shiftIso(iso, -1))
  const rightExposed = weekday === 0 || off(shiftIso(iso, 1))
  const aboveExposed = off(shiftIso(iso, -7))
  const belowExposed = off(shiftIso(iso, 7))

  return {
    tl: leftExposed && aboveExposed,
    tr: rightExposed && aboveExposed,
    bl: leftExposed && belowExposed,
    br: rightExposed && belowExposed,
  }
}

// The class names the corner modifiers map to, shared by every range calendar
// so the CalendarSurface `.dp-round-*` rules match all of them.
export const CORNER_CLASSNAMES = {
  dpRoundTl: 'dp-round-tl',
  dpRoundTr: 'dp-round-tr',
  dpRoundBl: 'dp-round-bl',
  dpRoundBr: 'dp-round-br',
}
