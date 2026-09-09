/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'

// Deterministic, valid v4-shaped UUID derived from a readable label. Lets test
// fixtures keep meaningful ids (e.g. testUuid('employee-1')) while still
// satisfying the uuid-typed user id columns. Same label always maps to the same
// uuid, so seed values and the references/assertions against them stay in sync.
export function testUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
