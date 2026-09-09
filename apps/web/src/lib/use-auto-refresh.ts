/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useRef, useState } from 'react'

// Shared cadence for the balance-bearing employee screens: how often they
// silently re-fetch a fresh server snapshot, and how often the "updated N ago"
// label ticks.
export const DASHBOARD_REFRESH_INTERVAL_MS = 5 * 60_000
export const RELATIVE_TIME_TICK_MS = 30_000

/**
 * Re-run `callback` on a cadence tied to the component lifecycle: every
 * `intervalMs` while the tab is visible, and immediately whenever the tab
 * regains visibility or focus (so a tab left open on a stale snapshot refreshes
 * as soon as the user returns). It stays quiet while the tab is hidden to avoid
 * background polling, and tears everything down on unmount. The latest
 * `callback` is always used without resetting the interval.
 *
 * This is how the employee dashboard stays "live": the server remains the single
 * source of truth for balances, and the client simply re-fetches a fresh
 * server-computed snapshot rather than extrapolating anything itself.
 */
export function useAutoRefresh(callback: () => void, intervalMs: number): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (intervalMs <= 0 || typeof window === 'undefined') {
      return
    }
    const run = () => savedCallback.current()
    const runIfVisible = () => {
      if (document.visibilityState === 'visible') {
        run()
      }
    }

    const id = window.setInterval(runIfVisible, intervalMs)
    document.addEventListener('visibilitychange', runIfVisible)
    window.addEventListener('focus', runIfVisible)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', runIfVisible)
      window.removeEventListener('focus', runIfVisible)
    }
  }, [intervalMs])
}

/**
 * A clock that re-renders the component every `intervalMs`, returning the
 * current epoch-ms. Keeps relative-time labels ("2 min ago") ticking without a
 * data refetch. For display only — the authoritative "as of" instant always
 * comes from the server timestamp the label is measured against.
 */
export function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (intervalMs <= 0 || typeof window === 'undefined') {
      return
    }
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
