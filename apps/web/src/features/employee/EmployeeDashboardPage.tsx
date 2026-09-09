/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink } from 'react-router-dom'
import type { LeaveRequestSummaryDto } from '@workspace/contracts'
import { EmployeeProfileStatus } from '@workspace/contracts'
import {
  formatDaySplit,
  formatLongDate,
  formatRelativeTime,
  formatWeekdayDate,
} from '../../lib/leave-format'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  RELATIVE_TIME_TICK_MS,
  useAutoRefresh,
  useNowTick,
} from '../../lib/use-auto-refresh'
import {
  EmployeeFeatureProvider,
  employeeFeatureActions,
  useEmployeeFeatureDispatch,
  useEmployeeFeatureSelector,
} from './employee-feature.store'
import { cancelLeaveRequest } from './employee-api'
import {
  buildUpcomingTimeline,
  firstNameOf,
  greetingFor,
  inDaysLabel,
  nextTimeOff,
  probationNoticeLine,
  startsLabel,
  type UpcomingEntry,
} from './dashboard-insights'
import {
  BalanceKpiGrid,
  CalendarGlyph,
  ChevronGlyph,
  ClockGlyph,
  DashboardCalendarBanner,
  DateTile,
  EmployeePageFrame,
  EmptyState,
  ErrorSection,
  LoadingSection,
  ProfilePendingState,
  RangeLine,
  RowBadge,
  RowTag,
  SectionCard,
  StatusPill,
  formatDays,
  formatLeaveType,
  linkButtonSx,
} from './employee-ui'

function UpcomingRow({ entry, highlight }: { entry: UpcomingEntry; highlight: boolean }) {
  const isLeave = entry.kind === 'leave'
  const to = isLeave
    ? `/employee/history/${entry.request!.requestId}`
    : '/employee/holidays'

  return (
    <Box
      component={RouterLink}
      to={to}
      sx={(theme) => ({
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        p: '13px 14px',
        borderRadius: '14px',
        border: '1px solid',
        borderColor: highlight ? 'transparent' : 'divider',
        // Prototype .row.hot: a soft primary gradient instead of a border.
        background: highlight
          ? `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.09)} 0%, ${alpha(theme.palette.primary.main, 0.04)} 100%)`
          : theme.palette.background.paper,
        textDecoration: 'none',
        color: 'inherit',
        transition:
          'transform .2s cubic-bezier(.22,1,.36,1), box-shadow .2s cubic-bezier(.22,1,.36,1), border-color .2s ease',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: '0 10px 28px -10px rgba(16, 24, 40, 0.14)',
          borderColor: highlight ? 'transparent' : 'rgba(16, 24, 40, 0.14)',
        },
        '&:hover .row-chev': {
          transform: 'translateX(3px)',
          color: theme.palette.primary.main,
        },
      })}
      data-testid={`upcoming-${entry.kind}-${entry.date}`}
    >
      {highlight ? (
        // Prototype .next-flag: a small floating label breaking the row's top
        // border, on the paper surface.
        <Box
          component="span"
          sx={(theme) => ({
            position: 'absolute',
            top: -9,
            left: 14,
            px: 1,
            py: '2px',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'primary.main',
            bgcolor: 'background.paper',
            border: `1px solid ${alpha(theme.palette.primary.main, 0.14)}`,
            borderRadius: '6px',
            lineHeight: 1.5,
          })}
        >
          Next up
        </Box>
      ) : null}
      <DateTile date={entry.date} />
      <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography
            sx={{
              fontSize: '14.5px',
              fontWeight: 800,
              letterSpacing: '-0.005em',
              color: highlight ? 'primary.main' : 'text.primary',
            }}
          >
            {entry.title}
          </Typography>
          {isLeave ? (
            <RowBadge label={inDaysLabel(entry.inDays)} hot={highlight} />
          ) : (
            <>
              <RowTag label="Public holiday" />
              <RowBadge label={inDaysLabel(entry.inDays)} />
            </>
          )}
        </Stack>
        <Box sx={{ color: highlight ? 'primary.main' : '#667085', minWidth: 0 }}>
          {isLeave ? (
            <RangeLine
              startDate={entry.request!.startDate}
              endDate={entry.request!.endDate}
              daysLabel={formatDaySplit(entry.request!.paidDays, entry.request!.unpaidDays)}
            />
          ) : (
            <Typography noWrap sx={{ fontSize: '12.5px', fontWeight: 500, color: 'inherit' }}>
              {formatWeekdayDate(entry.date)}
            </Typography>
          )}
        </Box>
      </Stack>
      <Box
        component="span"
        className="row-chev"
        sx={{
          display: 'flex',
          color: 'text.disabled',
          flexShrink: 0,
          transition: 'transform .2s ease, color .2s ease',
        }}
      >
        <ChevronGlyph />
      </Box>
    </Box>
  )
}

function UpcomingSection({
  entries,
  highlighted,
  status,
}: {
  entries: UpcomingEntry[]
  // The entry flagged "Next up" — the same one the hero's "next time off"
  // sentence points at, so the two never contradict each other.
  highlighted?: UpcomingEntry
  status: 'idle' | 'loading' | 'succeeded' | 'failed'
}) {
  return (
    <SectionCard
      title="Upcoming"
      caption="Approved time off and public holidays in one timeline."
      icon={<CalendarGlyph />}
      side={entries.length > 0 ? `${entries.length} upcoming` : undefined}
    >
      {status === 'failed' ? (
        <Alert severity="warning">
          The upcoming timeline could not be loaded right now. It refreshes with the dashboard.
        </Alert>
      ) : entries.length === 0 ? (
        status === 'succeeded' ? (
          <EmptyState
            title="Nothing planned in the next two weeks"
            message="Approved time off and public holidays will line up here as they approach."
          />
        ) : (
          <Typography variant="body2" color="text.secondary">
            Loading the next two weeks…
          </Typography>
        )
      ) : (
        <Stack spacing={1.25} data-testid="upcoming-timeline">
          {entries.map((entry) => (
            <UpcomingRow
              key={`${entry.kind}-${entry.date}-${entry.title}`}
              entry={entry}
              highlight={entry === highlighted}
            />
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}

function PendingRequestRow({
  request,
  canceling,
  onCancel,
}: {
  request: LeaveRequestSummaryDto
  canceling: boolean
  onCancel: () => void
}) {
  return (
    <Stack
      spacing={1}
      sx={{
        p: '13px 14px',
        borderRadius: '14px',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
      data-testid={`pending-request-${request.requestId}`}
    >
      <Stack direction="row" spacing={1.75} alignItems="flex-start">
        <DateTile date={request.startDate} />
        <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Typography sx={{ fontSize: '14.5px', fontWeight: 800, letterSpacing: '-0.005em' }}>
              {formatLeaveType(request.leaveType)}
            </Typography>
            <StatusPill status={request.status} />
          </Stack>
          <Box sx={{ color: '#667085', minWidth: 0 }}>
            <RangeLine
              startDate={request.startDate}
              endDate={request.endDate}
              daysLabel={formatDaySplit(request.paidDays, request.unpaidDays)}
            />
          </Box>
          {request.comment ? (
            <Typography sx={{ fontSize: '12.5px', fontWeight: 500, color: 'text.secondary' }}>
              “{request.comment}”
            </Typography>
          ) : null}
        </Stack>
      </Stack>
      {/* Full-width action row: primary action left, destructive action right. */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Button
          component={RouterLink}
          to={`/employee/history/${request.requestId}`}
          variant="text"
          sx={linkButtonSx}
        >
          View details
        </Button>
        <Button
          variant="text"
          disabled={canceling}
          onClick={onCancel}
          startIcon={canceling ? <CircularProgress size={13} color="inherit" /> : undefined}
          data-testid={`cancel-request-${request.requestId}`}
          sx={(theme) => ({
            ...linkButtonSx,
            color: 'warning.dark',
            '&:hover': { bgcolor: alpha(theme.palette.warning.main, 0.1) },
          })}
        >
          {canceling ? 'Cancelling…' : 'Cancel request'}
        </Button>
      </Stack>
    </Stack>
  )
}

function PendingRequestsSection({ requests }: { requests: LeaveRequestSummaryDto[] }) {
  const dispatch = useEmployeeFeatureDispatch()
  // Every in-flight OR already-cancelled request id. A successful cancel keeps
  // its id in the set (the row stays disabled) until the refreshed dashboard
  // snapshot drops the row entirely — re-enabling it early would invite a
  // duplicate cancel POST that the backend rejects with a confusing error.
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(new Set())
  const [cancelError, setCancelError] = useState<string | null>(null)

  const cancelRequest = async (requestId: string) => {
    setCancelingIds((prev) => new Set(prev).add(requestId))
    setCancelError(null)
    try {
      await cancelLeaveRequest(requestId)
      // The dashboard snapshot is server-computed; re-fetch instead of patching
      // local state so balances and holds stay authoritative.
      dispatch(employeeFeatureActions.dashboardRequested())
    } catch (error) {
      setCancelError(
        error instanceof Error ? error.message : 'Unable to cancel the request.',
      )
      // Only a FAILED cancel re-enables its row.
      setCancelingIds((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }
  }

  return (
    <SectionCard
      title="Pending requests"
      caption="Holding days until approvers decide."
      icon={<ClockGlyph size={17} />}
      iconTone="warning"
      side={
        requests.length > 0
          ? `${requests.length} pending`
          : undefined
      }
    >
      {cancelError ? <Alert severity="error">{cancelError}</Alert> : null}
      {requests.length === 0 ? (
        <EmptyState
          title="No pending requests"
          message="You have full flexibility right now. New requests will appear here once submitted."
        />
      ) : (
        <Stack spacing={1.25}>
          {requests.map((request) => (
            <PendingRequestRow
              key={request.requestId}
              request={request}
              canceling={cancelingIds.has(request.requestId)}
              onCancel={() => void cancelRequest(request.requestId)}
            />
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}

export function EmployeeDashboardPageContent() {
  const dispatch = useEmployeeFeatureDispatch()
  const dashboard = useEmployeeFeatureSelector((state) => state.dashboard)
  const upcoming = useEmployeeFeatureSelector((state) => state.upcoming)

  useEffect(() => {
    dispatch(employeeFeatureActions.dashboardRequested())
  }, [dispatch])

  // Fail closed: anything but an explicit Ready (PendingSetup, NotStartedYet,
  // or an unexpected/missing status) blocks the leave UI.
  const profileBlocked =
    dashboard.data?.profileStatus !== EmployeeProfileStatus.Ready
  // Keep the snapshot live: re-fetch a fresh server-computed dashboard every few
  // minutes and whenever the tab regains focus, so balances advance across day,
  // month and year-end boundaries without a manual reload. The server stays the
  // single source of truth; the client never extrapolates the figures itself.
  // The upcoming timeline re-queries itself from each fresh snapshot (see the
  // upcomingAfterDashboardEpic), so one cadence drives both.
  useAutoRefresh(() => {
    dispatch(employeeFeatureActions.dashboardRequested())
  }, DASHBOARD_REFRESH_INTERVAL_MS)

  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  const data = dashboard.data
  const ready = dashboard.status === 'succeeded' && Boolean(data) && !profileBlocked

  const entries =
    ready && data && upcoming.data
      ? buildUpcomingTimeline(
          upcoming.data.requests,
          upcoming.data.holidayCalendars,
          data.generatedAt,
        )
      : []
  const next = nextTimeOff(entries)
  // Display-only facts about the leave policy this employee is on; the server
  // decides what they mean, this only says them.
  const policyFacts =
    ready && data ? probationNoticeLine(data.probationEndsOn) : null

  // The hero greets by name once data is in; the topbar breadcrumb keeps the
  // stable page label either way.
  const title =
    ready && data
      ? `${greetingFor(new Date(nowMs).getHours())}, ${firstNameOf(data.displayName)}`
      : 'Leave dashboard'
  const subtitle =
    ready && data ? (
      <>
        {formatLongDate(data.generatedAt)}
        {next ? (
          <>
            {' · Your next time off starts '}
            {/* Prototype bolds the proximity fragment. */}
            <Box component="b" sx={{ fontWeight: 700, color: 'text.primary' }}>
              {startsLabel(next.inDays).replace(/^starts /, '')}
            </Box>
            {'.'}
          </>
        ) : (
          ' ·'
        )}
        {' Everything below refreshes automatically.'}
      </>
    ) : (
      'Track what is available right now, what is already on hold, and how requests are moving through the approval queue.'
    )

  return (
    <EmployeePageFrame
      title={title}
      subtitle={subtitle}
      statusIndicator={
        ready && data ? (
          <ShellStatusPill
            label={`Live · updated ${formatRelativeTime(data.generatedAt, nowMs)}`}
          />
        ) : undefined
      }
    >
      {dashboard.status === 'loading' || dashboard.status === 'idle' ? (
        <LoadingSection label="Loading dashboard" />
      ) : null}

      {dashboard.status === 'failed' && dashboard.error ? (
        <ErrorSection title="Dashboard unavailable" message={dashboard.error} />
      ) : null}

      {dashboard.status === 'succeeded' && data ? (
        profileBlocked ? (
          <ProfilePendingState
            status={data.profileStatus}
            employmentStartDate={data.employmentStartDate}
          />
        ) : (
          <>
            <DashboardCalendarBanner
              holidayCalendarYears={data.holidayCalendarYears}
              generatedAt={data.generatedAt}
            />

            {policyFacts ? (
              <Typography
                data-testid="dashboard-policy-line"
                sx={{ fontSize: 12.5, color: 'text.secondary' }}
              >
                {policyFacts}
              </Typography>
            ) : null}

            <BalanceKpiGrid
              balances={data.balances}
              pendingCount={data.pendingRequests.length}
              hoursPerDay={data.hoursPerDay}
            />

            <Box
              sx={{
                display: 'grid',
                gap: 2.25,
                alignItems: 'start',
                gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 7fr) minmax(0, 5fr)' },
              }}
            >
              <UpcomingSection entries={entries} highlighted={next} status={upcoming.status} />
              <PendingRequestsSection requests={data.pendingRequests} />
            </Box>
          </>
        )
      ) : null}
    </EmployeePageFrame>
  )
}

export function EmployeeDashboardPage() {
  return (
    <EmployeeFeatureProvider>
      <EmployeeDashboardPageContent />
    </EmployeeFeatureProvider>
  )
}

export default EmployeeDashboardPage
