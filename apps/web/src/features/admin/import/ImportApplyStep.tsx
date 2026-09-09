/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink } from 'react-router-dom'
import { CheckGlyph, SectionCard } from '../../employee/employee-ui'
import type { ImportEmployeeState } from './use-import-run'
import type { WizardTallies } from './import-wizard-model'
import {
  ImportStatusPill,
  InitialsBadge,
  NoticeLine,
  ProgressLine,
  ghostButtonSx,
} from './import-wizard-ui'
import { ApplyGlyph } from './import-wizard-glyphs'

const displayNameOf = (employee: ImportEmployeeState): string => {
  const result = employee.result
  if (result && (result.status === 'ok' || result.status === 'applied')) {
    return result.plan.displayName || employee.email
  }
  return employee.email
}

const failureMessageOf = (employee: ImportEmployeeState): string | undefined =>
  employee.result?.status === 'failed' ? employee.result.message : undefined

const skipReasonOf = (employee: ImportEmployeeState): string | undefined =>
  employee.result?.status === 'skipped'
    ? employee.result.reasons.join(' ') || 'Nothing to import.'
    : undefined

// The summary groups people by their identical outcome text: five unknown
// addresses share one skip reason, and five notices differing only by email
// would bury the one that actually says something different.
const groupedByMessage = (
  employees: ImportEmployeeState[],
  messageOf: (employee: ImportEmployeeState) => string | undefined,
  fallback: string,
): Array<{ message: string; names: string[] }> => {
  const groups = new Map<string, string[]>()
  for (const employee of employees) {
    const message = messageOf(employee) ?? fallback
    const names = groups.get(message) ?? []
    names.push(displayNameOf(employee))
    groups.set(message, names)
  }
  return [...groups.entries()].map(([message, names]) => ({ message, names }))
}

/**
 * Step 4 (prototype Apply card + Run finished card): the live walk, one row
 * per employee, then the summary once every employee is settled. A failed
 * RESULT does not stop the walk — only a thrown request error does (surfaced
 * as `error`, with the untouched employees reset to waiting); the copy and
 * the partial-state footer reflect that contract of use-import-run.
 */
export function ImportApplyStep({
  applying,
  progressDone,
  progressTotal,
  employees,
  error,
  tallies,
  runMetaLine,
  remainingCount,
  busy,
  onBackToReview,
  onApplyRemaining,
  onStartNewImport,
}: {
  applying: boolean
  progressDone: number
  progressTotal: number
  employees: ImportEmployeeState[]
  error?: string
  tallies: WizardTallies
  runMetaLine: string
  remainingCount: number
  busy: boolean
  onBackToReview: () => void
  onApplyRemaining: () => void
  onStartNewImport: () => void
}) {
  const finished = tallies.settled && !applying
  const failed = employees.filter(
    (employee) => employee.status === 'failed',
  )
  const skipped = employees.filter(
    (employee) => employee.status === 'skipped',
  )

  return (
    <Stack spacing={2}>
      <SectionCard
        title="Apply"
        caption="Strictly one employee at a time, each in their own transaction. A request error stops the walk; applied employees stay committed."
        icon={<ApplyGlyph />}
        accent="secondary"
      >
        <Stack spacing={2}>
          {applying ? (
            <ProgressLine
              label={`Applying ${Math.min(progressDone + 1, progressTotal)} of ${progressTotal}`}
              done={progressDone}
              total={progressTotal}
            />
          ) : error ? (
            <NoticeLine tone="warning">
              <b>The walk stopped.</b> {error}
            </NoticeLine>
          ) : tallies.done > 0 && !tallies.settled ? (
            <NoticeLine tone="neutral">
              {tallies.done} of {employees.length} applied. The rest are
              untouched and keep their computed preview.
            </NoticeLine>
          ) : null}

          <Stack spacing={1}>
            {employees.map((employee) => {
              const name = displayNameOf(employee)
              const failure = failureMessageOf(employee)
              return (
                <Stack
                  key={employee.email}
                  direction="row"
                  spacing={1.5}
                  alignItems="center"
                  sx={(theme) => ({
                    border: '1px solid',
                    borderColor:
                      employee.status === 'running'
                        ? 'secondary.main'
                        : theme.palette.divider,
                    borderRadius: '12px',
                    px: 1.5,
                    py: 1,
                    bgcolor:
                      employee.status === 'running'
                        ? alpha(theme.palette.secondary.main, 0.04)
                        : 'transparent',
                  })}
                >
                  <InitialsBadge name={name} email={employee.email} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                      component="span"
                      sx={{ fontSize: '13px', fontWeight: 800, mr: 0.75 }}
                    >
                      {name}
                    </Typography>
                    {name !== employee.email ? (
                      <Typography
                        component="span"
                        sx={{ fontSize: '12px', color: 'text.secondary' }}
                      >
                        {employee.email}
                      </Typography>
                    ) : null}
                    {failure ? (
                      <Typography
                        sx={{
                          fontSize: '12px',
                          fontWeight: 700,
                          color: 'error.main',
                        }}
                      >
                        {failure}
                      </Typography>
                    ) : null}
                  </Box>
                  {employee.status === 'running' ? (
                    <CircularProgress size={14} color="secondary" />
                  ) : null}
                  <ImportStatusPill status={employee.status} />
                </Stack>
              )
            })}
          </Stack>

          {!applying && !finished ? (
            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              justifyContent="space-between"
              useFlexGap
              flexWrap="wrap"
            >
              <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
                {remainingCount} employee{remainingCount === 1 ? '' : 's'} still
                {remainingCount === 1 ? ' has' : ' have'} a computed preview
                waiting.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={onBackToReview}
                  sx={ghostButtonSx}
                >
                  Back to review
                </Button>
                <Button
                  variant="contained"
                  color="secondary"
                  disabled={busy || remainingCount === 0}
                  onClick={onApplyRemaining}
                >
                  Apply remaining {remainingCount}
                </Button>
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      </SectionCard>

      {finished ? (
        <SectionCard
          title="Run finished"
          caption={runMetaLine}
          icon={<CheckGlyph size={19} />}
          iconTone="success"
          accent="secondary"
        >
          <Stack spacing={2}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 1.25,
              }}
            >
              {(
                [
                  { value: tallies.applied, label: 'applied', color: 'success.main' },
                  { value: tallies.skipped, label: 'skipped', color: 'warning.main' },
                  { value: tallies.failed, label: 'failed', color: 'error.main' },
                ] as const
              ).map((cell) => (
                <Box
                  key={cell.label}
                  sx={(theme) => ({
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: '12px',
                    px: 1.75,
                    py: 1.25,
                    textAlign: 'center',
                  })}
                >
                  <Typography
                    sx={{
                      fontSize: '22px',
                      fontWeight: 800,
                      fontVariantNumeric: 'tabular-nums',
                      color: cell.value > 0 ? cell.color : 'text.primary',
                    }}
                  >
                    {cell.value}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: '11px',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'text.secondary',
                    }}
                  >
                    {cell.label}
                  </Typography>
                </Box>
              ))}
            </Box>

            {groupedByMessage(failed, failureMessageOf, 'The apply failed.').map(
              (group) => (
                <NoticeLine key={`f-${group.message}`} tone="error">
                  <b>{group.names.join(', ')}</b> · {group.message} Resolve the
                  conflict and run a fresh import for them; everyone applied is
                  already committed.
                </NoticeLine>
              ),
            )}
            {groupedByMessage(skipped, skipReasonOf, 'Nothing to import.').map(
              (group) => (
                <NoticeLine key={`s-${group.message}`} tone="warning">
                  <b>{group.names.join(', ')}</b> · skipped: {group.message}
                </NoticeLine>
              ),
            )}

            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              justifyContent="space-between"
              useFlexGap
              flexWrap="wrap"
            >
              <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
                The run was written to the audit log as one entry.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  component={RouterLink}
                  to="/admin/activity/audit"
                  sx={ghostButtonSx}
                >
                  View in audit log
                </Button>
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={onStartNewImport}
                >
                  Start new import
                </Button>
              </Stack>
            </Stack>
          </Stack>
        </SectionCard>
      ) : null}
    </Stack>
  )
}
