/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import FilterAltOffRoundedIcon from '@mui/icons-material/FilterAltOffRounded'
import FilterListRoundedIcon from '@mui/icons-material/FilterListRounded'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import Grid from '@mui/material/Grid'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import Skeleton from '@mui/material/Skeleton'
import { LeaveRequestStatus, LeaveType } from '@workspace/contracts'
import type {
  AdminActivityFeedDto,
  AdminActivityFeedItemDto,
  AdminEmployeeOptionDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import { DateRangeField } from '../../components/date-picker'
import { IdentifierDisclosure } from '../../components/IdentifierDisclosure'
import {
  MetricTile,
  PulseGlyph,
  SectionCard,
  StatusPill,
  type MetricTone,
} from '../employee/employee-ui'
import { AdminLayout } from './AdminLayout'
import { AdminForceDecisionDialog } from './AdminForceDecisionDialog'
import { adminApi, type AdminApiClient } from './admin-api'
import { appendKeysetPage } from './keyset-paging'
import {
  adoptWorkdayHours,
  formatDayMonth,
  formatDaySplit,
  spansYears,
  workdayHoursOf,
} from '../../lib/leave-format'
import {
  applyDecisionToFeed,
  LEAVE_STATUS_OPTIONS,
  LEAVE_TYPE_OPTIONS,
  formatDate,
  formatDateTime,
  formatDays,
  formatLeaveType,
  summarizeActivity,
} from './admin-formatters'

type AdminActivityPageProps = {
  api?: AdminApiClient
  initialFeed?: AdminActivityFeedDto
  // Pre-populates the employee/approver filter dropdowns (tests / SSR).
  initialEmployees?: AdminEmployeeOptionDto[]
}

export type FeedState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminActivityFeedDto
  loadingMore: boolean
  // The filters that produced `data`. Load-more pages must be fetched with
  // THESE, not the live filters — otherwise a page filtered the new way gets
  // appended onto a list built the old way.
  appliedFilters: ActivityFilters
}

// '' means "no filter" on every field; toQueryString drops empty values, so
// the filters object doubles as the AdminActivityQuery (see admin-api.ts).
export type ActivityFilters = {
  employeeId: string
  approverEmail: string
  status: LeaveRequestStatus | ''
  leaveType: LeaveType | ''
  from: string
  to: string
}

// Prototype .metric tints: each KPI value is colored by what it counts.
const ACTIVITY_METRIC_TONES: Record<string, MetricTone> = {
  Pending: 'warning',
  Approved: 'success',
  Rejected: 'error',
  Cancelled: 'muted',
}

// The empty seed a first render shows before any response: the divisor here is
// the shared default, and the very next payload replaces the whole object with
// the org's own.
const emptyFeed: AdminActivityFeedDto = {
  items: [],
  hoursPerDay: workdayHoursOf(),
}

export const emptyActivityFilters: ActivityFilters = {
  employeeId: '',
  approverEmail: '',
  status: '',
  leaveType: '',
  from: '',
  to: '',
}

const ACTIVITY_FILTER_PARAM_KEYS: Array<keyof ActivityFilters> = [
  'employeeId',
  'approverEmail',
  'status',
  'leaveType',
  'from',
  'to',
]

function isLeaveRequestStatus(value: string): value is LeaveRequestStatus {
  return Object.values(LeaveRequestStatus).includes(value as LeaveRequestStatus)
}

function isLeaveType(value: string): value is LeaveType {
  return Object.values(LeaveType).includes(value as LeaveType)
}

// URL search params are the source of truth for feed filters so a return from
// request details (browser back) restores the listing the admin was viewing.
export function activityFiltersFromSearchParams(
  params: URLSearchParams | Readonly<URLSearchParams>,
): ActivityFilters {
  const status = params.get('status') ?? ''
  const leaveType = params.get('leaveType') ?? ''

  return {
    employeeId: params.get('employeeId') ?? '',
    approverEmail: params.get('approverEmail') ?? '',
    status: isLeaveRequestStatus(status) ? status : '',
    leaveType: isLeaveType(leaveType) ? leaveType : '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  }
}

export function activityFiltersToSearchParams(
  filters: ActivityFilters,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base)

  for (const key of ACTIVITY_FILTER_PARAM_KEYS) {
    const value = filters[key]
    if (value === '') {
      params.delete(key)
    } else {
      params.set(key, value)
    }
  }

  return params
}

function activityFiltersEqual(a: ActivityFilters, b: ActivityFilters): boolean {
  return ACTIVITY_FILTER_PARAM_KEYS.every((key) => a[key] === b[key])
}

// Which action a feed row offers its reader, from the two authority flags the
// server already computed. 'review' — the reader holds a vote, cast it on the
// review page (never the override dialog, which would bypass their own gate);
// 'decide' — an admin with no stake overrides here in the console; 'open' —
// nothing to do, just view. Both flags are server-computed from the admin role
// and the per-request standing, so the client never infers rights from the role.
export type RowAction = 'review' | 'decide' | 'open'

export function rowActionFor(item: AdminActivityFeedItemDto): RowAction {
  // A terminal request offers no action regardless of the flags — status is the
  // ground truth for "still actionable". Checked FIRST so a stale viewer carried
  // over an optimistic decision (canOverride left true while status flipped to
  // settled, see applyDecisionToFeed) can never re-offer a spent override.
  if (item.status !== LeaveRequestStatus.Pending) {
    return 'open'
  }
  if (item.viewer?.canDecide) {
    return 'review'
  }
  if (item.viewer?.canOverride) {
    return 'decide'
  }
  // Pending but no actionable standing (also a viewer-less payload, which the
  // contract says to read as no authority): view only.
  return 'open'
}

// Pure state transition for a resolved load-more page (exported for tests).
// Staleness/dedup semantics live in the shared appendKeysetPage — see
// keyset-paging.ts for the (appliedFilters, cursor) listing-identity
// contract.
export function appendActivityPage(
  current: FeedState,
  request: { cursor: string; appliedFilters: ActivityFilters },
  nextFeed: AdminActivityFeedDto,
): FeedState {
  const merged = appendKeysetPage(
    { data: current.data, applied: current.appliedFilters },
    { cursor: request.cursor, applied: request.appliedFilters },
    nextFeed,
    (item) => item.requestId,
  )
  return merged
    ? { ...current, status: 'success', loadingMore: false, data: merged }
    : { ...current, loadingMore: false }
}

export default function AdminActivityPage({
  api = adminApi,
  initialFeed,
  initialEmployees,
}: AdminActivityPageProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = activityFiltersFromSearchParams(searchParams)
  const activeFilterCount = Object.values(filters).filter(
    (value) => value !== '',
  ).length
  const hasActiveFilters = activeFilterCount > 0
  const [filtersOpen, setFiltersOpen] = useState(hasActiveFilters)
  const [employees, setEmployees] = useState<AdminEmployeeOptionDto[]>(
    initialEmployees ?? [],
  )
  // The approver input's visible text, controlled separately from the
  // committed filter: a freeSolo Autocomplete keeps its uncontrolled draft
  // when `value` is reset from outside, so "Clear filters" would blank the
  // filter but leave the stale text on screen.
  const [approverInput, setApproverInput] = useState('')
  useEffect(() => {
    setApproverInput(filters.approverEmail)
  }, [filters.approverEmail])
  const [feedState, setFeedState] = useState<FeedState>(() => ({
    status: initialFeed ? 'success' : 'idle',
    error: null,
    data: initialFeed ?? emptyFeed,
    loadingMore: false,
    appliedFilters: emptyActivityFilters,
  }))
  // The row being overridden, or null when the dialog is closed. Every other
  // piece of decision state (the reason draft, which button spins, the error)
  // lives inside the dialog instance, so two rows can never share it.
  const [decisionTarget, setDecisionTarget] =
    useState<AdminActivityFeedItemDto | null>(null)

  // Skip the network on first render only when server-provided data is present
  // (tests / SSR). Any later filter change always refetches.
  const skipInitialFetch = useRef(Boolean(initialFeed))

  // Fetches immediately on every committed filter change. Every control commits
  // discretely: selects and clear fire once, and the date-range picker commits
  // both endpoints in a single update on Done, so no debounce is needed.
  useEffect(() => {
    if (skipInitialFetch.current) {
      skipInitialFetch.current = false
      return
    }

    const activeFilters = activityFiltersFromSearchParams(searchParams)
    let active = true
    setFeedState((current) => ({ ...current, status: 'loading', error: null }))

    api
      .getActivity(activeFilters)
      .then((data) => {
        if (!active) {
          return
        }
        setFeedState({
          status: 'success',
          error: null,
          data,
          loadingMore: false,
          appliedFilters: activeFilters,
        })
      })
      .catch((error: Error) => {
        if (!active) {
          return
        }
        setFeedState((current) => ({
          ...current,
          status: 'error',
          error: error.message,
          loadingMore: false,
        }))
      })

    return () => {
      active = false
    }
  }, [api, searchParams])

  const commitFilters = useCallback(
    (next: ActivityFilters) => {
      setSearchParams(
        (current) => {
          const currentFilters = activityFiltersFromSearchParams(current)
          if (activityFiltersEqual(currentFilters, next)) {
            return current
          }
          return activityFiltersToSearchParams(next, current)
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // The employee and approver dropdowns need only names and emails; the
  // dedicated options endpoint avoids the employee list's per-user balance
  // hydration. A failure here only degrades the dropdowns to their "All …"
  // defaults; the feed itself reports its own errors.
  useEffect(() => {
    if (initialEmployees) {
      return
    }
    let active = true
    api
      .getEmployeeOptions()
      .then((options) => {
        if (active) {
          setEmployees(options)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [api, initialEmployees])

  const summary = summarizeActivity(feedState.data)

  // Commits a single discrete filter (employee, approver, status, leave type).
  // The no-op guard keeps an unchanged commit from minting a new filters
  // identity and refetching. The date range commits both endpoints at once via
  // commitFilters directly, so it does not go through here.
  const setFilter = useCallback(
    <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) => {
      if (filters[key] === value) {
        return
      }
      commitFilters({ ...filters, [key]: value })
    },
    [commitFilters, filters],
  )

  // Only ever called from the dialog's success path, never from an effect, so
  // it needs no useCallback. The fold itself is pure and unit-tested.
  const patchRow = (detail: LeaveRequestDetailDto) => {
    setFeedState((current) => ({
      ...current,
      data: applyDecisionToFeed(current.data, detail),
    }))
  }

  const reload = async () => {
    setFeedState((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const data = await api.getActivity(filters)
      setFeedState({
        status: 'success',
        error: null,
        data,
        loadingMore: false,
        appliedFilters: filters,
      })
    } catch (error) {
      setFeedState((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to load activity.',
        loadingMore: false,
      }))
    }
  }

  const loadMore = async () => {
    const cursor = feedState.data.nextCursor
    // Snapshot the filters the visible list was built with (NOT the live
    // ones): after an edited-but-failed refetch, or while a refetch is in
    // flight, live filters and the list would disagree. The same snapshot
    // identifies the listing in the staleness check after the await.
    const appliedFilters = feedState.appliedFilters
    // Only a successfully loaded listing may be extended: after a failed
    // filter refetch the visible data belongs to the OLD filters, and
    // appending would present the old population as a success under the
    // new ones.
    if (!cursor || feedState.loadingMore || feedState.status !== 'success') {
      return
    }

    setFeedState((current) => ({ ...current, loadingMore: true, error: null }))

    try {
      const nextFeed = await api.getActivity({ ...appliedFilters, cursor })
      setFeedState((current) =>
        appendActivityPage(current, { cursor, appliedFilters }, nextFeed),
      )
    } catch (error) {
      // Stamp the error only while the failed page's listing is still the
      // one on screen — a filter change mid-flight makes it irrelevant.
      setFeedState((current) =>
        current.appliedFilters === appliedFilters
          ? {
              ...current,
              loadingMore: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load more activity.',
            }
          : { ...current, loadingMore: false },
      )
    }
  }

  // From the feed itself: this route fetches nothing else that knows the org's
  // workday, and it prints server-authored notes carrying the real one beside
  // figures it renders here.
  adoptWorkdayHours(feedState.data.hoursPerDay)

  return (
    <AdminLayout
      title="Administrator activity"
      subtitle="Track leave submissions, approvals, and review velocity across the company."
      statusIndicator={<ShellStatusPill label="Live · feed up to date" />}
      headerSupplement={
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: {
              xs: 'repeat(2, minmax(0, 1fr))',
              md: 'repeat(5, minmax(0, 1fr))',
            },
          }}
        >
          {summary.map((item) => (
            <MetricTile
              key={item.label}
              label={item.label}
              value={item.value}
              size="lg"
              tone={ACTIVITY_METRIC_TONES[item.label] ?? 'default'}
            />
          ))}
        </Box>
      }
    >
      <SectionCard
        title="Activity feed"
        caption="Every leave request with its current state, ordered by the most recently updated so administrators can spot backlogs at a glance."
        icon={<PulseGlyph />}
        sideVariant="control"
        side={
          <Button
            variant="outlined"
            color="secondary"
            startIcon={<FilterListRoundedIcon />}
            endIcon={filtersOpen ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
        }
      >
        <Stack spacing={2.5} id="activity-feed">
            <Collapse in={filtersOpen}>
            <Grid container spacing={2} alignItems="center">
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                {/* Type-to-search over the directory; the query filters by
                    employeeId, so (unlike the approver) a value must be
                    picked from the list, not typed free-form. */}
                <Autocomplete
                  options={employees}
                  getOptionLabel={(option) => option.displayName}
                  isOptionEqualToValue={(option, selected) =>
                    option.employeeId === selected.employeeId
                  }
                  value={
                    employees.find(
                      (employee) => employee.employeeId === filters.employeeId,
                    ) ?? null
                  }
                  onChange={(_, option) =>
                    setFilter('employeeId', option?.employeeId ?? '')
                  }
                  renderOption={(props, option) => (
                    <li {...props} key={option.employeeId}>
                      <Stack>
                        <Typography variant="body2">{option.displayName}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.email}
                        </Typography>
                      </Stack>
                    </li>
                  )}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Employee"
                      placeholder="Search by name"
                    />
                  )}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                {/* Approvers can be any email (group mailboxes, defaults from
                    settings), not only employees, so allow free text on top
                    of the employee suggestions. autoSelect commits typed text
                    on blur, so filtering never requires pressing Enter. The
                    input text is controlled so an outside reset (Clear
                    filters) clears the visible draft too. */}
                <Autocomplete
                  freeSolo
                  autoSelect
                  options={employees.map((employee) => employee.email)}
                  value={filters.approverEmail || null}
                  inputValue={approverInput}
                  onInputChange={(_, value) => setApproverInput(value)}
                  onChange={(_, value) => setFilter('approverEmail', value ?? '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Approver"
                      placeholder="Any approver email"
                    />
                  )}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <TextField
                  select
                  fullWidth
                  label="Status"
                  value={filters.status}
                  onChange={(event) =>
                    setFilter('status', event.target.value as LeaveRequestStatus | '')
                  }
                >
                  <MenuItem value="">All statuses</MenuItem>
                  {LEAVE_STATUS_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <TextField
                  select
                  fullWidth
                  label="Leave type"
                  value={filters.leaveType}
                  onChange={(event) =>
                    setFilter('leaveType', event.target.value as LeaveType | '')
                  }
                >
                  <MenuItem value="">All leave types</MenuItem>
                  {LEAVE_TYPE_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                {/* One filter, both endpoints committed atomically on Done, so
                    keyset paging never sees a half-updated range. `plain`:
                    a filter has no leave semantics (no weekend/holiday shading,
                    no working-day count, no Done gate). */}
                <DateRangeField
                  plain
                  fullWidth
                  label="Leave range"
                  value={{ startDate: filters.from, endDate: filters.to }}
                  onChange={(range) =>
                    commitFilters({
                      ...filters,
                      from: range.startDate,
                      to: range.endDate,
                    })
                  }
                />
              </Grid>
              {hasActiveFilters ? (
                <Grid size={{ xs: 12, md: 2 }}>
                  <Button
                    color="secondary"
                    startIcon={<FilterAltOffRoundedIcon />}
                    onClick={() => commitFilters(emptyActivityFilters)}
                  >
                    Clear filters
                  </Button>
                </Grid>
              ) : null}
            </Grid>
            </Collapse>

            {feedState.error ? (
              <Alert
                severity="error"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      void reload()
                    }}
                  >
                    Retry
                  </Button>
                }
              >
                {feedState.error}
              </Alert>
            ) : null}

            {feedState.status === 'loading' && feedState.data.items.length === 0 ? (
              <Stack spacing={1.5}>
                {Array.from({ length: 4 }).map((_, index) => (
                  <Box
                    key={index}
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: '14px',
                      p: '16px 18px',
                    }}
                  >
                    <Skeleton variant="text" width="28%" />
                    <Skeleton variant="text" width="58%" />
                    <Skeleton variant="text" width="42%" />
                  </Box>
                ))}
              </Stack>
            ) : null}

            {/* Only after a completed fetch — during loading nothing is known
                yet, and in the error state the alert above already explains
                why there is nothing to show. */}
            {feedState.status !== 'loading' &&
            feedState.status !== 'error' &&
            feedState.data.items.length === 0 ? (
              <Alert severity="info">
                {hasActiveFilters
                  ? 'No leave requests match the current filters.'
                  : 'No leave requests have been submitted yet.'}
              </Alert>
            ) : null}

            {feedState.data.items.length > 0 ? (
              <Stack spacing={1.5}>
                {feedState.data.items.map((item) => (
                  <Stack
                    key={item.requestId}
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={{ xs: 2, md: 3 }}
                    justifyContent="space-between"
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: '14px',
                      p: '16px 18px',
                      transition: 'box-shadow 0.2s ease',
                      '&:hover': { boxShadow: '0 10px 28px -10px rgba(16, 24, 40, 0.14)' },
                    }}
                  >
                    <Stack spacing={1.25} sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                        <Typography sx={{ fontSize: 16, fontWeight: 800 }}>
                          {item.employeeDisplayName}
                        </Typography>
                        <StatusPill status={item.status} />
                        <Typography
                          component="span"
                          sx={{
                            fontSize: 11.5,
                            fontWeight: 700,
                            px: '10px',
                            py: '3px',
                            borderRadius: '8px',
                            border: '1px solid',
                            borderColor: 'divider',
                            color: 'text.secondary',
                          }}
                        >
                          {formatLeaveType(item.leaveType)}
                        </Typography>
                      </Stack>
                      <Box>
                        {/* Prototype .req-dates: an arrow range, with the year
                            carried once by the end date. */}
                        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                          {item.startDate === item.endDate
                            ? formatDate(item.endDate)
                            : spansYears(item.startDate, item.endDate)
                              ? `${formatDate(item.startDate)} → ${formatDate(item.endDate)}`
                              : `${formatDayMonth(item.startDate)} → ${formatDate(item.endDate)}`}{' '}
                          · {formatDaySplit(item.paidDays, item.unpaidDays)}
                        </Typography>
                        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                          Submitted {formatDateTime(item.submittedAt)}
                        </Typography>
                      </Box>
                      <IdentifierDisclosure
                        items={[
                          { label: 'Request ID', value: item.requestId },
                          { label: 'Employee ID', value: item.employeeId },
                        ]}
                      />
                    </Stack>
                    <Stack
                      spacing={1.5}
                      justifyContent="space-between"
                      alignItems={{ xs: 'flex-start', md: 'flex-end' }}
                      sx={{ flexShrink: 0 }}
                    >
                      <Box sx={{ textAlign: { md: 'right' } }}>
                        <Typography
                          sx={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            color: '#98a2b3',
                          }}
                        >
                          Last activity
                        </Typography>
                        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                          {item.lastAction.charAt(0).toUpperCase() + item.lastAction.slice(1)}{' '}
                          · {formatDateTime(item.lastActivityAt)}
                        </Typography>
                      </Box>
                      {/* One of three actions, chosen by the reader's server
                          standing on this row — see rowActionFor. 'review' — a
                          designated approver casts a vote on the review page;
                          'decide' — an admin overrides here in the console;
                          'open' — read-only. The gate is server-computed, so a
                          CC recipient (or any non-decider) never sees Decide. */}
                      {(() => {
                        switch (rowActionFor(item)) {
                          case 'review':
                            return (
                              <Button
                                component={RouterLink}
                                to={`/admin/approval/review/${item.requestId}`}
                                size="small"
                                variant="contained"
                                color="secondary"
                              >
                                Review
                              </Button>
                            )
                          case 'decide':
                            return (
                              <Button
                                size="small"
                                variant="contained"
                                color="secondary"
                                onClick={() => {
                                  setDecisionTarget(item)
                                }}
                              >
                                Decide
                              </Button>
                            )
                          case 'open':
                            return (
                              <Button
                                component={RouterLink}
                                to={`/admin/approval/review/${item.requestId}`}
                                size="small"
                                variant="outlined"
                                color="secondary"
                              >
                                Open request
                              </Button>
                            )
                        }
                      })()}
                    </Stack>
                  </Stack>
                ))}
              </Stack>
            ) : null}

            {feedState.status === 'success' && feedState.data.nextCursor ? (
              <Stack direction="row" justifyContent="center">
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={() => {
                    void loadMore()
                  }}
                  disabled={feedState.loadingMore}
                >
                  {feedState.loadingMore ? (
                    <CircularProgress size={18} color="inherit" />
                  ) : (
                    'Load more requests'
                  )}
                </Button>
              </Stack>
            ) : null}
        </Stack>
      </SectionCard>

      {/* Mounted only while a row is targeted, so the dialog's props stay
          non-nullable and its state resets between rows. */}
      {decisionTarget ? (
        <AdminForceDecisionDialog
          item={decisionTarget}
          api={api}
          onDecided={patchRow}
          onClose={() => {
            setDecisionTarget(null)
          }}
        />
      ) : null}
    </AdminLayout>
  )
}
