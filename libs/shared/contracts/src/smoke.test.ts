/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  AppRoleName,
  EmployeeProfileStatus,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveRequestSubmittedEvent,
  LeaveType,
  type CreateLeaveRequestDto,
  type EmployeeDashboardDto,
  type LeaveApprovalActionDto,
  type LeaveSettingsDto,
} from './index'

describe('leave contracts', () => {
  it('exports the shared leave DTO vocabulary', () => {
    const request: CreateLeaveRequestDto = {
      leaveType: LeaveType.Vacation,
      startDate: '2026-07-20',
      endDate: '2026-07-24',
      approverEmails: ['manager@example.com'],
      ccEmails: ['hr@example.com'],
      comment: 'Family trip',
    }

    const approval: LeaveApprovalActionDto = {
      action: LeaveApprovalAction.Approve,
      comment: 'Approved',
    }

    const dashboard: EmployeeDashboardDto = {
      employeeId: 'employee-1',
      displayName: 'Casey Rivera',
      roleNames: [AppRoleName.Employee],
      generatedAt: '2026-07-06T09:00:00.000Z',
      profileStatus: EmployeeProfileStatus.Ready,
      holidayCalendarYears: [2026],
      hoursPerDay: 8,
      balances: [
        {
          leaveType: LeaveType.Vacation,
          totalDays: 24,
          availableDays: 18,
          onHoldDays: 3,
          spentDays: 3,
          accruedDays: 24,
          updatedAt: '2026-07-06T09:00:00.000Z',
        },
      ],
      pendingRequests: [
        {
          requestId: 'request-1',
          leaveType: LeaveType.Vacation,
          status: LeaveRequestStatus.Pending,
          startDate: '2026-07-20',
          endDate: '2026-07-24',
          requestedDays: 3,
          paidDays: 3,
          unpaidDays: 0,
          heldDays: 3,
          submittedAt: '2026-07-06T08:00:00.000Z',
        },
      ],
      recentActivity: [
        {
          actorDisplayName: 'Casey Rivera',
          action: 'request-submitted',
          occurredAt: '2026-07-06T08:00:00.000Z',
        },
      ],
    }

    const settings: LeaveSettingsDto = {
      defaultVacationDays: 24,
      defaultSickDays: 10,
      defaultApproverEmails: ['manager@example.com'],
      defaultCcApproverEmails: ['hr@example.com'],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      holidayCalendars: [
        {
          calendarId: 'calendar-ua-2026',
          country: { code: 'UA', name: 'Ukraine' },
          year: 2026,
          name: 'UA 2026',
          holidays: [
            {
              holidayId: 'holiday-1',
              date: '2026-08-24',
              name: 'Independence Day',
            },
          ],
        },
      ],
      updatedAt: '2026-07-06T09:00:00.000Z',
    }

    expectTypeOf(request).toMatchTypeOf<CreateLeaveRequestDto>()
    expectTypeOf(approval).toMatchTypeOf<LeaveApprovalActionDto>()
    expectTypeOf(dashboard).toMatchTypeOf<EmployeeDashboardDto>()
    expectTypeOf(settings).toMatchTypeOf<LeaveSettingsDto>()
    expect(LeaveRequestStatus.Pending).toBe('pending')
    expect(LeaveBalanceChangeReason.Hold).toBe('hold')
  })

  it('exports event classes for backend workflows', () => {
    const event = new LeaveRequestSubmittedEvent(
      'request-1',
      'employee-1',
      LeaveType.Sick,
      '2026-07-07',
      '2026-07-07',
      1,
      ['manager@example.com'],
      ['hr@example.com'],
      '2026-07-06T10:00:00.000Z',
      1,
      0,
      8,
    )

    expect(event.type).toBe('leave.request-submitted')
    expect(event.leaveType).toBe(LeaveType.Sick)
    expect(event.approverEmails).toEqual(['manager@example.com'])
    expect(event.paidDays).toBe(1)
  })
})
