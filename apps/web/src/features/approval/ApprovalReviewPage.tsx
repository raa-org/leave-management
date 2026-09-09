/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useReducer, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type {
  LeaveRequestDetailDto,
  LeaveRequestViewerContextDto,
} from '@workspace/contracts'
import {
  ApproverDecision,
  LeaveApprovalAction,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
} from '@workspace/contracts'
import { useLocation, useParams } from 'react-router-dom'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  adoptWorkdayHours,
  formatDateRange,
  formatDaySplit,
  formatRelativeTime,
  summarizeApproverGate,
  summarizeModificationDiff,
} from '../../lib/leave-format'
import { RELATIVE_TIME_TICK_MS, useNowTick } from '../../lib/use-auto-refresh'
import {
  ApproverRoutingList,
  ArrowGlyph,
  BalanceImpactRows,
  BarsGlyph,
  CheckGlyph,
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
  formatDate,
  formatDateTime,
  formatDays,
  formatLeaveType,
} from '../employee/employee-ui'
import { AdminLayout } from '../admin/AdminLayout'
import {
  ApprovalReviewApiError,
  fetchApprovalReviewRequest,
  submitApprovalReviewDecision,
} from './approvalReview.api'
import {
  approvalReviewActions,
  approvalReviewReducer,
  createInitialApprovalReviewState,
} from './approvalReview.slice'

type ApprovalReviewPageProps = {
  requestId: string
  initialRequest?: LeaveRequestDetailDto
  fetchImpl?: typeof fetch
}

type ApprovalReviewRouteParams = {
  requestId?: string
}

export function ApprovalReviewPage({
  requestId,
  initialRequest,
  fetchImpl = fetch,
}: ApprovalReviewPageProps) {
  const { pathname } = useLocation()
  const isAdminWorkspace = pathname.startsWith('/admin')
  const [state, dispatch] = useReducer(
    approvalReviewReducer,
    createInitialApprovalReviewState({
      requestId,
      request: initialRequest,
    }),
  )
  const [refreshNonce, setRefreshNonce] = useState(0)
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  useEffect(() => {
    if (!requestId) {
      return
    }

    if (initialRequest?.requestId === requestId && refreshNonce === 0) {
      dispatch(
        approvalReviewActions.bootstrapApprovalReviewState({
          requestId,
          request: initialRequest,
        }),
      )
      return
    }

    let isCancelled = false
    dispatch(approvalReviewActions.approvalReviewLoadStarted(requestId))

    void fetchApprovalReviewRequest(requestId, fetchImpl)
      .then((request) => {
        if (isCancelled) {
          return
        }
        dispatch(approvalReviewActions.approvalReviewLoadSucceeded(request))
      })
      .catch((error: unknown) => {
        if (isCancelled) {
          return
        }
        dispatch(
          approvalReviewActions.approvalReviewLoadFailed(
            getApprovalErrorMessage(error, 'load'),
          ),
        )
      })

    return () => {
      isCancelled = true
    }
  }, [fetchImpl, initialRequest, refreshNonce, requestId])

  const request = state.request
  // This page is the landing spot of every approval email and fetches nothing
  // but the request, so the request is where its divisor has to come from. The
  // email renders its figures against the org's real workday; without this the
  // page an approver follows it to would contradict it about the same request.
  adoptWorkdayHours(request?.hoursPerDay)
  const isPending = request?.status === LeaveRequestStatus.Pending
  // Authority comes from the server, never re-derived here: approvers and
  // copied recipients follow the same emailed link, and only the API knows
  // which of them the session belongs to. The flag already covers the request
  // being open (see the contract), and absent viewer context means no
  // authority, so an older payload degrades to the read-only view.
  const canDecide = request?.viewer?.canDecide ?? false
  // A vote is cast once, so a returning approver finds no form. The gate banner
  // counts votes without attributing them, so this is the only thing on the
  // page that tells them the missing buttons are their own doing.
  const ownVote = describeOwnVote(request?.viewer, isPending)
  // Progress of the all-approvers gate. This is the only feedback a partial
  // approval produces: approving while a co-approver is undecided leaves the
  // request Pending, so without this the page would re-render unchanged.
  const gate = request
    ? summarizeApproverGate(request.approvers, request.status)
    : null
  const approveState = state.submitStates[LeaveApprovalAction.Approve]
  const rejectState = state.submitStates[LeaveApprovalAction.Reject]
  const isSubmitting =
    approveState.status === 'submitting' || rejectState.status === 'submitting'
  const submitError = approveState.error ?? rejectState.error

  const handleRetry = () => {
    setRefreshNonce((current) => current + 1)
  }

  const handleSubmit = async (action: LeaveApprovalAction) => {
    if (!requestId || !request || !canDecide || isSubmitting) {
      return
    }

    dispatch(approvalReviewActions.approvalReviewSubmitStarted(action))

    try {
      const updatedRequest = await submitApprovalReviewDecision(
        requestId,
        {
          action,
          comment: state.draftComment.trim() || undefined,
        },
        fetchImpl,
      )
      dispatch(
        approvalReviewActions.approvalReviewSubmitSucceeded(updatedRequest),
      )
    } catch (error) {
      dispatch(
        approvalReviewActions.approvalReviewSubmitFailed({
          action,
          error: getApprovalErrorMessage(error, 'submit'),
        }),
      )
    }
  }

  const decisionDetail = request
    ? request.decidedAt
      ? `Updated ${formatDateTime(request.decidedAt)}`
      : gate && gate.total > 0
        ? gate.label
        : 'Awaiting reviewer action'
    : ''

  const shellProps = {
    title: 'Approval review',
    subtitle:
      'Open the leave request from the emailed approval link, review the request context, and record a clear approve or reject decision.',
    breadcrumbLabel: 'Approval review',
    titleAdornment: request ? <StatusPill status={request.status} /> : undefined,
    statusIndicator: request ? (
      <ShellStatusPill
        label={
          request.decidedAt
            ? `Decided ${formatRelativeTime(request.decidedAt, nowMs)}`
            : `Submitted ${formatRelativeTime(request.submittedAt, nowMs)}`
        }
      />
    ) : undefined,
    headerSupplement: request ? (
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
        <MetricTile label="Employee" value={request.requesterDisplayName} />
        <MetricTile
          label="Leave type"
          value={formatLeaveType(request.leaveType)}
          detail={formatDaySplit(request.paidDays, request.unpaidDays)}
        />
        <MetricTile
          label="Requested period"
          value={formatDateRange(request.startDate, request.endDate)}
          detail={`submitted ${formatDateTime(request.submittedAt)}`}
        />
        <MetricTile
          label="Decision"
          value={formatStatusLabel(request.status)}
          detail={decisionDetail}
        />
      </Box>
    ) : null,
  }

  const body = (
    <>
      {!requestId ? (
        <Alert severity="error">Approval links must include a leave request id.</Alert>
      ) : null}

      {requestId && state.loadStatus === 'loading' ? (
        <SectionCard title="Loading request">
          <Stack direction="row" spacing={1.5} alignItems="center">
            <CircularProgress size={20} aria-label="Loading" />
            <Typography variant="body2" color="text.secondary">
              Loading the leave request details.
            </Typography>
          </Stack>
        </SectionCard>
      ) : null}

      {requestId && state.loadStatus === 'error' ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={handleRetry}>
              Retry
            </Button>
          }
        >
          {state.loadError}
        </Alert>
      ) : null}

      {request && gate ? (
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
              title="Decision"
              caption={
                canDecide
                  ? 'Record the reviewer note that appears in the request history and the employee activity feed.'
                  : isPending
                    ? 'The decision will appear here once a primary approver records it.'
                    : 'The recorded decision and reviewer note for this request.'
              }
              icon={<CheckGlyph />}
            >
              {/* WHICH date is short. The tiles above price the request; this
                  says where the missing hours are, which is the question an
                  approver of a part-day request actually has. */}
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

              {/* A change to leave that is already approved, not a fresh
                  request. Stated before anything else on the card: the dates
                  below are a proposal, and an approver who reads them as the
                  only booking on the table decides the wrong question. */}
              {request.supersedes ? (
                <Box data-testid="modification-banner">
                  <DecisionBanner tone="muted">
                    This is a change to leave that is already approved. The
                    original booking stays in effect until every primary
                    approver has approved the new dates, and stays untouched if
                    the change is rejected.
                  </DecisionBanner>
                </Box>
              ) : null}

              {request.supersedes ? (
                <Box
                  data-testid="modification-diff"
                  sx={{
                    border: '1px dashed rgba(16, 24, 40, 0.14)',
                    borderRadius: '11px',
                    p: '11px 13px',
                  }}
                >
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
                    Requested change
                  </Typography>
                  <Stack>
                    {summarizeModificationDiff(request.supersedes, request).map((line) => (
                      <Stack
                        key={line.label}
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={{ xs: 0.25, sm: 1.5 }}
                        sx={{
                          py: 1,
                          '& + &': { borderTop: '1px solid', borderColor: 'divider' },
                        }}
                      >
                        <Typography
                          sx={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: '#667085',
                            flexShrink: 0,
                            width: { sm: 96 },
                          }}
                        >
                          {line.label}
                        </Typography>
                        {/* Untouched fields still print, so the approver sees
                            the whole booking rather than guessing what the
                            omitted lines were. Only a changed one is struck
                            and paired with its replacement. */}
                        <Box
                          sx={{
                            minWidth: 0,
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 0.75,
                            fontSize: 13,
                            color: 'text.primary',
                          }}
                        >
                          <Typography
                            sx={{
                              fontSize: 13,
                              fontWeight: line.changed ? 500 : 700,
                              ...(line.changed
                                ? {
                                    color: 'text.secondary',
                                    textDecoration: 'line-through',
                                  }
                                : {}),
                            }}
                          >
                            {line.before}
                          </Typography>
                          {line.changed ? (
                            <>
                              <ArrowGlyph />
                              <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                                {line.after}
                              </Typography>
                            </>
                          ) : null}
                        </Box>
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              ) : null}

              {isPending ? (
                <>
                  {gate.total > 0 ? (
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
                    >
                      <Box sx={{ flexShrink: 0, mt: '1px', display: 'flex' }}>
                        <ClockGlyph size={15} />
                      </Box>
                      {/* Rejecting a change is not rejecting the leave: the
                          approved booking survives it, so the gate has to
                          promise that outcome and not the plain one. */}
                      {request.supersedes ? (
                        <>
                          Every listed approver must approve before the new dates
                          take effect; {gate.label.toLowerCase()} so far. A single
                          rejection keeps the original approved leave in place.
                        </>
                      ) : (
                        <>
                          Every listed approver must approve before this request is
                          granted; {gate.label.toLowerCase()} so far. A single
                          rejection rejects the whole request.
                        </>
                      )}
                    </Box>
                  ) : null}

                  {/* Why there is no form. The own-vote recap takes priority: a
                      returning approver's decision below is the reason, and the
                      generic access notice would only argue with it. */}
                  {ownVote ? (
                    <DecisionBanner tone="ok">{ownVote}</DecisionBanner>
                  ) : !canDecide ? (
                    <DecisionBanner tone="muted">
                      {describeViewerAccess(request.viewer)}
                    </DecisionBanner>
                  ) : null}

                  {canDecide ? (
                    <>
                      {submitError ? (
                        <Alert severity="error">{submitError}</Alert>
                      ) : null}

                      <TextField
                        label="Decision note"
                        multiline
                        minRows={4}
                        value={state.draftComment}
                        onChange={(event) => {
                          dispatch(
                            approvalReviewActions.approvalReviewCommentChanged(
                              event.target.value,
                            ),
                          )
                        }}
                        disabled={isSubmitting}
                        placeholder="Add context for the employee and the audit trail."
                        helperText="Optional, but recommended for traceability."
                        sx={{
                          '& .MuiInputBase-input': { fontSize: 13.5 },
                          '& .MuiInputLabel-root': { fontSize: 13.5 },
                        }}
                      />

                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                        <Button
                          startIcon={
                            approveState.status === 'submitting' ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <CheckGlyph size={15} />
                            )
                          }
                          onClick={() => {
                            void handleSubmit(LeaveApprovalAction.Approve)
                          }}
                          disabled={isSubmitting}
                        >
                          Approve request
                        </Button>
                        <Button
                          variant="outlined"
                          color="error"
                          startIcon={
                            rejectState.status === 'submitting' ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : undefined
                          }
                          onClick={() => {
                            void handleSubmit(LeaveApprovalAction.Reject)
                          }}
                          disabled={isSubmitting}
                        >
                          Reject request
                        </Button>
                      </Stack>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {ownVote ? (
                    <DecisionBanner tone="ok">{ownVote}</DecisionBanner>
                  ) : null}
                  {/* A settled request that names a successor is never a dead
                      end: superseded means the replacement already won its
                      approvals, anything else means the booking here still
                      stands while its change waits on the approvers. */}
                  {request.supersededBy ? (
                    <DecisionBanner tone="muted">
                      {request.status === LeaveRequestStatus.Superseded
                        ? `This request was replaced by the leave of ${formatDate(request.supersededBy.startDate)} to ${formatDate(request.supersededBy.endDate)}.`
                        : `A change to ${formatDate(request.supersededBy.startDate)} to ${formatDate(request.supersededBy.endDate)} is awaiting approval.`}
                    </DecisionBanner>
                  ) : null}
                  {request.decisionComment ? (
                    <DecisionBanner
                      tone={request.status === LeaveRequestStatus.Approved ? 'ok' : 'bad'}
                    >
                      {request.decisionComment}
                    </DecisionBanner>
                  ) : (
                    <DecisionBanner tone="muted">
                      This request is already {formatStatusLabel(request.status).toLowerCase()}. No
                      decision note was recorded.
                    </DecisionBanner>
                  )}
                </>
              )}
            </SectionCard>

            <SectionCard
              title="Balance impact"
              caption="How this request touches the balances."
              icon={<BarsGlyph />}
            >
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
      ) : null}
    </>
  )

  if (isAdminWorkspace) {
    return <AdminLayout {...shellProps}>{body}</AdminLayout>
  }

  return <EmployeePageFrame {...shellProps}>{body}</EmployeePageFrame>
}

export function ApprovalReviewRoutePage(
  props: Omit<ApprovalReviewPageProps, 'requestId'>,
) {
  const params = useParams<ApprovalReviewRouteParams>()

  return (
    <ApprovalReviewPage
      requestId={params.requestId ?? ''}
      {...props}
    />
  )
}

export default ApprovalReviewRoutePage

function getApprovalErrorMessage(
  error: unknown,
  phase: 'load' | 'submit',
): string {
  if (error instanceof ApprovalReviewApiError) {
    if (error.status === 401) {
      return 'Sign in to review and act on this leave request.'
    }
    if (error.status === 403) {
      return 'Your account is not allowed to review this leave request.'
    }
    if (error.status === 404) {
      return 'This leave request could not be found from the approval link.'
    }
    return error.message
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return phase === 'load'
    ? 'Unable to load the leave request for review.'
    : 'Unable to submit the approval decision.'
}

// Reports the viewer their own recorded vote. This is why the form is gone for
// them — a vote is cast once — so the page has to say it, or the missing
// buttons read as a permissions bug.
function describeOwnVote(
  viewer: LeaveRequestViewerContextDto | undefined,
  isPending: boolean,
): string | null {
  if (!viewer?.ownVote) {
    return null
  }

  const verb =
    viewer.ownVote.decision === ApproverDecision.Approved
      ? 'approved'
      : 'rejected'
  const when = viewer.ownVote.decidedAt
    ? ` on ${formatDateTime(viewer.ownVote.decidedAt)}`
    : ''
  // How the outcome could still change, if at all. An admin-approver keeps the
  // override even after voting, so send them to the console — not to "ask an
  // administrator", which for a lone admin means asking themselves. A non-admin
  // approver on an open request asks one; once the request is closed nobody can
  // override it, so promise nothing.
  const remedy = viewer.canOverride
    ? ' Your decision is recorded; to change the outcome, override it from the admin console.'
    : isPending
      ? ' Your decision is recorded and cannot be changed here — ask an administrator if it needs to be overridden.'
      : ' Your decision is recorded.'
  return `You ${verb} this request${when}.${remedy}`
}

// Says why the decision form is missing. A copied recipient follows the same
// link as an approver, so landing on a page with nothing to do reads as a bug
// unless the page names the reason. Composed from the two orthogonal axes the
// server hands us — identity (standing: who you are here) and capability
// (canOverride: what you may still do) — because standing alone collapses an
// administrator who is also copied into 'copied' and would wrongly tell them
// they cannot act. Never derive the action from the standing; read the flag.
function describeViewerAccess(
  viewer: LeaveRequestViewerContextDto | undefined,
): string {
  // Identity only — no capability language here; that is appended below from
  // the flag, so it is stated once and can never contradict the standing.
  const identity = describeStandingReason(viewer?.standing)
  // canOverride already encodes the exclusions (admin role, pending, not your
  // own), so appending this whenever it is true can never reach a requester or
  // a non-admin.
  return viewer?.canOverride
    ? `${identity} You can override it from the admin console.`
    : identity
}

function describeStandingReason(
  standing: LeaveRequestViewerStanding | undefined,
): string {
  switch (standing) {
    case LeaveRequestViewerStanding.Copied:
      return 'You are copied on this request — you can follow it here, but only its primary approvers approve or reject it.'
    case LeaveRequestViewerStanding.Requester:
      return 'This is your own request, so you cannot decide it. It is waiting for its primary approvers.'
    case LeaveRequestViewerStanding.Administrator:
      return 'You are viewing this request as an administrator; its primary approvers decide it.'
    default:
      return 'You can view this request, but you are not one of its primary approvers.'
  }
}

function formatStatusLabel(status: LeaveRequestStatus): string {
  switch (status) {
    case LeaveRequestStatus.Approved:
      return 'Approved'
    case LeaveRequestStatus.Rejected:
      return 'Rejected'
    case LeaveRequestStatus.Cancelled:
      return 'Cancelled'
    case LeaveRequestStatus.Superseded:
      return 'Superseded'
    case LeaveRequestStatus.Pending:
    default:
      return 'Pending review'
  }
}
