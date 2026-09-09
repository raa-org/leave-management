/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Inject } from '@nestjs/common'
import {
  EventsHandler,
  type IEventHandler,
} from '@nestjs/cqrs'
import {
  LeaveRequestApprovedEvent,
  LeaveRequestAutoApprovedEvent,
  LeaveRequestRejectedEvent,
  LeaveRequestSubmittedEvent,
} from '@workspace/contracts'
import { LeaveNotificationService } from './leave-notification.service'

@EventsHandler(LeaveRequestSubmittedEvent)
export class LeaveRequestSubmittedNotificationHandler
  implements IEventHandler<LeaveRequestSubmittedEvent>
{
  constructor(
    @Inject(LeaveNotificationService)
    private readonly leaveNotifications: LeaveNotificationService,
  ) {}

  async handle(event: LeaveRequestSubmittedEvent): Promise<void> {
    await this.leaveNotifications.sendApprovalRequest(event)
  }
}

@EventsHandler(LeaveRequestApprovedEvent)
export class LeaveRequestApprovedNotificationHandler
  implements IEventHandler<LeaveRequestApprovedEvent>
{
  constructor(
    @Inject(LeaveNotificationService)
    private readonly leaveNotifications: LeaveNotificationService,
  ) {}

  async handle(event: LeaveRequestApprovedEvent): Promise<void> {
    await this.leaveNotifications.sendEmployeeApprovedNotification(event)
  }
}

// Its own event, deliberately not LeaveRequestApprovedEvent: that one also
// fires on every ordinary approval and on both administrator overrides, so
// hanging the copy notice off it would mail the CC list a second time on every
// request a person actually decided.
@EventsHandler(LeaveRequestAutoApprovedEvent)
export class LeaveRequestAutoApprovedNotificationHandler
  implements IEventHandler<LeaveRequestAutoApprovedEvent>
{
  constructor(
    @Inject(LeaveNotificationService)
    private readonly leaveNotifications: LeaveNotificationService,
  ) {}

  async handle(event: LeaveRequestAutoApprovedEvent): Promise<void> {
    await this.leaveNotifications.sendAutoApprovedCopyNotice(event)
  }
}

@EventsHandler(LeaveRequestRejectedEvent)
export class LeaveRequestRejectedNotificationHandler
  implements IEventHandler<LeaveRequestRejectedEvent>
{
  constructor(
    @Inject(LeaveNotificationService)
    private readonly leaveNotifications: LeaveNotificationService,
  ) {}

  async handle(event: LeaveRequestRejectedEvent): Promise<void> {
    await this.leaveNotifications.sendEmployeeRejectedNotification(event)
  }
}

// Deliberately NO handler for CommunicationEmailSentEvent / FailedEvent. Those
// events carry only subject and recipients, so a handler can do no better than
// guess which journal row they belong to, and they are published synchronously
// INSIDE commandBus.execute — that is, before the sender writes the outcome to
// the row it actually owns. A handler here would therefore reintroduce exactly
// the mis-attribution sendApprovalRequest now avoids, and it would catch
// nothing on the way: the employee emails are not journalled at all.

export const leaveNotificationHandlers = [
  LeaveRequestSubmittedNotificationHandler,
  LeaveRequestApprovedNotificationHandler,
  LeaveRequestAutoApprovedNotificationHandler,
  LeaveRequestRejectedNotificationHandler,
] as const
