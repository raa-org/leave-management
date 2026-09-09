/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  CarryoverCapMode,
  CarryoverPolicy,
  type LeaveSettingsDto,
} from '@workspace/contracts'
import {
  buildSettingsPayload,
  countriesPayload,
  type SettingsDraft,
} from './settings-payload'

const server = {
  defaultVacationDays: 25,
  defaultSickDays: 5,
  approvalRequired: true,
  defaultApproverEmails: ['lead@example.com'],
  defaultCcApproverEmails: [],
  carryoverPolicy: CarryoverPolicy.Capped,
  carryoverCapDays: 0,
  carryoverCapMode: CarryoverCapMode.Percent,
  carryoverCapPercent: 50,
  defaultTimezone: 'Europe/Kyiv',
  countries: [
    { code: 'US', name: 'United States', timezone: 'America/New_York' },
  ],
  updatedAt: '2026-07-01T09:00:00.000Z',
} as unknown as LeaveSettingsDto

// Every field edited away from server truth, so any leak shows up as a value
// that could only have come from the draft.
const draft: SettingsDraft = {
  carryoverPolicy: CarryoverPolicy.None,
  carryoverCapDays: '9',
  carryoverCapMode: CarryoverCapMode.Days,
  carryoverCapPercent: '70',
  approvalRequired: false,
  defaultApproverEmails: ['drafted@example.com'],
  defaultCcApproverEmails: ['cc@example.com'],
  defaultTimezone: 'Europe/Warsaw',
  countryRows: [
    { code: 'US', name: 'United States', timezone: 'America/Los_Angeles' },
    { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
  ],
}

describe('buildSettingsPayload', () => {
  it('sends the country draft and server truth for every other card', () => {
    const payload = buildSettingsPayload('countries', server, draft)

    expect(payload.countries).toEqual([
      { code: 'US', name: 'United States', timezone: 'America/Los_Angeles' },
      { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
    ])
    // The half-typed carryover and approver drafts stay in the browser.
    expect(payload.carryoverPolicy).toBe(CarryoverPolicy.Capped)
    expect(payload.carryoverCapPercent).toBe(50)
    expect(payload.defaultApproverEmails).toEqual(['lead@example.com'])
    expect(payload.defaultTimezone).toBe('Europe/Kyiv')
    // Switching approvals off is the approver card's write, not this one's.
    expect(payload.approvalRequired).toBe(true)
  })

  it('saves the approval mode together with the lists it governs', () => {
    const payload = buildSettingsPayload('approvers', server, draft)

    expect(payload.approvalRequired).toBe(false)
    expect(payload.defaultApproverEmails).toEqual(['drafted@example.com'])
    expect(payload.defaultCcApproverEmails).toEqual(['cc@example.com'])
    // The deciding list is kept verbatim rather than cleared: optional mode
    // stops applying it, and turning the requirement back on must restore it.
    expect(payload.carryoverPolicy).toBe(CarryoverPolicy.Capped)
  })

  it('never lets one card create a country another card only drafted', () => {
    // Poland was added in the countries card and never confirmed; saving any
    // other card must not create it.
    for (const panel of ['carryover', 'approvers'] as const) {
      expect(buildSettingsPayload(panel, server, draft).countries).toEqual([
        { code: 'US', name: 'United States', timezone: 'America/New_York' },
      ])
    }
  })

  it('sends the approver draft and leaves carryover at server truth', () => {
    const payload = buildSettingsPayload('approvers', server, draft)

    expect(payload.defaultApproverEmails).toEqual(['drafted@example.com'])
    expect(payload.defaultCcApproverEmails).toEqual(['cc@example.com'])
    expect(payload.carryoverPolicy).toBe(CarryoverPolicy.Capped)
    expect(payload.countries).toHaveLength(1)
  })

  it('sends the carryover draft and leaves the approver lists alone', () => {
    const payload = buildSettingsPayload('carryover', server, draft)

    expect(payload.carryoverPolicy).toBe(CarryoverPolicy.None)
    // Not capped, so neither cap field carries a stale number.
    expect(payload.carryoverCapDays).toBe(0)
    expect(payload.carryoverCapPercent).toBe(50)
    expect(payload.defaultApproverEmails).toEqual(['lead@example.com'])
  })

  it('keeps a capped days rule and clamps a capped percent', () => {
    expect(
      buildSettingsPayload('carryover', server, {
        ...draft,
        carryoverPolicy: CarryoverPolicy.Capped,
      }).carryoverCapDays,
    ).toBe(9)
    expect(
      buildSettingsPayload('carryover', server, {
        ...draft,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.Percent,
        carryoverCapPercent: '140',
      }).carryoverCapPercent,
    ).toBe(100)
  })

  it('sends the percent for the allowance-percent mode, not the idle default', () => {
    // The two percent modes share carryoverCapPercent. Sending the reset 50
    // here would silently overwrite the number the admin typed the moment they
    // picked "% of allowance".
    const payload = buildSettingsPayload('carryover', server, {
      ...draft,
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: '70',
    })

    expect(payload.carryoverCapMode).toBe(CarryoverCapMode.PercentOfTotal)
    expect(payload.carryoverCapPercent).toBe(70)
    // The day cap is not the mode's field, so it must not persist the draft's 9.
    expect(payload.carryoverCapDays).toBe(0)
  })

  it('echoes the allowance fields from the server on every card', () => {
    for (const panel of ['carryover', 'approvers', 'countries'] as const) {
      const payload = buildSettingsPayload(panel, server, draft)
      expect(payload.defaultVacationDays).toBe(25)
      expect(payload.defaultSickDays).toBe(5)
      expect(payload.updatedAt).toBe('2026-07-01T09:00:00.000Z')
    }
  })
})

describe('countriesPayload', () => {
  it('omits the timezone key when a row has none', () => {
    // Absent means "leave the stored zone alone"; an empty string would be a
    // value the server has to reject.
    expect(countriesPayload([{ code: 'PL', name: 'Poland' }])).toEqual([
      { code: 'PL', name: 'Poland' },
    ])
    expect(
      countriesPayload([{ code: 'PL', name: 'Poland', timezone: '  ' }]),
    ).toEqual([{ code: 'PL', name: 'Poland' }])
  })

  it('normalizes the code and falls back to it for a blank name', () => {
    expect(countriesPayload([{ code: 'pl', name: '  ' }])).toEqual([
      { code: 'PL', name: 'PL' },
    ])
  })

  it('drops a row with no usable code', () => {
    expect(countriesPayload([{ code: '  ', name: 'Nowhere' }])).toEqual([])
  })
})
