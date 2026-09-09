/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { sliceName } from '@trusted-modules/auth-oidc-react'
import { AppShell } from './AppShell'
import {
  adminNavigationSections,
  employeeNavigationSections,
} from '../../lib/app-navigation'

function render(ui: React.ReactNode, route = '/'): string {
  return renderToString(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>)
    .split('<!-- -->')
    .join('')
}

// Text content of the topbar breadcrumb alone: the page title renders in the
// hero h1 too, so a whole-document match cannot tell the two apart.
function crumbText(html: string): string {
  const crumb = /data-testid="shell-breadcrumb"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? ''
  // Emotion inlines a <style> block inside the element; drop it with its CSS
  // text before flattening the remaining markup to plain text.
  return crumb
    .replace(/<style[^>]*>.*?<\/style>/g, '')
    .replace(/<[^>]*>/g, '')
    .trim()
}

describe('AppShell', () => {
  it('renders the employee workspace: caption, breadcrumb, and only employee nav', () => {
    const html = render(
      <AppShell
        title="Leave dashboard"
        navigation={employeeNavigationSections}
        productCaption="Employee workspace"
        breadcrumbLabel="Dashboard"
      >
        content
      </AppShell>,
    )
    expect(html).toContain('Employee workspace')
    expect(html).toContain('shell-breadcrumb')
    expect(html).toContain('Employee / ')
    // Workspace-scoped nav: employee links present, admin links absent.
    expect(html).toContain('href="/employee/request"')
    expect(html).toContain('href="/employee/holidays"')
    expect(html).not.toContain('href="/admin/settings"')
    // Group titles from the prototype structure.
    expect(html).toContain('Overview')
    expect(html).toContain('Requests')
    expect(html).toContain('Reference')
  })

  it('renders the admin accent variant with its own sections and crumb prefix', () => {
    const html = render(
      <AppShell
        title="Administrator activity"
        accent="secondary"
        navigation={adminNavigationSections}
        productCaption="Administrator workspace"
      >
        content
      </AppShell>,
    )
    expect(html).toContain('Administrator workspace')
    expect(html).toContain('Admin / ')
    expect(html).toContain('href="/admin/activity/audit"')
    expect(html).toContain('href="/admin/employees"')
    expect(html).not.toContain('href="/employee/dashboard"')
  })

  it('keeps the brand lockup in the topbar when there is no navigation', () => {
    const html = render(
      <AppShell title="Approval review" productCaption="Approval workflow">
        content
      </AppShell>,
    )
    expect(html).toContain('Leave tracker')
    expect(html).toContain('Approval workflow')
    expect(html).not.toContain('shell-breadcrumb')
  })

  it('names the active navigation item in the breadcrumb', () => {
    // Both activity routes share the page title "Administrator activity", so
    // the crumb has to come from the navigation to tell them apart.
    const audit = render(
      <AppShell title="Administrator activity" accent="secondary" navigation={adminNavigationSections}>
        content
      </AppShell>,
      '/admin/activity/audit',
    )
    expect(crumbText(audit)).toBe('Admin / Audit logs')

    const feed = render(
      <AppShell title="Administrator activity" accent="secondary" navigation={adminNavigationSections}>
        content
      </AppShell>,
      '/admin/activity',
    )
    expect(crumbText(feed)).toBe('Admin / Activity feed')

    // A page below a nav item keeps its own, more specific crumb.
    const profile = render(
      <AppShell
        title="Maya Chen"
        accent="secondary"
        navigation={adminNavigationSections}
        breadcrumbLabel="Maya Chen"
      >
        content
      </AppShell>,
      '/admin/employees/employee-1',
    )
    expect(crumbText(profile)).toBe('Admin / Maya Chen')
  })

  it('renders the mobile bottom bar only when the shell has navigation', () => {
    const withNav = render(
      <AppShell title="T" navigation={employeeNavigationSections}>
        content
      </AppShell>,
    )
    // Flattened sections: every employee destination appears as a bottom action.
    // Anchor the count on rendered <a> elements — the bare class name also
    // occurs inside the inlined SSR style sheets.
    expect(withNav).toContain('MuiBottomNavigation-root')
    expect(withNav.match(/<a[^>]+MuiBottomNavigationAction-root/g)?.length).toBe(5)

    // Icons only. MUI always renders the label element, so assert it carries no
    // text rather than that it is absent; the destination name reaches assistive
    // technology through aria-label instead.
    const labelSpans =
      withNav.match(/<span[^>]+MuiBottomNavigationAction-label[^>]*>([^<]*)</g) ?? []
    expect(labelSpans).toHaveLength(5)
    expect(labelSpans.every((span) => span.endsWith('><'))).toBe(true)
    expect(withNav).toContain('aria-label="Request history"')

    const withoutNav = render(<AppShell title="T">content</AppShell>)
    expect(withoutNav).not.toContain('MuiBottomNavigation-root')
  })

  it('shows the workspace switch card only for a signed-in store', () => {
    // No Redux provider at all: the card (like the bell/account cluster)
    // renders nothing instead of crashing.
    const bare = render(
      <AppShell title="T" navigation={employeeNavigationSections}>
        content
      </AppShell>,
    )
    expect(bare).not.toContain('switch workspace')

    const store = configureStore({
      reducer: (state = { [sliceName]: { user: { name: 'Maya Chen', email: 'maya@example.com' } } }) =>
        state,
    })
    const withUser = renderToString(
      <MemoryRouter>
        <Provider store={store}>
          <AppShell title="T" navigation={employeeNavigationSections}>
            content
          </AppShell>
        </Provider>
      </MemoryRouter>,
    )
    expect(withUser).toContain('switch workspace')
    expect(withUser).toContain('Maya Chen')
    // Role line follows the accent: primary shell reads Employee.
    expect(withUser).toContain('Employee')
  })
})
