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
import { NotificationDeliveryStatus } from '@workspace/contracts'
import { isoDateTimeTransformer } from '../database/column-transformers'
import { LeaveRequestEntity } from '../domain/entities/leave-request.entity'

// One row per delivery attempt (append-only). `createdAt` preserves insertion order.
@Entity('notification_deliveries')
@Index('idx_notification_deliveries_request', ['requestId'])
export class NotificationDeliveryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  @Column({ type: 'uuid', nullable: true })
  requestId!: string | null

  @ManyToOne(() => LeaveRequestEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'requestId' })
  request?: LeaveRequestEntity | null

  @Column({ type: 'varchar' })
  subject!: string

  @Column({ type: 'text', array: true })
  to!: string[]

  @Column({ type: 'text', array: true })
  cc!: string[]

  @Column({ type: 'varchar', nullable: true })
  approvalUrl!: string | null

  @Column({ type: 'enum', enum: NotificationDeliveryStatus })
  status!: NotificationDeliveryStatus

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  queuedAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string

  @Column({ type: 'varchar', nullable: true })
  messageId!: string | null

  @Column({ type: 'varchar', nullable: true })
  errorMessage!: string | null
}
