/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Shared country-code helper so the admin API, the OIDC profile mapper, and
// the web app all canonicalize codes the same way. The OIDC login path
// matches token claims against admin-entered reference codes with exact
// string equality, so every writer and reader must agree on this form.

/** Canonicalize a country code for comparison/storage: trimmed, uppercase. */
export function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase()
}
