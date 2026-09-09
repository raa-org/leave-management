/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { AdminEmployeeListItemDto } from '@workspace/contracts'
import { AppRoleName, EmployeeProfileStatus } from '@workspace/contracts'
import {
  buildResetDirectoryInput,
  describeResetCost,
  describeResetOutcome,
} from './TestToolingPanel'

function makeEmployee(
  overrides: Partial<AdminEmployeeListItemDto> & { email: string },
): AdminEmployeeListItemDto {
  return {
    employeeId: `id-${overrides.email}`,
    displayName: overrides.email.split('@')[0],
    roleNames: [AppRoleName.Employee],
    active: true,
    profileStatus: EmployeeProfileStatus.Ready,
    projects: [],
    ...overrides,
  }
}

describe('buildResetDirectoryInput', () => {
  it('spells a full wipe as all=true exactly when the keep selection is empty', () => {
    expect(buildResetDirectoryInput([], false)).toEqual({
      keep: [],
      all: true,
      clearAudit: false,
    })
  })

  it('sends the kept addresses without the full-wipe confirmation', () => {
    const input = buildResetDirectoryInput(
      [
        makeEmployee({ email: 'keep@example.com' }),
        makeEmployee({ email: 'also@example.com' }),
      ],
      true,
    )

    expect(input).toEqual({
      keep: ['keep@example.com', 'also@example.com'],
      all: false,
      clearAudit: true,
    })
  })
})

describe('describeResetCost', () => {
  it('quotes the untruncated headcount, not the picker page', () => {
    expect(describeResetCost(347, 0)).toBe('Delete ALL 347 users')
    expect(describeResetCost(347, 2)).toBe('Delete 345 of 347 users')
  })

  it('states no number when the headcount is unknown', () => {
    expect(describeResetCost(null, 0)).toBe('Delete ALL users')
    expect(describeResetCost(null, 3)).toBe('Delete all but 3 kept')
  })
})

describe('describeResetOutcome', () => {
  it('lists every counter, and omits the audit clause when clearing was not asked for', () => {
    expect(
      describeResetOutcome(
        {
          deletedUsers: 3,
          deletedRequests: 5,
          deletedLedgerEntries: 1,
          deletedDeliveries: 2,
          clearedAuditLogs: 0,
        },
        false,
      ),
    ).toBe(
      'Deleted — users: 3, requests: 5, ledger entries: 1, deliveries: 2.',
    )
  })

  it('reports a requested audit clear even when it emptied nothing', () => {
    // Otherwise a second consecutive reset reads exactly like one with the
    // checkbox unticked, and the admin cannot tell it was honoured.
    expect(
      describeResetOutcome(
        {
          deletedUsers: 0,
          deletedRequests: 0,
          deletedLedgerEntries: 0,
          deletedDeliveries: 0,
          clearedAuditLogs: 0,
        },
        true,
      ),
    ).toBe(
      'Deleted — users: 0, requests: 0, ledger entries: 0, deliveries: 0, audit rows cleared: 0.',
    )
  })
})
