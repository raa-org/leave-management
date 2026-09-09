/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { LeaveType } from '@workspace/contracts'
import type { ImportEmployeePlanDto } from '@workspace/contracts'
import { formatDayMonth } from './import-wizard-model'
import { floorDays, formatDays } from '../../../lib/leave-format'
import {
  ImportStatusPill,
  InitialsBadge,
  NoticeLine,
  ghostButtonSx,
} from './import-wizard-ui'
import type { ImportEmployeeState } from './use-import-run'

/**
 * One employee's card in the Review step (prototype .ecard): what the run
 * computed for them, and the button that commits it. The numbers here come
 * from the engine having actually done the work (inside a rolled-back
 * transaction), so nothing on this card is an estimate.
 */
export function ImportEmployeeCard({
  employee,
  onApply,
  applyDisabled,
  hoursPerDay,
}: {
  employee: ImportEmployeeState
  onApply: (email: string) => void
  applyDisabled?: boolean
  /** The org's workday, off the validation report. The reconciliation rows
   *  judge a gap against the hour grid it defines, so it is taken from the run
   *  rather than from the shared display fallback. */
  hoursPerDay: number
}) {
  const plan = planOf(employee)
  const name = plan?.displayName || employee.email
  return (
    <Box
      sx={(theme) => ({
        border: '1px solid',
        borderColor:
          employee.status === 'running'
            ? 'secondary.main'
            : theme.palette.divider,
        borderRadius: '14px',
        bgcolor: 'background.paper',
      })}
    >
      <Stack
        direction="row"
        spacing={1.25}
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        sx={{ px: 2, py: 1.5 }}
      >
        <InitialsBadge name={name} email={employee.email} />
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="span"
            sx={{ fontSize: '13.5px', fontWeight: 800, mr: 0.75 }}
          >
            {name}
          </Typography>
          {plan?.displayName ? (
            <Typography
              component="span"
              sx={{ fontSize: '12px', color: 'text.secondary' }}
            >
              {employee.email}
            </Typography>
          ) : null}
        </Box>
        {plan ? (
          <>
            <HeaderChip
              tinted={plan.policy.willBeCreated}
              label={plan.policy.policyName}
            />
            {plan.policy.willBeCreated ? (
              <HeaderChip tinted label="policy will be created" />
            ) : null}
            {plan.policy.keptExisting ? (
              <HeaderChip label="existing enrollment kept" />
            ) : null}
            {plan.employmentStartDate ? (
              <HeaderChip
                label={`hire date ${formatDayMonth(plan.employmentStartDate)} ${plan.employmentStartDate.slice(0, 4)}`}
              />
            ) : null}
            {plan.carriedOverVacationDays > 0 ? (
              <HeaderChip
                label={`${formatDays(plan.carriedOverVacationDays)} carried in`}
              />
            ) : null}
          </>
        ) : null}
        <Box sx={{ flex: 1 }} />
        {employee.status === 'running' ? (
          <CircularProgress size={14} color="secondary" />
        ) : null}
        <ImportStatusPill status={employee.status} />
        {employee.status === 'previewed' ? (
          // The prototype's ghost, not a contained blue: the card sits under
          // a contained teal "Apply all", and the per-employee action is the
          // quieter of the two.
          <Button
            size="small"
            variant="outlined"
            onClick={() => onApply(employee.email)}
            disabled={applyDisabled}
            sx={ghostButtonSx}
          >
            Apply
          </Button>
        ) : null}
      </Stack>

      {employee.result?.status === 'skipped' || employee.result?.status === 'failed' || plan ? (
        <Stack
          spacing={1.25}
          sx={(theme) => ({
            borderTop: `1px solid ${theme.palette.divider}`,
            px: 2,
            py: 1.5,
          })}
        >
          {employee.result?.status === 'skipped' ? (
            <NoticeLine tone="warning">
              <b>Skipped</b> ·{' '}
              {employee.result.reasons.join(' ') || 'Nothing to import.'}
            </NoticeLine>
          ) : null}
          {employee.result?.status === 'failed' ? (
            <NoticeLine tone="error">
              <b>Failed</b> · {employee.result.message}
            </NoticeLine>
          ) : null}
          {plan ? <PlanBody plan={plan} hoursPerDay={hoursPerDay} /> : null}
        </Stack>
      ) : null}
    </Box>
  )
}

// Whether a reconciliation gap is float dust rather than a disagreement.
// An HOUR, not a day: leave is bookable by the hour, so nothing finer than one
// can be entered on either side, and the old whole-day threshold called a
// seven-hour discrepancy a rounding artifact and left the row unhighlighted.
function isRoundingDust(delta: number, hoursPerDay: number): boolean {
  return floorDays(Math.abs(delta), hoursPerDay) === 0
}

function PlanBody({
  plan,
  hoursPerDay,
}: {
  plan: ImportEmployeePlanDto
  hoursPerDay: number
}) {
  return (
    <>
      {plan.requests.length > 0 ? (
        <Stack spacing={0.5}>
          <MiniLabel text="Leave" />
          {plan.requests.map((request) => (
            <RowLine
              key={`${request.startDate}-${request.endDate}-${request.leaveType}`}
              muted={request.status === 'skipped'}
            >
              {formatDayMonth(request.startDate)} to{' '}
              {formatDayMonth(request.endDate)} ·{' '}
              {request.leaveType === LeaveType.Vacation ? 'vacation' : 'sick'} ·{' '}
              {request.status === 'skipped'
                ? (request.reason ?? 'skipped')
                : `${formatDays(request.workingDays)} of leave${
                    request.unpaidDays > 0
                      ? `, ${formatDays(request.unpaidDays)} unpaid`
                      : ''
                  }`}
            </RowLine>
          ))}
        </Stack>
      ) : null}

      {plan.reconciliation.length > 0 ? (
        <Stack spacing={0.5}>
          <MiniLabel text="Balances" />
          {plan.reconciliation.map((entry) => {
            const off =
              entry.delta !== undefined &&
              !isRoundingDust(entry.delta, hoursPerDay)
            return (
              <RowLine key={entry.leaveType} warn={off}>
                {entry.leaveType === LeaveType.Vacation ? 'Vacation' : 'Sick'}:{' '}
                {formatDays(entry.computedBalance)} on{' '}
                {formatDayMonth(entry.asOf)} {entry.asOf.slice(0, 4)}
                {entry.committedDays > 0
                  ? `, ${formatDays(entry.committedDays)} already booked for later`
                  : ''}
                {entry.expectedBalance !== undefined
                  ? ` (file says ${formatDays(entry.expectedBalance)}${
                      entry.delta
                        ? isRoundingDust(entry.delta, hoursPerDay)
                          ? ', the same balance once rounded to the hour'
                          : `, off by ${entry.delta > 0 ? '+' : ''}${formatDays(entry.delta)}`
                        : ', matches'
                    })`
                  : ''}
              </RowLine>
            )
          })}
        </Stack>
      ) : null}

      {plan.issues.map((issue, index) => (
        <NoticeLine
          key={`${issue.message}-${index}`}
          tone={issue.severity === 'error' ? 'error' : 'warning'}
        >
          {issue.message}
        </NoticeLine>
      ))}
    </>
  )
}

function HeaderChip({ label, tinted }: { label: string; tinted?: boolean }) {
  return (
    <Box
      component="span"
      sx={(theme) => ({
        fontSize: '11px',
        fontWeight: 700,
        borderRadius: 999,
        px: 1.1,
        py: 0.3,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        ...(tinted
          ? {
              color: 'secondary.main',
              border: `1px solid ${alpha(theme.palette.secondary.main, 0.35)}`,
              bgcolor: alpha(theme.palette.secondary.main, 0.08),
            }
          : {
              color: 'text.secondary',
              border: `1px solid ${theme.palette.divider}`,
            }),
      })}
    >
      {label}
    </Box>
  )
}

function MiniLabel({ text }: { text: string }) {
  return (
    <Typography
      sx={{
        fontSize: '10.5px',
        fontWeight: 800,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'text.disabled',
      }}
    >
      {text}
    </Typography>
  )
}

function RowLine({
  children,
  muted,
  warn,
}: {
  children: ReactNode
  muted?: boolean
  warn?: boolean
}) {
  return (
    <Typography
      sx={{
        fontSize: '12.5px',
        lineHeight: 1.55,
        fontVariantNumeric: 'tabular-nums',
        color: warn ? 'warning.main' : muted ? 'text.disabled' : 'text.primary',
        fontWeight: warn ? 700 : 400,
      }}
    >
      {children}
    </Typography>
  )
}

const planOf = (
  employee: ImportEmployeeState,
): ImportEmployeePlanDto | undefined =>
  employee.result?.status === 'ok' || employee.result?.status === 'applied'
    ? employee.result.plan
    : undefined
