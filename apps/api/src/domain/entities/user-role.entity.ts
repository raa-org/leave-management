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
import { AppRoleName } from '@workspace/contracts'
import { UserEntity } from './user.entity'

@Entity('user_roles')
@Index('idx_user_roles_user', ['userId'])
@Index('uq_user_roles_user_role', ['userId', 'roleName'], { unique: true })
export class UserRoleEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  userId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity

  @Column({ type: 'enum', enum: AppRoleName })
  roleName!: AppRoleName

  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  assignedAt!: Date
}
