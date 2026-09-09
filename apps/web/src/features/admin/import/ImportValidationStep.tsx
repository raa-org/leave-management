/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { ImportValidationReportDto } from '@workspace/contracts'
import { SectionCard } from '../../employee/employee-ui'
import type { DirectorySyncRun } from '../use-directory-sync-run'
import { ImportPoliciesBlock } from './ImportPoliciesBlock'
import {
  NoticeLine,
  ProgressLine,
  StatTile,
  ghostButtonSx,
} from './import-wizard-ui'
import { ValidationGlyph } from './import-wizard-glyphs'

/**
 * Step 2 (prototype Validation card). Everything here is the report the
 * batched server checks produced; the only actions are the directory sync
 * detour for unknown addresses and the primary that moves on to the preview.
 * Re-validation after a sync is operator-started, never automatic.
 */
export function ImportValidationStep({
  validating,
  completed,
  total,
  validation,
  error,
  syncRun,
  onRunSync,
  onValidateAgain,
  policyNames,
  onRenamePolicy,
  busy,
  onComputePreview,
}: {
  validating: boolean
  completed: number
  total: number
  validation?: ImportValidationReportDto
  error?: string
  syncRun: DirectorySyncRun
  onRunSync: () => void
  onValidateAgain: () => void
  policyNames: Record<string, string>
  onRenamePolicy: (termsFingerprint: string, name: string) => void
  busy: boolean
  onComputePreview: () => void
}) {
  const unknown = validation?.unknownEmails ?? []
  const warnings =
    validation?.issues.filter((issue) => issue.severity === 'warning') ?? []
  const errors =
    validation?.issues.filter((issue) => issue.severity === 'error') ?? []
  const syncing = syncRun.status === 'running'

  return (
    <SectionCard
      title="Validation"
      caption="Batched server checks: directory accounts, dates against the holiday calendar, and the policy catalog."
      icon={<ValidationGlyph />}
      accent="secondary"
    >
      <Stack spacing={2}>
        {validating ? (
          <ProgressLine
            label={`Checking batch ${Math.min(completed + 1, total)} of ${total}`}
            done={completed}
            total={total}
          />
        ) : null}

        {error ? <NoticeLine tone="error">{error}</NoticeLine> : null}

        {validation ? (
          <>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <StatTile
                value={validation.employees.length}
                label="ready"
                tone="ok"
              />
              <StatTile
                value={unknown.length}
                label={unknown.length === 1 ? 'unknown address' : 'unknown addresses'}
                tone="warn"
              />
              <StatTile
                value={warnings.length}
                label={warnings.length === 1 ? 'warning' : 'warnings'}
                tone="warn"
              />
              <StatTile
                value={errors.length}
                label={errors.length === 1 ? 'blocking error' : 'blocking errors'}
                tone="warn"
              />
            </Stack>

            {unknown.length > 0 ? (
              <NoticeLine tone="warning">
                <Stack
                  direction="row"
                  spacing={1.5}
                  useFlexGap
                  flexWrap="wrap"
                  alignItems="center"
                >
                  <Typography
                    component="span"
                    sx={{ flex: 1, minWidth: 220, fontSize: 'inherit', lineHeight: 'inherit' }}
                  >
                    No account for <b>{unknown.join(', ')}</b>. The import never
                    creates accounts: run a directory sync, then validate again
                    to match the row{unknown.length === 1 ? '' : 's'}. Still
                    missing, those rows are ignored.
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={onRunSync}
                    disabled={syncing || busy}
                    sx={ghostButtonSx}
                  >
                    {syncing ? 'Syncing…' : 'Run directory sync'}
                  </Button>
                </Stack>
              </NoticeLine>
            ) : null}

            {/* Shown only while addresses are still unmatched: once a
                re-validation resolves them, the detour is over. */}
            {syncRun.status === 'done' && unknown.length > 0 ? (
              <NoticeLine tone="success">
                <Stack
                  direction="row"
                  spacing={1.5}
                  useFlexGap
                  flexWrap="wrap"
                  alignItems="center"
                >
                  <Typography
                    component="span"
                    sx={{ flex: 1, minWidth: 220, fontSize: 'inherit', lineHeight: 'inherit' }}
                  >
                    <b>Directory sync finished</b> · validate again to match the
                    freshly synced accounts.
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={onValidateAgain}
                    disabled={busy}
                    sx={ghostButtonSx}
                  >
                    Validate again
                  </Button>
                </Stack>
              </NoticeLine>
            ) : null}
            {syncRun.status === 'error' ? (
              <NoticeLine tone="error">{syncRun.message}</NoticeLine>
            ) : null}

            {errors.map((issue, index) => (
              <NoticeLine key={`e-${issue.email}-${index}`} tone="error">
                <b>{issue.email}</b> · {issue.message}
              </NoticeLine>
            ))}
            {warnings.slice(0, 20).map((issue, index) => (
              <NoticeLine key={`w-${issue.email}-${index}`} tone="warning">
                <b>{issue.email}</b> · {issue.message}
              </NoticeLine>
            ))}
            {warnings.length > 20 ? (
              <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
                And {warnings.length - 20} more warnings; the review shows each
                employee in full.
              </Typography>
            ) : null}

            <ImportPoliciesBlock
              report={validation}
              policyNames={policyNames}
              onRename={onRenamePolicy}
              disabled={busy}
            />
          </>
        ) : null}

        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          justifyContent="space-between"
          useFlexGap
          flexWrap="wrap"
        >
          <Typography sx={{ fontSize: '12px', color: 'text.disabled' }}>
            {validation
              ? validation.ok
                ? 'All checks passed; the preview computes exact numbers next.'
                : 'Resolve the blocking errors, then validate again.'
              : 'Checks run in batches; nothing is written.'}
          </Typography>
          <Button
            variant="contained"
            color="secondary"
            disabled={!validation?.ok || busy}
            onClick={onComputePreview}
          >
            Compute preview
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  )
}
