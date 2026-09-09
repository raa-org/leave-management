/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { DEFAULT_TIMEZONE } from './country-catalog'

dayjs.extend(utc)
dayjs.extend(timezone)

/**
 * The UTC instant at which the leave day `day` ('YYYY-MM-DD') is finished in
 * IANA `tz`: the midnight that ENDS it, which is the same instant as the
 * midnight starting the next day (2026-12-31 + 'Europe/Kyiv' ->
 * 2026-12-31T22:00:00.000Z).
 *
 * A day is recognised as spent at this instant. It replaces an end-of-workday
 * rule, so the boundary now falls once the day is genuinely over rather than
 * when an office happened to close, and no per-employee window has to be
 * configured for it to be right.
 *
 * DST-correct: the offset is resolved for that specific date, so a day that is
 * 23 or 25 hours long still ends when its own midnight arrives. Robust to a bad
 * stored zone so reconcile can never throw: falls back to the default timezone,
 * then to UTC midnight.
 */
export function endOfDayUtc(day: string, tz: string): Date {
  for (const zone of [tz, DEFAULT_TIMEZONE]) {
    if (!zone) {
      continue
    }
    try {
      // Built by adding a day rather than by naming 24:00, which dayjs.tz does
      // not parse, and rather than by naming the next date directly, which
      // would need month-end and leap-year arithmetic here.
      const instant = dayjs.tz(`${day}T00:00`, zone).add(1, 'day')
      if (instant.isValid()) {
        return instant.toDate()
      }
    } catch {
      // Unrecognized zone id - try the next candidate.
    }
  }
  return new Date(`${day}T24:00:00.000Z`)
}

/**
 * The calendar day ('YYYY-MM-DD') that `instantIso` falls on in IANA `tz` — the
 * inverse direction of endOfDayUtc. Every calendar decision in the domain
 * (which month has accrued, which leave year is current, whether employment has
 * begun) reads a day rather than an instant, because a day string carries no
 * zone and can therefore be compared and sliced without one. Deriving it in UTC
 * instead would put a Kyiv employee three hours behind their own calendar: for
 * the first three hours of every 1st, last month; on New Year's night, last
 * year. Same fallback chain as endOfDayUtc so a bad stored zone degrades
 * rather than throws.
 */
export function localDayIso(instantIso: string, tz: string): string {
  for (const zone of [tz, DEFAULT_TIMEZONE]) {
    if (!zone) {
      continue
    }
    try {
      const local = dayjs(instantIso).tz(zone)
      if (local.isValid()) {
        return local.format('YYYY-MM-DD')
      }
    } catch {
      // Unrecognized zone id - try the next candidate.
    }
  }
  return instantIso.slice(0, 10)
}
