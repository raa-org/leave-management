/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useRef, useState } from 'react'
import type {
  EmployeeImportRowDto,
  ImportEmployeeResultDto,
  ImportFunction,
  ImportMode,
  ImportValidationReportDto,
  LeaveHistoryImportRowDto,
} from '@workspace/contracts'
import type { AdminApiClient } from '../admin-api'
import {
  buildValidationBatches,
  buildWorkItems,
  chosenPolicyNameByEmail,
  mergeValidationReports,
  toValidationPayload,
  type EmployeeWorkItem,
} from './import-chunking'

/**
 * Owns one import run on behalf of the wizard.
 *
 * Requests are sent strictly one at a time — a batch during validation, an
 * employee during preview and apply. Sequential is not a simplification: the
 * policy catalog serializes minting anyway, and a wizard firing in parallel
 * would trade visible progress for lock waiting.
 *
 * Every phase is started by the operator, never by an effect, so nothing here
 * depends on how often React re-renders.
 */

export type ImportPhase = 'idle' | 'validating' | 'previewing' | 'applying'

export interface ImportEmployeeState {
  email: string
  status: 'pending' | 'running' | 'previewed' | 'applied' | 'skipped' | 'failed'
  result?: ImportEmployeeResultDto
}

export interface ImportRunState {
  phase: ImportPhase
  // Progress within the current phase, so the page can show "12 of 56".
  completed: number
  total: number
  validation?: ImportValidationReportDto
  employees: ImportEmployeeState[]
  error?: string
}

export interface ImportRunOptions {
  fn: ImportFunction
  targetYear: number
  mode: ImportMode
  // The day the source file's balances were taken; the reconciliation is
  // measured on it rather than on today.
  snapshotDate?: string
  employees?: EmployeeImportRowDto[]
  history?: LeaveHistoryImportRowDto[]
  // The names the operator chose for the policies about to be minted, keyed by
  // the validation report's terms fingerprint (opaque here: only the server can
  // derive it, and only it separates two offers sharing a vacation and sick
  // base).
  policyNames?: Record<string, string>
}

const initialState: ImportRunState = {
  phase: 'idle',
  completed: 0,
  total: 0,
  employees: [],
}

const statusOf = (result: ImportEmployeeResultDto): ImportEmployeeState['status'] => {
  switch (result.status) {
    case 'ok':
      return 'previewed'
    case 'applied':
      return 'applied'
    case 'skipped':
      return 'skipped'
    default:
      return 'failed'
  }
}

export function useImportRun(api: AdminApiClient) {
  const [state, setState] = useState<ImportRunState>(initialState)
  const inFlight = useRef(false)
  const items = useRef<EmployeeWorkItem[]>([])
  // Outcomes mirrored OUTSIDE React state, written the moment each result
  // lands. complete() must read these, not state.employees: a caller's
  // `applyAll(...).then(() => complete(...))` holds the complete instance of
  // the render it started from, whose captured state predates the whole walk.
  // Reading that stale snapshot made a clean full apply skip the audit
  // summary entirely (every status still 'previewed', nothing to report).
  const outcomes = useRef<Record<string, ImportEmployeeState['status']>>({})
  // The merged validation report, mirrored outside React state for the same
  // reason as the outcomes above: the walk runs from a callback captured in an
  // earlier render, and it needs the report to tell which policy group each
  // employee was put in before it can send the name the operator chose.
  const validation = useRef<ImportValidationReportDto | undefined>(undefined)
  // What complete() has already posted, per email. Each POST writes one audit
  // row naming a batch, so a second complete() must report only the DELTA
  // since the last successful one — an operator applying three people one by
  // one gets three rows naming one employee each, not three overlapping ones.
  const reported = useRef<Record<string, ImportEmployeeState['status']>>({})

  const reset = useCallback(() => {
    items.current = []
    outcomes.current = {}
    reported.current = {}
    validation.current = undefined
    setState(initialState)
  }, [])

  const validate = useCallback(
    async (options: ImportRunOptions) => {
      if (inFlight.current) {
        return
      }
      inFlight.current = true
      items.current = buildWorkItems(options)
      outcomes.current = Object.fromEntries(
        items.current.map((item) => [item.email, 'pending' as const]),
      )
      reported.current = {}
      validation.current = undefined
      const batches = buildValidationBatches(items.current)
      setState({
        phase: 'validating',
        completed: 0,
        total: batches.length,
        employees: items.current.map((item) => ({
          email: item.email,
          status: 'pending',
        })),
      })

      const reports: ImportValidationReportDto[] = []
      try {
        for (const batch of batches) {
          const report = await api.validateImport({
            fn: options.fn,
            targetYear: options.targetYear,
            mode: options.mode,
            snapshotDate: options.snapshotDate,
            ...toValidationPayload(batch),
          })
          reports.push(report)
          validation.current = mergeValidationReports(reports)
          setState((current) => ({
            ...current,
            completed: current.completed + 1,
            validation: validation.current,
          }))
        }
        validation.current = mergeValidationReports(reports)
        setState((current) => ({
          ...current,
          phase: 'idle',
          validation: validation.current,
        }))
      } catch (error) {
        setState((current) => ({
          ...current,
          phase: 'idle',
          error: messageOf(error, 'The file could not be validated.'),
        }))
      } finally {
        inFlight.current = false
      }
    },
    [api],
  )

  // Preview and apply differ only in which endpoint they call and whether the
  // work survives the request, so they share one walk. Resolves true when the
  // walk finished and false when a thrown request stopped it (the error is on
  // state) — a caller looping applyOne needs that signal, because firing the
  // next employee into a dead API would just repeat the failure N more times.
  const walk = useCallback(
    async (
      options: ImportRunOptions,
      phase: 'previewing' | 'applying',
      only?: string,
    ): Promise<boolean> => {
      if (inFlight.current) {
        return false
      }
      inFlight.current = true
      const targets = only
        ? items.current.filter((item) => item.email === only)
        : items.current
      for (const item of targets) {
        outcomes.current[item.email] = 'pending'
      }
      setState((current) => ({
        ...current,
        phase,
        completed: 0,
        total: targets.length,
        error: undefined,
        employees: current.employees.map((employee) =>
          !only || employee.email === only
            ? { ...employee, status: 'pending' }
            : employee,
        ),
      }))

      // Built once per walk from the report's own grouping: the client never
      // derives a terms key of its own, so it cannot disagree with the server
      // about which policy an employee belongs to.
      const chosenName = chosenPolicyNameByEmail(
        validation.current,
        options.policyNames,
      )

      try {
        for (const item of targets) {
          setState((current) => ({
            ...current,
            employees: current.employees.map((employee) =>
              employee.email === item.email
                ? { ...employee, status: 'running' }
                : employee,
            ),
          }))
          const payload = {
            fn: options.fn,
            targetYear: options.targetYear,
            mode: options.mode,
            snapshotDate: options.snapshotDate,
            employee: item.employee,
            history: item.history,
            policyName: item.employee
              ? chosenName[item.email.trim().toLowerCase()]
              : undefined,
          }
          const result =
            phase === 'previewing'
              ? await api.previewImportEmployee(payload)
              : await api.applyImportEmployee(payload)
          outcomes.current[item.email] = statusOf(result)
          setState((current) => ({
            ...current,
            completed: current.completed + 1,
            employees: current.employees.map((employee) =>
              employee.email === item.email
                ? { ...employee, status: statusOf(result), result }
                : employee,
            ),
          }))
        }
        setState((current) => ({ ...current, phase: 'idle' }))
        return true
      } catch (error) {
        // Nothing was written for the employee whose request threw, nor for
        // the targets behind them: put every unsettled target back into a
        // retryable status instead of leaving a perpetual 'running'. In the
        // apply walk they all still hold computed previews, so 'previewed'
        // (and the Apply-remaining count) is what they return to.
        const retryable = phase === 'applying' ? 'previewed' : 'pending'
        const unsettled = new Set(
          targets
            .map((item) => item.email)
            .filter((email) => outcomes.current[email] === 'pending'),
        )
        for (const email of unsettled) {
          outcomes.current[email] = retryable
        }
        setState((current) => ({
          ...current,
          phase: 'idle',
          error: messageOf(
            error,
            phase === 'previewing'
              ? 'The preview could not be computed.'
              : 'The import stopped. Employees already applied are committed; the rest were not touched.',
          ),
          employees: current.employees.map((employee) =>
            unsettled.has(employee.email)
              ? { ...employee, status: retryable }
              : employee,
          ),
        }))
        return false
      } finally {
        inFlight.current = false
      }
    },
    [api],
  )

  const preview = useCallback(
    (options: ImportRunOptions) => walk(options, 'previewing'),
    [walk],
  )

  const applyAll = useCallback(
    (options: ImportRunOptions) => walk(options, 'applying'),
    [walk],
  )

  const applyOne = useCallback(
    (options: ImportRunOptions, email: string) =>
      walk(options, 'applying', email),
    [walk],
  )

  /**
   * Closes the run in the audit trail. Called once the operator is done, and
   * deliberately best-effort: the employees are already committed, so a
   * failure to write the summary must not read as a failed import.
   */
  const complete = useCallback(
    async (options: ImportRunOptions) => {
      // Read the outcomes ref, never state: the caller invariably holds this
      // callback from the render its walk STARTED in, and that render's state
      // predates every result (see the outcomes comment above). Only the
      // delta since the last successful post goes out — see `reported`.
      const applied: string[] = []
      const skipped: string[] = []
      const failed: string[] = []
      for (const [email, status] of Object.entries(outcomes.current)) {
        if (reported.current[email] === status) {
          continue
        }
        if (status === 'applied') {
          applied.push(email)
        } else if (status === 'skipped') {
          skipped.push(email)
        } else if (status === 'failed') {
          failed.push(email)
        }
      }
      if (applied.length === 0 && skipped.length === 0 && failed.length === 0) {
        return
      }
      try {
        await api.completeImport({
          fn: options.fn,
          targetYear: options.targetYear,
          mode: options.mode,
          applied,
          skipped,
          failed,
        })
        // Marked only after the POST succeeded, so a failed summary write is
        // retried by whichever complete() runs next.
        for (const email of [...applied, ...skipped, ...failed]) {
          reported.current[email] = outcomes.current[email] as ImportEmployeeState['status']
        }
      } catch {
        // Swallowed on purpose: see above.
      }
    },
    [api],
  )

  return { state, validate, preview, applyAll, applyOne, complete, reset }
}

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback
