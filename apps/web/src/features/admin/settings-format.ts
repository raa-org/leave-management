/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  normalizeCountryCode,
  type CountryCatalogEntryDto,
  type CountryDto,
} from '@workspace/contracts'

// Decisions the settings cards make, kept out of the components: the web tests
// run in a node environment with no DOM, so a rule that lives inside a dialog
// cannot be asserted at all.

/**
 * The zones offered for one country: its catalog list, with whatever is stored
 * today guaranteed to be present. The stored value has to survive even when the
 * catalog no longer lists it, because the server accepts it back (a catalog
 * change must not strand a country nobody meant to touch) and a picker that
 * dropped it would silently rewrite the zone on the next save.
 */
export function countryTimezoneOptions(
  catalog: CountryCatalogEntryDto[],
  code: string,
  current: string | undefined,
): string[] {
  const normalized = normalizeCountryCode(code)
  const fromCatalog =
    catalog.find((entry) => entry.code === normalized)?.timezones ?? []
  const base = fromCatalog.length > 0 ? fromCatalog : current ? [current] : []
  return current && !base.includes(current) ? [current, ...base] : base
}

/**
 * Why this country cannot be removed, worded to be shown on its own, or null
 * when it can be removed.
 *
 * Mirrors the server's guard so the greyed-out button explains itself before
 * the click rather than after the round trip. The employee count has to come
 * from the server (`assignedUsers`) because nothing on this page would
 * otherwise know it, and it is the blocker that matters most: it is the one
 * the database will not stop. users.countryCode is ON DELETE SET NULL, so a
 * removal that got through would not fail, it would quietly strip the country
 * from those people and leave every one of them unable to submit leave.
 *
 * Both blockers can apply at once and both are named, because naming only the
 * first would send the admin round the loop twice.
 */
export function countryRemovalProblem(
  country: CountryDto,
  calendarYears: number[],
): string | null {
  const assigned = country.assignedUsers ?? 0
  const calendars = calendarYears.length
  const blockers: string[] = []
  const ways: string[] = []
  if (assigned > 0) {
    // "deactivated accounts included" is not a footnote. The directory shows
    // only active accounts by default, so an admin who just filtered it by this
    // country can be looking at an empty list while this says three. The count
    // has to include them: the foreign key is ON DELETE SET NULL, and it wipes
    // a deactivated person's country exactly as permanently.
    blockers.push(
      assigned === 1
        ? '1 employee is still assigned to it (deactivated accounts included)'
        : `${assigned} employees are still assigned to it (deactivated accounts included)`,
    )
    ways.push(
      assigned === 1
        ? 'move them to another country'
        : 'move them to other countries',
    )
  }
  if (calendars > 0) {
    blockers.push(
      calendars === 1
        ? 'it still has a holiday calendar'
        : `it still has ${calendars} holiday calendars`,
    )
    ways.push(calendars === 1 ? 'delete the calendar' : 'delete the calendars')
  }
  if (blockers.length === 0) {
    return null
  }
  const reason = blockers.join(', and ')
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. To remove it, ${ways.join(' and ')} first.`
}

export type CountryDraft = {
  editingCode: string | null
  code: string
  name: string
  timezone: string
}

/**
 * Why this draft cannot be saved, or null. Mirrors the server's rule so the
 * dialog refuses before the round trip, with the same reason the API would give.
 */
export function countryDraftProblem(
  draft: CountryDraft,
  rows: CountryDto[],
  catalog: CountryCatalogEntryDto[],
): string | null {
  const code = normalizeCountryCode(draft.code)
  if (!code) {
    return 'Choose a country.'
  }
  if (
    draft.editingCode === null &&
    rows.some((row) => normalizeCountryCode(row.code) === code)
  ) {
    return 'That country is already on the list.'
  }
  const allowed = countryTimezoneOptions(catalog, code, undefined)
  if (!draft.timezone) {
    return 'Choose a timezone for this country.'
  }
  // An empty catalog means it has not loaded (or failed to); refusing then
  // would blame the admin for the app's own missing data.
  if (allowed.length > 0 && !allowed.includes(draft.timezone)) {
    return `${draft.timezone} is not one of ${code}'s timezones.`
  }
  return null
}
