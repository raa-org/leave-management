/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { NotificationType } from '@workspace/contracts'
import type { NotificationDto } from '@workspace/contracts'
import {
  avatarColorFor,
  filterNotifications,
  groupNotificationsByDay,
  notificationDayLabel,
  notificationInitials,
  notificationTypeMeta,
  partitionTabRows,
  splitResolved,
  tabCounts,
  NOTIFICATION_TABS,
  NOTIFICATION_TAB_GROUPS,
  type NotificationTab,
} from './notification-format'

const NOW = Date.parse('2026-07-20T12:00:00.000Z')

function make(
  type: NotificationType,
  overrides: Partial<NotificationDto> = {},
): NotificationDto {
  return {
    notificationId: 'n-' + Math.random().toString(36).slice(2),
    type,
    actorLabel: 'Alex Morgan',
    summary: 'summary',
    requestId: 'r',
    occurredAt: '2026-07-20T09:00:00.000Z',
    ...overrides,
  }
}

const RESOLVED = {
  resolvedAt: '2026-07-20T11:00:00.000Z',
  resolvedByUserId: 'user-ivan',
  resolvedByLabel: 'Ivan Petrov',
  resolutionText: "approved David Brooks' vacation request for 2026-07-23 to 2026-07-23",
} as const

describe('tab model', () => {
  it('covers every notification type exactly once outside All, grouped by viewer role', () => {
    // Every type is addressed to exactly one role, which is the whole premise
    // of the grouped strip: a type in two tabs (or in none) would break it.
    const groupedTabs = NOTIFICATION_TAB_GROUPS.flatMap((group) => group.tabs)
    expect(groupedTabs.sort()).toEqual(
      (Object.keys(NOTIFICATION_TABS) as NotificationTab[]).sort(),
    )
    const typesOutsideAll = groupedTabs
      .filter((tab) => tab !== 'all')
      .flatMap((tab) => NOTIFICATION_TABS[tab].types)
    expect(typesOutsideAll.sort()).toEqual(Object.values(NotificationType).sort())
  })

  it("shelves cancellations under Updates in the others'-requests group", () => {
    expect(NOTIFICATION_TABS.updates.types).toEqual([NotificationType.RequestCancelled])
    expect(
      NOTIFICATION_TAB_GROUPS.find((group) => group.label === "Others' requests")?.tabs,
    ).toEqual(['actionNeeded', 'updates'])
  })
})

describe('filterNotifications', () => {
  const items = [
    make(NotificationType.ApprovalNeeded, { notificationId: 'a', readAt: undefined }),
    make(NotificationType.RequestApproved, { notificationId: 'b', readAt: '2026-07-20T10:00:00.000Z' }),
    make(NotificationType.ApprovalNeeded, { notificationId: 'c', readAt: '2026-07-20T10:00:00.000Z' }),
  ]

  it('narrows by tab', () => {
    expect(
      filterNotifications(items, { tab: 'actionNeeded', unreadOnly: false }).map((i) => i.notificationId),
    ).toEqual(['a', 'c'])
  })

  it('narrows by unread', () => {
    expect(
      filterNotifications(items, { tab: 'all', unreadOnly: true }).map((i) => i.notificationId),
    ).toEqual(['a'])
  })

  it('combines tab and unread', () => {
    expect(
      filterNotifications(items, { tab: 'actionNeeded', unreadOnly: true }).map((i) => i.notificationId),
    ).toEqual(['a'])
  })

  it('keeps a type this bundle does not know in All, and only in All', () => {
    // Deploy skew: a newer server can serve a type this bundle has no enum
    // member for. The table-wide unread count includes it, so All must show
    // it (the type meta falls back) instead of counting a row nobody can see.
    const foreign = make('final_outcome' as NotificationType, {
      notificationId: 'foreign',
    })
    expect(
      filterNotifications([foreign], { tab: 'all', unreadOnly: false }),
    ).toHaveLength(1)
    expect(
      filterNotifications([foreign], { tab: 'updates', unreadOnly: false }),
    ).toHaveLength(0)
  })

  it('keeps a resolved ask visible in Action needed', () => {
    // A decided approval stays on screen as "done" — how the ask was settled is
    // news to the approver. (A resolved PROGRESS row never reaches this filter:
    // the server does not serve it, the outcome's own row carries that news.)
    const mixed = [
      make(NotificationType.ApprovalNeeded, { notificationId: 'ask', ...RESOLVED }),
      make(NotificationType.ApprovalProgressed, { notificationId: 'live' }),
    ]
    expect(
      filterNotifications(mixed, { tab: 'actionNeeded', unreadOnly: false }).map((i) => i.notificationId),
    ).toEqual(['ask'])
    expect(
      filterNotifications(mixed, { tab: 'inProgress', unreadOnly: false }).map((i) => i.notificationId),
    ).toEqual(['live'])
  })
})

describe('tabCounts', () => {
  const READ = { readAt: '2026-07-20T10:00:00.000Z' } as const

  it('counts unread on the news tabs, so a read row stops demanding attention', () => {
    const counts = tabCounts([
      make(NotificationType.RequestRejected),
      make(NotificationType.RequestRejected, READ),
      make(NotificationType.RequestCancelled, READ),
      make(NotificationType.RequestApproved),
      make(NotificationType.ApprovalProgressed, READ),
    ])
    expect(counts.rejected).toBe(1)
    expect(counts.updates).toBe(0)
    expect(counts.approved).toBe(1)
    expect(counts.inProgress).toBe(0)
    // All is unread across every type — the panel-wide "what's new" number.
    expect(counts.all).toBe(2)
  })

  it('leaves Action needed at zero: its number is the table-wide openAskCount', () => {
    // A window-scoped ask count would creep upward as pages load and disagree
    // with the bell's table-wide figure, so tabCounts deliberately does not
    // compute one — the pill renders NotificationListDto.openAskCount and the
    // zero here guarantees no unread dot ever competes with it.
    const counts = tabCounts([
      make(NotificationType.ApprovalNeeded, READ),
      make(NotificationType.ApprovalNeeded),
      make(NotificationType.ApprovalNeeded, RESOLVED),
    ])
    expect(counts.actionNeeded).toBe(0)
    // All, being a news count, still sees the two unread rows.
    expect(counts.all).toBe(2)
  })
})

describe('partitionTabRows', () => {
  it('keeps an open ask pinned even under the Unread filter', () => {
    // Reading a request does not decide it: the Unread toggle narrows history
    // only, so the pill counting an open ask can never point at a view that
    // refuses to show it.
    const readOpenAsk = make(NotificationType.ApprovalNeeded, {
      notificationId: 'ask',
      readAt: '2026-07-20T10:00:00.000Z',
    })
    const readClosedAsk = make(NotificationType.ApprovalNeeded, {
      notificationId: 'closed',
      readAt: '2026-07-20T10:00:00.000Z',
      ...RESOLVED,
    })
    const result = partitionTabRows([readOpenAsk, readClosedAsk], {
      tab: 'actionNeeded',
      unreadOnly: true,
    })
    expect(result.pending.map((item) => item.notificationId)).toEqual(['ask'])
    // The read, settled ask is history and the filter applies to it.
    expect(result.history).toHaveLength(0)
  })

  it('applies the read filter to plain tabs as before', () => {
    const unread = make(NotificationType.RequestApproved, { notificationId: 'u' })
    const read = make(NotificationType.RequestApproved, {
      notificationId: 'r',
      readAt: '2026-07-20T10:00:00.000Z',
    })
    const result = partitionTabRows([unread, read], {
      tab: 'approved',
      unreadOnly: true,
    })
    expect(result.pending).toHaveLength(0)
    expect(result.history.map((item) => item.notificationId)).toEqual(['u'])
  })
})

describe('splitResolved', () => {
  it('pins open asks ahead of closed ones, preserving order within each side', () => {
    const split = splitResolved([
      make(NotificationType.ApprovalNeeded, { notificationId: 'done-1', ...RESOLVED }),
      make(NotificationType.ApprovalNeeded, { notificationId: 'open-1' }),
      make(NotificationType.ApprovalNeeded, { notificationId: 'done-2', ...RESOLVED }),
      make(NotificationType.ApprovalNeeded, { notificationId: 'open-2' }),
    ])
    expect(split.pending.map((i) => i.notificationId)).toEqual(['open-1', 'open-2'])
    expect(split.resolved.map((i) => i.notificationId)).toEqual(['done-1', 'done-2'])
  })
})

describe('notificationDayLabel', () => {
  it('buckets by age relative to now', () => {
    const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
    expect(notificationDayLabel(at(1), NOW)).toBe('Today')
    expect(notificationDayLabel(at(30), NOW)).toBe('Yesterday')
    expect(notificationDayLabel(at(24 * 4), NOW)).toBe('Earlier this week')
    expect(notificationDayLabel(at(24 * 15), NOW)).toBe('This month')
    expect(notificationDayLabel(at(24 * 60), NOW)).toBe('Earlier')
  })
})

describe('groupNotificationsByDay', () => {
  it('keeps the fixed day order, drops empty buckets, preserves within-day order', () => {
    const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
    const groups = groupNotificationsByDay(
      [
        make(NotificationType.ApprovalNeeded, { notificationId: 't1', occurredAt: at(1) }),
        make(NotificationType.ApprovalNeeded, { notificationId: 't2', occurredAt: at(2) }),
        make(NotificationType.RequestApproved, { notificationId: 'e1', occurredAt: at(24 * 15) }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.label)).toEqual(['Today', 'This month'])
    expect(groups[0]?.items.map((i) => i.notificationId)).toEqual(['t1', 't2'])
    expect(groups[1]?.items.map((i) => i.notificationId)).toEqual(['e1'])
  })

  it('returns nothing for an empty list', () => {
    expect(groupNotificationsByDay([], NOW)).toEqual([])
  })
})

describe('notificationInitials', () => {
  it('takes the first two words', () => {
    expect(notificationInitials('Vladislav Taskanov')).toBe('VT')
    expect(notificationInitials('Alex Morgan Smith')).toBe('AM')
  })
  it('handles a single word and blank input', () => {
    expect(notificationInitials('Admin')).toBe('A')
    expect(notificationInitials('   ')).toBe('?')
  })
})

describe('avatarColorFor', () => {
  it('is deterministic per name and stays in the palette', () => {
    const a = avatarColorFor('Alex Morgan')
    expect(a).toBe(avatarColorFor('Alex Morgan'))
    expect(a).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('separates different names (usually)', () => {
    expect(avatarColorFor('Alex Morgan')).not.toBe(avatarColorFor('Diego Costa'))
  })
})

describe('notificationTypeMeta', () => {
  it('gives each type an app-palette colour and label', () => {
    expect(notificationTypeMeta(NotificationType.ApprovalNeeded).color).toBe('#155eef')
    expect(notificationTypeMeta(NotificationType.RequestApproved).color).toBe('#15803d')
    expect(notificationTypeMeta(NotificationType.RequestRejected).label).toBe('Rejected')
  })
})
