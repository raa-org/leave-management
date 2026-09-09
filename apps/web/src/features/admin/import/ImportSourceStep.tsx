/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useState, type ChangeEvent, type DragEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { ImportMode } from '@workspace/contracts'
import { SectionCard } from '../../employee/employee-ui'
import { DateField } from '../../../components/date-picker'
import { tealFocusSx } from '../policy-ui'
import type { ParsedImportWorkbook } from './import-parse'
import { NoticeLine, ghostButtonSx } from './import-wizard-ui'
import { SourceFileGlyph, UploadGlyph } from './import-wizard-glyphs'

const WORKBOOK_PATTERN = /\.xlsx?$/i

// The years an import can sensibly target: around today, plus whatever is
// already picked (so a seeded value outside the window still shows).
const yearChoices = (picked: number): number[] => {
  const current = new Date().getFullYear()
  const window = [current - 1, current, current + 1]
  return window.includes(picked)
    ? window
    : [...window, picked].sort((a, b) => a - b)
}

// Focusable-but-invisible, NOT display:none: a hidden input never receives
// keyboard focus, which left the whole picker mouse-only. With the clip
// pattern the input itself sits in the tab order and Enter/Space opens the
// native dialog; the surrounding zone paints the ring via :focus-within.
const visuallyHiddenInputSx = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

/**
 * Step 1 (prototype Source file card): mode, target year, snapshot date and
 * the workbook itself. Parsing is client-side and instant, so choosing a file
 * is not a phase — the card simply re-renders with what was read.
 */
export function ImportSourceStep({
  mode,
  onModeChange,
  targetYear,
  onTargetYearChange,
  snapshotDate,
  onSnapshotDateChange,
  fileName,
  workbook,
  onFile,
  busy,
  onContinue,
}: {
  mode: ImportMode
  onModeChange: (mode: ImportMode) => void
  targetYear: number
  onTargetYearChange: (year: number) => void
  snapshotDate: string
  onSnapshotDateChange: (date: string) => void
  fileName: string
  workbook: ParsedImportWorkbook
  onFile: (file: File | undefined) => void
  busy: boolean
  onContinue: () => void
}) {
  const hasFile = fileName.length > 0
  const nothingRead =
    workbook.employees.length === 0 && workbook.history.length === 0
  const [dragOver, setDragOver] = useState(false)
  const [dropNote, setDropNote] = useState('')

  const takeFile = (file: File | undefined) => {
    if (!file) {
      return
    }
    if (!WORKBOOK_PATTERN.test(file.name)) {
      setDropNote(`${file.name} is not a workbook; only .xlsx or .xls is read.`)
      return
    }
    setDropNote('')
    onFile(file)
  }

  // Both file surfaces (the dropzone and the chosen-file row) accept a drag:
  // an area that looks like a dropzone must behave like one.
  const dragProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault()
      if (!busy) {
        setDragOver(true)
      }
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDragOver(false)
      if (!busy) {
        takeFile(event.dataTransfer.files?.[0])
      }
    },
  }

  const fileInput = (
    <Box
      component="input"
      type="file"
      accept=".xlsx,.xls"
      sx={visuallyHiddenInputSx}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        takeFile(event.target.files?.[0])
        // The same file must be pickable again after Start over.
        event.target.value = ''
      }}
    />
  )

  return (
    <SectionCard
      title="Source file"
      caption="One workbook with an Employees sheet and a Requests sheet. Employees must already exist in the directory: the import never creates accounts."
      icon={<SourceFileGlyph size={19} />}
      accent="secondary"
    >
      <Stack spacing={2}>
        <Box
          role="radiogroup"
          aria-label="Import mode"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 1.25,
          }}
        >
          {(
            [
              {
                value: 'add' as ImportMode,
                title: 'Add',
                detail: 'Fills what is missing; leave already on record is skipped.',
              },
              {
                value: 'override' as ImportMode,
                title: 'Override (refresh)',
                detail: 'Rebuilds the target year for the employees in the file.',
              },
            ] as const
          ).map((option) => {
            const on = mode === option.value
            return (
              <ButtonBase
                key={option.value}
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => onModeChange(option.value)}
                sx={(theme) => ({
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  gap: 0.5,
                  border: '1.5px solid',
                  borderColor: on ? 'secondary.main' : theme.palette.divider,
                  borderRadius: '12px',
                  px: 1.75,
                  py: 1.5,
                  bgcolor: on
                    ? alpha(theme.palette.secondary.main, 0.08)
                    : 'transparent',
                  boxShadow: on
                    ? `0 0 0 3px ${alpha(theme.palette.secondary.main, 0.08)}`
                    : 'none',
                  '&:hover': { borderColor: 'secondary.main' },
                })}
              >
                <Typography sx={{ fontSize: '13.5px', fontWeight: 800 }}>
                  {option.title}
                </Typography>
                <Typography
                  sx={{ fontSize: '11.5px', color: 'text.secondary', lineHeight: 1.45 }}
                >
                  {option.detail}
                </Typography>
              </ButtonBase>
            )
          })}
        </Box>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{
            ...tealFocusSx,
            // The wizard's field text speaks the card's 13.5px, not MUI's
            // 16px default (prototype .fld input). The label must shrink WITH
            // the outline: the notch the border leaves for it is measured in
            // the outline's em, so a larger label overflows into the border.
            '& .MuiOutlinedInput-root': { fontSize: '13.5px' },
            '& .MuiInputLabel-root': { fontSize: '13.5px' },
            '& .MuiFormHelperText-root': { fontSize: '11.5px' },
          }}
        >
          <TextField
            select
            size="small"
            label="Target year"
            value={targetYear}
            disabled={busy}
            onChange={(event) => onTargetYearChange(Number(event.target.value))}
            sx={{ width: { xs: '100%', sm: 140 } }}
          >
            {yearChoices(targetYear).map((year) => (
              <MenuItem key={year} value={year}>
                {year}
              </MenuItem>
            ))}
          </TextField>
          {/* The house calendar field, not a bare input[type=date]: the wizard
              lives inside the admin workspace and speaks its field language. */}
          <DateField
            label="File snapshot date"
            value={snapshotDate}
            disabled={busy}
            onChange={onSnapshotDateChange}
            helperText="Balances in the file are compared as of this day."
            sx={{ width: { xs: '100%', sm: 220 } }}
          />
        </Stack>

        {hasFile ? (
          <Stack
            direction="row"
            spacing={1.5}
            useFlexGap
            flexWrap="wrap"
            alignItems="center"
            {...dragProps}
            sx={(theme) => ({
              border: '1px solid',
              borderColor: dragOver
                ? 'secondary.main'
                : theme.palette.divider,
              bgcolor: dragOver
                ? alpha(theme.palette.secondary.main, 0.06)
                : 'transparent',
              borderRadius: '12px',
              px: 1.75,
              py: 1.5,
            })}
          >
            <Box
              aria-hidden
              sx={(theme) => ({
                width: 38,
                height: 38,
                borderRadius: '11px',
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.success.main, 0.1),
                color: 'success.main',
                flexShrink: 0,
              })}
            >
              <SourceFileGlyph size={18} />
            </Box>
            <Stack spacing={0.25} sx={{ minWidth: 200, flex: 1 }}>
              <Typography sx={{ fontSize: '13.5px', fontWeight: 800 }}>
                {fileName}
              </Typography>
              <Typography
                sx={{
                  fontSize: '12px',
                  color: 'text.secondary',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {workbook.employees.length} employee
                {workbook.employees.length === 1 ? '' : 's'} ·{' '}
                {workbook.history.length} leave row
                {workbook.history.length === 1 ? '' : 's'}
                {workbook.sheets.employees || workbook.sheets.requests
                  ? ` · read from ${[workbook.sheets.employees, workbook.sheets.requests]
                      .filter(Boolean)
                      .join(' and ')}`
                  : ''}
              </Typography>
            </Stack>
            <Button
              size="small"
              variant="outlined"
              component="label"
              disabled={busy}
              sx={(theme) => ({
                ...ghostButtonSx,
                '&:focus-within': {
                  outline: `2px solid ${theme.palette.secondary.main}`,
                  outlineOffset: 2,
                },
              })}
            >
              Replace file
              {fileInput}
            </Button>
          </Stack>
        ) : (
          <ButtonBase
            component="label"
            disabled={busy}
            {...dragProps}
            sx={(theme) => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              textAlign: 'left',
              gap: 1.5,
              width: '100%',
              border: '1.5px dashed',
              borderColor: dragOver ? 'secondary.main' : theme.palette.divider,
              borderRadius: '12px',
              px: 2,
              py: 2,
              bgcolor: dragOver
                ? alpha(theme.palette.secondary.main, 0.06)
                : alpha(theme.palette.text.primary, 0.015),
              '&:hover': {
                borderColor: 'secondary.main',
                bgcolor: alpha(theme.palette.secondary.main, 0.06),
              },
              // The tab stop is the clipped input inside; the zone paints it.
              '&:focus-within': {
                outline: `2px solid ${theme.palette.secondary.main}`,
                outlineOffset: 2,
              },
            })}
          >
            <Box
              aria-hidden
              sx={(theme) => ({
                width: 38,
                height: 38,
                borderRadius: '11px',
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.secondary.main, 0.1),
                color: 'secondary.main',
                flexShrink: 0,
              })}
            >
              <UploadGlyph size={18} />
            </Box>
            <Stack spacing={0.25}>
              <Typography sx={{ fontSize: '13.5px', fontWeight: 800 }}>
                Choose workbook · .xlsx
              </Typography>
              <Typography sx={{ fontSize: '12px', color: 'text.secondary' }}>
                Drop it here or click to pick. Parsed right in the browser;
                nothing is uploaded yet.
              </Typography>
            </Stack>
            {fileInput}
          </ButtonBase>
        )}

        {dropNote ? <NoticeLine tone="warning">{dropNote}</NoticeLine> : null}

        {workbook.issues.length > 0 ? (
          <NoticeLine tone="warning">
            <b>
              {workbook.issues.length} parse warning
              {workbook.issues.length === 1 ? '' : 's'}
            </b>
            {workbook.issues.slice(0, 8).map((issue) => (
              <span key={`${issue.row}-${issue.message}`}>
                {' '}
                · Row {issue.row}: {issue.message}
              </span>
            ))}
            {workbook.issues.length > 8
              ? ` · and ${workbook.issues.length - 8} more`
              : ''}
          </NoticeLine>
        ) : null}

        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          justifyContent="space-between"
          useFlexGap
          flexWrap="wrap"
        >
          <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
            Nothing is written until the apply step.
          </Typography>
          <Button
            variant="contained"
            color="secondary"
            disabled={nothingRead || busy}
            onClick={onContinue}
          >
            Continue to validation
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  )
}
