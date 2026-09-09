/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { resolveEnvironment } from './common/env'

/**
 * Load environment variables from the workspace-root .env files, once, at
 * process startup. This module is imported for its side effect from main.ts
 * BEFORE the AppModule (which reads process.env while its decorators evaluate).
 *
 * Precedence, highest first:
 *   1. real process.env      - injected by the host / CI (always wins)
 *   2. .env                  - local, gitignored (developer secrets/overrides)
 *   3. .env.<APP_ENV>        - committed per-environment defaults
 *
 * dotenv never overrides an already-defined key, so loading .env before
 * .env.<APP_ENV> gives local values priority over the committed defaults, and
 * anything already present in process.env beats both.
 *
 * Which layer (3) to load is decided by APP_ENV/NODE_ENV read from the REAL
 * process environment, captured before any .env is loaded below. APP_ENV
 * placed inside .env itself cannot select its own layer — .env has not been
 * read yet at that point — so deployments must set APP_ENV in the real
 * environment (host / CI / docker-compose `environment:`), not in .env.
 */
function findWorkspaceRoot(startDir: string): string {
  let dir = startDir
  // Walk up to the directory that owns nx.json (the workspace root), so this
  // works regardless of the process working directory or dist nesting.
  for (;;) {
    if (existsSync(resolve(dir, 'nx.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return startDir
    }
    dir = parent
  }
}

const workspaceRoot = findWorkspaceRoot(__dirname)
// Read from the real process.env: this runs before the dotenv calls below, so
// only host/CI-provided values are visible here (an APP_ENV written into .env
// is not yet loaded and cannot pick its own layer). Shared resolver
// (common/env.ts): APP_ENV over NODE_ENV, blank/whitespace = unset.
const environment = resolveEnvironment() ?? 'development'

for (const file of ['.env', `.env.${environment}`]) {
  const path = resolve(workspaceRoot, file)
  if (existsSync(path)) {
    loadDotenv({ path })
  }
}
