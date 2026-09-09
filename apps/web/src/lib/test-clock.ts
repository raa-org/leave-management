/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The test clock is set with a UTC instant, but nobody reasons about leave in
// UTC. A leave day is spent at midnight in the EMPLOYEE's zone, so an admin
// checking "does 6 August get spent" has to land the clock past Kyiv midnight,
// which is 21:00 UTC in summer and 22:00 in winter. Typing a UTC instant and
// doing that arithmetic in your head is how you conclude the feature is broken
// when the clock simply never reached the boundary.
//
// So the panel asks for the three things the admin actually knows (a date, a
// time, a zone) and this module turns them into the instant the API wants.

/** The viewer's own IANA zone, or Kyiv when the browser will not say. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv'
  } catch {
    return 'Europe/Kyiv'
  }
}

/**
 * Every IANA zone the runtime knows, so the admin can pick the employee's one
 * rather than convert to it. Falls back to a short list on a runtime without
 * `supportedValuesOf` (Safari before 17), always including `extra` so the
 * current selection is never an option the list has dropped.
 */
export function timezoneOptions(extra: string[] = []): string[] {
  let zones: string[] = []
  try {
    zones = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone') ?? []
  } catch {
    zones = []
  }
  if (zones.length === 0) {
    zones = [
      'Europe/Kyiv',
      'Europe/Warsaw',
      'Europe/Istanbul',
      'Asia/Tbilisi',
      'America/New_York',
      'America/Los_Angeles',
      'UTC',
    ]
  }
  return [...new Set([...extra.filter(Boolean), ...zones])].sort()
}

/**
 * The UTC instant of a wall-clock `date` ('YYYY-MM-DD') and `time` ('HH:mm')
 * read in IANA `tz`. Returns null for input the picker has not filled in or a
 * zone the runtime rejects, so the caller can keep the button disabled rather
 * than send a bad instant.
 *
 * Built on Intl rather than a date library on purpose. The zone ids offered by
 * the picker come from `Intl.supportedValuesOf`, so resolving them through the
 * same Intl is the only way the two cannot disagree: dayjs's tz PARSING path
 * rejects ids its conversion path accepts (Europe/Kyiv is one), which showed up
 * as a Jump button that would not light for the zone the browser had just named
 * as its own.
 *
 * Two passes: guess that the wall time is UTC, measure how far off that lands
 * in the target zone, correct, then re-measure. The second pass matters only
 * around a DST change, where the first correction can cross the shift.
 */
export function zonedWallTimeToUtc(
  date: string,
  time: string,
  tz: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null
  }
  const wantedAsUtc = Date.parse(`${date}T${time}:00.000Z`)
  if (Number.isNaN(wantedAsUtc)) {
    return null
  }
  let parts: Intl.DateTimeFormat
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return null
  }
  // What this instant reads as on the target wall clock, as a UTC-parsed number
  // so the two are subtractable.
  const wallOf = (instantMs: number): number => {
    const f: Record<string, string> = {}
    for (const part of parts.formatToParts(new Date(instantMs))) {
      f[part.type] = part.value
    }
    // 'en-CA' with hour12:false can render midnight as hour 24.
    const hour = f['hour'] === '24' ? '00' : f['hour']
    return Date.parse(
      `${f['year']}-${f['month']}-${f['day']}T${hour}:${f['minute']}:${f['second']}.000Z`,
    )
  }
  let instant = wantedAsUtc - (wallOf(wantedAsUtc) - wantedAsUtc)
  instant -= wallOf(instant) - wantedAsUtc
  return Number.isNaN(instant) ? null : new Date(instant).toISOString()
}

/**
 * An instant split into the date and time fields as they read in `tz` — the
 * inverse of zonedWallTimeToUtc, so seeding the pickers and reading them back
 * are the same conversion in two directions.
 *
 * Slicing the ISO string instead would seed UTC wall time into fields labelled
 * with a zone, which is both wrong by an offset and, in the datetime-local
 * shape the old single field used, not even a value a date input can display.
 */
export function wallPartsIn(
  instantIso: string,
  tz: string,
): { date: string; time: string } {
  const when = new Date(instantIso)
  if (Number.isNaN(when.getTime())) {
    return { date: '', time: '00:00' }
  }
  const read = (options: Intl.DateTimeFormatOptions): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const part of new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      ...options,
    }).formatToParts(when)) {
      out[part.type] = part.value
    }
    return out
  }
  try {
    const f = read({
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    // 'en-CA' with hour12:false can render midnight as hour 24.
    const hour = f['hour'] === '24' ? '00' : f['hour']
    return {
      date: `${f['year']}-${f['month']}-${f['day']}`,
      time: `${hour}:${f['minute']}`,
    }
  } catch {
    return { date: instantIso.slice(0, 10), time: instantIso.slice(11, 16) }
  }
}

/**
 * Why these three inputs cannot become an instant, or null when they can.
 *
 * Derived from the same checks the converter runs, rather than assumed by the
 * caller. A panel that blamed the timezone for every failure sent an admin
 * hunting a zone bug when the real cause was a stale date value the date input
 * could not even display.
 */
export function wallTimeProblem(
  date: string,
  time: string,
  tz: string,
): string | null {
  if (!date) {
    return 'Pick a date'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return `"${date}" is not a date this field can use. Reload the page.`
  }
  if (!time) {
    return 'Pick a time'
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return `"${time}" is not an HH:mm time`
  }
  if (zonedWallTimeToUtc(date, time, tz) === null) {
    return `${tz} is not a timezone this browser knows`
  }
  return null
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * How an instant reads on the wall in `tz`, for the lines telling the admin
 * what they are looking at and what they are about to set.
 *
 * Assembled from parts rather than handed to toLocaleString: the separator that
 * locale chooses moves between ICU versions ("4 Aug 2026, 15:54" in one, "4 Aug
 * 2026 at 15:54" in another), which makes the label untestable and, worse, made
 * two lines that must be compared by eye look formatted differently. Falls back
 * to the raw instant rather than throwing, since this is a label.
 */
export function wallTimeIn(instantIso: string, tz: string): string {
  // A zone the runtime rejects must not quietly render as UTC under that
  // zone's name: showing one clock and labelling it another is the whole bug
  // this line exists to make visible.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  } catch {
    return instantIso
  }
  const parts = wallPartsIn(instantIso, tz)
  if (!parts.date) {
    return instantIso
  }
  const [year, month, day] = parts.date.split('-')
  const name = MONTHS[Number(month) - 1]
  if (!name) {
    return instantIso
  }
  return `${Number(day)} ${name} ${year}, ${parts.time}`
}
