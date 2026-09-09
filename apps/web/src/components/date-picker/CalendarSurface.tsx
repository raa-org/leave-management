/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { labelDayButton, type Modifiers } from '@daypicker/react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha, styled } from '@mui/material/styles'
import { isWeekendIso } from '@workspace/contracts'
import { UNPAID_ACCENT } from '../../theme'
import { localDateToIso } from './calendar-dates'

// The calendar grid is a fixed size, so the popover is too. Without a definite
// width the footer copy drives it, and the popover visibly resizes as the
// message changes between the hint, the day count and the warning.
// 7 columns * 34px (--rdp-day-width) + per-month padding, the hairline
// divider between months, and the surface padding (prototype .cal-pop lands
// at ~560px for two months).
export const DAY_SIZE = 34
const MONTH_WIDTH = DAY_SIZE * 7
export const SURFACE_PADDING = 16 * 2
// Horizontal padding inside each month; the divider sits between the padded
// months (prototype .cal-month padding + border-left).
export const MONTH_PAD = 12
const MONTH_DIVIDER = 1
// The paper's own 1px border is inside the width, so it has to be counted:
// two pixels short and the second month wraps under the first.
const PAPER_BORDER = 2
export const ONE_MONTH_WIDTH =
  MONTH_WIDTH + MONTH_PAD * 2 + SURFACE_PADDING + PAPER_BORDER
export const TWO_MONTH_WIDTH =
  (MONTH_WIDTH + MONTH_PAD * 2) * 2 + MONTH_DIVIDER + SURFACE_PADDING + PAPER_BORDER

// The holiday accent shared by every calendar surface (year grid, request
// calendars, legends). Deliberately NOT the warning palette - holidays are a
// calendar convention, not a caution, and the amber tint read muddy against
// the paper. User decision: the PRIMARY brand blue itself - no third hue at
// all; a softer tint (and the deep primary-dark for small text) carries the
// difference from selection surfaces.
export const HOLIDAY_ACCENT = {
  /** Fills, dots, day numbers on tint (theme primary.main). */
  main: '#155eef',
  /** Small text on pale tints (pills) - primary.dark for contrast. */
  text: '#0040c1',
  /** Pill backgrounds, and holiday day cells in the REQUEST calendars
      (softer than the 0.1 selection band so a holiday never reads as
      pre-selected). */
  tint: 'rgba(21, 94, 239, 0.07)',
  /** Day-cell backgrounds in the display-only year grid. */
  tintStrong: 'rgba(21, 94, 239, 0.1)',
  /** Card and swatch borders. */
  border: 'rgba(21, 94, 239, 0.22)',
}

// Weekend / holiday day modifiers, shared by both pickers. Pass an empty set to
// shade nothing (a single-date field that carries no holiday data).
export function sharedDayModifiers(holidayDates: ReadonlySet<string>) {
  return {
    dpWeekend: (date: Date) => isWeekendIso(localDateToIso(date)),
    dpHoliday: (date: Date) => holidayDates.has(localDateToIso(date)),
  }
}

export const sharedModifiersClassNames = {
  dpWeekend: 'dp-weekend',
  dpHoliday: 'dp-holiday',
}

export const sharedDayLabels = {
  // Extend the stock label rather than replace it: `aria-selected` sits on the
  // gridcell while focus is on the button inside, so dropping the stock ",
  // selected" suffix would leave a screen reader with no selection state on the
  // focused element.
  labelDayButton: (date: Date, dayModifiers: Modifiers) => {
    const base = labelDayButton(date, dayModifiers)
    if (dayModifiers.dpHoliday) {
      return `${base}, public holiday`
    }
    if (dayModifiers.dpWeekend) {
      return `${base}, weekend`
    }
    return base
  },
}

export function LegendSwatch({
  tone,
  label,
}: {
  tone: 'weekend' | 'holiday' | 'today' | 'unpaid'
  label: string
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box
        sx={(theme) => ({
          width: 12,
          height: 12,
          borderRadius: '4px',
          // Ring-only for today (a divider border would double-ring it);
          // dashed for unpaid, matching the box drawn around the day itself.
          border:
            tone === 'today'
              ? 'none'
              : tone === 'unpaid'
                ? '1.5px dashed'
                : '1px solid',
          backgroundColor:
            tone === 'holiday'
              ? HOLIDAY_ACCENT.tintStrong
              : tone === 'today' || tone === 'unpaid'
                ? theme.palette.background.paper
                : alpha(theme.palette.text.primary, 0.06),
          borderColor:
            tone === 'holiday'
              ? HOLIDAY_ACCENT.border
              : tone === 'unpaid'
                ? alpha(UNPAID_ACCENT, 0.85)
                : theme.palette.divider,
          // The today marker is a ring, not a fill - same treatment as the
          // day cell it explains.
          boxShadow:
            tone === 'today'
              ? `inset 0 0 0 1.5px ${theme.palette.primary.light ?? theme.palette.primary.main}`
              : 'none',
        })}
      />
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}

/**
 * The skin, shared by the range and single pickers.
 *
 * Every `--rdp-*` variable is declared by the shipped stylesheet ON `.rdp-root`
 * itself, not on `:root`. An element's own declaration beats an inherited one,
 * so the overrides have to reach the same element through a descendant selector
 * — setting them on this wrapper, or via a class on the calendar, silently
 * loses.
 *
 * The range-only blocks (flattened range gradients, dp-round-* corner radii)
 * are inert for a single-date calendar, which never applies those classes.
 */
export const CalendarSurface = styled('div')(({ theme }) => ({
  padding: SURFACE_PADDING / 2,

  '& .rdp-root': {
    position: 'relative',
    '--rdp-accent-color': theme.palette.primary.main,
    '--rdp-accent-background-color': alpha(theme.palette.primary.main, 0.1),
    // Shared with the popover width above so the two cannot drift apart.
    '--rdp-day-height': `${DAY_SIZE}px`,
    '--rdp-day-width': `${DAY_SIZE}px`,
    '--rdp-day_button-height': '30px',
    '--rdp-day_button-width': '30px',
    // The stock 100% is a full pill, which theme.ts forbids outright.
    '--rdp-day_button-border-radius': theme.spacing(1),
    // Prototype today marker rides the primary family (inset ring below);
    // teal here would clash with the workspace accents.
    '--rdp-today-color': theme.palette.primary.main,
    '--rdp-nav-height': '34px',
    '--rdp-nav_button-height': '28px',
    '--rdp-nav_button-width': '28px',
    '--rdp-outside-opacity': '0.45',
    '--rdp-disabled-opacity': '0.38',
    '--rdp-weekday-opacity': '1',
    '--rdp-range_start-color': theme.palette.primary.contrastText,
    '--rdp-range_end-color': theme.palette.primary.contrastText,
    // Flatten the stock half-transparent gradients on the range ends to the
    // same flat tint as the middle, so the whole band is one even strip that
    // the radii below round off. Without this the ends fade to transparent and
    // rounding them does nothing visible.
    '--rdp-range_start-background': alpha(theme.palette.primary.main, 0.1),
    '--rdp-range_end-background': alpha(theme.palette.primary.main, 0.1),
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.body2.fontSize,
    color: theme.palette.text.primary,
  },

  // border-radius on a <td> is ignored under the stock `border-collapse:
  // collapse`. `separate` + zero spacing keeps the grid pixel-identical while
  // letting the range band round its corners.
  '& .rdp-month_grid': {
    borderCollapse: 'separate',
    borderSpacing: 0,
  },

  // Per-corner rounding driven by the JS modifiers (roundedCorners). Only the
  // convex corners of the block's outline round, so the range reads as one
  // continuous shape: interior wraps stay square, month-crossing cuts stay flat,
  // and the true silhouette corners (grid edges, start/end) round off. Corner
  // logic cannot live in CSS because it needs the cell above/below, which sits
  // in a different table row.
  '& .dp-round-tl': { borderTopLeftRadius: theme.spacing(1) },
  '& .dp-round-tr': { borderTopRightRadius: theme.spacing(1) },
  '& .dp-round-bl': { borderBottomLeftRadius: theme.spacing(1) },
  '& .dp-round-br': { borderBottomRightRadius: theme.spacing(1) },

  // nowrap so the months stay side by side even if the width arithmetic above
  // is off by a pixel. Wrapping is the ugly failure: the second month drops
  // below the first and the popover becomes a tall column. The hairline
  // between the padded months is the prototype's .cal-month divider.
  '& .rdp-months': {
    gap: 0,
    flexWrap: 'nowrap',
  },
  '& .rdp-month': {
    padding: `0 ${MONTH_PAD}px`,
  },
  '& .rdp-month + .rdp-month': {
    borderLeft: `1px solid ${theme.palette.divider}`,
  },

  // Prototype .cal-nav: the prev/next arrows ride the far edges of the header
  // line, not a cluster in one corner. The nav row overlays the month
  // captions (root is the positioning context above).
  '& .rdp-nav': {
    position: 'absolute',
    top: 0,
    left: MONTH_PAD,
    right: MONTH_PAD,
    height: 'var(--rdp-nav-height)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    pointerEvents: 'none',
    '& > *': { pointerEvents: 'auto' },
  },

  // Stock ships `font-size: large` on both of these. On the caption it fights
  // the type scale; on a selected day it grows the cell mid-selection and
  // reflows the grid under the pointer. Prototype .cal-title: 13/800 centered.
  '& .rdp-month_caption': {
    fontSize: 13,
    fontWeight: 800,
    justifyContent: 'center',
  },
  '& .rdp-selected': {
    fontSize: 'inherit',
    fontWeight: 700,
  },

  // Prototype .cal-dow: 10/700 uppercase, palest ink.
  '& .rdp-weekday': {
    ...theme.typography.overline,
    fontSize: 10,
    color: '#98a2b3',
  },

  // Prototype .cal-nav buttons: 28px, radius 9.
  '& .rdp-button_next, & .rdp-button_previous': {
    borderRadius: '9px',
    color: theme.palette.text.secondary,
    '&:hover': {
      backgroundColor: alpha(theme.palette.primary.main, 0.06),
    },
  },

  // The stock chevron renders at its intrinsic 24px, oversized for a 28px
  // button; compact it toward the prototype's slim arrows.
  '& .rdp-nav .rdp-chevron': {
    width: 17,
    height: 17,
  },

  '& .rdp-day_button': {
    fontSize: 12.5,
    fontWeight: 600,
    '&:focus-visible': {
      outline: `2px solid ${alpha(theme.palette.primary.main, 0.35)}`,
      outlineOffset: 2,
    },
  },

  // Prototype .cal-day.today: a light-primary inset ring, no fill.
  '& .rdp-day.rdp-today:not(.rdp-selected) .rdp-day_button': {
    boxShadow: `inset 0 0 0 1.5px ${theme.palette.primary.light ?? theme.palette.primary.main}`,
  },

  // `:not(.rdp-selected)` is load-bearing, not tidiness. A hover rule written
  // as `.rdp-day_button:hover` is (0,3,0) and outranks the stock
  // `.rdp-range_start .rdp-day_button` (0,2,0) that paints the solid accent
  // fill — while `.rdp-range_start` keeps setting the text to white. The day
  // you just clicked is the day under the cursor, so a selected endpoint would
  // sit at white-on-6%-tint for as long as the pointer rested on it.
  '& .rdp-day:not(.rdp-selected) .rdp-day_button:hover': {
    backgroundColor: alpha(theme.palette.primary.main, 0.06),
  },

  // `:not(.rdp-today)` keeps the today marker winning: its own rule is only
  // (0,2,0) and would otherwise lose to these. `:not(.rdp-selected)` leaves a
  // selected day rendered as selected, weekend or not.
  // Prototype .cal-day.wknd: pale ink over a whisper of fill.
  '& .rdp-day.dp-weekend:not(.rdp-today):not(.rdp-selected) .rdp-day_button': {
    color: theme.palette.text.disabled,
    backgroundColor: 'rgba(16, 24, 40, 0.03)',
  },
  // The softer tint, NOT tintStrong: in a range picker the 0.1 primary band
  // marks the selection, so holidays step down a notch to stay distinct.
  '& .rdp-day.dp-holiday:not(.rdp-selected) .rdp-day_button': {
    backgroundColor: HOLIDAY_ACCENT.tint,
  },
  '& .rdp-day.dp-holiday:not(.rdp-today):not(.rdp-selected) .rdp-day_button': {
    // Deep rose, not main: the small day numbers need the contrast on tint.
    color: HOLIDAY_ACCENT.text,
  },

  '@media (prefers-reduced-motion: reduce)': {
    '& .rdp-root *': {
      animation: 'none !important',
      transition: 'none !important',
    },
  },
}))
