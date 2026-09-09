/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { Entry } from 'ldapts'
import { isValidEmail, normalizeEmail } from '@workspace/contracts'
import { lookupCountry } from '../domain/country-catalog'

/**
 * The directory attributes this mapper reads — the single source of truth for
 * what the sync needs from the server. The client requests exactly this list
 * (importing it from here), so an attribute added to the mapping can never be
 * silently absent from the search results.
 *
 * The person's name is built from `givenName` + `sn`, not `displayName`: in
 * this directory `displayName` is frequently empty or holds the email, whereas
 * `sn` is always populated. `sn` (the surname) is treated as MANDATORY — an
 * entry without it is skipped (see mapLdapEntry), so the name stored is always
 * a real name. `givenName` is optional: when present it is prefixed to the
 * surname ("Given Surname"), otherwise the surname alone is stored.
 */
export const LDAP_SYNC_ATTRIBUTES = ['mail', 'givenName', 'sn', 'l']

/**
 * A directory entry reduced to exactly the fields the sync writes. Pure data —
 * no entity, no persistence — so the whole mapping is trivially testable.
 */
export interface MappedLdapUser {
  /** Address as it appears in the directory (trimmed), stored on `users.email`. */
  email: string
  /**
   * Lowercased form; the sync's single match key and `users.normalizedEmail`.
   * One address per person is guaranteed (multivalued mail is rejected),
   * so no alias set is needed.
   */
  normalizedEmail: string
  /** `givenName sn` when a given name is present, otherwise `sn` alone. */
  displayName: string
  /** ISO 3166-1 alpha-2 (upper-case) if `l` was a real country, else null. */
  countryCode: string | null
}

/**
 * Result of mapping one entry. A skipped entry carries a human-readable reason
 * for the run's `skipped` counter; a mapped entry may still carry non-fatal
 * `warnings` (e.g. an unusable country code that was dropped to null rather
 * than failing the whole record). Both name the person they are about — a skip
 * by DN, since it may have no usable address, a warning by the address it
 * mapped — because both end up in the audit trail as the only record of what
 * needs fixing in the directory.
 */
export type LdapEntryMapping =
  | { ok: true; user: MappedLdapUser; warnings: string[] }
  | { ok: false; reason: string }

/**
 * Map a raw LDAP entry to the fields the sync upserts.
 *
 * Skips (never throws) an entry the sync cannot store unambiguously: a
 * missing/malformed `mail`, a multivalued `mail` (two distinct addresses) that
 * would break the one-person-one-row invariant, a missing/empty or multivalued
 * `sn` (the surname is mandatory — `users.displayName` is NOT NULL — and must
 * be unambiguous), a multivalued `givenName` (the optional given name must be
 * unambiguous when present), or an `l` holding two or more distinct countries.
 * A single unusable country value degrades softly instead: it is dropped to
 * null with a warning, keeping the entry. One bad entry must never sink the run.
 */
export function mapLdapEntry(entry: Entry): LdapEntryMapping {
  const mailValues = stringValues(entry['mail'])
  if (mailValues.length === 0) {
    return {
      ok: false,
      reason: entry['mail'] === undefined
        ? `entry "${entry.dn}" has no mail attribute`
        : `entry "${entry.dn}" has an empty mail attribute`,
    }
  }
  // isValidEmail requires a dotted domain; deliberately strict because the team
  // confirmed (2026-07-22) the directory's `mail` always has one. A dotless
  // internal address (user@intranet) would be treated as invalid here.
  const validMails = mailValues.filter((value) => isValidEmail(value))
  if (validMails.length === 0) {
    return {
      ok: false,
      reason: `entry "${entry.dn}" has an invalid mail ${JSON.stringify(mailValues[0])}`,
    }
  }
  // `mail` must identify ONE person by ONE address. The directory guarantees a
  // single address per person (team-confirmed 2026-07-22), so a genuinely
  // multivalued mail — two DISTINCT normalized addresses — would break the
  // "one person ↔ one row" invariant the sync keys on. FAIL CLOSED: skip the
  // entry with a flag rather than silently pick one (which risks a duplicate
  // account when SSO keyed the row to the other address). A directory
  // regression then surfaces as a visible skipped-count, not a silent duplicate
  // a month later. Casing-only duplicates (Bob@x / bob@x) are the SAME address
  // and collapse to one, so they never trip this.
  const normalizedMails = [
    ...new Set(validMails.map((value) => normalizeEmail(value))),
  ].sort()
  if (normalizedMails.length > 1) {
    return {
      ok: false,
      reason:
        `entry "${entry.dn}" has multiple distinct mail addresses ` +
        `(${normalizedMails.join(', ')}) — the directory's one-address-per-person ` +
        `invariant is broken; skipped`,
    }
  }
  // All remaining values share one normalized form; pick the smallest RAW
  // spelling so the stored casing is deterministic regardless of value order (a
  // smallest-normalized reduce would be positional here — the forms are equal).
  const mail = validMails.reduce((best, candidate) =>
    candidate < best ? candidate : best,
  )

  // The surname is mandatory: `users.displayName` is NOT NULL, so an entry
  // without a usable `sn` cannot be stored. FAIL CLOSED like `mail` — skip the
  // entry (and count it) rather than substituting the email, which is an
  // address, not a name.
  const snValues = stringValues(entry['sn'])
  if (snValues.length === 0) {
    return {
      ok: false,
      reason: entry['sn'] === undefined
        ? `entry "${entry.dn}" has no sn attribute`
        : `entry "${entry.dn}" has an empty sn attribute`,
    }
  }
  // One surname per person is expected. Two or more DISTINCT sn values are an
  // ambiguity the sync cannot resolve — skip the entry rather than pick one,
  // so a broken assumption surfaces as a visible skip instead of a silently
  // chosen (and possibly wrong) name.
  const distinctSns = [...new Set(snValues)]
  if (distinctSns.length > 1) {
    return {
      ok: false,
      reason:
        `entry "${entry.dn}" has multiple distinct sn values ` +
        `(${distinctSns.join(', ')}) — ambiguous surname; skipped`,
    }
  }
  const surname = distinctSns[0]

  // `givenName` is optional. When absent/empty the surname stands alone; when
  // present it is prefixed to form "Given Surname". Two or more DISTINCT given
  // names are an ambiguity we cannot resolve, so skip rather than pick one.
  const givenNameValues = stringValues(entry['givenName'])
  const distinctGivenNames = [...new Set(givenNameValues)]
  if (distinctGivenNames.length > 1) {
    return {
      ok: false,
      reason:
        `entry "${entry.dn}" has multiple distinct givenName values ` +
        `(${distinctGivenNames.join(', ')}) — ambiguous given name; skipped`,
    }
  }
  const givenName = distinctGivenNames[0]
  const displayName = givenName ? `${givenName} ${surname}` : surname

  const warnings: string[] = []

  const country = mapCountry(entry, mail, warnings)
  if (country.ambiguous) {
    return {
      ok: false,
      reason:
        `entry "${entry.dn}" has multiple distinct country codes ` +
        `(${country.codes.join(', ')}) in 'l' — ambiguous; skipped`,
    }
  }

  return {
    ok: true,
    warnings,
    user: {
      email: mail,
      normalizedEmail: normalizeEmail(mail),
      displayName,
      countryCode: country.code,
    },
  }
}

/**
 * Result of resolving the `l` attribute: a country code (or null when absent /
 * a single unusable value), or an ambiguity signal when `l` holds two or more
 * distinct countries — which the caller turns into a skipped entry.
 */
type CountryResult =
  | { ambiguous: false; code: string | null }
  | { ambiguous: true; codes: string[] }

/**
 * Resolve the `l` attribute. Absent `l` → null. A single value that resolves to
 * no known country (e.g. a city name) → warning + null: unusable but non-fatal.
 * Two or more DISTINCT countries → ambiguous: the caller skips the entry rather
 * than store a guess. `lookupCountry` canonicalizes case and rejects anything
 * that is not a known alpha-2 code, matching how the identity path
 * (`resolveIdentityCountryCodeTx`) validates the field.
 *
 * Takes the mapped address so the warning can name whose country was dropped.
 */
function mapCountry(
  entry: Entry,
  email: string,
  warnings: string[],
): CountryResult {
  const rawValues = stringValues(entry['l'])
  if (rawValues.length === 0) {
    return { ambiguous: false, code: null }
  }
  // `l` is expected to hold ONE country code, and LDAP returns multivalued
  // attributes in no guaranteed order, so scan every value and collapse ones
  // that resolve to the SAME country (a resolvable code can sit behind a city
  // name). A single unresolvable value is non-fatal (warn + null); two or more
  // distinct countries are a real ambiguity the sync cannot resolve, so report
  // it up and let the entry be skipped rather than silently store null.
  const distinctCodes = [
    ...new Set(
      rawValues
        .map((value) => lookupCountry(value)?.code)
        .filter((code): code is string => code !== undefined),
    ),
  ]
  if (distinctCodes.length === 0) {
    // Named by the address, not by the DN the skip reasons carry: the mail is
    // already validated by the time an entry can warn, it is the key the sync
    // matches people on, and an admin reads it without opening a directory
    // browser. Unidentified, the audit row says a country was dropped but not
    // whose, and the advice to correct it in the directory cannot be followed.
    warnings.push(
      `account "${email}" has country code ${JSON.stringify(rawValues.length === 1 ? rawValues[0] : rawValues)}, which is not a known ISO 3166-1 alpha-2 country — stored as null`,
    )
    return { ambiguous: false, code: null }
  }
  if (distinctCodes.length > 1) {
    return { ambiguous: true, codes: distinctCodes }
  }
  return { ambiguous: false, code: distinctCodes[0] }
}

/**
 * Normalize an LDAP attribute value to usable strings. ldapts returns a single
 * value or an array, and text or Buffer, depending on the attribute and server
 * — this flattens all shapes to trimmed strings (utf-8 for Buffers), dropping
 * blank values, in directory order. Callers therefore never see '' or padded
 * values and need no trim of their own. Exported for the client, which reads
 * the lrs-* groups' uniqueMember values through the same shapes.
 */
export function stringValues(
  value: string | string[] | Buffer | Buffer[] | undefined,
): string[] {
  if (value === undefined) {
    return []
  }
  const values = Array.isArray(value) ? value : [value]
  return values
    .map((candidate) =>
      (typeof candidate === 'string' ? candidate : candidate.toString('utf8')).trim(),
    )
    .filter((text) => text !== '')
}
