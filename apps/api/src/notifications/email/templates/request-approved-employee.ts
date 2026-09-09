/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveType } from '@workspace/contracts'
import {
  dateRange,
  daysLabel,
  detailTable,
  emailButton,
  esc,
  leaveEmailShell,
  leaveTypeLabel,
  productNameFromEnv,
} from './shared'

export interface RequestApprovedEmployeeParams {
  employeeDisplayName: string
  leaveType: LeaveType | string
  startDate: string
  endDate: string
  requestedDays: number
  // The frozen paid/unpaid split of the requested days. Optional so a caller
  // that has no split to report (and every fully paid request) renders exactly
  // the email this template always rendered.
  paidDays?: number
  unpaidDays?: number
  // The org's workday length, so every figure below reads as days and hours.
  hoursPerDay: number
  actorDisplayName: string
  /** All deciding (to) approvers; when length > 1, shown as a list in the email. */
  approverLabels: string[]
  requestUrl: string
}

function approvalActorRows(params: RequestApprovedEmployeeParams): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Leave type', leaveTypeLabel(params.leaveType)],
    ['Dates', dateRange(params.startDate, params.endDate)],
    ['Duration', daysLabel(params.requestedDays, params.hoursPerDay)],
  ]
  // The approver was told which days the balance would not cover; so is the
  // person whose pay it is. Same wording as the approval email, and it sits
  // next to the duration it qualifies rather than after the decision.
  const unpaidDays = params.unpaidDays ?? 0
  if (unpaidDays > 0) {
    rows.push([
      'Unpaid',
      `${daysLabel(unpaidDays, params.hoursPerDay)} (the balance covers ${daysLabel(params.paidDays ?? 0, params.hoursPerDay)})`,
    ])
  }
  if (params.approverLabels.length > 1) {
    rows.push(['Approvers', params.approverLabels.join(', ')])
  } else {
    rows.push(['Approved by', params.actorDisplayName])
  }
  return rows
}

// Keyed on there being no deciding approver at all, never on the decision
// comment: an administrator override writes its own reason into that same
// field, and that text is not for the employee's inbox.
function wasApprovedAutomatically(params: RequestApprovedEmployeeParams): boolean {
  return params.approverLabels.length === 0
}

export function buildRequestApprovedEmployeeEmail(
  params: RequestApprovedEmployeeParams,
): { subject: string; html: string } {
  const productName = productNameFromEnv()
  const subject = `Your ${leaveTypeLabel(params.leaveType)} request was approved`
  const html = leaveEmailShell({
    productName,
    title: 'Request approved',
    introHtml: wasApprovedAutomatically(params)
      ? `Hi ${esc(params.employeeDisplayName)}, your leave request was approved automatically: approval is not required in this workspace, and you addressed the request to nobody.`
      : `Hi ${esc(params.employeeDisplayName)}, your leave request has been approved.`,
    bodyHtml: [
      detailTable(approvalActorRows(params)),
      emailButton('Leave request', params.requestUrl),
    ].join(''),
  })
  return { subject, html }
}
