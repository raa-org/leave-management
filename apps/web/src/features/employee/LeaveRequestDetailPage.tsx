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
import { Link as RouterLink, useParams } from 'react-router-dom'
import type { LeaveRequestDetailDto } from '@workspace/contracts'
import { LeaveRequestStatus } from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  adoptWorkdayHours,
  formatDate,
  formatDateRange,
  formatDayMonth,
  formatDayMonthLocal,
  formatDaySplit,
  formatRelativeTime,
  spansYears,
  summarizeApproverGate,
} from '../../lib/leave-format'
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  RELATIVE_TIME_TICK_MS,
  useAutoRefresh,
  useNowTick,
} from '../../lib/use-auto-refresh'
import {
  cancelLeaveRequest,
  fetchLeaveRequestDetail,
  RequestDetailApiError,
} from './employee-api'
import {
  ApproverRoutingList,
  BalanceImpactRows,
  BarsGlyph,
  BubbleGlyph,
  ChevronGlyph,
  ClockGlyph,
  DecisionBanner,
  EmployeePageFrame,
  MetricTile,
  PartDayShape,
  PeopleGlyph,
  PulseGlyph,
  RequestActivityList,
  SectionCard,
  StatusPill,
  formatDateTime,
  formatDays,
  formatLeaveType,
  formatStatus,
  linkButtonSx,
} from './employee-ui'
import type { FetchLike } from '../../lib/http'

type DetailState =
  | { status: 'idle' | 'loading' }
  | { status: 'failed'; message: string; httpStatus?: number }
  | { status: 'succeeded'; request: LeaveRequestDetailDto }

export function errorCopy(state: { message: string; httpStatus?: number }): {
  title: string
  message: string
} {
  if (state.httpStatus === 404) {
    return {
      title: 'Request not found',
      message: 'This leave request does not exist or is no longer available.',
    }
  }
  if (state.httpStatus === 403) {
    return {
      title: 'No access to this request',
      message: 'You can only open your own leave requests.',
    }
  }
  return { title: 'Request unavailable', message: state.message }
}

export function LeaveRequestDetailPageContent({
  requestId,
  initialRequest,
  fetchImpl,
}: {
  requestId?: string
  // Seeds the loaded state synchronously so server-side test renders show the
  // full layout without effects (the ApprovalReviewPage pattern).
  initialRequest?: LeaveRequestDetailDto
  fetchImpl?: FetchLike
}) {
  const [state, setState] = useState<DetailState>(() =>
    initialRequest && initialRequest.requestId === requestId
      ? { status: 'succeeded', request: initialRequest }
      : { status: 'idle' },
  )
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // The instant the CLIENT last received the request, backing the honest
  // "updated N min ago" pill; the auto-refresh below keeps it moving.
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  useAutoRefresh(() => {
    setRefreshNonce((nonce) => nonce + 1)
  }, DASHBOARD_REFRESH_INTERVAL_MS)

  useEffect(() => {
    if (!requestId) {
      return
    }
    if (initialRequest && initialRequest.requestId === requestId && refreshNonce === 0) {
      return
    }
    let disposed = false
    // Refreshes keep the current content on screen; only the first load shows
    // the spinner (matching the dashboard/history refresh rule).
    setState((current) => (current.status === 'succeeded' ? current : { status: 'loading' }))
    fetchLeaveRequestDetail(requestId, fetchImpl)
      .then((request) => {
        if (!disposed) {
          setState({ status: 'succeeded', request })
          setFetchedAt(new Date().toISOString())
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setState({
            status: 'failed',
            message:
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : 'Something went wrong. Please try again.',
            httpStatus: error instanceof RequestDetailApiError ? error.status : undefined,
          })
        }
      })
    return () => {
      disposed = true
    }
  }, [requestId, initialRequest, fetchImpl, refreshNonce])

  const request = state.status === 'succeeded' ? state.request : null
  // The divisor comes off the request itself, not from whatever response
  // happened to load before it: this page is reachable by deep link and by hard
  // reload, neither of which fetches the dashboard.
  adoptWorkdayHours(request?.hoursPerDay)
  const gate = request
    ? summarizeApproverGate(request.approvers, request.status)
    : null
  const pending = request?.status === LeaveRequestStatus.Pending

  const cancelRequest = async () => {
    if (!request) {
      return
    }
    setCanceling(true)
    setCancelError(null)
    try {
      // The cancel endpoint returns the refreshed detail DTO: swap it in
      // rather than refetching.
      const updated = await cancelLeaveRequest(request.requestId, fetchImpl)
      setState({ status: 'succeeded', request: updated })
      setFetchedAt(new Date().toISOString())
    } catch (error) {
      setCancelError(
        error instanceof Error ? error.message : 'Unable to cancel the request.',
      )
    } finally {
      setCanceling(false)
    }
  }

  const statusDetail = (() => {
    if (!request || !gate) {
      return ''
    }
    if (pending) {
      const waiting = gate.total - gate.approved
      return `waiting on ${waiting} approver${waiting === 1 ? '' : 's'}`
    }
    if (request.status === LeaveRequestStatus.Cancelled) {
      return request.decidedAt ? `cancelled ${formatDateTime(request.decidedAt)}` : 'cancelled by you'
    }
    return request.decidedAt ? `updated ${formatDateTime(request.decidedAt)}` : ''
  })()

  return (
    <EmployeePageFrame
      title={request ? formatLeaveType(request.leaveType) : 'Request details'}
      subtitle={
        request
          ? `${formatDateRange(request.startDate, request.endDate)} · ${formatDaySplit(request.paidDays, request.unpaidDays)} · submitted ${formatDateTime(request.submittedAt)}`
          : 'Full decision context for one leave request.'
      }
      breadcrumbLabel="Request details"
      titleAdornment={request ? <StatusPill status={request.status} /> : undefined}
      statusIndicator={
        request ? (
          <ShellStatusPill
            label={
              fetchedAt
                ? `Live · updated ${formatRelativeTime(fetchedAt, nowMs)}`
                : 'Live · request up to date'
            }
          />
        ) : undefined
      }
    >
      <Box>
        <Button
          component={RouterLink}
          to="/employee/history"
          variant="text"
          sx={{
            ...linkButtonSx,
            color: '#667085',
            '&:hover': { color: 'primary.main', bgcolor: 'transparent' },
            // Keep the 180° flip (the glyph points right by default) while
            // nudging left on hover — a bare translateX would REPLACE the
            // rotation and flip the arrow forward.
            '&:hover .back-chev': { transform: 'rotate(180deg) translateX(-2px)' },
            px: 0,
          }}
          startIcon={
            <Box
              component="span"
              className="back-chev"
              sx={{ display: 'flex', transform: 'rotate(180deg)', transition: 'transform .15s ease' }}
            >
              <ChevronGlyph size={15} />
            </Box>
          }
        >
          Request history
        </Button>
      </Box>

      {!requestId ? (
        <Alert severity="error">No request id in the address. Open a request from the history.</Alert>
      ) : null}

      {state.status === 'loading' || state.status === 'idle' ? (
        requestId ? (
          <SectionCard title="Loading request">
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={20} aria-label="Loading" />
              <Typography variant="body2" color="text.secondary">
                Loading the request details.
              </Typography>
            </Stack>
          </SectionCard>
        ) : null
      ) : null}

      {state.status === 'failed' ? (
        <SectionCard title={errorCopy(state).title}>
          <Stack spacing={1.5} alignItems="flex-start">
            <Alert severity="error" sx={{ width: '100%' }}>
              {errorCopy(state).message}
            </Alert>
            <Stack direction="row" spacing={1}>
              <Button variant="text" sx={linkButtonSx} onClick={() => setRefreshNonce((n) => n + 1)}>
                Retry
              </Button>
              <Button component={RouterLink} to="/employee/history" variant="text" sx={linkButtonSx}>
                Back to history
              </Button>
            </Stack>
          </Stack>
        </SectionCard>
      ) : null}

      {request && gate ? (
        <>
          {/* Four metric tiles (prototype .grid-kpi). */}
          <Box
            sx={{
              display: 'grid',
              gap: 1.75,
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, minmax(0, 1fr))',
                lg: 'repeat(4, minmax(0, 1fr))',
              },
            }}
          >
            <MetricTile
              label="Leave type"
              value={formatLeaveType(request.leaveType)}
              detail={formatDaySplit(request.paidDays, request.unpaidDays)}
            />
            <MetricTile
              label="Requested period"
              value={
                request.startDate === request.endDate
                  ? formatDayMonth(request.startDate)
                  : // A New Year crossing names each end's own year; the
                    // compact year-less pair stays for the ordinary case.
                    spansYears(request.startDate, request.endDate)
                    ? `${formatDate(request.startDate)} → ${formatDate(request.endDate)}`
                    : `${formatDayMonth(request.startDate)} → ${formatDayMonth(request.endDate)}`
              }
              detail={`submitted ${formatDayMonthLocal(request.submittedAt)}`}
            />
            <MetricTile
              label="Status"
              value={formatStatus(request.status)}
              detail={statusDetail}
            />
            <MetricTile
              label="Approvers"
              value={gate.total === 0 ? 'none' : `${gate.approved}/${gate.total} approved`}
              detail={
                gate.total === 0
                  ? 'approved automatically'
                  : gate.total > 1
                    ? 'every approver must approve'
                    : 'single approver decides'
              }
            />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gap: 2.25,
              alignItems: 'start',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 7fr) minmax(300px, 5fr)' },
            }}
          >
            <Stack spacing={2.25} sx={{ minWidth: 0 }}>
              <SectionCard
                title="Summary"
                caption="What was requested and where the decision stands."
                icon={<BubbleGlyph />}
              >
                {/* Which dates are short, beside the period the tiles above
                    state. Silent on an ordinary whole-day request. */}
                <PartDayShape dayPortions={request.dayPortions} />

                {request.comment ? (
                  <Typography
                    sx={{
                      fontSize: 13.5,
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

                {pending ? (
                  <>
                    <Box
                      sx={(theme) => ({
                        display: 'flex',
                        gap: 1.25,
                        alignItems: 'flex-start',
                        borderRadius: '12px',
                        p: '12px 14px',
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        fontWeight: 600,
                        border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
                        bgcolor: alpha(theme.palette.warning.main, 0.1),
                        color: theme.palette.warning.dark,
                      })}
                      data-testid="detail-pending-gate"
                    >
                      <Box sx={{ flexShrink: 0, mt: '1px', display: 'flex' }}>
                        <ClockGlyph size={15} />
                      </Box>
                      Waiting for approval. Every listed approver has to approve before the
                      request is granted; a single rejection rejects it.
                    </Box>
                    {cancelError ? <Alert severity="error">{cancelError}</Alert> : null}
                    <Box>
                      <Button
                        variant="text"
                        disabled={canceling}
                        onClick={() => void cancelRequest()}
                        startIcon={
                          canceling ? <CircularProgress size={13} color="inherit" /> : undefined
                        }
                        data-testid={`cancel-request-${request.requestId}`}
                        sx={(theme) => ({
                          ...linkButtonSx,
                          color: 'warning.dark',
                          '&:hover': { bgcolor: alpha(theme.palette.warning.main, 0.1) },
                        })}
                      >
                        {canceling ? 'Cancelling…' : 'Cancel request'}
                      </Button>
                    </Box>
                  </>
                ) : request.decisionComment ? (
                  <DecisionBanner
                    tone={request.status === LeaveRequestStatus.Approved ? 'ok' : 'bad'}
                  >
                    {request.decisionComment}
                  </DecisionBanner>
                ) : request.status === LeaveRequestStatus.Cancelled ? (
                  <DecisionBanner tone="muted">
                    Cancelled by you. Any held days were released back to available.
                  </DecisionBanner>
                ) : null}
              </SectionCard>

              <SectionCard
                title="Balance impact"
                caption="How this request touches the balances."
                icon={<BarsGlyph />}
              >
                {/* The detail DTO's timeline is the WHOLE user+leave-type
                    ledger (a deliberate backend choice), so the movements are
                    DERIVED from the request's status; shared with the approval
                    page. */}
                <BalanceImpactRows request={request} />
              </SectionCard>
            </Stack>

            <Stack spacing={2.25} sx={{ minWidth: 0 }}>
              <SectionCard
                title="Approval routing"
                caption={
                  gate.total === 0
                    ? 'No approval was required; the request was approved automatically.'
                    : gate.total > 1
                      ? `All ${gate.total} must approve; one rejection rejects.`
                      : 'A single approver decides.'
                }
                icon={<PeopleGlyph />}
              >
                <ApproverRoutingList approvers={request.approvers} />
              </SectionCard>

              <SectionCard
                title="Request activity"
                caption="Everything that happened, newest last."
                icon={<PulseGlyph />}
              >
                <RequestActivityList activity={request.activity} />
              </SectionCard>
            </Stack>
          </Box>
        </>
      ) : null}
    </EmployeePageFrame>
  )
}

export function LeaveRequestDetailRoutePage() {
  const { requestId } = useParams<{ requestId: string }>()
  return <LeaveRequestDetailPageContent requestId={requestId} />
}

export default LeaveRequestDetailRoutePage
