/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import LinearProgress from '@mui/material/LinearProgress'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import type {
  AdminEmployeeListItemDto,
  LeavePolicyDto,
  PolicyTransferMode,
  TransferEmployeePolicyDto,
} from '@workspace/contracts'
import { DateField } from '../../components/date-picker'
import { ApproverAvatar } from '../employee/employee-ui'
import { SelectAllCheckbox } from './policy-ui'
import type { AdminApiClient } from './admin-api'
import {
  apiErrorDetails,
  batchPreflightSummary,
  initialTransferSelection,
  effectiveDateHint,
  moveResultSummary,
  transferModeCopy,
  type BatchPreflightEntry,
  type MoveOutcome,
} from './policy-format'

// Moving a group of employees onto one policy. The engine has no bulk
// endpoint and could not have one honestly: the committed-days guard is
// per-person, so a batch is a set of independent transfers whose refusals
// must be reported individually. This dialog dry-runs each employee, states
// the outcome before the write, and reports partial success afterwards.

// How many refusals are named before the rest are counted.
const BLOCKED_SHOWN = 5

export function AdminPolicyMoveDialog({
  api,
  targetPolicy,
  employees,
  intent,
  today,
  onClose,
  onDone,
}: {
  api: AdminApiClient
  targetPolicy: LeavePolicyDto
  // Everyone the caller offered: for "add", people from other policies; for
  // "move", the members already picked in the list.
  employees: AdminEmployeeListItemDto[]
  /**
   * Which question the dialog is asking. 'add' offers the directory and starts
   * with nobody picked, because picking is the whole point. 'move' arrives with
   * the choice already made in the member list, so re-asking would make the
   * admin select the same people twice -- and with a single member there was
   * nothing on screen to select at all, leaving the confirm permanently dead.
   */
  intent: 'add' | 'move'
  today: string
  onClose: () => void
  onDone: () => void
}) {
  // 'add' starts empty: pre-selecting a whole directory fired a dry run per
  // person on open and answered with a hundred refusals nobody asked for.
  // 'move' starts full: those people were just chosen in the member list.
  const [selected, setSelected] = useState<string[]>(() =>
    initialTransferSelection(
      intent,
      employees.map((employee) => employee.employeeId),
    ),
  )
  const [query, setQuery] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [mode, setMode] = useState<PolicyTransferMode>('prospective')
  const [preflight, setPreflight] = useState<BatchPreflightEntry[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [earliestOffer, setEarliestOffer] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<MoveOutcome[] | null>(null)

  const isBackdated = effectiveDate !== '' && effectiveDate < today
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? employees.filter((employee) =>
          `${employee.displayName} ${employee.email}`
            .toLowerCase()
            .includes(needle),
        )
      : employees
  }, [employees, query])
  const picked = useMemo(
    () =>
      employees.filter((employee) => selected.includes(employee.employeeId)),
    [employees, selected],
  )

  // One dry run per selected employee whenever the inputs that decide it
  // change. Cancelled by the `active` flag so a slow batch cannot overwrite a
  // newer answer.
  useEffect(() => {
    if (picked.length === 0 || !effectiveDate || outcomes) {
      setPreflight(null)
      return
    }
    let active = true
    setChecking(true)
    const body: TransferEmployeePolicyDto = {
      policyId: targetPolicy.policyId,
      effectiveDate,
      ...(isBackdated ? { mode } : {}),
    }
    void Promise.all(
      picked.map((employee) =>
        api
          .preflightPolicyTransfer(employee.employeeId, body)
          .then((result) => ({
            employeeId: employee.employeeId,
            displayName: employee.displayName,
            feasible: result.feasible,
            blockingRequests: result.blockingRequests,
            probationWarnings: result.probationWarnings,
          }))
          .catch((error: unknown) => {
            const details = apiErrorDetails(error)
            if (details.kind === 'backdateOutOfRange' && active) {
              setEarliestOffer(details.earliestPermissibleDate)
            }
            return {
              employeeId: employee.employeeId,
              displayName: employee.displayName,
              feasible: false,
              blockingRequests: [],
              probationWarnings: [],
              refusal: details.message,
            } satisfies BatchPreflightEntry
          }),
      ),
    ).then((entries) => {
      if (!active) {
        return
      }
      // Refusals ride along on the entries themselves, so the blocked list
      // reports each one against the person it belongs to instead of hoisting
      // the first into a banner that says nothing about who it is about.
      setPreflight(entries)
      setChecking(false)
    })
    return () => {
      active = false
    }
  }, [api, effectiveDate, isBackdated, mode, outcomes, picked, targetPolicy.policyId])

  const summary = preflight ? batchPreflightSummary(preflight) : null

  const run = async () => {
    setRunning(true)
    const movable = (preflight ?? []).filter((entry) => entry.feasible)
    const results: MoveOutcome[] = []
    // Sequential on purpose: each transfer takes per-user advisory locks and
    // posts ledger rows, and a serial pass makes every refusal attributable.
    for (const entry of movable) {
      try {
        await api.transferEmployeePolicy(entry.employeeId, {
          policyId: targetPolicy.policyId,
          effectiveDate,
          ...(isBackdated ? { mode } : {}),
        })
        results.push({ displayName: entry.displayName })
      } catch (error) {
        results.push({
          displayName: entry.displayName,
          error: apiErrorDetails(error).message,
        })
      }
    }
    for (const entry of (preflight ?? []).filter((item) => !item.feasible)) {
      results.push({
        displayName: entry.displayName,
        error: 'Blocked by committed leave days.',
      })
    }
    setOutcomes(results)
    setRunning(false)
  }

  if (outcomes) {
    const result = moveResultSummary(outcomes, targetPolicy.name)
    return (
      <Dialog open fullWidth maxWidth="sm" onClose={onDone}>
        <DialogTitle>{result.headline}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Alert severity={result.failures.length ? 'warning' : 'success'}>
              {result.detail}
            </Alert>
            {result.failures.map((line) => (
              <Typography key={line} sx={{ fontSize: 12.5 }}>
                {line}
              </Typography>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" color="secondary" onClick={onDone}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={running ? undefined : onClose}
      aria-labelledby="policy-move-title"
    >
      <DialogTitle id="policy-move-title" sx={{ pb: 1 }}>
        {intent === 'add'
          ? `Add employees to "${targetPolicy.name}"`
          : `Move ${picked.length} employee${picked.length === 1 ? '' : 's'} to "${targetPolicy.name}"`}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            Everyone belongs to exactly one policy, so this moves them off
            their current one. Their history stays; only the terms from the
            effective date change.
          </Typography>

          {employees.length > 0 ? (
            <Box
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '12px',
                overflow: 'hidden',
              }}
            >
              <Stack
                direction="row"
                spacing={1.25}
                alignItems="center"
                flexWrap="wrap"
                useFlexGap
                sx={{
                  p: '11px 13px',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <SelectAllCheckbox
                  shownIds={shown.map((employee) => employee.employeeId)}
                  selected={selected}
                  onChange={setSelected}
                />
                <Typography
                  sx={{
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '.05em',
                    textTransform: 'uppercase',
                    color: selected.length ? 'secondary.main' : '#98a2b3',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selected.length} of {employees.length} selected
                </Typography>
                <TextField
                  size="small"
                  fullWidth={false}
                  placeholder="Search people"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  sx={{ flex: 1, minWidth: 150 }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRoundedIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                />
              </Stack>

              <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
              {shown.map((employee) => (
                <FormControlLabel
                  key={employee.employeeId}
                  sx={{
                    display: 'flex',
                    m: 0,
                    p: '9px 13px',
                    gap: 0,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    bgcolor: selected.includes(employee.employeeId)
                      ? 'rgba(15, 118, 110, 0.1)'
                      : 'transparent',
                    '&:last-of-type': { borderBottom: 0 },
                    '&:hover': {
                      bgcolor: selected.includes(employee.employeeId)
                        ? 'rgba(15, 118, 110, 0.1)'
                        : 'rgba(16, 24, 40, 0.02)',
                    },
                  }}
                  control={
                    <Checkbox
                      size="small"
                      color="secondary"
                      sx={{ p: 0.5 }}
                      checked={selected.includes(employee.employeeId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, employee.employeeId]
                            : current.filter((id) => id !== employee.employeeId),
                        )
                      }
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1.375} alignItems="center">
                      <ApproverAvatar
                        email={employee.email}
                        displayName={employee.displayName}
                      />
                      <Stack sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                          {employee.displayName}
                        </Typography>
                        <Typography
                          sx={{ fontSize: 11.5, color: 'text.secondary' }}
                        >
                          {employee.policyName ?? 'No policy'}
                        </Typography>
                      </Stack>
                    </Stack>
                  }
                />
              ))}
              {shown.length === 0 ? (
                <Typography
                  sx={{ p: 2.5, textAlign: 'center', fontSize: 12.5, color: '#98a2b3' }}
                >
                  Nobody matches that search.
                </Typography>
              ) : null}
              </Box>
            </Box>
          ) : null}

          <Box sx={{ maxWidth: 260 }}>
            <DateField
              label="Effective from"
              value={effectiveDate}
              onChange={setEffectiveDate}
              disabled={running}
              fullWidth
            />
          </Box>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {effectiveDateHint(effectiveDate, today)}
          </Typography>

          {isBackdated ? (
            <RadioGroup
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as PolicyTransferMode)
              }
            >
              <FormControlLabel
                value="retroactive"
                control={<Radio size="small" color="secondary" />}
                label={
                  <Typography sx={{ fontSize: 12.5 }}>
                    {transferModeCopy(
                      'retroactive',
                      targetPolicy.name,
                      effectiveDate,
                    )}
                  </Typography>
                }
              />
              <FormControlLabel
                value="prospective"
                control={<Radio size="small" color="secondary" />}
                label={
                  <Typography sx={{ fontSize: 12.5 }}>
                    {transferModeCopy(
                      'prospective',
                      targetPolicy.name,
                      effectiveDate,
                    )}
                  </Typography>
                }
              />
            </RadioGroup>
          ) : null}

          {checking ? <LinearProgress /> : null}

          {picked.length === 0 ? (
            <Box
              sx={{
                border: '1px dashed',
                borderColor: 'rgba(16, 24, 40, 0.14)',
                borderRadius: '12px',
                p: '12px 13px',
                bgcolor: 'rgba(16, 24, 40, 0.015)',
                fontSize: 12.5,
                color: 'text.secondary',
              }}
            >
              Pick who to move. Each one is dry-run against the new terms before
              anything is written.
            </Box>
          ) : null}

          {summary && !checking ? (
            <Stack
              spacing={1.125}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '12px',
                p: '12px 13px',
                bgcolor: 'rgba(16, 24, 40, 0.015)',
              }}
            >
              <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>
                {summary.headline}
              </Typography>
              {/* A hundred near-identical refusals is not a report, it is a
                  wall. Name a few and count the rest; the sentence is the same
                  for all of them anyway. */}
              {summary.blockedLines.slice(0, BLOCKED_SHOWN).map((line) => (
                <Box
                  key={line}
                  sx={{
                    border: '1px solid rgba(180, 35, 24, 0.22)',
                    bgcolor: 'rgba(180, 35, 24, 0.08)',
                    borderRadius: '10px',
                    p: '8px 11px',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {line}
                </Box>
              ))}
              {earliestOffer ? (
                <Box>
                  <Button
                    size="small"
                    variant="outlined"
                    color="secondary"
                    onClick={() => {
                      setEffectiveDate(earliestOffer)
                      setEarliestOffer(null)
                    }}
                  >
                    Apply from {earliestOffer}
                  </Button>
                </Box>
              ) : null}
              {summary.blockedLines.length > BLOCKED_SHOWN ? (
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                  and {summary.blockedLines.length - BLOCKED_SHOWN} more blocked
                  the same way.
                </Typography>
              ) : null}
              {summary.warningLines.map((line) => (
                <Box
                  key={line}
                  sx={{
                    border: '1px solid rgba(181, 71, 8, 0.22)',
                    bgcolor: 'rgba(181, 71, 8, 0.08)',
                    borderRadius: '10px',
                    p: '8px 11px',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {line}
                </Box>
              ))}
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={onClose}
          disabled={running}
          variant="outlined"
          color="inherit"
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => void run()}
          disabled={running || checking || !summary || summary.movable === 0}
        >
          {running
            ? 'Moving...'
            : summary && summary.movable > 0
              ? `Move ${summary.movable}`
              : 'Nothing to move'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
