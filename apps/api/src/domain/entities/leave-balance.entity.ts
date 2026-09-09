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
import { LeaveType } from '@workspace/contracts'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { dayColumn as day } from './day-column'
import { UserEntity } from './user.entity'

@Entity('leave_balances')
@Index('uq_leave_balances_user_type_year', ['userId', 'leaveType', 'year'], {
  unique: true,
})
export class LeaveBalanceEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  @Column({ type: 'enum', enum: LeaveType })
  leaveType!: LeaveType

  // Leave year this balance is for. The cache is keyed per (userId, leaveType,
  // year) so accrued/onHold/spent reset every January instead of accumulating
  // as lifetime counters (which deadlocked accrual on Jan 1).
  @Column({ type: 'int' })
  year!: number

  // Primitives only. totalDays lives on leave_allocations; display available
  // (accrued - spent) and bookable (accrued - onHold - spent) are derived.
  @Column(day)
  accruedDays!: number

  @Column(day)
  onHoldDays!: number

  @Column(day)
  spentDays!: number

  // Default lets the rename migration ADD this NOT NULL column on a populated
  // (rebuildable) cache without a truncate; the app always sets it explicitly.
  @Column({
    type: 'timestamptz',
    default: () => 'clock_timestamp()',
    transformer: isoDateTimeTransformer,
  })
  updatedAt!: string
}
