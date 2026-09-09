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
import { LeavePolicyEntity } from './leave-policy.entity'
import { UserEntity } from './user.entity'

// Admin-authored source of truth for how many vacation/sick days a user gets in
// a given leave year. Separates the admin-set total (and mid-year edits) from
// the derived balance cache, and supplies the year dimension the accrual math
// needs. `totalDays` is the divisor for the accrual target; `carriedOverDays`
// is folded additively into accrued at year start.
@Entity('leave_allocations')
@Index(
  'uq_leave_allocations_user_year_type',
  ['userId', 'year', 'leaveType'],
  { unique: true },
)
export class LeaveAllocationEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  @Column({ type: 'int' })
  year!: number

  @Column({ type: 'enum', enum: LeaveType })
  leaveType!: LeaveType

  @Column(day)
  totalDays!: number

  @Column({ ...day, default: 0 })
  carriedOverDays!: number

  // Running signed admin correction for THIS leave year only (vacation
  // surface; sick stays 0). Folded into the accrual target so a credit /
  // debit survives monthly accrual and re-anchor, yet is not copied into the
  // next year as a field — year end carryover consumes residual accrued
  // (which already includes it) under the org carry rules.
  @Column({ ...day, default: 0 })
  manualAdjustmentDays!: number

  // False on a FUTURE year's allocation, created early because someone booked
  // leave into it: the prior year is still running, so its leftover (and hence
  // this carryover) is not knowable yet. carriedOverDays stays 0 and every
  // projection recomputes the carryover on the fly; the first accrual run once
  // the year has actually begun finalizes the real figure and sets this true.
  // Defaults true so every already-materialized row keeps its computed value.
  @Column({ type: 'boolean', default: true })
  carryoverFinalized!: boolean

  // Set when the year close settled THIS year's leftover (carried it forward
  // and/or expired it, with the ledger rows to show for it). A closed year
  // accrues nothing more and refuses re-anchoring — its books are settled.
  // Deliberately its own marker rather than inferred from the successor's
  // carryoverFinalized: a successor can be finalized TRIVIALLY (an account's
  // first year, a pre-employment year), which says nothing about this year
  // having been closed, and inferring closure from it silently voided
  // backdated leave in exactly those states.
  @Column({
    type: 'timestamptz',
    nullable: true,
    transformer: isoDateTimeTransformer,
  })
  closedAt!: string | null

  @Column({ type: 'date', nullable: true })
  accrualStartDate!: string | null

  @Column({ type: 'uuid', nullable: true })
  setByUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'setByUserId' })
  setBy?: UserEntity | null

  // The policy the engine materialized this row's totalDays from — provenance
  // for "where did this figure come from". NULL on pre-engine legacy rows and
  // on history-import writes to closed years, which the resolver never governs.
  @Column({ type: 'uuid', nullable: true })
  sourcePolicyId!: string | null

  @ManyToOne(() => LeavePolicyEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'sourcePolicyId' })
  sourcePolicy?: LeavePolicyEntity | null

  @Column({ type: 'varchar', nullable: true })
  note!: string | null

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
