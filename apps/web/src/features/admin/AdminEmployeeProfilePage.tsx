/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { Link as RouterLink, useLocation, useParams } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import type {
  AdminAuditLogPageDto,
  AdminEmployeeDetailDto,
  CountryDto,
  EmployeePolicyDto,
  HolidayCalendarDto,
  LeaveBalanceChangeDto,
  LeavePolicyDto,
} from '@workspace/contracts'
import { AppRoleName, EmployeeProfileStatus, LeaveType } from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import { ledgerRows, ledgerTypeSections } from '../employee/balance-ledger'
import {
  ApproverAvatar,
  BalanceMeter,
  ChevronGlyph,
  DaysStepper,
  LedgerRow,
  SectionCard,
  StatusPill,
  segmentedControlSx,
} from '../employee/employee-ui'
import { AdminLayout } from './AdminLayout'
import { adminApi, type AdminApiClient } from './admin-api'
import { AdminPolicyTransferDialog } from './AdminPolicyTransferDialog'
import {
  apiErrorDetails,
  currentPolicyLine,
  probationLine,
  scheduledTransferLine,
  shapeMembershipTimeline,
} from './policy-format'
import { AuditLogEntry } from './AuditLogEntry'
import {
  countryLabel,
  formatDate,
  formatDateTime,
  formatLeaveType,
  formatRequestDateRange,
  formatRoleName,
  formatStatus,
} from './admin-formatters'
import { DateField } from '../../components/date-picker'
import {
  accruedSplitOf,
  adoptWorkdayHours,
  bookableDaysOf,
  carriedOverFromLastYearSuffix,
  floorDays,
  formatDaySplit,
  formatDays,
  roundDays,
  snapDaysToHourGrid,
} from '../../lib/leave-format'

// Sections of the employee profile. Hash-driven so the directory can deep-link
// (e.g. .../employees/:id#audit); the real tab/tabpanel roles apply because
// these switch panes within one page rather than navigating routes.
export type ProfileTab = 'profile' | 'balance' | 'requests' | 'audit'

type AdminEmployeeProfilePageProps = {
  api?: AdminApiClient
  // Seeds the detail synchronously so server-side test renders show the full
  // profile without effects (same idiom as the other admin pages' initial*).
  initialEmployeeDetail?: AdminEmployeeDetailDto
  initialCountries?: CountryDto[]
  // Seeds the employee's audit events synchronously so the Audit pane renders
  // its inline list under a static test render (short-circuits the fetch).
  initialAuditEvents?: AdminAuditLogPageDto
  // Seeds the policy panel synchronously (the membership timeline is its own
  // endpoint, so without this a static render shows the empty state).
  initialEmployeePolicy?: EmployeePolicyDto
  // useState initializer only — lets SSR tests reach the other profile tabs.
  initialTab?: ProfileTab
}

type DetailState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminEmployeeDetailDto | null
}

type AuditState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminAuditLogPageDto | null
}

const PROFILE_TAB_VALUES: ProfileTab[] = ['profile', 'balance', 'requests', 'audit']

// Maps a URL hash ('#audit') to a known tab; anything unknown falls back to
// Profile, mirroring the prototype's selectTab. The Timeline tab has merged
// into Balance, so an old '#timeline' deep link resolves there gracefully.
function tabFromHash(hash: string): ProfileTab {
  const raw = hash.replace(/^#/, '')
  if (raw === 'timeline') {
    return 'balance'
  }
  return PROFILE_TAB_VALUES.includes(raw as ProfileTab) ? (raw as ProfileTab) : 'profile'
}

export default function AdminEmployeeProfilePage({
  api = adminApi,
  initialEmployeeDetail,
  initialCountries,
  initialAuditEvents,
  initialEmployeePolicy,
  initialTab,
}: AdminEmployeeProfilePageProps) {
  const { employeeId: routeEmployeeId } = useParams<{ employeeId: string }>()
  const location = useLocation()

  const [detailState, setDetailState] = useState<DetailState>(() =>
    initialEmployeeDetail
      ? { status: 'success', error: null, data: initialEmployeeDetail }
      : { status: 'idle', error: null, data: null },
  )
  const [detailRetry, setDetailRetry] = useState(0)
  const [auditState, setAuditState] = useState<AuditState>(() =>
    initialAuditEvents
      ? { status: 'success', error: null, data: initialAuditEvents }
      : { status: 'idle', error: null, data: null },
  )
  const [countries, setCountries] = useState<CountryDto[]>(initialCountries ?? [])
  const [tab, setTab] = useState<ProfileTab>(
    () => initialTab ?? tabFromHash(location.hash),
  )

  // Hash-driven tab switch: update the address so the current tab is
  // deep-linkable, without pushing a new history entry (mirrors the prototype).
  const selectTab = (next: ProfileTab) => {
    setTab(next)
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const target = `#${next}`
      if (window.location.hash !== target) {
        window.history.replaceState(null, '', target)
      }
    }
  }

  useEffect(() => {
    if (!routeEmployeeId) {
      // No route param: either a test seeded the detail (handled by the
      // initializer) or the address is missing the id entirely.
      if (!initialEmployeeDetail) {
        setDetailState({
          status: 'error',
          error: 'No employee id in the address.',
          data: null,
        })
      }
      return
    }
    // Already have this employee from the initial payload; skip the first fetch.
    if (
      initialEmployeeDetail &&
      initialEmployeeDetail.employeeId === routeEmployeeId &&
      detailRetry === 0
    ) {
      return
    }

    let active = true
    setDetailState((current) => ({ ...current, status: 'loading', error: null }))
    api
      .getEmployeeDetail(routeEmployeeId)
      .then((data) => {
        if (active) {
          setDetailState({ status: 'success', error: null, data })
        }
      })
      .catch((error: Error) => {
        if (active) {
          setDetailState({ status: 'error', error: error.message, data: null })
        }
      })

    return () => {
      active = false
    }
  }, [api, routeEmployeeId, initialEmployeeDetail, detailRetry])

  // Countries back the location picker and resolve the country facts. Small,
  // rarely-changing global list; a failure is non-fatal (the editor merges in
  // the employee's current country either way).
  useEffect(() => {
    if (initialCountries) {
      return
    }
    let active = true
    api
      .getCountries()
      .then((data) => {
        if (active) {
          setCountries(data)
        }
      })
      .catch(() => {
        // Non-fatal: leave the list empty; the editor still offers the current one.
      })
    return () => {
      active = false
    }
  }, [api, initialCountries])

  // The employee's audit events, fetched in parallel with the detail so the
  // Audit pane can show them inline (and the tab a count badge). Deliberately
  // non-fatal: a failure here shows a small notice in the pane and never blocks
  // the rest of the profile. Seeded synchronously in tests via initialAuditEvents.
  useEffect(() => {
    if (!routeEmployeeId || initialAuditEvents) {
      return
    }
    let active = true
    setAuditState((current) => ({ ...current, status: 'loading', error: null }))
    api
      .getAuditLogs({ userId: routeEmployeeId })
      .then((data) => {
        if (active) {
          setAuditState({ status: 'success', error: null, data })
        }
      })
      .catch((error: Error) => {
        if (active) {
          setAuditState({ status: 'error', error: error.message, data: null })
        }
      })
    return () => {
      active = false
    }
  }, [api, routeEmployeeId, initialAuditEvents])

  const detail = detailState.data
  // From the profile payload, not from a settings fetch this page never makes:
  // only the admin Settings tab reads the endpoint that owns the workday, so a
  // console session that never opened it used to render every figure here (and
  // step the balance correction below) against the default eight.
  adoptWorkdayHours(detail?.hoursPerDay)
  // The employee's real ledger, shipped whole on the detail payload — not a
  // fold of the per-request timelines, which would miss the rows that belong
  // to no request (year-close carryover and expiry) and could collapse two
  // genuinely identical movements. One stream, newest first.
  const ledgerMovements = detail ? ledgerRows(detail.balanceTimeline) : []

  const name = detail?.displayName ?? 'Employee'
  const vacation = detail?.balances.find((b) => b.leaveType === LeaveType.Vacation)
  const sick = detail?.balances.find((b) => b.leaveType === LeaveType.Sick)

  return (
    <AdminLayout
      title={name}
      subtitle={detail?.email ?? 'Full profile: role, projects, balances, requests, and audit trail.'}
      breadcrumbLabel={detail ? name : 'Employee'}
      statusIndicator={<ShellStatusPill label="Live · profile up to date" />}
      titleIcon={
        detail ? (
          <ApproverAvatar email={detail.email} displayName={name} size={52} />
        ) : undefined
      }
      titleAdornment={
        detail ? (
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            {distinguishingRoles(detail.roleNames).map((roleName) => (
              <RoleChip key={roleName} role={formatRoleName(roleName)} />
            ))}
            <ProfileStatusChip status={detail.profileStatus} />
          </Stack>
        ) : undefined
      }
      headerActions={
        detail ? (
          // Prototype .p-side: three compact stat tiles on the RIGHT of the
          // name row (VACATION a/total, SICK a/total, PROJECTS count).
          <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap>
            <ProfileStatTile label="Vacation" value={<AvailableOfTotal balance={vacation} />} />
            <ProfileStatTile label="Sick" value={<AvailableOfTotal balance={sick} />} />
            <ProfileStatTile label="Projects" value={detail.projects.length} />
          </Stack>
        ) : undefined
      }
    >
      <Box>
        <Button
          component={RouterLink}
          to="/admin/employees"
          variant="text"
          sx={{
            fontSize: '13px',
            fontWeight: 700,
            color: '#667085',
            px: 0,
            '&:hover': { color: 'secondary.main', bgcolor: 'transparent' },
            '&:hover .back-chev': { transform: 'rotate(180deg) translateX(-2px)' },
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
          All employees
        </Button>
      </Box>

      {detailState.error ? (
        <SectionCard title="Profile unavailable">
          <Stack spacing={1.5} alignItems="flex-start">
            <Alert severity="error" sx={{ width: '100%' }}>
              {detailState.error}
            </Alert>
            <Stack direction="row" spacing={1}>
              <Button
                variant="text"
                size="small"
                onClick={() => setDetailRetry((count) => count + 1)}
              >
                Retry
              </Button>
              <Button component={RouterLink} to="/admin/employees" variant="text" size="small">
                Back to employees
              </Button>
            </Stack>
          </Stack>
        </SectionCard>
      ) : null}

      {detailState.status === 'loading' && !detail ? (
        <Stack spacing={2}>
          <Skeleton variant="text" width="36%" />
          <Skeleton variant="rounded" height={120} />
          <Skeleton variant="rounded" height={240} />
        </Stack>
      ) : null}

      {detail ? (
        <Stack spacing={2.25}>
          <ProfileTabBar
            current={tab}
            onChange={selectTab}
            counts={{
              requests: detail.requestHistory.length,
              audit: auditState.data ? auditState.data.items.length : null,
            }}
          />

          <Card sx={{ p: { xs: 2.5, md: 3 } }}>
            {/* Profile stays mounted (only hidden) so the editor keeps its
                in-progress fields across tab switches; the other panes are
                cheap to rebuild and mount only when active. */}
            <ProfilePane value="profile" current={tab}>
              <Stack spacing={2.75}>
                {/* Real backend signal the prototype's mock lacks: names the
                    empty required fields behind a PendingSetup profile. */}
                {detail.profileStatus === EmployeeProfileStatus.PendingSetup ? (
                  <Alert severity="warning">{missingProfileFieldsMessage(detail)}</Alert>
                ) : null}

                <EmployeeProfilePanel
                  detail={detail}
                  api={api}
                  countries={countries}
                  {...(initialEmployeePolicy ? { initialEmployeePolicy } : {})}
                  onUpdated={(next) =>
                    setDetailState({ status: 'success', error: null, data: next })
                  }
                />
              </Stack>
            </ProfilePane>

            {tab === 'balance' ? (
              <ProfilePane value="balance" current={tab}>
                <Stack spacing={2.25}>
                  <Box>
                    <SectionLabel>Balances</SectionLabel>
                    <Box
                      sx={{
                        display: 'grid',
                        gap: 1.75,
                        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                      }}
                    >
                      {detail.balances.map((balance) => (
                        <Box key={balance.leaveType}>
                          <BalanceMeter balance={balance} variant="tile" />
                          {/* The pair an administrator reasons with: what has
                              accrued and is spendable today, and what the whole
                              year still holds (accrual through December plus
                              carryover, minus spent and every commitment). */}
                          <Typography
                            sx={{ mt: 0.75, fontSize: 12.5, color: 'text.secondary' }}
                          >
                            {formatDays(bookableDaysOf(balance))} available
                            now · {formatDays(remainingThisYear(balance))} left
                            this year
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </Box>

                  <VacationBalanceAdjustBlock
                    detail={detail}
                    api={api}
                    onUpdated={(next) =>
                      setDetailState({ status: 'success', error: null, data: next })
                    }
                  />

                  {/* The former Timeline tab, folded in below the meters. */}
                  <Box>
                    <SectionLabel>Balance movements</SectionLabel>
                    {ledgerMovements.length === 0 ? (
                      <Alert severity="info">
                        No balance movements have been recorded for this employee yet.
                      </Alert>
                    ) : (
                      <Stack>
                        {/* Month separators, same treatment as the employee's
                            own Balance timeline: a LedgerRow prints only day
                            and month, so without the year-bearing group label
                            a January carry-over row would be year-ambiguous. */}
                        {ledgerTypeSections(
                          ledgerMovements,
                          detail.generatedAt,
                        ).map((section, sectionIndex) => (
                          <Box key={section.leaveType}>
                            {/* One section per leave type. Each type's rows are
                                chronological, but an accrual pass writes every
                                vacation row before every sick one, so a single
                                month-separated list restarted at January
                                halfway down with nothing saying why. */}
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
                            {section.groups.map((group, groupIndex) => (
                              <Box key={`${group.label}-${groupIndex}`}>
                                <Typography
                                  sx={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    letterSpacing: '0.05em',
                                    textTransform: 'uppercase',
                                    color: '#98a2b3',
                                    pt: groupIndex === 0 ? 0.5 : 1.5,
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
                  </Box>
                </Stack>
              </ProfilePane>
            ) : null}

            {tab === 'requests' ? (
              <ProfilePane value="requests" current={tab}>
                <Stack spacing={1.5}>
                  {detail.requestHistory.length === 0 ? (
                    <Alert severity="info">
                      This employee has not submitted leave requests yet.
                    </Alert>
                  ) : (
                    <Stack spacing={1.25}>
                      {detail.requestHistory.map((request) => (
                        <Box
                          key={request.requestId}
                          sx={{
                            border: '1px solid',
                            borderColor: 'divider',
                            borderRadius: '12px',
                            p: '12px 14px',
                          }}
                        >
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            flexWrap="wrap"
                            useFlexGap
                          >
                            <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
                              {formatLeaveType(request.leaveType)}
                            </Typography>
                            <StatusPill status={request.status} />
                          </Stack>
                          <Typography
                            sx={{ fontSize: 12.5, color: 'text.secondary', fontWeight: 500, mt: '3px' }}
                          >
                            {formatRequestDateRange(request)} ·{' '}
                            {formatDaySplit(request.paidDays, request.unpaidDays)} ·
                            Submitted{' '}
                            {formatDateTime(request.submittedAt)}
                          </Typography>
                          {request.comment ? (
                            <Typography
                              sx={{
                                fontSize: 12.5,
                                color: 'text.secondary',
                                fontStyle: 'italic',
                                mt: '4px',
                              }}
                            >
                              &ldquo;{request.comment}&rdquo;
                            </Typography>
                          ) : null}
                        </Box>
                      ))}
                    </Stack>
                  )}
                  <PaneFoot>
                    <Button
                      component={RouterLink}
                      to="/admin/activity"
                      variant="text"
                      size="small"
                      color="secondary"
                      sx={paneFootLinkSx}
                    >
                      Decide pending requests in the Activity feed →
                    </Button>
                  </PaneFoot>
                </Stack>
              </ProfilePane>
            ) : null}

            {tab === 'audit' ? (
              <ProfilePane value="audit" current={tab}>
                <Stack spacing={1.5}>
                  <SectionLabel>Events affecting this employee</SectionLabel>

                  {auditState.status === 'loading' && !auditState.data ? (
                    <Stack spacing={1.25}>
                      {Array.from({ length: 3 }).map((_, index) => (
                        <Skeleton key={index} variant="rounded" height={96} />
                      ))}
                    </Stack>
                  ) : null}

                  {/* Non-blocking: a failed audit fetch must never hide the rest
                      of the profile, so it degrades to a small warning here. */}
                  {auditState.status === 'error' ? (
                    <Alert severity="warning">
                      This employee&apos;s audit events could not be loaded right now.
                    </Alert>
                  ) : null}

                  {auditState.data && auditState.data.items.length === 0 ? (
                    <Alert severity="info">
                      No audit events recorded for this employee yet.
                    </Alert>
                  ) : null}

                  {auditState.data && auditState.data.items.length > 0 ? (
                    <Stack spacing={1.25}>
                      {auditState.data.items.map((item) => (
                        <AuditLogEntry key={item.auditId} item={item} />
                      ))}
                    </Stack>
                  ) : null}

                  <Button
                    component={RouterLink}
                    to={`/admin/activity/audit?userId=${detail.employeeId}`}
                    size="small"
                    variant="outlined"
                    color="secondary"
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Open this employee&apos;s audit trail
                  </Button>
                  <PaneFoot>
                    <Button
                      component={RouterLink}
                      to="/admin/activity/audit"
                      variant="text"
                      size="small"
                      color="secondary"
                      sx={paneFootLinkSx}
                    >
                      Open the full audit log →
                    </Button>
                  </PaneFoot>
                </Stack>
              </ProfilePane>
            ) : null}
          </Card>
        </Stack>
      ) : null}
    </AdminLayout>
  )
}

/**
 * What the vacation correction form MINTS from what the admin typed: the signed
 * amount, snapped onto this employee's org hour grid, and how far one press of
 * the stepper moves.
 *
 * Pure and exported so the grid it mints on is pinned by a spec. The divisor
 * comes off the employee payload, never off the shared display fallback: the
 * server refuses a correction that is not a whole number of hours at the org's
 * workday, so at a seven-hour day every fractional amount an eight-hour grid
 * can produce is rejected outright. Nothing about a page's display state may
 * decide what a form is allowed to submit.
 */
export function vacationCorrectionGrid(
  detail: Pick<AdminEmployeeDetailDto, 'hoursPerDay'>,
  typed: string,
  direction: 'add' | 'remove',
): { hoursPerDay: number; days: number; signedDelta: number; step: number } {
  const hoursPerDay = detail.hoursPerDay
  const days = snapDaysToHourGrid(Number(typed) || 0, hoursPerDay)
  return {
    hoursPerDay,
    days,
    signedDelta: direction === 'add' ? days : -days,
    // An EXACT fraction, not the three-decimal figure an hour is stored as:
    // one press is one hour (see DaysStepper's step).
    step: 1 / hoursPerDay,
  }
}

// One block on the Balance tab: a sticky add/remove for vacation only, with a
// mandatory note and a confirm dialog before the POST. Amounts sit on the same
// hour grid a booking does, so a correction can match a part day an employee
// actually took; the server refuses anything off it outright.
function VacationBalanceAdjustBlock({
  detail,
  api,
  onUpdated,
}: {
  detail: AdminEmployeeDetailDto
  api: AdminApiClient
  onUpdated: (next: AdminEmployeeDetailDto) => void
}) {
  const vacation = detail.balances.find((b) => b.leaveType === LeaveType.Vacation)
  const bookable = vacation
    ? bookableDaysOf(vacation)
    : 0
  // "accrued" on screen means earned from the annual entitlement; the DTO's
  // accruedDays counts the carryover too, so the caption splits it back into
  // its two named parts (the carried part capped by what the balance holds).
  const accruedSplit = vacation
    ? accruedSplitOf(vacation)
    : { earnedDays: 0, carriedDays: 0 }
  const [direction, setDirection] = useState<'add' | 'remove'>('add')
  const [days, setDays] = useState('1')
  const [note, setNote] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  // The grid this correction mints on, taken from the employee payload. A typed
  // figure is snapped onto it rather than truncated: an admin correcting a
  // four-hour absence types 0.5, and the old whole-day truncation turned that
  // into nothing at all.
  const {
    hoursPerDay,
    days: daysCount,
    signedDelta,
    step: hourStep,
  } = vacationCorrectionGrid(detail, days, direction)
  const noteTrimmed = note.trim()
  const previewBookable = roundDays(bookable + signedDelta)
  const canReview =
    daysCount > 0 &&
    noteTrimmed.length > 0 &&
    !(direction === 'remove' && daysCount > bookable)

  const apply = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.adjustEmployeeVacationBalance(detail.employeeId, {
        deltaDays: signedDelta,
        note: noteTrimmed,
      })
      onUpdated(next)
      setConfirmOpen(false)
      setNote('')
      setDays('1')
      setDirection('add')
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 2500)
    } catch (caught) {
      setError(apiErrorDetails(caught).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box>
      <SectionLabel
        action={savedFlash ? <SavedFlag /> : undefined}
      >
        Adjust vacation
      </SectionLabel>
      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '12px',
          p: { xs: 1.5, sm: 1.75 },
        }}
      >
        <Stack spacing={1.5}>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.45 }}>
            Add or remove vacation for the current leave year, by the day or by
            the hour. The change is sticky until year end and feeds carryover
            like ordinary leave. Sick leave is not adjusted here.
          </Typography>

          {vacation ? (
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              Available now: {formatDays(bookable)}
              {vacation.accruedDays !== bookable
                ? ` · accrued ${formatDays(accruedSplit.earnedDays)}${
                    accruedSplit.carriedDays > 0
                      ? ` + ${formatDays(accruedSplit.carriedDays)} carried over`
                      : ''
                  }`
                : null}
              {` · ${formatDays(remainingThisYear(vacation))} left this year`}
            </Typography>
          ) : (
            <Alert severity="info">No vacation balance has been materialised yet.</Alert>
          )}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ sm: 'flex-end' }}
            useFlexGap
            flexWrap="wrap"
          >
            <Stack spacing={0.75}>
              <Typography
                sx={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  color: 'text.secondary',
                }}
              >
                Direction
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={direction}
                onChange={(_event, next: 'add' | 'remove' | null) => {
                  if (next) setDirection(next)
                }}
                aria-label="Add or remove vacation days"
                sx={{
                  ...segmentedControlSx,
                  alignSelf: 'flex-start',
                  '& .MuiToggleButton-root': { px: 2, py: 0.75, fontSize: 13 },
                }}
              >
                <ToggleButton value="add">Add</ToggleButton>
                <ToggleButton value="remove">Remove</ToggleButton>
              </ToggleButtonGroup>
            </Stack>

            <DaysStepper
              label="Days"
              value={days}
              onChange={setDays}
              // One press is one hour. The removal ceiling is the hour-grid
              // floor of what is there: a balance of 3d 4h can be taken down
              // by 3d 4h, and a whole-day ceiling would strand the hours.
              step={hourStep}
              max={
                direction === 'remove'
                  ? Math.max(0, floorDays(bookable, hoursPerDay))
                  : undefined
              }
              dense
            />
          </Stack>

          <TextField
            label="Comment"
            required
            multiline
            minRows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this balance changing?"
            fullWidth
            inputProps={{ 'aria-label': 'Adjustment comment' }}
            sx={{ '& .MuiOutlinedInput-root': { fontSize: 13.5 } }}
          />

          {direction === 'remove' && daysCount > bookable ? (
            <Alert severity="warning">
              Cannot remove more than {formatDays(bookable)} available.
            </Alert>
          ) : null}

          {error ? (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="contained"
              color="secondary"
              size="small"
              disabled={!canReview || saving}
              onClick={() => {
                setError(null)
                setConfirmOpen(true)
              }}
              sx={{ minHeight: 36, fontSize: 13 }}
            >
              Review &amp; apply
            </Button>
            {canReview ? (
              <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                After: {formatDays(previewBookable)} available
              </Typography>
            ) : null}
          </Stack>
        </Stack>
      </Box>

      <Dialog
        open={confirmOpen}
        onClose={saving ? undefined : () => setConfirmOpen(false)}
        aria-labelledby="vacation-balance-adjust-title"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="vacation-balance-adjust-title" sx={{ pb: 1 }}>
          Confirm vacation adjustment
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography sx={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {direction === 'add' ? 'Add' : 'Remove'}{' '}
              <strong>{formatDays(daysCount)}</strong> of vacation for{' '}
              <strong>{detail.displayName}</strong>?
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              Available will change from {formatDays(bookable)} to{' '}
              {formatDays(previewBookable)}. The employee will be emailed, and
              the change is recorded in the balance ledger and audit log.
            </Typography>
            <Box
              sx={{
                p: 1.5,
                borderRadius: '10px',
                bgcolor: 'action.hover',
              }}
            >
              <Typography
                sx={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                  mb: 0.5,
                }}
              >
                Comment
              </Typography>
              <Typography sx={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
                {noteTrimmed}
              </Typography>
            </Box>
            {error ? <Alert severity="error">{error}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            variant="outlined"
            color="inherit"
            size="small"
            onClick={() => setConfirmOpen(false)}
            disabled={saving}
            sx={{ minHeight: 36, fontSize: 13 }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="secondary"
            size="small"
            onClick={() => void apply()}
            disabled={saving}
            startIcon={
              saving ? <CircularProgress size={16} color="inherit" /> : undefined
            }
            sx={{ minHeight: 36, fontSize: 13 }}
          >
            {saving ? 'Applying…' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

// ————— Tabs —————

// Admin accent (prototype --secondary): the active tab's label and underline.
const PROFILE_TAB_ACCENT = '#0f766e'

const PROFILE_TABS: { value: ProfileTab; label: string }[] = [
  { value: 'profile', label: 'Profile' },
  { value: 'balance', label: 'Balance' },
  { value: 'requests', label: 'Requests' },
  { value: 'audit', label: 'Audit' },
]

// Prototype .tabs: an underline tab bar with count badges.
function ProfileTabBar({
  current,
  onChange,
  counts,
}: {
  current: ProfileTab
  onChange: (tab: ProfileTab) => void
  // audit is null until the events have loaded, so the badge appears only once
  // there is a real count to show (requests is known synchronously).
  counts: { requests: number; audit: number | null }
}) {
  return (
    <Box
      role="tablist"
      aria-label="Employee sections"
      sx={{
        display: 'flex',
        gap: '4px',
        borderBottom: '1px solid',
        borderColor: 'divider',
        overflowX: 'auto',
      }}
    >
      {PROFILE_TABS.map((tab) => {
        const active = tab.value === current
        const count =
          tab.value === 'requests'
            ? counts.requests
            : tab.value === 'audit'
              ? counts.audit
              : null
        return (
          <ButtonBase
            key={tab.value}
            id={`employee-tab-${tab.value}`}
            role="tab"
            aria-selected={active}
            aria-controls={`employee-tabpanel-${tab.value}`}
            onClick={() => onChange(tab.value)}
            sx={{
              flexShrink: 0,
              gap: '5px',
              px: 2,
              py: 1.25,
              mb: '-1px',
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              borderRadius: '10px 10px 0 0',
              borderBottom: '2px solid',
              borderBottomColor: active ? PROFILE_TAB_ACCENT : 'transparent',
              color: active ? PROFILE_TAB_ACCENT : 'text.secondary',
              transition: 'color 0.15s ease, background 0.15s ease, border-color 0.15s ease',
              '&:hover': {
                color: active ? PROFILE_TAB_ACCENT : 'text.primary',
                bgcolor: 'rgba(16, 24, 40, 0.035)',
              },
            }}
          >
            {tab.label}
            {count !== null ? (
              <Box
                component="span"
                sx={{
                  fontSize: 11,
                  fontWeight: 800,
                  borderRadius: '999px',
                  px: '7px',
                  py: '1px',
                  fontVariantNumeric: 'tabular-nums',
                  bgcolor: active ? 'rgba(15, 118, 110, 0.1)' : 'rgba(16, 24, 40, 0.07)',
                  color: active ? PROFILE_TAB_ACCENT : 'text.secondary',
                }}
              >
                {count}
              </Box>
            ) : null}
          </ButtonBase>
        )
      })}
    </Box>
  )
}

// One tab pane. The Profile pane stays rendered but hidden across tab switches
// (display:none also takes its controls out of the tab order and the a11y
// tree); whether a pane is rendered at all is the caller's decision.
function ProfilePane({
  value,
  current,
  children,
}: {
  value: ProfileTab
  current: ProfileTab
  children: ReactNode
}) {
  const active = value === current
  return (
    <Box
      role="tabpanel"
      id={`employee-tabpanel-${value}`}
      aria-labelledby={`employee-tab-${value}`}
      hidden={!active}
      aria-hidden={!active || undefined}
      sx={{ display: active ? 'block' : 'none' }}
    >
      {children}
    </Box>
  )
}

// Right-aligned foot link row (prototype .pane-foot).
function PaneFoot({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'flex-end',
        borderTop: '1px solid',
        borderColor: 'divider',
        pt: 1.5,
        mt: 0.5,
      }}
    >
      {children}
    </Box>
  )
}

const paneFootLinkSx = {
  fontSize: 12.5,
  fontWeight: 700,
  color: 'secondary.main',
  px: 1.25,
  py: '5px',
  borderRadius: '8px',
} as const

// ————— Profile pane facts —————

// What the rest of the year still holds: accrual through December plus the
// carryover, minus spent and every committed day. The server computes exactly
// that as projectedRemainingDays (holds against future accrual included);
// the arithmetic fallback covers a server that has not sent the projection.
function remainingThisYear(balance: {
  totalDays: number
  carriedOverDays?: number
  spentDays: number
  onHoldDays: number
  projectedRemainingDays?: number
}): number {
  return Math.max(
    0,
    balance.projectedRemainingDays ??
      balance.totalDays +
        (balance.carriedOverDays ?? 0) -
        balance.spentDays -
        balance.onHoldDays,
  )
}

// The header stat value "16/24d" (available over total, both floored). Small
// suffix matches the prototype .p-stat .v small (12/600, muted). The
// denominator is the YEAR POOL — annual allowance plus carried-over days:
// the numerator already funds itself from the carryover (it sits inside
// accruedDays), so a carry-less total would read "9 of 15" for someone
// whose year really holds 20.
function AvailableOfTotal({
  balance,
}: {
  balance:
    | {
        availableDays: number
        onHoldDays: number
        totalDays: number
        carriedOverDays?: number
      }
    | undefined
}) {
  const available = balance ? formatDays(bookableDaysOf(balance)) : formatDays(0)
  const carried = balance?.carriedOverDays ?? 0
  const total = balance
    ? formatDays(balance.totalDays + carried)
    : formatDays(0)
  return (
    <Box
      title={
        carried > 0 && balance
          ? `${formatDays(balance.totalDays)} annual${carriedOverFromLastYearSuffix(carried)}`
          : undefined
      }
    >
      {available}
      <Box
        component="small"
        sx={{ ml: '2px', fontSize: 12, fontWeight: 600, color: 'text.secondary' }}
      >
        /{total}
      </Box>
      {carried > 0 ? (
        <Box
          sx={{
            mt: '2px',
            fontSize: 10,
            fontWeight: 600,
            color: 'text.secondary',
            lineHeight: 1.3,
          }}
        >
          incl. {formatDays(carried)} carried over from last year
        </Box>
      ) : null}
    </Box>
  )
}

// Prototype .p-stat: a compact header stat tile - a tiny uppercase muted label
// over a 17px/800 tabular-nums value, in a light bordered paper tile. These sit
// in the hero's right-hand actions slot (prototype .p-side).
function ProfileStatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        borderRadius: '12px',
        p: '10px 14px',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
        minWidth: 0,
      }}
    >
      <Typography
        sx={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#98a2b3',
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          fontSize: 17,
          fontWeight: 800,
          mt: '2px',
          lineHeight: 1.15,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </Box>
    </Box>
  )
}

// Prototype .fact: label over value; `wide` spans the grid, `mono` renders an
// id in a monospace face.
export function Fact({
  label,
  value,
  wide = false,
  mono = false,
  sx,
}: {
  label: string
  value: ReactNode
  wide?: boolean
  mono?: boolean
  sx?: object
}) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '11px',
        p: '10px 12px',
        minWidth: 0,
        ...(wide ? { gridColumn: '1 / -1' } : {}),
        ...sx,
      }}
    >
      <Typography
        sx={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: '#98a2b3',
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          fontSize: mono ? 12 : 14,
          fontWeight: 700,
          color: 'text.primary',
          mt: '2px',
          ...(mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : {}),
        }}
      >
        {value}
      </Box>
    </Box>
  )
}

// Employee IDs are long opaque UUIDs; show a short head and let admins copy the
// full value with one click. The copy button confirms with a transient check.
export function EmployeeIdValue({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const shortId = id.length > 12 ? `${id.slice(0, 8)}…` : id
  const copy = () => {
    void navigator.clipboard?.writeText(id)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
      <Box
        component="span"
        title={id}
        sx={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          color: 'text.primary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {shortId}
      </Box>
      <Tooltip title={copied ? 'Copied' : 'Copy employee ID'}>
        <IconButton
          size="small"
          onClick={copy}
          aria-label="Copy employee ID"
          sx={{
            p: '3px',
            color: copied ? '#0f766e' : '#98a2b3',
            '&:hover': { color: '#0f766e', bgcolor: 'rgba(15, 118, 110, 0.08)' },
          }}
        >
          {copied ? (
            <CheckRoundedIcon sx={{ fontSize: 15 }} />
          ) : (
            <ContentCopyRoundedIcon sx={{ fontSize: 14 }} />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  )
}

// Read-only employment fields in edit mode — same outlined TextField shell as Country.
const employmentEditFieldSx = {
  '& .MuiInputBase-root': {
    minHeight: 54,
  },
  '& .MuiInputBase-input': {
    py: 1.75,
    boxSizing: 'border-box',
  },
} as const

const employmentEditRow1Sx = {
  mb: '50px',
} as const

const employmentReadOnlyInputSx = {
  cursor: 'default',
  color: 'text.primary',
  userSelect: 'none',
  caretColor: 'transparent',
} as const

const employmentReadOnlyInputSlotProps = {
  readOnly: true,
  tabIndex: -1,
  onFocus: (event: FocusEvent<HTMLInputElement>) => {
    event.target.blur()
  },
  onMouseDown: (event: MouseEvent<HTMLInputElement>) => {
    event.preventDefault()
  },
} as const

function EmploymentLockedField({
  label,
  value,
  helperText,
  monospace = false,
  sx,
}: {
  label: string
  value: string
  helperText?: string
  monospace?: boolean
  sx?: object
}) {
  return (
    <TextField
      label={label}
      value={value}
      fullWidth
      helperText={helperText}
      sx={{ ...employmentEditFieldSx, ...sx }}
      slotProps={{
        input: {
          ...employmentReadOnlyInputSlotProps,
          sx: {
            ...employmentReadOnlyInputSx,
            ...(monospace ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : {}),
          },
        },
      }}
    />
  )
}

function EmployeeIdLockedField({ id, sx }: { id: string; sx?: object }) {
  const [copied, setCopied] = useState(false)
  const shortId = id.length > 12 ? `${id.slice(0, 8)}…` : id
  const copy = () => {
    void navigator.clipboard?.writeText(id)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <TextField
      label="Employee ID"
      value={shortId}
      fullWidth
      sx={{ ...employmentEditFieldSx, ...sx }}
      slotProps={{
        input: {
          ...employmentReadOnlyInputSlotProps,
          title: id,
          sx: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            ...employmentReadOnlyInputSx,
          },
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={copied ? 'Copied' : 'Copy employee ID'}>
                <IconButton
                  size="small"
                  onClick={copy}
                  aria-label="Copy employee ID"
                  edge="end"
                  sx={{
                    color: copied ? '#0f766e' : '#98a2b3',
                    '&:hover': { color: '#0f766e', bgcolor: 'rgba(15, 118, 110, 0.08)' },
                  }}
                >
                  {copied ? (
                    <CheckRoundedIcon sx={{ fontSize: 15 }} />
                  ) : (
                    <ContentCopyRoundedIcon sx={{ fontSize: 14 }} />
                  )}
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        },
      }}
    />
  )
}

// Prototype .sec-t: an uppercase section label. With `action`, it becomes the
// prototype .sec-row: the label on the left and a control (e.g. the Employment
// Edit toggle) on the right.
function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const labelSx = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: '#98a2b3',
  } as const
  if (action) {
    return (
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ gap: 1, mb: 1.25 }}
      >
        <Typography sx={labelSx}>{children}</Typography>
        {action}
      </Stack>
    )
  }
  return <Typography sx={{ ...labelSx, mb: 1.25 }}>{children}</Typography>
}

// ————— Shared presentational bits (imported by the directory page too) —————

// Prototype .role-chip: the compact pill the role chip and the account flags
// below are built from. `tone` carries the palette; the metrics live here once,
// so pills sharing a row line up whatever they say.
function AccountFlag({ tone, children }: { tone: object; children: ReactNode }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 10.5,
        fontWeight: 700,
        px: '8px',
        py: '2px',
        borderRadius: '999px',
        border: '1px solid',
        ...tone,
      }}
    >
      {children}
    </Typography>
  )
}

// A role worth naming beside an account. Only Administrator reaches this, since
// every caller filters through distinguishingRoles, so the pill wears the admin
// accent outright instead of guessing a tone from the label it is handed.
export function RoleChip({ role }: { role: string }) {
  return (
    <AccountFlag
      tone={{
        color: 'secondary.main',
        borderColor: 'rgba(15, 118, 110, 0.35)',
        bgcolor: 'rgba(15, 118, 110, 0.1)',
      }}
    >
      {role}
    </AccountFlag>
  )
}

// The roles worth a chip. Employee is the directory-wide norm, so chipping it
// would decorate nearly every row and tell the admin nothing; only
// Administrator sets an account apart. The full role set — including a
// missing employee role — stays visible in the profile facts and the CSV
// export.
export function distinguishingRoles(roleNames: AppRoleName[]): AppRoleName[] {
  return roleNames.filter((roleName) => roleName === AppRoleName.Administrator)
}

// A deactivated account: still listed (the sync never deletes anyone) but no
// longer able to sign in. Muted, because it marks an account that is out of
// play rather than one that needs work.
export function InactiveFlag() {
  return (
    <AccountFlag
      tone={{
        color: 'text.secondary',
        borderColor: 'rgba(16, 24, 40, 0.16)',
        bgcolor: 'rgba(16, 24, 40, 0.06)',
      }}
    >
      Inactive
    </AccountFlag>
  )
}

// An account whose profile card an admin still has to finish (country or
// employment start date missing). Amber: this one IS a to-do. The label comes
// from profileStatusLabel so the flag and the status chip cannot drift apart —
// they name the same state.
export function NeedsSetupFlag() {
  return (
    <AccountFlag
      tone={{
        color: 'warning.dark',
        borderColor: 'rgba(180, 83, 9, 0.35)',
        bgcolor: 'rgba(180, 83, 9, 0.1)',
      }}
    >
      {profileStatusLabel(EmployeeProfileStatus.PendingSetup)}
    </AccountFlag>
  )
}

// Prototype .chip-status, one tone per readiness state: Ready is green, "Needs
// setup" amber (an admin has to finish the card), "Not started yet" neutral
// (nothing to do but wait for the start date).
function ProfileStatusChip({ status }: { status: EmployeeProfileStatus }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 10.5,
        fontWeight: 700,
        px: '9px',
        py: '2.5px',
        borderRadius: '999px',
        ...profileStatusTone(status),
      }}
    >
      {profileStatusLabel(status)}
    </Typography>
  )
}

function profileStatusTone(status: EmployeeProfileStatus): object {
  switch (status) {
    case EmployeeProfileStatus.Ready:
      return { color: 'success.main', bgcolor: 'rgba(21, 128, 61, 0.1)' }
    case EmployeeProfileStatus.PendingSetup:
      return { color: 'warning.dark', bgcolor: 'rgba(180, 83, 9, 0.1)' }
    case EmployeeProfileStatus.NotStartedYet:
    default:
      return { color: 'text.secondary', bgcolor: 'rgba(16, 24, 40, 0.06)' }
  }
}

// Human-readable label for the readiness status (display only — the decision
// itself comes from the server's profileStatus). A status this build does not
// know falls back to neutral wording rather than claiming a specific reason.
export function profileStatusLabel(status: EmployeeProfileStatus): string {
  switch (status) {
    case EmployeeProfileStatus.Ready:
      return 'Ready'
    case EmployeeProfileStatus.NotStartedYet:
      return 'Not started yet'
    case EmployeeProfileStatus.PendingSetup:
      return 'Needs setup'
    default:
      return 'Not ready'
  }
}

// Highlighted placeholder for a required profile field that has no stored value.
export function NotSet() {
  return (
    <Typography component="span" variant="body2" color="error" sx={{ fontWeight: 600 }}>
      Not set
    </Typography>
  )
}

// ————— Employment / schedule / allocation editor —————

// Shown under a required editor field while its input is empty.
const REQUIRED_FIELD_HELPER =
  'Required — not set. The employee cannot submit leave requests without it.'

// Names the empty fields behind a PendingSetup profile (display only — the
// PendingSetup decision itself comes from the server's profileStatus).
function missingProfileFieldsMessage(detail: AdminEmployeeDetailDto): string {
  const missing = [
    !detail.employmentStartDate ? 'employment start date' : null,
    !detail.countryCode ? 'location' : null,
  ].filter(Boolean)
  const subject = missing.length > 1 ? 'these fields are' : 'it is'
  const accrualNote = detail.employmentStartDate
    ? ''
    : ' (and leave does not accrue without a start date)'
  return `Required: ${missing.join(' and ')} not set. This employee cannot submit leave requests${accrualNote} until ${subject} filled in below.`
}

// Country options for the location picker, guaranteeing the employee's current
// country is present even before the shared list loads (or if it was removed
// from settings), so MUI never warns about an out-of-range Select value.
function mergeCurrentCountry(
  countries: CountryDto[],
  currentCode: string | undefined,
): CountryDto[] {
  if (!currentCode || countries.some((country) => country.code === currentCode)) {
    return countries
  }
  return [...countries, { code: currentCode, name: currentCode }]
}

// The editor's form values as derived from a loaded detail. Single source for
// the state initializers and the reset effect.
function employeeFormFromDetail(detail: AdminEmployeeDetailDto): {
  startDate: string
  calendarCountryCode: string
} {
  return {
    startDate: detail.employmentStartDate ?? '',
    calendarCountryCode: detail.holidayCalendarCountryCode ?? detail.countryCode ?? '',
  }
}

function calendarCountryOptionsFromHolidays(
  calendars: HolidayCalendarDto[],
  effectiveCode: string | undefined,
  countries: CountryDto[],
): CountryDto[] {
  const byCode = new Map<string, CountryDto>()
  for (const calendar of calendars) {
    byCode.set(calendar.country.code, calendar.country)
  }
  if (effectiveCode && !byCode.has(effectiveCode)) {
    byCode.set(effectiveCode, {
      code: effectiveCode,
      name: countryLabel(effectiveCode, countries),
    })
  }
  return [...byCode.values()].sort((left, right) => left.name.localeCompare(right.name))
}

// Briefcase icon for a project card (prototype .proj-ic).
function BriefcaseGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block' }}>
      <path
        d="M3 8h18M5 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2m-14 0v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Transient "Saved" confirmation (prototype .saved): a green check + label
// that flashes after a successful save.
function SavedFlag() {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}>
      <CheckRoundedIcon sx={{ fontSize: 15 }} />
      <Typography component="span" sx={{ fontSize: 12.5, fontWeight: 700 }}>
        Saved
      </Typography>
    </Stack>
  )
}

// The clean sectioned Profile pane (prototype renderProfile): Employment (with
// an inline Edit toggle), the read-only LDAP projects, the work schedule, and
// the yearly allocation steppers. Each save posts to its own endpoint and
// pushes the refreshed detail back up via onUpdated.
// Employment grid: default grid stretch would inflate read-only facts (Role)
// to match tall TextFields with helper text in the same row — pin items to start.
const employmentGridSx = {
  display: 'grid',
  gap: 1.25,
  gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, minmax(0, 1fr))' },
  alignItems: 'start',
} as const

function EmployeeProfilePanel({
  detail,
  api,
  countries,
  initialEmployeePolicy,
  onUpdated,
}: {
  detail: AdminEmployeeDetailDto
  api: AdminApiClient
  countries: CountryDto[]
  initialEmployeePolicy?: EmployeePolicyDto
  onUpdated: (next: AdminEmployeeDetailDto) => void
}) {
  const baseline = employeeFormFromDetail(detail)
  // Employment (country + start date + assigned calendar) edits toggle between
  // a read-only facts grid and inline controls.
  const [editing, setEditing] = useState(false)
  const [startDate, setStartDate] = useState(baseline.startDate)
  const [calendarCountryCode, setCalendarCountryCode] = useState(baseline.calendarCountryCode)
  const [holidayCalendars, setHolidayCalendars] = useState<HolidayCalendarDto[]>([])
  const [savingEmployment, setSavingEmployment] = useState(false)
  const [employmentError, setEmploymentError] = useState<string | null>(null)
  const [employmentSaved, setEmploymentSaved] = useState(false)
  const [employeePolicy, setEmployeePolicy] =
    useState<EmployeePolicyDto | null>(initialEmployeePolicy ?? null)
  const [policies, setPolicies] = useState<LeavePolicyDto[]>([])
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [cancellingScheduled, setCancellingScheduled] = useState(false)
  const [policyReload, setPolicyReload] = useState(0)

  const latest = detail.requestHistory[0]

  // Options for the location picker. Always include the employee's current
  // country even if the fetched list has not arrived (or dropped it), so the
  // select never renders a value it has no matching option for.
  const countryOptions = mergeCurrentCountry(countries, detail.countryCode)
  const calendarOptions = calendarCountryOptionsFromHolidays(
    holidayCalendars,
    detail.holidayCalendarCountryCode ?? detail.countryCode,
    countries,
  )
  const assignedCalendarLabel = calendarCountryCode
    ? countryLabel(calendarCountryCode, countries)
    : null

  useEffect(() => {
    let active = true
    void api
      .listHolidays()
      .then((items) => {
        if (active) {
          setHolidayCalendars(items)
        }
      })
      .catch(() => {
        // Non-fatal: the picker falls back to the effective country only.
      })
    return () => {
      active = false
    }
  }, [api])

  // Reset the form only when a different employee is loaded (not on our own
  // save, which keeps the same employeeId).
  useEffect(() => {
    const next = employeeFormFromDetail(detail)
    setStartDate(next.startDate)
    setCalendarCountryCode(next.calendarCountryCode)
    setEditing(false)
    setEmploymentError(null)
    setEmploymentSaved(false)
    setPolicyError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.employeeId])

  const startEditing = () => {
    // Seed the inputs from the current detail so the edit begins from the
    // stored values regardless of any earlier abandoned edit.
    setStartDate(baseline.startDate)
    setCalendarCountryCode(baseline.calendarCountryCode)
    setEmploymentError(null)
    setEmploymentSaved(false)
    setEditing(true)
  }

  const cancelEditing = () => {
    setStartDate(baseline.startDate)
    setCalendarCountryCode(baseline.calendarCountryCode)
    setEmploymentError(null)
    setEditing(false)
  }

  // ONE call carries the accrual anchor and the assigned holiday calendar; on
  // success we leave edit mode and flash a transient "Saved" check.
  const saveEmployment = async () => {
    setSavingEmployment(true)
    setEmploymentError(null)
    try {
      const residenceCountry = detail.countryCode ?? ''
      const holidayCalendarCountryCode =
        calendarCountryCode && calendarCountryCode !== residenceCountry
          ? calendarCountryCode
          : null
      const next = await api.updateEmployee(detail.employeeId, {
        employmentStartDate: startDate.trim() ? startDate : null,
        holidayCalendarCountryCode,
      })
      onUpdated(next)
      setEditing(false)
      setEmploymentSaved(true)
      window.setTimeout(() => setEmploymentSaved(false), 2000)
    } catch (caught) {
      setEmploymentError((caught as Error).message)
    } finally {
      setSavingEmployment(false)
    }
  }


  // The employee's policy membership, refetched whenever a transfer or a
  // cancellation lands (policyReload), plus the catalog the transfer dialog
  // picks from. A 404 means "not enrolled yet" (pre-cutover), not a failure.
  useEffect(() => {
    if (initialEmployeePolicy && policyReload === 0) {
      return
    }
    let active = true
    void Promise.all([
      api.getEmployeePolicy(detail.employeeId).catch(() => null),
      api.getPolicies().catch(() => [] as LeavePolicyDto[]),
    ]).then(([policy, catalog]) => {
      if (active) {
        setEmployeePolicy(policy)
        setPolicies(catalog)
      }
    })
    return () => {
      active = false
    }
  }, [api, detail.employeeId, initialEmployeePolicy, policyReload])

  const cancelScheduledTransfer = async () => {
    setCancellingScheduled(true)
    setPolicyError(null)
    try {
      const next = await api.cancelScheduledPolicyTransfer(detail.employeeId)
      onUpdated(next)
      setPolicyReload((count) => count + 1)
    } catch (caught) {
      setPolicyError(apiErrorDetails(caught).message)
    } finally {
      setCancellingScheduled(false)
    }
  }

  return (
    <Stack spacing={2.75}>
      {/* Employment: read-only facts with an inline Edit toggle. */}
      <Box>
        <SectionLabel
          action={
            editing ? undefined : (
              <Stack direction="row" spacing={1} alignItems="center">
                {employmentSaved ? <SavedFlag /> : null}
                <Button
                  variant="text"
                  size="small"
                  color="secondary"
                  startIcon={<EditOutlinedIcon sx={{ fontSize: 16 }} />}
                  onClick={startEditing}
                  sx={{ fontSize: 12, fontWeight: 700, borderRadius: '8px' }}
                >
                  Edit
                </Button>
              </Stack>
            )
          }
        >
          Employment
        </SectionLabel>

        {employmentError ? (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {employmentError}
          </Alert>
        ) : null}

        <Box sx={employmentGridSx}>
          {editing ? (
            <EmploymentLockedField
              label={detail.roleNames.length > 1 ? 'Roles' : 'Role'}
              value={detail.roleNames.map((role) => formatRoleName(role)).join(' · ')}
              sx={employmentEditRow1Sx}
            />
          ) : (
            <Fact
              label={detail.roleNames.length > 1 ? 'Roles' : 'Role'}
              value={detail.roleNames.map((role) => formatRoleName(role)).join(' · ')}
            />
          )}
          {editing ? (
            <DateField
              label="Employment start"
              value={startDate}
              onChange={setStartDate}
              error={!startDate}
              helperText={startDate ? undefined : REQUIRED_FIELD_HELPER}
              fullWidth
              sx={{ ...employmentEditFieldSx, ...employmentEditRow1Sx }}
            />
          ) : (
            <Fact
              label="Employment start"
              value={
                detail.employmentStartDate ? formatDate(detail.employmentStartDate) : <NotSet />
              }
            />
          )}
          {editing ? (
            <EmployeeIdLockedField id={detail.employeeId} sx={employmentEditRow1Sx} />
          ) : (
            <Fact label="Employee ID" value={<EmployeeIdValue id={detail.employeeId} />} mono />
          )}
          {editing ? (
            <EmploymentLockedField
              label="Country"
              value={detail.countryCode ? countryLabel(detail.countryCode, countries) : 'Not set'}
              helperText="Location is synced from LDAP. To change it, update the LDAP directory or contact an administrator."
            />
          ) : (
            <Fact
              label="Country"
              value={detail.countryCode ? countryLabel(detail.countryCode, countries) : <NotSet />}
            />
          )}
          {editing ? (
            <TextField
              select
              label="Assigned calendar"
              value={calendarCountryCode}
              onChange={(event) => setCalendarCountryCode(event.target.value)}
              fullWidth
              sx={employmentEditFieldSx}
              helperText={
                calendarOptions.length === 0
                  ? 'No holiday calendars configured yet. Create one in Settings first.'
                  : 'Defaults to the employee country. Choose another calendar when they work under a different holiday schedule.'
              }
            >
              {calendarOptions.map((country) => (
                <MenuItem key={country.code} value={country.code}>
                  {country.name}
                  {country.code === detail.countryCode ? ' (country default)' : ''}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <Fact
              label="Assigned calendar"
              value={assignedCalendarLabel ?? <NotSet />}
            />
          )}
          {editing ? (
            <EmploymentLockedField
              label="Profile status"
              value={profileStatusLabel(detail.profileStatus)}
            />
          ) : (
            <Fact label="Profile status" value={profileStatusLabel(detail.profileStatus)} />
          )}
          {editing ? (
            <EmploymentLockedField
              label="Latest request"
              value={latest ? formatStatus(latest.status) : 'No requests yet'}
            />
          ) : (
            <Fact
              label="Latest request"
              value={latest ? formatStatus(latest.status) : 'No requests yet'}
            />
          )}
        </Box>

        {editing ? (
          <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center" sx={{ mt: 1.5 }}>
            <Button variant="outlined" color="secondary" onClick={cancelEditing} disabled={savingEmployment}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="secondary"
              onClick={() => void saveEmployment()}
              disabled={savingEmployment}
            >
              {savingEmployment ? 'Saving…' : 'Save changes'}
            </Button>
          </Stack>
        ) : null}
      </Box>

      {/* Projects and positions: read-only, sourced from LDAP. */}
      <Box>
        <SectionLabel>Projects and positions</SectionLabel>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1.25 }}>
          Projects, project members, and positions are managed in LDAP. They are read-only here and
          refresh on sync.
        </Typography>
        {detail.projects.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            No project memberships.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {detail.projects.map((project) => (
              <Stack
                key={project.projectId}
                direction="row"
                spacing={1.5}
                alignItems="flex-start"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '12px',
                  p: '12px 14px',
                }}
              >
                <Box
                  sx={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: '10px',
                    bgcolor: 'rgba(21, 94, 239, 0.08)',
                    color: 'primary.main',
                  }}
                  aria-hidden
                >
                  <BriefcaseGlyph />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 800 }}>{project.name}</Typography>
                  {project.position ? (
                    <Box sx={{ mt: 0.75 }}>
                      <Typography
                        component="span"
                        sx={{
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: 'text.secondary',
                          border: '1px solid',
                          borderColor: 'rgba(16, 24, 40, 0.14)',
                          borderRadius: '999px',
                          px: '10px',
                          py: '3px',
                        }}
                      >
                        {project.position}
                      </Typography>
                    </Box>
                  ) : null}
                </Box>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>

      {/* Leave policy: the group whose terms decide this employee's
          allowances. Every per-person exception is a policy of its own, so
          there is no per-user allocation editor any more. */}
      <Box>
        <SectionLabel>Leave policy</SectionLabel>
        {policyError ? (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {policyError}
          </Alert>
        ) : null}
        <Box
          sx={{
            border: '1px dashed rgba(15, 118, 110, 0.4)',
            bgcolor: 'rgba(15, 118, 110, 0.08)',
            borderRadius: '12px',
            p: '14px',
          }}
        >
          <Stack spacing={1.5}>
            {employeePolicy ? (
              <>
                <Stack
                  direction="row"
                  spacing={1.5}
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                  useFlexGap
                >
                  <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                    {currentPolicyLine(employeePolicy)}
                  </Typography>
                  <Button
                    variant="contained"
                    color="secondary"
                    size="small"
                    onClick={() => setTransferOpen(true)}
                  >
                    Transfer
                  </Button>
                </Stack>
                {probationLine(employeePolicy) ? (
                  <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                    {probationLine(employeePolicy)}
                  </Typography>
                ) : null}
                {scheduledTransferLine(employeePolicy) ? (
                  <Stack
                    direction="row"
                    spacing={1.5}
                    alignItems="center"
                    justifyContent="space-between"
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                      {scheduledTransferLine(employeePolicy)}
                    </Typography>
                    <Button
                      size="small"
                      onClick={() => void cancelScheduledTransfer()}
                      disabled={cancellingScheduled}
                    >
                      {cancellingScheduled ? 'Cancelling...' : 'Cancel'}
                    </Button>
                  </Stack>
                ) : null}
                {employeePolicy.history.length > 1 ? (
                  <Stack spacing={0.25}>
                    <Typography
                      sx={{ fontSize: 11, fontWeight: 700, color: '#98a2b3' }}
                    >
                      HISTORY
                    </Typography>
                    {shapeMembershipTimeline(employeePolicy.history).map(
                      (row) => (
                        <Typography
                          key={row.membershipId}
                          sx={{
                            fontSize: 12,
                            color: 'text.secondary',
                            textDecoration: row.superseded
                              ? 'line-through'
                              : 'none',
                          }}
                        >
                          {row.policyName}: {row.periodLabel}
                        </Typography>
                      ),
                    )}
                  </Stack>
                ) : null}
              </>
            ) : (
              <Stack
                direction="row"
                spacing={1.5}
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
                useFlexGap
              >
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  Not assigned to a policy yet.
                </Typography>
                <Button
                  variant="contained"
                  color="secondary"
                  size="small"
                  onClick={() => setTransferOpen(true)}
                >
                  Assign policy
                </Button>
              </Stack>
            )}
          </Stack>
        </Box>
      </Box>
      {transferOpen ? (
        <AdminPolicyTransferDialog
          employeeId={detail.employeeId}
          employeeName={detail.displayName}
          {...(employeePolicy
            ? { currentPolicyName: employeePolicy.current.policyName }
            : {})}
          policies={policies}
          api={api}
          today={new Date().toISOString().slice(0, 10)}
          onClose={() => setTransferOpen(false)}
          onTransferred={(next) => {
            onUpdated(next)
            setPolicyReload((count) => count + 1)
          }}
        />
      ) : null}
    </Stack>
  )
}
