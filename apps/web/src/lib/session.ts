/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { apiUrl } from './api-url'

// The auth module's logout route. Since @trusted-modules/auth-oidc-nest 1.3.0
// (with rpInitiatedLogout enabled in AuthOidcHostModule) this clears the app
// cookie AND redirects to the IdP end_session_endpoint with id_token_hint, so the
// Keycloak SSO session is terminated and the browser returns to the landing.
export const LOGOUT_PATH = '/api/auth-oidc/logout'

/**
 * Full sign-out. Navigates the browser to the module logout route (see above).
 * A full-page assign is the right tool here — we are deliberately leaving the SPA
 * for the OAuth provider, the same way the auth module's own login/logout epics do.
 */
export function signOut(): void {
  window.location.assign(apiUrl(LOGOUT_PATH))
}

let sessionExpiredHandler: (() => void) | null = null

/**
 * Register what to do when the API reports an expired/absent session (401).
 * Wired in main.tsx to clear the auth slice so the route guards redirect to the
 * landing. Pass null to detach (e.g. teardown).
 */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler
}

let interceptorInstalled = false

/**
 * Wrap window.fetch once so any API response with status 401 (the cookie is
 * missing or the 1h JWT expired) notifies the app via the registered handler,
 * which clears auth state and lets the route guards redirect to the landing —
 * instead of surfacing a raw "401 Unauthorized" message on the page.
 *
 * A single fetch chokepoint covers every feature (employee epics, admin api,
 * approval page) regardless of how each wires its own error handling. No-op
 * outside the browser (tests run in node and inject their own fetch), and
 * idempotent so a double-install is harmless.
 */
export function installSessionExpiryInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') {
    return
  }
  interceptorInstalled = true

  const nativeFetch = window.fetch.bind(window)
  const wrapped: typeof window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init)
    if (response.status === 401 && sessionExpiredHandler && isApiRequest(input)) {
      sessionExpiredHandler()
    }
    return response
  }
  window.fetch = wrapped
}

function isApiRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  return url.includes('/api/')
}
