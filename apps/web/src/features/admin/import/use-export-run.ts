/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useRef, useState } from 'react'
import type { AdminApiClient } from '../admin-api'
import {
  buildExportSheets,
  exportWorkbookFilename,
  type ExportEmployeeSource,
  type ExportOptions,
} from './export-workbook'

/**
 * Owns one export run: page through the directory, fetch every employee's
 * detail (the only endpoint carrying balances AND request history), shape the
 * sheets with the pure builder, and hand the workbook to the browser.
 *
 * Deliberately client-side and O(N) requests: the export mirrors whatever the
 * admin surface can already see, needs no new endpoint, and at this
 * company's size the sequential walk takes seconds behind a progress bar.
 * Requests go one at a time for the same reason the import walks one
 * employee at a time: visible progress beats parallel lock contention.
 *
 * The file is written with exceljs, not the SheetJS build the parser uses:
 * the export doubles as the import template, and a template earns its keep
 * styled (the community SheetJS build cannot write styles). exceljs loads
 * lazily so its weight is paid on the first export, never on page load.
 */

export type ExportPhase = 'idle' | 'fetching' | 'done' | 'error'

export interface ExportRunState {
  phase: ExportPhase
  completed: number
  total: number
  error?: string
  summary?: {
    fileName: string
    employees: number
    requests: number
    leftOut: string[]
  }
}

const initialState: ExportRunState = { phase: 'idle', completed: 0, total: 0 }

const EMPLOYEES_PAGE_LIMIT = 200

// The header row's navy (the hand-made template the owner circulated), white
// bold text over it.
const HEADER_FILL_ARGB = 'FF203864'

const columnWidth = (
  rows: Array<Array<string | number>>,
  index: number,
): number => {
  // Sized to the data; the header wraps inside whatever this gives (min 14
  // keeps a wrapped three-line header from collapsing to a sliver, max 42
  // keeps one long policy name from swallowing the screen).
  let widest = 0
  for (const row of rows.slice(1)) {
    widest = Math.max(widest, String(row[index] ?? '').length)
  }
  return Math.min(42, Math.max(14, widest + 2))
}

export function useExportRun(api: AdminApiClient) {
  const [state, setState] = useState<ExportRunState>(initialState)
  const inFlight = useRef(false)

  const start = useCallback(
    async (options: ExportOptions) => {
      if (inFlight.current) {
        return
      }
      inFlight.current = true
      setState({ phase: 'fetching', completed: 0, total: 0 })
      try {
        // 1. The roster, page by page (keyset cursor like the employees page).
        const employeeIds: string[] = []
        let cursor: string | undefined
        do {
          // eslint-disable-next-line no-await-in-loop -- pages are sequential by design
          const page = await api.getEmployees({
            limit: EMPLOYEES_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          })
          for (const item of page.items) {
            employeeIds.push(item.employeeId)
          }
          cursor = page.nextCursor
        } while (cursor)

        // 2. The policy catalog once, to resolve each employee's terms.
        const policies = await api.getPolicies()
        const policyById = new Map(
          policies.map((policy) => [policy.policyId, policy]),
        )

        // 3. Every employee's detail, one at a time, with visible progress.
        setState({ phase: 'fetching', completed: 0, total: employeeIds.length })
        const sources: ExportEmployeeSource[] = []
        for (let index = 0; index < employeeIds.length; index += 1) {
          // eslint-disable-next-line no-await-in-loop -- one employee at a time, see header
          const detail = await api.getEmployeeDetail(
            employeeIds[index] as string,
          )
          const policy = detail.policyId
            ? policyById.get(detail.policyId)
            : undefined
          sources.push(policy ? { detail, policy } : { detail })
          setState((current) => ({ ...current, completed: index + 1 }))
        }

        // 4. Pure shaping, then the styled write.
        const sheets = buildExportSheets(sources, options)
        const { Workbook } = await import('exceljs')
        const book = new Workbook()
        const addSheet = (
          name: string,
          rows: Array<Array<string | number>>,
        ) => {
          const sheet = book.addWorksheet(name, {
            views: [{ state: 'frozen', ySplit: 1 }],
          })
          sheet.addRows(rows as Array<Array<string | number>>)
          sheet.columns.forEach((column, index) => {
            column.width = columnWidth(rows, index)
          })
          const header = sheet.getRow(1)
          header.height = 44
          header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
          header.alignment = { vertical: 'middle', wrapText: true }
          header.eachCell((headerCell) => {
            headerCell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: HEADER_FILL_ARGB },
            }
          })
        }
        if (sheets.employees) {
          addSheet('Employees', sheets.employees)
        }
        if (sheets.requests) {
          addSheet('Requests', sheets.requests)
        }

        // 5. The one DOM-touching stretch: exceljs gives a buffer, the anchor
        // click hands it to the browser as a download.
        const fileName = exportWorkbookFilename(options.year)
        const buffer = await book.xlsx.writeBuffer()
        const url = URL.createObjectURL(
          new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
        )
        try {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = fileName
          anchor.click()
        } finally {
          URL.revokeObjectURL(url)
        }

        setState({
          phase: 'done',
          completed: employeeIds.length,
          total: employeeIds.length,
          summary: {
            fileName,
            employees: sheets.employees ? sheets.employees.length - 1 : 0,
            requests: sheets.requestCount,
            leftOut: sheets.leftOut,
          },
        })
      } catch (error) {
        setState((current) => ({
          phase: 'error',
          completed: current.completed,
          total: current.total,
          error:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'The export could not be built.',
        }))
      } finally {
        inFlight.current = false
      }
    },
    [api],
  )

  return { state, start }
}
