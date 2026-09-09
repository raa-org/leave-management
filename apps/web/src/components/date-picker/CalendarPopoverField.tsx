/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useRef, useState, type ReactNode } from 'react'
import type { SxProps, Theme } from '@mui/material/styles'
import { alpha } from '@mui/material/styles'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import FormHelperText from '@mui/material/FormHelperText'
import Popover from '@mui/material/Popover'
import TextField from '@mui/material/TextField'
import { CalendarSurface } from './CalendarSurface'

export type CalendarPopoverApi = { close: () => void }

export type CalendarPopoverFieldProps = {
  label: string
  /** Formatted value shown in the read-only trigger, or '' for the placeholder. */
  displayValue: string
  placeholder?: string
  disabled?: boolean
  error?: boolean
  helperText?: string
  testId?: string
  /** Accessible name for the input, when the label is not distinctive (repeated rows). */
  ariaLabel?: string
  /** Applied to the trigger TextField root (field variant only). */
  sx?: SxProps<Theme>
  fullWidth?: boolean
  size?: 'small' | 'medium'
  /**
   * Palette of the trigger's focused outline and floating label (field variant
   * only). Defaults to MUI's `primary`, which this app reserves for navigation
   * state — a filter row built from `color="secondary"` controls has to pass it
   * here too, or this one field focuses blue among teal neighbours.
   */
  color?: 'primary' | 'secondary'
  /**
   * Trigger look: 'field' is the labeled form field (composer, admin forms);
   * 'pill' is the prototype .drf filter button — "Label · value" in a compact
   * bordered pill that lights up primary while a value is committed.
   */
  variant?: 'field' | 'pill'
  /** Fixed popover width (one or two months), so it never resizes with content. */
  popoverWidth: number
  /** Runs before the popover opens (e.g. to seed a draft from the committed value). */
  onOpen?: () => void
  /** The calendar; rendered inside the themed CalendarSurface. */
  children: (api: CalendarPopoverApi) => ReactNode
  /** Optional footer below the calendar (legend, working-day count, Done/Clear). */
  footer?: (api: CalendarPopoverApi) => ReactNode
}

/**
 * The shared shell for both pickers: a read-only trigger that opens a themed
 * calendar in a popover. Holds the open state and anchor; the caller supplies
 * the calendar (and an optional footer) and closes via the `close` handle.
 * Escape and clicking away close through the popover's own onClose.
 */
export function CalendarPopoverField({
  label,
  displayValue,
  placeholder = 'Select date(s)',
  disabled = false,
  error = false,
  helperText,
  testId,
  ariaLabel,
  sx,
  fullWidth,
  size,
  color,
  variant = 'field',
  popoverWidth,
  onOpen,
  children,
  footer,
}: CalendarPopoverFieldProps) {
  // The popover anchors to the whole trigger, so it lines up with the outline
  // rather than with the text box inside it.
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  const openCalendar = () => {
    if (disabled) {
      return
    }
    onOpen?.()
    setOpen(true)
  }

  const close = () => setOpen(false)
  const isPill = variant === 'pill'
  const pillActive = isPill && displayValue !== ''

  return (
    <>
      {isPill ? (
        <Box ref={fieldRef} sx={{ display: 'inline-flex', flexDirection: 'column' }}>
          <ButtonBase
            onClick={openCalendar}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={ariaLabel ?? label}
            data-testid={testId}
            sx={(theme) => ({
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              fontSize: 13,
              fontWeight: 700,
              px: '13px',
              py: '8px',
              borderRadius: '11px',
              border: '1px solid',
              whiteSpace: 'nowrap',
              transition: 'all .15s ease',
              ...(pillActive
                ? {
                    borderColor: 'primary.main',
                    color: 'primary.main',
                    bgcolor: alpha(theme.palette.primary.main, 0.08),
                    boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.08)}`,
                  }
                : {
                    borderColor: 'rgba(16, 24, 40, 0.14)',
                    color: 'text.secondary',
                    bgcolor: 'background.paper',
                    '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
                  }),
            })}
          >
            {/* Prototype .drf calendar glyph. */}
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block' }}>
              <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth={1.8} />
              <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
            </svg>
            {label} · {displayValue === '' ? 'any' : displayValue}
          </ButtonBase>
          {helperText ? <FormHelperText error={error}>{helperText}</FormHelperText> : null}
        </Box>
      ) : (
        <TextField
          ref={fieldRef}
          label={label}
          value={displayValue}
          placeholder={placeholder}
          disabled={disabled}
          error={error}
          helperText={helperText}
          fullWidth={fullWidth}
          size={size}
          color={color}
          sx={sx}
          onClick={openCalendar}
          InputLabelProps={{ shrink: true }}
          InputProps={{ readOnly: true }}
          inputProps={{
            'data-testid': testId,
            'aria-label': ariaLabel,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            // On the INPUT, not on the TextField: TextField forwards unknown
            // props to the FormControl root, and a handler there never sees the
            // key the way this needs to. Without it the field is mouse-only.
            onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openCalendar()
              }
            },
            style: { cursor: disabled ? undefined : 'pointer' },
          }}
        />
      )}

      <Popover
        open={open}
        anchorEl={fieldRef.current}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: isPill ? 'right' : 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: isPill ? 'right' : 'left' }}
        slotProps={{
          paper: {
            // Prototype .cal-pop: rounded 16, hairline border, deep soft shadow.
            sx: {
              mt: 1,
              borderRadius: '16px',
              overflow: 'hidden',
              width: popoverWidth,
              maxWidth: 'calc(100vw - 32px)',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow:
                '0 24px 60px -18px rgba(16, 24, 40, 0.28), 0 2px 8px rgba(16, 24, 40, 0.06)',
            },
          },
        }}
      >
        <CalendarSurface>{children({ close })}</CalendarSurface>
        {footer ? footer({ close }) : null}
      </Popover>
    </>
  )
}
