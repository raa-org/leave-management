/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Logger } from '@nestjs/common'
import { AppRoleName, emptyDirectorySyncReport } from '@workspace/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClockService } from '../domain/clock.service'
import type { LeaveDomainService } from '../domain/leave-domain.service'
import type { DirectorySyncReport } from '../domain/leave-domain.types'
import { DirectoryMembershipRefusedError } from './directory-sync-failure'
import type { LdapDirectoryClient } from './ldap-client'
import { LdapSyncService } from './ldap-sync.service'

/**
 * The orchestrator owns the membership decisions: who from the staff tree is
 * an app user (lrs-* group membership by DN), which roles each member
 * carries, which group members are stale, and when the numbers are suspicious
 * enough to refuse the whole pass. These tests pin those decisions plus the
 * glue contracts (mapper wiring, fetchedAt/skipped plumbing, the
 * empty-directory refusal, the already-running translation). Locking and all
 * user-table behavior live in the domain and are covered by DB-backed tests
 * in leave-domain.service.spec.ts.
 */

function emptyReport(): DirectorySyncReport {
  return emptyDirectorySyncReport()
}

const JANE_DN = 'uid=jdoe,ou=Consultants,ou=Users,dc=example,dc=com'
const JANE = {
  dn: JANE_DN,
  mail: 'jdoe@example.com',
  givenName: 'Jane',
  sn: 'Doe',
}

/**
 * The client's fetch shape around a set of user entries. By default every
 * entry is a member of the employees group — the plain app-user case — so a
 * test only spells out membership when membership is what it is about.
 */
function directoryFetch(
  entries: Array<Record<string, unknown> & { dn: string }>,
  membership: { adminMemberDns?: string[]; employeeMemberDns?: string[] } = {},
) {
  return {
    entries,
    adminMemberDns: membership.adminMemberDns ?? [],
    employeeMemberDns:
      membership.employeeMemberDns ?? entries.map((entry) => entry.dn),
  }
}

describe('LdapSyncService', () => {
  let fetchDirectory: ReturnType<typeof vi.fn>
  let syncUsersFromDirectory: ReturnType<typeof vi.fn>
  let recordDirectorySyncEmpty: ReturnType<typeof vi.fn>
  let service: LdapSyncService

  beforeEach(() => {
    fetchDirectory = vi.fn().mockResolvedValue(directoryFetch([]))
    syncUsersFromDirectory = vi.fn().mockResolvedValue(emptyReport())
    recordDirectorySyncEmpty = vi.fn().mockResolvedValue(undefined)
    service = new LdapSyncService(
      { fetchDirectory } as unknown as LdapDirectoryClient,
      {
        syncUsersFromDirectory,
        recordDirectorySyncEmpty,
      } as unknown as LeaveDomainService,
      { nowIso: () => '2026-07-22T10:00:00.000Z' } as unknown as ClockService,
    )
  })

  afterEach(() => {
    // A failed assertion between a Logger spy and its mockRestore would
    // otherwise leave the prototype mocked for the rest of the file — later
    // log assertions could then pass on calls the FAILED test accumulated.
    vi.restoreAllMocks()
  })

  it('maps member entries and hands them to the domain with fetchedAt and skip reasons', async () => {
    fetchDirectory.mockResolvedValue(
      directoryFetch([
        { ...JANE, mail: 'Jane.Doe@example.com', l: 'DE' },
        // A MEMBER without mail -> skipped by the mapper, surfaces in the
        // report (and withholds deactivation downstream).
        { dn: 'uid=broken,ou=Users,dc=example,dc=com', displayName: 'No Mail' },
      ]),
    )
    syncUsersFromDirectory.mockResolvedValue({
      ...emptyReport(),
      created: ['Jane.Doe@example.com'],
      skipped: ['entry "uid=broken,ou=Users,dc=example,dc=com" has no mail attribute'],
    })

    const result = await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          email: 'Jane.Doe@example.com',
          displayName: 'Jane Doe',
          countryCode: 'DE',
          roleNames: [AppRoleName.Employee],
        }),
      ],
      {
        // Captured BEFORE the fetch, from the injected clock.
        fetchedAt: '2026-07-22T10:00:00.000Z',
        skipped: [expect.stringContaining('no mail attribute')],
        warnings: [],
        staleAccessMembers: [],
      },
    )
    expect(result.status).toBe('completed')
    expect(
      result.status === 'completed' && result.report.created,
    ).toEqual(['Jane.Doe@example.com'])
  })

  it('mirrors the roles literally from group membership', async () => {
    const bossDn = 'uid=boss,ou=Staff,ou=Users,dc=example,dc=com'
    const bothDn = 'uid=both,ou=Staff,ou=Users,dc=example,dc=com'
    fetchDirectory.mockResolvedValue(
      directoryFetch(
        [
          JANE,
          { dn: bossDn, mail: 'boss@example.com', sn: 'Boss' },
          { dn: bothDn, mail: 'both@example.com', sn: 'Both' },
        ],
        {
          // An admin-only member gets administrator ALONE: whether admins
          // also hold employee is the groups' decision, never synthesized.
          adminMemberDns: [bossDn, bothDn],
          employeeMemberDns: [JANE_DN, bothDn],
        },
      ),
    )

    await service.runSync()

    const batch = syncUsersFromDirectory.mock.calls[0]?.[0]
    expect(batch).toEqual([
      expect.objectContaining({
        email: 'jdoe@example.com',
        roleNames: [AppRoleName.Employee],
      }),
      expect.objectContaining({
        email: 'boss@example.com',
        roleNames: [AppRoleName.Administrator],
      }),
      expect.objectContaining({
        email: 'both@example.com',
        roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
      }),
    ])
  })

  it('matches membership through DN normalization and the optional uid suffix', async () => {
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], {
        // Same DN as the entry, spelled the way another tool might store it:
        // different case, decorative spaces, a nameAndOptionalUID suffix.
        employeeMemberDns: [
          `UID=JDOE, OU=Consultants, OU=Users, DC=example, DC=com#'0101'B`,
        ],
      }),
    )

    await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com' })],
      expect.objectContaining({ staleAccessMembers: [] }),
    )
  })

  it('keeps non-member entries out of the batch without mapping them at all', async () => {
    fetchDirectory.mockResolvedValue(
      directoryFetch(
        [
          JANE,
          // A guest account with a BROKEN mail: were it mapped, it would land
          // in skipped and withhold deactivation for a person the sync was
          // never going to store.
          { dn: 'uid=guest,ou=Consultants,ou=Users,dc=example,dc=com' },
        ],
        { employeeMemberDns: [JANE_DN] },
      ),
    )

    await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com' })],
      expect.objectContaining({ skipped: [], warnings: [] }),
    )
  })

  it('reports group members that match no staff entry as stale, with raw DNs deduplicated', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const goneDn = 'uid=gone,ou=Staff,ou=Users,dc=example,dc=com'
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], {
        // The departed person sits in BOTH groups (spelled differently) —
        // one stale line, first spelling kept, suffix cut.
        adminMemberDns: [`${goneDn}#'01'B`],
        employeeMemberDns: [JANE_DN, goneDn.toUpperCase()],
      }),
    )

    await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com' })],
      expect.objectContaining({ staleAccessMembers: [goneDn] }),
    )
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'without being removed from the app groups',
    )
    warn.mockRestore()
  })

  it('does not call a member stale when their entry exists but failed to map', async () => {
    // The member's entry is IN the staff tree, merely unreadable (no mail):
    // "remove them from the groups" would be wrong advice, and the skipped
    // list already protects them from deactivation.
    fetchDirectory.mockResolvedValue(
      directoryFetch([
        JANE,
        { dn: 'uid=broken,ou=Users,dc=example,dc=com' },
      ]),
    )

    await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com' })],
      expect.objectContaining({
        staleAccessMembers: [],
        skipped: [expect.stringContaining('no mail attribute')],
      }),
    )
  })

  it('refuses the pass when both groups are empty — nothing reaches the domain', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], { employeeMemberDns: [], adminMemberDns: [] }),
    )

    const rejection = await service
      .runSync()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryMembershipRefusedError)
    expect((rejection as Error).message).toContain('refused to act')
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    expect(recordDirectorySyncEmpty).not.toHaveBeenCalled()
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'zero members',
    )
    error.mockRestore()
  })

  it('refuses the pass when the employees group alone is empty — the wholesale-deactivation shape', async () => {
    // An ACL hiding uniqueMember is set per entry, so one group can go dark
    // while the other reads fine; an empty employees group would deactivate
    // everyone outside the admins group.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const bossDn = 'uid=boss,ou=Staff,ou=Users,dc=example,dc=com'
    fetchDirectory.mockResolvedValue(
      directoryFetch(
        [JANE, { dn: bossDn, mail: 'boss@example.com', sn: 'Boss' }],
        { adminMemberDns: [bossDn], employeeMemberDns: [] },
      ),
    )

    const rejection = await service
      .runSync()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryMembershipRefusedError)
    expect((rejection as Error).message).toContain(
      'employees group came back without a single member',
    )
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'LDAP_EMPLOYEE_GROUP_DN',
    )
    error.mockRestore()
  })

  it('refuses the pass when the employees group matches nothing, even though the admins group matches', async () => {
    // A matching admins side must not soften the verdict: the batch would
    // shrink to the admins and everyone else would be deactivated — the
    // wholesale event the guard exists to refuse. Shape: the staff OU was
    // renamed and the small admins group hand-fixed while the employees
    // group still carries the old DNs.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const bossDn = 'uid=boss,ou=Staff,ou=Users,dc=example,dc=com'
    fetchDirectory.mockResolvedValue(
      directoryFetch(
        [JANE, { dn: bossDn, mail: 'boss@example.com', sn: 'Boss' }],
        {
          adminMemberDns: [bossDn],
          employeeMemberDns: [
            'uid=jdoe,ou=Consultants,ou=OldUsers,dc=example,dc=com',
          ],
        },
      ),
    )

    const rejection = await service
      .runSync()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryMembershipRefusedError)
    expect((rejection as Error).message).toContain(
      'Not one member of the lrs employees group matched',
    )
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    expect(error.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'shrink the batch to the admins alone',
    )
    error.mockRestore()
  })

  it('only warns for an empty admins group — it admits nobody on its own', async () => {
    // Blast radius decides: no admins is a benign (if unusual) directory
    // state, and refusing it would wedge the sync entirely.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], { adminMemberDns: [] }),
    )

    const result = await service.runSync()

    expect(result.status).toBe('completed')
    expect(syncUsersFromDirectory).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'admins group (LDAP_ADMIN_GROUP_DN) has zero members',
    )
    warn.mockRestore()
  })

  it('returns empty-directory for a read with no entries even when the groups are populated', async () => {
    // An empty staff tree is a user-search problem; judging membership
    // against it would declare every legitimate member stale and advise
    // removing them from the groups — advice that, followed, strips the
    // whole company's app access.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    fetchDirectory.mockResolvedValue(
      directoryFetch([], {
        adminMemberDns: ['uid=boss,ou=Staff,ou=Users,dc=example,dc=com'],
        employeeMemberDns: [JANE_DN],
      }),
    )

    const result = await service.runSync()

    expect(result).toEqual({ status: 'empty-directory' })
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    // Membership was never judged, so the trace carries no stale members and
    // no non-member count — not a claim that the groups are clean.
    expect(recordDirectorySyncEmpty).toHaveBeenCalledWith({
      entriesRead: 0,
      skipped: [],
      staleAccessMembers: [],
      nonMembers: 0,
      occurredAt: '2026-07-22T10:00:00.000Z',
    })
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).not.toContain(
      'lrs group member(s) match no entry',
    )
    warn.mockRestore()
  })

  it('refuses the pass when no group member matches any entry — a wholesale DN disagreement', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], {
        // Plausible members from ANOTHER environment's folder: not one
        // matches, which marks a configuration/matching defect, not a company
        // where everyone left.
        employeeMemberDns: ['uid=jdoe,ou=Consultants,ou=Users,dc=other,dc=com'],
      }),
    )

    const rejection = await service
      .runSync()
      .then(() => undefined, (raised: unknown) => raised)

    expect(rejection).toBeInstanceOf(DirectoryMembershipRefusedError)
    expect((rejection as Error).message).toContain('disagree about DNs')
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    // The log carries raw-and-normalized samples from BOTH sides — members
    // included — so a normalization defect is diagnosable from the log
    // alone, even when the defect is in the key pipeline itself.
    const logged = error.mock.calls.map((call) => call[0]).join('\n')
    expect(logged).toContain('Sample member values (raw -> normalized)')
    expect(logged).toContain('uid=jdoe,ou=Consultants,ou=Users,dc=other,dc=com')
    error.mockRestore()
  })

  it('tolerates a partial match: unmatched members go stale, the matched ones sync', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const goneDn = 'uid=gone,ou=Staff,ou=Users,dc=example,dc=com'
    fetchDirectory.mockResolvedValue(
      directoryFetch([JANE], { employeeMemberDns: [JANE_DN, goneDn] }),
    )

    const result = await service.runSync()

    expect(result.status).toBe('completed')
    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com' })],
      expect.objectContaining({ staleAccessMembers: [goneDn] }),
    )
    warn.mockRestore()
  })

  it('forwards non-fatal mapper warnings (e.g. an unusable country) to the domain', async () => {
    fetchDirectory.mockResolvedValue(
      directoryFetch([
        {
          ...JANE,
          // Not a known ISO country — the mapper still maps the user (country
          // dropped to null) but emits a warning that must reach the report.
          l: 'Germany',
        },
      ]),
    )

    await service.runSync()

    expect(syncUsersFromDirectory).toHaveBeenCalledWith(
      [expect.objectContaining({ email: 'jdoe@example.com', countryCode: null })],
      expect.objectContaining({
        warnings: [expect.stringContaining('not a known ISO 3166-1')],
      }),
    )
  })

  it('returns empty-directory for a read with no entries at all', async () => {
    // Membership is not judged against an empty staff tree: the empty-read
    // outcome (with its "configuration problem" wording) fires before any
    // group-based refusal could.
    fetchDirectory.mockResolvedValue(
      directoryFetch([], { employeeMemberDns: [], adminMemberDns: [] }),
    )

    const result = await service.runSync()

    expect(result).toEqual({ status: 'empty-directory' })
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    expect(recordDirectorySyncEmpty).toHaveBeenCalledWith({
      entriesRead: 0,
      skipped: [],
      staleAccessMembers: [],
      nonMembers: 0,
      occurredAt: '2026-07-22T10:00:00.000Z',
    })
  })

  it('returns empty-directory when every member entry is unusable, and audits the empty pass', async () => {
    fetchDirectory.mockResolvedValue(
      directoryFetch([
        { dn: 'uid=broken,ou=Users,dc=example,dc=com', displayName: 'No Mail' },
      ]),
    )

    const result = await service.runSync()

    expect(result).toEqual({ status: 'empty-directory' })
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
    expect(recordDirectorySyncEmpty).toHaveBeenCalledWith({
      entriesRead: 1,
      skipped: [expect.stringContaining('no mail attribute')],
      staleAccessMembers: [],
      nonMembers: 0,
      occurredAt: '2026-07-22T10:00:00.000Z',
    })
  })

  it('carries stale members and the non-member count into the empty-pass trace', async () => {
    // The stale warning promises the full DN list in the audit trail, and for
    // this outcome the empty-pass row is the only row the pass writes — so
    // the list must ride it, or the promise points at nothing.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    fetchDirectory.mockResolvedValue(
      directoryFetch(
        [
          { dn: 'uid=broken,ou=Users,dc=example,dc=com', displayName: 'No Mail' },
          // In the tree but in neither group: counted, never named.
          { dn: 'uid=guest,ou=Users,dc=example,dc=com', mail: 'g@example.com' },
        ],
        {
          employeeMemberDns: [
            'uid=broken,ou=Users,dc=example,dc=com',
            'uid=gone,ou=Users,dc=example,dc=com',
          ],
        },
      ),
    )

    const result = await service.runSync()

    expect(result).toEqual({ status: 'empty-directory' })
    expect(recordDirectorySyncEmpty).toHaveBeenCalledWith({
      entriesRead: 2,
      skipped: [expect.stringContaining('no mail attribute')],
      staleAccessMembers: ['uid=gone,ou=Users,dc=example,dc=com'],
      nonMembers: 1,
      occurredAt: '2026-07-22T10:00:00.000Z',
    })
    warn.mockRestore()
  })

  it('still returns empty-directory when the lifecycle-trace write throws', async () => {
    // The trace is best-effort: a failed audit write must not turn a benign
    // empty read into a thrown error the caller would report as a hard failure.
    fetchDirectory.mockResolvedValue(
      directoryFetch([
        { dn: 'uid=broken,ou=Users,dc=example,dc=com', displayName: 'No Mail' },
      ]),
    )
    recordDirectorySyncEmpty.mockRejectedValue(new Error('DB hiccup'))

    const result = await service.runSync()

    expect(result).toEqual({ status: 'empty-directory' })
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
  })

  it('translates the domain declining the sync lock into already-running', async () => {
    fetchDirectory.mockResolvedValue(directoryFetch([JANE]))
    // null = another pass holds the transaction-scoped advisory lock.
    syncUsersFromDirectory.mockResolvedValue(null)

    const result = await service.runSync()

    expect(result).toEqual({ status: 'already-running' })
  })

  it('propagates LDAP failures to the caller untouched', async () => {
    fetchDirectory.mockRejectedValue(new Error('LDAP down'))

    await expect(service.runSync()).rejects.toThrow('LDAP down')
    expect(syncUsersFromDirectory).not.toHaveBeenCalled()
  })

  it('propagates domain failures to the caller untouched', async () => {
    fetchDirectory.mockResolvedValue(directoryFetch([JANE]))
    syncUsersFromDirectory.mockRejectedValue(new Error('db exploded'))

    await expect(service.runSync()).rejects.toThrow('db exploded')
  })
})
