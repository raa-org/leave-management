/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { numericTransformer } from '../../database/column-transformers'
import { DAY_DECIMALS } from '../day-math'

// THE column spec every day quantity is stored with, in one place because its
// scale is not a per-table choice: it has to match the quantum roundDays
// quantizes to (day-math.ts). A column declared finer would hold decimals the
// books have already thrown away; a column declared coarser would have Postgres
// silently round a value the books consider exact, and the ledger's running
// snapshots would stop adding up. Precision 7 leaves four integer digits, which
// is four orders of magnitude more leave than anyone accrues.
export const dayColumn = {
  type: 'numeric' as const,
  precision: 4 + DAY_DECIMALS,
  scale: DAY_DECIMALS,
  transformer: numericTransformer,
}
