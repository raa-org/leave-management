/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { ConflictException, ForbiddenException } from '@nestjs/common'
import type { ProvisionUserInputType } from '@trusted-modules/auth-oidc-nest'
import { AppRoleName } from '@workspace/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccountDeactivatedError,
  LeaveDomainValidationError,
  LoginIdentityConflictError,
  NoApplicationAccessError,
} from '../domain/leave-domain.service'
import type { LeaveDomainService } from '../domain/leave-domain.service'
import {
  AuthOidcUserStore,
  AuthOidcUserStoreBridge,
} from './auth-oidc-user-store'

// The store is the auth boundary's error map: the auth-oidc callback rethrows
// user-store errors as-is and the app has no global exception filter, so
// whatever class leaves findOrCreate IS the HTTP outcome. These specs pin that
// map — the two access refusals become 403s, an identity conflict becomes a
// 409, and everything else stays an unwrapped domain error (a 500 for
// alerting).

const findOrCreateUserFromIdentity = vi.fn()

function buildInput(
  extra: Partial<ProvisionUserInputType> = {},
): ProvisionUserInputType {
  return {
    subject: 'oidc-subject-1',
    email: 'user@example.com',
    name: 'Test User',
    roles: [AppRoleName.Employee],
    ...extra,
  }
}

describe('AuthOidcUserStore', () => {
  let store: AuthOidcUserStore

  beforeEach(() => {
    findOrCreateUserFromIdentity.mockReset()
    // The bridge publishes the domain service through module scope; wiring a
    // fake through the real bridge keeps the spec on the production path.
    new AuthOidcUserStoreBridge({
      findOrCreateUserFromIdentity,
    } as unknown as LeaveDomainService)
    store = new AuthOidcUserStore()
  })

  it('passes the identity to the domain and maps the record to a profile', async () => {
    findOrCreateUserFromIdentity.mockResolvedValue({
      userId: 'user-1',
      email: 'user@example.com',
      displayName: 'Test User',
      roleNames: [AppRoleName.Administrator, AppRoleName.Employee],
    })

    const profile = await store.findOrCreate(
      buildInput({
        country: 'UA',
        roles: [AppRoleName.Employee, AppRoleName.Administrator],
      }),
    )

    expect(findOrCreateUserFromIdentity).toHaveBeenCalledTimes(1)
    expect(findOrCreateUserFromIdentity).toHaveBeenCalledWith({
      subject: 'oidc-subject-1',
      email: 'user@example.com',
      displayName: 'Test User',
      countryCode: 'UA',
      roles: [AppRoleName.Employee, AppRoleName.Administrator],
    })
    // The session profile carries the set the domain just synced, not the raw
    // token roles — one source, nothing to reconcile.
    expect(profile).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      roles: [AppRoleName.Administrator, AppRoleName.Employee],
    })
  })

  it('falls back to the email as the display name when the token has no name', async () => {
    findOrCreateUserFromIdentity.mockResolvedValue({
      userId: 'user-1',
      email: 'user@example.com',
      displayName: 'user@example.com',
      roleNames: [AppRoleName.Employee],
    })

    await store.findOrCreate(buildInput({ name: undefined }))

    expect(findOrCreateUserFromIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'user@example.com' }),
    )
  })

  it('maps the deactivated refusal to a 403 carrying the domain wording', async () => {
    findOrCreateUserFromIdentity.mockRejectedValue(
      new AccountDeactivatedError(
        'This account is deactivated — contact your administrator.',
      ),
    )

    const error: unknown = await store
      .findOrCreate(buildInput())
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ForbiddenException)
    // The wording is owned by the domain; the boundary must propagate it, not
    // rewrite it — support reads this exact text.
    expect((error as ForbiddenException).message).toBe(
      'This account is deactivated — contact your administrator.',
    )
    expect((error as ForbiddenException).getStatus()).toBe(403)
  })

  it('maps the no-app-role refusal to a 403 with its own wording', async () => {
    findOrCreateUserFromIdentity.mockRejectedValue(
      new NoApplicationAccessError(
        'This account has no access to the leave request system — contact your administrator.',
      ),
    )

    const error: unknown = await store
      .findOrCreate(buildInput({ roles: [] }))
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ForbiddenException)
    // Distinct from the deactivated text: this person never had an account,
    // and "deactivated" would send them hunting for one.
    expect((error as ForbiddenException).message).toBe(
      'This account has no access to the leave request system — contact your administrator.',
    )
    expect((error as ForbiddenException).getStatus()).toBe(403)
  })

  it('maps an identity conflict to a 409, not a 500', async () => {
    findOrCreateUserFromIdentity.mockRejectedValue(
      new LoginIdentityConflictError(
        'Your sign-in could not be matched to a single account — contact your administrator.',
      ),
    )

    const error: unknown = await store
      .findOrCreate(buildInput())
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ConflictException)
    expect((error as ConflictException).message).toBe(
      'Your sign-in could not be matched to a single account — contact your administrator.',
    )
    expect((error as ConflictException).getStatus()).toBe(409)
  })

  it('rethrows any other domain error untouched so alerting sees a 500', async () => {
    // The login transaction transitively runs balance/accrual logic; its
    // generic validation failures are internal data problems, not access
    // refusals — they must NOT dress up as 403s support would chase.
    const failure = new LeaveDomainValidationError(
      'Allocation would exceed the annual quota.',
    )
    findOrCreateUserFromIdentity.mockRejectedValue(failure)

    await expect(store.findOrCreate(buildInput())).rejects.toBe(failure)
  })
})
