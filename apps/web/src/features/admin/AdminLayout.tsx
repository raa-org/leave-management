/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import { AppShell } from '../../components/layout/AppShell'
import { adminNavigationSections } from '../../lib/app-navigation'
import { TestToolingPanel } from './TestToolingPanel'

type AdminLayoutProps = {
  children: ReactNode
  title: string
  subtitle: ReactNode
  toolbarActions?: ReactNode
  headerActions?: ReactNode
  headerSupplement?: ReactNode
  // Forwarded to AppShell like EmployeePageFrame does, so redesigned admin
  // pages can add a topbar status pill, an inline title adornment, or override
  // the breadcrumb tail.
  breadcrumbLabel?: string
  statusIndicator?: ReactNode
  titleAdornment?: ReactNode
  titleIcon?: ReactNode
}

export function AdminLayout({
  children,
  title,
  subtitle,
  toolbarActions,
  headerActions,
  headerSupplement,
  breadcrumbLabel,
  statusIndicator,
  titleAdornment,
  titleIcon,
}: AdminLayoutProps) {
  return (
    // The tooling panel is fixed-positioned, so it takes no space - but as a
    // child of the content stack it still counts as a CSS sibling and pushed a
    // phantom gap above the first section. It lives outside the shell instead.
    <>
      <AppShell
        title={title}
        subtitle={subtitle}
        navigation={adminNavigationSections}
        toolbarActions={toolbarActions}
        headerActions={headerActions}
        headerSupplement={headerSupplement}
        breadcrumbLabel={breadcrumbLabel}
        statusIndicator={statusIndicator}
        titleAdornment={titleAdornment}
        titleIcon={titleIcon}
        productName="Leave tracker"
        productCaption="Administrator workspace"
        accent="secondary"
      >
        {children}
      </AppShell>
      <TestToolingPanel />
    </>
  )
}
