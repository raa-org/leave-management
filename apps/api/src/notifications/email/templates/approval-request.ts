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
  linkFallback,
  productNameFromEnv,
} from './shared'

export interface ApprovalRequestParams {
  requestId: string
  requesterDisplayName: string
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
  comment?: string
  approvalUrl: string
}

export function buildApprovalRequestEmail(
  params: ApprovalRequestParams,
): { subject: string; html: string } {
  const productName = productNameFromEnv()
  const subject = `Approval needed for ${params.requesterDisplayName}`
  const rows: Array<[label: string, value: string]> = [
    ['Employee', params.requesterDisplayName],
    ['Leave type', leaveTypeLabel(params.leaveType)],
    ['Dates', dateRange(params.startDate, params.endDate)],
    ['Duration', daysLabel(params.requestedDays, params.hoursPerDay)],
  ]
  // Only when part of the leave is unpaid: an approver signing off on days the
  // employee will not be paid for should be told so, and it sits next to the
  // duration it qualifies rather than at the bottom of the table.
  const unpaidDays = params.unpaidDays ?? 0
  if (unpaidDays > 0) {
    rows.push([
      'Unpaid',
      `${daysLabel(unpaidDays, params.hoursPerDay)} (the balance covers ${daysLabel(params.paidDays ?? 0, params.hoursPerDay)})`,
    ])
  }
  rows.push(['Reference', params.requestId])
  const html = leaveEmailShell({
    productName,
    title: 'Approval needed',
    introHtml: `<strong>${esc(params.requesterDisplayName)}</strong> submitted a leave request that requires your review.`,
    bodyHtml: [
      detailTable(rows),
      params.comment ? commentBlock(params.comment) : '',
      emailButton('Leave request', params.approvalUrl),
      linkFallback(params.approvalUrl),
    ].join(''),
  })
  return { subject, html }
}
