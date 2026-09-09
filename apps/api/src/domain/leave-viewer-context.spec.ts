/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  AppRoleName,
  ApproverDecision,
  ApproverKind,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
} from '@workspace/contracts'
import { describe, expect, it } from 'vitest'
import { describeViewerContext } from './leave-viewer-context'
import type { ViewerContextInput } from './leave-viewer-context'

// The one place the "how does this caller stand, and what may they do?" rules
// live, so they are pinned here without a database: both the review page and the
// admin console read this answer, and a disagreement between them is what these
// rules exist to prevent.
describe('describeViewerContext', () => {
  it('lets an outstanding approver decide someone else s pending request', () => {
    const viewer = describeViewerContext(input())

    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: true,
      // A non-admin approver holds no override.
      canOverride: false,
    })
  })

  it('matches the caller against recipient rows regardless of email case', () => {
    const viewer = describeViewerContext(
      input({ caller: { ...caller, email: 'Manager@EXAMPLE.com' } }),
    )

    expect(viewer.standing).toBe(LeaveRequestViewerStanding.Approver)
    expect(viewer.canDecide).toBe(true)
  })

  it('withdraws the decision once the approver has voted, and reports it back', () => {
    const viewer = describeViewerContext(
      input({
        recipients: [
          {
            email: 'manager@example.com',
            kind: ApproverKind.To,
            decision: ApproverDecision.Approved,
            decidedAt: '2026-06-02T09:00:00.000Z',
          },
        ],
      }),
    )

    // A vote is cast once. A non-admin approver who changed their mind goes
    // through an admin override, not a quiet second submission.
    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: false,
      canOverride: false,
      ownVote: {
        decision: ApproverDecision.Approved,
        decidedAt: '2026-06-02T09:00:00.000Z',
      },
    })
  })

  it('treats a pending recipient row as no vote at all', () => {
    const viewer = describeViewerContext(
      input({
        recipients: [
          {
            email: 'manager@example.com',
            kind: ApproverKind.To,
            decision: ApproverDecision.Pending,
          },
        ],
      }),
    )

    expect(viewer.canDecide).toBe(true)
    expect(viewer.ownVote).toBeUndefined()
  })

  it('omits decidedAt from ownVote when the row carries none', () => {
    const viewer = describeViewerContext(
      input({
        recipients: [
          {
            email: 'manager@example.com',
            kind: ApproverKind.To,
            decision: ApproverDecision.Rejected,
          },
        ],
      }),
    )

    expect(viewer.ownVote).toEqual({ decision: ApproverDecision.Rejected })
  })

  it('refuses a copied recipient, who never votes', () => {
    const viewer = describeViewerContext(
      input({
        recipients: [{ email: 'manager@example.com', kind: ApproverKind.Cc }],
      }),
    )

    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Copied,
      canDecide: false,
      // A copied NON-admin has no override authority either.
      canOverride: false,
    })
  })

  it('refuses the requester even when they listed themselves as an approver', () => {
    const viewer = describeViewerContext(
      input({ caller: { ...caller, id: 'employee-1' } }),
    )

    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Requester,
      canDecide: false,
      canOverride: false,
    })
  })

  it('refuses a DECISION from a non-approver admin but grants the OVERRIDE', () => {
    const viewer = describeViewerContext(
      input({
        caller: {
          id: 'admin-1',
          email: 'admin@example.com',
          roles: [AppRoleName.Administrator],
        },
      }),
    )

    // No vote — the admin is not an approver. But an override on a pending
    // request they have no stake in IS theirs to give.
    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Administrator,
      canDecide: false,
      canOverride: true,
    })
  })

  it('grants the override to an admin who is only COPIED, not by their standing', () => {
    const viewer = describeViewerContext(
      input({
        caller: {
          id: 'admin-1',
          email: 'admin@example.com',
          roles: [AppRoleName.Administrator],
        },
        recipients: [{ email: 'admin@example.com', kind: ApproverKind.Cc }],
      }),
    )

    // Being copied classifies them 'copied' and collapses the admin fact out of
    // the standing — so canOverride, keyed off the admin ROLE, is what keeps a
    // copied administrator able to override where a copied employee cannot.
    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Copied,
      canDecide: false,
      canOverride: true,
    })
  })

  it('gives an unspent admin-approver BOTH flags; the vote takes precedence', () => {
    const viewer = describeViewerContext(
      input({
        caller: {
          id: 'manager-1',
          email: 'manager@example.com',
          roles: [AppRoleName.Administrator],
        },
      }),
    )

    // Being an approver no longer strips the admin's override — it only sets hat
    // priority. Both flags are true; the client offers the vote (canDecide),
    // never the override, while the vote is unspent.
    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: true,
      canOverride: true,
    })
  })

  it('keeps the override for an admin-approver whose vote is already spent', () => {
    const viewer = describeViewerContext(
      input({
        caller: {
          id: 'manager-1',
          email: 'manager@example.com',
          roles: [AppRoleName.Administrator],
        },
        recipients: [
          {
            email: 'manager@example.com',
            kind: ApproverKind.To,
            decision: ApproverDecision.Approved,
            decidedAt: '2026-06-02T09:00:00.000Z',
          },
        ],
      }),
    )

    // The deadlock fix: a lone admin who has voted can still change the outcome
    // through an override. canDecide is spent, canOverride remains.
    expect(viewer.standing).toBe(LeaveRequestViewerStanding.Approver)
    expect(viewer.canDecide).toBe(false)
    expect(viewer.canOverride).toBe(true)
    expect(viewer.ownVote?.decision).toBe(ApproverDecision.Approved)
  })

  it('withholds the override on a closed request', () => {
    const viewer = describeViewerContext(
      input({
        status: LeaveRequestStatus.Approved,
        caller: {
          id: 'admin-1',
          email: 'admin@example.com',
          roles: [AppRoleName.Administrator],
        },
      }),
    )

    expect(viewer.canOverride).toBe(false)
  })

  // Administrator is claimed from the roles, never inferred from "none of the
  // above" — otherwise widening read access would hand a plain reader an
  // administrator's account of the page and point them at a console they
  // cannot open.
  it('calls a reader with no standing Unrelated, not an administrator', () => {
    const viewer = describeViewerContext(
      input({
        caller: { id: 'other-1', email: 'other@example.com', roles: [] },
      }),
    )

    expect(viewer).toEqual({
      standing: LeaveRequestViewerStanding.Unrelated,
      canDecide: false,
      // No standing, no override — the exact fail-safe Unrelated exists for.
      canOverride: false,
    })
  })

  it.each([
    LeaveRequestStatus.Approved,
    LeaveRequestStatus.Rejected,
    LeaveRequestStatus.Cancelled,
  ])('refuses a decision on a %s request', (status) => {
    const viewer = describeViewerContext(input({ status }))

    expect(viewer.canDecide).toBe(false)
  })
})

const caller = {
  id: 'manager-1',
  email: 'manager@example.com',
  roles: [] as string[],
}

function input(overrides: Partial<ViewerContextInput> = {}): ViewerContextInput {
  return {
    caller,
    requesterUserId: 'employee-1',
    status: LeaveRequestStatus.Pending,
    recipients: [{ email: 'manager@example.com', kind: ApproverKind.To }],
    ...overrides,
  }
}
