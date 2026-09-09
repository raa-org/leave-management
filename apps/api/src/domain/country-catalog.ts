/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { getAllCountries, getCountry } from 'countries-and-timezones'
import { normalizeCountryCode } from '@workspace/contracts'

// Canonical reference set of countries: ISO alpha-2 code -> display name +
// representative IANA timezone. Single source of truth used to (a) power the
// admin country picker, (b) auto-create a country arriving from LDAP that is not
// yet in the DB, and (c) seed `countries.timezone`. Names come from the built-in
// `Intl.DisplayNames`; timezones from `countries-and-timezones`. Avoids the two
// hand-entry problems: bad admin data, and a login country silently dropped.

export const DEFAULT_TIMEZONE = 'Europe/Kyiv'

// `countries-and-timezones` lists a country's zones without a "primary" concept
// (e.g. US -> America/Adak first), so pin a sensible office zone for the big
// multi-zone countries; everything else uses the library's first zone (correct
// for single-zone countries like PL/TR). Trimmed to the countries the catalog
// actually keeps (see the scope filter below) — RU/AU/KZ/ID/CN were dropped
// because they are now either excluded or out of scope.
const PREFERRED_ZONE: Record<string, string> = {
  US: 'America/New_York',
  CA: 'America/Toronto',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
}

// Catalog scope: Europe + the Americas only. A country is IN scope when any of
// its IANA zones is under Europe/* or America/*, OR its ISO code is in
// EUROPE_EXTRA (countries that sit in Asia/* zones but are treated as Europe
// here; Georgia is already used by the app). EXCLUDED countries are removed
// even though their zones qualify. Both sets are here so the scope is easy to
// adjust later.
const EUROPE_EXTRA = new Set(['GE', 'AM', 'AZ', 'CY'])
const EXCLUDED = new Set(['RU', 'BY'])

export interface CountryCatalogEntry {
  code: string
  name: string
  // Default/representative zone (the head of `timezones`).
  timezone: string
  // Full pickable list of the country's IANA zones, primary first, deduped.
  timezones: string[]
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

function displayName(code: string, fallback: string): string {
  try {
    return regionNames.of(code) ?? fallback
  } catch {
    return fallback
  }
}

function primaryTimezone(code: string, zones: readonly string[]): string {
  return PREFERRED_ZONE[code] ?? zones[0] ?? DEFAULT_TIMEZONE
}

/**
 * The country's full pickable zone list: the primary zone first, then the
 * library's remaining zones in their given order, de-duplicated. Never empty
 * (falls back to the primary, which itself falls back to DEFAULT_TIMEZONE).
 */
function catalogTimezones(code: string, zones: readonly string[]): string[] {
  const primary = primaryTimezone(code, zones)
  const ordered = [primary, ...zones]
  return [...new Set(ordered)]
}

/** True when the country falls within the catalog scope (Europe + Americas). */
function inCatalogScope(code: string, zones: readonly string[]): boolean {
  if (EXCLUDED.has(code)) {
    return false
  }
  if (EUROPE_EXTRA.has(code)) {
    return true
  }
  return zones.some(
    (zone) => zone.startsWith('Europe/') || zone.startsWith('America/'),
  )
}

let cachedList: CountryCatalogEntry[] | null = null

/**
 * Catalog countries within scope (Europe + the Americas, excluding Russia and
 * Belarus), sorted by display name (for the admin picker).
 */
export function listCountryCatalog(): CountryCatalogEntry[] {
  if (!cachedList) {
    cachedList = Object.values(getAllCountries())
      .filter((country) => inCatalogScope(country.id, country.timezones))
      .map((country) => ({
        code: country.id,
        name: displayName(country.id, country.name),
        timezone: primaryTimezone(country.id, country.timezones),
        timezones: catalogTimezones(country.id, country.timezones),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }
  return cachedList
}

/**
 * The zones an admin may pin this country to. Empty for a code the catalog does
 * not know, which is how `{code: 'ZZ'}` ends up with no assignable zone at all.
 */
export function catalogTimezonesFor(code: string): string[] {
  return lookupCountry(code)?.timezones ?? []
}

/**
 * Whether `timezone` is one this country actually has. Catalog knowledge stays
 * in this file so the settings write path cannot grow its own idea of which
 * zones are legal.
 */
export function isCatalogTimezone(code: string, timezone: string): boolean {
  return catalogTimezonesFor(code).includes(timezone)
}

/**
 * Whether the runtime can actually resolve `timezone`. Unlike
 * `isCatalogTimezone` this asks nothing about a country -- it is the check for
 * the org-wide default zone, which belongs to no country.
 *
 * Asked of `Intl.DateTimeFormat` rather than of `Intl.supportedValuesOf`,
 * which on Node 22 lists the legacy `Europe/Kiev` and NOT `Europe/Kyiv`: an
 * allowlist built from it would refuse this file's own DEFAULT_TIMEZONE.
 *
 * Fixed offsets are refused even though Intl resolves them. `+03:00` is right
 * for Kyiv in summer and an hour wrong all winter, and this value decides the
 * midnight at which a leave day is spent -- so an offset is not a timezone
 * here, it is a bug with a plausible face.
 */
export function isKnownTimezone(timezone: string): boolean {
  if (/^[+-]/.test(timezone) || /^(GMT|UTC)[+-]/i.test(timezone)) {
    return false
  }
  try {
    // Throws RangeError on anything it cannot resolve, the empty string and
    // untrimmed values included.
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Look up one country by (normalized) code; undefined if not a real country. */
export function lookupCountry(code: string): CountryCatalogEntry | undefined {
  const normalized = normalizeCountryCode(code)
  const country = getCountry(normalized)
  if (!country) {
    return undefined
  }
  return {
    code: country.id,
    name: displayName(country.id, country.name),
    timezone: primaryTimezone(country.id, country.timezones),
    timezones: catalogTimezones(country.id, country.timezones),
  }
}
