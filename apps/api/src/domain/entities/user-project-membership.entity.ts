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
import { ProjectEntity } from './project.entity'
import { UserEntity } from './user.entity'

// Which projects a user belongs to and their role-on-project (from OIDC).
// Replaced in full from the OIDC claim on each login. `approverEligible` flags
// members whose emails are suggested as approvers when the OIDC role vocabulary
// does not cleanly distinguish leads/managers.
@Entity('user_project_memberships')
@Index(
  'uq_user_project_memberships_user_project',
  ['userId', 'projectId'],
  { unique: true },
)
@Index('idx_user_project_memberships_project', ['projectId'])
export class UserProjectMembershipEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  @Column({ type: 'uuid' })
  projectId!: string

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project?: ProjectEntity

  @Column({ type: 'varchar' })
  roleOnProject!: string

  @Column({ type: 'boolean', default: false })
  approverEligible!: boolean

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  assignedAt!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  updatedAt!: string
}
