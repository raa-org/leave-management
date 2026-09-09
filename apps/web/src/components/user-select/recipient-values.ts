/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { normalizeEmail } from '@workspace/contracts'

/** Directory entry the picker offers; shaped like the server option DTOs. */
export type UserOption = {
  userId: string
  displayName: string
  email: string
}

/**
 * One picker value: a normalized email plus the directory entry it matched,
 * when one exists. Values without a `user` are legacy addresses (saved before
 * the picker constrained input to the directory): they render as plain email
 * chips that can be kept or removed, but never re-selected from the list.
 * `displayName` is a label override for values resolved outside the directory
 * (e.g. locked settings defaults the server already matched to a user).
 */
export type RecipientValue = {
  email: string
  user?: UserOption
  displayName?: string
}

/** Directory as picker options: normalized and deduped by email. */
export function toRecipientOptions(options: UserOption[]): RecipientValue[] {
  const byEmail = new Map<string, RecipientValue>()
  for (const option of options) {
    const email = normalizeEmail(option.email)
    if (email.length > 0 && !byEmail.has(email)) {
      byEmail.set(email, { email, user: option })
    }
  }
  return Array.from(byEmail.values())
}

/**
 * Resolve stored emails to picker values against the directory, preserving
 * order and dropping blanks/duplicates. Unmatched emails stay as bare values
 * so nothing already saved silently disappears from the field.
 */
export function resolveRecipientValues(
  emails: string[],
  options: UserOption[],
): RecipientValue[] {
  const optionByEmail = new Map(
    toRecipientOptions(options).map((option) => [option.email, option]),
  )
  const resolved = new Map<string, RecipientValue>()
  for (const raw of emails) {
    const email = normalizeEmail(raw)
    if (email.length === 0 || resolved.has(email)) {
      continue
    }
    resolved.set(email, optionByEmail.get(email) ?? { email })
  }
  return Array.from(resolved.values())
}

/** Picker values back to the stored form: normalized, deduped emails. */
export function recipientEmails(values: RecipientValue[]): string[] {
  const emails: string[] = []
  for (const value of values) {
    const email = normalizeEmail(value.email)
    if (email.length > 0 && !emails.includes(email)) {
      emails.push(email)
    }
  }
  return emails
}

/** Chip/option label: the person's name when known, the raw address otherwise. */
export function recipientLabel(value: RecipientValue): string {
  return value.user?.displayName ?? value.displayName ?? value.email
}

/** Remove directory entries whose email is in `excluded` (e.g. locked defaults). */
export function excludeEmails(
  options: UserOption[],
  excluded: string[],
): UserOption[] {
  const blocked = new Set(
    excluded.map((email) => normalizeEmail(email)).filter((email) => email.length > 0),
  )
  return options.filter((option) => !blocked.has(normalizeEmail(option.email)))
}
