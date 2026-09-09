/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  useMemo,
  type HTMLAttributes,
  type TdHTMLAttributes,
} from 'react'
import {
  DayPicker,
  type CalendarDay,
  type Modifiers,
  type MonthCaptionProps,
} from '@daypicker/react'
import '@daypicker/react/style.css'
import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import type { HolidayEntryDto } from '@workspace/contracts'
import {
  HOLIDAY_ACCENT,
  sharedDayModifiers,
  sharedModifiersClassNames,
} from '../../components/date-picker/CalendarSurface'
import { isoToLocalDate, localDateToIso } from '../../components/date-picker/calendar-dates'

const MONTHS = Array.from({ length: 12 }, (_, index) => index)

// The prototype mini titles are bare English month names ("July", no year) -
// a module const keeps them byte-deterministic under renderToString, matching
// the app's hardcoded-English copy everywhere else.
const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Prototype .mini-dow: single-letter weekday header (M T W T F S S with the
// Monday week start). The <th> keeps its stock full-name aria-label.
const miniFormatters = {
  formatWeekdayName: (weekday: Date) => 'SMTWTFS'.charAt(weekday.getDay()),
}

// The Day component RDP hands us in display-only mode. DayProps isn't re-exported
// from the package, so reconstruct it from the two parts that are.
type YearDayProps = {
  day: CalendarDay
  modifiers: Modifiers
} & HTMLAttributes<HTMLDivElement>

/**
 * A static, display-only year view: twelve mini month cards (prototype .mini)
 * with official holidays shaded and dotted, weekends dimmed, a per-month
 * holiday-count pill in the caption, and a warning-tinted card border for
 * months that contain holidays.
 *
 * Deliberately NOT wrapped in CalendarSurface: that skin's contributions are
 * either inert here (day-button rules - display-only RDP renders no buttons)
 * or need different values (fluid cells instead of the fixed 34px grid), so
 * the whole mini skin lives in this component's own scoped sx. Only the day
 * MODIFIERS are shared with the request calendars - that is the contract.
 *
 * Two things the range picker gets for free that this must add back: with no
 * `mode`, RDP renders each day as plain text in the cell (no `.rdp-day_button`),
 * so day styling targets the `.hc-cell` span a custom Day injects. And the
 * custom Day adds the styled tooltip naming the holiday.
 *
 * `todayIso` pins the today ring to the server clock (test clock included);
 * without it RDP falls back to the real client clock.
 *
 * Not a picker: nothing is selectable. The accompanying holiday LIST is the
 * accessible source of truth; the grid is a visual aid.
 */
export function HolidayYearCalendar({
  year,
  holidays,
  todayIso,
}: {
  year: number
  holidays: HolidayEntryDto[]
  todayIso?: string
}) {
  const { holidayDates, nameByDate, countByMonth } = useMemo(() => {
    const names = new Map(holidays.map((holiday) => [holiday.date, holiday.name]))
    const counts = Array.from({ length: 12 }, () => 0)
    for (const holiday of holidays) {
      // Slicing the ISO string avoids Date parsing; the page passes exactly
      // one year's holidays, so no year filter is needed.
      const monthIndex = Number(holiday.date.slice(5, 7)) - 1
      counts[monthIndex] = (counts[monthIndex] ?? 0) + 1
    }
    return { holidayDates: new Set(names.keys()), nameByDate: names, countByMonth: counts }
  }, [holidays])

  // One modifier set for all twelve months rather than twelve fresh closures.
  const modifiers = useMemo(() => sharedDayModifiers(holidayDates), [holidayDates])

  const today = todayIso ? isoToLocalDate(todayIso) : undefined

  // Stable component overrides so RDP does not remount the grids every render.
  // Day adds the holiday-name tooltip (and announces it) and wraps the day
  // number in the .hc-cell chip the styles below shade. MonthCaption replaces
  // the stock "July 2026" caption wholesale with the bare month name plus the
  // count pill - no hidden duplicate text, no stray live region (the month
  // grid keeps its own year-carrying aria-label).
  const components = useMemo(() => {
    function Day({ day, modifiers: _modifiers, children, ...rest }: YearDayProps) {
      const name = nameByDate.get(localDateToIso(day.date))
      const baseLabel = rest['aria-label']
      const cell = (
        <td
          {...(rest as unknown as TdHTMLAttributes<HTMLTableCellElement>)}
          aria-label={name && baseLabel ? `${baseLabel}, ${name}` : baseLabel}
        >
          <span className="hc-cell">{children}</span>
        </td>
      )
      // A styled tooltip (not the browser's native title) names the holiday on
      // hover/focus. Only holidays carry one; plain days render the bare cell.
      if (!name) {
        return cell
      }
      return (
        <Tooltip title={name} arrow enterTouchDelay={0} disableInteractive>
          {cell}
        </Tooltip>
      )
    }
    function MonthCaption({
      calendarMonth,
      displayIndex: _displayIndex,
      children: _children,
      ...divProps
    }: MonthCaptionProps) {
      const monthIndex = calendarMonth.date.getMonth()
      const count = countByMonth[monthIndex] ?? 0
      return (
        <div {...divProps}>
          {MONTH_LABELS[monthIndex] ?? ''}
          {count > 0 ? <span className="hc-count">{count}</span> : null}
        </div>
      )
    }
    return { Day, MonthCaption }
  }, [nameByDate, countByMonth])

  return (
    <Box
      sx={(theme) => ({
        display: 'grid',
        gap: 1.75,
        // Prototype .year-grid: fluid cards from 232px up; cells grow with
        // the card instead of centering a fixed grid in it.
        gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))',

        // The stock stylesheet declares every --rdp-* var on .rdp-root itself,
        // so overrides must reach that element (see CalendarSurface's note).
        '& .rdp-root': {
          width: '100%',
          '--rdp-day-width': 'auto',
          '--rdp-day-height': 'auto',
          // The stock sheet colors today's number with this var (literal
          // `blue` by default); with CalendarSurface gone, pin it to ink so
          // only our ring marks the day. The weekend/holiday span colors
          // still win on the .hc-cell.
          '--rdp-today-color': theme.palette.text.primary,
          fontFamily: theme.typography.fontFamily,
          color: theme.palette.text.primary,
        },
        '& .rdp-months, & .rdp-month': { display: 'block', padding: 0 },
        '& .rdp-month_grid': {
          width: '100%',
          tableLayout: 'fixed',
          borderCollapse: 'separate',
          borderSpacing: '2px',
        },

        // Prototype .mini-title: bare month name 13/800 centered, with the
        // warning count pill beside it.
        '& .rdp-month_caption': {
          fontSize: 13,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          marginBottom: '8px',
          // The stock caption reserves the 44px nav height; this view has no
          // nav, so collapse it to the prototype's compact title line.
          height: 'auto',
        },
        // A CIRCLE, not a capsule: fixed square with full rounding (grows
        // into a capsule only for a 2-digit count).
        '& .hc-count': {
          display: 'inline-grid',
          placeItems: 'center',
          minWidth: 17,
          height: 17,
          padding: '0 2px',
          fontSize: 10,
          fontWeight: 800,
          lineHeight: 1,
          color: HOLIDAY_ACCENT.text,
          backgroundColor: HOLIDAY_ACCENT.tint,
          borderRadius: '50%',
        },

        // Prototype .mini-dow: the ink-4 micro-caption grey every other
        // uppercase caption on the page uses (text.disabled is a warmer MUI
        // default grey that would stand out).
        '& .rdp-weekday': {
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          color: '#98a2b3',
          padding: '2px 0',
          opacity: 1,
        },

        // Day chips: fluid squares (aspect-ratio on the inner span is
        // reliable; on a <td> it is not).
        '& .hc-cell': {
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          aspectRatio: '1 / 1',
          minHeight: 26,
          borderRadius: '7px',
          fontSize: 12,
          fontWeight: 600,
        },
        '& .rdp-day.dp-weekend:not(.dp-holiday) .hc-cell': {
          color: '#98a2b3',
        },
        // The tint alone marks a holiday (user decision: no extra dot on top
        // of an already-shaded cell) - the tooltip still names it on hover.
        // Deep rose for the 12px numbers: the brighter main measures under
        // 4.5:1 on the tint.
        '& .rdp-day.dp-holiday .hc-cell': {
          backgroundColor: HOLIDAY_ACCENT.tintStrong,
          color: HOLIDAY_ACCENT.text,
          fontWeight: 800,
        },
        // Prototype .mini-day.today: the primary-light inset ring, holiday or
        // not - same family as the request calendar's today marker.
        '& .rdp-day.rdp-today .hc-cell': {
          boxShadow: `inset 0 0 0 1.5px ${theme.palette.primary.light ?? theme.palette.primary.main}`,
        },
      })}
    >
      {MONTHS.map((month) => (
        <Box
          key={month}
          sx={(theme) => ({
            // Uniform grey borders (user decision): the count pill and the
            // tinted days already say which months carry holidays, so an
            // accent border would just make the grid look uneven.
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: '14px',
            bgcolor: 'background.paper',
            p: '12px 12px 10px',
            transition:
              'box-shadow 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
            '&:hover': {
              boxShadow: '0 10px 28px -10px rgba(16, 24, 40, 0.14)',
              transform: 'translateY(-1px)',
            },
          })}
        >
          <DayPicker
            // Controlled month (not defaultMonth) so it follows the switcher.
            month={new Date(year, month, 1)}
            hideNavigation
            disableNavigation
            today={today}
            weekStartsOn={1}
            formatters={miniFormatters}
            modifiers={modifiers}
            modifiersClassNames={sharedModifiersClassNames}
            components={components}
          />
        </Box>
      ))}
    </Box>
  )
}
