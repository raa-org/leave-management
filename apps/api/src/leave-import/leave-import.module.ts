/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveImportController } from './leave-import.controller'
import { LeaveImportService } from './leave-import.service'

/**
 * The data-import feature. Nothing is gated behind an environment flag: the
 * import is a permanent admin capability (a year can be refreshed long after
 * go-live), so the only gate is the administrator check on every handler.
 */
@Module({
  imports: [LeaveDomainModule],
  controllers: [LeaveImportController],
  providers: [LeaveImportService],
  exports: [LeaveImportService],
})
export class LeaveImportModule {}
