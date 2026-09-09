/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  UnauthorizedException,
} from '@nestjs/common'
// Nest's MessageEvent, not the DOM one: tsconfig's lib includes "dom" and
// types:["node"] does not remove it, so a bare MessageEvent resolves to the DOM
// interface, whose members this handler cannot satisfy.
import type { MessageEvent } from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser } from '@trusted-modules/auth-oidc-nest'
import type { NotificationListDto } from '@workspace/contracts'
import type { Observable } from 'rxjs'
import { NotificationService } from '../domain/notification.service'
import { NotificationListenerService } from './notification-listener.service'
import { emptyToUndefined } from '../common/parse'

/**
 * The Notification Center's read surface. Every route is scoped to the caller:
 * there is no user id in any path, and the notification id in the mark-read
 * route is matched TOGETHER with the recipient, so it can never reach someone
 * else's row.
 *
 * No @UseGuards(JwtAuthGuard) on purpose. The auth-oidc module already mounts
 * its cookie verifier as middleware on every route, which is what populates
 * @CurrentUser(); the guard instead re-extracts and re-verifies the token
 * itself, and never reads req.user at all. Adding it would duplicate identity
 * work the trusted module owns, and would reject any caller the middleware
 * authenticated by other means.
 */
@Controller('notifications')
export class NotificationCenterController {
  constructor(
    @Inject(NotificationService)
    private readonly notifications: NotificationService,
    @Inject(NotificationListenerService)
    private readonly listener: NotificationListenerService,
  ) {}

  @Get()
  getNotifications(
    @CurrentUser() currentUser: UserProfileType | undefined,
    // Opaque keyset cursor from a previous page. Omitted on the first fetch
    // and on every mark-read snapshot (those always re-seed the newest page).
    // Typed unknown, not string: Express hands Nest a string[] for a repeated
    // ?cursor=a&cursor=b, and that must degrade to the malformed-cursor
    // contract (first page), not throw on .trim().
    @Query('cursor') cursor?: unknown,
  ): Promise<NotificationListDto> {
    return this.notifications.getNotifications(requireUser(currentUser).id, {
      cursor:
        typeof cursor === 'string' ? emptyToUndefined(cursor) : undefined,
    })
  }

  /**
   * A signal, never a data channel: each event only says "refetch", and the
   * client re-reads the snapshot the other routes serve. So a dropped event
   * costs a delayed refresh, not a lost notification, and no notification body
   * can reach the wrong stream.
   *
   * The recipient is the SESSION'S user id — there is no client-supplied
   * selector. requireUser throws synchronously, before Nest commits the SSE
   * headers, so an unauthenticated caller gets a normal 401 JSON response rather
   * than a hanging text/event-stream.
   */
  @Sse('stream')
  stream(
    @CurrentUser() currentUser: UserProfileType | undefined,
  ): Observable<MessageEvent> {
    return this.listener.streamFor(requireUser(currentUser).id)
  }

  @Post(':notificationId/read')
  async markRead(
    @CurrentUser() currentUser: UserProfileType | undefined,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationListDto> {
    const user = requireUser(currentUser)
    await this.notifications.markRead(user.id, notificationId)
    // Return the fresh list rather than 204: the client's one job is to render a
    // server-computed snapshot, so handing it back saves a round trip and keeps
    // the badge and the list describing the same instant.
    return this.notifications.getNotifications(user.id)
  }

  @Post('read-all')
  async markAllRead(
    @CurrentUser() currentUser: UserProfileType | undefined,
  ): Promise<NotificationListDto> {
    const user = requireUser(currentUser)
    await this.notifications.markAllRead(user.id)
    return this.notifications.getNotifications(user.id)
  }
}

function requireUser(currentUser?: UserProfileType): UserProfileType {
  if (!currentUser) {
    throw new UnauthorizedException('Authentication required.')
  }
  return currentUser
}
