/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  EmployeePolicyDto,
  LeavePolicyDto,
  PolicyMembershipDto,
  PolicyTransferAdjustmentDto,
  PolicyTransferMode,
  PolicyTransferRequestRefDto,
} from '@workspace/contracts'
import { ApiError } from './admin-api'
import { formatDate, formatLeaveType } from './admin-formatters'
import { formatDays } from '../../lib/leave-format'

// Every decision the policy dialogs render lives here as a pure function: the
// dialogs themselves are MUI portals, which render nothing under the node
// test environment, so the branches must be reachable without one.

// A bare day count for POLICY TERMS ONLY: an annual entitlement reads as
// arithmetic ('25+5 days', '+2/yr'), so the shared formatDays unit would only
// get in the way. Trailing zeros are dropped because stored terms are
// two-decimal numerics, and the write path refuses anything finer, so this can
// never be handed a figure off the hour grid.
//
// NOT for an amount of leave (a balance, a request's cost, an adjustment):
// those sit on the hour grid, where two decimals would render one hour of an
// eight-hour day as 0.13. Use formatDays.
function dayCount(value: number): string {
  return String(Math.round(value * 100) / 100)
}

// The cadence of the increment, as the denominator of a rate: '/yr' every
// year, '/3yr' every three. Rendered from the period rather than fixed to a
// year because the policy grows on its own schedule, and a '+5/yr' printed for
// a rise that lands once every three years overstates the deal threefold.
function incrementRate(policy: LeavePolicyDto): string {
  const every = policy.vacationIncrementEveryYears
  return `+${dayCount(policy.vacationAnnualIncrement)}/${every > 1 ? every : ''}yr`
}

/**
 * One line describing what a policy grants:
 *   '25+5 days, +2/yr max 35, probation 3 mo (sick paid)'
 *   '15+5 days, +5/3yr max 30, probation 3 mo'
 */
export function policyTermsSummary(policy: LeavePolicyDto): string {
  const parts = [
    `${dayCount(policy.vacationDays)}+${dayCount(policy.sickDays)} days`,
  ]
  if (policy.vacationAnnualIncrement > 0) {
    const growth = incrementRate(policy)
    parts.push(
      policy.vacationIncrementCapDays === undefined
        ? growth
        : `${growth} max ${dayCount(policy.vacationIncrementCapDays)}`,
    )
  }
  if (policy.probationMonths > 0) {
    parts.push(
      `probation ${policy.probationMonths} mo${
        policy.paidSickDuringProbation ? ' (sick paid)' : ''
      }`,
    )
  }
  return parts.join(', ')
}

/**
 * The prototype's `.terms` row: one chip per term, each a number with its unit
 * set quieter beside it. Kept as data rather than markup so the wording is
 * testable and the two callers that need a plain sentence can still use
 * policyTermsSummary.
 */
export type PolicyTermChip = { value: string; unit: string }

export function policyTermChips(policy: LeavePolicyDto): PolicyTermChip[] {
  const chips: PolicyTermChip[] = [
    { value: dayCount(policy.vacationDays), unit: 'vacation' },
    { value: dayCount(policy.sickDays), unit: 'sick' },
  ]
  if (policy.vacationAnnualIncrement > 0) {
    // The value keeps the amount and the unit keeps the cadence, so a column of
    // chips still compares '+5' against '+2' at a glance.
    const [amount, cadence] = incrementRate(policy).split('/') as [string, string]
    chips.push({
      value: amount,
      unit:
        policy.vacationIncrementCapDays === undefined
          ? `/${cadence}`
          // "max 35", not "to 35": the cap is the ceiling on the TOTAL
          // allowance, not on how much gets added.
          : `/${cadence}, max ${dayCount(policy.vacationIncrementCapDays)}`,
    })
  }
  if (policy.probationMonths > 0) {
    chips.push({
      value: String(policy.probationMonths),
      unit: `mo probation${policy.paidSickDuringProbation ? ', sick paid' : ''}`,
    })
  }
  return chips
}

/**
 * The catalog's increment cell, in a sentence:
 *   'Added every year of employment.'
 *   'Added every 3 years of employment, on 1 January.'
 *   'Added once, after 3 years of employment, on 1 January.'
 *
 * "on 1 January" is only said for a period above a year, and it is the fact
 * nothing else on screen carries: a step lands on the calendar-year boundary,
 * not on the hire anniversary, so an employee hired in November waits until
 * January rather than counting three years from their start date. At a period
 * of one year every boundary is a step, so the wording stays as it was.
 *
 * A one-off rise is not a stored term but a DERIVED reading: a ceiling exactly
 * one increment above the base can be reached once and never again. Saying
 * "added every 3 years" for terms that rise once would promise a growth the
 * engine will not give.
 */
export function policyIncrementHint(policy: LeavePolicyDto): string {
  const increment = policy.vacationAnnualIncrement
  const cap = policy.vacationIncrementCapDays
  if (increment <= 0) {
    return 'The allowance stays flat.'
  }
  const ceiling =
    cap === undefined ? '.' : `, until the allowance reaches ${dayCount(cap)} days.`
  const everyYears = policy.vacationIncrementEveryYears
  if (everyYears <= 1) {
    return `Added every year of employment${ceiling}`
  }
  if (cap !== undefined && dayCount(cap) === dayCount(policy.vacationDays + increment)) {
    return `Added once, after ${everyYears} years of employment, on 1 January.`
  }
  return `Added every ${everyYears} years of employment, on 1 January${ceiling}`
}

export type PolicyValidity = {
  label: string
  tone: 'active' | 'pending' | 'retiring' | 'retired'
}

/** Where a policy stands on `today`: in force, not started, retiring, gone. */
export function policyValidityLabel(
  policy: LeavePolicyDto,
  today: string,
): PolicyValidity {
  if (policy.effectiveTo && policy.effectiveTo < today) {
    return { label: `Retired ${formatDate(policy.effectiveTo)}`, tone: 'retired' }
  }
  if (policy.effectiveTo) {
    return {
      label: `Retires ${formatDate(policy.effectiveTo)}`,
      tone: 'retiring',
    }
  }
  if (policy.effectiveFrom > today) {
    return { label: `From ${formatDate(policy.effectiveFrom)}`, tone: 'pending' }
  }
  return { label: 'Active', tone: 'active' }
}

/**
 * The cutover minted one policy per distinct set of legacy per-person terms and
 * named them "Migrated {V}+{S}". The BackfillLeavePolicies migration identifies
 * its own rows by exactly this prefix, so this reads them the same way rather
 * than inventing a second rule.
 *
 * Feeds the counter that tells an admin how much cutover cleanup is left. The
 * rows themselves are not badged: the prefix is in the name, which is already
 * on screen, and a badge inferred from a name silently lies the moment someone
 * renames a policy.
 */
export function isMigrationPolicy(policy: LeavePolicyDto): boolean {
  return policy.name.startsWith('Migrated ')
}

/** '12 members' / '1 member, 2 scheduled' — the row's population line. */
export function policyMembershipSummary(policy: LeavePolicyDto): string {
  const members = `${policy.memberCount} member${policy.memberCount === 1 ? '' : 's'}`
  return policy.scheduledInCount > 0
    ? `${members}, ${policy.scheduledInCount} scheduled`
    : members
}

/**
 * Plain-language description of what each backdating mode does, for the radio
 * labels. The engine snaps a retroactive anchor to Jan 1 of the date's year
 * (floored at the hire date), so the applied date is shown, never assumed.
 */
export function transferModeCopy(
  mode: PolicyTransferMode,
  policyName: string,
  pickedDate: string,
  appliedFrom?: string,
): string {
  if (mode === 'retroactive') {
    const from = appliedFrom ?? pickedDate
    return `Recalculate as if "${policyName}" had applied from ${formatDate(from)}. Days already accrued are recomputed and the difference is posted now.`
  }
  return `Everything earned before ${formatDate(pickedDate)} stays as it was computed; "${policyName}" terms apply from that date on.`
}

/**
 * What the transfer would post, per leave type and year. Signed: a positive
 * delta grants days immediately, a negative one takes them back.
 */
export function adjustmentPreviewLines(
  adjustments: PolicyTransferAdjustmentDto[],
): string[] {
  return adjustments.map((adjustment) => {
    const verb = adjustment.delta >= 0 ? 'adds' : 'removes'
    const amount = formatDays(Math.abs(adjustment.delta))
    return `${formatLeaveType(adjustment.leaveType)} ${adjustment.year}: ${verb} ${amount} now; the annual total becomes ${formatDays(adjustment.newYearTotal)}.`
  })
}

const requestLine = (request: PolicyTransferRequestRefDto): string =>
  `${formatLeaveType(request.leaveType)} ${formatDate(request.startDate)} to ${formatDate(request.endDate)} (${formatDays(request.paidDays)} paid)`

/** Requests whose committed days the new terms cannot cover: these block. */
export function blockingRequestLines(
  requests: PolicyTransferRequestRefDto[],
): string[] {
  return requests.map(requestLine)
}

/**
 * Approved or pending PAID requests that fall inside the target policy's
 * probation window. Informational only: a frozen split stays paid, so these
 * warn the admin rather than block the move.
 */
export function probationWarningLines(
  requests: PolicyTransferRequestRefDto[],
): string[] {
  return requests.map(requestLine)
}

export type PolicyErrorDetails =
  | {
      kind: 'duplicatePolicy'
      message: string
      existingPolicyId: string
      existingPolicyName: string
    }
  | { kind: 'backdateOutOfRange'; message: string; earliestPermissibleDate: string }
  | { kind: 'policyInUse'; message: string }
  | { kind: 'plain'; message: string }

/**
 * Read the engine's structured refusals back into something a dialog can act
 * on: offering the existing twin, or a one-click re-submit from the earliest
 * date the backdate may reach.
 */
export function apiErrorDetails(error: unknown): PolicyErrorDetails {
  const message =
    error instanceof Error ? error.message : 'The request failed.'
  if (!(error instanceof ApiError)) {
    return { kind: 'plain', message }
  }
  const code = error.details['code']
  if (code === 'duplicate_policy_terms') {
    const existingPolicyId = error.details['existingPolicyId']
    const existingPolicyName = error.details['existingPolicyName']
    if (
      typeof existingPolicyId === 'string' &&
      typeof existingPolicyName === 'string'
    ) {
      return {
        kind: 'duplicatePolicy',
        message,
        existingPolicyId,
        existingPolicyName,
      }
    }
  }
  if (code === 'backdate_out_of_range') {
    const earliest = error.details['earliestPermissibleDate']
    if (typeof earliest === 'string') {
      return {
        kind: 'backdateOutOfRange',
        message,
        earliestPermissibleDate: earliest,
      }
    }
  }
  if (code === 'policy_in_use') {
    return { kind: 'policyInUse', message }
  }
  return { kind: 'plain', message }
}

export type MembershipTimelineRow = {
  membershipId: string
  policyName: string
  periodLabel: string
  superseded: boolean
  note?: string
}

/**
 * The profile panel's history list, newest first. A superseded row was erased
 * from resolution by a retroactive transfer but kept for the audit trail, so
 * it is rendered struck through rather than dropped.
 */
export function shapeMembershipTimeline(
  history: PolicyMembershipDto[],
): MembershipTimelineRow[] {
  return [...history]
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))
    .map((row) => ({
      membershipId: row.membershipId,
      policyName: row.policyName,
      periodLabel: row.effectiveTo
        ? `${formatDate(row.effectiveFrom)} to ${formatDate(row.effectiveTo)}`
        : `From ${formatDate(row.effectiveFrom)}`,
      superseded: row.superseded,
      ...(row.note ? { note: row.note } : {}),
    }))
}

/** The one-line status the profile panel leads with. */
export function currentPolicyLine(policy: EmployeePolicyDto): string {
  return `${policy.current.policyName}, since ${formatDate(policy.current.effectiveFrom)}`
}

/** 'Transfer to "X" scheduled for 1 Sep 2026' — the pending-move line. */
export function scheduledTransferLine(
  policy: EmployeePolicyDto,
): string | null {
  if (!policy.scheduled) {
    return null
  }
  return `Transfer to "${policy.scheduled.policyName}" scheduled for ${formatDate(policy.scheduled.effectiveFrom)}`
}

/** The probation line while the window is still running. */
export function probationLine(policy: EmployeePolicyDto): string | null {
  if (!policy.probation?.active) {
    return null
  }
  return `On probation until ${formatDate(policy.probation.endsOn)}; leave taken before then is unpaid.`
}

// ————————————————————— member management —————————————————————

/** 'Member since 15 Jul 2026' — where the current membership began. */
export function memberSinceLabel(policySince: string | undefined): string {
  return policySince ? `Member since ${formatDate(policySince)}` : 'Member'
}

/** The pending-move pill on a member row, absent when nothing is scheduled. */
export function scheduledDepartureLabel(
  scheduled: { policyName: string; effectiveFrom: string } | undefined,
): string | null {
  return scheduled
    ? `Leaves for ${scheduled.policyName} on ${formatDate(scheduled.effectiveFrom)}`
    : null
}

/** The probation pill on a member row, absent once the window has passed. */
export function probationMemberLabel(
  probationEndsOn: string | undefined,
): string | null {
  return probationEndsOn
    ? `On probation to ${formatDate(probationEndsOn)}`
    : null
}

/**
 * What picking this effective date means, in the admin's words. The engine
 * accepts all three tenses and each behaves differently, so the dialog says
 * which one is about to happen rather than letting the date imply it.
 */
export function effectiveDateHint(effectiveDate: string, today: string): string {
  if (effectiveDate > today) {
    return `Nothing changes until ${formatDate(effectiveDate)}. The move is recorded now and applies itself on that date.`
  }
  if (effectiveDate === today) {
    return 'The new terms take effect today. Rates change on month boundaries, so the current month follows the half-month rule.'
  }
  return 'This date is in the past, so choose what happens to the days already accrued.'
}

export type BatchPreflightEntry = {
  employeeId: string
  displayName: string
  feasible: boolean
  blockingRequests: PolicyTransferRequestRefDto[]
  probationWarnings: PolicyTransferRequestRefDto[]
  /**
   * The server's own words, when the dry run was REFUSED rather than answered.
   * A refusal has a specific cause (an unreachable mode, a backdate outside the
   * permitted range) that the client cannot re-derive, so it must be carried
   * rather than guessed.
   */
  refusal?: string
}

export type BatchPreflightSummary = {
  movable: number
  blocked: number
  headline: string
  blockedLines: string[]
  warningLines: string[]
}

/**
 * Fold per-employee dry runs into what the dialog states before the write.
 * Each employee is checked on their own because the committed-days guard is
 * per-person: a batch is not all-or-nothing, and pretending otherwise would
 * either block the many for the few or hide the refusals.
 */
/**
 * Who the transfer dialog starts with ticked.
 *
 * 'add' offers the directory, so picking is the whole point and nothing starts
 * ticked. 'move' arrives from the member list where the choice was already
 * made, so re-asking would mean selecting the same people twice -- and with a
 * single member there was nothing on screen to tick, which left the confirm
 * button permanently dead.
 */
export function initialTransferSelection(
  intent: 'add' | 'move',
  employeeIds: string[],
): string[] {
  return intent === 'move' ? [...employeeIds] : []
}

/** "The prospective mode..." -> "the prospective mode..." after a colon. */
function lowerFirst(sentence: string): string {
  // Only a plain capital is lowered: an identifier or an acronym opening the
  // sentence must survive intact.
  return /^[A-Z][a-z]/.test(sentence)
    ? sentence[0]!.toLowerCase() + sentence.slice(1)
    : sentence
}

export function batchPreflightSummary(
  entries: BatchPreflightEntry[],
): BatchPreflightSummary {
  const blocked = entries.filter((entry) => !entry.feasible)
  const movable = entries.length - blocked.length
  // Two different refusals wear the same flag on the wire (feasible: false with
  // no blocking requests means the balance itself does not survive the move),
  // and the dialog used to print "resolve those requests" for both. On a
  // downgrade that names requests which do not exist and asks for an action
  // that cannot be taken.
  const blockedLines = blocked.map((entry) => {
    // The server said why: repeat it rather than inventing a reason. Guessing
    // here once produced "they have already used more days than the new terms
    // grant" for a refusal that was actually about the transfer mode.
    if (entry.refusal) {
      return `${entry.displayName} cannot move: ${lowerFirst(entry.refusal)}`
    }
    const first = entry.blockingRequests[0]
    if (!first) {
      return (
        `${entry.displayName} cannot move: they have already used more days ` +
        `than the new terms grant for this year. Schedule this move for January 1.`
      )
    }
    return (
      `${entry.displayName} cannot move: holds ${formatDays(first.paidDays)} paid ` +
      `from ${formatDate(first.startDate)}. Resolve those requests, or ` +
      `schedule this move for January 1.`
    )
  })
  const warningLines = entries
    .filter((entry) => entry.probationWarnings.length > 0)
    .map(
      (entry) =>
        `${entry.displayName} has ${entry.probationWarnings.length} paid request(s) inside the new probation window; already approved days stay paid.`,
    )
  const headline = blocked.length
    ? `${movable} will move, ${blocked.length} blocked`
    : `${movable} will move`
  return {
    movable,
    blocked: blocked.length,
    headline,
    blockedLines,
    warningLines,
  }
}

export type MoveOutcome = { displayName: string; error?: string }

/**
 * The honest report of a partial batch: the refused keep their policy, and
 * saying so is the difference between a failure the admin can act on and one
 * they discover later in the balances.
 */
export function moveResultSummary(
  outcomes: MoveOutcome[],
  targetPolicyName: string,
): { headline: string; detail: string; failures: string[] } {
  const failures = outcomes.filter((outcome) => outcome.error)
  const moved = outcomes.length - failures.length
  return {
    headline: failures.length
      ? `${moved} moved to ${targetPolicyName}, ${failures.length} refused`
      : `${moved} moved to ${targetPolicyName}`,
    detail: failures.length
      ? 'The refused employees keep their current policy. Each holds more committed paid days than the new terms allow, which the engine will not overwrite silently.'
      : 'Every selected employee is on the new policy. Their balances were re-anchored in one step and the change is in the audit trail.',
    failures: failures.map(
      (outcome) => `${outcome.displayName}: ${outcome.error ?? 'refused'}`,
    ),
  }
}
