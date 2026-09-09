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
import { HolidayCalendarEntity } from './holiday-calendar.entity'

@Entity('holidays')
@Index('uq_holidays_calendar_date', ['calendarId', 'date'], { unique: true })
export class HolidayEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  calendarId!: string

  @ManyToOne(() => HolidayCalendarEntity, (calendar) => calendar.holidays, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'calendarId' })
  calendar?: HolidayCalendarEntity

  @Column({ type: 'date' })
  date!: string

  @Column({ type: 'varchar' })
  name!: string
}
