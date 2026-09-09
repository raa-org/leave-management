/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import type { ImportMode } from '@workspace/contracts'
import { adoptWorkdayHours } from '../../../lib/leave-format'
import { adminApi, type AdminApiClient } from '../admin-api'
import { useDirectorySyncRun } from '../use-directory-sync-run'
import { ImportApplyStep } from './ImportApplyStep'
import { ImportReviewStep } from './ImportReviewStep'
import { ImportSourceStep } from './ImportSourceStep'
import { ImportStepRail } from './ImportStepRail'
import { ImportValidationStep } from './ImportValidationStep'
import { ImportWizardReceipts } from './ImportWizardReceipts'
import { parseImportWorkbook, type ParsedImportWorkbook } from './import-parse'
import {
  formatSnapshotDate,
  importModeLabel,
  railModel,
  receiptModel,
  tallies,
  wizardBusy,
  type WizardContext,
  type WizardStep,
} from './import-wizard-model'
import { useImportRun, type ImportRunOptions } from './use-import-run'

/**
 * The import half of the Settings "Import and export" tab: the guided-rail
 * wizard ported from the admin-import-rail prototype. ONE workbook, one run,
 * four visible steps; the main column shows only the current step while the
 * completed ones collapse into receipt rows with a Change link.
 *
 * All run mechanics stay in useImportRun, untouched by the move: requests go
 * strictly one at a time, every phase is operator-started, and the rail and
 * receipts are a pure projection of that hook's state (import-wizard-model).
 */

const EMPTY_WORKBOOK: ParsedImportWorkbook = {
  employees: [],
  history: [],
  issues: [],
  sheets: {},
}

const todayIso = () => new Date().toISOString().slice(0, 10)

export function ImportWizard({
  api = adminApi,
}: {
  api?: AdminApiClient
}) {
  const [mode, setMode] = useState<ImportMode>('add')
  const [targetYear, setTargetYear] = useState(new Date().getFullYear())
  // The day the source file's balances were taken; reconciliation is measured
  // on it rather than on today (a tracker exported on the 1st and imported on
  // the 6th differs by days of accrual).
  const [snapshotDate, setSnapshotDate] = useState(todayIso)
  const [workbook, setWorkbook] = useState<ParsedImportWorkbook>(EMPTY_WORKBOOK)
  const [fileName, setFileName] = useState('')
  const [policyNames, setPolicyNames] = useState<Record<string, string>>({})
  const [step, setStep] = useState<WizardStep>(1)
  // Local progress for the sequential Apply-remaining loop: each applyOne
  // resets the hook's completed/total to 0/1, so the walk-wide numbers live
  // here while that loop runs.
  const [applyRemainingProgress, setApplyRemainingProgress] = useState<{
    done: number
    total: number
  } | null>(null)

  const run = useImportRun(api)
  const sync = useDirectorySyncRun(api, () => undefined)

  const options = useMemo<ImportRunOptions>(
    () => ({
      // Derived from the workbook, not chosen: whichever sheets it carried is
      // what the run did, and that is what the audit summary should say.
      fn:
        workbook.employees.length > 0 && workbook.history.length > 0
          ? 'combined'
          : workbook.history.length > 0
            ? 'leave-history'
            : 'user-data',
      targetYear,
      mode,
      snapshotDate: snapshotDate || undefined,
      employees: workbook.employees,
      history: workbook.history,
      policyNames,
    }),
    [workbook, targetYear, mode, snapshotDate, policyNames],
  )

  const ctx = useMemo<WizardContext>(
    () => ({
      step,
      fileName,
      peopleCount: workbook.employees.length,
      rowCount: workbook.history.length,
      mode,
      targetYear,
      snapshotDate,
      run: applyRemainingProgress
        ? {
            ...run.state,
            completed: applyRemainingProgress.done,
            total: applyRemainingProgress.total,
          }
        : run.state,
      syncing: sync.run.status === 'running',
    }),
    [
      step,
      fileName,
      workbook,
      mode,
      targetYear,
      snapshotDate,
      run.state,
      sync.run.status,
      applyRemainingProgress,
    ],
  )

  const busy = wizardBusy(ctx)
  const counts = tallies(run.state.employees)
  const remainingCount = counts.previewed + counts.pending

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return
      }
      const parsed = parseImportWorkbook(await file.arrayBuffer())
      setFileName(file.name)
      setWorkbook(parsed)
      setPolicyNames({})
      run.reset()
      setStep(1)
    },
    [run],
  )

  const resetAll = useCallback(() => {
    run.reset()
    setWorkbook(EMPTY_WORKBOOK)
    setFileName('')
    setPolicyNames({})
    setMode('add')
    setTargetYear(new Date().getFullYear())
    setSnapshotDate(todayIso())
    setApplyRemainingProgress(null)
    setStep(1)
  }, [run])

  const startValidation = useCallback(() => {
    setStep(2)
    void run.validate(options)
  }, [run, options])

  const startPreview = useCallback(() => {
    setStep(3)
    void run.preview(options)
  }, [run, options])

  const applyAll = useCallback(() => {
    setStep(4)
    void run.applyAll(options).then(() => run.complete(options))
  }, [run, options])

  // The sequential path for a partially settled run: applyAll's walk resets
  // EVERY employee to pending (already-applied ones would be re-sent, coming
  // back as skips at best), so the remainder is applied one call at a time.
  const applyRemaining = useCallback(async () => {
    const targets = run.state.employees
      .filter(
        (employee) =>
          employee.status === 'previewed' || employee.status === 'pending',
      )
      .map((employee) => employee.email)
    if (targets.length === 0) {
      return
    }
    setStep(4)
    setApplyRemainingProgress({ done: 0, total: targets.length })
    for (let index = 0; index < targets.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- one employee at a time is the contract
      const ok = await run.applyOne(options, targets[index] as string)
      if (!ok) {
        // The walk threw (the error is on run.state): stop instead of firing
        // the rest of the queue into a dead API one doomed request at a time.
        break
      }
      setApplyRemainingProgress({ done: index + 1, total: targets.length })
    }
    setApplyRemainingProgress(null)
    // Records whatever DID settle before a stop; complete() posts deltas, so
    // employees a previous summary already named are not re-reported.
    await run.complete(options)
  }, [run, options])

  const applyPrimary = useCallback(() => {
    if (counts.done > 0) {
      void applyRemaining()
    } else {
      applyAll()
    }
  }, [counts.done, applyRemaining, applyAll])

  const applyOne = useCallback(
    (email: string) => {
      setStep(4)
      void run.applyOne(options, email).then(() => run.complete(options))
    },
    [run, options],
  )

  // Change / rail navigation. Going back re-runs the phase the operator lands
  // on (validate rebuilds the work items, the preview walk resets statuses),
  // which is exactly the discard-later-steps semantics the receipts promise.
  // The one exception is "Back to review" from a partial apply: no recompute,
  // the settled statuses must stay visible on the cards.
  const goStep = useCallback(
    (target: WizardStep) => {
      if (target === 1) {
        run.reset()
        setApplyRemainingProgress(null)
        setStep(1)
      } else if (target === 2) {
        setStep(2)
        void run.validate(options)
      } else if (target === 3) {
        setStep(3)
        // Once anything is committed, re-previewing would wipe the settled
        // statuses (the walk resets every target) and rewrite outcomes the
        // audit summary already named — so a partial run only REVIEWS.
        if (counts.done === 0) {
          void run.preview(options)
        }
      }
    },
    [run, options, counts.done],
  )

  const backToReview = useCallback(() => {
    setStep(3)
  }, [])

  const runMetaLine = `${fileName} · ${importModeLabel(mode)} · ${targetYear} · snapshot ${formatSnapshotDate(snapshotDate)}`

  // The wizard is its own route and reads no settings response, so the divisor
  // for the day figures on its preview cards rides the validation report -
  // which always lands before a single card is rendered.
  const workdayHours = adoptWorkdayHours(run.state.validation?.hoursPerDay)

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '230px minmax(0, 1fr)' },
        gap: 2.5,
        alignItems: 'start',
      }}
    >
      <ImportStepRail
        steps={railModel(ctx)}
        onSelect={goStep}
        showStartOver={step > 1 || fileName.length > 0}
        startOverDisabled={busy}
        onStartOver={resetAll}
      />

      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <ImportWizardReceipts
          receipts={receiptModel(ctx)}
          busy={busy}
          onChange={goStep}
        />

        {step === 1 ? (
          <ImportSourceStep
            mode={mode}
            onModeChange={setMode}
            targetYear={targetYear}
            onTargetYearChange={setTargetYear}
            snapshotDate={snapshotDate}
            onSnapshotDateChange={setSnapshotDate}
            fileName={fileName}
            workbook={workbook}
            onFile={(file) => void onFile(file)}
            busy={busy}
            onContinue={startValidation}
          />
        ) : null}

        {step === 2 ? (
          <ImportValidationStep
            validating={run.state.phase === 'validating'}
            completed={run.state.completed}
            total={run.state.total}
            {...(run.state.validation
              ? { validation: run.state.validation }
              : {})}
            {...(run.state.error ? { error: run.state.error } : {})}
            syncRun={sync.run}
            onRunSync={sync.start}
            onValidateAgain={() => void run.validate(options)}
            policyNames={policyNames}
            onRenamePolicy={(termsFingerprint, name) =>
              setPolicyNames((current) => ({
                ...current,
                [termsFingerprint]: name,
              }))
            }
            busy={busy}
            onComputePreview={startPreview}
          />
        ) : null}

        {step === 3 ? (
          <ImportReviewStep
            previewing={run.state.phase === 'previewing'}
            completed={run.state.completed}
            total={run.state.total}
            employees={run.state.employees}
            {...(run.state.error ? { error: run.state.error } : {})}
            busy={busy}
            peopleCount={workbook.employees.length}
            rowCount={workbook.history.length}
            applyableCount={remainingCount}
            anySettled={counts.done > 0}
            onApplyAll={applyPrimary}
            onApplyOne={applyOne}
            hoursPerDay={workdayHours}
          />
        ) : null}

        {step === 4 ? (
          <ImportApplyStep
            applying={run.state.phase === 'applying'}
            progressDone={ctx.run.completed}
            progressTotal={ctx.run.total}
            employees={run.state.employees}
            {...(run.state.error ? { error: run.state.error } : {})}
            tallies={counts}
            runMetaLine={runMetaLine}
            remainingCount={remainingCount}
            busy={busy}
            onBackToReview={backToReview}
            onApplyRemaining={() => void applyRemaining()}
            onStartNewImport={resetAll}
          />
        ) : null}
      </Stack>
    </Box>
  )
}
