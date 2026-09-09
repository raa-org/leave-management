/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real CronJob would arm a live timer on start(); stub it so tests stay
// deterministic and we can capture the onTick callback to drive one run.
vi.mock('cron', () => ({
  CronJob: { from: vi.fn(() => ({ start: vi.fn() })) },
}))

import { Logger } from '@nestjs/common'
import { CronJob } from 'cron'
import type { SchedulerRegistry } from '@nestjs/schedule'
import type { LeaveDomainService } from '../domain/leave-domain.service'
import type { LdapSyncConfig } from './ldap-sync.config'
import { LdapSyncScheduler } from './ldap-sync.scheduler'
import type { LdapSyncService } from './ldap-sync.service'

const cronFrom = CronJob.from as unknown as ReturnType<typeof vi.fn>

const enabledConfig = {
  enabled: true,
  settings: { cron: '0 * * * *', cronEnabled: true },
} as unknown as LdapSyncConfig

function makeRegistry() {
  return {
    doesExist: vi.fn(() => false),
    addCronJob: vi.fn(),
    deleteCronJob: vi.fn(),
  }
}

// The onTick registered for the single CronJob.from call.
function tick(): () => Promise<void> {
  return cronFrom.mock.calls[0]?.[0]?.onTick
}

// True when any logger.log call carried the given fragment. Lets a test tell
// the already-running branch apart from the completed branch — they differ only
// in the message logged.
function logged(
  logSpy: { mock: { calls: unknown[][] } },
  fragment: string,
): boolean {
  return logSpy.mock.calls.some((call) => String(call[0]).includes(fragment))
}

describe('LdapSyncScheduler', () => {
  let runSync: ReturnType<typeof vi.fn>
  let recordDirectorySyncFailed: ReturnType<typeof vi.fn>
  let registry: ReturnType<typeof makeRegistry>
  let domain: LeaveDomainService

  beforeEach(() => {
    vi.clearAllMocks()
    runSync = vi.fn().mockResolvedValue({ status: 'completed', report: {} })
    recordDirectorySyncFailed = vi.fn().mockResolvedValue(undefined)
    registry = makeRegistry()
    domain = { recordDirectorySyncFailed } as unknown as LeaveDomainService
  })

  const make = (
    sync: LdapSyncService | null,
    config: LdapSyncConfig = enabledConfig,
  ) =>
    new LdapSyncScheduler(
      sync,
      config,
      registry as unknown as SchedulerRegistry,
      domain,
    )

  it('registers one started job from LDAP_SYNC_CRON at boot and never runs it there', () => {
    make({ runSync } as unknown as LdapSyncService).onApplicationBootstrap()

    expect(registry.addCronJob).toHaveBeenCalledTimes(1)
    expect(registry.addCronJob.mock.calls[0]?.[0]).toBe('ldap-sync')
    const options = cronFrom.mock.calls[0]?.[0]
    expect(options?.cronTime).toBe('0 * * * *')
    // No timeZone override: the expression runs in the server's timezone.
    expect(options?.timeZone).toBeUndefined()
    // The registered job is armed exactly once — start() is what fires the timer.
    expect(cronFrom.mock.results[0]?.value.start).toHaveBeenCalledTimes(1)
    // No boot-run: no option asks cron to fire at registration, and nothing
    // fires the tick here.
    expect(options?.runOnInit).toBeFalsy()
    expect(options?.start).toBeFalsy()
    expect(runSync).not.toHaveBeenCalled()
  })

  it('registers nothing when the service is absent', () => {
    // sync === null is the feature-off shape the DI factory yields; the enabled
    // flag alone must not register a job without a service.
    make(null).onApplicationBootstrap()

    expect(registry.addCronJob).not.toHaveBeenCalled()
    expect(cronFrom).not.toHaveBeenCalled()
  })

  it('registers nothing when the config is disabled', () => {
    make(
      { runSync } as unknown as LdapSyncService,
      { enabled: false } as unknown as LdapSyncConfig,
    ).onApplicationBootstrap()

    expect(registry.addCronJob).not.toHaveBeenCalled()
    expect(cronFrom).not.toHaveBeenCalled()
  })

  it('arms no job, and says so, when the schedule alone is switched off', () => {
    // LDAP_SYNC_CRON_ENABLED=false with a live service: the feature is fully
    // wired (the manual endpoint shares this same service and is untouched),
    // only the unattended pass stands down. Nothing reaches the registry, so
    // there is no timer and no tick to fire.
    const logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined)

    make({ runSync } as unknown as LdapSyncService, {
      enabled: true,
      settings: { cron: '0 * * * *', cronEnabled: false },
    } as unknown as LdapSyncConfig).onApplicationBootstrap()

    expect(registry.addCronJob).not.toHaveBeenCalled()
    expect(cronFrom).not.toHaveBeenCalled()
    expect(runSync).not.toHaveBeenCalled()
    // The startup log is the only signal an operator gets, so it must name the
    // variable rather than leave the usual "scheduled" line silently missing.
    expect(logged(logSpy, 'LDAP_SYNC_CRON_ENABLED=false')).toBe(true)
    expect(logged(logSpy, 'Directory sync scheduled')).toBe(false)
    logSpy.mockRestore()
  })

  it('runs the sync on a tick, logging completion and writing no failure row', async () => {
    const logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined)
    make({ runSync } as unknown as LdapSyncService).onApplicationBootstrap()

    await tick()()

    expect(runSync).toHaveBeenCalledTimes(1)
    expect(recordDirectorySyncFailed).not.toHaveBeenCalled()
    expect(logged(logSpy, 'completed')).toBe(true)
    expect(logged(logSpy, 'another run holds the lock')).toBe(false)
    logSpy.mockRestore()
  })

  it('only logs the lock skip (no audit) when a tick finds another run holding the lock', async () => {
    runSync.mockResolvedValue({ status: 'already-running' })
    const logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined)
    make({ runSync } as unknown as LdapSyncService).onApplicationBootstrap()

    await tick()()

    expect(runSync).toHaveBeenCalledTimes(1)
    expect(recordDirectorySyncFailed).not.toHaveBeenCalled()
    expect(logged(logSpy, 'another run holds the lock')).toBe(true)
    logSpy.mockRestore()
  })

  it('records ldap_sync.failed and does not throw when a tick run crashes', async () => {
    runSync.mockRejectedValue(new Error('LDAP down'))
    make({ runSync } as unknown as LdapSyncService).onApplicationBootstrap()

    // tick swallows the error (no retry — the next tick is the retry).
    await expect(tick()()).resolves.toBeUndefined()
    // A scheduled pass has no screen at all, so the worded cause exists only
    // here: without it the row would carry whatever the driver happened to say.
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'LDAP down',
      summary: expect.stringContaining('The directory was read'),
    })
  })

  it('swallows a failing audit write after a crash so the cron keeps running', async () => {
    runSync.mockRejectedValue(new Error('LDAP down'))
    recordDirectorySyncFailed.mockRejectedValue(new Error('audit DB down'))
    make({ runSync } as unknown as LdapSyncService).onApplicationBootstrap()

    // Even when the best-effort crash-audit write itself throws, the tick must
    // resolve — a failing trace must never stop the schedule.
    await expect(tick()()).resolves.toBeUndefined()
    expect(recordDirectorySyncFailed).toHaveBeenCalledWith({
      error: 'LDAP down',
      summary: expect.stringContaining('The directory was read'),
    })
  })
})
