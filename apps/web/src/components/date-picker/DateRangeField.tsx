/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useMemo, useState } from 'react'
import { DayPicker } from '@daypicker/react'
import '@daypicker/react/style.css'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { isWeekendIso } from '@workspace/contracts'
import { formatDateRange, formatDayMonth } from '../../lib/leave-format'
import { CalendarPopoverField } from './CalendarPopoverField'
import {
  LegendSwatch,
  ONE_MONTH_WIDTH,
  TWO_MONTH_WIDTH,
  sharedDayLabels,
  sharedDayModifiers,
  sharedModifiersClassNames,
} from './CalendarSurface'
import { countChargeableDays, isoToLocalDate, localDateToIso } from './calendar-dates'
import { CORNER_CLASSNAMES, roundedCorners, type Corner } from './range-corners'
import {
  emptySelection,
  nextSelection,
  type DateRangeSelection,
  type DateRangeValue,
} from './selection'

export type DateRangeFieldProps = {
  label: string
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  /** Official-holiday dates ('YYYY-MM-DD') to shade. Ignored when `plain`. */
  holidayDates?: ReadonlySet<string>
  disabled?: boolean
  error?: boolean
  helperText?: string
  testId?: string
  fullWidth?: boolean
  /**
   * Palette of the trigger's focused outline and floating label. Defaults to
   * MUI's `primary`; a filter row built from `color="secondary"` controls has
   * to pass it, or this one field focuses blue among teal neighbours. Ignored
   * by the `pill` variant, whose trigger is a ButtonBase with its own colours.
   */
  color?: 'primary' | 'secondary'
  /**
   * Filter mode: drop the leave semantics. No holiday shading, no legend, no
   * working-day count, and Done is never gated. Weekend shading stays — that is
   * date-awareness rather than leave semantics. Use it wherever the range is a
   * plain filter rather than a leave request.
   */
  plain?: boolean
  /**
   * Trigger look: 'field' (labeled form field) or 'pill' (prototype .drf
   * filter button with a compact "Jul 24 → Jul 27" value and an adjacent
   * clear control once a range is committed).
   */
  variant?: 'field' | 'pill'
  /**
   * Inclusive selectable bounds ('YYYY-MM-DD'). Days outside are disabled and
   * the calendar cannot navigate past the bounding months — the history
   * filter pins these to the first/last day across the user's requests.
   */
  minDate?: string
  maxDate?: string
}

/**
 * One field for a date range, replacing a start/end pair.
 *
 * Redux-free: the holiday set arrives as a prop so the same component serves
 * the employee composer (rich, with shading and a working-day count) and admin
 * filters (`plain`). The selection policy lives in `nextSelection` — see the
 * note there for why we do not use the library's own range handling.
 */
export function DateRangeField({
  label,
  value,
  onChange,
  holidayDates = new Set<string>(),
  disabled = false,
  error = false,
  helperText,
  testId,
  fullWidth,
  color,
  plain = false,
  variant = 'field',
  minDate,
  maxDate,
}: DateRangeFieldProps) {
  const theme = useTheme()
  const twoUp = useMediaQuery(theme.breakpoints.up('md'))
  const isPill = variant === 'pill'
  // The calendar edits a DRAFT, and only Done writes it back to `value`. So
  // Escape and clicking away discard the draft and the field keeps its
  // committed value: there is no way to leave an unconfirmed selection (a
  // weekend with no working days, say) sitting in the field, which the Done
  // guard already forbids.
  const [draft, setDraft] = useState<DateRangeSelection>(emptySelection)

  const hasValue = value.startDate !== '' && value.endDate !== ''
  // The pill shows the prototype's compact "Jul 24 → Jul 27" form; the form
  // field keeps the spelled-out range.
  const displayValue = hasValue
    ? isPill
      ? value.startDate === value.endDate
        ? formatDayMonth(value.startDate)
        : `${formatDayMonth(value.startDate)} → ${formatDayMonth(value.endDate)}`
      : formatDateRange(value.startDate, value.endDate)
    : ''

  // The committed value should never have zero working days, because Done is
  // gated on that. But holidays load asynchronously, so a day committed as a
  // working day can later become a holiday; surface that on the field instead
  // of leaving a silently un-submittable value with no explanation. Never in
  // plain mode, where any range is a valid filter.
  const committedNoWorkingDays =
    !plain &&
    hasValue &&
    countChargeableDays(value.startDate, value.endDate, holidayDates) === 0

  const draftHasValue = draft.startDate !== '' && draft.endDate !== ''
  const draftChargeableDays =
    !plain && draftHasValue
      ? countChargeableDays(draft.startDate, draft.endDate, holidayDates)
      : 0
  const draftNoWorkingDays = !plain && draftHasValue && draftChargeableDays === 0

  const selected = useMemo(() => {
    if (!draft.startDate) {
      return undefined
    }
    return {
      from: isoToLocalDate(draft.startDate),
      to: draft.endDate ? isoToLocalDate(draft.endDate) : undefined,
    }
  }, [draft.startDate, draft.endDate])

  const modifiers = useMemo(() => {
    const corner =
      (which: Corner) =>
      (date: Date): boolean =>
        roundedCorners(localDateToIso(date), draft.startDate, draft.endDate)[which]
    // The rounded-block corners are the range's visual identity, kept in both
    // modes. Weekend shading is date-awareness and stays everywhere; HOLIDAY
    // shading is leave-specific, so plain (filters) drops it.
    const cornerModifiers = {
      dpRoundTl: corner('tl'),
      dpRoundTr: corner('tr'),
      dpRoundBl: corner('bl'),
      dpRoundBr: corner('br'),
    }
    return plain
      ? {
          dpWeekend: (date: Date) => isWeekendIso(localDateToIso(date)),
          ...cornerModifiers,
        }
      : { ...sharedDayModifiers(holidayDates), ...cornerModifiers }
  }, [plain, holidayDates, draft.startDate, draft.endDate])

  const modifiersClassNames = plain
    ? { dpWeekend: 'dp-weekend', ...CORNER_CLASSNAMES }
    : { ...sharedModifiersClassNames, ...CORNER_CLASSNAMES }

  const commit = () => onChange({ startDate: draft.startDate, endDate: draft.endDate })

  const handleSelect = (_range: unknown, triggerDate: Date) => {
    setDraft((current) => nextSelection(current, localDateToIso(triggerDate)))
  }

  const field = (
    <CalendarPopoverField
      label={label}
      displayValue={displayValue}
      disabled={disabled}
      error={error || committedNoWorkingDays}
      helperText={
        committedNoWorkingDays ? 'Selected dates have no working days.' : helperText
      }
      testId={testId}
      fullWidth={fullWidth}
      color={color}
      variant={variant}
      popoverWidth={twoUp ? TWO_MONTH_WIDTH : ONE_MONTH_WIDTH}
      // Seed the draft from the committed value, settled (anchor null) so the
      // first click restarts rather than extends.
      onOpen={() =>
        setDraft({ startDate: value.startDate, endDate: value.endDate, anchor: null })
      }
      footer={({ close }) => (
        <Box
          sx={{
            px: 2,
            py: 1.5,
            borderTop: '1px solid',
            borderColor: 'divider',
            // Prototype .cal-foot rests on a slightly deeper paper.
            bgcolor: '#f7f9fc',
          }}
        >
          {/* Keyed on twoUp, not on the viewport: what the footer has to fit
              into is the POPOVER width, which follows the month count. One
              month is 298px, too narrow for copy and two buttons on one line,
              so it stacks. */}
          <Stack
            direction={twoUp ? 'row' : 'column'}
            spacing={1.5}
            alignItems={twoUp ? 'center' : 'stretch'}
            justifyContent="space-between"
          >
            {/* minWidth: 0 lets this column shrink instead of pushing the
                popover wider than the calendar; the copy wraps inside it. */}
            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              flexWrap="wrap"
              rowGap={0.5}
              sx={{ minWidth: 0 }}
            >
              {draft.anchor !== null ? (
                <Typography variant="body2" color="text.secondary">
                  Click a second date for a period.
                </Typography>
              ) : plain ? null : (
                <>
                  <LegendSwatch tone="weekend" label="Weekend" />
                  <LegendSwatch tone="holiday" label="Public holiday" />
                </>
              )}
              {/* The cost line shows for a pending single day too, not just a
                  settled period: a lone Saturday or public holiday costs
                  nothing and the server rejects it, so the employee has to see
                  that while choosing rather than after submitting. */}
              {!plain && draftHasValue ? (
                <Typography
                  variant="body2"
                  color={draftNoWorkingDays ? 'error.main' : 'text.secondary'}
                >
                  {draftNoWorkingDays
                    ? 'No working days selected'
                    : `${draftChargeableDays} working day${draftChargeableDays === 1 ? '' : 's'}`}
                </Typography>
              ) : null}
            </Stack>

            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="flex-end"
              sx={{ flexShrink: 0 }}
            >
              {/* Prototype .cal-foot buttons: compact text Clear + a small
                  primary Done, not full-height form buttons. */}
              <Button
                variant="text"
                onClick={() => setDraft(emptySelection)}
                disabled={!draft.startDate}
                sx={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'text.secondary',
                  px: 1.25,
                  py: '5px',
                  minWidth: 0,
                  minHeight: 0,
                  borderRadius: '8px',
                }}
              >
                Clear
              </Button>
              {/* The confirm action: it writes the draft back to the field.
                  Contained emphasis because it is the deliberate exit, unlike
                  Escape or clicking away. Disabled on a zero-cost selection so
                  it agrees with the footer warning; the submit button is gated
                  on the same rule. */}
              <Button
                onClick={() => {
                  commit()
                  close()
                }}
                disabled={draftNoWorkingDays}
                sx={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  px: 2,
                  py: '6px',
                  minWidth: 0,
                  minHeight: 0,
                  borderRadius: '9px',
                }}
              >
                Done
              </Button>
            </Stack>
          </Stack>
        </Box>
      )}
    >
      {() => (
        <DayPicker
          mode="range"
          selected={selected}
          onSelect={handleSelect}
          // Put focus straight into the grid so the arrow keys work the moment
          // the calendar opens; otherwise a keyboard user has to tab past the
          // month and year dropdowns to reach any date.
          autoFocus
          numberOfMonths={twoUp ? 2 : 1}
          defaultMonth={value.startDate ? isoToLocalDate(value.startDate) : undefined}
          // Selectable bounds: days outside grey out, and navigation stops at
          // the bounding months (the nav arrows disable at the edges).
          startMonth={minDate ? isoToLocalDate(minDate) : undefined}
          endMonth={maxDate ? isoToLocalDate(maxDate) : undefined}
          disabled={
            minDate || maxDate
              ? [
                  ...(minDate ? [{ before: isoToLocalDate(minDate) }] : []),
                  ...(maxDate ? [{ after: isoToLocalDate(maxDate) }] : []),
                ]
              : undefined
          }
          // Prototype .cal-title: a static centered month label with the
          // prev/next arrows, not dropdown selects.
          captionLayout="label"
          weekStartsOn={1}
          modifiers={modifiers}
          modifiersClassNames={modifiersClassNames}
          labels={sharedDayLabels}
        />
      )}
    </CalendarPopoverField>
  )

  if (!isPill) {
    return field
  }

  // Pill variant: the committed range gets an adjacent clear control
  // (prototype .drf-x) that resets the filter without opening the calendar.
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      {field}
      {hasValue ? (
        <IconButton
          size="small"
          aria-label="Clear the date filter"
          onClick={() => onChange({ startDate: '', endDate: '' })}
          sx={(t) => ({
            width: 26,
            height: 26,
            borderRadius: '8px',
            color: 'text.disabled',
            '&:hover': {
              bgcolor: 'rgba(180, 35, 24, 0.08)',
              color: t.palette.error.main,
            },
          })}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block' }}>
            <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
          </svg>
        </IconButton>
      ) : null}
    </Stack>
  )
}
