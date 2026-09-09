/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import type { DataSource } from 'typeorm'
import {
  AppRoleName,
  AuditCategory,
  AuditEventType,
  ApproverDecision,
  CarryoverCapMode,
  CarryoverPolicy,
  EmployeeProfileFilter,
  EmployeeProfileStatus,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveType,
} from '@workspace/contracts'
import { initTestDataSource, truncateAll } from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import {
  seedMembership,
  seedProject,
  testProjectId,
} from '../test-support/projects'
import {
  AccountDeactivatedError,
  CountryTimezoneNotAvailableError,
  DefaultTimezoneNotRecognizedError,
  LeaveDomainService,
  LeaveDomainValidationError,
  LoginIdentityConflictError,
  NoApplicationAccessError,
} from './leave-domain.service'
import { DEFAULT_TIMEZONE, lookupCountry } from './country-catalog'
import { CountryEntity } from './entities/country.entity'
import {
  LeaveSettingsEntity,
  SETTINGS_SINGLETON_ID,
} from './entities/leave-settings.entity'
import { AuditLogService } from './audit-log.service'
import { ClockService } from './clock.service'
import { NotificationService } from './notification.service'
import { UserEntity } from './entities/user.entity'
import { LeaveAllocationEntity } from './entities/leave-allocation.entity'
import { NotificationDeliveryEntity } from '../notifications/notification-delivery.entity'
import { LeaveNotificationDeliveryStore } from '../notifications/leave-notification.delivery-store'

describe('LeaveDomainService', () => {
  let dataSource: DataSource
  let service: LeaveDomainService
  // Test-tooling resets refuse to run unless TEST_TOOLING_ENABLED is on, and
  // ClockService reads that flag once at construction — so those specs drive
  // this second service while everything else keeps the production-like one.
  let tooling: LeaveDomainService

  beforeAll(async () => {
    dataSource = await initTestDataSource()
  })

  afterAll(async () => {
    // Guarded: when initTestDataSource fails in beforeAll (test DB down),
    // an unconditional destroy() buries the real connection error under a
    // secondary TypeError.
    await dataSource?.destroy()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    const clock = new ClockService()
    service = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const toolingClock = new ClockService()
    tooling = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, toolingClock),
      toolingClock,
      new NotificationService(dataSource, toolingClock),
    )
    delete process.env['TEST_TOOLING_ENABLED']
  })

  it('links an existing user by normalized email before creating a duplicate identity record', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Seeded WITHOUT a country so the assertion below can only pass when the
    // identity login's countryCode survives the by-email upsert branch.
    const seeded = await service.upsertUser({
      userId: testUuid('user-1'),
      email: 'Alex.Employee@Example.com',
      displayName: 'Alex Employee',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const linked = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-1',
      email: 'alex.employee@example.com',
      displayName: 'Alex Employee',
      roles: [AppRoleName.Employee],
      countryCode: 'UA',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    expect(linked.userId).toBe(seeded.userId)
    // The by-email branch is the only one of the three upsert call sites in
    // findOrCreateUserFromIdentity exercised here — pin its countryCode
    // hand-off so a regression in just this branch cannot pass unnoticed.
    expect(linked.countryCode).toBe('UA')
    expect(await service.listUsers()).toHaveLength(1)
    expect((await service.findUserBySubject('oidc-subject-1'))?.userId).toBe(
      seeded.userId,
    )
    expect(await service.getUserRoleNames(seeded.userId)).toEqual([
      AppRoleName.Employee,
    ])
  })

  it('mirrors token roles into user_roles on every login (add and remove)', async () => {
    await service.updateLeaveSettings(makeSettings())

    // First login carries both app roles -> mirrored literally.
    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-roles',
      email: 'roles@example.com',
      displayName: 'Roles User',
      roles: [AppRoleName.Employee, AppRoleName.Administrator],
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    // The synced set is returned so the auth layer can build the session
    // profile without re-querying.
    expect(created.roleNames).toEqual([
      AppRoleName.Administrator,
      AppRoleName.Employee,
    ])
    expect(await service.getUserRoleNames(created.userId)).toEqual([
      AppRoleName.Administrator,
      AppRoleName.Employee,
    ])

    // Keycloak revoked the admin role -> the next login removes exactly that
    // mirror row; employee stays because the token still carries it.
    const relogged = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-roles',
      email: 'roles@example.com',
      displayName: 'Roles User',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-03T00:00:00.000Z',
    })
    expect(relogged.roleNames).toEqual([AppRoleName.Employee])
    expect(await service.getUserRoleNames(created.userId)).toEqual([
      AppRoleName.Employee,
    ])

    // Both the elevated provisioning grant and the later revocation are
    // explicit user_roles.assigned audit entries (newest first); only the bare
    // [employee] baseline would be unaudited.
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const grants = await auditLog.getAdminAuditLogs({
      userId: created.userId,
      eventType: AuditEventType.UserRolesAssigned,
    })
    expect(
      grants.items.map((item) => [item.before?.['roles'], item.after?.['roles']]),
    ).toEqual([
      [
        [AppRoleName.Administrator, AppRoleName.Employee],
        [AppRoleName.Employee],
      ],
      [[], [AppRoleName.Administrator, AppRoleName.Employee]],
    ])

    // The mirror removes the employee role like any other: no role is
    // shielded from the remove half of add-and-remove.
    const adminOnly = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-roles',
      email: 'roles@example.com',
      displayName: 'Roles User',
      roles: [AppRoleName.Administrator],
      occurredAt: '2026-01-04T00:00:00.000Z',
    })
    expect(adminOnly.roleNames).toEqual([AppRoleName.Administrator])
    expect(await service.getUserRoleNames(created.userId)).toEqual([
      AppRoleName.Administrator,
    ])
  })

  it('mirrors an admin-only token literally, without an implied employee role', async () => {
    await service.updateLeaveSettings(makeSettings())

    // Whether admins also hold the employee role is the directory groups'
    // decision, carried by the token — the mirror must not synthesize it.
    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-admin-only',
      email: 'admin.only@example.com',
      displayName: 'Admin Only',
      roles: [AppRoleName.Administrator],
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    expect(created.roleNames).toEqual([AppRoleName.Administrator])
    expect(await service.getUserRoleNames(created.userId)).toEqual([
      AppRoleName.Administrator,
    ])
  })

  it('refuses a first sign-in carrying no app role and provisions nothing', async () => {
    await service.updateLeaveSettings(makeSettings())

    // Keycloak authenticates the whole staff directory; an account outside
    // the leaverequest-app groups arrives with no app role and must not
    // acquire a row by signing in.
    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-guest',
        email: 'guest@example.com',
        displayName: 'Guest Account',
        roles: [],
        // A real country that is NOT part of the seeded settings: only the
        // login's own country resolution could create its row.
        countryCode: 'DE',
        occurredAt: '2026-01-02T00:00:00.000Z',
      }),
    ).rejects.toThrow(NoApplicationAccessError)

    expect(await service.listUsers()).toHaveLength(0)
    // The token's country resolves only after the refusal checks, so the
    // refused login leaves no country row behind either.
    expect(
      await dataSource.getRepository(CountryEntity).countBy({ code: 'DE' }),
    ).toBe(0)
    // The refusal itself is the only trace the attempt leaves — and with no
    // matched row it references no user on either side.
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const refused = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.UserLoginRefused,
    })
    expect(refused.items).toHaveLength(1)
    expect(refused.items[0]?.summary).toBe(
      'Refused sign-in for Guest Account: the token carries no application role',
    )
    expect(refused.items[0]?.actorUserId).toBeUndefined()
    expect(refused.items[0]?.targetUserId).toBeUndefined()
  })

  it('refuses a role-less sign-in of an existing user without touching their stored roles', async () => {
    await service.updateLeaveSettings(makeSettings())
    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-losing-access',
      email: 'losing.access@example.com',
      displayName: 'Losing Access',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-subject-losing-access',
        email: 'losing.access@example.com',
        // The token's name differs on purpose: the refusal audit must name
        // the stored account, and a refused login patches no profile fields.
        displayName: 'Renamed In Token',
        roles: [],
        occurredAt: '2026-01-03T00:00:00.000Z',
      }),
    ).rejects.toThrow(NoApplicationAccessError)

    // The stored mirror stays as it was: ruling on a role-less account is
    // the directory sync's job, not the refused login's.
    expect(await service.getUserRoleNames(created.userId)).toEqual([
      AppRoleName.Employee,
    ])
    // The stored profile is untouched too: the token's new name was not
    // patched on.
    expect(
      (await service.findUserBySubject('oidc-subject-losing-access'))
        ?.displayName,
    ).toBe('Losing Access')
    // The refusal is audited against the matched account: its ids, its
    // stored display name.
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const refused = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.UserLoginRefused,
    })
    expect(refused.items).toHaveLength(1)
    expect(refused.items[0]?.summary).toBe(
      'Refused sign-in for Losing Access: the token carries no application role',
    )
    expect(refused.items[0]?.actorUserId).toBe(created.userId)
    expect(refused.items[0]?.targetUserId).toBe(created.userId)
  })

  it('refuses a deactivated account as deactivated even when its token also has no roles', async () => {
    await service.updateLeaveSettings(makeSettings())
    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-retired',
      email: 'retired@example.com',
      displayName: 'Retired User',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    // Deactivated by an admin, not by themselves — self-deactivation is
    // refused, and the audit actor must exist as a user row (FK).
    const adminActor = await service.upsertUser({
      userId: testUuid('retire-admin'),
      email: 'retire.admin@example.com',
      displayName: 'Retire Admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeActive({
      userId: created.userId,
      active: false,
      audit: {
        userId: adminActor.userId,
        label: 'Retire Admin',
        email: 'retire.admin@example.com',
        roles: [AppRoleName.Administrator],
      },
    })

    // A retired account typically loses its directory groups too, so its
    // token arrives role-less. "Deactivated" is the more precise refusal
    // and must win over "no application role" — the deactivation check runs
    // first.
    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-subject-retired',
        email: 'retired@example.com',
        displayName: 'Retired User',
        roles: [],
        occurredAt: '2026-01-03T00:00:00.000Z',
      }),
    ).rejects.toThrow(AccountDeactivatedError)
  })

  it('refuses a login whose subject and email resolve to different accounts', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Two distinct accounts, each keyed to its own subject + email.
    const alice = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    await service.findOrCreateUserFromIdentity({
      subject: 'oidc-bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    // Alice's stable subject now arrives carrying BOB's email — one identity
    // claiming two rows. Refused, nothing written.
    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-alice',
        email: 'bob@example.com',
        displayName: 'Alice',
        roles: [AppRoleName.Employee],
        occurredAt: '2026-01-03T00:00:00.000Z',
      }),
    ).rejects.toThrow(LoginIdentityConflictError)

    // Neither row was touched: Alice keeps her email, Bob keeps his.
    const aliceRow = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ subject: 'oidc-alice' })
    expect(aliceRow.id).toBe(alice.userId)
    expect(aliceRow.normalizedEmail).toBe('alice@example.com')
    const bobRow = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
    expect(bobRow.subject).toBe('oidc-bob')

    // The refusal is audited as an identity conflict.
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const conflicts = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.UserIdentityConflict,
    })
    expect(conflicts.items).toHaveLength(1)
    expect(conflicts.items[0]?.targetUserId).toBe(alice.userId)
  })

  it('refuses a subject-matched login whose email changed, leaving it untouched', async () => {
    await service.updateLeaveSettings(makeSettings())
    const alice = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-01T00:00:00.000Z',
    })

    // Same subject, a NEW normalized email belonging to nobody. Email is owned
    // by LDAP→sync, never rewritten by a login — the change is an anomaly the
    // login must NOT apply, so it is refused, the stored email left intact, and
    // the anomaly audited. (Reconciliation is the sync's next pass or an admin.)
    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-alice',
        email: 'alice.new@example.com',
        displayName: 'Alice',
        roles: [AppRoleName.Employee],
        occurredAt: '2026-01-02T00:00:00.000Z',
      }),
    ).rejects.toThrow(LoginIdentityConflictError)

    const row = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ subject: 'oidc-alice' })
    expect(row.id).toBe(alice.userId)
    expect(row.normalizedEmail).toBe('alice@example.com')
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const conflicts = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.UserIdentityConflict,
    })
    expect(conflicts.items).toHaveLength(1)
    expect(conflicts.items[0]?.targetUserId).toBe(alice.userId)
  })

  it('refuses a login whose email belongs to another subject, not overwriting it', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Bob owns shared@; his row is active and subject-linked.
    const bob = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-bob',
      email: 'shared@example.com',
      displayName: 'Bob',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-01T00:00:00.000Z',
    })

    // A DIFFERENT person (new subject) signs in with Bob's email. Linking her
    // subject would overwrite Bob's — account takeover — so it is refused and
    // Bob's row is left intact. (byEmail found a row whose subject is non-null
    // and not hers.)
    await expect(
      service.findOrCreateUserFromIdentity({
        subject: 'oidc-carol',
        email: 'shared@example.com',
        displayName: 'Carol',
        roles: [AppRoleName.Employee],
        occurredAt: '2026-01-02T00:00:00.000Z',
      }),
    ).rejects.toThrow(LoginIdentityConflictError)

    const row = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ normalizedEmail: 'shared@example.com' })
    expect(row.id).toBe(bob.userId)
    expect(row.subject).toBe('oidc-bob')
    expect(await service.findUserBySubject('oidc-carol')).toBeUndefined()
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const conflicts = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.UserIdentityConflict,
    })
    expect(conflicts.items).toHaveLength(1)
    expect(conflicts.items[0]?.targetUserId).toBe(bob.userId)
  })

  it('does not audit a profile sync when a repeat login changes nothing', async () => {
    // Guards change detection in upsertUserTx: when no OWNED column differs the
    // update path builds an empty patch and skips the write, so a repeat login
    // must emit no UserProfileSynced. A regression here (a column wrongly
    // treated as changed) would make every unchanged login audit-noisy.
    const login = {
      subject: 'oidc-subject-unchanged',
      email: 'unchanged@example.com',
      displayName: 'Unchanged User',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-01T00:00:00.000Z',
    }
    const created = await service.findOrCreateUserFromIdentity(login)
    await service.findOrCreateUserFromIdentity({
      ...login,
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    const auditLog = new AuditLogService(dataSource, new ClockService())
    const synced = await auditLog.getAdminAuditLogs({
      userId: created.userId,
      eventType: AuditEventType.UserProfileSynced,
    })
    expect(synced.items).toEqual([])
  })

  describe('syncUsersFromDirectory', () => {
    const jane = {
      email: 'Jane.Doe@example.com',
      displayName: 'Jane Doe',
      countryCode: 'DE',
      // The batch always names roles — membership is resolved before the
      // domain is called; employee-only keeps these fixtures on the plain
      // app-user case.
      roleNames: [AppRoleName.Employee],
    }
    const bob = {
      email: 'bob@example.com',
      displayName: 'Bob Brown',
      countryCode: null,
      roleNames: [AppRoleName.Employee],
    }
    // Distinct instants for consecutive passes: audit ordering ties break on
    // a random UUID within one millisecond, and the fetchedAt guard compares
    // createdAt against the pass instant — identical timestamps would make
    // both nondeterministic.
    const T1 = '2026-01-01T00:00:00.000Z'
    const T2 = '2026-01-02T00:00:00.000Z'
    const T3 = '2026-01-03T00:00:00.000Z'

    /**
     * The lock is uncontended in tests; a null report would be a bug.
     * fetchedAt defaults to occurredAt — the common "fetch just happened"
     * shape; tests exercising the new-hire guard pass it explicitly.
     */
    const sync = async (
      users: Parameters<LeaveDomainService['syncUsersFromDirectory']>[0],
      options: {
        occurredAt: string
        fetchedAt?: string
        skipped?: string[]
        warnings?: string[]
        staleAccessMembers?: string[]
      },
    ) => {
      const report = await service.syncUsersFromDirectory(users, {
        occurredAt: options.occurredAt,
        fetchedAt: options.fetchedAt ?? options.occurredAt,
        ...(options.skipped ? { skipped: options.skipped } : {}),
        ...(options.warnings ? { warnings: options.warnings } : {}),
        staleAccessMembers: options.staleAccessMembers ?? [],
      })
      expect(report).not.toBeNull()
      return report!
    }

    it('creates directory users idempotently — a second identical pass changes nothing', async () => {
      await service.updateLeaveSettings(makeSettings())

      const first = await sync([jane, bob], { occurredAt: T1 })
      expect(first.created.sort()).toEqual(['Jane.Doe@example.com', 'bob@example.com'].sort())
      expect(first.updated).toEqual([])
      expect(first.deactivated).toEqual([])

      const second = await sync([jane, bob], { occurredAt: T2 })
      expect(second).toEqual({
        created: [],
        updated: [],
        deactivated: [],
        conflicts: [],
        duplicateEmails: [],
        skipped: [],
        warnings: [],
        deactivationWithheld: false,
        adminGranted: [],
        adminRevoked: [],
        employeeGranted: [],
        employeeRevoked: [],
        staleAccessMembers: [],
      })

      const users = await dataSource.getRepository(UserEntity).find()
      expect(users).toHaveLength(2)
      const created = users.find((user) => user.normalizedEmail === 'jane.doe@example.com')
      expect(created?.displayName).toBe('Jane Doe')
      expect(created?.countryCode).toBe('DE')
      expect(created?.active).toBe(true)
      // subject belongs to the SSO path; the sync must never write it.
      expect(created?.subject).toBeNull()
      // A created user gets exactly the batch's roles, and balances like any
      // other provisioning source.
      expect(await service.getUserRoleNames(created!.id)).toEqual([
        AppRoleName.Employee,
      ])
    })

    it('mirrors group roles literally and reports the admin diff, not the input flags', async () => {
      await service.updateLeaveSettings(makeSettings())
      const boss = {
        email: 'boss@example.com',
        displayName: 'Boss Brown',
        countryCode: null,
        roleNames: [AppRoleName.Administrator],
      }
      const both = {
        email: 'both@example.com',
        displayName: 'Both Roles',
        countryCode: null,
        roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
      }

      const first = await sync([jane, boss, both], { occurredAt: T1 })

      const ids = new Map<string, string>()
      for (const user of await dataSource.getRepository(UserEntity).find()) {
        ids.set(user.normalizedEmail, user.id)
      }
      // Literal mirror: an admin-only member gets no synthesized employee —
      // the directory sync writes what the groups say, exactly like the
      // login writes what the token says.
      expect(
        await service.getUserRoleNames(ids.get('boss@example.com')!),
      ).toEqual([AppRoleName.Administrator])
      expect(
        await service.getUserRoleNames(ids.get('both@example.com')!),
      ).toEqual([AppRoleName.Administrator, AppRoleName.Employee])
      expect(
        await service.getUserRoleNames(ids.get('jane.doe@example.com')!),
      ).toEqual([AppRoleName.Employee])
      expect(first.adminGranted.sort()).toEqual([
        'boss@example.com',
        'both@example.com',
      ])
      expect(first.adminRevoked).toEqual([])
      // Creation grants ride the per-role lists too: coming into existence
      // with a role IS that role's grant.
      expect(first.employeeGranted.sort()).toEqual([
        'Jane.Doe@example.com',
        'both@example.com',
      ])
      expect(first.employeeRevoked).toEqual([])

      // An identical pass changes no rows, so nothing is re-reported — the
      // report reflects the applied diff, not the input flags.
      const second = await sync([jane, boss, both], { occurredAt: T2 })
      expect(second.adminGranted).toEqual([])
      expect(second.adminRevoked).toEqual([])
      expect(second.employeeGranted).toEqual([])
      expect(second.employeeRevoked).toEqual([])

      // The admins group dropped boss to employee-only: both halves of the
      // move come from the diff, and the stored set follows the groups
      // literally.
      const third = await sync(
        [jane, { ...boss, roleNames: [AppRoleName.Employee] }, both],
        { occurredAt: T3 },
      )
      expect(third.adminGranted).toEqual([])
      expect(third.adminRevoked).toEqual(['boss@example.com'])
      expect(third.employeeGranted).toEqual(['boss@example.com'])
      expect(third.employeeRevoked).toEqual([])
      expect(
        await service.getUserRoleNames(ids.get('boss@example.com')!),
      ).toEqual([AppRoleName.Employee])

      // Boss's role history, newest first: the demotion, then the first
      // grant — whose before-state is EMPTY. The directory path seeds no
      // baseline: the group mirror is the single writer of user_roles here,
      // exactly as the token mirror is on the login path.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const grants = await auditLog.getAdminAuditLogs({
        userId: ids.get('boss@example.com')!,
        eventType: AuditEventType.UserRolesAssigned,
      })
      expect(
        grants.items.map((item) => [item.before?.['roles'], item.after?.['roles']]),
      ).toEqual([
        [[AppRoleName.Administrator], [AppRoleName.Employee]],
        [[], [AppRoleName.Administrator]],
      ])
    })

    it('warns when the sync changes roles of an SSO-linked account — recurrence means config ping-pong', async () => {
      await service.updateLeaveSettings(makeSettings())
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined)

      // Created by the sync (no subject yet): the grant is provisioning, not
      // a disagreement between writers — the detector stays silent.
      await sync([jane], { occurredAt: T1 })
      expect(warn.mock.calls.map((call) => call[0]).join('\n')).not.toContain(
        'SSO-linked',
      )

      // The person signs in: the subject links and the token confirms the
      // stored roles (no change, no detector line).
      await service.findOrCreateUserFromIdentity({
        subject: 'oidc-pingpong',
        email: jane.email,
        displayName: jane.displayName,
        roles: [AppRoleName.Employee],
        occurredAt: T2,
      })

      // Now the groups say something the token's last word did not: the
      // mirror writes, and the detector names the account — recurrence of
      // this line is the signature of a Keycloak-mapping/group-DN drift.
      warn.mockClear()
      await sync(
        [
          {
            ...jane,
            roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
          },
        ],
        { occurredAt: T3 },
      )
      const logged = warn.mock.calls.map((call) => call[0]).join('\n')
      expect(logged).toContain('SSO-linked Jane.Doe@example.com')
      expect(logged).toContain('Keycloak role mapping')
      warn.mockRestore()
    })

    it('refuses a batch entry with no roles instead of stripping the account', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane], { occurredAt: T1 })

      // The type promises roleNames is never empty; a runtime breach must be
      // loud — silently mirroring [] would revoke everything from an active
      // account while the pass reports success.
      await expect(
        service.syncUsersFromDirectory([{ ...jane, roleNames: [] }], {
          fetchedAt: T2,
          staleAccessMembers: [],
        }),
      ).rejects.toThrow(/no roles — refusing the batch/)

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      expect(await service.getUserRoleNames(row.id)).toEqual([
        AppRoleName.Employee,
      ])
    })

    it('leaves a deactivated conflict row untouched even when the groups changed its roles', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane], { occurredAt: T1 })
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      const actor = await service.upsertUser({
        userId: testUuid('conflict-admin'),
        email: 'conflict.admin@example.com',
        displayName: 'Conflict Admin',
        createdAt: T1,
      })
      await service.setEmployeeActive({
        userId: row.id,
        active: false,
        audit: {
          userId: actor.userId,
          label: 'Conflict Admin',
          email: 'conflict.admin@example.com',
          roles: [AppRoleName.Administrator],
        },
      })

      // The directory now claims she is an admin — the sync flags the
      // conflict and must not touch the retired row: no reactivation, no
      // role write, no admin-grant report.
      const report = await sync(
        [{ ...jane, roleNames: [AppRoleName.Employee, AppRoleName.Administrator] }],
        { occurredAt: T2 },
      )

      expect(report.conflicts).toEqual(['Jane.Doe@example.com'])
      expect(report.adminGranted).toEqual([])
      expect(report.employeeGranted).toEqual([])
      expect(await service.getUserRoleNames(row.id)).toEqual([
        AppRoleName.Employee,
      ])
      const after = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: row.id })
      expect(after.active).toBe(false)
    })

    it('clears a stored country when the directory no longer provides one (LDAP is the source of truth)', async () => {
      await service.updateLeaveSettings(makeSettings())
      // First pass: Jane carries DE.
      await sync([jane], { occurredAt: T1 })
      const before = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      expect(before.countryCode).toBe('DE')

      // Second pass: her `l` is now absent/unusable → mapped countryCode null.
      // LDAP is the source of truth, so the stored DE must be CLEARED, not kept.
      const report = await sync([{ ...jane, countryCode: null }], { occurredAt: T2 })

      expect(report.updated).toEqual(['Jane.Doe@example.com'])
      const after = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      expect(after.countryCode).toBeNull()
    })

    it('updates an SSO-provisioned row by email without touching its subject', async () => {
      await service.updateLeaveSettings(makeSettings())
      const logged = await service.findOrCreateUserFromIdentity({
        subject: 'oidc-jane',
        email: 'Jane.Doe@example.com',
        displayName: 'Old Name',
        roles: [AppRoleName.Employee],
      })

      const report = await sync([jane], { occurredAt: T2 })

      expect(report.created).toEqual([])
      expect(report.updated).toEqual(['Jane.Doe@example.com'])
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: logged.userId })
      expect(row.displayName).toBe('Jane Doe')
      expect(row.subject).toBe('oidc-jane')

      // The change is audited with the sync as the actor.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const synced = await auditLog.getAdminAuditLogs({
        userId: logged.userId,
        eventType: AuditEventType.UserProfileSynced,
      })
      expect(synced.items).toHaveLength(1)
      expect(synced.items[0]?.actorLabel).toBe('LDAP sync')
    })

    it('writes only the columns it owns and scopes the audit to them', async () => {
      await service.updateLeaveSettings(makeSettings())
      // SSO links the subject; the admin then owns workday + start date.
      const logged = await service.findOrCreateUserFromIdentity({
        subject: 'oidc-jane',
        email: 'Jane.Doe@example.com',
        displayName: 'Old Name',
        countryCode: 'DE',
        roles: [AppRoleName.Employee],
        occurredAt: T1,
      })
      // Far-future start date: set, but with no accrual side effects.
      await service.updateEmployeeAdmin({
        userId: logged.userId,
        employmentStartDate: '2099-01-01',
      })

      // The directory pass changes ONLY the display name.
      await sync([jane], { occurredAt: T2 })

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: logged.userId })
      expect(row.displayName).toBe('Jane Doe')
      // Columns the sync does NOT own survive the targeted UPDATE untouched —
      // they are never named in the generated SQL, so no stale snapshot of the
      // sync's could revert them.
      expect(row.subject).toBe('oidc-jane')
      expect(row.employmentStartDate).toBe('2099-01-01')
      expect(row.active).toBe(true)
      // updatedAt round-trips through isoDateTimeTransformer on a PARTIAL update
      // (repo.update), proving the transformer runs for a patch, not just save.
      expect(row.updatedAt).toBe(T2)

      // The audit before/after carry ONLY the sync's owned columns; a change to
      // a non-owned column (read without a lock) can never leak into this diff.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const synced = await auditLog.getAdminAuditLogs({
        userId: logged.userId,
        eventType: AuditEventType.UserProfileSynced,
      })
      expect(synced.items).toHaveLength(1)
      const event = synced.items[0]!
      expect(Object.keys(event.before ?? {}).sort()).toEqual([
        'countryCode',
        'displayName',
        'email',
      ])
      expect(Object.keys(event.after ?? {}).sort()).toEqual([
        'countryCode',
        'displayName',
        'email',
      ])
      expect(event.before?.['displayName']).toBe('Old Name')
      expect(event.after?.['displayName']).toBe('Jane Doe')
      // The field-level diff names only the one column that actually changed.
      expect(event.changedFields?.map((change) => change.field)).toEqual([
        'displayName',
      ])
    })

    it('deactivates users missing from the directory and refuses their next login', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })

      // Bob left the company: the next pass only lists Jane.
      const report = await sync([jane], { occurredAt: T2 })
      expect(report.deactivated).toEqual(['bob@example.com'])

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
      expect(row.active).toBe(false)
      // The atomic conditional UPDATE stamps updatedAt through the
      // isoDateTimeTransformer just like a full save did.
      expect(row.updatedAt).toBe(T2)

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const deactivations = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.UserDeactivated,
      })
      expect(deactivations.items).toHaveLength(1)
      // Ownership-narrowed snapshot: before/after carry ONLY the `active`
      // flip, and the derived diff names exactly that one field.
      expect(deactivations.items[0]?.before).toEqual({ active: true })
      expect(deactivations.items[0]?.after).toEqual({ active: false })
      expect(deactivations.items[0]?.changedFields?.map((c) => c.field)).toEqual([
        'active',
      ])

      // The account is now refused at the door, and the refusal is audited.
      await expect(
        service.findOrCreateUserFromIdentity({
          subject: 'oidc-bob',
          email: 'bob@example.com',
          displayName: 'Bob Brown',
          roles: [AppRoleName.Employee],
        }),
      ).rejects.toThrow(LeaveDomainValidationError)
      const refusals = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.UserLoginRefused,
      })
      expect(refusals.items).toHaveLength(1)
    })

    it('does not re-deactivate or re-audit a user who stays absent across passes', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })
      const first = await sync([jane], { occurredAt: T2 })
      expect(first.deactivated).toEqual(['bob@example.com'])

      // Bob is still gone the next pass. He is already inactive, so the pass
      // must neither report nor audit a second deactivation: the active-only
      // candidate scan skips him and — had a concurrent writer retired him
      // first — the affected-row guard would too.
      const second = await sync([jane], { occurredAt: T3 })
      expect(second.deactivated).toEqual([])
      expect(second.conflicts).toEqual([])

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const deactivations = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.UserDeactivated,
      })
      expect(deactivations.items).toHaveLength(1)

      // updatedAt was stamped by the FIRST pass and never touched again.
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
      expect(row.updatedAt).toBe(T2)
    })

    it('flags a deactivated-but-present user as a conflict and leaves the row untouched', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })
      await sync([jane], { occurredAt: T2 }) // bob deactivated

      // Bob reappears in LDAP (directory mistake or re-hire) with new data.
      const report = await sync(
        [jane, { ...bob, displayName: 'Bob Rehired' }],
        { occurredAt: T3 },
      )

      expect(report.conflicts).toEqual(['bob@example.com'])
      expect(report.updated).toEqual([])
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
      // NOT reactivated, fields NOT updated — manual resolution only.
      expect(row.active).toBe(false)
      expect(row.displayName).toBe('Bob Brown')

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const conflicts = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.UserSyncConflict,
      })
      expect(conflicts.items).toHaveLength(1)
      // Nothing changed: the explicit changedFields:[] suppresses the derived
      // diff, and no before/after is recorded.
      expect(conflicts.items[0]?.changedFields).toBeUndefined()
      expect(conflicts.items[0]?.before).toBeUndefined()
      expect(conflicts.items[0]?.after).toBeUndefined()
    })

    it('skips batch duplicates and withholds deactivation for the whole pass', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })

      // The unique-overlay guarantee broke: two entries share Jane's address
      // AND Bob's entry is absent. Nothing may be deactivated off a batch
      // duplicates made untrustworthy — neither Jane (present) nor Bob
      // (absent). A survivor entry (carol) keeps the batch non-hollow, so the
      // pass runs instead of tripping the only-duplicates refusal.
      const report = await sync(
        [
          { ...jane, displayName: 'Jane A' },
          { ...jane, displayName: 'Jane B' },
          {
            email: 'carol@example.com',
            displayName: 'Carol Cook',
            countryCode: null,
            roleNames: [AppRoleName.Employee],
          },
        ],
        { occurredAt: T2 },
      )

      // Raw directory casing, same convention as every other report list.
      expect(report.duplicateEmails).toEqual(['Jane.Doe@example.com'])
      expect(report.deactivated).toEqual([])
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      // Neither ambiguous entry was applied, and Jane stayed active.
      expect(row.displayName).toBe('Jane Doe')
      expect(row.active).toBe(true)
      const bobRow = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
      expect(bobRow.active).toBe(true)
    })

    it('refuses an empty batch loudly instead of reporting a silent no-op', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane], { occurredAt: T1 })

      await expect(
        service.syncUsersFromDirectory([], {
          fetchedAt: T2,
          staleAccessMembers: [],
        }),
      ).rejects.toThrow(LeaveDomainValidationError)
      // A batch hollowed out to nothing by the dedupe is the same hazard.
      await expect(
        service.syncUsersFromDirectory(
          [
            { ...jane, displayName: 'Jane A' },
            { ...jane, displayName: 'Jane B' },
          ],
          { fetchedAt: T2, staleAccessMembers: [] },
        ),
      ).rejects.toThrow(/only duplicated addresses/)

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      expect(row.active).toBe(true)
    })

    it('withholds deactivation when entries were skipped, but still upserts', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })

      // Bob's entry became unreadable (mapper skip): his absence must NOT
      // deactivate him, and the skip reasons surface in report + summary.
      const report = await sync([{ ...jane, displayName: 'Jane Renamed' }], {
        occurredAt: T2,
        skipped: ['entry "uid=bob" has no mail attribute'],
      })

      expect(report.deactivated).toEqual([])
      expect(report.updated).toEqual(['Jane.Doe@example.com'])
      expect(report.skipped).toEqual(['entry "uid=bob" has no mail attribute'])
      // The report states the decision itself, so a reader never has to infer
      // it from the lists — and cannot drift from the rule that made it.
      expect(report.deactivationWithheld).toBe(true)
      const bobRow = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'bob@example.com' })
      expect(bobRow.active).toBe(true)

      // The withholding is a STRUCTURED flag on the newest summary entry —
      // the consecutive-withheld counter reads it from the audit log — and
      // the skip reasons ride along for the admin.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const summaries = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncCompleted,
      })
      expect(summaries.items[0]?.after?.['deactivationWithheld']).toBe(true)
      expect(summaries.items[0]?.after?.['skipped']).toEqual([
        'entry "uid=bob" has no mail attribute',
      ])
    })

    it('echoes caller warnings into the report and the audit summary', async () => {
      await service.updateLeaveSettings(makeSettings())

      const report = await sync([jane], {
        occurredAt: T1,
        warnings: ["country code 'Germany' is not a known ISO 3166-1 alpha-2 country — stored as null"],
      })

      expect(report.warnings).toEqual([
        "country code 'Germany' is not a known ISO 3166-1 alpha-2 country — stored as null",
      ])
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const summaries = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncCompleted,
      })
      expect(summaries.items[0]?.after?.['warnings']).toEqual([
        "country code 'Germany' is not a known ISO 3166-1 alpha-2 country — stored as null",
      ])
    })

    it('never deactivates a row created at or after the directory fetch', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane], { occurredAt: T1 })
      // Bob's first SSO login lands while a pass (whose LDAP snapshot
      // predates him) is running.
      await service.findOrCreateUserFromIdentity({
        subject: 'oidc-bob',
        email: 'bob@example.com',
        displayName: 'Bob Brown',
        roles: [AppRoleName.Employee],
        occurredAt: T2,
      })

      // Pass fetched BEFORE Bob existed: his absence is not a departure.
      const stale = await sync([jane], { occurredAt: T3, fetchedAt: T2 })
      expect(stale.deactivated).toEqual([])

      // A later pass whose fetch postdates him treats absence as real.
      const fresh = await sync([jane], {
        occurredAt: '2026-01-04T00:00:00.000Z',
        fetchedAt: T3,
      })
      expect(fresh.deactivated).toEqual(['bob@example.com'])
    })

    it('does not bump updatedAt for users the directory reports unchanged', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane], { occurredAt: T1 })
      const before = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })

      await sync([jane], { occurredAt: T2 })

      const after = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      // The row was not rewritten: updatedAt stays a real change signal.
      expect(after.updatedAt).toEqual(before.updatedAt)
    })

    it('keeps the stored email spelling when only the casing differs', async () => {
      await service.updateLeaveSettings(makeSettings())
      // First login provisions the row (subject linked immediately, so later
      // logins differ ONLY in casing — subject is a snapshotted field and
      // linking it would legitimately count as a profile change).
      await service.findOrCreateUserFromIdentity({
        subject: 'oidc-jane',
        email: 'Jane.Doe@example.com',
        displayName: 'Jane Doe',
        roles: [AppRoleName.Employee],
        occurredAt: T1,
      })

      // The IdP presents the lowercase form of the same address next time:
      // the column must not ping-pong between the two spellings (each flip
      // would be a spurious audit row on every login/sync cycle).
      await service.findOrCreateUserFromIdentity({
        subject: 'oidc-jane',
        email: 'jane.doe@example.com',
        displayName: 'Jane Doe',
        roles: [AppRoleName.Employee],
        occurredAt: T2,
      })

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ normalizedEmail: 'jane.doe@example.com' })
      expect(row.email).toBe('Jane.Doe@example.com')
      // And the relogin produced no profile-sync audit noise.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const synced = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.UserProfileSynced,
      })
      expect(synced.items).toEqual([])
    })

    it('writes one summary audit row per pass', async () => {
      await service.updateLeaveSettings(makeSettings())
      await sync([jane, bob], { occurredAt: T1 })

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const summaries = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncCompleted,
      })
      expect(summaries.items).toHaveLength(1)
      expect(summaries.items[0]?.after?.['created']).toEqual(
        expect.arrayContaining(['Jane.Doe@example.com', 'bob@example.com']),
      )
      // A complete batch records the flag as false, so consecutive-withheld
      // counting can distinguish "clean pass" from "withheld pass".
      expect(summaries.items[0]?.after?.['deactivationWithheld']).toBe(false)
    })

    it('records a crashed pass as an out-of-transaction ldap_sync.failed row', async () => {
      // No work transaction is opened here: a real failure would have rolled
      // the work back, and the point of this writer is that the trace survives
      // that rollback because it runs on the non-transactional manager.
      // A bind a directory refuses without a diagnostic string: the driver's
      // whole message is the hex result code, which is why the row cannot be
      // left to carry only that.
      await service.recordDirectorySyncFailed({
        error: 'Code: 0x31',
        summary:
          'The directory server refused the account this app signs in with. Its password or DN needs updating.',
        occurredAt: T1,
      })

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const failed = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncFailed,
      })
      expect(failed.items).toHaveLength(1)
      expect(failed.items[0]?.category).toBe(AuditCategory.LdapSync)
      expect(failed.items[0]?.actorLabel).toBe('LDAP sync')
      expect(failed.items[0]?.summary).toContain(
        'refused the account this app signs in with',
      )
      expect(failed.items[0]?.summary).not.toContain('0x31')
      expect(failed.items[0]?.after?.['reason']).toBe('error')
      // The raw text is kept, just not as the whole account of the failure.
      expect(failed.items[0]?.after?.['error']).toBe('Code: 0x31')
    })

    it('records an empty directory read as ldap_sync.failed, not a completion', async () => {
      await service.recordDirectorySyncEmpty({
        entriesRead: 5,
        skipped: ['entry "uid=bob" has no mail attribute'],
        staleAccessMembers: ['uid=gone,ou=Users,dc=example,dc=com'],
        nonMembers: 2,
        occurredAt: T1,
      })

      const auditLog = new AuditLogService(dataSource, new ClockService())
      const failed = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncFailed,
      })
      expect(failed.items).toHaveLength(1)
      expect(failed.items[0]?.after?.['reason']).toBe('empty-directory')
      expect(failed.items[0]?.after?.['entriesRead']).toBe(5)
      expect(failed.items[0]?.after?.['skipped']).toEqual([
        'entry "uid=bob" has no mail attribute',
      ])
      // The stale DNs must be readable off this row: the orchestrator's
      // warning points an admin at the audit trail for the full list, and an
      // empty pass writes no other row to carry it.
      expect(failed.items[0]?.after?.['staleAccessMembers']).toEqual([
        'uid=gone,ou=Users,dc=example,dc=com',
      ])
      expect(failed.items[0]?.after?.['nonMembers']).toBe(2)
      expect(failed.items[0]?.summary).toContain('1 stale group member')
      // Modeled as a failure, NOT a completion: a broken filter returning
      // nothing must never read as a healthy pass in the sync-health query.
      const completed = await auditLog.getAdminAuditLogs({
        eventType: AuditEventType.LdapSyncCompleted,
      })
      expect(completed.items).toEqual([])
    })

    it('files the runs under the directory-sync category and the accounts they touched under their own', async () => {
      await service.updateLeaveSettings(makeSettings())
      // Three passes covering every account event a pass can write: both users
      // provisioned, Bob dropped (deactivated), then Bob listed again while
      // inactive (conflict) beside a renamed Jane (profile synced).
      await sync([jane, bob], { occurredAt: T1 })
      await sync([jane], { occurredAt: T2 })
      await sync([{ ...jane, displayName: 'Jane Renamed' }, bob], {
        occurredAt: T3,
      })

      // One read of the whole trail: the claim is about how the rows DIVIDE
      // between categories, which a query per group could not show.
      const auditLog = new AuditLogService(dataSource, new ClockService())
      const trail = await auditLog.getAdminAuditLogs()
      const categoriesOf = (eventType: AuditEventType) =>
        trail.items
          .filter((item) => item.eventType === eventType)
          .map((item) => item.category)

      // Exactly what a pass alone can produce, and nothing else. Sorted rather
      // than compared in place: the conflict and the third summary share one
      // occurredAt, so their order is not fixed.
      expect(
        trail.items
          .filter((item) => item.category === AuditCategory.LdapSync)
          .map((item) => item.eventType)
          .sort(),
      ).toEqual([
        AuditEventType.LdapSyncCompleted,
        AuditEventType.LdapSyncCompleted,
        AuditEventType.LdapSyncCompleted,
        AuditEventType.UserSyncConflict,
      ])

      // The accounts a pass touches keep their own categories: the login path
      // writes the same provisioning and profile events, and an admin retires
      // an account by hand — the category holds runs, not everything the sync
      // ever did.
      expect(categoriesOf(AuditEventType.UserProvisioned)).toEqual([
        AuditCategory.Auth,
        AuditCategory.Auth,
      ])
      expect(categoriesOf(AuditEventType.UserProfileSynced)).toEqual([
        AuditCategory.Auth,
      ])
      expect(categoriesOf(AuditEventType.UserDeactivated)).toEqual([
        AuditCategory.Employee,
      ])
    })
  })

  it('serves the employee directory as A-to-Z keyset pages with SQL filters and totals', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('dir-anna'),
      email: 'anna@example.com',
      displayName: 'Anna Adams',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('dir-bob'),
      email: 'bob@example.com',
      displayName: 'Bob Brown',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Display name contains LIKE metacharacters on purpose (see search below).
    await service.upsertUser({
      userId: testUuid('dir-cara'),
      email: 'cara@example.com',
      displayName: 'Cara 100% Effort',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.assignUserRoles({
      userId: testUuid('dir-bob'),
      roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
    })

    // Page 1 of 2: alphabetical, cursor to continue, directory-wide totals.
    const page1 = await service.getAdminEmployeeList({ limit: 2 })
    expect(page1.items.map((item) => item.displayName)).toEqual([
      'Anna Adams',
      'Bob Brown',
    ])
    expect(page1.items[1]?.roleNames).toEqual([
      AppRoleName.Administrator,
      AppRoleName.Employee,
    ])
    // Each row carries its active status (drives the Inactive badge and the
    // deactivate/reactivate control); all seeded users are active here.
    expect(page1.items.every((item) => item.active === true)).toBe(true)
    // profileStatus flows through too: these users were upserted with no country
    // or start date, so the directory flags them as still needing admin setup.
    expect(
      page1.items.every(
        (item) => item.profileStatus === EmployeeProfileStatus.PendingSetup,
      ),
    ).toBe(true)
    expect(page1.totals).toEqual({
      employees: 3,
      administrators: 1,
      accounts: 3,
      pendingReview: 0,
    })
    expect(page1.nextCursor).toBeDefined()

    // Page 2: remainder, no further cursor, totals only on the first page.
    const page2 = await service.getAdminEmployeeList({
      limit: 2,
      cursor: page1.nextCursor,
    })
    expect(page2.items.map((item) => item.displayName)).toEqual([
      'Cara 100% Effort',
    ])
    expect(page2.nextCursor).toBeUndefined()
    expect(page2.totals).toBeUndefined()

    // Role filter narrows in SQL.
    const admins = await service.getAdminEmployeeList({
      roleName: AppRoleName.Administrator,
    })
    expect(admins.items.map((item) => item.displayName)).toEqual(['Bob Brown'])

    // The Employees card counts holders of the employee role, exactly like
    // the Role filter — an admin-only account is listed but not counted.
    await service.upsertUser({
      userId: testUuid('dir-dana'),
      email: 'dana@example.com',
      displayName: 'Dana Admin-Only',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.assignUserRoles({
      userId: testUuid('dir-dana'),
      roleNames: [AppRoleName.Administrator],
    })
    const withAdminOnly = await service.getAdminEmployeeList({ limit: 2 })
    // The account count still includes Dana — an account-level number, which
    // is what the directory-reset tooling quotes.
    expect(withAdminOnly.totals).toEqual({
      employees: 3,
      administrators: 2,
      accounts: 4,
      pendingReview: 0,
    })

    // Deactivation drops an account from the role cards but never from
    // accounts: the role rows stay (reactivation restores them), yet a card
    // answering "how many admins" must not grow with attrition.
    await service.setEmployeeActive({
      userId: testUuid('dir-dana'),
      active: false,
      audit: {
        userId: testUuid('dir-bob'),
        label: 'Bob Brown',
        email: 'bob@example.com',
        roles: [AppRoleName.Administrator],
      },
    })
    const afterRetire = await service.getAdminEmployeeList({ limit: 2 })
    expect(afterRetire.totals).toEqual({
      employees: 3,
      administrators: 1,
      accounts: 4,
      pendingReview: 0,
    })

    // A literal % in the search term matches itself, not everything.
    const literalPercent = await service.getAdminEmployeeList({ search: '0%' })
    expect(literalPercent.items.map((item) => item.displayName)).toEqual([
      'Cara 100% Effort',
    ])

    // Search matches email too, case-insensitively.
    const byEmail = await service.getAdminEmployeeList({ search: 'BOB@' })
    expect(byEmail.items.map((item) => item.displayName)).toEqual(['Bob Brown'])
  })

  describe('setEmployeeActive', () => {
    const actor = {
      userId: testUuid('admin-actor'),
      label: 'Admin Actor',
      email: 'admin@example.com',
      roles: [AppRoleName.Administrator],
    }

    it('flips only the active column and leaves the owned profile fields intact', async () => {
      await service.updateLeaveSettings(makeSettings())
      const seeded = await service.upsertUser({
        userId: testUuid('deact-1'),
        email: 'dept@example.com',
        displayName: 'Dana Part',
        countryCode: 'DE',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      await service.updateEmployeeAdmin({
        userId: seeded.userId,
        employmentStartDate: '2026-02-01',
      })
      // The actor is an app user, so the audit row can reference a real actor
      // via the actorUserId FK (as in prod, where the admin is a synced user).
      await service.upsertUser({
        userId: actor.userId,
        email: actor.email,
        displayName: actor.label,
        createdAt: '2026-01-01T00:00:00.000Z',
      })

      await service.setEmployeeActive({
        userId: seeded.userId,
        active: false,
        audit: actor,
      })

      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: seeded.userId })
      expect(row.active).toBe(false)
      // The deactivate path owns ONLY `active` — every other field the
      // admin/sync own is left exactly as it was.
      expect(row.countryCode).toBe('DE')
      expect(row.employmentStartDate).toBe('2026-02-01')

      const events = await new AuditLogService(
        dataSource,
        new ClockService(),
      ).getAdminAuditLogs({ eventType: AuditEventType.UserDeactivated })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]?.actorLabel).toBe('Admin Actor')
    })

    it('is idempotent: setting the current state writes no audit event', async () => {
      await service.updateLeaveSettings(makeSettings())
      const seeded = await service.upsertUser({
        userId: testUuid('noop-1'),
        email: 'noop@example.com',
        displayName: 'Nora Op',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      // Already active — reactivating is a no-op that must not audit.
      await service.setEmployeeActive({
        userId: seeded.userId,
        active: true,
        audit: actor,
      })

      const events = await new AuditLogService(
        dataSource,
        new ClockService(),
      ).getAdminAuditLogs({ eventType: AuditEventType.UserReactivated })
      expect(events.items).toEqual([])
    })

    it('refuses an admin deactivating their own account (guard lives in the domain)', async () => {
      await service.updateLeaveSettings(makeSettings())
      const self = await service.upsertUser({
        userId: testUuid('self-admin'),
        email: 'self@example.com',
        displayName: 'Self Admin',
        createdAt: '2026-01-01T00:00:00.000Z',
      })

      await expect(
        service.setEmployeeActive({
          userId: self.userId,
          active: false,
          audit: { ...actor, userId: self.userId },
        }),
      ).rejects.toThrow(LeaveDomainValidationError)

      // The row was not touched (the guard runs before the transaction).
      const row = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: self.userId })
      expect(row.active).toBe(true)
    })
  })

  it('narrows the employee directory by project and country in SQL, and projects both onto the rows', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'PL', name: 'Poland' },
        ],
      }),
    )
    await service.upsertUser({
      userId: testUuid('proj-anna'),
      email: 'anna@example.com',
      displayName: 'Anna Adams',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('proj-bob'),
      email: 'bob@example.com',
      displayName: 'Bob Brown',
      countryCode: 'PL',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('proj-cara'),
      email: 'cara@example.com',
      displayName: 'Cara Clark',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.assignUserRoles({
      userId: testUuid('proj-cara'),
      roleNames: [AppRoleName.Employee, AppRoleName.Administrator],
    })
    // Nothing writes projects/memberships yet (they are mirrored from OIDC at
    // login), so the fixture seeds the tables directly.
    await seedProject(dataSource, 'apollo', 'Apollo')
    await seedProject(dataSource, 'zephyr', 'Zephyr')
    await seedMembership(dataSource, 'proj-anna', 'apollo')
    await seedMembership(dataSource, 'proj-cara', 'apollo')
    await seedMembership(dataSource, 'proj-cara', 'zephyr')

    // Every row carries its country and its (name-sorted) projects; a user
    // with no membership gets an empty array, never undefined.
    const all = await service.getAdminEmployeeList()
    expect(
      all.items.map((item) => [
        item.displayName,
        item.countryCode,
        item.projects.map((project) => project.name),
      ]),
    ).toEqual([
      ['Anna Adams', 'UA', ['Apollo']],
      ['Bob Brown', 'PL', []],
      ['Cara Clark', 'UA', ['Apollo', 'Zephyr']],
    ])

    // Project filter narrows in SQL.
    const apollo = await service.getAdminEmployeeList({
      projectId: testProjectId('apollo'),
    })
    expect(apollo.items.map((item) => item.displayName)).toEqual([
      'Anna Adams',
      'Cara Clark',
    ])
    // Directory-wide totals are unaffected by the filters (as with search/role).
    expect(apollo.totals).toEqual({
      employees: 3,
      administrators: 1,
      accounts: 3,
      pendingReview: 0,
    })

    // Country filter narrows in SQL.
    const poland = await service.getAdminEmployeeList({ countryCode: 'PL' })
    expect(poland.items.map((item) => item.displayName)).toEqual(['Bob Brown'])

    // Combined with each other and with the existing search/role filters, all
    // ANDed: Cara is the only Apollo member in UA who is an administrator and
    // matches the search term.
    const combined = await service.getAdminEmployeeList({
      projectId: testProjectId('apollo'),
      countryCode: 'UA',
      roleName: AppRoleName.Administrator,
      search: 'cara@',
    })
    expect(combined.items.map((item) => item.displayName)).toEqual([
      'Cara Clark',
    ])
    // Anna is on Apollo but is not an administrator — the AND must exclude her.
    const apolloAdmins = await service.getAdminEmployeeList({
      projectId: testProjectId('apollo'),
      roleName: AppRoleName.Administrator,
    })
    expect(apolloAdmins.items.map((item) => item.displayName)).toEqual([
      'Cara Clark',
    ])
    // A contradictory combination is empty, not silently widened.
    const empty = await service.getAdminEmployeeList({
      projectId: testProjectId('zephyr'),
      countryCode: 'PL',
    })
    expect(empty.items).toEqual([])

    // The filters live in the WHERE clause, so keyset paging over a filtered
    // population stays whole: page 1 is FULL (not short) and page 2 continues
    // past the cursor instead of skipping rows an in-memory filter would drop.
    const filteredPage1 = await service.getAdminEmployeeList({
      projectId: testProjectId('apollo'),
      limit: 1,
    })
    expect(filteredPage1.items.map((item) => item.displayName)).toEqual([
      'Anna Adams',
    ])
    expect(filteredPage1.nextCursor).toBeDefined()
    const filteredPage2 = await service.getAdminEmployeeList({
      projectId: testProjectId('apollo'),
      limit: 1,
      cursor: filteredPage1.nextCursor,
    })
    expect(filteredPage2.items.map((item) => item.displayName)).toEqual([
      'Cara Clark',
    ])
    expect(filteredPage2.nextCursor).toBeUndefined()

    // Options for the dropdowns: only countries actually in use, all projects.
    const options = await service.getAdminEmployeeFilterOptions()
    expect(options.countries.map((country) => country.code)).toEqual([
      'PL',
      'UA',
    ])
    expect(options.projects.map((project) => project.name)).toEqual([
      'Apollo',
      'Zephyr',
    ])
  })

  it('narrows the employee directory by account status in SQL, keeping filtered pages whole', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'PL', name: 'Poland' },
        ],
      }),
    )
    // The two country-less rows: Anna stays active, Bob is deactivated below,
    // so neither can be reached through the country filter.
    await service.upsertUser({
      userId: testUuid('act-anna'),
      email: 'anna@example.com',
      displayName: 'Anna Adams',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('act-bob'),
      email: 'bob@example.com',
      displayName: 'Bob Brown',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('act-cara'),
      email: 'cara@example.com',
      displayName: 'Cara Clark',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('act-dan'),
      email: 'dan@example.com',
      displayName: 'Dan Drake',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('act-eve'),
      email: 'eve@example.com',
      displayName: 'Eve Ellis',
      countryCode: 'PL',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Deactivated with no audit actor (a system caller), so the population
    // stays exactly these five rows.
    await service.setEmployeeActive({
      userId: testUuid('act-bob'),
      active: false,
    })

    // `false` asks for the deactivated accounts — it is a filter, not the
    // absence of one.
    const inactive = await service.getAdminEmployeeList({ active: false })
    expect(inactive.items.map((item) => item.displayName)).toEqual([
      'Bob Brown',
    ])
    // Directory-wide totals stay directory-wide under the new filter too —
    // and the role cards count only ACTIVE holders, so deactivated Bob is in
    // accounts but not in employees.
    expect(inactive.totals).toEqual({
      employees: 4,
      administrators: 0,
      accounts: 5,
      pendingReview: 0,
    })
    const active = await service.getAdminEmployeeList({ active: true })
    expect(active.items.map((item) => item.displayName)).toEqual([
      'Anna Adams',
      'Cara Clark',
      'Dan Drake',
      'Eve Ellis',
    ])

    // The new filter ANDs with the existing ones.
    const activeInUkraine = await service.getAdminEmployeeList({
      active: true,
      countryCode: 'UA',
    })
    expect(activeInUkraine.items.map((item) => item.displayName)).toEqual([
      'Cara Clark',
      'Dan Drake',
    ])
    // A contradictory combination is empty, not silently widened: the only
    // deactivated account has no country at all.
    const contradiction = await service.getAdminEmployeeList({
      active: false,
      countryCode: 'UA',
    })
    expect(contradiction.items).toEqual([])

    // The filter lives in the WHERE clause, so keyset paging over a filtered
    // population stays whole: page 1 is FULL and page 2 continues past the
    // cursor. Filtering after the page was cut would leave Bob's slot empty
    // here and skip rows on the way.
    const activePage1 = await service.getAdminEmployeeList({
      active: true,
      limit: 2,
    })
    expect(activePage1.items.map((item) => item.displayName)).toEqual([
      'Anna Adams',
      'Cara Clark',
    ])
    expect(activePage1.nextCursor).toBeDefined()
    const activePage2 = await service.getAdminEmployeeList({
      active: true,
      limit: 2,
      cursor: activePage1.nextCursor,
    })
    expect(activePage2.items.map((item) => item.displayName)).toEqual([
      'Dan Drake',
      'Eve Ellis',
    ])
    expect(activePage2.nextCursor).toBeUndefined()
  })

  it('narrows the employee directory by which profile details are missing', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'PL', name: 'Poland' },
        ],
      }),
    )
    // One row per shape the filter names: missing both, missing only the start
    // date, missing only the country, and two complete cards. Every state is
    // held by someone, so a predicate that leaked into its neighbour would move
    // a name between these lists.
    for (const [seed, displayName, countryCode, employmentStartDate] of [
      ['card-anna', 'Anna Adams', undefined, undefined],
      ['card-bob', 'Bob Brown', 'UA', undefined],
      ['card-cara', 'Cara Clark', undefined, '2026-03-10'],
      ['card-dan', 'Dan Drake', 'UA', '2026-03-01'],
      ['card-eve', 'Eve Ellis', 'PL', '2026-04-15'],
    ] as const) {
      await service.upsertUser({
        userId: testUuid(seed),
        email: `${seed}@example.com`,
        displayName,
        countryCode,
        employmentStartDate,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }

    const namesOf = async (
      query: Parameters<typeof service.getAdminEmployeeList>[0],
    ): Promise<string[]> =>
      (await service.getAdminEmployeeList(query)).items.map(
        (item) => item.displayName,
      )

    expect(await namesOf({ profile: EmployeeProfileFilter.MissingAny })).toEqual(
      ['Anna Adams', 'Bob Brown', 'Cara Clark'],
    )
    expect(
      await namesOf({ profile: EmployeeProfileFilter.MissingStartDate }),
    ).toEqual(['Anna Adams', 'Bob Brown'])
    expect(
      await namesOf({ profile: EmployeeProfileFilter.MissingCountry }),
    ).toEqual(['Anna Adams', 'Cara Clark'])
    expect(await namesOf({ profile: EmployeeProfileFilter.Complete })).toEqual([
      'Dan Drake',
      'Eve Ellis',
    ])

    // Complete is the exact complement of MissingAny: together they account for
    // the whole directory and they share nobody. A predicate that drifted would
    // either lose a row from both lists or claim one twice.
    const everyone = await namesOf({})
    expect(
      [
        ...(await namesOf({ profile: EmployeeProfileFilter.MissingAny })),
        ...(await namesOf({ profile: EmployeeProfileFilter.Complete })),
      ].sort(),
    ).toEqual([...everyone].sort())

    // Paging over a filtered population stays whole, exactly as for the other
    // SQL filters. MissingCountry is the case worth paging: its matches are
    // Anna and Cara with Bob sitting between them in the A-to-Z order, so a
    // page cut before the filter ran would spend page 1 on Bob and serve him as
    // nothing.
    const page1 = await service.getAdminEmployeeList({
      profile: EmployeeProfileFilter.MissingCountry,
      limit: 1,
    })
    expect(page1.items.map((item) => item.displayName)).toEqual(['Anna Adams'])
    expect(page1.nextCursor).toBeDefined()
    const page2 = await service.getAdminEmployeeList({
      profile: EmployeeProfileFilter.MissingCountry,
      limit: 1,
      cursor: page1.nextCursor,
    })
    expect(page2.items.map((item) => item.displayName)).toEqual(['Cara Clark'])
    expect(page2.nextCursor).toBeUndefined()
  })

  it('narrows the employee directory by an employment-start range, inclusive at both ends', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Dan sits ON the lower bound used below and Eve ON the upper one, so
    // swapping either comparison for its strict form drops a name.
    for (const [seed, displayName, employmentStartDate] of [
      ['range-ann', 'Ann Undated', undefined],
      ['range-dan', 'Dan Drake', '2026-03-01'],
      ['range-eve', 'Eve Ellis', '2026-03-31'],
      ['range-fay', 'Fay Later', '2026-04-15'],
    ] as const) {
      await service.upsertUser({
        userId: testUuid(seed),
        email: `${seed}@example.com`,
        displayName,
        countryCode: 'UA',
        employmentStartDate,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }

    const march = await service.getAdminEmployeeList({
      employmentStartDateFrom: '2026-03-01',
      employmentStartDateTo: '2026-03-31',
    })
    expect(march.items.map((item) => item.displayName)).toEqual([
      'Dan Drake',
      'Eve Ellis',
    ])

    // Either end alone leaves that side open. This is how "who is still to
    // start" is asked — by naming the day, never by the server reading a clock.
    const fromApril = await service.getAdminEmployeeList({
      employmentStartDateFrom: '2026-04-01',
    })
    expect(fromApril.items.map((item) => item.displayName)).toEqual([
      'Fay Later',
    ])
    const untilMarch = await service.getAdminEmployeeList({
      employmentStartDateTo: '2026-03-31',
    })
    expect(untilMarch.items.map((item) => item.displayName)).toEqual([
      'Dan Drake',
      'Eve Ellis',
    ])

    // An undated row answers neither bound, so it never rides along on a
    // half-open range the way a NULL treated as "unknown, keep it" would.
    expect(
      [...march.items, ...fromApril.items, ...untilMarch.items].map(
        (item) => item.displayName,
      ),
    ).not.toContain('Ann Undated')

    // ...which makes a range asked next to "missing the start date"
    // contradictory. It answers empty — the literal answer, not a widened one.
    const contradiction = await service.getAdminEmployeeList({
      profile: EmployeeProfileFilter.MissingStartDate,
      employmentStartDateFrom: '2026-01-01',
    })
    expect(contradiction.items).toEqual([])

    // Bounds that cross answer empty too, rather than quietly swapping.
    const inverted = await service.getAdminEmployeeList({
      employmentStartDateFrom: '2026-04-01',
      employmentStartDateTo: '2026-03-01',
    })
    expect(inverted.items).toEqual([])
  })

  it('projects the employee detail with the user\'s (name-sorted) project memberships and positions', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('proj-cara'),
      email: 'cara@example.com',
      displayName: 'Cara Clark',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('proj-bob'),
      email: 'bob@example.com',
      displayName: 'Bob Brown',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Memberships are mirrored from OIDC at login, so the fixture seeds them
    // directly (roleOnProject defaults to 'member' in the seed helper).
    await seedProject(dataSource, 'apollo', 'Apollo')
    await seedProject(dataSource, 'zephyr', 'Zephyr')
    // Seeded zephyr-first to prove the detail sorts by project name, not insert
    // order.
    await seedMembership(dataSource, 'proj-cara', 'zephyr')
    await seedMembership(dataSource, 'proj-cara', 'apollo')

    const cara = await service.getAdminEmployeeDetail(testUuid('proj-cara'))
    expect(cara.projects).toEqual([
      { projectId: testProjectId('apollo'), name: 'Apollo', position: 'member' },
      { projectId: testProjectId('zephyr'), name: 'Zephyr', position: 'member' },
    ])

    // A user with no memberships gets an empty array, never undefined.
    const bob = await service.getAdminEmployeeDetail(testUuid('proj-bob'))
    expect(bob.projects).toEqual([])
  })

  it('persists a known country code from identity claims when creating a user', async () => {
    await service.updateLeaveSettings(makeSettings())

    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-country',
      email: 'country@example.com',
      displayName: 'Country User',
      roles: [AppRoleName.Employee],
      countryCode: 'UA',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })

    expect(created.countryCode).toBe('UA')
  })

  it('overwrites the stored country code on a repeat login (LDAP is the source of truth)', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'PL', name: 'Poland' },
        ],
      }),
    )

    await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-move',
      email: 'move@example.com',
      displayName: 'Move User',
      roles: [AppRoleName.Employee],
      countryCode: 'UA',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    const relogged = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-move',
      email: 'move@example.com',
      displayName: 'Move User',
      roles: [AppRoleName.Employee],
      countryCode: 'PL',
      occurredAt: '2026-01-03T00:00:00.000Z',
    })

    expect(relogged.countryCode).toBe('PL')
  })

  it('keeps the stored country code when a repeat login carries no country claim', async () => {
    await service.updateLeaveSettings(makeSettings())

    await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-keep',
      email: 'keep@example.com',
      displayName: 'Keep User',
      roles: [AppRoleName.Employee],
      countryCode: 'UA',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    const relogged = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-subject-keep',
      email: 'keep@example.com',
      displayName: 'Keep User',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-03T00:00:00.000Z',
    })

    expect(relogged.countryCode).toBe('UA')
  })

  it('ignores an unknown country code without failing the login', async () => {
    await service.updateLeaveSettings(makeSettings())
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)

    try {
      const created = await service.findOrCreateUserFromIdentity({
        subject: 'oidc-subject-unknown',
        email: 'unknown@example.com',
        displayName: 'Unknown Country',
        roles: [AppRoleName.Employee],
        countryCode: 'XX',
        occurredAt: '2026-01-02T00:00:00.000Z',
      })
      expect(created.countryCode).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"XX"'),
      )
      // The identity path must NOT auto-create the unknown country either
      // (ensureCountry serves the trusted admin/upsert paths only).
      expect(
        (await service.getLeaveSettings()).countries.map((c) => c.code),
      ).not.toContain('XX')

      // An unknown code on a later login must not wipe a stored value.
      const withCountry = await service.findOrCreateUserFromIdentity({
        subject: 'oidc-subject-unknown',
        email: 'unknown@example.com',
        displayName: 'Unknown Country',
        roles: [AppRoleName.Employee],
        countryCode: 'UA',
        occurredAt: '2026-01-03T00:00:00.000Z',
      })
      expect(withCountry.countryCode).toBe('UA')

      const reloggedUnknown = await service.findOrCreateUserFromIdentity({
        subject: 'oidc-subject-unknown',
        email: 'unknown@example.com',
        displayName: 'Unknown Country',
        roles: [AppRoleName.Employee],
        countryCode: 'XX',
        occurredAt: '2026-01-04T00:00:00.000Z',
      })
      expect(reloggedUnknown.countryCode).toBe('UA')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('resets accrual per leave year instead of deadlocking on January 1', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const user = await service.upsertUser({
      userId: testUuid('rollover-1'),
      email: 'rollover@example.com',
      displayName: 'Rollover User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Accrue the full 2026 allowance (December => the whole 24 days).
    await service.refreshBalances(user.userId, '2026-12-15T00:00:00.000Z')
    // Cross into 2027: the new leave year must accrue afresh, not deadlock.
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')

    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    const accruals = timeline.filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Accrual,
    )
    const accruedIn = (year: string) =>
      accruals
        .filter((entry) => entry.effectiveDate.startsWith(year))
        .reduce((sum, entry) => sum + entry.deltaDays, 0)

    // 2026 reached the full 24-day allocation...
    expect(accruedIn('2026')).toBeCloseTo(24)
    // ...and 2027 started over (January => 24/12 = 2 days), proving the reset.
    expect(accruedIn('2027')).toBeCloseTo(2)
  })

  it('opens the new leave year on the employee calendar, ahead of UTC', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('tz-kyiv'),
      email: 'kyiv@example.com',
      displayName: 'Kyiv Employee',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-12-15T00:00:00.000Z')
    // 22:00 UTC on 31 December is already 00:00 on 1 January in Kyiv. The leave
    // year that opens is the employee's, not the server's: read off UTC this
    // instant would still be December and January's tranche would sit unposted
    // for another two hours.
    await service.refreshBalances(user.userId, '2026-12-31T22:00:00.000Z')

    const accruals = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
    expect(
      accruals
        .filter((entry) => entry.effectiveDate.startsWith('2027'))
        .map((entry) => [entry.effectiveDate, entry.deltaDays]),
    ).toEqual([['2027-01-01', 2]])
  })

  it('holds the old leave year for an employee whose calendar lags UTC', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'US', name: 'United States' },
        ],
      }),
    )
    const user = await service.upsertUser({
      userId: testUuid('tz-ny'),
      email: 'newyork@example.com',
      displayName: 'New York Employee',
      countryCode: 'US',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const accrualsIn = async (year: string) =>
      (await service.getBalanceTimeline(user.userId, LeaveType.Vacation))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .filter((entry) => entry.effectiveDate.startsWith(year))

    await service.refreshBalances(user.userId, '2026-12-15T00:00:00.000Z')
    // The mirror image of the Kyiv case: 01:00 UTC on 1 January is still 20:00
    // on 31 December in New York, so the next year has NOT begun for them.
    await service.refreshBalances(user.userId, '2027-01-01T01:00:00.000Z')
    expect(await accrualsIn('2027')).toEqual([])

    // 06:00 UTC is 01:00 in New York, and now it has.
    await service.refreshBalances(user.userId, '2027-01-01T06:00:00.000Z')
    expect(
      (await accrualsIn('2027')).map((entry) => [
        entry.effectiveDate,
        entry.deltaDays,
      ]),
    ).toEqual([['2027-01-01', 2]])
  })

  it('pins a country to a non-primary zone from its own catalog list', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          {
            code: 'US',
            name: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ],
      }),
    )
    expect(
      (await service.getLeaveSettings()).countries.map((country) => [
        country.code,
        country.timezone,
      ]),
    ).toEqual([['US', 'America/Los_Angeles']])
  })

  it('keeps a pinned zone when a later save says nothing about it', async () => {
    // The regression that mattered: every settings save used to overwrite the
    // stored zone with the catalog default, so saving approvers silently moved
    // a US workspace back from Los Angeles to New York.
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          {
            code: 'US',
            name: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ],
      }),
    )
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'US', name: 'United States' }] }),
    )
    expect(
      (await service.getLeaveSettings()).countries.map(
        (country) => country.timezone,
      ),
    ).toEqual(['America/Los_Angeles'])
  })

  it('seeds a country with no submitted zone from the catalog primary', async () => {
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'CA', name: 'Canada' }] }),
    )
    const [country] = (await service.getLeaveSettings()).countries
    expect(country.timezone).toBe(lookupCountry('CA')?.timezone)
  })

  it('refuses a zone the country does not have, and rolls the save back', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        defaultVacationDays: 21,
        countries: [{ code: 'US', name: 'United States' }],
      }),
    )
    await expect(
      service.updateLeaveSettings(
        makeSettings({
          defaultVacationDays: 30,
          countries: [
            { code: 'US', name: 'United States', timezone: 'Europe/Kyiv' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(CountryTimezoneNotAvailableError)

    // The refusal is thrown inside the transaction, so the settings write it
    // travelled with is gone too. A half-applied save would be worse than none.
    const settings = await service.getLeaveSettings()
    expect(settings.defaultVacationDays).toBe(21)
    expect(settings.countries.map((country) => country.timezone)).toEqual([
      lookupCountry('US')?.timezone,
    ])
  })

  it('carries the assignable zones on the refusal', async () => {
    const attempt = service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'US', name: 'United States', timezone: 'Europe/Kyiv' },
        ],
      }),
    )
    await expect(attempt).rejects.toThrow(/Europe\/Kyiv/)
    await attempt.catch((error: unknown) => {
      const refusal = error as CountryTimezoneNotAvailableError
      expect(refusal.countryCode).toBe('US')
      expect(refusal.allowedTimezones).toContain('America/New_York')
      expect(refusal.allowedTimezones).toContain('America/Los_Angeles')
    })
  })

  it('accepts the zone already stored even when the catalog stops listing it', async () => {
    // A future version of the timezone catalog must not lock an admin out of
    // saving settings over a value they never chose to change.
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'PL', name: 'Poland' }] }),
    )
    await dataSource
      .getRepository(CountryEntity)
      .update({ code: 'PL' }, { timezone: 'Europe/Berlin' })

    await service.updateLeaveSettings(
      makeSettings({
        countries: [{ code: 'PL', name: 'Poland', timezone: 'Europe/Berlin' }],
      }),
    )
    expect(
      (await service.getLeaveSettings()).countries.map(
        (country) => country.timezone,
      ),
    ).toEqual(['Europe/Berlin'])

    // The grandfather clause is exactly one value wide: any OTHER unlisted zone
    // is still refused.
    await expect(
      service.updateLeaveSettings(
        makeSettings({
          countries: [{ code: 'PL', name: 'Poland', timezone: 'Europe/Paris' }],
        }),
      ),
    ).rejects.toBeInstanceOf(CountryTimezoneNotAvailableError)
  })

  it('refuses an org default timezone the runtime cannot resolve', async () => {
    await service.updateLeaveSettings(makeSettings({ defaultVacationDays: 21 }))
    await expect(
      service.updateLeaveSettings(
        makeSettings({
          defaultVacationDays: 30,
          defaultTimezone: 'Mars/Olympus',
        }),
      ),
    ).rejects.toBeInstanceOf(DefaultTimezoneNotRecognizedError)

    // Thrown inside the transaction, so the settings write it travelled with is
    // gone too -- the same all-or-nothing the country refusal gets.
    const settings = await service.getLeaveSettings()
    expect(settings.defaultVacationDays).toBe(21)
    expect(settings.defaultTimezone).toBe(DEFAULT_TIMEZONE)
  })

  it('accepts the org default zone already stored, even if unresolvable now', async () => {
    // The lockout this prevents is total: every card on the settings page sends
    // the whole object, so one bad stored zone would block carryover and
    // approver edits too, over a value nobody is touching.
    await service.updateLeaveSettings(makeSettings())
    await dataSource
      .getRepository(LeaveSettingsEntity)
      .update(
        { id: SETTINGS_SINGLETON_ID },
        { defaultTimezone: 'Mars/Olympus' },
      )

    await service.updateLeaveSettings(
      makeSettings({ defaultVacationDays: 30, defaultTimezone: 'Mars/Olympus' }),
    )
    expect((await service.getLeaveSettings()).defaultVacationDays).toBe(30)

    // One value wide: any OTHER unresolvable zone is still refused.
    await expect(
      service.updateLeaveSettings(
        makeSettings({ defaultTimezone: 'Mars/Pavonis' }),
      ),
    ).rejects.toBeInstanceOf(DefaultTimezoneNotRecognizedError)
  })

  it('leaves the org default zone alone when the payload omits it', async () => {
    await service.updateLeaveSettings(
      makeSettings({ defaultTimezone: 'Europe/Warsaw' }),
    )
    // Absent must not read as "reset to Kyiv": every card sends the whole
    // object, so that would move everyone's midnight from an unrelated save.
    await service.updateLeaveSettings(makeSettings({ defaultVacationDays: 30 }))
    expect((await service.getLeaveSettings()).defaultTimezone).toBe(
      'Europe/Warsaw',
    )
  })

  it('does not audit a settings save that changed nothing', async () => {
    // Every card on the settings page posts the whole object, so pressing Save
    // on an untouched card used to append a row whose before and after were
    // byte-identical, and the console rendered it as a page of edits.
    await service.updateLeaveSettings(makeSettings())
    await service.updateLeaveSettings(makeSettings())

    const auditLog = new AuditLogService(dataSource, new ClockService())
    const rows = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.SettingsUpdated,
    })
    expect(rows.items).toHaveLength(1)
  })

  it('audits the org default timezone', async () => {
    // It was missing from the snapshot, so changing it produced an audit row
    // whose before and after matched. Suppressing no-op rows without closing
    // that hole would have turned it into no row at all.
    await service.updateLeaveSettings(makeSettings())
    await service.updateLeaveSettings({
      ...makeSettings(),
      defaultTimezone: 'Europe/Warsaw',
    })

    const auditLog = new AuditLogService(dataSource, new ClockService())
    const rows = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.SettingsUpdated,
    })
    const changed = (rows.items[0]?.changedFields ?? []).map((row) => row.field)
    expect(changed).toContain('defaultTimezone')
  })

  it('audits a country zone change once, and an unchanged country never', async () => {
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'US', name: 'United States' }] }),
    )
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          {
            code: 'US',
            name: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ],
      }),
    )
    // Saved again with nothing about the zone: nothing changed, so nothing is
    // audited. The old code compared the stored value against the catalog
    // default and logged an identical before/after row on every save.
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'US', name: 'United States' }] }),
    )

    const auditLog = new AuditLogService(dataSource, new ClockService())
    const updates = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.CountryUpdated,
    })
    expect(
      updates.items.map((item) => [
        item.before?.['timezone'],
        item.after?.['timezone'],
      ]),
    ).toEqual([['America/New_York', 'America/Los_Angeles']])
  })

  it('accrues on the pinned office zone, not the country catalog default', async () => {
    // The load-bearing case for country timezones. A US workspace running out
    // of Los Angeles must not roll the leave year over on New York's clock.
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          {
            code: 'US',
            name: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ],
      }),
    )
    const user = await service.upsertUser({
      userId: testUuid('tz-la'),
      email: 'losangeles@example.com',
      displayName: 'Los Angeles Employee',
      countryCode: 'US',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const accrualsIn = async (year: string) =>
      (await service.getBalanceTimeline(user.userId, LeaveType.Vacation))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .filter((entry) => entry.effectiveDate.startsWith(year))

    await service.refreshBalances(user.userId, '2026-12-15T00:00:00.000Z')
    // 06:00 UTC on 1 January is 22:00 on 31 December in Los Angeles. Under the
    // catalog default (New York) this same instant is 01:00 and WOULD accrue,
    // so this assertion is what proves the pin survived the save.
    await service.refreshBalances(user.userId, '2027-01-01T06:00:00.000Z')
    expect(await accrualsIn('2027')).toEqual([])

    // 08:00 UTC is midnight in Los Angeles, and now the year has turned.
    await service.refreshBalances(user.userId, '2027-01-01T08:00:00.000Z')
    expect(
      (await accrualsIn('2027')).map((entry) => [
        entry.effectiveDate,
        entry.deltaDays,
      ]),
    ).toEqual([['2027-01-01', 2]])
  })

  it('posts one dated accrual per month owed when an account catches up late', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Hired in January, entered into the system in May: five months are owed at
    // once. They must read as five monthly tranches on the 1st of each month,
    // not as a single lump dated to the day someone got around to it.
    const user = await service.upsertUser({
      userId: testUuid('catch-up-accrual'),
      email: 'late@example.com',
      displayName: 'Late Entry',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-05-20T09:00:00.000Z',
    })

    const accruals = async () =>
      (await service.getBalanceTimeline(user.userId, LeaveType.Vacation))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .map((entry) => [entry.effectiveDate, entry.deltaDays])

    expect(await accruals()).toEqual([
      ['2026-01-01', 2],
      ['2026-02-01', 2],
      ['2026-03-01', 2],
      ['2026-04-01', 2],
      ['2026-05-01', 2],
    ])
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(10)

    // Idempotent without any high-water mark: the cumulative target already
    // knows every month is covered, so a second read writes nothing.
    await service.refreshBalances(user.userId, '2026-05-20T18:00:00.000Z')
    expect(await accruals()).toHaveLength(5)
  })

  it('grants sick leave as a single tranche dated to the hire month', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('sick-tranche'),
      email: 'sick-tranche@example.com',
      displayName: 'Sick Tranche',
      countryCode: 'UA',
      employmentStartDate: '2026-03-10',
      createdAt: '2026-07-20T09:00:00.000Z',
    })

    // Sick leave is credited up front rather than monthly, so the month loop
    // posts once — dated to the month employment began, not to July. The
    // tranche is prorated by the months of the year still ahead of that month:
    // hired in March, 12 * 10/12 = 10 rather than the full year's 12.
    expect(
      (await service.getBalanceTimeline(user.userId, LeaveType.Sick))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .map((entry) => [entry.effectiveDate, entry.deltaDays]),
    ).toEqual([['2026-03-01', 10]])
  })

  it('carries unused days into the next year (capped) without suppressing accrual', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapDays: 5,
      carryoverCapMode: CarryoverCapMode.Days,
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const user = await service.upsertUser({
      userId: testUuid('carry-1'),
      email: 'carry@example.com',
      displayName: 'Carry User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Accrue all of 2026 (24 days) and take none: 24 unused, capped at 5.
    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')

    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    const accruals = timeline.filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Accrual,
    )
    const accruedIn = (year: string) =>
      accruals
        .filter((entry) => entry.effectiveDate.startsWith(year))
        .reduce((sum, entry) => sum + entry.deltaDays, 0)

    expect(accruedIn('2026')).toBeCloseTo(24)
    // The carryover no longer hides inside January's accrual row: 2027 accrues
    // exactly its own monthly tranche, and the carried days arrive as their own
    // ledger entry. The books say what actually happened.
    expect(accruedIn('2027')).toBeCloseTo(2)

    // The year close, double-entry: 5 leave 2026 for 2027, 19 burn under the
    // cap, 5 arrive in 2027 — and the burnt days name the cap as the cause.
    const closeRows = timeline
      .filter((entry) =>
        [
          LeaveBalanceChangeReason.CarryoverOut,
          LeaveBalanceChangeReason.Expired,
          LeaveBalanceChangeReason.CarryoverIn,
        ].includes(entry.reason),
      )
      .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays])
    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 5],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 19],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 5],
    ])
    expect(
      timeline.find(
        (entry) => entry.reason === LeaveBalanceChangeReason.Expired,
      )?.note,
    ).toContain('5-day carryover cap')

    // The running snapshots agree with the rows: after the close the 2026 side
    // stands at zero available (all 24 left the year), and 2027's January
    // accrual lands on top of the carried 5 for 7 available.
    const snapshotOf = (reason: LeaveBalanceChangeReason) =>
      timeline.find((entry) => entry.reason === reason)?.availableDays
    expect(snapshotOf(LeaveBalanceChangeReason.Expired)).toBeCloseTo(0)
    expect(
      timeline
        .filter((entry) => entry.effectiveDate.startsWith('2027'))
        .at(-1)?.availableDays,
    ).toBeCloseTo(7)
  })

  // The three carryover cases the percent cap adds, driven the same way as the
  // day-cap test above: accrue a full 2026, take nothing, cross the boundary.
  const seedCarryoverUser = async (
    slug: string,
    settings: {
      defaultVacationDays?: number
      carryoverPolicy: CarryoverPolicy
      carryoverCapDays?: number
      carryoverCapMode?: CarryoverCapMode
      carryoverCapPercent?: number
    },
    // A later hire accrues only part of the year while the allocation's annual
    // figure stays whole, which is the ONLY way the two percent modes disagree:
    // with a full year the leftover IS the allowance and both cap identically.
    employmentStartDate = '2026-01-01',
  ) => {
    await service.updateLeaveSettings(makeSettings(settings))
    const user = await service.upsertUser({
      userId: testUuid(slug),
      email: `${slug}@example.com`,
      displayName: 'Carry User',
      countryCode: 'UA',
      employmentStartDate,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    return {
      user,
      timeline,
      closeRows: timeline
        .filter((entry) =>
          [
            LeaveBalanceChangeReason.CarryoverOut,
            LeaveBalanceChangeReason.Expired,
            LeaveBalanceChangeReason.CarryoverIn,
          ].includes(entry.reason),
        )
        .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays]),
    }
  }

  it('carries a percent of the leftover, floored to whole days', async () => {
    const { timeline, closeRows } = await seedCarryoverUser('carry-pct', {
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })

    // Half of the 24 unused days survive, half burn, and the burnt row names
    // the percentage rather than a day count.
    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 12],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 12],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 12],
    ])
    expect(
      timeline.find(
        (entry) => entry.reason === LeaveBalanceChangeReason.Expired,
      )?.note,
    ).toContain('50% carryover cap')

    // January still accrues exactly its own tranche: the carried days arrived
    // as their own entry, so nothing is counted twice.
    expect(
      timeline
        .filter(
          (entry) =>
            entry.reason === LeaveBalanceChangeReason.Accrual &&
            entry.effectiveDate.startsWith('2027'),
        )
        .map((entry) => entry.deltaDays),
    ).toEqual([2])
  })

  it('floors a fractional percent result instead of rounding it', async () => {
    // 25 unused days at 50% is 12.5. A carried balance is always whole days,
    // so 12 move and the odd half burns with the rest.
    const { closeRows } = await seedCarryoverUser('carry-pct-floor', {
      defaultVacationDays: 25,
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 12],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 13],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 12],
    ])
  })

  it('never rounds a share that is a hair short of a whole day up into one', async () => {
    // The share is floored, and the floor is taken off the share ITSELF: a
    // November hire accrues 20 * 2/12 = 3.333 days, and 30% of that is 0.9999 —
    // short of the whole day the cap would have to grant before anything can
    // carry. Quantizing the share before flooring it (what this used to do)
    // reads 0.9999 as 1.000 and hands over a day the cap never allowed.
    const { closeRows } = await seedCarryoverUser(
      'carry-pct-hair',
      {
        defaultVacationDays: 20,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.Percent,
        carryoverCapPercent: 30,
      },
      '2026-11-01',
    )

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 3.333],
    ])
  })

  it('caps the carryover at a percent of the prorated entitlement, not of the leftover', async () => {
    // The company rule this mode exists for, hire-prorated: a 25-day policy at
    // 50% caps a full-year employee at floor(25 / 2) = 12, but an April hire
    // could only EARN 9/12 of the allowance (18.75 days), so their ceiling is
    // floor(18.75 / 2) = 9 — a share of what their shortened year could grant,
    // never of the whole norm. The leftover (all 18.75, nothing spent) is well
    // clear of it, and the ceiling is what decides.
    const { timeline, closeRows } = await seedCarryoverUser(
      'carry-pct-total',
      {
        defaultVacationDays: 25,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.PercentOfTotal,
        carryoverCapPercent: 50,
      },
      '2026-04-01',
    )

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 9],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 9.75],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 9],
    ])
    // The note must name WHICH 50% burnt the days, and that the base was the
    // shortened hire year: beside the dashboard's whole-norm denominator the
    // plain label would read as a math error.
    expect(
      timeline.find(
        (entry) => entry.reason === LeaveBalanceChangeReason.Expired,
      )?.note,
    ).toContain('50%-of-allowance carryover cap, prorated for the hire year')
  })

  it('prorates the allowance ceiling down to what the hire year could earn', async () => {
    // A ceiling that scales with the entitlement. Hired in October: 3/12 of 25
    // accrued = 6.25 days, so the ceiling is floor(6.25 / 2) = 3, not the 12 a
    // full-year colleague gets — the cap now binds where the un-prorated rule
    // would have waved the whole leftover through.
    const { closeRows } = await seedCarryoverUser(
      'carry-pct-total-under',
      {
        defaultVacationDays: 25,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.PercentOfTotal,
        carryoverCapPercent: 50,
      },
      '2026-10-01',
    )

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 3],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 3.25],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 3],
    ])
  })

  it('counts the hire month into the base only when at least half of it was worked', async () => {
    // The same half-month rule accrual lives by, flowing into the ceiling: a
    // July 17 hire is employed 15 of 31 days, so July counts — 6/12 of 25 is
    // 12.5 earned and the ceiling is floor(12.5 / 2) = 6. Three days later the
    // clock starts in August: 5/12 of 25 is 10.417 and the ceiling drops to 5.
    const early = await seedCarryoverUser(
      'carry-half-month-in',
      {
        defaultVacationDays: 25,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.PercentOfTotal,
        carryoverCapPercent: 50,
      },
      '2026-07-17',
    )
    expect(early.closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 6],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 6.5],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 6],
    ])

    const late = await seedCarryoverUser(
      'carry-half-month-out',
      {
        defaultVacationDays: 25,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.PercentOfTotal,
        carryoverCapPercent: 50,
      },
      '2026-07-20',
    )
    expect(late.closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 5],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 5.417],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 5],
    ])
  })

  it('keeps flooring the prorated ceiling even at a 100 percent cap', async () => {
    // Owner decision: the ceiling is whole days at EVERY percent. An October
    // hire's 6.25-day entitlement at 100% floors to a 6-day ceiling and the
    // quarter day burns; "everything carries" is CarryoverPolicy.Full's job,
    // not percent_of_total at 100.
    const { closeRows } = await seedCarryoverUser(
      'carry-pct-total-hundred',
      {
        defaultVacationDays: 25,
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapMode: CarryoverCapMode.PercentOfTotal,
        carryoverCapPercent: 100,
      },
      '2026-10-01',
    )

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 6],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 0.25],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 6],
    ])
  })

  it('floors the allowance ceiling to whole days', async () => {
    // 25 at 50% is 12.5: the CEILING itself floors to 12 before it is compared
    // with the leftover, so a carried balance is never fractional.
    const { closeRows } = await seedCarryoverUser('carry-pct-total-floor', {
      defaultVacationDays: 25,
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 50,
    })

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 12],
      [LeaveBalanceChangeReason.Expired, '2026-12-31', 13],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 12],
    ])
  })

  it('persists the allowance-percent cap mode through a settings round trip', async () => {
    // The enum reaches the column: the pg type, the validator's allowlist and
    // the read mapping all have to know the new member for this to come back.
    expect(
      await service.updateLeaveSettings(
        makeSettings({
          carryoverPolicy: CarryoverPolicy.Capped,
          carryoverCapMode: CarryoverCapMode.PercentOfTotal,
          carryoverCapPercent: 40,
        }),
      ),
    ).toMatchObject({
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 40,
    })
    expect(await service.getLeaveSettings()).toMatchObject({
      carryoverCapMode: CarryoverCapMode.PercentOfTotal,
      carryoverCapPercent: 40,
    })
  })

  it('keeps the whole leftover when the day cap exceeds it', async () => {
    // The degenerate cap: nothing to burn, so no expiry row is written at all.
    const { closeRows } = await seedCarryoverUser('carry-cap-wide', {
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Days,
      carryoverCapDays: 30,
    })

    expect(closeRows).toEqual([
      [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 24],
      [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 24],
    ])
  })

  it('defaults to the capped 50 percent company policy', async () => {
    // No settings row at all: the fallback an untouched install runs on.
    expect(await service.getLeaveSettings()).toMatchObject({
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })

    // A save that omits the carryover fields resolves to the same policy, and
    // the audit trail records the cap mode rather than dropping it silently.
    const saved = await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(saved).toMatchObject({
      carryoverPolicy: CarryoverPolicy.Capped,
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })
    const auditLog = new AuditLogService(dataSource, new ClockService())
    const settingsAudit = await auditLog.getAdminAuditLogs({
      eventType: AuditEventType.SettingsUpdated,
    })
    expect(settingsAudit.items[0]?.after).toMatchObject({
      carryoverCapMode: CarryoverCapMode.Percent,
      carryoverCapPercent: 50,
    })
  })

  it('prorates accrual for a mid-year joiner from the employment start date', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // Joins on July 1: only Jul..Dec (6 of 12 months) should accrue by year end.
    const user = await service.upsertUser({
      userId: testUuid('joiner-1'),
      email: 'joiner@example.com',
      displayName: 'July Joiner',
      countryCode: 'UA',
      employmentStartDate: '2026-07-01',
      createdAt: '2026-07-01T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-12-20T00:00:00.000Z')

    const accrued = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    )
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
      .reduce((sum, entry) => sum + entry.deltaDays, 0)
    // 24 * 6/12 = 12, not the full 24 a January employee would have.
    expect(accrued).toBeCloseTo(12)
  })

  // The half-month rule: the hire month counts only when the employee was
  // there for at least half of it, floor(days in month / 2) days counted from
  // the start date to the month's end. Each case is pinned by the month the
  // FIRST accrual is dated to, which is the effective hire month itself.
  const firstAccrualMonth = async (
    startDate: string,
    asOfIso: string,
    slug: string,
  ): Promise<string | undefined> => {
    const user = await service.upsertUser({
      userId: testUuid(slug),
      email: `${slug}@example.com`,
      displayName: 'Half Month Case',
      countryCode: 'UA',
      employmentStartDate: startDate,
      createdAt: `${startDate}T00:00:00.000Z`,
    })
    await service.refreshBalances(user.userId, asOfIso)
    return (await service.getBalanceTimeline(user.userId, LeaveType.Vacation))
      .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
      .map((entry) => entry.effectiveDate)
      .sort()[0]
  }

  it('counts the hire month only when half of it was worked, month length included', async () => {
    await service.updateLeaveSettings(makeSettings())

    // 31-day month, threshold 15: the 17th leaves exactly 15 days, the 18th
    // one fewer.
    expect(
      await firstAccrualMonth(
        '2026-01-17',
        '2026-03-31T12:00:00.000Z',
        'half-jan-17',
      ),
    ).toBe('2026-01-01')
    expect(
      await firstAccrualMonth(
        '2026-01-18',
        '2026-03-31T12:00:00.000Z',
        'half-jan-18',
      ),
    ).toBe('2026-02-01')

    // 30-day month, threshold 15: the boundary moves a day earlier.
    expect(
      await firstAccrualMonth(
        '2026-04-16',
        '2026-06-30T12:00:00.000Z',
        'half-apr-16',
      ),
    ).toBe('2026-04-01')
    expect(
      await firstAccrualMonth(
        '2026-04-17',
        '2026-06-30T12:00:00.000Z',
        'half-apr-17',
      ),
    ).toBe('2026-05-01')

    // February, 28 days, threshold 14.
    expect(
      await firstAccrualMonth(
        '2026-02-15',
        '2026-04-30T12:00:00.000Z',
        'half-feb-15',
      ),
    ).toBe('2026-02-01')
    expect(
      await firstAccrualMonth(
        '2026-02-16',
        '2026-04-30T12:00:00.000Z',
        'half-feb-16',
      ),
    ).toBe('2026-03-01')

    // Leap February, 29 days: the threshold stays 14 (floor of 14.5), so the
    // extra day shifts the boundary rather than the threshold.
    expect(
      await firstAccrualMonth(
        '2028-02-16',
        '2028-04-30T12:00:00.000Z',
        'half-feb-16-leap',
      ),
    ).toBe('2028-02-01')
    expect(
      await firstAccrualMonth(
        '2028-02-17',
        '2028-04-30T12:00:00.000Z',
        'half-feb-17-leap',
      ),
    ).toBe('2028-03-01')
  })

  it('accrues nothing in the hire year for a late-December start and opens fully in January', async () => {
    await service.updateLeaveSettings(makeSettings())
    // December 20 leaves 12 of the month's 31 days, under the threshold of 15,
    // so the effective hire month falls past December: this year owes nothing.
    const user = await service.upsertUser({
      userId: testUuid('late-dec'),
      email: 'late-dec@example.com',
      displayName: 'Late December Joiner',
      countryCode: 'UA',
      employmentStartDate: '2026-12-20',
      createdAt: '2026-12-20T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-12-31T12:00:00.000Z')
    // The new year starts them as a full-year employee: one month of vacation
    // and the whole sick allowance, both anchored to January. Read off the
    // timeline rather than getBalance, which answers for the year the wall
    // clock is in.
    await service.refreshBalances(user.userId, '2027-01-15T12:00:00.000Z')

    const accrualsFor = async (leaveType: LeaveType, year: string) =>
      (await service.getBalanceTimeline(user.userId, leaveType))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .filter((entry) => entry.effectiveDate.startsWith(year))
        .reduce((sum, entry) => sum + entry.deltaDays, 0)

    expect(await accrualsFor(LeaveType.Vacation, '2026')).toBeCloseTo(0)
    expect(await accrualsFor(LeaveType.Sick, '2026')).toBeCloseTo(0)
    expect(await accrualsFor(LeaveType.Vacation, '2027')).toBeCloseTo(2)
    expect(await accrualsFor(LeaveType.Sick, '2027')).toBeCloseTo(12)
  })

  it('prorates the sick tranche by the months of the year left at the hire month', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 5,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const user = await service.upsertUser({
      userId: testUuid('sick-prorated'),
      email: 'sick-prorated@example.com',
      displayName: 'Sick Prorated',
      countryCode: 'UA',
      employmentStartDate: '2026-07-01',
      createdAt: '2026-07-01T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-08-15T12:00:00.000Z')

    // Half a year of employment carries half the annual sick allowance:
    // 5 * 6/12 = 2.5, still credited up front and dated to the hire month.
    expect(
      (await service.getBalanceTimeline(user.userId, LeaveType.Sick))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .map((entry) => [entry.effectiveDate, entry.deltaDays]),
    ).toEqual([['2026-07-01', 2.5]])
    expect(await service.getBalance(user.userId, LeaveType.Sick)).toMatchObject({
      accruedDays: 2.5,
      availableDays: 2.5,
    })
  })

  it('leaves a late-month joiner with nothing to spend until the next month opens', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    // Hired on the 20th of a 31-day month: under the half-month rule nothing
    // accrues until August 1, so leave taken in that window is fully unpaid.
    const user = await service.upsertUser({
      userId: testUuid('stub-window'),
      email: 'stub-window@example.com',
      displayName: 'Stub Window',
      countryCode: 'UA',
      employmentStartDate: '2026-07-20',
      createdAt: '2026-07-20T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-29',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    expect(request).toMatchObject({
      requestedDays: 3,
      paidDays: 0,
      unpaidDays: 3,
    })
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(0)
  })

  it('joins a still-pending approver display name from the user record', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('init-req'),
      email: 'init-req@example.com',
      displayName: 'Req Uester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // The approver is a real app user who has cast no decision yet: submit never
    // snapshots a name onto the approver row, so it must be joined from users.
    await service.upsertUser({
      userId: testUuid('init-approver'),
      email: 'mark.white@example.com',
      displayName: 'Mark White',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
      approverEmails: ['mark.white@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    const detail = await service.getLeaveRequestDetail(request.requestId)
    const approver = detail.approvers.find(
      (row) => row.email === 'mark.white@example.com',
    )
    expect(approver?.decision).toBe(ApproverDecision.Pending)
    expect(approver?.displayName).toBe('Mark White')
  })

  it('leaves an approver with no user record nameless for the address fallback', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('init-nouser-req'),
      email: 'init-nouser-req@example.com',
      displayName: 'Req Uester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
      approverEmails: ['nouser@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    const detail = await service.getLeaveRequestDetail(request.requestId)
    const approver = detail.approvers.find(
      (row) => row.email === 'nouser@example.com',
    )
    expect(approver).toBeDefined()
    expect(approver?.displayName).toBeUndefined()
  })

  it('keeps the name a decided approver signed with and names their pending co-approver from the current record', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('init-signed-req'),
      email: 'init-signed-req@example.com',
      displayName: 'Req Uester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const decider = await service.upsertUser({
      userId: testUuid('init-signed-decider'),
      email: 'signed@example.com',
      displayName: 'Mark White',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('init-signed-waiting'),
      email: 'waiting@example.com',
      displayName: 'Old Name',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
      approverEmails: ['signed@example.com', 'waiting@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    // One of the two signs off; the gate needs both, so the other stays pending.
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: decider.userId,
      actorDisplayName: 'Mark White',
      actorEmail: 'signed@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-07-22T09:00:00.000Z',
    })

    // Both accounts are renamed after the vote was cast.
    await service.upsertUser({
      userId: testUuid('init-signed-decider'),
      email: 'signed@example.com',
      displayName: 'Mark Black',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('init-signed-waiting'),
      email: 'waiting@example.com',
      displayName: 'New Name',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const detail = await service.getLeaveRequestDetail(request.requestId)
    const decided = detail.approvers.find(
      (row) => row.email === 'signed@example.com',
    )
    const pending = detail.approvers.find(
      (row) => row.email === 'waiting@example.com',
    )
    expect(detail.status).toBe(LeaveRequestStatus.Pending)
    expect(decided?.decision).toBe(ApproverDecision.Approved)
    expect(decided?.displayName).toBe('Mark White')
    expect(pending?.decision).toBe(ApproverDecision.Pending)
    expect(pending?.displayName).toBe('New Name')
  })

  it('names a decider whose vote recorded their address instead of a name', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('init-addr-req'),
      email: 'init-addr-req@example.com',
      displayName: 'Req Uester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const decider = await service.upsertUser({
      userId: testUuid('init-addr-decider'),
      email: 'addr@example.com',
      displayName: 'Ann Green',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
      approverEmails: ['addr@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    // A sign-in carrying no name decides as its own address, which is not a
    // name to render: the row must fall back to the account's name. The address
    // arrives in the spelling the token used, not the normalized one the row
    // was stored under.
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: decider.userId,
      actorDisplayName: 'Addr@Example.com',
      actorEmail: 'Addr@Example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-07-22T09:00:00.000Z',
    })

    const detail = await service.getLeaveRequestDetail(request.requestId)
    const approver = detail.approvers.find(
      (row) => row.email === 'addr@example.com',
    )
    expect(approver?.decision).toBe(ApproverDecision.Approved)
    expect(approver?.displayName).toBe('Ann Green')
  })

  it('names a decider whose vote recorded a blank name', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('init-blank-req'),
      email: 'init-blank-req@example.com',
      displayName: 'Req Uester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const decider = await service.upsertUser({
      userId: testUuid('init-blank-decider'),
      email: 'blank@example.com',
      displayName: 'Bea Blank',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
      approverEmails: ['blank@example.com'],
      ccEmails: [],
      submittedAt: '2026-07-21T09:00:00.000Z',
    })

    // Whitespace is not a name either — an empty name claim reaches the vote as
    // it stands, and the row has to read as the person it belongs to.
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: decider.userId,
      actorDisplayName: '   ',
      actorEmail: 'blank@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-07-22T09:00:00.000Z',
    })

    const detail = await service.getLeaveRequestDetail(request.requestId)
    const approver = detail.approvers.find(
      (row) => row.email === 'blank@example.com',
    )
    expect(approver?.decision).toBe(ApproverDecision.Approved)
    expect(approver?.displayName).toBe('Bea Blank')
  })

  it('re-anchors the current year accrued balance when the admin changes the start date', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Full-year employee: by December the whole 24-day allocation has accrued.
    const user = await service.upsertUser({
      userId: testUuid('reanchor-1'),
      email: 'reanchor@example.com',
      displayName: 'Re-anchor User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.refreshBalances(user.userId, '2026-12-20T00:00:00.000Z')
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(24)

    // updateEmployeeAdmin has no asOf parameter — it reads the wall clock — so
    // pin it to keep the pro-rata target (and the resulting adjustment)
    // deterministic.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-20T00:00:00.000Z'))
    try {
      await service.updateEmployeeAdmin({
        userId: user.userId,
        employmentStartDate: '2026-07-01',
      })
    } finally {
      vi.useRealTimers()
    }

    // Moving the start date to July halves the year's target to 24 * 6/12 = 12;
    // the accrued balance must follow via an adjustment, not stay stuck at 24.
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(12)
    const adjustments = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
    )
    expect(adjustments).toHaveLength(1)
    expect(adjustments[0].deltaDays).toBeCloseTo(-12)

    // Sick is prorated by hire month too, so the same shift halves it: the
    // up-front tranche of 12 becomes 12 * 6/12 = 6, posted as one adjustment.
    const sickAdjustments = (
      await service.getBalanceTimeline(user.userId, LeaveType.Sick)
    ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Adjustment)
    expect(sickAdjustments).toHaveLength(1)
    expect(sickAdjustments[0].deltaDays).toBeCloseTo(-6)
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).accruedDays,
    ).toBeCloseTo(6)
  })

  it('preserves carryover when an admin changes the annual allocation', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        carryoverPolicy: CarryoverPolicy.Capped,
        carryoverCapDays: 5,
        carryoverCapMode: CarryoverCapMode.Days,
      }),
    )
    const user = await service.upsertUser({
      userId: testUuid('carry-alloc-1'),
      email: 'carry-alloc@example.com',
      displayName: 'Carry Alloc User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Accrue all of 2026 (24 days, none taken) so 2027 starts with the capped
    // 5-day carryover plus January's 24/12 = 2: accrued 7.
    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-20T00:00:00.000Z'))
    try {
      await service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2027,
        totalDays: 12,
      })
    } finally {
      vi.useRealTimers()
    }

    // New target = 12 * 1/12 + 5 carryover = 6, so the adjustment is -1. A
    // target that ignored carryover would post -6 and wipe it, only for the
    // next refresh to accrue it right back — an oscillating ledger.
    const vacation2027 = (
      await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
    ).filter((entry) => entry.effectiveDate.startsWith('2027'))
    const adjustments = vacation2027.filter(
      (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
    )
    expect(adjustments).toHaveLength(1)
    expect(adjustments[0].deltaDays).toBeCloseTo(-1)
    // Pin the ABSOLUTE 2027 balance too: the carryover term cancels out of the
    // delta (-1 holds even with carryover dropped everywhere), so only the
    // resulting accrued figure proves the 5 carried-over days survived.
    expect(
      vacation2027.reduce((sum, entry) => sum + entry.deltaDays, 0),
    ).toBeCloseTo(6)
  })

  it('zeroes the balance for a start date later this year and resumes accrual from the hire month', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Entered with a January start by mistake; by mid-July 7 of 12 months of
    // the 24-day allocation (14 days) plus a full year's sick grant have
    // accrued.
    const user = await service.upsertUser({
      userId: testUuid('future-start-1'),
      email: 'future-start@example.com',
      displayName: 'Future Start User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.refreshBalances(user.userId, '2026-07-14T00:00:00.000Z')
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(14)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))
    try {
      await service.updateEmployeeAdmin({
        userId: user.userId,
        employmentStartDate: '2026-09-01',
      })
    } finally {
      vi.useRealTimers()
    }

    // Not employed yet as of "today": everything accrued under the mistaken
    // January anchor is clawed back to zero for both leave types.
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(0)
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).accruedDays,
    ).toBeCloseTo(0)

    // A submission timed before the start date (the midnight race) is rejected
    // with the actual cause, not a puzzling "insufficient balance".
    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-10-05',
        endDate: '2026-10-06',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-07-20T00:00:00.000Z',
      }),
    ).rejects.toThrow(/employment starts on 2026-09-01/)

    // September arrives: vacation resumes pro-rata from the hire month
    // (1 of 12 months = 2 days) and sick comes back prorated to the four
    // months of the year that are left, 12 * 4/12 = 4.
    await service.refreshBalances(user.userId, '2026-09-30T00:00:00.000Z')
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(2)
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).accruedDays,
    ).toBeCloseTo(4)
  })

  it('refuses a start-date move that would cut the sick tranche below the days already taken', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('sick-guard'),
      email: 'sick-guard@example.com',
      displayName: 'Sick Guard',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('sick-guard-admin'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Five sick days taken and settled in January, against the full-year
    // tranche of 12 a January hire earns.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Sick,
      startDate: '2026-01-12',
      endDate: '2026-01-16',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-01-12T08:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('sick-guard-admin'),
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-01-12T09:00:00.000Z',
    })
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-01-31T23:00:00.000Z',
    })
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).spentDays,
    ).toBeCloseTo(5)

    // Moving the start to October would prorate the tranche down to 12 * 3/12
    // = 3, less than the 5 days already taken. The guard rejects it and the
    // whole edit rolls back rather than leaving a balance in deficit.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))
    try {
      await expect(
        service.updateEmployeeAdmin({
          userId: user.userId,
          employmentStartDate: '2026-10-01',
        }),
      ).rejects.toThrow(/more committed \(held \+ spent\) leave days/i)
    } finally {
      vi.useRealTimers()
    }

    const sick = await service.getBalance(user.userId, LeaveType.Sick)
    expect(sick.accruedDays).toBeCloseTo(12)
    expect(sick.spentDays).toBeCloseTo(5)
    expect((await service.getUser(user.userId)).employmentStartDate).toBe(
      '2026-01-01',
    )
  })

  it('tops up a prior year on the same half-month rule it was accruing on', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    await seedHolidayCalendar(service, { year: 2027 })
    // Hired on September 20: 11 of that month's 30 days, under the threshold
    // of 15, so 2026 accrues from October and owes 3 months.
    const user = await service.upsertUser({
      userId: testUuid('prior-year-topup'),
      email: 'prior-year-topup@example.com',
      displayName: 'Prior Year Topup',
      countryCode: 'UA',
      employmentStartDate: '2026-09-20',
      createdAt: '2026-09-20T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-11-15T12:00:00.000Z')
    // Booking into next year materializes 2027 ahead of time, which is what
    // later sends the carryover walk back to top 2026 up. That top-up must use
    // the same effective hire month the year was accruing on rather than
    // falling back to January.
    await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2027-03-15',
      endDate: '2027-03-16',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-11-16T09:00:00.000Z',
    })
    await service.refreshBalances(user.userId, '2027-02-15T12:00:00.000Z')

    const accrualsFor = async (leaveType: LeaveType, year: string) =>
      (await service.getBalanceTimeline(user.userId, leaveType))
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .filter((entry) => entry.effectiveDate.startsWith(year))
        .reduce((sum, entry) => sum + entry.deltaDays, 0)

    // Vacation 24 * 3/12 = 6, sick 12 * 3/12 = 3, both for Oct..Dec 2026.
    expect(await accrualsFor(LeaveType.Vacation, '2026')).toBeCloseTo(6)
    expect(await accrualsFor(LeaveType.Sick, '2026')).toBeCloseTo(3)
    // 2027 is a full year for them: two months of vacation and all 12 sick.
    expect(await accrualsFor(LeaveType.Vacation, '2027')).toBeCloseTo(4)
    expect(await accrualsFor(LeaveType.Sick, '2027')).toBeCloseTo(12)
  })

  it('accrues nothing and blocks submissions until the start date is set', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Profile card not finished: no employment start date.
    const user = await service.upsertUser({
      userId: testUuid('no-start-1'),
      email: 'no-start@example.com',
      displayName: 'No Start User',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // The start date is required input for the entitlement math — nothing may
    // be guessed, so nothing accrues (vacation OR sick).
    await service.refreshBalances(user.userId, '2026-07-14T00:00:00.000Z')
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBe(0)
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).accruedDays,
    ).toBe(0)

    // Submissions are rejected up front with the actual cause, not a puzzling
    // "insufficient balance".
    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-04',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-07-14T00:00:00.000Z',
      }),
    ).rejects.toThrow(/start date and country must both be set/)

    // Admin completes the card: a FIRST-TIME set is a plain catch-up through
    // the ordinary accrual — one row per month owed, dated to its own 1st,
    // exactly like an account that was set up on day one. No adjustment lump:
    // under a null anchor nothing accrued, so there is nothing to re-anchor.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))
    try {
      await service.updateEmployeeAdmin({
        userId: user.userId,
        employmentStartDate: '2026-01-01',
      })
    } finally {
      vi.useRealTimers()
    }

    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeCloseTo(14)
    expect(
      (await service.getBalance(user.userId, LeaveType.Sick)).accruedDays,
    ).toBeCloseTo(12)
    const vacationEntries = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    expect(
      vacationEntries
        .filter((entry) => entry.reason === LeaveBalanceChangeReason.Accrual)
        .map((entry) => entry.effectiveDate),
    ).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ])
    expect(
      vacationEntries.filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
      ),
    ).toHaveLength(0)
  })

  it('blocks submission until the country is set (part of profile readiness)', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    // Start date present, but no country: the country selects the holiday
    // calendar that decides which requested days are paid, so it is required.
    const user = await service.upsertUser({
      userId: testUuid('no-country-1'),
      email: 'no-country@example.com',
      displayName: 'No Country User',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Accrual is country-independent: the balance still builds in the
    // background, ready to use once the country is filled in.
    await service.refreshBalances(user.userId, '2026-06-01T00:00:00.000Z')
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).accruedDays,
    ).toBeGreaterThan(0)

    // The dashboard reports the profile as not set up, and submission is
    // rejected up front.
    expect(
      (await service.getEmployeeDashboard(user.userId)).profileStatus,
    ).toBe(EmployeeProfileStatus.PendingSetup)
    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-06-01T09:00:00.000Z',
      }),
    ).rejects.toThrow(/start date and country must both be set/)

    // Allocation editing needs only the start-date anchor (its math never uses
    // the country), so the admin may pre-load days before the country is set.
    await service.setEmployeeAllocation({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 30,
    })
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).totalDays,
    ).toBe(30)
  })

  it('rejects submission when no holiday calendar is configured for the request year', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Fully set-up profile, but NO calendar seeded for 2026: an absent calendar
    // is "not configured" (distinct from a deliberately empty one), so the
    // request is refused rather than silently charging holidays as leave.
    const user = await service.upsertUser({
      userId: testUuid('no-calendar-1'),
      email: 'no-calendar@example.com',
      displayName: 'No Calendar User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-06-01T09:00:00.000Z',
      }),
    ).rejects.toThrow(/No holiday calendar is configured for UA 2026/)
    // The dashboard mirrors the same fact so the composer can warn up front.
    expect(
      (await service.getEmployeeDashboard(user.userId)).holidayCalendarYears,
    ).toEqual([])

    // A deliberately empty calendar (confirmed-empty) unblocks the submission.
    await seedHolidayCalendar(service)
    expect(
      (await service.getEmployeeDashboard(user.userId)).holidayCalendarYears,
    ).toEqual([2026])
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-10',
      endDate: '2026-06-11',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-06-01T09:00:00.000Z',
    })
    expect(request.requestedDays).toBe(2)
  })

  it('reports profile readiness on the employee dashboard', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('profile-status-1'),
      email: 'profile-status@example.com',
      displayName: 'Profile Status User',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(
      (await service.getEmployeeDashboard(user.userId)).profileStatus,
    ).toBe(EmployeeProfileStatus.PendingSetup)

    // A set-but-future start date is a distinct state: the card is complete,
    // employment just has not begun (far-future date keeps this stable no
    // matter when the suite runs — the dashboard reads the wall clock).
    await service.upsertUser({
      userId: user.userId,
      email: 'profile-status@example.com',
      displayName: 'Profile Status User',
      countryCode: 'UA',
      employmentStartDate: '2099-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const notStarted = await service.getEmployeeDashboard(user.userId)
    expect(notStarted.profileStatus).toBe(EmployeeProfileStatus.NotStartedYet)
    // The date rides along for display (the notice names it).
    expect(notStarted.employmentStartDate).toBe('2099-01-01')

    await service.upsertUser({
      userId: user.userId,
      email: 'profile-status@example.com',
      displayName: 'Profile Status User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(
      (await service.getEmployeeDashboard(user.userId)).profileStatus,
    ).toBe(EmployeeProfileStatus.Ready)
  })

  it('rejects allocation edits until the start date is set, but allows pre-configuring a future start', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('alloc-guard-1'),
      email: 'alloc-guard@example.com',
      displayName: 'Alloc Guard User',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // No start date: the allocation could not take effect (and for a legacy
    // balance the re-anchor would wipe it), so the edit is rejected outright.
    await expect(
      service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 30,
      }),
    ).rejects.toThrow(/Set the employment start date/)

    // A future-dated employee may be pre-configured: the allocation persists
    // with NO balance side effects (far-future date keeps the status stable
    // no matter when the suite runs — the guard reads the wall clock).
    await service.upsertUser({
      userId: user.userId,
      email: 'alloc-guard@example.com',
      displayName: 'Alloc Guard User',
      countryCode: 'UA',
      employmentStartDate: '2099-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeAllocation({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 30,
    })

    const balance = await service.getBalance(user.userId, LeaveType.Vacation)
    expect(balance.totalDays).toBe(30)
    expect(balance.accruedDays).toBe(0)
    expect(
      (
        await service.getBalanceTimeline(user.userId, LeaveType.Vacation)
      ).filter((entry) => entry.reason === LeaveBalanceChangeReason.Adjustment),
    ).toHaveLength(0)
  })

  it('rejects clearing an already-set employment start date', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('clear-start-1'),
      email: 'clear-start@example.com',
      displayName: 'Clear Start User',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Clearing the anchor would wipe the accrued balance (or trip the
    // committed-days guard) — a wrong date is corrected, never removed.
    await expect(
      service.updateEmployeeAdmin({
        userId: user.userId,
        employmentStartDate: null,
      }),
    ).rejects.toThrow(/cannot be cleared/)

    // An explicit null for a user that never had a date stays a no-op.
    const bare = await service.upsertUser({
      userId: testUuid('clear-start-2'),
      email: 'clear-start-2@example.com',
      displayName: 'Never Set User',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const updated = await service.updateEmployeeAdmin({
      userId: bare.userId,
      employmentStartDate: null,
    })
    expect(updated.employmentStartDate).toBeUndefined()
  })

  it('an admin edit never resurrects a deactivated account and touches only owned columns', async () => {
    await service.updateLeaveSettings(makeSettings())
    // Provision via SSO so subject is linked, then let a directory pass with a
    // different roster deactivate Carol (absent from it).
    const logged = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-carol',
      email: 'carol@example.com',
      displayName: 'Carol',
      countryCode: 'UA',
      roles: [AppRoleName.Employee],
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    await service.syncUsersFromDirectory(
      [
        {
          email: 'someone-else@example.com',
          displayName: 'Someone Else',
          countryCode: null,
          roleNames: [AppRoleName.Employee],
        },
      ],
      {
        occurredAt: '2026-02-01T00:00:00.000Z',
        fetchedAt: '2026-02-01T00:00:00.000Z',
        staleAccessMembers: [],
      },
    )
    const deactivated = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: logged.userId })
    expect(deactivated.active).toBe(false)

    // The admin edits the profile while the account is deactivated.
    await service.updateEmployeeAdmin({
      userId: logged.userId,
      employmentStartDate: '2026-02-01',
    })

    const row = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: logged.userId })
    // The owned column changed...
    expect(row.employmentStartDate).toBe('2026-02-01')
    // ...but `active` is NOT resurrected — the admin path no longer writes it,
    // so with the pessimistic_write lock gone the row still cannot be
    // brought back to life by a stale read. Non-owned identity columns are
    // untouched too.
    expect(row.active).toBe(false)
    expect(row.subject).toBe('oidc-carol')
    expect(row.email).toBe('carol@example.com')
    expect(row.displayName).toBe('Carol')
  })

  it('holds requested days excluding official holidays and weekends, and releases them on rejection', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-01-02', name: 'Observed Holiday' }],
    })

    const user = await service.upsertUser({
      userId: testUuid('user-2'),
      email: 'nina@example.com',
      displayName: 'Nina',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // By January (month 1) one twelfth of the 24-day allowance has accrued.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-01-01',
      endDate: '2026-01-03',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      comment: 'Annual leave',
      submittedAt: '2026-01-01T10:00:00.000Z',
    })

    // 2026-01-01 (Thu) counts; 01-02 (Fri) is the holiday and 01-03 (Sat) is a
    // weekend, so only one working day is held.
    expect(request.requestedDays).toBe(1)
    expect(request.status).toBe(LeaveRequestStatus.Pending)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      // Display available = accrued - spent; the hold shows as onHoldDays, not
      // as a reduction in available.
      availableDays: 2,
      onHoldDays: 1,
      spentDays: 0,
      accruedDays: 2,
    })

    await service.upsertUser({
      userId: testUuid('admin-1'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const rejected = await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('admin-1'),
      actorDisplayName: 'Admin One',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Reject,
      comment: 'Capacity issue',
      decidedAt: '2026-01-01T12:00:00.000Z',
    })

    expect(rejected.status).toBe(LeaveRequestStatus.Rejected)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      availableDays: 2,
      onHoldDays: 0,
      spentDays: 0,
      accruedDays: 2,
    })
  })

  it('moves approved leave from hold to spent only as the leave dates are actually used', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-02-02', name: 'Observed Holiday' }],
    })

    const user = await service.upsertUser({
      userId: testUuid('user-3'),
      email: 'olena@example.com',
      displayName: 'Olena',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-02-01T00:00:00.000Z',
    })

    // Submitting in February accrues the year-to-date allowance (2 months of a
    // 24-day allowance = 4 days) before holding the requested days. The period
    // 02-01..02-04 spans a Sunday (02-01, weekend), the holiday (02-02) and two
    // working days (Tue 02-03, Wed 02-04), so exactly two days are held and each
    // is spent only once its own date is reached.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-02-01',
      endDate: '2026-02-04',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-02-01T08:00:00.000Z',
    })

    await service.upsertUser({
      userId: testUuid('admin-2'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('admin-2'),
      actorDisplayName: 'Admin Two',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-02-01T09:00:00.000Z',
    })

    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-02-03T23:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      // First working day (02-03) reached: accrued 4 - spent 1 = 3 (the
      // remaining held day is not netted here).
      availableDays: 3,
      onHoldDays: 1,
      spentDays: 1,
      accruedDays: 4,
    })

    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-02-04T23:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      availableDays: 2,
      onHoldDays: 0,
      spentDays: 2,
      accruedDays: 4,
    })

    // Read the ledger directly (getBalanceTimeline is side-effect free, unlike
    // the history endpoint which lazily accrues to the current month).
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    expect(
      (await service.getLeaveRequestDetail(request.requestId)).status,
    ).toBe(LeaveRequestStatus.Approved)
    expect(timeline.map((entry) => entry.reason)).toEqual([
      'accrual',
      'accrual',
      'hold',
      'spent',
      'spent',
    ])
    // Two accruals, not one lump: a January hire submitting in February is owed
    // January and February, and each row is dated to the 1st of the month it
    // belongs to rather than to the day the read happened to land on.
    expect(
      timeline
        .filter((entry) => entry.reason === 'accrual')
        .map((entry) => [entry.effectiveDate, entry.deltaDays]),
    ).toEqual([
      ['2026-01-01', 2],
      ['2026-02-01', 2],
    ])
  })

  it('dates each consumed day to the leave day itself on a catch-up reconcile', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('catch-up'),
      email: 'catchup@example.com',
      displayName: 'Catch Up',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })

    // A full Mon-Fri working week (2026-03-02..03-06): five working days, no
    // weekend or holiday inside. By March the 24-day allowance has accrued 6.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T08:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('catch-up-mgr'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('catch-up-mgr'),
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T09:00:00.000Z',
    })

    // A SINGLE reconcile long after every day elapsed must still consume each
    // day, not collapse them onto the reconcile date.
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-03-20T23:00:00.000Z',
    })

    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      availableDays: 1,
      onHoldDays: 0,
      spentDays: 5,
      accruedDays: 6,
    })

    // One 'spent' ledger entry per leave day, each dated to the day itself
    // (effectiveDate), never to the 03-20 reconcile date.
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    const spentDates = timeline
      .filter((entry) => entry.reason === 'spent')
      .map((entry) => entry.effectiveDate)
    expect(spentDates).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ])

    // The activity feed likewise shows one 'consumed' event per day, stamped at
    // the Kyiv midnight that ENDS that day (22:00 UTC in winter) rather than
    // collapsing onto the reconcile instant.
    const consumed = (
      await service.getLeaveRequestDetail(request.requestId)
    ).activity
      .filter((entry) => entry.action === 'consumed')
      .map((entry) => entry.occurredAt)
      .sort()
    expect(consumed).toEqual([
      '2026-03-02T22:00:00.000Z',
      '2026-03-03T22:00:00.000Z',
      '2026-03-04T22:00:00.000Z',
      '2026-03-05T22:00:00.000Z',
      '2026-03-06T22:00:00.000Z',
    ])
  })

  it('files a catch-up in the order it happened, not accruals before spends', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('order'),
      email: 'order@example.com',
      displayName: 'Ledger Order',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Leave at the very end of June, then nobody touches the account until
    // mid-August: one refresh owes two monthly accruals AND two leave days that
    // elapsed before either of them.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-29',
      endDate: '2026-06-30',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-06-01T08:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('order-mgr'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('order-mgr'),
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-06-01T09:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-08-15T00:00:00.000Z')

    // The ledger arrives in insertion order, so this array IS the order the
    // timeline shows. The June days were spent before July was ever credited,
    // and that is where they sit.
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    expect(timeline.map((entry) => [entry.reason, entry.effectiveDate])).toEqual(
      [
        ['accrual', '2026-01-01'],
        ['accrual', '2026-02-01'],
        ['accrual', '2026-03-01'],
        ['accrual', '2026-04-01'],
        ['accrual', '2026-05-01'],
        ['accrual', '2026-06-01'],
        ['hold', '2026-06-29'],
        ['spent', '2026-06-29'],
        ['spent', '2026-06-30'],
        ['accrual', '2026-07-01'],
        ['accrual', '2026-08-01'],
      ],
    )

    // And because the rows were written in that order, the balance frozen on
    // each of them is the balance as it really stood: the June spends know
    // nothing of the July and August accruals that came after.
    // Six months accrued (12 days) less the day just taken, then less the
    // second — not the sixteen days the account only reaches in August.
    const spends = timeline.filter((entry) => entry.reason === 'spent')
    expect(spends.map((entry) => entry.availableDays)).toEqual([11, 10])
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ accruedDays: 16, spentDays: 2, onHoldDays: 0 })
  })

  it('writes nothing on a second refresh inside the same month', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('idem'),
      email: 'idem@example.com',
      displayName: 'Idempotent',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-08-15T00:00:00.000Z')
    const after = await service.getBalanceTimeline(user.userId)
    // Later in the same month, with nothing new elapsed: the catch-up has no
    // boundary left to walk and adds no rows.
    await service.refreshBalances(user.userId, '2026-08-28T00:00:00.000Z')
    expect(await service.getBalanceTimeline(user.userId)).toHaveLength(
      after.length,
    )
  })

  it('drives accrual through the read path via the shiftable clock, up to year-end', async () => {
    // The whole point of the injectable clock: move the server clock and the
    // ordinary dashboard read accrues to that date, with no date argument and no
    // waiting. Uses its own TEST_TOOLING_ENABLED-enabled service on the shared DB.
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    const travelling = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    try {
      await travelling.updateLeaveSettings(makeSettings())
      const user = await travelling.upsertUser({
        userId: testUuid('time-travel'),
        email: 'traveller@example.com',
        displayName: 'Traveller',
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })

      // Mid-July: a plain dashboard read accrues 7/12 of the 24-day allowance.
      clock.setNow('2026-07-15T12:00:00.000Z')
      const dashJul = await travelling.getEmployeeDashboard(user.userId)
      expect(dashJul.generatedAt.slice(0, 10)).toBe('2026-07-15')
      expect(
        dashJul.balances.find((b) => b.leaveType === LeaveType.Vacation)
          ?.accruedDays,
      ).toBe(14)

      // Year-end: the full allocation has accrued.
      clock.setNow('2026-12-31T12:00:00.000Z')
      const dashDec = await travelling.getEmployeeDashboard(user.userId)
      expect(
        dashDec.balances.find((b) => b.leaveType === LeaveType.Vacation)
          ?.accruedDays,
      ).toBe(24)
    } finally {
      delete process.env['TEST_TOOLING_ENABLED']
    }
  })

  it('applies a sticky admin vacation balance adjustment that survives refresh and rejects over-removal', async () => {
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    const travelling = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    try {
      await travelling.updateLeaveSettings(makeSettings())
      clock.setNow('2026-06-15T12:00:00.000Z')
      const user = await travelling.upsertUser({
        userId: testUuid('adjust-me'),
        email: 'adjust@example.com',
        displayName: 'Adjustee',
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })

      // Settle accrual once before measuring admin deltas.
      await travelling.getBalances(user.userId)

      await travelling.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: 3,
        note: 'Bonus for project delivery',
      })

      const afterCredit = await travelling.getBalances(user.userId)
      const creditAccrued = afterCredit.find(
        (b) => b.leaveType === LeaveType.Vacation,
      )!.accruedDays

      // Sticky: a later refresh must not claw the credit back.
      const stillAfter = await travelling.getBalances(user.userId)
      expect(
        stillAfter.find((b) => b.leaveType === LeaveType.Vacation)!.accruedDays,
      ).toBe(creditAccrued)

      const allocation = await dataSource
        .getRepository(LeaveAllocationEntity)
        .findOneBy({
          userId: user.userId,
          leaveType: LeaveType.Vacation,
          year: 2026,
        })
      expect(allocation?.manualAdjustmentDays).toBe(3)

      await travelling.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: -2,
        note: 'Partial clawback',
      })
      const afterDebit = await travelling.getBalances(user.userId)
      expect(
        afterDebit.find((b) => b.leaveType === LeaveType.Vacation)!.accruedDays,
      ).toBe(creditAccrued - 2)
      const allocationAfterDebit = await dataSource
        .getRepository(LeaveAllocationEntity)
        .findOneBy({
          userId: user.userId,
          leaveType: LeaveType.Vacation,
          year: 2026,
        })
      expect(allocationAfterDebit?.manualAdjustmentDays).toBe(1)

      await expect(
        travelling.adjustEmployeeVacationBalance({
          userId: user.userId,
          deltaDays: -100,
          note: 'Too much',
        }),
      ).rejects.toBeInstanceOf(LeaveDomainValidationError)

      const timeline = await travelling.getBalanceTimeline(
        user.userId,
        LeaveType.Vacation,
      )
      const adjustments = timeline.filter(
        (entry) => entry.reason === LeaveBalanceChangeReason.Adjustment,
      )
      expect(adjustments.map((entry) => entry.deltaDays)).toEqual([3, -2])
      expect(adjustments[0]?.note).toBe('Bonus for project delivery')

      // Next month adds only the formula slice; the sticky offset stays 1
      // and the credit is never clawed back on refresh.
      const midYearAccrued = afterDebit.find(
        (b) => b.leaveType === LeaveType.Vacation,
      )!.accruedDays
      clock.setNow('2026-07-15T12:00:00.000Z')
      const nextMonth = await travelling.getBalances(user.userId)
      const nextAccrued = nextMonth.find(
        (b) => b.leaveType === LeaveType.Vacation,
      )!.accruedDays
      expect(nextAccrued).toBeGreaterThanOrEqual(midYearAccrued)
      const allocationJuly = await dataSource
        .getRepository(LeaveAllocationEntity)
        .findOneBy({
          userId: user.userId,
          leaveType: LeaveType.Vacation,
          year: 2026,
        })
      expect(allocationJuly?.manualAdjustmentDays).toBe(1)
    } finally {
      delete process.env['TEST_TOOLING_ENABLED']
    }
  })

  it('folds a manual credit into the allowance-percent carryover base', async () => {
    // Owner decision: manualAdjustmentDays counts toward the percent_of_total
    // base, matching the denominator the dashboard shows. A full-year employee
    // on 25 days with a +3 credit ends 2026 with 28 accrued, and the ceiling
    // follows the credited norm: floor(28 / 2) = 14, not 12.
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    const travelling = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    try {
      await travelling.updateLeaveSettings(
        makeSettings({
          defaultVacationDays: 25,
          carryoverPolicy: CarryoverPolicy.Capped,
          carryoverCapMode: CarryoverCapMode.PercentOfTotal,
          carryoverCapPercent: 50,
        }),
      )
      clock.setNow('2026-06-15T12:00:00.000Z')
      const user = await travelling.upsertUser({
        userId: testUuid('carry-manual-base'),
        email: 'carry-manual-base@example.com',
        displayName: 'Credited User',
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      await travelling.getBalances(user.userId)
      await travelling.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: 3,
        note: 'Bonus days',
      })
      await travelling.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
      await travelling.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')
      const timeline = await travelling.getBalanceTimeline(
        user.userId,
        LeaveType.Vacation,
      )
      expect(
        timeline
          .filter((entry) =>
            [
              LeaveBalanceChangeReason.CarryoverOut,
              LeaveBalanceChangeReason.Expired,
              LeaveBalanceChangeReason.CarryoverIn,
            ].includes(entry.reason),
          )
          .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays]),
      ).toEqual([
        [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 14],
        [LeaveBalanceChangeReason.Expired, '2026-12-31', 14],
        [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 14],
      ])
    } finally {
      delete process.env['TEST_TOOLING_ENABLED']
    }
  })

  it('caps a credited second-half-December hire at a share of the credit alone', async () => {
    // The hire month never started counting (half-month rule: hired the 20th),
    // so the earned base is zero and only the admin's +5 credit funds the
    // year. The ceiling is a share of THAT: floor(5 / 2) = 2 carries, 3 burn.
    // Under the old whole-norm rule the ceiling would have been 12 and the
    // whole credit would have carried; the owner chose the prorated reading.
    process.env['TEST_TOOLING_ENABLED'] = 'true'
    const clock = new ClockService()
    const travelling = new LeaveDomainService(
      dataSource,
      new AuditLogService(dataSource, clock),
      clock,
      new NotificationService(dataSource, clock),
    )
    try {
      await travelling.updateLeaveSettings(
        makeSettings({
          defaultVacationDays: 25,
          carryoverPolicy: CarryoverPolicy.Capped,
          carryoverCapMode: CarryoverCapMode.PercentOfTotal,
          carryoverCapPercent: 50,
        }),
      )
      clock.setNow('2026-12-21T12:00:00.000Z')
      const user = await travelling.upsertUser({
        userId: testUuid('carry-dec-credit'),
        email: 'carry-dec-credit@example.com',
        displayName: 'December Hire',
        countryCode: 'UA',
        employmentStartDate: '2026-12-20',
        createdAt: '2026-12-20T00:00:00.000Z',
      })
      await travelling.getBalances(user.userId)
      await travelling.adjustEmployeeVacationBalance({
        userId: user.userId,
        deltaDays: 5,
        note: 'Signing bonus days',
      })
      await travelling.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')
      const timeline = await travelling.getBalanceTimeline(
        user.userId,
        LeaveType.Vacation,
      )
      expect(
        timeline
          .filter((entry) =>
            [
              LeaveBalanceChangeReason.CarryoverOut,
              LeaveBalanceChangeReason.Expired,
              LeaveBalanceChangeReason.CarryoverIn,
            ].includes(entry.reason),
          )
          .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays]),
      ).toEqual([
        [LeaveBalanceChangeReason.CarryoverOut, '2026-12-31', 2],
        [LeaveBalanceChangeReason.Expired, '2026-12-31', 3],
        [LeaveBalanceChangeReason.CarryoverIn, '2027-01-01', 2],
      ])
    } finally {
      delete process.env['TEST_TOOLING_ENABLED']
    }
  })

  it('resets one user leave data: wipes requests, zeroes spent, keeps the allocation', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('reset-me'),
      email: 'reset@example.com',
      displayName: 'Reset Me',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const manager = await service.upsertUser({
      userId: testUuid('reset-mgr'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // An admin override of the annual entitlement must survive the reset.
    await service.setEmployeeAllocation({
      userId: user.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 30,
    })

    // Submit + approve + consume a request so spent > 0 and history exists.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T08:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: manager.userId,
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T09:00:00.000Z',
    })
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-03-10T23:00:00.000Z',
    })
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).spentDays,
    ).toBeGreaterThan(0)

    await service.resetUserLeaveData({ userId: user.userId })

    // Request history is gone.
    const history = await service.getLeaveRequestHistory(user.userId)
    expect(history.requests).toHaveLength(0)

    // Balance self-heals on a dated refresh: spent/onHold zero, accrued
    // re-accrues against the PRESERVED 30-day allocation (30 * 8/12 = 20), and
    // the ledger holds only fresh accrual entries.
    await service.refreshBalances(user.userId, '2026-08-15T00:00:00.000Z')
    const after = await service.getBalance(user.userId, LeaveType.Vacation)
    expect(after).toMatchObject({
      totalDays: 30,
      spentDays: 0,
      onHoldDays: 0,
      accruedDays: 20,
    })
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )
    expect(timeline.every((entry) => entry.reason === 'accrual')).toBe(true)
  })

  it('reset replays the year close from an empty ledger under the current policy', async () => {
    await service.updateLeaveSettings(
      makeSettings({ carryoverPolicy: CarryoverPolicy.Full }),
    )
    const user = await service.upsertUser({
      userId: testUuid('reset-close'),
      email: 'reset-close@example.com',
      displayName: 'Reset Close',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Close 2026 into 2027 under Full: all 24 unused days carry.
    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')
    const allocations = dataSource.getRepository(LeaveAllocationEntity)
    const vacationRows = () =>
      allocations.find({
        where: { userId: user.userId, leaveType: LeaveType.Vacation },
        order: { year: 'ASC' },
      })
    expect(
      (await vacationRows()).map((row) => [
        row.year,
        Number(row.carriedOverDays),
        row.carryoverFinalized,
        row.closedAt !== null,
      ]),
    ).toEqual([
      [2026, 0, true, true],
      [2027, 24, true, false],
    ])

    // Tighten the policy, then reset: the books the old policy wrote are gone,
    // so nothing may survive to re-assert them.
    await service.updateLeaveSettings(
      makeSettings({ carryoverPolicy: CarryoverPolicy.None }),
    )
    await service.resetUserLeaveData({ userId: user.userId })

    // Every year is pending again, with its entitlement intact.
    expect(
      (await vacationRows()).map((row) => [
        row.year,
        Number(row.totalDays),
        Number(row.carriedOverDays),
        row.carryoverFinalized,
        row.closedAt,
      ]),
    ).toEqual([
      [2026, 24, 0, false, null],
      [2027, 24, 0, false, null],
    ])

    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')
    const timeline = await service.getBalanceTimeline(
      user.userId,
      LeaveType.Vacation,
    )

    // The boundary is re-closed under the CURRENT policy: everything burns,
    // nothing carries. Before the scrub the stale carriedOverDays came back as
    // a single fat accrual row and no close rows at all.
    expect(
      timeline
        .filter((entry) =>
          [
            LeaveBalanceChangeReason.CarryoverOut,
            LeaveBalanceChangeReason.Expired,
            LeaveBalanceChangeReason.CarryoverIn,
          ].includes(entry.reason),
        )
        .map((entry) => [entry.reason, entry.effectiveDate, entry.deltaDays]),
    ).toEqual([[LeaveBalanceChangeReason.Expired, '2026-12-31', 24]])

    const accrualsIn = (year: string) =>
      timeline
        .filter(
          (entry) =>
            entry.reason === LeaveBalanceChangeReason.Accrual &&
            entry.effectiveDate.startsWith(year),
        )
        .reduce((sum, entry) => sum + entry.deltaDays, 0)
    // The formerly closed year accrues again rather than staying frozen empty.
    expect(accrualsIn('2026')).toBeCloseTo(24)
    expect(accrualsIn('2027')).toBeCloseTo(2)

    expect(
      (await vacationRows()).map((row) => [
        row.year,
        Number(row.carriedOverDays),
        row.carryoverFinalized,
        row.closedAt !== null,
      ]),
    ).toEqual([
      [2026, 0, true, true],
      [2027, 0, true, false],
    ])
  })

  it('reset reopens a closed year so a re-run can edit it', async () => {
    await service.updateLeaveSettings(
      makeSettings({ carryoverPolicy: CarryoverPolicy.Full }),
    )
    const user = await service.upsertUser({
      userId: testUuid('reset-reopen'),
      email: 'reset-reopen@example.com',
      displayName: 'Reset Reopen',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    await service.refreshBalances(user.userId, '2027-01-20T00:00:00.000Z')

    // A settled year refuses edits, which is what makes a QA re-run impossible
    // until the reset reopens it.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2027-01-20T12:00:00.000Z'))
      await expect(
        service.setEmployeeAllocation({
          userId: user.userId,
          leaveType: LeaveType.Vacation,
          year: 2026,
          totalDays: 30,
        }),
      ).rejects.toThrow(/closed/i)

      await service.resetUserLeaveData({ userId: user.userId })

      // The same edit now lands, and the rewound year accrues on it.
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
      await service.setEmployeeAllocation({
        userId: user.userId,
        leaveType: LeaveType.Vacation,
        year: 2026,
        totalDays: 30,
      })
    } finally {
      vi.useRealTimers()
    }

    await service.refreshBalances(user.userId, '2026-06-15T00:00:00.000Z')
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ totalDays: 30, accruedDays: 15 })
  })

  it('reset-directory wipes the whole population and its dependent rows, detaching the audit trail', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const alice = await service.upsertUser({
      userId: testUuid('rd-alice'),
      email: 'alice@example.com',
      displayName: 'Alice',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const bob = await service.upsertUser({
      userId: testUuid('rd-bob'),
      email: 'bob@example.com',
      displayName: 'Bob',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeAllocation({
      userId: alice.userId,
      leaveType: LeaveType.Vacation,
      year: 2026,
      totalDays: 30,
    })
    const request = await service.submitLeaveRequest({
      requesterUserId: alice.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      approverEmails: ['bob@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T08:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: bob.userId,
      actorDisplayName: 'Bob',
      actorEmail: 'bob@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T09:00:00.000Z',
    })
    await service.reconcileApprovedLeave({
      userId: alice.userId,
      asOfIso: '2026-03-10T23:00:00.000Z',
    })
    // Projects and memberships are mirrored from OIDC, so no domain call
    // creates them — seeded here because the users delete relies on the
    // membership CASCADE, which the table list below pins like every other.
    await seedProject(dataSource, 'apollo', 'Apollo')
    await seedMembership(dataSource, 'rd-alice', 'apollo')
    // The delivery log is written by the notifications module, not the domain.
    // It has no user FK — only the full wipe below can (and must) remove it.
    await seedDelivery(dataSource, request.requestId, ['bob@example.com'])

    // Every table asserted empty below is asserted non-empty first: otherwise a
    // cascade that silently stopped working would still pass as 0 === 0.
    const wiped = [
      'users',
      'user_roles',
      'leave_balances',
      'leave_balance_changes',
      'leave_requests',
      'leave_request_approvers',
      'leave_approval_decisions',
      'leave_request_activities',
      'leave_allocations',
      'user_project_memberships',
      'notifications',
      'notification_deliveries',
    ]
    // The table name rides along in the assertion so a failure names the table
    // that broke rather than just "0 !== 1".
    for (const table of wiped) {
      expect({
        table,
        populated: (await countRows(dataSource, table)) > 0,
      }).toEqual({ table, populated: true })
    }
    expect(await countRows(dataSource, 'audit_logs')).toBeGreaterThan(0)

    const result = await tooling.resetDirectory({ keep: [], all: true })
    expect(result.deletedUsers).toBe(2)
    expect(result.deletedDeliveries).toBe(1)

    for (const table of wiped) {
      expect({ table, rows: await countRows(dataSource, table) }).toEqual({
        table,
        rows: 0,
      })
    }
    // clearAudit defaults off: the trail survives, but its user references are
    // SET NULL, so no row still points at a deleted user.
    expect(await countRows(dataSource, 'audit_logs')).toBeGreaterThan(0)
    const stillLinked = await dataSource.query(
      'SELECT COUNT(*)::int AS n FROM "audit_logs" WHERE "actorUserId" IS NOT NULL OR "targetUserId" IS NOT NULL',
    )
    expect(stillLinked[0].n).toBe(0)
  })

  it('reset-directory keeps listed users, survives a cross-user reference, and clears audit on request', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const keeper = await service.upsertUser({
      userId: testUuid('rd-keep'),
      email: 'keep@example.com',
      displayName: 'Keeper',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const goner = await service.upsertUser({
      userId: testUuid('rd-gone'),
      email: 'gone@example.com',
      displayName: 'Goner',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // The DELETED user is the approver on the KEPT user's request: deleting them
    // must SET NULL that actor reference, not fail on it (subset-delete safety).
    const request = await service.submitLeaveRequest({
      requesterUserId: keeper.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      approverEmails: ['gone@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T08:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: goner.userId,
      actorDisplayName: 'Goner',
      actorEmail: 'gone@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T09:00:00.000Z',
    })
    // With someone kept, the delivery log must survive untouched: it has no
    // user FK, so rows cannot be attributed to the deleted user except by
    // matching address text — which the reset refuses to guess at.
    await seedDelivery(dataSource, request.requestId, ['gone@example.com'])

    const result = await tooling.resetDirectory({
      keep: ['keep@example.com'],
      clearAudit: true,
    })

    expect(result.deletedUsers).toBe(1)
    expect(result.deletedDeliveries).toBe(0)
    // Still linked: the kept user's request survived, so nothing SET-NULLed it.
    const deliveries = await dataSource
      .getRepository(NotificationDeliveryEntity)
      .find()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].requestId).toBe(request.requestId)
    const remaining = await dataSource.getRepository(UserEntity).find()
    expect(remaining.map((user) => user.normalizedEmail)).toEqual([
      'keep@example.com',
    ])
    // The kept user's request survives; the deleted approver's actor id is nulled.
    const decisions = await dataSource.query(
      'SELECT "actorUserId" FROM "leave_approval_decisions"',
    )
    expect(decisions.length).toBeGreaterThan(0)
    expect(
      decisions.every(
        (row: { actorUserId: string | null }) => row.actorUserId === null,
      ),
    ).toBe(true)
    // clearAudit emptied the table.
    const audit = await dataSource.query(
      'SELECT COUNT(*)::int AS n FROM "audit_logs"',
    )
    expect(audit[0].n).toBe(0)
  })

  it('reset-directory still clears the audit trail when the keep list spares everyone', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-all-kept'),
      email: 'kept@example.com',
      displayName: 'Kept',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(await countRows(dataSource, 'audit_logs')).toBeGreaterThan(0)

    // Nobody is deletable, but clearing the trail was asked for independently
    // of the population wipe — it must not be skipped along with the deletes.
    const result = await tooling.resetDirectory({
      keep: ['kept@example.com'],
      clearAudit: true,
    })

    expect(result).toMatchObject({
      deletedUsers: 0,
      deletedRequests: 0,
      deletedLedgerEntries: 0,
    })
    expect(result.clearedAuditLogs).toBeGreaterThan(0)
    expect(await countRows(dataSource, 'audit_logs')).toBe(0)
    const remaining = await dataSource.getRepository(UserEntity).find()
    expect(remaining).toHaveLength(1)
  })

  it('reset-directory refuses to wipe everyone unless the full wipe is confirmed', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-unconfirmed'),
      email: 'nobody@example.com',
      displayName: 'Nobody',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // An empty keep list is exactly what a bodyless request produces, so on its
    // own it must not delete the population.
    await expect(tooling.resetDirectory({ keep: [] })).rejects.toThrow(
      /requires all=true/,
    )
    await expect(tooling.resetDirectory({})).rejects.toThrow(/requires all=true/)

    expect(await dataSource.getRepository(UserEntity).find()).toHaveLength(1)
  })

  it('reset-directory refuses a keep list sent alongside all=true rather than picking a reading', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-contradiction'),
      email: 'keep@example.com',
      displayName: 'Keep',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // The request says both "delete everyone" and "spare this person". Honouring
    // either half silently would be a guess about an irreversible delete.
    await expect(
      tooling.resetDirectory({ keep: ['keep@example.com'], all: true }),
    ).rejects.toThrow(/all=true confirms deleting EVERY user/)

    expect(await dataSource.getRepository(UserEntity).find()).toHaveLength(1)
  })

  it('reset-directory refuses outright when test tooling is disabled', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-disabled'),
      email: 'safe@example.com',
      displayName: 'Safe',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // `service` is the suite's production-like instance: its clock was built
    // with TEST_TOOLING_ENABLED unset, so the wipe is refused in the domain
    // itself, not only at the controller that normally 404s.
    await expect(
      service.resetDirectory({ keep: [], all: true }),
    ).rejects.toThrow(/test tooling is disabled/)

    expect(await dataSource.getRepository(UserEntity).find()).toHaveLength(1)
  })

  it('reset-directory refuses while a directory sync holds the lock, changing nothing', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-locked'),
      email: 'locked@example.com',
      displayName: 'Locked',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Hold the directory-sync advisory lock on a separate connection, the way a
    // running sync does. The key mirrors the domain constant: if that ever
    // changes, the reset below stops being refused and this test fails.
    const holder = dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query('SELECT pg_try_advisory_xact_lock($1)', [774_201_001])

      await expect(
        tooling.resetDirectory({ keep: [], all: true }),
      ).rejects.toThrow(/sync is currently running/)
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }

    // Refused outright rather than half-applied.
    expect(await dataSource.getRepository(UserEntity).find()).toHaveLength(1)
  })

  it('reset-directory refuses a keep address that matches nobody, deleting nothing', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.upsertUser({
      userId: testUuid('rd-typo'),
      email: 'alice@example.com',
      displayName: 'Alice',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // A typo in the keep list would otherwise protect nobody and wipe the very
    // user it named — the whole reset is refused instead.
    await expect(
      tooling.resetDirectory({ keep: ['alcie@example.com'] }),
    ).rejects.toThrow(/no user matches alcie@example.com/)

    const remaining = await dataSource.getRepository(UserEntity).find()
    expect(remaining.map((user) => user.normalizedEmail)).toEqual([
      'alice@example.com',
    ])
  })

  it('spends a leave day only after midnight in the employee timezone', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('eow'),
      email: 'eow@example.com',
      displayName: 'End Of Workday',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const mgr = await service.upsertUser({
      userId: testUuid('eow-mgr'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T08:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: mgr.userId,
      actorDisplayName: 'Manager',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T09:00:00.000Z',
    })

    // Still 2 March in Kyiv (23:00 local): the day is not over, so it is held.
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-03-02T21:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ spentDays: 0, onHoldDays: 1 })

    // Kyiv midnight (22:00 UTC in winter) ends the day, and it flips to spent.
    await service.reconcileApprovedLeave({
      userId: user.userId,
      asOfIso: '2026-03-02T22:00:00.000Z',
    })
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({ spentDays: 1, onHoldDays: 0 })
  })

  it('auto-creates a country from the catalog for an unknown identity country code', async () => {
    await service.updateLeaveSettings(
      makeSettings({ countries: [{ code: 'UA', name: 'Ukraine' }] }),
    )
    // DE is a real country but is not in the settings list; provisioning must
    // auto-create it (instead of dropping it) so the user's location is set.
    const created = await service.findOrCreateUserFromIdentity({
      subject: 'oidc-de',
      email: 'de@example.com',
      displayName: 'DE User',
      roles: [AppRoleName.Employee],
      countryCode: 'DE',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    expect(created.countryCode).toBe('DE')
    expect(
      (await service.getLeaveSettings()).countries.map((c) => c.code),
    ).toContain('DE')
  })

  it('counts only weekdays across a weekend when calculating requested days', async () => {
    // 2026-04-10 Fri .. 2026-04-13 Mon: Fri + Mon are working days; Sat (04-11)
    // and Sun (04-12) are excluded. No country needed (weekends are universal).
    const days = await service.countWorkingDates({
      startDate: '2026-04-10',
      endDate: '2026-04-13',
    })
    expect(days).toBe(2)
  })

  it('excludes weekends and country holidays together', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      // 2026-04-13 is a Monday.
      holidays: [{ date: '2026-04-13', name: 'Bank Holiday' }],
    })
    // 2026-04-10 Fri counts; 04-11 Sat + 04-12 Sun are weekend; 04-13 Mon is a
    // holiday -> only one working day remains.
    const days = await service.countWorkingDates({
      startDate: '2026-04-10',
      endDate: '2026-04-13',
      countryCode: 'UA',
    })
    expect(days).toBe(1)
  })

  it('uses the assigned holiday calendar instead of the residence country', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        countries: [
          { code: 'UA', name: 'Ukraine' },
          { code: 'TR', name: 'Turkey' },
        ],
      }),
    )
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-04-13', name: 'Bank Holiday' }],
    })
    await service.replaceHolidayCalendar({
      countryCode: 'TR',
      year: 2026,
      holidays: [{ date: '2026-04-10', name: 'TR holiday' }],
    })

    const user = await service.upsertUser({
      userId: testUuid('calendar-override'),
      email: 'tr-ua@example.com',
      displayName: 'TR UA',
      countryCode: 'TR',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-04-01T00:00:00.000Z',
    })
    await service.updateEmployeeAdmin({
      userId: user.userId,
      holidayCalendarCountryCode: 'UA',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-04-10',
      endDate: '2026-04-13',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    expect(request.requestedDays).toBe(1)
  })

  it('holds only the working days of a weekend-spanning request', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('weekend-span'),
      email: 'span@example.com',
      displayName: 'Span',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-04-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-04-10', // Friday
      endDate: '2026-04-13', // Monday
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-04-01T09:00:00.000Z',
    })

    // Only Friday and Monday are held; the weekend never consumes balance.
    expect(request.requestedDays).toBe(2)
    expect(
      (await service.getBalance(user.userId, LeaveType.Vacation)).onHoldDays,
    ).toBe(2)
  })

  it('rejects a request that falls entirely on a weekend', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('weekend-only'),
      email: 'weekend@example.com',
      displayName: 'Weekend',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-04-01T00:00:00.000Z',
    })

    // 2026-04-11 Sat .. 2026-04-12 Sun: no working days at all.
    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-04-11',
        endDate: '2026-04-12',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-04-01T09:00:00.000Z',
      }),
    ).rejects.toThrowError('at least one working day')
  })

  it('returns one feed row per request with its live status, paginated by request id', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-03-01T00:00:00.000Z',
    })

    const user = await service.upsertUser({
      userId: testUuid('user-4'),
      email: 'roman@example.com',
      displayName: 'Roman',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(service)

    const firstRequest = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-10',
      endDate: '2026-03-10',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T09:00:00.000Z',
    })

    const secondRequest = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-11',
      endDate: '2026-03-11',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-01T10:00:00.000Z',
    })

    await service.upsertUser({
      userId: testUuid('admin-3'),
      email: 'manager@example.com',
      displayName: 'Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: firstRequest.requestId,
      actorUserId: testUuid('admin-3'),
      actorDisplayName: 'Admin Three',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Reject,
      decidedAt: '2026-03-01T11:00:00.000Z',
    })

    // Two requests exist; the rejected one was touched last (11:00), so it leads.
    // Each request appears exactly once, carrying its live status.
    const firstPage = await service.getAdminActivity({ limit: 1 })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.items[0]).toMatchObject({
      requestId: firstRequest.requestId,
      status: LeaveRequestStatus.Rejected,
      lastAction: 'rejected',
      lastActivityAt: '2026-03-01T11:00:00.000Z',
    })
    expect(firstPage.nextCursor).toBeTypeOf('string')
    // Totals cover the whole company, not just the visible page.
    expect(firstPage.totals).toEqual({
      total: 2,
      pending: 1,
      approved: 0,
      rejected: 1,
      cancelled: 0,
      superseded: 0,
    })

    const secondPage = await service.getAdminActivity({
      limit: 1,
      cursor: firstPage.nextCursor,
    })

    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0]?.requestId).toBe(secondRequest.requestId)
    expect(secondPage.items[0]).toMatchObject({
      status: LeaveRequestStatus.Pending,
      lastAction: 'submitted',
    })
    expect(secondPage.nextCursor).toBeUndefined()
    // Cursor pages omit totals; clients keep the first-page values.
    expect(secondPage.totals).toBeUndefined()

    // Malformed cursors (not base64url "timestamp|uuid") fall back to the
    // first page instead of reaching a SQL cast error.
    for (const badCursor of [
      'garbage',
      Buffer.from('abc|def', 'utf8').toString('base64url'),
      firstRequest.requestId,
    ]) {
      const fallback = await service.getAdminActivity({
        limit: 1,
        cursor: badCursor,
      })
      expect(fallback.items[0]?.requestId).toBe(firstRequest.requestId)
    }

    // Keyset stability: a request acted on mid-pagination moves ABOVE the
    // cursor (newer lastActivityAt), so re-reading the old cursor neither
    // re-serves already-seen rows nor duplicates the updated one — it shows
    // up at the top of a fresh first page instead.
    await service.decideLeaveRequest({
      requestId: secondRequest.requestId,
      actorUserId: testUuid('admin-3'),
      actorDisplayName: 'Admin Three',
      actorEmail: 'manager@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-01T12:00:00.000Z',
    })

    const staleCursorPage = await service.getAdminActivity({
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(staleCursorPage.items).toHaveLength(0)
    expect(staleCursorPage.nextCursor).toBeUndefined()

    const refreshedFirstPage = await service.getAdminActivity({ limit: 1 })
    expect(refreshedFirstPage.items[0]).toMatchObject({
      requestId: secondRequest.requestId,
      status: LeaveRequestStatus.Approved,
      lastAction: 'approved',
    })
  })

  it('labels a non-final approval with its progress so the feed never pairs Pending with a bare approved', async () => {
    await service.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('user-5'),
      email: 'dana@example.com',
      displayName: 'Dana',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('approver-a'),
      email: 'first@example.com',
      displayName: 'First Approver',
      countryCode: 'UA',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('approver-b'),
      email: 'second@example.com',
      displayName: 'Second Approver',
      countryCode: 'UA',
      createdAt: '2026-03-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-12',
      endDate: '2026-03-12',
      approverEmails: ['first@example.com', 'second@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-02T09:00:00.000Z',
    })

    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('approver-a'),
      actorDisplayName: 'First Approver',
      actorEmail: 'first@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-02T10:00:00.000Z',
    })

    const afterFirst = await service.getAdminActivity()
    expect(afterFirst.items[0]).toMatchObject({
      requestId: request.requestId,
      status: LeaveRequestStatus.Pending,
      lastAction: 'approved (1 of 2)',
    })

    await service.decideLeaveRequest({
      requestId: request.requestId,
      actorUserId: testUuid('approver-b'),
      actorDisplayName: 'Second Approver',
      actorEmail: 'second@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-02T11:00:00.000Z',
    })

    const afterFinal = await service.getAdminActivity()
    expect(afterFinal.items[0]).toMatchObject({
      requestId: request.requestId,
      status: LeaveRequestStatus.Approved,
      lastAction: 'approved',
    })

    // The system 'consumed' reconciliation (triggered lazily by reads) lands
    // on the timeline but never touches the snapshot: the feed keeps the
    // human decision as the last activity and does not reorder.
    await service.refreshBalances(user.userId, '2026-03-20T00:00:00.000Z')
    const afterConsumption = await service.getAdminActivity()
    expect(afterConsumption.items[0]).toMatchObject({
      requestId: request.requestId,
      status: LeaveRequestStatus.Approved,
      lastAction: 'approved',
      lastActivityAt: '2026-03-02T11:00:00.000Z',
    })
  })

  it('filters the admin activity feed by employee, approver, status, leave type, and leave-period overlap', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const alice = await service.upsertUser({
      userId: testUuid('feed-alice'),
      email: 'alice@example.com',
      displayName: 'Alice',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    const bob = await service.upsertUser({
      userId: testUuid('feed-bob'),
      email: 'bob@example.com',
      displayName: 'Bob',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('feed-lead'),
      email: 'lead@example.com',
      displayName: 'Lead',
      countryCode: 'UA',
      createdAt: '2026-03-01T00:00:00.000Z',
    })

    // A: Alice, vacation Apr 6-7, approver lead -> approved. (Alice's two
    // vacation requests total 4 days, within the 6 days accrued by March.)
    const requestA = await service.submitLeaveRequest({
      requesterUserId: alice.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-04-06',
      endDate: '2026-04-07',
      approverEmails: ['lead@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-02T09:00:00.000Z',
    })
    await service.decideLeaveRequest({
      requestId: requestA.requestId,
      actorUserId: testUuid('feed-lead'),
      actorDisplayName: 'Lead',
      actorEmail: 'lead@example.com',
      action: LeaveApprovalAction.Approve,
      decidedAt: '2026-03-02T10:00:00.000Z',
    })
    // B: Bob, sick May 4-5, lead only CC'd -> pending.
    const requestB = await service.submitLeaveRequest({
      requesterUserId: bob.userId,
      leaveType: LeaveType.Sick,
      startDate: '2026-05-04',
      endDate: '2026-05-05',
      approverEmails: ['other@example.com'],
      ccEmails: ['lead@example.com'],
      submittedAt: '2026-03-02T11:00:00.000Z',
    })
    // C: Alice, vacation Jun 1-2 -> pending.
    const requestC = await service.submitLeaveRequest({
      requesterUserId: alice.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      approverEmails: ['other@example.com'],
      ccEmails: [],
      submittedAt: '2026-03-02T12:00:00.000Z',
    })

    const ids = (feed: { items: { requestId: string }[] }) =>
      feed.items.map((item) => item.requestId)

    const byEmployee = await service.getAdminActivity({
      employeeId: alice.userId,
    })
    expect(ids(byEmployee)).toEqual([requestC.requestId, requestA.requestId])
    // Totals count the filtered population (Alice's requests), not the company.
    expect(byEmployee.totals).toEqual({
      total: 2,
      pending: 1,
      approved: 1,
      rejected: 0,
      cancelled: 0,
      superseded: 0,
    })

    // Approver matching is case/whitespace-insensitive and only counts
    // deciding ('to') approvers: B has lead as CC and must not match.
    const byApprover = await service.getAdminActivity({
      approverEmail: ' Lead@Example.com ',
    })
    expect(ids(byApprover)).toEqual([requestA.requestId])

    // The status filter behaves like every other filter: the totals cards
    // count only the matching requests.
    const byStatus = await service.getAdminActivity({
      status: LeaveRequestStatus.Pending,
    })
    expect(ids(byStatus)).toEqual([requestC.requestId, requestB.requestId])
    expect(byStatus.totals).toEqual({
      total: 2,
      pending: 2,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      superseded: 0,
    })

    const byType = await service.getAdminActivity({ leaveType: LeaveType.Sick })
    expect(ids(byType)).toEqual([requestB.requestId])

    // Inclusive overlap: A ends on the range's first day, B starts on its
    // last day, C lies entirely after it.
    const byRange = await service.getAdminActivity({
      from: '2026-04-07',
      to: '2026-05-04',
    })
    expect(ids(byRange)).toEqual([requestB.requestId, requestA.requestId])

    const openEnded = await service.getAdminActivity({ from: '2026-05-01' })
    expect(ids(openEnded)).toEqual([requestC.requestId, requestB.requestId])

    // Filters combine with AND, and the keyset cursor respects them.
    const combined = await service.getAdminActivity({
      employeeId: alice.userId,
      status: LeaveRequestStatus.Pending,
    })
    expect(ids(combined)).toEqual([requestC.requestId])

    const pagedFirst = await service.getAdminActivity({
      employeeId: alice.userId,
      limit: 1,
    })
    expect(ids(pagedFirst)).toEqual([requestC.requestId])
    const pagedSecond = await service.getAdminActivity({
      employeeId: alice.userId,
      limit: 1,
      cursor: pagedFirst.nextCursor,
    })
    expect(ids(pagedSecond)).toEqual([requestA.requestId])
    expect(pagedSecond.nextCursor).toBeUndefined()
  })

  it('lazily accrues the full annual allocation by December without losing fractional days', async () => {
    // 25 is not divisible by 12, so naive monthly rounding would drop days.
    await service.updateLeaveSettings(makeSettings({ defaultVacationDays: 25 }))
    const user = await service.upsertUser({
      userId: testUuid('user-accrual'),
      email: 'accrual@example.com',
      displayName: 'Accrual',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-07-15T00:00:00.000Z')
    // 25 * 7 / 12 = 14.5833..., quantized to the books' three decimals.
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      accruedDays: 14.583,
      availableDays: 14.583,
    })

    await service.refreshBalances(user.userId, '2026-12-31T00:00:00.000Z')
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      accruedDays: 25,
      availableDays: 25,
    })
  })

  it('rejects a leave request that overlaps an existing pending request', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('user-overlap'),
      email: 'overlap@example.com',
      displayName: 'Overlap',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-06-01T00:00:00.000Z',
    })

    await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-10',
      endDate: '2026-06-12',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-06-01T09:00:00.000Z',
    })

    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Sick,
        startDate: '2026-06-12',
        endDate: '2026-06-13',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-06-02T09:00:00.000Z',
      }),
    ).rejects.toThrow(
      /Leave request overlaps an existing request: 2026-06-10 to 2026-06-12 \(Pending\)\./,
    )
  })

  it('cancels a pending request and releases the held days', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('user-cancel'),
      email: 'cancel@example.com',
      displayName: 'Cancel',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-06-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-06-10',
      endDate: '2026-06-11',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-06-01T09:00:00.000Z',
    })
    const heldBalance = await service.getBalance(user.userId, LeaveType.Vacation)
    expect(heldBalance.onHoldDays).toBe(2)

    const cancelled = await service.cancelLeaveRequest({
      requestId: request.requestId,
      actorUserId: user.userId,
      actorDisplayName: user.displayName,
    })
    expect(cancelled.status).toBe(LeaveRequestStatus.Cancelled)
    expect(
      await service.getBalance(user.userId, LeaveType.Vacation),
    ).toMatchObject({
      onHoldDays: 0,
      // Releasing a hold does not change display available (accrued - spent);
      // only onHoldDays returns to 0.
      availableDays: heldBalance.availableDays,
    })
  })

  const seedApprovalRequest = async (
    approverEmails: string[],
    requester = 'emp@example.com',
  ) => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('emp-' + requester),
      email: requester,
      displayName: 'Employee',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Approvers are app users (owner decision #1), so a decision can reference a
    // real actor via the actorUserId FK.
    for (const email of approverEmails) {
      await service.upsertUser({
        userId: testUuid('appr-' + email),
        email,
        displayName: email,
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      approverEmails,
      ccEmails: [],
      submittedAt: '2026-01-02T09:00:00.000Z',
    })
    return { user, request }
  }

  const decide = (
    requestId: string,
    email: string,
    action: LeaveApprovalAction,
    when: string,
  ) =>
    service.decideLeaveRequest({
      requestId,
      actorUserId: testUuid('appr-' + email),
      actorDisplayName: email,
      actorEmail: email,
      action,
      decidedAt: when,
    })

  it('approves only after every to-approver has approved', async () => {
    const { request } = await seedApprovalRequest([
      'lead@example.com',
      'hr@example.com',
    ])

    const afterFirst = await decide(
      request.requestId,
      'lead@example.com',
      LeaveApprovalAction.Approve,
      '2026-01-02T10:00:00.000Z',
    )
    expect(afterFirst.status).toBe(LeaveRequestStatus.Pending)
    expect(
      afterFirst.approvers.find((a) => a.email === 'lead@example.com')?.decision,
    ).toBe(ApproverDecision.Approved)
    expect(
      afterFirst.approvers.find((a) => a.email === 'hr@example.com')?.decision,
    ).toBe(ApproverDecision.Pending)

    const afterSecond = await decide(
      request.requestId,
      'hr@example.com',
      LeaveApprovalAction.Approve,
      '2026-01-02T11:00:00.000Z',
    )
    expect(afterSecond.status).toBe(LeaveRequestStatus.Approved)
  })

  it('rejects the request and releases the hold when any to-approver rejects', async () => {
    const { user, request } = await seedApprovalRequest([
      'lead@example.com',
      'hr@example.com',
    ])

    const rejected = await decide(
      request.requestId,
      'lead@example.com',
      LeaveApprovalAction.Reject,
      '2026-01-02T10:00:00.000Z',
    )
    expect(rejected.status).toBe(LeaveRequestStatus.Rejected)
    const balance = await service.getBalance(user.userId, LeaveType.Vacation)
    expect(balance.onHoldDays).toBe(0)
  })

  it('blocks self-approval, unknown approvers, and re-deciding a terminal request', async () => {
    const { user, request } = await seedApprovalRequest(['lead@example.com'])

    await expect(
      service.decideLeaveRequest({
        requestId: request.requestId,
        actorUserId: user.userId,
        actorDisplayName: 'Employee',
        actorEmail: 'emp@example.com',
        action: LeaveApprovalAction.Approve,
        decidedAt: '2026-01-02T10:00:00.000Z',
      }),
    ).rejects.toThrowError('your own leave request')

    await expect(
      decide(
        request.requestId,
        'stranger@example.com',
        LeaveApprovalAction.Approve,
        '2026-01-02T10:00:00.000Z',
      ),
    ).rejects.toThrowError('not an approver')

    await decide(
      request.requestId,
      'lead@example.com',
      LeaveApprovalAction.Approve,
      '2026-01-02T11:00:00.000Z',
    )
    await expect(
      decide(
        request.requestId,
        'lead@example.com',
        LeaveApprovalAction.Approve,
        '2026-01-02T12:00:00.000Z',
      ),
    ).rejects.toThrowError('Only pending')
  })

  it('lets an admin force-approve past an undecided approver without fabricating decisions', async () => {
    const { request } = await seedApprovalRequest([
      'lead@example.com',
      'hr@example.com',
    ])
    await decide(
      request.requestId,
      'lead@example.com',
      LeaveApprovalAction.Approve,
      '2026-01-02T10:00:00.000Z',
    )

    const admin = await service.upsertUser({
      userId: testUuid('force-admin'),
      email: 'forceadmin@example.com',
      displayName: 'Admin',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const forced = await service.forceDecideLeaveRequest({
      requestId: request.requestId,
      actorUserId: admin.userId,
      actorDisplayName: 'Admin',
      action: LeaveApprovalAction.Approve,
      comment: 'Approver left the company',
      decidedAt: '2026-01-02T12:00:00.000Z',
    })
    expect(forced.status).toBe(LeaveRequestStatus.Approved)
    // The never-acting approver row is NOT fabricated as approved.
    expect(
      forced.approvers.find((a) => a.email === 'hr@example.com')?.decision,
    ).toBe(ApproverDecision.Pending)
  })

  it('refuses an override with no written reason, and records a trimmed one', async () => {
    const { request } = await seedApprovalRequest([
      'lead@example.com',
      'hr@example.com',
    ])
    const admin = await service.upsertUser({
      userId: testUuid('reason-admin'),
      email: 'reasonadmin@example.com',
      displayName: 'Admin',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const override = (comment?: string) =>
      service.forceDecideLeaveRequest({
        requestId: request.requestId,
        actorUserId: admin.userId,
        actorDisplayName: 'Admin',
        action: LeaveApprovalAction.Reject,
        ...(comment !== undefined ? { comment } : {}),
        decidedAt: '2026-01-02T12:00:00.000Z',
      })

    // The reason is the only account of why the approvers were bypassed, so an
    // omitted one and a blank one are the same mistake.
    await expect(override()).rejects.toThrowError(
      'An override reason is required to bypass the approver gate.',
    )
    await expect(override('   ')).rejects.toThrowError(
      'An override reason is required to bypass the approver gate.',
    )

    const forced = await override('  Approver unreachable for two weeks  ')
    expect(forced.status).toBe(LeaveRequestStatus.Rejected)
    expect(forced.decisionComment).toBe('Approver unreachable for two weeks')
    expect(
      forced.activity.some(
        (entry) =>
          entry.action === 'force-rejected' &&
          entry.comment === 'Approver unreachable for two weeks',
      ),
    ).toBe(true)
  })

  it('drops the requester from the folded approver set and requires another approver', async () => {
    await service.updateLeaveSettings(
      makeSettings({ defaultApproverEmails: ['self@example.com'] }),
    )
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('self-approver'),
      email: 'self@example.com',
      displayName: 'Self',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        // No explicit approver: the sole 'to' approver is the settings default
        // 'self@example.com', which the fold drops as the requester's own
        // address — leaving the request with no approver other than them.
        approverEmails: [],
        ccEmails: [],
        submittedAt: '2026-01-02T09:00:00.000Z',
      }),
    ).rejects.toThrowError('at least one approver other than the requester')
  })

  it('rejects a submission that lists an inactive employee as approver', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('req-inactive-appr'),
      email: 'req-inactive-appr@example.com',
      displayName: 'Requester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactive = await service.upsertUser({
      userId: testUuid('inactive-appr'),
      email: 'gone-manager@example.com',
      displayName: 'Gone Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeActive({
      userId: inactive.userId,
      active: false,
    })

    await expect(
      service.submitLeaveRequest({
        requesterUserId: requester.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        approverEmails: ['gone-manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-01-02T09:00:00.000Z',
      }),
    ).rejects.toThrowError('inactive')
  })

  it('rejects a submission that lists an inactive employee in CC', async () => {
    await service.updateLeaveSettings(makeSettings())
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('req-inactive-cc'),
      email: 'req-inactive-cc@example.com',
      displayName: 'Requester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('active-appr'),
      email: 'active-manager@example.com',
      displayName: 'Active Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactive = await service.upsertUser({
      userId: testUuid('inactive-cc'),
      email: 'gone-hr@example.com',
      displayName: 'Gone HR',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeActive({
      userId: inactive.userId,
      active: false,
    })

    await expect(
      service.submitLeaveRequest({
        requesterUserId: requester.userId,
        leaveType: LeaveType.Vacation,
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        approverEmails: ['active-manager@example.com'],
        ccEmails: ['gone-hr@example.com'],
        submittedAt: '2026-01-02T09:00:00.000Z',
      }),
    ).rejects.toThrowError('inactive')
  })

  it('drops an inactive default approver and still submits when another default remains', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        defaultApproverEmails: [
          'gone-default@example.com',
          'active-default@example.com',
        ],
      }),
    )
    await seedHolidayCalendar(service)
    const requester = await service.upsertUser({
      userId: testUuid('req-inactive-default'),
      email: 'req-inactive-default@example.com',
      displayName: 'Requester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactiveDefault = await service.upsertUser({
      userId: testUuid('inactive-default'),
      email: 'gone-default@example.com',
      displayName: 'Gone Default',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeActive({
      userId: inactiveDefault.userId,
      active: false,
    })
    await service.upsertUser({
      userId: testUuid('active-default'),
      email: 'active-default@example.com',
      displayName: 'Active Default',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const request = await service.submitLeaveRequest({
      requesterUserId: requester.userId,
      leaveType: LeaveType.Vacation,
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      approverEmails: [],
      ccEmails: [],
      submittedAt: '2026-01-02T09:00:00.000Z',
    })

    expect(request.approvers.map((approver) => approver.email)).toEqual([
      'active-default@example.com',
    ])
  })

  it('excludes inactive employees from the request form context', async () => {
    await service.updateLeaveSettings(
      makeSettings({
        defaultApproverEmails: ['gone-default@example.com', 'manager@example.com'],
        defaultCcApproverEmails: ['gone-cc@example.com', 'hr@example.com'],
      }),
    )
    await service.upsertUser({
      userId: testUuid('ctx-requester'),
      email: 'ctx-requester@example.com',
      displayName: 'Context Requester',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.upsertUser({
      userId: testUuid('ctx-active'),
      email: 'manager@example.com',
      displayName: 'Active Manager',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactiveDefault = await service.upsertUser({
      userId: testUuid('ctx-inactive-default'),
      email: 'gone-default@example.com',
      displayName: 'Gone Default',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactiveCc = await service.upsertUser({
      userId: testUuid('ctx-inactive-cc'),
      email: 'gone-cc@example.com',
      displayName: 'Gone CC',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const inactivePicker = await service.upsertUser({
      userId: testUuid('ctx-inactive-picker'),
      email: 'gone-picker@example.com',
      displayName: 'Gone Picker',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await service.setEmployeeActive({ userId: inactiveDefault.userId, active: false })
    await service.setEmployeeActive({ userId: inactiveCc.userId, active: false })
    await service.setEmployeeActive({ userId: inactivePicker.userId, active: false })

    const context = await service.getLeaveRequestFormContext(
      testUuid('ctx-requester'),
    )

    expect(context.users.map((user) => user.email)).toEqual([
      'manager@example.com',
    ])
    expect(context.defaultApprovers).toEqual([
      { email: 'manager@example.com', displayName: 'Active Manager' },
    ])
    expect(context.defaultCc).toEqual([{ email: 'hr@example.com' }])
  })

  it('rejects a submission with an unknown leave type', async () => {
    await service.updateLeaveSettings(makeSettings())
    const user = await service.upsertUser({
      userId: testUuid('user-type'),
      email: 'type@example.com',
      displayName: 'Type',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-06-01T00:00:00.000Z',
    })

    await expect(
      service.submitLeaveRequest({
        requesterUserId: user.userId,
        leaveType: 'holiday' as LeaveType,
        startDate: '2026-06-10',
        endDate: '2026-06-11',
        approverEmails: ['manager@example.com'],
        ccEmails: [],
        submittedAt: '2026-06-01T09:00:00.000Z',
      }),
    ).rejects.toThrow(/Unknown leave type/i)
  })

  it('credits the sick allowance up front so early-year sick leave is claimable', async () => {
    await service.updateLeaveSettings(makeSettings()) // sick = 12
    await seedHolidayCalendar(service)
    const user = await service.upsertUser({
      userId: testUuid('user-sick'),
      email: 'sick@example.com',
      displayName: 'Sick',
      countryCode: 'UA',
      employmentStartDate: '2026-01-01',
      createdAt: '2026-01-05T00:00:00.000Z',
    })

    await service.refreshBalances(user.userId, '2026-01-05T00:00:00.000Z')
    expect(await service.getBalance(user.userId, LeaveType.Sick)).toMatchObject({
      accruedDays: 12,
      availableDays: 12,
    })

    // A 3-day sick request in early January must be claimable.
    const request = await service.submitLeaveRequest({
      requesterUserId: user.userId,
      leaveType: LeaveType.Sick,
      startDate: '2026-01-12',
      endDate: '2026-01-14',
      approverEmails: ['manager@example.com'],
      ccEmails: [],
      submittedAt: '2026-01-10T09:00:00.000Z',
    })
    expect(request.requestedDays).toBe(3)
    expect(request.status).toBe(LeaveRequestStatus.Pending)
  })

  it('dedupes holidays that fall on the same date instead of failing the save', async () => {
    await service.updateLeaveSettings(makeSettings())
    const calendar = await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [
        { date: '2026-05-01', name: 'Civic Holiday' },
        { date: '2026-05-01', name: 'Religious Holiday' },
      ],
    })
    // Last-wins on the shared date: exactly one holiday for 2026-05-01.
    expect(calendar.holidays).toHaveLength(1)
    expect(calendar.holidays[0]?.date).toBe('2026-05-01')
    expect(calendar.holidays[0]?.name).toBe('Religious Holiday')
  })

  it('keeps calendars for other years when one calendar is saved', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2025,
      holidays: [{ date: '2025-05-01', name: 'Labour Day 2025' }],
    })
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-05-01', name: 'Labour Day 2026' }],
    })

    // Saving 2026 again must not touch the 2025 calendar.
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-05-01', name: 'Renamed' }],
    })

    const calendars = await service.listHolidayCalendars({ countryCode: 'UA' })
    const years = calendars.map((calendar) => calendar.year).sort()
    expect(years).toEqual([2025, 2026])
  })

  it('does not wipe holiday calendars when settings are saved', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [{ date: '2026-05-01', name: 'Labour Day' }],
    })

    await service.updateLeaveSettings(makeSettings({ defaultVacationDays: 30 }))

    const calendars = await service.listHolidayCalendars({ countryCode: 'UA' })
    expect(calendars).toHaveLength(1)
    expect(calendars[0]?.holidays[0]?.date).toBe('2026-05-01')
  })

  it('clones a calendar into a new year, shifting dates and recording provenance', async () => {
    await service.updateLeaveSettings(makeSettings())
    const source = await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      holidays: [
        { date: '2026-01-01', name: 'New Year' },
        { date: '2026-05-01', name: 'Labour Day' },
      ],
    })

    const cloned = await service.cloneHolidayCalendar({
      countryCode: 'UA',
      sourceYear: 2026,
      targetYear: 2027,
    })
    expect(cloned.year).toBe(2027)
    expect(cloned.sourceCalendarId).toBe(source.calendarId)
    expect(cloned.holidays.map((holiday) => holiday.date)).toEqual([
      '2027-01-01',
      '2027-05-01',
    ])

    // Cloning onto an existing target year is rejected.
    await expect(
      service.cloneHolidayCalendar({
        countryCode: 'UA',
        sourceYear: 2026,
        targetYear: 2027,
      }),
    ).rejects.toThrowError('already exists')
  })

  it('clears a calendar name when an explicit null is saved', async () => {
    await service.updateLeaveSettings(makeSettings())
    await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      name: 'UA National',
      holidays: [{ date: '2026-05-01', name: 'Labour Day' }],
    })

    const blanked = await service.replaceHolidayCalendar({
      countryCode: 'UA',
      year: 2026,
      name: null,
      holidays: [{ date: '2026-05-01', name: 'Labour Day' }],
    })
    expect(blanked.name).toBeNull()
  })

  it('rejects a holiday whose date falls outside the calendar year', async () => {
    await service.updateLeaveSettings(makeSettings())
    await expect(
      service.replaceHolidayCalendar({
        countryCode: 'UA',
        year: 2026,
        holidays: [{ date: '2027-01-01', name: 'Wrong Year' }],
      }),
    ).rejects.toThrowError('does not fall in 2026')
  })
})

// Seeds one outbound-mail log row through the notifications module's own
// writer — the domain never writes this table itself, and going through
// trackPending keeps the row's shape and its normalization the real ones.
async function seedDelivery(
  dataSource: DataSource,
  requestId: string,
  to: string[],
): Promise<void> {
  const store = new LeaveNotificationDeliveryStore(
    dataSource.getRepository(NotificationDeliveryEntity),
  )
  await store.trackPending({
    requestId,
    subject: 'Leave request pending approval',
    to,
    cc: [],
    approvalUrl: 'https://leave.example.test/review',
    queuedAt: '2026-03-01T08:00:00.000Z',
  })
}

// Row count for a table the domain has no repository read for (or where the
// point of the assertion is "the cascade emptied it").
async function countRows(
  dataSource: DataSource,
  table: string,
): Promise<number> {
  const rows = await dataSource.query(
    `SELECT COUNT(*)::int AS n FROM "${table}"`,
  )
  return rows[0].n
}

function makeSettings(
  overrides: {
    defaultVacationDays?: number
    defaultApproverEmails?: string[]
    defaultCcApproverEmails?: string[]
    countries?: { code: string; name: string; timezone?: string }[]
    carryoverPolicy?: CarryoverPolicy
    carryoverCapDays?: number
    carryoverCapMode?: CarryoverCapMode
    carryoverCapPercent?: number
    defaultTimezone?: string
  } = {},
) {
  return {
    // Omitted unless asked for, because absent is a meaningful value here: it
    // means "leave the stored zone alone".
    ...(overrides.defaultTimezone !== undefined
      ? { defaultTimezone: overrides.defaultTimezone }
      : {}),
    defaultVacationDays: overrides.defaultVacationDays ?? 24,
    defaultSickDays: 12,
    defaultApproverEmails: overrides.defaultApproverEmails ?? [],
    defaultCcApproverEmails: overrides.defaultCcApproverEmails ?? [],
    countries: overrides.countries ?? [{ code: 'UA', name: 'Ukraine' }],
    // Pinned rather than left undefined: the service default is the company
    // policy (capped at 50%), so a fixture that says nothing about carryover
    // means "no carryover" here and stays readable as the years roll over.
    carryoverPolicy: overrides.carryoverPolicy ?? CarryoverPolicy.None,
    carryoverCapDays: overrides.carryoverCapDays ?? 0,
    carryoverCapMode: overrides.carryoverCapMode,
    carryoverCapPercent: overrides.carryoverCapPercent,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
