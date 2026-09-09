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
  OneToMany,
  PrimaryColumn,
} from 'typeorm'
import { isoDateTimeTransformer } from '../../database/column-transformers'
import { CountryEntity } from './country.entity'
import { HolidayEntity } from './holiday.entity'

// One official-holiday calendar per country per year. The clone target:
// cloning inserts a new calendar row for the target year and copies its holiday
// rows (shifting dates to that year). `sourceCalendarId` records provenance.
// countryCode -> countries.code is RESTRICT so deleting a country cannot wipe
// its calendars and their frozen holiday history.
@Entity('holiday_calendars')
@Index('uq_holiday_calendars_country_year', ['countryCode', 'year'], {
  unique: true,
})
export class HolidayCalendarEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'varchar' })
  countryCode!: string

  @ManyToOne(() => CountryEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'countryCode', referencedColumnName: 'code' })
  country?: CountryEntity

  @Column({ type: 'int' })
  year!: number

  @Column({ type: 'varchar', nullable: true })
  name!: string | null

  @Column({ type: 'uuid', nullable: true })
  sourceCalendarId!: string | null

  @ManyToOne(() => HolidayCalendarEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'sourceCalendarId' })
  sourceCalendar?: HolidayCalendarEntity | null

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string

  @OneToMany(() => HolidayEntity, (holiday) => holiday.calendar)
  holidays?: HolidayEntity[]
}
