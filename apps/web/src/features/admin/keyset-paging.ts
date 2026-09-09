/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Shared pure append step for the keyset "Load more" feeds (activity, audit
// logs, employee directory), so their staleness/dedup semantics cannot drift.
//
// A page belongs to the listing identified by (applied, cursor): if EITHER
// changed while the page was in flight — a refresh or filter change replaced
// the listing — the response is stale and must be dropped, not appended.
// Comparing the cursor alone is not enough: a filter change can produce a
// first page ending on the same boundary row while the population differs.
//
// The `applied` identity contract: every FIRST-PAGE load stores a FRESH
// filters object in state, and load-more snapshots that object for both its
// request parameters and this staleness check. Reference equality is the
// whole mechanism — never reuse or memoize an applied object across loads.

// Returns the merged page data, or null when the response is stale and the
// caller should keep its state untouched (beyond clearing its loading flag).
// Rows updated mid-pagination can be re-served past the cursor; already
// rendered rows win so list keys stay unique. Page-level extras (e.g. totals,
// present on first-page responses only) are preserved from the current data
// unless the next page explicitly carries a defined value; nextCursor always
// comes from the next page (an absent cursor means the feed is exhausted).
//
// Single type parameter on purpose: the item type is derived from the page
// (TPage['items'][number]) so it infers at call sites — a separate TItem
// would only appear in a constraint, which TypeScript does not infer from,
// leaving getId's parameter as `unknown`.
export function appendKeysetPage<
  TPage extends { items: readonly unknown[]; nextCursor?: string },
>(
  current: { data: TPage; applied: unknown },
  request: { cursor: string; applied: unknown },
  next: TPage,
  getId: (item: TPage['items'][number]) => string,
): TPage | null {
  if (
    current.data.nextCursor !== request.cursor ||
    current.applied !== request.applied
  ) {
    return null
  }
  const seen = new Set(current.data.items.map(getId))
  const definedNext = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as Partial<TPage>
  // The spread-and-override shape cannot be proven generically by the
  // compiler; the cast is sound because every field originates from TPage
  // values of the same concrete type.
  return {
    ...current.data,
    ...definedNext,
    items: [
      ...current.data.items,
      ...next.items.filter((item) => !seen.has(getId(item))),
    ],
    nextCursor: next.nextCursor,
  } as TPage
}
