/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CircularProgress from '@mui/material/CircularProgress'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha, type Theme } from '@mui/material/styles'
import type {
  LeaveAvailabilityPreviewDto,
  LeaveBalanceChangeDto,
  LeaveBalanceDto,
  LeaveRequestActivityDto,
  LeaveRequestApprovalRecipientDto,
  LeaveRequestDetailDto,
} from '@workspace/contracts'
import {
  ApproverDecision,
  ApproverKind,
  EmployeeProfileStatus,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { UNPAID_ACCENT } from '../../theme'
import { AppShell } from '../../components/layout/AppShell'
import { InfoHint } from '../../components/leave-metrics'
import { employeeNavigationSections } from '../../lib/app-navigation'
import { signedDeltaDays } from './balance-ledger'
import { aggregateBalanceTotals } from './dashboard-insights'
import type { YearFunding } from './leave-year-model'
import {
  describeArriving,
  type ReceiptSwatch,
  type ReceiptVerdict,
  type RequestReceipt as RequestReceiptModel,
} from './request-receipt'
import {
  accruedSplitOf,
  bookableDaysOf,
  calendarNoticeFor,
  exactBookableTooltip,
  floorDays,
  formatBalanceReason,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDayMonth,
  formatDayMonthLocal,
  formatDays,
  carriedOverFromLastYearSuffix,
  formatCompleteHoursDelta,
  formatLeaveType,
  formatStatus,
  formatWeekdayDayMonth,
  getStatusColor,
  partDayEntries,
  roundDays,
  spansYears,
  splitDayAmount,
} from '../../lib/leave-format'

// Re-export from the shared formatter module so employee pages keep importing
// these from here while there is a single implementation.
export {
  formatDate,
  formatDateTime,
  formatDays,
  formatLeaveType,
  formatStatus,
  getStatusColor,
}

export function EmployeePageFrame({
  title,
  subtitle,
  headerActions,
  headerSupplement,
  breadcrumbLabel,
  statusIndicator,
  titleAdornment,
  children,
}: {
  title: string
  subtitle: ReactNode
  headerActions?: ReactNode
  headerSupplement?: ReactNode
  breadcrumbLabel?: string
  statusIndicator?: ReactNode
  titleAdornment?: ReactNode
  children: ReactNode
}) {
  return (
    <AppShell
      title={title}
      subtitle={subtitle}
      headerActions={headerActions}
      headerSupplement={headerSupplement}
      breadcrumbLabel={breadcrumbLabel}
      statusIndicator={statusIndicator}
      titleAdornment={titleAdornment}
      navigation={employeeNavigationSections}
      productCaption="Employee workspace"
    >
      {children}
    </AppShell>
  )
}

export function SectionCard({
  title,
  caption,
  icon,
  iconTone = 'primary',
  accent = 'primary',
  side,
  sideVariant = 'note',
  children,
}: {
  title: string
  caption?: string
  // Optional header dressing (prototype card headers): a tinted icon tile on
  // the left and a right-aligned side note (e.g. "3 upcoming").
  icon?: ReactNode
  iconTone?: 'primary' | 'warning' | 'success'
  // Opt-in accent for the icon tile (prototype .card-ic). Defaults to the blue
  // primary so every existing employee caller is byte-identical; the admin
  // (teal) surface passes 'secondary'. `iconTone="warning"` still wins, so the
  // dashboard's warning tile is unchanged.
  accent?: 'primary' | 'secondary'
  side?: ReactNode
  // What the side slot holds. A 'note' is a short label ("3 upcoming") that
  // rides along the title; a 'control' is a select or button, which needs the
  // full width on narrow screens and therefore drops below the caption there
  // instead of squeezing it into a column.
  sideVariant?: 'note' | 'control'
  children: ReactNode
}) {
  const sideIsControl = sideVariant === 'control'
  return (
    <Card sx={{ p: { xs: 2.5, md: 3 } }}>
      <Stack spacing={2.5}>
        <Stack
          direction="row"
          spacing={1.5}
          // gap, not margins: a wrapped side slot must not keep a left offset.
          useFlexGap
          // Only a full-width control ever wraps; the title column has a zero
          // flex basis, so a short note can never break the line.
          flexWrap="wrap"
          alignItems="flex-start"
        >
          {icon ? (
            <Box
              sx={(theme) => ({
                width: 36,
                height: 36,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '11px',
                bgcolor:
                  iconTone === 'warning'
                    ? alpha(theme.palette.warning.main, 0.1)
                    : iconTone === 'success'
                      ? alpha(theme.palette.success.main, 0.1)
                      : accent === 'secondary'
                        ? alpha(theme.palette.secondary.main, 0.1)
                        : alpha(theme.palette.primary.main, 0.08),
                color:
                  iconTone === 'warning'
                    ? 'warning.main'
                    : iconTone === 'success'
                      ? 'success.main'
                      : accent === 'secondary'
                        ? 'secondary.main'
                        : 'primary.main',
              })}
              aria-hidden
            >
              {icon}
            </Box>
          ) : null}
          <Stack spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
            {/* Prototype .card-t / .card-cap: 16.5/800 over 12.5. */}
            <Typography component="h2" sx={{ fontSize: '16.5px', fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
              {title}
            </Typography>
            {caption ? (
              <Typography sx={{ fontSize: '12.5px', color: 'text.secondary' }}>
                {caption}
              </Typography>
            ) : null}
          </Stack>
          {side ? (
            // A Box, not a paragraph Typography: the side slot may hold block
            // controls (a select, a button group), which cannot legally nest
            // inside a <p>.
            <Box
              sx={{
                fontSize: '12.5px',
                fontWeight: 700,
                color: 'text.secondary',
                flexShrink: 0,
                // A full-width control claims its own row on xs; from sm the
                // slot returns to its intrinsic width beside the title. The
                // control itself is sized here too: a caller's field would
                // otherwise stay intrinsic inside the full-width row on xs,
                // and a fullWidth field would resolve 100% against an auto
                // wrapper from sm and collapse to its label.
                ...(sideIsControl
                  ? {
                      width: { xs: '100%', sm: 'auto' },
                      mt: { xs: 0, sm: 0.5 },
                      '& > *': { width: { xs: '100%', sm: 'auto' } },
                    }
                  : { mt: 0.5 }),
              }}
            >
              {side}
            </Box>
          ) : null}
        </Stack>
        {children}
      </Stack>
    </Card>
  )
}

export function LoadingSection({ label }: { label: string }) {
  return (
    <SectionCard title={label}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1.5} role="status" aria-live="polite">
          <CircularProgress size={20} aria-label="Loading" />
          <Typography variant="body2" color="text.secondary">
            Loading the latest employee data.
          </Typography>
        </Stack>
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="rounded" height={88} />
      </Stack>
    </SectionCard>
  )
}

export function ErrorSection({
  title,
  message,
}: {
  title: string
  message: string
}) {
  return (
    <SectionCard title={title}>
      <Alert severity="error">{message}</Alert>
    </SectionCard>
  )
}

// Per-status copy for ProfilePendingState. Explicit cases per known status; a
// status this build does not know yet falls back to neutral wording instead of
// silently inheriting the "admin is setting up your profile" narrative.
function profilePendingCopy(
  status: EmployeeProfileStatus,
  employmentStartDate?: string,
): { title: string; severity: 'info' | 'warning'; message: string } {
  switch (status) {
    case EmployeeProfileStatus.NotStartedYet:
      return {
        title: 'Employment starts soon',
        severity: 'info',
        message: `Your employment starts on ${
          employmentStartDate ? formatDate(employmentStartDate) : 'your start date'
        }. Leave balances begin accruing from that month when you start in its first half, otherwise from the month after, and requests will become available then.`,
      }
    case EmployeeProfileStatus.PendingSetup:
      return {
        title: 'Profile setup in progress',
        severity: 'warning',
        message:
          'Your profile is still being set up by an administrator. Leave balances and requests will become available once the setup is complete.',
      }
    default:
      return {
        title: 'Leave temporarily unavailable',
        severity: 'warning',
        message: 'Leave is currently unavailable for your account.',
      }
  }
}

// Replaces the ENTIRE request composer when the employee's country has NO
// configured holiday calendar for ANY year: every submission would be
// rejected, so the form is useless until an admin configures one. Shown
// immediately on page load — the employee should not have to pick a date to
// discover the problem.
export function HolidayCalendarMissingState() {
  return (
    <SectionCard title="Leave requests unavailable">
      <Stack spacing={1.5} data-testid="calendar-missing-state">
        <Alert severity="warning">
          No holiday calendar has been configured for your country yet, so
          leave requests cannot be submitted for any dates.
        </Alert>
        <Typography variant="body2" color="text.secondary">
          Please contact your administrator to set up the holiday calendar.
        </Typography>
      </Stack>
    </SectionCard>
  )
}

// Informational banner for the dashboard: warns when the employee's country
// has no holiday calendar at all, or none for the CURRENT year (per the
// server's generatedAt, not the client clock). Driven by the same
// calendarNoticeFor classifier the request composer uses, so the two surfaces
// cannot drift. Renders nothing when the current year is configured. Purely
// informational — the dashboard itself stays fully visible.
export function DashboardCalendarBanner({
  holidayCalendarYears,
  generatedAt,
}: {
  holidayCalendarYears: number[]
  generatedAt: string
}) {
  // No picked date on the dashboard: '' yields the none-configured or
  // current-year-missing notice (or null when the current year is fine).
  const notice = calendarNoticeFor('', { holidayCalendarYears, generatedAt })
  if (notice === null) {
    return null
  }
  return (
    <Alert severity="warning" data-testid="dashboard-calendar-warning">
      {notice.kind === 'none-configured'
        ? 'No holiday calendar has been configured for your country yet, so leave requests cannot be submitted until an administrator sets one up.'
        : `No holiday calendar is configured for the current year (${notice.year}) in your country yet, so requests for ${notice.year} cannot be submitted until an administrator sets one up.`}
    </Alert>
  )
}

// Replaces the ENTIRE page content while the backend reports a not-Ready
// profileStatus: either an admin has not finished the profile card yet
// (PendingSetup) or the employment start date is still in the future
// (NotStartedYet). Nothing accrues and no leave action is possible in either
// state. The readiness rule itself lives on the backend — this component only
// renders the reported status (employmentStartDate is display-only).
export function ProfilePendingState({
  status,
  employmentStartDate,
}: {
  status: EmployeeProfileStatus
  employmentStartDate?: string
}) {
  const copy = profilePendingCopy(status, employmentStartDate)
  return (
    <SectionCard title={copy.title}>
      <Stack spacing={1.5} data-testid="profile-pending-state">
        <Alert severity={copy.severity}>{copy.message}</Alert>
        <Typography variant="body2" color="text.secondary">
          If you have any questions, please contact your administrator.
        </Typography>
      </Stack>
    </SectionCard>
  )
}

export function EmptyState({
  title,
  message,
}: {
  title: string
  message: string
}) {
  return (
    <Box
      sx={{
        border: (theme) => `1px dashed ${theme.palette.divider}`,
        borderRadius: 3,
        px: 2,
        py: 3,
      }}
    >
      <Stack spacing={0.75} alignItems="flex-start">
        <Typography variant="h5" component="p">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {message}
        </Typography>
      </Stack>
    </Box>
  )
}

// Plain-language explanation of how a balance is derived, shown behind an (i)
// affordance so the accrual and rounding are transparent to the employee.
export function balanceExplanation(balance: LeaveBalanceDto): ReactNode {
  const isSick = balance.leaveType === LeaveType.Sick
  const held = balance.onHoldDays > 0
  // Days reserved by holds are not available to book - see bookableDaysOf.
  const bookable = formatDays(bookableDaysOf(balance))
  // The DTO's accruedDays counts the carryover, but "accrued" on screen means
  // earned from the annual entitlement, so the equation names the carryover as
  // its own term - and stays byte-identical when there is none. accruedSplitOf
  // caps and grid-floors the carried term so the printed terms always sum to
  // the printed result, even after a correction eats into the carryover.
  const { earnedDays: earned, carriedDays } = accruedSplitOf(balance)
  const accruedLabel = carriedDays > 0 ? 'accrued + carried over' : 'accrued'
  const carriedTerm =
    carriedDays > 0 ? ` + ${formatDays(carriedDays)} carried over` : ''
  return (
    <Stack spacing={0.75}>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>
        {formatLeaveType(balance.leaveType)}
      </Typography>
      <Typography variant="caption">
        {isSick
          ? `Sick leave is credited up front and available at any time: the full ${formatDays(balance.totalDays)} for a full year, or the share of it left in the year if you joined partway through.`
          : `Vacation accrues 1/12 of your ${formatDays(balance.totalDays)} allowance each month from your start month, reaching the full amount by December.`}
      </Typography>
      {(balance.carriedOverDays ?? 0) > 0 ? (
        <Typography variant="caption">
          {formatDays(balance.carriedOverDays ?? 0)} carried over from last year
          sits on top of that allowance.
        </Typography>
      ) : null}
      <Typography variant="caption">
        {isSick ? (
          held ? (
            <>
              {formatDays(balance.onHoldDays)} is on hold for pending
              requests, so {bookable} is available to book right now.
            </>
          ) : (
            <>You have {bookable} available to book right now.</>
          )
        ) : held ? (
          <>
            Available = {accruedLabel} − spent − on hold, rounded down to the
            hour: {formatDays(earned)} accrued{carriedTerm} −{' '}
            {formatDays(balance.spentDays)} spent −{' '}
            {formatDays(balance.onHoldDays)} on hold ={' '}
            {formatDays(
              balance.accruedDays - balance.spentDays - balance.onHoldDays,
            )}
            , so {bookable} is available to book right now.
          </>
        ) : (
          <>
            Available = {accruedLabel} − spent, rounded down to the hour:{' '}
            {formatDays(earned)} accrued{carriedTerm} −{' '}
            {formatDays(balance.spentDays)} spent ={' '}
            {formatDays(balance.accruedDays - balance.spentDays)}, so{' '}
            {bookable} is available to you right now.
          </>
        )}
      </Typography>
      {exactBookableTooltip(bookableDaysOf(balance)) ? (
        <Typography variant="caption">
          {exactBookableTooltip(bookableDaysOf(balance))}
        </Typography>
      ) : null}
    </Stack>
  )
}

// ————— Prototype stroke glyphs —————
// The design source (improved.html) uses 1.8px stroke-outline icons, not the
// filled Material set, so the exact SVG paths are reproduced here.
function glyphProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true as const,
    style: { display: 'block' },
  }
}

export function SunriseGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M12 3v2M5.6 5.6 7 7M3 12h2m0 5a7 7 0 1 1 14 0Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function HeartGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M12 21s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.4-7 10-7 10Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ClockGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M12 8v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CheckGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M20 7 9 18l-5-5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CalendarGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth={1.8} />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

export function ChevronGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ArrowGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M4 12h14m0 0-5-5m5 5-5 5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BubbleGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M8 10h8M8 14h5M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function BarsGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M4 19V5m0 14h16M8 15v-4m4 4V8m4 7v-6"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PeopleGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth={1.8} />
      <path
        d="M3 20c1-3.2 3.4-5 6-5s5 1.8 6 5M16 5.5a3.2 3.2 0 0 1 0 6M21 20c-.5-2-1.6-3.4-3-4.2"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PulseGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M3 12h4l3-8 4 16 3-8h4"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function WarnTriangleGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function PlusGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ListGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

// Drawn on the shared 24 grid like every glyph beside it. The earlier path was
// authored for a 16 box, so inside glyphProps' 24 viewBox its 8.5-radius arc
// swept outside the frame and only a clipped crescent survived.
export function UndoGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SlidersGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <path
        d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  )
}

// Prototype countries card glyph (.card-ic globe).
export function GlobeGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg {...glyphProps(size)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={1.8} />
      <path
        d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z"
        stroke="currentColor"
        strokeWidth={1.6}
      />
    </svg>
  )
}

// ————— Segmented control (prototype .seg) —————

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  icon?: ReactNode
}

/**
 * The prototype's segmented toggle: a light track with the active option
 * raised onto paper. Used for the composer's leave type (full width) and the
 * holidays page's display mode (inline). aria-pressed carries the state.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  fullWidth = false,
  accent = 'primary',
  trackColor = '#eef2f8',
  sizing = 'equal',
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  fullWidth?: boolean
  // 'equal' gives every option the same width, which is right when the options
  // are peers of similar length ("Days"/"Hours"). 'content' lets each option
  // size to its own label, which is what the prototype's tab bar does: pairing
  // a one-word tab with a five-word one under 'equal' inflates the short tab
  // into a slab of empty space. Defaults to 'equal' so existing callers are
  // byte-identical.
  sizing?: 'equal' | 'content'
  // Color of the SELECTED option (label + tint). Defaults to the blue primary
  // so every existing employee caller is byte-identical; the admin (teal)
  // surface passes 'secondary' for its sub-tab bar.
  accent?: 'primary' | 'secondary'
  // Track behind the options. Defaults to the cool grey-blue every caller on a
  // white card renders today. A control sitting INSIDE a tinted panel passes a
  // deeper tint of that panel's own hue, so the track reads as a recess in the
  // panel instead of a foreign chip dropped onto it.
  trackColor?: string
}) {
  const selectedColor = accent === 'secondary' ? 'secondary.main' : 'primary.main'
  return (
    <Box
      role="group"
      aria-label={ariaLabel}
      sx={{
        // Grid columns keep every option the SAME width, content length
        // notwithstanding; flex sizes each option by its own label.
        display:
          sizing === 'content'
            ? fullWidth
              ? 'flex'
              : 'inline-flex'
            : fullWidth
              ? 'grid'
              : 'inline-grid',
        ...(sizing === 'content'
          ? {}
          : { gridAutoFlow: 'column', gridAutoColumns: '1fr' }),
        gap: '2px',
        p: '3px',
        borderRadius: '12px',
        bgcolor: trackColor,
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
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              px: 2,
              py: 1,
              borderRadius: '10px',
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 700,
              color: selected ? selectedColor : 'text.secondary',
              bgcolor: selected ? 'background.paper' : 'transparent',
              boxShadow: selected ? '0 1px 3px rgba(16, 24, 40, 0.12)' : 'none',
              transition: 'all 0.16s ease',
            }}
          >
            {option.icon}
            {option.label}
          </ButtonBase>
        )
      })}
    </Box>
  )
}

// ————— Days stepper (prototype .days) —————

/**
 * One press of a DaysStepper button, pure for unit tests.
 *
 * `step` is an EXACT fraction of a day (an hour of a seven-hour day is 1/7,
 * never the 0.143 it is stored as). The current value is snapped onto that grid
 * before the move and the result is quantized to the books' three decimals
 * after it, which is the only way a workday whose hour does not divide evenly
 * keeps landing on figures the server accepts: seven presses of 1/7 reach
 * exactly 1, where repeated addition of 0.143 would reach 1.001 and be refused.
 *
 * A whole-day stepper (step 1) keeps truncating a typed decimal, because its
 * callers - policy terms, carryover caps, annual allocations - are whole-day
 * settings and half a day of annual entitlement is not a thing.
 */
export function steppedDaysValue(
  value: string,
  delta: number,
  options: { step: number; max?: number; min?: number },
): string {
  const current = Number(value) || 0
  // Zero unless the caller says otherwise: a count of days bottoms out at
  // none, while a PERIOD of years bottoms out at one because it divides.
  const min = options.min ?? 0
  const stepped =
    options.step === 1
      ? Math.max(min, Math.trunc(current) + delta)
      : Math.max(
          min,
          roundDays((Math.round(current / options.step) + delta) * options.step),
        )
  return String(
    options.max === undefined ? stepped : Math.min(options.max, stepped),
  )
}

// Prototype .days: a minus / value / plus stepper for whole-day settings.
// Typing stays possible (the input is not readonly) so a large number does not
// require dozens of clicks; the buttons clamp at zero. Shared by the admin
// Settings defaults and the per-employee annual allocation editor.
export function DaysStepper({
  label,
  value,
  onChange,
  ariaLabel,
  hideLabel = false,
  max,
  min,
  step = 1,
  dense = false,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  // When true, renders only the −/input/+ control without the internal top
  // label (the profile allocation rows supply their own label to the left).
  // Default false keeps the label-above layout every existing caller relies on.
  hideLabel?: boolean
  // Upper bound for the stepper buttons, for counts that are not open-ended
  // (a percentage stops at 100). Left undefined, stepping stays unbounded as
  // every day-count caller expects.
  max?: number
  // Lower bound for the buttons. Left undefined, stepping stops at zero, which
  // is what every day count wants; a period of years passes 1, because zero
  // years between two rises is a division by zero in the rate formula.
  min?: number
  // How much one press moves, as an EXACT fraction (an hour of a seven-hour
  // day is 1/7, never the 0.143 it is stored as). The value is snapped onto
  // that grid before stepping and quantized to the books' three decimals
  // after, so a workday whose hour does not divide evenly still steps onto
  // figures the server accepts. The default of 1 keeps every whole-day form
  // (policy terms, carryover caps, annual allocations) exactly as it was,
  // including its truncation of a typed decimal.
  step?: number
  // Compact 36px chrome for dense admin panes. Default false keeps the 40px
  // request-form sizing every existing caller relies on.
  dense?: boolean
  // Greys the whole control, for a term that means nothing until another one
  // is set (the increment period without an increment).
  disabled?: boolean
}) {
  const stepBy = (delta: number) => {
    onChange(
      steppedDaysValue(value, delta, {
        step,
        ...(max === undefined ? {} : { max }),
        ...(min === undefined ? {} : { min }),
      }),
    )
  }
  const buttonSx = {
    width: dense ? 36 : 38,
    height: dense ? 36 : 40,
    minWidth: 0,
    // The theme's 42px Button minHeight would silently win over the heights
    // above, so the stepper opts out and owns its own height.
    minHeight: 0,
    borderRadius: dense ? '8px' : '10px',
    border: '1px solid rgba(16, 24, 40, 0.14)',
    fontSize: dense ? 16 : 18,
    fontWeight: 700,
    lineHeight: 1,
    color: 'text.secondary',
    '&:hover': {
      borderColor: 'secondary.main',
      color: 'secondary.main',
      bgcolor: 'rgba(15, 118, 110, 0.08)',
    },
  } as const
  const control = (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Button
        variant="text"
        sx={buttonSx}
        aria-label={`Decrease ${label}`}
        disabled={disabled}
        onClick={() => stepBy(-1)}
      >
        –
      </Button>
      <TextField
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        inputProps={{
          inputMode: 'numeric',
          'aria-label': ariaLabel ?? label,
          style: {
            textAlign: 'center',
            fontWeight: 800,
            width: dense ? 40 : 44,
            ...(dense ? { fontSize: 13.5 } : {}),
          },
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            borderRadius: dense ? '8px' : '10px',
            height: dense ? 36 : 40,
          },
        }}
      />
      <Button
        variant="text"
        sx={buttonSx}
        aria-label={`Increase ${label}`}
        disabled={disabled}
        onClick={() => stepBy(1)}
      >
        +
      </Button>
    </Stack>
  )
  // Label-left callers (the profile allocation rows) supply their own label and
  // want the bare control; everyone else gets the label stacked above it.
  if (hideLabel) {
    return control
  }
  return (
    <Stack spacing={0.75}>
      <Typography
        sx={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.02em',
          color: 'text.secondary',
        }}
      >
        {label}
      </Typography>
      {control}
    </Stack>
  )
}

// ————— Shared row primitives (prototype .row-d / .tag / .badge / .link-btn) —————

// A pill segmented control (gray track, white selected pill) for a
// ToggleButtonGroup — the approved prototype pattern rather than MUI's default
// bordered attached buttons. Callers size the ToggleButtons themselves
// (px/py/fontSize) on top of this shell.
export const segmentedControlSx = {
  bgcolor: '#eef2f8',
  borderRadius: 999,
  p: '3px',
  '& .MuiToggleButtonGroup-grouped': {
    m: 0,
    border: 0,
    borderRadius: '999px',
    textTransform: 'none',
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.2,
    color: '#98a2b3',
    gap: 0.75,
    '&:hover': { bgcolor: 'transparent' },
    '&.Mui-selected': {
      color: '#101828',
      bgcolor: '#ffffff',
      boxShadow: '0 1px 2px rgba(16,24,40,.06)',
      '&:hover': { bgcolor: '#ffffff' },
    },
    '&:first-of-type': { borderRadius: '999px' },
    '&:not(:first-of-type)': { ml: '2px', borderRadius: '999px' },
  },
} as const

// Prototype .link-btn: compact 12.5/700 text buttons. Danger variants compose
// warning.dark + a warning tint hover on top (never error red — round-1 call).
export const linkButtonSx = {
  fontSize: '12.5px',
  fontWeight: 700,
  px: 1.25,
  py: '5px',
  minWidth: 0,
  minHeight: 0,
  borderRadius: '8px',
} as const

// Prototype .row-d: 12.5/500 with the inline arrow glyph — "Jul 24 → Jul 27,
// 2026 · 2d" (single-day entries render the one date only). Inherits color so
// highlighted rows can tint the whole line. `suffix` appends fragments like
// "· submitted Jul 21".
export function RangeLine({
  startDate,
  endDate,
  daysLabel,
  suffix,
  wrap = false,
}: {
  startDate: string
  endDate: string
  daysLabel?: string
  suffix?: ReactNode
  // History cards wrap their meta line on narrow widths (prototype .req-d);
  // dashboard rows keep it to one clipped line.
  wrap?: boolean
}) {
  return (
    <Typography
      noWrap={!wrap}
      sx={{
        fontSize: '12.5px',
        fontWeight: 500,
        color: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        ...(wrap ? { flexWrap: 'wrap' } : {}),
      }}
    >
      {startDate === endDate ? (
        formatDate(endDate)
      ) : (
        <>
          {/* The end date carries the year for both ends — unless the range
              crosses the New Year, where "Dec 25 → Jan 5, 2027" would silently
              file both ends under 2027. A crossing range names each year. */}
          {spansYears(startDate, endDate)
            ? formatDate(startDate)
            : formatDayMonth(startDate)}
          <ArrowGlyph />
          {formatDate(endDate)}
        </>
      )}
      {/* Each fragment is its own flex item so the 6px gap separates the
          middots — bare text nodes would sit flush against the date. */}
      {daysLabel ? <Box component="span">· {daysLabel}</Box> : null}
      {suffix ? <Box component="span">{suffix}</Box> : null}
    </Typography>
  )
}

// Prototype .badge: grey fill for "In N days"; the highlighted row's badge
// flips to the blue tint (.badge.hot).
export function RowBadge({ label, hot }: { label: string; hot?: boolean }) {
  return (
    <Box
      component="span"
      sx={(theme) => ({
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.4,
        px: '9px',
        py: '3px',
        borderRadius: '7px',
        whiteSpace: 'nowrap',
        bgcolor: hot ? alpha(theme.palette.primary.main, 0.14) : 'rgba(16, 24, 40, 0.06)',
        color: hot ? theme.palette.primary.main : theme.palette.text.secondary,
      })}
    >
      {label}
    </Box>
  )
}

// Prototype .tag: outlined neutral pill ("Public holiday").
export function RowTag({ label }: { label: string }) {
  return (
    <Box
      component="span"
      sx={{
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.4,
        px: '9px',
        py: '2.5px',
        borderRadius: '7px',
        whiteSpace: 'nowrap',
        border: '1px solid',
        borderColor: 'divider',
        color: '#667085',
        bgcolor: 'background.paper',
      }}
    >
      {label}
    </Box>
  )
}

// Prototype .chip status pill: tinted per status, 11.5/700, radius 8.
export function StatusPill({ status }: { status: LeaveRequestStatus | string }) {
  return (
    <Box
      component="span"
      sx={(theme) => {
        const base = {
          fontSize: 11.5,
          fontWeight: 700,
          lineHeight: 1.4,
          px: '10px',
          py: '3px',
          borderRadius: '8px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          border: '1px solid',
        }
        switch (status) {
          case LeaveRequestStatus.Pending:
            return {
              ...base,
              borderColor: alpha(theme.palette.warning.main, 0.35),
              bgcolor: alpha(theme.palette.warning.main, 0.1),
              color: theme.palette.warning.dark,
            }
          case LeaveRequestStatus.Approved:
            return {
              ...base,
              borderColor: alpha(theme.palette.success.main, 0.35),
              bgcolor: alpha(theme.palette.success.main, 0.1),
              color: theme.palette.success.main,
            }
          case LeaveRequestStatus.Rejected:
            return {
              ...base,
              borderColor: alpha(theme.palette.error.main, 0.35),
              bgcolor: alpha(theme.palette.error.main, 0.08),
              color: theme.palette.error.main,
            }
          // The leave was taken, under other dates. Sharing the neutral grey
          // with a cancelled request would say it never happened.
          case LeaveRequestStatus.Superseded:
            return {
              ...base,
              borderColor: alpha(theme.palette.info.main, 0.35),
              bgcolor: alpha(theme.palette.info.main, 0.1),
              color: theme.palette.info.main,
            }
          default:
            return {
              ...base,
              borderColor: 'rgba(16, 24, 40, 0.14)',
              bgcolor: 'rgba(16, 24, 40, 0.03)',
              color: '#667085',
            }
        }
      }}
    >
      {formatStatus(status)}
    </Box>
  )
}

// Prototype request-detail .kpi tile: compact label / value / detail metric.
// The approval page adopts this in its own redesign round.
// The value tint for a metric tile. Default ink; the admin KPI rows tint each
// stat by status (prototype .metric colors) so the eye lands on what matters.
export type MetricTone = 'default' | 'warning' | 'success' | 'error' | 'muted'

const METRIC_TONE_COLOR: Record<MetricTone, string> = {
  default: '#101828',
  warning: '#c2410c',
  success: '#15803d',
  error: '#b42318',
  muted: '#667085',
}

export function MetricTile({
  label,
  value,
  detail,
  tone = 'default',
  size = 'sm',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: MetricTone
  // 'sm' (18px) for in-page metric tiles; 'lg' (28px, tabular) for the admin
  // KPI rows that mirror the prototype .metric .v.
  size?: 'sm' | 'lg'
}) {
  return (
    <Card sx={{ p: '16px 16px 14px' }}>
      <Stack spacing={0.5}>
        <Typography
          sx={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#667085',
          }}
        >
          {label}
        </Typography>
        <Typography
          sx={{
            fontSize: size === 'lg' ? 28 : 18,
            fontWeight: 800,
            letterSpacing: '-0.01em',
            lineHeight: 1.15,
            fontVariantNumeric: size === 'lg' ? 'tabular-nums' : undefined,
            color: METRIC_TONE_COLOR[tone],
          }}
        >
          {value}
        </Typography>
        {detail ? (
          <Typography sx={{ fontSize: 12, color: '#667085', fontWeight: 500 }}>{detail}</Typography>
        ) : null}
      </Stack>
    </Card>
  )
}

// Prototype .decision banner: tinted outcome strip with a leading glyph.
export function DecisionBanner({
  tone,
  children,
}: {
  /**
   * 'info' is the consequence tone: something the reader must take in before
   * they act, but not something standing in their way. Kept clearly apart from
   * 'bad', which means the action is refused.
   */
  tone: 'ok' | 'info' | 'bad' | 'muted'
  children: ReactNode
}) {
  return (
    <Box
      sx={(theme) => ({
        display: 'flex',
        gap: 1.125,
        alignItems: 'flex-start',
        borderRadius: '11px',
        p: '10px 12px',
        fontSize: 12.5,
        lineHeight: 1.5,
        fontWeight: 500,
        ...(tone === 'ok'
          ? {
              bgcolor: alpha(theme.palette.success.main, 0.1),
              color: theme.palette.success.main,
            }
          : tone === 'bad'
            ? {
                bgcolor: alpha(theme.palette.warning.main, 0.1),
                color: theme.palette.warning.dark,
              }
            : tone === 'info'
              ? {
                  bgcolor: alpha(theme.palette.primary.main, 0.09),
                  color: theme.palette.primary.dark,
                }
              : {
                  bgcolor: 'rgba(16, 24, 40, 0.04)',
                  color: theme.palette.text.secondary,
                }),
      })}
    >
      {tone === 'muted' ? null : (
        <Box sx={{ flexShrink: 0, mt: '1px', display: 'flex' }}>
          {tone === 'ok' ? <CheckGlyph size={15} /> : <WarnTriangleGlyph />}
        </Box>
      )}
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  )
}

export type FoldingChipItem = {
  label: string
  title?: string
}

// Prototype .chips[data-max] folding: long recipient lists show the first
// `max` chips and fold the rest behind "+K more". Folding exactly one chip
// would cost the same space as showing it, so lists of max+1 render in full.
export function FoldingChips({ items, max = 3 }: { items: FoldingChipItem[]; max?: number }) {
  const [expanded, setExpanded] = useState(false)
  const foldable = items.length > max + 1
  const visible = foldable && !expanded ? items.slice(0, max) : items
  return (
    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
      {visible.map((item) => (
        <Box
          key={item.label}
          component="span"
          title={item.title}
          sx={{
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: 1.4,
            px: '10px',
            py: '3px',
            borderRadius: 999,
            border: '1px solid',
            borderColor: 'divider',
            color: 'text.secondary',
            whiteSpace: 'nowrap',
          }}
        >
          {item.label}
        </Box>
      ))}
      {foldable ? (
        <ButtonBase
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          sx={(theme) => ({
            fontSize: 11.5,
            fontWeight: 700,
            lineHeight: 1.4,
            px: '10px',
            py: '3px',
            borderRadius: 999,
            border: `1px dashed ${alpha(theme.palette.primary.main, 0.4)}`,
            color: 'primary.main',
            transition: 'background .15s ease',
            '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08), borderStyle: 'solid' },
          })}
        >
          {expanded ? 'Show less' : `+${items.length - max} more`}
        </ButtonBase>
      ) : null}
    </Box>
  )
}

// One segment of a KPI tile's stacked bar: an exact day value and its color.
type KpiBarSegment = {
  value: number
  color: string
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// Never UP (exported for unit tests). Every figure this animates is an amount
// of leave, and the standing rule is that an employee is never shown more than
// they can take: a headline that rounded 3.6 to 4 would promise four days the
// balance cannot fund. A whole input (which is what splitDayAmount hands the
// KPI tiles) is unmoved, and the final frame lands exactly on the target
// because the easing reaches 1.
export const countUpFrame = (value: number): number => Math.floor(value + 1e-9)

// Animated headline figure: counts from the previously shown value to the
// target over ~0.9s (prototype .count). Server/static renders show 0 and the
// number settles on mount; a data refresh re-counts from the on-screen value.
export function CountUpNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(0)
  const displayRef = useRef(0)

  useEffect(() => {
    const settled = countUpFrame(value)
    const from = displayRef.current
    if (from === settled || prefersReducedMotion()) {
      displayRef.current = settled
      setDisplay(settled)
      return
    }
    let raf = 0
    const start = performance.now()
    const duration = 900
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = countUpFrame(from + (value - from) * eased)
      displayRef.current = next
      setDisplay(next)
      if (t < 1) {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return <>{display}</>
}

// Thin stacked bar under a KPI value: segment widths are fractions of the
// larger of `total` and the segments' sum (available+onHold+spent can exceed
// the yearly total mid-accrual — without the normalization the trailing grey
// "spent" piece would be clipped by overflow:hidden). Widths animate from 0 on
// mount (prototype data-w behavior). Renders nothing without a positive total.
function KpiBar({ segments, total, label }: { segments: KpiBarSegment[]; total: number; label: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setArmed(true)
  }, [])

  const visible = segments.filter((segment) => segment.value > 0)
  // A zero allowance is not the same as nothing to show: somebody moved onto a
  // no-leave policy mid-year still has the days they already took, and hiding
  // the bar there left the card reading "0 days · 5d spent" with nothing to
  // explain it. The bar is dropped only when there is genuinely nothing to
  // draw — no allowance AND no days used.
  if (total <= 0 && visible.length === 0) {
    return null
  }
  const denominator = Math.max(
    total,
    visible.reduce((sum, segment) => sum + segment.value, 0),
  )
  return (
    <Box
      role="img"
      aria-label={label}
      sx={(theme) => ({
        display: 'flex',
        height: 6,
        borderRadius: '4px',
        bgcolor: alpha(theme.palette.text.primary, 0.07),
        overflow: 'hidden',
        '& > * + *': { ml: '2px' },
      })}
    >
      {visible.map((segment, index) => (
        <Box
          key={index}
          sx={{
            flex: 'none',
            width: armed ? `${(segment.value / denominator) * 100}%` : 0,
            transition: 'width 900ms cubic-bezier(.22,1,.36,1)',
            bgcolor: segment.color,
            borderRadius: '4px',
          }}
        />
      ))}
    </Box>
  )
}

function KpiLegendDot({ color }: { color: string }) {
  return (
    <Box
      component="span"
      sx={{
        width: 8,
        height: 8,
        borderRadius: '3px',
        bgcolor: color,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  )
}

type KpiTone = 'primary' | 'warning' | 'muted'

function kpiToneSx(tone: KpiTone) {
  if (tone === 'warning') {
    return {
      bgcolor: (theme: Theme) => alpha(theme.palette.warning.main, 0.1),
      color: 'warning.main',
    }
  }
  if (tone === 'muted') {
    return { bgcolor: 'rgba(16, 24, 40, 0.05)', color: 'text.secondary' }
  }
  return {
    bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, 0.08),
    color: 'primary.main',
  }
}

// The quiet unit letter beside a KPI figure ("d", "h").
function KpiUnit({ children }: { children: ReactNode }) {
  return (
    <Typography
      component="span"
      sx={{ fontSize: '1rem', fontWeight: 700, color: 'text.secondary', ml: 0.5 }}
    >
      {children}
    </Typography>
  )
}

function KpiTile({
  label,
  value,
  hint,
  cornerIcon,
  tone = 'primary',
  bar,
  legend,
  detail,
  testId,
}: {
  label: string
  value: number
  hint?: ReactNode
  // Prototype .kpi-ic: a tinted 32px icon tile pinned to the top-right corner.
  cornerIcon?: ReactNode
  tone?: KpiTone
  bar?: ReactNode
  legend?: ReactNode
  detail: string
  testId: string
}) {
  // The EXACT amount comes in; the floor to the bookable hour grid happens
  // here, in the one renderer, so the tile can never disagree with the legend
  // chips beside it.
  const amount = splitDayAmount(value)
  return (
    <Card sx={{ p: 2.25, position: 'relative', overflow: 'hidden' }} data-testid={testId}>
      {cornerIcon ? (
        <Box
          sx={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 32,
            height: 32,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '9px',
            ...kpiToneSx(tone),
          }}
          aria-hidden
        >
          {cornerIcon}
        </Box>
      ) : null}
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ pr: cornerIcon ? 5 : 0 }}>
          <Typography variant="overline" color="text.secondary">
            {label}
          </Typography>
          {hint ? (
            // The (i) affordance stays discoverable but nearly silent until
            // approached — it is a footnote, not a peer of the KPI label.
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                opacity: 0.4,
                transition: 'opacity 150ms ease',
                '&:hover, &:focus-within': { opacity: 1 },
              }}
            >
              {hint}
            </Box>
          ) : null}
        </Stack>
        {/* Named so the notation this tile assembles by hand can be pinned
            against the one formatDays renders everywhere else. */}
        <ExactDaysHover days={value}>
        <Typography
          data-testid={`${testId}-amount`}
          sx={{ fontSize: '2rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05, cursor: exactBookableTooltip(value) ? 'help' : undefined }}
        >
          {/* Days and hours, the app's one notation for an amount of leave, laid
              out as figures with quiet units so the tile still reads as a
              number at a glance. Split from formatDays rather than parsed out
              of it, and rendered to the same rule: the hours part is dropped
              when the amount is whole, and the DAYS part is dropped when there
              are none, so half a day reads "4h" here exactly as formatDays
              renders it everywhere else rather than "0d 4h". Both parts are
              only ever absent together at zero, which is the one "0d". */}
          {amount.days > 0 || amount.hours === 0 ? (
            <>
              <CountUpNumber value={amount.days} />
              <KpiUnit>d</KpiUnit>
            </>
          ) : null}
          {amount.hours > 0 ? (
            <>
              {amount.days > 0 ? ' ' : null}
              <CountUpNumber value={amount.hours} />
              <KpiUnit>h</KpiUnit>
            </>
          ) : null}
        </Typography>
        </ExactDaysHover>
        {bar}
        {legend}
        <Typography variant="caption" color="text.secondary">
          {detail}
        </Typography>
      </Stack>
    </Card>
  )
}

// The dashboard's four balance KPI tiles (prototype: Vacation available / Sick
// available / On hold / Taken this year). Headline figures are floored to the
// bookable hour grid by the tile itself; bar segment widths use the exact
// figures.
export function BalanceKpiGrid({
  balances,
  pendingCount,
  hoursPerDay,
}: {
  balances: LeaveBalanceDto[]
  pendingCount: number
  /** The org's workday, from the dashboard payload these balances came on:
   *  the hour-grid test below decides which leave types the breakdown names. */
  hoursPerDay: number
}) {
  const { vacation, sick, onHoldTotal, spentTotal, spentVacation, spentSick } =
    aggregateBalanceTotals(balances)
  // The pool the org-wide tiles measure against: annual totals plus the
  // carryover sitting on top of them, matching the per-type bars below which
  // already stretch their track by carriedOverDays. The two parts stay
  // separate so the labels can name the carryover the way every other
  // pool-denominated label on this grid does.
  const annualAllocationTotal = balances.reduce(
    (sum, balance) => sum + balance.totalDays,
    0,
  )
  const carriedOverTotal = balances.reduce(
    (sum, balance) => sum + Math.max(balance.carriedOverDays ?? 0, 0),
    0,
  )
  const allocationTotal = annualAllocationTotal + carriedOverTotal
  const allocationNote = `${formatDays(annualAllocationTotal)} allocation${carriedOverFromLastYearSuffix(carriedOverTotal)}`
  const availableColor = 'primary.main'
  const holdColor = 'warning.main'
  const spentColor = 'rgba(16, 24, 40, 0.16)'

  return (
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
      <KpiTile
        label="Vacation available"
        // Bookable, not the DTO's availableDays: days a pending request holds
        // are not available to book (see bookableDaysOf).
        value={vacation ? bookableDaysOf(vacation) : 0}
        testId="kpi-vacation"
        cornerIcon={<SunriseGlyph />}
        hint={
          vacation ? (
            <InfoHint
              title={balanceExplanation(vacation)}
              label="How Vacation is calculated"
            />
          ) : undefined
        }
        bar={
          vacation ? (
            <KpiBar
              total={vacation.totalDays + (vacation.carriedOverDays ?? 0)}
              label={`Vacation: ${formatDays(bookableDaysOf(vacation))} available, ${formatDays(vacation.onHoldDays)} on hold, ${formatDays(vacation.spentDays)} spent, of ${formatDays(vacation.totalDays)} total${carriedOverFromLastYearSuffix(vacation.carriedOverDays)}`}
              segments={[
                { value: bookableDaysOf(vacation), color: availableColor },
                { value: vacation.onHoldDays, color: holdColor },
                { value: vacation.spentDays, color: spentColor },
              ]}
            />
          ) : undefined
        }
        legend={
          vacation && (vacation.onHoldDays > 0 || vacation.spentDays > 0) ? (
            <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap">
              {vacation.onHoldDays > 0 ? (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <KpiLegendDot color={holdColor} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDays(vacation.onHoldDays)} on hold
                  </Typography>
                </Stack>
              ) : null}
              {vacation.spentDays > 0 ? (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <KpiLegendDot color={spentColor} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDays(vacation.spentDays)} spent
                  </Typography>
                </Stack>
              ) : null}
            </Stack>
          ) : undefined
        }
        detail={
          vacation
            ? // "accrued so far" is what the entitlement has earned: the DTO's
              // accruedDays counts the carryover too, which this line already
              // names beside the total, so it comes off before display.
              `of ${formatDays(vacation.totalDays)} total${carriedOverFromLastYearSuffix(vacation.carriedOverDays)} · accrues monthly · ${formatDays(accruedSplitOf(vacation).earnedDays)} accrued so far`
            : 'No vacation balance yet'
        }
      />
      <KpiTile
        label="Sick available"
        // Same bookable figure as the vacation tile: held days are excluded.
        value={sick ? bookableDaysOf(sick) : 0}
        testId="kpi-sick"
        cornerIcon={<HeartGlyph />}
        hint={
          sick ? (
            <InfoHint title={balanceExplanation(sick)} label="How Sick leave is calculated" />
          ) : undefined
        }
        bar={
          sick ? (
            <KpiBar
              total={sick.totalDays + (sick.carriedOverDays ?? 0)}
              label={`Sick leave: ${formatDays(bookableDaysOf(sick))} available, ${formatDays(sick.onHoldDays)} on hold, ${formatDays(sick.spentDays)} spent, of ${formatDays(sick.totalDays)} total${carriedOverFromLastYearSuffix(sick.carriedOverDays)}`}
              segments={[
                { value: bookableDaysOf(sick), color: availableColor },
                { value: sick.onHoldDays, color: holdColor },
                { value: sick.spentDays, color: spentColor },
              ]}
            />
          ) : undefined
        }
        legend={
          sick && (sick.onHoldDays > 0 || sick.spentDays > 0) ? (
            <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap">
              {sick.onHoldDays > 0 ? (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <KpiLegendDot color={holdColor} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDays(sick.onHoldDays)} on hold
                  </Typography>
                </Stack>
              ) : null}
              {sick.spentDays > 0 ? (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <KpiLegendDot color={spentColor} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDays(sick.spentDays)} spent
                  </Typography>
                </Stack>
              ) : null}
            </Stack>
          ) : undefined
        }
        detail={
          sick
            ? `of ${formatDays(sick.totalDays)} total${carriedOverFromLastYearSuffix(sick.carriedOverDays)} · credited up front`
            : 'No sick-leave balance yet'
        }
      />
      <KpiTile
        label="On hold"
        value={onHoldTotal}
        testId="kpi-on-hold"
        cornerIcon={<ClockGlyph />}
        tone="warning"
        hint={
          <InfoHint
            label="How On hold works"
            title={
              <Stack spacing={0.75}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  On hold
                </Typography>
                <Typography variant="caption">
                  Days reserved by pending requests and by approved leave that has not started
                  yet, so they cannot be requested twice.
                </Typography>
                <Typography variant="caption">
                  A rejection or cancellation releases them back to available; taking the leave
                  converts them to spent on the leave dates.
                </Typography>
              </Stack>
            }
          />
        }
        bar={
          <KpiBar
            total={allocationTotal}
            label={`${formatDays(onHoldTotal)} on hold, of ${allocationNote}`}
            segments={[{ value: onHoldTotal, color: holdColor }]}
          />
        }
        detail={
          pendingCount === 0
            ? 'no pending requests holding days'
            : `held by ${pendingCount} pending ${pendingCount === 1 ? 'request' : 'requests'}`
        }
      />
      <KpiTile
        label="Taken this year"
        value={spentTotal}
        testId="kpi-taken"
        cornerIcon={<CheckGlyph />}
        tone="muted"
        hint={
          <InfoHint
            label="How Taken this year works"
            title={
              <Stack spacing={0.75}>
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  Taken this year
                </Typography>
                <Typography variant="caption">
                  {/* Name only the types actually taken: "0d vacation and 0d
                      sick" reads like a bug, not a breakdown. */}
                  {floorDays(spentVacation, hoursPerDay) > 0 ||
                  floorDays(spentSick, hoursPerDay) > 0 ? (
                    <>
                      Days already consumed as leave in the current leave year:{' '}
                      {[
                        floorDays(spentVacation, hoursPerDay) > 0
                          ? `${formatDays(spentVacation)} vacation`
                          : null,
                        floorDays(spentSick, hoursPerDay) > 0
                          ? `${formatDays(spentSick)} sick`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' and ')}
                      .
                    </>
                  ) : (
                    <>Nothing has been taken yet in the current leave year.</>
                  )}
                </Typography>
                <Typography variant="caption">
                  Spent days never return to the balance; the counter starts over on the first
                  day of the next leave year.
                </Typography>
              </Stack>
            }
          />
        }
        bar={
          <KpiBar
            total={allocationTotal}
            label={`${formatDays(spentTotal)} taken, of ${allocationNote}`}
            segments={[{ value: spentTotal, color: spentColor }]}
          />
        }
        detail={`${formatDays(spentVacation)} vacation · ${formatDays(spentSick)} sick`}
      />
    </Box>
  )
}

// Compact calendar-leaf date tile (prototype .date-tile): month over day, both
// UTC-pinned like every calendar date in the app.
export function DateTile({ date }: { date: string }) {
  const parsed = new Date(date.length <= 10 ? `${date}T00:00:00.000Z` : date)
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      sx={{
        width: 52,
        height: 54,
        flexShrink: 0,
        borderRadius: '12px',
        border: (theme) => `1px solid ${theme.palette.divider}`,
        bgcolor: 'background.paper',
      }}
      aria-hidden
    >
      <Typography sx={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', color: 'text.secondary', textTransform: 'uppercase', lineHeight: 1.2 }}>
        {parsed.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}
      </Typography>
      <Typography sx={{ fontSize: 19, fontWeight: 800, lineHeight: 1.1 }}>
        {parsed.getUTCDate()}
      </Typography>
    </Stack>
  )
}

// The bar's background (prototype --track): the not-yet-accrued remainder. For
// vacation that is whatever December still owes; for sick it is the share of
// the annual allowance a mid-year joiner never earns. It gets its own "pending
// accrual" legend entry whenever it is non-empty - unlabeled, the light track
// and the light preview segment read as one another's color.
const METER_TRACK = '#dbe4ff'
// Spent is its own segment in the same muted ink the dashboard KpiBar uses,
// never the track color: the uncovered track is unaccrued days, and labeling
// that color "spent" would misread every pre-December vacation balance.
const METER_SPENT = 'rgba(16, 24, 40, 0.16)'

/**
 * The one hatch on this bar, in whatever colour it is asked for.
 *
 * Two bands use it, and they mean the same KIND of thing: days that are not in
 * the balance right now. Arriving days will be; unpaid days never will. Giving
 * them one texture and two colours says exactly that - same nature, different
 * outcome - where two different textures would have implied two unrelated
 * ideas and left the reader deciding which pattern meant what.
 *
 * The pitch is the fine one on purpose: an unpaid tail can be a single day,
 * a sliver of the bar, and a coarse hatch would have nothing to show there.
 */
// A flat colour expressed as a background-IMAGE, so it can sit on top of the
// opaque backing every band now carries (see the plate note on the segments).
const solidFill = (color: string) => `linear-gradient(${color}, ${color})`

const hatchFill = (color: string) =>
  `repeating-linear-gradient(135deg, ${alpha(color, 0.85)} 0 2px, ${alpha(
    color,
    0.26,
  )} 2px 5px)`

// Days the year has not paid out yet but will have by the time the leave is
// taken. Hatched rather than solid: they are promised, not held.
const arrivingFill = (theme: Theme) => hatchFill(theme.palette.primary.main)

// Days of a leave the balance does not pay for. The hue is its own
// (UNPAID_ACCENT) because every other colour on this bar already means a kind
// of balance day; the shared hatch is what places it beside the arriving band
// rather than beside available and on hold.
const unpaidFill = () => hatchFill(UNPAID_ACCENT)

/**
 * How far a band reaches back over its neighbour to fade in.
 *
 * Deliberately small. The bar is 12px tall and one day of a 24-day year is
 * 12-17px wide on it, so a blend anywhere near 12px has the footprint of a
 * whole day and stops reading as an edge treatment - it becomes a band of its
 * own that stands for nothing. 4px is an edge; it is also comfortably under the
 * hatch's 7.07px horizontal period, so a seam can never swallow a whole stripe.
 */
const SEAM_BLEND = 4

// A straight alpha ramp across the overlap. The band underneath stays fully
// opaque the whole way, so the pair reads as one blending into the other with
// nothing showing through between them.
const SEAM_MASK =
  `linear-gradient(90deg, rgba(0, 0, 0, 0) 0, rgb(0, 0, 0) ${SEAM_BLEND}px, rgb(0, 0, 0) 100%)`

// The marking laid OVER the bands a request would touch. An outline rather
// than a fill, so the bands underneath stay readable: the request is an
// intention over the balance, not a slice of it.
const affectedSx = (theme: Theme) => ({
  position: 'absolute' as const,
  top: -2,
  bottom: -2,
  border: `1.5px dashed ${alpha(theme.palette.primary.dark, 0.75)}`,
  borderRadius: '6px',
  backgroundColor: alpha(theme.palette.primary.main, 0.07),
  cursor: 'help',
})

/**
 * The state of one leave year at the month a request falls in: what will have
 * accrued by then, and what is already claimed of it.
 *
 * Straight off the server's monthly outlook, with one thing worth naming:
 * `committedDays` already INCLUDES the request being composed, so the days of
 * that request are subtracted back out to draw them as their own segment.
 */
export type BalanceProjection = {
  leaveYear: number
  month: number
  projectedAccruedDays: number
  committedDays: number
  remainingDays: number
  requestedDays: number
}

// One band of the balance meter, described once and rendered twice: as a block
// in the bar and as a chip in the legend under it.
type MeterSegment = {
  key: string
  value: number
  /** "available" shows a zero, since a zero there is the message. */
  alwaysInLegend?: boolean
  /** The empty tail is a band in the bar but not a colour worth a chip. */
  hideFromLegend?: boolean
  /**
   * The empty remainder rather than a real band: it carries no plate, so the
   * band before it fades out over the bare track the way it should.
   */
  tail?: boolean
  label: string
  /** Sign in front of the legend figure, for a band that adds rather than is. */
  prefix?: string
  fill: (theme: Theme) => string
  /**
   * Takes a faint fill when pointed at. Only the tail needs it: the highlight
   * everywhere else is the OTHER bands easing back, which a band with no
   * colour of its own cannot show.
   */
  highlightOnHover?: boolean
  title: string
}

// Behind the dashed marking and its chip: what the request draws on, naming
// only the pools it actually touches. A leave inside this month waits for
// nothing, and "0d from future accrual" would invite the reader to wonder
// what they missed.
function affectedExplanation(
  draw: RequestDraw,
  requestedDays: number,
  byThen: string,
): string {
  if (draw.unpaid > 0) {
    const funded = formatDays(draw.fromArriving + draw.fromAvailable)
    return draw.unpaid >= requestedDays
      ? `${formatDays(requestedDays)} requested, none of which the balance can cover: the whole leave would be unpaid.`
      : `${formatDays(requestedDays)} requested, of which the balance covers ${funded}. The other ${formatDays(draw.unpaid)} would be unpaid.`
  }
  const sources: string[] = []
  if (draw.fromArriving > 0) {
    sources.push(
      `${formatDays(draw.fromArriving)} from the accrual arriving before ${byThen || 'it starts'}`,
    )
  }
  if (draw.fromAvailable > 0) {
    sources.push(`${formatDays(draw.fromAvailable)} from what is available today`)
  }
  return `${formatDays(requestedDays)} of leave: ${sources.join(', ')}.`
}

// The tail answers two questions at once: what this empty stretch is, and how
// much of the year is still free to plan once everything committed is taken
// off. The second figure is the one people actually plan against.
// Exported for tests: it feeds a MUI Tooltip, which renders nothing under
// renderToString, so the copy is only pinnable as the pure function.
export function restExplanation(input: {
  rest: number
  totalDays: number
  spent: number
  onHold: number
  requested: number
}): string {
  const toPlan = roundDays(
    input.totalDays - input.spent - input.onHold - input.requested,
  )
  // With no draft there is no "after this leave" to speak of.
  const what =
    input.requested > 0
      ? `${formatDays(input.rest)} of your allowance lands after this leave, later in the year.`
      : `${formatDays(input.rest)} of your allowance has yet to accrue this year.`
  // A request that does not fit must not be reported as "0 left": a zero reads
  // as "exactly used up" when the truth is an overdraft.
  const tail =
    toPlan < 0
      ? `Counting this request, the year is over-committed by ${formatDays(-toPlan)}.`
      : input.requested > 0
        ? `Counting this request, ${formatDays(toPlan)} of the year stay free to plan between now and 31 December.`
        : `In all, ${formatDays(toPlan)} of the year stay free to plan between now and 31 December.`
  return `${what} ${tail}`
}

// The dashed marking is not one of the bands, but it takes part in the same
// hover highlighting, so it needs a key in the same space.
const AFFECTED_KEY = 'affected'

export type RequestDraw = {
  /** Taken from the accrual that lands before the leave starts. */
  fromArriving: number
  /** Taken from what is already available today. */
  fromAvailable: number
  /** Days the balance cannot fund, which would be taken unpaid. */
  unpaid: number
  /** The stretch of the bar the request marks: everything it can draw on. */
  covered: number
}

/**
 * Where a request's days come from, pure so the arithmetic is testable without
 * a DOM.
 *
 * Funded from the ARRIVING days first, then from today's. That is the true
 * order: a December leave is paid for by the accrual landing before December,
 * and reporting it as eating today's balance would claim it touches days it
 * never does. With nothing arriving - a leave inside this month - it reduces
 * to drawing on today's balance alone.
 *
 * `unpaidDays` is the server's own verdict on the same range, and it wins when
 * it is there: the split is decided day by day against the accrual due on each
 * one, which this year-end arithmetic can only approximate. Without it (no
 * preview yet, or a preview for other dates) the local estimate stands in.
 */
export function requestDraw(input: {
  availableNow: number
  arrivingByThen: number
  requestedDays: number
  unpaidDays?: number
}): RequestDraw {
  const requested = Math.max(input.requestedDays, 0)
  const arriving = Math.max(input.arrivingByThen, 0)
  const available = Math.max(input.availableNow, 0)
  const unpaid =
    input.unpaidDays === undefined
      ? Math.max(requested - Math.min(requested, available + arriving), 0)
      : Math.min(Math.max(input.unpaidDays, 0), requested)
  const funded = roundDays(requested - unpaid)
  const fromArriving = Math.min(arriving, funded)
  const fromAvailable = Math.max(funded - fromArriving, 0)
  return {
    fromArriving: roundDays(fromArriving),
    fromAvailable: roundDays(fromAvailable),
    unpaid: roundDays(unpaid),
    covered: funded,
  }
}

/**
 * One balance as a segmented meter bar (prototype .meter-block): bookable
 * days in primary, on hold in warning, spent in muted ink, over an unaccrued
 * track. The live preview (the days the request being composed would take)
 * splits off the END of the available segment in a lighter primary, so the
 * draft visibly consumes bookable days rather than the track.
 *
 * With a `projection`, the days that will have accrued by the month the leave
 * falls in get their own segment, continuing the available one. That is what
 * makes planning ahead legible: booking December from January shows a short
 * solid "available today" followed by the longer stretch the year still owes,
 * with the request sitting on the days it actually waits for.
 *
 * Legend figures follow the headline rounding rule (floored to the hour
 * grid, by formatDays); the bar widths use the exact values. The denominator stretches to fit oversized
 * content the same way KpiBar does, so an overdrawn preview never overflows.
 */
/**
 * The bar itself: a head, the segmented track with its dashed marking, and the
 * legend built from the same segment list. It knows nothing about balances or
 * leave years, so one of these draws today's balance and another draws a year
 * that has not begun.
 *
 * Hover state lives HERE rather than one level up: with several bars on screen,
 * pointing at a band in one must not dim the bands of the next.
 */
function MeterBar({
  name,
  note,
  variant,
  segments,
  denominator,
  marking,
  ariaLabel,
  testId,
}: {
  name: string
  /** The head's right-hand note; the tile variant shows the name alone. */
  note?: string
  variant: 'meter' | 'tile'
  segments: MeterSegment[]
  denominator: number
  /** The dashed overlay, or null while nothing is being composed. */
  marking: { days: number; coveredDays: number; title: string } | null
  ariaLabel: string
  testId: string
}) {
  const widthOf = (value: number) => `${(value / denominator) * 100}%`

  // Which band the reader is pointing at, on the bar or on its chip: the two
  // surfaces highlight together, so a chip lights up its block and a block
  // lights up its chip.
  const [hovered, setHovered] = useState<string | null>(null)
  // Everything except the pointed-at band fades. Nothing fades while nothing
  // is hovered, so the bar sits at full strength at rest.
  const dimmed = (key: string) => hovered !== null && hovered !== key

  // The bands that actually reach the bar, so the ends can be rounded by
  // position rather than by a CSS selector the marking would disturb.
  const drawn = segments.filter((segment) => segment.value > 0)

  return (
    <Stack
      spacing={1.1}
      sx={{
        p: 1.75,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '14px',
        // The tile stands directly on the page canvas (prototype .bal-tile),
        // so it carries the paper-card treatment; the default meter lives
        // inside a SectionCard and stays as-is.
        ...(variant === 'tile'
          ? {
              bgcolor: 'background.paper',
              boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
              borderRadius: '16px',
              py: 2,
              px: 2.25,
            }
          : {}),
      }}
      data-testid={testId}
    >
      {variant === 'tile' ? (
        // No headline figure: the legend under the bar already reads
        // "Nd available", and the same number twice in one tile invites the
        // reader to look for a difference between them.
        <Stack direction="row" alignItems="baseline" spacing={1}>
          <Typography
            sx={{
              fontSize: 15,
              fontWeight: 800,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </Typography>
          {note ? (
            <Typography
              sx={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'text.secondary',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {note}
            </Typography>
          ) : null}
        </Stack>
      ) : (
        // space-between, not an auto margin: the two groups are the header's
        // left and right edges, and the plan figure has to stay pinned to the
        // right one whether or not the accrued note beside the name is there.
        <Stack direction="row" alignItems="center" spacing={1} justifyContent="space-between">
          <Stack
            direction="row"
            alignItems="baseline"
            spacing={1}
            sx={{ minWidth: 0, flexShrink: 1 }}
          >
            <Typography sx={{ fontSize: 14, fontWeight: 800 }}>{name}</Typography>
            {/* While the year still owes days, the header explains the pale
                track ("14d of 25 accrued"), so the legend needs no extra chip
                for it and stays a single line. */}
            <Typography
              sx={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'text.secondary',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {note}
            </Typography>
          </Stack>
        </Stack>
      )}
      <Box
        role="img"
        aria-label={ariaLabel}
        sx={{
          position: 'relative',
          display: 'flex',
          height: 12,
          borderRadius: '6px',
          bgcolor: METER_TRACK,
        }}
      >
        {drawn.map((segment, index) => (
          <MeterTooltip key={segment.key} title={segment.title}>
            <Box
              onMouseEnter={() => setHovered(segment.key)}
              onMouseLeave={() => setHovered(null)}
              sx={(theme) => ({
                flex: 'none',
                position: 'relative',
                // Bands overlap now, so paint order decides the seams. Equal
                // z-index resolves by tree order, which is the order the bands
                // are listed in - each one covers the tail of the one before.
                zIndex: 1,
                // The band reaches back over its neighbour by SEAM_BLEND and
                // fades in across it, so the two meet as a gradient rather than
                // at a line. The width grows by exactly what the margin takes
                // away: the band's right edge stays where the data puts it, and
                // without that compensation every band after the first drifts
                // left and the bar stops depicting the right quantities.
                ...(index === 0
                  ? { width: widthOf(segment.value) }
                  : {
                      width: `calc(${widthOf(segment.value)} + ${SEAM_BLEND}px)`,
                      marginLeft: `-${SEAM_BLEND}px`,
                      maskImage: SEAM_MASK,
                      WebkitMaskImage: SEAM_MASK,
                    }),
                // The plate. Every band paints the track as its own opaque
                // backing and its colour on top. Away from a seam this changes
                // nothing - the track was already what showed through a hatch's
                // gaps. In the overlap it is what makes the fade a clean blend
                // of the two bands instead of both of them going half
                // transparent and letting the track wash through the middle.
                backgroundColor: segment.tail ? 'transparent' : METER_TRACK,
                backgroundImage: segment.fill(theme),
                cursor: 'help',
                // Rounded by POSITION IN THE LIST, not by :first/:last-of-type:
                // the dashed marking is a sibling of these blocks, so whenever
                // a request is being composed it would steal :last-of-type and
                // square off the end of the bar.
                ...(index === 0
                  ? { borderTopLeftRadius: '6px', borderBottomLeftRadius: '6px' }
                  : {}),
                ...(index === drawn.length - 1
                  ? { borderTopRightRadius: '6px', borderBottomRightRadius: '6px' }
                  : {}),
                transition:
                  'width 600ms cubic-bezier(.22,1,.36,1), background-color 220ms ease',
                ...(segment.highlightOnHover && hovered === segment.key
                  ? { backgroundColor: alpha(theme.palette.primary.main, 0.1) }
                  : {}),
                // The highlight is the other bands easing back a little, done
                // by veiling them WITH THE TRACK rather than by making them
                // transparent: 0.65 opacity would now reveal the neighbour
                // underneath in the overlap instead of the track. Same pixels
                // as before everywhere else - 0.65 of the band over 0.35 of the
                // track is exactly what the old opacity produced.
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: METER_TRACK,
                  opacity: dimmed(segment.key) ? 0.35 : 0,
                  transition: 'opacity 220ms ease',
                  pointerEvents: 'none',
                },
              })}
            />
          </MeterTooltip>
        ))}
        {marking ? (
          // What this request would touch, drawn over the bands rather than
          // carved out of them: the bar keeps saying what the balance IS while
          // the dashes say what a booking would take from it. It starts at the
          // left edge because available and the accrual it waits for are the
          // two leading bands, and those are exactly what a request draws on.
          <MeterTooltip title={marking.title}>
            <Box
              onMouseEnter={() => setHovered(AFFECTED_KEY)}
              onMouseLeave={() => setHovered(null)}
              sx={(theme) => ({
                ...affectedSx(theme),
                left: 0,
                // Above the bands, which are positioned now: without this the
                // dashed outline would be painted under them and disappear.
                zIndex: 2,
                width: widthOf(marking.coveredDays),
                transition:
                  'width 600ms cubic-bezier(.22,1,.36,1), opacity 220ms ease, background-color 220ms ease',
                opacity: dimmed(AFFECTED_KEY) ? 0.65 : 1,
                ...(hovered === AFFECTED_KEY
                  ? { backgroundColor: alpha(theme.palette.primary.main, 0.14) }
                  : {}),
              })}
            />
          </MeterTooltip>
        ) : null}
      </Box>
      {/* One chip per band, from the same list the bar is drawn from.
          Zero-value entries hide (their block is not in the bar either); only
          "available" always shows, since a zero there is the message. The
          aria-label above still spells out every figure. */}
      <Stack direction="row" spacing={1.75} rowGap={0.5} flexWrap="wrap" useFlexGap>
        {segments
          .filter(
            (segment) =>
              !segment.hideFromLegend &&
              (segment.value > 0 || segment.alwaysInLegend),
          )
          .map((segment) => (
            <MeterLegend
              key={segment.key}
              fill={segment.fill}
              days={segment.value}
              prefix={segment.prefix}
              label={segment.label}
              title={segment.title}
              dimmed={dimmed(segment.key)}
              onHoverChange={(on) => setHovered(on ? segment.key : null)}
            />
          ))}
        {marking ? (
          <MeterLegend
            fill={() => 'transparent'}
            marking
            days={marking.days}
            label="this request affects"
            title={marking.title}
            dimmed={dimmed(AFFECTED_KEY)}
            onHoverChange={(on) => setHovered(on ? AFFECTED_KEY : null)}
          />
        ) : null}
      </Stack>
    </Stack>
  )
}

export function BalanceMeter({
  balance,
  previewDays = 0,
  variant = 'meter',
}: {
  balance: LeaveBalanceDto
  previewDays?: number
  /**
   * 'meter' (default): compact head with the accrued-of-total note - the
   * composer's side rail. 'tile' (prototype .bal-tile): the balance page's
   * summary tile with the big bookable headline instead.
   */
  variant?: 'meter' | 'tile'
}) {
  // Bookable, not the DTO's availableDays: held days sit in their own band, so
  // counting them as available too would paint them twice (bookableDaysOf).
  const available = bookableDaysOf(balance)
  const onHold = Math.max(balance.onHoldDays, 0)
  const spent = Math.max(balance.spentDays, 0)
  const preview = Math.max(previewDays, 0)
  // The DTO's accruedDays and availableDays already contain the carryover
  // (the carryover_in ledger row seeds the year's counter), while totalDays
  // is the annual entitlement alone. The year's whole pool is their sum, and
  // "accrued" in any note here means earned from the entitlement, with the
  // carryover named separately (accruedSplitOf).
  const carryover = Math.max(balance.carriedOverDays ?? 0, 0)
  const poolDays = roundDays(balance.totalDays + carryover)
  const earnedAccrued = accruedSplitOf(balance).earnedDays
  // Nothing arrives on this bar: the accrual a request waits for belongs to the
  // per-year bars, which know which year it lands in. Kept in the arithmetic at
  // zero so the shared shape below stays one expression.
  const arriving = 0
  const draw = requestDraw({
    availableNow: available,
    arrivingByThen: arriving,
    requestedDays: preview,
  })

  // The whole track IS the year's pool - the annual total plus last year's
  // carryover: every band is a slice of it and nothing is drawn outside. The
  // bands describe the balance as it STANDS - the request is marked over them
  // rather than carved out of them, so the reader sees what they have and
  // what a booking would touch at once.
  //
  // Unpaid days are the exception, and the only one: they are days of the
  // leave that no allowance covers, so they extend the bar past the year's
  // total rather than taking a slice of it. The denominator stretches to fit
  // them, which is exactly the picture - the request runs off the end.
  const denominator = Math.max(
    poolDays,
    spent + onHold + available + arriving + draw.unpaid,
    1,
  )

  const name = formatLeaveType(balance.leaveType)
  const carryoverNote = carriedOverFromLastYearSuffix(balance.carriedOverDays)
  // Days of the year's pool the balance does not hold: for vacation what the
  // year has yet to accrue, for sick the share a mid-year joiner never earns.
  // Zero for anyone employed the whole year. accruedDays already counts the
  // carryover, so it is measured against the pool, never the bare total.
  const unaccrued = Math.max(poolDays - balance.accruedDays, 0)
  // The tail: allowance that will not have accrued even by the leave.
  const rest = Math.max(
    denominator - spent - onHold - available - arriving - draw.unpaid,
    0,
  )

  // ONE description per band, feeding both the bar and the legend below it.
  // Two lists would drift, and a chip explaining itself differently from the
  // block it points at is worse than no explanation at all.
  const segments: MeterSegment[] = [
    {
      key: 'available',
      value: available,
      alwaysInLegend: true,
      label: 'available',
      fill: (theme: Theme) => solidFill(theme.palette.primary.main),
      title:
        'Accrued and not committed to anything. The days you could book today.',
    },
    {
      key: 'arriving',
      value: arriving,
      label: 'by the leave dates',
      prefix: '+',
      fill: arrivingFill,
      title: `Not accrued yet. These days build up month by month between now and the leave, and are all in your balance by the time it starts, which is what lets this request fit when today's balance alone would not cover it.`,
    },
    {
      key: 'unpaid',
      value: draw.unpaid,
      label: 'unpaid',
      fill: unpaidFill,
      title:
        'Days of this request that fall past everything the year will have accrued by then. They can still be taken, they simply are not paid: nothing is held for them and nothing is spent.',
    },
    {
      key: 'hold',
      value: onHold,
      label: 'on hold',
      fill: (theme: Theme) => solidFill(theme.palette.warning.main),
      title:
        'Reserved by leave already submitted: requests awaiting a decision, and approved leave you have not taken yet.',
    },
    {
      key: 'spent',
      value: spent,
      label: 'spent',
      fill: () => solidFill(METER_SPENT),
      title: 'Leave you have already taken. Counted day by day as each one passes.',
    },
    {
      key: 'rest',
      value: rest,
      label: 'still to accrue',
      hideFromLegend: true,
      tail: true,
      fill: () => 'none',
      highlightOnHover: true,
      title: restExplanation({
        rest,
        totalDays: denominator,
        spent,
        onHold,
        requested: preview,
      }),
    },
  ]

  // What the marking encloses. Ordinarily the days the request draws on; once
  // any of it is unpaid, the leading bands are exhausted by definition, so the
  // marking runs over available AND arriving AND the unpaid band beyond them,
  // which is the whole leave in one enclosed stretch.
  const markedDays =
    draw.unpaid > 0 ? roundDays(available + arriving + draw.unpaid) : draw.covered

  const ariaLabel =
    `${name}: ${formatDays(available)} available, ${formatDays(onHold)} on hold, ${formatDays(spent)} spent` +
    (arriving > 0 ? `, ${formatDays(arriving)} arriving by the leave dates` : '') +
    // Through the shared formatter like every other figure in this label: a
    // bare decimal is the one notation the app never shows anyone, and a
    // screen reader would announce "0.5" where the bar beside it says "4h".
    (preview > 0 ? `, ${formatDays(preview)} affected by this request` : '') +
    (draw.unpaid > 0 ? `, ${formatDays(draw.unpaid)} of them unpaid` : '') +
    (rest > 0 ? `, ${formatDays(rest)} still to accrue` : '')

  return (
    <MeterBar
      name={name}
      note={
        // Tiles hide the accrued-of-total note (the legend already says
        // available); they still name last year's leftover, which the bar
        // does not. Compact meters always show the full allocation note.
        variant === 'tile' && !carryoverNote
          ? undefined
          : unaccrued > 0
            ? `${formatDays(earnedAccrued)} of ${formatDays(balance.totalDays)} accrued${carryoverNote}`
            : `${formatDays(balance.totalDays)} total${carryoverNote}`
      }
      variant={variant}
      segments={segments}
      denominator={denominator}
      marking={
        preview > 0
          ? {
              days: preview,
              coveredDays: markedDays,
              title: affectedExplanation(draw, preview, ''),
            }
          : null
      }
      ariaLabel={ariaLabel}
      testId={`balance-meter-${balance.leaveType}`}
    />
  )
}

// The carryover band. Hatched like the arriving days rather than solid,
// because it is the same kind of quantity: promised, not yet in hand.
const carryFill = (theme: Theme) => hatchFill(theme.palette.secondary.main)

// A side of the window narrower than one day would be invisible; a year with
// nothing at all gets this fixed sliver instead of vanishing.
const EMPTY_SIDE_FLEX = 0.14

// One side of the funding window, precomputed so the ribbon, the caps and the
// legend all read the same numbers.
type WindowSide = {
  funding: YearFunding
  /** The side's span in days: its pool plus the unpaid days running past it. */
  sideDays: number
  empty: boolean
  flex: number
}

/**
 * The request funding window: ONE ribbon for the request being composed, split
 * by a labeled seam at each New Year boundary. Each side's flex weight is its
 * days (pool + unpaid), so widths are day-proportional ACROSS the whole
 * window, and unpaid days run past their side's funded pool as an overflow
 * band. This is a view of the REQUEST, not of the year: the year's own
 * total/spent/holds stay on the balance meters above.
 *
 * Renders under renderToString: every width is data, nothing is measured.
 */
export function RequestFundingWindow({
  leaveType,
  years,
}: {
  leaveType: LeaveType
  years: YearFunding[]
}) {
  const sides: WindowSide[] = years.map((funding) => {
    const sideDays = roundDays(funding.poolDays + funding.unpaidDays)
    const empty = sideDays <= 0
    return { funding, sideDays, empty, flex: empty ? EMPTY_SIDE_FLEX : sideDays }
  })
  const hasSeam = sides.length > 1

  // Same chip-to-band hover linkage as the meter, keys namespaced per year:
  // pointing at "available" in 2026 must not dim 2027's bands.
  const [hovered, setHovered] = useState<string | null>(null)
  const dimmed = (key: string) => hovered !== null && hovered !== key

  if (sides.length === 0) {
    return null
  }

  return (
    // The same container the balance meters wear: this block now stands in a
    // meter's slot, and a frameless ribbon next to a framed bar would read as
    // a different kind of thing rather than the same balance while composing.
    <Stack
      spacing={1.1}
      sx={{
        p: 1.75,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '14px',
      }}
      data-testid={`funding-window-${leaveType}`}
    >
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
          {formatLeaveType(leaveType)}
        </Typography>
        <Typography
          sx={{ fontSize: 12.5, fontWeight: 600, color: 'text.secondary' }}
        >
          where these days come from
        </Typography>
      </Stack>
      {/* Caps: NATURAL width, pinned to the edges. Deliberately NOT the bar's
          flex geometry: a collapsed side must never push its caption into the
          neighbour's. */}
      <Stack
        direction="row"
        justifyContent="space-between"
        flexWrap="wrap"
        useFlexGap
        sx={{ columnGap: 1.75, rowGap: 0.25 }}
      >
        {sides.map(({ funding }, index) => (
          <Typography
            key={funding.year}
            data-testid={`funding-cap-${funding.year}`}
            sx={{
              flex: 'none',
              fontSize: 12,
              fontWeight: 600,
              color: 'text.secondary',
              whiteSpace: 'nowrap',
              ...(index === sides.length - 1 && index > 0
                ? { textAlign: 'right' }
                : {}),
            }}
          >
            {!funding.touched && funding.future && funding.holdsBookedLeave ? (
              <>
                {hasSeam ? `${funding.year} holds ` : 'Holds '}
                <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
                  {formatDays(funding.onHoldDays + funding.spentDays)}
                </Box>
                {' already booked'}
              </>
            ) : (
              <>
                {hasSeam ? `${funding.year} pays for ` : 'Pays for '}
                <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
                  {formatDays(funding.paidDays)}
                </Box>
                {funding.unpaidDays > 0 ? (
                  <Box component="span" sx={{ color: UNPAID_ACCENT, fontWeight: 700 }}>
                    {`, ${formatDays(funding.unpaidDays)} unpaid`}
                  </Box>
                ) : null}
                {!funding.touched && funding.carryOutDays > 0
                  ? `, feeds ${formatDays(funding.carryOutDays)} carryover`
                  : null}
              </>
            )}
          </Typography>
        ))}
      </Stack>

      {/* The ribbon. pb reserves room for the seam label hanging below it. */}
      <Box
        role="img"
        aria-label={windowAriaLabel(leaveType, sides)}
        sx={{ display: 'flex', alignItems: 'stretch', pb: hasSeam ? '20px' : 0 }}
      >
        {sides.map((side, index) => (
          <Fragment key={side.funding.year}>
            {index > 0 ? (
              <Box aria-hidden="true" sx={{ flex: 'none', width: 16, position: 'relative' }}>
                <Box
                  sx={{
                    position: 'absolute',
                    left: '50%',
                    top: -4,
                    bottom: -4,
                    borderLeft: '2px dashed',
                    borderColor: 'text.disabled',
                  }}
                />
                <Typography
                  sx={{
                    position: 'absolute',
                    top: 'calc(100% + 7px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: 'text.secondary',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {`1 Jan ${side.funding.year}`}
                </Typography>
              </Box>
            ) : null}
            <FundingWindowSide
              side={side}
              setHovered={setHovered}
              dimmed={dimmed}
            />
          </Fragment>
        ))}
      </Box>

      {/* Legend: one wrapping row, grouped by year with muted year labels. */}
      <Stack
        direction="row"
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ columnGap: 1.75, rowGap: 0.5 }}
      >
        {sides.map(({ funding }, index) => (
          <Fragment key={funding.year}>
            {index > 0 ? (
              <Box sx={{ width: '1px', height: 14, bgcolor: 'divider' }} />
            ) : null}
            {hasSeam ? (
              <Typography
                sx={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  color: 'text.disabled',
                }}
              >
                {funding.year}
              </Typography>
            ) : null}
            {windowChips(funding).map((chip) => (
              <MeterLegend
                key={`${funding.year}:${chip.key}`}
                fill={chip.fill}
                days={chip.days}
                prefix={chip.prefix}
                label={chip.label}
                title={chip.title}
                marking={chip.marking}
                dimmed={dimmed(`${funding.year}:${chip.key}`)}
                onHoverChange={(on) =>
                  setHovered(on ? `${funding.year}:${chip.key}` : null)
                }
              />
            ))}
          </Fragment>
        ))}
      </Stack>
    </Stack>
  )
}

// One side of the ribbon: the funded pool as a track of bands, unpaid days
// overflowing past it, the dashed request outline over both.
function FundingWindowSide({
  side,
  setHovered,
  dimmed,
}: {
  side: WindowSide
  setHovered: (key: string | null) => void
  dimmed: (key: string) => boolean
}) {
  const { funding, sideDays, empty } = side
  const year = funding.year
  const bands = [
    {
      key: 'carry',
      value: funding.carryInDays,
      fill: carryFill,
      title: `Days ${year - 1} is projected to hand over once it closes. They open ${year}'s balance, on top of what it accrues itself.`,
    },
    {
      key: 'available',
      value: funding.availableNow,
      fill: (theme: Theme) => solidFill(theme.palette.primary.main),
      title:
        'Accrued and not committed to anything. The days you could book today.',
    },
    {
      key: 'arriving',
      value: funding.arrivingNetDays,
      fill: arrivingFill,
      title: describeArriving(funding),
    },
  ].filter((band) => band.value > 0)

  const draw = requestDraw({
    availableNow: funding.carryInDays + funding.availableNow,
    arrivingByThen: funding.arrivingNetDays,
    requestedDays: funding.requestedDays,
    unpaidDays: funding.unpaidDays,
  })

  if (empty) {
    return (
      <MeterTooltip
        title={`Nothing free in ${year}: every accrued day is already spent or committed to leave you have booked.`}
      >
        <Box
          data-testid={`funding-side-${year}`}
          sx={{
            flex: `${side.flex} 1 0`,
            height: 12,
            borderRadius: '6px',
            bgcolor: METER_TRACK,
            cursor: 'help',
          }}
        />
      </MeterTooltip>
    )
  }

  return (
    <Box
      data-testid={`funding-side-${year}`}
      sx={{
        position: 'relative',
        display: 'flex',
        height: 12,
        minWidth: 0,
        flex: `${side.flex} 1 0`,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          height: 12,
          borderRadius: '6px',
          bgcolor: METER_TRACK,
          width: `${(funding.poolDays / sideDays) * 100}%`,
        }}
      >
        {bands.map((band, index) => (
          <MeterTooltip key={band.key} title={band.title}>
            <Box
              onMouseEnter={() => setHovered(`${year}:${band.key}`)}
              onMouseLeave={() => setHovered(null)}
              sx={(theme) => ({
                flex: 'none',
                position: 'relative',
                zIndex: 1,
                // Same seam-blend idiom as the balance meter: each band after
                // the first reaches back over its neighbour and fades in, its
                // width grown by exactly what the margin takes away.
                ...(index === 0
                  ? { width: `${(band.value / funding.poolDays) * 100}%` }
                  : {
                      width: `calc(${(band.value / funding.poolDays) * 100}% + ${SEAM_BLEND}px)`,
                      marginLeft: `-${SEAM_BLEND}px`,
                      maskImage: SEAM_MASK,
                      WebkitMaskImage: SEAM_MASK,
                    }),
                backgroundColor: METER_TRACK,
                backgroundImage: band.fill(theme),
                cursor: 'help',
                ...(index === 0
                  ? { borderTopLeftRadius: '6px', borderBottomLeftRadius: '6px' }
                  : {}),
                ...(index === bands.length - 1
                  ? { borderTopRightRadius: '6px', borderBottomRightRadius: '6px' }
                  : {}),
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: METER_TRACK,
                  opacity: dimmed(`${year}:${band.key}`) ? 0.35 : 0,
                  transition: 'opacity 220ms ease',
                  pointerEvents: 'none',
                },
              })}
            />
          </MeterTooltip>
        ))}
      </Box>
      {funding.unpaidDays > 0 ? (
        <MeterTooltip title="Days of this request that fall past everything the year will have accrued by then. They can still be taken, they simply are not paid: nothing is held for them and nothing is spent.">
          <Box
            onMouseEnter={() => setHovered(`${year}:unpaid`)}
            onMouseLeave={() => setHovered(null)}
            sx={{
              flex: 'none',
              marginLeft: '2px',
              borderRadius: '0 6px 6px 0',
              width: `${(funding.unpaidDays / sideDays) * 100}%`,
              backgroundColor: METER_TRACK,
              backgroundImage: unpaidFill(),
              cursor: 'help',
            }}
          />
        </MeterTooltip>
      ) : null}
      {funding.touched ? (
        <MeterTooltip title={affectedExplanation(draw, funding.requestedDays, '')}>
          <Box
            onMouseEnter={() => setHovered(`${year}:affected`)}
            onMouseLeave={() => setHovered(null)}
            sx={(theme) => ({
              ...affectedSx(theme),
              left: 0,
              zIndex: 2,
              // What the request OCCUPIES on this side, not how many days it
              // asks for: the funded stretch it can draw on here (bounded by
              // the pool) plus the unpaid band beyond it. The server can fund
              // more days than this side's pool shows, because commitments
              // that fall AFTER the leave do not compete with it for accrual,
              // and an unclamped width would then run the outline off the bar.
              width: `${(Math.min(funding.paidDays, funding.poolDays) + funding.unpaidDays) / sideDays * 100}%`,
              opacity: dimmed(`${year}:affected`) ? 0.65 : 1,
            })}
          />
        </MeterTooltip>
      ) : null}
    </Box>
  )
}

// The chips under the window, one list per year, wordings inherited from the
// per-year meter so the vocabulary stays one.
function windowChips(funding: YearFunding): {
  key: string
  days: number
  prefix?: string
  label: string
  title: string
  fill: (theme: Theme) => string
  marking?: boolean
}[] {
  const year = funding.year
  const draw = requestDraw({
    availableNow: funding.carryInDays + funding.availableNow,
    arrivingByThen: funding.arrivingNetDays,
    requestedDays: funding.requestedDays,
    unpaidDays: funding.unpaidDays,
  })
  const chips: ReturnType<typeof windowChips> = []
  if (funding.future) {
    chips.push({
      key: 'carry',
      days: funding.carryInDays,
      prefix: '+',
      label: `carried over from ${year - 1}`,
      title: `Days ${year - 1} is projected to hand over once it closes.`,
      fill: carryFill,
    })
    if (funding.arrivingNetDays > 0 || funding.touched || funding.deficitDays > 0) {
      chips.push({
        key: 'arriving',
        days: funding.arrivingNetDays,
        prefix: '+',
        label: funding.touched ? 'accrues by the leave' : `accrues in ${year}`,
        title: describeArriving(funding),
        fill: arrivingFill,
      })
    }
    if (!funding.touched && funding.holdsBookedLeave) {
      chips.push({
        key: 'booked',
        days: funding.onHoldDays + funding.spentDays,
        label: 'already booked',
        title: `Leave already approved or pending in ${year}. Carryover from ${year - 1} is reserved to fund it, which is why leftover days this year cannot all be taken.`,
        fill: (theme: Theme) => solidFill(theme.palette.warning.main),
      })
    }
  } else {
    chips.push({
      key: 'available',
      days: funding.availableNow,
      label: 'available now',
      title:
        'Accrued and not committed to anything. The days you could book today.',
      fill: (theme: Theme) => solidFill(theme.palette.primary.main),
    })
    // Only when something actually arrives, or when a deficit makes the zero
    // the answer rather than an absence. The plain balance meter already drops
    // a zero chip (its legend filters on value), and a chip reading "+0d" costs
    // a slot in the same row as the figures that do say something.
    if (funding.arrivingNetDays > 0 || funding.deficitDays > 0) {
      chips.push({
        key: 'arriving',
        days: funding.arrivingNetDays,
        prefix: '+',
        label: funding.touched
          ? funding.deficitDays > 0
            ? 'free by the leave dates'
            : 'by the leave dates'
          : 'by the year end',
        title: describeArriving(funding),
        fill: arrivingFill,
      })
    }
    if (funding.fundsBookedCarryover && funding.leftoverAtYearEnd > 0) {
      chips.push({
        key: 'reserved',
        days: funding.leftoverAtYearEnd,
        label: `reserved to fund ${year + 1}`,
        title: `${formatDays(funding.leftoverAtYearEnd)} stays unused this year so ${formatDays(funding.carryOutDays)} can carry over to leave already booked in ${year + 1}.`,
        fill: carryFill,
      })
    }
  }
  if (funding.touched) {
    chips.push({
      key: 'affected',
      days: funding.requestedDays,
      label: 'this request',
      title: affectedExplanation(draw, funding.requestedDays, ''),
      fill: () => 'transparent',
      marking: true,
    })
  }
  if (funding.unpaidDays > 0) {
    chips.push({
      key: 'unpaid',
      days: funding.unpaidDays,
      label: 'unpaid',
      title:
        'Days of this request that fall past everything the year will have accrued by then. A working day is paid in full or unpaid in full, so leftover hours cannot cover part of a longer day.',
      fill: unpaidFill,
    })
  }
  return chips
}

// Every figure the ribbon draws, in words, for a reader who cannot see it.
function windowAriaLabel(leaveType: LeaveType, sides: WindowSide[]): string {
  const named = sides.length > 1
  const parts = sides.map(({ funding, empty }) => {
    if (!funding.touched && funding.future && funding.holdsBookedLeave) {
      return `${funding.year} holds ${formatDays(funding.onHoldDays + funding.spentDays)} already booked`
    }
    if (empty) {
      return `${funding.year} has nothing left to fund this request`
    }
    return (
      `${named ? `${funding.year} pays` : 'Pays'} for ${formatDays(funding.paidDays)}` +
      (funding.unpaidDays > 0
        ? `, ${formatDays(funding.unpaidDays)} of them unpaid`
        : '') +
      (!funding.touched && funding.carryOutDays > 0
        ? `, feeds ${formatDays(funding.carryOutDays)} of carryover`
        : '')
    )
  })
  return `${formatLeaveType(leaveType)} funding window: ${parts.join('; ')}`
}

// The receipt's dots ARE the meter's bands: the same fill functions, not copies
// of their colours, so a band recoloured above recolours its row below.
const SWATCH_FILL: Record<ReceiptSwatch, (theme: Theme) => string> = {
  available: (theme: Theme) => solidFill(theme.palette.primary.main),
  arriving: arrivingFill,
  carry: carryFill,
  unpaid: unpaidFill,
}

/**
 * What the request costs, as a ledger: one section per leave year, each adding
 * up from what the year holds to what it hands on. Entirely dumb, because every
 * string, figure and tone is decided by buildRequestReceipt.
 */
export function RequestReceipt({ receipt }: { receipt: RequestReceiptModel }) {
  if (receipt.kind === 'pending') {
    // Holds the rail's height so the column does not jump on every keystroke.
    return (
      <Stack spacing={0.75} aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} variant="rounded" height={19} />
        ))}
      </Stack>
    )
  }
  if (receipt.kind !== 'receipt') {
    return (
      <Typography sx={{ fontSize: 13, color: 'text.secondary', lineHeight: 1.55 }}>
        {receipt.message}
      </Typography>
    )
  }

  return (
    <Stack spacing={0} data-testid="request-receipt">
      <Stack
        spacing={0}
        // One edit behind: the rows still describe the dates the server
        // answered for, and the verdict says so, so nothing on screen
        // contradicts anything else.
        {...(receipt.stale ? { 'aria-busy': 'true' } : {})}
        sx={{
          opacity: receipt.stale ? 0.55 : 1,
          transition: 'opacity 220ms ease',
        }}
      >
        {receipt.sections.map((section) => (
          <Box key={section.year} data-testid={`receipt-year-${section.year}`} sx={{ mt: 1.6 }}>
            <Typography
              component="h3"
              sx={{
                fontSize: 11.5,
                fontWeight: 800,
                letterSpacing: '0.02em',
                color: 'text.secondary',
                pb: 0.75,
                borderBottom: '1px solid',
                borderColor: 'rgba(16, 24, 40, 0.14)',
              }}
            >
              {section.heading}
            </Typography>
            {section.rows.map((row) => (
              <Box key={row.key}>
                {row.ruleAbove ? (
                  <Box sx={{ borderTop: '1px solid', borderColor: 'divider', my: '3px' }} />
                ) : null}
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{ py: '5px' }}
                >
                  <Box
                    sx={(theme) => ({
                      width: 9,
                      height: 9,
                      borderRadius: '3px',
                      flexShrink: 0,
                      backgroundColor: row.swatch ? METER_TRACK : 'transparent',
                      backgroundImage: row.swatch
                        ? SWATCH_FILL[row.swatch](theme)
                        : 'none',
                    })}
                  />
                  <Typography
                    sx={{
                      flex: 1,
                      fontSize: 12.5,
                      fontWeight: row.tone === 'sum' ? 800 : 600,
                      color:
                        row.tone === 'sum'
                          ? 'text.primary'
                          : row.tone === 'muted'
                            ? 'text.disabled'
                            : 'text.secondary',
                    }}
                  >
                    {row.label}
                  </Typography>
                  <ExactDaysHover days={row.rawDays} title={row.title}>
                  <Typography
                    sx={{
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 12.5,
                      fontWeight: 800,
                      whiteSpace: 'nowrap',
                      cursor:
                        row.title ||
                        (row.rawDays !== undefined && exactBookableTooltip(row.rawDays))
                          ? 'help'
                          : undefined,
                      color:
                        row.tone === 'unpaid'
                          ? UNPAID_ACCENT
                          : row.tone === 'muted'
                            ? 'text.disabled'
                            : 'text.primary',
                    }}
                  >
                    {row.value}
                  </Typography>
                  </ExactDaysHover>
                </Stack>
                {row.finePrint ? (
                  <Typography
                    sx={{
                      fontSize: 11,
                      color: 'text.disabled',
                      lineHeight: 1.45,
                      pl: '17px',
                      mt: '-3px',
                      mb: '3px',
                    }}
                  >
                    {row.finePrint}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Box>
        ))}
      </Stack>
      <Box
        data-testid="receipt-verdict"
        sx={(theme) => ({
          mt: 1.6,
          borderRadius: '10px',
          py: '8px',
          px: 1.5,
          fontSize: 12.5,
          fontWeight: 800,
          textAlign: 'center',
          ...verdictTone(theme, receipt.verdict.tone),
        })}
      >
        {receipt.verdict.label}
      </Box>
    </Stack>
  )
}

function verdictTone(theme: Theme, tone: ReceiptVerdict['tone']) {
  if (tone === 'paid') {
    return {
      backgroundColor: alpha(theme.palette.success.main, 0.12),
      color: theme.palette.success.dark,
    }
  }
  if (tone === 'partial') {
    return {
      backgroundColor: alpha(theme.palette.warning.main, 0.14),
      color: theme.palette.warning.dark,
    }
  }
  if (tone === 'unpaid') {
    return {
      backgroundColor: alpha(UNPAID_ACCENT, 0.1),
      color: UNPAID_ACCENT,
    }
  }
  return {
    backgroundColor: 'rgba(16, 24, 40, 0.05)',
    color: theme.palette.text.disabled,
  }
}

// The shared hover for a meter band: the same wording whether the reader
// points at the block in the bar or at its chip below.
function MeterTooltip({ title, children }: { title: string; children: ReactElement }) {
  return (
    <Tooltip
      arrow
      enterTouchDelay={0}
      leaveTouchDelay={4000}
      title={<Box sx={{ py: 0.25, maxWidth: 280, lineHeight: 1.5 }}>{title}</Box>}
    >
      {children}
    </Tooltip>
  )
}

function ExactDaysHover({
  days,
  title,
  children,
}: {
  days?: number
  title?: string
  children: ReactElement
}) {
  const exact = days !== undefined ? exactBookableTooltip(days) : undefined
  const hover = [title, exact].filter(Boolean).join(' ')
  if (!hover) {
    return children
  }
  return <MeterTooltip title={hover}>{children}</MeterTooltip>
}

function MeterLegend({
  fill,
  days,
  label,
  prefix = '',
  title,
  marking = false,
  dimmed = false,
  onHoverChange,
}: {
  fill: (theme: Theme) => string
  days: number
  label: string
  /** Sign before the figure, for a band that adds rather than stands. */
  prefix?: string
  title?: string
  /**
   * The chip for the dashed marking rather than for a band: same swatch size
   * as its neighbours, but dashed and tinted like the marking on the bar.
   */
  marking?: boolean
  dimmed?: boolean
  onHoverChange?: (hovered: boolean) => void
}) {
  const chip = (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      sx={{
        cursor: title || exactBookableTooltip(days) ? 'help' : undefined,
        opacity: dimmed ? 0.72 : 1,
        transition: 'opacity 220ms ease',
      }}
    >
      <Box
        sx={(theme) => ({
          width: 9,
          height: 9,
          borderRadius: '3px',
          flexShrink: 0,
          background: fill(theme),
          ...(marking
            ? {
                borderRadius: '4px',
                border: `1.5px dashed ${alpha(theme.palette.primary.dark, 0.75)}`,
                backgroundColor: alpha(theme.palette.primary.main, 0.07),
              }
            : {}),
        })}
      />
      <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary' }}>
        <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
          {prefix}
          {formatDays(days)}
        </Box>{' '}
        {label}
      </Typography>
    </Stack>
  )
  return title || exactBookableTooltip(days) ? (
    <ExactDaysHover days={days} title={title}>
      {chip}
    </ExactDaysHover>
  ) : (
    chip
  )
}

// ————— Approver routing / activity / balance impact —————
// Shared by the employee request-detail page and the approval review page:
// their right column and balance-impact card are identical, so the rendering
// lives here once and both pages wrap it in their own SectionCards.

// Deterministic avatar color for an approver row: a stable hash over a small
// warm/cool palette so the same person is always the same color.
const AVATAR_COLORS = ['#155eef', '#0f766e', '#7c3aed', '#b42318', '#b45309', '#0891b2', '#475467']

export function avatarColor(email: string): string {
  let hash = 0
  for (const char of email) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

export function initialsOfRecipient(email: string, displayName?: string): string {
  const source = displayName?.trim() || email
  // A domain names the mail server, not the person, so it never contributes a
  // letter. Everything before the "@" is what is left of a person in an
  // address — whether it arrives as the fallback address or as a display name
  // that is itself one.
  const named = source.includes('@') ? (source.split('@')[0] ?? '') : source
  const words = named.split(/[\s._-]+/).filter(Boolean)
  // Spread iterates code points, so an astral-plane first character keeps its
  // full surrogate pair instead of splitting into garbage.
  const first = [...(words[0] ?? '')][0] ?? '?'
  const second = [...(words[1] ?? '')][0] ?? ''
  return `${first}${second}`.toUpperCase()
}

export function ApproverAvatar({
  email,
  displayName,
  size = 30,
}: {
  email: string
  displayName?: string
  size?: number
}) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontSize: 11,
        fontWeight: 800,
        bgcolor: avatarColor(email),
      }}
      aria-hidden
    >
      {initialsOfRecipient(email, displayName)}
    </Box>
  )
}

// The primary-approver rows (avatar + email + decision line + status pill) and
// the CC "notified only" chips. Pass the WHOLE approver list; it splits by kind.
export function ApproverRoutingList({
  approvers,
}: {
  approvers: LeaveRequestApprovalRecipientDto[]
}) {
  const toApprovers = approvers.filter((recipient) => recipient.kind === ApproverKind.To)
  const ccRecipients = approvers.filter((recipient) => recipient.kind === ApproverKind.Cc)
  return (
    <>
      {/* A request nobody had to decide is a normal state now (approval
          optional, addressed to no one), and it can still carry cc rows below.
          Without this the card rendered an empty box under its heading. */}
      {toApprovers.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: '#667085', lineHeight: 1.55 }}>
          No approvers were asked to decide this request.
        </Typography>
      ) : null}
      <Stack spacing={1}>
        {toApprovers.map((recipient) => (
          <Stack
            key={recipient.email}
            direction="row"
            spacing={1.25}
            alignItems="center"
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '11px',
              p: '9px 12px',
            }}
            data-testid={`routing-${recipient.email}`}
          >
            <ApproverAvatar email={recipient.email} displayName={recipient.displayName} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography
                noWrap
                title={recipient.displayName}
                sx={{ fontSize: 12.5, fontWeight: 700 }}
              >
                {recipient.email}
              </Typography>
              <Typography sx={{ fontSize: 11, color: '#98a2b3', fontWeight: 600 }}>
                {/* The API always sends a decision (Pending until someone
                    acts) - only real verdicts get a label. */}
                {recipient.decision && recipient.decision !== ApproverDecision.Pending
                  ? `${formatStatus(recipient.decision)}${
                      recipient.decidedAt ? ` · ${formatDateTime(recipient.decidedAt)}` : ''
                    }`
                  : 'awaiting decision'}
              </Typography>
            </Box>
            <StatusPill status={recipient.decision ?? LeaveRequestStatus.Pending} />
          </Stack>
        ))}
      </Stack>
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
            CC · notified only
          </Typography>
          <FoldingChips
            items={ccRecipients.map((recipient) => ({
              label: recipient.email,
              title: recipient.displayName,
            }))}
          />
        </Box>
      ) : null}
    </>
  )
}

export function RequestActivityList({ activity }: { activity: LeaveRequestActivityDto[] }) {
  return (
    <Stack spacing={0.875}>
      {activity.map((entry, index) => (
        <Stack
          key={`${entry.occurredAt}-${index}`}
          direction="row"
          spacing={1}
          sx={{ fontSize: 12.5, fontWeight: 500, color: '#667085' }}
        >
          <Box component="span" sx={{ minWidth: 0 }}>
            <Box component="b" sx={{ color: 'text.secondary', fontWeight: 700 }}>
              {entry.actorDisplayName}
            </Box>{' '}
            · {entry.action}
            {entry.comment ? <> · “{entry.comment}”</> : null}
          </Box>
          <Box
            component="span"
            sx={{
              ml: 'auto',
              flexShrink: 0,
              color: '#98a2b3',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatDateTime(entry.occurredAt)}
          </Box>
        </Stack>
      ))}
    </Stack>
  )
}

// The ledger arrives whole (user+leaveType); the latest entry is the current
// balance snapshot for this leave type.
export function latestBalanceOf(
  timeline: readonly LeaveBalanceChangeDto[],
): LeaveBalanceChangeDto | null {
  let latest: LeaveBalanceChangeDto | null = null
  for (const entry of timeline) {
    if (!latest || entry.effectiveDate >= latest.effectiveDate) {
      latest = entry
    }
  }
  return latest
}

/**
 * The balance as this request left it: the snapshot carried by the LAST ledger
 * row the request itself wrote.
 *
 * A request page is a piece of history, so the running figures belong to that
 * history rather than to today — and "today" was doubly wrong here. The
 * timeline is the whole user's, and picking its newest-dated row could land on
 * a monthly accrual dated after the leave days were spent, which is how an
 * approved and fully taken request came to report "0d spent". Since the server
 * files movements in the order they happened, the row this finds carries the
 * balance as it stood when the request last moved it: a June leave shows the
 * June figures, not what a later August accrual made of them.
 *
 * Rows are matched by the request id the domain writes into every note it
 * posts for a request (hold, spend, release).
 */
export function balanceAfterRequest(
  timeline: readonly LeaveBalanceChangeDto[],
  requestId: string,
): LeaveBalanceChangeDto | null {
  let last: LeaveBalanceChangeDto | null = null
  for (const entry of timeline) {
    if (entry.note?.includes(requestId)) {
      last = entry
    }
  }
  return last
}

// This request's balance movements, in the order they happened.
//
// The domain holds a request's paid days on submit, spends them one at a time
// as each leave date passes, and releases whatever is left if the request is
// rejected or cancelled. This used to be inferred from the STATUS alone, which
// made an approved request read "placed on hold" forever — including for leave
// lived through months ago, which is every row the data import writes. The
// figures now come from the request itself: `heldDays` is what is still
// reserved, so the difference is what has been taken.
export type ImpactRow = {
  // hold: reserved and still returnable · spent: gone from the balance ·
  // plus: given back · none: no movement at all.
  tone: 'hold' | 'spent' | 'plus' | 'none'
  title: string
  delta: string
  sub: string
}

export function impactRowsFor(request: LeaveRequestDetailDto): ImpactRow[] {
  // Only the paid days ever move the balance, so every figure here is the paid
  // count. The unpaid days get a row of their own, stating that they move
  // nothing, rather than being silently missing from a card that claims to
  // account for the whole request.
  const days = formatDays(request.paidDays)
  const type = formatLeaveType(request.leaveType).toLowerCase()
  const unpaid: ImpactRow[] =
    request.unpaidDays > 0
      ? [
          {
            tone: 'none',
            title: 'Unpaid days',
            delta: formatDays(request.unpaidDays),
            sub: `${type} · beyond what the balance covers · never held, never spent`,
          },
        ]
      : []
  // A request the balance never funded has no movements at all to show.
  if (request.paidDays <= 0) {
    return unpaid
  }

  // The movements this request actually posted, read from the ledger rather
  // than inferred: the domain stamps the request id into every row it writes,
  // so a card can report what happened instead of what the status implies. An
  // approved request used to read "placed on hold" forever, which is wrong for
  // any leave already lived through — and that is every row the import writes.
  const own = request.balanceTimeline.filter((entry) =>
    entry.note?.includes(request.requestId),
  )
  const sumOf = (reason: LeaveBalanceChangeReason): number =>
    own
      .filter((entry) => entry.reason === reason)
      .reduce((total, entry) => total + Math.abs(entry.deltaDays), 0)
  const spentDates = own
    .filter((entry) => entry.reason === LeaveBalanceChangeReason.Spent)
    .map((entry) => entry.effectiveDate)
    .sort()

  const held: ImpactRow = {
    tone: 'hold',
    title: 'Placed on hold',
    delta: `−${days}`,
    sub: `${formatDayMonthLocal(request.submittedAt)} · ${type} · held while approvers decide`,
  }
  const releasedLabel =
    request.status === LeaveRequestStatus.Rejected
      ? 'request rejected'
      : request.status === LeaveRequestStatus.Cancelled
        ? 'request cancelled'
        : 'replaced by a later request'

  const consumedFromLedger = sumOf(LeaveBalanceChangeReason.Spent)
  const releasedFromLedger = sumOf(LeaveBalanceChangeReason.Release)
  // Fall back to the request's own figures when the ledger is not to hand (an
  // older server sends no per-row notes, and heldDays may be absent too).
  const stillHeld = request.heldDays ?? request.paidDays
  const consumed =
    own.length > 0 ? consumedFromLedger : Math.max(0, request.paidDays - stillHeld)
  const released =
    own.length > 0
      ? releasedFromLedger
      : request.status === LeaveRequestStatus.Rejected ||
          request.status === LeaveRequestStatus.Cancelled ||
          request.status === LeaveRequestStatus.Superseded
        ? stillHeld
        : 0
  const outstanding = Math.max(0, request.paidDays - consumed - released)

  // Each day is spent at the midnight that ends it, so the row names the span
  // rather than pretending one stroke took them all.
  const span =
    spentDates.length > 1
      ? ` · day by day, ${formatDayMonthLocal(spentDates[0]!)} to ${formatDayMonthLocal(spentDates[spentDates.length - 1]!)}`
      : spentDates.length === 1
        ? ` · on ${formatDayMonthLocal(spentDates[0]!)}`
        : ''

  const consumedRow: ImpactRow[] =
    consumed > 0
      ? [
          {
            tone: 'spent',
            title: 'Consumed as leave taken',
            delta: `−${formatDays(consumed)}`,
            sub:
              outstanding > 0
                ? `${type}${span} · ${formatDays(outstanding)} still held for the dates ahead`
                : `${type} · one day at a time${span}`,
          },
        ]
      : []
  const releasedRow: ImpactRow[] =
    released > 0
      ? [
          {
            tone: 'plus',
            title: 'Released back to available',
            delta: `+${formatDays(released)}`,
            sub: `${request.decidedAt ? `${formatDayMonthLocal(request.decidedAt)} · ` : ''}${type} · ${releasedLabel}`,
          },
        ]
      : []

  if (consumed <= 0 && released <= 0) {
    return [
      {
        ...held,
        sub:
          request.status === LeaveRequestStatus.Pending
            ? `${formatDayMonthLocal(request.submittedAt)} · ${type} · released if rejected or cancelled`
            : `${formatDayMonthLocal(request.submittedAt)} · ${type} · spends on the leave dates`,
      },
      ...unpaid,
    ]
  }
  return [held, ...consumedRow, ...releasedRow, ...unpaid]
}

function impactNoteFor(request: LeaveRequestDetailDto): string {
  if (request.paidDays <= 0) {
    return 'None of these days are charged to the balance: the whole request is unpaid.'
  }
  const tail =
    request.unpaidDays > 0
      ? ` The ${formatDays(request.unpaidDays)} unpaid never touch the balance.`
      : ''
  switch (request.status) {
    case LeaveRequestStatus.Pending:
      return `The held days are released back to available if the request is rejected or cancelled.${tail}`
    case LeaveRequestStatus.Approved:
      return `The held days spend from the balance on the leave dates.${tail}`
    default:
      return `Net effect on the balance is zero: the hold was released.${tail}`
  }
}

// The balance-impact card body: the status-derived movement rows, the current
// snapshot line (bookable available, matching the dashboard tiles), and the
// explanatory note.
/**
 * WHICH dates of a request are short, and by how much (prototype .cd-badge
 * spelled out in words). The DTO froze the portions and nothing rendered them,
 * so an approver could see that a week cost four and a half days without ever
 * seeing which afternoon was the half.
 *
 * Renders NOTHING for an ordinary whole-day request: no empty row, no "0h". The
 * amount goes through the same day notation as every other figure on the page,
 * so "4h" here is the same "4h" the summary line above it counts.
 */
export function PartDayShape({
  dayPortions,
}: {
  dayPortions?: Record<string, number>
}) {
  const entries = partDayEntries(dayPortions)
  if (entries.length === 0) {
    return null
  }
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      flexWrap="wrap"
      rowGap={0.5}
      data-testid="part-day-shape"
    >
      <Typography
        sx={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#98a2b3',
          flexShrink: 0,
        }}
      >
        {entries.length === 1 ? 'Part day' : 'Part days'}
      </Typography>
      {entries.map(({ date, portion }) => (
        <Typography key={date} sx={{ fontSize: 12.5, fontWeight: 600 }}>
          {formatWeekdayDayMonth(date)} · {formatDays(portion)}
        </Typography>
      ))}
    </Stack>
  )
}

export function BalanceImpactRows({ request }: { request: LeaveRequestDetailDto }) {
  const latestBalance = balanceAfterRequest(
    request.balanceTimeline,
    request.requestId,
  )
  return (
    <>
      <Stack>
        {impactRowsFor(request).map((row) => (
          <Stack
            key={row.title}
            direction="row"
            spacing={1.5}
            alignItems="flex-start"
            sx={{
              py: 1.25,
              '& + &': { borderTop: '1px solid', borderColor: 'divider' },
            }}
          >
            <Box
              sx={(theme) => ({
                width: 30,
                height: 30,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                ...(row.tone === 'plus'
                  ? {
                      bgcolor: alpha(theme.palette.success.main, 0.1),
                      color: theme.palette.success.main,
                    }
                  : row.tone === 'spent'
                    ? {
                        // Settled, not pending: the neutral tint of a movement
                        // that is over, rather than the warning tint of one
                        // still waiting to resolve.
                        bgcolor: alpha(theme.palette.text.primary, 0.08),
                        color: theme.palette.text.primary,
                      }
                  : row.tone === 'none'
                    ? {
                        // A row that reports no movement is drawn as one: the
                        // warning tint would claim the balance did something.
                        bgcolor: alpha(theme.palette.text.primary, 0.06),
                        color: theme.palette.text.secondary,
                      }
                    : {
                        bgcolor: alpha(theme.palette.warning.main, 0.1),
                        color: theme.palette.warning.main,
                      }),
              })}
              aria-hidden
            >
              {row.tone === 'plus' ? (
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
                </svg>
              ) : row.tone === 'spent' ? (
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
                  <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : row.tone === 'none' ? (
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
                  <path d="M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
                </svg>
              ) : (
                <ClockGlyph size={13} />
              )}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{row.title}</Typography>
                <Typography
                  sx={{
                    ml: 'auto',
                    fontSize: 13,
                    fontWeight: 800,
                    fontVariantNumeric: 'tabular-nums',
                    color: row.tone === 'plus' ? 'success.main' : 'text.secondary',
                  }}
                >
                  {row.delta}
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 11.5, color: '#98a2b3', fontWeight: 500 }}>
                {row.sub}
              </Typography>
            </Box>
          </Stack>
        ))}
      </Stack>
      {latestBalance ? (
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          {/* Available = bookable (net of holds), matching the dashboard
              tiles - see bookableDaysOf. */}
          {formatLeaveType(request.leaveType)} balance after this request:{' '}
          {formatDays(bookableDaysOf(latestBalance))} available ·{' '}
          {formatDays(latestBalance.onHoldDays)} on hold ·{' '}
          {formatDays(latestBalance.spentDays)} spent.
        </Typography>
      ) : null}
      <Box
        sx={{
          border: '1px dashed rgba(16, 24, 40, 0.14)',
          borderRadius: '11px',
          p: '11px 13px',
          fontSize: 12.5,
          fontWeight: 500,
          color: '#667085',
        }}
      >
        {impactNoteFor(request)}
      </Box>
    </>
  )
}

// Prototype .r-ic tints and glyphs per movement type.
const REASON_VISUALS: Record<
  LeaveBalanceChangeReason,
  { icon: ReactNode; bg: (alphaFn: typeof alpha) => string; color: string }
> = {
  [LeaveBalanceChangeReason.Accrual]: {
    icon: <PlusGlyph size={15} />,
    bg: () => 'rgba(21, 128, 61, 0.1)',
    color: '#15803d',
  },
  [LeaveBalanceChangeReason.Hold]: {
    icon: <ClockGlyph size={15} />,
    bg: (alphaFn) => alphaFn('#d97706', 0.1),
    color: '#d97706',
  },
  [LeaveBalanceChangeReason.Release]: {
    icon: <UndoGlyph size={15} />,
    bg: () => 'rgba(21, 94, 239, 0.08)',
    color: '#155eef',
  },
  [LeaveBalanceChangeReason.Spent]: {
    icon: <CheckGlyph size={15} />,
    bg: () => 'rgba(16, 24, 40, 0.06)',
    color: '#667085',
  },
  [LeaveBalanceChangeReason.Adjustment]: {
    icon: <SlidersGlyph size={15} />,
    bg: () => 'rgba(15, 118, 110, 0.1)',
    color: '#0f766e',
  },
  // Year close. In arrives (accrual green), out departs into the next year
  // (neutral, it is a transfer, not a loss), expired is the loss — the amber
  // the hold shares, since both mean "days you cannot book right now".
  [LeaveBalanceChangeReason.CarryoverIn]: {
    icon: <ArrowGlyph size={14} />,
    bg: () => 'rgba(21, 128, 61, 0.1)',
    color: '#15803d',
  },
  [LeaveBalanceChangeReason.CarryoverOut]: {
    icon: <ArrowGlyph size={14} />,
    bg: () => 'rgba(16, 24, 40, 0.06)',
    color: '#667085',
  },
  [LeaveBalanceChangeReason.Expired]: {
    icon: <ClockGlyph size={15} />,
    bg: (alphaFn) => alphaFn('#d97706', 0.1),
    color: '#d97706',
  },
}

// One ledger row (prototype .row): reason icon tile, title line with the
// leave-type chip, optional note, and the delta / after / date column.
// Lives here (not on the employee page) so the admin zone — which must stay
// free of the employee Redux store — can render the same ledger.
// Responsive grid: from sm up the delta, audit triple, and date form a
// right-aligned column; below sm only the delta stays beside the title while
// the triple and date drop to a full-width line under the content, so the
// title, chips, and note keep the whole row width on narrow screens.
export function LedgerRow({ entry }: { entry: LeaveBalanceChangeDto }) {
  const visuals = REASON_VISUALS[entry.reason]
  // Reason-derived, not the raw DTO sign: the server emits magnitudes for
  // everything but adjustments (see signedDeltaDays).
  const signed = signedDeltaDays(entry)
  const afterBookable = entry.availableDays - entry.onHoldDays
  const beforeBookable = afterBookable - signed
  const deltaLabel = formatCompleteHoursDelta(afterBookable, beforeBookable)
  const positive = !deltaLabel.startsWith('−') && deltaLabel.startsWith('+')
  // The audit triple, shown inline (not a tooltip): the running BOOKABLE
  // available (net of holds, matching the dashboard tiles) beside the raw
  // hold and spent components. Complete hours only — leftover minutes are
  // not a bookable hour — so the monthly delta is the step between these
  // running totals (January +2d, February +2d 1h) rather than each twelfth
  // independently rounded to +2d 1h.
  const statValue = (value: number) => formatDays(value)
  const availBookable = statValue(entry.availableDays - entry.onHoldDays)
  const onHoldValue = statValue(entry.onHoldDays)
  const spentValue = statValue(entry.spentDays)
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '34px minmax(0, 1fr) auto',
        gridTemplateAreas: {
          xs: '"icon content delta" "icon meta meta"',
          sm: '"icon content delta" "icon content meta"',
        },
        columnGap: 1.6,
        rowGap: { xs: 1, sm: '4px' },
        py: 1.5,
        px: 0.5,
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box
        sx={{
          gridArea: 'icon',
          width: 34,
          height: 34,
          mt: '1px',
          borderRadius: '10px',
          display: 'grid',
          placeItems: 'center',
          bgcolor: visuals.bg(alpha),
          color: visuals.color,
        }}
        aria-hidden
      >
        {visuals.icon}
      </Box>
      <Box sx={{ gridArea: 'content', minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
            {formatBalanceReason(entry.reason)}
          </Typography>
          <Typography
            component="span"
            sx={{
              fontSize: 11,
              fontWeight: 700,
              px: 1,
              py: '2px',
              borderRadius: '7px',
              border: '1px solid',
              borderColor: 'divider',
              color: 'text.secondary',
            }}
          >
            {formatLeaveType(entry.leaveType)}
          </Typography>
          {entry.reason === LeaveBalanceChangeReason.Adjustment ? (
            <Typography
              component="span"
              sx={{
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: '#0f766e',
                bgcolor: 'rgba(15, 118, 110, 0.1)',
                borderRadius: '7px',
                px: 0.9,
                py: '2px',
              }}
            >
              Adjustment
            </Typography>
          ) : null}
        </Stack>
        {entry.note ? (
          <Typography
            sx={{ mt: '3px', fontSize: 12.5, color: 'text.secondary', lineHeight: 1.45 }}
          >
            {entry.note}
          </Typography>
        ) : null}
      </Box>
      <Box sx={{ gridArea: 'delta', textAlign: 'right' }}>
      <ExactDaysHover days={signed}>
      <Typography
        sx={{
          fontSize: 15,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          cursor: exactBookableTooltip(signed) ? 'help' : undefined,
          // Proto: a minus movement is normal bookkeeping, not a warning.
          color: positive ? 'success.main' : 'text.secondary',
        }}
      >
        {deltaLabel}
      </Typography>
      </ExactDaysHover>
      </Box>
      <Box
        sx={{
          gridArea: 'meta',
          display: 'flex',
          flexDirection: { xs: 'row', sm: 'column' },
          // The triple and the date are both nowrap and cannot shrink; on
          // narrow phones the pair can exceed the row, so let the date wrap
          // to its own line instead of clipping at the card edge.
          flexWrap: { xs: 'wrap', sm: 'nowrap' },
          justifyContent: { xs: 'space-between', sm: 'flex-start' },
          alignItems: { xs: 'baseline', sm: 'flex-end' },
          gap: { xs: 0.75, sm: '4px' },
        }}
      >
        {/* The audit triple, always visible: available (bookable) / hold /
            spent after this movement. */}
        <Box
          sx={{
            display: 'flex',
            gap: 0.75,
            alignItems: 'baseline',
            fontSize: 11,
            fontWeight: 600,
            color: '#98a2b3',
            whiteSpace: 'nowrap',
          }}
        >
          <Box component="span">
            <ExactDaysHover days={entry.availableDays - entry.onHoldDays}>
            <Box component="b" sx={{ color: 'text.secondary', fontWeight: 800, cursor: exactBookableTooltip(entry.availableDays - entry.onHoldDays) ? 'help' : undefined }}>
              {availBookable}
            </Box>
            </ExactDaysHover>{' '}
            avail
          </Box>
          <Box component="span" sx={{ color: 'rgba(16, 24, 40, 0.2)' }}>·</Box>
          <Box component="span">
            <Box component="b" sx={{ color: 'text.secondary', fontWeight: 800 }}>
              {onHoldValue}
            </Box>{' '}
            hold
          </Box>
          <Box component="span" sx={{ color: 'rgba(16, 24, 40, 0.2)' }}>·</Box>
          <Box component="span">
            <Box component="b" sx={{ color: 'text.secondary', fontWeight: 800 }}>
              {spentValue}
            </Box>{' '}
            spent
          </Box>
        </Box>
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: '#98a2b3', whiteSpace: 'nowrap' }}>
          {formatDayMonth(entry.effectiveDate)}
        </Typography>
      </Box>
    </Box>
  )
}

// ————— Composer availability —————

/**
 * What stands in the way of the period being picked, and what taking it would
 * cost that the balance does not cover.
 *
 * The ordinary positive case is not a message: it is the projected bar in the
 * balance rail, which says the same thing quantitatively. What is left here is
 * the refusal and the unpaid notice, both beside the calendar because that is
 * the input they are about. Renders the server's own sentences verbatim: the
 * composer must never paraphrase a rule it does not own.
 *
 * The unpaid notice is NOT a refusal. Days beyond the balance can be taken;
 * they are simply not paid, and the submit button stays live under it.
 *
 * Fails open. A preview that could not load simply disappears, because the
 * submission itself is still checked server-side; blocking on a failed
 * advisory call would be worse than not showing it.
 */
export function AvailabilityNotices({
  status,
  preview,
}: {
  status: 'idle' | 'loading' | 'succeeded' | 'failed'
  preview?: LeaveAvailabilityPreviewDto
}) {
  if (status === 'loading') {
    return <PreviewLoading />
  }
  if (status !== 'succeeded' || !preview) {
    return null
  }
  if (!preview.feasible) {
    return (
      <DecisionBanner tone="bad">
        {/* One line per blocker, in the server's order (most blocking
            first); the banner's own type scale carries them. */}
        <Stack spacing={0.5} data-testid="availability-blocked">
          {preview.blockers.map((blocker, blockerIndex) => (
            <Box key={`${blocker.code}-${blockerIndex}`}>
              <Box>{blocker.message}</Box>
              {blocker.overlappingRequests?.length ? (
                <Stack
                  component="ul"
                  spacing={0.25}
                  sx={{ m: 0, pl: 2.5, mt: 0.25 }}
                  data-testid="availability-overlap-details"
                >
                  {blocker.overlappingRequests.map((request) => (
                    <Box component="li" key={`${request.startDate}-${request.endDate}-${request.status}`}>
                      {formatDateRange(request.startDate, request.endDate)} (
                      {formatStatus(request.status)})
                    </Box>
                  ))}
                </Stack>
              ) : null}
            </Box>
          ))}
        </Stack>
      </DecisionBanner>
    )
  }
  if (!preview.unpaidNotice) {
    return null
  }
  return (
    <DecisionBanner tone="info">
      <Box data-testid="availability-unpaid">{preview.unpaidNotice}</Box>
    </DecisionBanner>
  )
}

// The muted strip holds the panel's place while the server is asked, so the
// composer does not jump each time one verdict replaces another.
function PreviewLoading() {
  return (
    <DecisionBanner tone="muted">
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={13} aria-hidden />
        <Box component="span">Checking availability for these dates</Box>
      </Stack>
    </DecisionBanner>
  )
}

// Month names for the projected bar and its outlook strip, UTC-pinned like
// every calendar date in the app so a viewer behind UTC never reads the label
// of the month before.
function monthLabel(leaveYear: number, month: number): string {
  return new Date(Date.UTC(leaveYear, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  })
}
