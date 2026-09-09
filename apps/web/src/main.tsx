/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { bootstrapAuthOidc, logoutLocal } from '@trusted-modules/auth-oidc-react'
// Variable Manrope (400-800) — theme.ts lists it first in fontFamily; without
// this import the browser silently falls back to system fonts.
import '@fontsource-variable/manrope'
import './index.css'
import theme from './theme'
import App from './App'
import { BASE_PATH } from './lib/base-path'
import { createAppStore } from './store'
import {
  installSessionExpiryInterceptor,
  setSessionExpiredHandler,
} from './lib/session'

// Install the 401 interceptor BEFORE the store is created, so the fetch the
// store injects into its epics (resolveFetch binds window.fetch here) is already
// session-aware. On an expired/absent session it clears the auth slice; the
// route guards then redirect to the landing.
console.info(`📦 ${__BUILD_TIME__}`)

installSessionExpiryInterceptor()

const store = createAppStore()

setSessionExpiredHandler(() => {
  store.dispatch(logoutLocal())
})

store.dispatch(bootstrapAuthOidc())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter
        basename={BASE_PATH || undefined}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </Provider>
  </StrictMode>,
)
