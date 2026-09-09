/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Check, Column, Entity, PrimaryColumn } from 'typeorm'
import { CarryoverCapMode, CarryoverPolicy } from '@workspace/contracts'
import { isoDateTimeTransformer } from '../../database/column-transformers'

// Single-row settings table (id is always SETTINGS_SINGLETON_ID). Countries and
// holiday calendars are NOT stored here; they live in their own tables and are
// joined into LeaveSettingsDto at read time.
export const SETTINGS_SINGLETON_ID = 1

@Entity('leave_settings')
// Singleton guard: the fixed int PK already blocks a duplicate id=1; this pins
// the table to that one row so no second settings row (id=2) can be inserted.
// (Not an enum domain check, so it stays a CHECK.)
@Check('chk_leave_settings_singleton', `"id" = 1`)
export class LeaveSettingsEntity {
  @PrimaryColumn({ type: 'int' })
  id!: number

  @Column({ type: 'int' })
  defaultVacationDays!: number

  @Column({ type: 'int' })
  defaultSickDays!: number

  // Whether a leave request needs a human decision. Default true keeps the
  // classic behavior for every existing installation without a backfill.
  // False makes approval optional: defaultApproverEmails stop being folded
  // onto submissions (a request nobody is addressed to is approved by the
  // system at once), while defaultCcApproverEmails keep being folded in under
  // either mode — a copied recipient never decides anything.
  @Column({ type: 'boolean', default: true })
  approvalRequired!: boolean

  @Column({ type: 'text', array: true })
  defaultApproverEmails!: string[]

  @Column({ type: 'text', array: true })
  defaultCcApproverEmails!: string[]

  // How unused leave days roll into the next year. Defaulted so the existing
  // singleton row is valid without a data backfill.
  @Column({
    type: 'enum',
    enum: CarryoverPolicy,
    default: CarryoverPolicy.Capped,
  })
  carryoverPolicy!: CarryoverPolicy

  @Column({ type: 'int', default: 0 })
  carryoverCapDays!: number

  // Which cap the `capped` policy reads: carryoverCapDays, or carryoverCapPercent
  // as a share of either the leftover (`percent`) or the year's earned
  // entitlement, hire-month prorated in the year of joining
  // (`percent_of_total`). The percent default matches the company policy, so a
  // fresh install carries half the leftover without an admin touching anything.
  // A row that predates this column is corrected by the paired backfill:
  // an already-capped policy meant days, never percent.
  @Column({
    type: 'enum',
    enum: CarryoverCapMode,
    default: CarryoverCapMode.Percent,
  })
  carryoverCapMode!: CarryoverCapMode

  @Column({ type: 'int', default: 50 })
  carryoverCapPercent!: number

  // The org-wide fallback timezone: used for an employee whose country is not
  // set, or whose country carries no zone. A leave day is spent at midnight on
  // this calendar and the leave year turns over on it.
  @Column({ type: 'varchar', default: 'Europe/Kyiv' })
  defaultTimezone!: string

  // How many hours a full workday is. The divisor that turns a booking in hours
  // into a fraction of a day: at 8, two hours off is 0.25 of a day. Whole hours
  // only, and org-wide on purpose — a per-employee day length would make one
  // employee's day worth more balance than another's, which is a payroll
  // decision the leave books do not get to make.
  @Column({ type: 'int', default: 8 })
  hoursPerDay!: number

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
