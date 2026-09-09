/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import type { AdminAuditLogPageDto } from '@workspace/contracts'
import { AuditCategory } from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import { CheckGlyph, MetricTile, SectionCard } from '../employee/employee-ui'
import { AdminLayout } from './AdminLayout'
import { adminApi, type AdminApiClient } from './admin-api'
import { appendKeysetPage } from './keyset-paging'
import { AuditLogEntry } from './AuditLogEntry'
import {
  AUDIT_CATEGORY_OPTIONS,
  focusedUserLabel,
  summarizeAuditLogs,
} from './admin-formatters'

type AdminAuditLogsPageProps = {
  api?: AdminApiClient
  // When set, the page is scoped to one employee's audit trail (events where
  // they are the actor OR the subject). Comes from the ?userId= query param.
  userId?: string
  initialAuditLogs?: AdminAuditLogPageDto
}

type AuditFilters = {
  userId?: string
  category: AuditCategory | ''
}

type AuditState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminAuditLogPageDto
  loadingMore: boolean
  // The filters the visible data was built with. Every first-page load stores
  // a fresh object; load-more identifies its listing by (applied, cursor) —
  // the cursor alone is not enough, a filter change can produce a first page
  // ending on the same boundary row (same pattern as the activity feed).
  applied: AuditFilters
}

const emptyPage: AdminAuditLogPageDto = { items: [] }
const emptyAuditFilters: AuditFilters = { category: '' }

export default function AdminAuditLogsPage({
  api = adminApi,
  userId,
  initialAuditLogs,
}: AdminAuditLogsPageProps) {
  const [category, setCategory] = useState<AuditCategory | ''>('')
  const [state, setState] = useState<AuditState>(() => ({
    status: initialAuditLogs ? 'success' : 'idle',
    error: null,
    data: initialAuditLogs ?? emptyPage,
    loadingMore: false,
    applied: { ...emptyAuditFilters, userId: userId || undefined },
  }))

  // Skip the network on first render only when server-provided data is present
  // (tests / SSR). Any later filter change always refetches.
  const skipInitialFetch = useRef(Boolean(initialAuditLogs))

  useEffect(() => {
    if (skipInitialFetch.current) {
      skipInitialFetch.current = false
      return
    }

    // Fresh object per load: its identity marks this listing for the
    // load-more staleness checks.
    const applied: AuditFilters = { userId: userId || undefined, category }

    let active = true
    setState((current) => ({ ...current, status: 'loading', error: null }))

    api
      .getAuditLogs({
        userId: applied.userId,
        category: applied.category || undefined,
      })
      .then((data) => {
        if (active) {
          setState({
            status: 'success',
            error: null,
            data,
            loadingMore: false,
            applied,
          })
        }
      })
      .catch((error: Error) => {
        if (active) {
          setState((current) => ({
            ...current,
            status: 'error',
            error: error.message,
            loadingMore: false,
          }))
        }
      })

    return () => {
      active = false
    }
  }, [api, userId, category])

  const reload = async () => {
    const applied: AuditFilters = { userId: userId || undefined, category }
    setState((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const data = await api.getAuditLogs({
        userId: applied.userId,
        category: applied.category || undefined,
      })
      setState({ status: 'success', error: null, data, loadingMore: false, applied })
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to load audit logs.',
        loadingMore: false,
      }))
    }
  }

  const loadMore = async () => {
    const cursor = state.data.nextCursor
    // Snapshot the filters the visible list was built with (NOT the live
    // ones) — they parameterize the request and identify the listing in the
    // staleness check after the await. Only a successfully loaded listing
    // may be extended (after a failed refetch the visible data belongs to
    // the old filters).
    const applied = state.applied
    if (!cursor || state.loadingMore || state.status !== 'success') {
      return
    }
    setState((current) => ({ ...current, loadingMore: true, error: null }))
    try {
      const next = await api.getAuditLogs({
        cursor,
        userId: applied.userId,
        category: applied.category || undefined,
      })
      setState((current) => {
        const merged = appendKeysetPage(
          current,
          { cursor, applied },
          next,
          (item) => item.auditId,
        )
        return merged
          ? { ...current, status: 'success', loadingMore: false, data: merged }
          : { ...current, loadingMore: false }
      })
    } catch (error) {
      setState((current) =>
        current.applied === applied
          ? {
              ...current,
              loadingMore: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load more audit logs.',
            }
          : { ...current, loadingMore: false },
      )
    }
  }

  const summary = summarizeAuditLogs(state.data)
  const focusedLabel = userId ? focusedUserLabel(state.data.items, userId) : undefined

  return (
    <AdminLayout
      title="Administrator activity"
      subtitle="Immutable audit trail of every change across employees and administrators."
      statusIndicator={<ShellStatusPill label="Live · audit trail up to date" />}
      headerSupplement={
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          }}
        >
          {summary.map((item) => (
            <MetricTile key={item.label} label={item.label} value={item.value} size="lg" />
          ))}
        </Box>
      }
    >
      <SectionCard
        title="Audit logs"
        caption="Every create, update, and delete is recorded with the actor and the object before and after the change."
        icon={<CheckGlyph />}
        sideVariant="control"
        side={
          <TextField
            select
            label="Category"
            value={category}
            onChange={(event) => setCategory(event.target.value as AuditCategory | '')}
            // The "all" option is the empty string, which MUI treats as "no
            // selection": it renders a blank control once the floating label
            // has shrunk. displayEmpty renders the option's own label instead,
            // and the label stays shrunk so the two never overlap.
            slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            sx={{ minWidth: { sm: 220 } }}
          >
            <MenuItem value="">All categories</MenuItem>
            {AUDIT_CATEGORY_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        }
      >
        <Stack spacing={2.5}>
            {userId ? (
              <Alert
                severity="info"
                action={
                  <Button color="inherit" size="small" component={RouterLink} to="/admin/activity/audit">
                    Clear filter
                  </Button>
                }
              >
                Showing the audit trail for{' '}
                <strong>{focusedLabel ?? 'the selected employee'}</strong> (as actor or
                subject).
              </Alert>
            ) : null}

            {state.error ? (
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
                {state.error}
              </Alert>
            ) : null}

            {state.status === 'loading' && state.data.items.length === 0 ? (
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
                    <Skeleton variant="text" width="34%" />
                    <Skeleton variant="text" width="62%" />
                    <Skeleton variant="text" width="48%" />
                  </Box>
                ))}
              </Stack>
            ) : null}

            {state.status !== 'loading' && state.data.items.length === 0 ? (
              <Alert severity="info">No audit events match the current filters.</Alert>
            ) : null}

            {state.data.items.length > 0 ? (
              <Stack spacing={1.5}>
                {state.data.items.map((item) => (
                  <AuditLogEntry key={item.auditId} item={item} />
                ))}
              </Stack>
            ) : null}

            {state.status === 'success' && state.data.nextCursor ? (
              <Stack direction="row" justifyContent="center">
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={() => {
                    void loadMore()
                  }}
                  disabled={state.loadingMore}
                >
                  {state.loadingMore ? (
                    <CircularProgress size={18} color="inherit" />
                  ) : (
                    'Load older events'
                  )}
                </Button>
              </Stack>
            ) : null}
        </Stack>
      </SectionCard>
    </AdminLayout>
  )
}
