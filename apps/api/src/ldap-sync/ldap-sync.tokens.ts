/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * DI token for the directory-sync service. The module's factory yields `null`
 * when `LDAP_SYNC_ENABLED` is not `'true'`, so every injector receives
 * `LdapSyncService | null` and must handle the disabled deployment explicitly.
 * A dedicated token (not the class) is what lets the provider be null.
 */
export const LDAP_SYNC_SERVICE = Symbol('LDAP_SYNC_SERVICE')

/**
 * DI token for the once-loaded LdapSyncConfig. Both the service factory and the
 * scheduler read it, so loadLdapSyncConfig() runs (and validates) exactly once
 * at bootstrap.
 */
export const LDAP_SYNC_CONFIG = Symbol('LDAP_SYNC_CONFIG')
