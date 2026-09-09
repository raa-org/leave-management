/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import type { AdminEmployeeListDto } from '@workspace/contracts'
import { AppRoleName, EmployeeProfileFilter } from '@workspace/contracts'
import { createAdminApiClient, type AdminEmployeesQuery } from './admin-api'

const emptyPage: AdminEmployeeListDto = {
  hoursPerDay: 8,
  items: [] }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// Calls the client and hands back the query string the request actually
// carried. The URL is relative outside a browser, so it is resolved against a
// throwaway origin before parsing.
async function requestedParams(
  input: AdminEmployeesQuery,
): Promise<URLSearchParams> {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(emptyPage),
  )
  const client = createAdminApiClient(fetchMock as typeof fetch)

  await client.getEmployees(input)

  const url = String(fetchMock.mock.calls[0]?.[0])
  expect(url).toContain('/api/admin/employees')
  return new URL(url, 'http://directory.test').searchParams
}

// The directory page hands its whole filter object to getEmployees unmapped, so
// the '' sentinel every select uses for "all" is what has to be dropped on the
// way out — and only that. These pin the boundary the account filter depends
// on: '' means the question was never asked, 'false' asks for the deactivated
// accounts, and the two must not collapse into each other.
describe('admin employees api client', () => {
  // Shape of the page's filter state with nothing chosen.
  const noFilters: AdminEmployeesQuery = {
    search: '',
    roleName: '',
    countryCode: '',
    projectId: '',
    active: '',
    profile: '',
    employmentStartDateFrom: '',
    employmentStartDateTo: '',
  }

  it('asks for the deactivated accounts by value, not by leaving the filter out', async () => {
    const params = await requestedParams({ ...noFilters, active: 'false' })
    expect(params.get('active')).toBe('false')
  })

  it('sends the active-only filter the same way', async () => {
    const params = await requestedParams({ ...noFilters, active: 'true' })
    expect(params.get('active')).toBe('true')
  })

  it('omits the account filter entirely while it is unset', async () => {
    // Not `active=` and not `active=all`: the server tells "absent" apart from
    // both booleans, and a blank value would 400.
    const params = await requestedParams(noFilters)
    expect(params.has('active')).toBe(false)
    // Every other unchosen filter drops out too, which is what makes handing
    // the page's whole state over unmapped safe.
    expect([...params.keys()]).toEqual([])
  })

  it('names the wanted profile population', async () => {
    const params = await requestedParams({
      ...noFilters,
      profile: EmployeeProfileFilter.MissingAny,
    })
    expect(params.get('profile')).toBe('missing_any')
  })

  it('sends each end of the employment range under its own name', async () => {
    // Two fields on the wire for one filter, and either end may travel alone —
    // a range open on one side is a question the server answers.
    const both = await requestedParams({
      ...noFilters,
      employmentStartDateFrom: '2026-03-01',
      employmentStartDateTo: '2026-03-31',
    })
    expect(both.get('employmentStartDateFrom')).toBe('2026-03-01')
    expect(both.get('employmentStartDateTo')).toBe('2026-03-31')

    const openEnded = await requestedParams({
      ...noFilters,
      employmentStartDateFrom: '2026-03-01',
    })
    expect(openEnded.get('employmentStartDateFrom')).toBe('2026-03-01')
    expect(openEnded.has('employmentStartDateTo')).toBe(false)
  })

  it('keeps the chosen filters alongside the cursor on a load-more call', async () => {
    const params = await requestedParams({
      ...noFilters,
      roleName: AppRoleName.Administrator,
      countryCode: 'UA',
      active: 'false',
      profile: EmployeeProfileFilter.Complete,
      employmentStartDateFrom: '2026-03-01',
      cursor: 'opaque-cursor',
    })
    expect(params.get('active')).toBe('false')
    expect(params.get('roleName')).toBe(AppRoleName.Administrator)
    expect(params.get('countryCode')).toBe('UA')
    expect(params.get('profile')).toBe('complete')
    expect(params.get('employmentStartDateFrom')).toBe('2026-03-01')
    expect(params.get('cursor')).toBe('opaque-cursor')
    expect(params.has('search')).toBe(false)
    expect(params.has('projectId')).toBe(false)
    expect(params.has('employmentStartDateTo')).toBe(false)
  })
})
