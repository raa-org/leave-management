/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react'
import BlockRoundedIcon from '@mui/icons-material/BlockRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import DoneAllRoundedIcon from '@mui/icons-material/DoneAllRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ViewAgendaOutlinedIcon from '@mui/icons-material/ViewAgendaOutlined'
import ViewHeadlineRoundedIcon from '@mui/icons-material/ViewHeadlineRounded'
import VolumeOffOutlinedIcon from '@mui/icons-material/VolumeOffOutlined'
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import ListItemButton from '@mui/material/ListItemButton'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { SxProps, Theme } from '@mui/material/styles'
import { NotificationType } from '@workspace/contracts'
import type { NotificationDto } from '@workspace/contracts'
import { Link as RouterLink, useLocation } from 'react-router-dom'
import { VariableSizeList, type ListChildComponentProps } from 'react-window'
import { formatRelativeTime } from '../../lib/leave-format'
import { segmentedControlSx } from '../employee/employee-ui'
import type { NotificationsState } from './notifications.store'
import { notificationLink } from './notification-link'
import {
  avatarColorFor,
  groupNotificationsByDay,
  isResolved,
  notificationInitials,
  notificationTypeMeta,
  partitionTabRows,
  tabCounts,
  NOTIFICATION_TABS,
  NOTIFICATION_TAB_GROUPS,
  type NotificationTab,
} from './notification-format'

type Density = 'comfortable' | 'compact'

const DENSITY_KEY = 'nc.density'

// The list's maximum pixel height. react-window needs an explicit number, so
// the old CSS cap `min(58vh, 460px)` is reproduced in code: 460 here, and the
// 58vh half via the measured viewport (see viewportHeight below).
const MAX_LIST_HEIGHT = 460
const VIEWPORT_CAP = 0.58

// Row SLOTS are deterministic on purpose: every comfortable row reserves the
// full two-line summary (a one-line row keeps a little air below), compact
// rows clamp to one line anyway — so heights are three constants and nothing
// is ever measured, re-laid-out or jumped. The comfortable slot is sized for
// py 12+12 + title ~21 + 2px gap + two 13px/1.42 summary lines ~37 + border.
const HEADER_ROW_HEIGHT = 36
const FOOTER_ROW_HEIGHT = 44
const ITEM_ROW_HEIGHT = { comfortable: 86, compact: 56 } as const

// How close to the end (in rows) before we ask for the next older page.
const LOAD_MORE_THRESHOLD = 4

export type StickySection = {
  label: string
  countLabel: string
  // How far the overlay is pushed up (px) by the next section's approaching
  // header — the classic sticky hand-off.
  shift: number
}

// Pure pick of the section whose header the sticky overlay mirrors: the last
// header at or above the scroll offset. Exported for direct testing — the
// overlay itself is just this value rendered.
export function pickStickySection(
  offsets: Array<{ label: string; countLabel: string; start: number }>,
  scrollOffset: number,
  headerHeight: number,
): StickySection | null {
  let current: StickySection | null = null
  for (let index = 0; index < offsets.length; index += 1) {
    const header = offsets[index] as (typeof offsets)[number]
    if (header.start > scrollOffset) {
      break
    }
    const next = offsets[index + 1]
    let shift = 0
    if (next) {
      const gap = next.start - scrollOffset
      shift = gap < headerHeight ? headerHeight - gap : 0
    }
    current = { label: header.label, countLabel: header.countLabel, shift }
  }
  return current
}

type VirtualRow =
  | { kind: 'header'; label: string; countLabel: string }
  // pos is the row's 1-based position among ITEM rows only, for
  // aria-posinset — headers and the footer are not part of the list's items.
  | { kind: 'item'; item: NotificationDto; pos: number }
  | { kind: 'footer'; loading: boolean; error?: string }

// The strip's tabs in visual order, for the roving-tabindex arrow keys.
const ORDERED_TABS: NotificationTab[] = NOTIFICATION_TAB_GROUPS.flatMap(
  (group) => group.tabs,
)

function readStoredDensity(): Density {
  if (typeof window === 'undefined') {
    return 'comfortable'
  }
  return window.localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
}

type NotificationListProps = {
  items: NotificationDto[]
  unreadCount: number
  // Table-wide open asks: feeds the Action needed tab pill (so it agrees with
  // the bell's dot instead of drifting as pages load) and the Pending
  // section's "N of X".
  openAskCount: number
  status: NotificationsState['status']
  error?: string
  markingIds: string[]
  // True while a table-wide mark-all-read is in flight — the banner button's
  // busy state, which markingIds (loaded rows only) cannot carry once every
  // loaded row is read while older unread still exist.
  markingAll: boolean
  soundOn: boolean
  // Opaque cursor means older pages exist; the list asks for them near the end.
  hasMore: boolean
  loadingMore: boolean
  // The last load-more failure, rendered inline at the list's end with a
  // retry — a page failure must not blank a panel that already shows rows.
  loadMoreError?: string
  // The signed-in user, so a question the viewer settled themselves wears the
  // green Done chip while one settled without them wears the neutral Closed.
  currentUserId: string
  onToggleSound: () => void
  onMarkRead: (notificationId: string) => void
  onMarkAllRead: () => void
  onLoadMore: () => void
  onClose?: () => void
  onNavigate?: () => void
  // The tab the panel opens on. Defaults to All; static render tests use it
  // to reach tab-specific chrome (the Pending section) that a click cannot
  // reach under renderToStaticMarkup.
  initialTab?: NotificationTab
}

const COUNT_PILL_SX = {
  minWidth: 18,
  height: 18,
  px: 0.625,
  borderRadius: 999,
  display: 'inline-grid',
  placeItems: 'center',
  fontSize: 11,
  fontWeight: 800,
  fontVariantNumeric: 'tabular-nums',
  bgcolor: '#eef2f8',
  color: 'text.secondary',
} as const

// Shared by the day groups and the pinned Pending section, so the two kinds of
// section header cannot drift apart visually.
const SUBHEADER_SX: SxProps<Theme> = {
  px: 2,
  py: 1,
  lineHeight: 1.4,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'text.disabled',
  bgcolor: (theme) => alpha(theme.palette.background.paper, 0.92),
  backdropFilter: 'blur(8px)',
  borderBottom: '1px solid',
  borderColor: 'divider',
}

/**
 * The panel's contents: pure and presentational, and deliberately NOT inside the
 * Popover. Portalled content renders as nothing under renderToStaticMarkup, so
 * folding this into the Popover would make every assertion about it pass
 * vacuously. Keep the split.
 *
 * Type tabs + a Comfortable/Compact density switch + an All/Unread filter, all
 * local UI state — the store stays the source of truth for the data only.
 */
export function NotificationList({
  items,
  unreadCount,
  openAskCount,
  status,
  error,
  markingIds,
  markingAll,
  soundOn,
  hasMore,
  loadingMore,
  loadMoreError,
  currentUserId,
  onToggleSound,
  onMarkRead,
  onMarkAllRead,
  onLoadMore,
  onClose,
  onNavigate,
  initialTab = 'all',
}: NotificationListProps) {
  const { pathname } = useLocation()
  const [activeTab, setActiveTab] = useState<NotificationTab>(initialTab)
  const [density, setDensity] = useState<Density>(() => readStoredDensity())
  const [readFilter, setReadFilter] = useState<'all' | 'unread'>('all')
  const listRef = useRef<VariableSizeList>(null)

  // Roving tabindex for the hand-built strip: the whole strip is ONE Tab stop
  // (the active tab), and Left/Right/Home/End move selection and focus
  // together — the exact contract role="tablist" announces to screen readers.
  const tabRefs = useRef<Partial<Record<NotificationTab, HTMLButtonElement | null>>>({})
  const onTablistKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    let next: NotificationTab | undefined
    if (event.key === 'Home') {
      next = ORDERED_TABS[0]
    } else if (event.key === 'End') {
      next = ORDERED_TABS[ORDERED_TABS.length - 1]
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const step = event.key === 'ArrowRight' ? 1 : -1
      const index = ORDERED_TABS.indexOf(activeTab)
      next =
        ORDERED_TABS[(index + step + ORDERED_TABS.length) % ORDERED_TABS.length]
    }
    if (next === undefined) {
      return
    }
    event.preventDefault()
    setActiveTab(next)
    tabRefs.current[next]?.focus()
  }

  const counts = useMemo(() => tabCounts(items), [items])
  // Only the Action needed tab pins open asks above the day groups (work must
  // not sink below old history), and the read filter narrows history only —
  // see partitionTabRows for why an open ask never hides behind Unread.
  const { pending, history } = useMemo(
    () =>
      partitionTabRows(items, {
        tab: activeTab,
        unreadOnly: readFilter === 'unread',
      }),
    [items, activeTab, readFilter],
  )
  const visibleCount = pending.length + history.length
  const groups = useMemo(
    () => groupNotificationsByDay(history, Date.now()),
    [history],
  )

  const virtualRows = useMemo((): VirtualRow[] => {
    const rows: VirtualRow[] = []
    let pos = 0
    if (pending.length > 0) {
      rows.push({
        kind: 'header',
        label: 'Pending',
        // Loaded vs table-wide, so the section and the tab pill cannot look
        // like two different answers to one question. max() guards the
        // instant a fresh ask is loaded before the counts snapshot catches up.
        countLabel: `${pending.length} of ${Math.max(openAskCount, pending.length)}`,
      })
      for (const item of pending) {
        pos += 1
        rows.push({ kind: 'item', item, pos })
      }
    }
    for (const group of groups) {
      rows.push({
        kind: 'header',
        label: group.label,
        countLabel: String(group.items.length),
      })
      for (const item of group.items) {
        pos += 1
        rows.push({ kind: 'item', item, pos })
      }
    }
    if (hasMore || loadingMore || loadMoreError) {
      rows.push({ kind: 'footer', loading: loadingMore, ...(loadMoreError ? { error: loadMoreError } : {}) })
    }
    return rows
  }, [pending, groups, hasMore, loadingMore, loadMoreError, openAskCount])

  const compact = density === 'compact'
  const itemHeight = ITEM_ROW_HEIGHT[density]

  const getItemSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (!row) {
        return itemHeight
      }
      if (row.kind === 'header') {
        return HEADER_ROW_HEIGHT
      }
      if (row.kind === 'footer') {
        return FOOTER_ROW_HEIGHT
      }
      return itemHeight
    },
    [virtualRows, itemHeight],
  )

  useEffect(() => {
    listRef.current?.resetAfterIndex(0, true)
  }, [virtualRows, density])

  const showLoading = status === 'loading' && items.length === 0
  const showError = status === 'failed' && Boolean(error) && items.length === 0
  // A refetch failing over an already-loaded list must not blank it, but it
  // must not stay silent either: the thin strip under the tabs says the list
  // may be stale.
  const showStaleWarning = status === 'failed' && Boolean(error) && items.length > 0

  const onItemsRendered = useCallback(
    ({ visibleStopIndex }: { visibleStopIndex: number }) => {
      if (
        !hasMore ||
        loadingMore ||
        Boolean(loadMoreError) ||
        virtualRows.length === 0 ||
        visibleStopIndex < virtualRows.length - 1 - LOAD_MORE_THRESHOLD
      ) {
        return
      }
      onLoadMore()
    },
    [hasMore, loadingMore, loadMoreError, virtualRows.length, onLoadMore],
  )

  // aria-setsize for the virtualized rows: -1 (unknown) while older pages may
  // still exist, the loaded count once the feed is exhausted.
  const itemSetSize = hasMore ? -1 : visibleCount

  const rowProps = useMemo(
    () => ({
      rows: virtualRows,
      pathname,
      compact,
      currentUserId,
      markingIds,
      itemSetSize,
      onMarkRead,
      onNavigate,
      onLoadMore,
    }),
    [
      virtualRows,
      pathname,
      compact,
      currentUserId,
      markingIds,
      itemSetSize,
      onMarkRead,
      onNavigate,
      onLoadMore,
    ],
  )

  const contentHeight = useMemo(() => {
    let total = 0
    for (let index = 0; index < virtualRows.length; index += 1) {
      total += getItemSize(index)
    }
    return total
  }, [virtualRows, getItemSize])

  // The old CSS cap was min(58vh, 460px); react-window needs the number, so
  // the 58vh half tracks the real viewport instead of silently dying.
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? MAX_LIST_HEIGHT : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const listHeight = Math.min(
    MAX_LIST_HEIGHT,
    Math.floor(viewportHeight * VIEWPORT_CAP),
    Math.max(contentHeight, 1),
  )

  // Auto-fill: onItemsRendered only fires when the RENDERED range changes, so
  // it goes silent when a fetched page adds no rows matching the current
  // tab/filter (nothing re-renders) or when the list is shorter than the
  // viewport (no scrollbar to move). Whenever the visible content cannot fill
  // the window and older pages exist, keep fetching until a match appears or
  // the feed is exhausted; a failed page stops the loop until Retry.
  useEffect(() => {
    if (!hasMore || loadingMore || Boolean(loadMoreError)) {
      return
    }
    if (contentHeight <= listHeight + ITEM_ROW_HEIGHT[density]) {
      onLoadMore()
    }
  }, [contentHeight, listHeight, hasMore, loadingMore, loadMoreError, density, onLoadMore])

  // ---- sticky section overlay -------------------------------------------
  // Rows are absolutely positioned by react-window, so CSS position: sticky
  // cannot work. Instead the current section's header is mirrored by ONE
  // overlay pinned to the top edge of the list viewport: binary-search the
  // last header at or above the scroll offset, and let the NEXT header push
  // the overlay out as it approaches (the classic sticky hand-off).
  const [scrollOffset, setScrollOffset] = useState(0)
  const headerOffsets = useMemo(() => {
    const offsets: Array<{ label: string; countLabel: string; start: number }> = []
    let top = 0
    for (const row of virtualRows) {
      if (row.kind === 'header') {
        offsets.push({ label: row.label, countLabel: row.countLabel, start: top })
      }
      top +=
        row.kind === 'header'
          ? HEADER_ROW_HEIGHT
          : row.kind === 'footer'
            ? FOOTER_ROW_HEIGHT
            : ITEM_ROW_HEIGHT[density]
    }
    return offsets
  }, [virtualRows, density])
  const stickyHeader = useMemo(
    () => pickStickySection(headerOffsets, scrollOffset, HEADER_ROW_HEIGHT),
    [headerOffsets, scrollOffset],
  )

  return (
    <Stack spacing={0} sx={{ width: { xs: 340, sm: 420 } }}>
      {/* Header */}
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ px: 2, pt: 1.75, pb: 1.25 }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {/* No unread caption here: the count lives in ONE place — the banner
              under the tabs — so it cannot disagree with itself. */}
          <Typography variant="h6" component="p" sx={{ lineHeight: 1.2, letterSpacing: '-0.02em' }}>
            Notifications
          </Typography>
        </Box>
        <Tooltip title={soundOn ? 'Mute notification sound' : 'Enable notification sound'}>
          <IconButton
            size="small"
            onClick={onToggleSound}
            aria-label={soundOn ? 'Mute notification sound' : 'Enable notification sound'}
            sx={(theme) => ({
              borderRadius: '8px',
              color: soundOn ? theme.palette.primary.main : theme.palette.text.secondary,
              bgcolor: soundOn ? alpha(theme.palette.primary.main, 0.1) : 'transparent',
              '&:hover': {
                bgcolor: soundOn ? alpha(theme.palette.primary.main, 0.16) : theme.palette.action.hover,
              },
            })}
          >
            {soundOn ? <VolumeUpOutlinedIcon fontSize="small" /> : <VolumeOffOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        {onClose ? (
          <IconButton
            size="small"
            onClick={onClose}
            aria-label="Close notifications"
            sx={{ borderRadius: '8px', color: 'text.secondary' }}
          >
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Stack>

      {showLoading ? (
        <Stack spacing={1} sx={{ p: 2 }}>
          <Skeleton variant="rounded" height={56} />
          <Skeleton variant="rounded" height={56} />
          <Skeleton variant="rounded" height={56} />
        </Stack>
      ) : showError ? (
        <Box sx={{ p: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      ) : (
        <>
          {/* Role-grouped tab strip. Hand-built rather than MUI Tabs: the strip
              carries overline group labels above the tab row, which Tabs cannot
              host. Every notification type belongs to exactly one viewer role,
              so the clusters answer "whose request is this about". */}
          <Box
            role="tablist"
            aria-label="Notification categories"
            className="nc-scroll"
            onKeyDown={onTablistKeyDown}
            sx={{
              display: 'flex',
              alignItems: 'stretch',
              px: 1,
              borderBottom: '1px solid',
              borderColor: 'divider',
              overflowX: 'auto',
            }}
          >
            {NOTIFICATION_TAB_GROUPS.map((group, groupIndex) => (
              <Box
                key={group.label ?? 'ungrouped'}
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  pt: 0.5,
                  ...(groupIndex > 0
                    ? { borderLeft: '1px solid', borderColor: 'divider', ml: 0.75, pl: 1 }
                    : {}),
                }}
              >
                <Typography
                  component="span"
                  sx={{
                    px: 1,
                    height: 14,
                    lineHeight: '14px',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'text.disabled',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {/* Non-breaking space keeps the ungrouped column the same
                      height, so every tab's baseline lines up. */}
                  {group.label ?? ' '}
                </Typography>
                <Stack direction="row">
                  {group.tabs.map((tab) => {
                    const spec = NOTIFICATION_TABS[tab]
                    const active = activeTab === tab
                    // Action needed is the ONLY tab that carries a number, and
                    // that number means open asks (work), not unread. Every
                    // other tab signals unread with a bare dot, so the strip
                    // holds numbers of exactly one kind and the unread COUNT
                    // belongs to the banner alone. Nothing renders at zero.
                    const hasUnreadDot = tab !== 'actionNeeded' && counts[tab] > 0
                    return (
                      <ButtonBase
                        key={tab}
                        role="tab"
                        id={`nc-tab-${tab}`}
                        aria-selected={active}
                        aria-controls="nc-tabpanel"
                        aria-label={hasUnreadDot ? `${spec.label}, has unread` : undefined}
                        tabIndex={active ? 0 : -1}
                        ref={(node: HTMLButtonElement | null) => {
                          tabRefs.current[tab] = node
                        }}
                        onClick={() => setActiveTab(tab)}
                        sx={{
                          gap: 0.75,
                          px: 1,
                          pt: '4px',
                          pb: '7px',
                          fontFamily: 'inherit',
                          fontSize: 12.5,
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          color: active ? (spec.color ?? 'primary.main') : 'text.secondary',
                          borderBottom: '2.5px solid',
                          borderColor: active ? (spec.color ?? 'primary.main') : 'transparent',
                          // ButtonBase ships outline: 0 and no focus ripple, so
                          // keyboard focus would otherwise be invisible.
                          '&.Mui-focusVisible': {
                            outline: '2px solid currentColor',
                            outlineOffset: '-2px',
                          },
                        }}
                      >
                        {spec.label}
                        {/* Table-wide, not the loaded window: the pill must
                            agree with the bell's dot and stay still while
                            older pages stream in. */}
                        {tab === 'actionNeeded' && openAskCount > 0 ? (
                          <Box component="span" sx={COUNT_PILL_SX}>
                            {openAskCount}
                          </Box>
                        ) : null}
                        {hasUnreadDot ? (
                          <Box
                            component="span"
                            aria-hidden
                            sx={{
                              alignSelf: 'flex-start',
                              mt: '3px',
                              width: 6,
                              height: 6,
                              flexShrink: 0,
                              borderRadius: '50%',
                              bgcolor: 'primary.main',
                            }}
                          />
                        ) : null}
                      </ButtonBase>
                    )
                  })}
                </Stack>
              </Box>
            ))}
          </Box>

          {/* Unread banner. Exists only while there is something unread, so the
              control and the state it acts on appear and vanish together — the
              caught-up panel carries no chrome between the tabs and the list.
              This is THE one place the unread count is spelled as a number
              (the tab dots and the bell badge only signal presence). */}
          {unreadCount > 0 ? (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={(theme) => ({
                px: 2,
                py: 0.75,
                borderBottom: '1px solid',
                borderColor: 'divider',
                bgcolor: alpha(theme.palette.primary.main, 0.06),
              })}
            >
              <Box
                aria-hidden
                sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'primary.main' }}
              />
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: 'primary.main' }}>
                {unreadCount} unread
              </Typography>
              <Box sx={{ flex: 1 }} />
              {/* The count beside the button is table-wide, and so is the
                  action; the tooltip spells that out for anyone who reads the
                  button against the currently filtered tab. */}
              <Tooltip
                title={`Marks ${unreadCount === 1 ? '1' : `all ${unreadCount}`} as read, across all tabs`}
              >
                <span>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={<DoneAllRoundedIcon />}
                    onClick={onMarkAllRead}
                    // markingAll, not markingIds: the busy set only spans
                    // loaded rows and is empty exactly when every loaded row
                    // is read while older unread keep the banner visible.
                    disabled={markingAll || markingIds.length > 0}
                    sx={{ fontWeight: 700, fontSize: 12, minHeight: 0, py: 0.25, px: 1 }}
                  >
                    Mark all read
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          ) : null}

          {showStaleWarning ? (
            <Alert severity="warning" sx={{ borderRadius: 0, py: 0.25 }}>
              {error} The list may be out of date.
            </Alert>
          ) : null}

          {/* Body — whichever branch renders IS the tabpanel the strip's
              aria-controls points at. */}
          {visibleCount === 0 ? (
            <Box
              role="tabpanel"
              id="nc-tabpanel"
              aria-labelledby={`nc-tab-${activeTab}`}
              sx={{ p: 4, textAlign: 'center' }}
            >
              {loadMoreError ? (
                // The footer's Retry lives inside the virtual list, which is
                // not mounted here — without this branch a failed page would
                // leave a perpetual "looking…" with no way out.
                <Stack spacing={1} alignItems="center">
                  <Typography variant="body2" color="error">
                    Couldn't load older notifications.
                  </Typography>
                  <Button size="small" variant="text" onClick={onLoadMore} sx={{ fontWeight: 700 }}>
                    Retry
                  </Button>
                </Stack>
              ) : hasMore || loadingMore ? (
                // Older pages may hold matches; the auto-fill effect is
                // already walking them — say so instead of a flat "nothing".
                <Stack spacing={1} alignItems="center">
                  <CircularProgress size={18} thickness={5} aria-label="Looking for older notifications" />
                  <Typography variant="body2" color="text.secondary">
                    Looking for older notifications…
                  </Typography>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {readFilter === 'unread'
                    ? 'No unread notifications in this view.'
                    : items.length === 0
                      ? 'You have no notifications yet.'
                      : 'Nothing of this type right now.'}
                </Typography>
              )}
            </Box>
          ) : (
            <Box
              role="tabpanel"
              id="nc-tabpanel"
              aria-labelledby={`nc-tab-${activeTab}`}
              className="nc-scroll"
              // position: relative anchors the sticky-section overlay; the
              // height cap lives in listHeight (58vh is measured, not CSS).
              sx={{ position: 'relative' }}
            >
              {stickyHeader ? (
                // Rows are absolutely positioned, so CSS sticky cannot work;
                // this overlay mirrors the current section's header at the
                // viewport's top edge and is pushed out by the next one. A
                // pure visual duplicate — the real header scrolls in the
                // list — so it is hidden from the accessibility tree.
                <Box
                  aria-hidden
                  sx={{
                    ...SUBHEADER_SX,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 2,
                    display: 'flex',
                    alignItems: 'center',
                    height: HEADER_ROW_HEIGHT,
                    boxSizing: 'border-box',
                    transform: `translateY(-${stickyHeader.shift}px)`,
                    // Purely decorative and it spans the scroller's scrollbar
                    // gutter — it must never swallow a click or a thumb drag.
                    pointerEvents: 'none',
                  }}
                >
                  {stickyHeader.label}
                  <Box component="span" sx={COUNT_PILL_SX} style={{ marginLeft: 8 }}>
                    {stickyHeader.countLabel}
                  </Box>
                </Box>
              ) : null}
              <VariableSizeList
                ref={listRef}
                height={listHeight}
                width="100%"
                itemCount={virtualRows.length}
                itemSize={getItemSize}
                itemData={rowProps}
                overscanCount={8}
                onItemsRendered={onItemsRendered}
                onScroll={({ scrollOffset: offset }: { scrollOffset: number }) =>
                  setScrollOffset(offset)
                }
                innerElementType={InnerList}
              >
                {VirtualRowRenderer}
              </VariableSizeList>
            </Box>
          )}

          {/* Foot: read filter + row density. */}
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ px: 2, py: 1, borderTop: '1px solid', borderColor: 'divider', bgcolor: '#f7f9fc' }}
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={readFilter}
              onChange={(_event, value: 'all' | 'unread' | null) => {
                if (value) setReadFilter(value)
              }}
              aria-label="Read filter"
              sx={{ ...segmentedControlSx, '& .MuiToggleButton-root': { px: 1.5, py: 0.375 } }}
            >
              <ToggleButton value="all" aria-label="All notifications">All</ToggleButton>
              <ToggleButton value="unread" aria-label="Unread notifications">Unread</ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ flex: 1 }} />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={density}
              onChange={(_event, value: Density | null) => {
                if (!value) {
                  return
                }
                setDensity(value)
                try {
                  window.localStorage.setItem(DENSITY_KEY, value)
                } catch {
                  // storage unavailable — keep the in-memory preference
                }
              }}
              aria-label="Row density"
              sx={{ ...segmentedControlSx, '& .MuiToggleButton-root': { px: 1.5, py: 0.375 } }}
            >
              {/* Icon-only on the narrow panel: three footer controls do not
                  fit 340px with the labels, and the aria-labels keep the
                  buttons named for assistive tech either way. */}
              <ToggleButton value="comfortable" aria-label="Comfortable density">
                <ViewAgendaOutlinedIcon sx={{ fontSize: 15 }} />
                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                  Comfortable
                </Box>
              </ToggleButton>
              <ToggleButton value="compact" aria-label="Compact density">
                <ViewHeadlineRoundedIcon sx={{ fontSize: 15 }} />
                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                  Compact
                </Box>
              </ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </>
      )}
    </Stack>
  )
}

type VirtualRowData = {
  rows: VirtualRow[]
  pathname: string
  compact: boolean
  currentUserId: string
  markingIds: string[]
  // -1 while older pages may exist (ARIA's "set size unknown"), the loaded
  // count once the feed is exhausted.
  itemSetSize: number
  onMarkRead: (notificationId: string) => void
  onNavigate?: () => void
  onLoadMore: () => void
}

// react-window's inner container as a real <ul>: the virtual rows render as
// absolutely-positioned <li> children (legal CSS), so the feed keeps genuine
// list semantics — a bare div stack would orphan the rows for screen readers.
const InnerList = forwardRef<HTMLUListElement, HTMLAttributes<HTMLUListElement>>(
  function InnerList({ style, ...rest }, ref) {
    return (
      <ul
        ref={ref}
        role="list"
        style={{ ...style, margin: 0, padding: 0, listStyle: 'none' }}
        {...rest}
      />
    )
  },
)

function VirtualRowRenderer({
  index,
  style,
  data,
}: ListChildComponentProps<VirtualRowData>) {
  const row = data.rows[index]
  if (!row) {
    return null
  }

  if (row.kind === 'header') {
    return (
      <Box
        component="li"
        role="presentation"
        style={style}
        sx={{
          ...SUBHEADER_SX,
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}
      >
        {row.label}
        <Box component="span" sx={COUNT_PILL_SX} style={{ marginLeft: 8 }}>
          {row.countLabel}
        </Box>
      </Box>
    )
  }

  if (row.kind === 'footer') {
    return (
      <Box
        component="li"
        role="presentation"
        style={style}
        sx={{
          display: 'grid',
          placeItems: 'center',
          px: 2,
          boxSizing: 'border-box',
        }}
      >
        {row.error ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="error">
              Couldn't load older notifications.
            </Typography>
            <Button
              size="small"
              variant="text"
              onClick={data.onLoadMore}
              sx={{ fontWeight: 700, fontSize: 12, minHeight: 0, py: 0, px: 0.5 }}
            >
              Retry
            </Button>
          </Stack>
        ) : row.loading ? (
          <CircularProgress size={18} thickness={5} aria-label="Loading older notifications" />
        ) : (
          <Typography variant="caption" color="text.disabled">
            Scroll for older notifications
          </Typography>
        )}
      </Box>
    )
  }

  return (
    <Box
      component="li"
      aria-setsize={data.itemSetSize}
      aria-posinset={row.pos}
      style={style}
      sx={{ boxSizing: 'border-box' }}
    >
      <NotificationRow
        item={row.item}
        pathname={data.pathname}
        compact={data.compact}
        currentUserId={data.currentUserId}
        marking={data.markingIds.includes(row.item.notificationId)}
        onMarkRead={data.onMarkRead}
        onNavigate={data.onNavigate}
      />
    </Box>
  )
}

function NotificationRow({
  item,
  pathname,
  compact,
  currentUserId,
  marking,
  onMarkRead,
  onNavigate,
}: {
  item: NotificationDto
  pathname: string
  compact: boolean
  currentUserId: string
  marking: boolean
  onMarkRead: (notificationId: string) => void
  onNavigate?: () => void
}) {
  const meta = notificationTypeMeta(item.type)
  const isUnread = !item.readAt
  const avatarSize = compact ? 30 : 40

  // A terminal approval belongs to everyone who signed off, not to whoever
  // voted last: its summary names all the approvers, so the row's identity is
  // the OUTCOME — a green check avatar and a "Request approved" title — not
  // one person's face over other people's names.
  const finalApproved = item.type === NotificationType.RequestApproved

  // A resolved ask keeps its frozen summary — the ask's own text under the
  // ask's own date — and only the chip changes: green "Done" when the viewer
  // settled the question themselves, neutral "Closed" when it was settled
  // without them. What happened to the REQUEST arrives as its own news row
  // (request_cancelled/approved/rejected), so neither row repeats the other.
  // Unread state is untouched by resolution: dot, tint and text emphasis all
  // follow readAt alone.
  const resolved = isResolved(item)
  const closedByMe = resolved && item.resolvedByUserId === currentUserId
  const state = !resolved
    ? { label: meta.short, color: meta.color, Icon: meta.Icon }
    : closedByMe
      ? { label: 'Done', color: '#15803d', Icon: CheckRoundedIcon }
      : { label: 'Closed', color: '#667085', Icon: BlockRoundedIcon }

  return (
    <ListItemButton
      component={RouterLink}
      to={notificationLink(item, pathname)}
      disabled={marking}
      onClick={() => {
        // Opening it is reading it; the row is a link either way, so a failed
        // mark-read never blocks the navigation.
        if (isUnread) {
          onMarkRead(item.notificationId)
        }
        onNavigate?.()
      }}
      sx={{
        alignItems: 'flex-start',
        gap: 1.25,
        pl: 1.5,
        pr: 2,
        // Paddings are derived FROM the slot constants, not the other way
        // around: compact content is 20px title + 17px summary + 1px border,
        // so 9px each side lands exactly on the 56px slot (comfortable: 12px
        // each side + 21 + 2 + 37 + 1 ≈ 86).
        py: compact ? 1.125 : 1.5,
        // The app theme rounds every ListItemButton (10px); notification rows are
        // full-bleed, so flatten them.
        borderRadius: 0,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: isUnread ? alpha(meta.color, 0.07) : undefined,
        '&:hover': { bgcolor: isUnread ? alpha(meta.color, 0.12) : 'action.hover' },
      }}
    >
      {/* Unread dot (type colour) — a dot, not colour alone. */}
      <Box
        aria-hidden
        sx={{
          mt: compact ? 1.1 : 1.6,
          width: 7,
          height: 7,
          flexShrink: 0,
          borderRadius: '50%',
          bgcolor: isUnread ? meta.color : 'transparent',
        }}
      />
      <Avatar
        sx={{
          width: avatarSize,
          height: avatarSize,
          fontSize: compact ? 12 : 13.5,
          fontWeight: 700,
          bgcolor: finalApproved ? alpha('#15803d', 0.13) : avatarColorFor(item.actorLabel),
          color: finalApproved ? '#15803d' : undefined,
          transition: 'width .22s cubic-bezier(.22,1.2,.36,1), height .22s cubic-bezier(.22,1.2,.36,1)',
        }}
      >
        {finalApproved ? (
          <CheckRoundedIcon sx={{ fontSize: compact ? 16 : 20 }} />
        ) : (
          notificationInitials(item.actorLabel)
        )}
      </Avatar>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography
            variant="subtitle2"
            noWrap
            sx={{ fontWeight: 700, fontSize: compact ? 12.5 : 13.5, minWidth: 0 }}
          >
            {finalApproved ? 'Request approved' : item.actorLabel}
          </Typography>
          {compact ? (
            <Box
              aria-label={state.label}
              sx={{
                display: 'inline-grid',
                placeItems: 'center',
                width: 20,
                height: 20,
                flexShrink: 0,
                borderRadius: 999,
                bgcolor: alpha(state.color, 0.13),
                color: state.color,
              }}
            >
              <state.Icon sx={{ fontSize: 13 }} />
            </Box>
          ) : (
            <Chip
              size="small"
              icon={<state.Icon />}
              label={state.label}
              sx={{
                height: 20,
                flexShrink: 0,
                borderRadius: 999,
                bgcolor: alpha(state.color, 0.13),
                color: state.color,
                '& .MuiChip-label': { px: 0.75, fontSize: 10.5, fontWeight: 700 },
                '& .MuiChip-icon': { color: state.color, fontSize: 13, ml: '5px', mr: '-3px' },
              }}
            />
          )}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {formatRelativeTime(item.occurredAt, Date.now())}
          </Typography>
        </Stack>
        <Typography
          variant="body2"
          color={isUnread ? 'text.primary' : 'text.secondary'}
          sx={{
            mt: compact ? 0 : 0.25,
            fontSize: compact ? 12 : 13,
            lineHeight: 1.42,
            display: '-webkit-box',
            WebkitLineClamp: compact ? 1 : 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            // Reserve the full two lines in comfortable mode so every row is
            // exactly ITEM_ROW_HEIGHT tall — the virtual slots are constants,
            // and a one-line summary must not leave its divider floating
            // mid-slot.
            minHeight: compact ? undefined : '2.84em',
          }}
        >
          {item.summary}
        </Typography>
      </Box>
    </ListItemButton>
  )
}
