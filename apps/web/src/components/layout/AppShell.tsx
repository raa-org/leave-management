/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useContext, useEffect, useState, type ReactNode } from 'react'
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import EventAvailableRoundedIcon from '@mui/icons-material/EventAvailableRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import AppBar from '@mui/material/AppBar'
import BottomNavigation from '@mui/material/BottomNavigation'
import BottomNavigationAction from '@mui/material/BottomNavigationAction'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ReactReduxContext, useSelector } from 'react-redux'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { sliceName } from '@trusted-modules/auth-oidc-react'
import { IdentityAvatar } from '../identity'
import { NotificationBell } from '../../features/notifications/NotificationBell'

// Persisted across reloads so a collapsed sidebar stays collapsed. Collapse is a
// desktop (lg+) affordance only: below lg the sidebar is replaced by the fixed
// bottom app bar, so the flag is ignored there.
const NAV_COLLAPSED_STORAGE_KEY = 'leave-tracker.nav-collapsed'

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export type AppShellNavItem = {
  label: string
  to: string
  icon?: ReactNode
  description?: string
  badge?: ReactNode
  end?: boolean
}

export type AppShellNavSection = {
  title?: string
  items: AppShellNavItem[]
}

type AppShellAccent = 'primary' | 'secondary'

export type AppShellProps = {
  children: ReactNode
  title: string
  // ReactNode so pages can emphasize fragments (the dashboard bolds
  // "in N days" in its hero line).
  subtitle?: ReactNode
  toolbarActions?: ReactNode
  headerActions?: ReactNode
  headerSupplement?: ReactNode
  navigation?: AppShellNavSection[]
  navigationFooter?: ReactNode
  productName?: string
  productCaption?: string
  // Workspace accent: 'secondary' (teal) marks the administrator workspace on
  // the brand tile, caption, and active nav items; everything else stays on the
  // shared primary palette.
  accent?: AppShellAccent
  // Overrides the topbar breadcrumb for pages that are more specific than the
  // navigation item they sit under (a request's details, one employee's
  // profile). Left unset, the crumb names the active navigation item.
  breadcrumbLabel?: string
  // Topbar slot left of the identity cluster (prototype's "Live · updated N
  // min ago" pill).
  statusIndicator?: ReactNode
  // Rendered inline right after the h1 (the detail page's status pill sits
  // beside the title, not in the far-right actions slot).
  titleAdornment?: ReactNode
  // Rendered immediately to the LEFT of the title h1, vertically centered with
  // the name/subtitle block (the employee profile's avatar). Default undefined
  // leaves every other page's hero unchanged.
  titleIcon?: ReactNode
}

// Staggered entrance (prototype .reveal): rises 12px with a per-element delay.
function rise(delayMs: number) {
  return {
    animation: 'app-rise .55s cubic-bezier(.22,1,.36,1) both',
    animationDelay: `${delayMs}ms`,
  }
}

// Topbar freshness pill (prototype .live): green pulsing dot + label. The
// pill doubles as the network indicator: when the browser goes offline the
// dot stops pulsing and greys out and the label says so, and the caller's
// label returns the moment the connection is back. Browser-level
// connectivity (navigator.onLine) is the signal — cheap, no polling, and it
// covers exactly the "am I still saving?" question the pill answers.
export function ShellStatusPill({ label }: { label: string }) {
  // Only an explicit false is offline: node's global navigator has no onLine
  // at all, and server-rendered tests (no effects) must default to the online
  // look the callers' labels describe.
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  )

  useEffect(() => {
    const wentOnline = () => setOnline(true)
    const wentOffline = () => setOnline(false)
    window.addEventListener('online', wentOnline)
    window.addEventListener('offline', wentOffline)
    return () => {
      window.removeEventListener('online', wentOnline)
      window.removeEventListener('offline', wentOffline)
    }
  }, [])

  return (
    <Box
      sx={{
        display: { xs: 'none', md: 'inline-flex' },
        alignItems: 'center',
        gap: 0.875,
        px: 1.5,
        py: 0.625,
        borderRadius: 999,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        fontSize: 12,
        fontWeight: 700,
        color: online ? 'text.secondary' : 'text.disabled',
        whiteSpace: 'nowrap',
      }}
      data-testid="shell-status-pill"
    >
      <Box
        component="span"
        sx={{
          position: 'relative',
          width: 7,
          height: 7,
          borderRadius: '50%',
          bgcolor: online ? 'success.main' : 'text.disabled',
          flexShrink: 0,
          '&::after': online
            ? {
                content: '""',
                position: 'absolute',
                inset: -4,
                borderRadius: '50%',
                border: '2px solid',
                borderColor: 'success.main',
                opacity: 0,
                animation: 'app-pulse 2.4s ease-out infinite',
              }
            : undefined,
        }}
      />
      {online ? label : 'Offline · waiting for the connection to return'}
    </Box>
  )
}

// Brand lockup shared by the sidebar top and the no-navigation topbar, so
// approval/status pages (which have no sidebar) stay branded.
function BrandLockup({
  productName,
  productCaption,
  accent,
  collapsed = false,
}: {
  productName: string
  productCaption: string
  accent: AppShellAccent
  collapsed?: boolean
}) {
  return (
    <Box
      component={NavLink}
      to="/"
      aria-label={`${productName} - go to home`}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        minWidth: 0,
        px: 1,
        py: 0.5,
        textDecoration: 'none',
        color: 'inherit',
        justifyContent: { xs: 'flex-start', lg: collapsed ? 'center' : 'flex-start' },
      }}
    >
      <Box
        sx={(theme) => ({
          width: 34,
          height: 34,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '10px',
          color: theme.palette[accent].contrastText,
          background: `linear-gradient(135deg, ${theme.palette[accent].main}, ${theme.palette[accent].dark})`,
          boxShadow: `0 6px 14px -6px ${alpha(theme.palette[accent].main, 0.55)}`,
        })}
      >
        <EventAvailableRoundedIcon fontSize="small" />
      </Box>
      <Box sx={{ minWidth: 0, display: { xs: 'block', lg: collapsed ? 'none' : 'block' } }}>
        <Typography noWrap sx={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
          {productName}
        </Typography>
        <Typography
          noWrap
          sx={{
            fontSize: 11,
            fontWeight: accent === 'secondary' ? 700 : 600,
            lineHeight: 1.3,
            // Prototype .brand-cap: ink-3, one step lighter than body text.
            color: accent === 'secondary' ? 'secondary.main' : '#667085',
          }}
        >
          {productCaption}
        </Typography>
      </Box>
    </Box>
  )
}

function NavigationSection({
  section,
  collapsed,
  accent,
  collapseControl,
}: {
  section: AppShellNavSection
  collapsed: boolean
  accent: AppShellAccent
  // The collapse chevron always rides the FIRST section's title row (prototype
  // behavior): expanded it sits right of the group label, collapsed it becomes
  // the centered rail toggle while the label hides.
  collapseControl?: ReactNode
}) {
  // When collapsed, labels/descriptions/badges hide at lg while the icon stays
  // centered; the label moves into a hover tooltip instead. The xs branches are
  // inert (the whole sidebar is display:none below lg) but keep the collapsed
  // styling scoped to the breakpoint the rail actually renders at.
  const hideOnCollapse = { xs: 'block', lg: collapsed ? 'none' : 'block' } as const

  return (
    <Box component="nav" aria-label={section.title}>
      {section.title || collapseControl ? (
        <Stack
          direction="row"
          alignItems="center"
          sx={{
            minHeight: 26,
            mb: 0.75,
            px: 1.25,
            display: {
              xs: 'flex',
              // Collapsed rail: keep the row only where the chevron lives;
              // other groups drop it so the rail has no empty bands.
              lg: collapsed && !collapseControl ? 'none' : 'flex',
            },
            justifyContent: { xs: 'space-between', lg: collapsed ? 'center' : 'space-between' },
          }}
        >
          {section.title ? (
            <Typography
              variant="overline"
              sx={{
                // Prototype .nav-title: the palest ink so group labels recede
                // behind the items.
                color: '#98a2b3',
                display: { xs: 'block', lg: collapsed ? 'none' : 'block' },
              }}
            >
              {section.title}
            </Typography>
          ) : null}
          {collapseControl ?? null}
        </Stack>
      ) : null}
      <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        {section.items.map((item) => (
          <Tooltip
            key={`${item.to}-${item.label}`}
            title={collapsed ? item.label : ''}
            placement="right"
          >
            <ListItemButton
              component={NavLink}
              to={item.to}
              end={item.end}
              sx={(theme) => ({
                alignItems: 'center',
                gap: { xs: 1.25, lg: collapsed ? 0 : 1.25 },
                justifyContent: { xs: 'flex-start', lg: collapsed ? 'center' : 'flex-start' },
                px: { xs: 1.25, lg: collapsed ? 0 : 1.25 },
                // Prototype .nav-item: mid-grey resting labels that darken on
                // hover — the near-black default read too heavy.
                color: 'text.secondary',
                '&:hover': { color: 'text.primary' },
                '& .MuiListItemIcon-root': {
                  minWidth: 0,
                  color: 'text.secondary',
                },
                '& .MuiListItemText-root': { my: 0 },
                '& .MuiListItemText-primary': { fontSize: 14, fontWeight: 600 },
                '& .MuiListItemText-secondary': {
                  color: 'text.secondary',
                },
                '&.active .MuiListItemText-primary, &.active .MuiListItemText-secondary': {
                  color: 'inherit',
                },
                // Teal workspace accent. The doubled selector out-specifies the
                // theme's MuiListItemButton `.active` override (primary blue).
                ...(accent === 'secondary'
                  ? {
                      '&&.active': {
                        backgroundColor: alpha(theme.palette.secondary.main, 0.1),
                        color: theme.palette.secondary.main,
                      },
                      '&&.active .MuiListItemIcon-root': {
                        color: theme.palette.secondary.main,
                      },
                    }
                  : {}),
              })}
            >
              {item.icon ? <ListItemIcon>{item.icon}</ListItemIcon> : null}
              <ListItemText
                primary={item.label}
                secondary={item.description}
                sx={{ display: hideOnCollapse }}
                slotProps={{
                  // Prototype .nav-label: 14px/600. Enforced via slotProps so
                  // Typography variants can never override the nav face.
                  primary: { sx: { fontSize: 14, fontWeight: 600, lineHeight: 1.45 } },
                }}
              />
              {item.badge ? (
                <Chip
                  component="span"
                  label={item.badge}
                  size="small"
                  variant="outlined"
                  sx={{
                    alignSelf: 'center',
                    display: hideOnCollapse,
                    bgcolor: (theme) => alpha(theme.palette.common.white, 0.72),
                  }}
                />
              ) : null}
            </ListItemButton>
          </Tooltip>
        ))}
      </List>
    </Box>
  )
}

// The navigation item the current route belongs to. Longest matching `to` wins
// so nested routes resolve to the right item: /employee/history/:id belongs to
// "Request history", while /admin/activity/audit belongs to "Audit logs" (and
// "Activity feed" opts into exact matching via `end`).
function findActiveNavItem(
  sections: AppShellNavSection[],
  pathname: string,
): AppShellNavItem | undefined {
  return sections
    .flatMap((section) => section.items)
    .filter((item) =>
      item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
    )
    .sort((a, b) => b.to.length - a.to.length)[0]
}

// Fixed bottom app bar: the ONLY navigation below lg, where the sidebar is
// hidden entirely. Sections flatten into one row of icons (5 employee / 4
// admin items); the active destination is named by the topbar breadcrumb
// rather than under its icon, and the accent color marks it here.
function MobileBottomBar({
  sections,
  accent,
}: {
  sections: AppShellNavSection[]
  accent: AppShellAccent
}) {
  const { pathname } = useLocation()
  const items = sections.flatMap((section) => section.items)
  const selected = findActiveNavItem(sections, pathname)?.to ?? false

  return (
    <Box
      component="nav"
      aria-label="Primary"
      sx={(theme) => ({
        display: { xs: 'block', lg: 'none' },
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: theme.zIndex.appBar,
        borderTop: `1px solid ${theme.palette.divider}`,
        bgcolor: alpha(theme.palette.background.paper, 0.92),
        backdropFilter: 'blur(14px)',
        // Keeps the row clear of the iOS home indicator.
        pb: 'env(safe-area-inset-bottom)',
      })}
    >
      <BottomNavigation
        value={selected}
        sx={(theme) => ({
          bgcolor: 'transparent',
          '& .MuiBottomNavigationAction-root': {
            minWidth: 0,
            px: 0.5,
            color: theme.palette.text.secondary,
            '&.Mui-selected': { color: theme.palette[accent].main },
          },
        })}
      >
        {items.map((item) => (
          <BottomNavigationAction
            key={`${item.to}-${item.label}`}
            component={NavLink}
            to={item.to}
            end={item.end}
            value={item.to}
            // No visible labels: the icon alone marks the destination, so the
            // name has to reach assistive technology some other way. The full
            // wording is clearer read aloud than the compact one.
            aria-label={item.label}
            icon={item.icon}
          />
        ))}
      </BottomNavigation>
    </Box>
  )
}

type AuthOidcPartialState = Record<string, { user?: UserProfileType | null } | undefined>

// Sidebar-footer user card doubling as the workspace switcher: it links back to
// the landing chooser at "/". Redux-optional with the same two guards as
// AccountControls, so shells rendered without a store (or without the auth
// slice) simply omit it.
function WorkspaceSwitchCard({
  collapsed,
  accent,
}: {
  collapsed: boolean
  accent: AppShellAccent
}) {
  const reduxContext = useContext(ReactReduxContext)
  if (!reduxContext) {
    return null
  }
  return <WorkspaceSwitchCardInner collapsed={collapsed} accent={accent} />
}

function WorkspaceSwitchCardInner({
  collapsed,
  accent,
}: {
  collapsed: boolean
  accent: AppShellAccent
}) {
  const user = useSelector((state: AuthOidcPartialState) => state?.[sliceName]?.user ?? null)
  if (!user) {
    return null
  }

  const displayName = user.name?.trim() || user.email
  const roleLine = accent === 'secondary' ? 'Administrator' : 'Employee'

  return (
    <ButtonBase
      component={Link}
      to="/"
      aria-label={`${displayName} - switch workspace`}
      title="Switch workspace"
      sx={(theme) => ({
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        p: 0.75,
        borderRadius: '12px',
        textAlign: 'left',
        justifyContent: { xs: 'flex-start', lg: collapsed ? 'center' : 'flex-start' },
        // The card lifts slightly and the switch icon turns primary on hover,
        // so the whole footer reads as one actionable control.
        transition:
          'background .18s ease, transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s ease',
        '&:hover': {
          bgcolor: alpha(theme.palette.text.primary, 0.05),
          transform: 'scale(1.02)',
          boxShadow: '0 6px 16px -12px rgba(16, 24, 40, 0.3)',
        },
        '&:hover .switch-workspace-icon': { color: theme.palette.primary.main },
      })}
    >
      <IdentityAvatar user={user} size={34} />
      <Box sx={{ minWidth: 0, flex: 1, display: { xs: 'block', lg: collapsed ? 'none' : 'block' } }}>
        <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>
          {displayName}
        </Typography>
        <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.3 }}>
          {roleLine}
        </Typography>
      </Box>
      <SwapHorizRoundedIcon
        className="switch-workspace-icon"
        sx={{
          fontSize: 16,
          color: 'text.disabled',
          transition: 'color .18s ease',
          display: { xs: 'block', lg: collapsed ? 'none' : 'block' },
        }}
      />
    </ButtonBase>
  )
}

// Mobile stand-in for the sidebar footer card: below lg the sidebar (and with
// it the workspace-switch card) is hidden, so the topbar shows the avatar as a
// link to the landing workspace chooser instead. Redux-optional with the same
// two guards as WorkspaceSwitchCard.
function TopbarWorkspaceButton() {
  const reduxContext = useContext(ReactReduxContext)
  if (!reduxContext) {
    return null
  }
  return <TopbarWorkspaceButtonInner />
}

function TopbarWorkspaceButtonInner() {
  const user = useSelector((state: AuthOidcPartialState) => state?.[sliceName]?.user ?? null)
  if (!user) {
    return null
  }

  const displayName = user.name?.trim() || user.email

  return (
    <IconButton
      component={Link}
      to="/"
      aria-label={`${displayName} - switch workspace`}
      title="Switch workspace"
      sx={{ display: { xs: 'inline-flex', lg: 'none' }, p: 0.25, flexShrink: 0 }}
    >
      <IdentityAvatar user={user} size={30} />
    </IconButton>
  )
}

export function AppShell({
  children,
  title,
  subtitle,
  toolbarActions,
  headerActions,
  headerSupplement,
  navigation = [],
  navigationFooter,
  productName = 'Leave tracker',
  productCaption = 'Internal operations',
  accent = 'primary',
  breadcrumbLabel,
  statusIndicator,
  titleAdornment,
  titleIcon,
}: AppShellProps) {
  const hasNavigation = navigation.length > 0
  const { pathname } = useLocation()
  const activeNavItem = findActiveNavItem(navigation, pathname)
  // Page titles are prose ("Administrator activity" covers both the feed and
  // the audit log), so the crumb names the destination the way the navigation
  // does. An explicit breadcrumbLabel still wins for pages below a nav item.
  const crumb = breadcrumbLabel ?? activeNavItem?.label ?? title
  const [navCollapsed, setNavCollapsed] = useState(readCollapsedPreference)

  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, navCollapsed ? '1' : '0')
    } catch {
      // Ignore storage failures (private mode, disabled storage); collapse still
      // works for the current session, it just will not be remembered.
    }
  }, [navCollapsed])

  const collapseLabel = navCollapsed ? 'Expand navigation' : 'Collapse navigation'
  const collapseControl = (
    <Tooltip title={collapseLabel} placement="right">
      <IconButton
        size="small"
        onClick={() => setNavCollapsed((value) => !value)}
        aria-label={collapseLabel}
        aria-expanded={!navCollapsed}
        sx={{
          display: { xs: 'none', lg: 'inline-flex' },
          width: 26,
          height: 26,
          borderRadius: '8px',
          transition: 'transform .28s cubic-bezier(.22,1,.36,1)',
          transform: navCollapsed ? 'rotate(180deg)' : 'none',
        }}
      >
        <ChevronLeftRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  )

  return (
    <Box
      sx={(theme) => ({
        display: 'grid',
        minHeight: '100dvh',
        bgcolor: 'background.default',
        gridTemplateColumns: hasNavigation
          ? { xs: '1fr', lg: navCollapsed ? '80px minmax(0, 1fr)' : '252px minmax(0, 1fr)' }
          : '1fr',
        transition: theme.transitions.create('grid-template-columns', {
          duration: 280,
          easing: 'cubic-bezier(.22,1,.36,1)',
        }),
      })}
    >
      {hasNavigation ? (
        <Box
          component="aside"
          sx={{
            bgcolor: 'background.paper',
            borderColor: 'divider',
            borderStyle: 'solid',
            borderWidth: 0,
            borderRightWidth: 1,
            px: navCollapsed ? 1.25 : 1.75,
            py: 2.5,
            // Desktop-only surface: below lg navigation moves to the fixed
            // bottom app bar and the sidebar disappears entirely.
            display: { xs: 'none', lg: 'flex' },
            flexDirection: 'column',
            gap: 2.75,
            position: 'sticky',
            top: 0,
            height: '100dvh',
            overflowY: 'auto',
          }}
        >
          <BrandLockup
            productName={productName}
            productCaption={productCaption}
            accent={accent}
            collapsed={navCollapsed}
          />
          <Box
            sx={(theme) => ({
              display: 'flex',
              flexDirection: 'column',
              gap: 2.75,
              // Groups fade in with a light stagger on mount.
              '& > nav': { animation: 'app-rise .45s cubic-bezier(.22,1,.36,1) both' },
              '& > nav:nth-of-type(2)': { animationDelay: '50ms' },
              '& > nav:nth-of-type(3)': { animationDelay: '100ms' },
              '& > nav:nth-of-type(4)': { animationDelay: '150ms' },
              // Collapsed rail: hairlines between icon groups replace the
              // hidden group labels as the visual separator.
              [theme.breakpoints.up('lg')]: navCollapsed
                ? {
                    '& > nav + nav': {
                      borderTop: `1px solid ${theme.palette.divider}`,
                      paddingTop: theme.spacing(1.75),
                    },
                  }
                : {},
            })}
          >
            {navigation.map((section, index) => (
              <NavigationSection
                key={section.title ?? `section-${index}`}
                section={section}
                collapsed={navCollapsed}
                accent={accent}
                collapseControl={index === 0 ? collapseControl : undefined}
              />
            ))}
          </Box>
          <Box sx={{ mt: 'auto', borderTop: '1px solid', borderColor: 'divider', pt: 1.75 }}>
            {navigationFooter ? (
              <Box sx={{ mb: 1, display: { xs: 'block', lg: navCollapsed ? 'none' : 'block' } }}>
                {navigationFooter}
              </Box>
            ) : null}
            <WorkspaceSwitchCard collapsed={navCollapsed} accent={accent} />
          </Box>
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar
          position="sticky"
          sx={(theme) => ({
            bgcolor: alpha(theme.palette.background.default, 0.82),
            backdropFilter: 'blur(14px)',
          })}
        >
          <Toolbar disableGutters sx={{ minHeight: { xs: 56, sm: 56 } }}>
            <Box
              sx={{
                maxWidth: 1160,
                mx: 'auto',
                width: '100%',
                px: { xs: 2.5, md: 3.5 },
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              {hasNavigation ? (
                <Typography
                  component="nav"
                  aria-label="Breadcrumb"
                  data-testid="shell-breadcrumb"
                  variant="caption"
                  noWrap
                  sx={{ fontWeight: 600, color: 'text.secondary', minWidth: 0 }}
                >
                  {accent === 'secondary' ? 'Admin' : 'Employee'}
                  {' / '}
                  <Box component="b" sx={{ color: 'text.primary', fontWeight: 700 }}>
                    {crumb}
                  </Box>
                </Typography>
              ) : (
                <BrandLockup
                  productName={productName}
                  productCaption={productCaption}
                  accent={accent}
                />
              )}
              <Box sx={{ flexGrow: 1 }} />
              {statusIndicator}
              {toolbarActions}
              {/* The bell alone in the topbar (prototype .bell): the soft
                  container supplies the bordered surface the self-mounting,
                  do-not-modify NotificationBell was designed to sit on. It
                  self-mounts HERE only (never also in AdminLayout or the
                  employee frame — those wrap AppShell, and there would be two);
                  :empty hides the surface when the bell's guards render null.
                  Account/sign-out lives on the landing session card, reached
                  via the sidebar user card. */}
              <Box
                sx={(theme) => ({
                  // Prototype .bell: a compact 36px bordered paper square (the
                  // 34px self-mounting button + 1px border), not a padded chip.
                  display: 'inline-flex',
                  alignItems: 'center',
                  borderRadius: '10px',
                  bgcolor: 'background.paper',
                  border: `1px solid ${theme.palette.divider}`,
                  transition: 'border-color .15s ease',
                  '&:hover': { borderColor: alpha(theme.palette.primary.main, 0.35) },
                  '&:empty': { display: 'none' },
                  // Prototype .bell-badge: an 18px counter overhanging the
                  // BUTTON's top-right corner. MUI anchors the badge to its
                  // child (the small glyph), which lands it on top of the bell,
                  // so re-anchor it to this wrapper instead — all from outside,
                  // NotificationBell stays untouched.
                  position: 'relative',
                  '& .MuiBadge-root': { position: 'static' },
                  '& .MuiBadge-badge': {
                    position: 'absolute',
                    // -8px keeps even the widest cap ("99+" — the bell itself
                    // caps at max=99) clear of the glyph: the pill grows
                    // leftwards from the corner, so it must ride high enough
                    // to stay above the bell's outline.
                    top: -8,
                    right: -8,
                    transform: 'none',
                    minWidth: 18,
                    height: 18,
                    px: '5px',
                    fontSize: 10.5,
                    fontWeight: 800,
                    lineHeight: 1,
                    borderRadius: 999,
                    border: '2px solid',
                    borderColor: 'background.paper',
                  },
                  '& .MuiBadge-invisible': { display: 'none' },
                })}
              >
                <NotificationBell />
              </Box>
              {hasNavigation ? <TopbarWorkspaceButton /> : null}
            </Box>
          </Toolbar>
        </AppBar>

        <Box
          component="main"
          sx={{
            maxWidth: 1160,
            mx: 'auto',
            width: '100%',
            px: { xs: 2.5, md: 3.5 },
            pt: { xs: 3, md: 3.25 },
            // Below lg the fixed bottom app bar overlays the viewport, so the
            // content clears the bar's 56px height plus the safe-area inset,
            // with 40px of breathing room on top of that.
            pb: hasNavigation
              ? { xs: 'calc(96px + env(safe-area-inset-bottom))', lg: 7 }
              : 7,
            display: 'flex',
            flexDirection: 'column',
            gap: 2.75,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
              ...rise(40),
            }}
          >
            {/* Optional title icon (the profile avatar) rides left of the
                name/subtitle block, vertically centered with it. Without an
                icon this is a single-child flex row, visually identical to the
                previous bare block. */}
            <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 1.75 }}>
              {titleIcon ? (
                <Box sx={{ flexShrink: 0, display: 'flex' }}>{titleIcon}</Box>
              ) : null}
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
                  <Typography
                    variant="h1"
                    sx={{ fontSize: '1.625rem', fontWeight: 800, letterSpacing: '-0.02em' }}
                  >
                    {title}
                  </Typography>
                  {titleAdornment}
                </Box>
                {subtitle ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 560 }}>
                    {subtitle}
                  </Typography>
                ) : null}
              </Box>
            </Box>
            {headerActions ? <Box sx={{ flexShrink: 0 }}>{headerActions}</Box> : null}
          </Box>

          {headerSupplement ? <Box sx={rise(110)}>{headerSupplement}</Box> : null}

          <Stack
            spacing={3}
            sx={{
              // Content sections rise one after another (prototype .reveal
              // stagger). Six explicit steps cover every real page; anything
              // deeper shares the last delay.
              '& > *': { animation: 'app-rise .55s cubic-bezier(.22,1,.36,1) both' },
              '& > *:nth-of-type(1)': { animationDelay: '90ms' },
              '& > *:nth-of-type(2)': { animationDelay: '150ms' },
              '& > *:nth-of-type(3)': { animationDelay: '210ms' },
              '& > *:nth-of-type(4)': { animationDelay: '270ms' },
              '& > *:nth-of-type(5)': { animationDelay: '330ms' },
              '& > *:nth-of-type(n+6)': { animationDelay: '390ms' },
            }}
          >
            {children}
          </Stack>
        </Box>

        {hasNavigation ? <MobileBottomBar sections={navigation} accent={accent} /> : null}
      </Box>
    </Box>
  )
}
