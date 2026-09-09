/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { dayColumn as day } from './day-column'
import { UserEntity } from './user.entity'

// A leave policy group: the terms of an offer (vacation/sick allowance, annual
// increment, probation), assigned to users via leave_policy_memberships. TERMS
// ARE IMMUTABLE after creation — "editing" terms is modeled as supersede
// (create the corrected policy, transfer the members); only name, description,
// effectiveTo and the default flag ever change in place. Immutability is what
// keeps the dedup fingerprint stable, the audit history true, and the
// test-tooling reset/replay deterministic.
@Entity('leave_policies')
@Index('idx_leave_policies_fingerprint', ['termsFingerprint'])
@Index('uq_leave_policies_default', ['isDefault'], {
  unique: true,
  where: '"isDefault" = true',
})
@Check(
  'chk_leave_policies_validity',
  '"effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"',
)
export class LeavePolicyEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  // Unique case-insensitively, enforced app-side under the policy-catalog
  // advisory lock — an expression index on lower(name) cannot be produced by
  // generated migrations.
  @Column({ type: 'varchar' })
  name!: string

  @Column({ type: 'varchar', nullable: true })
  description!: string | null

  @Column(day)
  vacationDays!: number

  @Column(day)
  sickDays!: number

  // +N vacation days every vacationIncrementEveryYears calendar years of
  // employment (steps anchored to the hire year, applied by the resolver per
  // allocation year); 0 = no automatic revision.
  @Column({ ...day, default: 0 })
  vacationAnnualIncrement!: number

  // Years between two increment steps; 1 = every year, which is what every row
  // written before this column existed means. Coerced back to 1 when the
  // increment is 0, so an inert period cannot fingerprint two identical deals
  // apart.
  @Column({ type: 'int', default: 1 })
  vacationIncrementEveryYears!: number

  // Upper bound the increment may grow vacationDays to; NULL = uncapped.
  @Column({ ...day, nullable: true })
  vacationIncrementCapDays!: number | null

  @Column({ type: 'int', default: 0 })
  probationMonths!: number

  // When true, sick requests during probation stay paid; vacation days inside
  // the probation window are always forced unpaid. Meaningful only with
  // probationMonths > 0 — the writer refuses the true/0 combination so two
  // behaviorally identical policies cannot carry distinct fingerprints.
  @Column({ type: 'boolean', default: false })
  paidSickDuringProbation!: boolean

  // The policy's own validity window; effectiveTo NULL is the required
  // "active forever" variant. Setting/shortening effectiveTo is refused while
  // open members remain without a scheduled successor, so resolution never
  // meets an expired policy that still governs someone.
  @Column({ type: 'date' })
  effectiveFrom!: string

  @Column({ type: 'date', nullable: true })
  effectiveTo!: string | null

  // Exactly one default policy exists (partial unique index above). New users
  // are enrolled into it at provisioning; it can be neither deleted nor given
  // an effectiveTo.
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean

  // Canonical readable fingerprint of the term fields (see
  // policy-fingerprint.ts). Deliberately NOT unique in the database: an
  // expired twin is legal (re-introducing last era's terms), so duplicate
  // detection among non-expired policies is app-level, under the same
  // advisory lock as the name check.
  @Column({ type: 'varchar', length: 160 })
  termsFingerprint!: string

  // NULL = created by the system (bootstrap migration).
  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'createdByUserId' })
  createdBy?: UserEntity | null

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
