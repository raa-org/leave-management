/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import { createAdminApiClient, type TestToolingState } from './admin-api'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const enabledState: TestToolingState = {
  enabled: true,
  now: '2026-12-31T00:00:00.000Z',
  offsetMs: 14_000_000_000,
}

describe('admin test-tooling api client', () => {
  it('GETs the current tooling/clock state', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(enabledState),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    const state = await client.getTestTooling()

    expect(state).toEqual(enabledState)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/test-tooling')
    expect(init).toBeUndefined()
  })

  it('POSTs a target date to jump the clock', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(enabledState),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await client.setTestTooling({ now: '2026-12-31T00:00:00.000Z' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/test-tooling')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      now: '2026-12-31T00:00:00.000Z',
    })
  })

  it('DELETEs to reset the clock', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ...enabledState, offsetMs: 0 }),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    const state = await client.resetTestTooling()

    expect(state.offsetMs).toBe(0)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('propagates a 404 (tooling disabled) as an error the panel can hide on', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ message: 'Not Found' }, false, 404),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await expect(client.getTestTooling()).rejects.toThrow()
  })

  it('POSTs a userId to reset one user leave data', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ userId: 'user-1', displayName: 'Reset Me' }),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    const result = await client.resetUserLeaveData('user-1')

    expect(result).toEqual({ userId: 'user-1', displayName: 'Reset Me' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/test-tooling/reset-user')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ userId: 'user-1' })
  })

  it('POSTs the keep list, wipe confirmation and audit flag to reset the directory', async () => {
    const result = {
      deletedUsers: 3,
      deletedRequests: 5,
      deletedLedgerEntries: 12,
      deletedDeliveries: 0,
      clearedAuditLogs: 0,
    }
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(result),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    const response = await client.resetDirectory({
      keep: ['keep@example.com'],
      all: false,
      clearAudit: true,
    })

    expect(response).toEqual(result)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/admin/test-tooling/reset-directory')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      keep: ['keep@example.com'],
      all: false,
      clearAudit: true,
    })
  })

  it('surfaces the server refusal message verbatim on a 409', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          message:
            'Directory reset refused: a directory sync is currently running. Retry once it finishes.',
        },
        false,
        409,
      ),
    )
    const client = createAdminApiClient(fetchMock as typeof fetch)

    await expect(
      client.resetDirectory({ keep: [], all: true, clearAudit: false }),
    ).rejects.toThrow(/a directory sync is currently running/)
  })
})
