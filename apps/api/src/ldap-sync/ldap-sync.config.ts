/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Cron expressions are validated with the same `cron` package @nestjs/schedule
// registers jobs through, so anything that passes here is exactly what the
// scheduler accepts — including macros like @daily.
import { readFileSync } from 'node:fs'
import type { ConnectionOptions } from 'node:tls'
import { Logger } from '@nestjs/common'
import { validateCronExpression } from 'cron'
import { DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV } from '../common/env'
import { normalizeDn } from './ldap-dn'
import { emptyToUndefined, parsePositiveInteger } from '../common/parse'

/**
 * Configuration for the LDAP → `users` sync.
 *
 * Everything is read from the environment once, at startup, and validated
 * eagerly: a misconfigured deployment fails fast with a message naming the
 * offending variables instead of dying later inside a scheduled run where
 * nobody is watching.
 *
 * The whole module is off unless `LDAP_SYNC_ENABLED=true`. While it is off the
 * remaining variables are not required and are not read, so a dev checkout with
 * no LDAP at hand boots normally.
 */

/** Connection and search settings, present only when the sync is enabled. */
export interface LdapSyncSettings {
  /** Always `ldaps://`, e.g. `ldaps://ldap.example.com:636` — plaintext is refused. */
  url: string
  /** DN of the read-only service account used to bind. */
  bindDn: string
  bindPassword: string
  /** Search root, e.g. `ou=people,dc=example,dc=com`. */
  baseDn: string
  /** LDAP search filter selecting employee entries. */
  userFilter: string
  /**
   * DN of the admins group (`cn=lrs-admins,...`). Group membership decides
   * who is an app user at all: only entries listed in one of the two lrs-*
   * groups are synced, membership here grants the administrator role, and
   * everyone else in the directory (guest, test, technical accounts) is
   * filtered out. The OU differs per environment (`ou=leaverequest-app` in
   * production, `ou=leaverequest-dev-app` in dev), which is why these are
   * env values and not constants.
   *
   * REQUIRED while the sync is enabled — deliberately no groups-less
   * fallback: syncing without membership would provision every directory
   * entry, guest, test and technical accounts included, and nobody would
   * know until the directory listed them. A missing variable is a startup
   * error instead.
   */
  adminGroupDn: string
  /**
   * DN of the employees group (`cn=lrs-employees,...`); membership grants
   * the employee role. Same contract as adminGroupDn: required while the
   * sync is enabled, per-environment value.
   */
  employeeGroupDn: string
  /** Paged-results page size; the server caps how much it returns at once. */
  pageSize: number
  /**
   * How long to wait for the TCP/TLS connection before giving up. Without a
   * limit an unreachable host is only abandoned when the operating system's own
   * TCP timeout expires, well over a minute later — during which the pass holds
   * an HTTP request open and a shutdown cannot complete.
   */
  connectTimeoutMs: number
  /**
   * How long the directory has to answer one LDAP message — the bind, or one
   * page of a paged search — counted from the request going out until that
   * message completes. A page's entries arrive one at a time and none of them
   * resets the count, so this is a deadline on delivering a whole page, not a
   * limit on how long the directory may stay silent.
   *
   * It therefore bounds a step, not the read: a directory that keeps
   * answering, page by page, may legitimately take many times longer. What it
   * does stop is a connection that opened and then answers nothing — TCP and
   * TLS succeed, and the request would otherwise hang forever.
   *
   * A healthy but slow directory that trips it can be given either more time
   * or less to carry: raise this, or lower `pageSize`.
   */
  timeoutMs: number
  /** Cron expression driving the scheduled run. */
  cron: string
  /**
   * Whether the scheduled run is armed at all. False switches off ONLY the
   * cron job: the client, the service and the admin-triggered endpoint stay
   * fully wired, so a developer can still sync on demand from the console
   * without a directory pass firing behind their back twice a day.
   *
   * Separate from `enabled` because they answer different questions —
   * "does this deployment have a directory" versus "may it read it
   * unattended". The expression above is still parsed and validated while
   * this is false, so turning the schedule back on can never surface a typo
   * that was sitting in the environment all along.
   */
  cronEnabled: boolean
  /**
   * Ready-to-use TLS options for `ldaps://` connections, or undefined to let
   * the system trust store and library defaults apply (the secure default).
   */
  tlsOptions?: ConnectionOptions
  /**
   * True when certificate verification was deliberately switched off. Kept
   * separate from `tlsOptions` so the client can shout about it without
   * inspecting option internals.
   */
  skipCertVerify: boolean
}

/**
 * Disabled is a first-class state rather than "settings with empty strings", so
 * callers cannot accidentally connect to a half-configured directory.
 */
export type LdapSyncConfig =
  | { enabled: false }
  | { enabled: true; settings: LdapSyncSettings }

const DEFAULT_USER_FILTER = '(objectClass=inetOrgPerson)'
const DEFAULT_PAGE_SIZE = 500
/** Long enough for a VPN handshake, short enough to fail a wrong host fast. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
/** Generous for one page of a large directory, which is what it bounds. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Hourly, on the minute. */
const DEFAULT_CRON = '0 * * * *'

type Env = Record<string, string | undefined>

const logger = new Logger('LdapSyncConfig')

/**
 * Build the config from environment variables.
 *
 * Collects *all* problems before throwing: fixing a `.env` one error per
 * restart is miserable, so the message lists every variable that needs
 * attention at once. Helpers signal a bad value by returning `undefined`
 * alongside the recorded problem, and the settings object is only assembled
 * after the guard below — the compiler, not comment-distance, enforces that a
 * missing value can never reach a live LDAP bind.
 *
 * `isDevEnvironment` gates the certificate-verification escape hatch. It is a
 * separate parameter, not another read of `env`, precisely so the gate cannot
 * be opened by a line inside a .env file — the default is the pre-dotenv
 * snapshot (see DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV in common/env).
 *
 * @throws Error when the sync is enabled but the environment is incomplete or invalid.
 */
export function loadLdapSyncConfig(
  env: Env = process.env,
  isDevEnvironment: boolean = DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV,
): LdapSyncConfig {
  const enabledRaw = optionalValue(env, 'LDAP_SYNC_ENABLED')
  if (enabledRaw !== 'true') {
    // A set-but-not-'true' value is the one shape worth a hint: a quoted
    // "true " or a stray '1' silently disabling the sync is otherwise
    // undiagnosable (while disabled, all other LDAP_* validation is skipped).
    if (enabledRaw !== undefined) {
      logger.log(
        `LDAP user sync is disabled: LDAP_SYNC_ENABLED=${JSON.stringify(enabledRaw)} is not "true".`,
      )
    }
    return { enabled: false }
  }

  const problems: string[] = []

  const url = requireValue(env, 'LDAP_URL', problems)
  const bindDn = requireValue(env, 'LDAP_BIND_DN', problems)
  const bindPassword = requireSecret(env, 'LDAP_BIND_PASSWORD', problems)
  const baseDn = requireValue(env, 'LDAP_BASE_DN', problems)
  // The DNs are not validated by shape: the only honest test of a DN is the
  // search itself, and a wrong one fails the first pass loudly (with the
  // variable named in the log). Presence — and the two naming DIFFERENT
  // groups — is what startup can check.
  const adminGroupDn = requireValue(env, 'LDAP_ADMIN_GROUP_DN', problems)
  const employeeGroupDn = requireValue(env, 'LDAP_EMPLOYEE_GROUP_DN', problems)
  // One group cannot serve both roles: a copy-pasted value would grant every
  // member both app roles — or, pasted the other way, shrink the batch to
  // the admins group and deactivate everyone else. The membership guards
  // cannot see this shape (both "groups" read fine and match), so it must
  // die at boot, exactly as the equal OIDC role names do. Compared
  // normalized, so case/spacing variants of one DN do not slip through.
  if (
    adminGroupDn !== undefined &&
    employeeGroupDn !== undefined &&
    normalizeDn(adminGroupDn) === normalizeDn(employeeGroupDn)
  ) {
    problems.push(
      'LDAP_ADMIN_GROUP_DN and LDAP_EMPLOYEE_GROUP_DN must name two different ' +
        `groups (both resolve to ${JSON.stringify(normalizeDn(adminGroupDn))})`,
    )
  }

  const userFilter = optionalValue(env, 'LDAP_USER_FILTER') ?? DEFAULT_USER_FILTER
  const pageSize = parsePageSize(env, problems)
  const connectTimeoutMs = parseTimeout(
    env,
    'LDAP_CONNECT_TIMEOUT_MS',
    DEFAULT_CONNECT_TIMEOUT_MS,
    problems,
  )
  const timeoutMs = parseTimeout(
    env,
    'LDAP_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    problems,
  )
  const cron = parseCron(env, problems)
  const cronEnabled = parseCronEnabled(env, problems)
  const tls = parseTls(env, url, problems, isDevEnvironment)

  if (
    problems.length > 0 ||
    // Redundant with problems[] by construction, but narrows the types: after
    // this guard every value is provably present, with no placeholder escapes.
    url === undefined ||
    bindDn === undefined ||
    bindPassword === undefined ||
    baseDn === undefined ||
    adminGroupDn === undefined ||
    employeeGroupDn === undefined ||
    pageSize === undefined ||
    connectTimeoutMs === undefined ||
    timeoutMs === undefined ||
    cron === undefined ||
    cronEnabled === undefined ||
    tls === undefined
  ) {
    throw new Error(
      `Invalid LDAP sync configuration (LDAP_SYNC_ENABLED=true):\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        `\nSet the variables above or unset LDAP_SYNC_ENABLED to disable the sync.`,
    )
  }

  return {
    enabled: true,
    settings: {
      url,
      bindDn,
      bindPassword,
      baseDn,
      adminGroupDn,
      employeeGroupDn,
      userFilter,
      pageSize,
      connectTimeoutMs,
      timeoutMs,
      cron,
      cronEnabled,
      ...(tls.tlsOptions ? { tlsOptions: tls.tlsOptions } : {}),
      skipCertVerify: tls.skipCertVerify,
    },
  }
}

interface TlsSettings {
  tlsOptions?: ConnectionOptions
  skipCertVerify: boolean
}

/**
 * Assemble the TLS posture. The transport itself is never negotiable: the URL
 * must be `ldaps://`, so the connection is always encrypted.
 *
 * Secure by default: with nothing configured we return no options at all, so
 * Node verifies the server certificate against the system trust store.
 * `LDAP_TLS_CA_FILE` adds the directory's own CA and keeps verification on —
 * that is the production shape. `LDAP_TLS_SKIP_CERT_VERIFY=true` skips only the
 * CA-signature and hostname checks — exactly what `LDAPTLS_REQCERT=never`
 * does for ldapsearch — and is honored only on a machine that declared itself
 * a development environment (fail closed everywhere else).
 *
 * Two independent variables must line up, and the second one (DEV_ENVIRONMENT)
 * has no legitimate reason to be set on a deployed host — so shipping this
 * escape hatch by accident takes two deliberate mistakes, not one. The gate is
 * NOT derived from APP_ENV/NODE_ENV: those select config layers and move for
 * operational reasons that have nothing to do with TLS.
 *
 * Every problem is collected before giving up, matching the module's
 * one-restart-fixes-everything contract.
 */
function parseTls(
  env: Env,
  url: string | undefined,
  problems: string[],
  isDevEnvironment: boolean,
): TlsSettings | undefined {
  const problemsBefore = problems.length

  // Only the literal 'true' asks to skip verification — no truthy-ish values —
  // and it is honored only on a declared development machine (fail closed).
  const skipRequested = optionalValue(env, 'LDAP_TLS_SKIP_CERT_VERIFY') === 'true'
  const skipHonored = skipRequested && isDevEnvironment
  if (skipRequested && !skipHonored) {
    problems.push(
      'LDAP_TLS_SKIP_CERT_VERIFY=true is only honored when DEV_ENVIRONMENT=true ' +
        'is set in the real process environment before startup. `npm run ' +
        'serve:api` sets it for you; putting it in a .env file does NOT work ' +
        '(it is read before .env files load) and must not be attempted on a ' +
        'server. Anything else is treated as production (fail closed): ' +
        'unverified TLS exposes the sync to man-in-the-middle attacks; supply ' +
        "the directory's CA via LDAP_TLS_CA_FILE instead",
    )
  }

  // The transport is always TLS: plaintext ldap:// would put the bind
  // password and the whole directory on the wire in the clear, and no flag
  // unlocks that. LDAP_TLS_SKIP_CERT_VERIFY only relaxes certificate
  // *verification* (the ldapsearch LDAPTLS_REQCERT=never equivalent); the
  // connection stays encrypted either way.
  //
  // Parse the scheme the same way ldapts does (WHATWG `new URL().protocol`,
  // which lowercases it) rather than a raw startsWith: the scheme is
  // case-insensitive (RFC 4516), so `LDAPS://` is valid and ldapts accepts
  // it — a startsWith('ldaps://') check would reject a working URL.
  if (url !== undefined && parseScheme(url) !== 'ldaps:') {
    problems.push(
      `LDAP_URL must use ldaps:// (got ${JSON.stringify(url)}) — the sync ` +
        'never connects in plaintext. To skip certificate verification ' +
        'against a self-signed directory, keep ldaps:// and set ' +
        'LDAP_TLS_SKIP_CERT_VERIFY=true in a local environment',
    )
  }

  const caFile = optionalValue(env, 'LDAP_TLS_CA_FILE')

  // When verification is actually skipped the CA is irrelevant, so it is NOT
  // read: the documented workflow is a shared env file that carries the CA
  // path while a developer flips the flag locally, and that dev box may not
  // even have the file — reading it would fail startup for a value that does
  // nothing here. (When skip was REQUESTED but refused, verification stays on,
  // so we fall through and validate the CA as usual.)
  if (skipHonored) {
    if (problems.length > problemsBefore) {
      return undefined
    }
    if (caFile !== undefined) {
      logger.warn(
        `LDAP_TLS_CA_FILE (${caFile}) is ignored while ` +
          'LDAP_TLS_SKIP_CERT_VERIFY=true — the server certificate is not ' +
          'verified at all.',
      )
    }
    return { skipCertVerify: true, tlsOptions: { rejectUnauthorized: false } }
  }

  // Verification is on: load the CA if one is configured.
  let ca: Buffer | undefined
  if (caFile !== undefined) {
    try {
      ca = readFileSync(caFile)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      problems.push(`LDAP_TLS_CA_FILE cannot be read (${caFile}): ${reason}`)
    }
  }

  if (problems.length > problemsBefore) {
    return undefined
  }

  return {
    skipCertVerify: false,
    ...(ca !== undefined ? { tlsOptions: { ca } } : {}),
  }
}

/** Lowercased URL scheme (e.g. `ldaps:`), or undefined if the URL won't parse. */
function parseScheme(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}

/** Read a variable that must be set; records a problem when it is missing. */
function requireValue(
  env: Env,
  name: string,
  problems: string[],
): string | undefined {
  const value = optionalValue(env, name)
  if (value === undefined) {
    problems.push(`${name} is required`)
  }
  return value
}

/**
 * Read a required secret. Presence is judged on the trimmed value (a
 * whitespace-only line is not a password), but the returned value is the RAW
 * env string: surrounding whitespace can legitimately be part of a password
 * (dotenv preserves it inside quotes), and trimming it would send a wrong
 * password to the bind.
 */
function requireSecret(
  env: Env,
  name: string,
  problems: string[],
): string | undefined {
  const raw = env[name]
  // Presence is the shared blank rule; the returned value stays raw.
  if (emptyToUndefined(raw) === undefined) {
    problems.push(`${name} is required`)
    return undefined
  }
  return raw
}

/** Treat whitespace-only values as absent — a blank line in `.env` is not a setting. */
function optionalValue(env: Env, name: string): string | undefined {
  return emptyToUndefined(env[name])
}

/**
 * The largest delay Node's `setTimeout` can hold (2^31 − 1 ms, ~24.8 days).
 * Anything larger fires after 1 ms instead — so a value past this line would
 * time out every LDAP message instantly and fail every pass, while the error
 * message blamed the directory server for an env-file typo.
 */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * A timeout in milliseconds, defaulting when unset. Zero is refused along with
 * every other non-positive value: in ldapts it means "wait forever", which is
 * exactly the state these settings exist to prevent, so it must not be
 * reachable by typing a plausible-looking number into an env file.
 */
function parseTimeout(
  env: Env,
  name: string,
  fallback: number,
  problems: string[],
): number | undefined {
  const raw = optionalValue(env, name)
  if (raw === undefined) {
    return fallback
  }
  const parsed = parsePositiveInteger(raw)
  if (parsed === undefined || parsed > MAX_TIMEOUT_MS) {
    problems.push(
      `${name} must be a positive integer of milliseconds, at most ${MAX_TIMEOUT_MS} (got ${JSON.stringify(raw)})`,
    )
    return undefined
  }
  return parsed
}

function parsePageSize(env: Env, problems: string[]): number | undefined {
  const raw = optionalValue(env, 'LDAP_PAGE_SIZE')
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE
  }
  const parsed = parsePositiveInteger(raw)
  if (parsed === undefined) {
    problems.push(
      `LDAP_PAGE_SIZE must be a positive integer (got ${JSON.stringify(raw)})`,
    )
  }
  return parsed
}

/**
 * Validate the cron expression with the cron library itself — the exact parser
 * @nestjs/schedule will hand it to when the job registers. That keeps this
 * check from drifting (a hand-rolled shape check would reject macros like
 * `@daily` the library accepts, and pass field values like `99 * * * *` it
 * rejects) while the failure still happens at startup, naming the variable.
 */
function parseCron(env: Env, problems: string[]): string | undefined {
  const raw = optionalValue(env, 'LDAP_SYNC_CRON')
  if (raw === undefined) {
    return DEFAULT_CRON
  }
  const result = validateCronExpression(raw)
  if (!result.valid) {
    const reason =
      result.error instanceof Error ? `: ${result.error.message}` : ''
    problems.push(
      `LDAP_SYNC_CRON is not a valid cron expression (got ${JSON.stringify(raw)})${reason}`,
    )
    return undefined
  }
  return raw
}

/**
 * Whether the cron job may be armed. Absent means yes: a deployment that says
 * nothing about its schedule keeps the one it has always had, so adding this
 * variable cannot silently stop a production sync.
 *
 * Unlike LDAP_SYNC_ENABLED — where anything but the literal 'true' means off,
 * because failing closed on a whole directory feature is the safe direction —
 * this flag defaults to ON, so a typo has to be caught rather than absorbed:
 * 'False', '0' and 'off' would each leave the schedule quietly running while
 * the author believed they had stopped it. Only the two literals are accepted
 * and anything else is a startup error naming the variable.
 */
function parseCronEnabled(env: Env, problems: string[]): boolean | undefined {
  const raw = optionalValue(env, 'LDAP_SYNC_CRON_ENABLED')
  if (raw === undefined) {
    return true
  }
  if (raw === 'true' || raw === 'false') {
    return raw === 'true'
  }
  problems.push(
    `LDAP_SYNC_CRON_ENABLED must be "true" or "false" (got ${JSON.stringify(raw)})`,
  )
  return undefined
}
