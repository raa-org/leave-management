/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveNotificationsModule } from '../notifications/leave-notifications.module'
import { AdminLeaveController } from './admin-leave.controller'
import { AdminPolicyController } from './admin-policy.controller'
import { TestToolingController } from './test-tooling.controller'

@Module({
  imports: [CqrsModule, LeaveDomainModule, LeaveNotificationsModule],
  controllers: [
    AdminLeaveController,
    AdminPolicyController,
    TestToolingController,
  ],
})
export class AdminLeaveModule {}
