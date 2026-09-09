/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import Badge from '@mui/material/Badge'
import IconButton from '@mui/material/IconButton'
import Popover from '@mui/material/Popover'
import { ReactReduxContext, useDispatch, useSelector } from 'react-redux'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { sliceName } from '@trusted-modules/auth-oidc-react'
import { NotificationList } from './NotificationList'
import { playNotificationChime } from './notification-sound'
import {
  notificationsActions,
  type NotificationsState,
} from './notifications.store'

// The bell for the app-shell top bar, so every signed-in surface gets it with no
// prop threading.
//
// The two guards are copied from AccountControls, and for the same reasons —
// they are what keeps this component from breaking pages that render AppShell
// under a bare StaticRouter or under a store without these slices:
//   1. No Redux Provider at all -> ReactReduxContext is null, render nothing
//      before any useSelector runs.
//   2. A Provider whose store lacks the slices -> the null-safe selectors return
//      nothing, so we render nothing.

type BellPartialState = Record<
  string,
  { user?: UserProfileType | null } | undefined
> & {
  notifications?: NotificationsState
}

const SOUND_KEY = 'nc.sound'

export function NotificationBell() {
  const reduxContext = useContext(ReactReduxContext)
  if (!reduxContext) {
    return null
  }
  return <NotificationBellInner />
}

function NotificationBellInner() {
  const dispatch = useDispatch()
  // The id STRING, not the user object: a fresh object each render would churn
  // the effect below and reopen the stream on every render.
  const userId = useSelector(
    (state: BellPartialState) => state?.[sliceName]?.user?.id ?? null,
  )
  const notifications = useSelector(
    (state: BellPartialState) => state?.notifications ?? null,
  )
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)

  // Sound preference persists; default ON (matches the picked prototype).
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return true
    }
    return window.localStorage.getItem(SOUND_KEY) !== 'off'
  })
  const soundOnRef = useRef(soundOn)
  soundOnRef.current = soundOn
  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
      } catch {
        // storage unavailable — keep the in-memory preference
      }
      return next
    })
  }, [])

  // Opening the stream is an effect, never a render side effect. One connection
  // per signed-in session, torn down on sign-out — each EventSource permanently
  // holds one of the browser's ~6 connections per origin.
  //
  // The load is dispatched independently of the stream, not left to its onopen:
  // the table is the source of truth and the stream only accelerates it, so the
  // centre must fill even where EventSource never connects at all.
  useEffect(() => {
    if (!userId) {
      return
    }
    dispatch(notificationsActions.notificationsRequested())
    dispatch(notificationsActions.streamConnectRequested())
    return () => {
      dispatch(notificationsActions.streamClosed())
    }
  }, [userId, dispatch])

  // Play the chime + pop the bell when a genuinely NEW notification arrives.
  // "New" means an unread top row whose id was not in the PREVIOUS list at
  // all: a top-id change alone is not enough, because a refetch can REMOVE
  // the top row (a progress trail resolves and stops being served) and float
  // an older, already-seen unread row into first place — that must stay
  // silent. The initial empty -> first-page transition (no previous ids)
  // never chimes either. soundOn is read through a ref so toggling it never
  // re-runs this effect.
  const items = notifications?.items
  const knownIdsRef = useRef<Set<string> | null>(null)
  const [pinging, setPinging] = useState(false)
  useEffect(() => {
    const top = items && items.length > 0 ? items[0] : undefined
    const previousIds = knownIdsRef.current
    knownIdsRef.current = new Set(
      (items ?? []).map((item) => item.notificationId),
    )
    if (
      top &&
      !top.readAt &&
      // size > 0, not just non-null: the effect's first run sees the store's
      // initial EMPTY list and would otherwise arm an empty set, making the
      // first real snapshot chime on plain page load.
      previousIds !== null &&
      previousIds.size > 0 &&
      !previousIds.has(top.notificationId)
    ) {
      if (soundOnRef.current) {
        playNotificationChime()
      }
      setPinging(true)
    }
  }, [items])

  useEffect(() => {
    if (!pinging) {
      return
    }
    const timer = window.setTimeout(() => setPinging(false), 1200)
    return () => window.clearTimeout(timer)
  }, [pinging])

  if (!userId || !notifications) {
    return null
  }

  const open = Boolean(anchorEl)
  const close = () => setAnchorEl(null)

  return (
    <>
      <IconButton
        aria-label={
          notifications.unreadCount > 0
            ? `Notifications, ${notifications.unreadCount} unread`
            : notifications.openAskCount > 0
              ? 'Notifications, decisions waiting on you'
              : 'Notifications'
        }
        onClick={(event) => {
          setAnchorEl(event.currentTarget)
        }}
        sx={{
          // Ghost glyph inside the shared identity cluster (see AppShell): the
          // surrounding container carries the surface, so the bell stays
          // transparent and only lifts to a white chip on hover, matching the
          // avatar button beside it. Square 34px keyline to align with it.
          width: 34,
          height: 34,
          borderRadius: '9px',
          color: 'primary.dark',
          '&:hover': { bgcolor: 'background.paper' },
          transform: pinging ? 'scale(1.14)' : 'none',
          transition:
            'transform .18s cubic-bezier(.22,1.2,.36,1), background-color .15s ease',
        }}
      >
        {/* Two signals, same language as inside the panel: a NUMBER means
            unread, a bare DOT means "decisions are still waiting on you" once
            everything is read. Unread wins while both are true — the number
            already brings the user in. Both render through Badge in MUI's own
            geometry; in dot mode badgeContent must be OMITTED — MUI hides a
            badge whose content is 0 regardless of variant (useBadge checks
            content before variant). */}
        <Badge
          {...(notifications.unreadCount === 0 && notifications.openAskCount > 0
            ? { variant: 'dot' as const }
            : { badgeContent: notifications.unreadCount })}
          color="primary"
          max={99}
        >
          {/* Prototype .bell glyph: 1.9px stroke outline, not the Material
              filled bell. Only the glyph differs — behavior is untouched. */}
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block' }}>
            <path
              d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10.3 19a2 2 0 0 0 3.4 0"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { mt: 1, borderRadius: '16px', overflow: 'hidden' } } }}
      >
        <NotificationList
          items={notifications.items}
          unreadCount={notifications.unreadCount}
          openAskCount={notifications.openAskCount}
          status={notifications.status}
          currentUserId={userId}
          hasMore={Boolean(notifications.nextCursor)}
          loadingMore={notifications.loadingMore}
          {...(notifications.error ? { error: notifications.error } : {})}
          {...(notifications.loadMoreError
            ? { loadMoreError: notifications.loadMoreError }
            : {})}
          markingIds={notifications.markingIds}
          markingAll={notifications.markingAll}
          soundOn={soundOn}
          onToggleSound={toggleSound}
          onMarkRead={(notificationId) => {
            dispatch(notificationsActions.markReadRequested(notificationId))
          }}
          onMarkAllRead={() => {
            dispatch(notificationsActions.markAllReadRequested())
          }}
          onLoadMore={() => {
            dispatch(notificationsActions.notificationsMoreRequested())
          }}
          onClose={close}
          onNavigate={close}
        />
      </Popover>
    </>
  )
}
