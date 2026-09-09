/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { initialsOfRecipient } from './employee-ui'

describe('approver initials', () => {
  it('reads a name as its first and last initial', () => {
    expect(initialsOfRecipient('mark.white@example.com', 'Mark White')).toBe('MW')
  })

  it('never spells a domain, whichever way the address arrives', () => {
    // Both sources can hold an address; neither may contribute a domain letter.
    expect(initialsOfRecipient('uatestuser1@example.com')).toBe('U')
    expect(
      initialsOfRecipient('uatestuser1@example.com', 'uatestuser1@example.com'),
    ).toBe('U')
  })

  it('splits an address on the separators that stand for a name', () => {
    expect(initialsOfRecipient('john.doe@example.com')).toBe('JD')
    expect(initialsOfRecipient('mark_white@example.com')).toBe('MW')
    expect(initialsOfRecipient('ann-green@example.com')).toBe('AG')
  })

  it('gives one letter to an address that carries no name to split', () => {
    expect(initialsOfRecipient('uatestuser1@example.com')).toBe('U')
  })

  it('prefers the name over the address it was addressed at', () => {
    expect(initialsOfRecipient('uatestuser1@example.com', 'Mark White')).toBe('MW')
  })

  it('falls back to the address when the name is only whitespace', () => {
    expect(initialsOfRecipient('john.doe@example.com', '   ')).toBe('JD')
  })

  it('keeps a multi-byte first character whole', () => {
    expect(initialsOfRecipient('a@example.com', '🙂 Smith')).toBe('🙂S')
  })

  it('has something to render for an empty recipient', () => {
    expect(initialsOfRecipient('')).toBe('?')
  })
})
