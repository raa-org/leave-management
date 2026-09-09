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
import { LeaveApprovalAction } from '@workspace/contracts'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { LeaveRequestEntity } from './leave-request.entity'
import { UserEntity } from './user.entity'

@Entity('leave_approval_decisions')
@Index('idx_leave_approval_decisions_request', ['requestId'])
export class LeaveApprovalDecisionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

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

  // Actor name is joined from users at read time (no snapshot).

  @Column({ type: 'enum', enum: LeaveApprovalAction })
  action!: LeaveApprovalAction

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  occurredAt!: string

  @Column({ type: 'varchar', nullable: true })
  comment!: string | null
}
