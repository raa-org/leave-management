/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveType } from '@workspace/contracts'
import { effectiveHireMonth, roundDays } from './day-math'

// The policy engine's pure resolution core: turns a user's policy membership
// timeline into per-month rate segments for one calendar year, and computes
// the cumulative accrual target from them. Deliberately entity-free — callers
// adapt rows to the flat inputs below, so every formula here is unit-testable
// without a database.

// The behavior-bearing terms of one policy, plus identity for provenance.
export interface PolicyTermsInput {
  policyId: string
  name: string
  vacationDays: number
  sickDays: number
  // +N vacation days every `vacationIncrementEveryYears` calendar years of
  // employment; steps anchor to the hire YEAR (a transfer never resets
  // seniority progression).
  vacationAnnualIncrement: number
  // Years between two steps, at least 1. Never 0: it divides.
  vacationIncrementEveryYears: number
  vacationIncrementCapDays: number | null
}

// One live membership row, half-open [effectiveFrom, effectiveTo).
export interface MembershipRowInput {
  policyId: string
  effectiveFrom: string
  effectiveTo: string | null
  supersededByRowId: string | null
}

export interface PolicyScheduleSegment {
  policyId: string
  policyName: string
  // Annual figures for THIS year (vacation increment already applied); the
  // month range [firstMonth, lastMonth] this policy owns, 1..12 inclusive.
  vacationRate: number
  sickBase: number
  firstMonth: number
  lastMonth: number
}

export interface PolicyYearSchedule {
  // Ordered, contiguous, covering months 1..12 exactly.
  segments: PolicyScheduleSegment[]
  changedDuringYear: boolean
}

// The vacation allowance a policy grants for calendar year `year`: base plus
// one increment per COMPLETED period of `vacationIncrementEveryYears`
// employment years, capped. Steps anchor to the hire YEAR and land on 1
// January, not on the hire anniversary (calendar-year granularity: the hire
// year itself is already prorated by months via the half-month rule, so the
// short first year needs no special case).
//
// Three constraints this formula must not lose:
// - The elapsed years are clamped BEFORE the division. Dividing first gives a
//   future hire date negative steps, and a negative allowance goes straight
//   into leave_allocations.totalDays.
// - A null hire date yields steps 0 without entering the arithmetic, which
//   would reach the same column as NaN. Such profiles are PendingSetup and
//   cannot accrue anyway.
// - The period floors at 1 because it divides. The writer already refuses 0,
//   so this only covers a row that never passed through it.
export function vacationRateForYear(
  terms: PolicyTermsInput,
  hireYear: number | null,
  year: number,
): number {
  const everyYears = Math.max(1, Math.trunc(terms.vacationIncrementEveryYears))
  const steps =
    hireYear === null ? 0 : Math.floor(Math.max(0, year - hireYear) / everyYears)
  const grown = terms.vacationDays + terms.vacationAnnualIncrement * steps
  const capped =
    terms.vacationIncrementCapDays === null
      ? grown
      : Math.min(grown, terms.vacationIncrementCapDays)
  return roundDays(capped)
}

// Derive the year's ownership segments from the membership timeline.
// Returns null for an empty timeline — the caller falls back to the
// pre-engine legacy resolution.
//
// Rules, in order:
// - Only LIVE rows resolve (supersededByRowId IS NULL); superseded rows are
//   audit history a retroactive backdate erased.
// - The EARLIEST live row extends backward in time: any instant before its
//   effectiveFrom belongs to it (covers the bootstrap cutover and the
//   provisioning race where the hire date precedes the first membership row).
// - Every later row's ownership starts at the month its effectiveFrom snaps
//   to under the half-month rule (the same rule that slices a hire month), or
//   month 1 of a later year. A snap to month 13 owns nothing this year.
// - Two boundaries snapping into the same month: the LATER effectiveFrom wins
//   the month (its predecessor owns zero months there).
// - effectiveTo is deliberately ignored: the live timeline is contiguous by
//   construction (a close is always paired with a successor), so ownership is
//   decided purely by successor starts.
export function deriveYearSchedule(
  year: number,
  timeline: MembershipRowInput[],
  policiesById: Map<string, PolicyTermsInput>,
  employmentStartDate: string | null,
): PolicyYearSchedule | null {
  const live = timeline
    .filter((row) => row.supersededByRowId === null)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))
  if (live.length === 0) {
    return null
  }
  const hireYear =
    employmentStartDate === null
      ? null
      : Number.parseInt(employmentStartDate.slice(0, 4), 10)

  // Ownership start month of each live row within `year`; rows are sorted by
  // effectiveFrom, so a later row overrides earlier ones from its start month
  // on — which also implements the same-month tie rule for free.
  const startMonthOf = (row: MembershipRowInput, index: number): number => {
    if (index === 0) {
      // The earliest row extends backward in time: every month (and year)
      // before its effectiveFrom resolves to it.
      return 1
    }
    const fromYear = Number.parseInt(row.effectiveFrom.slice(0, 4), 10)
    if (fromYear < year) {
      return 1
    }
    if (fromYear > year) {
      return 13
    }
    return effectiveHireMonth(year, row.effectiveFrom)
  }

  const ownerByMonth: MembershipRowInput[] = []
  for (let month = 1; month <= 12; month++) {
    let owner = live[0]!
    live.forEach((row, index) => {
      if (startMonthOf(row, index) <= month) {
        owner = row
      }
    })
    ownerByMonth[month] = owner
  }

  const segments: PolicyScheduleSegment[] = []
  for (let month = 1; month <= 12; month++) {
    const owner = ownerByMonth[month]!
    const terms = policiesById.get(owner.policyId)
    if (!terms) {
      throw new Error(
        `Policy ${owner.policyId} referenced by a membership row is not loaded`,
      )
    }
    const last = segments[segments.length - 1]
    if (last && last.policyId === terms.policyId) {
      last.lastMonth = month
      continue
    }
    segments.push({
      policyId: terms.policyId,
      policyName: terms.name,
      vacationRate: vacationRateForYear(terms, hireYear, year),
      sickBase: roundDays(terms.sickDays),
      firstMonth: month,
      lastMonth: month,
    })
  }
  return { segments, changedDuringYear: segments.length > 1 }
}

// A pre-engine scalar allocation expressed as a single-segment schedule, so
// the target formula has exactly one shape. Per-leave-type: the scalar is the
// one allocation row's totalDays, valid for whichever type the caller computes.
export function legacyScheduleFromTotal(totalDays: number): PolicyYearSchedule {
  return {
    segments: [
      {
        policyId: '',
        policyName: '',
        vacationRate: totalDays,
        sickBase: totalDays,
        firstMonth: 1,
        lastMonth: 12,
      },
    ],
    changedDuringYear: false,
  }
}

// The cumulative days a leave year should have accrued by its m-th employed
// month — THE single accrual target formula. Every consumer (the monthly
// accrual loop, every re-anchor, and the forward projection) must agree on it,
// or the ledger oscillates; carryover is added ON TOP (never folded into the
// comparison), so it neither suppresses monthly accrual nor gets wiped by
// re-anchoring.
//
// Vacation earns per month at the owning segment's annual rate / 12; the sum
// is rounded ONCE at the cumulative level (grouped products, one division), so
// a single-segment year computes literally roundDays(rate*m/12) — the same shape
// as the pre-engine scalar formula — and the remainder is spread across
// segments rather than lost at a boundary.
//
// Sick is one up-front tranche, hire-prorated, sized by the segment owning the
// m-th employed month. Ratchet by construction: the accrual loop only moves
// up (delta <= 0 writes nothing), so a mid-year DOWNGRADE leaves the granted
// tranche untouched until Jan 1 (the owner's decision), while an UPGRADE
// tops the tranche up lazily when the loop passes the boundary month.
export function pieceTargetDays(
  leaveType: LeaveType,
  schedule: PolicyYearSchedule,
  carriedOverDays: number,
  hireMonth: number,
  months: number,
  // Sticky admin correction for this leave year (vacation only in practice).
  // Added on top of earned + carry so monthly accrual neither undoes a debit
  // nor swallows a credit; year rollover leaves the field behind and
  // materializes residual accrued via carryover policy instead.
  manualAdjustmentDays = 0,
): number {
  // TODO(carryover): months <= 0 zeroes the target INCLUDING carriedOverDays.
  // That covers "not yet employed this year" and the half-month rule's waiting
  // period. Once a start-date re-anchor can move a hire later within a year
  // that already carried days in, this would wipe them — decide the policy
  // then (note carried over from the pre-engine scalar formula).
  //
  // Manual adjustments are preserved at months <= 0 so a rare early-year
  // credit/debit already booked is not erased by the guard; carried over
  // remains zeroed for the dormant pre-employment path.
  if (months <= 0) {
    return roundDays(manualAdjustmentDays)
  }
  const lastEmployedMonth = Math.min(hireMonth + months - 1, 12)
  let earned: number
  if (leaveType === LeaveType.Sick) {
    const owner = schedule.segments.find(
      (segment) =>
        segment.firstMonth <= lastEmployedMonth &&
        lastEmployedMonth <= segment.lastMonth,
    )
    earned = roundDays(((owner?.sickBase ?? 0) * (13 - hireMonth)) / 12)
  } else {
    let weighted = 0
    for (const segment of schedule.segments) {
      const from = Math.max(segment.firstMonth, hireMonth)
      const to = Math.min(segment.lastMonth, lastEmployedMonth)
      if (to >= from) {
        weighted += segment.vacationRate * (to - from + 1)
      }
    }
    earned = roundDays(weighted / 12)
  }
  return roundDays(earned + carriedOverDays + manualAdjustmentDays)
}

// The year-end annual figure for the display denominator and the allocation
// cache: vacation is the full-calendar-year weighted total (matches no single
// policy in a blended year — LeaveBalanceDto.policyChangedDuringYear labels
// that); sick is the December owner's allowance.
export function scheduleYearEndTotal(
  leaveType: LeaveType,
  schedule: PolicyYearSchedule,
): number {
  const december = schedule.segments[schedule.segments.length - 1]!
  if (leaveType === LeaveType.Sick) {
    return roundDays(december.sickBase)
  }
  let weighted = 0
  for (const segment of schedule.segments) {
    weighted += segment.vacationRate * (segment.lastMonth - segment.firstMonth + 1)
  }
  return roundDays(weighted / 12)
}

// The denominator the percent_of_total carryover cap is a share OF: the
// year-end accrual target the employee can actually reach — pieceTargetDays
// from their effective hire month through December, manual adjustments
// included, carryover-in excluded (carried days are last year's leftover, not
// this year's entitlement, and must not compound the next ceiling).
//
// This is deliberately the SAME formula the accrual engine targets, not
// scheduleYearEndTotal times an employed-months ratio: a blended hire year
// (probation policy handing over to a standard one mid-year) weights only the
// months from the hire month on, so the base equals what those months really
// grant. For a full-year employee it is bit-identical to scheduleYearEndTotal,
// so nothing moves for anyone hired in a prior year.
//
// The hire month obeys the half-month rule (effectiveHireMonth): a month
// counts only when at least half of it was worked. A second-half-December
// hire (or a null/future anchor, which the year close never passes but the
// projection fold may) lands on months 0, where the base folds to the manual
// adjustment alone — matching pieceTargetDays' own months<=0 semantics.
//
// Anchor-sensitive by design: the base reads the anchor as of the moment it
// runs, exactly like the accrual target. A start-date correction made before
// a year's lazy close therefore moves that year's ceiling along with its
// accrual, never independently of it.
export function carryoverCapBaseDays(
  leaveType: LeaveType,
  schedule: PolicyYearSchedule,
  year: number,
  anchor: string | null,
  manualAdjustmentDays: number,
): number {
  const anchorYear =
    anchor === null ? null : Number.parseInt(anchor.slice(0, 4), 10)
  const hireMonth =
    anchorYear === null || anchorYear > year
      ? 13
      : anchorYear === year
        ? effectiveHireMonth(year, anchor!)
        : 1
  return pieceTargetDays(
    leaveType,
    schedule,
    0,
    hireMonth,
    Math.max(0, 13 - hireMonth),
    manualAdjustmentDays,
  )
}
