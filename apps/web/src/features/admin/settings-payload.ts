/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  CarryoverCapMode,
  CarryoverPolicy,
  normalizeCountryCode,
  type CountryDto,
  type LeaveSettingsDto,
  type UpdateLeaveSettingsDto,
} from '@workspace/contracts'

// There is ONE settings endpoint and it takes the whole object, but the page
// shows four cards with four Save buttons. Sending every card's draft on every
// Save meant "Save countries" quietly committed a half-typed carryover rule,
// and saving the approvers quietly committed country rows nobody had confirmed.
//
// So the payload is assembled here instead: server truth for everything, with
// only the pressed card's fields laid over it. The invariant this replaces
// ("no field is ever lost, whichever Save you press") becomes: each card
// writes its own fields and echoes the server's value for the rest, so a draft
// in another card is neither committed nor discarded.
//
// This does NOT close cross-session clobbering: the PUT is still a full-object
// write, so a second tab that saved after this one loaded will be reverted.
// The fix for that is optimistic concurrency (If-Match on updatedAt, which the
// service deliberately ignores today), which needs its own conflict UI.
//
// Lives in its own module because the web tests run in a node environment with
// no DOM, so anything worth asserting has to be a pure function.

/** Which card's Save was pressed. */
export type SettingsPanelKey =
  | 'carryover'
  | 'approvers'
  | 'countries'

/** The draft state each card edits, as the page holds it. */
export type SettingsDraft = {
  carryoverPolicy: CarryoverPolicy
  carryoverCapDays: string
  carryoverCapMode: CarryoverCapMode
  carryoverCapPercent: string
  approvalRequired: boolean
  defaultApproverEmails: string[]
  defaultCcApproverEmails: string[]
  defaultTimezone: string
  countryRows: CountryDto[]
}

/**
 * The country roster as the server should receive it. The timezone key is
 * omitted when the row has none, because absent means "leave the stored zone
 * alone" while an empty string would be a value the server has to reject.
 */
export function countriesPayload(rows: CountryDto[]): CountryDto[] {
  return rows
    .map((row) => {
      const code = normalizeCountryCode(row.code)
      const timezone = row.timezone?.trim()
      return {
        code,
        name: row.name.trim() || code,
        ...(timezone ? { timezone } : {}),
      }
    })
    .filter((country) => country.code !== '')
}

export function buildSettingsPayload(
  panel: SettingsPanelKey,
  server: LeaveSettingsDto,
  draft: SettingsDraft,
): UpdateLeaveSettingsDto {
  const base: UpdateLeaveSettingsDto = {
    // Echoed untouched: allowances come from leave policies now and no card
    // edits these. The columns go in a post-launch cleanup.
    defaultVacationDays: server.defaultVacationDays,
    defaultSickDays: server.defaultSickDays,
    approvalRequired: server.approvalRequired ?? true,
    defaultApproverEmails: [...server.defaultApproverEmails],
    defaultCcApproverEmails: [...server.defaultCcApproverEmails],
    carryoverPolicy: server.carryoverPolicy ?? CarryoverPolicy.Capped,
    carryoverCapDays: server.carryoverCapDays ?? 0,
    carryoverCapMode: server.carryoverCapMode ?? CarryoverCapMode.Percent,
    carryoverCapPercent: server.carryoverCapPercent ?? 50,
    ...(server.defaultTimezone ? { defaultTimezone: server.defaultTimezone } : {}),
    countries: countriesPayload(server.countries),
    // The server stamps its own; echoing the loaded value is the honest
    // payload and the seed of a future If-Match.
    updatedAt: server.updatedAt,
  }

  if (panel === 'countries') {
    return { ...base, countries: countriesPayload(draft.countryRows) }
  }
  if (panel === 'approvers') {
    // The approval mode belongs to this card: it decides whether the deciding
    // list below it is applied at all, so the two are saved together.
    return {
      ...base,
      approvalRequired: draft.approvalRequired,
      defaultApproverEmails: draft.defaultApproverEmails,
      defaultCcApproverEmails: draft.defaultCcApproverEmails,
    }
  }
  return {
    ...base,
    carryoverPolicy: draft.carryoverPolicy,
    // Each cap field is sent only by the mode that reads it, so the other never
    // persists a stale number. The mode itself always goes, which keeps a
    // days/percent preference across a detour through No carryover. The idle
    // percent resets to the default 50 rather than 0: a stored 0% would quietly
    // carry nothing the moment someone picks a percent mode.
    //
    // Both percent modes share carryoverCapPercent, so the test is "not Days"
    // rather than a list of the percent modes: a mode added later reads the
    // number it was given instead of silently receiving the reset 50.
    carryoverCapDays:
      draft.carryoverPolicy === CarryoverPolicy.Capped &&
      draft.carryoverCapMode === CarryoverCapMode.Days
        ? Math.max(0, Math.trunc(Number(draft.carryoverCapDays) || 0))
        : 0,
    carryoverCapMode: draft.carryoverCapMode,
    carryoverCapPercent:
      draft.carryoverPolicy === CarryoverPolicy.Capped &&
      draft.carryoverCapMode !== CarryoverCapMode.Days
        ? Math.min(
            100,
            Math.max(0, Math.trunc(Number(draft.carryoverCapPercent) || 0)),
          )
        : 50,
  }
}
