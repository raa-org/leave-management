/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('countries')
@Index('uq_countries_code', ['code'], { unique: true })
export class CountryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'varchar' })
  code!: string

  @Column({ type: 'varchar' })
  name!: string

  // Representative IANA timezone for this country's office (from the country
  // catalog). Drives midnight spend recognition for users in this country;
  // null falls back to the settings default timezone.
  @Column({ type: 'varchar', nullable: true })
  timezone!: string | null
}
