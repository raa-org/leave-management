/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useState, type PropsWithChildren } from 'react'
import { combineEpics, createEpicMiddleware, ofType, type Epic } from 'redux-observable'
import { Provider, useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux'
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AnyAction } from 'redux'
import { createSelector } from 'reselect'
import {
  catchError,
  debounceTime,
  from,
  map,
  mergeMap,
  of,
  switchMap,
} from 'rxjs'
import type {
  CreateLeaveRequestDto,
  EmployeeDashboardDto,
  HolidayCalendarDto,
  LeaveAvailabilityPreviewDto,
  LeaveAvailabilityQueryDto,
  LeaveRequestDetailDto,
  LeaveRequestFormContextDto,
  LeaveRequestHistoryDto,
  LeaveRequestSummaryDto,
  ListMyLeaveRequestsQueryDto,
  ModifyLeaveRequestDto,
} from '@workspace/contracts'
import { LeaveRequestStatus } from '@workspace/contracts'
import {
  fetchAvailabilityPreview,
  fetchEmployeeDashboard,
  fetchLeaveRequestDetail,
  fetchLeaveRequestFormContext,
  fetchLeaveRequestHistory,
  modifyLeaveRequest,
  submitLeaveRequest,
} from './employee-api'
import { fetchHolidayCalendars } from '../holidays/holidays-api'
import { upcomingWindow } from './dashboard-insights'
import {
  resolveEventSource,
  type EventSourceFactory,
} from '../../lib/event-source'

type AsyncStatus = 'idle' | 'loading' | 'succeeded' | 'failed'

type AsyncResource<T> = {
  status: AsyncStatus
  data?: T
  error?: string
}

type RequestComposerState = {
  contextStatus: AsyncStatus
  contextError?: string
  dashboard?: EmployeeDashboardDto
  history?: LeaveRequestHistoryDto
  // Directory + settings-default recipients backing the approver/CC pickers;
  // loaded together with the dashboard so 'succeeded' implies it is present.
  formContext?: LeaveRequestFormContextDto
  submitStatus: AsyncStatus
  submitError?: string
  createdRequest?: LeaveRequestDetailDto
  // The server's verdict on the currently picked period. Refreshed as the
  // dates change, independently of the context above.
  availability: AsyncResource<LeaveAvailabilityPreviewDto>
  // Set only when the composer is changing an existing approved leave.
  modify?: {
    requestId: string
    status: AsyncStatus
    original?: LeaveRequestDetailDto
    error?: string
  }
}

// Raw inputs of the dashboard's "Upcoming" timeline: the approved requests
// overlapping the queried window plus the employee-country holiday calendars.
// The timeline itself is derived at render time (buildUpcomingTimeline), so the
// store holds server payloads only.
export type UpcomingResourceData = {
  requests: LeaveRequestSummaryDto[]
  holidayCalendars: HolidayCalendarDto[]
  from: string
  to: string
}

export type UpcomingRequestedPayload = {
  from: string
  to: string
  countryCode?: string
}

export type EmployeeFeatureState = {
  dashboard: AsyncResource<EmployeeDashboardDto>
  upcoming: AsyncResource<UpcomingResourceData>
  history: AsyncResource<LeaveRequestHistoryDto> & {
    filters: ListMyLeaveRequestsQueryDto
  }
  requestComposer: RequestComposerState
}

export const createInitialEmployeeFeatureState = (): EmployeeFeatureState => ({
  dashboard: {
    status: 'idle',
  },
  upcoming: {
    status: 'idle',
  },
  history: {
    status: 'idle',
    filters: {},
  },
  requestComposer: {
    contextStatus: 'idle',
    submitStatus: 'idle',
    availability: { status: 'idle' },
  },
})

const employeeFeatureSlice = createSlice({
  name: 'employeeFeature',
  initialState: createInitialEmployeeFeatureState(),
  reducers: {
    dashboardRequested(state) {
      // The initial load shows the full-page loader. An auto/focus refresh keeps
      // the current snapshot on screen and swaps it in place when the refetch
      // lands, so the periodic refresh never flashes the dashboard to a spinner.
      if (!state.dashboard.data) {
        state.dashboard.status = 'loading'
      }
      state.dashboard.error = undefined
    },
    dashboardReceived(state, action: PayloadAction<EmployeeDashboardDto>) {
      state.dashboard.status = 'succeeded'
      state.dashboard.data = action.payload
    },
    dashboardRequestFailed(state, action: PayloadAction<string>) {
      state.dashboard.status = 'failed'
      state.dashboard.error = action.payload
    },
    upcomingRequested(state, _action: PayloadAction<UpcomingRequestedPayload>) {
      // Same in-place refresh rule as the dashboard: only the first load shows
      // a loading state; refreshes swap the data when it lands.
      if (!state.upcoming.data) {
        state.upcoming.status = 'loading'
      }
      state.upcoming.error = undefined
    },
    upcomingReceived(state, action: PayloadAction<UpcomingResourceData>) {
      state.upcoming.status = 'succeeded'
      state.upcoming.data = action.payload
    },
    upcomingRequestFailed(state, action: PayloadAction<string>) {
      state.upcoming.status = 'failed'
      state.upcoming.error = action.payload
    },
    historyRequested(state, action: PayloadAction<ListMyLeaveRequestsQueryDto>) {
      // Full-page loader only on the first load; a filter change or auto/focus
      // refresh keeps the current list on screen and swaps it in place.
      if (!state.history.data) {
        state.history.status = 'loading'
      }
      state.history.error = undefined
      state.history.filters = action.payload
    },
    historyReceived(state, action: PayloadAction<LeaveRequestHistoryDto>) {
      state.history.status = 'succeeded'
      state.history.data = action.payload
    },
    historyRequestFailed(state, action: PayloadAction<string>) {
      state.history.status = 'failed'
      state.history.error = action.payload
    },
    requestContextRequested(state) {
      // The initial load shows the full-page loader. A post-submit refresh keeps
      // the current content on screen and updates it in place when the refetch
      // lands, so submitting does not flash the whole workspace back to loading.
      if (!state.requestComposer.dashboard) {
        state.requestComposer.contextStatus = 'loading'
      }
      state.requestComposer.contextError = undefined
    },
    requestContextReceived(
      state,
      action: PayloadAction<{
        dashboard: EmployeeDashboardDto
        history: LeaveRequestHistoryDto
        formContext: LeaveRequestFormContextDto
      }>,
    ) {
      state.requestComposer.contextStatus = 'succeeded'
      state.requestComposer.dashboard = action.payload.dashboard
      state.requestComposer.history = action.payload.history
      state.requestComposer.formContext = action.payload.formContext
    },
    requestContextFailed(state, action: PayloadAction<string>) {
      state.requestComposer.contextStatus = 'failed'
      state.requestComposer.contextError = action.payload
    },
    requestSubmitted(state, _action: PayloadAction<CreateLeaveRequestDto>) {
      state.requestComposer.submitStatus = 'loading'
      state.requestComposer.submitError = undefined
      state.requestComposer.createdRequest = undefined
    },
    requestSubmissionSucceeded(state, action: PayloadAction<LeaveRequestDetailDto>) {
      state.requestComposer.submitStatus = 'succeeded'
      state.requestComposer.createdRequest = action.payload
    },
    requestSubmissionFailed(state, action: PayloadAction<string>) {
      state.requestComposer.submitStatus = 'failed'
      state.requestComposer.submitError = action.payload
    },
    requestSubmissionReset(state) {
      state.requestComposer.submitStatus = 'idle'
      state.requestComposer.submitError = undefined
      state.requestComposer.createdRequest = undefined
      // Leaving the composer discards what it was asking about; a stale
      // verdict from the previous visit must not greet the next one.
      state.requestComposer.availability = { status: 'idle' }
      state.requestComposer.modify = undefined
    },
    availabilityPreviewRequested(
      state,
      _action: PayloadAction<LeaveAvailabilityQueryDto>,
    ) {
      // Keep the previous verdict on screen while the next one loads: the
      // panel would otherwise blink empty on every date tweak.
      state.requestComposer.availability.status = 'loading'
      state.requestComposer.availability.error = undefined
    },
    availabilityPreviewReceived(
      state,
      action: PayloadAction<LeaveAvailabilityPreviewDto>,
    ) {
      state.requestComposer.availability = {
        status: 'succeeded',
        data: action.payload,
      }
    },
    availabilityPreviewFailed(state, action: PayloadAction<string>) {
      // Fail open: the panel disappears, the server still decides at submit.
      state.requestComposer.availability = {
        status: 'failed',
        error: action.payload,
      }
    },
    availabilityPreviewCleared(state) {
      state.requestComposer.availability = { status: 'idle' }
    },
    modifyContextRequested(state, action: PayloadAction<string>) {
      state.requestComposer.modify = {
        requestId: action.payload,
        status: 'loading',
      }
    },
    // The composer is one page for both jobs, and leaving modify mode does not
    // unmount it. Without this, a subsequent new request would still be
    // addressed to the leave the previous visit was changing.
    modifyContextCleared(state) {
      state.requestComposer.modify = undefined
    },
    modifyContextReceived(state, action: PayloadAction<LeaveRequestDetailDto>) {
      state.requestComposer.modify = {
        requestId: action.payload.requestId,
        status: 'succeeded',
        original: action.payload,
      }
    },
    modifyContextFailed(state, action: PayloadAction<string>) {
      if (state.requestComposer.modify) {
        state.requestComposer.modify.status = 'failed'
        state.requestComposer.modify.error = action.payload
      }
    },
    modificationSubmitted(
      state,
      _action: PayloadAction<{
        requestId: string
        payload: ModifyLeaveRequestDto
      }>,
    ) {
      state.requestComposer.submitStatus = 'loading'
      state.requestComposer.submitError = undefined
      state.requestComposer.createdRequest = undefined
    },
  },
})

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

// Dependency shape shared by the standalone employee store (used in tests) and
// the composed app store. Only `fetch` is consumed here; `apiBaseUrl` and
// `eventSource` are part of the app-wide contract so a single epic array serves
// both stores.
export type AppEpicDependencies = {
  apiBaseUrl: string
  fetch: typeof fetch
  eventSource: EventSourceFactory
}

// State is left as `unknown` so the same epics compose into the app store
// (whose root state is wider than EmployeeFeatureState). The epics never read
// state, only actions.
type EmployeeEpic = Epic<AnyAction, AnyAction, unknown, AppEpicDependencies>

const dashboardRequestedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.dashboardRequested.type),
    switchMap(() =>
      from(fetchEmployeeDashboard(fetchImpl)).pipe(
        map((dashboard) => employeeFeatureSlice.actions.dashboardReceived(dashboard)),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.dashboardRequestFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

// Every fresh dashboard snapshot re-queries the upcoming window from ITS
// generatedAt, so the timeline follows the same auto/focus refresh cadence as
// the dashboard without its own timers, and the window is always derived from
// server time.
const upcomingAfterDashboardEpic: EmployeeEpic = (action$) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.dashboardReceived.type),
    map((action) => {
      const dashboard = action.payload as EmployeeDashboardDto
      const { from, to } = upcomingWindow(dashboard.generatedAt)
      return employeeFeatureSlice.actions.upcomingRequested({
        from,
        to,
        countryCode: dashboard.holidayCalendarCountryCode ?? dashboard.countryCode,
      })
    }),
  )

const upcomingRequestedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.upcomingRequested.type),
    switchMap((action) => {
      // `from`/`to` renamed locally so the rxjs `from` import stays usable.
      const { from: windowFrom, to: windowTo, countryCode } =
        action.payload as UpcomingRequestedPayload
      return from(
        Promise.all([
          fetchLeaveRequestHistory(
            { status: LeaveRequestStatus.Approved, from: windowFrom, to: windowTo },
            fetchImpl,
          ),
          // No assigned country means no holiday calendar to show; the leave
          // half of the timeline still loads.
          countryCode
            ? fetchHolidayCalendars(countryCode, fetchImpl)
            : Promise.resolve<HolidayCalendarDto[]>([]),
        ]),
      ).pipe(
        map(([history, holidayCalendars]) =>
          employeeFeatureSlice.actions.upcomingReceived({
            requests: history.requests,
            holidayCalendars,
            from: windowFrom,
            to: windowTo,
          }),
        ),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.upcomingRequestFailed(getErrorMessage(error))),
        ),
      )
    }),
  )

const historyRequestedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.historyRequested.type),
    switchMap((action) =>
      from(fetchLeaveRequestHistory(action.payload, fetchImpl)).pipe(
        map((history) => employeeFeatureSlice.actions.historyReceived(history)),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.historyRequestFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

const requestContextRequestedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.requestContextRequested.type),
    switchMap(() =>
      from(
        Promise.all([
          fetchEmployeeDashboard(fetchImpl),
          fetchLeaveRequestHistory({}, fetchImpl),
          fetchLeaveRequestFormContext(fetchImpl),
        ]),
      ).pipe(
        map(([dashboard, history, formContext]) =>
          employeeFeatureSlice.actions.requestContextReceived({
            dashboard,
            history,
            formContext,
          }),
        ),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.requestContextFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

const requestSubmittedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.requestSubmitted.type),
    switchMap((action) =>
      from(submitLeaveRequest(action.payload, fetchImpl)).pipe(
        // On success, surface the created request AND refresh the request
        // context (dashboard + history) so the pending-request chip and the
        // on-hold balance update immediately instead of only after a reload.
        mergeMap((request) =>
          of(
            employeeFeatureSlice.actions.requestSubmissionSucceeded(request),
            employeeFeatureSlice.actions.requestContextRequested(),
          ),
        ),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.requestSubmissionFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

// Debounced because it follows the picked dates, and switchMapped so only the
// latest period's verdict can land: an earlier, slower response overwriting a
// newer one would tell the employee about dates they no longer have picked.
const availabilityPreviewEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.availabilityPreviewRequested.type),
    debounceTime(250),
    switchMap((action) =>
      from(fetchAvailabilityPreview(action.payload, fetchImpl)).pipe(
        map((preview) =>
          employeeFeatureSlice.actions.availabilityPreviewReceived(preview),
        ),
        catchError((error: unknown) =>
          of(
            employeeFeatureSlice.actions.availabilityPreviewFailed(
              getErrorMessage(error),
            ),
          ),
        ),
      ),
    ),
  )

const modifyContextRequestedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.modifyContextRequested.type),
    switchMap((action) =>
      from(fetchLeaveRequestDetail(action.payload, fetchImpl)).pipe(
        map((request) =>
          employeeFeatureSlice.actions.modifyContextReceived(request),
        ),
        catchError((error: unknown) =>
          of(
            employeeFeatureSlice.actions.modifyContextFailed(
              getErrorMessage(error),
            ),
          ),
        ),
      ),
    ),
  )

// Mirrors requestSubmittedEpic, including its success/failure actions: a
// modification IS a submission from the composer's point of view, so the
// success banner, error alert and post-submit refresh all work unchanged.
const modificationSubmittedEpic: EmployeeEpic = (action$, _state$, { fetch: fetchImpl }) =>
  action$.pipe(
    ofType(employeeFeatureSlice.actions.modificationSubmitted.type),
    switchMap((action) =>
      from(
        modifyLeaveRequest(
          action.payload.requestId,
          action.payload.payload,
          fetchImpl,
        ),
      ).pipe(
        mergeMap((request) =>
          of(
            employeeFeatureSlice.actions.requestSubmissionSucceeded(request),
            employeeFeatureSlice.actions.requestContextRequested(),
          ),
        ),
        catchError((error: unknown) =>
          of(employeeFeatureSlice.actions.requestSubmissionFailed(getErrorMessage(error))),
        ),
      ),
    ),
  )

// The single source of truth for the employee reducer and epics, reused by the
// composed app store (see ../../store/index.ts).
export const employeeFeatureReducer = employeeFeatureSlice.reducer

export const employeeFeatureEpics = [
  dashboardRequestedEpic,
  upcomingAfterDashboardEpic,
  upcomingRequestedEpic,
  historyRequestedEpic,
  requestContextRequestedEpic,
  requestSubmittedEpic,
  availabilityPreviewEpic,
  modifyContextRequestedEpic,
  modificationSubmittedEpic,
]

export function createEmployeeFeatureStore(fetchImpl: typeof fetch = fetch) {
  const dependencies: AppEpicDependencies = {
    apiBaseUrl: '',
    fetch: fetchImpl,
    // This store never runs the notification epics, so the factory is never
    // called here; it is present only to satisfy the shared dependency shape.
    eventSource: resolveEventSource(),
  }
  const epicMiddleware = createEpicMiddleware<
    AnyAction,
    AnyAction,
    EmployeeFeatureState,
    AppEpicDependencies
  >({
    dependencies,
  })

  const store = configureStore({
    reducer: employeeFeatureSlice.reducer,
    devTools: import.meta.env.DEV,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
      }).concat(epicMiddleware),
  })

  epicMiddleware.run(combineEpics(...employeeFeatureEpics))

  return store
}

type EmployeeFeatureStore = ReturnType<typeof createEmployeeFeatureStore>
type EmployeeFeatureDispatch = EmployeeFeatureStore['dispatch']

export function EmployeeFeatureProvider({
  children,
  fetchImpl,
}: PropsWithChildren<{ fetchImpl?: typeof fetch }>) {
  const [store] = useState(() => createEmployeeFeatureStore(fetchImpl))
  return <Provider store={store}>{children}</Provider>
}

export function useEmployeeFeatureDispatch() {
  return useDispatch<EmployeeFeatureDispatch>()
}

export const useEmployeeFeatureSelector: TypedUseSelectorHook<EmployeeFeatureState> = useSelector

export const employeeFeatureActions = employeeFeatureSlice.actions

export const selectDashboardState = (state: EmployeeFeatureState) => state.dashboard
export const selectUpcomingState = (state: EmployeeFeatureState) => state.upcoming
export const selectHistoryState = (state: EmployeeFeatureState) => state.history
export const selectRequestComposerState = (state: EmployeeFeatureState) => state.requestComposer

export const selectHistoryFilters = createSelector(
  selectHistoryState,
  (history) => history.filters,
)
