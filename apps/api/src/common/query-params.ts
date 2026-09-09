/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { BadRequestException } from '@nestjs/common'
import { emptyToUndefined, parsePositiveInteger } from './parse'

/**
 * Coercions for HTTP query-string values. Same classification core as
 * ./parse.ts plus the one reporting policy every controller shares: a bad
 * value is the client's fault, so it maps to a 400 naming the field.
 */

/** Absent/blank → undefined; invalid → 400; otherwise the parsed integer. */
export function parseOptionalPositiveInteger(
  rawValue: string | undefined,
  fieldName: string,
): number | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }

  const parsed = parsePositiveInteger(value)
  if (parsed === undefined) {
    throw new BadRequestException(`${fieldName} must be a positive integer.`)
  }

  return parsed
}

/**
 * Absent/blank → undefined; 'true'/'false' → the boolean; anything else → 400.
 *
 * Deliberately stricter than the env-var idiom (`=== 'true'`, everything else
 * false): a filter has to tell "not asked for" apart from "asked for false", so
 * a typo in a hand-built URL must be rejected rather than quietly answered with
 * the false population.
 */
export function parseOptionalBoolean(
  rawValue: string | undefined,
  fieldName: string,
): boolean | undefined {
  const value = emptyToUndefined(rawValue)
  if (value === undefined) {
    return undefined
  }
  if (value !== 'true' && value !== 'false') {
    throw new BadRequestException(`${fieldName} must be true or false.`)
  }

  return value === 'true'
}
