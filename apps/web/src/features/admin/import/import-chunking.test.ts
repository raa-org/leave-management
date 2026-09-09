/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { LeaveType } from '@workspace/contracts'
import type {
  EmployeeImportRowDto,
  ImportValidationReportDto,
  LeaveHistoryImportRowDto,
  PolicyToCreateDto,
  PolicyToReuseDto,
} from '@workspace/contracts'
import {
  buildValidationBatches,
  buildWorkItems,
  chosenPolicyNameByEmail,
  mergeValidationReports,
  toValidationPayload,
} from './import-chunking'

// Server fingerprints, verbatim: two offers with the same 25+5 base, one flat
// and one rising every three years. The client treats them as opaque ids.
const FLAT_25 = 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0'
const STEPPED_25 = 'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0;vy=3'

const employee = (email: string): EmployeeImportRowDto => ({
  email,
  employmentStartDate: '2020-03-02',
  countryCode: 'UA',
  vacationDaysPerYear: 25,
  sickDaysPerYear: 5,
})

const leave = (email: string, startDate: string): LeaveHistoryImportRowDto => ({
  email,
  leaveType: LeaveType.Vacation,
  startDate,
  endDate: startDate,
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

// The default group is the ordinary one: terms nothing in the catalog holds,
// named by the server, still the operator's to rename.
const toCreate = (
  overrides: Partial<PolicyToCreateDto> = {},
): PolicyToCreateDto => ({
  termsFingerprint: FLAT_25,
  vacationDaysPerYear: 25,
  sickDaysPerYear: 5,
  plannedName: 'Imported 25+5',
  nameSource: 'suggested',
  renameable: true,
  memberEmails: [],
  ...overrides,
})

const toReuse = (
  overrides: Partial<PolicyToReuseDto> = {},
): PolicyToReuseDto => ({
  policyId: 'p-standard',
  policyName: 'Standard UA',
  vacationDaysPerYear: 25,
  sickDaysPerYear: 5,
  matchedBy: 'terms',
  retired: false,
  termsDiffer: false,
  memberEmails: [],
  ...overrides,
})

describe('buildWorkItems', () => {
  it('gives every employee their own item with their leave attached', () => {
    const items = buildWorkItems({
      employees: [employee('anna@example.com'), employee('boris@example.com')],
      history: [
        leave('anna@example.com', '2026-03-02'),
        leave('anna@example.com', '2026-05-04'),
      ],
    })

    expect(items).toHaveLength(2)
    expect(items[0]?.email).toBe('anna@example.com')
    expect(items[0]?.history).toHaveLength(2)
    expect(items[1]?.history).toEqual([])
  })

  it('matches addresses case-insensitively, as the directory does', () => {
    const items = buildWorkItems({
      employees: [employee('Anna@Example.com')],
      history: [leave('anna@example.com', '2026-03-02')],
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.history).toHaveLength(1)
  })

  it('keeps history for people the user-data file does not mention', () => {
    const items = buildWorkItems({
      history: [leave('vera@example.com', '2026-03-02')],
    })

    expect(items).toEqual([
      {
        email: 'vera@example.com',
        history: [leave('vera@example.com', '2026-03-02')],
      },
    ])
  })
})

describe('buildValidationBatches', () => {
  it('never splits an employee across two requests', () => {
    const items = buildWorkItems({
      employees: Array.from({ length: 5 }, (_, index) =>
        employee(`user${index}@example.com`),
      ),
      history: [leave('user0@example.com', '2026-03-02')],
    })

    const batches = buildValidationBatches(items, 2)

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1])
    const payload = toValidationPayload(batches[0]!)
    expect(payload.employees).toHaveLength(2)
    expect(payload.history).toHaveLength(1)
  })
})

describe('mergeValidationReports', () => {
  it('folds the batch reports into one, deduping addresses', () => {
    const merged = mergeValidationReports([
      report({
        employees: ['anna@example.com'],
        unknownEmails: ['ghost@example.com'],
      }),
      report({
        ok: false,
        employees: ['anna@example.com', 'boris@example.com'],
        unknownEmails: ['ghost@example.com'],
        issues: [
          { email: 'boris@example.com', severity: 'error', message: 'bad date' },
        ],
      }),
    ])

    expect(merged.ok).toBe(false)
    expect(merged.employees).toEqual(['anna@example.com', 'boris@example.com'])
    expect(merged.unknownEmails).toEqual(['ghost@example.com'])
    expect(merged.issues).toHaveLength(1)
  })

  it('dedupes word-for-word repeated issues and drops the no-account restatements', () => {
    const noAccount = {
      email: 'ghost@example.com',
      severity: 'warning' as const,
      message:
        'No account with this address. Run a directory sync and validate again; if it is still missing, the row is ignored.',
    }
    const sameWarning = {
      email: 'anna@example.com',
      severity: 'warning' as const,
      message: 'hired mid-month; the first month is prorated',
    }
    const merged = mergeValidationReports([
      report({
        unknownEmails: ['ghost@example.com'],
        // The server writes one issue per ROW: five problem rows for one
        // email arrive as five identical lines.
        issues: [noAccount, noAccount, sameWarning, sameWarning],
      }),
      report({ issues: [sameWarning] }),
    ])

    // The banner already names the unknown address; only the substantive
    // warning survives, once.
    expect(merged.issues).toEqual([sameWarning])
  })

  it('counts one policy per terms tuple, however many batches named it', () => {
    const merged = mergeValidationReports([
      report({
        policiesToCreate: [toCreate({ memberEmails: ['anna@example.com'] })],
      }),
      report({
        policiesToCreate: [
          toCreate({ memberEmails: ['boris@example.com'] }),
          toCreate({
            termsFingerprint: 'v=15.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
            vacationDaysPerYear: 15,
            plannedName: 'Imported 15+5',
            memberEmails: ['vera@example.com'],
          }),
        ],
      }),
    ])

    expect(merged.policiesToCreate).toHaveLength(2)
    expect(merged.policiesToCreate[0]?.memberEmails).toEqual([
      'anna@example.com',
      'boris@example.com',
    ])
  })

  it('keeps two offers that share a base apart, because the fingerprint does', () => {
    // The defect the fingerprint key exists to close: keyed by "25+5" these
    // two merged into one row, so the operator saw one policy, named it once,
    // and half the people were enrolled under terms they never agreed to.
    const merged = mergeValidationReports([
      report({
        policiesToCreate: [
          toCreate({ memberEmails: ['anna@example.com'] }),
          toCreate({
            termsFingerprint: STEPPED_25,
            plannedName: 'Imported 25+5, +5/3yr',
            memberEmails: ['boris@example.com'],
          }),
        ],
      }),
    ])

    expect(merged.policiesToCreate).toHaveLength(2)
    expect(merged.policiesToCreate.map((policy) => policy.memberEmails)).toEqual([
      ['anna@example.com'],
      ['boris@example.com'],
    ])
  })

  it('folds two batches planning one name into the single policy they will mint', () => {
    // Batches are validated independently and no batch sees what another is
    // about to mint, so two rows naming one absent policy arrive as two groups.
    // The apply mints it once, whatever terms the second row states, so showing
    // two rows here would promise a catalog the run does not produce.
    const merged = mergeValidationReports([
      report({
        policiesToCreate: [
          toCreate({
            plannedName: 'Contractors',
            nameSource: 'file',
            renameable: false,
            memberEmails: ['anna@example.com'],
          }),
        ],
      }),
      report({
        policiesToCreate: [
          toCreate({
            termsFingerprint: STEPPED_25,
            plannedName: '  contractors ',
            nameSource: 'file',
            renameable: false,
            memberEmails: ['boris@example.com'],
          }),
        ],
      }),
    ])

    expect(merged.policiesToCreate).toHaveLength(1)
    // The first group's fingerprint stays the key: it is what the wizard uses
    // for the React key and for the operator's chosen names.
    expect(merged.policiesToCreate[0]).toMatchObject({
      termsFingerprint: FLAT_25,
      memberEmails: ['anna@example.com', 'boris@example.com'],
    })
  })

  it('lets the file name win and takes the rename away with it', () => {
    // One batch saw only unnamed rows and planned a derived name; another saw
    // the row that states one. The file decides, so the merged group carries
    // its name and offers no box: a name typed here would be thrown away.
    const merged = mergeValidationReports([
      report({
        policiesToCreate: [toCreate({ memberEmails: ['anna@example.com'] })],
      }),
      report({
        policiesToCreate: [
          toCreate({
            plannedName: 'Contractors',
            nameSource: 'file',
            renameable: false,
            memberEmails: ['boris@example.com'],
          }),
        ],
      }),
    ])

    expect(merged.policiesToCreate).toHaveLength(1)
    expect(merged.policiesToCreate[0]).toMatchObject({
      plannedName: 'Contractors',
      nameSource: 'file',
      renameable: false,
    })
  })

  it('folds one policy taken by two batches, keeping the worse news', () => {
    const merged = mergeValidationReports([
      report({
        policiesToReuse: [toReuse({ memberEmails: ['anna@example.com'] })],
      }),
      report({
        policiesToReuse: [
          toReuse({
            matchedBy: 'name',
            retired: true,
            termsDiffer: true,
            memberEmails: ['boris@example.com'],
          }),
        ],
      }),
    ])

    expect(merged.policiesToReuse).toHaveLength(1)
    expect(merged.policiesToReuse[0]).toMatchObject({
      // Asked for by name in any batch is asked for by name; a retired policy
      // and a disagreement about terms are facts the operator must act on
      // however few batches saw them.
      matchedBy: 'name',
      retired: true,
      termsDiffer: true,
      memberEmails: ['anna@example.com', 'boris@example.com'],
    })
  })
})

describe('chosenPolicyNameByEmail', () => {
  const stepped = toCreate({
    termsFingerprint: STEPPED_25,
    plannedName: 'Imported 25+5, +5/3yr',
    memberEmails: ['Boris@Example.com'],
  })
  const flat = toCreate({ memberEmails: ['anna@example.com'] })

  it('gives every member of a renamed group the operator name, and nobody else', () => {
    const chosen = chosenPolicyNameByEmail(
      report({ policiesToCreate: [flat, stepped] }),
      { [STEPPED_25]: 'Senior UA' },
    )

    // The rename was typed for the stepped policy only: the flat group keeps
    // its suggestion (absent here), which is what the request omits.
    expect(chosen).toEqual({ 'boris@example.com': 'Senior UA' })
  })

  it('ignores a blank name and a report it has not seen', () => {
    expect(
      chosenPolicyNameByEmail(report({ policiesToCreate: [flat] }), {
        [FLAT_25]: '   ',
      }),
    ).toEqual({})
    expect(chosenPolicyNameByEmail(undefined, { [FLAT_25]: 'Standard' })).toEqual(
      {},
    )
  })

  it('stays silent for a group the server will not let be renamed', () => {
    // The wizard draws no box for one, but a typed name outlives a
    // re-validation: a group that WAS renameable and is no longer (a policy
    // created meanwhile, a row added that names it) would otherwise keep
    // sending a name the server has to throw away.
    expect(
      chosenPolicyNameByEmail(
        report({
          policiesToCreate: [
            toCreate({
              plannedName: 'Contractors',
              nameSource: 'file',
              renameable: false,
              memberEmails: ['anna@example.com'],
            }),
          ],
        }),
        { [FLAT_25]: 'Senior UA' },
      ),
    ).toEqual({})
  })
})
