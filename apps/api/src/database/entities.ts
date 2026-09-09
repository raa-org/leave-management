/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { AuditLogEntity } from '../domain/entities/audit-log.entity'
import { CountryEntity } from '../domain/entities/country.entity'
import { HolidayEntity } from '../domain/entities/holiday.entity'
import { HolidayCalendarEntity } from '../domain/entities/holiday-calendar.entity'
import { LeaveAllocationEntity } from '../domain/entities/leave-allocation.entity'
import { LeaveApprovalDecisionEntity } from '../domain/entities/leave-approval-decision.entity'
import { LeavePolicyEntity } from '../domain/entities/leave-policy.entity'
import { LeavePolicyMembershipEntity } from '../domain/entities/leave-policy-membership.entity'
import { LeaveBalanceEntity } from '../domain/entities/leave-balance.entity'
import { LeaveBalanceChangeEntity } from '../domain/entities/leave-balance-change.entity'
import { LeaveRequestEntity } from '../domain/entities/leave-request.entity'
import { LeaveRequestActivityEntity } from '../domain/entities/leave-request-activity.entity'
import { LeaveRequestApproverEntity } from '../domain/entities/leave-request-approver.entity'
import { LeaveSettingsEntity } from '../domain/entities/leave-settings.entity'
import { NotificationEntity } from '../domain/entities/notification.entity'
import { ProjectEntity } from '../domain/entities/project.entity'
import { UserEntity } from '../domain/entities/user.entity'
import { UserProjectMembershipEntity } from '../domain/entities/user-project-membership.entity'
import { UserRoleEntity } from '../domain/entities/user-role.entity'
import { NotificationDeliveryEntity } from '../notifications/notification-delivery.entity'

// Single source of the entity list, shared by the DataSource (CLI + runtime)
// and TypeOrmModule.forFeature registrations.
export const entities = [
  UserEntity,
  UserRoleEntity,
  ProjectEntity,
  UserProjectMembershipEntity,
  LeavePolicyEntity,
  LeavePolicyMembershipEntity,
  LeaveAllocationEntity,
  LeaveBalanceEntity,
  LeaveBalanceChangeEntity,
  LeaveRequestEntity,
  LeaveRequestApproverEntity,
  LeaveRequestActivityEntity,
  LeaveApprovalDecisionEntity,
  CountryEntity,
  HolidayEntity,
  HolidayCalendarEntity,
  LeaveSettingsEntity,
  NotificationDeliveryEntity,
  AuditLogEntity,
  NotificationEntity,
]
