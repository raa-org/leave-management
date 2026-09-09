/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { sliceName } from '@trusted-modules/auth-oidc-react'
import { ApproverKind, NotificationType } from '@workspace/contracts'
import type { NotificationDto } from '@workspace/contracts'
import theme from '../../theme'
import { parseJsonResponse } from '../../lib/http'
import { NotificationBell } from './NotificationBell'
import { NotificationList, pickStickySection } from './NotificationList'
import { notificationLink } from './notification-link'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications-api'
import {
  createInitialNotificationsState,
  notificationsActions,
  notificationsReducer,
  type NotificationsState,
} from './notifications.store'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const notification = (
  overrides: Partial<NotificationDto> = {},
): NotificationDto => ({
  notificationId: 'notif-1',
  type: NotificationType.ApprovalNeeded,
  actorLabel: 'Alex Morgan',
  summary: 'Alex Morgan requests vacation and needs your approval',
  requestId: 'request-1',
  occurredAt: '2026-07-01T09:30:00.000Z',
  ...overrides,
})

describe('notificationLink', () => {
  it('scopes review links to the employee workspace', () => {
    for (const type of Object.values(NotificationType)) {
      expect(
        notificationLink(notification({ type, requestId: 'r-9' }), '/employee/dashboard'),
      ).toBe('/employee/approval/review/r-9')
    }
  })

  it('scopes review links to the admin workspace', () => {
    expect(
      notificationLink(notification({ requestId: 'r-9' }), '/admin/activity'),
    ).toBe('/admin/approval/review/r-9')
  })
})

describe('parseJsonResponse', () => {
  // Pins the move out of employee-api as behaviour-neutral.
  it('returns the payload on success', async () => {
    await expect(parseJsonResponse(jsonResponse({ ok: 1 }))).resolves.toEqual({
      ok: 1,
    })
  })

  it('surfaces the server message, joining a validation list', async () => {
    await expect(
      parseJsonResponse(jsonResponse({ message: 'comment is required' }, false, 400)),
    ).rejects.toThrowError('comment is required')
    await expect(
      parseJsonResponse(jsonResponse({ message: ['a', 'b'] }, false, 400)),
    ).rejects.toThrowError('a, b')
  })

  it('falls back to the status when the body says nothing', async () => {
    await expect(
      parseJsonResponse(jsonResponse({}, false, 503)),
    ).rejects.toThrowError('Request failed with status 503')
  })
})

describe('notifications api', () => {
  it('reads, marks one, and marks all through apiUrl-built paths', async () => {
    const list = { items: [notification()], unreadCount: 1, openAskCount: 1 }
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(list),
    )

    await expect(fetchNotifications(fetchMock as typeof fetch)).resolves.toEqual(list)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/notifications')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('cursor=')
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined()

    await markNotificationRead('notif-1', fetchMock as typeof fetch)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/api/notifications/notif-1/read',
    )
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST')

    await markAllNotificationsRead(fetchMock as typeof fetch)
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      '/api/notifications/read-all',
    )
  })

  it('passes the opaque cursor verbatim on load-more', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ items: [], unreadCount: 0, openAskCount: 0 }),
    )
    await fetchNotifications(fetchMock as typeof fetch, { cursor: 'abc+/=_' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'cursor=abc%2B%2F%3D_',
    )
  })

  it('escapes the id rather than pasting it into the path', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ items: [], unreadCount: 0, openAskCount: 0 }),
    )
    await markNotificationRead('a/../b', fetchMock as typeof fetch)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('a%2F..%2Fb')
  })
})

describe('notifications reducer', () => {
  it('replaces the snapshot wholesale and clears what was in flight', async () => {
    // The client never does count arithmetic: the server's snapshot is adopted
    // as-is, which is what keeps the badge and the list from disagreeing.
    let state = createInitialNotificationsState()
    state = notificationsReducer(state, notificationsActions.markReadRequested('notif-1'))
    expect(state.markingIds).toEqual(['notif-1'])

    state = notificationsReducer(
      state,
      notificationsActions.notificationsReceived({
        items: [notification({ readAt: '2026-07-01T10:00:00.000Z' })],
        unreadCount: 0,
        openAskCount: 3,
      }),
    )
    expect(state.status).toBe('succeeded')
    expect(state.unreadCount).toBe(0)
    // Adopted as-is alongside the unread count — the bell's dot rides on it.
    expect(state.openAskCount).toBe(3)
    expect(state.markingIds).toEqual([])
  })

  it('keeps a refresh from blanking a list that is already on screen', async () => {
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification()],
        unreadCount: 1,
        openAskCount: 0,
      }),
    )
    state = notificationsReducer(state, notificationsActions.notificationsRequested())
    // Still 'succeeded', so a stream-driven refetch does not flash a skeleton
    // over a list the user is reading.
    expect(state.status).toBe('succeeded')
    expect(state.items).toHaveLength(1)
  })

  it('releases the busy set when a mark fails, so the panel is not left deadlocked', () => {
    // A failed mark-read used to leave its id in markingIds forever. That
    // disables the row (pointer-events: none) AND 'Mark all read' (which
    // self-disables while anything is marking), so the panel had no control left
    // to retry from.
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification()],
        unreadCount: 1,
        openAskCount: 0,
      }),
    )
    state = notificationsReducer(state, notificationsActions.markReadRequested('notif-1'))
    expect(state.markingIds).toEqual(['notif-1'])

    state = notificationsReducer(
      state,
      notificationsActions.notificationsRequestFailed('Request failed with status 500'),
    )
    expect(state.markingIds).toEqual([])
    expect(state.error).toBe('Request failed with status 500')
  })

  it('tracks the stream so the bell can report it', () => {
    let state = createInitialNotificationsState()
    state = notificationsReducer(state, notificationsActions.streamConnectRequested())
    expect(state.streamStatus).toBe('retrying')
    state = notificationsReducer(state, notificationsActions.streamOpened())
    expect(state.streamStatus).toBe('open')
    state = notificationsReducer(state, notificationsActions.streamClosed())
    expect(state.streamStatus).toBe('idle')
  })

  it('marks every unread row busy on mark-all, and no read ones', () => {
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [
          notification({ notificationId: 'a' }),
          notification({ notificationId: 'b', readAt: '2026-07-01T10:00:00.000Z' }),
        ],
        unreadCount: 1,
        openAskCount: 0,
      }),
    )
    state = notificationsReducer(state, notificationsActions.markAllReadRequested())
    expect(state.markingIds).toEqual(['a'])
  })

  it('appends an older page and advances the cursor without blanking the list', () => {
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification({ notificationId: 'n-1', summary: 'First' })],
        unreadCount: 2,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    expect(state.nextCursor).toBe('cursor-1')

    state = notificationsReducer(state, notificationsActions.notificationsMoreRequested())
    expect(state.loadingMore).toBe(true)

    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreReceived({
        list: {
          items: [
            notification({ notificationId: 'n-1', summary: 'dup' }),
            notification({ notificationId: 'n-2', summary: 'Second' }),
          ],
          unreadCount: 2,
          openAskCount: 0,
        },
        generation: state.generation,
      }),
    )
    expect(state.loadingMore).toBe(false)
    expect(state.nextCursor).toBeUndefined()
    expect(state.items.map((item) => item.notificationId)).toEqual(['n-1', 'n-2'])
    expect(state.items[0]?.summary).toBe('First')
  })

  it('a refetch replaces the head and keeps the scrolled-in tail', () => {
    // The snapshot path merges, never wholesale-replaces: an SSE-triggered
    // refetch returns the newest page only, and dropping the tail would
    // collapse the list under the user's scroll on every live event.
    const at = (hour: number) =>
      `2026-07-01T${String(hour).padStart(2, '0')}:00:00.000Z`
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [
          notification({ notificationId: 'progress', occurredAt: at(13) }),
          notification({ notificationId: 'h-1', occurredAt: at(12) }),
        ],
        unreadCount: 1,
        openAskCount: 1,
        nextCursor: 'cursor-1',
      }),
    )
    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreReceived({
        list: {
          items: [
            notification({ notificationId: 't-1', occurredAt: at(9) }),
            notification({ notificationId: 't-2', occurredAt: at(8) }),
          ],
          unreadCount: 1,
          openAskCount: 1,
          nextCursor: 'cursor-2',
        },
        generation: state.generation,
      }),
    )

    // Fresh first page: a new row arrived and 'progress' stopped being served
    // (a resolved progress trail) — it sat INSIDE the range the fresh page
    // covers, so its absence there means it is gone. The tail below the
    // page's reach survives untouched, and the page's own cursor (pointing
    // into the middle of what we hold) must not regress the tail's cursor.
    state = notificationsReducer(
      state,
      notificationsActions.notificationsReceived({
        items: [
          notification({ notificationId: 'new', occurredAt: at(14) }),
          notification({ notificationId: 'h-1', occurredAt: at(12) }),
        ],
        unreadCount: 2,
        openAskCount: 1,
        nextCursor: 'cursor-page-1',
      }),
    )
    expect(state.items.map((item) => item.notificationId)).toEqual([
      'new',
      'h-1',
      't-1',
      't-2',
    ])
    expect(state.nextCursor).toBe('cursor-2')
    expect(state.unreadCount).toBe(2)
  })

  it('drops a load-more page from a superseded generation instead of resurrecting unread rows', () => {
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification({ notificationId: 'n-1' })],
        unreadCount: 1,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    // What the epic would have captured when the page request left — BEFORE
    // the mark-all bumped the generation.
    const staleGeneration = state.generation
    state = notificationsReducer(state, notificationsActions.markAllReadRequested())
    expect(state.markingAll).toBe(true)
    state = notificationsReducer(
      state,
      notificationsActions.markAllReadSucceeded({
        items: [notification({ notificationId: 'n-1', readAt: '2026-07-01T10:00:00.000Z' })],
        unreadCount: 0,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    expect(state.markingAll).toBe(false)

    // A page requested BEFORE the mark-all lands afterwards, still carrying
    // readAt: null rows the server has since marked read — it must be dropped.
    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreReceived({
        list: {
          items: [notification({ notificationId: 'stale', occurredAt: '2026-06-30T09:00:00.000Z' })],
          unreadCount: 5,
          openAskCount: 5,
        },
        generation: staleGeneration,
      }),
    )
    expect(state.items.map((item) => item.notificationId)).toEqual(['n-1'])
    // Counts were not overwritten by the stale page either.
    expect(state.unreadCount).toBe(0)
    expect(state.openAskCount).toBe(0)
  })

  it('drops an in-flight page when a merge hands the cursor over', () => {
    // The page was requested against a boundary that a tail-less merge just
    // replaced; letting it land could skip the rows between the new head and
    // the stale page's start. The next scroll re-asks with the live cursor.
    const at = (hour: number) =>
      `2026-07-01T${String(hour).padStart(2, '0')}:00:00.000Z`
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification({ notificationId: 'a', occurredAt: at(12) })],
        unreadCount: 1,
        openAskCount: 0,
        nextCursor: 'cursor-old',
      }),
    )
    const inFlightGeneration = state.generation
    state = notificationsReducer(
      state,
      notificationsActions.notificationsReceived({
        items: [
          notification({ notificationId: 'b', occurredAt: at(13) }),
          notification({ notificationId: 'a', occurredAt: at(12) }),
        ],
        unreadCount: 2,
        openAskCount: 0,
        nextCursor: 'cursor-new',
      }),
    )
    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreReceived({
        list: {
          items: [notification({ notificationId: 'stale', occurredAt: at(9) })],
          unreadCount: 2,
          openAskCount: 0,
          nextCursor: 'cursor-stale',
        },
        generation: inFlightGeneration,
      }),
    )
    expect(state.items.map((item) => item.notificationId)).toEqual(['b', 'a'])
    expect(state.nextCursor).toBe('cursor-new')
  })

  it('mark-all stamps the kept tail read, and pages never adopt counts', () => {
    const at = (hour: number) =>
      `2026-07-01T${String(hour).padStart(2, '0')}:00:00.000Z`
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification({ notificationId: 'h-1', occurredAt: at(12) })],
        unreadCount: 2,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreReceived({
        list: {
          items: [notification({ notificationId: 't-1', occurredAt: at(9) })],
          // A page response snapshots counts too, but they may be older than
          // the last snapshot's — the reducer must ignore them.
          unreadCount: 99,
          openAskCount: 99,
          nextCursor: 'cursor-2',
        },
        generation: state.generation,
      }),
    )
    expect(state.unreadCount).toBe(2)
    expect(state.openAskCount).toBe(0)

    // Mark-all is table-wide on the server: the kept tail row must come back
    // read, not keep claiming unread until the user happens to reload.
    state = notificationsReducer(
      state,
      notificationsActions.markAllReadSucceeded({
        items: [notification({ notificationId: 'h-1', occurredAt: at(12), readAt: at(13) })],
        unreadCount: 0,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    expect(state.items.find((item) => item.notificationId === 't-1')?.readAt).toBe(at(13))
  })

  it('keeps a load-more failure inline instead of failing the whole panel', () => {
    let state = notificationsReducer(
      createInitialNotificationsState(),
      notificationsActions.notificationsReceived({
        items: [notification({ notificationId: 'n-1' })],
        unreadCount: 1,
        openAskCount: 0,
        nextCursor: 'cursor-1',
      }),
    )
    state = notificationsReducer(state, notificationsActions.notificationsMoreRequested())
    state = notificationsReducer(
      state,
      notificationsActions.notificationsMoreFailed('Request failed with status 500'),
    )
    expect(state.status).toBe('succeeded')
    expect(state.loadMoreError).toBe('Request failed with status 500')
    expect(state.nextCursor).toBe('cursor-1')
    // A retry clears the inline error while the request runs.
    state = notificationsReducer(state, notificationsActions.notificationsMoreRequested())
    expect(state.loadMoreError).toBeUndefined()
    expect(state.loadingMore).toBe(true)
  })
})

describe('NotificationList', () => {
  // Rendered DIRECTLY, never through the bell's Popover: portalled content is
  // empty under renderToStaticMarkup regardless of open state, so an assertion
  // made through the Popover would pass whether or not this rendered at all.
  const render = (ui: React.ReactElement, route = '/employee/dashboard') =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={theme}>{ui}</ThemeProvider>
      </MemoryRouter>,
    )

  const baseProps = {
    status: 'succeeded' as const,
    markingIds: [],
    markingAll: false,
    openAskCount: 0,
    soundOn: true,
    currentUserId: 'viewer-1',
    hasMore: false,
    loadingMore: false,
    onToggleSound: () => undefined,
    onMarkRead: () => undefined,
    onMarkAllRead: () => undefined,
    onLoadMore: () => undefined,
  }

  it('renders each row as a link to its request, with the actor summary', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification({ requestId: 'request-7' })]}
        unreadCount={1}
      />,
    )
    expect(html).toContain('needs your approval')
    expect(html).toContain('/employee/approval/review/request-7')
  })

  it('shows a real person avatar from the actor label', () => {
    // The avatar is derived from actorLabel — the whole reason we snapshot it.
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification({ actorLabel: 'Vladislav Taskanov' })]}
        unreadCount={1}
      />,
    )
    expect(html).toContain('VT')
  })

  it('renders the role-grouped tab strip and the density switch', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification()]}
        unreadCount={1}
      />,
    )
    // Both role clusters with their overlines, and every tab of each.
    // Approver-side news lives under Updates, so no Cancelled tab exists.
    expect(html).toContain('requests')
    expect(html).toContain('My requests')
    expect(html).toContain('Action needed')
    expect(html).toContain('Updates')
    expect(html).toContain('In progress')
    expect(html).not.toContain('Cancelled')
    expect(html).toContain('Comfortable')
    expect(html).toContain('Compact')
  })

  it('renders a resolved ask with its frozen summary and a Done chip when the viewer settled it', () => {
    // The ask keeps its own text under its own date; resolution only flips the
    // chip. What happened to the request is a separate news row's sentence.
    const html = render(
      <NotificationList
        {...baseProps}
        items={[
          notification({
            resolvedAt: '2026-07-01T10:00:00.000Z',
            resolvedByUserId: 'viewer-1',
            resolvedByLabel: 'Viewer Person',
            resolutionText:
              "approved Alex Morgan's vacation request for 2026-07-23 to 2026-07-23",
          }),
        ]}
        unreadCount={0}
      />,
    )
    expect(html).toContain('>Done<')
    expect(html).toContain('needs your approval')
    expect(html).not.toContain('You approved')
  })

  it('renders an ask settled without the viewer as Closed, text untouched', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[
          notification({
            resolvedAt: '2026-07-01T10:00:00.000Z',
            resolvedByUserId: 'admin-9',
            resolvedByLabel: 'Ivan Petrov',
            resolutionText:
              "rejected Alex Morgan's vacation request for 2026-07-23 to 2026-07-23 — your decision is no longer needed",
          }),
        ]}
        unreadCount={1}
      />,
    )
    expect(html).toContain('Closed')
    expect(html).toContain('needs your approval')
    expect(html).not.toContain('Ivan Petrov rejected')
    expect(html).not.toContain('>Done<')
  })

  it('keeps counting a read-but-open ask, and never renders a zero pill', () => {
    // One read, unresolved ask: Action needed still shows 1 (reading a request
    // does not decide it), while every news tab sits at zero — and a zero is
    // not rendered as a gray pill at all.
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification({ readAt: '2026-07-01T10:00:00.000Z' })]}
        unreadCount={0}
      />,
    )
    expect(html).toContain('>1<')
    expect(html).not.toContain('>0<')
  })

  it('marks unread tabs with a dot, keeping the number for Action needed alone', () => {
    // Two kinds of signal, never mixed: Action needed numbers the TABLE-WIDE
    // open asks (work — agreeing with the bell's dot and standing still while
    // pages load), every other tab only says "there is something unread here".
    const html = render(
      <NotificationList
        {...baseProps}
        items={[
          notification(),
          notification({
            notificationId: 'n-2',
            type: NotificationType.RequestApproved,
          }),
        ]}
        unreadCount={2}
        openAskCount={3}
      />,
    )
    expect(html).toContain('aria-label="Approved, has unread"')
    expect(html).toContain('aria-label="All, has unread"')
    // The dot never carries a number; Action needed's pill still does — the
    // table-wide figure, not the loaded window's.
    expect(html).not.toContain('aria-label="Action needed, has unread"')
    expect(html).toContain('>3<')
  })

  it('shows the unread banner only while something is unread', () => {
    // The banner is the ONE place the unread count is a number, and it takes
    // the mark-all action with it when the panel is caught up.
    const withUnread = render(
      <NotificationList {...baseProps} items={[notification()]} unreadCount={2} />,
    )
    expect(withUnread).toContain('2 unread')
    expect(withUnread).toContain('Mark all read')

    const caughtUp = render(
      <NotificationList
        {...baseProps}
        items={[notification({ readAt: '2026-07-01T10:00:00.000Z' })]}
        unreadCount={0}
      />,
    )
    // The word "unread" legitimately survives in the footer filter, so the
    // banner's absence is pinned by its two unique parts: count and action.
    expect(caughtUp).not.toContain('0 unread')
    expect(caughtUp).not.toContain('Mark all read')
  })

  it('admits older pages exist instead of posing as the full history', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification()]}
        unreadCount={1}
        hasMore
      />,
    )
    expect(html).toContain('Scroll for older notifications')
    const complete = render(
      <NotificationList {...baseProps} items={[notification()]} unreadCount={1} />,
    )
    expect(complete).not.toContain('Scroll for older')
  })

  it('keeps the strip one Tab stop, wired to its tabpanel', () => {
    // Roving tabindex: only the active tab is focusable; the others are
    // reached with the arrow keys the tablist role promises.
    const html = render(
      <NotificationList {...baseProps} items={[notification()]} unreadCount={1} />,
    )
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? []
    expect(tabs).toHaveLength(6)
    expect(tabs.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1)
    expect(tabs.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(5)
    expect(html).toContain('aria-controls="nc-tabpanel"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-labelledby="nc-tab-all"')
  })

  it('renders a final approval impersonally: names in the text, outcome as identity', () => {
    // The summary names every approver, so no single face belongs over it —
    // the avatar is a check and the title is the outcome.
    const html = render(
      <NotificationList
        {...baseProps}
        items={[
          notification({
            type: NotificationType.RequestApproved,
            actorLabel: 'Mark Wilson',
            summary:
              'David Brooks and Mark Wilson approved your vacation request for 2026-09-29 to 2026-09-30',
          }),
        ]}
        unreadCount={0}
      />,
    )
    expect(html).toContain('Request approved')
    expect(html).toContain('David Brooks and Mark Wilson approved')
    // No initials avatar for the last voter.
    expect(html).not.toContain('>MW<')
  })

  it('labels a progress row Progress, leaving the word Update to the Updates tab', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification({ type: NotificationType.ApprovalProgressed })]}
        unreadCount={1}
      />,
    )
    expect(html).toContain('Progress')
    expect(html).not.toContain('>Update<')
  })

  it('restores the density preference from localStorage', () => {
    const storage = new Map<string, string>([['nc.density', 'compact']])
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        },
        removeItem: (key: string) => {
          storage.delete(key)
        },
      },
    })
    try {
      const html = render(
        <NotificationList
          {...baseProps}
          items={[notification()]}
          unreadCount={1}
        />,
      )
      // Matched inside the button's own tag: a later unrelated pressed toggle
      // (the read filter also renders aria-pressed) must not satisfy this.
      const compactButton = html.match(/<button[^>]*aria-label="Compact density"[^>]*>/)?.[0]
      expect(compactButton).toContain('aria-pressed="true"')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says so plainly when there is nothing, rather than showing an empty box', () => {
    const html = render(
      <NotificationList {...baseProps} items={[]} unreadCount={0} />,
    )
    expect(html).toContain('You have no notifications yet')
  })

  it('surfaces a load failure instead of looking empty', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        status="failed"
        error="Unable to load your notifications."
        items={[]}
        unreadCount={0}
      />,
    )
    expect(html).toContain('Unable to load your notifications.')
    expect(html).not.toContain('You have no notifications yet')
  })
})

describe('pickStickySection', () => {
  const offsets = [
    { label: 'Pending', countLabel: '2 of 4', start: 0 },
    { label: 'Today', countLabel: '3', start: 208 },
    { label: 'Yesterday', countLabel: '1', start: 502 },
  ]

  it('mirrors the section whose header is at or above the viewport top', () => {
    expect(pickStickySection(offsets, 0, 36)?.label).toBe('Pending')
    expect(pickStickySection(offsets, 100, 36)?.label).toBe('Pending')
    expect(pickStickySection(offsets, 208, 36)?.label).toBe('Today')
    expect(pickStickySection(offsets, 600, 36)?.label).toBe('Yesterday')
    expect(pickStickySection([], 100, 36)).toBeNull()
  })

  it('is pushed out by the next header exactly across the hand-off', () => {
    // Next header 20px away with a 36px-tall overlay: 16px of it is pushed up.
    const midHandOff = pickStickySection(offsets, 188, 36)
    expect(midHandOff).toMatchObject({ label: 'Pending', shift: 16 })
    // Far from the next header: no shift.
    expect(pickStickySection(offsets, 100, 36)?.shift).toBe(0)
    // The last section has nothing to push it.
    expect(pickStickySection(offsets, 900, 36)?.shift).toBe(0)
  })
})

describe('NotificationList pagination chrome', () => {
  const render = (ui: React.ReactElement) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={['/employee/dashboard']}>
        <ThemeProvider theme={theme}>{ui}</ThemeProvider>
      </MemoryRouter>,
    )
  const baseProps = {
    status: 'succeeded' as const,
    markingIds: [],
    markingAll: false,
    openAskCount: 0,
    unreadCount: 0,
    soundOn: true,
    currentUserId: 'viewer-1',
    hasMore: false,
    loadingMore: false,
    onToggleSound: () => undefined,
    onMarkRead: () => undefined,
    onMarkAllRead: () => undefined,
    onLoadMore: () => undefined,
  }

  it('renders a failed page inline with a retry, keeping the list', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification()]}
        hasMore
        loadMoreError="Request failed with status 500"
      />,
    )
    expect(html).toContain('needs your approval')
    expect(html).toContain('Couldn&#x27;t load older notifications.')
    expect(html).toContain('Retry')
  })

  it('says it is looking in older pages instead of claiming an empty tab', () => {
    const html = render(
      <NotificationList {...baseProps} items={[]} hasMore loadingMore />,
    )
    expect(html).toContain('Looking for older notifications')
    expect(html).not.toContain('You have no notifications yet')
  })

  it('shows the Pending section as loaded-of-total', () => {
    const html = render(
      <NotificationList
        {...baseProps}
        items={[notification()]}
        unreadCount={1}
        openAskCount={4}
        initialTab="actionNeeded"
      />,
    )
    // The tab pill carries the table-wide figure; the section header admits
    // how much of it is loaded.
    expect(html).toContain('>4<')
    expect(html).toContain('1 of 4')
  })
})

describe('NotificationBell badge', () => {
  // Static render through a real Provider: the bell reads the auth slice for
  // the user id and the notifications slice for the counts; effects (stream,
  // load) never run under renderToStaticMarkup, which is exactly what a badge
  // assertion needs.
  const renderBell = (partial: Partial<NotificationsState>) => {
    const notifications = { ...createInitialNotificationsState(), ...partial }
    const store = configureStore({
      reducer: {
        [sliceName]: (state = { user: { id: 'viewer-1' } }) => state,
        notifications: (state = notifications) => state,
      },
    })
    return renderToStaticMarkup(
      <Provider store={store}>
        <NotificationBell />
      </Provider>,
    )
  }

  // Matched in the class attribute: emotion also prints ".MuiBadge-dot" and
  // ".MuiBadge-invisible" as selectors inside its <style> blocks, which a
  // plain toContain would hit.
  const DOT = /class="[^"]*MuiBadge-dot/
  const INVISIBLE = /class="[^"]*MuiBadge-invisible/

  it('shows the unread number while anything is unread, never the dot', () => {
    const html = renderBell({ unreadCount: 2, openAskCount: 4 })
    expect(html).toContain('>2<')
    expect(html).not.toMatch(DOT)
  })

  it('falls back to the dot when all is read but decisions still wait', () => {
    // badgeContent must be omitted in dot mode: MUI hides a badge whose
    // content is 0 regardless of variant — this is the regression pin.
    const html = renderBell({ unreadCount: 0, openAskCount: 4 })
    expect(html).toMatch(DOT)
    expect(html).not.toMatch(INVISIBLE)
  })

  it('goes dark when nothing is unread and nothing waits', () => {
    const html = renderBell({ unreadCount: 0, openAskCount: 0 })
    expect(html).not.toMatch(DOT)
    expect(html).toMatch(INVISIBLE)
  })
})
