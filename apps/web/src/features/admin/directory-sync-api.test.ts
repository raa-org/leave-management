/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  DirectorySyncResultDto,
  DirectorySyncStatusDto,
} from '@workspace/contracts'
import { createAdminApiClient } from './admin-api'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// Reading the status and running a sync share one URL and are told apart only
// by the verb, so the verb is what these tests pin. A run that degraded into a
// status read would resolve with a body carrying no report — a shape the
// result alert has no words for.
describe('directory sync api client', () => {
  const status: DirectorySyncStatusDto = { enabled: true }
  const result: DirectorySyncResultDto = { status: 'already-running' }

  it('GETs the deployment status', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(status),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    expect(await client.getDirectorySyncStatus()).toEqual(status)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/ldap-sync')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('POSTs to run a sync', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(result),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    expect(await client.runDirectorySync()).toEqual(result)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/ldap-sync')
    expect(init?.method).toBe('POST')
  })

  it("passes the API's own failure phrase through to the caller", async () => {
    // The 500 body's message is already worded for people — the server names
    // the cause and keeps the raw error in the audit log.
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { message: 'Could not reach the directory server.', statusCode: 500 },
        false,
        500,
      ),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await expect(client.runDirectorySync()).rejects.toThrow(
      'Could not reach the directory server.',
    )
  })

  it('replaces a non-API failure with a phrase that admits uncertainty', async () => {
    // A gateway's HTML error page means the server may already have accepted
    // the POST: the run may or may not have happened, and the raw body was
    // written for no human — neither belongs in the alert.
    const gatewayPage = '<html><body>502 Bad Gateway (nginx)</body></html>'
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('not json')
          },
          text: async () => gatewayPage,
        }) as unknown as Response,
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    const rejection: unknown = await client
      .runDirectorySync()
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(Error)
    const message = (rejection as Error).message
    expect(message).toContain('may or may not have happened')
    expect(message).not.toContain('nginx')
    expect(message).not.toContain('<html>')
  })

  it('says the same when the connection itself fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await expect(client.runDirectorySync()).rejects.toThrow(
      'may or may not have happened',
    )
  })
})
