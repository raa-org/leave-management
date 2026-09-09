/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  ApproverKind,
  LeaveType,
  type LeaveRequestApprovalRecipientDto,
  normalizeEmail,
} from '@workspace/contracts'
import { formatDayAmount } from '../../../domain/day-math'

// Names the approvers who were asked to decide, one label each. A name reads
// better than an address and matches how the single-approver line names the
// person who decided, so the name stands alone — the address is appended only
// to the approvers a bare name would not tell apart, and stands in for the
// name when none is known for the address.
//
// Dedup is by address, which identifies an approver where a name does not: the
// same person listed twice in different spellings is one line, and an approver
// with no name to show still counts as themselves.
export function decidingApproverLabels(
  approvers: LeaveRequestApprovalRecipientDto[],
): string[] {
  const seen = new Set<string>()
  const deciders: Array<{ name?: string; email: string }> = []
  for (const approver of approvers) {
    if (approver.kind !== ApproverKind.To) {
      continue
    }
    const email = approver.email.trim()
    const name = approver.displayName?.trim()
    // An approver is their address, but a row that somehow reached us without
    // one is still a person to name rather than a line to drop.
    const key = normalizeEmail(email) || name?.toLowerCase()
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    deciders.push({ ...(name ? { name } : {}), email })
  }

  // How many of the listed approvers a bare name would read the same for.
  const timesNamed = new Map<string, number>()
  for (const decider of deciders) {
    if (decider.name) {
      const key = decider.name.toLowerCase()
      timesNamed.set(key, (timesNamed.get(key) ?? 0) + 1)
    }
  }

  return deciders.map(({ name, email }) => {
    if (!name) {
      return email
    }
    const shared = (timesNamed.get(name.toLowerCase()) ?? 0) > 1
    return shared && email ? `${name} (${email})` : name
  })
}

export function productNameFromEnv(): string {
  return (
    process.env.LEAVE_EMAIL_PRODUCT_NAME?.trim() ||
    process.env.COMMUNICATION_EMAIL_DEFAULT_FROM_NAME?.trim() ||
    'Leave Requests'
  )
}

export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function leaveTypeLabel(leaveType: LeaveType | string): string {
  if (leaveType === LeaveType.Sick || leaveType === 'sick') return 'Sick leave'
  if (leaveType === LeaveType.Vacation || leaveType === 'vacation') return 'Vacation'
  return String(leaveType)
}

export function dateRange(start: string, end: string): string {
  return start === end ? start : `${start} – ${end}`
}

// Every day figure an email states, in the one notation the whole product uses
// (formatDayAmount: "2d 4h", "5h", "3d"). Clamped at zero because an email is
// the wrong place to argue with a negative balance; the sign of a deliberate
// change is spelled out by its own caller.
//
// hoursPerDay comes off the event that triggered the send, so the message
// describes the leave against the workday that was in force when it happened.
export function daysLabel(days: number, hoursPerDay: number): string {
  return formatDayAmount(Math.max(0, days), hoursPerDay)
}

export function detailTable(rows: Array<[label: string, value: string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#475467;">${esc(label)}</td><td style="padding:8px 0;font-weight:600;">${esc(value)}</td></tr>`,
    )
    .join('')
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">${body}</table>`
}

export function commentBlock(comment: string): string {
  const text = comment.trim()
  if (!text) return ''
  return `<p style="margin:16px 0 0;padding:12px 16px;background:#f9fafb;border-radius:8px;"><strong>Comment</strong><br/>${esc(text)}</p>`
}

export function emailButton(label: string, url: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 0;">
        <tr>
          <td bgcolor="#155eef" style="background-color:#155eef;border-radius:10px;">
            <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(label)}</a>
          </td>
        </tr>
      </table>`
}

export function linkFallback(url: string): string {
  return `<p style="margin:16px 0 0;font-size:13px;color:#475467;line-height:1.5;">
        Or open this link:<br/>
        <a href="${esc(url)}" style="color:#0040c1;word-break:break-all;">${esc(url)}</a>
      </p>`
}

export function leaveEmailShell(input: {
  productName: string
  title: string
  introHtml: string
  bodyHtml: string
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px 16px;background:#f3f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#101828;">
  <div style="max-width:560px;margin:0 auto;">
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#155eef;">${esc(input.productName)}</p>
    <div style="background:#fff;border:1px solid #eaecf0;border-radius:14px;padding:24px;">
      <h1 style="margin:0 0 8px;font-size:22px;">${esc(input.title)}</h1>
      <p style="margin:0 0 20px;color:#475467;line-height:1.6;">${input.introHtml}</p>
      ${input.bodyHtml}
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#475467;text-align:center;">Automated message from ${esc(input.productName)}. Do not reply.</p>
  </div>
</body>
</html>`
}
