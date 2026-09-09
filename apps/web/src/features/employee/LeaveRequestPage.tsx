/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useSearchParams } from 'react-router-dom'
import {
  ApproverKind,
  EmployeeProfileStatus,
  LeaveRequestStatus,
  LeaveType,
  type CreateLeaveRequestDto,
  type DefaultRecipientDto,
  type LeaveAvailabilityPreviewDto,
  type LeaveBalanceDto,
  type LeaveRequestDetailDto,
} from '@workspace/contracts'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  InlineRangeCalendar,
  chargeableDates,
  costOfDates,
} from '../../components/date-picker'
import { UserMultiSelect, excludeEmails } from '../../components/user-select'
import { useHolidayDates, useHolidayNames } from '../holidays/use-holiday-dates'
import { buildYearMeters, chargeableDaysByYear } from './leave-year-model'
import { buildRequestReceipt } from './request-receipt'
import {
  bookableDaysOf,
  calendarNoticeFor,
  canModifyRequest,
  daysToWholeHours,
  floorDays,
  formatDayMonth,
  formatDays,
  formatRelativeTime,
  horizonNoticeFor,
  roundDays,
  spansYears,
  workdayHoursOf,
  yearFromIso,
} from '../../lib/leave-format'
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  RELATIVE_TIME_TICK_MS,
  useAutoRefresh,
  useNowTick,
} from '../../lib/use-auto-refresh'
import {
  EmployeeFeatureProvider,
  employeeFeatureActions,
  useEmployeeFeatureDispatch,
  useEmployeeFeatureSelector,
} from './employee-feature.store'
import {
  ArrowGlyph,
  AvailabilityNotices,
  BalanceMeter,
  RequestFundingWindow,
  RequestReceipt,
  BarsGlyph,
  CheckGlyph,
  DecisionBanner,
  EmployeePageFrame,
  ErrorSection,
  HeartGlyph,
  HolidayCalendarMissingState,
  LoadingSection,
  PlusGlyph,
  ProfilePendingState,
  PulseGlyph,
  SectionCard,
  SegmentedControl,
  SunriseGlyph,
  formatDate,
  formatDateTime,
  formatLeaveType,
} from './employee-ui'

type LeaveRequestFormState = {
  leaveType: LeaveType
  startDate: string
  endDate: string
  comment: string
  approverEmails: string[]
  ccEmails: string[]
}

const INITIAL_FORM: LeaveRequestFormState = {
  leaveType: LeaveType.Vacation,
  startDate: '',
  endDate: '',
  comment: '',
  approverEmails: [],
  ccEmails: [],
}

// How long the success banner stays before dismissing itself.
const SUCCESS_BANNER_DISMISS_MS = 5_000
// The leave animation before the banner unmounts.
const SUCCESS_BANNER_LEAVE_MS = 300

// Icon-ring geometry (prototype variant 2): the progress circle's
// circumference drives the dash offset.
const SUCCESS_RING_RADIUS = 11
const SUCCESS_RING_LENGTH = 2 * Math.PI * SUCCESS_RING_RADIUS

/**
 * The submit success banner with the user-picked "icon ring" timer: the check
 * icon sits inside a circular ring that depletes over the dismiss window,
 * then the banner fades out and `onDone` unmounts it. Hovering pauses the
 * clock (a quiet "paused" tag appears) so the copy can be read at leisure.
 *
 * The ring is driven imperatively (strokeDashoffset on the circle) from a
 * requestAnimationFrame loop - no per-frame re-render, and the paused flag
 * lives in a ref for the same reason. Effects never run under renderToString,
 * so tests see the banner statically at its start state.
 */
function AutoDismissSuccessAlert({
  onDone,
  testId,
  children,
}: {
  onDone: () => void
  testId?: string
  children: ReactNode
}) {
  const [leaving, setLeaving] = useState(false)
  const ringRef = useRef<SVGCircleElement>(null)
  const pausedRef = useRef(false)
  // The latest onDone without restarting the timer when the parent re-renders
  // with a fresh closure.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    let elapsed = 0
    let last: number | null = null
    let raf = 0
    let doneTimer: ReturnType<typeof setTimeout> | undefined

    const frame = (now: number) => {
      if (last !== null && !pausedRef.current) {
        elapsed += now - last
      }
      last = now
      const fraction = Math.min(elapsed / SUCCESS_BANNER_DISMISS_MS, 1)
      if (ringRef.current) {
        ringRef.current.style.strokeDashoffset = `${SUCCESS_RING_LENGTH * fraction}`
      }
      if (fraction >= 1) {
        setLeaving(true)
        doneTimer = setTimeout(() => onDoneRef.current(), SUCCESS_BANNER_LEAVE_MS)
        return
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      if (doneTimer !== undefined) {
        clearTimeout(doneTimer)
      }
    }
  }, [])

  return (
    <Alert
      severity="success"
      data-testid={testId}
      onMouseEnter={() => {
        pausedRef.current = true
      }}
      onMouseLeave={() => {
        pausedRef.current = false
      }}
      icon={
        <Box
          sx={{
            position: 'relative',
            width: 26,
            height: 26,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
          }}
          aria-hidden
        >
          {/* rotate(-90deg) starts the depletion at 12 o'clock. */}
          <Box
            component="svg"
            viewBox="0 0 26 26"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              transform: 'rotate(-90deg)',
            }}
          >
            <circle
              cx={13}
              cy={13}
              r={SUCCESS_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              opacity={0.35}
            />
            <circle
              ref={ringRef}
              cx={13}
              cy={13}
              r={SUCCESS_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              style={{ strokeDasharray: SUCCESS_RING_LENGTH }}
            />
          </Box>
          <CheckGlyph size={12} />
        </Box>
      }
      sx={{
        position: 'relative',
        opacity: leaving ? 0 : 1,
        transform: leaving ? 'translateY(-6px)' : 'none',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        '&:hover .success-paused-tag': { opacity: 0.55 },
      }}
    >
      {children}
      <Box
        component="span"
        className="success-paused-tag"
        sx={{
          position: 'absolute',
          top: 8,
          right: 10,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'success.main',
          opacity: 0,
          transition: 'opacity 0.15s ease',
          pointerEvents: 'none',
        }}
      >
        paused
      </Box>
    </Alert>
  )
}

const recipientEmailsOf = (recipients: DefaultRecipientDto[]): string[] =>
  recipients.map((recipient) => recipient.email)

// What picking each type means for the balance, mirrored from the accrual
// rules balanceExplanation spells out in full (vacation accrues 1/12 monthly;
// sick is credited up front, prorated for a mid-year joiner).
const TYPE_HINTS: Record<LeaveType, string> = {
  [LeaveType.Vacation]: 'Vacation spends your vacation balance (accrues monthly).',
  [LeaveType.Sick]: 'Sick leave spends the sick balance (credited up front).',
}

// Exported for unit tests: the submit gate accepts a settings default as the
// required approver, not only a manual pick. When the org made approval
// optional there is nothing to require: the server folds in no deciding
// default and approves an unaddressed request on the spot, so the form must
// let it through rather than demand somebody first.
export function hasRequiredApprover(
  chosenApproverEmails: string[],
  defaultApprovers: DefaultRecipientDto[],
  approvalRequired: boolean,
): boolean {
  if (!approvalRequired) {
    return true
  }
  return chosenApproverEmails.length > 0 || defaultApprovers.length > 0
}

// Exported for unit tests: drop draft picks that a refreshed context promoted
// into the locked defaults. Preserves array identity when nothing changes so
// the state setter can bail out without a render.
export function pruneLockedEmails(
  emails: string[],
  locked: ReadonlySet<string>,
): string[] {
  const pruned = emails.filter((email) => !locked.has(email))
  return pruned.length === emails.length ? emails : pruned
}

// Exported for unit tests: the form as it should open when changing an
// existing approved leave. The approvers of the original are carried over so
// the same people are asked again, minus any that policy now locks in anyway.
export function buildModifyPrefill(
  original: LeaveRequestDetailDto,
  defaultApprovers: DefaultRecipientDto[],
  defaultCc: DefaultRecipientDto[],
): LeaveRequestFormState {
  // Asymmetric, like the pickers. An approver of the original survives being
  // in the CC defaults (they can still be the decider); pooling both sets
  // dropped them, and with approval optional dropping the last one silently
  // turned a change to a human-approved leave into an automatic approval.
  const lockedApprovers = new Set(recipientEmailsOf(defaultApprovers))
  const lockedForCc = new Set([
    ...recipientEmailsOf(defaultApprovers),
    ...recipientEmailsOf(defaultCc),
  ])
  const emailsOfKind = (kind: ApproverKind): string[] => {
    const locked = kind === ApproverKind.To ? lockedApprovers : lockedForCc
    return original.approvers
      .filter((approver) => approver.kind === kind)
      .map((approver) => approver.email)
      .filter((email) => !locked.has(email))
  }
  return {
    leaveType: original.leaveType,
    startDate: original.startDate,
    endDate: original.endDate,
    comment: original.comment ?? '',
    approverEmails: emailsOfKind(ApproverKind.To),
    ccEmails: emailsOfKind(ApproverKind.Cc),
  }
}

/**
 * The hours the editor opens on when changing an approved leave.
 *
 * The original stores FROZEN PORTIONS, and they are converted through the
 * CURRENT workday length, because the replacement will be priced with the
 * current one: half a day booked when a day was eight hours prefills as four
 * hours, and as three and a half if the org has since moved to a seven-hour
 * day. That last figure is not bookable, so the conversion is the server's own
 * inverse (dayPortionToHours: round to the nearest whole hour) and the result is
 * then clamped into 1..hoursPerDay. Rounding rather than flooring keeps the
 * editor showing the same hours the request's own detail page does, and the
 * clamp is what guarantees the form can be submitted at all: a portion that
 * lands on zero hours would otherwise wedge it against a server that refuses
 * anything under an hour.
 *
 * A portion that rounds to a whole day is simply left out: the map carries
 * shortened dates only, exactly like the payload it becomes.
 */
export function buildModifyHoursPrefill(
  dayPortions: Record<string, number> | undefined,
  hoursPerDay: number,
): Record<string, number> {
  const hoursByDate: Record<string, number> = {}
  for (const [date, portion] of Object.entries(dayPortions ?? {})) {
    const hours = Math.min(
      Math.max(daysToWholeHours(portion, hoursPerDay), 1),
      hoursPerDay,
    )
    if (hours < hoursPerDay) {
      hoursByDate[date] = hours
    }
  }
  return hoursByDate
}

/**
 * The hours state after a change of range, calendar or workday length, pure for
 * unit tests.
 *
 * Two jobs, both of which the server would otherwise refuse the submission for:
 * a date that is no longer a working day of the period loses its entry, and an
 * hour count that no longer fits the workday is clamped into it. Preserves the
 * object identity when nothing changes, so the reducer can hand back the very
 * same state and the effect that prunes after every range edit cannot loop.
 */
export function pruneHoursByDate(
  hoursByDate: Readonly<Record<string, number>>,
  dates: readonly string[],
  hoursPerDay: number,
): Record<string, number> {
  const chargeable = new Set(dates)
  const pruned: Record<string, number> = {}
  let changed = false
  for (const [date, hours] of Object.entries(hoursByDate)) {
    if (!chargeable.has(date)) {
      changed = true
      continue
    }
    const clamped = Math.min(Math.max(Math.round(hours), 1), hoursPerDay)
    if (clamped !== hours) {
      changed = true
    }
    // A date the clamp pushed back up to a whole day is not a part day any
    // more, and the map only ever carries the shortened ones.
    if (clamped < hoursPerDay) {
      pruned[date] = clamped
    }
  }
  return changed ? pruned : (hoursByDate as Record<string, number>)
}

/**
 * The `hoursByDate` a submission (and the preview that has to predict it)
 * carries: the shortened dates of the current selection, or nothing at all.
 *
 * Whole days are never named. An ordinary request then goes over the wire
 * exactly as it always did, which is also how it is stored: an empty portions
 * column is what every request booked before leave had hours carries.
 */
export function hoursPayloadFor(
  dates: readonly string[],
  hoursByDate: Readonly<Record<string, number>>,
  hoursPerDay: number,
): Record<string, number> | undefined {
  const payload: Record<string, number> = {}
  for (const date of dates) {
    const hours = hoursByDate[date]
    if (hours !== undefined && hours < hoursPerDay) {
      payload[date] = hours
    }
  }
  return Object.keys(payload).length > 0 ? payload : undefined
}

// Whether two hour maps book the same shape. The modification gate needs it:
// same dates and same comment is no longer the same request if a day of it has
// been shortened.
export function sameHoursByDate(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): boolean {
  const a = left ?? {}
  const b = right ?? {}
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  )
}

/** The per-day hours editor: whether it is open, and the dates it shortened. */
export type PartialDaysState = {
  open: boolean
  /** Shortened dates only. A date it does not name is a full working day. */
  hoursByDate: Record<string, number>
}

export type PartialDaysAction =
  /** The switch. Off resets every date to a full day - see the reducer. */
  | { kind: 'toggled'; open: boolean }
  | { kind: 'hours-set'; date: string; hours: number; hoursPerDay: number }
  /** The range, the calendar or the workday moved under the current hours. */
  | { kind: 'pruned'; dates: readonly string[]; hoursPerDay: number }
  /** Opening a change to an approved leave, from its frozen portions. */
  | { kind: 'prefilled'; dayPortions?: Record<string, number>; hoursPerDay: number }
  /** A submitted draft: the hours belonged to dates that are now filed. */
  | { kind: 'cleared' }

export const INITIAL_PARTIAL_DAYS: PartialDaysState = {
  open: false,
  hoursByDate: {},
}

/**
 * Every transition of the composer's part-day state, in one pure place.
 *
 * Two invariants hold across all of them, and both are what the server would
 * otherwise refuse the submission for: the map names only dates the current
 * range actually charges, and only hours strictly between one and a full day.
 *
 * Identity is preserved whenever nothing changes, so the pruning that follows
 * every range edit cannot loop.
 */
export function partialDaysReducer(
  state: PartialDaysState,
  action: PartialDaysAction,
): PartialDaysState {
  switch (action.kind) {
    case 'toggled':
      // Off means whole days again, for every date at once. Keeping the hours
      // would leave a closed editor quietly pricing the request, and the
      // switch is the only way back to whole days once one is shortened.
      return action.open
        ? { ...state, open: true }
        : { open: false, hoursByDate: {} }
    case 'hours-set': {
      const clamped = Math.min(
        Math.max(Math.round(action.hours), 1),
        action.hoursPerDay,
      )
      const hoursByDate = { ...state.hoursByDate }
      if (clamped >= action.hoursPerDay) {
        // Back to a whole day, which the map does not carry.
        delete hoursByDate[action.date]
      } else {
        hoursByDate[action.date] = clamped
      }
      return { ...state, hoursByDate }
    }
    case 'pruned': {
      // Nothing chargeable left to shorten - Clear, or a range of weekends
      // only. The editor closes and forgets its hours rather than hanging open
      // with no rows above a switch the calendar has just disabled, which is a
      // panel the employee can neither use nor put away.
      if (action.dates.length === 0) {
        return state.open || Object.keys(state.hoursByDate).length > 0
          ? INITIAL_PARTIAL_DAYS
          : state
      }
      const hoursByDate = pruneHoursByDate(
        state.hoursByDate,
        action.dates,
        action.hoursPerDay,
      )
      return hoursByDate === state.hoursByDate ? state : { ...state, hoursByDate }
    }
    case 'prefilled': {
      const hoursByDate = buildModifyHoursPrefill(
        action.dayPortions,
        action.hoursPerDay,
      )
      // Opened along with the hours it holds: a closed editor would leave the
      // employee submitting part days they cannot see.
      return { open: Object.keys(hoursByDate).length > 0, hoursByDate }
    }
    case 'cleared':
    default:
      return INITIAL_PARTIAL_DAYS
  }
}

/**
 * The submit-row note (prototype #submit-note), pure for unit tests. One
 * message at a time, ordered by what the employee should resolve first; every
 * blocking condition here is also a `canSubmit` gate, so the note always
 * explains the disabled button rather than contradicting it. The optional
 * flags carry the ways a CHANGE to an approved leave can be not ready, which
 * a new request has no equivalent of.
 */
export function submitNoteFor(input: {
  hasApprover: boolean
  // True when this submission will be approved by the system the moment it is
  // sent: the org made approval optional and nobody is addressed to decide it.
  // Not a blocker, so it refines the ready note rather than replacing it.
  willAutoApprove?: boolean
  hasDates: boolean
  chargeableDays: number
  pickedYearMissing: boolean
  // The range runs into a later year whose calendar is not configured yet.
  endYearMissing?: boolean
  beyondHorizon?: boolean
  availabilityBlocked?: boolean
  unchangedModification?: boolean
  awaitingOriginal?: boolean
  originalUnavailable?: boolean
  // Days the balance will not cover. Not a blocker: the last word beside a
  // live button, so nobody submits unpaid leave without having been told.
  unpaidDays?: number
  // First payable day, when the range reaches into the requester's probation
  // period. Present only alongside unpaid days it explains, so it refines that
  // note rather than adding one of its own.
  probationEnd?: string
}): string {
  // Nothing on the form means anything before the leave being changed is on
  // screen, so these outrank every other message. The failed case is checked
  // first: once the fetch has given up, "loading" is no longer true, and a
  // note that waits forever would leave the disabled button unexplained.
  if (input.originalUnavailable) {
    return 'The leave you are changing could not be loaded.'
  }
  if (input.awaitingOriginal) {
    return 'Loading the leave you are changing.'
  }
  if (!input.hasApprover) {
    return 'At least one approver is required before submission.'
  }
  if (!input.hasDates) {
    return 'Pick the leave date(s) to continue.'
  }
  if (input.chargeableDays === 0) {
    return 'The selected range contains no working days.'
  }
  if (input.pickedYearMissing) {
    return 'The selected year has no holiday calendar yet.'
  }
  if (input.endYearMissing) {
    return 'The selected range runs into a year with no holiday calendar yet.'
  }
  if (input.beyondHorizon) {
    return 'Leave can be planned for this year and next year only.'
  }
  if (input.availabilityBlocked) {
    // Running past the balance no longer blocks anything, so this branch is
    // only ever the other refusals, which the notice above spells out.
    return 'These dates cannot be booked; the notice above says why.'
  }
  if (input.unchangedModification) {
    // The hours are named because they are a change in their own right: moving
    // hours between the same dates keeping the same total is a different
    // absence, and a note offering only "the dates or the comment" would read
    // as a refusal to consider it.
    return 'Change the dates, the hours or the comment to propose something different.'
  }
  // What is left are the refinements of a live button, and they COMPOSE: the
  // unpaid warning used to return early, which hid the automatic approval on
  // exactly the requests that carry both.
  const notes = ['Ready to submit.']
  if (input.unpaidDays && input.unpaidDays > 0) {
    notes.push(`${formatDays(input.unpaidDays)} of this request will be unpaid.`)
    // Probation is the reason WHY, and it has an end date the balance note
    // cannot give: naming it turns "unpaid" from a verdict into a schedule.
    if (input.probationEnd) {
      notes.push(`Paid leave starts ${formatDate(input.probationEnd)}.`)
    }
  }
  if (input.willAutoApprove) {
    notes.push('No approvers are required; this request will be approved automatically.')
  }
  return notes.join(' ')
}

// Whether a server verdict prices the same shape the form now holds. Both
// figures are quantized to the books' three decimals, so this is an equality
// check with room for the last bit of float only.
export function sameCost(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.0005
}

export type RequestImpact =
  | { kind: 'empty' }
  | { kind: 'zero-cost' }
  | {
      kind: 'costed'
      unpaidDays: number
      /** True when unpaidDays came from the server rather than the local estimate. */
      fromServer: boolean
    }

/**
 * The live cost of the current selection (prototype #impact-line), pure for
 * unit tests.
 *
 * `before` is what remains free for the REST of the year
 * (projectedRemainingDays): the days the year will have accrued by its end,
 * minus what is spent and what other requests already claim. That is the
 * figure the server's own feasibility check is built on, so an overdraft here
 * means the same thing it means there. Falling back to the bookable figure
 * covers a server that has not sent the projection.
 *
 * `after` is arithmetic on top of that floor, so the two figures can never
 * disagree with each other, and it stops at zero: what the balance cannot fund
 * is taken unpaid rather than driving the year negative. The floor is the
 * BOOKABLE HOUR GRID (floorDays), not a whole day: half a day left funds half a
 * day of leave, and an employee holding one used to be told they had nothing.
 *
 * How many days that is comes from the SERVER whenever the last preview is for
 * these exact dates. The server decides the split day by day against the
 * accrual due on each one, which this year-end arithmetic can only approximate
 * (it cannot see that accrual arriving mid-leave pays for the days after it).
 * Without a matching preview the local estimate stands in, and the banner
 * beside this card carries the server's own sentence either way.
 */
export function requestImpactFor(input: {
  leaveType: LeaveType
  startDate: string
  endDate: string
  // What the selection COSTS, part days included - never the count of dates in
  // it. Both were the same figure until leave could be booked by the hour.
  costDays: number
  balances: LeaveBalanceDto[]
  // The org's workday, from the composer's form context: the floor below is the
  // bookable ceiling this year's balance can fund, not a rendering of it.
  hoursPerDay: number
  // Days the leave being changed hands back when the change is approved. A
  // change costs the difference only, so counting its days on top of a
  // balance that is already holding them would overstate every proposal.
  replacedDays?: number
  preview?: Pick<
    LeaveAvailabilityPreviewDto,
    'leaveType' | 'startDate' | 'endDate' | 'requestedDays' | 'unpaidDays'
  >
}): RequestImpact {
  if (!input.startDate) {
    return { kind: 'empty' }
  }
  if (input.costDays === 0) {
    return { kind: 'zero-cost' }
  }
  const balance = input.balances.find((entry) => entry.leaveType === input.leaveType)
  const remaining = balance?.projectedRemainingDays ?? (balance ? bookableDaysOf(balance) : 0)
  const before = floorDays(Math.max(0, remaining), input.hoursPerDay)
  const replaced = input.replacedDays ?? 0
  const previewMatches =
    input.preview !== undefined &&
    input.preview.leaveType === input.leaveType &&
    input.preview.startDate === input.startDate &&
    input.preview.endDate === input.endDate &&
    // ...and about the same SHAPE, not merely the same period. A verdict for
    // five whole days is not a verdict about the same week with one of them
    // shortened, and the dates alone cannot tell the two apart.
    sameCost(input.preview.requestedDays, input.costDays)

  return {
    kind: 'costed',
    unpaidDays:
      previewMatches && input.preview
        ? Math.min(input.preview.unpaidDays, input.costDays)
        : // A single figure, judged against what the year has left: the honest
          // per-year split needs the server's projections, and the receipt
          // beside this card shows it as soon as they arrive.
          Math.max(0, roundDays(input.costDays - replaced - before)),
    fromServer: previewMatches,
  }
}

// Prototype input typography (textarea / .rec-input are 13.5px): MUI fields
// default to 16px body text, oversized next to the rest of the composer.
const fieldSx = {
  '& .MuiInputBase-input': { fontSize: 13.5 },
  '& .MuiInputLabel-root': { fontSize: 13.5 },
} as const

// Prototype .f-label: the small bold field caption above a control.
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', color: 'text.secondary' }}
    >
      {children}
    </Typography>
  )
}

// Prototype .rec-title / .rec-cap: the recipients section heading pair.
function RecipientHeading({ title, caption }: { title: string; caption: string }) {
  return (
    <Stack spacing={0.25}>
      <Typography sx={{ fontSize: 14.5, fontWeight: 800 }}>{title}</Typography>
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{caption}</Typography>
    </Stack>
  )
}

export function LeaveRequestPageContent() {
  const dispatch = useEmployeeFeatureDispatch()
  const composer = useEmployeeFeatureSelector((state) => state.requestComposer)
  const [searchParams] = useSearchParams()
  // Present when the page was opened to CHANGE an approved leave rather than
  // to book a new one. Everything below branches on this one value.
  const modifyRequestId = searchParams.get('modify') ?? undefined
  const modify = composer.modify
  const modifyOriginal =
    modify?.status === 'succeeded' ? modify.original : undefined
  const [form, setForm] = useState<LeaveRequestFormState>(INITIAL_FORM)
  // The per-day hours editor. Kept out of LeaveRequestFormState because it is
  // derived from the picked range: the effect below prunes it whenever that
  // range moves, and every transition it has lives in partialDaysReducer.
  const [partialDays, dispatchPartialDays] = useReducer(
    partialDaysReducer,
    INITIAL_PARTIAL_DAYS,
  )
  const hoursByDate = partialDays.hoursByDate

  // Fill the form from the leave being changed, once. After that the employee
  // owns the fields; a silent context refresh must not reset their edits.
  const [prefilled, setPrefilled] = useState(false)

  useEffect(() => {
    dispatch(employeeFeatureActions.requestContextRequested())
    // Clear any prior submit success/error when leaving so a return visit to
    // the shared store does not show a stale banner.
    return () => {
      dispatch(employeeFeatureActions.requestSubmissionReset())
    }
  }, [dispatch])

  useEffect(() => {
    if (modifyRequestId) {
      dispatch(employeeFeatureActions.modifyContextRequested(modifyRequestId))
      return
    }
    // Back to booking new leave without the page ever unmounting: forget the
    // leave the previous visit was changing, or the next submission would be
    // addressed to it.
    dispatch(employeeFeatureActions.modifyContextCleared())
    setPrefilled(false)
  }, [dispatch, modifyRequestId])

  // A successful submission clears the draft: the created request now lives
  // in history and the pending list (the success banner reads the returned
  // DTO, not the form), and a lingering draft invites an accidental duplicate
  // the server would reject as overlapping. Dropping the prefilled flag along
  // with it puts a change back on the leave as it currently stands: the
  // proposal is with the approvers now, not with the form.
  useEffect(() => {
    if (composer.submitStatus === 'succeeded') {
      setForm(INITIAL_FORM)
      // The hours belonged to the dates that have just been submitted; leaving
      // them behind would price the next draft against a range it never had.
      dispatchPartialDays({ kind: 'cleared' })
      setPrefilled(false)
    }
  }, [composer.submitStatus])

  // Backend-computed readiness: while the profile is not Ready (being set up,
  // or the start date is still in the future) nothing accrues, so the whole
  // composer is replaced with the pending state below (and the backend rejects
  // submissions anyway). Fail closed: an unexpected/missing status blocks too.
  const profileBlocked =
    composer.dashboard?.profileStatus !== EmployeeProfileStatus.Ready

  // Keep the availability snapshot the request is validated against fresh: the
  // context refetch keeps current content in place (no loader flash), so a stale
  // balance never silently backs a submission.
  useAutoRefresh(() => {
    dispatch(employeeFeatureActions.requestContextRequested())
  }, DASHBOARD_REFRESH_INTERVAL_MS)
  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  // Shading input for the calendar. Keyed by the employee's country, so it is
  // the same cache entry the upcoming per-country holidays page will read.
  // Names ride along for the day tooltips; the dates hook owns the fetch.
  const holidayCountryCode =
    composer.dashboard?.holidayCalendarCountryCode ?? composer.dashboard?.countryCode
  const holidayDates = useHolidayDates(holidayCountryCode)
  const holidayNames = useHolidayNames(holidayCountryCode)

  // The dates the selection charges, and how many of them there are. The COUNT
  // is what the server's no-working-days rule is about (resolveLeaveDays):
  // mirroring it here keeps the composer honest, since the calendar footer says
  // the selection costs nothing, so submit must not be offered either. It can
  // only ever block a selection the server would reject anyway - weekends are
  // certain client-side, and holidays subtract only once the calendar has
  // loaded, so an unloaded calendar falls back to today's behaviour.
  const selectedDates = useMemo(
    () => chargeableDates(form.startDate, form.endDate, holidayDates),
    [form.startDate, form.endDate, holidayDates],
  )
  const chargeableDays = selectedDates.length

  // How long a working day is here: the editor's upper bound and the divisor
  // every hour count on this page is priced through. The form context is the
  // response that publishes it FOR the composer; the dashboard carries the same
  // setting, and the display divisor is the last resort so the page still
  // prices sensibly before either has landed.
  const hoursPerDay =
    composer.formContext?.hoursPerDay ??
    composer.dashboard?.hoursPerDay ??
    workdayHoursOf()

  // A range that moved leaves entries behind that no longer name a working day
  // of it, and the server refuses those rather than dropping them. Same effect
  // covers an administrator shortening the workday under an open draft.
  useEffect(() => {
    dispatchPartialDays({ kind: 'pruned', dates: selectedDates, hoursPerDay })
  }, [hoursPerDay, selectedDates])

  // What the selection COSTS, which is no longer its date count: the figure the
  // impact line, the meter marking and the funding window are all priced from.
  const costDays = useMemo(
    () => costOfDates(selectedDates, hoursByDate, hoursPerDay),
    [hoursByDate, hoursPerDay, selectedDates],
  )
  // The shape the submission will freeze. The preview is asked about this exact
  // map, so the panel cannot promise a split submit would not produce.
  const hoursPayload = useMemo(
    () => hoursPayloadFor(selectedDates, hoursByDate, hoursPerDay),
    [hoursByDate, hoursPerDay, selectedDates],
  )

  // The backend rejects submissions touching a year with no configured
  // holiday calendar; the dashboard ships the configured years so we can warn
  // and disable BEFORE the attempt. calendarNoticeFor yields AT MOST one
  // notice: 'none-configured' replaces the whole composer (see render below),
  // 'picked-year-missing' warns and disables submit for the chosen date,
  // 'end-year-missing' does the same for a range crossing into an
  // unconfigured year, and 'current-year-missing' informs on page load
  // before any date is picked.
  const calendarNotice = calendarNoticeFor(
    form.startDate,
    composer.dashboard,
    form.endDate,
  )

  // A person appears in EITHER Approvers OR CC, never both. The pickers
  // enforce it by construction: defaults (locked chips) and the other field's
  // selection are excluded from each field's options, so every recipient ends
  // up in exactly one list, matching the server merge which dedupes by email.
  const formContext = composer.formContext
  const defaultApprovers = useMemo(
    () => formContext?.defaultApprovers ?? [],
    [formContext],
  )
  const defaultCc = useMemo(() => formContext?.defaultCc ?? [], [formContext])
  // The requester is already dropped from formContext.users (and the defaults)
  // by the server, and inactive employees never appear in the picker or default
  // preview — so self-approval and inactive recipients are impossible here.
  //
  // The two exclusions are ASYMMETRIC, because promotion runs one way only. A
  // CC default may be picked as a deciding approver (the server merge gives
  // 'to' precedence over 'cc' for one address), so it stays in the approver
  // options. A deciding default cannot be demoted: picking one as CC would
  // render the same person twice and still store them as a decider, so the CC
  // options exclude both lists.
  const approverOptions = useMemo(
    () =>
      excludeEmails(formContext?.users ?? [], [
        ...recipientEmailsOf(defaultApprovers),
        ...form.ccEmails,
      ]),
    [formContext, defaultApprovers, form.ccEmails],
  )
  const ccOptions = useMemo(
    () =>
      excludeEmails(formContext?.users ?? [], [
        ...recipientEmailsOf(defaultApprovers),
        ...recipientEmailsOf(defaultCc),
        ...form.approverEmails,
      ]),
    [formContext, defaultApprovers, defaultCc, form.approverEmails],
  )
  // A CC default the employee promoted to deciding approver is shown by the
  // approver field now; leaving it locked here too would render the same
  // person twice and imply they are only copied.
  const ccLockedRecipients = useMemo(
    () =>
      defaultCc.filter(
        (recipient) => !form.approverEmails.includes(recipient.email),
      ),
    [defaultCc, form.approverEmails],
  )

  // The context refreshes silently (interval + tab focus), and an admin may
  // have promoted an already-picked person into the settings defaults while
  // the draft sat open. Prune such picks so the either/or invariant holds:
  // the locked chip now represents them, and no chip lingers with a label
  // that misstates what the server merge will do.
  useEffect(() => {
    // Mirrors the option lists, asymmetry included: an approver pick survives
    // a CC default (that is the promotion), a CC pick survives neither.
    const lockedApprovers = new Set(recipientEmailsOf(defaultApprovers))
    const lockedForCc = new Set([
      ...recipientEmailsOf(defaultApprovers),
      ...recipientEmailsOf(defaultCc),
    ])
    if (lockedForCc.size === 0) {
      return
    }
    setForm((current) => {
      const approverEmails = pruneLockedEmails(
        current.approverEmails,
        lockedApprovers,
      )
      const ccEmails = pruneLockedEmails(current.ccEmails, lockedForCc)
      if (
        approverEmails === current.approverEmails &&
        ccEmails === current.ccEmails
      ) {
        return current
      }
      return { ...current, approverEmails, ccEmails }
    })
  }, [defaultApprovers, defaultCc])

  // A default 'to' approver satisfies the requirement on its own; the manual
  // minimum applies only when the settings provide none. With approval
  // optional there is no requirement at all, and a submission addressed to
  // nobody is the one the server will approve on the spot.
  const approvalRequired = formContext?.approvalRequired ?? true
  const hasApprover = hasRequiredApprover(
    form.approverEmails,
    defaultApprovers,
    approvalRequired,
  )
  const willAutoApprove =
    !approvalRequired &&
    form.approverEmails.length === 0 &&
    defaultApprovers.length === 0

  useEffect(() => {
    if (!modifyOriginal || prefilled || !composer.formContext) {
      return
    }
    setForm(buildModifyPrefill(modifyOriginal, defaultApprovers, defaultCc))
    dispatchPartialDays({
      kind: 'prefilled',
      ...(modifyOriginal.dayPortions
        ? { dayPortions: modifyOriginal.dayPortions }
        : {}),
      hoursPerDay: composer.formContext.hoursPerDay,
    })
    setPrefilled(true)
  }, [composer.formContext, defaultApprovers, defaultCc, modifyOriginal, prefilled])

  // Ask the server whether the picked period would be accepted. In modify mode
  // this waits for the original to load: without its id the preview would count
  // the very days the change is going to release and flash a false objection.
  useEffect(() => {
    const waitingForOriginal = Boolean(modifyRequestId) && !modifyOriginal
    if (
      waitingForOriginal ||
      form.startDate.length === 0 ||
      form.endDate.length === 0 ||
      form.endDate < form.startDate
    ) {
      dispatch(employeeFeatureActions.availabilityPreviewCleared())
      return
    }
    dispatch(
      employeeFeatureActions.availabilityPreviewRequested({
        leaveType: form.leaveType,
        startDate: form.startDate,
        endDate: form.endDate,
        ...(modifyOriginal ? { excludeRequestId: modifyOriginal.requestId } : {}),
        // The same map the submission will carry: the preview is priced by the
        // code that freezes the request, so asking about anything else would
        // let the panel predict a split submit does not produce.
        ...(hoursPayload ? { hoursByDate: hoursPayload } : {}),
      }),
    )
  }, [
    dispatch,
    form.leaveType,
    form.startDate,
    form.endDate,
    hoursPayload,
    modifyOriginal,
    modifyRequestId,
  ])

  // Advisory pre-check mirroring the backend horizon guard, so a date beyond
  // next year is refused before the attempt rather than after it. The END of
  // the range is what must clear the horizon (a Dec→Jan span reaches with its
  // far end), same as the server.
  const horizonNotice = horizonNoticeFor(
    form.startDate,
    composer.dashboard?.generatedAt,
    form.endDate,
  )

  // A loaded verdict of "no" blocks submission; a missing, failed or still
  // loading one never does. The server decides at submit either way, so
  // failing open here costs nothing and failing closed would strand people.
  const availabilityBlocksSubmit =
    composer.availability.status === 'succeeded' &&
    composer.availability.data?.feasible === false

  // Nothing to submit when the change would leave the leave exactly as it is.
  // The hours count as much as the dates do: shortening one day of an approved
  // week is a proposal like any other, and comparing only the period would
  // leave the button dead with no explanation.
  const modificationIsNoop =
    modifyOriginal !== undefined &&
    form.startDate === modifyOriginal.startDate &&
    form.endDate === modifyOriginal.endDate &&
    form.comment.trim() === (modifyOriginal.comment ?? '') &&
    sameHoursByDate(
      hoursPayload,
      buildModifyHoursPrefill(modifyOriginal.dayPortions, hoursPerDay),
    )

  // The days the leave being changed gives back once the change is approved.
  // Both the meter preview and the impact line net them out, so a change that
  // only moves a booking reads as costing nothing.
  const replacedDays =
    modifyOriginal !== undefined && modifyOriginal.leaveType === form.leaveType
      ? modifyOriginal.requestedDays
      : 0

  // The balance as it will stand when the leave is actually taken, for the
  // projected bar. Read from the LAST preview regardless of its status: the
  // store keeps the previous verdict while the next one loads, so editing the
  // dates refines the bar instead of blanking it. Keyed to the month the leave
  // ends in, which is the month "by then" means to the person picking dates.
  const preview = composer.availability.data

  const canSubmit = useMemo(
    () =>
      form.startDate.length > 0 &&
      form.endDate.length > 0 &&
      form.endDate >= form.startDate &&
      chargeableDays > 0 &&
      calendarNotice?.kind !== 'picked-year-missing' &&
      calendarNotice?.kind !== 'end-year-missing' &&
      horizonNotice === null &&
      !availabilityBlocksSubmit &&
      !modificationIsNoop &&
      (!modifyRequestId || modifyOriginal !== undefined) &&
      hasApprover &&
      composer.submitStatus !== 'loading',
    [
      availabilityBlocksSubmit,
      calendarNotice,
      chargeableDays,
      composer.submitStatus,
      hasApprover,
      horizonNotice,
      modificationIsNoop,
      modifyOriginal,
      modifyRequestId,
      form.endDate,
      form.startDate,
    ],
  )

  const impact = requestImpactFor({
    leaveType: form.leaveType,
    startDate: form.startDate,
    endDate: form.endDate,
    costDays,
    balances: composer.dashboard?.balances ?? [],
    hoursPerDay,
    replacedDays,
    ...(preview ? { preview } : {}),
  })
  const unpaidDays = impact.kind === 'costed' ? impact.unpaidDays : 0
  const receipt = buildRequestReceipt({
    leaveType: form.leaveType,
    startDate: form.startDate,
    endDate: form.endDate,
    chargeableDays,
    costDays,
    previewStatus: composer.availability.status,
    ...(preview ? { preview } : {}),
    ...(replacedDays > 0 ? { replacedDays } : {}),
  })
  // The funding window's sides: one per leave year the request charges, plus
  // this year whenever it only feeds the carryover. The January side of a New
  // Year span is funded by NEXT year's budget, and the window is what says so.
  //
  // The preview is only read when it describes the type on the form: switching
  // Vacation to Sick otherwise draws the vacation verdict onto the sick window
  // for as long as the debounce lasts.
  const windowYears = useMemo(() => {
    const forThisType = preview?.leaveType === form.leaveType ? preview : undefined
    return buildYearMeters({
      hoursPerDay,
      ...(forThisType ? { years: forThisType.years } : {}),
      ...(forThisType ? { currentYear: forThisType.currentYear } : {}),
      localDaysByYear: chargeableDaysByYear(
        form.startDate,
        form.endDate,
        holidayDates,
        hoursByDate,
        hoursPerDay,
      ),
      fromServer: impact.kind === 'costed' && impact.fromServer,
    })
  }, [
    preview,
    form.leaveType,
    form.startDate,
    form.endDate,
    holidayDates,
    hoursByDate,
    hoursPerDay,
    impact,
  ])
  // Only the server knows WHICH days go unpaid, and only for the dates it was
  // asked about: a preview for other dates would hatch the wrong squares.
  const previewMatchesSelection =
    preview !== undefined &&
    preview.leaveType === form.leaveType &&
    preview.startDate === form.startDate &&
    preview.endDate === form.endDate &&
    // The shape too: which days go unpaid depends on what each day costs, so a
    // verdict priced before a stepper moved would hatch the wrong squares.
    sameCost(preview.requestedDays, costDays)
  const unpaidDatesForSelection = useMemo(
    () =>
      previewMatchesSelection && preview
        ? new Set(preview.unpaidDates)
        : undefined,
    [preview, previewMatchesSelection],
  )

  const submitNote = submitNoteFor({
    hasApprover,
    willAutoApprove,
    hasDates: form.startDate.length > 0 && form.endDate.length > 0,
    chargeableDays,
    pickedYearMissing: calendarNotice?.kind === 'picked-year-missing',
    endYearMissing: calendarNotice?.kind === 'end-year-missing',
    beyondHorizon: horizonNotice !== null,
    availabilityBlocked: availabilityBlocksSubmit,
    unchangedModification: modificationIsNoop,
    awaitingOriginal:
      Boolean(modifyRequestId) &&
      modifyOriginal === undefined &&
      modify?.status !== 'failed',
    originalUnavailable: Boolean(modifyRequestId) && modify?.status === 'failed',
    unpaidDays,
    // Same staleness gate as the calendar hatching: a preview for other dates
    // would date a probation end the current selection never asked about.
    ...(previewMatchesSelection && preview?.probationEnd
      ? { probationEnd: preview.probationEnd }
      : {}),
  })

  // The type a leave was booked with is fixed for its whole life; a different
  // type means cancelling it and booking afresh.
  const leaveTypeLocked = modifyRequestId !== undefined

  const updateForm = <K extends keyof LeaveRequestFormState>(
    key: K,
    value: LeaveRequestFormState[K],
  ) => {
    setForm((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const handleSubmit = () => {
    const comment =
      form.comment.trim().length > 0 ? form.comment.trim() : undefined
    // Both conditions: the URL says this is a change AND the leave it changes
    // has loaded. Either alone could address a new request to the modify route.
    if (modifyRequestId && modifyOriginal) {
      // The leave type is not sent: it stays the original's, so a change of
      // type means cancelling and booking afresh.
      dispatch(
        employeeFeatureActions.modificationSubmitted({
          requestId: modifyOriginal.requestId,
          payload: {
            startDate: form.startDate,
            endDate: form.endDate,
            comment,
            approverEmails: form.approverEmails,
            ccEmails: form.ccEmails,
            // Re-stated in full, never inherited: an absent map means every
            // new date is whole, which is exactly what turning the switch off
            // proposes.
            ...(hoursPayload ? { hoursByDate: hoursPayload } : {}),
          },
        }),
      )
      return
    }

    const payload: CreateLeaveRequestDto = {
      leaveType: form.leaveType,
      startDate: form.startDate,
      endDate: form.endDate,
      comment,
      approverEmails: form.approverEmails,
      ccEmails: form.ccEmails,
      ...(hoursPayload ? { hoursByDate: hoursPayload } : {}),
    }

    dispatch(employeeFeatureActions.requestSubmitted(payload))
  }

  // The leave can no longer be changed (it started, it is not approved, or a
  // change is already awaiting approval). Advisory: the server enforces it.
  const modifyUnavailable =
    modifyOriginal !== undefined &&
    composer.dashboard !== undefined &&
    !canModifyRequest(modifyOriginal, composer.dashboard.generatedAt)

  return (
    <EmployeePageFrame
      // Matches the prototype h1, the topbar crumb, and the sidebar item, so
      // the page carries one name everywhere. Changing an approved leave is
      // the same composer on a different errand, and says so.
      title={modifyRequestId ? 'Change approved leave' : 'New request'}
      subtitle={
        modifyRequestId
          ? willAutoApprove
            ? 'Propose new dates. No approval is required, so they replace your approved leave as soon as you submit.'
            : 'Propose new dates. Your approved leave stays in place until every approver has approved the change.'
          : 'Prepare approvers, confirm the date range, and submit one clean request that reflects the current balance picture.'
      }
      statusIndicator={
        composer.contextStatus === 'succeeded' && composer.dashboard ? (
          <ShellStatusPill
            label={`Live · updated ${formatRelativeTime(composer.dashboard.generatedAt, nowMs)}`}
          />
        ) : undefined
      }
    >
      {composer.contextStatus === 'loading' || composer.contextStatus === 'idle' ? (
        <LoadingSection label="Loading request workspace" />
      ) : null}

      {composer.contextStatus === 'failed' && composer.contextError ? (
        <ErrorSection title="Request workspace unavailable" message={composer.contextError} />
      ) : null}

      {composer.contextStatus === 'succeeded' && composer.dashboard ? (
        profileBlocked ? (
          <ProfilePendingState
            status={composer.dashboard.profileStatus}
            employmentStartDate={composer.dashboard.employmentStartDate}
          />
        ) : calendarNotice?.kind === 'none-configured' ? (
          <HolidayCalendarMissingState />
        ) : composer.history ? (
          <Box
            sx={{
              display: 'grid',
              gap: 2.25,
              alignItems: 'start',
              gridTemplateColumns: {
                xs: '1fr',
                lg: 'minmax(0, 7fr) minmax(300px, 5fr)',
              },
            }}
          >
            <SectionCard
              title={modifyRequestId ? 'New dates' : 'Request details'}
              caption="Weekends and public holidays are shaded; they don't spend your balance."
              icon={modifyRequestId ? <ArrowGlyph size={16} /> : <PlusGlyph size={17} />}
            >
              <Stack spacing={2}>
                {modifyOriginal ? (
                  <DecisionBanner tone="muted">
                    <Box data-testid="modify-context">
                      You are proposing new dates for your approved{' '}
                      {formatLeaveType(modifyOriginal.leaveType).toLowerCase()} of{' '}
                      {formatDate(modifyOriginal.startDate)} to{' '}
                      {formatDate(modifyOriginal.endDate)}.{' '}
                      {willAutoApprove
                        ? 'No approval is required, so submitting replaces that leave right away.'
                        : 'That leave stays approved until every approver has approved the change, and stays untouched if they reject it.'}
                    </Box>
                  </DecisionBanner>
                ) : null}

                {modifyUnavailable ? (
                  <DecisionBanner tone="bad">
                    <Box data-testid="modify-unavailable">
                      This leave can no longer be changed. It has either started already or
                      has a change awaiting approval.
                    </Box>
                  </DecisionBanner>
                ) : null}

                {modify?.status === 'failed' ? (
                  <DecisionBanner tone="bad">
                    <Box data-testid="modify-load-failed">
                      {modify.error ?? 'The leave you are changing could not be loaded.'}{' '}
                      Open it again from your request history.
                    </Box>
                  </DecisionBanner>
                ) : null}

                <Box>
                  <FieldLabel>Leave type</FieldLabel>
                  {/* Prototype .seg, stretched to the full row (user decision:
                      the Compensation control is not ported). A change keeps
                      the type its leave was booked with, so the control still
                      shows it but stops answering. */}
                  <Box
                    sx={{
                      mt: 1,
                      ...(leaveTypeLocked ? { opacity: 0.6, pointerEvents: 'none' } : {}),
                    }}
                    aria-disabled={leaveTypeLocked || undefined}
                  >
                    <SegmentedControl
                      ariaLabel="Leave type"
                      fullWidth
                      value={form.leaveType}
                      onChange={(leaveType) => {
                        // Keyboard focus still reaches the options with pointer
                        // events off, so the lock is enforced here as well.
                        if (!leaveTypeLocked) {
                          updateForm('leaveType', leaveType)
                        }
                      }}
                      options={[
                        {
                          value: LeaveType.Vacation,
                          label: formatLeaveType(LeaveType.Vacation),
                          icon: <SunriseGlyph size={15} />,
                        },
                        {
                          value: LeaveType.Sick,
                          label: formatLeaveType(LeaveType.Sick),
                          icon: <HeartGlyph size={15} />,
                        },
                      ]}
                    />
                  </Box>
                  <Typography sx={{ mt: 0.75, fontSize: 12, color: '#98a2b3' }}>
                    {leaveTypeLocked
                      ? 'The leave type stays as it was. To change it, cancel this leave and submit a new request.'
                      : TYPE_HINTS[form.leaveType]}
                  </Typography>
                </Box>

                {/* Always-visible calendar, not a popover field: shaded
                    weekends and official holidays are the whole point of the
                    surface, and every click commits straight to the form. A
                    single day is a first-class selection - see nextSelection. */}
                <Box>
                  <FieldLabel>Leave date(s)</FieldLabel>
                  <Box sx={{ mt: 1 }}>
                    <InlineRangeCalendar
                      value={{ startDate: form.startDate, endDate: form.endDate }}
                      onChange={(next) =>
                        setForm((current) => ({
                          ...current,
                          startDate: next.startDate,
                          endDate: next.endDate,
                        }))
                      }
                      partialDays={{
                        enabled: partialDays.open,
                        onEnabledChange: (open) =>
                          dispatchPartialDays({ kind: 'toggled', open }),
                        hoursPerDay,
                        hoursByDate,
                        onHoursChange: (date, hours) =>
                          dispatchPartialDays({
                            kind: 'hours-set',
                            date,
                            hours,
                            hoursPerDay,
                          }),
                      }}
                      holidayDates={holidayDates}
                      holidayNames={holidayNames}
                      unpaidDates={unpaidDatesForSelection}
                      // Deliberately unbounded into the past: retroactive
                      // requests (sick yesterday, filing today) are a
                      // supported server flow.
                      testId="leave-request-calendar"
                    />
                  </Box>
                </Box>

                {calendarNotice?.kind === 'picked-year-missing' ? (
                  <Alert severity="warning" data-testid="calendar-missing-warning">
                    No holiday calendar is configured for {calendarNotice.year}{' '}
                    in your country yet, so a request for this year cannot be
                    submitted. Please contact your administrator.
                  </Alert>
                ) : null}

                {calendarNotice?.kind === 'end-year-missing' ? (
                  <Alert severity="warning" data-testid="end-year-calendar-warning">
                    No holiday calendar is configured for {calendarNotice.year}{' '}
                    in your country yet, so a request that runs into{' '}
                    {calendarNotice.year} cannot be submitted. Please contact
                    your administrator.
                  </Alert>
                ) : null}

                {calendarNotice?.kind === 'current-year-missing' ? (
                  <Alert severity="warning" data-testid="current-year-calendar-warning">
                    No holiday calendar is configured for the current year (
                    {calendarNotice.year}) in your country yet, so requests for{' '}
                    {calendarNotice.year} cannot be submitted. Requests for
                    configured years are still possible. Please contact your
                    administrator.
                  </Alert>
                ) : null}

                {horizonNotice ? (
                  <DecisionBanner tone="bad">
                    <Box data-testid="horizon-warning">
                      Leave can be planned for this year and next year only, up to the end
                      of {horizonNotice.maxYear}.
                    </Box>
                  </DecisionBanner>
                ) : null}

                {/* Only what stands in the way; the balance rail carries the
                    positive answer as a bar. */}
                <AvailabilityNotices
                  status={composer.availability.status}
                  preview={composer.availability.data}
                />

                {modificationIsNoop ? (
                  <DecisionBanner tone="muted">
                    <Box data-testid="modify-noop">
                      These are the dates you already have approved. Change them to propose
                      something different.
                    </Box>
                  </DecisionBanner>
                ) : null}

                <TextField
                  label="Comment"
                  name="comment"
                  multiline
                  minRows={4}
                  value={form.comment}
                  onChange={(event) => updateForm('comment', event.target.value)}
                  inputProps={{ 'data-testid': 'leave-request-comment' }}
                  helperText="Optional context for approvers."
                  sx={fieldSx}
                />

                <Divider />

                <Stack spacing={1.5}>
                  <RecipientHeading
                    title="Approvers"
                    caption={
                      approvalRequired
                        ? 'These recipients can approve or reject the request.'
                        : 'Optional here. Name someone and they decide the request; leave it empty and the request is approved automatically.'
                    }
                  />
                  <UserMultiSelect
                    label="Add approvers"
                    placeholder="Search by name or email"
                    value={form.approverEmails}
                    onChange={(emails) => updateForm('approverEmails', emails)}
                    options={approverOptions}
                    lockedRecipients={defaultApprovers}
                    lockedHint="Included automatically by company policy. These approvers cannot be removed."
                    testId="approver-email-input"
                    sx={fieldSx}
                  />
                </Stack>

                <Stack spacing={1.5}>
                  <RecipientHeading
                    title="CC recipients"
                    caption="Keep stakeholders informed without granting approval authority."
                  />
                  <UserMultiSelect
                    label="Add CC recipients"
                    placeholder="Search by name or email"
                    value={form.ccEmails}
                    onChange={(emails) => updateForm('ccEmails', emails)}
                    options={ccOptions}
                    lockedRecipients={ccLockedRecipients}
                    lockedHint="Included automatically by company policy. These recipients cannot be removed."
                    testId="cc-email-input"
                    sx={fieldSx}
                  />
                </Stack>

                {composer.submitStatus === 'failed' && composer.submitError ? (
                  <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                    {composer.submitError}
                  </Alert>
                ) : null}

                {composer.submitStatus === 'succeeded' && composer.createdRequest ? (
                  // Auto-dismisses with the draining tint; the reset also
                  // covers the store so a return visit opens clean.
                  <AutoDismissSuccessAlert
                    testId="leave-request-success"
                    onDone={() => {
                      dispatch(employeeFeatureActions.requestSubmissionReset())
                      // That reset drops the modify context together with the
                      // banner; ask for it again so the page still knows which
                      // leave it is on, now with a change pending against it.
                      if (modifyRequestId) {
                        dispatch(
                          employeeFeatureActions.modifyContextRequested(modifyRequestId),
                        )
                      }
                    }}
                  >
                    {composer.createdRequest.supersedesRequestId ? (
                      composer.createdRequest.status ===
                      LeaveRequestStatus.Approved ? (
                        // Already settled: the original was superseded and its
                        // hold released in the same call, so promising it
                        // "stays approved until every approver has approved"
                        // would describe a state that no longer exists.
                        <>
                          Change applied:{' '}
                          {formatDate(composer.createdRequest.startDate)} to{' '}
                          {formatDate(composer.createdRequest.endDate)}. No approval was
                          required, so the new dates replaced your original leave right
                          away.
                          {composer.createdRequest.unpaidDays > 0
                            ? ` ${formatDays(composer.createdRequest.unpaidDays)} of it will be unpaid.`
                            : ''}
                        </>
                      ) : (
                        <>
                          Change submitted for approval:{' '}
                          {formatDate(composer.createdRequest.startDate)} to{' '}
                          {formatDate(composer.createdRequest.endDate)}. Your original leave
                          stays approved until every approver has approved the new dates.
                          {composer.createdRequest.unpaidDays > 0
                            ? ` ${formatDays(composer.createdRequest.unpaidDays)} of it will be unpaid.`
                            : ''}
                        </>
                      )
                    ) : (
                      <>
                        Submitted {formatLeaveType(composer.createdRequest.leaveType).toLowerCase()} request for{' '}
                        {formatDate(composer.createdRequest.startDate)} to {formatDate(composer.createdRequest.endDate)}.
                        {composer.createdRequest.unpaidDays > 0
                          ? ` ${formatDays(composer.createdRequest.unpaidDays)} of it will be unpaid.`
                          : ''}
                      </>
                    )}
                  </AutoDismissSuccessAlert>
                ) : null}

                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1.5}
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                >
                  <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: 'text.secondary' }}>
                    {submitNote}
                  </Typography>
                  <Button
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    data-testid="leave-request-submit"
                    sx={{ ml: { sm: 'auto' }, flexShrink: 0 }}
                  >
                    {composer.submitStatus === 'loading'
                      ? 'Submitting...'
                      : modifyRequestId
                        ? 'Submit change for approval'
                        : 'Submit request'}
                  </Button>
                </Stack>
              </Stack>
            </SectionCard>

            {/* Prototype .sticky-col: the balance picture keeps pace with the
                scroll so the cost of the selection is always in view. */}
            <Stack
              spacing={2.25}
              sx={{
                position: { lg: 'sticky' },
                top: { lg: 86 },
              }}
            >
              <SectionCard
                title="Current balance"
                caption={`Availability snapshot as of ${formatDateTime(composer.dashboard.generatedAt)} · updated ${formatRelativeTime(composer.dashboard.generatedAt, nowMs)}`}
                icon={<BarsGlyph size={16} />}
              >
                <Stack spacing={1.75}>
                  {composer.dashboard.balances.map((balance) => {
                    // While a request is being composed, the picked type's
                    // meter gives way to the funding window: same slot, but it
                    // tells where THESE days come from, year seam and all. The
                    // other type keeps its plain meter, and a marking on the
                    // current-year bar never lies about a January request that
                    // charges next year's budget.
                    const requested = balance.leaveType === form.leaveType
                    return requested &&
                      receipt.kind === 'receipt' &&
                      windowYears.length > 0 ? (
                      // Dims together with the receipt while the verdict
                      // describes other dates: two halves of one story must go
                      // stale as one.
                      <Box
                        key={balance.leaveType}
                        {...(receipt.stale ? { 'aria-busy': 'true' } : {})}
                        sx={{
                          opacity: receipt.stale ? 0.55 : 1,
                          transition: 'opacity 220ms ease',
                        }}
                      >
                        <RequestFundingWindow
                          leaveType={balance.leaveType}
                          years={windowYears}
                        />
                      </Box>
                    ) : (
                      <BalanceMeter
                        key={balance.leaveType}
                        balance={balance}
                        previewDays={
                          requested ? roundDays(costDays - replacedDays) : 0
                        }
                      />
                    )
                  })}
                </Stack>
              </SectionCard>

              <SectionCard
                title="This request"
                caption="Live cost of the current selection."
                icon={<PulseGlyph size={16} />}
              >
                <RequestReceipt receipt={receipt} />
              </SectionCard>
            </Stack>
          </Box>
        ) : null
      ) : null}
    </EmployeePageFrame>
  )
}

export function LeaveRequestPage() {
  return (
    <EmployeeFeatureProvider>
      <LeaveRequestPageContent />
    </EmployeeFeatureProvider>
  )
}

export default LeaveRequestPage
