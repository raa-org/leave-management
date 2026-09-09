/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { Entry } from 'ldapts'
import { describe, expect, it } from 'vitest'
import { mapLdapEntry } from './ldap-entry.mapper'

/** A minimal valid entry; individual tests override single attributes. */
function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    dn: 'uid=jdoe,ou=Users,dc=example,dc=com',
    mail: 'Jane.Doe@example.com',
    givenName: 'Jane',
    sn: 'Doe',
    l: 'DE',
    ...overrides,
  }
}

describe('mapLdapEntry', () => {
  it('maps a well-formed entry', () => {
    const result = mapLdapEntry(entry())

    expect(result).toEqual({
      ok: true,
      warnings: [],
      user: {
        email: 'Jane.Doe@example.com',
        normalizedEmail: 'jane.doe@example.com',
        displayName: 'Jane Doe',
        countryCode: 'DE',
      },
    })
  })

  it('skips an entry with no mail', () => {
    const { mail: _omitted, ...withoutMail } = entry()
    const result = mapLdapEntry(withoutMail as Entry)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/no mail attribute/)
  })

  it('skips an entry whose mail is blank or malformed', () => {
    for (const mail of ['   ', 'not-an-email', 'a@b', '@example.com']) {
      const result = mapLdapEntry(entry({ mail }))
      expect(result.ok).toBe(false)
    }
  })

  it('distinguishes a blank mail from a missing one in the skip reason', () => {
    const result = mapLdapEntry(entry({ mail: '   ' }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/empty mail attribute/)
  })

  it('skips an entry whose sn is blank (surname is mandatory)', () => {
    const result = mapLdapEntry(entry({ sn: '   ' }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/empty sn attribute/)
  })

  it('skips an entry with no sn (surname is mandatory)', () => {
    const result = mapLdapEntry(stripSn())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/no sn attribute/)
  })

  it('joins givenName and sn into displayName', () => {
    const result = mapLdapEntry(entry({ givenName: 'Jane', sn: 'Doe' }))

    expect(result.ok && result.user.displayName).toBe('Jane Doe')
  })

  it('stores the surname alone when givenName is absent', () => {
    const { givenName: _omitted, ...withoutGivenName } = entry()
    const result = mapLdapEntry(withoutGivenName as Entry)

    expect(result.ok && result.user.displayName).toBe('Doe')
  })

  it('stores the surname alone when givenName is blank', () => {
    const result = mapLdapEntry(entry({ givenName: '   ' }))

    expect(result.ok && result.user.displayName).toBe('Doe')
  })

  it('skips an entry with multiple distinct givenName values (ambiguous)', () => {
    const result = mapLdapEntry(entry({ givenName: ['Jane', 'Janet'] }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/multiple distinct givenName values/)
  })

  it('normalizes and accepts a lower-case country code', () => {
    const result = mapLdapEntry(entry({ l: 'de' }))

    expect(result.ok && result.user.countryCode).toBe('DE')
    expect(result.ok && result.warnings).toEqual([])
  })

  it('drops an unknown country to null with a warning, still mapping the user', () => {
    const result = mapLdapEntry(entry({ l: 'Germany' }))

    expect(result.ok).toBe(true)
    expect(result.ok && result.user.countryCode).toBeNull()
    expect(result.ok && result.warnings[0]).toMatch(/not a known ISO 3166-1/)
    // The rejected value, so the audit row says what to correct, and the
    // address, so it says whose entry to correct it on. The alert only ever
    // shows a count and sends the admin to the audit log for the rest, so a
    // warning that identifies nobody makes that advice impossible to follow.
    expect(result.ok && result.warnings[0]).toContain('"Germany"')
    // The address as stored, not its normalized form, so the row and the
    // account read the same way.
    expect(result.ok && result.warnings[0]).toContain('"Jane.Doe@example.com"')
  })

  it('treats an absent country as null without a warning', () => {
    const { l: _omitted, ...withoutL } = entry()
    const result = mapLdapEntry(withoutL as Entry)

    expect(result.ok && result.user.countryCode).toBeNull()
    expect(result.ok && result.warnings).toEqual([])
  })

  it('recovers a resolvable country from a multivalued l and collapses casing', () => {
    // A city (or any non-country value) alongside a real code must not hide it,
    // and casing variants of one country collapse — no silent first-value pick.
    const withCity = mapLdapEntry(entry({ l: ['Berlin', 'DE'] }))
    expect(withCity.ok && withCity.user.countryCode).toBe('DE')
    expect(withCity.ok && withCity.warnings).toEqual([])
    const casing = mapLdapEntry(entry({ l: ['de', 'DE'] }))
    expect(casing.ok && casing.user.countryCode).toBe('DE')
  })

  it('skips an entry whose l holds two distinct countries (ambiguous)', () => {
    // `l` is expected to hold ONE country; two distinct ones are an ambiguity
    // the sync cannot resolve, so the entry is skipped rather than stored with
    // a guessed or nulled country.
    const result = mapLdapEntry(entry({ l: ['DE', 'FR'] }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/multiple distinct country codes/)
    expect(result.ok === false && result.reason).toContain('DE')
    expect(result.ok === false && result.reason).toContain('FR')
  })

  it('skips an entry with multiple distinct sn values (ambiguous surname)', () => {
    const result = mapLdapEntry(entry({ sn: ['Smith', 'Smyth'] }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/multiple distinct sn values/)
  })

  it('accepts an sn repeated as the same value (one distinct surname)', () => {
    const result = mapLdapEntry(entry({ sn: ['Doe', 'Doe'] }))

    expect(result.ok && result.user.displayName).toBe('Jane Doe')
  })

  it('uses a valid mail value, skipping a non-address alongside it', () => {
    // `mail` is multivalued; a stray bare uid must not sink the whole entry.
    const result = mapLdapEntry(entry({ mail: ['jdoe', 'jdoe@example.com'] }))

    expect(result.ok && result.user.email).toBe('jdoe@example.com')
    expect(result.ok && result.user.normalizedEmail).toBe('jdoe@example.com')
  })

  it('skips a mail with two distinct addresses (fail-closed on one-per-person)', () => {
    // The directory guarantees one address per person; two DISTINCT addresses
    // would break the one-person-one-row invariant, so the entry is skipped
    // with a flag rather than silently picking one.
    const result = mapLdapEntry(
      entry({ mail: ['zeta@example.com', 'alpha@example.com'] }),
    )

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('multiple distinct mail')
    expect(!result.ok && result.reason).toContain('alpha@example.com')
    expect(!result.ok && result.reason).toContain('zeta@example.com')
  })

  it('collapses casing-only duplicates and picks a deterministic raw spelling', () => {
    // Two spellings of the SAME address are one address, not two — they must
    // NOT trip the multivalued skip. The stored raw spelling is deterministic
    // regardless of directory value order (smallest raw: 'B' < 'b').
    const forward = mapLdapEntry(
      entry({ mail: ['bob@corp.example.com', 'Bob@corp.example.com'] }),
    )
    const reversed = mapLdapEntry(
      entry({ mail: ['Bob@corp.example.com', 'bob@corp.example.com'] }),
    )

    expect(forward.ok && forward.user.email).toBe('Bob@corp.example.com')
    expect(reversed.ok && reversed.user.email).toBe('Bob@corp.example.com')
    expect(forward.ok && forward.user.normalizedEmail).toBe('bob@corp.example.com')
  })

  it('trims surrounding whitespace off attribute values', () => {
    const result = mapLdapEntry(
      entry({ mail: '  Jane.Doe@example.com  ', givenName: '  Jane  ', sn: '  Doe  ' }),
    )

    expect(result.ok && result.user.email).toBe('Jane.Doe@example.com')
    expect(result.ok && result.user.displayName).toBe('Jane Doe')
  })

  it('skips blank values of a multivalued attribute and takes the next real one', () => {
    const result = mapLdapEntry(
      entry({
        mail: ['   ', 'real@example.com'],
        givenName: [Buffer.from(''), Buffer.from('Real')],
        sn: [Buffer.from(''), Buffer.from('Name')],
      }),
    )

    expect(result.ok && result.user.email).toBe('real@example.com')
    expect(result.ok && result.user.displayName).toBe('Real Name')
  })

  it('decodes a Buffer-valued attribute as utf-8', () => {
    const result = mapLdapEntry(
      entry({
        mail: Buffer.from('buf@example.com'),
        givenName: Buffer.from('Buf'),
        sn: Buffer.from('Name'),
      }),
    )

    expect(result.ok && result.user.email).toBe('buf@example.com')
    expect(result.ok && result.user.displayName).toBe('Buf Name')
  })
})

/** Build an entry with no sn attribute at all. */
function stripSn(): Entry {
  const { sn: _omitted, ...rest } = {
    dn: 'uid=jdoe,ou=Users,dc=example,dc=com',
    mail: 'Jane.Doe@example.com',
    l: 'DE',
    givenName: 'Jane',
    sn: 'Doe',
  }
  return rest as Entry
}
