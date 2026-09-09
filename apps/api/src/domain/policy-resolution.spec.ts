/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { policyTermsFingerprint, type LeavePolicyTerms } from './policy-fingerprint'
import {
  describePolicyTermsMismatch,
  firstFreePolicyName,
  policyCatalogEntry,
  quantizePolicyTerms,
  resolvePolicy,
  suggestPolicyName,
  type PolicyCatalogEntry,
  type PolicyResolution,
  type PolicyResolutionRequest,
} from './policy-resolution'

// The one decision both sides of an import make: which policy a row lands on.
// Pure, so this spec needs no database, and every case here is a case the apply
// really produces (the rule order mirrors findOrCreatePolicyByTermsTx and the
// twin check inside createPolicyTx).

const terms = (overrides: Partial<LeavePolicyTerms> = {}): LeavePolicyTerms => ({
  vacationDays: 25,
  sickDays: 5,
  vacationAnnualIncrement: 0,
  vacationIncrementEveryYears: 1,
  vacationIncrementCapDays: null,
  probationMonths: 0,
  paidSickDuringProbation: false,
  ...overrides,
})

const entry = (
  overrides: Partial<PolicyCatalogEntry> = {},
): PolicyCatalogEntry => {
  const entryTerms = overrides.terms ?? terms()
  return {
    policyId: 'p-standard',
    name: 'Standard UA',
    terms: entryTerms,
    termsFingerprint: policyTermsFingerprint(entryTerms),
    effectiveTo: null,
    ...overrides,
  }
}

const request = (
  overrides: Partial<PolicyResolutionRequest> = {},
): PolicyResolutionRequest => ({
  terms: terms(),
  effectiveFrom: '2020-03-02',
  ...overrides,
})

const STANDARD = entry()
const SENIOR = entry({
  policyId: 'p-senior',
  name: 'Senior UA',
  terms: terms({ vacationDays: 28 }),
})

describe('resolvePolicy', () => {
  const table: {
    outcome: string
    request: PolicyResolutionRequest
    catalog: PolicyCatalogEntry[]
    expected: Partial<PolicyResolution>
  }[] = [
    {
      outcome: 'join-by-name: the file names a policy the catalog holds',
      request: request({ fileName: 'Senior UA' }),
      catalog: [STANDARD, SENIOR],
      expected: {
        kind: 'join-by-name',
        policyId: 'p-senior',
        policyName: 'Senior UA',
        retired: false,
      },
    },
    {
      outcome: 'join-by-terms: nobody named it and the terms are in force',
      request: request(),
      catalog: [STANDARD, SENIOR],
      expected: {
        kind: 'join-by-terms',
        policyId: 'p-standard',
        policyName: 'Standard UA',
        retired: false,
      },
    },
    {
      outcome: 'mint-file-name: the file names a policy the catalog lacks',
      request: request({
        fileName: 'Contractors',
        terms: terms({ vacationDays: 20 }),
      }),
      catalog: [STANDARD, SENIOR],
      expected: {
        kind: 'mint-file-name',
        plannedName: 'Contractors',
        nameBase: 'Contractors',
      },
    },
    {
      outcome: 'mint-derived-name: nothing names it and the terms are new',
      request: request({ terms: terms({ vacationDays: 20 }) }),
      catalog: [STANDARD, SENIOR],
      expected: {
        kind: 'mint-derived-name',
        plannedName: 'Imported 20+5',
        nameBase: 'Imported 20+5',
      },
    },
  ]

  for (const row of table) {
    it(`resolves ${row.outcome}`, () => {
      expect(resolvePolicy(row.request, row.catalog)).toMatchObject(row.expected)
    })
  }

  it('drops a file name the catalog lacks onto the live twin its terms point at', () => {
    // The discrepancy nobody had noticed: the apply joins the twin and the name
    // the file states is lost in silence. Stated here so the preview can say
    // "Standard UA takes them" instead of promising a "Contractors".
    const resolution = resolvePolicy(request({ fileName: 'Contractors' }), [
      STANDARD,
    ])

    expect(resolution).toMatchObject({
      kind: 'join-by-terms',
      policyId: 'p-standard',
      policyName: 'Standard UA',
    })
  })

  it('matches the file name case-insensitively and ignores the era', () => {
    const retired = entry({
      policyId: 'p-old',
      name: 'Legacy UA',
      effectiveTo: '2024-12-31',
    })

    expect(
      resolvePolicy(request({ fileName: '  legacy ua ' }), [retired]),
    ).toMatchObject({
      kind: 'join-by-name',
      policyId: 'p-old',
      policyName: 'Legacy UA',
      // Carried rather than filtered away: the enrollment will refuse a retired
      // policy, so the operator has to be told before the run starts.
      retired: true,
    })
  })

  it('names every term the file states differently from the policy it asks for', () => {
    const resolution = resolvePolicy(
      request({
        fileName: 'Senior UA',
        terms: terms({ vacationDays: 25, probationMonths: 3 }),
      }),
      [SENIOR],
    )

    expect(resolution.kind).toBe('join-by-name')
    if (resolution.kind !== 'join-by-name') {
      return
    }
    expect(resolution.termsMismatch?.differing).toEqual([
      'vacationDays',
      'probationMonths',
    ])
    // The card and the books follow the CATALOG, so the terms handed back are
    // its own, not the ones the row stated.
    expect(resolution.terms.vacationDays).toBe(28)
  })

  it('reports no mismatch when the row states the very terms the policy holds', () => {
    const resolution = resolvePolicy(
      request({ fileName: 'Standard UA' }),
      [STANDARD],
    )

    expect(resolution).toMatchObject({ kind: 'join-by-name', retired: false })
    expect(
      resolution.kind === 'join-by-name' ? resolution.termsMismatch : 'unset',
    ).toBeUndefined()
  })

  it('joins an expired twin whose window still covers the hire date', () => {
    // The first retired tier: createPolicyTx refuses to mint around this twin,
    // so the apply sits on it. The preview has to say so, because the
    // enrollment then refuses the employee.
    const expired = entry({
      policyId: 'p-expired',
      name: 'Standard UA 2024',
      effectiveTo: '2024-12-31',
    })

    expect(
      resolvePolicy(request({ effectiveFrom: '2024-06-01' }), [expired]),
    ).toMatchObject({
      kind: 'join-by-terms',
      policyId: 'p-expired',
      retired: true,
    })
  })

  it('mints freely when the expired twin closed before the hire date', () => {
    // The second retired tier: re-introducing an era's terms is legitimate once
    // its window is behind the day the new policy would start.
    const expired = entry({
      policyId: 'p-expired',
      name: 'Standard UA 2024',
      effectiveTo: '2024-12-31',
    })

    expect(
      resolvePolicy(request({ effectiveFrom: '2025-01-01' }), [expired]),
    ).toMatchObject({
      kind: 'mint-derived-name',
      plannedName: 'Imported 25+5',
    })
  })

  it('prefers the policy in force to an expired twin, whatever the catalog order', () => {
    const expired = entry({
      policyId: 'p-expired',
      name: 'Standard UA 2024',
      effectiveTo: '2099-12-31',
    })

    for (const catalog of [
      [expired, STANDARD],
      [STANDARD, expired],
    ]) {
      expect(resolvePolicy(request(), catalog)).toMatchObject({
        kind: 'join-by-terms',
        policyId: 'p-standard',
        retired: false,
      })
    }
  })

  it('picks the same expired twin however the catalog arrives', () => {
    // Both readers used to scan an unordered find(), so with two expired twins
    // the winner was whichever row the database returned first. Latest closed
    // window wins, and the id breaks a tie.
    const older = entry({
      policyId: 'p-b',
      name: 'Standard 2022',
      effectiveTo: '2023-12-31',
    })
    const newer = entry({
      policyId: 'p-c',
      name: 'Standard 2023',
      effectiveTo: '2024-12-31',
    })
    const sameDay = entry({
      policyId: 'p-a',
      name: 'Standard 2023 bis',
      effectiveTo: '2024-12-31',
    })

    for (const catalog of [
      [older, newer, sameDay],
      [sameDay, older, newer],
      [newer, sameDay, older],
    ]) {
      expect(
        resolvePolicy(request({ effectiveFrom: '2020-03-02' }), catalog),
      ).toMatchObject({ kind: 'join-by-terms', policyId: 'p-a', retired: true })
    }
  })

  it('numbers a minted name that the catalog already carries', () => {
    const taken = entry({
      policyId: 'p-taken',
      name: 'imported 25+5',
      terms: terms({ vacationDays: 28, sickDays: 8 }),
    })

    expect(resolvePolicy(request(), [taken])).toMatchObject({
      kind: 'mint-derived-name',
      plannedName: 'Imported 25+5 (2)',
      nameBase: 'Imported 25+5',
    })
  })

  it('climbs the ladder past every rung already taken, retired ones included', () => {
    // The catalog demands unique names whatever the era, so a retired rung
    // occupies its name exactly as a live one does. A name the FILE states
    // never reaches the ladder: were it taken, the name rule above would have
    // joined that policy instead.
    const rungs = ['Contractors', 'Contractors (2)'].map((name, index) =>
      entry({
        policyId: `p-${index}`,
        name,
        terms: terms({ vacationDays: 10 + index }),
        effectiveTo: '2024-12-31',
      }),
    )

    expect(
      resolvePolicy(
        request({ chosenName: 'Contractors', terms: terms({ vacationDays: 20 }) }),
        rungs,
      ),
    ).toMatchObject({
      kind: 'mint-derived-name',
      plannedName: 'Contractors (3)',
      nameBase: 'Contractors',
    })
  })

  it('takes the operator name only for a row the file left unnamed', () => {
    expect(
      resolvePolicy(
        request({ chosenName: 'Contractors', terms: terms({ vacationDays: 20 }) }),
        [],
      ),
    ).toMatchObject({ kind: 'mint-derived-name', plannedName: 'Contractors' })

    expect(
      resolvePolicy(
        request({
          fileName: 'Field staff',
          chosenName: 'Contractors',
          terms: terms({ vacationDays: 20 }),
        }),
        [],
      ),
    ).toMatchObject({ kind: 'mint-file-name', plannedName: 'Field staff' })
  })

  it('quantizes the row terms, so a cell of 24.999 is the same offer as 25', () => {
    expect(
      resolvePolicy(request({ terms: terms({ vacationDays: 24.999 }) }), [
        STANDARD,
      ]),
    ).toMatchObject({ kind: 'join-by-terms', policyId: 'p-standard' })
  })

  it('answers rather than throws for a row that never passed validation', () => {
    // The preview groups rows it has already found faults in, so an impossible
    // cell must reach a verdict here and be refused by the writer.
    const resolution = resolvePolicy(
      request({
        terms: terms({ vacationDays: -1, probationMonths: 1.5 }),
      }),
      [STANDARD],
    )

    expect(resolution.kind).toBe('mint-derived-name')
  })
})

describe('quantizePolicyTerms', () => {
  it('neutralizes the two inert terms the writer neutralizes', () => {
    expect(
      quantizePolicyTerms(
        terms({ vacationAnnualIncrement: 0, vacationIncrementEveryYears: 3 }),
      ).vacationIncrementEveryYears,
    ).toBe(1)
    expect(
      quantizePolicyTerms(
        terms({ probationMonths: 0, paidSickDuringProbation: true }),
      ).paidSickDuringProbation,
    ).toBe(false)
  })

  it('is idempotent, so quantizing twice cannot drift', () => {
    const once = quantizePolicyTerms(terms({ vacationDays: 20.8333 }))
    expect(quantizePolicyTerms(once)).toEqual(once)
    expect(once.vacationDays).toBe(20.83)
  })
})

describe('suggestPolicyName', () => {
  it('carries every term that tells two offers apart', () => {
    expect(suggestPolicyName(terms())).toBe('Imported 25+5')
    expect(
      suggestPolicyName(terms({ vacationAnnualIncrement: 5 })),
    ).toBe('Imported 25+5, +5/yr')
    expect(
      suggestPolicyName(
        terms({ vacationAnnualIncrement: 5, vacationIncrementEveryYears: 3 }),
      ),
    ).toBe('Imported 25+5, +5/3yr')
    expect(
      suggestPolicyName(
        terms({
          vacationAnnualIncrement: 5,
          vacationIncrementCapDays: 30,
          probationMonths: 3,
          paidSickDuringProbation: true,
        }),
      ),
    ).toBe('Imported 25+5, +5/yr to 30, 3m probation, sick paid')
  })

  it('states the figures the policy will be stored with', () => {
    expect(suggestPolicyName(terms({ vacationDays: 20.8333 }))).toBe(
      'Imported 20.83+5',
    )
  })
})

describe('firstFreePolicyName', () => {
  it('hands back the base name when nothing holds it', () => {
    expect(firstFreePolicyName('Contractors', ['Standard UA'])).toBe(
      'Contractors',
    )
  })

  it('compares names the way the catalog does, trimmed and case-blind', () => {
    expect(firstFreePolicyName('Contractors', ['  CONTRACTORS  '])).toBe(
      'Contractors (2)',
    )
  })
})

describe('policyCatalogEntry', () => {
  it('reads a stored row as the catalog entry matching consults', () => {
    expect(
      policyCatalogEntry({
        id: 'p-stored',
        name: 'Standard UA',
        termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
        effectiveTo: null,
        ...terms(),
      }),
    ).toEqual({
      policyId: 'p-stored',
      name: 'Standard UA',
      termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
      terms: terms(),
      effectiveTo: null,
    })
  })
})

describe('describePolicyTermsMismatch', () => {
  it('names the terms, the catalog figure and the file figure, in that order', () => {
    expect(
      describePolicyTermsMismatch('Senior UA', {
        catalog: terms({ vacationDays: 28, vacationIncrementCapDays: 35 }),
        supplied: terms({ vacationDays: 25 }),
        differing: ['vacationDays', 'vacationIncrementCapDays'],
      }),
    ).toBe(
      'The file asks for policy "Senior UA", whose terms are not the ones the row states: ' +
        'vacation days 28 rather than 25, increase cap 35 rather than none. ' +
        'The catalog wins; correct the file or the policy if that is not intended.',
    )
  })
})
