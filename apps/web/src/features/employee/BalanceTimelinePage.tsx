/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { LeaveBalanceChangeReason, LeaveType } from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  bookableDaysOf,
  formatBalanceReason,
  formatRelativeTime,
  formatLeaveType,
} from '../../lib/leave-format'
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  RELATIVE_TIME_TICK_MS,
  useAutoRefresh,
  useNowTick,
} from '../../lib/use-auto-refresh'
import { filterLedger, ledgerRows, ledgerTypeSections } from './balance-ledger'
import {
  EmployeeFeatureProvider,
  employeeFeatureActions,
  useEmployeeFeatureDispatch,
  useEmployeeFeatureSelector,
} from './employee-feature.store'
import {
  BalanceMeter,
  EmployeePageFrame,
  EmptyState,
  ErrorSection,
  LedgerRow,
  LoadingSection,
  PulseGlyph,
  SectionCard,
} from './employee-ui'

// LedgerRow now lives in the shared employee-ui module so the Redux-free admin
// zone can render the same rows; re-exported here for existing importers.
export { LedgerRow }

const REASON_OPTIONS: LeaveBalanceChangeReason[] = [
  LeaveBalanceChangeReason.Accrual,
  LeaveBalanceChangeReason.Hold,
  LeaveBalanceChangeReason.Release,
  LeaveBalanceChangeReason.Spent,
  LeaveBalanceChangeReason.CarryoverIn,
  LeaveBalanceChangeReason.CarryoverOut,
  LeaveBalanceChangeReason.Expired,
  LeaveBalanceChangeReason.Adjustment,
]

// Prototype .pills: a rounded pill group; '' is the "all" option.
function FilterPills<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T | ''; label: string }[]
  value: T | ''
  onChange: (value: T | '') => void
  ariaLabel: string
}) {
  return (
    <Box
      role="group"
      aria-label={ariaLabel}
      sx={{
        display: 'inline-flex',
        gap: '2px',
        p: '3px',
        borderRadius: '999px',
        bgcolor: '#eef2f8',
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <ButtonBase
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            sx={{
              px: 1.75,
              py: '6px',
              borderRadius: '999px',
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 700,
              color: selected ? 'primary.main' : 'text.secondary',
              bgcolor: selected ? 'background.paper' : 'transparent',
              boxShadow: selected ? '0 1px 2px rgba(16, 24, 40, 0.06)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            {option.label}
          </ButtonBase>
        )
      })}
    </Box>
  )
}

export function BalanceTimelinePageContent({
  initialTypeFilter = '',
  initialReasonFilter = '',
}: {
  /** useState initializers only - lets SSR tests reach the filtered states. */
  initialTypeFilter?: LeaveType | ''
  initialReasonFilter?: LeaveBalanceChangeReason | ''
} = {}) {
  const dispatch = useEmployeeFeatureDispatch()
  const history = useEmployeeFeatureSelector((state) => state.history)
  const dashboard = useEmployeeFeatureSelector((state) => state.dashboard)

  const [typeFilter, setTypeFilter] = useState<LeaveType | ''>(initialTypeFilter)
  const [reasonFilter, setReasonFilter] = useState<LeaveBalanceChangeReason | ''>(
    initialReasonFilter,
  )

  useEffect(() => {
    // The history payload carries the WHOLE ledger regardless of filters;
    // the dashboard supplies the per-type balances for the tiles.
    dispatch(employeeFeatureActions.historyRequested({}))
    dispatch(employeeFeatureActions.dashboardRequested())
  }, [dispatch])

  useAutoRefresh(() => {
    dispatch(employeeFeatureActions.historyRequested({}))
    dispatch(employeeFeatureActions.dashboardRequested())
  }, DASHBOARD_REFRESH_INTERVAL_MS)
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  const data = history.data
  const rows = useMemo(() => ledgerRows(data?.balanceTimeline ?? []), [data])
  const filtered = useMemo(
    () =>
      filterLedger(
        rows,
        typeFilter === '' ? null : typeFilter,
        reasonFilter === '' ? null : reasonFilter,
      ),
    [rows, typeFilter, reasonFilter],
  )
  const sections = useMemo(
    () => (data ? ledgerTypeSections(filtered, data.generatedAt) : []),
    [filtered, data],
  )

  return (
    <EmployeePageFrame
      title="Balance timeline"
      subtitle="Every accrual, hold, release, spent movement, year-end carry-over, and manual adjustment across your leave balances, newest first."
      statusIndicator={
        history.status === 'succeeded' && data ? (
          <ShellStatusPill
            label={`Live · updated ${formatRelativeTime(data.generatedAt, nowMs)}`}
          />
        ) : undefined
      }
    >
      {history.status === 'loading' || history.status === 'idle' ? (
        <LoadingSection label="Loading balance timeline" />
      ) : null}

      {history.status === 'failed' && history.error ? (
        <ErrorSection title="Balance timeline unavailable" message={history.error} />
      ) : null}

      {history.status === 'succeeded' && data ? (
        <>
          {/* Prototype .bal-tiles: the current standing per leave type. Stale
              data keeps rendering across a failed refresh; only a failure with
              nothing to show surfaces the notice. */}
          {dashboard.data ? (
            <Box
              sx={{
                display: 'grid',
                gap: 1.75,
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
              }}
            >
              {dashboard.data.balances.map((balance) => (
                <BalanceMeter key={balance.leaveType} balance={balance} variant="tile" />
              ))}
            </Box>
          ) : dashboard.status === 'failed' && dashboard.error ? (
            <ErrorSection title="Balance tiles unavailable" message={dashboard.error} />
          ) : null}

          <SectionCard
            title="Ledger"
            caption="The server is the source of truth; every movement here is a recorded transition, not a client estimate."
            icon={<PulseGlyph size={16} />}
          >
            <Stack spacing={1.5}>
              <Stack
                direction="row"
                spacing={1.5}
                rowGap={1}
                useFlexGap
                flexWrap="wrap"
                alignItems="center"
              >
                <FilterPills
                  ariaLabel="Leave type"
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={[
                    { value: '', label: 'All types' },
                    { value: LeaveType.Vacation, label: 'Vacation' },
                    { value: LeaveType.Sick, label: 'Sick' },
                  ]}
                />
                <TextField
                  select
                  value={reasonFilter}
                  onChange={(event) =>
                    setReasonFilter(event.target.value as LeaveBalanceChangeReason | '')
                  }
                  // The theme makes every text field full width; here the
                  // control sits in a row with the pills and the count, so it
                  // takes only what it needs.
                  fullWidth={false}
                  // '' is a real choice here ("All movements"), not the absence
                  // of one: without displayEmpty the select computes no display
                  // value for it and renders blank (SelectInput: isFilled(value)
                  // || displayEmpty). The field carries no label, so that blank
                  // would leave nothing on screen naming the control at all.
                  slotProps={{
                    htmlInput: {
                      'data-testid': 'ledger-reason-select',
                      'aria-label': 'Movement type',
                    },
                    select: { displayEmpty: true },
                  }}
                  sx={{
                    ml: { sm: 'auto' },
                    minWidth: 180,
                    '& .MuiOutlinedInput-root': { borderRadius: '10px' },
                    '& .MuiSelect-select': { fontSize: 13, fontWeight: 700, py: '8px' },
                  }}
                >
                  <MenuItem value="">All movements</MenuItem>
                  {REASON_OPTIONS.map((reason) => (
                    <MenuItem key={reason} value={reason}>
                      {formatBalanceReason(reason)}
                    </MenuItem>
                  ))}
                </TextField>
                <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: '#98a2b3' }}>
                  {filtered.length} {filtered.length === 1 ? 'movement' : 'movements'}
                </Typography>
              </Stack>

              {rows.length === 0 ? (
                <EmptyState
                  title="No balance movement"
                  message="Accruals, holds, releases, and spent leave entries will appear once requests are processed."
                />
              ) : filtered.length === 0 ? (
                <Box
                  sx={{
                    border: '1px dashed rgba(16, 24, 40, 0.14)',
                    borderRadius: '12px',
                    p: 3.25,
                    textAlign: 'center',
                    fontSize: 13.5,
                    color: 'text.secondary',
                  }}
                >
                  No movements match these filters.
                </Box>
              ) : (
                <Stack>
                  {sections.map((section, sectionIndex) => (
                    <Box key={section.leaveType}>
                      {/* Only when both types are on screen: with a type
                          filter on, the heading would repeat the filter. */}
                      {sections.length > 1 ? (
                        <Typography
                          sx={{
                            fontSize: 13,
                            fontWeight: 800,
                            pt: sectionIndex === 0 ? 0.5 : 2.5,
                            pb: 0.25,
                          }}
                        >
                          {formatLeaveType(section.leaveType)}
                        </Typography>
                      ) : null}
                      {section.groups.map((group, groupIndex) => (
                        <Box key={`${group.label}-${groupIndex}`}>
                          <Typography
                            sx={{
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.05em',
                              textTransform: 'uppercase',
                              color: '#98a2b3',
                              pt:
                                groupIndex === 0 && sectionIndex === 0 ? 0.5 : 1.5,
                              pb: 0.5,
                            }}
                          >
                            {group.label}
                          </Typography>
                          {group.items.map((entry, index) => (
                            <LedgerRow
                              key={`${entry.effectiveDate}-${entry.reason}-${index}`}
                              entry={entry}
                            />
                          ))}
                        </Box>
                      ))}
                    </Box>
                  ))}
                </Stack>
              )}
            </Stack>
          </SectionCard>
        </>
      ) : null}
    </EmployeePageFrame>
  )
}

export function BalanceTimelinePage() {
  return (
    <EmployeeFeatureProvider>
      <BalanceTimelinePageContent />
    </EmployeeFeatureProvider>
  )
}

export default BalanceTimelinePage
