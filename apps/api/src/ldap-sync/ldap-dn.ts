/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * DN comparison helpers for the group-membership sync.
 *
 * The sync decides who is an app user by matching the `uniqueMember` DNs of
 * the lrs-* groups against the DN of every entry from the user search. Both
 * sides are issued by the SAME directory server, but not by the same code
 * path — group values are stored attribute values while entry DNs are
 * composed by the server, and either can be hand-entered through different
 * tools — so they can legitimately differ in case, in whitespace around
 * separators, and in Unicode composition (é as one code point vs
 * e + combining accent: the server's own matching normalizes per RFC 4518,
 * JS string equality does not). `normalizeDn` folds exactly those three
 * differences and nothing else.
 *
 * Deliberate simplification, not an oversight: this is NOT a full RFC 4514
 * normalizer. Hex escapes (\2C), multi-valued RDNs (cn=a+sn=b) and
 * attribute-name aliases (2.5.4.3 vs cn) are left as-is, because a server
 * spells them consistently on both sides and folding them would mean
 * reimplementing a DN parser for differences that cannot occur here. A
 * mismatch fed through one of those shapes can never produce a WRONG match —
 * the failure mode is a missed match, which surfaces as a stale group
 * member plus an entry outside the batch, and, when it hits every employees
 * member, as the orchestrator's refuse.
 */

/**
 * Normalize a DN for equality comparison: trim, drop whitespace runs that
 * touch an unescaped `,` or the RDN's attribute/value `=`, and lowercase
 * the result.
 *
 * Escaped separators (`cn=Smith\, John`) are value characters, not
 * boundaries, so whitespace next to them is preserved — collapsing it would
 * corrupt the value and make two different people compare equal. Whitespace
 * INSIDE a value (`cn=John  Smith`) is also preserved, double spaces
 * included: it is significant to the server, and both sides of our
 * comparison spell it the same way. That includes whitespace next to a
 * VALUE-internal `=`: RFC 4514 requires no escaping for `=` inside a value,
 * so only the first unescaped `=` of each RDN separates attribute from
 * value — `cn=a =b` and `cn=a=b` name two different people and must not
 * fold into one key.
 */
export function normalizeDn(dn: string): string {
  // NFC first: composed and decomposed spellings of one character are equal
  // to the server and to every directory tool, but not to JS string
  // equality — without this fold a single NFD-pasted member value silently
  // unmatches its NFC entry.
  const trimmed = dn.normalize('NFC').trim()
  let out = ''
  let index = 0
  // Whether the current RDN's boundary `=` has already been emitted. A `+`
  // (multi-valued RDN) does not reset it: the shape is documented above as
  // left alone, and not resetting fails toward a missed match, never a
  // wrong one.
  let equalsSeenInRdn = false
  // Whether the LAST character appended to out was an unescaped separator.
  // The look-back below cannot judge by the character alone: after emitting
  // `\,` the output genuinely ends in a comma, but that comma is a value
  // character — treating it as a boundary would swallow the space inside
  // `cn=Smith\, John` and merge two differently named people into one key.
  let lastEmittedSeparator = false
  while (index < trimmed.length) {
    const ch = trimmed[index]
    if (ch === '\\') {
      // Escape sequence: keep the backslash and the escaped character
      // verbatim. `\X` always escapes exactly one character here — the hex
      // form (`\2C`) then reads as an escaped '2' plus a literal 'C', which
      // is wrong per RFC but HARMLESS for comparison: both sides get the
      // same treatment, and equality is all this function serves.
      out += ch
      if (index + 1 < trimmed.length) {
        out += trimmed[index + 1]
      }
      lastEmittedSeparator = false
      index += 2
      continue
    }
    if (ch === ' ' || ch === '\t') {
      // A whitespace run: emitted only when it separates value characters.
      // If it touches an unescaped separator on either side, it is
      // decorative spacing around `,`/`=` and dies. The look-back checks
      // the OUTPUT (already normalized), the look-ahead checks the input
      // past the run — where a separator cannot be an escaped one, since
      // escaped pairs start with a backslash, not with `,`/`=`.
      let end = index
      while (
        end < trimmed.length &&
        (trimmed[end] === ' ' || trimmed[end] === '\t')
      ) {
        end += 1
      }
      const next = trimmed[end]
      const nextIsSeparator =
        next === ',' || (next === '=' && !equalsSeenInRdn)
      if (!lastEmittedSeparator && !nextIsSeparator) {
        out += trimmed.slice(index, end)
      }
      index = end
      continue
    }
    if (ch === ',') {
      out += ch
      equalsSeenInRdn = false
      lastEmittedSeparator = true
      index += 1
      continue
    }
    if (ch === '=' && !equalsSeenInRdn) {
      out += ch
      equalsSeenInRdn = true
      lastEmittedSeparator = true
      index += 1
      continue
    }
    out += ch
    lastEmittedSeparator = false
    index += 1
  }
  return out.toLowerCase()
}

/**
 * Strip the optional uid suffix a `uniqueMember` value may carry.
 *
 * The attribute's syntax is NameAndOptionalUID (RFC 4517): a DN optionally
 * followed by `#` and a bit string, e.g. `uid=x,dc=example#'0101'B`. The
 * suffix distinguishes reused DNs across time — a concern this directory
 * does not have — so it is cut before normalization; everything else,
 * including a `#` anywhere inside a value, passes through untouched (only
 * the exact trailing bit-string shape behind an UNESCAPED `#` is
 * recognized — an escaped `\#` is a value character, and cutting there
 * would leave a dangling backslash that corrupts the DN).
 */
export function stripUniqueMemberUid(value: string): string {
  const trimmed = value.trim()
  const match = /#'[01]*'B$/i.exec(trimmed)
  if (!match) {
    return trimmed
  }
  // The `#` delimits the suffix only when it is unescaped: count the run of
  // backslashes immediately before it. An even run pairs off into escaped
  // backslashes and leaves the `#` standing alone; an odd run makes the `#`
  // itself a value character (`\#`), so there is no suffix to cut.
  let backslashes = 0
  for (let i = match.index - 1; i >= 0 && trimmed[i] === '\\'; i--) {
    backslashes += 1
  }
  return backslashes % 2 === 0 ? trimmed.slice(0, match.index) : trimmed
}
