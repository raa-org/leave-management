/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { BASE_PATH } from './base-path'

/**
 * Resolve an API path against the app's injected mount prefix (BASE_PATH).
 *
 * The orchestrator runtime serves this app under `${BASE_PATH}/` and
 * forwards `${BASE_PATH}/api/*` to the backend. Under `vite dev` BASE_PATH
 * is empty and calls hit the dev origin directly.
 *
 * Build the URL from BASE_PATH - a stable build-time constant - rather than
 * `document.baseURI`, which (absent a <base href>) tracks the live URL and
 * changes on every client navigation.
 *
 * Example:
 *   import { apiUrl } from '../lib/api-url'
 *   const todos = await fetch(apiUrl('/api/todos')).then((r) => r.json())
 */
export const apiUrl = (path: string): string => {
  const suffix = path.startsWith('/') ? path : `/${path}`
  const rooted = `${BASE_PATH}${suffix}`
  if (typeof window === 'undefined') {
    return rooted
  }
  return new URL(rooted, window.location.origin).toString()
}
