/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useContext, useState } from 'react'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Divider from '@mui/material/Divider'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { ReactReduxContext, useSelector } from 'react-redux'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { sliceName } from '@trusted-modules/auth-oidc-react'
import { IdentityAvatar } from './identity'
import { signOut } from '../lib/session'

// Identity for the app-shell top bar, collapsed into a single avatar button:
// the email and Sign out live in a dropdown so the bar stays compact. Reachable
// from every page (not just "/").
//
// Two guards keep this safe wherever AppShell is rendered, including tests:
//   1. No Redux Provider at all (StaticRouter-only page tests) -> ReactReduxContext
//      is null, so we render nothing before any useSelector runs.
//   2. A Provider whose store lacks the authOidc slice (the employee feature test
//      store) -> the null-safe selector returns null, so we render nothing.
// It deliberately does NOT use the module's useAuth(): its selectAuthOidcUser
// reads state.authOidc.user without optional chaining and would throw on a
// slice-less store. We only need the user for display; logout goes via signOut().

type AuthOidcPartialState = Record<string, { user?: UserProfileType | null } | undefined>

export function AccountControls() {
  const reduxContext = useContext(ReactReduxContext)
  if (!reduxContext) {
    return null
  }
  return <AccountControlsInner />
}

function AccountControlsInner() {
  const user = useSelector((state: AuthOidcPartialState) => state?.[sliceName]?.user ?? null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  if (!user) {
    return null
  }

  const open = Boolean(anchorEl)
  const close = () => setAnchorEl(null)
  const displayName = user.name?.trim() || null

  return (
    <>
      <ButtonBase
        onClick={(event) => setAnchorEl(event.currentTarget)}
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          height: 34,
          pl: 0.5,
          pr: 0.25,
          borderRadius: '9px',
          transition: 'background .15s ease',
          '&:hover': { bgcolor: 'background.paper' },
          '&:focus-visible': { outline: '2px solid', outlineColor: (theme) => alpha(theme.palette.primary.main, 0.35), outlineOffset: 1 },
        }}
      >
        <IdentityAvatar user={user} size={34} variant="plain" />
        <KeyboardArrowDownRoundedIcon
          sx={{
            fontSize: 18,
            color: 'text.secondary',
            transition: 'transform .18s ease',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </ButtonBase>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { mt: 1, minWidth: 240, borderRadius: '12px', overflow: 'hidden' } },
          list: { sx: { py: 0 } },
        }}
      >
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2, py: 1.5 }}>
          <IdentityAvatar user={user} size={40} />
          <Box sx={{ minWidth: 0 }}>
            {displayName ? (
              <>
                <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
                  {displayName}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: 'block' }}
                  title={user.email}
                >
                  {user.email}
                </Typography>
              </>
            ) : (
              <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }} title={user.email}>
                {user.email}
              </Typography>
            )}
          </Box>
        </Stack>
        <Divider />
        <MenuItem
          onClick={() => {
            close()
            signOut()
          }}
          sx={{ py: 1.25, fontWeight: 600 }}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <LogoutRoundedIcon fontSize="small" />
          </ListItemIcon>
          Sign out
        </MenuItem>
      </Menu>
    </>
  )
}
