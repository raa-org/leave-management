/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import DoDisturbAltRoundedIcon from '@mui/icons-material/DoDisturbAltRounded'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type {
  AdminActivityFeedItemDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import {
  LeaveApprovalAction,
  LeaveRequestStatus,
} from '@workspace/contracts'
import { ApproverAvatar } from '../employee/employee-ui'
import type { AdminApiClient } from './admin-api'
import {
  describeApproverStanding,
  formatDateRange,
  formatDaySplit,
  formatDays,
  formatLeaveType,
  formatStatus,
  summarizeApproverGate,
} from './admin-formatters'

// Uppercase micro-label used across the redesign (prototype .sec-t / eyebrow).
const microLabelSx = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color: '#98a2b3',
}

type AdminForceDecisionDialogProps = {
  // Non-nullable by design: the parent renders this component only while a row
  // is targeted. An `item: T | null` prop with `open={item !== null}` would not
  // work — JSX children are evaluated BEFORE MUI decides not to mount them, so
  // every `item.x` below would be both a strict-null compile error and a
  // runtime throw on the closed state.
  item: AdminActivityFeedItemDto
  api: AdminApiClient
  onDecided: (detail: LeaveRequestDetailDto) => void
  onClose: () => void
}

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; data: LeaveRequestDetailDto }
  | { status: 'error'; error: string }

export function AdminForceDecisionDialog({
  item,
  api,
  onDecided,
  onClose,
}: AdminForceDecisionDialogProps) {
  const [detailState, setDetailState] = useState<DetailState>({
    status: 'loading',
  })
  const [reason, setReason] = useState('')
  const [retryNonce, setRetryNonce] = useState(0)
  // Non-null means "submitting" AND names which button spins, so the two can
  // never disagree.
  const [submitAction, setSubmitAction] = useState<LeaveApprovalAction | null>(
    null,
  )
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Loads the approvers so the admin sees who they are about to overrule. This
  // effect only ever writes LOCAL state: calling the parent's onDecided from
  // here would force it into the dep array (react-hooks/exhaustive-deps is on
  // for apps/web), and a parent callback that triggers a parent setState would
  // then loop fetch -> setState -> new callback identity -> fetch.
  useEffect(() => {
    let isCancelled = false
    setDetailState({ status: 'loading' })

    api
      .getLeaveRequestDetail(item.requestId)
      .then((data) => {
        if (!isCancelled) {
          setDetailState({ status: 'ready', data })
        }
      })
      .catch((error: unknown) => {
        if (!isCancelled) {
          setDetailState({
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load the approvers for this request.',
          })
        }
      })

    return () => {
      isCancelled = true
    }
  }, [api, item.requestId, retryNonce])

  const detail = detailState.status === 'ready' ? detailState.data : null
  const gate = detail
    ? summarizeApproverGate(detail.approvers, detail.status)
    : null
  const alreadySettled =
    detail !== null && detail.status !== LeaveRequestStatus.Pending
  const submitting = submitAction !== null
  const trimmedReason = reason.trim()
  // The server computes override authority; the console obeys it rather than
  // re-deriving from status. Absent (still loading, or a payload without viewer)
  // reads as no authority, so submit stays closed until the flag is known.
  const canOverride = detail?.viewer?.canOverride ?? false
  const canSubmit =
    trimmedReason !== '' && !submitting && !alreadySettled && canOverride

  const handleSubmit = async (action: LeaveApprovalAction) => {
    if (!canSubmit) {
      return
    }
    setSubmitAction(action)
    setSubmitError(null)

    try {
      const updated = await api.forceDecideRequest(item.requestId, {
        action,
        comment: trimmedReason,
      })
      onDecided(updated)
      onClose()
    } catch (error) {
      setSubmitAction(null)
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Unable to record the override.',
      )
    }
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={submitting ? undefined : onClose}
      aria-labelledby="admin-force-decision-title"
    >
      <DialogTitle id="admin-force-decision-title" sx={{ pb: 1 }}>
        Override the approver gate
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Stack spacing={0.35}>
            <Typography sx={{ fontSize: 17, fontWeight: 800, color: '#101828' }}>
              {item.employeeDisplayName}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              {formatLeaveType(item.leaveType)} ·{' '}
              {formatDateRange(item.startDate, item.endDate)} ·{' '}
              {formatDaySplit(item.paidDays, item.unpaidDays)}
            </Typography>
          </Stack>

          <Divider />

          {detailState.status === 'loading' ? (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                Loading the approvers for this request.
              </Typography>
            </Stack>
          ) : null}

          {detailState.status === 'error' ? (
            // The buttons stay live: an override exists precisely to unblock a
            // stuck request, so a failed read must not become a second blocker.
            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setRetryNonce((current) => current + 1)
                  }}
                >
                  Retry
                </Button>
              }
            >
              {detailState.error} You can still record the override without it.
            </Alert>
          ) : null}

          {alreadySettled && detail ? (
            <Alert severity="info">
              This request is already {formatStatus(detail.status).toLowerCase()}{' '}
              and can no longer be decided. Close this dialog and refresh the
              feed.
            </Alert>
          ) : null}

          {detail && !alreadySettled ? (
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={microLabelSx}>
                  Approvers you would overrule
                </Typography>
                {gate && gate.total > 0 ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={gate.label}
                    sx={{
                      fontWeight: 700,
                      fontSize: 11.5,
                      borderColor: 'divider',
                      color: 'text.secondary',
                    }}
                  />
                ) : null}
              </Stack>

              {detail.approvers.length === 0 ? (
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  No approval recipients are attached to this request.
                </Typography>
              ) : (
                <Stack spacing={0.75}>
                  {detail.approvers.map((approver) => (
                    <Stack
                      key={approver.email}
                      direction="row"
                      spacing={1.25}
                      alignItems="center"
                      sx={{
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: '11px',
                        p: '9px 12px',
                      }}
                    >
                      <ApproverAvatar
                        email={approver.email}
                        displayName={approver.displayName}
                        size={30}
                      />
                      <Stack sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
                          {approver.displayName ?? approver.email}
                        </Typography>
                        {/* An override singles one person out of this list, and
                            two colleagues can share a name — so the address
                            stays on screen wherever a name is standing in for
                            it. */}
                        {approver.displayName ? (
                          <Typography
                            sx={{ fontSize: 11.5, color: 'text.secondary' }}
                            noWrap
                          >
                            {approver.email}
                          </Typography>
                        ) : null}
                      </Stack>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', flexShrink: 0 }}>
                        {describeApproverStanding(approver, detail.status)}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              )}

              <Alert severity="warning">
                An override settles this request from your decision alone. It
                does not record a decision for the approvers above, so the
                reason you give is the only account of why they were bypassed.
              </Alert>
            </Stack>
          ) : null}

          {submitError ? <Alert severity="error">{submitError}</Alert> : null}

          <TextField
            label="Override reason"
            color="secondary"
            multiline
            minRows={3}
            required
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
            }}
            disabled={submitting || alreadySettled}
            placeholder="Why is this request being decided without the approvers?"
            helperText="Required. Recorded on the request, its history, and the audit trail."
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, '& > :first-of-type': { mr: 'auto' } }}>
        <Button onClick={onClose} disabled={submitting} color="inherit">
          Cancel
        </Button>
        <Button
          variant="outlined"
          color="error"
          startIcon={
            submitAction === LeaveApprovalAction.Reject ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              <DoDisturbAltRoundedIcon />
            )
          }
          onClick={() => {
            void handleSubmit(LeaveApprovalAction.Reject)
          }}
          disabled={!canSubmit}
        >
          Reject request
        </Button>
        <Button
          variant="contained"
          color="secondary"
          startIcon={
            submitAction === LeaveApprovalAction.Approve ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              <CheckCircleOutlineRoundedIcon />
            )
          }
          onClick={() => {
            void handleSubmit(LeaveApprovalAction.Approve)
          }}
          disabled={!canSubmit}
        >
          Approve request
        </Button>
      </DialogActions>
    </Dialog>
  )
}

