/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ImportMode } from '@workspace/contracts'
import type { ImportEmployeeState, ImportRunState } from './use-import-run'

/**
 * The wizard's rail and receipts as a pure projection.
 *
 * This module exists so the 4-step rail and the receipt strip are DERIVED from
 * ImportRunState plus the wizard's own locals (step, file, mode, year) — never
 * kept as a second state machine that could drift from the run. Every caption
 * string lives here rather than in JSX, so node tests cover the exact wording
 * without rendering anything.
 */

export type WizardStep = 1 | 2 | 3 | 4

export interface WizardContext {
  step: WizardStep
  // '' until a workbook is loaded; the step-1 caption switches on it.
  fileName: string
  peopleCount: number
  rowCount: number
  mode: ImportMode
  targetYear: number
  snapshotDate: string
  run: ImportRunState
  // Directory sync in flight (the unknown-emails remedy) — busy like a phase.
  syncing: boolean
}

export interface WizardTallies {
  applied: number
  skipped: number
  failed: number
  previewed: number
  pending: number
  // Terminal outcomes only: applied + skipped + failed.
  done: number
  // Every employee reached a terminal outcome (and there was at least one).
  settled: boolean
}

export function tallies(employees: ImportEmployeeState[]): WizardTallies {
  const counts: WizardTallies = {
    applied: 0,
    skipped: 0,
    failed: 0,
    previewed: 0,
    pending: 0,
    done: 0,
    settled: false,
  }
  for (const employee of employees) {
    if (employee.status === 'applied') {
      counts.applied += 1
    } else if (employee.status === 'skipped') {
      counts.skipped += 1
    } else if (employee.status === 'failed') {
      counts.failed += 1
    } else if (employee.status === 'previewed') {
      counts.previewed += 1
    } else if (employee.status === 'pending') {
      counts.pending += 1
    }
  }
  counts.done = counts.applied + counts.skipped + counts.failed
  counts.settled = employees.length > 0 && counts.done === employees.length
  return counts
}

export interface RailStepModel {
  step: WizardStep
  title: string
  caption: string
  state: 'current' | 'done' | 'future'
  clickable: boolean
}

export interface ReceiptModel {
  step: WizardStep
  text: string
}

export function wizardBusy(ctx: WizardContext): boolean {
  return ctx.run.phase !== 'idle' || ctx.syncing
}

const STEPS: WizardStep[] = [1, 2, 3, 4]
const TITLES: Record<WizardStep, string> = {
  1: 'Source file',
  2: 'Validation',
  3: 'Review',
  4: 'Apply',
}

const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`

// Progress within a phase, shown as the item BEING worked on: completed 0 of 3
// reads "1 of 3", and the cap keeps the last item from reading "4 of 3".
const progressOf = (run: ImportRunState): string =>
  `${Math.min(run.completed + 1, run.total)} of ${run.total}`

const warningsOf = (run: ImportRunState): number =>
  run.validation
    ? run.validation.issues.filter((issue) => issue.severity === 'warning').length
    : 0

export function railModel(ctx: WizardContext): RailStepModel[] {
  const busy = wizardBusy(ctx)
  const totals = tallies(ctx.run.employees)
  return STEPS.map((step) => {
    const state = railState(ctx, step, totals)
    return {
      step,
      title: TITLES[step],
      caption: railCaption(ctx, step, totals),
      state,
      clickable: state === 'done' && step < 4 && !busy,
    }
  })
}

function railState(
  ctx: WizardContext,
  step: WizardStep,
  totals: WizardTallies,
): RailStepModel['state'] {
  if (step === ctx.step) {
    return 'current'
  }
  if (
    step < ctx.step ||
    (step === 4 && totals.settled && ctx.run.phase === 'idle')
  ) {
    return 'done'
  }
  return 'future'
}

function railCaption(
  ctx: WizardContext,
  step: WizardStep,
  totals: WizardTallies,
): string {
  const { run } = ctx
  if (step === 1) {
    return ctx.fileName
      ? `${count(ctx.peopleCount, 'person', 'people')} · ${count(ctx.rowCount, 'row')}`
      : 'Mode, year and workbook'
  }
  if (step === 2) {
    if (run.phase === 'validating') {
      return `Checking batch ${progressOf(run)}`
    }
    if (run.validation) {
      const ready = `${run.validation.employees.length} ready · ${count(warningsOf(run), 'warning')}`
      return run.validation.unknownEmails.length > 0
        ? `${ready} · ${run.validation.unknownEmails.length} unknown`
        : ready
    }
    return 'Directory and policy checks'
  }
  if (step === 3) {
    if (run.phase === 'previewing') {
      return `Computing ${progressOf(run)}`
    }
    if (totals.previewed > 0) {
      return `${totals.previewed} previewed`
    }
    return 'Exact numbers, computed live'
  }
  if (run.phase === 'applying') {
    return `Applying ${progressOf(run)}`
  }
  if (totals.settled) {
    return `${totals.applied} applied · ${totals.skipped} skipped · ${totals.failed} failed`
  }
  if (totals.done > 0) {
    return `${totals.done} of ${run.employees.length} done`
  }
  return 'One employee at a time'
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** '2026-08-10' → '10 Aug' (prototype fmtDate): the in-card date language,
 * where the year would repeat on every row. Non-ISO input passes through. */
export function formatDayMonth(iso: string): string {
  const parts = iso.split('-')
  if (parts.length < 3) {
    return iso
  }
  const month = MONTHS[Number(parts[1]) - 1]
  return month ? `${Number(parts[2])} ${month}` : iso
}

/** '2026-08-10' → '10 Aug 2026': the receipt/summary variant, where a
 * snapshot can belong to a different year than the run's target. */
export function formatSnapshotDate(iso: string): string {
  const short = formatDayMonth(iso)
  return short === iso ? iso : `${short} ${iso.split('-')[0]}`
}

/** The receipt and summary wording for the mode (prototype modeLabel). */
export function importModeLabel(mode: ImportMode): string {
  return mode === 'add' ? 'Add' : 'Override (refresh)'
}

export function receiptModel(ctx: WizardContext): ReceiptModel[] {
  const receipts: ReceiptModel[] = []
  const { run } = ctx
  if (ctx.step > 1) {
    receipts.push({
      step: 1,
      text: `Source file · ${ctx.fileName} · ${importModeLabel(ctx.mode)} · ${ctx.targetYear} · snapshot ${formatSnapshotDate(ctx.snapshotDate)}`,
    })
  }
  // A step earns a receipt only once it has data to show: a wiped run (Start
  // over mid-flow) simply drops the line rather than inventing zeros.
  if (ctx.step > 2 && run.validation) {
    const base = `Validation · ${run.validation.employees.length} ready · ${count(warningsOf(run), 'warning')}`
    const minted = run.validation.policiesToCreate.length
    receipts.push({
      step: 2,
      text:
        minted > 0
          ? `${base} · ${count(minted, 'policy to create', 'policies to create')}`
          : base,
    })
  }
  if (ctx.step > 3) {
    const totals = tallies(run.employees)
    if (totals.previewed > 0) {
      receipts.push({
        step: 3,
        text: `Review · ${totals.previewed} previewed · exact numbers from a rolled-back run`,
      })
    } else if (totals.done > 0) {
      // The apply walk resets every status to 'pending' before it starts, so
      // mid-apply (and after) the previewed count is gone. Rather than restate
      // a number the state no longer holds, the receipt reports what the apply
      // has settled so far — simple, total, and always true.
      receipts.push({
        step: 3,
        text: `Review · ${totals.done} of ${run.employees.length} already applied`,
      })
    }
  }
  return receipts
}
