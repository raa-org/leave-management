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
import { CountryEntity } from './country.entity'

@Entity('users')
@Index('uq_users_normalized_email', ['normalizedEmail'], { unique: true })
@Index('uq_users_subject', ['subject'], {
  unique: true,
  where: 'subject IS NOT NULL',
})
export class UserEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'varchar', nullable: true })
  subject!: string | null

  @Column({ type: 'varchar' })
  email!: string

  @Column({ type: 'varchar' })
  normalizedEmail!: string

  @Column({ type: 'varchar' })
  displayName!: string

  // Office / country. Provisioning ensures the country exists (ensureCountry),
  // so this FK always resolves; SET NULL keeps users if a country is removed.
  @Column({ type: 'varchar', nullable: true })
  countryCode!: string | null

  @ManyToOne(() => CountryEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'countryCode', referencedColumnName: 'code' })
  country?: CountryEntity | null

  // Optional override for which country's holiday calendar drives leave-day
  // counting and the employee UI. When null, the employee's countryCode applies.
  @Column({ type: 'varchar', nullable: true })
  holidayCalendarCountryCode!: string | null

  // The FK name is pinned to what AddUserHolidayCalendarCountry created;
  // without it the generator keeps proposing a rename to the hashed default.
  @ManyToOne(() => CountryEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'holidayCalendarCountryCode',
    referencedColumnName: 'code',
    foreignKeyConstraintName: 'FK_users_holiday_calendar_country',
  })
  holidayCalendarCountry?: CountryEntity | null

  // Accrual anchor: proration counts months from max(year start, this date), so
  // a mid-year joiner is not granted a full year on day one. Admin-overridable
  // per employee (correct an OIDC-provided or missing hire date).
  @Column({ type: 'date', nullable: true })
  employmentStartDate!: string | null

  // Employment status mirrored from the directory (LDAP): the sync flips this
  // to false when the person disappears from the directory instead of deleting
  // the row — leave requests, balances and audit entries keep their FK target.
  @Column({ type: 'boolean', default: true })
  active!: boolean

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
