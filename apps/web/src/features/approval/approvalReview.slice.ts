/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { LeaveRequestDetailDto } from '@workspace/contracts'
import { LeaveApprovalAction } from '@workspace/contracts'

export type ApprovalReviewAsyncStatus = 'idle' | 'loading' | 'ready' | 'error'

export type ApprovalReviewActionState = {
  status: 'idle' | 'submitting' | 'error'
  error: string | null
}

export type ApprovalReviewState = {
  requestId: string | null
  request: LeaveRequestDetailDto | null
  loadStatus: ApprovalReviewAsyncStatus
  loadError: string | null
  draftComment: string
  submitStates: Record<LeaveApprovalAction, ApprovalReviewActionState>
}

type ApprovalReviewBootstrap = {
  requestId?: string | null
  request?: LeaveRequestDetailDto | null
}

type ApprovalReviewSubmitFailedPayload = {
  action: LeaveApprovalAction
  error: string
}

const createSubmitState = (): Record<LeaveApprovalAction, ApprovalReviewActionState> => ({
  [LeaveApprovalAction.Approve]: {
    status: 'idle',
    error: null,
  },
  [LeaveApprovalAction.Reject]: {
    status: 'idle',
    error: null,
  },
})

export const createInitialApprovalReviewState = (
  bootstrap: ApprovalReviewBootstrap = {},
): ApprovalReviewState => ({
  requestId: bootstrap.request?.requestId ?? bootstrap.requestId ?? null,
  request: bootstrap.request ?? null,
  loadStatus: bootstrap.request ? 'ready' : 'idle',
  loadError: null,
  draftComment: bootstrap.request?.decisionComment ?? '',
  submitStates: createSubmitState(),
})

const approvalReviewSlice = createSlice({
  name: 'approvalReview',
  initialState: createInitialApprovalReviewState(),
  reducers: {
    bootstrapApprovalReviewState(
      _state,
      action: PayloadAction<ApprovalReviewBootstrap>,
    ) {
      return createInitialApprovalReviewState(action.payload)
    },
    approvalReviewLoadStarted(state, action: PayloadAction<string>) {
      state.requestId = action.payload
      state.request = null
      state.loadStatus = 'loading'
      state.loadError = null
      state.submitStates = createSubmitState()
    },
    approvalReviewLoadSucceeded(
      state,
      action: PayloadAction<LeaveRequestDetailDto>,
    ) {
      state.requestId = action.payload.requestId
      state.request = action.payload
      state.loadStatus = 'ready'
      state.loadError = null
      state.draftComment = action.payload.decisionComment ?? state.draftComment
      state.submitStates = createSubmitState()
    },
    approvalReviewLoadFailed(state, action: PayloadAction<string>) {
      state.loadStatus = 'error'
      state.loadError = action.payload
      state.request = null
      state.submitStates = createSubmitState()
    },
    approvalReviewCommentChanged(state, action: PayloadAction<string>) {
      state.draftComment = action.payload
    },
    approvalReviewSubmitStarted(
      state,
      action: PayloadAction<LeaveApprovalAction>,
    ) {
      state.submitStates = createSubmitState()
      state.submitStates[action.payload] = {
        status: 'submitting',
        error: null,
      }
    },
    approvalReviewSubmitSucceeded(
      state,
      action: PayloadAction<LeaveRequestDetailDto>,
    ) {
      state.request = action.payload
      state.requestId = action.payload.requestId
      state.loadStatus = 'ready'
      state.loadError = null
      state.draftComment = action.payload.decisionComment ?? state.draftComment
      state.submitStates = createSubmitState()
    },
    approvalReviewSubmitFailed(
      state,
      action: PayloadAction<ApprovalReviewSubmitFailedPayload>,
    ) {
      state.submitStates[action.payload.action] = {
        status: 'error',
        error: action.payload.error,
      }
    },
  },
})

export const approvalReviewActions = approvalReviewSlice.actions
export const approvalReviewReducer = approvalReviewSlice.reducer
