/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { policyTermsFingerprint, roundPolicyTerm } from './policy-fingerprint'
import type { LeavePolicyTerms } from './policy-fingerprint'
import { roundDays } from './day-math'

const baseTerms: LeavePolicyTerms = {
  vacationDays: 25,
  sickDays: 5,
  vacationAnnualIncrement: 0,
  vacationIncrementEveryYears: 1,
  vacationIncrementCapDays: null,
  probationMonths: 0,
  paidSickDuringProbation: false,
}

describe('policyTermsFingerprint', () => {
  it('renders the canonical readable form', () => {
    expect(policyTermsFingerprint(baseTerms)).toBe(
      'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
    )
  })

  it('canonicalizes numeric noise so 25, 25.0 and 25.004 collide', () => {
    const canonical = policyTermsFingerprint(baseTerms)
    expect(policyTermsFingerprint({ ...baseTerms, vacationDays: 25.0 })).toBe(
      canonical,
    )
    // 25.004 rounds to 25.00 under the fingerprint's own two-decimal quantum
    // (the books keep three decimals, so they would tell these two apart).
    expect(policyTermsFingerprint({ ...baseTerms, vacationDays: 25.004 })).toBe(
      canonical,
    )
    // 25.005 rounds up — a genuinely different (if odd) deal must not collide.
    expect(
      policyTermsFingerprint({ ...baseTerms, vacationDays: 25.005 }),
    ).not.toBe(canonical)
  })

  // The fingerprint is a policy's identity, so a term may never be STORED finer
  // than it is fingerprinted: two offers that round to one fingerprint but to
  // two different stored figures would share an identity, and the import would
  // enrol the second employee in the first one's policy. roundPolicyTerm is what
  // every writer of a term must round with; the books' roundDays is finer and
  // would break that.
  it('quantizes a term exactly as coarsely as the fingerprint reads it', () => {
    for (const value of [25, 25.0, 25.004, 25.005, 20.8334, 20.8339, 0.125]) {
      const stored = roundPolicyTerm(value)
      expect(
        policyTermsFingerprint({ ...baseTerms, vacationDays: value }),
      ).toBe(policyTermsFingerprint({ ...baseTerms, vacationDays: stored }))
      expect(roundPolicyTerm(stored)).toBe(stored)
    }
    // Two prorated spreadsheet norms that share a fingerprint must also share
    // the figure that gets stored, or the identity would be a lie.
    expect(roundPolicyTerm(20.8334)).toBe(roundPolicyTerm(20.8339))
    expect(roundDays(20.8334)).not.toBe(roundDays(20.8339))
  })

  it('renders a set increment cap with two decimals and null as none', () => {
    expect(
      policyTermsFingerprint({
        ...baseTerms,
        vacationAnnualIncrement: 2,
        vacationIncrementCapDays: 35,
      }),
    ).toBe('v=25.00;s=5.00;vi=2.00;vc=35.00;p=0;ps=0')
  })

  it('distinguishes the paid-sick-during-probation flag', () => {
    const withProbation = policyTermsFingerprint({
      ...baseTerms,
      probationMonths: 3,
    })
    const withPaidSick = policyTermsFingerprint({
      ...baseTerms,
      probationMonths: 3,
      paidSickDuringProbation: true,
    })
    expect(withProbation).toBe('v=25.00;s=5.00;vi=0.00;vc=none;p=3;ps=0')
    expect(withPaidSick).toBe('v=25.00;s=5.00;vi=0.00;vc=none;p=3;ps=1')
    expect(withPaidSick).not.toBe(withProbation)
  })

  it('renders probation months as a plain integer', () => {
    expect(
      policyTermsFingerprint({ ...baseTerms, probationMonths: 6 }),
    ).toContain(';p=6;')
  })

  it('supports the zero-allowance deal (0 vacation, 0 sick)', () => {
    expect(
      policyTermsFingerprint({ ...baseTerms, vacationDays: 0, sickDays: 0 }),
    ).toBe('v=0.00;s=0.00;vi=0.00;vc=none;p=0;ps=0')
  })

  // Fingerprints are write-once and already stored: in leave_policies rows and
  // as SQL literals inside a committed backfill migration that can never be
  // edited. Every one of them means "every year", so period 1 must render the
  // six-component string it always did, byte for byte, suffix included.
  it('renders period 1 exactly as before the period existed', () => {
    const everyYear = { ...baseTerms, vacationIncrementEveryYears: 1 }
    expect(policyTermsFingerprint(everyYear)).toBe(
      'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
    )
    // The literal suffix the backfill migration concatenates onto the settings
    // figures (1785447000000-BackfillLeavePolicies.ts, four places).
    expect(policyTermsFingerprint(everyYear)).toMatch(
      /;vi=0\.00;vc=none;p=0;ps=0$/,
    )
    expect(
      policyTermsFingerprint({
        ...everyYear,
        vacationAnnualIncrement: 2,
        vacationIncrementCapDays: 35,
        probationMonths: 3,
        paidSickDuringProbation: true,
      }),
    ).toBe('v=25.00;s=5.00;vi=2.00;vc=35.00;p=3;ps=1')
  })

  it('appends the period as a trailing component above 1', () => {
    expect(
      policyTermsFingerprint({
        ...baseTerms,
        vacationAnnualIncrement: 5,
        vacationIncrementEveryYears: 3,
        vacationIncrementCapDays: 30,
      }),
    ).toBe('v=25.00;s=5.00;vi=5.00;vc=30.00;p=0;ps=0;vy=3')
  })

  it('tells two periods apart, and both apart from every year', () => {
    const withPeriod = (years: number): string =>
      policyTermsFingerprint({
        ...baseTerms,
        vacationAnnualIncrement: 5,
        vacationIncrementEveryYears: years,
      })
    expect(new Set([withPeriod(1), withPeriod(2), withPeriod(3)]).size).toBe(3)
    expect(withPeriod(1)).not.toContain('vy=')
  })
})
