/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Resolve the Express `trust proxy` setting for this process.
 *
 * nginx terminates TLS and reaches the app over plain HTTP, so `req.secure`
 * stays false unless Express is told which peers may be believed about
 * `X-Forwarded-Proto`. That is not bookkeeping: express-session refuses to
 * emit a cookie marked `Secure` while `req.secure` is false, and announces it
 * only through `debug()`, which prints nothing in production
 * (express-session/index.js:242). The module builds its session with
 * `secure: process.env.NODE_ENV === 'production'`, so the day NODE_ENV was
 * baked into the image the `auth-oidc.sid` cookie silently stopped being sent
 * and every OIDC callback failed with "checks.state argument is missing".
 *
 * `null` means "do not trust any proxy", which leaves the Express default
 * (`false`) untouched rather than setting it back explicitly.
 */
export type TrustProxySetting = string | number | boolean

/**
 * Trusts loopback plus the private ranges, never a public address.
 *
 * `loopback` on its own would not be enough: the container is reached through
 * Docker's port NAT, so the peer address it actually sees is the bridge
 * gateway (172.16/12 and friends), not 127.0.0.1. Keeping `loopback` in the
 * list covers running the API directly on a host behind a local nginx.
 */
const PRODUCTION_DEFAULT = 'loopback, uniquelocal'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no'])

export function resolveTrustProxy(
  env: NodeJS.ProcessEnv,
): TrustProxySetting | null {
  const raw = env['TRUST_PROXY']?.trim()

  if (raw === undefined || raw === '') {
    return env['NODE_ENV'] === 'production' ? PRODUCTION_DEFAULT : null
  }

  // An explicit flag beats the NODE_ENV default in both directions. Turning it
  // off is the documented rollback lever: set TRUST_PROXY=false and recreate
  // the container, no image rebuild needed.
  const normalized = raw.toLowerCase()
  if (DISABLED_VALUES.has(normalized)) {
    return null
  }
  if (normalized === 'true') {
    return true
  }

  // A bare integer is a hop count ("trust the nearest N proxies"), the escape
  // hatch for a deployment whose peer address matches none of the preset
  // ranges. Only safe while the port is not reachable by untrusted clients.
  // Anything else goes through untouched so operators can pass preset names or
  // a CIDR list.
  const hops = Number(raw)
  return Number.isInteger(hops) && hops > 0 ? hops : raw
}
