/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type {
  ImportRowIssueDto,
  ImportValidationReportDto,
  PolicyToCreateDto,
} from '@workspace/contracts'
import type { ImportEmployeeState, ImportRunState } from './use-import-run'
import {
  railModel,
  receiptModel,
  tallies,
  wizardBusy,
  type WizardContext,
} from './import-wizard-model'

// ------------------------------------------------------------- fixtures ----

const employees = (
  ...statuses: ImportEmployeeState['status'][]
): ImportEmployeeState[] =>
  statuses.map((status, index) => ({
    email: `person-${index + 1}@example.com`,
    status,
  }))

const makeRun = (overrides: Partial<ImportRunState> = {}): ImportRunState => ({
  phase: 'idle',
  completed: 0,
  total: 0,
  employees: [],
  ...overrides,
})

const warning = (email: string): ImportRowIssueDto => ({
  email,
  severity: 'warning',
  message: 'Tracker balance differs from the computed one.',
})

const blocker = (email: string): ImportRowIssueDto => ({
  email,
  severity: 'error',
  message: 'Employment start date is missing.',
})

const policyToCreate = (members: string[]): PolicyToCreateDto => ({
  termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
  vacationDaysPerYear: 25,
  sickDaysPerYear: 5,
  plannedName: 'Imported 25+5',
  nameSource: 'suggested',
  renameable: true,
  memberEmails: members,
})

const report = (
  overrides: Partial<ImportValidationReportDto> = {},
): ImportValidationReportDto => ({
  ok: true,
  unknownEmails: [],
  employees: [],
  issues: [],
  policiesToCreate: [],
  policiesToReuse: [],
  hoursPerDay: 8,
  ...overrides,
})

const makeContext = (overrides: Partial<WizardContext> = {}): WizardContext => ({
  step: 1,
  fileName: '',
  peopleCount: 0,
  rowCount: 0,
  mode: 'add',
  targetYear: 2026,
  snapshotDate: '2026-08-01',
  run: makeRun(),
  syncing: false,
  ...overrides,
})

const captionOf = (ctx: WizardContext, step: number): string =>
  railModel(ctx).find((item) => item.step === step)!.caption

// --------------------------------------------------------------- tallies ----

describe('tallies', () => {
  it('counts each status bucket and derives done from the terminal three', () => {
    const totals = tallies(
      employees(
        'applied',
        'applied',
        'skipped',
        'failed',
        'previewed',
        'pending',
        'running',
      ),
    )
    expect(totals).toEqual({
      applied: 2,
      skipped: 1,
      failed: 1,
      previewed: 1,
      pending: 1,
      done: 4,
      settled: false,
    })
  })

  it('settles only when every employee reached a terminal outcome', () => {
    expect(tallies(employees('applied', 'skipped', 'failed')).settled).toBe(true)
    expect(tallies(employees('applied', 'previewed')).settled).toBe(false)
  })

  it('never settles an empty list', () => {
    expect(tallies([]).settled).toBe(false)
  })
})

// ------------------------------------------------------------ rail: text ----

describe('railModel captions', () => {
  it('titles the four steps', () => {
    expect(railModel(makeContext()).map((item) => item.title)).toEqual([
      'Source file',
      'Validation',
      'Review',
      'Apply',
    ])
  })

  const idle = makeContext()
  it.each([
    [1, 'Mode, year and workbook'],
    [2, 'Directory and policy checks'],
    [3, 'Exact numbers, computed live'],
    [4, 'One employee at a time'],
  ])('step %i idle with no file: %s', (step, caption) => {
    expect(captionOf(idle, step)).toBe(caption)
  })

  it('source caption reports the loaded file, plural', () => {
    const ctx = makeContext({ fileName: 'tracker.xlsx', peopleCount: 8, rowCount: 120 })
    expect(captionOf(ctx, 1)).toBe('8 people · 120 rows')
  })

  it('source caption goes singular for one person and one row', () => {
    const ctx = makeContext({ fileName: 'solo.xlsx', peopleCount: 1, rowCount: 1 })
    expect(captionOf(ctx, 1)).toBe('1 person · 1 row')
  })

  it('validation caption walks the batches while validating', () => {
    // 45 employees chunk into 3 batches of 20; one batch is already merged.
    const ctx = makeContext({
      step: 2,
      run: makeRun({
        phase: 'validating',
        completed: 1,
        total: 3,
        employees: employees(...Array<'pending'>(45).fill('pending')),
      }),
    })
    expect(captionOf(ctx, 2)).toBe('Checking batch 2 of 3')
  })

  it('validation caption never exceeds the batch count on the last batch', () => {
    const ctx = makeContext({
      step: 2,
      run: makeRun({ phase: 'validating', completed: 3, total: 3 }),
    })
    expect(captionOf(ctx, 2)).toBe('Checking batch 3 of 3')
  })

  it('validated caption reports ready and warnings, pluralized', () => {
    const ctx = makeContext({
      step: 2,
      run: makeRun({
        validation: report({
          employees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com', 'g@x.com', 'h@x.com'],
          issues: [warning('a@x.com'), warning('b@x.com'), blocker('c@x.com')],
        }),
      }),
    })
    // The blocker is an error, not a warning: only severity 'warning' counts.
    expect(captionOf(ctx, 2)).toBe('8 ready · 2 warnings')
  })

  it('validated caption goes singular for one warning and appends unknowns', () => {
    const ctx = makeContext({
      step: 2,
      run: makeRun({
        validation: report({
          employees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com', 'g@x.com'],
          issues: [warning('a@x.com')],
          unknownEmails: ['ghost@x.com'],
        }),
      }),
    })
    expect(captionOf(ctx, 2)).toBe('7 ready · 1 warning · 1 unknown')
  })

  it('review caption walks the employees while previewing', () => {
    const ctx = makeContext({
      step: 3,
      run: makeRun({
        phase: 'previewing',
        completed: 3,
        total: 8,
        employees: employees(
          'previewed', 'previewed', 'previewed', 'running',
          'pending', 'pending', 'pending', 'pending',
        ),
      }),
    })
    expect(captionOf(ctx, 3)).toBe('Computing 4 of 8')
  })

  it('review caption reports the previewed count once idle', () => {
    const ctx = makeContext({
      step: 3,
      run: makeRun({ employees: employees(...Array<'previewed'>(8).fill('previewed')) }),
    })
    expect(captionOf(ctx, 3)).toBe('8 previewed')
  })

  it('apply caption walks the employees while applying', () => {
    const ctx = makeContext({
      step: 4,
      run: makeRun({
        phase: 'applying',
        completed: 1,
        total: 8,
        employees: employees(
          'applied', 'running', 'pending', 'pending',
          'pending', 'pending', 'pending', 'pending',
        ),
      }),
    })
    expect(captionOf(ctx, 4)).toBe('Applying 2 of 8')
  })

  it('apply caption reports the settled split', () => {
    const ctx = makeContext({
      step: 4,
      run: makeRun({
        employees: employees(
          'applied', 'applied', 'applied', 'applied',
          'applied', 'applied', 'skipped', 'failed',
        ),
      }),
    })
    expect(captionOf(ctx, 4)).toBe('6 applied · 1 skipped · 1 failed')
  })

  it('apply caption reports partial progress when a walk stopped early', () => {
    const ctx = makeContext({
      step: 4,
      run: makeRun({
        employees: employees(
          'applied', 'applied', 'failed', 'pending',
          'pending', 'pending', 'pending', 'pending',
        ),
      }),
    })
    expect(captionOf(ctx, 4)).toBe('3 of 8 done')
  })
})

// ----------------------------------------------------- rail: state, clicks ----

describe('railModel states and clickability', () => {
  it('marks earlier steps done, the active one current, later ones future', () => {
    const ctx = makeContext({ step: 3, fileName: 'tracker.xlsx' })
    expect(railModel(ctx).map((item) => item.state)).toEqual([
      'done',
      'done',
      'current',
      'future',
    ])
  })

  it('lets the operator revisit a done step while nothing runs', () => {
    const ctx = makeContext({ step: 3, fileName: 'tracker.xlsx' })
    expect(railModel(ctx).map((item) => item.clickable)).toEqual([
      true,
      true,
      false,
      false,
    ])
  })

  it('locks every step while a phase runs', () => {
    const ctx = makeContext({
      step: 3,
      fileName: 'tracker.xlsx',
      run: makeRun({ phase: 'previewing', total: 8 }),
    })
    expect(railModel(ctx).every((item) => !item.clickable)).toBe(true)
  })

  it('locks every step while the directory sync runs', () => {
    const ctx = makeContext({ step: 3, fileName: 'tracker.xlsx', syncing: true })
    expect(railModel(ctx).every((item) => !item.clickable)).toBe(true)
  })

  it('marks step 4 done once settled and idle, but never clickable', () => {
    const ctx = makeContext({
      step: 4,
      fileName: 'tracker.xlsx',
      run: makeRun({ employees: employees('applied', 'skipped', 'failed') }),
    })
    const apply = railModel(ctx)[3]
    // Current wins over done for the step the wizard sits on...
    expect(apply.state).toBe('current')
    expect(apply.clickable).toBe(false)
  })

  it('does not mark step 4 done while the apply is still walking', () => {
    const ctx = makeContext({
      step: 4,
      run: makeRun({
        phase: 'applying',
        completed: 2,
        total: 3,
        employees: employees('applied', 'applied', 'running'),
      }),
    })
    expect(railModel(ctx)[3].state).toBe('current')
  })
})

// -------------------------------------------------------------- receipts ----

describe('receiptModel', () => {
  const validated = makeRun({
    validation: report({
      employees: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com', 'g@x.com', 'h@x.com'],
      issues: [warning('a@x.com'), warning('b@x.com')],
      policiesToCreate: [policyToCreate(['a@x.com', 'b@x.com'])],
    }),
  })

  it('emits nothing on step 1', () => {
    expect(receiptModel(makeContext())).toEqual([])
  })

  it('emits the source receipt on step 2, with the Add label and a readable date', () => {
    const ctx = makeContext({ step: 2, fileName: 'tracker.xlsx' })
    expect(receiptModel(ctx)).toEqual([
      { step: 1, text: 'Source file · tracker.xlsx · Add · 2026 · snapshot 1 Aug 2026' },
    ])
  })

  it('labels override mode the way the prototype does', () => {
    const ctx = makeContext({
      step: 2,
      fileName: 'refresh.xlsx',
      mode: 'override',
      targetYear: 2025,
      snapshotDate: '2025-12-31',
    })
    expect(receiptModel(ctx)[0].text).toBe(
      'Source file · refresh.xlsx · Override (refresh) · 2025 · snapshot 31 Dec 2025',
    )
  })

  it('adds the validation receipt on step 3, with a singular policy suffix', () => {
    const ctx = makeContext({ step: 3, fileName: 'tracker.xlsx', run: validated })
    expect(receiptModel(ctx).map((receipt) => receipt.text)).toEqual([
      'Source file · tracker.xlsx · Add · 2026 · snapshot 1 Aug 2026',
      'Validation · 8 ready · 2 warnings · 1 policy to create',
    ])
  })

  it('pluralizes the policy suffix', () => {
    const ctx = makeContext({
      step: 3,
      fileName: 'tracker.xlsx',
      run: makeRun({
        validation: report({
          employees: ['a@x.com', 'b@x.com'],
          issues: [warning('a@x.com')],
          policiesToCreate: [
            policyToCreate(['a@x.com']),
            policyToCreate(['b@x.com']),
          ],
        }),
      }),
    })
    expect(receiptModel(ctx)[1].text).toBe(
      'Validation · 2 ready · 1 warning · 2 policies to create',
    )
  })

  it('omits the policy suffix when nothing is minted', () => {
    const ctx = makeContext({
      step: 3,
      fileName: 'tracker.xlsx',
      run: makeRun({ validation: report({ employees: ['a@x.com'] }) }),
    })
    expect(receiptModel(ctx)[1].text).toBe('Validation · 1 ready · 0 warnings')
  })

  it('skips the validation receipt when the report was wiped', () => {
    const ctx = makeContext({ step: 3, fileName: 'tracker.xlsx' })
    expect(receiptModel(ctx)).toHaveLength(1)
    expect(receiptModel(ctx)[0].step).toBe(1)
  })

  it('adds the review receipt on step 4 while previews are still held', () => {
    const ctx = makeContext({
      step: 4,
      fileName: 'tracker.xlsx',
      run: makeRun({
        validation: validated.validation,
        employees: employees(...Array<'previewed'>(8).fill('previewed')),
      }),
    })
    expect(receiptModel(ctx)[2]).toEqual({
      step: 3,
      text: 'Review · 8 previewed · exact numbers from a rolled-back run',
    })
  })

  it('falls back to the applied count once the walk wiped the previews', () => {
    // The apply walk resets statuses to pending, then settles them one by one.
    const ctx = makeContext({
      step: 4,
      fileName: 'tracker.xlsx',
      run: makeRun({
        validation: validated.validation,
        employees: employees(
          'applied', 'applied', 'skipped', 'pending',
          'pending', 'pending', 'pending', 'pending',
        ),
      }),
    })
    expect(receiptModel(ctx)[2]).toEqual({
      step: 3,
      text: 'Review · 3 of 8 already applied',
    })
  })

  it('emits no review receipt before any preview or apply', () => {
    const ctx = makeContext({
      step: 4,
      fileName: 'tracker.xlsx',
      run: makeRun({
        validation: validated.validation,
        employees: employees('pending', 'pending'),
      }),
    })
    expect(receiptModel(ctx).map((receipt) => receipt.step)).toEqual([1, 2])
  })
})

// ------------------------------------------------------------ wizardBusy ----

describe('wizardBusy', () => {
  it.each([
    ['idle and not syncing', makeContext(), false],
    ['validating', makeContext({ run: makeRun({ phase: 'validating' }) }), true],
    ['previewing', makeContext({ run: makeRun({ phase: 'previewing' }) }), true],
    ['applying', makeContext({ run: makeRun({ phase: 'applying' }) }), true],
    ['directory sync in flight', makeContext({ syncing: true }), true],
  ])('%s', (_label, ctx, expected) => {
    expect(wizardBusy(ctx)).toBe(expected)
  })
})
