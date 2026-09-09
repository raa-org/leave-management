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
  linkFallback,
  productNameFromEnv,
} from './shared'

// The copy notice for CC recipients of a request the system approved on its
// own (approval is optional org-wide and the request named no approver). It is
// deliberately NOT the approval-request email: that one asks for a review that
// will never come. This one only reports, in observer voice, that leave was
// booked — which is exactly what a copied recipient is for.
export interface AutoApprovedCopiedParams {
  requestId: string
  requesterDisplayName: string
  leaveType: LeaveType | string
  startDate: string
  endDate: string
  requestedDays: number
  paidDays?: number
  unpaidDays?: number
  // The org's workday length, so every figure below reads as days and hours.
  hoursPerDay: number
  comment?: string
  requestUrl: string
}

export function buildAutoApprovedCopiedEmail(
  params: AutoApprovedCopiedParams,
): { subject: string; html: string } {
  const productName = productNameFromEnv()
  const subject = `${params.requesterDisplayName} booked ${leaveTypeLabel(params.leaveType)}`
  const rows: Array<[label: string, value: string]> = [
    ['Employee', params.requesterDisplayName],
    ['Leave type', leaveTypeLabel(params.leaveType)],
    ['Dates', dateRange(params.startDate, params.endDate)],
    ['Duration', daysLabel(params.requestedDays, params.hoursPerDay)],
  ]
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
    title: 'Leave booked',
    // No call to action: the reader is copied, not asked. Saying who approved
    // it here (rather than in the table) keeps the table identical to the one
    // the approval email shows.
    introHtml:
      `<strong>${esc(params.requesterDisplayName)}</strong> booked leave. ` +
      'Approval is not required in this workspace, so the request was approved ' +
      'automatically and you are copied for your records.',
    bodyHtml: [
      detailTable(rows),
      // The employee's own note, when they left one. Rendered plainly rather
      // than through commentBlock so it never reads as a decision comment.
      params.comment
        ? `<p style="margin:16px 0 0;font-size:14px;line-height:22px;color:#475467;">${esc(params.comment)}</p>`
        : '',
      emailButton('Leave request', params.requestUrl),
      linkFallback(params.requestUrl),
    ].join(''),
  })
  return { subject, html }
}
