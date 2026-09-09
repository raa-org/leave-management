/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common'
import { QueryBus } from '@nestjs/cqrs'
import { CurrentUser } from '@trusted-modules/auth-oidc-nest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import type { HolidayCalendarDto, ListHolidaysQueryDto } from '@workspace/contracts'
import { normalizeCountryCode } from '@workspace/contracts'
import { ListHolidayCalendarsQuery } from './employee-leave.application'

// The employee-facing read of official holiday calendars. The admin route
// (GET /admin/holidays) serves the same domain method behind a role check
// because it also WRITES; this one is read-only reference data that the
// request calendar needs in order to shade non-working days.
@Controller('holiday-calendars')
export class HolidayCalendarController {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  @Get()
  listHolidayCalendars(
    @CurrentUser() currentUser?: UserProfileType,
    @Query('countryCode') countryCode?: string,
    @Query('year') year?: string,
  ): Promise<HolidayCalendarDto[]> {
    // Calendars are stored under canonical (trimmed uppercase) codes, so the
    // read side must normalize the same way the write side does.
    const filters: ListHolidaysQueryDto = {
      countryCode:
        countryCode === undefined ? undefined : normalizeCountryCode(countryCode),
      year: parseOptionalYear(year),
    }

    return this.queryBus.execute(new ListHolidayCalendarsQuery(currentUser, filters))
  }
}

function parseOptionalYear(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined
  }

  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException('year must be a positive integer.')
  }

  return parsed
}
