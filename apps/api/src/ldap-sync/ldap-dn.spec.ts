/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { normalizeDn, stripUniqueMemberUid } from './ldap-dn'

describe('normalizeDn', () => {
  it('leaves an already canonical DN unchanged apart from case', () => {
    expect(
      normalizeDn('uid=yvoloskova,ou=Consultants,ou=Users,dc=example,dc=com'),
    ).toBe('uid=yvoloskova,ou=consultants,ou=users,dc=example,dc=com')
  })

  it('equates composed and decomposed spellings of one character', () => {
    // The server's DN matching normalizes Unicode (RFC 4518); JS string
    // equality is code-point-wise, so without the NFC fold an NFD-pasted
    // member value silently unmatches its NFC entry. Escapes, not glyphs:
    // an editor re-normalizing the file must not quietly equalize the two
    // fixtures.
    expect(normalizeDn('cn=Jos\u00e9 Garc\u00eda,ou=Users')).toBe(
      normalizeDn('cn=Jose\u0301 Garci\u0301a,ou=Users'),
    )
  })

  it('equates DNs differing only in case', () => {
    expect(normalizeDn('UID=YVoloskova,OU=Users,DC=Example,DC=Com')).toBe(
      normalizeDn('uid=yvoloskova,ou=users,dc=example,dc=com'),
    )
  })

  it('drops whitespace around unescaped commas and equals signs', () => {
    expect(normalizeDn('uid = x , ou = Users , dc = example')).toBe(
      normalizeDn('uid=x,ou=Users,dc=example'),
    )
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeDn('  uid=x,dc=example  ')).toBe('uid=x,dc=example')
  })

  it('drops tabs next to separators like spaces', () => {
    expect(normalizeDn('uid=x,\tou=Users')).toBe('uid=x,ou=users')
  })

  it('treats an escaped comma as a value character, not a boundary', () => {
    // The space after the escaped comma is part of the value: collapsing it
    // would merge two differently named people into one key.
    const withSpace = normalizeDn('cn=Smith\\, John,ou=Users')
    const withoutSpace = normalizeDn('cn=Smith\\,John,ou=Users')
    expect(withSpace).toBe('cn=smith\\, john,ou=users')
    expect(withSpace).not.toBe(withoutSpace)
  })

  it('preserves whitespace inside a value, double spaces included', () => {
    expect(normalizeDn('cn=John  Smith,ou=Users')).toBe(
      'cn=john  smith,ou=users',
    )
    expect(normalizeDn('cn=John  Smith,ou=Users')).not.toBe(
      normalizeDn('cn=John Smith,ou=Users'),
    )
  })

  it('keeps an escaped trailing backslash without swallowing the run after it', () => {
    // A lone escape at the very end must not read past the string.
    expect(normalizeDn('cn=x\\')).toBe('cn=x\\')
  })

  it('preserves whitespace next to an equals sign inside a value', () => {
    // RFC 4514 requires no escaping for `=` inside a value, so only the
    // first `=` of the RDN is a boundary. Folding the space here would
    // collapse two different people into one membership key — the one
    // wrong-match shape this module must never produce.
    expect(normalizeDn('cn=a =b,ou=users')).toBe('cn=a =b,ou=users')
    expect(normalizeDn('cn=a =b,ou=users')).not.toBe(
      normalizeDn('cn=a=b,ou=users'),
    )
    expect(normalizeDn('cn=a = b,ou=users')).toBe('cn=a = b,ou=users')
  })

  it('still drops whitespace around the boundary equals of every RDN', () => {
    // The boundary detection resets at each comma: the second RDN's first
    // `=` is a boundary again even after a value-internal `=` before it.
    expect(normalizeDn('cn=a=b , ou = users')).toBe('cn=a=b,ou=users')
  })
})

describe('stripUniqueMemberUid', () => {
  it('cuts the optional bit-string suffix off a member value', () => {
    expect(stripUniqueMemberUid("uid=x,dc=example#'0101'B")).toBe(
      'uid=x,dc=example',
    )
  })

  it('accepts an empty bit string and a lowercase b', () => {
    expect(stripUniqueMemberUid("uid=x,dc=example#''B")).toBe('uid=x,dc=example')
    expect(stripUniqueMemberUid("uid=x,dc=example#'01'b")).toBe(
      'uid=x,dc=example',
    )
  })

  it('leaves a value without the suffix untouched', () => {
    expect(stripUniqueMemberUid('uid=x,dc=example')).toBe('uid=x,dc=example')
  })

  it('leaves a hash inside a value alone when no bit string follows', () => {
    expect(stripUniqueMemberUid('cn=room#3,dc=example')).toBe(
      'cn=room#3,dc=example',
    )
  })

  it('trims the value before matching so a padded suffix is still recognized', () => {
    expect(stripUniqueMemberUid("  uid=x,dc=example#'1'B  ")).toBe(
      'uid=x,dc=example',
    )
  })

  it('leaves an escaped hash alone even when a bit string follows it', () => {
    // `\#` is a value character, not the suffix delimiter; cutting there
    // would leave a dangling backslash that corrupts the DN.
    expect(stripUniqueMemberUid("cn=tag\\#'0101'B,dc=example")).toBe(
      "cn=tag\\#'0101'B,dc=example",
    )
    expect(stripUniqueMemberUid("cn=tag\\#'0101'B")).toBe("cn=tag\\#'0101'B")
  })

  it('cuts the suffix behind a value ending in an escaped backslash', () => {
    // `\\` is one escaped backslash — the pair leaves the `#` unescaped, so
    // this one IS the suffix delimiter.
    expect(stripUniqueMemberUid("cn=tag\\\\#'0101'B")).toBe('cn=tag\\\\')
  })

  it('leaves a bit-string-shaped fragment alone in the middle of a value', () => {
    // Only the trailing shape is the suffix; the same characters mid-DN are
    // value text and excising them would splice two halves together.
    expect(stripUniqueMemberUid("uid=x#'01'B,dc=example")).toBe(
      "uid=x#'01'B,dc=example",
    )
  })

  it('composes with normalizeDn into one comparison key', () => {
    // The exact pipeline the orchestrator runs on every group member.
    expect(
      normalizeDn(stripUniqueMemberUid("UID=X, OU=Users,DC=Example#'0101'B")),
    ).toBe('uid=x,ou=users,dc=example')
  })
})
