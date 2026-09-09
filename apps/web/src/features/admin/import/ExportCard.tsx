/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { SectionCard } from '../../employee/employee-ui'
import { adminApi, type AdminApiClient } from '../admin-api'
import { tealFocusSx } from '../policy-ui'
import { NoticeLine, ProgressLine } from './import-wizard-ui'
import { DownloadGlyph } from './import-wizard-glyphs'
import { useExportRun } from './use-export-run'

/**
 * The export half of the Settings "Import and export" tab (prototype Export
 * workbook card): a year, three include toggles, one download. The sheets are
 * written the way the import reads them, so the natural use is a snapshot
 * right before an Override run, or handing the tracker back to HR.
 */

interface IncludeRow {
  key: 'employees' | 'balances' | 'history'
  title: string
  detail: string
}

export function ExportCard({
  api = adminApi,
}: {
  api?: AdminApiClient
}) {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [includeEmployees, setIncludeEmployees] = useState(true)
  const [includeBalances, setIncludeBalances] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(true)
  const { state, start } = useExportRun(api)

  const nothingPicked = !includeEmployees && !includeHistory
  const fetching = state.phase === 'fetching'

  const includeRows: Array<
    IncludeRow & { checked: boolean; onToggle: () => void }
  > = [
    {
      key: 'employees',
      title: 'Employees and policies',
      detail: 'Names, emails, hire dates and the policy terms each person is on.',
      checked: includeEmployees,
      onToggle: () => setIncludeEmployees((value) => !value),
    },
    {
      key: 'balances',
      title: 'Balances as of today',
      detail: 'Expected vacation and sick balances, for reconciliation on re-import.',
      checked: includeBalances,
      onToggle: () => setIncludeBalances((value) => !value),
    },
    {
      key: 'history',
      title: 'Leave history',
      detail: 'Every approved request in the year, one row each, with working days counted.',
      checked: includeHistory,
      onToggle: () => setIncludeHistory((value) => !value),
    },
  ]

  return (
    <SectionCard
      title="Export workbook"
      caption="Take a snapshot before an override run, or hand the tracker back to HR. The workbook matches the import format."
      icon={<DownloadGlyph size={19} />}
      accent="secondary"
    >
      <Stack spacing={2}>
        <TextField
          select
          size="small"
          label="Year"
          value={year}
          disabled={fetching}
          onChange={(event) => setYear(Number(event.target.value))}
          sx={{
            width: 140,
            ...tealFocusSx,
            '& .MuiOutlinedInput-root': { fontSize: '13.5px' },
            '& .MuiInputLabel-root': { fontSize: '13.5px' },
          }}
        >
          {[currentYear - 1, currentYear].map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>

        <Stack spacing={1}>
          <Typography
            sx={{
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'text.disabled',
            }}
          >
            What to include
          </Typography>
          {includeRows.map((row) => (
            <Box
              key={row.key}
              component="label"
              sx={(theme) => ({
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1,
                border: '1.5px solid',
                borderColor: row.checked
                  ? 'secondary.main'
                  : theme.palette.divider,
                borderRadius: '12px',
                px: 1.5,
                py: 1.25,
                cursor: fetching ? 'default' : 'pointer',
                bgcolor: row.checked
                  ? alpha(theme.palette.secondary.main, 0.05)
                  : 'transparent',
              })}
            >
              <Checkbox
                size="small"
                color="secondary"
                checked={row.checked}
                disabled={fetching}
                onChange={row.onToggle}
                sx={{ p: 0.25, mt: '-1px' }}
              />
              <Stack spacing={0.25}>
                <Typography sx={{ fontSize: '13px', fontWeight: 800 }}>
                  {row.title}
                </Typography>
                <Typography
                  sx={{ fontSize: '11.5px', color: 'text.secondary', lineHeight: 1.45 }}
                >
                  {row.detail}
                </Typography>
              </Stack>
            </Box>
          ))}
        </Stack>

        {fetching ? (
          <ProgressLine
            label={
              state.total > 0
                ? `Fetching employee ${Math.min(state.completed + 1, state.total)} of ${state.total}`
                : 'Listing employees'
            }
            done={state.completed}
            total={state.total}
          />
        ) : null}

        {state.phase === 'done' && state.summary ? (
          <NoticeLine tone="success">
            <b>{state.summary.fileName}</b> is ready · {state.summary.employees}{' '}
            employee{state.summary.employees === 1 ? '' : 's'},{' '}
            {state.summary.requests} leave row
            {state.summary.requests === 1 ? '' : 's'}.
            {state.summary.leftOut.length > 0
              ? ` Left out of the Employees sheet (no start date or no policy terms to write): ${state.summary.leftOut.join(', ')}.`
              : ''}
          </NoticeLine>
        ) : null}
        {state.phase === 'error' ? (
          <NoticeLine tone="error">{state.error}</NoticeLine>
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
            {nothingPicked
              ? includeBalances
                ? 'Balances live in the Employees sheet; include employees and policies to export them.'
                : 'Pick at least one thing to include.'
              : 'Sheets are written the way the import reads them, so a round trip is lossless.'}
          </Typography>
          <Button
            variant="contained"
            color="secondary"
            disabled={nothingPicked || fetching}
            onClick={() =>
              void start({
                year,
                includeEmployees,
                includeBalances,
                includeHistory,
              })
            }
          >
            Download workbook
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  )
}
