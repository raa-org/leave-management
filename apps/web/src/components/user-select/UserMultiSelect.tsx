/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useMemo } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CancelIcon from '@mui/icons-material/Cancel'
import type { SxProps, Theme } from '@mui/material/styles'
import { normalizeEmail } from '@workspace/contracts'
import { filterRecipientOptions } from './recipient-filter'
import {
  recipientEmails,
  recipientLabel,
  resolveRecipientValues,
  toRecipientOptions,
  type RecipientValue,
  type UserOption,
} from './recipient-values'

/** A recipient the server adds on its own; rendered as a non-removable chip. */
export type LockedRecipient = {
  email: string
  displayName?: string
}

const DEFAULT_LOCKED_HINT =
  'Included automatically by company policy. These recipients cannot be removed.'

export type UserMultiSelectProps = {
  label: string
  /** Selected recipient emails (normalized, deduped). */
  value: string[]
  onChange: (value: string[]) => void
  /** Directory of selectable users. Inject it; the component never fetches. */
  options: UserOption[]
  /**
   * Recipients included by policy. They render inside the field in the same
   * style as picked ones, but their delete icon is inert: hovering it explains
   * why in a tooltip (`lockedHint`). They are display-only: not part of
   * `value`, and any removal attempt is silently undone.
   */
  lockedRecipients?: LockedRecipient[]
  /** Tooltip shown on a locked chip's delete icon. */
  lockedHint?: string
  placeholder?: string
  disabled?: boolean
  error?: boolean
  helperText?: string
  testId?: string
  sx?: SxProps<Theme>
  fullWidth?: boolean
  /**
   * Selected-chip appearance (prototype `.chip`). Defaults to `'default'`, the
   * blue MUI treatment every existing employee caller relies on, so their
   * output is unchanged. The admin Settings surface opts into the prototype's
   * neutral pill (`'neutral'`) and the dashed/muted CC pill (`'cc'`).
   */
  chipStyle?: 'default' | 'neutral' | 'cc'
}

// Prototype .chip / .chip.cc: a neutral pill (solid line, ink-2 text, paper
// bg) or the CC variant (dashed line, muted ink-3 text). The remove ✕ turns
// red on hover in both. Applied only when the caller opts in.
function chipStyleSx(style: 'neutral' | 'cc') {
  return {
    borderRadius: '999px',
    border: '1px solid',
    borderColor: 'rgba(16, 24, 40, 0.14)',
    bgcolor: 'background.paper',
    color: style === 'cc' ? '#667085' : '#475467',
    ...(style === 'cc' ? { borderStyle: 'dashed' } : {}),
    '& .MuiChip-deleteIcon': {
      color: '#98a2b3',
      '&:hover': { color: 'error.main' },
    },
  } as const
}

const ignoreLockedDelete = () => {
  // Locked chips keep the delete affordance for visual consistency, but the
  // recipient is enforced server-side; the tooltip on the icon explains why.
}

// Prototype .chip-r: compact pill typography shared by every selected chip.
const chipSx = {
  fontSize: 12.5,
  fontWeight: 700,
} as const

/**
 * Multi-select of system users for approver/CC style fields, replacing
 * free-text email entry. Values stay `string[]` of normalized emails so the
 * component drops into the existing email-based contracts unchanged; the
 * directory only constrains what can be picked. Emails already stored that
 * match no user (legacy free-text entries) still render, as plain email chips
 * that can be removed but not re-selected.
 */
export function UserMultiSelect({
  label,
  value,
  onChange,
  options,
  lockedRecipients,
  lockedHint = DEFAULT_LOCKED_HINT,
  placeholder,
  disabled = false,
  error = false,
  helperText,
  testId,
  sx,
  fullWidth,
  chipStyle = 'default',
}: UserMultiSelectProps) {
  const styleSx = chipStyle === 'default' ? {} : chipStyleSx(chipStyle)
  const pickerOptions = useMemo(() => toRecipientOptions(options), [options])
  const lockedValues = useMemo<RecipientValue[]>(() => {
    const byEmail = new Map<string, RecipientValue>()
    for (const recipient of lockedRecipients ?? []) {
      const email = normalizeEmail(recipient.email)
      if (email.length > 0 && !byEmail.has(email)) {
        byEmail.set(email, {
          email,
          ...(recipient.displayName !== undefined
            ? { displayName: recipient.displayName }
            : {}),
        })
      }
    }
    return Array.from(byEmail.values())
  }, [lockedRecipients])
  const lockedEmails = useMemo(
    () => new Set(lockedValues.map((locked) => locked.email)),
    [lockedValues],
  )
  // Locked chips lead, picked ones follow. The Autocomplete value carries
  // both, but `value`/`onChange` only ever describe the picked subset.
  const displayedValues = useMemo(
    () => [
      ...lockedValues,
      ...resolveRecipientValues(value, options).filter(
        (selected) => !lockedEmails.has(selected.email),
      ),
    ],
    [lockedValues, lockedEmails, value, options],
  )

  return (
    <Autocomplete
      multiple
      filterSelectedOptions
      options={pickerOptions}
      value={displayedValues}
      onChange={(_event, nextValues) => {
        // Dropping a locked chip (backspace, the clear button) is undone here:
        // only non-locked selections reach the caller, and the locked set is
        // re-rendered from props on the next pass.
        onChange(
          recipientEmails(
            nextValues.filter((next) => !lockedEmails.has(next.email)),
          ),
        )
      }}
      getOptionLabel={recipientLabel}
      filterOptions={filterRecipientOptions}
      isOptionEqualToValue={(option, selected) =>
        option.email === selected.email
      }
      disabled={disabled}
      fullWidth={fullWidth}
      sx={sx}
      renderOption={(props, option) => (
        <li {...props} key={option.email}>
          <Stack>
            <Typography variant="body2">{recipientLabel(option)}</Typography>
            <Typography variant="caption" color="text.secondary">
              {option.email}
            </Typography>
          </Stack>
        </li>
      )}
      renderTags={(tagValues, getTagProps) =>
        tagValues.map((option, index) => {
          const { key, ...tagProps } = getTagProps({ index })
          if (lockedEmails.has(option.email)) {
            return (
              <Chip
                key={key}
                {...tagProps}
                size="small"
                label={recipientLabel(option)}
                color={chipStyle === 'default' ? 'primary' : 'default'}
                variant={chipStyle === 'default' ? 'filled' : 'outlined'}
                onDelete={ignoreLockedDelete}
                deleteIcon={
                  <Tooltip title={lockedHint}>
                    <CancelIcon />
                  </Tooltip>
                }
                sx={{
                  ...chipSx,
                  ...styleSx,
                  '& .MuiChip-deleteIcon': {
                    cursor: 'not-allowed',
                    opacity: 0.4,
                    '&:hover': { opacity: 0.4 },
                  },
                }}
                data-testid={testId ? `${testId}-locked` : undefined}
              />
            )
          }
          return (
            <Tooltip key={key} title={option.email}>
              <Chip
                {...tagProps}
                size="small"
                label={recipientLabel(option)}
                color={
                  chipStyle !== 'default'
                    ? 'default'
                    : option.user
                      ? 'primary'
                      : 'default'
                }
                variant={
                  chipStyle !== 'default'
                    ? 'outlined'
                    : option.user
                      ? 'filled'
                      : 'outlined'
                }
                sx={{ ...chipSx, ...styleSx }}
              />
            </Tooltip>
          )
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          error={error}
          helperText={helperText}
          inputProps={{
            ...params.inputProps,
            ...(testId ? { 'data-testid': testId } : {}),
          }}
        />
      )}
    />
  )
}
