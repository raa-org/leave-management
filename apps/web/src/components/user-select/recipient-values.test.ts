/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import {
  excludeEmails,
  recipientEmails,
  recipientLabel,
  resolveRecipientValues,
  toRecipientOptions,
  type UserOption,
} from './recipient-values'

const directory: UserOption[] = [
  { userId: 'u1', displayName: 'Anna Approver', email: 'Anna@Example.com' },
  { userId: 'u2', displayName: 'Boris Backup', email: 'boris@example.com' },
  { userId: 'u3', displayName: 'Clara Copy', email: 'clara@example.com' },
]

describe('toRecipientOptions', () => {
  it('normalizes emails and links each option to its user', () => {
    const options = toRecipientOptions(directory)
    expect(options.map((option) => option.email)).toEqual([
      'anna@example.com',
      'boris@example.com',
      'clara@example.com',
    ])
    expect(options[0].user).toBe(directory[0])
  })

  it('dedupes case-variant duplicates and drops blank emails', () => {
    const options = toRecipientOptions([
      ...directory,
      { userId: 'u4', displayName: 'Dup', email: 'ANNA@example.com' },
      { userId: 'u5', displayName: 'Blank', email: '   ' },
    ])
    expect(options).toHaveLength(3)
  })
})

describe('resolveRecipientValues', () => {
  it('matches stored emails to directory users case-insensitively', () => {
    const values = resolveRecipientValues(['ANNA@example.com'], directory)
    expect(values).toHaveLength(1)
    expect(values[0].email).toBe('anna@example.com')
    expect(values[0].user?.displayName).toBe('Anna Approver')
  })

  it('keeps unmatched legacy emails as bare values', () => {
    const values = resolveRecipientValues(
      ['ops-mailbox@example.com', 'boris@example.com'],
      directory,
    )
    expect(values.map((value) => value.email)).toEqual([
      'ops-mailbox@example.com',
      'boris@example.com',
    ])
    expect(values[0].user).toBeUndefined()
    expect(values[1].user?.userId).toBe('u2')
  })

  it('drops blanks and duplicates while preserving order', () => {
    const values = resolveRecipientValues(
      ['boris@example.com', ' ', 'BORIS@example.com', 'anna@example.com'],
      directory,
    )
    expect(values.map((value) => value.email)).toEqual([
      'boris@example.com',
      'anna@example.com',
    ])
  })
})

describe('recipientEmails', () => {
  it('round-trips picker values to normalized deduped emails', () => {
    const emails = recipientEmails([
      { email: 'Anna@Example.com' },
      { email: 'anna@example.com' },
      { email: 'ops-mailbox@example.com' },
      { email: '' },
    ])
    expect(emails).toEqual(['anna@example.com', 'ops-mailbox@example.com'])
  })
})

describe('recipientLabel', () => {
  it('prefers the display name and falls back to the address', () => {
    expect(
      recipientLabel({ email: 'anna@example.com', user: directory[0] }),
    ).toBe('Anna Approver')
    expect(recipientLabel({ email: 'ops-mailbox@example.com' })).toBe(
      'ops-mailbox@example.com',
    )
  })
})

describe('excludeEmails', () => {
  it('removes directory entries matching the excluded emails', () => {
    const remaining = excludeEmails(directory, ['ANNA@example.com', ''])
    expect(remaining.map((option) => option.userId)).toEqual(['u2', 'u3'])
  })

  it('returns the directory untouched for no exclusions', () => {
    expect(excludeEmails(directory, [])).toHaveLength(3)
  })
})
