/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import type {
  AdminEmployeeListItemDto,
  LeavePolicyDto,
} from '@workspace/contracts'
import type { AdminApiClient } from './admin-api'
import { AdminPolicyMoveDialog } from './AdminPolicyMoveDialog'
import {
  memberSinceLabel,
  probationMemberLabel,
  scheduledDepartureLabel,
} from './policy-format'
import { ApproverAvatar } from '../employee/employee-ui'
import {
  MemberFlagChip,
  PolicyActionButton,
  SelectAllCheckbox,
} from './policy-ui'

// The server caps a directory page at 200 rows. A policy with more members
// than that is listed up to the cap and says so, rather than silently showing
// a slice as if it were everyone.
const MEMBER_PAGE_LIMIT = 200

type MembersState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  items: AdminEmployeeListItemDto[]
  truncated: boolean
}

export function AdminPolicyMemberList({
  api,
  policy,
  policies,
  today,
  initialMembers,
  onChanged,
}: {
  api: AdminApiClient
  policy: LeavePolicyDto
  // The catalog, so a move can name its destination. Retiring policies take no
  // new members and are not offered.
  policies: LeavePolicyDto[]
  today: string
  // Seeds the list synchronously for the server-rendered tests.
  initialMembers?: AdminEmployeeListItemDto[]
  onChanged: () => void
}) {
  const [state, setState] = useState<MembersState>(() =>
    initialMembers
      ? { status: 'success', error: null, items: initialMembers, truncated: false }
      : { status: 'idle', error: null, items: [], truncated: false },
  )
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const destinations = useMemo(
    () =>
      policies.filter(
        (candidate) =>
          candidate.policyId !== policy.policyId &&
          candidate.effectiveTo === undefined,
      ),
    [policies, policy.policyId],
  )
  const [destination, setDestination] = useState('')
  const [moving, setMoving] = useState<{
    target: LeavePolicyDto
    employees: AdminEmployeeListItemDto[]
  } | null>(null)
  const [adding, setAdding] = useState(false)
  const [outsiders, setOutsiders] = useState<AdminEmployeeListItemDto[]>([])

  useEffect(() => {
    if (initialMembers && reload === 0) {
      return
    }
    let active = true
    setState((current) => ({ ...current, status: 'loading' }))
    api
      .getEmployees({ policyId: policy.policyId, limit: MEMBER_PAGE_LIMIT })
      .then((page) => {
        if (active) {
          setState({
            status: 'success',
            error: null,
            items: page.items,
            truncated: Boolean(page.nextCursor),
          })
          setSelected([])
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: 'error',
            error: (error as Error).message,
            items: [],
            truncated: false,
          })
        }
      })
    return () => {
      active = false
    }
  }, [api, initialMembers, policy.policyId, reload])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? state.items.filter((member) =>
          `${member.displayName} ${member.email}`.toLowerCase().includes(needle),
        )
      : state.items
  }, [query, state.items])

  const openAdd = async () => {
    // Everyone NOT on this policy: the same directory endpoint, unfiltered,
    // minus the current members.
    const page = await api.getEmployees({ limit: MEMBER_PAGE_LIMIT })
    setOutsiders(
      page.items.filter((employee) => employee.policyId !== policy.policyId),
    )
    setAdding(true)
  }

  const afterMove = () => {
    setMoving(null)
    setAdding(false)
    setReload((count) => count + 1)
    onChanged()
  }

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.paper',
        overflow: 'hidden',
      }}
    >
      <Stack
        direction="row"
        spacing={1.25}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ p: '11px 13px', borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <SelectAllCheckbox
          shownIds={shown.map((member) => member.employeeId)}
          selected={selected}
          onChange={setSelected}
        />
        <Typography
          sx={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '.05em',
            textTransform: 'uppercase',
            color: '#98a2b3',
          }}
        >
          Members · {state.items.length}
        </Typography>
        <TextField
          size="small"
          fullWidth={false}
          placeholder="Search members"
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
        <PolicyActionButton size="small" onClick={() => void openAdd()}>
          Add employees
        </PolicyActionButton>
      </Stack>

      {state.status === 'error' ? (
        <Alert severity="error" sx={{ m: 1.5 }}>
          {state.error}
        </Alert>
      ) : null}
      {state.status === 'loading' && state.items.length === 0 ? (
        <Stack spacing={0.5} sx={{ p: 1.5 }}>
          <Skeleton variant="rounded" height={38} />
          <Skeleton variant="rounded" height={38} />
        </Stack>
      ) : null}

      <Box sx={{ maxHeight: 246, overflowY: 'auto' }}>
        {shown.map((member) => {
          const scheduled = scheduledDepartureLabel(member.policyScheduled)
          const probation = probationMemberLabel(member.probationEndsOn)
          return (
            <Stack
              key={member.employeeId}
              direction="row"
              spacing={1.375}
              alignItems="center"
              sx={{
                p: '9px 13px',
                borderBottom: '1px solid',
                borderColor: 'divider',
                bgcolor: selected.includes(member.employeeId)
                  ? 'rgba(15, 118, 110, 0.1)'
                  : 'transparent',
                '&:hover': {
                  bgcolor: selected.includes(member.employeeId)
                    ? 'rgba(15, 118, 110, 0.1)'
                    : 'rgba(16, 24, 40, 0.02)',
                },
              }}
            >
              <Checkbox
                size="small"
                color="secondary"
                sx={{ p: 0.5 }}
                checked={selected.includes(member.employeeId)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, member.employeeId]
                      : current.filter((id) => id !== member.employeeId),
                  )
                }
                inputProps={{
                  'aria-label': `Select ${member.displayName}`,
                }}
              />
              <ApproverAvatar
                email={member.email}
                displayName={member.displayName}
              />
              <Stack sx={{ minWidth: 0, flex: 1 }}>
                <Stack
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  flexWrap="wrap"
                  useFlexGap
                >
                  <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                    {member.displayName}
                  </Typography>
                  {probation ? (
                    <MemberFlagChip label={probation} tone="warning" />
                  ) : null}
                  {scheduled ? <MemberFlagChip label={scheduled} /> : null}
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }} noWrap>
                  {member.email}
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 11.5, color: '#98a2b3' }} noWrap>
                {memberSinceLabel(member.policySince)}
              </Typography>
            </Stack>
          )
        })}
        {state.status === 'success' && shown.length === 0 ? (
          <Typography
            sx={{ p: 2.5, textAlign: 'center', fontSize: 12.5, color: '#98a2b3' }}
          >
            {state.items.length
              ? 'Nobody matches that search.'
              : 'No members yet. Add employees from another policy.'}
          </Typography>
        ) : null}
      </Box>

      {state.truncated ? (
        <Typography sx={{ p: 1.5, fontSize: 11.5, color: 'text.secondary' }}>
          Showing the first {MEMBER_PAGE_LIMIT} members.{' '}
          <RouterLink to={`/admin/employees?policy=${policy.policyId}`}>
            Open the directory
          </RouterLink>{' '}
          for the rest.
        </Typography>
      ) : null}

      {selected.length > 0 ? (
        <Stack
          direction="row"
          spacing={1.25}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{
            p: '11px 13px',
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'rgba(15, 118, 110, 0.1)',
          }}
        >
          <Typography
            sx={{ fontSize: 12.5, fontWeight: 800, color: 'secondary.main' }}
          >
            {selected.length} selected
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography
            component="label"
            htmlFor="policy-move-target"
            sx={{ fontSize: 11.5, fontWeight: 700, color: 'text.secondary' }}
          >
            Move to
          </Typography>
          <TextField
            select
            size="small"
            fullWidth={false}
            id="policy-move-target"
            value={destination || destinations[0]?.policyId || ''}
            onChange={(event) => setDestination(event.target.value)}
            sx={{
              minWidth: 180,
              '& .MuiSelect-select': {
                py: '7px',
                fontSize: 12.5,
                fontWeight: 700,
              },
            }}
          >
            {destinations.map((candidate) => (
              <MenuItem key={candidate.policyId} value={candidate.policyId}>
                {candidate.name}
              </MenuItem>
            ))}
          </TextField>
          <Button
            size="small"
            variant="contained"
            color="secondary"
            sx={{ minHeight: 32, py: '7px', px: '12px', fontSize: 12.5 }}
            disabled={destinations.length === 0}
            onClick={() => {
              const targetId = destination || destinations[0]?.policyId
              const target = destinations.find(
                (candidate) => candidate.policyId === targetId,
              )
              if (target) {
                setMoving({
                  target,
                  employees: state.items.filter((member) =>
                    selected.includes(member.employeeId),
                  ),
                })
              }
            }}
          >
            Move...
          </Button>
          <PolicyActionButton size="small" onClick={() => setSelected([])}>
            Clear
          </PolicyActionButton>
        </Stack>
      ) : null}

      {moving ? (
        <AdminPolicyMoveDialog
          api={api}
          targetPolicy={moving.target}
          employees={moving.employees}
          intent="move"
          today={today}
          onClose={() => setMoving(null)}
          onDone={afterMove}
        />
      ) : null}
      {adding ? (
        <AdminPolicyMoveDialog
          api={api}
          targetPolicy={policy}
          employees={outsiders}
          intent="add"
          today={today}
          onClose={() => setAdding(false)}
          onDone={afterMove}
        />
      ) : null}
    </Box>
  )
}
