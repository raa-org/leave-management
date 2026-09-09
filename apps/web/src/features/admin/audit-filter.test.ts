/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import type { AdminAuditLogPageDto } from '@workspace/contracts'
import { AuditCategory } from '@workspace/contracts'
import { createAdminApiClient } from './admin-api'
import { AUDIT_CATEGORY_OPTIONS } from './admin-formatters'

const emptyPage: AdminAuditLogPageDto = { items: [] }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// The audit page's Category control is built from AUDIT_CATEGORY_OPTIONS and
// hands the picked value straight to the API client. Neither end shows up in a
// static render — the menu items exist only once the select is opened — so
// these tests stand in for that path.
describe('audit category filter', () => {
  it('offers the directory sync category, spelled as the rows are labelled', () => {
    expect(AUDIT_CATEGORY_OPTIONS).toContainEqual({
      value: AuditCategory.LdapSync,
      label: 'Directory sync',
    })
    // Every category is offered: a value that can reach a stored row must not
    // be one the filter cannot ask for.
    expect(AUDIT_CATEGORY_OPTIONS.map((option) => option.value)).toEqual(
      Object.values(AuditCategory),
    )
  })

  it('sends the chosen category to the audit endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(emptyPage),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await client.getAuditLogs({ category: AuditCategory.LdapSync })

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/audit?category=ldap_sync')
  })

  it('sends no category at all when the filter is on "all"', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(emptyPage),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    // "All categories" is the empty string on the page and reaches the client
    // as undefined. Either way no parameter may go out: the server validates
    // the value against the enum and would reject an empty one.
    await client.getAuditLogs({ category: undefined })

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/audit')
    expect(String(url)).not.toContain('category')
  })
})
