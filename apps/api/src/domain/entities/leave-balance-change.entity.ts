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
import { LeaveBalanceChangeReason, LeaveType } from '@workspace/contracts'
import { dayColumn as day } from './day-column'
import { UserEntity } from './user.entity'

// Append-only balance ledger. `createdAt` (per-row insertion time) is the
// stable timeline order, since the change only stores effectiveDate (a date),
// not a full timestamp — and the writers append IN CHRONOLOGICAL ORDER, a
// catch-up covering months of dormancy included, so insertion order really is
// the order the movements happened. That is also what makes the running
// figures frozen on each row (accruedDays/onHoldDays/spentDays) readable: they
// only make sense read in the order they were written.
@Entity('leave_balance_changes')
@Index('idx_leave_balance_changes_user_type', [
  'userId',
  'leaveType',
  'year',
  'createdAt',
])
export class LeaveBalanceChangeEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  @Column({ type: 'date' })
  effectiveDate!: string

  @Column({ type: 'enum', enum: LeaveType })
  leaveType!: LeaveType

  // Leave year this ledger entry belongs to (so a year is a fold over its own
  // entries). Backfilled from effectiveDate.
  @Column({ type: 'int' })
  year!: number

  @Column(day)
  deltaDays!: number

  // Running snapshots after this entry. Only the three primitives are stored;
  // display available (accrued - spent) is derived at read time.
  @Column(day)
  accruedDays!: number

  @Column(day)
  onHoldDays!: number

  @Column(day)
  spentDays!: number

  @Column({ type: 'enum', enum: LeaveBalanceChangeReason })
  reason!: LeaveBalanceChangeReason

  @Column({ type: 'varchar', nullable: true })
  note!: string | null
}
