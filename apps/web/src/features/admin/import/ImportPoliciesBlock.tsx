/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { ImportValidationReportDto } from '@workspace/contracts'
import { tealFocusSx } from '../policy-ui'

/**
 * What the run will do to the policy catalog, shown BEFORE anything is
 * applied (prototype "Policies found in the file": one bordered row per
 * group with a pill and the member count).
 *
 * Policies are minted from the terms in the file, so an operator who does not
 * see the grouping first has no way to know that thirty people are about to
 * land on one new policy, or that a tuple they thought was new already exists.
 *
 * Four outcomes, because the server now reports the four the run really has:
 * a policy joined by the name the file states, one joined by the terms the row
 * carries, a mint named by the file, and a mint named by the server. Only the
 * last is renameable: a name the file states travels on the row itself and
 * outranks anything typed here, so a box for it would collect a value the
 * server throws away.
 */
export function ImportPoliciesBlock({
  report,
  policyNames,
  onRename,
  disabled,
}: {
  report: ImportValidationReportDto
  // Keyed by the server's terms fingerprint, which the client treats as an
  // opaque id. Keying by "vacation+sick" merged two different offers with the
  // same base into one row, so a name typed for one of them was applied to
  // both and the second group's members were enrolled under it.
  policyNames: Record<string, string>
  onRename: (termsFingerprint: string, name: string) => void
  disabled?: boolean
}) {
  const nothingToShow =
    report.policiesToCreate.length === 0 && report.policiesToReuse.length === 0
  if (nothingToShow) {
    return null
  }
  const notes = footnotes(report)

  return (
    <Stack spacing={1}>
      <Typography
        sx={{
          fontSize: '12px',
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'text.disabled',
        }}
      >
        Policies found in the file
      </Typography>

      {report.policiesToReuse.map((policy) => (
        <PolicyRow
          key={policy.policyId}
          // A closed validity window is the one state of an existing policy the
          // operator has to act on, so it takes the pill rather than a note.
          pill={policy.retired ? 'retired' : 'exists'}
        >
          <Typography sx={{ fontSize: '14px', fontWeight: 800 }}>
            {policy.policyName}
          </Typography>
          <RowMeta
            text={[
              memberCount(policy.memberEmails.length),
              // Why this policy, in the operator's terms: named in the file, or
              // reached because its terms are the row's. The second is worth
              // saying even when the file DID state a name, since a live policy
              // already holding those terms is joined before a name is minted.
              policy.matchedBy === 'name'
                ? 'named in the file'
                : 'matched on the terms in the file',
              ...(policy.termsDiffer ? ['terms in the file differ'] : []),
              ...(policy.retired ? ['cannot take members'] : []),
            ].join(' · ')}
          />
        </PolicyRow>
      ))}

      {report.policiesToCreate.map((policy) => {
        const key = policy.termsFingerprint
        return (
          <PolicyRow key={key} pill="will be created">
            {policy.renameable ? (
              <TextField
                size="small"
                value={policyNames[key] ?? policy.plannedName}
                onChange={(event) => onRename(key, event.target.value)}
                disabled={disabled}
                inputProps={{ 'aria-label': 'Name for the new policy' }}
                sx={{
                  minWidth: 200,
                  ...tealFocusSx,
                  '& .MuiOutlinedInput-root': { fontSize: '13.5px' },
                }}
              />
            ) : (
              // No box at all rather than a disabled one: the value would never
              // reach the server, and a field that looks typeable but is
              // ignored is the defect this screen was fixed for.
              <Typography sx={{ fontSize: '14px', fontWeight: 800 }}>
                {policy.plannedName}
              </Typography>
            )}
            <RowMeta
              text={[
                memberCount(policy.memberEmails.length),
                `terms ${policy.vacationDaysPerYear} vacation + ${policy.sickDaysPerYear} sick`,
                ...(policy.renameable ? [] : ['named in the file']),
              ].join(' · ')}
            />
          </PolicyRow>
        )
      })}

      {notes.length > 0 ? (
        <Typography
          sx={{ fontSize: '12px', color: 'text.secondary', lineHeight: 1.55 }}
        >
          {notes.join(' ')}
        </Typography>
      ) : null}
    </Stack>
  )
}

const memberCount = (count: number): string =>
  `${count} employee${count === 1 ? '' : 's'}`

/**
 * A sentence per case the list contains, in the voice of the rest of the step.
 *
 * The rename explanation is not optional politeness: after the first run the
 * export writes a policy name into EVERY row, so on the way back almost nothing
 * is renameable, and without a line saying why, the boxes simply vanish.
 */
function footnotes(report: ImportValidationReportDto): string[] {
  const minted = report.policiesToCreate.length
  const renameable = report.policiesToCreate.filter(
    (policy) => policy.renameable,
  ).length
  const notes: string[] = []
  if (minted > 0) {
    // "Set of terms", not "vacation and sick combination": the grouping is by
    // every term, so two rows sharing a base can still be two policies.
    notes.push(
      minted === 1
        ? 'One set of terms in the file has no matching policy.'
        : `${minted} sets of terms in the file have no matching policy.`,
      'Employees with identical terms share one policy.',
    )
  }
  if (renameable > 0) {
    notes.push(
      renameable === 1
        ? 'Rename it here before it is minted; the terms themselves come from the file.'
        : 'Rename them here before they are minted; the terms themselves come from the file.',
    )
  }
  if (minted > renameable) {
    notes.push('A name the file states is not editable here: the file decides it.')
  }
  if (report.policiesToReuse.some((policy) => policy.termsDiffer)) {
    notes.push(
      'Where the file states terms an existing policy does not hold, the policy wins and the employees are only enrolled.',
    )
  }
  if (report.policiesToReuse.some((policy) => policy.retired)) {
    notes.push(
      'A retired policy cannot take members, so those rows block the run until the file or the policy is fixed.',
    )
  }
  return notes
}

function PolicyRow({
  pill,
  children,
}: {
  pill: 'exists' | 'retired' | 'will be created'
  children: [React.ReactNode, React.ReactNode]
}) {
  const [name, meta] = children
  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      flexWrap="wrap"
      alignItems="center"
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: '12px',
        px: 1.75,
        py: 1.25,
      })}
    >
      {name}
      <Box
        component="span"
        sx={(theme) => ({
          fontSize: '10.5px',
          fontWeight: 700,
          borderRadius: 999,
          px: 1.1,
          py: 0.3,
          whiteSpace: 'nowrap',
          ...(pill === 'will be created'
            ? {
                color: 'secondary.main',
                border: `1px solid ${alpha(theme.palette.secondary.main, 0.35)}`,
                bgcolor: alpha(theme.palette.secondary.main, 0.1),
              }
            : pill === 'retired'
              ? {
                  // Carries the error tone because it IS the blocking error:
                  // every member of that row is refused by the enrollment.
                  color: 'error.main',
                  border: `1px solid ${alpha(theme.palette.error.main, 0.35)}`,
                  bgcolor: alpha(theme.palette.error.main, 0.1),
                }
              : {
                  color: 'text.secondary',
                  border: `1px solid ${theme.palette.divider}`,
                }),
        })}
      >
        {pill}
      </Box>
      <Box sx={{ flex: 1 }} />
      {meta}
    </Stack>
  )
}

function RowMeta({ text }: { text: string }) {
  return (
    <Typography
      sx={{
        fontSize: '12px',
        fontWeight: 600,
        color: 'text.secondary',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {text}
    </Typography>
  )
}
