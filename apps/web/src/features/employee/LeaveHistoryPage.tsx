/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import { ApproverKind, LeaveRequestStatus } from '@workspace/contracts'
import type { LeaveRequestDetailDto, LeaveRequestSummaryDto } from '@workspace/contracts'
import { DateRangeField } from '../../components/date-picker'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  adoptWorkdayHours,
  canCancelRequest,
  canModifyRequest,
  formatDayMonthLocal,
  formatDaySplit,
  formatRelativeTime,
} from '../../lib/leave-format'
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  RELATIVE_TIME_TICK_MS,
  useAutoRefresh,
  useNowTick,
} from '../../lib/use-auto-refresh'
import { cancelLeaveRequest } from './employee-api'
import {
  EmployeeFeatureProvider,
  employeeFeatureActions,
  useEmployeeFeatureDispatch,
  useEmployeeFeatureSelector,
} from './employee-feature.store'
import {
  filterByStatus,
  historyDateBounds,
  statusCounts,
  type HistoryStatusCounts,
} from './history-filters'
import {
  ChevronGlyph,
  DateTile,
  DecisionBanner,
  EmployeePageFrame,
  EmptyState,
  ErrorSection,
  FoldingChips,
  LoadingSection,
  RangeLine,
  RowBadge,
  StatusPill,
  formatDate,
  formatDays,
  formatLeaveType,
  linkButtonSx,
} from './employee-ui'

// A booking that a change request replaced is a history-only state, so it sits
// outside the shared window counter; it is tallied next to it.
type HistoryCounts = HistoryStatusCounts & { superseded: number }

function historyCounts(requests: readonly LeaveRequestDetailDto[]): HistoryCounts {
  return {
    ...statusCounts(requests),
    superseded: requests.filter(
      (request) => request.status === LeaveRequestStatus.Superseded,
    ).length,
  }
}

// The filter card's horizontal padding, in px. The mobile pill row bleeds to
// the card edges with negative margins, so the same value must drive the card
// padding and the bleed — one constant keeps them in sync.
const CARD_PAD_X = 20

// Gap between status pills, in px. The mobile scroll row derives its trailing
// spacer from it, so the inset stays CARD_PAD_X wide however the gap changes.
const PILL_GAP_X = 8

const statusFilters: Array<{
  label: string
  value?: LeaveRequestStatus
  countKey: keyof HistoryCounts
}> = [
  { label: 'All', value: undefined, countKey: 'all' },
  { label: 'Pending', value: LeaveRequestStatus.Pending, countKey: 'pending' },
  { label: 'Approved', value: LeaveRequestStatus.Approved, countKey: 'approved' },
  { label: 'Rejected', value: LeaveRequestStatus.Rejected, countKey: 'rejected' },
  { label: 'Cancelled', value: LeaveRequestStatus.Cancelled, countKey: 'cancelled' },
  { label: 'Superseded', value: LeaveRequestStatus.Superseded, countKey: 'superseded' },
]

// Prototype .pill with the .n count bubble: the count always describes the
// loaded date window, the active pill fills primary.
function FilterPill({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-pressed={selected}
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.875,
        // Keep intrinsic width inside the mobile nowrap scroll row.
        flex: 'none',
        whiteSpace: 'nowrap',
        fontSize: 13,
        fontWeight: 700,
        px: '14px',
        py: '7px',
        borderRadius: 999,
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'rgba(16, 24, 40, 0.14)',
        color: selected ? '#fff' : 'text.secondary',
        bgcolor: selected ? 'primary.main' : 'background.paper',
        boxShadow: selected ? '0 6px 14px -6px rgba(21, 94, 239, 0.5)' : 'none',
        transition: 'all .16s ease',
        '&:hover': selected
          ? {}
          : { borderColor: 'primary.main', color: 'primary.main' },
        '& .pill-n': {
          minWidth: 18,
          height: 18,
          px: '5px',
          borderRadius: 999,
          display: 'inline-grid',
          placeItems: 'center',
          fontSize: 11,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          bgcolor: selected ? 'rgba(255, 255, 255, 0.25)' : 'rgba(16, 24, 40, 0.07)',
          color: selected ? '#fff' : '#667085',
        },
        ...(selected ? {} : { '&:hover .pill-n': { color: alpha(theme.palette.primary.main, 0.9) } }),
      })}
    >
      {label}
      <Box component="span" className="pill-n">
        {count}
      </Box>
    </ButtonBase>
  )
}

// The other end of a modification pair, on the row's meta typography: both ends
// name each other, so a superseded booking is never a dead end and a
// replacement always shows what it is replacing.
function LinkedRequestLine({
  label,
  request,
}: {
  label: string
  request: LeaveRequestSummaryDto
}) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      flexWrap="wrap"
      sx={{ color: '#667085', minWidth: 0 }}
    >
      <Typography sx={{ fontSize: '12.5px', fontWeight: 700 }}>{label}</Typography>
      <RangeLine startDate={request.startDate} endDate={request.endDate} wrap />
    </Stack>
  )
}

// One request card (prototype .req): head with date tile + status, quoted
// note, to/cc recipient groups with folding, decision banner, and an actions
// row linking into the request-detail page.
function HistoryRequestCard({
  request,
  asOf,
  canceling,
  onCancel,
  onModify,
}: {
  request: LeaveRequestDetailDto
  // The server instant the snapshot was computed to. Every "can this still be
  // cancelled or changed" question is asked against it, never a local clock.
  asOf: string | null
  canceling: boolean
  onCancel: () => void
  onModify: () => void
}) {
  const approvers = request.approvers.filter((recipient) => recipient.kind === ApproverKind.To)
  const ccRecipients = request.approvers.filter((recipient) => recipient.kind === ApproverKind.Cc)
  const rejected = request.status === LeaveRequestStatus.Rejected
  const approved = request.status === LeaveRequestStatus.Approved
  const cancellable = asOf !== null && canCancelRequest(request, asOf)
  const modifiable = asOf !== null && canModifyRequest(request, asOf)

  return (
    <Card
      sx={{
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        borderRadius: '14px',
        transition: 'box-shadow .2s cubic-bezier(.22,1,.36,1)',
        '&:hover': { boxShadow: '0 10px 28px -10px rgba(16, 24, 40, 0.14)' },
      }}
      data-testid={`history-request-${request.requestId}`}
    >
      <Stack direction="row" spacing={1.75} alignItems="flex-start">
        <DateTile date={request.startDate} />
        <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Typography sx={{ fontSize: '14.5px', fontWeight: 800, letterSpacing: '-0.005em' }}>
              {formatLeaveType(request.leaveType)}
            </Typography>
            <StatusPill status={request.status} />
            {request.modificationPending ? (
              // Still approved, but a replacement is in flight: the badge is
              // what tells the two apart at a glance.
              <Box
                component="span"
                sx={{ display: 'flex' }}
                data-testid={`modification-pending-${request.requestId}`}
              >
                <RowBadge label="Change pending" hot />
              </Box>
            ) : null}
          </Stack>
          <Box sx={{ color: '#667085', minWidth: 0 }}>
            <RangeLine
              startDate={request.startDate}
              endDate={request.endDate}
              daysLabel={formatDaySplit(request.paidDays, request.unpaidDays)}
              suffix={<>· submitted {formatDayMonthLocal(request.submittedAt)}</>}
              wrap
            />
          </Box>
        </Stack>
      </Stack>

      {request.supersedes ? (
        <LinkedRequestLine
          label="Replaces the approved leave of"
          request={request.supersedes}
        />
      ) : null}
      {request.supersededBy ? (
        <LinkedRequestLine
          label={
            request.status === LeaveRequestStatus.Superseded
              ? 'Replaced by the approved leave of'
              : 'Change awaiting approval:'
          }
          request={request.supersededBy}
        />
      ) : null}

      {request.comment ? (
        // Prototype .note: quoted, italic, 3px left rule.
        <Typography
          sx={{
            fontSize: 13,
            color: 'text.secondary',
            fontStyle: 'italic',
            borderLeft: '3px solid rgba(16, 24, 40, 0.14)',
            pl: 1.5,
            py: '2px',
          }}
        >
          “{request.comment}”
        </Typography>
      ) : null}

      {approvers.length > 0 || ccRecipients.length > 0 ? (
        <Box
          sx={{
            display: 'grid',
            gap: '10px 16px',
            // Always two columns at sm (prototype .rec-groups): an
            // approvers-only card keeps its chips to the half width.
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          }}
        >
          {approvers.length > 0 ? (
            <Box>
              <Typography
                sx={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#98a2b3',
                  mb: '5px',
                }}
              >
                Approvers <Box component="span" sx={{ color: '#667085' }}>· {approvers.length}</Box>
              </Typography>
              <FoldingChips
                items={approvers.map((recipient) => ({
                  label: recipient.email,
                  title: recipient.displayName,
                }))}
              />
            </Box>
          ) : null}
          {ccRecipients.length > 0 ? (
            <Box>
              <Typography
                sx={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#98a2b3',
                  mb: '5px',
                }}
              >
                CC <Box component="span" sx={{ color: '#667085' }}>· {ccRecipients.length}</Box>
              </Typography>
              <FoldingChips
                items={ccRecipients.map((recipient) => ({
                  label: recipient.email,
                  title: recipient.displayName,
                }))}
              />
            </Box>
          ) : null}
        </Box>
      ) : null}

      {request.decisionComment ? (
        // Rejections read as caution, not alarm.
        <DecisionBanner tone={rejected ? 'bad' : 'ok'}>
          {request.decisionComment}
        </DecisionBanner>
      ) : null}

      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Button
          component={RouterLink}
          to={`/employee/history/${request.requestId}`}
          variant="text"
          sx={linkButtonSx}
          startIcon={
            <Box component="span" sx={{ display: 'flex' }}>
              <ChevronGlyph size={14} />
            </Box>
          }
        >
          View details
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {modifiable ? (
          <Button
            variant="text"
            onClick={onModify}
            data-testid={`modify-request-${request.requestId}`}
            sx={linkButtonSx}
          >
            Change dates
          </Button>
        ) : null}
        {cancellable ? (
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
            {canceling ? 'Cancelling…' : approved ? 'Cancel leave' : 'Cancel request'}
          </Button>
        ) : null}
      </Stack>

    </Card>
  )
}

export function LeaveHistoryPageContent() {
  const dispatch = useEmployeeFeatureDispatch()
  const navigate = useNavigate()
  const history = useEmployeeFeatureSelector((state) => state.history)
  // Status filtering is client-side over the loaded window (instant pills,
  // window-scoped counts); only the date window round-trips to the server.
  const [statusFilter, setStatusFilter] = useState<LeaveRequestStatus | undefined>(undefined)
  // In-flight AND already-cancelled ids: a successful cancel keeps its row
  // disabled until the refreshed snapshot replaces the list.
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(new Set())
  const [cancelError, setCancelError] = useState<string | null>(null)
  // The approved booking awaiting a confirmed cancellation, if any. The dialog
  // holds no logic of its own: what may be cancelled is decided by
  // canCancelRequest, and the server enforces it regardless.
  const [pendingCancel, setPendingCancel] = useState<string | null>(null)
  // Latest-filters ref (same pattern as useAutoRefresh): the async cancel
  // handler must refresh the CURRENT window, not the one captured when the
  // button rendered.
  const filtersRef = useRef(history.filters)
  filtersRef.current = history.filters

  useEffect(() => {
    dispatch(employeeFeatureActions.historyRequested({}))
  }, [dispatch])

  // Keep the history + balance timeline live: silently re-fetch a fresh
  // server-computed snapshot (with the current window) on a cadence and on
  // focus, so consumed days appear without a manual reload.
  useAutoRefresh(() => {
    dispatch(employeeFeatureActions.historyRequested(history.filters))
  }, DASHBOARD_REFRESH_INTERVAL_MS)
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  const hasDateFilter = history.filters.from != null || history.filters.to != null

  // Selectable calendar bounds = the span of the FULL history, captured from
  // unfiltered snapshots only — a windowed response must not shrink the
  // bounds, or the user could never widen the filter again.
  const boundsRef = useRef<{ min: string; max: string } | null>(null)
  if (!hasDateFilter && history.data) {
    boundsRef.current = historyDateBounds(history.data.requests)
  }

  const cancelRequest = async (requestId: string) => {
    setCancelingIds((prev) => new Set(prev).add(requestId))
    setCancelError(null)
    try {
      await cancelLeaveRequest(requestId)
      dispatch(employeeFeatureActions.historyRequested(filtersRef.current))
    } catch (error) {
      setCancelError(
        error instanceof Error ? error.message : 'Unable to cancel the request.',
      )
      setCancelingIds((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }
  }

  const requestCancel = (request: LeaveRequestDetailDto) => {
    // An approved booking is a commitment other people planned around, so ask
    // before handing the days back.
    if (request.status === LeaveRequestStatus.Approved) {
      setPendingCancel(request.requestId)
      return
    }
    void cancelRequest(request.requestId)
  }

  // From the history payload rather than from the dashboard: opened by deep
  // link or after a hard reload, this page is the first response of the
  // session and no dashboard fetch has set the divisor.
  adoptWorkdayHours(history.data?.hoursPerDay)
  const requests = history.data?.requests ?? []
  const asOf = history.data?.generatedAt ?? null
  const counts = historyCounts(requests)
  const visibleRequests = filterByStatus(requests, statusFilter)
  const pendingCancelRequest = requests.find(
    (request) => request.requestId === pendingCancel,
  )

  return (
    <EmployeePageFrame
      title="Request history"
      subtitle="Inspect prior leave decisions, comments, and the activity around each request."
      statusIndicator={
        history.status === 'succeeded' && history.data ? (
          <ShellStatusPill
            label={`Live · updated ${formatRelativeTime(history.data.generatedAt, nowMs)}`}
          />
        ) : undefined
      }
    >
      {/* Filters: status pills + the date window. One wrapping row on sm+;
          on xs the pills become a single horizontally scrollable row bleeding
          to the card edges (the clipped last pill hints at the scroll) and the
          date pill drops to its own left-aligned row below. */}
      <Card sx={{ p: `16px ${CARD_PAD_X}px 18px` }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
            // sm only: a wrapping column container sizes itself to its widest
            // child, which would let the pill row grow instead of scrolling.
            flexWrap: { sm: 'wrap' },
            alignItems: { sm: 'center' },
          }}
          role="group"
          aria-label="Filters"
        >
          <Box
            sx={{
              display: 'flex',
              gap: `${PILL_GAP_X}px`,
              alignItems: 'center',
              flexWrap: { xs: 'nowrap', sm: 'wrap' },
              overflowX: { xs: 'auto', sm: 'visible' },
              // Bleed to the card edges so the scroll row clips at the card
              // border, not mid-content.
              mx: { xs: `${-CARD_PAD_X}px`, sm: 0 },
              pl: { xs: `${CARD_PAD_X}px`, sm: 0 },
              // A scroll container clips both axes; give the selected pill's
              // drop shadow vertical room instead of slicing it flat.
              py: { xs: '8px', sm: 0 },
              my: { xs: '-8px', sm: 0 },
              // Keyboard focus scrolls a pill fully into view with the same
              // inset the row shows at rest, keeping the next pill peeking.
              scrollPaddingInline: `${CARD_PAD_X}px`,
              scrollbarWidth: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
              // The trailing inset is a spacer item, not padding: WebKit omits
              // a scroll container's inline-end padding from the scrollable
              // area, which would leave the last pill flush at the clipped
              // edge. The row gap already supplies its first pixels.
              '&::after': {
                content: '""',
                display: { xs: 'block', sm: 'none' },
                flex: 'none',
                inlineSize: `${CARD_PAD_X - PILL_GAP_X}px`,
              },
            }}
          >
            {statusFilters.map((filter) => (
              <FilterPill
                key={filter.label}
                label={filter.label}
                count={counts[filter.countKey]}
                selected={statusFilter === filter.value}
                onClick={() => setStatusFilter(filter.value)}
              />
            ))}
          </Box>
          <Box sx={{ ml: { sm: 'auto' } }}>
            {/* A plain range filter (no leave semantics): shows requests whose
                period overlaps [from, to]. Committing on Done sends one request. */}
            <DateRangeField
              plain
              variant="pill"
              label="Leave dates"
              testId="leave-history-date-range"
              minDate={boundsRef.current?.min}
              maxDate={boundsRef.current?.max}
              value={{
                startDate: history.filters.from ?? '',
                endDate: history.filters.to ?? '',
              }}
              onChange={(range) =>
                dispatch(
                  employeeFeatureActions.historyRequested({
                    from: range.startDate || undefined,
                    to: range.endDate || undefined,
                  }),
                )
              }
            />
          </Box>
        </Box>
      </Card>

      {history.status === 'loading' || history.status === 'idle' ? (
        <LoadingSection label="Loading history" />
      ) : null}

      {history.status === 'failed' && history.error ? (
        <ErrorSection title="History unavailable" message={history.error} />
      ) : null}

      {history.status === 'succeeded' && history.data ? (
        <>
          {cancelError ? <Alert severity="error">{cancelError}</Alert> : null}

          {requests.length === 0 ? (
            <EmptyState
              title={hasDateFilter ? 'No requests in this period' : 'No requests yet'}
              message={
                hasDateFilter
                  ? 'Try widening or clearing the date range to restore the full request history.'
                  : 'Once you submit leave, your requests and their decisions will show up here.'
              }
            />
          ) : visibleRequests.length === 0 ? (
            // Prototype .list-empty: the window has data, the status pill hides it.
            <Box
              sx={{
                p: '30px',
                textAlign: 'center',
                fontSize: 13.5,
                color: '#667085',
                border: '1px dashed rgba(16, 24, 40, 0.14)',
                borderRadius: '12px',
              }}
            >
              No requests match this filter.
            </Box>
          ) : (
            <Stack spacing={1.5}>
              {visibleRequests.map((request) => (
                <HistoryRequestCard
                  key={request.requestId}
                  request={request}
                  asOf={asOf}
                  canceling={cancelingIds.has(request.requestId)}
                  onCancel={() => requestCancel(request)}
                  onModify={() =>
                    navigate(
                      `/employee/request?modify=${encodeURIComponent(request.requestId)}`,
                    )
                  }
                />
              ))}
            </Stack>
          )}
        </>
      ) : null}

      <Dialog
        open={pendingCancelRequest !== undefined}
        onClose={() => setPendingCancel(null)}
      >
        <DialogTitle>Cancel this approved leave?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingCancelRequest
              ? `Your booked days from ${formatDate(pendingCancelRequest.startDate)} to ${formatDate(pendingCancelRequest.endDate)} go back to your balance and your approvers are notified. This cannot be undone.`
              : ''}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingCancel(null)}>Keep leave</Button>
          <Button
            color="error"
            onClick={() => {
              const requestId = pendingCancel
              setPendingCancel(null)
              if (requestId) {
                void cancelRequest(requestId)
              }
            }}
            data-testid="confirm-cancel-approved"
          >
            Cancel leave
          </Button>
        </DialogActions>
      </Dialog>
    </EmployeePageFrame>
  )
}

export function LeaveHistoryPage() {
  return (
    <EmployeeFeatureProvider>
      <LeaveHistoryPageContent />
    </EmployeeFeatureProvider>
  )
}

export default LeaveHistoryPage
