/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { emptyToUndefined } from './parse'

/**
 * The single definition of "which environment is this process running in":
 * `APP_ENV` wins, `NODE_ENV` is the fallback, blank/whitespace values count
 * as unset. Both the .env-layer loader (load-env.ts) and security gates (the
 * LDAP certificate-verification skip guard) resolve through here, so they can
 * never disagree about what the environment is called.
 *
 * Deliberately returns `undefined` instead of defaulting: the safe default
 * differs per consumer. The loader assumes 'development' (pointing local
 * tooling at prod config layers by default would be dangerous), while
 * security gates treat "unknown" as production (fail closed).
 */
export function resolveEnvironment(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return emptyToUndefined(env['APP_ENV']) ?? emptyToUndefined(env['NODE_ENV'])
}

/**
 * Whether this process runs on a local development machine, as declared by
 * `DEV_ENVIRONMENT=true`.
 *
 * CACHED VALUE — read once, when this module is first imported, which is
 * BEFORE any .env file has been loaded. The chain is main.ts → load-env.ts →
 * this module: an imported module finishes evaluating before the importer's
 * body runs, and load-env.ts calls dotenv in its body, so nothing dotenv
 * injects into process.env can ever be visible here. Later mutations of
 * process.env do not change this constant either — that is the point, not a
 * limitation.
 *
 * Deliberately NOT derived from APP_ENV/NODE_ENV (see resolveEnvironment
 * above): those name the config layer to load, are set by operations for
 * unrelated reasons, and travel inside env files. A security gate must not
 * move when someone legitimately renames an environment. DEV_ENVIRONMENT has
 * exactly one purpose — unlocking local-only escape hatches — so its presence
 * on a deployed host is unambiguous misconfiguration rather than a plausible
 * setting. Same shape as the existing TEST_TOOLING_ENABLED flag.
 *
 * Fail closed: anything but the literal 'true' (unset, blank, '1', 'yes')
 * means "not a development machine".
 *
 * Set by the `serve:api` npm script, which only ever runs a local dev server —
 * so it never needs to appear in a .env file (where it would not work anyway)
 * and nothing has to be typed by hand. Production runs the built artifact via
 * `start:api`, which does not set it.
 *
 * LIMIT — docker-compose `env_file:` is NOT dotenv. It reads the file and sets
 * its entries as real container environment variables before node starts, so
 * in the container path an env-file entry is indistinguishable from one set in
 * `environment:`, and this snapshot would see it. Nothing in-process can tell
 * them apart. Deployed env files must therefore never carry DEV_ENVIRONMENT;
 * omitting it keeps every gate shut by construction.
 */
export const DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV: boolean =
  emptyToUndefined(process.env['DEV_ENVIRONMENT']) === 'true'
