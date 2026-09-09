/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Legal / display name of the hosting company, baked in at build time.
 *
 * Set `VITE_COMPANY_NAME` in the root .env files (per environment). Used in
 * the landing footer copyright line; leave empty to omit the company name.
 */
const configuredCompanyName = (import.meta.env.VITE_COMPANY_NAME ?? '').trim()

export const COMPANY_NAME = configuredCompanyName
