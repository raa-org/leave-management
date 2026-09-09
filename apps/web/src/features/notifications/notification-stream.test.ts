/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import { Subject } from 'rxjs'
import { StateObservable } from 'redux-observable'
import type { AnyAction } from 'redux'
import { EVENT_SOURCE_CLOSED, type EventSourceLike } from '../../lib/event-source'
import type { AppEpicDependencies } from '../employee/employee-feature.store'
import { notificationsActions, streamEpic } from './notifications.store'

type FakeSource = EventSourceLike & {
  emit: (type: string) => void
  fail: (readyState: number) => void
  open: () => void
  closed: boolean
}

function createFakeSource(): FakeSource {
  const listeners = new Map<string, () => void>()
  let state = 0
  const source: FakeSource = {
    get readyState() {
      return state
    },
    onopen: null,
    onerror: null,
    addEventListener: (type, listener) => {
      listeners.set(type, listener)
    },
    close: () => {
      source.closed = true
    },
    closed: false,
    open: () => {
      source.onopen?.()
    },
    emit: (type) => {
      listeners.get(type)?.()
    },
    fail: (readyState) => {
      state = readyState
      source.onerror?.()
    },
  }
  return source
}

function runStreamEpic(factory: () => FakeSource) {
  const action$ = new Subject<AnyAction>()
  const dispatched: AnyAction[] = []
  const sources: FakeSource[] = []
  const deps = {
    apiBaseUrl: '',
    fetch: (() => undefined) as unknown as typeof fetch,
    eventSource: () => {
      const source = factory()
      sources.push(source)
      return source
    },
  } as AppEpicDependencies

  const state$ = new StateObservable(new Subject(), {})
  const subscription = streamEpic(action$, state$, deps).subscribe((action) => {
    dispatched.push(action)
    // Feed output back into action$, exactly as redux-observable does
    // (createEpicMiddleware dispatches epic output, which re-enters the action
    // stream). Without this an epic that emits its OWN trigger action looks
    // inert here while looping in production.
    action$.next(action)
  })

  return { action$, dispatched, sources, subscription }
}

describe('notification stream epic', () => {
  it('refetches on connect and on every frame the server sends', () => {
    const { action$, dispatched, sources, subscription } =
      runStreamEpic(createFakeSource)
    action$.next(notificationsActions.streamConnectRequested())

    const source = sources[0] as FakeSource
    source.open()
    // Opening refetches: anything published while disconnected is gone from the
    // stream but still in the table.
    expect(dispatched.map((a) => a.type)).toEqual([
      notificationsActions.streamOpened.type,
      notificationsActions.notificationsRequested.type,
    ])

    // A real notification and a server-side resync collapse to the same action:
    // the stream is a signal, never a data channel.
    source.emit('notification')
    source.emit('resync')
    expect(
      dispatched.filter(
        (a) => a.type === notificationsActions.notificationsRequested.type,
      ),
    ).toHaveLength(3)

    subscription.unsubscribe()
  })

  it('closes the connection when the bell unmounts', () => {
    const { action$, sources, subscription } = runStreamEpic(createFakeSource)
    action$.next(notificationsActions.streamConnectRequested())
    const source = sources[0] as FakeSource
    expect(source.closed).toBe(false)

    action$.next(notificationsActions.streamClosed())
    expect(source.closed).toBe(true)
    subscription.unsubscribe()
  })

  it('reconnects after a sign-out and sign-in cycle', () => {
    // The regression this guards: with takeUntil OUTSIDE the switchMap, the
    // first streamClosed would end the epic for the life of the store and the
    // bell would never come back. React 18's StrictMode makes that fire on the
    // very first mount in development.
    const { action$, sources, subscription } = runStreamEpic(createFakeSource)

    action$.next(notificationsActions.streamConnectRequested())
    action$.next(notificationsActions.streamClosed())
    action$.next(notificationsActions.streamConnectRequested())

    expect(sources).toHaveLength(2)
    expect(sources[0]?.closed).toBe(true)
    expect(sources[1]?.closed).toBe(false)
    subscription.unsubscribe()
  })

  it('retries after a transient drop and after a server-closed stream', async () => {
    vi.useFakeTimers()
    try {
      const { action$, dispatched, sources, subscription } =
        runStreamEpic(createFakeSource)
      action$.next(notificationsActions.streamConnectRequested())

      // readyState CONNECTING: the browser is already retrying on its own timer,
      // so the epic must only note it and leave that connection alone. The
      // harness loops actions back, so if this branch emitted the epic's own
      // trigger it would restart the switchMap and `sources` would grow —
      // fighting the browser's reconnect with an unthrottled one of our own.
      ;(sources[0] as FakeSource).fail(0)
      expect(sources).toHaveLength(1)
      expect(sources[0]?.closed).toBe(false)
      expect(dispatched[dispatched.length - 1]?.type).toBe(
        notificationsActions.streamRetrying.type,
      )

      // readyState CLOSED means a non-200 (an expired cookie is a 401) and the
      // browser will NOT retry by itself. EventSource bypasses the app's
      // window.fetch 401 interceptor, so this branch is the only thing that can
      // notice — it errors, and retry re-establishes.
      ;(sources[0] as FakeSource).fail(EVENT_SOURCE_CLOSED)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sources.length).toBeGreaterThan(1)

      subscription.unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })
})
