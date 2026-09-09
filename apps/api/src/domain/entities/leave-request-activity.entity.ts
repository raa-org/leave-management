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
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { LeaveRequestEntity } from './leave-request.entity'
import { UserEntity } from './user.entity'

// Append-only per-request timeline; `createdAt` preserves insertion order.
// The admin activity feed does NOT read this table — it uses the denormalized
// (lastAction, lastActivityAt) snapshot on leave_requests, which addActivity
// keeps in sync with the newest row here.
@Entity('leave_request_activities')
@Index('idx_leave_request_activities_request', ['requestId', 'createdAt'])
export class LeaveRequestActivityEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  @Column({ type: 'uuid' })
  requestId!: string

  @ManyToOne(() => LeaveRequestEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request?: LeaveRequestEntity

  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actor?: UserEntity | null

  // Label for system-generated events (actorUserId IS NULL). When actorUserId
  // is present the actor's name is joined from users instead.
  @Column({ type: 'varchar', nullable: true })
  systemActorLabel!: string | null

  @Column({ type: 'varchar' })
  action!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  occurredAt!: string

  @Column({ type: 'varchar', nullable: true })
  comment!: string | null
}
