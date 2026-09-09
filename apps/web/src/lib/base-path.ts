/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * App mount prefix, resolved from the environment at build time.
 *
 * Set `VITE_BASE_PATH` in the root .env files (per environment). It also feeds
 * Vite's `base` option in vite.config.ts, so assets and routing agree.
 *   - "" or "/"        -> served at the origin root (BASE_PATH = "")
 *   - "/runtime/abc"   -> served under a sub-path  (BASE_PATH = "/runtime/abc")
 *
 * Single source of truth for the app's base path:
 *   - react-router: <BrowserRouter basename={BASE_PATH || undefined}>
 *   - API calls:    apiUrl() prefixes paths with BASE_PATH
 *
 * Do NOT derive the base from `document.baseURI`: without a <base href>
 * element it tracks the live URL and changes on every client navigation,
 * which breaks routing under a sub-path mount.
 */
const configuredBasePath = (import.meta.env.VITE_BASE_PATH ?? '').trim()

// Strip trailing slashes; treat empty or a bare "/" as "served at root" ("").
const normalized = configuredBasePath.replace(/\/+$/, '')

export const BASE_PATH = normalized === '' || normalized === '/' ? '' : normalized
