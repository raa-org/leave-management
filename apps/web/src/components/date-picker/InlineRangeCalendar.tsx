/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from 'react'
import { DayPicker, type CalendarDay, type Modifiers } from '@daypicker/react'
import '@daypicker/react/style.css'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha, useTheme } from '@mui/material/styles'
import {
  formatDate,
  formatDayMonth,
  formatDays,
  formatWeekdayDayMonth,
  hoursToDays,
  spansYears,
} from '../../lib/leave-format'
import {
  CalendarSurface,
  LegendSwatch,
  sharedDayLabels,
  sharedDayModifiers,
  sharedModifiersClassNames,
} from './CalendarSurface'
// UNPAID_MARKING_DISABLED: restore with the two commented rules below.
// import { UNPAID_ACCENT } from '../../theme'
import { chargeableDates, isoToLocalDate, localDateToIso } from './calendar-dates'
import { CORNER_CLASSNAMES, roundedCorners, type Corner } from './range-corners'
import { nextSelection, type DateRangeValue } from './selection'

/**
 * The per-day hours editor, when the caller offers one. The calendar owns the
 * switch, the rows and the badges; the CALLER owns the hours, because they are
 * what it submits and what it prices the request with.
 *
 * The rows are derived here from the chargeable dates of the current range, so
 * a weekend or a public holiday can never get one: those days cost nothing, and
 * the server refuses hours booked against them outright.
 */
export type PartialDaysControl = {
  /** Whether the editor is open. Closed means every date is a full day. */
  enabled: boolean
  /** Turning it off is the caller's cue to reset every date to a full day. */
  onEnabledChange: (enabled: boolean) => void
  /** The org's workday length: the upper bound of every stepper, and the
   *  amount that means "a whole day". */
  hoursPerDay: number
  /** Hours booked per ISO date. A date it does not name is a full day. */
  hoursByDate: Readonly<Record<string, number>>
  onHoursChange: (date: string, hours: number) => void
}

export type InlineRangeCalendarProps = {
  /** The committed range; the calendar is fully controlled. */
  value: DateRangeValue
  /** Fires on every day click and on Clear - there is no Done step. */
  onChange: (value: DateRangeValue) => void
  /** Omitted, the calendar books whole days only and shows no switch. */
  partialDays?: PartialDaysControl
  /** Official-holiday dates ('YYYY-MM-DD') to shade and exclude from the count. */
  holidayDates?: ReadonlySet<string>
  /** Holiday names by date, for the hover tooltip. Purely additive. */
  holidayNames?: ReadonlyMap<string, string>
  /**
   * Days of the current selection the balance will not pay for ('YYYY-MM-DD'),
   * hatched so the employee sees WHICH days are unpaid rather than only how
   * many. Server-decided, and not necessarily a trailing run: accrual arriving
   * mid-leave pays for the days after it.
   */
  unpaidDates?: ReadonlySet<string>
  /**
   * Optional inclusive lower bound ('YYYY-MM-DD'). Earlier days are disabled
   * and the calendar cannot navigate before the bounding month. The composer
   * passes none: retroactive requests are a supported server flow.
   */
  minDate?: string
  testId?: string
}

const dayPlural = (count: number) => (count === 1 ? 'working day' : 'working days')

/**
 * What the selection costs once part days are in play, pure for unit tests.
 * Null when every chargeable date is whole, which is when the day count in the
 * summary already IS the cost and a second figure saying the same thing would
 * be noise.
 *
 * `hours` is one entry per chargeable date, in order. The shapes come from the
 * prototype: one repeated part-day length is named ("2 × 4h"), several
 * different ones are only counted, because spelling each out would outgrow the
 * footer line the editor below already lists them on.
 */
export function partialDaysSummary(
  hours: readonly number[],
  hoursPerDay: number,
): string | null {
  let booked = 0
  let full = 0
  const partHours: number[] = []
  for (const entry of hours) {
    booked += entry
    if (entry >= hoursPerDay) {
      full += 1
    } else {
      partHours.push(entry)
    }
  }
  if (partHours.length === 0) {
    return null
  }
  const total = formatDays(hoursToDays(booked, hoursPerDay))
  const sameLength = partHours.every((entry) => entry === partHours[0])
  if (!sameLength) {
    return `${total} (mixed hours)`
  }
  const part = `${partHours.length} × ${partHours[0]}h`
  return full === 0 ? `${total} (${part})` : `${total} (${full} full + ${part})`
}

/**
 * The footer copy, pure so tests cover every state without rendering.
 *
 * `warn` marks the one state that needs attention: a settled selection whose
 * every day is a weekend or holiday. The server rejects such a request, and
 * the submit button is gated on the same count, so the footer must say why.
 *
 * `cost` is partialDaysSummary's line, appended to a settled selection only:
 * while the range is still being drawn the day count is explicitly "so far",
 * and a cost beside it would read as final.
 */
export function selectionSummary(
  value: DateRangeValue,
  anchor: string | null,
  days: number,
  cost: string | null = null,
): { text: string; warn: boolean } {
  if (!value.startDate) {
    return { text: 'Pick a start date. A single day is fine too.', warn: false }
  }
  if (anchor !== null) {
    return {
      text: `${formatDayMonth(value.startDate)} · ${days} ${dayPlural(days)} so far. Pick the end date or submit a single day.`,
      warn: false,
    }
  }
  const dates =
    value.startDate === value.endDate
      ? formatDayMonth(value.startDate)
      : // A range crossing the New Year names each end's own year; "Dec 25 →
        // Jan 5" alone would read as one year.
        spansYears(value.startDate, value.endDate)
        ? `${formatDate(value.startDate)} → ${formatDate(value.endDate)}`
        : `${formatDayMonth(value.startDate)} → ${formatDayMonth(value.endDate)}`
  if (days === 0) {
    return { text: `${dates} · no working days in this range`, warn: true }
  }
  const counted = `${dates} · ${days} ${dayPlural(days)}`
  return { text: cost ? `${counted} · ${cost}` : counted, warn: false }
}

// The DayButton props RDP hands an override; the type is not re-exported from
// the package, so reconstruct it from the parts that are (HolidayYearCalendar
// does the same for the display-only Day).
type RangeDayButtonProps = {
  day: CalendarDay
  modifiers: Modifiers
} & ButtonHTMLAttributes<HTMLButtonElement>

// What a day cell draws on top of the date: the hours of a shortened day and
// the name of a public holiday.
type DayCellDecoration = {
  badgeHours: ReadonlyMap<string, number>
  holidayNames?: ReadonlyMap<string, string>
}

const NO_DECORATION: DayCellDecoration = { badgeHours: new Map() }

// Through CONTEXT rather than through the `components` prop's closure, and this
// is the whole point of the indirection: RDP treats a new component identity as
// a different component, so a `components` object rebuilt on any render
// unmounts and remounts every day cell in the calendar. The composer re-renders
// on every keystroke of its comment box, and a closure over the badges would
// tie the cells' lifetime to that. A changing context value re-renders the
// cells, which is exactly what is wanted, and never remounts them.
const DayCellDecorationContext = createContext<DayCellDecoration>(NO_DECORATION)

// The stock button's focus management is replicated because overriding the
// component replaces it: without the effect, keyboard arrow navigation stops
// moving focus.
function DecoratedDayButton({
  day,
  modifiers: dayModifiers,
  children,
  ...rest
}: RangeDayButtonProps) {
  const { badgeHours, holidayNames } = useContext(DayCellDecorationContext)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (dayModifiers.focused) {
      ref.current?.focus()
    }
  }, [dayModifiers.focused])
  const iso = localDateToIso(day.date)
  const badge = badgeHours.get(iso)
  const button = (
    <button ref={ref} {...rest}>
      {children}
      {badge !== undefined ? (
        // Prototype .cd-badge: the hours of a shortened day.
        <Box component="span" className="dp-hours-badge">
          {badge}h
        </Box>
      ) : null}
    </button>
  )
  const name = holidayNames?.get(iso)
  // No tooltip on a disabled day: disabled elements fire no pointer events, so
  // it would never open, and MUI logs a dev error about it.
  if (!name || rest.disabled) {
    return button
  }
  return (
    <Tooltip title={name} arrow enterTouchDelay={0} disableInteractive>
      {button}
    </Tooltip>
  )
}

// A module CONSTANT, deliberately: handed to DayPicker unconditionally so its
// identity is fixed for the life of the app and no render can ever remount a
// day cell. Exported so a spec can pin that identity from the outside.
export const RANGE_DAY_COMPONENTS = { DayButton: DecoratedDayButton }

// Prototype .psw-group: the label and the iOS-style track are one control, and
// one flex item, so a wrapping footer row can never leave the switch stranded
// from the words that name it.
function PartialDaysSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <ButtonBase
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      disableRipple
      onClick={() => onChange(!checked)}
      data-testid="partial-days-switch"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        flex: 'none',
        borderRadius: '8px',
        px: 0.5,
        py: 0.25,
        '&.Mui-disabled': { opacity: 0.45 },
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: 12,
          fontWeight: 600,
          color: 'text.secondary',
          whiteSpace: 'nowrap',
        }}
      >
        Partial days
      </Box>
      {/* Prototype .psw: a 30x17 track with a 13px knob, both fixed pixel
          sizes - the control reads as a switch at that size and no other. */}
      <Box
        component="span"
        aria-hidden
        sx={(theme) => ({
          position: 'relative',
          width: 30,
          height: 17,
          flex: 'none',
          borderRadius: 999,
          backgroundColor: checked
            ? theme.palette.primary.main
            : 'rgba(16, 24, 40, 0.18)',
          transition: 'background-color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          '&::after': {
            content: '""',
            position: 'absolute',
            top: 2,
            left: checked ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: '50%',
            backgroundColor: theme.palette.common.white,
            boxShadow: '0 1px 2px rgba(16, 24, 40, 0.24)',
            transition: 'left 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          },
        })}
      />
    </ButtonBase>
  )
}

// Prototype .stepper: whole hours only, clamped to 1..hoursPerDay, because
// those are exactly the values the server accepts for a booked date (a full day
// is hoursPerDay; nothing at all is a date left out of the range).
function HoursStepper({
  label,
  hours,
  hoursPerDay,
  onChange,
}: {
  label: string
  hours: number
  hoursPerDay: number
  onChange: (hours: number) => void
}) {
  const buttonSx = {
    width: 26,
    height: 26,
    minWidth: 0,
    minHeight: 0,
    // The theme gives every Button paddingInline 18, which inside a 26px box
    // leaves no content width at all: the glyph is pushed out and the group's
    // overflow clips it, so the stepper renders as a bare number nobody can
    // change. Any small square button in this app has to say padding 0.
    padding: 0,
    borderRadius: 0,
    color: 'text.secondary',
    '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
    '&.Mui-disabled': { opacity: 0.35 },
  } as const
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{
        border: '1px solid',
        borderColor: 'rgba(16, 24, 40, 0.14)',
        borderRadius: '10px',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        flex: 'none',
      }}
    >
      <Button
        variant="text"
        sx={buttonSx}
        disabled={hours <= 1}
        aria-label={`Decrease hours for ${label}`}
        onClick={() => onChange(hours - 1)}
      >
        <Box component="svg" width={12} height={12} viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
        </Box>
      </Button>
      <Box
        component="span"
        sx={{
          minWidth: 34,
          textAlign: 'center',
          fontSize: 12.5,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {hours}h
      </Box>
      <Button
        variant="text"
        sx={buttonSx}
        disabled={hours >= hoursPerDay}
        aria-label={`Increase hours for ${label}`}
        onClick={() => onChange(hours + 1)}
      >
        <Box component="svg" width={12} height={12} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
          />
        </Box>
      </Button>
    </Stack>
  )
}

/**
 * The composer's always-visible range calendar (prototype .cal-wrap): the
 * popover picker's skin and selection policy, without the popover. Every click
 * commits through `onChange` immediately - `nextSelection` never produces an
 * inverted range, so there is nothing a Done step would need to veto; the
 * page's working-day gate keeps a zero-cost selection from being submitted.
 *
 * Redux-free like the popover picker: holidays arrive as props.
 */
export function InlineRangeCalendar({
  value,
  onChange,
  partialDays,
  holidayDates = new Set<string>(),
  holidayNames,
  unpaidDates,
  minDate,
  testId,
}: InlineRangeCalendarProps) {
  const theme = useTheme()
  const twoUp = useMediaQuery(theme.breakpoints.up('md'))
  // Only the anchor lives here: the range itself is the caller's form state.
  // An anchor is the first click of a selection still open to extension - see
  // nextSelection for the policy.
  const [anchor, setAnchor] = useState<string | null>(null)
  // The anchor only means something while the click that opened it still
  // stands in `value`. When the caller clears the value externally (a form
  // reset after a successful submit), a kept anchor would silently stretch
  // the next click into a phantom range from the previous draft.
  const effectiveAnchor = value.startDate !== '' ? anchor : null

  // The visible month is state, not a one-shot default: this calendar is
  // always mounted, so a value that arrives later (the composer prefilling the
  // leave being changed) would otherwise leave the view sitting on today while
  // the selection lives months away, out of sight and one stray click from
  // being replaced.
  const [month, setMonth] = useState<Date | undefined>(() =>
    initialMonthFor(value.startDate, minDate),
  )
  // Follow the selection only when it lands OUTSIDE the visible window: a
  // click inside the calendar already shows what it selected, and pulling the
  // view onto it would jolt the second month of a two-up layout back to first.
  useEffect(() => {
    if (!value.startDate) {
      return
    }
    const target = isoToLocalDate(value.startDate)
    setMonth((current) =>
      current && isMonthVisible(target, current, twoUp ? 2 : 1) ? current : target,
    )
  }, [value.startDate, twoUp])

  const handleSelect = (_range: unknown, triggerDate: Date) => {
    const next = nextSelection(
      { startDate: value.startDate, endDate: value.endDate, anchor: effectiveAnchor },
      localDateToIso(triggerDate),
    )
    setAnchor(next.anchor)
    onChange({ startDate: next.startDate, endDate: next.endDate })
  }

  const clear = () => {
    setAnchor(null)
    onChange({ startDate: '', endDate: '' })
  }

  const selected = useMemo(() => {
    if (!value.startDate) {
      return undefined
    }
    return {
      from: isoToLocalDate(value.startDate),
      to: value.endDate ? isoToLocalDate(value.endDate) : undefined,
    }
  }, [value.startDate, value.endDate])

  const modifiers = useMemo(() => {
    const corner =
      (which: Corner) =>
      (date: Date): boolean =>
        roundedCorners(localDateToIso(date), value.startDate, value.endDate)[which]
    return {
      ...sharedDayModifiers(holidayDates),
      dpUnpaid: (date: Date): boolean =>
        unpaidDates?.has(localDateToIso(date)) ?? false,
      dpRoundTl: corner('tl'),
      dpRoundTr: corner('tr'),
      dpRoundBl: corner('bl'),
      dpRoundBr: corner('br'),
    }
  }, [holidayDates, unpaidDates, value.startDate, value.endDate])

  const modifiersClassNames = {
    ...sharedModifiersClassNames,
    ...CORNER_CLASSNAMES,
    dpUnpaid: 'dp-unpaid',
  }

  // The chargeable dates in order: the day count in the footer, one editor row
  // each, and the cells a part-day badge can land on all come from this one
  // list, so the three can never disagree about which days cost anything.
  const dates = useMemo(
    () => chargeableDates(value.startDate, value.endDate, holidayDates),
    [value.startDate, value.endDate, holidayDates],
  )
  const days = dates.length
  // Destructured out of the control object rather than read through it: the
  // caller builds `partialDays` inline, so its identity changes on every render
  // of the composer and any memo depending on it would recompute for nothing.
  const hoursPerDay = partialDays?.hoursPerDay ?? 0
  const partialEnabled = partialDays?.enabled ?? false
  const hoursByDate = partialDays?.hoursByDate
  const bookedHours = useMemo(
    () =>
      hoursByDate
        ? dates.map((date) => hoursByDate[date] ?? hoursPerDay)
        : [],
    [dates, hoursByDate, hoursPerDay],
  )
  // Only a date actually shortened gets a badge; a full day is what the cell
  // already means, and stamping "8h" on every selected day would bury the one
  // date that is different.
  const badgeHours = useMemo(() => {
    const marked = new Map<string, number>()
    if (!partialEnabled) {
      return marked
    }
    dates.forEach((date, index) => {
      const hours = bookedHours[index] ?? hoursPerDay
      if (hours < hoursPerDay) {
        marked.set(date, hours)
      }
    })
    return marked
  }, [bookedHours, dates, hoursPerDay, partialEnabled])
  const summary = selectionSummary(
    value,
    effectiveAnchor,
    days,
    partialEnabled ? partialDaysSummary(bookedHours, hoursPerDay) : null,
  )

  // What the day cells draw, handed down as context. Only the VALUE changes
  // here; the component that reads it is a module constant, so a new badge map
  // re-renders the cells and never remounts them.
  const decoration = useMemo(
    () => ({ badgeHours, ...(holidayNames ? { holidayNames } : {}) }),
    [badgeHours, holidayNames],
  )

  return (
    <Box
      data-testid={testId}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '14px',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        // No prototype holiday dot here: the warning tint already marks the
        // day, and a second signal on top of the shading reads as noise (the
        // tooltip still names the holiday on hover).
        // Prototype .cal-day.in-range.wknd/.hol: free days inside the range
        // keep a visibly weaker band (60% of the tint), so the at-a-glance
        // shading survives an active selection.
        '& .rdp-day.rdp-range_middle.dp-holiday, & .rdp-day.rdp-range_middle.dp-weekend': {
          backgroundColor: alpha(theme.palette.primary.main, 0.06),
        },
        // Prototype .cd-badge: the hours of a shortened day, pinned to the
        // cell's top-right corner. It hangs outside the 30px day button on
        // purpose, which is why the button has to stop clipping it.
        '& .rdp-day_button': { position: 'relative', overflow: 'visible' },
        '& .dp-hours-badge': {
          position: 'absolute',
          top: -4,
          right: -3,
          zIndex: 2,
          px: '4px',
          py: '1px',
          borderRadius: '6px',
          fontSize: 9,
          fontWeight: 800,
          lineHeight: 1.2,
          backgroundColor: theme.palette.primary.main,
          color: theme.palette.primary.contrastText,
          fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'none',
        },
        // TEMPORARILY OFF (see UNPAID_MARKING_DISABLED below): the calendar
        // marks nothing while the treatment is being reconsidered. Everything
        // that feeds it is still in place - the `dp-unpaid` modifier is still
        // applied to the right days and `unpaidDates` still arrives from the
        // composer - so restoring the marking is uncommenting these two rules
        // and the footer legend.
        //
        // Unpaid days: a dashed box around the day. An outline rather than a
        // fill, because these days ARE selected and every fill in this calendar
        // already means something about the selection - blue is the range, pale
        // blue a holiday, grey a weekend. Dashed is also what the balance meter
        // draws around the days a request touches, so the two surfaces say
        // "this request" the same way.
        // '& .rdp-day.dp-unpaid .rdp-day_button': {
        //   border: `1.5px dashed ${alpha(UNPAID_ACCENT, 0.85)}`,
        //   // Restated, not inherited: the library zeroes the radius on every
        //   // day INSIDE a range (`.rdp-range_middle .rdp-day_button` sets
        //   // `border-radius: unset`) so the selection reads as one continuous
        //   // band. That is right for the band and wrong for a box drawn on top
        //   // of it, which would come out square on exactly the days most likely
        //   // to be unpaid.
        //   borderRadius: theme.spacing(1),
        // },
        // The ends of the range are solid primary with white text, so a coral
        // outline on them all but disappears. A request whose LAST day is
        // unpaid is the common case, which makes this the rule that decides
        // whether the marking is seen at all.
        // '& .rdp-day.dp-unpaid.rdp-range_start .rdp-day_button, & .rdp-day.dp-unpaid.rdp-range_end .rdp-day_button':
        //   {
        //     borderColor: alpha(theme.palette.common.white, 0.9),
        //   },
      }}
    >
      {/* Auto margins (not centered flex) so an overflowing calendar stays
          fully reachable by scrolling: constrained auto margins collapse to
          zero and the content left-aligns instead of clipping its start. */}
      <Box sx={{ overflowX: 'auto' }}>
        <CalendarSurface sx={{ width: 'fit-content', mx: 'auto' }}>
          <DayCellDecorationContext.Provider value={decoration}>
            <DayPicker
              mode="range"
              selected={selected}
              onSelect={handleSelect}
              numberOfMonths={twoUp ? 2 : 1}
              // Anchored on the selection, else on the bound: the server clock
              // decides "today" (test clock included), so the client's own month
              // is the fallback only when neither is known.
              month={month}
              onMonthChange={setMonth}
              // Past days grey out and navigation stops at the bounding month.
              startMonth={minDate ? isoToLocalDate(minDate) : undefined}
              disabled={minDate ? [{ before: isoToLocalDate(minDate) }] : undefined}
              captionLayout="label"
              weekStartsOn={1}
              modifiers={modifiers}
              modifiersClassNames={modifiersClassNames}
              labels={sharedDayLabels}
              components={RANGE_DAY_COMPONENTS}
            />
          </DayCellDecorationContext.Provider>
        </CalendarSurface>
      </Box>

      {/* Prototype .cal-foot: two rows. The selection summary owns the first
          one outright, because it is the sentence the whole calendar is about
          and a wrapping toolbar beside it kept pushing it around. */}
      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderTop: '1px solid',
          borderColor: 'divider',
          bgcolor: '#f7f9fc',
        }}
      >
        <Stack spacing={0.875}>
          <Typography
            sx={{
              fontSize: 12.5,
              fontWeight: 600,
              color: summary.warn ? 'error.main' : 'text.secondary',
              minWidth: 0,
            }}
          >
            {summary.text}
          </Typography>
          {/* Two GROUPS, spread apart, rather than a flat row whose last item
              carries `ml: auto`: Stack's own spacing rule is a descendant
              selector, so it outranks the child's margin and quietly pins the
              tools back beside the legend instead of at the right edge. */}
          <Stack
            direction="row"
            rowGap={0.75}
            columnGap={1.5}
            alignItems="center"
            justifyContent="space-between"
            flexWrap="wrap"
          >
            <Stack direction="row" columnGap={1.5} alignItems="center" flexWrap="wrap">
              <LegendSwatch tone="weekend" label="Weekend" />
              <LegendSwatch tone="holiday" label="Public holiday" />
            {/* UNPAID_MARKING_DISABLED: off with the day marking above. A legend
                entry explaining a treatment that is not on screen is worse than
                no legend at all. Restore it together with the two rules in the
                stylesheet.

                Only while a split is actually on screen: a legend entry for a
                marking nobody can see is noise on every ordinary request.
            {unpaidDates && unpaidDates.size > 0 ? (
              <LegendSwatch tone="unpaid" label="Unpaid" />
            ) : null} */}
            </Stack>
            {/* Prototype .cal-tools: the switch, a hairline and Clear travel
                together as one right-hand cluster, so a narrow footer wraps the
                whole toolbar rather than splitting the switch off its label. */}
            <Stack
              direction="row"
              columnGap={1.25}
              alignItems="center"
              sx={{ flex: 'none' }}
            >
              {partialDays ? (
                <>
                  <PartialDaysSwitch
                    checked={partialDays.enabled}
                    // Nothing to shorten without a working day in the range,
                    // and an editor that opens onto no rows explains nothing.
                    disabled={days === 0}
                    onChange={partialDays.onEnabledChange}
                  />
                  <Box
                    aria-hidden
                    sx={{
                      width: '1px',
                      height: 14,
                      flex: 'none',
                      bgcolor: 'rgba(16, 24, 40, 0.14)',
                    }}
                  />
                </>
              ) : null}
              <Button
                variant="text"
                onClick={clear}
                disabled={!value.startDate}
                sx={{
                  flexShrink: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'primary.main',
                  px: 1.25,
                  py: '4px',
                  minWidth: 0,
                  minHeight: 0,
                  borderRadius: '8px',
                  '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08) },
                  '&.Mui-disabled': { color: 'text.disabled' },
                }}
              >
                Clear
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </Box>

      {/* Prototype .dh-slide: the editor lives INSIDE the calendar's box, under
          its footer, because the hours it sets belong to the days above it.
          Kept mounted while closed so the slide runs in both directions;
          `visibility` (delayed to the end of the close) is what takes the rows
          out of the tab order and the accessibility tree. */}
      {partialDays ? (
        <Box
          data-testid="partial-days-editor"
          sx={{
            overflow: 'hidden',
            maxHeight: partialDays.enabled ? 400 : 0,
            opacity: partialDays.enabled ? 1 : 0,
            visibility: partialDays.enabled ? 'visible' : 'hidden',
            transition: partialDays.enabled
              ? 'max-height 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms cubic-bezier(0.22, 1, 0.36, 1)'
              : 'max-height 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 240ms',
          }}
        >
          <Box
            sx={{
              borderTop: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              px: 2,
              pt: 0.5,
              pb: 1.25,
              maxHeight: 360,
              overflowY: 'auto',
            }}
          >
            {dates.map((date, index) => {
              const label = formatWeekdayDayMonth(date)
              return (
                <Stack
                  key={date}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  spacing={1.5}
                  sx={{
                    py: 0.875,
                    '& + &': { borderTop: '1px solid', borderColor: 'divider' },
                  }}
                >
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                    {label}
                  </Typography>
                  <HoursStepper
                    label={label}
                    hours={bookedHours[index] ?? hoursPerDay}
                    hoursPerDay={hoursPerDay}
                    onChange={(hours) => partialDays.onHoursChange(date, hours)}
                  />
                </Stack>
              )
            })}
            <Typography
              sx={{
                fontSize: 11,
                color: '#98a2b3',
                mt: 1,
                pt: 1,
                borderTop: '1px solid',
                borderColor: 'divider',
              }}
            >
              {`${hoursPerDay}h = a full working day. A day is paid in full or unpaid in full, so leftover hours cannot cover part of a longer day.`}
            </Typography>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

// Where the calendar opens: on the selection when there is one, else on the
// earliest month it will let you reach, else on the viewer's own month.
function initialMonthFor(
  startDate: string,
  minDate: string | undefined,
): Date | undefined {
  if (startDate) {
    return isoToLocalDate(startDate)
  }
  return minDate ? isoToLocalDate(minDate) : undefined
}

// Whether `target` falls in one of the `count` months on show from `first`.
function isMonthVisible(target: Date, first: Date, count: number): boolean {
  const monthsApart =
    (target.getFullYear() - first.getFullYear()) * 12 +
    (target.getMonth() - first.getMonth())
  return monthsApart >= 0 && monthsApart < count
}
