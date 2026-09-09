/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Shared string-coercion primitives for untrusted-string boundaries (HTTP
 * query params, env vars). One definition of what counts as "blank" and what
 * counts as a "positive integer", so the HTTP and config paths cannot drift.
 *
 * These helpers only classify/convert; how to report a bad value (400 vs
 * startup error) stays with the caller.
 */

/** Blank (absent, empty, or whitespace-only) → undefined; otherwise the trimmed value. */
export function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Parse a strictly-decimal positive integer ('42'). Returns undefined for
 * everything else — including forms Number() would happily coerce ('1e3',
 * '0x10', '1.5') but nobody writes into a query string or .env on purpose.
 */
export function parsePositiveInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined
  }
  const parsed = Number(raw)
  return parsed > 0 ? parsed : undefined
}
