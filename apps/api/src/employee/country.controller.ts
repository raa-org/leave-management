/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Controller, Get, Inject } from '@nestjs/common'
import { QueryBus } from '@nestjs/cqrs'
import { CurrentUser } from '@trusted-modules/auth-oidc-nest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import type { CountryDto } from '@workspace/contracts'
import { ListCountriesQuery } from './employee-leave.application'

// The employee-facing read of the reserved country list (the countries table).
// The admin route (GET /admin/countries) serves the same data behind a role
// check because the console also edits countries; this one is read-only
// reference data the holidays page needs to populate its country picker.
@Controller('countries')
export class CountryController {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  @Get()
  listCountries(
    @CurrentUser() currentUser?: UserProfileType,
  ): Promise<CountryDto[]> {
    return this.queryBus.execute(new ListCountriesQuery(currentUser))
  }
}
