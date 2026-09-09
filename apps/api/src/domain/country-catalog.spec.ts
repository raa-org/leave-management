/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEZONE,
  catalogTimezonesFor,
  isCatalogTimezone,
  isKnownTimezone,
  listCountryCatalog,
  lookupCountry,
} from './country-catalog'

describe('country catalog', () => {
  it('looks up a country name + timezone by code', () => {
    expect(lookupCountry('DE')).toMatchObject({
      code: 'DE',
      name: 'Germany',
      timezone: 'Europe/Berlin',
    })
  })

  it('normalizes the code before lookup', () => {
    expect(lookupCountry('ua')?.code).toBe('UA')
    expect(lookupCountry('ua')?.timezone).toBe('Europe/Kyiv')
  })

  it('pins a sensible office zone for big multi-zone countries', () => {
    expect(lookupCountry('US')?.timezone).toBe('America/New_York')
  })

  it('returns undefined for a code that is not a real country', () => {
    expect(lookupCountry('ZZ')).toBeUndefined()
  })

  it('lists the in-scope catalog sorted by name', () => {
    const list = listCountryCatalog()
    expect(list.length).toBeGreaterThan(50)
    const names = list.map((entry) => entry.name)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    expect(DEFAULT_TIMEZONE).toBe('Europe/Kyiv')
  })

  it('scopes the catalog to Europe and the Americas, minus Russia and Belarus', () => {
    const codes = new Set(listCountryCatalog().map((entry) => entry.code))
    // Representative Europe + Americas countries and a EUROPE_EXTRA one (GE).
    for (const code of ['UA', 'PL', 'DE', 'TR', 'US', 'CA', 'BR', 'GE']) {
      expect(codes.has(code)).toBe(true)
    }
    // Russia and Belarus are dropped despite their Europe/* zones; Asia,
    // Africa and Oceania countries fall out of scope entirely.
    for (const code of ['RU', 'BY', 'KZ', 'NG', 'AU']) {
      expect(codes.has(code)).toBe(false)
    }
  })

  it('exposes each country full zone list with the default zone first', () => {
    const byCode = new Map(
      listCountryCatalog().map((entry) => [entry.code, entry]),
    )
    for (const entry of byCode.values()) {
      expect(entry.timezones.length).toBeGreaterThan(0)
      expect(entry.timezones[0]).toBe(entry.timezone)
    }
    // The US spans several zones (default America/New_York first); Poland has
    // exactly one (Europe/Warsaw).
    const us = byCode.get('US')
    expect(us?.timezones.length).toBeGreaterThan(1)
    expect(us?.timezones[0]).toBe('America/New_York')
    expect(byCode.get('PL')?.timezones).toEqual(['Europe/Warsaw'])
  })

  it('answers which zones a country may be pinned to', () => {
    expect(isCatalogTimezone('US', 'America/Los_Angeles')).toBe(true)
    expect(isCatalogTimezone('US', 'Europe/Kyiv')).toBe(false)
    // Lower-case input is normalized the way every other code path does.
    expect(isCatalogTimezone('us', 'America/New_York')).toBe(true)
    // A code the catalog does not know has no assignable zone at all.
    expect(isCatalogTimezone('ZZ', 'Europe/Kyiv')).toBe(false)
    expect(catalogTimezonesFor('ZZ')).toEqual([])
    expect(catalogTimezonesFor('PL')).toEqual(['Europe/Warsaw'])
  })

  describe('isKnownTimezone', () => {
    it('accepts this app default zone, which an allowlist would not', () => {
      // The load-bearing case. Intl.supportedValuesOf('timeZone') on Node 22
      // returns the legacy 'Europe/Kiev' and NOT 'Europe/Kyiv', so a validator
      // built on it would refuse DEFAULT_TIMEZONE and lock the settings page.
      expect(isKnownTimezone(DEFAULT_TIMEZONE)).toBe(true)
      expect(isKnownTimezone('Europe/Kyiv')).toBe(true)
      expect(isKnownTimezone('Europe/Kiev')).toBe(true)
    })

    it('accepts every zone the catalog is willing to hand out', () => {
      // Otherwise the settings page could offer a country zone that the org
      // default check would then refuse.
      for (const entry of listCountryCatalog()) {
        for (const zone of entry.timezones) {
          expect(isKnownTimezone(zone)).toBe(true)
        }
      }
    })

    it('refuses what the runtime cannot resolve, blank and untrimmed included', () => {
      expect(isKnownTimezone('Not/AZone')).toBe(false)
      expect(isKnownTimezone('')).toBe(false)
      expect(isKnownTimezone('   ')).toBe(false)
      expect(isKnownTimezone(' Europe/Kyiv ')).toBe(false)
    })

    it('refuses a fixed offset even though Intl resolves one', () => {
      // An offset has no daylight saving rule: '+03:00' is Kyiv in summer and
      // an hour wrong all winter, which would move the midnight a leave day is
      // spent at for half of every year.
      expect(isKnownTimezone('+03:00')).toBe(false)
      expect(isKnownTimezone('-05:00')).toBe(false)
      expect(isKnownTimezone('GMT+3')).toBe(false)
      expect(isKnownTimezone('UTC+3')).toBe(false)
      // Plain UTC is a zone, not an offset, and stays acceptable.
      expect(isKnownTimezone('UTC')).toBe(true)
    })
  })
})
