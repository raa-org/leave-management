/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { AppRoleName } from '@workspace/contracts'
import { useAuth } from '@trusted-modules/auth-oidc-react'
import { Link, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import type { AppShellNavSection } from './components/layout/AppShell'
import { ScrollToTop } from './components/ScrollToTop'
import { employeeNavigationSections } from './lib/app-navigation'
import LandingPage from './features/landing/LandingPage'
import AdminActivityPage from './features/admin/AdminActivityPage'
import AdminAuditLogsPage from './features/admin/AdminAuditLogsPage'
import AdminEmployeesPage from './features/admin/AdminEmployeesPage'
import AdminEmployeeProfilePage from './features/admin/AdminEmployeeProfilePage'
import AdminSettingsPage from './features/admin/AdminSettingsPage'
import { ApprovalReviewRoutePage } from './features/approval'
import { EmployeeDashboardPageContent } from './features/employee/EmployeeDashboardPage'
import { BalanceTimelinePageContent } from './features/employee/BalanceTimelinePage'
import { LeaveHistoryPageContent } from './features/employee/LeaveHistoryPage'
import { LeaveRequestDetailRoutePage } from './features/employee/LeaveRequestDetailPage'
import { LeaveRequestPageContent } from './features/employee/LeaveRequestPage'
import { HolidaysPageContent } from './features/holidays/HolidaysPage'

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/employee" element={<Navigate to="/employee/dashboard" replace />} />
        <Route
          path="/employee/dashboard"
          element={
            <RequireAuthenticated>
              <EmployeeDashboardPageContent />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/request"
          element={
            <RequireAuthenticated>
              <LeaveRequestPageContent />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/history"
          element={
            <RequireAuthenticated>
              <LeaveHistoryPageContent />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/history/:requestId"
          element={
            <RequireAuthenticated>
              <LeaveRequestDetailRoutePage />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/balance"
          element={
            <RequireAuthenticated>
              <BalanceTimelinePageContent />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/holidays"
          element={
            <RequireAuthenticated>
              <HolidaysPageContent />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/employee/approval/review/:requestId"
          element={
            <RequireAuthenticated>
              <ApprovalReviewRoutePage />
            </RequireAuthenticated>
          }
        />
        <Route
          path="/admin/approval/review/:requestId"
          element={
            <RequireAdministrator>
              <ApprovalReviewRoutePage />
            </RequireAdministrator>
          }
        />
        <Route path="/admin" element={<Navigate to="/admin/activity" replace />} />
        <Route
          path="/admin/activity"
          element={
            <RequireAdministrator>
              <AdminActivityPage />
            </RequireAdministrator>
          }
        />
        <Route
          path="/admin/activity/audit"
          element={
            <RequireAdministrator>
              <AdminAuditLogsRoutePage />
            </RequireAdministrator>
          }
        />
        <Route
          path="/admin/employees"
          element={
            <RequireAdministrator>
              <AdminEmployeesPage />
            </RequireAdministrator>
          }
        />
        <Route
          path="/admin/employees/:employeeId"
          element={
            <RequireAdministrator>
              <AdminEmployeeProfilePage />
            </RequireAdministrator>
          }
        />
        {/* Policies and the import wizard moved into Settings; keep the old
            addresses working. The hash names the tab the settings page opens. */}
        <Route
          path="/admin/policies"
          element={<Navigate replace to="/admin/settings" />}
        />
        <Route
          path="/admin/import"
          element={<Navigate replace to="/admin/settings#import" />}
        />
        <Route
          path="/admin/settings"
          element={
            <RequireAdministrator>
              <AdminSettingsPage />
            </RequireAdministrator>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  )
}

// Reads the optional ?userId= filter so the employee directory can deep-link
// into one employee's audit trail.
function AdminAuditLogsRoutePage() {
  const [searchParams] = useSearchParams()
  const userId = searchParams.get('userId') ?? undefined
  return <AdminAuditLogsPage userId={userId} />
}

function RequireAuthenticated({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading && !user) {
    return <SessionStatusPage title="Checking your session" message="Checking your sign-in before opening the workspace." />
  }

  // Session absent or expired (the 1h cookie lapsed) -> send them to the landing
  // to sign in, instead of surfacing an in-page "sign in required" / 401 notice.
  if (!user) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

function RequireAdministrator({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading && !user) {
    return <SessionStatusPage title="Checking administrator access" message="Checking your sign-in before opening administrator pages." />
  }

  // Session absent or expired -> redirect to the landing. A signed-in user
  // WITHOUT the admin role is a different case, handled below (not redirected).
  if (!user) {
    return <Navigate to="/" replace />
  }

  if (!user.roles.includes(AppRoleName.Administrator)) {
    return (
      <SessionStatusPage
        title="Administrator access only"
        message="This account is signed in, but it does not have the administrator role needed to manage other people's leave."
        navigation={employeeNavigationSections}
        action={
          <Button component={Link} to="/employee/dashboard" variant="outlined">
            Open employee dashboard
          </Button>
        }
      />
    )
  }

  return <>{children}</>
}

function NotFoundPage() {
  return (
    <SessionStatusPage
      title="Page not found"
      message="This page does not exist. Go back to the home page to sign in and open a workspace."
    />
  )
}

function SessionStatusPage({
  title,
  message,
  action,
  navigation,
}: {
  title: string
  message: string
  action?: ReactNode
  // Only signed-in states (e.g. a wrong-role user) pass the full workspace nav.
  // Anonymous / not-found states omit it so the route list never leaks pre-login.
  navigation?: AppShellNavSection[]
}) {
  return (
    <AppShell
      title={title}
      subtitle={message}
      navigation={navigation}
      productName="Leave tracker"
      productCaption="Access control"
    >
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="body1" color="text.secondary">
              {message}
            </Typography>
            <Divider />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              {action}
              <Button component={Link} to="/" variant="outlined">
                Workspace home
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </AppShell>
  )
}
