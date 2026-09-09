/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ValueTransformer } from 'typeorm'
import { normalizeEmail } from '@workspace/contracts'

/**
 * Postgres `numeric`/`decimal` columns come back from the driver as strings.
 * The leave domain does arithmetic on day counts as numbers, so convert on read.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null | undefined =>
    value === null || value === undefined ? value : Number(value),
}

/**
 * Same problem one level down: a `numeric[]` column comes back as an array of
 * strings. Used by the per-date day portions of a leave request, which the
 * domain sums and compares as numbers.
 */
export const numericArrayTransformer: ValueTransformer = {
  to: (value?: number[] | null): number[] | null | undefined => value,
  from: (value?: string[] | null): number[] | null | undefined =>
    value === null || value === undefined ? value : value.map(Number),
}

/**
 * The domain represents timestamps as ISO-8601 strings everywhere (occurredAt,
 * submittedAt, createdAt, ...). Store them in real `timestamptz` columns but
 * keep the string contract: write string -> Date, read Date -> ISO string.
 * Date-only fields use the `date` column type instead, which TypeORM already
 * returns as a 'YYYY-MM-DD' string.
 */
export const isoDateTimeTransformer: ValueTransformer = {
  to: (value?: string | null): Date | null | undefined =>
    value === null || value === undefined ? value : new Date(value),
  from: (value?: Date | null): string | null | undefined =>
    value === null || value === undefined ? value : value.toISOString(),
}

/**
 * Columns matched with exact SQL equality (e.g. the activity feed's approver
 * filter) must hold the canonical lowercase/trimmed form no matter which code
 * path writes them. Enforcing it at the column keeps the invariant in ONE
 * place instead of relying on every writer to normalize first.
 * NOTE: applies to entity persistence only — QueryBuilder parameters bypass
 * transformers, so read-side filters still normalize their input explicitly.
 */
export const normalizedEmailTransformer: ValueTransformer = {
  to: (value?: string | null): string | null | undefined =>
    value === null || value === undefined ? value : normalizeEmail(value),
  from: (value?: string | null): string | null | undefined => value,
}
