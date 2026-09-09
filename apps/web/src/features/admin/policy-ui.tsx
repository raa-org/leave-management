/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import Button, { type ButtonProps } from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { CreateLeavePolicyDto, LeavePolicyDto } from '@workspace/contracts'
import { DateField } from '../../components/date-picker'
import { DaysStepper } from '../employee/employee-ui'
import { policyTermChips, type PolicyValidity } from './policy-format'

// Presentational pieces the policies page, the profile panel and the transfer
// dialog share. Anything that decides WHAT to say lives in policy-format.ts;
// this file only renders.

/**
 * The admin console is teal; the employee workspace is blue. MUI rings a
 * focused field in the blue primary by default, which is the one blue thing on
 * an otherwise teal surface, so every admin form applies this.
 */
export const tealFocusSx = {
  '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': {
    borderColor: 'secondary.main',
  },
  '& .MuiOutlinedInput-root.Mui-focused': {
    boxShadow: '0 0 0 3px rgba(15, 118, 110, 0.1)',
  },
  '& .MuiInputLabel-root.Mui-focused': { color: 'secondary.main' },
} as const

// DaysStepper's own label metric. Every field in this form uses it rather than
// MUI's floating label, so the whole dialog speaks one language and no caption
// disappears into a notch the moment the field has a value.
const fieldLabelSx = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: 'text.secondary',
} as const

// The terms form's draft state: strings, because the steppers and text fields
// edit text and only the submit path converts. `capDays` empty means uncapped.
export type PolicyTermsDraft = {
  name: string
  description: string
  vacationDays: string
  sickDays: string
  increment: string
  // Years between two rises; '1' is the every-year deal every policy had
  // before the period existed.
  incrementEveryYears: string
  capDays: string
  probationMonths: string
  paidSickDuringProbation: boolean
  effectiveFrom: string
}

export function emptyPolicyTermsDraft(today: string): PolicyTermsDraft {
  return {
    name: '',
    description: '',
    vacationDays: '25',
    sickDays: '5',
    increment: '0',
    incrementEveryYears: '1',
    capDays: '',
    probationMonths: '0',
    // On by default: probation is meant to defer paid VACATION, not to make
    // someone choose between losing pay and working ill. Whoever wants the
    // stricter deal has to say so deliberately.
    paidSickDuringProbation: true,
    // A policy starting today can take members immediately; the writer
    // refuses a transfer that reaches before its start.
    effectiveFrom: today,
  }
}

// Two decimals, the quantum a POLICY TERM is held to, mirroring the server's
// roundPolicyTerm (apps/api/src/domain/policy-fingerprint.ts). Deliberately
// coarser than the books' roundDays: the fingerprint that decides a policy's
// identity quantizes here, so a term the form judges by any finer scale would
// disagree with the row the writer creates. Arithmetic hygiene only, never a
// display rounding.
function roundPolicyTerm(value: number): number {
  return Math.round(value * 100) / 100
}

// WHEN the rise period means anything. The writer coerces an inert period away
// rather than storing it, so every part of the form has to agree about when it
// is inert: the control that edits it, the rule that judges it and the payload
// that carries it. Quantized, so an increment of 0.001 is no increment here
// either.
function incrementPeriodApplies(increment: number): boolean {
  return roundPolicyTerm(increment) !== 0
}

/**
 * Turn a draft into the create payload, or explain what is wrong with it. The
 * server validates again (and owns the rules); this only spares a round trip
 * and words the obvious mistakes in place.
 */
export function policyDraftToPayload(
  draft: PolicyTermsDraft,
): { payload: CreateLeavePolicyDto } | { error: string } {
  const name = draft.name.trim()
  if (!name) {
    return { error: 'Give the policy a name.' }
  }
  const numeric = (raw: string): number | null => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  const vacationDays = numeric(draft.vacationDays)
  const sickDays = numeric(draft.sickDays)
  const increment = numeric(draft.increment)
  const probationMonths = numeric(draft.probationMonths)
  if (
    vacationDays === null ||
    sickDays === null ||
    increment === null ||
    probationMonths === null
  ) {
    return { error: 'Day counts must be non-negative numbers.' }
  }
  // Years, so whole numbers only, and never 0: the period divides the elapsed
  // years in the rate formula. The server holds the same range, this only says
  // so before the round trip.
  //
  // Only while something is actually added. The stepper is disabled at a zero
  // increment and the payload below throws an inert period away, so refusing
  // one would point the operator at a control they cannot reach: raise the
  // increment, clear the period box, drop the increment back, and the form
  // becomes unsubmittable.
  const periodApplies = incrementPeriodApplies(increment)
  const everyYears = Number(draft.incrementEveryYears)
  if (
    periodApplies &&
    (!Number.isInteger(everyYears) || everyYears < 1 || everyYears > 50)
  ) {
    return {
      error: 'Add the extra days every whole number of years, from 1 to 50.',
    }
  }
  const capDays = draft.capDays.trim() === '' ? null : numeric(draft.capDays)
  if (draft.capDays.trim() !== '' && capDays === null) {
    return { error: 'The increment cap must be a non-negative number.' }
  }
  if (capDays !== null && capDays < vacationDays) {
    return { error: 'The increment cap cannot be lower than the base allowance.' }
  }
  if (!draft.effectiveFrom) {
    return { error: 'Pick the date the policy starts.' }
  }
  return {
    payload: {
      name,
      ...(draft.description.trim()
        ? { description: draft.description.trim() }
        : {}),
      vacationDays,
      sickDays,
      vacationAnnualIncrement: increment,
      // Same settling as the probation flag below: the period control is
      // disabled while there is nothing to add, so a period left over from an
      // earlier edit must not travel and mint a behavioural twin of the flat
      // policy. The writer coerces it too; agreeing here keeps the payload the
      // form shows and the row it creates the same thing.
      vacationIncrementEveryYears: periodApplies ? everyYears : 1,
      ...(capDays !== null ? { vacationIncrementCapDays: capDays } : {}),
      probationMonths,
      // The flag only means something inside a probation window, and the
      // writer refuses the true/0 pair so two behaviourally identical policies
      // cannot carry different fingerprints. The checkbox is disabled at zero
      // months, so the draft's default would otherwise be unclearable: settle
      // it here instead of refusing what the form would not let anyone fix.
      paidSickDuringProbation:
        probationMonths === 0 ? false : draft.paidSickDuringProbation,
      effectiveFrom: draft.effectiveFrom,
    },
  }
}

/**
 * The catalog's "Duplicate with changes" action, as data.
 *
 * EVERY term travels. Terms are immutable, so duplicating is the only way to
 * revise a deal, and a term dropped here does not read as a copy that lost
 * something: it reads as a policy the admin believes they copied. A dropped
 * increment period turns "+5 every 3 years" into "+5 every year" and grants
 * three times the growth.
 *
 * The name and the start date deliberately do NOT: the catalog demands unique
 * names, and a copy starts when it is made, not when its original did.
 */
export function policyCopyDraft(
  policy: LeavePolicyDto,
  today: string,
): PolicyTermsDraft {
  return {
    ...emptyPolicyTermsDraft(today),
    name: `${policy.name} (copy)`,
    vacationDays: String(policy.vacationDays),
    sickDays: String(policy.sickDays),
    increment: String(policy.vacationAnnualIncrement),
    incrementEveryYears: String(policy.vacationIncrementEveryYears),
    capDays:
      policy.vacationIncrementCapDays === undefined
        ? ''
        : String(policy.vacationIncrementCapDays),
    probationMonths: String(policy.probationMonths),
    paidSickDuringProbation: policy.paidSickDuringProbation,
  }
}

export function PolicyTermsFields({
  draft,
  onChange,
  disabled = false,
}: {
  draft: PolicyTermsDraft
  onChange: (next: PolicyTermsDraft) => void
  disabled?: boolean
}) {
  const patch = (fields: Partial<PolicyTermsDraft>) =>
    onChange({ ...draft, ...fields })
  return (
    <Stack spacing={2.25} sx={tealFocusSx}>
      <Stack spacing={0.75}>
        <Typography component="label" htmlFor="policy-name" sx={fieldLabelSx}>
          Policy name
        </Typography>
        <TextField
          id="policy-name"
          value={draft.name}
          placeholder="Standard"
          onChange={(event) => patch({ name: event.target.value })}
          disabled={disabled}
          fullWidth
          size="small"
        />
      </Stack>
      <Stack spacing={0.75}>
        <Typography
          component="label"
          htmlFor="policy-description"
          sx={fieldLabelSx}
        >
          Description (optional)
        </Typography>
        <TextField
          id="policy-description"
          value={draft.description}
          placeholder="Who this deal is for"
          onChange={(event) => patch({ description: event.target.value })}
          disabled={disabled}
          fullWidth
          size="small"
        />
      </Stack>
      <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
        <DaysStepper
          label="Vacation days"
          value={draft.vacationDays}
          onChange={(value) => patch({ vacationDays: value })}
        />
        <DaysStepper
          label="Sick days"
          value={draft.sickDays}
          onChange={(value) => patch({ sickDays: value })}
        />
      </Stack>
      {/* Both rows bottom-align, so a control sits level with the stepper's
          buttons rather than floating up against its label. */}
      <Stack
        direction="row"
        spacing={3}
        flexWrap="wrap"
        useFlexGap
        alignItems="flex-end"
      >
        <DaysStepper
          label="Extra vacation days"
          value={draft.increment}
          onChange={(value) => patch({ increment: value })}
        />
        {/* The cadence, no longer implied by the label above: the rise can
            land every year or every N. Minimum 1 because the period divides,
            and dark while there is nothing to add, the same rule the cap
            field follows. */}
        <DaysStepper
          label="Added every (years)"
          value={draft.incrementEveryYears}
          onChange={(value) => patch({ incrementEveryYears: value })}
          min={1}
          max={50}
          disabled={disabled || !incrementPeriodApplies(Number(draft.increment))}
        />
        <Stack spacing={0.75}>
          {/* A standing label, not MUI's floating one: the floating version
              was too long to fit the notch, so it truncated to "Increment cap
              (blank = uncap..." and then vanished the moment you typed, which
              is exactly when you still need to know what the field is. */}
          <Typography component="label" htmlFor="policy-cap" sx={fieldLabelSx}>
            Maximum vacation days
          </Typography>
          <TextField
            id="policy-cap"
            value={draft.capDays}
            placeholder="No maximum"
            onChange={(event) => patch({ capDays: event.target.value })}
            disabled={disabled || Number(draft.increment) === 0}
            size="small"
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                'aria-label': 'Maximum vacation days',
              },
            }}
            sx={{
              width: 200,
              '& .MuiOutlinedInput-root': { height: 40, borderRadius: '10px' },
            }}
          />
        </Stack>
      </Stack>
      <Stack
        direction="row"
        spacing={3}
        alignItems="flex-end"
        flexWrap="wrap"
        useFlexGap
      >
        <DaysStepper
          label="Probationary period (months)"
          value={draft.probationMonths}
          onChange={(value) => patch({ probationMonths: value })}
          max={24}
        />
        <FormControlLabel
          sx={{ height: 40, m: 0 }}
          control={
            <Checkbox
              color="secondary"
              checked={draft.paidSickDuringProbation}
              onChange={(event) =>
                patch({ paidSickDuringProbation: event.target.checked })
              }
              disabled={disabled || Number(draft.probationMonths) === 0}
            />
          }
          label="Sick leave stays paid during the probationary period"
        />
      </Stack>
      <Stack spacing={0.75} sx={{ maxWidth: 260 }}>
        <Typography component="span" sx={fieldLabelSx}>
          Policy starts
        </Typography>
        <DateField
          label=""
          ariaLabel="Policy starts"
          value={draft.effectiveFrom}
          onChange={(value) => patch({ effectiveFrom: value })}
          disabled={disabled}
          fullWidth
        />
      </Stack>
      <Box
        sx={{
          border: '1px dashed',
          borderColor: 'rgba(16, 24, 40, 0.14)',
          borderRadius: '12px',
          p: '11px 13px',
          bgcolor: 'rgba(16, 24, 40, 0.015)',
          fontSize: 12.5,
          lineHeight: 1.55,
          color: 'text.secondary',
        }}
      >
        <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
          Terms cannot be edited later.
        </Box>{' '}
        To change them, create a policy with the new terms and transfer its
        members.
      </Box>
    </Stack>
  )
}

// The prototype's `.btn.ghost.sm` / `.btn.danger.sm`. The app theme makes every
// Button a contained blue one 42px tall, which is right for a card's single
// call to action and wrong for a strip of five row actions: rendered that way
// the strip shouts louder than the policy it belongs to, and Delete stops being
// the one button that looks dangerous. So the strip keeps its own metric:
// neutral until hover, teal on hover, red reserved for the destructive one.
export function PolicyActionButton({
  tone = 'ghost',
  ...props
}: ButtonProps & { tone?: 'ghost' | 'danger' }) {
  return (
    <Button
      {...props}
      variant="outlined"
      color={tone === 'danger' ? 'error' : 'inherit'}
      sx={{
        minHeight: 32,
        py: '7px',
        px: '12px',
        fontSize: 12.5,
        ...(tone === 'danger'
          ? {
              color: '#b42318',
              borderColor: 'rgba(180, 35, 24, 0.28)',
              '&:hover': {
                borderColor: 'rgba(180, 35, 24, 0.4)',
                bgcolor: 'rgba(180, 35, 24, 0.08)',
              },
            }
          : {
              color: 'text.secondary',
              borderColor: 'rgba(16, 24, 40, 0.14)',
              '&:hover': {
                color: 'secondary.main',
                borderColor: 'secondary.main',
                bgcolor: 'rgba(15, 118, 110, 0.1)',
              },
            }),
        ...props.sx,
      }}
    />
  )
}

// Prototype .terms/.term/.u: the collapsed policy row states its deal as a row
// of small tabular chips, so two policies can be compared down the column at a
// glance. A comma-joined sentence made the reader parse prose instead.
export function PolicyTermChips({ policy }: { policy: LeavePolicyDto }) {
  return (
    <Box sx={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
      {policyTermChips(policy).map((chip) => (
        <Box
          key={`${chip.value} ${chip.unit}`}
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            px: '9px',
            py: '4px',
            borderRadius: '8px',
            bgcolor: 'rgba(16, 24, 40, 0.04)',
            fontSize: 12,
            fontWeight: 700,
            color: 'text.secondary',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {chip.value}
          <Box component="span" sx={{ color: '#98a2b3', fontWeight: 600 }}>
            {chip.unit}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/**
 * The head of a checkbox column: ticked when every row on screen is selected,
 * a dash when only some are. Deliberately acts on the rows CURRENTLY SHOWN, so
 * a search narrows its reach instead of silently sweeping in people hidden
 * behind the filter -- these lists move employees between leave policies, and
 * that changes what they are paid.
 *
 * Shared by the member list and the add dialog so the two cannot drift into
 * behaving differently.
 */
export function SelectAllCheckbox({
  shownIds,
  selected,
  onChange,
}: {
  shownIds: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const on = shownIds.filter((id) => selected.includes(id)).length
  const all = shownIds.length > 0 && on === shownIds.length
  return (
    <Checkbox
      size="small"
      color="secondary"
      sx={{ p: 0.5 }}
      disabled={shownIds.length === 0}
      checked={all}
      indeterminate={on > 0 && !all}
      onChange={() => {
        onChange(
          all
            ? selected.filter((id) => !shownIds.includes(id))
            : [...new Set([...selected, ...shownIds])],
        )
      }}
      inputProps={{
        'aria-label': all ? 'Clear the shown rows' : 'Select the shown rows',
      }}
    />
  )
}

/** The shield the prototype puts on the policies card. */
export function ShieldGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={{ display: 'block' }}
    >
      <path
        d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-3Z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  )
}

const validityTone: Record<PolicyValidity['tone'], object> = {
  active: {
    color: 'secondary.main',
    borderColor: 'rgba(15, 118, 110, 0.35)',
    bgcolor: 'rgba(15, 118, 110, 0.1)',
  },
  pending: {
    color: '#b54708',
    borderColor: 'rgba(181, 71, 8, 0.3)',
    bgcolor: 'rgba(181, 71, 8, 0.08)',
  },
  retiring: {
    color: '#b54708',
    borderColor: 'rgba(181, 71, 8, 0.3)',
    bgcolor: 'rgba(181, 71, 8, 0.08)',
  },
  retired: {
    color: 'text.secondary',
    borderColor: 'divider',
    bgcolor: 'rgba(16, 24, 40, 0.04)',
  },
}

function Pill({ tone, children }: { tone: object; children: React.ReactNode }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 10.5,
        fontWeight: 700,
        px: '8px',
        py: '2px',
        borderRadius: '999px',
        border: '1px solid',
        whiteSpace: 'nowrap',
        ...tone,
      }}
    >
      {children}
    </Typography>
  )
}

export function PolicyValidityChip({ validity }: { validity: PolicyValidity }) {
  return <Pill tone={validityTone[validity.tone]}>{validity.label}</Pill>
}

/** Probation / pending-transfer flags on a member row. */
export function MemberFlagChip({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'warning'
}) {
  return (
    <Pill
      tone={
        tone === 'warning'
          ? {
              color: '#b54708',
              borderColor: 'rgba(181, 71, 8, 0.3)',
              bgcolor: 'rgba(181, 71, 8, 0.08)',
            }
          : {
              color: 'text.secondary',
              borderColor: 'divider',
              borderStyle: 'dashed',
            }
      }
    >
      {label}
    </Pill>
  )
}

export function DefaultPolicyChip() {
  return (
    <Pill
      tone={{
        color: 'secondary.main',
        borderColor: 'rgba(15, 118, 110, 0.35)',
        bgcolor: 'rgba(15, 118, 110, 0.1)',
      }}
    >
      Default
    </Pill>
  )
}
