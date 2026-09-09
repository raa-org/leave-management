/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DirectoryGroupUnreadableError,
  DirectoryReadError,
} from './directory-sync-failure'
import { LdapDirectoryClient } from './ldap-client'
import { LDAP_SYNC_ATTRIBUTES } from './ldap-entry.mapper'
import type { LdapSyncSettings } from './ldap-sync.config'

const bind = vi.fn()
const search = vi.fn()
const unbind = vi.fn()
const constructed: unknown[] = []

vi.mock('ldapts', () => ({
  Client: class {
    constructor(options: unknown) {
      constructed.push(options)
    }
    bind = bind
    search = search
    unbind = unbind
  },
}))

const settings: LdapSyncSettings = {
  url: 'ldaps://ldap.example.com:636',
  bindDn: 'cn=svc-leave,ou=services,dc=example,dc=com',
  bindPassword: 'secret',
  baseDn: 'ou=people,dc=example,dc=com',
  adminGroupDn: 'cn=lrs-admins,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
  employeeGroupDn:
    'cn=lrs-employees,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
  userFilter: '(objectClass=inetOrgPerson)',
  pageSize: 500,
  connectTimeoutMs: 10_000,
  timeoutMs: 120_000,
  cron: '0 * * * *',
  // Neither field reaches the client — it is handed the whole settings object
  // and reads only the connection ones — but the type is the real one, so the
  // schedule fields are filled in as the scheduler would see them.
  cronEnabled: true,
  skipCertVerify: false,
}

/**
 * Default search behavior for the three-search pass: the user search (paged,
 * by options shape) answers with no entries, each group search with a group
 * carrying one member. Individual tests override per-DN as needed.
 */
function answerSearches(options: {
  users?: unknown[]
  adminMembers?: unknown
  employeeMembers?: unknown
}) {
  search.mockImplementation((base: string) => {
    if (base === settings.adminGroupDn) {
      return Promise.resolve({
        searchEntries:
          options.adminMembers === undefined
            ? [{ dn: settings.adminGroupDn }]
            : [{ dn: settings.adminGroupDn, uniqueMember: options.adminMembers }],
        searchReferences: [],
      })
    }
    if (base === settings.employeeGroupDn) {
      return Promise.resolve({
        searchEntries:
          options.employeeMembers === undefined
            ? [{ dn: settings.employeeGroupDn }]
            : [
                {
                  dn: settings.employeeGroupDn,
                  uniqueMember: options.employeeMembers,
                },
              ],
        searchReferences: [],
      })
    }
    return Promise.resolve({
      searchEntries: options.users ?? [],
      searchReferences: [],
    })
  })
}

describe('LdapDirectoryClient', () => {
  beforeEach(() => {
    bind.mockReset().mockResolvedValue(undefined)
    search.mockReset()
    answerSearches({})
    unbind.mockReset().mockResolvedValue(undefined)
    constructed.length = 0
  })

  afterEach(() => {
    // A failed assertion between a Logger spy and its mockRestore would
    // otherwise leave the prototype mocked for the rest of the file; the
    // module-level bind/search/unbind fns are re-armed in beforeEach.
    vi.restoreAllMocks()
  })

  it('binds, searches the configured tree, and returns the entries', async () => {
    const entries = [
      { dn: 'uid=a,ou=people,dc=example,dc=com', mail: 'a@example.com' },
      { dn: 'uid=b,ou=people,dc=example,dc=com', mail: 'b@example.com' },
    ]
    answerSearches({ users: entries })

    const result = await new LdapDirectoryClient(settings).fetchDirectory()

    expect(result.entries).toEqual(entries)
    expect(bind).toHaveBeenCalledWith(settings.bindDn, settings.bindPassword)
    expect(search).toHaveBeenCalledWith(settings.baseDn, {
      scope: 'sub',
      filter: settings.userFilter,
      attributes: LDAP_SYNC_ATTRIBUTES,
      paged: { pageSize: 500 },
    })
  })

  it('reads both groups base-scope on the same bound connection', async () => {
    await new LdapDirectoryClient(settings).fetchDirectory()

    // One bind serves all three searches, in user-tree → groups order.
    expect(bind).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledTimes(3)
    for (const groupDn of [settings.adminGroupDn, settings.employeeGroupDn]) {
      expect(search).toHaveBeenCalledWith(groupDn, {
        scope: 'base',
        filter: '(objectClass=groupOfUniqueNames)',
        attributes: ['uniqueMember'],
      })
    }
  })

  it('returns each group\'s raw uniqueMember values in directory order', async () => {
    answerSearches({
      adminMembers: [
        'uid=boss,ou=Staff,ou=Users,dc=example,dc=com',
      ],
      employeeMembers: [
        'uid=b,ou=Consultants,ou=Users,dc=example,dc=com',
        'uid=a,ou=Staff,ou=Users,dc=example,dc=com',
      ],
    })

    const result = await new LdapDirectoryClient(settings).fetchDirectory()

    expect(result.adminMemberDns).toEqual([
      'uid=boss,ou=Staff,ou=Users,dc=example,dc=com',
    ])
    expect(result.employeeMemberDns).toEqual([
      'uid=b,ou=Consultants,ou=Users,dc=example,dc=com',
      'uid=a,ou=Staff,ou=Users,dc=example,dc=com',
    ])
  })

  it('flattens single-valued and Buffer uniqueMember shapes to strings', async () => {
    // ldapts hands attribute values back as string | string[] | Buffer |
    // Buffer[] depending on server and value count; membership must not
    // depend on which shape arrived.
    answerSearches({
      adminMembers: 'uid=only,ou=Staff,ou=Users,dc=example,dc=com',
      employeeMembers: [
        Buffer.from('uid=buffered,ou=Staff,ou=Users,dc=example,dc=com'),
      ],
    })

    const result = await new LdapDirectoryClient(settings).fetchDirectory()

    expect(result.adminMemberDns).toEqual([
      'uid=only,ou=Staff,ou=Users,dc=example,dc=com',
    ])
    expect(result.employeeMemberDns).toEqual([
      'uid=buffered,ou=Staff,ou=Users,dc=example,dc=com',
    ])
  })

  it('returns an empty member list for a readable group without uniqueMember values', async () => {
    // An empty list is a fact the client reports, not a failure it invents:
    // whether "no members" is a refusal-worthy state belongs to the caller,
    // which can tell the whole pass's context.
    const result = await new LdapDirectoryClient(settings).fetchDirectory()

    expect(result.adminMemberDns).toEqual([])
    expect(result.employeeMemberDns).toEqual([])
  })

  it('fails the whole read when a group search throws', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const cause = Object.assign(new Error('No Such Object'), { code: 32 })
    search.mockImplementation((base: string) => {
      if (base === settings.employeeGroupDn) {
        return Promise.reject(cause)
      }
      // The user search answers empty, the admins group reads fine — the
      // employees group must be the FIRST failure the pass hits.
      return Promise.resolve({
        searchEntries: base === settings.adminGroupDn ? [{ dn: String(base) }] : [],
        searchReferences: [],
      })
    })

    const rejection = await new LdapDirectoryClient(settings)
      .fetchDirectory()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryReadError)
    expect((rejection as DirectoryReadError).cause).toBe(cause)
    // The log names the env variable whose DN was searched — the classified
    // sentence covers the whole pass and cannot say which search failed.
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'LDAP_EMPLOYEE_GROUP_DN',
    )
    error.mockRestore()
  })

  it('fails the whole read when a group DN resolves to no readable group entry', async () => {
    // Base-scope with the groupOfUniqueNames filter can only come back empty
    // when the DN exists but is not a group the service account can read —
    // returning [] would quietly read as "nobody is an app user".
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    search.mockImplementation((base: string) =>
      Promise.resolve({
        searchEntries:
          base === settings.adminGroupDn ? [] : [{ dn: String(base) }],
        searchReferences: [],
      }),
    )

    const rejection = await new LdapDirectoryClient(settings)
      .fetchDirectory()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryReadError)
    expect((rejection as Error).message).toContain('lrs-admins')
    // The typed cause is what classification recognizes, so the admin gets
    // the unreadable-group sentence instead of the unknown bucket.
    expect((rejection as DirectoryReadError).cause).toBeInstanceOf(
      DirectoryGroupUnreadableError,
    )
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'LDAP_ADMIN_GROUP_DN',
    )
    error.mockRestore()
  })

  it('names the user search inputs when the user search itself fails', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    search.mockRejectedValue(new Error('sizeLimitExceeded'))

    await expect(
      new LdapDirectoryClient(settings).fetchDirectory(),
    ).rejects.toThrow('sizeLimitExceeded')
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'LDAP_BASE_DN',
    )
    error.mockRestore()
  })

  it('requests only the attributes the sync maps', () => {
    // Guards against a future edit widening the request to '*': entries can
    // carry large attributes (photos) that would be fetched for nothing.
    expect(LDAP_SYNC_ATTRIBUTES).toEqual(['mail', 'givenName', 'sn', 'l'])
  })

  it('passes the page size through so the server result limit is respected', async () => {
    await new LdapDirectoryClient({ ...settings, pageSize: 42 }).fetchDirectory()

    expect(search.mock.calls[0]?.[1]).toMatchObject({ paged: { pageSize: 42 } })
  })

  it('hands the configured TLS options to the connection', async () => {
    const tlsOptions = { ca: Buffer.from('CA'), rejectUnauthorized: true }

    await new LdapDirectoryClient({ ...settings, tlsOptions }).fetchDirectory()

    expect(constructed[0]).toEqual({
      url: settings.url,
      connectTimeout: settings.connectTimeoutMs,
      timeout: settings.timeoutMs,
      tlsOptions,
    })
  })

  it('omits TLS options entirely when none are configured', async () => {
    // The system trust store must stay in charge by default — passing an empty
    // options object would be a silent invitation to loosen it later.
    await new LdapDirectoryClient(settings).fetchDirectory()

    expect(constructed[0]).toEqual({
      url: settings.url,
      connectTimeout: settings.connectTimeoutMs,
      timeout: settings.timeoutMs,
    })
  })

  it('unbinds after a successful read', async () => {
    await new LdapDirectoryClient(settings).fetchDirectory()

    expect(unbind).toHaveBeenCalledTimes(1)
  })

  it('propagates a bind failure and still unbinds', async () => {
    bind.mockRejectedValue(new Error('invalidCredentials'))

    await expect(new LdapDirectoryClient(settings).fetchDirectory()).rejects.toThrow(
      'invalidCredentials',
    )
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(search).not.toHaveBeenCalled()
  })

  it('propagates a search failure and still unbinds', async () => {
    search.mockRejectedValue(new Error('sizeLimitExceeded'))

    await expect(new LdapDirectoryClient(settings).fetchDirectory()).rejects.toThrow(
      'sizeLimitExceeded',
    )
    expect(unbind).toHaveBeenCalledTimes(1)
  })

  it.each([
    { step: 'bind', fail: bind },
    { step: 'search', fail: search },
  ])('marks a $step failure as the directory read that raised it', async ({ fail }) => {
    // Only failures carrying this marker may be described to an administrator
    // as the directory's; a database failure later in the pass looks the same
    // by error code alone.
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:636'), {
      code: 'ECONNREFUSED',
    })
    fail.mockRejectedValue(cause)

    const error = await new LdapDirectoryClient(settings)
      .fetchDirectory()
      .then(() => undefined, (rejection: unknown) => rejection)

    expect(error).toBeInstanceOf(DirectoryReadError)
    expect((error as DirectoryReadError).cause).toBe(cause)
  })

  it('leaves the failure trace reading exactly as the cause did', async () => {
    // The message goes into the ldap_sync.failed lifecycle row and the stack
    // into the server log; wrapping must not cost the operator either, nor
    // point the stack at the line that wrapped instead of the line that failed.
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:636')
    search.mockRejectedValue(cause)

    const error = await new LdapDirectoryClient(settings)
      .fetchDirectory()
      .then(() => undefined, (rejection: unknown) => rejection)

    expect((error as Error).message).toBe(cause.message)
    expect((error as Error).stack).toBe(cause.stack)
  })

  it('does not let an unbind failure mask the real error', async () => {
    // A broken connection typically fails both operations; the caller needs
    // the cause, not the teardown symptom.
    search.mockRejectedValue(new Error('connection reset'))
    unbind.mockRejectedValue(new Error('socket already closed'))

    await expect(new LdapDirectoryClient(settings).fetchDirectory()).rejects.toThrow(
      'connection reset',
    )
  })

  it('does not fail a successful read because unbind threw', async () => {
    const entries = [{ dn: 'uid=a,ou=people,dc=example,dc=com' }]
    answerSearches({ users: entries })
    unbind.mockRejectedValue(new Error('socket already closed'))

    await expect(
      new LdapDirectoryClient(settings).fetchDirectory(),
    ).resolves.toMatchObject({ entries })
  })

  describe('transport warnings (once, at construction)', () => {
    it('warns at construction when TLS verification is disabled', () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})

      new LdapDirectoryClient({ ...settings, skipCertVerify: true })

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('verification is DISABLED')
      warn.mockRestore()
    })

    it('stays silent for a verified ldaps:// configuration', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})

      await new LdapDirectoryClient(settings).fetchDirectory()

      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
