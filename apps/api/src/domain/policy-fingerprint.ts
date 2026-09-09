/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The behavior-bearing term fields of a leave policy. Everything else on a
// policy (name, description, validity window, default flag) is scheduling or
// presentation metadata and deliberately outside the fingerprint: two policies
// with identical DEALS collide even when they differ in name or era, and an
// expired twin never blocks re-introducing old terms (that check is on the
// caller, not in here).
export interface LeavePolicyTerms {
  vacationDays: number
  sickDays: number
  vacationAnnualIncrement: number
  // How many years of employment separate two increment steps; 1 = every year.
  // A period above 1 is only meaningful with a non-zero increment, so the
  // writer coerces it back to 1 when the increment is 0 (see
  // normalizePolicyTerms). An inert period left standing would give two
  // behaviorally identical deals distinct fingerprints.
  vacationIncrementEveryYears: number
  vacationIncrementCapDays: number | null
  probationMonths: number
  paidSickDuringProbation: boolean
}

// THE quantum a policy term is held to, and deliberately NOT the books'
// (roundDays, three decimals since leave became bookable by the hour):
// fingerprints already sit in leave_policies rows and in the SQL of a committed
// backfill migration that can never be edited, so following the books to a finer
// quantum would make identical terms fingerprint differently than the stored
// rows and the duplicate-terms check would start minting twins. A policy is an
// annual offer, not an hourly booking.
//
// Every writer of a term must round with this, not with roundDays: a term
// stored finer than it is fingerprinted would let two different offers share one
// identity, which is the one thing the fingerprint exists to prevent.
export function roundPolicyTerm(value: number): number {
  return Math.round(value * 100) / 100
}

// Canonical READABLE fingerprint of a policy's terms — readable beats hashed
// for debugging:
//   v=25.00;s=5.00;vi=2.00;vc=none;p=3;ps=0
//   v=25.00;s=5.00;vi=5.00;vc=30.00;p=0;ps=0;vy=3   (a rise every 3 years)
// Day numbers are quantized to two decimals, so 25, 25.0 and 25.004 all
// canonicalize to '25.00'. Computed server-side at policy creation, never
// trusted from the client, and write-once because terms are immutable.
//
// The increment PERIOD is appended last and only when it is above 1. Existing
// fingerprints are not recomputable: they sit in leave_policies rows and are
// hardcoded as SQL literals in a committed backfill migration, so the
// every-year default has to render byte-identically to the six-component form
// it always did. Worst case the string is 57 characters against varchar(160).
export function policyTermsFingerprint(terms: LeavePolicyTerms): string {
  const days = (value: number): string => roundPolicyTerm(value).toFixed(2)
  const cap =
    terms.vacationIncrementCapDays === null
      ? 'none'
      : days(terms.vacationIncrementCapDays)
  const everyYears = Math.trunc(terms.vacationIncrementEveryYears)
  return [
    `v=${days(terms.vacationDays)}`,
    `s=${days(terms.sickDays)}`,
    `vi=${days(terms.vacationAnnualIncrement)}`,
    `vc=${cap}`,
    `p=${Math.trunc(terms.probationMonths)}`,
    `ps=${terms.paidSickDuringProbation ? 1 : 0}`,
    ...(everyYears > 1 ? [`vy=${everyYears}`] : []),
  ].join(';')
}
