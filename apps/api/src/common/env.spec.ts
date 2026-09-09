/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveEnvironment } from './env'

describe('resolveEnvironment', () => {
  it('prefers APP_ENV over NODE_ENV', () => {
    expect(
      resolveEnvironment({ APP_ENV: 'staging', NODE_ENV: 'production' }),
    ).toBe('staging')
  })

  it('falls back to NODE_ENV when APP_ENV is unset or blank', () => {
    expect(resolveEnvironment({ NODE_ENV: 'production' })).toBe('production')
    // A stray `APP_ENV=` line in .env must not shadow NODE_ENV — this is the
    // divergence that used to make load-env skip every .env.<env> layer.
    expect(resolveEnvironment({ APP_ENV: '', NODE_ENV: 'production' })).toBe(
      'production',
    )
    expect(resolveEnvironment({ APP_ENV: '   ', NODE_ENV: 'test' })).toBe('test')
  })

  it('returns undefined when nothing is set, leaving the default to the caller', () => {
    expect(resolveEnvironment({})).toBeUndefined()
    expect(resolveEnvironment({ APP_ENV: '', NODE_ENV: ' ' })).toBeUndefined()
  })

  it('trims surrounding whitespace off the value', () => {
    expect(resolveEnvironment({ APP_ENV: ' production ' })).toBe('production')
  })
})

describe('DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV', () => {
  const original = process.env['DEV_ENVIRONMENT']

  afterEach(() => {
    if (original === undefined) {
      delete process.env['DEV_ENVIRONMENT']
    } else {
      process.env['DEV_ENVIRONMENT'] = original
    }
    vi.resetModules()
  })

  /** Re-import the module so its module-load snapshot re-reads process.env. */
  async function snapshotWith(value: string | undefined): Promise<boolean> {
    if (value === undefined) {
      delete process.env['DEV_ENVIRONMENT']
    } else {
      process.env['DEV_ENVIRONMENT'] = value
    }
    vi.resetModules()
    const mod = await import('./env')
    return mod.DEV_ENVIRONMENT_SNAPSHOT_PRE_DOTENV
  }

  it('captures the value present in process.env at module load', async () => {
    // The security gate is the snapshot, not the injected test param — so a
    // regression in how/when it is captured must fail a test, not slip
    // through because every other test passes isDevEnvironment explicitly.
    expect(await snapshotWith('true')).toBe(true)
  })

  it('is false (fail closed) for unset, blank, or non-"true" values', async () => {
    for (const value of [undefined, '', '   ', '1', 'yes', 'TRUE', 'false']) {
      expect(await snapshotWith(value)).toBe(false)
    }
  })
})
