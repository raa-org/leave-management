/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Controller, Get, Inject } from '@nestjs/common'
import { QueryBus } from '@nestjs/cqrs'
import { CurrentUser } from '@trusted-modules/auth-oidc-nest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import type { EmployeeDashboardDto } from '@workspace/contracts'
import { GetEmployeeDashboardQuery } from './employee-leave.application'

@Controller('dashboard')
export class EmployeeDashboardController {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  @Get('me')
  getMyDashboard(
    @CurrentUser() currentUser?: UserProfileType,
  ): Promise<EmployeeDashboardDto> {
    return this.queryBus.execute(new GetEmployeeDashboardQuery(currentUser))
  }
}
