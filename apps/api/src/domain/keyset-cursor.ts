/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Shared keyset-pagination machinery for the admin feeds. A cursor is an
// opaque base64url "sortValue|id" pair where id is a uuid and sortValue is
// either an ISO timestamp (newest-first feeds: audit log, activity feed) or
// an arbitrary text sort key (A-to-Z feeds: employee directory). Pages
// contain rows strictly past the cursor in (sortColumn, id) order, so a row
// updated mid-pagination bubbles across the cursor instead of being
// re-served.

export interface KeysetCursor {
  sortValue: string
  id: string
}

// What the decoded sortValue must look like. Timestamps are validated so
// garbage never reaches a SQL timestamptz cast (which would 500 the request);
// text keys (e.g. a lowercased display name) accept any string — they are
// only ever compared, never cast.
export type KeysetSortValueKind = 'timestamp' | 'text'

// Shared with the admin controllers' query-param validation so cursor ids and
// id filters accept exactly the same shapes.
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.sortValue}|${cursor.id}`, 'utf8').toString(
    'base64url',
  )
}

// A malformed or tampered cursor decodes to null and the caller serves the
// first page. The id half is always uuid-validated; the sortValue half is
// validated per kind (see KeysetSortValueKind). The split uses the LAST '|'
// because a text sortValue may itself contain '|' while a uuid never does.
export function decodeKeysetCursor(
  raw?: string,
  sortValueKind: KeysetSortValueKind = 'timestamp',
): KeysetCursor | null {
  if (!raw) {
    return null
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator === -1) {
    return null
  }
  const sortValue = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)
  if (!UUID_PATTERN.test(id)) {
    return null
  }
  if (sortValueKind === 'timestamp' && Number.isNaN(Date.parse(sortValue))) {
    return null
  }
  return { sortValue, id }
}

// WHERE fragment selecting rows strictly older than the cursor (newest-first
// feeds); bind { cursorSortValue: cursor.sortValue, cursorId: cursor.id }
// alongside it. The predicates and the codec live together so the admin feeds
// cannot drift apart in boundary semantics.
export function keysetWhere(alias: string, sortColumn: string): string {
  return `(${alias}.${sortColumn} < :cursorSortValue OR (${alias}.${sortColumn} = :cursorSortValue AND ${alias}.id < :cursorId))`
}

// Ascending counterpart for A-to-Z feeds. Parameter order mirrors keysetWhere
// (alias first). `sortExpr` is a full SQL expression (e.g.
// `LOWER(u."displayName")`) so the caller can paginate over a derived key; it
// MUST match the query's ORDER BY expression exactly.
export function keysetWhereAsc(alias: string, sortExpr: string): string {
  return `(${sortExpr} > :cursorSortValue OR (${sortExpr} = :cursorSortValue AND ${alias}.id > :cursorId))`
}

// Truncate a limit+1 overfetch to one page and build the follow-up cursor.
// Shared by every keyset feed so the hasMore/slice/last-row invariants cannot
// drift between them.
export function takeKeysetPage<T>(
  rows: T[],
  limit: number,
  toCursor: (last: T) => KeysetCursor,
): { page: T[]; nextCursor?: string } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  return {
    page,
    nextCursor:
      hasMore && last ? encodeKeysetCursor(toCursor(last)) : undefined,
  }
}
