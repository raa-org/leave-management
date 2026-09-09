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
import { LeavePolicyEntity } from './leave-policy.entity'
import { UserEntity } from './user.entity'

// A user's policy membership timeline. Intervals are HALF-OPEN
// [effectiveFrom, effectiveTo): a transfer effective on day D closes the
// current row at D and opens the successor at D — no gap, no overlap, and a
// transfer effective exactly on Jan 1 gives the new policy the whole year.
// effectiveTo NULL marks the open row; the partial unique index enforces one
// LIVE open row per user. LIVE rows are supersededByRowId IS NULL: a
// retroactive backdated transfer never rewrites or date-edits history rows —
// it appends the replacement and marks the rows it erases as superseded, so
// the audit keeps them visible and test-tooling replay stays deterministic.
// Every timeline read goes through the domain's shared loader (which filters
// superseded rows); never query this table ad hoc.
@Entity('leave_policy_memberships')
@Index('uq_leave_policy_memberships_open', ['userId'], {
  unique: true,
  where: '"effectiveTo" IS NULL AND "supersededByRowId" IS NULL',
})
@Index('idx_leave_policy_memberships_user_from', ['userId', 'effectiveFrom'])
@Index('idx_leave_policy_memberships_policy', ['policyId'])
export class LeavePolicyMembershipEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  // RESTRICT: entitlement history must survive its policy. Deleting a policy
  // is only legal while no membership row ever referenced it — retiring a used
  // policy goes through effectiveTo instead.
  @Column({ type: 'uuid' })
  policyId!: string

  @ManyToOne(() => LeavePolicyEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'policyId' })
  policy?: LeavePolicyEntity

  @Column({ type: 'date' })
  effectiveFrom!: string

  @Column({ type: 'date', nullable: true })
  effectiveTo!: string | null

  // Set by a retroactive backdated transfer on every row it replaces. SET NULL
  // (not RESTRICT) so the user-CASCADE delete never trips over self-FK
  // ordering when a user's rows go away together.
  @Column({ type: 'uuid', nullable: true })
  supersededByRowId!: string | null

  @ManyToOne(() => LeavePolicyMembershipEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'supersededByRowId' })
  supersededBy?: LeavePolicyMembershipEntity | null

  // NULL = auto-provisioned (directory sync, first login) or migration.
  @Column({ type: 'uuid', nullable: true })
  assignedByUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignedByUserId' })
  assignedBy?: UserEntity | null

  @Column({ type: 'varchar', nullable: true })
  note!: string | null

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
