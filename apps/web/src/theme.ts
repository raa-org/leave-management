/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { alpha, createTheme } from '@mui/material/styles'

// Default design system for generated apps. This is the AUTHORITATIVE baseline:
// feature code builds UI on top of these tokens (MUI components + the `sx` prop)
// and EXTENDS this file - it does not replace it. Keep the look premium and
// restrained:
// - border-radius is moderate and CAPPED. Do NOT inflate it into full "pills"
//   (no `borderRadius: 999` on buttons / chips / inputs); the values below are
//   the ceiling, not a starting point to scale up from.
// - colors, spacing and typography come from these tokens; do not hard-code hex
//   values or pixel paddings in feature code.
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#155eef', dark: '#0040c1', light: '#5b8cff', contrastText: '#ffffff' },
    secondary: { main: '#0f766e', dark: '#115e59', light: '#14b8a6' },
    success: { main: '#15803d' },
    // Split-role warm scale: `main` (golden amber) carries fills, icons, bar
    // segments and tints; `dark` (fresh rust-orange, AA on the tints) carries
    // small warning TEXT — chips and labels. The browns (#b45309, #92400e)
    // read muddy next to #155eef and are deliberately gone.
    warning: { main: '#d97706', light: '#fbbf24', dark: '#c2410c' },
    error: { main: '#b42318' },
    background: { default: '#f3f6fb', paper: '#ffffff' },
    text: { primary: '#101828', secondary: '#475467' },
    divider: 'rgba(16, 24, 40, 0.08)',
  },
  // Platform standard. Component overrides below stay <= 16; never exceed it and
  // never use a full-pill radius unless an explicit `pill` / `capsule` design
  // marker asks for one.
  shape: { borderRadius: 10 },
  typography: {
    // "Manrope Variable" is the exact family name @fontsource-variable/manrope
    // registers (imported in main.tsx); plain "Manrope" would never match it.
    fontFamily:
      '"Manrope Variable", "Manrope", "Aptos", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    h1: { fontSize: '2.25rem', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15 },
    h2: { fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2 },
    h3: { fontSize: '1.375rem', fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 },
    h4: { fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.35 },
    h5: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.4 },
    h6: { fontSize: '0.9375rem', fontWeight: 700, lineHeight: 1.4, letterSpacing: '-0.01em' },
    overline: { fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.6 },
    subtitle1: { fontWeight: 600 },
    body1: { lineHeight: 1.6 },
    body2: { lineHeight: 1.6 },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
          backgroundImage:
            'radial-gradient(circle at top, rgba(21, 94, 239, 0.08), transparent 28%)',
        },
        // Shared entrance/status animations (prototype .reveal / .live-dot).
        // Pure CSS keyframes: they play on mount without any JS arming, so
        // server-side test renders stay inert and route changes replay them.
        '@keyframes app-rise': {
          from: { opacity: 0, transform: 'translateY(12px)' },
          to: { opacity: 1, transform: 'none' },
        },
        '@keyframes app-pulse': {
          '0%': { transform: 'scale(0.4)', opacity: 0.6 },
          '70%': { transform: 'scale(1)', opacity: 0 },
          '100%': { opacity: 0 },
        },
        // One global switch honors the OS setting for every animation and
        // transition this app declares.
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
          },
        },
      },
    },
    MuiButton: {
      defaultProps: { variant: 'contained', disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 10,
          paddingInline: 18,
          minHeight: 42,
          boxShadow: 'none',
          fontWeight: 700,
          '&:focus-visible': {
            outline: '2px solid rgba(21, 94, 239, 0.35)',
            outlineOffset: 2,
          },
          // A teal button drawing a blue focus ring is the one blue thing on an
          // otherwise teal surface, so the ring follows the button's own hue.
          '&.MuiButton-colorSecondary:focus-visible': {
            outline: '2px solid rgba(15, 118, 110, 0.35)',
          },
          '&.MuiButton-colorError:focus-visible': {
            outline: '2px solid rgba(180, 35, 24, 0.35)',
          },
        },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          border: '1px solid rgba(16, 24, 40, 0.08)',
          borderRadius: 14,
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    // Dialog chrome lives here rather than in each dialog's `sx`: every dialog
    // in the app wants the same surface and the same title weight, and a value
    // repeated per call site drifts. The title colour is deliberately absent —
    // DialogTitle already inherits text.primary. The radius is 16 rather than
    // the 18px the dialogs used to set inline, because a dialog is a component
    // override like any other and the cap above it applies.
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 16 },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        // rem, not px: a dialog title has to grow with the reader's browser
        // font size like the rest of the scale does.
        root: { fontSize: '1.125rem', fontWeight: 800 },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small', fullWidth: true },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          backgroundColor: alpha('#ffffff', 0.92),
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 8, fontWeight: 700 },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'inherit' },
      styleOverrides: {
        root: {
          backgroundColor: alpha('#ffffff', 0.88),
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid rgba(16, 24, 40, 0.08)',
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: 'rgba(16, 24, 40, 0.08)' },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          paddingBlock: 10,
          paddingInline: 12,
          // Prototype .nav-item.active: the plain primary, not the darker
          // shade — the dark variant read too heavy against the light tint.
          '&.active': {
            backgroundColor: alpha('#155eef', 0.1),
            color: '#155eef',
          },
          '&.active .MuiListItemIcon-root': {
            color: '#155eef',
          },
        },
      },
    },
  },
})

/**
 * Leave days nobody pays for.
 *
 * Its own hue on purpose, and one the palette above does not otherwise use:
 * every colour on the balance bar is already spoken for (primary is "days you
 * have", warning is "on hold", muted ink is "spent", the pale track is what has
 * yet to accrue), so an unpaid day borrowing any of them would read as a kind
 * of balance day, which is exactly what it is not.
 *
 * Shared by the balance meter and the request calendar: one concept, one
 * colour, on every surface that marks it.
 */
export const UNPAID_ACCENT = '#e04f39'

export default theme
