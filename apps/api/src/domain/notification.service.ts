/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, IsNull } from 'typeorm'
import type {
  NotificationDto,
  NotificationListDto,
} from '@workspace/contracts'
import { NotificationType } from '@workspace/contracts'
import { ClockService } from './clock.service'
import { NotificationEntity } from './entities/notification.entity'
import {
  LEAVE_NOTIFICATIONS_CHANNEL,
  encodeSignal,
} from './notification-channel'
import {
  decodeKeysetCursor,
  keysetWhere,
  takeKeysetPage,
} from './keyset-cursor'

// How many rows one feed page carries. The unread / open-ask COUNTS stay
// table-wide on every page, so a badge can never shrink just because the
// client is still scrolling older history.
const FEED_PAGE_SIZE = 50

export interface GetNotificationsQuery {
  // Opaque keyset cursor from a previous page's nextCursor. Absent / malformed
  // means the newest page (same decode-null → first-page contract as the
  // admin feeds).
  cursor?: string
}

export interface RecordNotificationInput {
  recipientUserId: string
  type: NotificationType
  requestId: string
  // Display name of the person who caused this (drives the row's avatar).
  actorLabel: string
  summary: string
  // The mutation's own instant. Required, not defaulted: a fresh clock read here
  // would let the notification disagree with the audit row it commits beside.
  occurredAt: string
  // Who caused this. Not stored — it exists so recordMany can drop a
  // notification addressed to the person who triggered it. See recordMany.
  actorUserId: string
}

export interface ResolveOpenNotificationsInput {
  requestId: string
  // Narrow to one recipient's rows (an approver resolving their OWN ask by
  // voting); omitted, every still-open row of the given types closes — the
  // terminal-outcome paths (reject, override, cancel).
  recipientUserId?: string
  // Which ask types this closure means: approval_needed, approval_progressed,
  // or both. Callers differ (a vote closes only the ask; a terminal outcome
  // closes the requester's progress trail too), so the set is theirs to name.
  types: NotificationType[]
  resolvedByUserId: string
  resolvedByLabel: string
  // Subject-less sentence recording HOW the question closed (see
  // NotificationDto.resolutionText — stored, not rendered today).
  resolutionText: string
  // The mutation's own instant, same discipline as RecordNotificationInput.
  occurredAt: string
}

/**
 * The Notification Center's write and read side. `record` is the structural twin
 * of AuditLogService.record: it takes the caller's EntityManager and runs on it,
 * so the notification commits atomically with the change it announces. That is
 * the whole guarantee behind "offline users find it at next sign-in" — a
 * notification cannot exist without its cause, and a cause cannot commit without
 * its notification.
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  private get manager(): EntityManager {
    return this.dataSource.manager
  }

  async record(
    manager: EntityManager,
    input: RecordNotificationInput,
  ): Promise<void> {
    await this.recordMany(manager, [input])
  }

  /**
   * Append notifications on the caller's transaction manager.
   *
   * Nobody is ever told about their own action. The filter lives here rather
   * than at the call sites so none of them can forget it: decide/forceDecide
   * refuse self-decision upstream and submit strips the requester's own address,
   * but removeLeaveRequestApprover has no self guard at all — an admin removing
   * an approver from their own request would otherwise notify themselves.
   *
   * Deliberately NOT wrapped in try/catch: Postgres aborts the entire
   * transaction on any statement error, so catching here would only surface as
   * "current transaction is aborted" on the next statement and hide the cause.
   * Callers pass zero recipients rather than relying on rescue.
   */
  async recordMany(
    manager: EntityManager,
    inputs: RecordNotificationInput[],
  ): Promise<void> {
    const addressed = inputs.filter(
      (input) => input.recipientUserId !== input.actorUserId,
    )
    if (addressed.length === 0) {
      return
    }

    const repo = manager.getRepository(NotificationEntity)
    const rows = addressed.map((input) =>
      repo.create({
        id: randomUUID(),
        occurredAt: input.occurredAt,
        recipientUserId: input.recipientUserId,
        type: input.type,
        requestId: input.requestId,
        actorLabel: input.actorLabel,
        summary: input.summary,
        readAt: null,
      }),
    )
    await repo.save(rows)

    // Announce on the SAME manager, which is the whole point: Postgres withholds
    // NOTIFY until the transaction COMMITS, so a listener can never be told about
    // a row a reader cannot yet see. Emitting from an in-process bus instead
    // would race the commit. pg_notify() rather than NOTIFY because NOTIFY takes
    // literal identifiers and cannot be parameterized.
    for (const row of rows) {
      await manager.query('SELECT pg_notify($1, $2)', [
        LEAVE_NOTIFICATIONS_CHANNEL,
        encodeSignal({ userId: row.recipientUserId, id: row.id }),
      ])
    }
  }

  /**
   * Close still-open ask rows for a request: stamp how their question was
   * answered. `summary` is never rewritten and `readAt` is never touched in
   * either direction — resolution is not reading, and un-reading a row would
   * lie about what the recipient has seen.
   *
   * Scoped by type on purpose: only `approval_needed` and
   * `approval_progressed` rows ever carry an open question. Outcome rows
   * (approved/rejected/cancelled) ARE answers and must stay untouched, so the
   * caller names the types it means to close instead of this method guessing.
   *
   * Announces on the same manager for every row it actually closed, exactly
   * like recordMany: the recipient's open panel refetches the snapshot and the
   * closed row re-renders — this liveness is why resolution happens at write
   * time rather than being computed at read time.
   */
  async resolveOpenRows(
    manager: EntityManager,
    input: ResolveOpenNotificationsInput,
  ): Promise<void> {
    const qb = manager
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({
        resolvedAt: input.occurredAt,
        resolvedByUserId: input.resolvedByUserId,
        resolvedByLabel: input.resolvedByLabel,
        resolutionText: input.resolutionText,
      })
      .where('"requestId" = :requestId', { requestId: input.requestId })
      .andWhere('"resolvedAt" IS NULL')
      .andWhere('"type" IN (:...types)', { types: input.types })
      .returning(['id', 'recipientUserId'])
    if (input.recipientUserId !== undefined) {
      qb.andWhere('"recipientUserId" = :recipientUserId', {
        recipientUserId: input.recipientUserId,
      })
    }

    const result = await qb.execute()
    const rows = (result.raw ?? []) as Array<{
      id: string
      recipientUserId: string
    }>
    for (const row of rows) {
      await manager.query('SELECT pg_notify($1, $2)', [
        LEAVE_NOTIFICATIONS_CHANNEL,
        encodeSignal({ userId: row.recipientUserId, id: row.id }),
      ])
    }
  }

  // Newest-first keyset pages plus the table-wide unread / open-ask counts,
  // computed together so the badge and the list always describe the same
  // instant. Pass the previous page's nextCursor to walk older history; the
  // first page (no cursor) is what mark-read / SSE refetches replace with.
  //
  // A RESOLVED approval_progressed row is not served at all — not in the list
  // and not in the count. Once the request reaches its outcome the outcome's
  // own row (approved/rejected) carries the news to the same recipient, so the
  // closed progress trail could only say it a second time; and if it counted
  // as unread the badge would demand a read the panel has nothing to show for.
  // The row itself stays in the table (the journal is append-only) — it just
  // stops being feed material. Resolved approval_NEEDED rows keep flowing:
  // for an approver "how your ask was settled" IS the news.
  async getNotifications(
    recipientUserId: string,
    query: GetNotificationsQuery = {},
  ): Promise<NotificationListDto> {
    const repo = this.manager.getRepository(NotificationEntity)
    // The served-rows predicate keeps the OR INSIDE the recipient-bound
    // conjunction rather than one recipient conjunct per OR arm (a where
    // array): Postgres does not factor a shared conjunct out of OR arms, and
    // only the factored form lets the feed index (recipientUserId, occurredAt,
    // id) answer each page with an ordered scan that stops at FEED_PAGE_SIZE
    // instead of collecting and sorting the recipient's entire history.
    const servedRows = () =>
      repo
        .createQueryBuilder('n')
        .where('n.recipientUserId = :recipientUserId', { recipientUserId })
        .andWhere('(n.type != :progressed OR n.resolvedAt IS NULL)', {
          progressed: NotificationType.ApprovalProgressed,
        })

    const pageQb = servedRows()
      .orderBy('n.occurredAt', 'DESC')
      .addOrderBy('n.id', 'DESC')
      // Over-fetch one row so takeKeysetPage can tell whether another page
      // exists without a separate COUNT of the remaining feed.
      .take(FEED_PAGE_SIZE + 1)

    const cursor = decodeKeysetCursor(query.cursor)
    if (cursor) {
      pageQb.andWhere(keysetWhere('n', 'occurredAt'), {
        cursorSortValue: cursor.sortValue,
        cursorId: cursor.id,
      })
    }

    const [rows, unreadCount, openAskCount] = await Promise.all([
      pageQb.getMany(),
      servedRows().andWhere('n.readAt IS NULL').getCount(),
      // Decisions still waiting on this recipient, table-wide: the bell's work
      // indicator must not go dark just because an open ask aged out of the
      // loaded pages. Served by the partial idx_notifications_open_asks.
      repo.count({
        where: {
          recipientUserId,
          type: NotificationType.ApprovalNeeded,
          resolvedAt: IsNull(),
        },
      }),
    ])

    const { page, nextCursor } = takeKeysetPage(rows, FEED_PAGE_SIZE, (last) => ({
      sortValue: last.occurredAt,
      id: last.id,
    }))

    return {
      items: page.map(toNotificationDto),
      unreadCount,
      openAskCount,
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  /**
   * Mark one notification read. Scoped by recipient in the WHERE clause, so an
   * id belonging to someone else simply matches nothing — the id from the URL
   * never confers access.
   *
   * A query builder rather than repo.update: `readAt` carries
   * isoDateTimeTransformer, and repo.update runs that transformer over its
   * CRITERIA too, so an `IsNull()` guard there becomes new Date(FindOperator) —
   * an Invalid Date that reaches Postgres as "0NaN-NaN-NaN...". The builder's
   * where clause is raw SQL and is left alone.
   */
  async markRead(recipientUserId: string, notificationId: string): Promise<void> {
    await this.unreadOf(recipientUserId)
      .andWhere('id = :notificationId', { notificationId })
      .execute()
  }

  // Table-wide by design: it clears what the badge counts, not what the panel
  // happens to be showing.
  async markAllRead(recipientUserId: string): Promise<void> {
    await this.unreadOf(recipientUserId).execute()
  }

  // Stamp-as-read, scoped to one recipient's still-unread rows. The IS NULL
  // guard keeps a re-read from overwriting the original read time.
  private unreadOf(recipientUserId: string) {
    return this.manager
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({ readAt: this.clock.nowIso() })
      .where('"recipientUserId" = :recipientUserId', { recipientUserId })
      .andWhere('"readAt" IS NULL')
  }
}

function toNotificationDto(entity: NotificationEntity): NotificationDto {
  return {
    notificationId: entity.id,
    type: entity.type,
    actorLabel: entity.actorLabel,
    summary: entity.summary,
    requestId: entity.requestId,
    occurredAt: entity.occurredAt,
    ...(entity.readAt ? { readAt: entity.readAt } : {}),
    ...(entity.resolvedAt ? { resolvedAt: entity.resolvedAt } : {}),
    // Mapped independently of resolvedAt: the FK is SET NULL, so a resolved
    // row may legitimately outlive its closer's user id while keeping the
    // label and the sentence.
    ...(entity.resolvedByUserId
      ? { resolvedByUserId: entity.resolvedByUserId }
      : {}),
    ...(entity.resolvedByLabel
      ? { resolvedByLabel: entity.resolvedByLabel }
      : {}),
    ...(entity.resolutionText
      ? { resolutionText: entity.resolutionText }
      : {}),
  }
}
