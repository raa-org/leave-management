/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { EventBus } from '@nestjs/cqrs'
import {
  ApproverKind,
  LeaveRequestApprovedEvent,
  LeaveRequestAutoApprovedEvent,
  LeaveRequestRejectedEvent,
  LeaveRequestSubmittedEvent,
  LeaveRequestStatus,
  type LeaveRequestDetailDto,
} from '@workspace/contracts'

export function publishLeaveRequestSubmittedEmail(
  eventBus: EventBus,
  input: {
    detail: LeaveRequestDetailDto
    employeeId: string
    approverEmails: string[]
    ccEmails: string[]
    // The org's workday length, so the email can render its day figures as
    // days and hours. Passed in rather than read at send time: see the note on
    // the events themselves.
    hoursPerDay: number
  },
): void {
  const { detail, employeeId, approverEmails, ccEmails, hoursPerDay } = input
  eventBus.publish(
    new LeaveRequestSubmittedEvent(
      detail.requestId,
      employeeId,
      detail.leaveType,
      detail.startDate,
      detail.endDate,
      detail.requestedDays,
      approverEmails,
      ccEmails,
      detail.submittedAt,
      // The paid/unpaid split is frozen on the request at submit, so the event
      // carries the same figures the approver will see on the request itself.
      detail.paidDays,
      detail.unpaidDays,
      hoursPerDay,
    ),
  )
}

/**
 * The counterpart of publishLeaveRequestSubmittedEmail for a submission the
 * system approved on its own: there are no approvers to ask, so the CC
 * recipients are told what was booked instead. Addressed off the SAVED
 * recipient rows rather than the client payload, because the CC defaults are
 * folded in by the domain and never appear in what the composer sent.
 */
export function publishLeaveRequestAutoApprovedEmail(
  eventBus: EventBus,
  input: {
    detail: LeaveRequestDetailDto
    employeeId: string
    hoursPerDay: number
  },
): void {
  const { detail, employeeId, hoursPerDay } = input
  if (detail.status !== LeaveRequestStatus.Approved) {
    return
  }
  const ccEmails = detail.approvers
    .filter((approver) => approver.kind === ApproverKind.Cc)
    .map((approver) => approver.email)
  eventBus.publish(
    new LeaveRequestAutoApprovedEvent(
      detail.requestId,
      employeeId,
      detail.leaveType,
      detail.startDate,
      detail.endDate,
      detail.requestedDays,
      ccEmails,
      detail.decidedAt ?? detail.submittedAt,
      detail.paidDays,
      detail.unpaidDays,
      hoursPerDay,
    ),
  )
}

export function publishLeaveRequestApprovedEmail(
  eventBus: EventBus,
  detail: LeaveRequestDetailDto,
  actorDisplayName: string,
  hoursPerDay: number,
): void {
  if (detail.status !== LeaveRequestStatus.Approved) {
    return
  }
  eventBus.publish(
    new LeaveRequestApprovedEvent(
      detail.requestId,
      detail.requesterUserId,
      detail.leaveType,
      detail.startDate,
      detail.endDate,
      detail.requestedDays,
      detail.decidedAt ?? new Date().toISOString(),
      actorDisplayName,
      hoursPerDay,
    ),
  )
}

export function publishLeaveRequestRejectedEmail(
  eventBus: EventBus,
  detail: LeaveRequestDetailDto,
  actorDisplayName: string,
  hoursPerDay: number,
): void {
  if (detail.status !== LeaveRequestStatus.Rejected) {
    return
  }
  eventBus.publish(
    new LeaveRequestRejectedEvent(
      detail.requestId,
      detail.requesterUserId,
      detail.leaveType,
      detail.startDate,
      detail.endDate,
      detail.requestedDays,
      detail.decidedAt ?? new Date().toISOString(),
      actorDisplayName,
      hoursPerDay,
      detail.decisionComment,
    ),
  )
}
