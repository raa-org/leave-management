/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  policyTermsFingerprint,
  roundPolicyTerm,
  type LeavePolicyTerms,
} from './policy-fingerprint'

/**
 * WHICH policy a row of an import file lands on. One answer for both sides of a
 * run: the validation step that shows the operator what will happen, and the
 * apply that then does it.
 *
 * They used to decide separately, and they decided differently: the preview
 * predicted from the row's TERMS alone while the apply resolves by the file's
 * NAME first. So a policy shown as "will be created" was joined instead, a name
 * the operator typed was thrown away, and a row pointing at a retired policy
 * passed validation only to fail at the enrollment, naming a policy the preview
 * never showed.
 *
 * Pure by contract: reads nothing, throws nothing.
 *  - Reading nothing is what lets the apply call it INSIDE the catalog advisory
 *    lock on the snapshot it just read, and the preview call it outside on a
 *    catalog of its own.
 *  - Throwing nothing is what lets the preview run it over rows that never
 *    passed row validation. A cell out of range must reach the same verdict
 *    here as it will at the apply and be refused by the writer, not by this.
 */

// One policy of the catalog as resolution reads it. Structural on purpose (no
// entity import): the preview resolves against a catalog that GROWS, since the
// policies the file itself is about to mint must be visible to the rows below
// them.
export interface PolicyCatalogEntry {
  policyId: string
  name: string
  // The STORED fingerprint, not one recomputed from the terms: the apply looks
  // a policy up by that column, so a fingerprint derived any other way here
  // would predict a match the apply cannot make.
  termsFingerprint: string
  terms: LeavePolicyTerms
  // NULL is the only "in force" value. A closed window retires the policy at
  // ANY date, past or future: assignHistoricalMembershipTx refuses every policy
  // that carries one.
  effectiveTo: string | null
}

export interface PolicyResolutionRequest {
  // The policy name the FILE states for this row. Authoritative on both counts:
  // it decides which catalog policy is joined, and it names what gets minted.
  // Blank and absent mean the same thing here.
  fileName?: string
  // The name the operator settled on for this group in the wizard. It only
  // reaches a row the file left unnamed: a stated name outranks it.
  chosenName?: string
  // As the file states them, quantized but NOT validated on the way in (see
  // quantizePolicyTerms).
  terms: LeavePolicyTerms
  // The row's employment start date: the day a minted policy would start from,
  // and the day a retired twin's window must still cover for the apply to land
  // on that twin instead of minting.
  effectiveFrom: string
}

// Every behaviour-bearing term the named policy holds differently from the row.
// EVERY term is compared, not just the two day counts: an export gives every
// row its policy name, so a file edited in the "Increase every" or the
// probation column would otherwise be overruled in silence.
export interface PolicyTermsMismatch {
  catalog: LeavePolicyTerms
  supplied: LeavePolicyTerms
  differing: (keyof LeavePolicyTerms)[]
}

export type PolicyResolution =
  | {
      // The file named a policy that exists. Its terms win over the row's, and
      // its era is not consulted: a retired one is joined too, which is why
      // `retired` travels rather than being quietly filtered away.
      kind: 'join-by-name'
      policyId: string
      policyName: string
      terms: LeavePolicyTerms
      retired: boolean
      termsMismatch?: PolicyTermsMismatch
    }
  | {
      // Nobody named it (or the named one is absent), and the terms are already
      // in the catalog.
      kind: 'join-by-terms'
      policyId: string
      policyName: string
      terms: LeavePolicyTerms
      retired: boolean
    }
  | {
      // Nothing to join: the run mints it. Which of the two kinds it is decides
      // whether the operator may rename it, since a name the file states is not
      // the wizard's to change.
      kind: 'mint-file-name' | 'mint-derived-name'
      // What the policy will really be called, collisions already numbered away.
      plannedName: string
      // plannedName before the ladder: what the numbering starts from when a
      // name turns out to be taken after all.
      nameBase: string
      terms: LeavePolicyTerms
    }

/**
 * The canonicalization normalizePolicyTerms performs, MINUS its refusals.
 *
 * Quantizing matters because identity is quantized: a cell of 24.999 and one of
 * 25 are the same offer, and a resolver comparing raw figures would tell the
 * preview they are two. Refusing is not this module's job: groupPolicies runs
 * over rows that failed row validation, and a throw there would take down a
 * preview whose whole purpose is to report what is wrong.
 */
export function quantizePolicyTerms(terms: LeavePolicyTerms): LeavePolicyTerms {
  const vacationAnnualIncrement = roundPolicyTerm(terms.vacationAnnualIncrement)
  return {
    vacationDays: roundPolicyTerm(terms.vacationDays),
    sickDays: roundPolicyTerm(terms.sickDays),
    vacationAnnualIncrement,
    // The two coercions the writer itself performs, because they decide
    // identity: a period is inert without a rise, and paid sick is inert
    // without a probation window. Left standing, either would fingerprint two
    // behaviorally identical deals apart.
    vacationIncrementEveryYears:
      vacationAnnualIncrement === 0 ? 1 : terms.vacationIncrementEveryYears,
    vacationIncrementCapDays:
      terms.vacationIncrementCapDays === null
        ? null
        : roundPolicyTerm(terms.vacationIncrementCapDays),
    probationMonths: terms.probationMonths,
    paidSickDuringProbation:
      terms.probationMonths > 0 && terms.paidSickDuringProbation,
  }
}

/**
 * The catalog in the order matching reads it: in force first, then by the most
 * recently closed window, then by id.
 *
 * Both readers used to scan an unordered `find()`, so with two expired twins
 * the winner was whichever row Postgres happened to return first, and the
 * preview and the apply could pick different ones. The order is part of the
 * answer, so it is taken here rather than left to a caller to remember.
 */
export function sortPolicyCatalog(
  catalog: readonly PolicyCatalogEntry[],
): PolicyCatalogEntry[] {
  return [...catalog].sort((left, right) => {
    if (left.effectiveTo !== right.effectiveTo) {
      if (left.effectiveTo === null) {
        return -1
      }
      if (right.effectiveTo === null) {
        return 1
      }
      return right.effectiveTo.localeCompare(left.effectiveTo)
    }
    return left.policyId.localeCompare(right.policyId)
  })
}

/**
 * A name that says what the policy grants, for a row that names none. It has to
 * carry every term that distinguishes one offer from another: two policies
 * differing only in their annual rise are different deals, and naming both
 * "Imported 25+5" makes the second collide on the catalog's case-insensitive
 * name check.
 *
 * Stated in the figures the policy will be STORED with, so it quantizes its own
 * input: a prorated cell of 20.8333 becomes a policy granting 20.83, and a name
 * saying otherwise would describe an offer nobody is on. Idempotent, so passing
 * already quantized terms changes nothing.
 */
export function suggestPolicyName(rawTerms: LeavePolicyTerms): string {
  const terms = quantizePolicyTerms(rawTerms)
  const parts = [`Imported ${terms.vacationDays}+${terms.sickDays}`]
  if (terms.vacationAnnualIncrement > 0) {
    // The period belongs in the name for the same reason the rise does: "+5
    // every year" and "+5 every 3 years" are different offers, and naming both
    // "Imported 15+5, +5/yr" makes the second collide on that same check.
    const everyYears = terms.vacationIncrementEveryYears
    parts.push(
      `+${terms.vacationAnnualIncrement}/${everyYears > 1 ? everyYears : ''}yr` +
        (terms.vacationIncrementCapDays !== null
          ? ` to ${terms.vacationIncrementCapDays}`
          : ''),
    )
  }
  if (terms.probationMonths > 0) {
    parts.push(
      `${terms.probationMonths}m probation` +
        (terms.paidSickDuringProbation ? ', sick paid' : ''),
    )
  }
  return parts.join(', ')
}

/**
 * The name under which a policy can actually be created: `base`, or the first
 * free rung of the " (2)", " (3)" ladder.
 *
 * A name already taken by DIFFERENT terms is not a reason to lose the employee:
 * the catalog demands unique names (case-insensitively), so the variant is
 * numbered and the operator can rename it afterwards. The scan terminates
 * because `taken` is finite.
 */
export function firstFreePolicyName(
  base: string,
  taken: Iterable<string>,
): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()))
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base} (${attempt + 1})`
    if (!used.has(candidate.trim().toLowerCase())) {
      return candidate
    }
  }
}

/**
 * The one decision, in the apply's own order of rules:
 *
 *  1. the file's name matches a catalog policy (case-insensitively, with NO era
 *     filter) -> join it, terms and all;
 *  2. the terms match a policy that is in force -> join it;
 *  3. the terms match a RETIRED policy whose window still covers the row's
 *     effectiveFrom -> join it, which is what the writer's duplicate-terms
 *     refusal makes the apply do;
 *  4. otherwise mint, under the file's name, else the operator's, else a
 *     derived one, with a collision numbered away.
 *
 * Rules 2 and 3 are what createPolicyTx would refuse to create around; stating
 * them here is what lets the preview say so before the run starts.
 */
export function resolvePolicy(
  request: PolicyResolutionRequest,
  catalog: readonly PolicyCatalogEntry[],
): PolicyResolution {
  const terms = quantizePolicyTerms(request.terms)
  const ordered = sortPolicyCatalog(catalog)
  const fileName = request.fileName?.trim()

  if (fileName) {
    const wanted = fileName.toLowerCase()
    const named = ordered.find(
      (entry) => entry.name.trim().toLowerCase() === wanted,
    )
    if (named) {
      // Keyed off the quantized object rather than a hand-kept list: it is
      // built whole by quantizePolicyTerms, so a term added to LeavePolicyTerms
      // joins the comparison without anyone remembering to. Both sides are
      // canonical (the stored row was written through normalizePolicyTerms), so
      // the inert-period and inert-flag coercions cannot read as a
      // disagreement.
      const differing = (
        Object.keys(terms) as (keyof LeavePolicyTerms)[]
      ).filter((term) => named.terms[term] !== terms[term])
      return {
        kind: 'join-by-name',
        policyId: named.policyId,
        policyName: named.name,
        terms: named.terms,
        retired: named.effectiveTo !== null,
        ...(differing.length > 0
          ? {
              termsMismatch: { catalog: named.terms, supplied: terms, differing },
            }
          : {}),
      }
    }
    // Named but absent: it is minted under that name below, so a catalog can be
    // built from the file as well as matched against one.
  }

  const fingerprint = policyTermsFingerprint(terms)
  const live = ordered.find(
    (entry) =>
      entry.termsFingerprint === fingerprint && entry.effectiveTo === null,
  )
  if (live) {
    return {
      kind: 'join-by-terms',
      policyId: live.policyId,
      policyName: live.name,
      terms: live.terms,
      retired: false,
    }
  }
  // An expired twin does not block on its own: re-introducing an era's terms is
  // legitimate. It blocks only while its window still covers the day the new
  // policy would start, which is exactly the twin check inside createPolicyTx,
  // and there the apply ends up sitting on the expired policy.
  const expired = ordered.find(
    (entry) =>
      entry.termsFingerprint === fingerprint &&
      entry.effectiveTo !== null &&
      entry.effectiveTo >= request.effectiveFrom,
  )
  if (expired) {
    return {
      kind: 'join-by-terms',
      policyId: expired.policyId,
      policyName: expired.name,
      terms: expired.terms,
      retired: true,
    }
  }

  const nameBase =
    fileName || request.chosenName?.trim() || suggestPolicyName(terms)
  return {
    kind: fileName ? 'mint-file-name' : 'mint-derived-name',
    plannedName: firstFreePolicyName(
      nameBase,
      ordered.map((entry) => entry.name),
    ),
    nameBase,
    terms,
  }
}

// Read a stored policy row as a catalog entry. Structurally typed rather than
// taking the entity, so this module stays free of persistence imports and both
// callers agree on what a catalog entry is.
export function policyCatalogEntry(
  policy: LeavePolicyTerms & {
    id: string
    name: string
    termsFingerprint: string
    effectiveTo: string | null
  },
): PolicyCatalogEntry {
  return {
    policyId: policy.id,
    name: policy.name,
    termsFingerprint: policy.termsFingerprint,
    // Stored terms are taken as they are: they were written through
    // normalizePolicyTerms, so they are already canonical, and re-quantizing
    // would hide a row that is not.
    terms: {
      vacationDays: policy.vacationDays,
      sickDays: policy.sickDays,
      vacationAnnualIncrement: policy.vacationAnnualIncrement,
      vacationIncrementEveryYears: policy.vacationIncrementEveryYears,
      vacationIncrementCapDays: policy.vacationIncrementCapDays,
      probationMonths: policy.probationMonths,
      paidSickDuringProbation: policy.paidSickDuringProbation,
    },
    effectiveTo: policy.effectiveTo,
  }
}

// How a term is named when a file's row disagrees with the catalog policy it
// asks for. A Record over the term keys, so a term added to LeavePolicyTerms
// cannot reach the operator unnamed.
const POLICY_TERM_LABELS: Record<keyof LeavePolicyTerms, string> = {
  vacationDays: 'vacation days',
  sickDays: 'sick days',
  vacationAnnualIncrement: 'annual increase',
  vacationIncrementEveryYears: 'increase period in years',
  vacationIncrementCapDays: 'increase cap',
  probationMonths: 'probation months',
  paidSickDuringProbation: 'paid sick during probation',
}

// A term reads inside a sentence, so the two non-numeric shapes have to be
// words: an absent cap is no cap at all, and a flag is a yes or a no.
function formatPolicyTerm(value: number | boolean | null): string {
  if (value === null) {
    return 'none'
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no'
  }
  return String(value)
}

// THE sentence for a row whose terms lose to the policy it names, so the
// warning the preview shows and the warning the apply records are the same
// words rather than two accounts of one fact.
export function describePolicyTermsMismatch(
  policyName: string,
  mismatch: PolicyTermsMismatch,
): string {
  return (
    `The file asks for policy "${policyName}", whose terms are not the ones the row states: ` +
    mismatch.differing
      .map(
        (term) =>
          `${POLICY_TERM_LABELS[term]} ${formatPolicyTerm(mismatch.catalog[term])} rather than ${formatPolicyTerm(mismatch.supplied[term])}`,
      )
      .join(', ') +
    '. The catalog wins; correct the file or the policy if that is not intended.'
  )
}
