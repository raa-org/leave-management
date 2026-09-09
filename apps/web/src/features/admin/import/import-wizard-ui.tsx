/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { ImportEmployeeState } from './use-import-run'

/**
 * Presentational atoms shared by the import wizard's step panels. They exist
 * so the four panels stay declarative: every bordered notice line, stat tile
 * and status pill renders through one place, which is also the one place that
 * has to match the prototype (admin-import-rail.html) it was ported from.
 */

/**
 * The prototype's .btn.ghost: neutral border and ink until hover, teal after
 * (the same hover language DaysStepper's -/+ buttons speak). MUI's outlined
 * secondary is teal at rest, which reads as a second primary; every quiet
 * action in the wizard wears this instead.
 */
export const ghostButtonSx = {
  border: '1px solid rgba(16, 24, 40, 0.14)',
  color: 'text.secondary',
  fontWeight: 700,
  '&:hover': {
    borderColor: 'secondary.main',
    color: 'secondary.main',
    bgcolor: 'rgba(15, 118, 110, 0.08)',
  },
} as const

export function ProgressLine({
  label,
  done,
  total,
}: {
  label: string
  done: number
  total: number
}) {
  // A one-unit run would pin a determinate bar at 0% for its whole duration,
  // which reads as "nothing is happening" — exactly what a progress line is
  // there to deny. With no granularity to show, show motion instead.
  const indeterminate = total <= 1
  return (
    <Stack spacing={0.75}>
      <Typography
        sx={{
          fontSize: '12px',
          fontWeight: 700,
          color: 'text.secondary',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {label}
      </Typography>
      <LinearProgress
        color="secondary"
        {...(indeterminate
          ? { variant: 'indeterminate' as const }
          : {
              variant: 'determinate' as const,
              value: (done / Math.max(total, 1)) * 100,
            })}
        sx={{ borderRadius: 999, height: 6 }}
      />
    </Stack>
  )
}

export type NoticeTone = 'neutral' | 'warning' | 'error' | 'success'

/**
 * One bordered notice line (prototype .notice/.wline/.eline/.gline). Unlike an
 * MUI Alert it has no icon and no role="alert" chatter, which matters in a
 * panel that can render twenty of them from one validation report.
 */
export function NoticeLine({
  tone = 'neutral',
  children,
}: {
  tone?: NoticeTone
  children: ReactNode
}) {
  return (
    <Box
      sx={(theme) => {
        const main =
          tone === 'warning'
            ? theme.palette.warning.main
            : tone === 'error'
              ? theme.palette.error.main
              : tone === 'success'
                ? theme.palette.success.main
                : theme.palette.text.primary
        return {
          border: '1px solid',
          borderColor:
            tone === 'neutral' ? theme.palette.divider : alpha(main, 0.3),
          bgcolor:
            tone === 'neutral' ? alpha(main, 0.015) : alpha(main, 0.06),
          borderRadius: '10px',
          px: 1.5,
          py: 1,
          fontSize: '12.5px',
          lineHeight: 1.55,
          color: 'text.primary',
          '& b': {
            color: tone === 'neutral' ? 'text.primary' : main,
          },
        }
      }}
    >
      {children}
    </Box>
  )
}

/** Validation summary tiles (prototype .vstat): a count with a short label. */
export function StatTile({
  value,
  label,
  tone = 'neutral',
}: {
  value: number
  label: string
  tone?: 'neutral' | 'ok' | 'warn'
}) {
  return (
    <Box
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: '10px',
        px: 1.5,
        py: 0.75,
        fontSize: '12.5px',
        fontWeight: 600,
        color: 'text.secondary',
        whiteSpace: 'nowrap',
        '& b': {
          fontSize: '14px',
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          color:
            tone === 'ok'
              ? theme.palette.secondary.main
              : tone === 'warn' && value > 0
                ? theme.palette.warning.main
                : theme.palette.text.primary,
        },
      })}
    >
      <b>{value}</b> {label}
    </Box>
  )
}

const STATUS_LABEL: Record<ImportEmployeeState['status'], string> = {
  pending: 'waiting',
  running: 'working',
  previewed: 'previewed',
  applied: 'applied',
  skipped: 'skipped',
  failed: 'failed',
}

/**
 * The per-employee status pill of the apply ticker. ImportEmployeeCard keeps
 * its own MUI Chip variant; this one matches the prototype's flat .stt pill
 * and stays local to the wizard so neither leaks into the other's tests.
 */
export function ImportStatusPill({
  status,
}: {
  status: ImportEmployeeState['status']
}) {
  return (
    <Box
      component="span"
      sx={(theme) => {
        // Applied is success green, previewed stays teal: in the ticker a
        // committed employee must read differently from a merely computed one
        // (the prototype's .stt.ok vs .stt.prev).
        const main =
          status === 'applied'
            ? theme.palette.success.main
            : status === 'previewed'
              ? theme.palette.secondary.main
              : status === 'skipped'
                ? theme.palette.warning.main
                : status === 'failed'
                  ? theme.palette.error.main
                  : theme.palette.text.secondary
        // Lowercase like the prototype's .stt pills: the ticker repeats this
        // pill on every row, and eight uppercase stamps read as shouting.
        return {
          flexShrink: 0,
          fontSize: '11px',
          fontWeight: 700,
          borderRadius: 999,
          px: 1.25,
          py: 0.4,
          border: `1px solid ${status === 'pending' || status === 'running' ? theme.palette.divider : alpha(main, 0.35)}`,
          color: status === 'pending' || status === 'running' ? 'text.secondary' : main,
          bgcolor:
            status === 'pending' || status === 'running'
              ? 'transparent'
              : alpha(main, 0.08),
        }
      }}
    >
      {STATUS_LABEL[status]}
    </Box>
  )
}

// A stable, distinct badge color per person, keyed on the email so the ticker
// and the review cards agree. Same trick the settings page plays for country
// badges: deterministic assignment beats storing a color anywhere.
const AVATAR_COLORS = [
  '#155eef',
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#b42318',
  '#0891b2',
  '#15803d',
  '#c2410c',
]

export function avatarColor(email: string): string {
  let hash = 0
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] as string
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function InitialsBadge({ name, email }: { name: string; email: string }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: 30,
        height: 30,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        fontSize: '11px',
        fontWeight: 800,
        color: '#fff',
        bgcolor: avatarColor(email),
      }}
    >
      {initialsOf(name || email)}
    </Box>
  )
}
