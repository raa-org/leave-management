/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Global, Module } from '@nestjs/common'
import { AuthOidcModule } from '@trusted-modules/auth-oidc-nest'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { AuthOidcUserProfileMapper } from './auth-oidc-user-profile-mapper'
import {
  AuthOidcUserStore,
  AuthOidcUserStoreBridge,
} from './auth-oidc-user-store'

@Global()
@Module({
  imports: [
    LeaveDomainModule,
    AuthOidcModule.forRoot({
      issuerUrl: process.env['OIDC_ISSUER_URL']!,
      clientId: process.env['OIDC_CLIENT_ID']!,
      clientSecret: process.env['OIDC_CLIENT_SECRET']!,
      redirectUri: process.env['OIDC_REDIRECT_URI']!,
      jwtSecret: process.env['JWT_SECRET']!,
      scope: process.env['OIDC_SCOPE'] ?? 'openid email profile',
      jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '1h',
      cookieName: process.env['AUTH_COOKIE_NAME'] ?? 'auth_token',
      sessionSecret: process.env['SESSION_SECRET']!,
      cookiePath: process.env['BASE_PATH'] || '/',
      cookieSecure: process.env['AUTH_COOKIE_SECURE'] === 'true',
      // RP-initiated logout (auth-oidc-nest >= 1.3.0): on sign-out the module
      // clears the app cookie AND redirects to the IdP end_session_endpoint with
      // id_token_hint, terminating the Keycloak SSO session so a fresh sign-in is
      // not silently re-authenticated and a different user can log in. The
      // post_logout_redirect_uri falls back to frontendUrl below (must be a
      // registered "Valid Post Logout Redirect URI" on the Keycloak client).
      rpInitiatedLogout: true,
      // Cookie that carries the IdP id_token for the logout id_token_hint (only
      // written while rpInitiatedLogout is on). Passed explicitly because the
      // options type requires every defaulted field; value matches the module default.
      idTokenCookieName: 'auth_id_token',
      ...(process.env['FRONTEND_URL']
        ? { frontendUrl: process.env['FRONTEND_URL'] }
        : {}),
      userProfileMapper: { useClass: AuthOidcUserProfileMapper },
      userStore: { useClass: AuthOidcUserStore },
    }),
  ],
  providers: [AuthOidcUserStoreBridge],
  exports: [AuthOidcModule],
})
export class AuthOidcHostModule {}
