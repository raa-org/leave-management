/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadLdapSyncConfig } from './ldap-sync.config'

/** The minimum environment for an enabled sync. */
const requiredEnv = {
  LDAP_SYNC_ENABLED: 'true',
  LDAP_URL: 'ldaps://ldap.example.com:636',
  LDAP_BIND_DN: 'cn=svc-leave,ou=services,dc=example,dc=com',
  LDAP_BIND_PASSWORD: 'secret',
  LDAP_BASE_DN: 'ou=people,dc=example,dc=com',
  LDAP_ADMIN_GROUP_DN: 'cn=lrs-admins,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
  LDAP_EMPLOYEE_GROUP_DN:
    'cn=lrs-employees,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
}

describe('loadLdapSyncConfig', () => {
  it('is disabled unless LDAP_SYNC_ENABLED is exactly "true"', () => {
    expect(loadLdapSyncConfig({}).enabled).toBe(false)
    expect(loadLdapSyncConfig({ LDAP_SYNC_ENABLED: 'false' }).enabled).toBe(false)
    // Guard against a truthy-looking value silently enabling the sync.
    expect(loadLdapSyncConfig({ LDAP_SYNC_ENABLED: '1' }).enabled).toBe(false)
  })

  it('tolerates surrounding whitespace on the enabled flag', () => {
    // A quoted "true " in .env or a docker-compose entry with a stray space
    // must not silently disable the whole sync — the flag gets the same trim
    // as every other variable in this file.
    const config = loadLdapSyncConfig({ ...requiredEnv, LDAP_SYNC_ENABLED: ' true ' })

    expect(config.enabled).toBe(true)
  })

  it('ignores the other variables while disabled, even invalid ones', () => {
    expect(
      loadLdapSyncConfig({ LDAP_PAGE_SIZE: 'abc', LDAP_SYNC_CRON: 'nonsense' })
        .enabled,
    ).toBe(false)
  })

  it('applies defaults for the optional variables', () => {
    const config = loadLdapSyncConfig(requiredEnv)

    expect(config).toEqual({
      enabled: true,
      settings: {
        url: 'ldaps://ldap.example.com:636',
        bindDn: 'cn=svc-leave,ou=services,dc=example,dc=com',
        bindPassword: 'secret',
        baseDn: 'ou=people,dc=example,dc=com',
        adminGroupDn:
          'cn=lrs-admins,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
        employeeGroupDn:
          'cn=lrs-employees,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
        userFilter: '(objectClass=inetOrgPerson)',
        pageSize: 500,
        connectTimeoutMs: 10_000,
        timeoutMs: 120_000,
        cron: '0 * * * *',
        // Defaults ON: adding LDAP_SYNC_CRON_ENABLED to the codebase must not
        // stop the schedule of a deployment that never heard of it.
        cronEnabled: true,
        skipCertVerify: false,
      },
    })
  })

  it('takes overrides for the optional variables', () => {
    const config = loadLdapSyncConfig({
      ...requiredEnv,
      LDAP_USER_FILTER: '(&(objectClass=inetOrgPerson)(!(employeeType=contractor)))',
      LDAP_PAGE_SIZE: '250',
      LDAP_CONNECT_TIMEOUT_MS: '3000',
      LDAP_TIMEOUT_MS: '45000',
      LDAP_SYNC_CRON: '*/15 * * * *',
    })

    expect(config.enabled && config.settings).toMatchObject({
      userFilter: '(&(objectClass=inetOrgPerson)(!(employeeType=contractor)))',
      pageSize: 250,
      connectTimeoutMs: 3000,
      timeoutMs: 45_000,
      cron: '*/15 * * * *',
    })
  })

  it('refuses a timeout that would mean "wait forever"', () => {
    // Zero is ldapts' own "no timeout", which is the state these settings
    // exist to prevent — an unreachable host would hold the request until the
    // operating system gave up.
    expect(() =>
      loadLdapSyncConfig({ ...requiredEnv, LDAP_CONNECT_TIMEOUT_MS: '0' }),
    ).toThrow(/LDAP_CONNECT_TIMEOUT_MS must be a positive integer/)
    expect(() =>
      loadLdapSyncConfig({ ...requiredEnv, LDAP_TIMEOUT_MS: 'soon' }),
    ).toThrow(/LDAP_TIMEOUT_MS must be a positive integer/)
  })

  it('refuses a timeout larger than a timer can hold', () => {
    // Node clamps a setTimeout delay above 2^31 − 1 ms to 1 ms, so a larger
    // value would not wait longer — it would fail every LDAP message instantly
    // and blame the directory server for an env-file typo.
    expect(() =>
      loadLdapSyncConfig({ ...requiredEnv, LDAP_TIMEOUT_MS: '2147483648' }),
    ).toThrow(/LDAP_TIMEOUT_MS must be a positive integer/)

    // The largest representable delay itself is still accepted.
    const config = loadLdapSyncConfig({
      ...requiredEnv,
      LDAP_TIMEOUT_MS: '2147483647',
    })
    expect(config.enabled && config.settings).toMatchObject({
      timeoutMs: 2_147_483_647,
    })
  })

  it('names the missing required variable', () => {
    const { LDAP_URL: _omitted, ...withoutUrl } = requiredEnv

    expect(() => loadLdapSyncConfig(withoutUrl)).toThrow(/LDAP_URL is required/)
  })

  it('reports every missing variable at once', () => {
    let message = ''
    try {
      loadLdapSyncConfig({ LDAP_SYNC_ENABLED: 'true' })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('LDAP_URL is required')
    expect(message).toContain('LDAP_BIND_DN is required')
    expect(message).toContain('LDAP_BIND_PASSWORD is required')
    expect(message).toContain('LDAP_BASE_DN is required')
    expect(message).toContain('LDAP_ADMIN_GROUP_DN is required')
    expect(message).toContain('LDAP_EMPLOYEE_GROUP_DN is required')
  })

  it('requires each group DN on its own — there is no groups-less mode', () => {
    // Deliberately NO groups-less fallback: a deployment that lost one of
    // these lines would otherwise quietly provision every directory entry,
    // guest and test accounts included. One missing variable, named, fails
    // startup while the other one being present changes nothing.
    const { LDAP_ADMIN_GROUP_DN: _admin, ...withoutAdmin } = requiredEnv
    expect(() => loadLdapSyncConfig(withoutAdmin)).toThrow(
      /LDAP_ADMIN_GROUP_DN is required/,
    )

    const { LDAP_EMPLOYEE_GROUP_DN: _employee, ...withoutEmployee } = requiredEnv
    expect(() => loadLdapSyncConfig(withoutEmployee)).toThrow(
      /LDAP_EMPLOYEE_GROUP_DN is required/,
    )
  })

  it('refuses the two group DNs naming one group, even spelled differently', () => {
    // A copy-pasted value would grant every member both app roles, or —
    // pasted the other way — deactivate everyone outside the admins group;
    // the membership guards cannot see the shape, so boot must. Normalized
    // comparison: case/spacing variants of one DN are still one group.
    expect(() =>
      loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_EMPLOYEE_GROUP_DN: requiredEnv.LDAP_ADMIN_GROUP_DN,
      }),
    ).toThrow(/must name two different groups/)

    expect(() =>
      loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_EMPLOYEE_GROUP_DN:
          'CN=LRS-ADMINS, ou=leaverequest-app, ou=Roles, dc=example, dc=com',
      }),
    ).toThrow(/must name two different groups/)
  })

  it('treats a blank group DN as missing', () => {
    expect(() =>
      loadLdapSyncConfig({ ...requiredEnv, LDAP_EMPLOYEE_GROUP_DN: '   ' }),
    ).toThrow(/LDAP_EMPLOYEE_GROUP_DN is required/)
  })

  it('trims surrounding whitespace off the group DNs', () => {
    const config = loadLdapSyncConfig({
      ...requiredEnv,
      LDAP_ADMIN_GROUP_DN:
        '  cn=lrs-admins,ou=leaverequest-app,ou=Roles,dc=example,dc=com  ',
    })

    expect(config.enabled && config.settings.adminGroupDn).toBe(
      'cn=lrs-admins,ou=leaverequest-app,ou=Roles,dc=example,dc=com',
    )
  })

  it('treats a blank value as missing', () => {
    expect(() => loadLdapSyncConfig({ ...requiredEnv, LDAP_BASE_DN: '   ' })).toThrow(
      /LDAP_BASE_DN is required/,
    )
  })

  it('trims surrounding whitespace off values', () => {
    const config = loadLdapSyncConfig({
      ...requiredEnv,
      LDAP_BASE_DN: '  ou=people,dc=example,dc=com  ',
    })

    expect(config.enabled && config.settings.baseDn).toBe(
      'ou=people,dc=example,dc=com',
    )
  })

  it('preserves whitespace inside the bind password', () => {
    // A quoted "  pass  " in .env survives dotenv with its spaces; they are
    // part of the password and must reach the bind untouched.
    const config = loadLdapSyncConfig({
      ...requiredEnv,
      LDAP_BIND_PASSWORD: '  s3cret ',
    })

    expect(config.enabled && config.settings.bindPassword).toBe('  s3cret ')
  })

  it('treats a whitespace-only bind password as missing', () => {
    expect(() =>
      loadLdapSyncConfig({ ...requiredEnv, LDAP_BIND_PASSWORD: '   ' }),
    ).toThrow(/LDAP_BIND_PASSWORD is required/)
  })

  it('rejects a non-numeric or non-positive page size', () => {
    // '1e3' and '0x10' are numbers to Number(), but not decimal integers —
    // an .env typo must not slip through as a surprising page size.
    for (const pageSize of ['abc', '0', '-1', '1.5', '1e3', '0x10']) {
      expect(() =>
        loadLdapSyncConfig({ ...requiredEnv, LDAP_PAGE_SIZE: pageSize }),
      ).toThrow(/LDAP_PAGE_SIZE must be a positive integer/)
    }
  })

  it('rejects an invalid cron expression', () => {
    // Shapes and field values the cron library itself refuses: intervals,
    // wrong field counts, out-of-range minutes, garbage tokens.
    for (const cron of ['5m', '* * * *', '* * * * * * *', '99 * * * *', 'a b c d e']) {
      expect(() =>
        loadLdapSyncConfig({ ...requiredEnv, LDAP_SYNC_CRON: cron }),
      ).toThrow(/LDAP_SYNC_CRON is not a valid cron expression/)
    }
  })

  it('accepts every cron form the scheduler library accepts', () => {
    // 6-field (with seconds) and named macros are all valid to the cron
    // package @nestjs/schedule registers jobs with — the config must not be
    // stricter than the library.
    for (const cron of ['0 0 * * * *', '@daily', '@hourly']) {
      const config = loadLdapSyncConfig({ ...requiredEnv, LDAP_SYNC_CRON: cron })

      expect(config.enabled && config.settings.cron).toBe(cron)
    }
  })

  describe('LDAP_SYNC_CRON_ENABLED', () => {
    it('switches the schedule off on an explicit "false"', () => {
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_SYNC_CRON_ENABLED: 'false',
      })

      expect(config.enabled && config.settings.cronEnabled).toBe(false)
    })

    it('leaves the rest of the feature enabled while the schedule is off', () => {
      // The whole point of the second flag: the module still has a directory,
      // so the service is built and the manual endpoint keeps answering. Only
      // the cron job (which reads cronEnabled) stands down.
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_SYNC_CRON_ENABLED: 'false',
      })

      expect(config.enabled).toBe(true)
    })

    it('accepts an explicit "true"', () => {
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_SYNC_CRON_ENABLED: 'true',
      })

      expect(config.enabled && config.settings.cronEnabled).toBe(true)
    })

    it('tolerates surrounding whitespace', () => {
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_SYNC_CRON_ENABLED: ' false ',
      })

      expect(config.enabled && config.settings.cronEnabled).toBe(false)
    })

    it('refuses anything that is not one of the two literals', () => {
      // Unlike LDAP_SYNC_ENABLED this flag defaults to ON, so absorbing a
      // near-miss would leave the schedule running while its author believed
      // it stopped. Each of these fails startup naming the variable instead.
      for (const raw of ['False', 'FALSE', '0', 'off', 'no', 'disabled']) {
        expect(() =>
          loadLdapSyncConfig({ ...requiredEnv, LDAP_SYNC_CRON_ENABLED: raw }),
        ).toThrow(/LDAP_SYNC_CRON_ENABLED must be "true" or "false"/)
      }
    })

    it('still validates the cron expression while the schedule is off', () => {
      // Otherwise a typo sits in the environment unnoticed and only surfaces
      // on the day someone turns the schedule back on.
      expect(() =>
        loadLdapSyncConfig({
          ...requiredEnv,
          LDAP_SYNC_CRON_ENABLED: 'false',
          LDAP_SYNC_CRON: 'nonsense',
        }),
      ).toThrow(/LDAP_SYNC_CRON is not a valid cron expression/)
    })
  })

  describe('TLS', () => {
    let caDir: string
    let caPath: string

    beforeAll(() => {
      caDir = mkdtempSync(join(tmpdir(), 'ldap-ca-'))
      caPath = join(caDir, 'ca.crt')
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ntest\n')
    })

    afterAll(() => {
      rmSync(caDir, { recursive: true, force: true })
    })

    it('verifies against the system trust store when nothing is configured', () => {
      // The secure default: no options at all rather than an empty object, so
      // nothing looks like a place to loosen verification later.
      const config = loadLdapSyncConfig(requiredEnv)

      expect(config.enabled && config.settings.tlsOptions).toBeUndefined()
      expect(config.enabled && config.settings.skipCertVerify).toBe(false)
    })

    it('loads the CA file and keeps verification on', () => {
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_TLS_CA_FILE: caPath,
      })

      expect(config.enabled && config.settings.tlsOptions?.ca?.toString()).toContain(
        'BEGIN CERTIFICATE',
      )
      // Crucially NOT rejectUnauthorized:false — this is the production shape.
      expect(
        config.enabled && config.settings.tlsOptions?.rejectUnauthorized,
      ).toBeUndefined()
      expect(config.enabled && config.settings.skipCertVerify).toBe(false)
    })

    it('fails at startup when the CA file cannot be read', () => {
      expect(() =>
        loadLdapSyncConfig({
          ...requiredEnv,
          LDAP_TLS_CA_FILE: join(caDir, 'missing.crt'),
        }),
      ).toThrow(/LDAP_TLS_CA_FILE cannot be read/)
    })

    it('disables verification only on an explicit "true"', () => {
      const insecure = loadLdapSyncConfig(
        { ...requiredEnv, LDAP_TLS_SKIP_CERT_VERIFY: 'true' },
        true,
      )
      expect(insecure.enabled && insecure.settings.tlsOptions).toEqual({
        rejectUnauthorized: false,
      })
      expect(insecure.enabled && insecure.settings.skipCertVerify).toBe(true)

      // Anything else must leave verification on, even on a dev machine.
      for (const value of ['false', '1', 'yes', 'TRUE']) {
        const config = loadLdapSyncConfig(
          { ...requiredEnv, LDAP_TLS_SKIP_CERT_VERIFY: value },
          true,
        )
        expect(config.enabled && config.settings.skipCertVerify).toBe(false)
      }
    })

    it('refuses the insecure flag off a declared development machine', () => {
      // Fail closed: the real launch paths (docker-compose env_file only, the
      // Dockerfile CMD, CI) never declare DEV_ENVIRONMENT, so "not declared"
      // must count as production.
      expect(() =>
        loadLdapSyncConfig(
          { ...requiredEnv, LDAP_TLS_SKIP_CERT_VERIFY: 'true' },
          false,
        ),
      ).toThrow(/LDAP_TLS_SKIP_CERT_VERIFY=true is only honored/)
    })

    it('never gates on APP_ENV/NODE_ENV from the config env', () => {
      // The gate must not read an environment name out of the same (post-
      // dotenv) env bag as the other variables: an APP_ENV=development line
      // left in a shared .env lands in process.env on a production host that
      // sets no environment of its own, and must NOT open the gate. Only the
      // dedicated DEV_ENVIRONMENT snapshot, passed separately, decides.
      expect(() =>
        loadLdapSyncConfig(
          {
            ...requiredEnv,
            APP_ENV: 'development',
            NODE_ENV: 'development',
            DEV_ENVIRONMENT: 'true', // in the env bag = came from .env: ignored
            LDAP_TLS_SKIP_CERT_VERIFY: 'true',
          },
          false, // the pre-dotenv snapshot says: not a dev machine
        ),
      ).toThrow(/LDAP_TLS_SKIP_CERT_VERIFY=true is only honored/)
    })

    it('allows the insecure flag on a declared development machine', () => {
      const config = loadLdapSyncConfig(
        { ...requiredEnv, LDAP_TLS_SKIP_CERT_VERIFY: 'true' },
        true,
      )

      expect(config.enabled && config.settings.skipCertVerify).toBe(true)
    })

    it('does not require a dev environment when the insecure flag is off', () => {
      // Fail-closed applies to the FLAG, not to the sync: a normal verified
      // configuration must keep working on a plain production machine.
      const config = loadLdapSyncConfig(
        { ...requiredEnv, LDAP_TLS_CA_FILE: caPath },
        false,
      )

      expect(config.enabled).toBe(true)
    })

    it('requires ldaps:// — no flag or environment unlocks plaintext', () => {
      // LDAP_TLS_SKIP_CERT_VERIFY is the LDAPTLS_REQCERT=never equivalent: it
      // relaxes certificate VERIFICATION only. The transport stays encrypted,
      // so plaintext ldap:// is refused even in dev with the flag on.
      for (const overrides of [
        {},
        { LDAP_TLS_SKIP_CERT_VERIFY: 'true' },
      ]) {
        expect(() =>
          loadLdapSyncConfig(
            {
              ...requiredEnv,
              ...overrides,
              LDAP_URL: 'ldap://ldap.example.com:389',
            },
            true,
          ),
        ).toThrow(/LDAP_URL must use ldaps:\/\//)
      }
    })

    it('rejects any other URL scheme', () => {
      for (const url of [
        'https://ldap.example.com',
        'ldap.example.com:636',
        'ldapi:///',
        'not a url',
      ]) {
        expect(() =>
          loadLdapSyncConfig({ ...requiredEnv, LDAP_URL: url }),
        ).toThrow(/LDAP_URL must use ldaps:\/\//)
      }
    })

    it('accepts ldaps:// case-insensitively (scheme is case-insensitive)', () => {
      // ldapts parses the scheme via new URL().protocol, which lowercases it,
      // so an uppercase LDAPS:// connects fine — the config must not be
      // stricter than the library and reject it.
      const config = loadLdapSyncConfig({
        ...requiredEnv,
        LDAP_URL: 'LDAPS://ldap.example.com:636',
      })

      // The original string is preserved (ldapts handles the casing).
      expect(config.enabled && config.settings.url).toBe(
        'LDAPS://ldap.example.com:636',
      )
    })

    it('ignores the CA (with a warning) when verification is skipped', () => {
      // Documented workflow: a shared env carries the CA path while a dev
      // flips the flag locally. The CA must not appear in tlsOptions (it does
      // nothing), and the operator is warned so nobody thinks the server is
      // verified.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})

      const config = loadLdapSyncConfig(
        {
          ...requiredEnv,
          LDAP_TLS_SKIP_CERT_VERIFY: 'true',
          LDAP_TLS_CA_FILE: caPath,
        },
        true,
      )

      expect(config.enabled && config.settings.tlsOptions).toEqual({
        rejectUnauthorized: false,
      })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('is ignored while')
      warn.mockRestore()
    })

    it('does not fail startup on an unreadable CA when verification is skipped', () => {
      // The dev box need not have the shared CA file at all — skipping
      // verification must not turn its absence into a startup failure.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})

      const config = loadLdapSyncConfig(
        {
          ...requiredEnv,
          LDAP_TLS_SKIP_CERT_VERIFY: 'true',
          LDAP_TLS_CA_FILE: join(caDir, 'not-on-this-machine.crt'),
        },
        true,
      )

      expect(config.enabled).toBe(true)
      warn.mockRestore()
    })

    it('reports every TLS problem in one pass, not one per restart', () => {
      // Insecure flag refused (no local env) AND unreadable CA file: both
      // must appear in the same startup error — the collect-all contract.
      let message = ''
      try {
        loadLdapSyncConfig(
          {
            ...requiredEnv,
            LDAP_TLS_SKIP_CERT_VERIFY: 'true',
            LDAP_TLS_CA_FILE: join(caDir, 'missing.crt'),
          },
          false, // not a dev machine — the flag is refused
        )
      } catch (error) {
        message = (error as Error).message
      }

      expect(message).toContain('LDAP_TLS_SKIP_CERT_VERIFY=true is only honored')
      expect(message).toContain('LDAP_TLS_CA_FILE cannot be read')
    })

    it('allows production when verification is left on', () => {
      const config = loadLdapSyncConfig(
        { ...requiredEnv, LDAP_TLS_CA_FILE: caPath },
        false,
      )

      expect(config.enabled).toBe(true)
    })
  })
})
