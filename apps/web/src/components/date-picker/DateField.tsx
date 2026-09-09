/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { DayPicker } from '@daypicker/react'
import '@daypicker/react/style.css'
import type { SxProps, Theme } from '@mui/material/styles'
import { formatDate } from '../../lib/leave-format'
import { CalendarPopoverField } from './CalendarPopoverField'
import {
  ONE_MONTH_WIDTH,
  sharedDayLabels,
  sharedDayModifiers,
  sharedModifiersClassNames,
} from './CalendarSurface'
import { isoToLocalDate, localDateToIso } from './calendar-dates'

export type DateFieldProps = {
  label: string
  /** 'YYYY-MM-DD', or '' for no date. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  error?: boolean
  helperText?: string
  testId?: string
  /** Accessible name for the input, when the label is not distinctive (repeated rows). */
  ariaLabel?: string
  sx?: SxProps<Theme>
  fullWidth?: boolean
  size?: 'small' | 'medium'
  /** Official-holiday dates ('YYYY-MM-DD') to shade. Off by default. */
  holidayDates?: ReadonlySet<string>
}

/**
 * A single calendar date, replacing a native `type="date"` input.
 *
 * A single pick is unambiguous, so there is no draft/Done model: clicking a day
 * commits it and closes. The value stays a 'YYYY-MM-DD' string end to end.
 */
export function DateField({
  label,
  value,
  onChange,
  disabled = false,
  error = false,
  helperText,
  testId,
  ariaLabel,
  sx,
  fullWidth,
  size,
  holidayDates,
}: DateFieldProps) {
  const displayValue = value ? formatDate(value) : ''
  const shade = holidayDates !== undefined

  // The dropdown caption needs an explicit navigable span, or DayPicker caps the
  // year list at the current year - which blocks picking a future holiday-year
  // date (2027, 2028, …). Give a generous window around today: decades back for
  // employment start dates, years ahead for future holiday calendars.
  const currentYear = new Date().getFullYear()
  const startMonth = new Date(currentYear - 40, 0, 1)
  const endMonth = new Date(currentYear + 20, 11, 31)

  return (
    <CalendarPopoverField
      label={label}
      displayValue={displayValue}
      placeholder="Select date"
      disabled={disabled}
      error={error}
      helperText={helperText}
      testId={testId}
      ariaLabel={ariaLabel}
      sx={sx}
      fullWidth={fullWidth}
      size={size}
      popoverWidth={ONE_MONTH_WIDTH}
    >
      {({ close }) => (
        <DayPicker
          mode="single"
          selected={value ? isoToLocalDate(value) : undefined}
          onSelect={(date) => {
            onChange(date ? localDateToIso(date) : '')
            if (date) {
              close()
            }
          }}
          autoFocus
          defaultMonth={value ? isoToLocalDate(value) : undefined}
          startMonth={startMonth}
          endMonth={endMonth}
          captionLayout="dropdown"
          weekStartsOn={1}
          {...(shade
            ? {
                modifiers: sharedDayModifiers(holidayDates),
                modifiersClassNames: sharedModifiersClassNames,
                labels: sharedDayLabels,
              }
            : {})}
        />
      )}
    </CalendarPopoverField>
  )
}
