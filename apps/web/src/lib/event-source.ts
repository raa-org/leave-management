/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// EventSource.CLOSED. Spelled out rather than read off the global so this module
// stays importable under the node test environment, where EventSource does not
// exist at all.
export const EVENT_SOURCE_CLOSED = 2

// The slice of EventSource the notification stream uses. Narrow on purpose: it
// is what a test fake has to implement, and it keeps the epic honest about what
// it may rely on.
export type EventSourceLike = {
  readonly readyState: number
  onopen: (() => void) | null
  onerror: (() => void) | null
  addEventListener: (type: string, listener: () => void) => void
  close: () => void
}

export type EventSourceFactory = (url: string) => EventSourceLike

/**
 * The real factory, resolved lazily so importing this module never touches the
 * global. Throws where EventSource does not exist rather than returning an inert
 * stub: a silently dead bell is worse than a loud failure, and the only place
 * without EventSource is a test that should be injecting a fake anyway.
 */
export function resolveEventSource(): EventSourceFactory {
  return (url: string) => {
    if (typeof EventSource === 'undefined') {
      throw new Error('EventSource is unavailable in this environment.')
    }
    // Same-origin (the /api prefix is proxied), so the auth cookie rides along
    // automatically — EventSource cannot set headers, which is precisely why the
    // stream authenticates by cookie like every other route.
    return new EventSource(url) as EventSourceLike
  }
}
