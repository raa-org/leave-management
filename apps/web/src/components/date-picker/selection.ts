/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

export type DateRangeValue = {
  startDate: string
  endDate: string
}

export type DateRangeSelection = DateRangeValue & {
  /**
   * The first click of a selection still open to extension, or null once the
   * selection is settled. This is what makes "one day" and "a period" both
   * reachable: a settled selection restarts on the next click instead of
   * stretching to it.
   *
   * `anchor === null` IS "settled" — there is no separate done flag, because
   * the calendar no longer closes itself. The user confirms explicitly.
   */
  anchor: string | null
}

export const emptySelection: DateRangeSelection = {
  startDate: '',
  endDate: '',
  anchor: null,
}

/**
 * The selection policy for the range calendar, as a pure function of the
 * previous selection and the clicked date.
 *
 * react-day-picker's own range handling cannot express both of our cases.
 * Without `resetOnSelect` a click on a settled range STRETCHES it — pick
 * 12-15 Aug, then click 5 Sep and you get 12 Aug - 5 Sep. With `resetOnSelect`
 * a single day needs two clicks on the same date, which nobody discovers, and
 * clicking the day of a settled one-day range wipes it with no undo. So we
 * ignore the range the library computes and derive the next selection from the
 * clicked date ourselves — the calendar is fully controlled anyway.
 *
 * The rules:
 *  - nothing pending: the click selects that one day, immediately valid and
 *    submittable, and opens the selection to extension;
 *  - clicking the selected single day again (whether still open or settled):
 *    TOGGLES it off — the selection empties;
 *  - clicking any other day while an anchor is open: makes the period, ends
 *    sorted so dragging backwards works, and settles;
 *  - clicking a day of a settled PERIOD (endpoints included): restarts a new
 *    single-day selection there — never a toggle, so a period cannot vanish
 *    from a single click.
 *
 * Toggling a single day off IS a calendar gesture (user request); wiping a
 * multi-day range still is not — that stays on the caller's explicit Clear
 * control, so a settled range never disappears from one misclick.
 */
export function nextSelection(
  current: DateRangeSelection,
  clickedIso: string,
): DateRangeSelection {
  if (current.anchor === null) {
    if (
      current.startDate !== '' &&
      current.startDate === clickedIso &&
      current.endDate === clickedIso
    ) {
      return emptySelection
    }
    return { startDate: clickedIso, endDate: clickedIso, anchor: clickedIso }
  }

  if (clickedIso === current.anchor) {
    return emptySelection
  }

  const [from, to] =
    clickedIso < current.anchor
      ? [clickedIso, current.anchor]
      : [current.anchor, clickedIso]

  return { startDate: from, endDate: to, anchor: null }
}
