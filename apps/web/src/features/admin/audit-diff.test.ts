/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { AuditActionKind, AuditCategory, AuditEventType } from '@workspace/contracts'
import type { AdminAuditLogItemDto } from '@workspace/contracts'
import { buildDiffRows } from './AuditLogEntry'

function entry(
  overrides: Partial<AdminAuditLogItemDto>,
): AdminAuditLogItemDto {
  return {
    auditId: 'a1',
    occurredAt: '2026-08-04T10:00:00.000Z',
    eventType: AuditEventType.SettingsUpdated,
    category: AuditCategory.Settings,
    action: AuditActionKind.Update,
    actorLabel: 'Admin',
    actorRoles: [],
    entityType: 'leave_settings',
    entityId: '1',
    summary: 'Updated leave settings',
    ...overrides,
  } as AdminAuditLogItemDto
}

describe('buildDiffRows', () => {
  it('prefers the recorded field diff when the server supplied one', () => {
    expect(
      buildDiffRows(
        entry({
          changedFields: [
            { field: 'carryoverPolicy', before: 'full', after: 'none' },
          ],
        }),
      ),
    ).toEqual([{ field: 'carryoverPolicy', before: 'full', after: 'none' }])
  })

  it('shows nothing for an edit whose snapshots match', () => {
    // The reported defect: a settings save that changed nothing rendered every
    // field as "25 -> 25", which reads as six edits nobody made.
    const same = {
      defaultVacationDays: 25,
      defaultSickDays: 5,
      carryoverPolicy: 'none',
      defaultApproverEmails: [],
    }
    expect(
      buildDiffRows(entry({ before: { ...same }, after: { ...same } })),
    ).toEqual([])
  })

  it('keeps only the fields that actually moved', () => {
    const rows = buildDiffRows(
      entry({
        before: { defaultVacationDays: 25, defaultSickDays: 5 },
        after: { defaultVacationDays: 15, defaultSickDays: 5 },
      }),
    )
    expect(rows).toEqual([
      { field: 'defaultVacationDays', before: 25, after: 15 },
    ])
  })

  it('lists the whole snapshot when there is only one side', () => {
    // A creation or a deletion has nothing to compare against, so every field
    // of the single snapshot is the story.
    const created = buildDiffRows(
      entry({
        action: AuditActionKind.Create,
        after: { code: 'PL', name: 'Poland' },
      }),
    )
    expect(created.map((row) => row.field).sort()).toEqual(['code', 'name'])
  })

  it('is empty when the entry carries no state at all', () => {
    expect(buildDiffRows(entry({}))).toEqual([])
  })
})
