/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState } from 'react'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type {
  AdminEmployeeListItemDto,
  LeavePolicyDto,
} from '@workspace/contracts'
import { DateField } from '../../components/date-picker'
import { SectionCard } from '../employee/employee-ui'
import type { AdminApiClient } from './admin-api'
import { AdminPolicyMemberList } from './AdminPolicyMemberList'
import {
  apiErrorDetails,
  isMigrationPolicy,
  policyIncrementHint,
  policyMembershipSummary,
  policyValidityLabel,
} from './policy-format'
import {
  DefaultPolicyChip,
  PolicyActionButton,
  PolicyTermChips,
  PolicyTermsFields,
  PolicyValidityChip,
  ShieldGlyph,
  emptyPolicyTermsDraft,
  policyCopyDraft,
  policyDraftToPayload,
  type PolicyTermsDraft,
} from './policy-ui'

// The policy catalog, as it lives inside the Settings page. Collapsed, a row
// says what the policy grants and who is on it; expanded, it spells every term
// out and puts the group's membership under the same roof, because "who is on
// this deal" is the question that follows "what is this deal".

type ListState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: LeavePolicyDto[] | null
}

type RetireTarget = { policy: LeavePolicyDto; date: string }

export function AdminPolicyCatalog({
  api,
  today,
  initialPolicies,
  initialMembers,
}: {
  api: AdminApiClient
  today: string
  initialPolicies?: LeavePolicyDto[]
  // Seeds the member list of the expanded policy for server-rendered tests.
  initialMembers?: AdminEmployeeListItemDto[]
}) {
  const [listState, setListState] = useState<ListState>(() =>
    initialPolicies
      ? { status: 'success', error: null, data: initialPolicies }
      : { status: 'idle', error: null, data: null },
  )
  const [reloadCount, setReloadCount] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(
    initialPolicies?.[0]?.policyId ?? null,
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState<PolicyTermsDraft>(() =>
    emptyPolicyTermsDraft(today),
  )
  const [createError, setCreateError] = useState<string | null>(null)
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState<LeavePolicyDto | null>(null)
  const [renameDraft, setRenameDraft] = useState({ name: '', description: '' })
  const [retiring, setRetiring] = useState<RetireTarget | null>(null)
  const [deleting, setDeleting] = useState<LeavePolicyDto | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    if (initialPolicies && reloadCount === 0) {
      return
    }
    let active = true
    setListState((current) => ({ ...current, status: 'loading' }))
    api
      .getPolicies()
      .then((policies) => {
        if (active) {
          setListState({ status: 'success', error: null, data: policies })
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setListState({
            status: 'error',
            error: (error as Error).message,
            data: null,
          })
        }
      })
    return () => {
      active = false
    }
  }, [api, initialPolicies, reloadCount])

  const reload = () => setReloadCount((count) => count + 1)
  const policies = useMemo(() => listState.data ?? [], [listState.data])

  const submitCreate = async () => {
    const parsed = policyDraftToPayload(draft)
    if ('error' in parsed) {
      setCreateError(parsed.error)
      return
    }
    setSaving(true)
    setCreateError(null)
    setDuplicateOf(null)
    try {
      await api.createPolicy(parsed.payload)
      setCreateOpen(false)
      setDraft(emptyPolicyTermsDraft(today))
      reload()
    } catch (error) {
      const details = apiErrorDetails(error)
      setCreateError(details.message)
      if (details.kind === 'duplicatePolicy') {
        setDuplicateOf(details.existingPolicyName)
      }
    } finally {
      setSaving(false)
    }
  }

  const runRowAction = async (action: () => Promise<unknown>) => {
    setRowError(null)
    try {
      await action()
      reload()
      return true
    } catch (error) {
      setRowError(apiErrorDetails(error).message)
      return false
    }
  }

  const migratedMembers = policies
    .filter(isMigrationPolicy)
    .reduce((sum, policy) => sum + policy.memberCount, 0)

  return (
    <SectionCard
      title="Leave policies"
      caption="Every employee belongs to exactly one. Terms are fixed when the policy is created, so a different deal means a new policy."
      icon={<ShieldGlyph />}
      accent="secondary"
      side={
        <Button
          size="small"
          variant="contained"
          color="secondary"
          startIcon={<AddRoundedIcon />}
          onClick={() => {
            setDraft(emptyPolicyTermsDraft(today))
            setCreateError(null)
            setDuplicateOf(null)
            setCreateOpen(true)
          }}
        >
          New policy
        </Button>
      }
      sideVariant="control"
    >
      <Stack spacing={1.5}>
        {migratedMembers > 0 ? (
          <Box
            sx={{
              border: '1px dashed',
              borderColor: 'rgba(16, 24, 40, 0.14)',
              borderRadius: '12px',
              p: '11px 13px',
              bgcolor: 'rgba(16, 24, 40, 0.015)',
              fontSize: 12.5,
              lineHeight: 1.55,
              color: 'text.secondary',
            }}
          >
            <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
              {migratedMembers === 1
                ? '1 employee still sits'
                : `${migratedMembers} employees still sit`}{' '}
              on a migration policy.
            </Box>{' '}
            The cutover minted those from old per-person allowances so no
            balance moved. Move them onto a real policy, then the migration
            policy can be retired.
          </Box>
        ) : null}
        {rowError ? <Alert severity="error">{rowError}</Alert> : null}
        {listState.status === 'error' ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={reload}>
                Retry
              </Button>
            }
          >
            {listState.error}
          </Alert>
        ) : null}
        {listState.status === 'loading' && policies.length === 0 ? (
          <Stack spacing={1}>
            <Skeleton variant="rounded" height={64} />
            <Skeleton variant="rounded" height={64} />
          </Stack>
        ) : null}
        {listState.status === 'success' && policies.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            No policies yet. Create one to start grouping employees.
          </Typography>
        ) : null}

        {policies.map((policy) => {
          const open = expanded === policy.policyId
          const canDelete =
            !policy.isDefault && policy.memberCount === 0 && policy.scheduledInCount === 0
          const canRetire = !policy.isDefault && policy.effectiveTo === undefined
          const validity = policyValidityLabel(policy, today)
          return (
            <Box
              key={policy.policyId}
              sx={{
                border: '1px solid',
                borderColor: open ? 'rgba(16, 24, 40, 0.14)' : 'divider',
                borderRadius: '12px',
                boxShadow: open ? '0 1px 2px rgba(16,24,40,.05)' : 'none',
              }}
            >
              {/* A row, not a button wrapping a link: the member count is an
                  anchor, and an anchor inside a button is invalid markup. */}
              <Stack
                direction="row"
                spacing={1.5}
                alignItems="center"
                sx={{ p: '13px 14px' }}
              >
                <ButtonBase
                  onClick={() => setExpanded(open ? null : policy.policyId)}
                  aria-expanded={open}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    justifyContent: 'flex-start',
                    gap: 1.5,
                    textAlign: 'left',
                    borderRadius: '8px',
                  }}
                >
                  <ChevronRightRoundedIcon
                    fontSize="small"
                    sx={{
                      color: '#98a2b3',
                      transform: open ? 'rotate(90deg)' : 'none',
                      transition: 'transform .22s',
                    }}
                  />
                  <Stack sx={{ minWidth: 0, flex: 1 }} spacing={0.75}>
                    <Stack
                      direction="row"
                      spacing={0.75}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography sx={{ fontSize: 14.5, fontWeight: 800 }}>
                        {policy.name}
                      </Typography>
                      {policy.isDefault ? <DefaultPolicyChip /> : null}
                      {validity.tone === 'active' ? null : (
                        <PolicyValidityChip validity={validity} />
                      )}
                    </Stack>
                    <PolicyTermChips policy={policy} />
                  </Stack>
                </ButtonBase>
                <Typography
                  sx={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: policy.memberCount ? 'secondary.main' : '#98a2b3',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {policyMembershipSummary(policy)}
                </Typography>
              </Stack>

              {open ? (
                <Stack
                  spacing={2}
                  sx={{
                    borderTop: '1px solid',
                    borderColor: 'divider',
                    p: 1.75,
                    bgcolor: 'rgba(16, 24, 40, 0.012)',
                  }}
                >
                  {policy.description ? (
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                      {policy.description}
                    </Typography>
                  ) : null}

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fit, minmax(170px, 1fr))',
                      gap: 1.25,
                    }}
                  >
                    <TermCell
                      label="Vacation"
                      value={`${policy.vacationDays} days`}
                      hint="Accrues monthly across the leave year."
                    />
                    <TermCell
                      label="Sick"
                      value={`${policy.sickDays} days`}
                      hint={
                        policy.sickDays
                          ? 'Granted up front, prorated for a mid-year joiner.'
                          : 'This policy grants no paid sick leave.'
                      }
                    />
                    {/* Not "Annual increment": the rise can land every year or
                        every N, and the cadence is in the hint below. */}
                    <TermCell
                      label="Vacation increment"
                      value={
                        policy.vacationAnnualIncrement
                          ? `+${policy.vacationAnnualIncrement} days`
                          : 'None'
                      }
                      hint={policyIncrementHint(policy)}
                    />
                    <TermCell
                      label="Probationary period"
                      value={
                        policy.probationMonths
                          ? `${policy.probationMonths} months`
                          : 'None'
                      }
                      hint={
                        policy.probationMonths
                          ? `Leave before the window ends is unpaid${
                              policy.paidSickDuringProbation
                                ? ', except sick leave.'
                                : ', including sick leave.'
                            }`
                          : 'Paid leave from day one.'
                      }
                    />
                  </Box>

                  <AdminPolicyMemberList
                    api={api}
                    policy={policy}
                    policies={policies}
                    today={today}
                    {...(initialMembers ? { initialMembers } : {})}
                    onChanged={reload}
                  />

                  <Stack
                    direction="row"
                    spacing={1}
                    flexWrap="wrap"
                    useFlexGap
                    alignItems="center"
                  >
                    <PolicyActionButton
                      size="small"
                      onClick={() => {
                        setDraft(policyCopyDraft(policy, today))
                        setCreateError(null)
                        setDuplicateOf(null)
                        setCreateOpen(true)
                      }}
                    >
                      Duplicate with changes
                    </PolicyActionButton>
                    <PolicyActionButton
                      size="small"
                      onClick={() => {
                        setRenameDraft({
                          name: policy.name,
                          description: policy.description ?? '',
                        })
                        setRenaming(policy)
                      }}
                    >
                      Rename
                    </PolicyActionButton>
                    {policy.isDefault ? null : (
                      <PolicyActionButton
                        size="small"
                        onClick={() =>
                          void runRowAction(() =>
                            api.setDefaultPolicy(policy.policyId),
                          )
                        }
                      >
                        Make default
                      </PolicyActionButton>
                    )}
                    <Box sx={{ flex: 1 }} />
                    <PolicyActionButton
                      size="small"
                      disabled={!canRetire}
                      onClick={() =>
                        setRetiring({ policy, date: policy.effectiveTo ?? '' })
                      }
                    >
                      Retire...
                    </PolicyActionButton>
                    <PolicyActionButton
                      size="small"
                      tone="danger"
                      disabled={!canDelete}
                      onClick={() => setDeleting(policy)}
                    >
                      Delete
                    </PolicyActionButton>
                  </Stack>
                  <Typography sx={{ fontSize: 11.5, color: '#98a2b3' }}>
                    {policy.isDefault
                      ? 'The default policy is where new employees land, so it can be neither retired nor deleted. Terms are fixed: to change them, duplicate this policy and move its members onto the copy.'
                      : canDelete
                        ? 'Nobody is on this policy, so it can still be deleted outright. Terms are fixed: a different deal means a new policy.'
                        : 'Someone has been on this policy, so the balance history points at it and it cannot be deleted. Retiring stops it taking new members while the record stays readable.'}
                  </Typography>
                </Stack>
              ) : null}
            </Box>
          )
        })}
      </Stack>

      {createOpen ? (
        <Dialog
          open
          fullWidth
          maxWidth="sm"
          onClose={saving ? undefined : () => setCreateOpen(false)}
          aria-labelledby="admin-create-policy-title"
        >
          <DialogTitle id="admin-create-policy-title">New policy</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {createError ? (
                <Alert severity={duplicateOf ? 'warning' : 'error'}>
                  {duplicateOf
                    ? `A policy with identical terms already exists: "${duplicateOf}". Assign employees to it instead, or change these terms.`
                    : createError}
                </Alert>
              ) : null}
              <PolicyTermsFields
                draft={draft}
                onChange={setDraft}
                disabled={saving}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setCreateOpen(false)}
              disabled={saving}
              variant="outlined"
              color="inherit"
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="secondary"
              onClick={() => void submitCreate()}
              disabled={saving}
            >
              {saving ? 'Creating...' : 'Create policy'}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {renaming ? (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          onClose={() => setRenaming(null)}
          aria-labelledby="admin-rename-policy-title"
        >
          <DialogTitle id="admin-rename-policy-title">Rename policy</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                label="Policy name"
                value={renameDraft.name}
                onChange={(event) =>
                  setRenameDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                fullWidth
                size="small"
              />
              <TextField
                label="Description"
                value={renameDraft.description}
                onChange={(event) =>
                  setRenameDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                fullWidth
                size="small"
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setRenaming(null)}
              variant="outlined"
              color="inherit"
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="secondary"
              onClick={() => {
                const target = renaming
                void runRowAction(() =>
                  api.updatePolicy(target.policyId, {
                    name: renameDraft.name,
                    description: renameDraft.description || null,
                  }),
                ).then((ok) => {
                  if (ok) {
                    setRenaming(null)
                  }
                })
              }}
            >
              Save
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {retiring ? (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          onClose={() => setRetiring(null)}
          aria-labelledby="admin-retire-policy-title"
        >
          <DialogTitle id="admin-retire-policy-title">
            Retire "{retiring.policy.name}"
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <DialogContentText sx={{ fontSize: 13 }}>
                After this date the policy takes no members. Every employee on
                it must already be transferred out (or scheduled to be) by
                then, or the change is refused.
              </DialogContentText>
              <DateField
                label="Retires after"
                value={retiring.date}
                onChange={(value) =>
                  setRetiring((current) =>
                    current ? { ...current, date: value } : current,
                  )
                }
                fullWidth
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            {retiring.policy.effectiveTo ? (
              <Button
                variant="outlined"
                color="inherit"
                onClick={() => {
                  const target = retiring.policy
                  void runRowAction(() =>
                    api.updatePolicy(target.policyId, { effectiveTo: null }),
                  ).then((ok) => {
                    if (ok) {
                      setRetiring(null)
                    }
                  })
                }}
              >
                Keep active
              </Button>
            ) : null}
            <Button
              onClick={() => setRetiring(null)}
              variant="outlined"
              color="inherit"
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="secondary"
              disabled={!retiring.date}
              onClick={() => {
                const target = retiring
                void runRowAction(() =>
                  api.updatePolicy(target.policy.policyId, {
                    effectiveTo: target.date,
                  }),
                ).then((ok) => {
                  if (ok) {
                    setRetiring(null)
                  }
                })
              }}
            >
              Retire
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {deleting ? (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          onClose={() => setDeleting(null)}
          aria-labelledby="admin-delete-policy-title"
        >
          <DialogTitle id="admin-delete-policy-title">
            Delete "{deleting.name}"
          </DialogTitle>
          <DialogContent dividers>
            <DialogContentText sx={{ fontSize: 13 }}>
              A policy anyone has ever been on cannot be deleted, because the
              balance history points at it. Retire it instead and it stops
              taking members while the record stays readable.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setDeleting(null)}
              variant="outlined"
              color="inherit"
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => {
                const target = deleting
                void runRowAction(() => api.deletePolicy(target.policyId)).then(
                  (ok) => {
                    if (ok) {
                      setDeleting(null)
                    }
                  },
                )
              }}
            >
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </SectionCard>
  )
}

function TermCell({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '11px',
        p: '10px 12px',
        bgcolor: 'background.paper',
      }}
    >
      <Typography
        sx={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '.05em',
          textTransform: 'uppercase',
          color: '#98a2b3',
        }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontSize: 15, fontWeight: 800, mt: 0.4 }}>
        {value}
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.4 }}>
        {hint}
      </Typography>
    </Box>
  )
}
