/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/// <reference types="vite/client" />

/** Build timestamp (ISO 8601) injected via `define` in vite.config.ts. */
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  /** App mount prefix baked into the SPA (see lib/base-path.ts). */
  readonly VITE_BASE_PATH?: string
  /** Company name shown in the landing footer (see lib/company-name.ts). */
  readonly VITE_COMPANY_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
