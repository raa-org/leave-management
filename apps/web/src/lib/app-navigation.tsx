/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded'
import BarChartRoundedIcon from '@mui/icons-material/BarChartRounded'
import CalendarMonthRoundedIcon from '@mui/icons-material/CalendarMonthRounded'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded'
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded'
import type { AppShellNavSection } from '../components/layout/AppShell'

// Single source of truth for workspace navigation. Each workspace renders only
// its own sections (the sidebar is workspace-scoped); switching workspaces goes
// through the landing chooser at "/", linked from the sidebar footer.
export const employeeNavigationSections: AppShellNavSection[] = [
  {
    title: 'Overview',
    items: [
      {
        label: 'Dashboard',
        to: '/employee/dashboard',
        icon: <SpaceDashboardRoundedIcon fontSize="small" />,
      },
    ],
  },
  {
    title: 'Requests',
    items: [
      {
        label: 'New request',
        to: '/employee/request',
        icon: <AddCircleOutlineRoundedIcon fontSize="small" />,
      },
      {
        label: 'Request history',
        to: '/employee/history',
        icon: <HistoryRoundedIcon fontSize="small" />,
      },
    ],
  },
  {
    title: 'Balance',
    items: [
      {
        label: 'Balance timeline',
        to: '/employee/balance',
        icon: <BarChartRoundedIcon fontSize="small" />,
      },
    ],
  },
  {
    title: 'Reference',
    items: [
      {
        label: 'Holiday calendars',
        to: '/employee/holidays',
        icon: <CalendarMonthRoundedIcon fontSize="small" />,
      },
    ],
  },
]

export const adminNavigationSections: AppShellNavSection[] = [
  {
    title: 'Activity',
    items: [
      {
        label: 'Activity feed',
        to: '/admin/activity',
        // NavLink matches by prefix; without `end` this item would also light up
        // on /admin/activity/audit alongside the Audit logs item.
        end: true,
        icon: <TimelineRoundedIcon fontSize="small" />,
      },
      {
        label: 'Audit logs',
        to: '/admin/activity/audit',
        icon: <FactCheckRoundedIcon fontSize="small" />,
      },
    ],
  },
  {
    title: 'Manage',
    items: [
      {
        label: 'Employees',
        to: '/admin/employees',
        icon: <GroupsRoundedIcon fontSize="small" />,
      },
      {
        label: 'Settings',
        to: '/admin/settings',
        icon: <SettingsRoundedIcon fontSize="small" />,
      },
    ],
  },
]
