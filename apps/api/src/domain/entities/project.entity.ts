/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm'
import { isoDateTimeTransformer } from '../../database/column-transformers'

// Mirror of the projects supplied by OIDC/Keycloak. Upserted by `externalId` on
// login so OIDC stays the source of truth. Backs approver suggestions via
// user_project_memberships.
@Entity('projects')
@Index('uq_projects_external', ['externalId'], { unique: true })
export class ProjectEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'varchar' })
  externalId!: string

  @Column({ type: 'varchar', nullable: true })
  key!: string | null

  @Column({ type: 'varchar' })
  name!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  createdAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
