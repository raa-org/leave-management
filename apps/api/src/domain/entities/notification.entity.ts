/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm'
import { NotificationType } from '@workspace/contracts'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { LeaveRequestEntity } from './leave-request.entity'
import { UserEntity } from './user.entity'

// One notification addressed to ONE user. This table is the source of truth for
// the Notification Center: the realtime stream is only a signal to refetch it,
// so a dropped signal delays a refresh and never loses a notification, and a
// recipient who was offline at write time simply finds the row at next sign-in.
//
// Two decisions are load-bearing:
//  - `readAt` is a column ON the row, which only works because every
//    notification has a concrete recipient. There is no audience/broadcast form
//    (the DB cannot enumerate administrators — that role comes from a Keycloak
//    claim per login and is never persisted), so no separate reads table.
//  - `summary` is snapshotted, so the row stays readable after the request or
//    the people it names change.
//
// `createdAt` preserves true insertion order; the feed is paginated newest-first
// on (occurredAt, id), matching audit_logs.
@Entity('notifications')
@Index('idx_notifications_recipient_feed', ['recipientUserId', 'occurredAt', 'id'])
// Serves resolveOpenRows (WHERE "requestId" … "resolvedAt" IS NULL) and the
// FK-cascade lookups when a request is deleted; the feed index above starts
// with the recipient and cannot help either.
@Index('idx_notifications_request', ['requestId'])
// Serves getNotifications' table-wide openAskCount. Partial on purpose: rows
// leave the index the moment their ask resolves, so it stays the size of the
// OPEN work (a handful per user) while the journal grows forever.
@Index('idx_notifications_open_asks', ['recipientUserId'], {
  where: `"type" = 'approval_needed' AND "resolvedAt" IS NULL`,
})
// Serves the SET NULL enforcement when a user is deleted — without it that
// delete seq-scans the whole journal (recipientUserId's CASCADE is covered by
// the feed index's leading column; this FK column was not).
@Index('idx_notifications_resolved_by', ['resolvedByUserId'])
export class NotificationEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  // Fed the mutation's OWN already-computed instant (submittedAt / decidedAt /
  // occurredAt), never a fresh clock read: the notification must not disagree
  // with the audit row it commits beside, and the gated test clock must keep
  // working.
  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  occurredAt!: string

  // Deliberately CASCADE, unlike audit_logs' SET NULL: an audit row is a
  // compliance record that must outlive its actor, whereas a notification
  // addressed to a deleted user is unreachable garbage.
  @Column({ type: 'uuid' })
  recipientUserId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipientUserId' })
  recipient?: UserEntity

  @Column({ type: 'enum', enum: NotificationType })
  type!: NotificationType

  // Snapshot of the acting person's display name (see NotificationDto.actorLabel).
  // Snapshotted, not joined: the summary beside it is already a snapshot, so the
  // avatar this drives stays consistent with the sentence after a rename.
  @Column({ type: 'varchar' })
  actorLabel!: string

  // Every notification is request-scoped, so this is NOT NULL and the deep link
  // always resolves. CASCADE matters: a leave-data reset really does delete
  // requests, and without it the bell would link to a 404.
  @Column({ type: 'uuid' })
  requestId!: string

  @ManyToOne(() => LeaveRequestEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request?: LeaveRequestEntity

  @Column({ type: 'varchar' })
  summary!: string

  @Column({
    type: 'timestamptz',
    nullable: true,
    transformer: isoDateTimeTransformer,
  })
  readAt!: string | null

  // The second, initially-empty half of an ask row: how its question was
  // closed. Only `approval_needed` / `approval_progressed` rows are ever
  // resolved. `summary` stays frozen AND stays the rendered text — resolution
  // drives the row's settled state (chip, counters), never its sentence.
  // Resolution NEVER touches `readAt` in either direction — "read" means
  // exactly "the recipient opened this row".
  @Column({
    type: 'timestamptz',
    nullable: true,
    transformer: isoDateTimeTransformer,
  })
  resolvedAt!: string | null

  // SET NULL, unlike the recipient's CASCADE: a row addressed to a deleted user
  // is garbage, but a row whose CLOSER left must keep telling its recipient
  // what happened — the display name survives in resolvedByLabel.
  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolvedByUserId' })
  resolvedBy?: UserEntity

  // Snapshot of the closer's display name, resolvedByLabel to actorLabel as
  // "who closed it" is to "who opened it".
  @Column({ type: 'varchar', nullable: true })
  resolvedByLabel!: string | null

  // Subject-less sentence ("approved X's vacation request for A to B") — the
  // durable record of HOW the question closed. Not rendered today; kept for a
  // future tooltip/meta-line beside the frozen summary.
  @Column({ type: 'varchar', nullable: true })
  resolutionText!: string | null
}
