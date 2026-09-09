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
  normalizeEmail,
} from '@workspace/contracts'
import type {
  LeaveRequestDetailDto,
  LeaveRequestViewerContextDto,
} from '@workspace/contracts'

/**
 * "What is this caller's standing on this request, and may they act on it?"
 * answered in ONE place.
 *
 * Two surfaces ask it — the review page (one request) and the admin console
 * feed (a page of them) — and they must never disagree: a console that thinks
 * an admin may override while the review page thinks they may vote would put
 * the same person through two different doors for one request. Pure and
 * storage-free on purpose, so both callers can feed it whatever they already
 * loaded, and so the rules below are testable without a database.
 */
export type ViewerContextInput = {
  caller: {
    id: string
    email: string
    roles: string[]
  }
  requesterUserId: string
  status: LeaveRequestStatus
  recipients: Array<{
    email: string
    kind: ApproverKind
    decision?: ApproverDecision
    // `| null` so a raw LeaveRequestApproverEntity row (decidedAt: string | null)
    // is accepted directly, alongside the DTO's string | undefined. A null is
    // treated as "no timestamp" — the truthiness check when building ownVote
    // drops it either way.
    decidedAt?: string | null
  }>
}

export function describeViewerContext(
  input: ViewerContextInput,
): LeaveRequestViewerContextDto {
  // One pass over the recipients captures both the caller's 'to' and 'cc' rows,
  // and normalizes the caller's email once, rather than scanning twice.
  const { toRow, ccRow } = findCallerRows(input)
  const isRequester = input.requesterUserId === input.caller.id
  const isAdmin = isAdministrator(input.caller.roles)
  // A requester is never an approver-actor on their own request, so drop their
  // 'to' row at the SOURCE. Everything derived from it — ownVote, canDecide's
  // `ownRow !== undefined`, and the standing — then follows without each having
  // to re-check isRequester. (The backend rejects a self-listed approver on
  // submit; this only guards a legacy/imported row that still carries one.)
  const ownRow = isRequester ? undefined : toRow
  // Both action rights require an OPEN request that is not your own; each then
  // adds its own condition (a vote, or the admin role). Named once so the two
  // flags cannot drift on the shared part.
  const openAndNotOwn =
    !isRequester && input.status === LeaveRequestStatus.Pending

  // The caller's own cast vote in final DTO shape, or undefined. Narrowed to
  // exclude Pending: a row still sitting at Pending has not been acted on, so it
  // is "no vote" (ownRow is already undefined for the requester, see above).
  // Built once here (decidedAt dropped when null) and emitted as-is below.
  const ownVote =
    ownRow &&
    ownRow.decision !== undefined &&
    ownRow.decision !== ApproverDecision.Pending
      ? {
          decision: ownRow.decision,
          ...(ownRow.decidedAt ? { decidedAt: ownRow.decidedAt } : {}),
        }
      : undefined

  return {
    standing: describeStanding(
      isRequester,
      ownRow !== undefined,
      ccRow !== undefined,
      isAdmin,
    ),
    // The decision endpoint's conditions and nothing else: an open, not-your-own
    // request where you are a designated 'to' approver who has not yet voted (a
    // vote is cast once; administrators get no bypass here — that is the override
    // below).
    canDecide: openAndNotOwn && ownRow !== undefined && ownVote === undefined,
    // The override endpoint's conditions. Keyed off the admin ROLE, not the
    // per-request standing: an admin who is merely copied is classified 'copied',
    // so inferring override rights from the standing would both deny them and
    // hand the same rights to a copied non-admin. Being an approver does NOT
    // remove it — a voted admin-approver may still override; the client routes
    // them to the vote first (canDecide) while it is unspent.
    canOverride: openAndNotOwn && isAdmin,
    ...(ownVote ? { ownVote } : {}),
  }
}

/**
 * Attach-viewer seam for a single request detail: the one mapping from a
 * LeaveRequestDetailDto (+ caller) onto describeViewerContext's inputs. Both the
 * employee detail/decision responses and the admin console read through this, so
 * the "detail → viewer" shape lives once and cannot drift between surfaces.
 */
export function describeViewerContextForDetail(
  caller: ViewerContextInput['caller'],
  detail: LeaveRequestDetailDto,
): LeaveRequestViewerContextDto {
  return describeViewerContext({
    caller,
    requesterUserId: detail.requesterUserId,
    status: detail.status,
    recipients: detail.approvers,
  })
}

// Ordered by precedence of involvement, not by how they got read access: being
// the requester outranks everything (it is why they may not decide), and an
// administrator who is also an approver is reported as an approver, since that
// is the hat they act in first. Administrator is CLAIMED from the admin role,
// never inferred from "none of the above" — a caller who is none of these is
// Unrelated, so this is safe to call for anyone without mislabelling a non-admin
// as an administrator.
function describeStanding(
  isRequester: boolean,
  isToApprover: boolean,
  isCopied: boolean,
  isAdmin: boolean,
): LeaveRequestViewerStanding {
  if (isRequester) {
    return LeaveRequestViewerStanding.Requester
  }

  if (isToApprover) {
    return LeaveRequestViewerStanding.Approver
  }

  if (isCopied) {
    return LeaveRequestViewerStanding.Copied
  }

  return isAdmin
    ? LeaveRequestViewerStanding.Administrator
    : LeaveRequestViewerStanding.Unrelated
}

// The single definition of "which recipient rows are this caller's", resolved in
// ONE pass so the caller email is normalized once and the array is walked once.
// A future change to the matching rule (say, the ldapEntryUuid escalation path)
// lands in callerMatches here rather than drifting across surfaces.
function findCallerRows(input: ViewerContextInput): {
  toRow?: ViewerContextInput['recipients'][number]
  ccRow?: ViewerContextInput['recipients'][number]
} {
  const normalizedCaller = normalizeEmail(input.caller.email)
  const callerMatches = (recipient: ViewerContextInput['recipients'][number]) =>
    normalizeEmail(recipient.email) === normalizedCaller

  let toRow: ViewerContextInput['recipients'][number] | undefined
  let ccRow: ViewerContextInput['recipients'][number] | undefined
  for (const recipient of input.recipients) {
    if (!callerMatches(recipient)) {
      continue
    }
    // First match per kind wins, matching the prior find() semantics.
    if (recipient.kind === ApproverKind.To) {
      toRow ??= recipient
    } else if (recipient.kind === ApproverKind.Cc) {
      ccRow ??= recipient
    }
  }

  return { toRow, ccRow }
}

export function isAdministrator(roles: string[]): boolean {
  // Trust the roles on the authenticated profile — the literal mirror of the
  // token's roles, one source with nothing to reconcile — consistent with the
  // admin controller and the frontend gate.
  return roles.includes(AppRoleName.Administrator)
}
