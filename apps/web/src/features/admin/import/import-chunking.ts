/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  EmployeeImportRowDto,
  ImportValidationReportDto,
  LeaveHistoryImportRowDto,
} from '@workspace/contracts'
import { workdayHoursOf } from '../../../lib/leave-format'

/**
 * Slicing a file into requests.
 *
 * Validation goes in batches (a report per batch, merged here), and the run
 * itself goes one employee per request: that is what keeps every payload small
 * and, more importantly, what makes each employee its own transaction and its
 * own line of progress on screen.
 */

// Twenty employees is a few kilobytes of JSON — comfortably inside the default
// body limit, with room for the long date lists a heavy year produces.
export const VALIDATION_BATCH_SIZE = 20

export interface EmployeeWorkItem {
  email: string
  employee?: EmployeeImportRowDto
  history: LeaveHistoryImportRowDto[]
}

/**
 * One work item per employee, in the order the file lists them, with each
 * person's leave attached. History rows for somebody the user-data file does
 * not mention still get an item: a history-only run is legitimate once the
 * profiles are already in place.
 */
export const buildWorkItems = (input: {
  employees?: EmployeeImportRowDto[]
  history?: LeaveHistoryImportRowDto[]
}): EmployeeWorkItem[] => {
  const items = new Map<string, EmployeeWorkItem>()
  const keyOf = (email: string): string => email.trim().toLowerCase()

  for (const employee of input.employees ?? []) {
    items.set(keyOf(employee.email), {
      email: employee.email,
      employee,
      history: [],
    })
  }
  for (const row of input.history ?? []) {
    const key = keyOf(row.email)
    const existing = items.get(key)
    if (existing) {
      existing.history.push(row)
      continue
    }
    items.set(key, { email: row.email, history: [row] })
  }
  return [...items.values()]
}

/** Validation batches: whole employees, never split across requests. */
export const buildValidationBatches = (
  items: EmployeeWorkItem[],
  size = VALIDATION_BATCH_SIZE,
): EmployeeWorkItem[][] => {
  const batches: EmployeeWorkItem[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export const toValidationPayload = (
  batch: EmployeeWorkItem[],
): {
  employees: EmployeeImportRowDto[]
  history: LeaveHistoryImportRowDto[]
} => ({
  employees: batch
    .map((item) => item.employee)
    .filter((employee): employee is EmployeeImportRowDto => Boolean(employee)),
  history: batch.flatMap((item) => item.history),
})

/**
 * Fold the per-batch reports into the one the wizard shows.
 *
 * Batches are validated INDEPENDENTLY and no batch can see what another one is
 * about to mint, so the same policy can arrive twice under two readings. Two
 * keys therefore fold a create group: the server's terms fingerprint (what the
 * engine dedups by) and the planned name (what a file that states names dedups
 * by, since two rows naming one absent policy in two batches are one policy the
 * apply mints once). Two offers that merely share a vacation and sick base are
 * still two policies and must not collapse into one row.
 */
export const mergeValidationReports = (
  reports: ImportValidationReportDto[],
): ImportValidationReportDto => {
  const merged: ImportValidationReportDto = {
    ok: true,
    unknownEmails: [],
    employees: [],
    issues: [],
    policiesToCreate: [],
    policiesToReuse: [],
    // Every batch validates against the same settings row, so the last report
    // to state it wins and an empty run keeps the shared default.
    hoursPerDay: workdayHoursOf(),
  }
  // Keyed by the FIRST group's fingerprint; the two indexes below both point at
  // that key, so a group folded in under either reading keeps one row.
  const createGroups = new Map<
    string,
    ImportValidationReportDto['policiesToCreate'][number]
  >()
  const createKeyByFingerprint = new Map<string, string>()
  const createKeyByName = new Map<string, string>()
  const reuseByPolicy = new Map<
    string,
    ImportValidationReportDto['policiesToReuse'][number]
  >()
  // Names compare the way the catalog compares them, and the way the resolver's
  // ladder does: trimmed and case-blind.
  const nameKey = (name: string): string => name.trim().toLowerCase()

  for (const report of reports) {
    merged.ok = merged.ok && report.ok
    merged.hoursPerDay = report.hoursPerDay
    for (const email of report.unknownEmails) {
      if (!merged.unknownEmails.includes(email)) {
        merged.unknownEmails.push(email)
      }
    }
    for (const email of report.employees) {
      if (!merged.employees.includes(email)) {
        merged.employees.push(email)
      }
    }
    // The server reports an issue per ROW, so an email with five identical
    // problem rows arrives five times word for word. One line carries the
    // fact; duplicates only bury the report (and the counts feed the stat
    // tiles and the rail caption, which must agree with the visible list).
    // "No account…" warnings are dropped wholesale: unknownEmails carries the
    // same fact, and the wizard's banner already names every address on it.
    for (const issue of report.issues) {
      if (
        issue.severity === 'warning' &&
        report.unknownEmails.includes(issue.email) &&
        issue.message.startsWith('No account')
      ) {
        continue
      }
      const seen = merged.issues.some(
        (existing) =>
          existing.severity === issue.severity &&
          existing.email === issue.email &&
          existing.message === issue.message,
      )
      if (!seen) {
        merged.issues.push(issue)
      }
    }
    for (const policy of report.policiesToCreate) {
      const key =
        createKeyByFingerprint.get(policy.termsFingerprint) ??
        createKeyByName.get(nameKey(policy.plannedName)) ??
        policy.termsFingerprint
      const existing = createGroups.get(key)
      if (existing) {
        existing.memberEmails.push(...policy.memberEmails)
        // Renaming survives only where EVERY batch could offer it: one batch
        // holding the name fixed fixes it for the whole group.
        existing.renameable = existing.renameable && policy.renameable
        if (policy.nameSource === 'file') {
          // The file's name is what the apply will really use, so it takes over
          // the row wholesale rather than leaving a name and a source that
          // describe different outcomes.
          existing.nameSource = 'file'
          existing.plannedName = policy.plannedName
        }
      } else {
        createGroups.set(key, { ...policy, memberEmails: [...policy.memberEmails] })
      }
      createKeyByFingerprint.set(policy.termsFingerprint, key)
      createKeyByName.set(nameKey(policy.plannedName), key)
      createKeyByName.set(nameKey(createGroups.get(key)!.plannedName), key)
    }
    for (const policy of report.policiesToReuse) {
      const key = policy.policyId
      const existing = reuseByPolicy.get(key)
      if (existing) {
        existing.memberEmails.push(...policy.memberEmails)
        // The stronger claim and the worse news both win: a policy asked for by
        // name in any batch was asked for by name, and one retired or
        // disagreeing reading is the fact the operator has to act on.
        if (policy.matchedBy === 'name') {
          existing.matchedBy = 'name'
        }
        existing.retired = existing.retired || policy.retired
        existing.termsDiffer = existing.termsDiffer || policy.termsDiffer
        continue
      }
      reuseByPolicy.set(key, { ...policy, memberEmails: [...policy.memberEmails] })
    }
  }

  merged.policiesToCreate = [...createGroups.values()]
  merged.policiesToReuse = [...reuseByPolicy.values()]
  return merged
}

/**
 * Which name the operator chose for each employee's policy, by email.
 *
 * Read off the report's own grouping rather than re-derived from the employee
 * row: the server decided which terms belong together, and the only honest way
 * to ask "what did the operator call THIS person's policy" is to look up the
 * group it put them in. Rebuilding the key here would mean reimplementing the
 * writer's canonicalization in the browser, and any drift between the two
 * enrolls people under a policy nobody named.
 *
 * Emails are matched case-insensitively, the same reading buildWorkItems uses
 * for the file's own duplicates.
 *
 * A group the server marked non-renameable is skipped outright. The wizard
 * draws no box for one, but the typed names outlive a re-validation, so a group
 * that WAS renameable and is no longer (a policy created meanwhile, a row added
 * that names it) would otherwise still send a name the server has to ignore.
 */
export const chosenPolicyNameByEmail = (
  report: ImportValidationReportDto | undefined,
  policyNames: Record<string, string> | undefined,
): Record<string, string> => {
  const chosen: Record<string, string> = {}
  for (const policy of report?.policiesToCreate ?? []) {
    if (!policy.renameable) {
      continue
    }
    const name = policyNames?.[policy.termsFingerprint]?.trim()
    if (!name) {
      continue
    }
    for (const email of policy.memberEmails) {
      chosen[email.trim().toLowerCase()] = name
    }
  }
  return chosen
}
