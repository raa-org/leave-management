/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { NotificationDto, NotificationListDto } from '@workspace/contracts'
import type { AnyAction } from 'redux'
import { EMPTY, Observable, from, of, timer } from 'rxjs'
import {
  catchError,
  concatMap,
  exhaustMap,
  map,
  retry,
  switchMap,
  takeUntil,
} from 'rxjs/operators'
import { type Epic, ofType } from 'redux-observable'
import type { AppEpicDependencies } from '../employee/employee-feature.store'
import { EVENT_SOURCE_CLOSED } from '../../lib/event-source'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationStreamUrl,
} from './notifications-api'

export type NotificationsState = {
  status: 'idle' | 'loading' | 'succeeded' | 'failed'
  error?: string
  items: NotificationDto[]
  unreadCount: number
  openAskCount: number
  // Opaque keyset cursor for the next older page. Absent when the feed is
  // exhausted (or never loaded).
  nextCursor?: string
  // True while a load-more request is in flight. Distinct from `status` so a
  // page append never flashes the first-load skeleton over an on-screen list.
  loadingMore: boolean
  // Non-empty when the LAST load-more attempt failed; cleared by the next
  // successful page or snapshot. Separate from `error` so a page failure can
  // render inline at the list's end instead of replacing the whole panel.
  loadMoreError?: string
  // Per-item busy set, never one shared flag: the rows are independently
  // actionable, so a single flag would spin every one of them.
  markingIds: string[]
  // True while a table-wide mark-all-read is in flight. markingIds only spans
  // the LOADED rows, so it goes empty exactly when every loaded row is read
  // while older unread still exist — the case the banner button needs a
  // busy state for.
  markingAll: boolean
  // Bumped when the read-state of rows changes wholesale (mark-all-read): a
  // load-more page requested before the bump carries pre-mark rows and is
  // dropped instead of resurrecting them as unread.
  generation: number
  streamStatus: 'idle' | 'open' | 'retrying'
}

const initialState: NotificationsState = {
  status: 'idle',
  items: [],
  unreadCount: 0,
  openAskCount: 0,
  loadingMore: false,
  markingIds: [],
  markingAll: false,
  generation: 0,
  streamStatus: 'idle',
}

// Newest-first order: a row sorts before another when its (occurredAt, id)
// tuple is greater — the exact ORDER BY the server pages with.
function isOlderThan(item: NotificationDto, last: NotificationDto): boolean {
  if (item.occurredAt !== last.occurredAt) {
    return item.occurredAt < last.occurredAt
  }
  return item.notificationId < last.notificationId
}

// Range-replace: the fresh first page replaces the HEAD of the loaded list —
// every loaded row at or newer than the page's last row — while older,
// already-loaded pages stay put, so a live update never collapses the user's
// scroll. A row the server stopped serving (a resolved progress trail)
// disappears with the head it lived in; a row deeper in the kept tail may go
// stale until the next full reload — before pagination the replace showed
// nothing older at all at this moment, so the kept tail is a strict
// improvement. Counts are adopted here and ONLY here: they are table-wide and
// must never be overwritten by an older page's snapshot of them.
function mergeSnapshot(
  state: NotificationsState,
  list: NotificationListDto,
): void {
  state.status = 'succeeded'
  delete state.error
  delete state.loadMoreError
  const page = list.items
  if (page.length === 0) {
    // An empty FIRST page means the whole feed is empty — nothing older can
    // exist below an empty head. An in-flight older-page request predates
    // this emptiness and must not resurrect rows into it: bump the
    // generation so its response is dropped (unless we were already empty —
    // then there is nothing a stale page could contradict... except itself,
    // and an empty state has no cursor for one to be in flight).
    if (state.items.length > 0 || state.nextCursor) {
      state.generation += 1
    }
    state.items = []
    delete state.nextCursor
  } else {
    const last = page[page.length - 1] as NotificationDto
    const pageIds = new Set(page.map((item) => item.notificationId))
    const tail = state.items.filter(
      (item) =>
        isOlderThan(item, last) && !pageIds.has(item.notificationId),
    )
    state.items = [...page, ...tail]
    if (tail.length === 0) {
      // The page covers everything we had: continue from ITS cursor. With a
      // surviving tail the existing cursor already points beyond it and the
      // page's own cursor (into the middle of the tail) must not regress it.
      // When the cursor VALUE actually moves, its old boundary is gone and an
      // older-page request still in flight would continue from nowhere —
      // bump the generation to drop it (the next scroll re-asks cleanly).
      // An identical cursor is the common no-op refetch and drops nothing.
      if (state.nextCursor !== list.nextCursor) {
        state.generation += 1
      }
      if (list.nextCursor) {
        state.nextCursor = list.nextCursor
      } else {
        delete state.nextCursor
      }
    }
  }
  state.unreadCount = list.unreadCount
  state.openAskCount = list.openAskCount
  state.loadingMore = false
  // Whatever was in flight is answered by this snapshot.
  state.markingIds = []
  state.markingAll = false
}

export const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    // The one action every stream event collapses to. The socket says "something
    // changed"; the server says what. Always re-seeds the newest page.
    notificationsRequested(state) {
      state.status = state.status === 'succeeded' ? 'succeeded' : 'loading'
      delete state.error
    },
    notificationsReceived(state, action: PayloadAction<NotificationListDto>) {
      mergeSnapshot(state, action.payload)
    },
    notificationsRequestFailed(state, action: PayloadAction<string>) {
      state.status = 'failed'
      state.error = action.payload
      state.loadingMore = false
      // Release the busy set too. Without this a failed mark-read leaves its row
      // disabled forever: MUI's .Mui-disabled sets pointer-events: none, and
      // 'Mark all read' self-disables while anything is marking, so the panel
      // would deadlock with no control left to retry from.
      state.markingIds = []
      state.markingAll = false
    },
    // Scroll-near-end asks for the next older page. No-ops if we already have
    // one in flight or there is no cursor — the epic also guards, but keeping
    // the flag here stops the UI from double-firing.
    notificationsMoreRequested(state) {
      if (!state.nextCursor || state.loadingMore) {
        return
      }
      state.loadingMore = true
      delete state.loadMoreError
    },
    notificationsMoreReceived(
      state,
      action: PayloadAction<{ list: NotificationListDto; generation: number }>,
    ) {
      state.loadingMore = false
      // A page requested before a wholesale read-state change (mark-all-read)
      // carries rows stamped unread on a server that has since read them —
      // drop it rather than resurrect them; the user's next scroll re-asks
      // with the still-valid cursor.
      if (action.payload.generation !== state.generation) {
        return
      }
      delete state.loadMoreError
      const list = action.payload.list
      // Dedupe by id: a malformed cursor that fell back to the first page, or
      // a merge seam overlapping an append, must not double-render.
      const seen = new Set(state.items.map((item) => item.notificationId))
      let added = 0
      for (const item of list.items) {
        if (!seen.has(item.notificationId)) {
          state.items.push(item)
          seen.add(item.notificationId)
          added += 1
        }
      }
      // Counts are NOT adopted here: they are table-wide figures owned by the
      // snapshot path, and this response may be older than the last snapshot.
      //
      // No new rows means the cursor was stale or decoded to the first page —
      // drop it so the load-more trigger cannot spin forever on the same page.
      if (added === 0 || !list.nextCursor) {
        delete state.nextCursor
      } else {
        state.nextCursor = list.nextCursor
      }
    },
    notificationsMoreFailed(state, action: PayloadAction<string>) {
      state.loadingMore = false
      // Keep the already-loaded pages; the inline row at the list's end
      // renders this and offers a retry.
      state.loadMoreError = action.payload
    },
    markReadRequested(state, action: PayloadAction<string>) {
      if (!state.markingIds.includes(action.payload)) {
        state.markingIds.push(action.payload)
      }
    },
    markAllReadRequested(state) {
      state.markingAll = true
      state.markingIds = state.items
        .filter((item) => !item.readAt)
        .map((item) => item.notificationId)
    },
    // Mark-all is table-wide on the server, so the kept tail must not go on
    // claiming unread: stamp the TAIL rows with the read instant the
    // snapshot's own rows carry, and invalidate in-flight pages fetched
    // against the pre-mark state. Only the tail — a row created between the
    // server's mark and its snapshot read arrives genuinely unread inside the
    // fresh page and must stay so, or the badge would count an unread row the
    // list refuses to show.
    markAllReadSucceeded(state, action: PayloadAction<NotificationListDto>) {
      state.generation += 1
      mergeSnapshot(state, action.payload)
      const pageIds = new Set(
        action.payload.items.map((item) => item.notificationId),
      )
      const stamp = action.payload.items.find((item) => item.readAt)?.readAt
      if (stamp) {
        for (const item of state.items) {
          if (!item.readAt && !pageIds.has(item.notificationId)) {
            item.readAt = stamp
          }
        }
      }
    },
    streamConnectRequested(state) {
      state.streamStatus = 'retrying'
    },
    // Records a transient drop WITHOUT re-triggering the epic. Deliberately not
    // streamConnectRequested: that is the epic's own ofType trigger, so emitting
    // it would re-enter the switchMap, tear down the very connection the browser
    // was already retrying, and open a fresh EventSource with no backoff — a
    // reconnect storm on every network blip.
    streamRetrying(state) {
      state.streamStatus = 'retrying'
    },
    streamOpened(state) {
      state.streamStatus = 'open'
    },
    streamClosed(state) {
      state.streamStatus = 'idle'
    },
  },
})

export const notificationsActions = notificationsSlice.actions
export const notificationsReducer = notificationsSlice.reducer

export function createInitialNotificationsState(): NotificationsState {
  return notificationsReducer(undefined, { type: '@@INIT' })
}

type NotificationsEpic = Epic<AnyAction, AnyAction, unknown, AppEpicDependencies>

type NotificationsRoot = { notifications?: NotificationsState }

// Bursts of signals collapse to one refetch: switchMap drops a stale snapshot in
// favour of the newer one already on its way.
const notificationsRequestedEpic: NotificationsEpic = (
  action$,
  _state$,
  { fetch: fetchImpl },
) =>
  action$.pipe(
    ofType(notificationsActions.notificationsRequested.type),
    switchMap(() =>
      from(fetchNotifications(fetchImpl)).pipe(
        map((list) => notificationsActions.notificationsReceived(list)),
        catchError((error: unknown) =>
          of(notificationsActions.notificationsRequestFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

// exhaustMap: one in-flight older page at a time; scroll spam while loading is
// ignored until that page lands (or fails).
const notificationsMoreRequestedEpic: NotificationsEpic = (
  action$,
  state$,
  { fetch: fetchImpl },
) =>
  action$.pipe(
    ofType(notificationsActions.notificationsMoreRequested.type),
    exhaustMap(() => {
      const slice = (state$.value as NotificationsRoot).notifications
      const cursor = slice?.nextCursor
      if (!cursor) {
        return EMPTY
      }
      // Captured at request time: the reducer drops the page if a wholesale
      // read-state change (mark-all-read) bumped the generation meanwhile.
      const generation = slice?.generation ?? 0
      return from(fetchNotifications(fetchImpl, { cursor })).pipe(
        map((list) =>
          notificationsActions.notificationsMoreReceived({ list, generation }),
        ),
        catchError((error: unknown) =>
          of(notificationsActions.notificationsMoreFailed(getErrorMessage(error))),
        ),
      )
    }),
  )

// concatMap, not switchMap: every click must land. Dropping an in-flight
// mark-read would leave that row unread while its spinner had already stopped.
const markReadEpic: NotificationsEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(notificationsActions.markReadRequested.type),
    concatMap((action) =>
      from(
        markNotificationRead((action as PayloadAction<string>).payload, fetchImpl),
      ).pipe(
        // Mark-read returns the newest page only — same snapshot contract as a
        // full refetch — so older pages the user had scrolled into are dropped
        // until they scroll again.
        map((list) => notificationsActions.notificationsReceived(list)),
        catchError((error: unknown) =>
          of(notificationsActions.notificationsRequestFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

const markAllReadEpic: NotificationsEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(notificationsActions.markAllReadRequested.type),
    concatMap(() =>
      from(markAllNotificationsRead(fetchImpl)).pipe(
        // Not the plain snapshot action: the kept tail must be stamped read
        // and in-flight pre-mark pages invalidated (see the reducer).
        map((list) => notificationsActions.markAllReadSucceeded(list)),
        catchError((error: unknown) =>
          of(notificationsActions.notificationsRequestFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

/**
 * Holds the SSE connection open and turns every frame into a refetch.
 *
 * retry and takeUntil both sit INSIDE the switchMap on purpose. Outside, the
 * first disconnect (or React 18's StrictMode mount/unmount/mount in dev) would
 * terminate the epic for the life of the store and the bell would never
 * reconnect.
 */
// Exported by name (unlike its siblings) because the stream test must grab
// EXACTLY this epic — a positional notificationsEpics[i] lookup silently
// exercises the wrong epic the moment the array grows.
export const streamEpic: NotificationsEpic = (action$, _state$, { eventSource }) =>
  action$.pipe(
    ofType(notificationsActions.streamConnectRequested.type),
    switchMap(() =>
      new Observable<AnyAction>((subscriber) => {
        const source = eventSource(notificationStreamUrl())

        source.onopen = () => {
          subscriber.next(notificationsActions.streamOpened())
          // Refetch on every (re)connect: anything published while we were away
          // is unrecoverable from the stream, but the table still has it.
          subscriber.next(notificationsActions.notificationsRequested())
        }
        source.addEventListener('notification', () => {
          subscriber.next(notificationsActions.notificationsRequested())
        })
        // The server lost its Postgres listener and got it back, so it cannot
        // know what it missed. Same handling as a real notification.
        source.addEventListener('resync', () => {
          subscriber.next(notificationsActions.notificationsRequested())
        })
        source.onerror = () => {
          // A non-200 (an expired cookie is a 401) fails the connection outright:
          // readyState goes CLOSED and the browser does NOT retry. EventSource
          // bypasses the app's window.fetch 401 interceptor, so this is the only
          // place that can notice. Erroring hands it to the retry below, which
          // reconnects and — if the session really is gone — the next ordinary
          // fetch surfaces the 401 through the existing chokepoint.
          if (source.readyState === EVENT_SOURCE_CLOSED) {
            subscriber.error(new Error('Notification stream closed by the server.'))
            return
          }
          // Anything else is a transient drop the browser is already retrying on
          // its own timer, so this only records it. It must NOT emit this epic's
          // trigger action — redux-observable feeds epic output back into
          // action$, which would restart the switchMap and fight the browser's
          // reconnect instead of letting it finish.
          subscriber.next(notificationsActions.streamRetrying())
        }

        return () => {
          source.close()
        }
      }).pipe(
        retry({
          delay: (_error, retryCount) =>
            timer(Math.min(1_000 * 2 ** retryCount, 30_000)),
        }),
        takeUntil(action$.pipe(ofType(notificationsActions.streamClosed.type))),
      ),
    ),
  )

export const notificationsEpics = [
  notificationsRequestedEpic,
  notificationsMoreRequestedEpic,
  markReadEpic,
  markAllReadEpic,
  streamEpic,
]

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return 'Unable to load your notifications.'
}
