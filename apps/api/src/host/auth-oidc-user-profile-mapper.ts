/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Injectable, Logger } from '@nestjs/common'
import type {
  OidcClaimsType,
  UserProfileType,
} from '@trusted-modules/auth-oidc-core'
import type { IUserProfileMapper } from '@trusted-modules/auth-oidc-nest'
import { AppRoleName, normalizeCountryCode } from '@workspace/contracts'

// Keycloak's `roles` claim carries the realm's own role names, not app role
// names. Keycloak derives them from the leaverequest-app LDAP groups, so the
// claim is the login-path mirror of directory membership: the employee role
// and the admin role each map to their app counterpart LITERALLY — being able
// to authenticate implies no role on its own (Keycloak also admits
// directory accounts that are not app users at all; a token carrying neither
// role is refused downstream in LeaveDomainService). Everything else in the
// claim (default-roles-*, offline_access, uma_authorization, ...) is Keycloak
// plumbing and is ignored.
//
// The role names are realm configuration, so like every other OIDC deployment
// knob they are env-configurable; the defaults match what the realm sends
// today.
const DEFAULT_KEYCLOAK_ADMIN_ROLE = 'lrs-admins'
const DEFAULT_KEYCLOAK_EMPLOYEE_ROLE = 'lrs-employees'

// Keycloak maps the LDAP country attribute into a custom `country` claim.
// @trusted-modules/auth-oidc-core >= 1.2.0 carries it through OidcClaimsType
// (schema passthrough + explicit field) and auth-oidc-nest forwards it to
// the user store — see docs/oidc-roles-passthrough.md for the module fix.
//
// The mapper only canonicalizes casing; whether the code is a real country
// is decided in one place — the countries reference check in
// LeaveDomainService (unknown codes are dropped there with a warning).
function normalizeCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeCountryCode(value)
  return normalized === '' ? undefined : normalized
}

@Injectable()
export class AuthOidcUserProfileMapper implements IUserProfileMapper {
  private readonly logger = new Logger(AuthOidcUserProfileMapper.name)

  private readonly keycloakAdminRole =
    process.env['OIDC_ADMIN_ROLE']?.trim() || DEFAULT_KEYCLOAK_ADMIN_ROLE

  private readonly keycloakEmployeeRole =
    process.env['OIDC_EMPLOYEE_ROLE']?.trim() || DEFAULT_KEYCLOAK_EMPLOYEE_ROLE

  constructor() {
    // The two names resolving to one role is always a deployment mistake
    // (a copy-pasted env value, or one override set to the other's default):
    // every holder of that one Keycloak role would silently get BOTH app
    // roles, visible only much later in the directory's role chips. The
    // mapper is constructed once at boot, so this refuses the start — logged
    // AND thrown, so the cause survives even if the boot error gets wrapped.
    if (this.keycloakAdminRole === this.keycloakEmployeeRole) {
      const message =
        `OIDC role mapping misconfigured: OIDC_ADMIN_ROLE and ` +
        `OIDC_EMPLOYEE_ROLE both resolve to "${this.keycloakAdminRole}", so ` +
        `one Keycloak role would grant both app roles. Set them to two ` +
        `distinct realm role names (defaults: ` +
        `"${DEFAULT_KEYCLOAK_ADMIN_ROLE}" and ` +
        `"${DEFAULT_KEYCLOAK_EMPLOYEE_ROLE}").`
      this.logger.error(message)
      throw new Error(message)
    }
  }

  mapClaims(claims: OidcClaimsType): UserProfileType {
    const email = claims.email.trim()
    const claimRoles = claims.roles ?? []
    // Literal mapping, no implication between the two: an admin-only token
    // yields [administrator] without employee — role-per-workspace is the
    // realm's call, mirrored here as-is.
    const roles: AppRoleName[] = []
    if (claimRoles.includes(this.keycloakEmployeeRole)) {
      roles.push(AppRoleName.Employee)
    }
    if (claimRoles.includes(this.keycloakAdminRole)) {
      roles.push(AppRoleName.Administrator)
    }
    // This is the only layer that ever sees the raw claim, and a non-empty
    // claim mapping to nothing is the shape a stale realm mapping produces
    // (a token still carrying an outdated role name): downstream the sign-in
    // is refused with a checklist that cannot quote the offending value, so
    // it is quoted here — next to the two names it was matched against.
    if (roles.length === 0 && claimRoles.length > 0) {
      this.logger.warn(
        `Token for subject "${claims.sub}" carries roles ` +
          `${JSON.stringify(claimRoles)}, none matching the configured ` +
          `"${this.keycloakEmployeeRole}"/"${this.keycloakAdminRole}" — no app ` +
          'role granted.',
      )
    }
    const country = normalizeCountry(claims.country)
    const hasCountryClaim =
      typeof claims.country === 'string'
        ? claims.country.trim() !== ''
        : claims.country !== undefined && claims.country !== null
    if (hasCountryClaim && country === undefined) {
      this.logger.warn(
        `Ignoring malformed country claim ${JSON.stringify(claims.country)} for subject "${claims.sub}".`,
      )
    }

    return {
      id: claims.sub,
      email,
      ...(claims.name ? { name: claims.name } : {}),
      roles,
      ...(country ? { country } : {}),
    }
  }
}
