/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { ClockService } from '../domain/clock.service'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { LdapDirectoryClient } from './ldap-client'
import { type LdapSyncConfig, loadLdapSyncConfig } from './ldap-sync.config'
import { LdapSyncController } from './ldap-sync.controller'
import { LdapSyncScheduler } from './ldap-sync.scheduler'
import { LdapSyncService } from './ldap-sync.service'
import { LDAP_SYNC_CONFIG, LDAP_SYNC_SERVICE } from './ldap-sync.tokens'

/**
 * Wires the LDAP directory sync into the container. The service and its client
 * are plain classes (unit-testable without DI); this module is where they
 * finally meet the DI graph, pulling LeaveDomainService + ClockService from
 * LeaveDomainModule.
 *
 * The whole feature is gated on LDAP_SYNC_ENABLED. When it is off the factory
 * yields null and the controller answers 409, so a deployment with no directory
 * configured still boots and serves everything else. loadLdapSyncConfig runs at
 * bootstrap here, which is deliberate: an enabled-but-misconfigured environment
 * fails fast with a message naming the offending variables, rather than dying
 * later inside a scheduled run where nobody is watching.
 */
@Module({
  imports: [LeaveDomainModule],
  controllers: [LdapSyncController],
  providers: [
    // Loaded (and validated) once at bootstrap; shared by the service factory
    // and the scheduler.
    {
      provide: LDAP_SYNC_CONFIG,
      useFactory: (): LdapSyncConfig => loadLdapSyncConfig(),
    },
    {
      provide: LDAP_SYNC_SERVICE,
      useFactory: (
        config: LdapSyncConfig,
        domain: LeaveDomainService,
        clock: ClockService,
      ): LdapSyncService | null => {
        if (!config.enabled) {
          return null
        }
        return new LdapSyncService(
          new LdapDirectoryClient(config.settings),
          domain,
          clock,
        )
      },
      inject: [LDAP_SYNC_CONFIG, LeaveDomainService, ClockService],
    },
    LdapSyncScheduler,
  ],
})
export class LdapSyncModule {}
