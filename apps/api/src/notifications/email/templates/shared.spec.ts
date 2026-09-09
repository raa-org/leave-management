/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { ApproverDecision, ApproverKind } from '@workspace/contracts'
import { describe, expect, it } from 'vitest'
import { decidingApproverLabels } from './shared'

describe('decidingApproverLabels', () => {
  const to = (email: string, displayName?: string) => ({
    email,
    kind: ApproverKind.To,
    decision: ApproverDecision.Pending,
    ...(displayName === undefined ? {} : { displayName }),
  })

  it('names an approver without spelling out their address', () => {
    expect(decidingApproverLabels([to('mark.white@example.com', 'Mark White')])).toEqual([
      'Mark White',
    ])
  })

  it('tells same-named approvers apart by address', () => {
    expect(
      decidingApproverLabels([
        to('john@a.example.com', 'John Smith'),
        to('john@b.example.com', 'John Smith'),
        to('ann@example.com', 'Ann Lee'),
      ]),
    ).toEqual([
      'John Smith (john@a.example.com)',
      'John Smith (john@b.example.com)',
      'Ann Lee',
    ])
  })

  it('reads a shared name the same way whatever its casing', () => {
    expect(
      decidingApproverLabels([
        to('john@a.example.com', 'John Smith'),
        to('john@b.example.com', 'JOHN SMITH'),
      ]),
    ).toEqual([
      'John Smith (john@a.example.com)',
      'JOHN SMITH (john@b.example.com)',
    ])
  })

  it('falls back to the bare address when no name is known for it', () => {
    expect(decidingApproverLabels([to('nobody@example.com')])).toEqual([
      'nobody@example.com',
    ])
  })

  it('ignores a name that is only whitespace', () => {
    expect(decidingApproverLabels([to('quiet@example.com', '   ')])).toEqual([
      'quiet@example.com',
    ])
  })

  it('still names an approver whose row carries no address', () => {
    expect(decidingApproverLabels([to('', 'Nameless Row')])).toEqual([
      'Nameless Row',
    ])
  })

  it('folds one approver listed twice into a single label', () => {
    expect(
      decidingApproverLabels([
        to('Mark.White@example.com', 'Mark White'),
        to('mark.white@example.com', 'Mark White'),
      ]),
    ).toEqual(['Mark White'])
  })

  it('names only the approvers who were asked to decide', () => {
    expect(
      decidingApproverLabels([
        to('decider@example.com', 'Dee Cider'),
        {
          email: 'copied@example.com',
          kind: ApproverKind.Cc,
          decision: ApproverDecision.Pending,
          displayName: 'Dee Cider',
        },
      ]),
    ).toEqual(['Dee Cider'])
  })
})
