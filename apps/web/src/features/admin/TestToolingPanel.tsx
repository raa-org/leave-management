/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import BugReportRoundedIcon from '@mui/icons-material/BugReportRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DragIndicatorRoundedIcon from '@mui/icons-material/DragIndicatorRounded'
import Autocomplete from '@mui/material/Autocomplete'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Fab from '@mui/material/Fab'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { Theme } from '@mui/material/styles'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import type { AdminEmployeeListItemDto } from '@workspace/contracts'
import {
  browserTimezone,
  timezoneOptions,
  wallPartsIn,
  wallTimeIn,
  wallTimeProblem,
  zonedWallTimeToUtc,
} from '../../lib/test-clock'
import {
  adminApi,
  type AdminApiClient,
  type ResetDirectoryInput,
  type ResetDirectoryResult,
  type TestToolingState,
} from './admin-api'

const PANEL_WIDTH = 360

function shiftDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

function shiftMonths(iso: string, months: number): string {
  const date = new Date(iso)
  date.setUTCMonth(date.getUTCMonth() + months)
  return date.toISOString()
}

function yearEndOf(iso: string): string {
  return `${new Date(iso).getUTCFullYear()}-12-31T00:00:00.000Z`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The one place that decides what a keep selection means to the server: an
 * empty selection is a full wipe and must carry the explicit `all: true`
 * confirmation; a non-empty one sends the kept addresses and `all: false`.
 * Exported for tests (the panel itself renders nothing without a live API).
 */
export function buildResetDirectoryInput(
  keepEmployees: AdminEmployeeListItemDto[],
  clearAudit: boolean,
): ResetDirectoryInput {
  return {
    keep: keepEmployees.map((employee) => employee.email),
    all: keepEmployees.length === 0,
    clearAudit,
  }
}

/**
 * Confirm-button label stating the reset's real cost. `directorySize` is the
 * untruncated headcount (the picker list caps at 200); null when unknown, in
 * which case the label stays honest by not quoting a number.
 */
export function describeResetCost(
  directorySize: number | null,
  keptCount: number,
): string {
  if (directorySize === null) {
    return keptCount === 0
      ? 'Delete ALL users'
      : `Delete all but ${keptCount} kept`
  }
  return keptCount === 0
    ? `Delete ALL ${directorySize} users`
    : `Delete ${directorySize - keptCount} of ${directorySize} users`
}

/**
 * One-line summary of a finished directory reset. Label-first, so no counter
 * needs a plural form. The audit clause follows what was ASKED for, not what
 * was found: a requested clear of an already-empty trail still reports zero,
 * so the checkbox is never silently unaccounted for.
 */
export function describeResetOutcome(
  result: ResetDirectoryResult,
  clearAuditRequested: boolean,
): string {
  const parts = [
    `users: ${result.deletedUsers}`,
    `requests: ${result.deletedRequests}`,
    `ledger entries: ${result.deletedLedgerEntries}`,
    `deliveries: ${result.deletedDeliveries}`,
  ]
  if (clearAuditRequested) {
    parts.push(`audit rows cleared: ${result.clearedAuditLogs}`)
  }
  return `Deleted — ${parts.join(', ')}.`
}

// The pickers below are portaled to <body>, where the default z-index
// (modal, 1300) sits BELOW this floating panel (snackbar, 1400) and would hide
// the option list behind it. Lifted once, here, for all of them.
const pickerPopperSlotProps = {
  popper: { sx: { zIndex: (theme: Theme) => theme.zIndex.tooltip + 1 } },
}

const employeeOptionLabel = (option: AdminEmployeeListItemDto): string =>
  `${option.displayName} (${option.email})`

const sameEmployee = (
  option: AdminEmployeeListItemDto,
  value: AdminEmployeeListItemDto,
): boolean => option.employeeId === value.employeeId

/**
 * Floating administrator test tooling. Renders nothing unless the API reports the
 * tooling is enabled (TEST_TOOLING_ENABLED, dev/staging only) — a disabled server
 * 404s, which this treats as "not available here". A debug FAB toggles a draggable
 * panel with one tab per tool: a "Time travel" tab (shift the whole server clock so
 * accrual and spend can be exercised up to year-end without waiting) and a "Reset
 * user" tab (wipe one user's requests + balance back to a clean slate) and a
 * "Reset directory" tab (wipe the whole user population — or all but a kept
 * list — so an LDAP sync can be observed from a clean slate).
 */
export function TestToolingPanel({
  client = adminApi,
}: {
  client?: AdminApiClient
}) {
  const [state, setState] = useState<TestToolingState | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [activeTab, setActiveTab] = useState(0)
  // Time-travel tool.
  // Date, time and zone are asked for separately because that is how an admin
  // knows them. The time defaults to midnight, which is the boundary a leave
  // day is spent at, and the zone to the viewer's own so the common case needs
  // no thought.
  const [dateInput, setDateInput] = useState('')
  const [timeInput, setTimeInput] = useState('00:00')
  const [zoneInput, setZoneInput] = useState(() => browserTimezone())
  // Null until all three inputs are usable, which is also what disables Jump.
  // Seeded from the server instant read on the SELECTED zone, so the two
  // pickers always show the same wall clock the labels above them name.
  const seedClockInputs = useCallback(
    (instantIso: string) => {
      const parts = wallPartsIn(instantIso, zoneInput)
      setDateInput(parts.date)
      setTimeInput(parts.time)
    },
    [zoneInput],
  )
  const jumpTarget = zonedWallTimeToUtc(dateInput, timeInput, zoneInput)
  const jumpBlocker = wallTimeProblem(dateInput, timeInput, zoneInput)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reset-user tool.
  const [employees, setEmployees] = useState<AdminEmployeeListItemDto[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetMessage, setResetMessage] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  // Reset-directory tool. `directorySize` is the untruncated headcount from the
  // list totals; null when the totals are unavailable.
  const [directorySize, setDirectorySize] = useState<number | null>(null)
  const [keepEmployees, setKeepEmployees] = useState<AdminEmployeeListItemDto[]>([])
  const [clearAudit, setClearAudit] = useState(false)
  const [dirConfirming, setDirConfirming] = useState(false)
  const [dirBusy, setDirBusy] = useState(false)
  const [dirMessage, setDirMessage] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    client
      .getTestTooling()
      .then((next) => {
        if (!active) {
          return
        }
        setState(next)
        seedClockInputs(next.now)
      })
      .catch(() => {
        // 404 (flag off) / 403 (not admin) / network — simply not available.
        if (active) {
          setState(null)
        }
      })
    return () => {
      active = false
    }
    // Deliberately not depending on seedClockInputs: it changes with the zone,
    // and re-running this would refetch and overwrite a wall time the admin has
    // already typed. Switching zones keeps what is in the fields, which is the
    // point of a zone picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // Place the panel near the FAB on first open; it can then be dragged anywhere.
  useEffect(() => {
    if (open && !pos && typeof window !== 'undefined') {
      setPos({
        x: Math.max(16, window.innerWidth - PANEL_WIDTH - 24),
        y: Math.max(16, window.innerHeight - 520),
      })
    }
  }, [open, pos])

  // Keep the remembered position on-screen when the window is resized: a saved
  // spot near the right/bottom edge would otherwise fall outside a shrunk
  // viewport and become undraggable.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const clampToViewport = () => {
      setPos((current) =>
        current
          ? {
              x: clamp(current.x, 0, Math.max(0, window.innerWidth - PANEL_WIDTH)),
              y: clamp(current.y, 0, Math.max(0, window.innerHeight - 48)),
            }
          : current,
      )
    }
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [])

  // The single loader for both reset tabs, so the picker options and the
  // headcount behind the confirm label can never be fetched two different ways.
  const loadEmployees = useCallback((): Promise<void> => {
    return (
      client
        // The endpoint is keyset-paginated (default 50); request the server max
        // (200). Directories beyond that are truncated — acceptable for a
        // dev/staging-only reset picker over seeded test data.
        .getEmployees({ limit: 200 })
        .then((list) => {
          setEmployees(list.items)
          // The list is truncated, the totals are not — the directory-reset tab
          // states the real headcount rather than counting the picker's page.
          // Accounts, not a role-holder count: the reset deletes rows, and an
          // admin-only account would be missing from the employees number.
          setDirectorySize(list.totals?.accounts ?? null)
        })
        .catch(() => {
          setEmployees([])
          setDirectorySize(null)
        })
    )
  }, [client])

  // Reload every time the panel is opened, not once per mount: an LDAP sync (or
  // another admin) can change the population while this page stays open, and a
  // stale count would understate what the irreversible wipe is about to delete.
  useEffect(() => {
    if (!state?.enabled || !open) {
      return
    }
    void loadEmployees()
  }, [loadEmployees, open, state?.enabled])

  if (!state || !state.enabled) {
    return null
  }

  const shifted = state.offsetMs !== 0

  const apply = (action: () => Promise<TestToolingState>) => {
    setBusy(true)
    setError(null)
    action()
      .then((next) => {
        setState(next)
        seedClockInputs(next.now)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Test tooling update failed.')
      })
      .finally(() => setBusy(false))
  }

  const selectedEmployee =
    employees.find((employee) => employee.employeeId === selectedUserId) ?? null

  const selectUser = (userId: string) => {
    setSelectedUserId(userId)
    setConfirming(false)
    setResetMessage(null)
    setResetError(null)
  }

  const runReset = () => {
    // Gated on the resolved employee, never on the raw id: an id whose row is
    // no longer in the directory would POST a user the server cannot find.
    if (!selectedEmployee) {
      return
    }
    setResetBusy(true)
    setResetError(null)
    setResetMessage(null)
    client
      .resetUserLeaveData(selectedEmployee.employeeId)
      .then((result) => {
        setResetMessage(`Cleared ${result.displayName}'s leave data.`)
        setConfirming(false)
      })
      .catch((err: unknown) => {
        setResetError(err instanceof Error ? err.message : 'Reset failed.')
      })
      .finally(() => setResetBusy(false))
  }

  // Any change to what the reset would do (keep list, audit flag) invalidates
  // a pending confirmation: the red button must always name the current cost.
  const selectKeep = (value: AdminEmployeeListItemDto[]) => {
    setKeepEmployees(value)
    setDirConfirming(false)
    setDirMessage(null)
    setDirError(null)
  }

  const toggleClearAudit = (checked: boolean) => {
    setClearAudit(checked)
    setDirConfirming(false)
  }

  const runDirectoryReset = () => {
    setDirBusy(true)
    setDirError(null)
    setDirMessage(null)
    client
      .resetDirectory(buildResetDirectoryInput(keepEmployees, clearAudit))
      .then((result) => {
        setDirMessage(describeResetOutcome(result, clearAudit))
        setDirConfirming(false)
        // Most of the population is gone; drop every selection that referenced
        // it — including the reset-user tab's, whose employee this wipe may
        // just have deleted — and reload from what actually survived.
        setKeepEmployees([])
        setSelectedUserId('')
        setConfirming(false)
        return loadEmployees()
      })
      .catch((err: unknown) => {
        // The server's own refusal texts (409 sync running, 400 unmatched keep
        // address) surface verbatim — fetchJson unwraps the Nest message.
        setDirError(err instanceof Error ? err.message : 'Reset failed.')
      })
      .finally(() => setDirBusy(false))
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Ignore drags that start on the close button.
    if ((event.target as HTMLElement).closest('button')) {
      return
    }
    const origin = pos ?? { x: 24, y: 88 }
    const grabX = event.clientX - origin.x
    const grabY = event.clientY - origin.y
    const move = (moveEvent: PointerEvent) => {
      setPos({
        x: clamp(moveEvent.clientX - grabX, 0, window.innerWidth - PANEL_WIDTH),
        y: clamp(moveEvent.clientY - grabY, 0, window.innerHeight - 48),
      })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <>
      <Badge
        color="warning"
        variant="dot"
        overlap="circular"
        invisible={!shifted}
        sx={{
          position: 'fixed',
          // Below lg the shell's fixed bottom app bar occupies the bottom edge,
          // so the FAB rides above it (bar height + safe-area inset + a gap).
          bottom: { xs: 'calc(80px + env(safe-area-inset-bottom))', lg: 24 },
          right: 24,
          zIndex: (theme) => theme.zIndex.snackbar,
        }}
      >
        <Fab
          size="medium"
          color={shifted ? 'warning' : 'default'}
          aria-label="Test tooling"
          onClick={() => setOpen((current) => !current)}
          data-testid="test-tooling-fab"
        >
          <BugReportRoundedIcon />
        </Fab>
      </Badge>

      {open && pos ? (
        <Paper
          elevation={10}
          data-testid="test-tooling-panel"
          sx={{
            position: 'fixed',
            top: pos.y,
            left: pos.x,
            width: `min(${PANEL_WIDTH}px, calc(100vw - 32px))`,
            zIndex: (theme) => theme.zIndex.snackbar,
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <Box
            onPointerDown={startDrag}
            sx={{
              cursor: 'move',
              touchAction: 'none',
              px: 1.5,
              py: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              color: 'common.white',
              bgcolor: shifted ? 'warning.main' : 'primary.main',
            }}
          >
            <DragIndicatorRoundedIcon fontSize="small" />
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Test tooling
            </Typography>
            <Chip
              size="small"
              label={shifted ? 'Time-travelling' : 'Real time'}
              sx={{
                bgcolor: 'rgba(255,255,255,0.22)',
                color: 'common.white',
                fontWeight: 600,
              }}
            />
            <IconButton
              size="small"
              aria-label="Close test tooling"
              onClick={() => setOpen(false)}
              sx={{ color: 'common.white' }}
            >
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Box>

          <Tabs
            value={activeTab}
            onChange={(_event, value: number) => setActiveTab(value)}
            variant="fullWidth"
            sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40 }}
          >
            <Tab label="Time travel" sx={{ minHeight: 40 }} />
            <Tab label="Reset user" sx={{ minHeight: 40 }} />
            <Tab label="Reset directory" sx={{ minHeight: 40 }} />
          </Tabs>

          <Box sx={{ p: 2 }}>
            {activeTab === 0 ? (
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Server now: <strong>{wallTimeIn(state.now, 'UTC')}</strong> UTC
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {wallTimeIn(state.now, zoneInput)} in {zoneInput}
                </Typography>

                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    type="date"
                    size="small"
                    label="Date"
                    value={dateInput}
                    onChange={(event) => setDateInput(event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'data-testid': 'test-tooling-date' }}
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                  <TextField
                    type="time"
                    size="small"
                    label="Time"
                    value={timeInput}
                    onChange={(event) => setTimeInput(event.target.value)}
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ 'data-testid': 'test-tooling-time' }}
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                </Stack>

                <Autocomplete
                  size="small"
                  options={timezoneOptions([zoneInput])}
                  value={zoneInput}
                  onChange={(_event, value) => setZoneInput(value ?? browserTimezone())}
                  disableClearable
                  slotProps={pickerPopperSlotProps}
                  renderInput={(params) => (
                    <TextField {...params} label="Timezone" />
                  )}
                />

                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button
                    variant="contained"
                    size="small"
                    disabled={busy || jumpTarget === null}
                    onClick={() => {
                      if (jumpTarget !== null) {
                        apply(() => client.setTestTooling({ now: jumpTarget }))
                      }
                    }}
                  >
                    Jump
                  </Button>
                  {/* Either the instant that will be sent, or why it cannot be
                      built. A leave day is spent at midnight in the employee's
                      zone, so seeing the UTC translation is what stops an admin
                      concluding the feature is broken when the clock never
                      reached it -- and a button that greys out without saying
                      why is the same trap one step earlier. */}
                  <Typography variant="caption" color="text.secondary">
                    {jumpTarget
                      ? `= ${wallTimeIn(jumpTarget, 'UTC')} UTC`
                      : jumpBlocker}
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      apply(() => client.setTestTooling({ now: shiftDays(state.now, 1) }))
                    }
                  >
                    +1 day
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      apply(() => client.setTestTooling({ now: shiftDays(state.now, 7) }))
                    }
                  >
                    +1 week
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      apply(() => client.setTestTooling({ now: shiftMonths(state.now, 1) }))
                    }
                  >
                    +1 month
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      apply(() => client.setTestTooling({ now: yearEndOf(state.now) }))
                    }
                  >
                    Year-end
                  </Button>
                  <Button
                    size="small"
                    color="inherit"
                    disabled={busy || !shifted}
                    onClick={() => apply(() => client.resetTestTooling())}
                  >
                    Reset
                  </Button>
                </Stack>

                {error ? (
                  <Typography variant="body2" color="error">
                    {error}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  Development/staging only. Shifts the whole server clock so accrual
                  and spend can be driven to any date; the shifted clock keeps ticking.
                </Typography>
              </Stack>
            ) : null}
            {activeTab === 1 ? (
              <Stack spacing={1.25}>
                <Autocomplete
                  size="small"
                  options={employees}
                  value={selectedEmployee}
                  getOptionLabel={employeeOptionLabel}
                  isOptionEqualToValue={sameEmployee}
                  slotProps={pickerPopperSlotProps}
                  onChange={(_event, value) => selectUser(value?.employeeId ?? '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Employee"
                      inputProps={{
                        ...params.inputProps,
                        'data-testid': 'test-tooling-user',
                      }}
                    />
                  )}
                />

                {confirming ? (
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      color="error"
                      variant="contained"
                      disabled={resetBusy}
                      onClick={runReset}
                    >
                      Confirm reset
                    </Button>
                    <Button
                      size="small"
                      disabled={resetBusy}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </Button>
                  </Stack>
                ) : (
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    disabled={!selectedEmployee || resetBusy}
                    onClick={() => setConfirming(true)}
                  >
                    Reset leave data
                  </Button>
                )}
                {resetMessage ? (
                  <Typography variant="body2" color="success.main">
                    {resetMessage}
                  </Typography>
                ) : null}
                {resetError ? (
                  <Typography variant="body2" color="error">
                    {resetError}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  Deletes the user&apos;s requests and balance history (spent
                  &rarr; 0). Their annual allocation is kept. Irreversible.
                </Typography>
              </Stack>
            ) : null}
            {activeTab === 2 ? (
              <Stack spacing={1.25}>
                <Autocomplete
                  multiple
                  size="small"
                  options={employees}
                  value={keepEmployees}
                  getOptionLabel={employeeOptionLabel}
                  isOptionEqualToValue={sameEmployee}
                  slotProps={pickerPopperSlotProps}
                  onChange={(_event, value) => selectKeep([...value])}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Keep these users"
                      placeholder={
                        keepEmployees.length === 0
                          ? 'Nobody — the whole directory goes'
                          : undefined
                      }
                      inputProps={{
                        ...params.inputProps,
                        'data-testid': 'test-tooling-keep',
                      }}
                    />
                  )}
                />

                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={clearAudit}
                      onChange={(event) => toggleClearAudit(event.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="body2">Also clear the audit log</Typography>
                  }
                />

                {dirConfirming ? (
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      color="error"
                      variant="contained"
                      disabled={dirBusy}
                      onClick={runDirectoryReset}
                    >
                      {describeResetCost(directorySize, keepEmployees.length)}
                    </Button>
                    <Button
                      size="small"
                      disabled={dirBusy}
                      onClick={() => setDirConfirming(false)}
                    >
                      Cancel
                    </Button>
                  </Stack>
                ) : (
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    disabled={dirBusy}
                    onClick={() => {
                      setDirMessage(null)
                      setDirError(null)
                      setDirConfirming(true)
                    }}
                  >
                    Reset directory
                  </Button>
                )}
                {dirMessage ? (
                  <Typography variant="body2" color="success.main">
                    {dirMessage}
                  </Typography>
                ) : null}
                {dirError ? (
                  <Typography variant="body2" color="error">
                    {dirError}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  Deletes every user except the kept ones, with their requests
                  and balance history, so an LDAP sync can repopulate from a
                  clean slate.{' '}
                  {clearAudit
                    ? 'The audit trail will be emptied along with them.'
                    : 'The audit trail survives with its user links detached.'}{' '}
                  Irreversible.
                </Typography>
              </Stack>
            ) : null}
          </Box>
        </Paper>
      ) : null}
    </>
  )
}
