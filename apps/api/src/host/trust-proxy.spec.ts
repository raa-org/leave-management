/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { resolveTrustProxy } from './trust-proxy'

describe('resolveTrustProxy', () => {
  describe('without an explicit flag', () => {
    it('trusts loopback and the private ranges under NODE_ENV=production', () => {
      // uniquelocal is what actually matches: behind Docker's port NAT the
      // peer address is the bridge gateway, not 127.0.0.1.
      expect(resolveTrustProxy({ NODE_ENV: 'production' })).toBe(
        'loopback, uniquelocal',
      )
    })

    it('trusts nothing when NODE_ENV is anything else', () => {
      expect(resolveTrustProxy({ NODE_ENV: 'development' })).toBeNull()
      expect(resolveTrustProxy({ NODE_ENV: 'staging' })).toBeNull()
    })

    it('trusts nothing when NODE_ENV is unset', () => {
      // APP_ENV drives which .env file is loaded and deliberately does not
      // enable proxy trust on its own.
      expect(resolveTrustProxy({ APP_ENV: 'production' })).toBeNull()
    })

    it('treats a blank flag as absent', () => {
      expect(
        resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: '   ' }),
      ).toBe('loopback, uniquelocal')
    })
  })

  describe('with an explicit flag', () => {
    it('turns trust off even under NODE_ENV=production', () => {
      // The rollback lever: no image rebuild, just recreate the container.
      for (const value of ['false', '0', 'off', 'no', 'FALSE', 'Off']) {
        expect(
          resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: value }),
        ).toBeNull()
      }
    })

    it('turns trust on outside production', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true)
      expect(resolveTrustProxy({ TRUST_PROXY: 'TRUE' })).toBe(true)
    })

    it('reads a bare integer as a hop count', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(1)
      expect(resolveTrustProxy({ TRUST_PROXY: '2' })).toBe(2)
    })

    it('passes preset names and CIDR lists through untouched', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: 'loopback' })).toBe('loopback')
      expect(resolveTrustProxy({ TRUST_PROXY: '172.18.0.0/16' })).toBe(
        '172.18.0.0/16',
      )
      expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.1, 10.0.0.2' })).toBe(
        '10.0.0.1, 10.0.0.2',
      )
    })

    it('trims surrounding whitespace', () => {
      expect(resolveTrustProxy({ TRUST_PROXY: '  loopback  ' })).toBe(
        'loopback',
      )
    })

    it('overrides the production default', () => {
      expect(
        resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'loopback' }),
      ).toBe('loopback')
    })
  })
})
