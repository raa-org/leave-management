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
import {
  AppRoleName,
  AuditActionKind,
  AuditCategory,
  AuditEventType,
  type AuditFieldChangeDto,
  type AuditStateSnapshot,
} from '@workspace/contracts'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { UserEntity } from './user.entity'

// Append-only, immutable cross-cutting audit trail: who did what, over whom, and
// the before/after state. Distinct from `leave_request_activities` (the request
// lifecycle feed) — this table covers settings, holidays, allocations, roles,
// profile edits, auth, and the request lifecycle in one place. `createdAt`
// preserves insertion order; the feed is paginated newest-first on
// (occurredAt, id) via idx_audit_logs_feed.
@Entity('audit_logs')
@Index('idx_audit_logs_feed', ['occurredAt', 'id'])
@Index('idx_audit_logs_target', ['targetUserId', 'occurredAt', 'id'])
@Index('idx_audit_logs_actor', ['actorUserId', 'occurredAt', 'id'])
@Index('idx_audit_logs_category', ['category', 'occurredAt', 'id'])
export class AuditLogEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  occurredAt!: string

  @Column({ type: 'enum', enum: AuditEventType })
  eventType!: AuditEventType

  @Column({ type: 'enum', enum: AuditCategory })
  category!: AuditCategory

  @Column({ type: 'enum', enum: AuditActionKind })
  action!: AuditActionKind

  // Null for system-generated events. FK SET NULL so purging a user keeps the
  // durable trail (the snapshotted actorLabel/actorEmail survive).
  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actor?: UserEntity | null

  // Snapshotted, not joined: the trail must survive rename/deletion of the user.
  @Column({ type: 'varchar' })
  actorLabel!: string

  @Column({ type: 'varchar', nullable: true })
  actorEmail!: string | null

  // Roles held at action time. The `administrator` role is granted per-login by
  // Keycloak and never persisted, so it cannot be reconstructed later — capture
  // it here. Default written as a bare `'[]'` (not `'[]'::jsonb`) to match how
  // Postgres introspects the jsonb default, avoiding perpetual migration drift.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  actorRoles!: AppRoleName[]

  // The user the event is about (subject). SET NULL keeps the row if the target
  // user is removed.
  @Column({ type: 'uuid', nullable: true })
  targetUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'targetUserId' })
  target?: UserEntity | null

  @Column({ type: 'varchar', nullable: true })
  targetLabel!: string | null

  @Column({ type: 'varchar' })
  entityType!: string

  @Column({ type: 'varchar', nullable: true })
  entityId!: string | null

  @Column({ type: 'varchar' })
  summary!: string

  // Null when the object did not exist (before a create / after a delete).
  @Column({ type: 'jsonb', nullable: true })
  beforeState!: AuditStateSnapshot | null

  @Column({ type: 'jsonb', nullable: true })
  afterState!: AuditStateSnapshot | null

  @Column({ type: 'jsonb', nullable: true })
  changedFields!: AuditFieldChangeDto[] | null

  // Optional deep-link target when the event concerns a leave request.
  @Column({ type: 'uuid', nullable: true })
  requestId!: string | null
}
