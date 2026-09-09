/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { ScheduleModule } from '@nestjs/schedule'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CommunicationEmailModule } from '@trusted-modules/communication-email-nest'
import { AdminLeaveModule } from './admin/admin-leave.module'
import { AppController } from './app.controller'
import { dataSourceOptions } from './database/data-source'
import { LeaveDomainModule } from './domain/leave-domain.module'
import { EmployeeModule } from './employee/employee.module'
import { AuthOidcHostModule } from './host/auth-oidc-host.module'
import { LdapSyncModule } from './ldap-sync/ldap-sync.module'
import { LeaveImportModule } from './leave-import/leave-import.module'
import { LeaveNotificationsModule } from './notifications/leave-notifications.module'

/**
 * Root module of the generated NestJS api.
 *
 * CqrsModule.forRoot() is pre-wired so trusted modules added via
 * `<Module>.forRoot()` and host code share a single EventBus /
 * CommandBus / QueryBus instance. Host services can immediately publish
 * via `EventBus.publish(new SomeEvent(...))` or subscribe via
 * `@EventsHandler(<EventClass>)` without any extra setup.
 *
 * Trusted modules import the bare `CqrsModule` (NOT forRoot) inside
 * their own forRoot(), which resolves to the same singleton registered
 * here.
 */
@Module({
  imports: [
    CqrsModule.forRoot(),
    // Enables @Cron decorators app-wide (used by the LDAP user sync).
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot(dataSourceOptions),
    LeaveDomainModule,
    AuthOidcHostModule,
    CommunicationEmailModule.forRoot({
      smtpHost: process.env['COMMUNICATION_EMAIL_SMTP_HOST'] ?? 'localhost',
      smtpPort: Number(process.env['COMMUNICATION_EMAIL_SMTP_PORT'] ?? 1025),
      smtpSecure: process.env['COMMUNICATION_EMAIL_SMTP_SECURE'] === 'true',
      ...(process.env['COMMUNICATION_EMAIL_SMTP_USER']
        ? { smtpUser: process.env['COMMUNICATION_EMAIL_SMTP_USER'] }
        : {}),
      ...(process.env['COMMUNICATION_EMAIL_SMTP_PASSWORD']
        ? { smtpPassword: process.env['COMMUNICATION_EMAIL_SMTP_PASSWORD'] }
        : {}),
      defaultFromEmail:
        process.env['COMMUNICATION_EMAIL_DEFAULT_FROM_EMAIL'] ??
        'noreply@example.com',
      ...(process.env['COMMUNICATION_EMAIL_DEFAULT_FROM_NAME']
        ? {
            defaultFromName:
              process.env['COMMUNICATION_EMAIL_DEFAULT_FROM_NAME'],
          }
        : {}),
    }),
    EmployeeModule,
    AdminLeaveModule,
    LdapSyncModule,
    LeaveImportModule,
    LeaveNotificationsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
