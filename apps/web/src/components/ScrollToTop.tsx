/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'

// Layout effects warn under renderToString (the legacy server renderer), so
// fall back to a plain effect where there is no window to scroll anyway.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

// React Router's component <Routes> (as opposed to a data router) does not reset
// the scroll offset on navigation, so a fresh page would otherwise inherit the
// previous one's scroll position and open partway down. Bring the window back to
// the top on every path change. Keyed on pathname only: search-param changes
// (filters, pagination) must NOT yank the reader back to the top.
//
// Instant and pre-paint, deliberately NOT smooth: the shell plays a staggered
// entrance (app-rise) on every page, and a smooth glide would travel through
// the middle of the new page while its sections are still rising - two
// competing movements. The layout effect resets the offset before the browser
// paints the new route, so the entrance animation starts from a settled
// viewport with no flash of the inherited position.
export function ScrollToTop() {
  const { pathname } = useLocation()

  useIsomorphicLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return null
}
