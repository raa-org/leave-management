/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { AuthOidcReactStateInterface } from '@trusted-modules/auth-oidc-core'
import {
  epics as authOidcEpics,
  reducer as authOidcReducer,
} from '@trusted-modules/auth-oidc-react'
import { combineEpics, createEpicMiddleware } from 'redux-observable'
import type { AnyAction } from 'redux'
import { configureStore } from '@reduxjs/toolkit'
import {
  createInitialEmployeeFeatureState,
  employeeFeatureEpics,
  employeeFeatureReducer,
  type AppEpicDependencies,
  type EmployeeFeatureState,
} from '../features/employee/employee-feature.store'
import {
  createInitialHolidaysState,
  holidaysEpics,
  holidaysReducer,
  type HolidaysState,
} from '../features/holidays/holidays.store'
import {
  createInitialNotificationsState,
  notificationsEpics,
  notificationsReducer,
  type NotificationsState,
} from '../features/notifications/notifications.store'
import { apiUrl } from '../lib/api-url'
import { resolveEventSource } from '../lib/event-source'

// The approval-review screen manages its own local useReducer state (it is a
// standalone deep-link surface), so the root store intentionally does not carry
// an approvalReview slice.
export type AppState = EmployeeFeatureState & {
  authOidc: AuthOidcReactStateInterface
  notifications: NotificationsState
  holidays: HolidaysState
}

type AppStoreOptions = {
  apiBaseUrl?: string
  fetchImpl?: typeof fetch
  preloadedState?: Partial<AppState>
}

function createInitialAuthOidcState(): AuthOidcReactStateInterface {
  return authOidcReducer(undefined, { type: '@@INIT' })
}

function projectEmployeeState(state: AppState): EmployeeFeatureState {
  return {
    dashboard: state.dashboard,
    upcoming: state.upcoming,
    history: state.history,
    requestComposer: state.requestComposer,
  }
}

function createInitialAppState(preloadedState?: Partial<AppState>): AppState {
  const employeeState = createInitialEmployeeFeatureState()

  return {
    dashboard: preloadedState?.dashboard ?? employeeState.dashboard,
    upcoming: preloadedState?.upcoming ?? employeeState.upcoming,
    history: preloadedState?.history ?? employeeState.history,
    requestComposer: preloadedState?.requestComposer ?? employeeState.requestComposer,
    authOidc: preloadedState?.authOidc ?? createInitialAuthOidcState(),
    notifications: preloadedState?.notifications ?? createInitialNotificationsState(),
    holidays: preloadedState?.holidays ?? createInitialHolidaysState(),
  }
}

// Hand-composed, not combineReducers: every slice must be listed here too, or it
// stays undefined at runtime while TypeScript claims otherwise.
function appReducer(state: AppState | undefined, action: AnyAction): AppState {
  const currentState = state ?? createInitialAppState()
  const nextEmployeeState = employeeFeatureReducer(projectEmployeeState(currentState), action)

  return {
    ...nextEmployeeState,
    authOidc: authOidcReducer(currentState.authOidc, action),
    notifications: notificationsReducer(currentState.notifications, action),
    holidays: holidaysReducer(currentState.holidays, action),
  }
}

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) {
    return fetchImpl
  }

  if (typeof window !== 'undefined') {
    return window.fetch.bind(window)
  }

  return globalThis.fetch.bind(globalThis)
}

export function createAppStore({
  apiBaseUrl = apiUrl('/api'),
  fetchImpl,
  preloadedState,
}: AppStoreOptions = {}) {
  const dependencies: AppEpicDependencies = {
    apiBaseUrl,
    fetch: resolveFetch(fetchImpl),
    eventSource: resolveEventSource(),
  }
  const epicMiddleware = createEpicMiddleware<
    AnyAction,
    AnyAction,
    AppState,
    AppEpicDependencies
  >({
    dependencies,
  })
  const store = configureStore({
    reducer: appReducer,
    devTools: import.meta.env.DEV,
    preloadedState: createInitialAppState(preloadedState),
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        thunk: {
          extraArgument: dependencies,
        },
      }).concat(epicMiddleware),
  })

  epicMiddleware.run(
    combineEpics(
      ...authOidcEpics,
      ...employeeFeatureEpics,
      ...notificationsEpics,
      ...holidaysEpics,
    ),
  )

  return store
}

export type AppStore = ReturnType<typeof createAppStore>
export type AppDispatch = AppStore['dispatch']
