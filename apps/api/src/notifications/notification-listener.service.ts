/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import type { MessageEvent } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { Client } from 'pg'
import { Observable, Subject, interval, merge, race, timer } from 'rxjs'
import { filter, map, startWith, takeUntil } from 'rxjs/operators'
import { DataSource } from 'typeorm'
import {
  LEAVE_NOTIFICATIONS_CHANNEL,
  type LeaveNotificationSignal,
  decodeSignal,
} from '../domain/notification-channel'

// Long enough not to be chatty, short enough to beat the idle timeout of any
// proxy in front of us.
const HEARTBEAT_MS = 25_000

// The auth cookie is verified exactly ONCE, when the stream is opened: the
// middleware maps only {id, email, name, roles} onto req.user and discards exp,
// and re-reading the cookie in host code is not ours to do. A lifetime cap is
// therefore the only honest lever — the browser reconnects automatically and the
// cookie is checked again, so an expired session can outlive itself by at most
// this long. The jitter keeps every client from reconnecting in the same second.
const STREAM_MAX_LIFETIME_MS = 15 * 60_000
const STREAM_JITTER_MS = 60_000

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Owns ONE dedicated Postgres connection that LISTENs for notification signals
 * and fans them out to every open SSE stream.
 *
 * Dedicated because LISTEN is session-scoped: a pooled connection would be
 * handed back and stop listening. This client is therefore built outside the
 * TypeORM pool — but FROM the DataSource's own options, never from the imported
 * dataSourceOptions, because NOTIFY is per-database and the test DataSource
 * points at a different database entirely.
 */
@Injectable()
export class NotificationListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationListenerService.name)
  private readonly signals$ = new Subject<LeaveNotificationSignal>()
  // Emits when LISTEN comes back after a drop. Signals fired while it was down
  // are gone forever (LISTEN/NOTIFY has no backlog), so every live stream is
  // told to refetch instead — the table is the source of truth, so a refetch
  // recovers whatever the bus missed.
  private readonly resync$ = new Subject<void>()
  private readonly shutdown$ = new Subject<void>()
  private client: Client | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private hasConnected = false
  private stopped = false

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.connect()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Ends every open stream so Nest can close their responses; without this the
    // per-stream heartbeat intervals keep the event loop alive and SIGTERM hangs.
    this.shutdown$.next()
    this.shutdown$.complete()
    this.signals$.complete()
    this.resync$.complete()
    const client = this.client
    this.client = null
    await client?.end().catch(() => undefined)
  }

  /**
   * The stream for ONE user. The id comes from the server-side session, never
   * from the client, and the filter is what keeps one user's signals out of
   * another's stream.
   */
  streamFor(userId: string): Observable<MessageEvent> {
    const notifications$ = this.signals$.pipe(
      filter((signal) => signal.userId === userId),
      map((signal): MessageEvent => ({ type: 'notification', data: signal.id })),
    )
    const resyncs$ = this.resync$.pipe(
      map((): MessageEvent => ({ type: 'resync', data: '1' })),
    )
    // Non-empty on purpose: Nest writes no data: line for an empty payload and
    // the SSE spec then drops the event entirely. Named 'heartbeat' so the
    // browser dispatches it to a listener nobody registers.
    const heartbeats$ = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: '1' })),
    )

    return merge(notifications$, resyncs$, heartbeats$).pipe(
      // Nest defers committing the response headers until the first message, so
      // without this EventSource.onopen would not fire until the first real
      // notification — possibly never. Also pins the browser's retry delay.
      startWith({ type: 'hello', data: '1', retry: 3_000 } as MessageEvent),
      takeUntil(
        race(
          timer(STREAM_MAX_LIFETIME_MS + Math.random() * STREAM_JITTER_MS),
          this.shutdown$,
        ),
      ),
    )
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return
    }
    // The DataSource the app is ACTUALLY using — in tests that is the test
    // database, and NOTIFY does not cross databases.
    const options = this.dataSource.options as {
      host?: string
      port?: number
      username?: string
      password?: string
      database?: string
    }
    const client = new Client({
      host: options.host,
      port: options.port,
      user: options.username,
      password: options.password,
      database: options.database,
    })
    client.on('error', (error) => {
      this.logger.warn(`Notification listener connection lost: ${error.message}`)
      this.scheduleReconnect()
    })
    client.on('notification', (message) => {
      const signal = decodeSignal(message.payload)
      if (signal) {
        this.signals$.next(signal)
      }
    })

    try {
      await client.connect()
      await client.query(`LISTEN ${LEAVE_NOTIFICATIONS_CHANNEL}`)
      this.client = client
      this.reconnectAttempts = 0
      if (this.hasConnected) {
        // A reconnect, not the first connect: tell live streams to refetch, since
        // anything published during the gap is unrecoverable from the bus.
        this.resync$.next()
      }
      this.hasConnected = true
    } catch (error) {
      await client.end().catch(() => undefined)
      this.logger.warn(
        `Notification listener could not connect: ${(error as Error).message}`,
      )
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempts += 1
    this.client = null
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    // Never hold the process open just to retry a best-effort accelerator.
    this.reconnectTimer.unref?.()
  }
}
