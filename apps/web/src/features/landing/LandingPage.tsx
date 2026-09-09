/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded'
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import CalendarMonthRoundedIcon from '@mui/icons-material/CalendarMonthRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import EventAvailableRoundedIcon from '@mui/icons-material/EventAvailableRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import LockRoundedIcon from '@mui/icons-material/LockRounded'
import LoginRoundedIcon from '@mui/icons-material/LoginRounded'
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded'
import MarkEmailReadRoundedIcon from '@mui/icons-material/MarkEmailReadRounded'
import PersonRoundedIcon from '@mui/icons-material/PersonRounded'
import SendRoundedIcon from '@mui/icons-material/SendRounded'
import { useRef } from 'react'
import Alert from '@mui/material/Alert'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import Fade from '@mui/material/Fade'
import Grid from '@mui/material/Grid'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha, keyframes } from '@mui/material/styles'
import type { CSSObject, Theme } from '@mui/material/styles'
import { AppRoleName } from '@workspace/contracts'
import { useAuth } from '@trusted-modules/auth-oidc-react'
import { useNavigate } from 'react-router-dom'
import { IdentityAvatar } from '../../components/identity'
import { COMPANY_NAME } from '../../lib/company-name'
import { signOut } from '../../lib/session'

// The public "/" route. A self-owned split-hero landing (the "Split hero" design)
// that does NOT mount AppShell, so an anonymous visitor never sees the route
// left-nav. Header is identity-only; capability tiles are non-interactive story;
// after sign-in the page becomes a full workspace chooser (admin locked, not
// hidden). A synchronous session-resolution gate holds a neutral loader until we
// KNOW whether there is a session, so the page never flashes signed-out then in.

type SessionUser = NonNullable<ReturnType<typeof useAuth>['user']>
type Accent = 'primary' | 'secondary'
type SxFn = (theme: Theme) => CSSObject

// ---------------------------------------------------------------------------
// Motion helpers - all gated on one reduced-motion flag, with an @media reset.
// ---------------------------------------------------------------------------

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
`

const drift = keyframes`
  0%   { transform: translate3d(-4%, -3%, 0) scale(1); }
  50%  { transform: translate3d(5%, 4%, 0) scale(1.08); }
  100% { transform: translate3d(-4%, -3%, 0) scale(1); }
`

function entranceSx(delayMs: number, reduce: boolean): CSSObject {
  if (reduce) return {}
  return {
    animation: `${fadeUp} 520ms cubic-bezier(0.16, 1, 0.3, 1) both`,
    animationDelay: `${delayMs}ms`,
    '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 1, transform: 'none' },
  }
}

// Soft lift for interactive surfaces (the workspace choice cards).
function cardHoverSx(reduce: boolean): SxFn {
  return (theme) => ({
    transition: 'transform .18s ease, border-color .18s ease, box-shadow .18s ease',
    '&:hover': {
      transform: reduce ? 'none' : 'translateY(-3px)',
      borderColor: theme.palette.primary.light,
      boxShadow: `0 12px 28px ${alpha(theme.palette.primary.main, 0.12)}`,
    },
    '&.Mui-focusVisible': {
      borderColor: theme.palette.primary.main,
    },
  })
}

// The glass "anchor" card treatment (sign-in card).
const glassSx: SxFn = (theme) => ({
  borderRadius: '14px',
  backgroundColor: alpha(theme.palette.background.paper, 0.72),
  backdropFilter: 'blur(20px)',
  border: `1px solid ${alpha(theme.palette.primary.main, 0.14)}`,
  boxShadow: `0 18px 48px -22px ${alpha(theme.palette.primary.main, 0.35)}, 0 1px 2px ${alpha(theme.palette.text.primary, 0.04)}`,
})

// A soft eyebrow chip (outlined, tinted from an accent) - the "pill" the design
// uses for "Self-hosted leave management" / "Company single sign-on" / "Signed in".
function eyebrowChipSx(accent: Accent): SxFn {
  return (theme) => ({
    height: 'auto',
    borderRadius: '8px',
    padding: '3px 4px',
    fontWeight: 700,
    color: theme.palette[accent].main,
    backgroundColor: alpha(theme.palette[accent].main, 0.06),
    borderColor: alpha(theme.palette[accent].main, 0.28),
    '& .MuiChip-icon': { color: theme.palette[accent].main },
  })
}

// A small square icon tile filled with an accent at 10% alpha.
function IconTile({
  size,
  accent,
  children,
}: {
  size: number
  accent: Accent
  children: ReactNode
}) {
  return (
    <Box
      sx={(theme) => ({
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '10px',
        flexShrink: 0,
        bgcolor: alpha(theme.palette[accent].main, 0.1),
        color: theme.palette[accent].main,
      })}
    >
      {children}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Ambient background: two blurred blobs + a faint dot-grid that fades below the
// hero. Static under reduced motion.
// ---------------------------------------------------------------------------

const auroraBlobs: Array<{ key: string; color: Accent; a: number; size: string; duration: string; delay: string; pos: CSSObject }> = [
  { key: 'primary', color: 'primary', a: 0.12, size: '64vw', duration: '34s', delay: '0s', pos: { top: '-18%', right: '-10%' } },
  { key: 'secondary', color: 'secondary', a: 0.09, size: '58vw', duration: '42s', delay: '-9s', pos: { top: '18%', left: '-16%' } },
]

function AuroraBackground() {
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  return (
    <Box aria-hidden sx={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {auroraBlobs.map((blob) => (
        <Box
          key={blob.key}
          sx={[
            (theme) => ({
              position: 'absolute',
              width: blob.size,
              height: blob.size,
              borderRadius: '50%',
              filter: 'blur(56px)',
              background: `radial-gradient(circle, ${alpha(theme.palette[blob.color].main, blob.a)} 0%, transparent 70%)`,
              animation: reduce ? 'none' : `${drift} ${blob.duration} ease-in-out ${blob.delay} infinite alternate`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }),
            blob.pos,
          ]}
        />
      ))}
    </Box>
  )
}

function DotGridBackground() {
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        backgroundImage: `radial-gradient(${alpha(theme.palette.text.primary, 0.05)} 1px, transparent 1px)`,
        backgroundSize: '22px 22px',
        maskImage: 'linear-gradient(#000, transparent 62%)',
        WebkitMaskImage: 'linear-gradient(#000, transparent 62%)',
      })}
    />
  )
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function SessionErrorAlert({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Alert
      severity="error"
      variant="outlined"
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {error}
    </Alert>
  )
}

// ---------------------------------------------------------------------------
// Header: brand lockup + identity/session controls only. No route links.
// ---------------------------------------------------------------------------

function LandingHeader({
  user,
  isLoading,
  booting,
  login,
}: {
  user: SessionUser | null
  isLoading: boolean
  booting: boolean
  login: () => void
}) {
  return (
    <AppBar position="sticky" elevation={0} sx={{ zIndex: 20 }}>
      <Toolbar sx={{ minHeight: { xs: 60, md: 64 }, gap: 2 }}>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              width: 34,
              height: 34,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '10px',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              flexShrink: 0,
            }}
          >
            <EventAvailableRoundedIcon fontSize="small" />
          </Box>
          <Typography variant="subtitle1" component="p" fontWeight={800} letterSpacing="-0.02em" noWrap>
            Leave tracker
          </Typography>
        </Stack>

        {booting ? (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <CircularProgress size={16} thickness={5} aria-label="Checking access" />
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
              Checking access…
            </Typography>
          </Stack>
        ) : user ? (
          // Only the action lives in the header: the page below already greets
          // the user by name, so an avatar and email chip here would repeat it.
          <Button variant="text" startIcon={<LogoutRoundedIcon />} onClick={signOut}>
            Sign out
          </Button>
        ) : // Signed out, no header button at all: the hero's "Sign in with
        // SSO" card is the single entry point.
        null}
      </Toolbar>
    </AppBar>
  )
}

// ---------------------------------------------------------------------------
// Signed-out: split hero (copy + sign-in anchor card) + capabilities.
// ---------------------------------------------------------------------------

const signInProof = [
  'Submit a request and it goes to the right approvers automatically.',
  'Approvers get an email, sign in, and decide — only listed approvers can act.',
  'A complete approval history, limited to what you are allowed to see.',
]

function SignInPanel({ error, login, refresh }: { error: string | null; login: () => void; refresh: () => void }) {
  return (
    <Card sx={glassSx}>
      <CardContent sx={{ p: { xs: 3, md: 3.25 } }}>
        <Stack spacing={2.25}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <IconTile size={44} accent="primary">
              <PersonRoundedIcon />
            </IconTile>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" component="p">
                Not signed in
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Use your work account to continue
              </Typography>
            </Box>
          </Stack>

          {error ? <SessionErrorAlert error={error} onRetry={refresh} /> : null}

          <Button variant="contained" size="large" fullWidth startIcon={<LoginRoundedIcon />} onClick={login}>
            Sign in with SSO
          </Button>

          <Divider />

          <Stack spacing={1.25}>
            {signInProof.map((line) => (
              <Stack key={line} direction="row" spacing={1.25} alignItems="flex-start">
                <Box
                  sx={(theme) => ({
                    mt: '2px',
                    width: 20,
                    height: 20,
                    borderRadius: '6px',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                    bgcolor: alpha(theme.palette.secondary.main, 0.1),
                    color: theme.palette.secondary.main,
                  })}
                >
                  <CheckRoundedIcon sx={{ fontSize: 14 }} />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {line}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

const capabilities: Array<{
  icon: ReactNode
  title: string
  description: string
  accent: Accent
  size: { xs: number; sm: number; md: number }
}> = [
  {
    icon: <AccountBalanceWalletRoundedIcon />,
    title: 'Vacation & sick balances',
    description: 'See accrued, used, and remaining days per leave type, updated as requests are approved.',
    accent: 'primary',
    size: { xs: 12, sm: 6, md: 6 },
  },
  {
    icon: <SendRoundedIcon />,
    title: 'Leave requests',
    description: 'Submit once — the request reaches the approvers responsible for you.',
    accent: 'primary',
    size: { xs: 12, sm: 6, md: 6 },
  },
  {
    icon: <MarkEmailReadRoundedIcon />,
    title: 'Approvals by email',
    description:
      'Approvers get an email, sign in with company SSO, and decide. Only people on the approver list can act.',
    accent: 'secondary',
    size: { xs: 12, sm: 6, md: 4 },
  },
  {
    icon: <HistoryRoundedIcon />,
    title: 'Approval history',
    description: 'A complete, dated record of every decision — you only see what your role allows.',
    accent: 'primary',
    size: { xs: 12, sm: 6, md: 4 },
  },
  {
    icon: <CalendarMonthRoundedIcon />,
    title: 'Holiday calendars',
    description: 'Public and company holidays for each year, so leave days are counted correctly.',
    accent: 'secondary',
    size: { xs: 12, sm: 6, md: 4 },
  },
  {
    icon: <AdminPanelSettingsRoundedIcon />,
    title: 'Admin directory, activity & settings',
    description: 'Manage people, review activity, and configure leave policies and approvers from one workspace.',
    accent: 'primary',
    size: { xs: 12, sm: 6, md: 8 },
  },
  {
    icon: <LockRoundedIcon />,
    title: 'Sign in with SSO',
    description: 'Use your work account. No extra password to remember.',
    accent: 'secondary',
    size: { xs: 12, sm: 6, md: 4 },
  },
]

function CapabilityCard({ item, index, reduce }: { item: (typeof capabilities)[number]; index: number; reduce: boolean }) {
  return (
    <Card elevation={0} sx={[{ height: '100%' }, entranceSx(360 + index * 70, reduce)]}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack spacing={1.5}>
          <IconTile size={42} accent={item.accent}>
            {item.icon}
          </IconTile>
          <Typography variant="h5" component="h3" sx={{ fontSize: '0.975rem' }}>
            {item.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {item.description}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  )
}

function SignedOutView({ error, login, refresh, reduce }: { error: string | null; login: () => void; refresh: () => void; reduce: boolean }) {
  return (
    <>
      {/* Hero */}
      <Grid container spacing={{ xs: 4, md: 5.5 }} alignItems="center" sx={{ py: { xs: 6, md: 9 } }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={2.25} alignItems="flex-start">
            <Chip
              icon={<CheckRoundedIcon sx={{ fontSize: 15 }} />}
              label="Self-hosted leave management"
              variant="outlined"
              size="small"
              sx={[eyebrowChipSx('primary'), entranceSx(0, reduce)]}
            />
            <Typography
              variant="h1"
              sx={[
                { fontSize: 'clamp(2.4rem, 5.4vw, 3.7rem)', lineHeight: 1.08, letterSpacing: '-0.02em', fontWeight: 800 },
                entranceSx(80, reduce),
              ]}
            >
              Time off,{' '}
              <Box
                component="span"
                sx={(theme) => ({
                  backgroundImage: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                })}
              >
                handled cleanly
              </Box>{' '}
              from request to approval.
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={[{ maxWidth: 520 }, entranceSx(160, reduce)]}>
              Track vacation and sick-leave balances, route requests to the right approvers, and keep a complete,
              timestamped approval history — all in one place.
            </Typography>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }} sx={entranceSx(300, reduce)}>
          <SignInPanel error={error} login={login} refresh={refresh} />
        </Grid>
      </Grid>

      {/* Capabilities */}
      <Box sx={{ py: { xs: 5, md: 8 } }}>
        <Stack spacing={0.75} sx={{ mb: { xs: 3, md: 3.5 } }}>
          <Typography variant="overline" color="text.secondary" sx={entranceSx(300, reduce)}>
            What&apos;s inside
          </Typography>
          <Typography variant="h2" sx={entranceSx(340, reduce)}>
            Everything a leave workflow needs
          </Typography>
        </Stack>
        <Grid container spacing={2}>
          {capabilities.map((item, index) => (
            <Grid key={item.title} size={item.size}>
              <CapabilityCard item={item} index={index} reduce={reduce} />
            </Grid>
          ))}
        </Grid>
      </Box>
    </>
  )
}

// ---------------------------------------------------------------------------
// Signed-in: welcome + session card + two workspace choice cards.
// ---------------------------------------------------------------------------

function WorkspaceChoiceCard({
  icon,
  title,
  description,
  accent,
  locked,
  reduce,
  onOpen,
}: {
  icon: ReactNode
  title: string
  description: string
  accent: Accent
  locked: boolean
  reduce: boolean
  onOpen?: () => void
}) {
  const inner = (
    <Stack spacing={1.25} alignItems="flex-start" sx={{ height: '100%' }}>
      <IconTile size={40} accent={locked ? 'primary' : accent}>
        {locked ? <LockRoundedIcon /> : icon}
      </IconTile>
      <Typography component="h3" sx={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em' }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ color: locked ? 'text.disabled' : `${accent}.main`, fontWeight: 700 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'inherit' }}>
          {locked ? 'Requires the administrator role' : 'Open workspace'}
        </Typography>
        {locked ? <LockRoundedIcon sx={{ fontSize: 16 }} /> : <ArrowForwardRoundedIcon sx={{ fontSize: 18 }} />}
      </Stack>
    </Stack>
  )

  const baseSx: SxFn = (theme) => ({
    height: '100%',
    borderRadius: '14px',
    border: `1px solid ${theme.palette.divider}`,
    backgroundColor: locked ? alpha(theme.palette.text.primary, 0.02) : theme.palette.background.paper,
    boxShadow: `0 1px 2px ${alpha(theme.palette.text.primary, 0.04)}`,
  })

  if (locked) {
    return (
      <Box sx={[baseSx, { p: { xs: 2.25, md: 2.5 }, opacity: 0.75 }]} aria-disabled aria-label={`${title}. Requires the administrator role.`}>
        {inner}
      </Box>
    )
  }

  return (
    <ButtonBase
      onClick={onOpen}
      sx={[baseSx, cardHoverSx(reduce), { p: { xs: 2.25, md: 2.5 }, textAlign: 'left', alignItems: 'stretch', width: '100%' }]}
    >
      {inner}
    </ButtonBase>
  )
}

function SignedInView({
  user,
  isLoading,
  error,
  refresh,
  reduce,
}: {
  user: SessionUser
  isLoading: boolean
  error: string | null
  refresh: () => void
  reduce: boolean
}) {
  const navigate = useNavigate()
  const hasAdmin = user.roles.includes(AppRoleName.Administrator)
  const hasEmployee = user.roles.includes(AppRoleName.Employee)
  const firstName = (user.name ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? user.email

  return (
    <Box sx={{ width: '100%', py: { xs: 4, md: 5 }, maxWidth: 840, mx: 'auto' }}>
      <Stack spacing={1.25} sx={{ mb: 2.75, maxWidth: 600 }}>
        <Typography
          variant="h1"
          sx={[
            { fontSize: 'clamp(2rem, 4.4vw, 2.9rem)', lineHeight: 1.1, letterSpacing: '-0.02em', fontWeight: 800 },
            entranceSx(70, reduce),
          ]}
        >
          Welcome back, {firstName}.
        </Typography>
        <Typography color="text.secondary" sx={[{ fontSize: 14.5, lineHeight: 1.55 }, entranceSx(140, reduce)]}>
          You&apos;re signed in with your work account. Choose a workspace — you will only see what your role allows.
        </Typography>
      </Stack>

      {/* Session card */}
      <Card elevation={0} sx={[{ mb: 3 }, entranceSx(180, reduce)]}>
        <CardContent sx={{ p: { xs: 2, md: 2.25 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'flex-start', sm: 'center' }}>
            <IdentityAvatar user={user} size={40} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography component="p" noWrap sx={{ fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
                {user.name ?? user.email}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {user.email}
              </Typography>
              <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
                {hasEmployee ? <Chip label="Employee" variant="outlined" color="primary" size="small" /> : null}
                {hasAdmin ? <Chip label="Administrator" variant="outlined" color="secondary" size="small" /> : null}
                {!hasEmployee && !hasAdmin ? <Chip label="No app roles yet" variant="outlined" size="small" /> : null}
              </Stack>
            </Box>
            <Box sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}>
              <Button variant="outlined" onClick={refresh} disabled={isLoading} startIcon={isLoading ? <CircularProgress size={15} thickness={5} aria-label="Refreshing session" /> : undefined}>
                Refresh session
              </Button>
            </Box>
          </Stack>
          {error ? (
            <Box sx={{ mt: 2 }}>
              <SessionErrorAlert error={error} onRetry={refresh} />
            </Box>
          ) : null}
        </CardContent>
      </Card>

      {/* Workspace chooser */}
      <Grid container spacing={2} sx={entranceSx(220, reduce)}>
        <Grid size={{ xs: 12, sm: 6 }}>
          <WorkspaceChoiceCard
            icon={<PersonRoundedIcon />}
            title="Enter employee workspace"
            description="Check balances, submit leave requests, and follow your approval history."
            accent="primary"
            locked={false}
            reduce={reduce}
            onOpen={() => navigate('/employee/dashboard')}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <WorkspaceChoiceCard
            icon={<AdminPanelSettingsRoundedIcon />}
            title="Enter admin workspace"
            description={
              hasAdmin
                ? 'Manage the directory, holiday calendars, activity, and leave settings.'
                : 'Directory, holiday calendars, activity, and leave settings.'
            }
            accent="secondary"
            locked={!hasAdmin}
            reduce={reduce}
            onOpen={hasAdmin ? () => navigate('/admin/activity') : undefined}
          />
        </Grid>
      </Grid>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function LandingFooter() {
  const year = new Date().getFullYear()
  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.25}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        sx={{ py: 2.5 }}
      >
        <Typography variant="caption" color="text.secondary">
          © {year}
          {COMPANY_NAME ? ` ${COMPANY_NAME}` : ''} · Leave tracker
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Employee &amp; Administrator workspaces
        </Typography>
      </Stack>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Session-resolution loader.
// ---------------------------------------------------------------------------

function SessionBootingView() {
  return (
    <Box sx={{ position: 'relative', py: { xs: 6, md: 9 } }}>
      <Box aria-hidden sx={{ filter: 'blur(3px)', opacity: 0.6, pointerEvents: 'none' }}>
        <Grid container spacing={{ xs: 4, md: 5.5 }} alignItems="center">
          <Grid size={{ xs: 12, md: 7 }}>
            <Stack spacing={2.5}>
              <Skeleton variant="rounded" width={200} height={26} />
              <Skeleton variant="rounded" width="92%" height={56} />
              <Skeleton variant="rounded" width="70%" height={56} />
              <Skeleton variant="text" width="85%" />
            </Stack>
          </Grid>
          <Grid size={{ xs: 12, md: 5 }}>
            <Card sx={glassSx}>
              <CardContent sx={{ p: { xs: 3, md: 3.25 } }}>
                <Stack spacing={2}>
                  <Skeleton variant="rounded" width={160} height={24} />
                  <Skeleton variant="text" width="70%" height={26} />
                  <Skeleton variant="rounded" height={46} />
                  <Skeleton variant="rounded" height={14} width="55%" sx={{ mx: 'auto' }} />
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Box>
      <Stack role="status" aria-live="polite" alignItems="center" spacing={1.5} sx={{ position: 'absolute', inset: 0, justifyContent: 'center' }}>
        <CircularProgress size={26} thickness={4} aria-label="Verifying your session" />
        <Typography variant="body2" color="text.secondary">
          Verifying your session…
        </Typography>
      </Stack>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function LandingPage() {
  const { user, isLoading, error, login, refresh } = useAuth()
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')

  // Synchronous, SSR-safe session-resolution gate. bootstrapAuthOidc() is
  // dispatched in main.tsx before first render and its epic sets isLoading=true
  // synchronously, so the first client frame is isLoading=true - rendered as a
  // neutral loader, not a signed-out state. `resolvedRef` latches once the
  // session is known so a later retry never swaps the whole page back to the
  // loader. useRef mutation during render is SSR-safe and triggers no re-render.
  const ready = Boolean(user) || Boolean(error) || !isLoading
  const resolvedRef = useRef(false)
  if (ready) resolvedRef.current = true
  const showContent = ready || resolvedRef.current

  const handleRefresh = () => {
    void refresh()
  }

  return (
    <Box
      sx={{
        position: 'relative',
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflowX: 'clip',
        bgcolor: 'background.default',
      }}
    >
      <AuroraBackground />
      <DotGridBackground />

      <LandingHeader user={user} isLoading={isLoading} booting={!showContent} login={login} />

      <Container
        maxWidth="lg"
        sx={{ position: 'relative', zIndex: 1, flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        {!showContent ? (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <SessionBootingView />
          </Box>
        ) : (
          <Fade in appear={!reduce} timeout={reduce ? 0 : 320}>
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {/* Grow + vertically centre the (short) signed-in view; keep the
                  (tall) signed-out view top-aligned. The footer then sits at the
                  bottom of the viewport either way. */}
              <Box
                sx={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: user ? 'center' : 'flex-start',
                }}
              >
                {user ? (
                  <SignedInView user={user} isLoading={isLoading} error={error} refresh={handleRefresh} reduce={reduce} />
                ) : (
                  <SignedOutView error={error} login={login} refresh={handleRefresh} reduce={reduce} />
                )}
              </Box>
              <LandingFooter />
            </Box>
          </Fade>
        )}
      </Container>
    </Box>
  )
}

export default LandingPage
