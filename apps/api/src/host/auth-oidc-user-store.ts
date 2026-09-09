/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import type {
  IUserStore,
  ProvisionUserInputType,
} from '@trusted-modules/auth-oidc-nest'
import type { AppRoleName } from '@workspace/contracts'
import {
  AccountDeactivatedError,
  LeaveDomainService,
  LoginIdentityConflictError,
  NoApplicationAccessError,
} from '../domain/leave-domain.service'

let leaveDomainServiceRef: LeaveDomainService | undefined

@Injectable()
export class AuthOidcUserStoreBridge {
  constructor(
    @Inject(LeaveDomainService)
    leaveDomainService: LeaveDomainService,
  ) {
    leaveDomainServiceRef = leaveDomainService
  }

  static getLeaveDomainService(): LeaveDomainService {
    if (!leaveDomainServiceRef) {
      throw new Error('Leave domain service is not available for OIDC user provisioning.')
    }

    return leaveDomainServiceRef
  }
}

@Injectable()
export class AuthOidcUserStore implements IUserStore {
  async findOrCreate(input: ProvisionUserInputType): Promise<UserProfileType> {
    const leaveDomainService = AuthOidcUserStoreBridge.getLeaveDomainService()
    let user
    try {
      user = await leaveDomainService.findOrCreateUserFromIdentity({
        subject: input.subject,
        email: input.email,
        displayName: input.name ?? input.email,
        countryCode: input.country,
        // Mirrored into user_roles by findOrCreateUserFromIdentity and
        // snapshotted onto the login/provision audit entries.
        roles: input.roles as AppRoleName[],
      })
    } catch (error) {
      // The auth-oidc callback rethrows user-store errors as-is, and the app
      // has no global exception filter — a bare domain error would surface as
      // an opaque 500 (and page on-call for every ex-employee's login try).
      // ONLY the two access refusals become 403s: the login transaction
      // transitively runs balance/accrual logic whose generic validation
      // errors are internal data problems — those must stay 500s so alerting
      // sees them instead of support chasing "forbidden" users.
      if (error instanceof AccountDeactivatedError) {
        throw new ForbiddenException(error.message)
      }
      // A directory account with no app role (guest/test/technical): Keycloak
      // authenticates it, the leaverequest-app groups do not admit it. Its own
      // wording — "deactivated" would describe an account that never existed.
      if (error instanceof NoApplicationAccessError) {
        throw new ForbiddenException(error.message)
      }
      // A subject/email split (or a unique-index collision) is a data anomaly
      // needing manual resolution, not a transient fault — a 409, not a 500 on
      // the on-call pager. Sits above the generic rethrow for the same reason
      // as the deactivated case.
      if (error instanceof LoginIdentityConflictError) {
        throw new ConflictException(error.message)
      }
      throw error
    }
    // Keycloak/LDAP is the single source of truth for roles. The domain has
    // just synced user_roles to this login's token (add and remove) and
    // returns the synced set — exactly the token roles, mirrored literally,
    // no second role source to reconcile. Revoking a Keycloak role therefore
    // revokes both session access and the mirrored row on the user's next
    // login; revoking the last one refuses the sign-in entirely (403 above).
    return {
      id: user.userId,
      email: user.email,
      name: user.displayName,
      roles: user.roleNames,
    }
  }
}
