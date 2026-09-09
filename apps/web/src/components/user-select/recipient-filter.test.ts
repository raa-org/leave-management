/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { filterRecipientOptions } from './recipient-filter'
import {
  recipientLabel,
  toRecipientOptions,
  type UserOption,
} from './recipient-values'

const directory: UserOption[] = [
  { userId: 'u1', displayName: 'Anna Approver', email: 'anna@example.com' },
  { userId: 'u2', displayName: 'Boris Backup', email: 'boris@example.com' },
  { userId: 'u3', displayName: 'Clara Copy', email: 'clara@example.com' },
]

function filter(inputValue: string): string[] {
  return filterRecipientOptions(toRecipientOptions(directory), {
    inputValue,
    getOptionLabel: recipientLabel,
  }).map((option) => option.email)
}

describe('filterRecipientOptions', () => {
  it('matches by display name', () => {
    expect(filter('boris')).toEqual(['boris@example.com'])
    expect(filter('backup')).toEqual(['boris@example.com'])
  })

  it('matches by email prefix and by full pasted address', () => {
    // The regression this guards: the default MUI filter sees only the label
    // (display name), so any input containing '@' would yield "No options".
    expect(filter('boris@')).toEqual(['boris@example.com'])
    expect(filter('boris@example.com')).toEqual(['boris@example.com'])
  })

  it('returns every option for empty input', () => {
    expect(filter('')).toHaveLength(3)
  })

  it('matches case-insensitively', () => {
    expect(filter('BORIS@EXAMPLE')).toEqual(['boris@example.com'])
  })
})
