/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveDomainService } from '../domain/leave-domain.service'

// A submission requires a configured holiday calendar for its (country, year).
// Seeding an empty one (confirmed-empty) satisfies the guard without excluding
// any dates, so requestedDays assertions stay unchanged. Pass holidays to test
// actual holiday exclusion.
export async function seedHolidayCalendar(
  leaveDomain: LeaveDomainService,
  overrides: {
    countryCode?: string
    year?: number
    holidays?: { date: string; name: string }[]
  } = {},
): Promise<void> {
  await leaveDomain.replaceHolidayCalendar({
    countryCode: overrides.countryCode ?? 'UA',
    year: overrides.year ?? 2026,
    holidays: overrides.holidays ?? [],
  })
}
