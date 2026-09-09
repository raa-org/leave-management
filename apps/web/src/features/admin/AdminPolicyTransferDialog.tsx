/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type {
  AdminEmployeeDetailDto,
  LeavePolicyDto,
  PolicyTransferMode,
  PolicyTransferPreflightDto,
  TransferEmployeePolicyDto,
} from '@workspace/contracts'
import { DateField } from '../../components/date-picker'
import type { AdminApiClient } from './admin-api'
import {
  adjustmentPreviewLines,
  apiErrorDetails,
  blockingRequestLines,
  policyTermsSummary,
  probationWarningLines,
  transferModeCopy,
} from './policy-format'
import {
  PolicyTermsFields,
  emptyPolicyTermsDraft,
  policyDraftToPayload,
  type PolicyTermsDraft,
} from './policy-ui'

// Moving an employee between policies. The dialog's job is to make the
// consequences visible BEFORE the write: the preflight reports what the
// transfer would adjust, which requests would block it, and which paid
// requests fall inside a probation window. The server re-checks everything.

export function AdminPolicyTransferDialog({
  employeeId,
  employeeName,
  currentPolicyName,
  policies,
  api,
  today,
  onClose,
  onTransferred,
}: {
  employeeId: string
  employeeName: string
  currentPolicyName?: string
  policies: LeavePolicyDto[]
  api: AdminApiClient
  today: string
  onClose: () => void
  onTransferred: (detail: AdminEmployeeDetailDto) => void
}) {
  const [creatingNew, setCreatingNew] = useState(false)
  const [policyId, setPolicyId] = useState('')
  const [draft, setDraft] = useState<PolicyTermsDraft>(() =>
    emptyPolicyTermsDraft(today),
  )
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [mode, setMode] = useState<PolicyTransferMode>('prospective')
  const [preflight, setPreflight] = useState<PolicyTransferPreflightDto | null>(
    null,
  )
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [earliestOffer, setEarliestOffer] = useState<string | null>(null)
  const [duplicateOffer, setDuplicateOffer] = useState<{
    policyId: string
    name: string
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const isBackdated = effectiveDate !== '' && effectiveDate < today
  // A retiring policy takes no new members, so it is not offered.
  const selectable = policies.filter(
    (policy) => policy.effectiveTo === undefined,
  )
  const targetName = creatingNew
    ? draft.name || 'the new policy'
    : (selectable.find((policy) => policy.policyId === policyId)?.name ??
      'the policy')

  // The dry run reruns whenever the inputs that decide it change. Only an
  // existing policy can be previewed: the new one does not exist yet.
  useEffect(() => {
    if (creatingNew || !policyId || !effectiveDate) {
      setPreflight(null)
      setPreflightError(null)
      return
    }
    let active = true
    const body: TransferEmployeePolicyDto = {
      policyId,
      effectiveDate,
      ...(isBackdated ? { mode } : {}),
    }
    api
      .preflightPolicyTransfer(employeeId, body)
      .then((result) => {
        if (active) {
          setPreflight(result)
          setPreflightError(null)
          setEarliestOffer(null)
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return
        }
        const details = apiErrorDetails(error)
        setPreflight(null)
        setPreflightError(details.message)
        setEarliestOffer(
          details.kind === 'backdateOutOfRange'
            ? details.earliestPermissibleDate
            : null,
        )
      })
    return () => {
      active = false
    }
  }, [api, creatingNew, employeeId, effectiveDate, isBackdated, mode, policyId])

  const submit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    setDuplicateOffer(null)
    try {
      let body: TransferEmployeePolicyDto
      if (creatingNew) {
        const parsed = policyDraftToPayload(draft)
        if ('error' in parsed) {
          setSubmitError(parsed.error)
          setSubmitting(false)
          return
        }
        body = {
          newPolicy: parsed.payload,
          effectiveDate,
          ...(isBackdated ? { mode } : {}),
        }
      } else {
        body = {
          policyId,
          effectiveDate,
          ...(isBackdated ? { mode } : {}),
        }
      }
      const detail = await api.transferEmployeePolicy(employeeId, body)
      onTransferred(detail)
      onClose()
    } catch (error) {
      const details = apiErrorDetails(error)
      setSubmitError(details.message)
      if (details.kind === 'duplicatePolicy') {
        setDuplicateOffer({
          policyId: details.existingPolicyId,
          name: details.existingPolicyName,
        })
      }
      if (details.kind === 'backdateOutOfRange') {
        setEarliestOffer(details.earliestPermissibleDate)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const blocking = preflight ? blockingRequestLines(preflight.blockingRequests) : []
  const warnings = preflight
    ? probationWarningLines(preflight.probationWarnings)
    : []
  const adjustments = preflight
    ? adjustmentPreviewLines(preflight.perYearAdjustments)
    : []
  const canSubmit =
    !submitting &&
    effectiveDate !== '' &&
    (creatingNew ? draft.name.trim() !== '' : policyId !== '') &&
    blocking.length === 0

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={submitting ? undefined : onClose}
      aria-labelledby="admin-policy-transfer-title"
    >
      <DialogTitle id="admin-policy-transfer-title" sx={{ pb: 1 }}>
        Transfer {employeeName} to another policy
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.25}>
          {currentPolicyName ? (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              Currently on "{currentPolicyName}".
            </Typography>
          ) : null}

          <FormControlLabel
            control={
              <Switch
                checked={creatingNew}
                onChange={(event) => {
                  setCreatingNew(event.target.checked)
                  setPreflight(null)
                  setPreflightError(null)
                }}
                disabled={submitting}
              />
            }
            label="Create a new policy for this move"
          />

          {creatingNew ? (
            <PolicyTermsFields
              draft={draft}
              onChange={setDraft}
              disabled={submitting}
            />
          ) : (
            <TextField
              select
              label="Move to"
              value={policyId}
              onChange={(event) => setPolicyId(event.target.value)}
              disabled={submitting}
              fullWidth
              size="small"
            >
              {selectable.map((policy) => (
                <MenuItem key={policy.policyId} value={policy.policyId}>
                  {policy.name} ({policyTermsSummary(policy)})
                </MenuItem>
              ))}
            </TextField>
          )}

          <Box sx={{ maxWidth: 260 }}>
            <DateField
              label="Effective from"
              value={effectiveDate}
              onChange={setEffectiveDate}
              disabled={submitting}
              fullWidth
            />
          </Box>

          {isBackdated ? (
            <Box>
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>
                This date is in the past. What should happen to the days
                already accrued?
              </Typography>
              <RadioGroup
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as PolicyTransferMode)
                }
              >
                <FormControlLabel
                  value="retroactive"
                  control={<Radio size="small" />}
                  label={
                    <Typography sx={{ fontSize: 12.5 }}>
                      {transferModeCopy(
                        'retroactive',
                        targetName,
                        effectiveDate,
                        preflight?.appliedFrom,
                      )}
                    </Typography>
                  }
                />
                <FormControlLabel
                  value="prospective"
                  control={<Radio size="small" />}
                  label={
                    <Typography sx={{ fontSize: 12.5 }}>
                      {transferModeCopy(
                        'prospective',
                        targetName,
                        effectiveDate,
                      )}
                    </Typography>
                  }
                />
              </RadioGroup>
            </Box>
          ) : null}

          {preflightError ? (
            <Alert
              severity="error"
              action={
                earliestOffer ? (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      setEffectiveDate(earliestOffer)
                      setEarliestOffer(null)
                    }}
                  >
                    Apply from {earliestOffer}
                  </Button>
                ) : undefined
              }
            >
              {preflightError}
            </Alert>
          ) : null}

          {preflight ? (
            <>
              <Divider />
              <Stack spacing={1}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>
                  What this change does
                </Typography>
                {preflight.appliedFrom !== effectiveDate ? (
                  <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                    Applied from {preflight.appliedFrom} (rates change on month
                    boundaries).
                  </Typography>
                ) : null}
                {adjustments.length === 0 ? (
                  <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                    No balance moves now; the new terms take effect from the
                    date above.
                  </Typography>
                ) : (
                  adjustments.map((line) => (
                    <Typography
                      key={line}
                      sx={{ fontSize: 12.5, color: 'text.secondary' }}
                    >
                      {line}
                    </Typography>
                  ))
                )}
              </Stack>
            </>
          ) : null}

          {blocking.length > 0 ? (
            <Alert severity="error">
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>
                These approved or pending requests hold more paid days than the
                new terms allow. Resolve them first, or move the date to
                January 1.
              </Typography>
              {blocking.map((line) => (
                <Typography key={line} sx={{ fontSize: 12.5 }}>
                  {line}
                </Typography>
              ))}
            </Alert>
          ) : null}

          {warnings.length > 0 ? (
            <Alert severity="warning">
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>
                These requests fall inside the new policy's probation period.
                Already approved days stay paid; new requests in that window
                will be unpaid.
              </Typography>
              {warnings.map((line) => (
                <Typography key={line} sx={{ fontSize: 12.5 }}>
                  {line}
                </Typography>
              ))}
            </Alert>
          ) : null}

          {submitError ? (
            <Alert
              severity="error"
              action={
                duplicateOffer ? (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      setCreatingNew(false)
                      setPolicyId(duplicateOffer.policyId)
                      setSubmitError(null)
                      setDuplicateOffer(null)
                    }}
                  >
                    Use {duplicateOffer.name}
                  </Button>
                ) : undefined
              }
            >
              {submitError}
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {submitting ? 'Transferring...' : 'Transfer'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
