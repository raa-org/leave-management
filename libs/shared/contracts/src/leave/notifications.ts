/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The Notification Center's vocabulary. A notification is always addressed to
// ONE concrete user: there is no broadcast/audience form, because the database
// does not know who the administrators are — that role is derived from a
// Keycloak claim on every login and never persisted (see
// AuthOidcUserProfileMapper). Group addressing is deferred, not worked around.

// What happened. The type drives only the icon and the deep link; who acted and
// how is carried by the snapshotted `summary`, which is why an administrator
// override needs no member of its own.
export enum NotificationType {
  // You are a designated approver and the request is waiting on your decision.
  ApprovalNeeded = 'approval_needed',
  // Another approver approved, but the request is still short of the full set.
  ApprovalProgressed = 'approval_progressed',
  RequestApproved = 'request_approved',
  RequestRejected = 'request_rejected',
  // The requester withdrew a request you were asked to decide.
  RequestCancelled = 'request_cancelled',
}

export interface NotificationDto {
  notificationId: string
  type: NotificationType
  // Display name of the person who caused this notification (the one named at
  // the start of `summary`): the requester for an approval-needed row, the
  // approver/admin for a decision. Snapshotted like `summary`, so the row's
  // avatar stays right after a rename. The client derives initials + a colour.
  actorLabel: string
  // Self-contained sentence snapshotted at write time, so the row still reads
  // correctly after the people or the request it names have changed.
  summary: string
  // The leave request this is about; always present, so the deep link always
  // resolves.
  requestId: string
  occurredAt: string
  // Absent until the recipient reads it.
  readAt?: string
  // The second half of an ask's life, absent until the row's question is
  // closed. Only `approval_needed` and `approval_progressed` rows ever gain
  // these: a decision-outcome row IS the outcome and has nothing to close.
  // Resolution never changes what a row SAYS — the client always renders the
  // frozen `summary`; these fields drive the row's settled state (chip,
  // counters, pinning). What happened to the request travels as its own
  // outcome/news row.
  resolvedAt?: string
  // Who closed it. The client compares this with the signed-in user to pick
  // the chip: settled by you vs settled without you.
  resolvedByUserId?: string
  // Snapshot of the closer's display name (like actorLabel), surviving
  // renames and the closer's account. Not rendered today — kept so a future
  // tooltip/meta-line can say who settled the question without a migration.
  resolvedByLabel?: string
  // Subject-less snapshotted sentence, e.g. "approved David Brooks' vacation
  // request for 2026-07-23 to 2026-07-23". Not rendered today — the record of
  // HOW the question closed, available to a future tooltip/meta-line.
  resolutionText?: string
}

export interface NotificationListDto {
  items: NotificationDto[]
  // Counts EVERY unread notification, not just the ones in `items` (which is a
  // page of the newest-first feed). Both figures come from the same request, so
  // they cannot drift apart — but they answer different questions.
  unreadCount: number
  // Open `approval_needed` rows across the whole table: decisions still waiting
  // on this recipient. Distinct from unreadCount — reading an ask does not
  // decide it — and table-wide for the same reason: an ask older than the
  // loaded pages must still keep the bell's work indicator lit.
  openAskCount: number
  // Opaque keyset cursor — pass nextCursor back verbatim to fetch the next
  // (older) page; never construct it client-side. Absent when the feed is
  // exhausted.
  nextCursor?: string
}
