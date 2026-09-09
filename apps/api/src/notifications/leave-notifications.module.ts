/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Module } from '@nestjs/common'
import { CqrsModule } from '@nestjs/cqrs'
import { TypeOrmModule } from '@nestjs/typeorm'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveNotificationDeliveryStore } from './leave-notification.delivery-store'
import {
  leaveNotificationHandlers,
} from './leave-notification.handlers'
import {
  LEAVE_NOTIFICATIONS_CONFIG,
  LeaveNotificationService,
} from './leave-notification.service'
import { NotificationCenterController } from './notification-center.controller'
import { NotificationDeliveryEntity } from './notification-delivery.entity'
import { NotificationListenerService } from './notification-listener.service'

@Module({
  imports: [
    CqrsModule,
    LeaveDomainModule,
    TypeOrmModule.forFeature([NotificationDeliveryEntity]),
  ],
  // The Notification Center's read surface. LeaveDomainModule (imported above)
  // already exports NotificationService, so no extra wiring is needed.
  controllers: [NotificationCenterController],
  providers: [
    {
      provide: LEAVE_NOTIFICATIONS_CONFIG,
      useValue: {},
    },
    LeaveNotificationDeliveryStore,
    LeaveNotificationService,
    NotificationListenerService,
    ...leaveNotificationHandlers,
  ],
  exports: [LeaveNotificationDeliveryStore, LeaveNotificationService],
})
export class LeaveNotificationsModule {}
