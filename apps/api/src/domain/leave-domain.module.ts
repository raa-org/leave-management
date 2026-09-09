/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CountryEntity } from './entities/country.entity'
import { HolidayEntity } from './entities/holiday.entity'
import { LeaveApprovalDecisionEntity } from './entities/leave-approval-decision.entity'
import { LeaveBalanceEntity } from './entities/leave-balance.entity'
import { LeaveBalanceChangeEntity } from './entities/leave-balance-change.entity'
import { LeaveRequestEntity } from './entities/leave-request.entity'
import { LeaveRequestActivityEntity } from './entities/leave-request-activity.entity'
import { LeaveRequestApproverEntity } from './entities/leave-request-approver.entity'
import { LeaveSettingsEntity } from './entities/leave-settings.entity'
import { UserEntity } from './entities/user.entity'
import { UserRoleEntity } from './entities/user-role.entity'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { LeaveDomainService } from './leave-domain.service'
import { NotificationService } from './notification.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      UserRoleEntity,
      LeaveBalanceEntity,
      LeaveBalanceChangeEntity,
      LeaveRequestEntity,
      LeaveRequestApproverEntity,
      LeaveRequestActivityEntity,
      LeaveApprovalDecisionEntity,
      CountryEntity,
      HolidayEntity,
      LeaveSettingsEntity,
    ]),
  ],
  // NotificationService is exported so the notification controller can inject it
  // without a new module. Like AuditLogService it reaches its entity through
  // manager.getRepository, so it needs no forFeature registration.
  providers: [
    LeaveDomainService,
    AuditLogService,
    ClockService,
    NotificationService,
  ],
  exports: [
    LeaveDomainService,
    AuditLogService,
    ClockService,
    NotificationService,
  ],
})
export class LeaveDomainModule {}
