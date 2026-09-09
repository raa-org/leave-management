/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactElement } from 'react'
import { Provider } from 'react-redux'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import { fetchMeThunk } from '@trusted-modules/auth-oidc-react'
import { describe, expect, it, vi } from 'vitest'
import { AppRoleName } from '@workspace/contracts'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import App from './App'
import { createAppStore, type AppStore } from './store'
import theme from './theme'

function renderRoute(route: string, store: AppStore): string {
  return renderToString(
    <Provider store={store}>
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={theme}>
          <App />
        </ThemeProvider>
      </MemoryRouter>
    </Provider>,
  )
}

function authenticate(store: AppStore, user: UserProfileType) {
  store.dispatch(fetchMeThunk.fulfilled(user, 'test-request', undefined))
}

describe('App integration', () => {
  it('renders a focused sign-in landing for anonymous visitors, not a route dump', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    const html = renderRoute('/', store)

    // The primary action and the capability story are present...
    expect(html).toContain('Sign in')
    expect(html).toContain('Everything a leave workflow needs')
    // ...but the old route dump is gone: no direct links into protected routes
    // ever reach an anonymous visitor.
    expect(html).not.toContain('href="/employee/request"')
    expect(html).not.toContain('href="/admin/employees"')
    expect(html).not.toContain('href="/admin/settings"')
  })

  it('offers the employee workspace and locks the admin workspace for a non-admin', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    authenticate(store, {
      id: 'employee-1',
      email: 'employee@example.com',
      name: 'Employee User',
      roles: [AppRoleName.Employee],
    })

    const html = renderRoute('/', store)

    expect(html).toContain('Welcome back')
    expect(html).toContain('Enter employee workspace')
    expect(html).toContain('Enter admin workspace')
    expect(html).toContain('Requires the administrator role')
    expect(html).toContain('employee@example.com')
  })

  it('offers both workspaces to an administrator', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    authenticate(store, {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin User',
      roles: [AppRoleName.Employee, AppRoleName.Administrator],
    })

    const html = renderRoute('/', store)

    expect(html).toContain('Welcome back')
    expect(html).toContain('Enter employee workspace')
    expect(html).toContain('Enter admin workspace')
    expect(html).toContain('Manage the directory, holiday calendars, activity, and leave settings.')
    expect(html).not.toContain('Requires the administrator role')
  })

  it('mounts the employee dashboard route for an authenticated user', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    authenticate(store, {
      id: 'employee-1',
      email: 'employee@example.com',
      name: 'Employee User',
      roles: [AppRoleName.Employee],
    })

    const html = renderRoute('/employee/dashboard', store)

    expect(html).toContain('Leave dashboard')
    expect(html).toContain('Loading dashboard')
  })

  it('mounts the administrator activity route for an administrator', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    authenticate(store, {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin User',
      roles: [AppRoleName.Administrator],
    })

    const html = renderRoute('/admin/activity', store)

    expect(html).toContain('Administrator activity')
    expect(html).toContain('Activity feed')
  })

  it('blocks administrator routes for non-admin users', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    authenticate(store, {
      id: 'employee-1',
      email: 'employee@example.com',
      name: 'Employee User',
      roles: [AppRoleName.Employee],
    })

    const html = renderRoute('/admin/activity', store)

    expect(html).toContain('Administrator access only')
    expect(html).toContain('Open employee dashboard')
    // A signed-in user (wrong role) still gets the employee nav to move around;
    // admin routes are no longer offered in a workspace-scoped sidebar.
    // /employee/request comes ONLY from the sidebar nav (the action button
    // links to the dashboard), so this pins the nav itself.
    expect(html).toContain('href="/employee/dashboard"')
    expect(html).toContain('href="/employee/request"')
    expect(html).not.toContain('href="/admin/settings"')
  })

  it('redirects an anonymous deep-link into a protected route to the landing', () => {
    const store = createAppStore({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    })

    // No authenticate() -> the user is null (anonymous), as on a cold deep-link.
    // The guard now renders <Navigate to="/" replace />. Under SSR (renderToString,
    // no effects) Navigate renders nothing, so we assert the old in-page "Sign in
    // required" notice is gone and no protected nav/content leaks before the redirect.
    const html = renderRoute('/employee/dashboard', store)

    expect(html).not.toContain('Sign in required')
    // The route list must never reach a not-yet-signed-in visitor.
    expect(html).not.toContain('href="/admin/settings"')
    expect(html).not.toContain('href="/employee/history"')
  })
})
