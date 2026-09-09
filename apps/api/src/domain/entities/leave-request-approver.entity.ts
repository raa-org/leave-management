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
import { ApproverDecision, ApproverKind } from '@workspace/contracts'
import {
  isoDateTimeTransformer,
  normalizedEmailTransformer,
} from '../../database/column-transformers'
import { LeaveRequestEntity } from './leave-request.entity'
import { UserEntity } from './user.entity'

@Entity('leave_request_approvers')
@Index('uq_leave_request_approvers_request_email', ['requestId', 'email'], {
  unique: true,
})
export class LeaveRequestApproverEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  @Column({ type: 'uuid' })
  requestId!: string

  @ManyToOne(() => LeaveRequestEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request?: LeaveRequestEntity

  // Stored normalized (lowercase/trimmed) — the activity feed's approver
  // filter matches this column with exact SQL equality, so the transformer
  // enforces the canonical form for every write path.
  @Column({ type: 'varchar', transformer: normalizedEmailTransformer })
  email!: string

  @Column({ type: 'enum', enum: ApproverKind })
  kind!: ApproverKind

  @Column({ type: 'varchar', nullable: true })
  displayName!: string | null

  // Per-approver current decision (last-wins). Only kind='to' rows count toward
  // the all-approvers gate; cc rows stay 'pending' forever. Existing rows start
  // 'pending' via the default (no backfill).
  @Column({ type: 'enum', enum: ApproverDecision, default: ApproverDecision.Pending })
  decision!: ApproverDecision

  @Column({
    type: 'timestamptz',
    nullable: true,
    transformer: isoDateTimeTransformer,
  })
  decidedAt!: string | null

  @Column({ type: 'varchar', nullable: true })
  decisionComment!: string | null

  // The app user who recorded the decision.
  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actor?: UserEntity | null
}
