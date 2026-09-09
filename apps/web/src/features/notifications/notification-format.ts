/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { SvgIconComponent } from '@mui/icons-material'
// Outline / line-style glyphs, matching the approved prototype's thin stroke
// icons — deliberately NOT the filled Rounded shapes.
import BlockRoundedIcon from '@mui/icons-material/BlockRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import { NotificationType } from '@workspace/contracts'
import type { NotificationDto } from '@workspace/contracts'

// Presentation vocabulary for a notification type. Colours are the app palette
// (apps/web/src/theme.ts) so the centre reads like the rest of the product.
export type NotificationTypeMeta = {
  label: string
  short: string
  color: string
  Icon: SvgIconComponent
}

export const NOTIFICATION_TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  [NotificationType.ApprovalNeeded]: {
    label: 'Action needed',
    short: 'Action',
    color: '#155eef',
    Icon: MoveToInboxOutlinedIcon,
  },
  [NotificationType.ApprovalProgressed]: {
    label: 'In progress',
    // Not 'Update': that word is the Updates tab's name (approver-side news),
    // and this chip rides requester-side rows.
    short: 'Progress',
    color: '#7c3aed',
    Icon: ScheduleRoundedIcon,
  },
  [NotificationType.RequestApproved]: {
    label: 'Approved',
    short: 'Approved',
    color: '#15803d',
    Icon: CheckRoundedIcon,
  },
  [NotificationType.RequestRejected]: {
    label: 'Rejected',
    short: 'Rejected',
    color: '#b42318',
    Icon: CloseRoundedIcon,
  },
  [NotificationType.RequestCancelled]: {
    label: 'Cancelled',
    short: 'Cancelled',
    color: '#667085',
    Icon: BlockRoundedIcon,
  },
}

export function notificationTypeMeta(type: NotificationType): NotificationTypeMeta {
  return NOTIFICATION_TYPE_META[type] ?? NOTIFICATION_TYPE_META[NotificationType.ApprovalNeeded]
}

// ---------------------------------------------------------------- resolution --
// A row whose question has been closed (see NotificationDto.resolvedAt). Only
// ask rows (approval_needed / approval_progressed) ever resolve; outcome rows
// never carry these fields. A resolved row keeps rendering its frozen summary
// — resolution feeds the Done/Closed chip and the counters, never the text;
// what happened to the request is a separate news row's sentence.
export function isResolved(item: NotificationDto): boolean {
  return Boolean(item.resolvedAt)
}

// ---------------------------------------------------------------- tabs --------
// Named tabs over type SETS, not one-tab-per-type: Updates is "news about
// requests where you're an approver" and later grows more kinds without a new
// tab.
export type NotificationTab =
  | 'all'
  | 'actionNeeded'
  | 'updates'
  | 'inProgress'
  | 'approved'
  | 'rejected'

export type NotificationTabSpec = {
  label: string
  types: NotificationType[]
  // Active-tab underline colour; undefined = theme primary (the All tab).
  color?: string
}

export const NOTIFICATION_TABS: Record<NotificationTab, NotificationTabSpec> = {
  all: { label: 'All', types: Object.values(NotificationType) },
  actionNeeded: {
    label: 'Action needed',
    types: [NotificationType.ApprovalNeeded],
    color: NOTIFICATION_TYPE_META[NotificationType.ApprovalNeeded].color,
  },
  // No own colour: the cancelled type's gray as an active-tab underline reads
  // as "not selected", so Updates takes the theme primary like the All tab.
  updates: {
    label: 'Updates',
    types: [NotificationType.RequestCancelled],
  },
  inProgress: {
    label: 'In progress',
    types: [NotificationType.ApprovalProgressed],
    color: NOTIFICATION_TYPE_META[NotificationType.ApprovalProgressed].color,
  },
  approved: {
    label: 'Approved',
    types: [NotificationType.RequestApproved],
    color: NOTIFICATION_TYPE_META[NotificationType.RequestApproved].color,
  },
  rejected: {
    label: 'Rejected',
    types: [NotificationType.RequestRejected],
    color: NOTIFICATION_TYPE_META[NotificationType.RequestRejected].color,
  },
}

// The strip's layout: tabs clustered by which hat the viewer wears for them,
// because every notification type is addressed to exactly one of the two roles.
// A null group label renders no overline (the All tab stands alone).
export const NOTIFICATION_TAB_GROUPS: Array<{
  label: string | null
  tabs: NotificationTab[]
}> = [
  { label: null, tabs: ['all'] },
  { label: "Others' requests", tabs: ['actionNeeded', 'updates'] },
  { label: 'My requests', tabs: ['inProgress', 'approved', 'rejected'] },
]

// ---------------------------------------------------------------- filtering ---
export function filterNotifications(
  items: NotificationDto[],
  opts: { tab: NotificationTab; unreadOnly: boolean },
): NotificationDto[] {
  const spec = NOTIFICATION_TABS[opts.tab]
  // No resolved-progress handling here: the server does not serve resolved
  // approval_progressed rows at all (the outcome's own row carries that news),
  // so by the time items reach this filter every progress row is live.
  //
  // All is the unfiltered journal, NOT a type filter: a row whose type this
  // bundle does not know yet (a newer server mid-deploy) must still render
  // somewhere — notificationTypeMeta falls back for exactly that row — rather
  // than vanish while the server-side unread count keeps counting it.
  return items.filter(
    (item) =>
      (opts.tab === 'all' || spec.types.includes(item.type)) &&
      (!opts.unreadOnly || !item.readAt),
  )
}

// Unresolved asks first, everything else after, both sides keeping their
// incoming order. The Action needed tab pins the first half above its day
// groups so an open ask can never hide below old history.
export function splitResolved(items: NotificationDto[]): {
  pending: NotificationDto[]
  resolved: NotificationDto[]
} {
  const pending: NotificationDto[] = []
  const resolved: NotificationDto[] = []
  for (const item of items) {
    ;(isResolved(item) ? resolved : pending).push(item)
  }
  return { pending, resolved }
}

// The panel body's two halves for one tab: pinned open asks and the history
// below them. The read filter narrows HISTORY only — an open ask stays pinned
// however the viewer read it, because reading a request does not decide it,
// and the tab pill counting the ask must never point at a view that refuses
// to show it.
export function partitionTabRows(
  items: NotificationDto[],
  opts: { tab: NotificationTab; unreadOnly: boolean },
): { pending: NotificationDto[]; history: NotificationDto[] } {
  const tabItems = filterNotifications(items, {
    tab: opts.tab,
    unreadOnly: false,
  })
  const split =
    opts.tab === 'actionNeeded'
      ? splitResolved(tabItems)
      : { pending: [], resolved: tabItems }
  const history = opts.unreadOnly
    ? split.resolved.filter((item) => !item.readAt)
    : split.resolved
  return { pending: split.pending, history }
}

// Unread counts of the LOADED pages, per tab — these feed the strip's dots
// ("there is something unread in here"), inbox-style: once read, there is
// nothing left to signal. Action needed is deliberately NOT counted here: its
// pill renders the TABLE-WIDE open-ask count the API serves
// (NotificationListDto.openAskCount) — a window-scoped number would creep
// upward as pages load and disagree with the bell — so its entry stays zero
// and no dot ever competes with that pill.
export type NotificationTabCounts = Record<NotificationTab, number>

export function tabCounts(items: NotificationDto[]): NotificationTabCounts {
  const counts: NotificationTabCounts = {
    all: 0,
    actionNeeded: 0,
    updates: 0,
    inProgress: 0,
    approved: 0,
    rejected: 0,
  }
  for (const item of items) {
    if (item.readAt) {
      continue
    }
    counts.all += 1
    switch (item.type) {
      case NotificationType.ApprovalProgressed:
        counts.inProgress += 1
        break
      case NotificationType.RequestApproved:
        counts.approved += 1
        break
      case NotificationType.RequestRejected:
        counts.rejected += 1
        break
      case NotificationType.RequestCancelled:
        counts.updates += 1
        break
    }
  }
  return counts
}

// ---------------------------------------------------------------- grouping ----
const DAY_ORDER = [
  'Today',
  'Yesterday',
  'Earlier this week',
  'This month',
  'Earlier',
] as const
export type NotificationDayLabel = (typeof DAY_ORDER)[number]

// Coarse day bucket for a server ISO instant. Client clock is fine here: it is a
// display-only grouping, never a business figure.
export function notificationDayLabel(iso: string, nowMs: number): NotificationDayLabel {
  const hours = (nowMs - Date.parse(iso)) / 3_600_000
  if (hours < 24) return 'Today'
  if (hours < 48) return 'Yesterday'
  if (hours < 24 * 7) return 'Earlier this week'
  if (hours < 24 * 30) return 'This month'
  return 'Earlier'
}

export type NotificationGroup = { label: NotificationDayLabel; items: NotificationDto[] }

// Groups newest-first items into day buckets in a fixed order; preserves each
// item's incoming order within its bucket. Empty buckets are dropped.
export function groupNotificationsByDay(
  items: NotificationDto[],
  nowMs: number,
): NotificationGroup[] {
  const buckets = new Map<NotificationDayLabel, NotificationDto[]>()
  for (const item of items) {
    const label = notificationDayLabel(item.occurredAt, nowMs)
    const arr = buckets.get(label)
    if (arr) {
      arr.push(item)
    } else {
      buckets.set(label, [item])
    }
  }
  return DAY_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    items: buckets.get(label) as NotificationDto[],
  }))
}

// ---------------------------------------------------------------- avatar ------
// Up to two initials from the first two words of the actor's name.
export function notificationInitials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
  return (letters || '?').toUpperCase()
}

// Deterministic avatar colour from the name, so the same person is always the
// same colour without storing one. Palette mirrors the prototype.
const AVATAR_PALETTE = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#3b82f6', '#a855f7', '#22c55e', '#06b6d4', '#d946ef',
]

export function avatarColorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}
