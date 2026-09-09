/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveType } from './enums'

// Every one of these events carries `hoursPerDay`, the org's workday length at
// the moment it fired. The email templates render their day figures as days and
// hours, and the divisor is a setting an admin can change: reading it at send
// time would let a message describe the leave against a workday that was not in
// force when it was decided, and defaulting it would quietly render a 6-hour
// org's amounts as if they were 8-hour ones.

export class LeaveRequestSubmittedEvent {
  readonly type = 'leave.request-submitted'

  constructor(
    public readonly requestId: string,
    public readonly employeeId: string,
    public readonly leaveType: LeaveType,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly requestedDays: number,
    public readonly approverEmails: string[],
    public readonly ccEmails: string[],
    public readonly submittedAt: string,
    // Appended rather than placed next to requestedDays: the constructor is
    // positional, and every existing caller passes the first nine in order.
    public readonly paidDays: number,
    public readonly unpaidDays: number,
    public readonly hoursPerDay: number,
  ) {}
}

/** Fired when a request becomes approved — triggers employee email. */
export class LeaveRequestApprovedEvent {
  readonly type = 'leave.request-approved'

  constructor(
    public readonly requestId: string,
    public readonly requesterUserId: string,
    public readonly leaveType: LeaveType,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly requestedDays: number,
    public readonly decidedAt: string,
    public readonly actorDisplayName: string,
    public readonly hoursPerDay: number,
  ) {}
}

/**
 * Fired when a submission was approved by the system because the org made
 * approval optional and the request carried no deciding approver. Triggers the
 * copy notice to the CC recipients, who are folded in under either mode and
 * would otherwise hear nothing: the approval-request email is deliberately not
 * sent for such a request (there is nobody to ask), and the approved email
 * addresses only the requester.
 */
export class LeaveRequestAutoApprovedEvent {
  readonly type = 'leave.request-auto-approved'

  constructor(
    public readonly requestId: string,
    public readonly employeeId: string,
    public readonly leaveType: LeaveType,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly requestedDays: number,
    public readonly ccEmails: string[],
    public readonly decidedAt: string,
    public readonly paidDays: number,
    public readonly unpaidDays: number,
    public readonly hoursPerDay: number,
  ) {}
}

/** Fired when a request is rejected — triggers employee email. */
export class LeaveRequestRejectedEvent {
  readonly type = 'leave.request-rejected'

  constructor(
    public readonly requestId: string,
    public readonly requesterUserId: string,
    public readonly leaveType: LeaveType,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly requestedDays: number,
    public readonly decidedAt: string,
    public readonly actorDisplayName: string,
    // Ahead of the optional comment: a positional constructor cannot append a
    // required parameter after an optional one.
    public readonly hoursPerDay: number,
    public readonly comment?: string,
  ) {}
}
