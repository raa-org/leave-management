/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import { alpha } from '@mui/material/styles'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'

// Shared identity presentation used by both the landing header and the app-shell
// account controls, so the avatar/initials treatment stays in one place.

export function initialsOf(user: UserProfileType): string {
  const source = (user.name?.trim() || user.email || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

// `variant` controls the backdrop: 'tile' is the filled rounded square used on
// its own (menu header, landing); 'plain' drops the fill so the initials sit
// bare, for when a surrounding container already provides the surface (the
// app-bar identity cluster).
export function IdentityAvatar({
  user,
  size,
  variant = 'tile',
}: {
  user: UserProfileType
  size: number
  variant?: 'tile' | 'plain'
}) {
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '10px',
        flexShrink: 0,
        fontWeight: 800,
        fontSize: size >= 44 ? '0.95rem' : '0.8125rem',
        bgcolor: variant === 'tile' ? alpha(theme.palette.primary.main, 0.12) : 'transparent',
        color: theme.palette.primary.dark,
      })}
    >
      {initialsOf(user)}
    </Box>
  )
}
