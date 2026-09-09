/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveType } from '@workspace/contracts'
import { describe, expect, it } from 'vitest'
import { buildRequestApprovedEmployeeEmail } from './request-approved-employee'
import { buildRequestRejectedEmployeeEmail } from './request-rejected-employee'

describe('employee leave request emails', () => {
  const base = {
    employeeDisplayName: 'Alex Employee',
    leaveType: LeaveType.Vacation,
    startDate: '2026-07-01',
    endDate: '2026-07-05',
    requestedDays: 3,
    hoursPerDay: 8,
    requestUrl: 'https://leave.example.test/employee/history/req-1',
  }

  it('builds approved notification with Leave request button', () => {
    const { subject, html } = buildRequestApprovedEmployeeEmail({
      ...base,
      actorDisplayName: 'Manager',
      approverLabels: ['Manager'],
    })
    expect(subject).toContain('approved')
    expect(html).toContain('Leave request</a>')
    expect(html).toContain('Approved by')
    expect(html).toContain('3d')
    // The fixture is fully paid, so the split must stay out of the email
    // entirely rather than reading "Unpaid: 0d".
    expect(html).not.toContain('Unpaid')
  })

  it('names the unpaid part of a split approval', () => {
    const { html } = buildRequestApprovedEmployeeEmail({
      ...base,
      requestedDays: 8.5,
      paidDays: 3,
      unpaidDays: 5.5,
      actorDisplayName: 'Manager',
      approverLabels: ['Manager'],
    })

    // The approver's email names the days the balance will not cover; the
    // employee whose pay it is must not be the one person left uninformed.
    expect(html).toContain('Unpaid')
    expect(html).toContain('5d 4h (the balance covers 3d)')
  })

  it('lists all approvers when more than one decided', () => {
    const { html } = buildRequestApprovedEmployeeEmail({
      ...base,
      actorDisplayName: 'Director',
      approverLabels: ['Manager', 'Director'],
    })
    expect(html).toContain('Approvers')
    expect(html).toContain('Manager, Director')
    expect(html).not.toContain('Approved by')
  })

  it('builds rejected notification', () => {
    const { subject, html } = buildRequestRejectedEmployeeEmail({
      ...base,
      actorDisplayName: 'Manager',
      comment: 'Not enough coverage',
    })
    expect(subject).toContain('rejected')
    expect(html).toContain('Request rejected')
    expect(html).toContain('Not enough coverage')
  })
})
