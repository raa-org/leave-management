/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../employee/employee-ui'
import { ImportEmployeeCard } from './ImportEmployeeCard'
import type { ImportEmployeeState } from './use-import-run'
import { NoticeLine, ProgressLine } from './import-wizard-ui'
import { ReviewGlyph } from './import-wizard-glyphs'

/**
 * Step 3 (prototype Review card): the computed plans, one employee card each,
 * reusing ImportEmployeeCard unchanged. The header's primary action reads
 * "Apply all" on a fresh preview and "Apply remaining N" once part of the
 * run is already settled (a partial apply or a stopped walk).
 */
export function ImportReviewStep({
  previewing,
  completed,
  total,
  employees,
  error,
  busy,
  peopleCount,
  rowCount,
  applyableCount,
  anySettled,
  onApplyAll,
  onApplyOne,
  hoursPerDay,
}: {
  previewing: boolean
  completed: number
  total: number
  employees: ImportEmployeeState[]
  error?: string
  busy: boolean
  peopleCount: number
  rowCount: number
  applyableCount: number
  anySettled: boolean
  onApplyAll: () => void
  onApplyOne: (email: string) => void
  /** The org's workday, from the validation report the run already holds. */
  hoursPerDay: number
}) {
  return (
    <SectionCard
      title="Review"
      caption="The engine ran the import for real inside a rolled-back transaction, so every number is exact, not an estimate."
      icon={<ReviewGlyph />}
      accent="secondary"
      side={
        applyableCount > 0 ? (
          <Button
            variant="contained"
            color="secondary"
            disabled={busy}
            onClick={onApplyAll}
          >
            {anySettled ? `Apply remaining ${applyableCount}` : 'Apply all'}
          </Button>
        ) : undefined
      }
      sideVariant="control"
    >
      <Stack spacing={2}>
        {previewing ? (
          <ProgressLine
            label={`Computing ${Math.min(completed + 1, total)} of ${total}`}
            done={completed}
            total={total}
          />
        ) : null}
        {error ? <NoticeLine tone="error">{error}</NoticeLine> : null}

        <Stack spacing={1.5}>
          {employees.map((employee) => (
            <ImportEmployeeCard
              key={employee.email}
              employee={employee}
              applyDisabled={busy}
              onApply={onApplyOne}
              hoursPerDay={hoursPerDay}
            />
          ))}
        </Stack>

        <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
          {peopleCount} employee{peopleCount === 1 ? '' : 's'} · {rowCount} row
          {rowCount === 1 ? '' : 's'} read from the file · nothing is written at
          this step.
        </Typography>
      </Stack>
    </SectionCard>
  )
}
