/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Logger } from '@nestjs/common'
import type { OidcClaimsType } from '@trusted-modules/auth-oidc-core'
import { AppRoleName } from '@workspace/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthOidcUserProfileMapper } from './auth-oidc-user-profile-mapper'

// Keycloak roles as they actually arrive in the ID token: realm system
// roles plus, for app users, the roles derived from the leaverequest-app
// directory groups (lrs-employees / lrs-admins).
const KEYCLOAK_SYSTEM_ROLES = [
  'default-roles-example',
  'offline_access',
  'uma_authorization',
]

function buildClaims(
  extra: Record<string, unknown> = {},
): OidcClaimsType {
  return {
    sub: 'subject-1',
    email: 'user@example.com',
    name: 'Test User',
    roles: KEYCLOAK_SYSTEM_ROLES,
    ...extra,
  } as OidcClaimsType
}

describe('AuthOidcUserProfileMapper', () => {
  let mapper: AuthOidcUserProfileMapper

  beforeEach(() => {
    mapper = new AuthOidcUserProfileMapper()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('maps the base profile fields from claims', () => {
    const profile = mapper.mapClaims(buildClaims())

    expect(profile).toEqual({
      id: 'subject-1',
      email: 'user@example.com',
      name: 'Test User',
      roles: [],
    })
  })

  it('maps the Keycloak employee role to AppRoleName.Employee', () => {
    const profile = mapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees'] }),
    )

    expect(profile.roles).toEqual([AppRoleName.Employee])
  })

  it('maps the Keycloak admin role to AppRoleName.Administrator without implying employee', () => {
    // Literal mirroring: an admin-only token gets no employee role — whether
    // admins also hold the employee role is decided by the directory groups,
    // not synthesized here.
    const profile = mapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-admins'] }),
    )

    expect(profile.roles).toEqual([AppRoleName.Administrator])
  })

  it('maps both roles for a token carrying employee and admin', () => {
    const profile = mapper.mapClaims(
      buildClaims({
        roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees', 'lrs-admins'],
      }),
    )

    expect(profile.roles).toEqual([
      AppRoleName.Employee,
      AppRoleName.Administrator,
    ])
  })

  it('grants no app roles for a user with only Keycloak system roles', () => {
    const profile = mapper.mapClaims(buildClaims())

    expect(profile.roles).toEqual([])
  })

  it('grants no app roles when the roles claim is absent', () => {
    const profile = mapper.mapClaims(buildClaims({ roles: undefined }))

    expect(profile.roles).toEqual([])
  })

  it('honors the OIDC_ADMIN_ROLE env override for the admin role name', () => {
    vi.stubEnv('OIDC_ADMIN_ROLE', 'custom-realm-admin')
    const overriddenMapper = new AuthOidcUserProfileMapper()

    const admin = overriddenMapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'custom-realm-admin'] }),
    )
    expect(admin.roles).toEqual([AppRoleName.Administrator])

    // The default role name no longer grants admin once overridden.
    const defaultNamed = overriddenMapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-admins'] }),
    )
    expect(defaultNamed.roles).toEqual([])
  })

  it('honors the OIDC_EMPLOYEE_ROLE env override for the employee role name', () => {
    vi.stubEnv('OIDC_EMPLOYEE_ROLE', 'custom-realm-employee')
    const overriddenMapper = new AuthOidcUserProfileMapper()

    const employee = overriddenMapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'custom-realm-employee'] }),
    )
    expect(employee.roles).toEqual([AppRoleName.Employee])

    // The default role name no longer grants employee once overridden.
    const defaultNamed = overriddenMapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees'] }),
    )
    expect(defaultNamed.roles).toEqual([])
  })

  it('warns with the raw claim when a non-empty roles claim maps to nothing', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)

    // A stale realm mapping: the token carries an outdated role name. The
    // warn must quote it — no other layer ever sees the raw claim, and the
    // downstream refusal checklist cannot name the offending value.
    mapper.mapClaims(
      buildClaims({
        roles: [...KEYCLOAK_SYSTEM_ROLES, 'leaverequest-app-admin'],
      }),
    )
    const logged = warn.mock.calls.map((call) => call[0]).join('\n')
    expect(logged).toContain('leaverequest-app-admin')
    expect(logged).toContain('lrs-admins')

    // A token that maps to at least one app role stays quiet, and so does a
    // token with no roles claim at all — there is nothing to quote.
    warn.mockClear()
    mapper.mapClaims(
      buildClaims({ roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-admins'] }),
    )
    mapper.mapClaims(buildClaims({ roles: undefined }))
    mapper.mapClaims(buildClaims({ roles: [] }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses to construct when an override collides with the other default', () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)
    // The copy-paste shape: OIDC_EMPLOYEE_ROLE set to the admin default. One
    // Keycloak role granting both app roles is never a deliberate setup, so
    // the mapper must refuse the boot instead of mapping it silently.
    vi.stubEnv('OIDC_EMPLOYEE_ROLE', 'lrs-admins')

    expect(() => new AuthOidcUserProfileMapper()).toThrow(
      'OIDC_ADMIN_ROLE and OIDC_EMPLOYEE_ROLE both resolve to "lrs-admins"',
    )
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('refuses to construct when both overrides name the same role', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.stubEnv('OIDC_ADMIN_ROLE', 'shared-role')
    vi.stubEnv('OIDC_EMPLOYEE_ROLE', 'shared-role')

    expect(() => new AuthOidcUserProfileMapper()).toThrow(
      'both resolve to "shared-role"',
    )
  })

  it('falls back to the default role names when an override is empty or blank', () => {
    // '' and whitespace mean "not configured", not "match the empty role
    // name": the fallback fires on any blank value, so the default names
    // keep mapping.
    vi.stubEnv('OIDC_ADMIN_ROLE', '')
    vi.stubEnv('OIDC_EMPLOYEE_ROLE', '   ')
    const blankOverridesMapper = new AuthOidcUserProfileMapper()

    const profile = blankOverridesMapper.mapClaims(
      buildClaims({
        roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees', 'lrs-admins'],
      }),
    )

    expect(profile.roles).toEqual([
      AppRoleName.Employee,
      AppRoleName.Administrator,
    ])
  })

  it('normalizes a valid country claim to an upper-case ISO code', () => {
    const profile = mapper.mapClaims(buildClaims({ country: ' ua ' }))

    expect(profile.country).toBe('UA')
  })

  it('keeps an already normalized country claim as is', () => {
    const profile = mapper.mapClaims(buildClaims({ country: 'PL' }))

    expect(profile.country).toBe('PL')
  })

  it('omits the country field when the claim is absent', () => {
    const profile = mapper.mapClaims(buildClaims())

    expect('country' in profile).toBe(false)
  })

  it.each([
    ['empty string', ''],
    ['blank string', '   '],
    ['number', 42],
    ['null', null],
    ['object', { code: 'UA' }],
  ])('omits the country field for a non-string or blank claim (%s)', (_label, value) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const profile = mapper.mapClaims(buildClaims({ country: value }))

    expect('country' in profile).toBe(false)
  })

  it.each([
    ['three-letter code', 'UKR', 'UKR'],
    ['full country name', ' ukraine ', 'UKRAINE'],
    ['digits', '42', '42'],
  ])(
    'passes a non-empty string claim through as-is for the domain reference check (%s)',
    (_label, value, expected) => {
      const profile = mapper.mapClaims(buildClaims({ country: value }))

      // Validity is owned by the countries reference in LeaveDomainService;
      // the mapper only canonicalizes casing.
      expect(profile.country).toBe(expected)
    },
  )

  it('warns about a non-string country claim but stays silent for an absent or blank one', () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    // A matched app role keeps the roles-mapped-to-nothing warn quiet, so
    // the counts below are about the country claim alone.
    const roles = [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees']

    mapper.mapClaims(buildClaims({ country: 42, roles }))
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockClear()
    mapper.mapClaims(buildClaims({ roles }))
    mapper.mapClaims(buildClaims({ country: '   ', roles }))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not regress role mapping when a country claim is present', () => {
    const profile = mapper.mapClaims(
      buildClaims({
        country: 'UA',
        roles: [...KEYCLOAK_SYSTEM_ROLES, 'lrs-employees', 'lrs-admins'],
      }),
    )

    expect(profile.roles).toEqual([
      AppRoleName.Employee,
      AppRoleName.Administrator,
    ])
  })
})
