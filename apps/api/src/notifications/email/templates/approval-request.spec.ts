/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { LeaveType } from '@workspace/contracts'
import { describe, expect, it } from 'vitest'
import { buildApprovalRequestEmail } from './approval-request'

describe('buildApprovalRequestEmail', () => {
  it('renders subject and html from params', () => {
    const { subject, html } = buildApprovalRequestEmail({
      requestId: 'req-123',
      requesterDisplayName: 'Alex Employee',
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-01',
      endDate: '2026-07-05',
      requestedDays: 3,
      hoursPerDay: 8,
      comment: 'Need <time off> & rest',
      approvalUrl: 'https://leave.example.test/employee/approval/review/req-123',
    })

    expect(subject).toBe('Approval needed for Alex Employee')
    expect(html).toContain('Leave request</a>')
    expect(html).toContain('Need &lt;time off&gt; &amp; rest')
    // The duration reads in the product's one notation for an amount.
    expect(html).toContain('3d')
    // A fully paid request says nothing about a split.
    expect(html).not.toContain('Unpaid')
  })

  it('names the unpaid part of a split request, and only then', () => {
    const split = buildApprovalRequestEmail({
      requestId: 'req-124',
      requesterDisplayName: 'Alex Employee',
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      requestedDays: 8.5,
      paidDays: 3,
      unpaidDays: 5.5,
      hoursPerDay: 8,
      approvalUrl: 'https://leave.example.test/approval/review/req-124',
    })

    // An approver signing off on days the employee will not be paid for is told
    // so, with the funded count named alongside.
    expect(split.html).toContain('Unpaid')
    expect(split.html).toContain('5d 4h (the balance covers 3d)')
  })
})
