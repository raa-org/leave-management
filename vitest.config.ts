/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from 'vitest/config'
import * as path from 'node:path'

/**
 * Single root vitest config across the monorepo. Picks up specs from
 * every app and shared lib so `vitest run` from the workspace root is
 * one command to drive the whole baseline.
 *
 * Default `environment: 'node'` keeps things lean for pure logic tests.
 * Frontend specs (apps/web/**) that render React components should opt
 * into DOM via a file-level pragma at the top of the spec:
 *
 *   // @vitest-environment jsdom
 *
 * When the first real UI test lands, also add `jsdom` (and optionally
 * `@testing-library/react`) as devDependencies at the root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // The api specs share one PostgreSQL test database (leave_management_test)
    // and truncate between cases, so test files must not run in parallel.
    fileParallelism: false,
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'libs/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      '.nx/**',
      '.task-worktrees/**',
    ],
  },
  resolve: {
    alias: {
      '@workspace/contracts': path.resolve(
        __dirname,
        'libs/shared/contracts/src/index.ts',
      ),
    },
  },
})
