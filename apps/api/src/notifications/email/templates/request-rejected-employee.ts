/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveType } from '@workspace/contracts'
import {
  commentBlock,
  dateRange,
  daysLabel,
  detailTable,
  emailButton,
  esc,
  leaveEmailShell,
  leaveTypeLabel,
  productNameFromEnv,
} from './shared'

export interface RequestRejectedEmployeeParams {
  employeeDisplayName: string
  leaveType: LeaveType | string
  startDate: string
  endDate: string
  requestedDays: number
  // The org's workday length, so the duration reads as days and hours.
  hoursPerDay: number
  actorDisplayName: string
  requestUrl: string
  comment?: string
}

export function buildRequestRejectedEmployeeEmail(
  params: RequestRejectedEmployeeParams,
): { subject: string; html: string } {
  const productName = productNameFromEnv()
  const subject = `Your ${leaveTypeLabel(params.leaveType)} request was rejected`
  const html = leaveEmailShell({
    productName,
    title: 'Request rejected',
    introHtml: `Hi ${esc(params.employeeDisplayName)}, your leave request was rejected by ${esc(params.actorDisplayName)}.`,
    bodyHtml: [
      detailTable([
        ['Leave type', leaveTypeLabel(params.leaveType)],
        ['Dates', dateRange(params.startDate, params.endDate)],
        ['Duration', daysLabel(params.requestedDays, params.hoursPerDay)],
        ['Rejected by', params.actorDisplayName],
      ]),
      params.comment ? commentBlock(params.comment) : '',
      emailButton('Leave request', params.requestUrl),
    ].join(''),
  })
  return { subject, html }
}
