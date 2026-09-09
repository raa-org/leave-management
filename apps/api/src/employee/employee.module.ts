/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { CountryController } from './country.controller'
import { EmployeeDashboardController } from './employee-dashboard.controller'
import { EmployeeLeaveController } from './employee-leave.controller'
import { HolidayCalendarController } from './holiday-calendar.controller'
import {
  EmployeeLeaveApplicationService,
  employeeLeaveHandlers,
} from './employee-leave.application'

@Module({
  imports: [CqrsModule, LeaveDomainModule],
  controllers: [
    EmployeeDashboardController,
    EmployeeLeaveController,
    HolidayCalendarController,
    CountryController,
  ],
  providers: [EmployeeLeaveApplicationService, ...employeeLeaveHandlers],
})
export class EmployeeModule {}
