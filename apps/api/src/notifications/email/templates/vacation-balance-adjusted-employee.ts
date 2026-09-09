/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  commentBlock,
  daysLabel,
  detailTable,
  emailButton,
  esc,
  leaveEmailShell,
  productNameFromEnv,
} from './shared'

export interface VacationBalanceAdjustedEmployeeParams {
  employeeDisplayName: string
  actorDisplayName: string
  // Signed day figure on the hour grid: positive added, negative removed. Not
  // a whole number any more (0.5 is a four-hour correction of an eight-hour
  // day), so daysLabel below renders it as days and hours. The sign is carried
  // by the wording and the +/− prefix, never by the label itself.
  deltaDays: number
  note: string
  // Bookable leftover after the change, when known.
  availableDays?: number
  // Running accrued after the change, when known.
  accruedDays?: number
  // The org's workday length, so every figure below reads as days and hours.
  hoursPerDay: number
  balanceUrl: string
}

/**
 * Notice to the employee that an administrator adjusted their vacation
 * balance for the open leave year (add or remove).
 */
export function buildVacationBalanceAdjustedEmployeeEmail(
  params: VacationBalanceAdjustedEmployeeParams,
): { subject: string; html: string } {
  const productName = productNameFromEnv()
  const magnitudeLabel = daysLabel(
    Math.abs(params.deltaDays),
    params.hoursPerDay,
  )
  const verb = params.deltaDays > 0 ? 'added' : 'removed'
  const subject =
    params.deltaDays > 0
      ? `${magnitudeLabel} added to your vacation balance`
      : `${magnitudeLabel} removed from your vacation balance`

  const rows: Array<[string, string]> = [
    [
      'Change',
      params.deltaDays > 0 ? `+${magnitudeLabel}` : `−${magnitudeLabel}`,
    ],
    ['Adjusted by', params.actorDisplayName],
  ]
  if (params.availableDays !== undefined) {
    rows.push([
      'Available now',
      daysLabel(params.availableDays, params.hoursPerDay),
    ])
  } else if (params.accruedDays !== undefined) {
    rows.push(['Accrued now', daysLabel(params.accruedDays, params.hoursPerDay)])
  }

  const html = leaveEmailShell({
    productName,
    title: 'Vacation balance updated',
    introHtml: `Hi ${esc(params.employeeDisplayName)}, an administrator ${verb} ${esc(magnitudeLabel)} ${
      params.deltaDays > 0 ? 'to' : 'from'
    } your vacation balance.`,
    bodyHtml: [
      detailTable(rows),
      commentBlock(params.note),
      emailButton('View balance', params.balanceUrl),
    ].join(''),
  })
  return { subject, html }
}
