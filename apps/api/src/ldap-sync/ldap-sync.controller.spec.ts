/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { AppRoleName, emptyDirectorySyncReport } from '@workspace/contracts'
import type { DirectorySyncReportDto } from '@workspace/contracts'
import type { LeaveDomainService } from '../domain/leave-domain.service'
import { DirectoryReadError } from './directory-sync-failure'
import type { LdapSyncConfig } from './ldap-sync.config'
import { LdapSyncController } from './ldap-sync.controller'
import type { LdapSyncService } from './ldap-sync.service'

/**
 * Pure unit tests: the guard and DI wiring live in the module, so here we drive
 * the handler directly with a mocked service (null = disabled deployment) and a
 * mocked domain (for the failed-run audit writer).
 */

const admin = {
  roles: [AppRoleName.Administrator],
} as unknown as UserProfileType
const employee = {
  roles: [AppRoleName.Employee],
} as unknown as UserProfileType

function report(
  overrides: Partial<DirectorySyncReportDto> = {},
): DirectorySyncReportDto {
  return {
    ...emptyDirectorySyncReport(),
    ...overrides,
  }
}

describe('LdapSyncController', () => {
  let runSync: ReturnType<typeof vi.fn>
  let recordDirectorySyncFailed: ReturnType<typeof vi.fn>
  let domain: LeaveDomainService

  // The two travel together in production: the module builds a service only for
  // an enabled config, so a test that passes a service describes an enabled
  // deployment unless it says otherwise.
  const controllerWith = (
    sync: LdapSyncService | null,
    config: LdapSyncConfig = { enabled: sync !== null } as LdapSyncConfig,
  ) => new LdapSyncController(sync, domain, config)

  beforeEach(() => {
    runSync = vi.fn()
    recordDirectorySyncFailed = vi.fn().mockResolvedValue(undefined)
    domain = { recordDirectorySyncFailed } as unknown as LeaveDomainService
  })

  it('refuses a non-administrator with 403 and never runs the sync', async () => {
    const sync = { runSync } as unknown as LdapSyncService

    await expect(controllerWith(sync).run(employee)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(runSync).not.toHaveBeenCalled()
  })

  it('answers 409 when the sync is disabled — before touching any service', async () => {
    await expect(controllerWith(null).run(admin)).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('returns the completed report to an administrator', async () => {
    const completed = { status: 'completed' as const, report: report({ created: ['a@example.com'] }) }
    runSync.mockResolvedValue(completed)
    const sync = { runSync } as unknown as LdapSyncService

    expect(await controllerWith(sync).run(admin)).toEqual(completed)
  })

  it('passes through already-running and empty-directory statuses', async () => {
    const sync = { runSync } as unknown as LdapSyncService

    runSync.mockResolvedValueOnce({ status: 'already-running' })
    expect(await controllerWith(sync).run(admin)).toEqual({
      status: 'already-running',
    })

    runSync.mockResolvedValueOnce({ status: 'empty-directory' })
    expect(await controllerWith(sync).run(admin)).toEqual({
      status: 'empty-directory',
    })
  })

  it('records ldap_sync.failed and surfaces 500 when the run throws', async () => {
    runSync.mockRejectedValue(new Error('LDAP down'))
    const sync = { runSync } as unknown as LdapSyncService

    await expect(controllerWith(sync).run(admin)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
    // The crash left a lifecycle trace on the non-transactional manager,
    // carrying both halves: the raw text to debug from and the worded cause,
    // which is all the row will still be saying once the page has been closed.
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'LDAP down',
      summary: expect.stringContaining('The directory was read'),
    })
  })

  it('answers a crash with the cause, never with the plumbing', async () => {
    // The 500 body is what the admin reads; the host and port belong in the
    // audit trail and the server log, which get the raw text instead.
    runSync.mockRejectedValue(
      new DirectoryReadError(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:636'), {
          code: 'ECONNREFUSED',
        }),
      ),
    )
    const sync = { runSync } as unknown as LdapSyncService

    const rejection: unknown = await controllerWith(sync)
      .run(admin)
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(InternalServerErrorException)
    const message = (rejection as InternalServerErrorException).message
    expect(message).toContain('Could not reach the directory server')
    expect(message).not.toContain('10.0.0.5')
    expect(message).not.toContain('636')
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'connect ECONNREFUSED 10.0.0.5:636',
      // The row says what the screen says, because a reader who missed the
      // screen has only this.
      summary: message,
    })
  })

  it('does not blame the directory when the database is what failed', async () => {
    // The pass reaches the domain transaction only after the directory has
    // answered, and Postgres refuses a connection in the same shape LDAP does.
    // Reported as the directory's, this sends the admin to the wrong owner for
    // the whole outage.
    runSync.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      }),
    )
    const sync = { runSync } as unknown as LdapSyncService

    const rejection: unknown = await controllerWith(sync)
      .run(admin)
      .catch((error: unknown) => error)

    const message = (rejection as InternalServerErrorException).message
    expect(message).toContain('The directory was read')
    expect(message).not.toContain('Could not reach the directory server')
    expect(message).not.toContain('127.0.0.1')
    // The trace still carries the raw cause: the admin's screen is the only
    // place that stays vague.
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'connect ECONNREFUSED 127.0.0.1:5432',
      summary: message,
    })
  })

  it('logs the crash with its stack for the operator', async () => {
    // The admin's screen deliberately hides the plumbing, so the server log
    // has to carry it — with the stack, or the log names the failure without
    // saying where it happened.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)
    try {
      const crash = new Error('LDAP down')
      runSync.mockRejectedValue(crash)
      const sync = { runSync } as unknown as LdapSyncService

      await expect(controllerWith(sync).run(admin)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      )
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('LDAP down'),
        crash.stack,
      )
    } finally {
      logged.mockRestore()
    }
  })

  it('still returns 500 (not the raw audit error) when the trace write also throws', async () => {
    // When the DB is the very thing that is down, the failure-trace write fails
    // too; the guard must swallow it so the client still gets the clean 500.
    runSync.mockRejectedValue(new Error('LDAP down'))
    recordDirectorySyncFailed.mockRejectedValue(new Error('DB unreachable'))
    const sync = { runSync } as unknown as LdapSyncService

    await expect(controllerWith(sync).run(admin)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'LDAP down',
      summary: expect.stringContaining('The directory was read'),
    })
  })

  describe('status', () => {
    it('refuses a non-administrator with 403', () => {
      const sync = { runSync } as unknown as LdapSyncService

      expect(() => controllerWith(sync).status(employee)).toThrow(
        ForbiddenException,
      )
    })

    it('reports a disabled deployment as enabled:false instead of 409', () => {
      // The web hides the button on this; a 409 would make the caller read a
      // normal state as a failure.
      expect(controllerWith(null).status(admin)).toEqual({ enabled: false })
    })

    it('reports an enabled deployment to an administrator', () => {
      const sync = { runSync } as unknown as LdapSyncService

      expect(controllerWith(sync).status(admin)).toEqual({ enabled: true })
    })

    it('answers from the configuration, not from whether a client was built', () => {
      // A deployment that configured the sync but ended up without a usable
      // client has a directory; it has a broken one. Reporting it as a company
      // that does not sync would hide the breakage behind a missing button.
      const configured = { enabled: true } as LdapSyncConfig

      expect(controllerWith(null, configured).status(admin)).toEqual({
        enabled: true,
      })
    })
  })
})
