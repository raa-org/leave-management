/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { ThemeProvider } from '@mui/material/styles'
import { LeaveType } from '@workspace/contracts'
import type {
  ImportEmployeePlanDto,
  ImportValidationReportDto,
} from '@workspace/contracts'
import theme from '../../../theme'
import type { AdminApiClient } from '../admin-api'
import { ExportCard } from './ExportCard'
import { ImportEmployeeCard } from './ImportEmployeeCard'
import { ImportExportViews } from './ImportExportViews'
import { ImportPoliciesBlock } from './ImportPoliciesBlock'
import { ImportStepRail } from './ImportStepRail'
import { ImportWizard } from './ImportWizard'

// Node env, no jsdom: these render the markup and read it, which is enough to
// prove the wizard mounts and that a card states the numbers it was given.

const render = (ui: ReactElement, location = '/admin/import'): string =>
  renderToStaticMarkup(
    <StaticRouter location={location}>
      <ThemeProvider theme={theme}>{ui}</ThemeProvider>
    </StaticRouter>,
  )

const stubApi = {} as AdminApiClient

const plan: ImportEmployeePlanDto = {
  email: 'anna@example.com',
  displayName: 'Anna Ivanova',
  employmentStartDate: '2020-03-02',
  policy: {
    policyName: 'Imported 25+5',
    vacationDaysPerYear: 25,
    sickDaysPerYear: 5,
    willBeCreated: true,
  },
  carriedOverVacationDays: 7,
  requests: [
    {
      leaveType: LeaveType.Vacation,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
      workingDays: 5,
      unpaidDays: 0,
      status: 'imported',
    },
    {
      leaveType: LeaveType.Sick,
      startDate: '2026-04-01',
      endDate: '2026-04-02',
      workingDays: 0,
      unpaidDays: 0,
      status: 'skipped',
      reason: 'Leave is already on record for 2026-04-01..2026-04-02.',
    },
  ],
  reconciliation: [
    {
      leaveType: LeaveType.Vacation,
      computedBalance: 18.67,
      committedDays: 0,
      expectedBalance: 18,
      delta: 0.67,
      asOf: '2026-08-01',
    },
  ],
  issues: [
    {
      email: 'anna@example.com',
      severity: 'warning',
      message: 'The file counts 4 working day(s), the calendar counts 5.',
    },
  ],
}

describe('ImportWizard', () => {
  it('opens on the source step with the whole rail in view', () => {
    const markup = render(<ImportWizard api={stubApi} />)

    // The rail names all four steps up front with their idle captions.
    expect(markup).toContain('Source file')
    expect(markup).toContain('Validation')
    expect(markup).toContain('Review')
    expect(markup).toContain('Apply')
    expect(markup).toContain('Mode, year and workbook')
    expect(markup).toContain('One employee at a time')

    // Step 1's card: mode tiles, the dropzone and the gated primary.
    expect(markup).toContain('Choose workbook')
    expect(markup).toContain('never creates accounts')
    expect(markup).toContain('Continue to validation')
    expect(markup).toContain('Nothing is written until the apply step')
  })
})

describe('ImportExportViews', () => {
  // Both children stay mounted (a run must survive a glance at Export), so
  // content strings render in BOTH states and prove nothing about which view
  // is active. The seam under test is the data-active-view switch itself.
  it('marks the import view active and keeps the export card mounted', () => {
    const markup = render(<ImportExportViews api={stubApi} active="import" />)

    expect(markup).toContain('data-active-view="import"')
    expect(markup).toContain('Choose workbook')
    expect(markup).toContain('Download workbook')
  })

  it('marks the export view active', () => {
    const markup = render(<ImportExportViews api={stubApi} active="export" />)

    expect(markup).toContain('data-active-view="export"')
  })
})

describe('ExportCard', () => {
  it('offers the year, the include toggles and the download', () => {
    const markup = render(<ExportCard api={stubApi} />)

    expect(markup).toContain('What to include')
    expect(markup).toContain('Employees and policies')
    expect(markup).toContain('Balances as of today')
    expect(markup).toContain('Leave history')
    expect(markup).toContain('Download workbook')
    expect(markup).toContain('round trip is lossless')
  })
})

describe('ImportStepRail', () => {
  it('renders done steps as checks with their outcome captions', () => {
    const markup = render(
      <ImportStepRail
        steps={[
          {
            step: 1,
            title: 'Source file',
            caption: '8 people · 34 rows',
            state: 'done',
            clickable: true,
          },
          {
            step: 2,
            title: 'Validation',
            caption: 'Checking batch 2 of 4',
            state: 'current',
            clickable: false,
          },
          {
            step: 3,
            title: 'Review',
            caption: 'Exact numbers, computed live',
            state: 'future',
            clickable: false,
          },
          {
            step: 4,
            title: 'Apply',
            caption: 'One employee at a time',
            state: 'future',
            clickable: false,
          },
        ]}
        onSelect={() => undefined}
        showStartOver
        startOverDisabled={false}
        onStartOver={() => undefined}
      />,
    )

    expect(markup).toContain('8 people · 34 rows')
    expect(markup).toContain('Checking batch 2 of 4')
    expect(markup).toContain('aria-current="step"')
    expect(markup).toContain('Start over')
  })
})

describe('ImportEmployeeCard', () => {
  it('states what the run computed, including the skipped row and the delta', () => {
    const markup = render(
      <ImportEmployeeCard
        hoursPerDay={8}
        employee={{
          email: 'anna@example.com',
          status: 'previewed',
          result: { status: 'ok', plan },
        }}
        onApply={() => undefined}
      />,
    )

    expect(markup).toContain('Anna Ivanova')
    expect(markup).toContain('Imported 25+5')
    expect(markup).toContain('policy will be created')
    // Day figures read as days and hours now that leave is bookable by the
    // hour, and a 0.67 gap is five real hours: the row says so and warns,
    // where the whole-day threshold used to dismiss it as rounding.
    expect(markup).toContain('7d carried in')
    expect(markup).toContain('5d of leave')
    expect(markup).toContain('already on record')
    expect(markup).toContain('file says 18d')
    expect(markup).toContain('on 1 Aug 2026')
    expect(markup).toContain('off by +5h')
    expect(markup).toContain('the calendar counts 5')
    expect(markup).toContain('Apply')
  })

  it('calls a reconciliation gap under an hour what it is: rounding', () => {
    const markup = render(
      <ImportEmployeeCard
        hoursPerDay={8}
        employee={{
          email: 'anna@example.com',
          status: 'previewed',
          result: {
            status: 'ok',
            plan: {
              ...plan,
              reconciliation: [
                {
                  leaveType: LeaveType.Vacation,
                  computedBalance: 18.05,
                  committedDays: 0,
                  expectedBalance: 18,
                  delta: 0.05,
                  asOf: '2026-08-01',
                },
              ],
            },
          },
        }}
        onApply={() => undefined}
      />,
    )

    // Nothing finer than an hour can be entered on either side, so this gap is
    // float dust from the pro-rata accrual rather than a disagreement.
    expect(markup).toContain('the same balance once rounded to the hour')
    expect(markup).not.toContain('off by')
  })

  it('shows why an employee was skipped instead of a plan', () => {
    const markup = render(
      <ImportEmployeeCard
        hoursPerDay={8}
        employee={{
          email: 'ghost@example.com',
          status: 'skipped',
          result: {
            status: 'skipped',
            email: 'ghost@example.com',
            reasons: ['No account with this address.'],
          },
        }}
        onApply={() => undefined}
      />,
    )

    expect(markup).toContain('No account with this address.')
    expect(markup).not.toContain('Apply</')
  })
})

describe('ImportPoliciesBlock', () => {
  const report: ImportValidationReportDto = {
    hoursPerDay: 8,
    ok: true,
    unknownEmails: [],
    employees: ['anna@example.com', 'boris@example.com'],
    issues: [],
    policiesToCreate: [
      {
        termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
        vacationDaysPerYear: 25,
        sickDaysPerYear: 5,
        plannedName: 'Imported 25+5',
        nameSource: 'suggested',
        renameable: true,
        memberEmails: ['anna@example.com', 'boris@example.com'],
      },
    ],
    policiesToReuse: [
      {
        policyId: 'policy-1',
        policyName: 'Default',
        vacationDaysPerYear: 15,
        sickDaysPerYear: 5,
        matchedBy: 'terms',
        retired: false,
        termsDiffer: false,
        memberEmails: ['vera@example.com'],
      },
    ],
  }

  it('names the policies to create and the members grouped into them', () => {
    const markup = render(
      <ImportPoliciesBlock
        report={report}
        policyNames={{}}
        onRename={() => undefined}
      />,
    )

    expect(markup).toContain('Policies found in the file')
    expect(markup).toContain('Imported 25+5')
    expect(markup).toContain('will be created')
    expect(markup).toContain('2 employees · terms 25 vacation + 5 sick')
    expect(markup).toContain('exists')
    expect(markup).toContain('Default')
  })

  it('names each set of terms on its own row, keyed by the fingerprint', () => {
    // Two offers with the same 25+5 base: keyed by "vacation+sick" they shared
    // one row and one name box, so renaming one renamed both and the second
    // group was enrolled under terms nobody chose for them.
    const flat = report.policiesToCreate[0]!
    const markup = render(
      <ImportPoliciesBlock
        report={{
          ...report,
          policiesToCreate: [
            flat,
            {
              termsFingerprint: 'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0;vy=3',
              vacationDaysPerYear: 25,
              sickDaysPerYear: 5,
              plannedName: 'Imported 25+5, +5/3yr',
              nameSource: 'suggested',
              renameable: true,
              memberEmails: ['vera@example.com'],
            },
          ],
        }}
        policyNames={{
          'v=25.00;s=5.00;vi=5.00;vc=none;p=0;ps=0;vy=3': 'Senior UA',
        }}
        onRename={() => undefined}
      />,
    )

    // The rename reached the stepped policy only; the flat one still offers
    // its suggestion.
    expect(markup).toContain('Senior UA')
    expect(markup).toContain('Imported 25+5"')
    expect(markup).not.toContain('Imported 25+5, +5/3yr')
    expect(markup).toContain('2 sets of terms in the file have no matching policy')
  })

  it('renders nothing when the file needs no policy work', () => {
    const markup = render(
      <ImportPoliciesBlock
        report={{ ...report, policiesToCreate: [], policiesToReuse: [] }}
        policyNames={{}}
        onRename={() => undefined}
      />,
    )

    expect(markup).toBe('')
  })

  it('offers a rename box only where a rename reaches the server', () => {
    // A name the file states travels on the row itself and outranks anything
    // typed here, so a box for it would collect a value the server discards.
    // The derived name beside it is still the operator's to change.
    const markup = render(
      <ImportPoliciesBlock
        report={{
          ...report,
          policiesToCreate: [
            report.policiesToCreate[0]!,
            {
              termsFingerprint: 'v=20.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
              vacationDaysPerYear: 20,
              sickDaysPerYear: 5,
              plannedName: 'Contractors',
              nameSource: 'file',
              renameable: false,
              memberEmails: ['vera@example.com'],
            },
          ],
        }}
        policyNames={{}}
        onRename={() => undefined}
      />,
    )

    // One input, and it belongs to the group the server said was renameable.
    expect(markup.match(/<input/g) ?? []).toHaveLength(1)
    expect(markup).toContain('value="Imported 25+5"')
    expect(markup).toContain('Contractors')
    expect(markup).not.toContain('value="Contractors"')
    expect(markup).toContain(
      '1 employee · terms 20 vacation + 5 sick · named in the file',
    )
    expect(markup).toContain(
      'A name the file states is not editable here: the file decides it.',
    )
  })

  it('says which rule took an existing policy, and what it means', () => {
    const markup = render(
      <ImportPoliciesBlock
        report={{
          ...report,
          policiesToCreate: [],
          policiesToReuse: [
            {
              policyId: 'policy-2',
              policyName: 'Legacy UA',
              vacationDaysPerYear: 28,
              sickDaysPerYear: 5,
              matchedBy: 'name',
              retired: true,
              termsDiffer: true,
              memberEmails: ['vera@example.com'],
            },
            report.policiesToReuse[0]!,
          ],
        }}
        policyNames={{}}
        onRename={() => undefined}
      />,
    )

    expect(markup).toContain('retired')
    expect(markup).toContain(
      '1 employee · named in the file · terms in the file differ · cannot take members',
    )
    // The one joined on its terms says so too: a live policy already holding
    // them is taken even by a row that states some other name.
    expect(markup).toContain('1 employee · matched on the terms in the file')
    expect(markup).toContain(
      'Where the file states terms an existing policy does not hold, the policy wins',
    )
    expect(markup).toContain('A retired policy cannot take members')
  })
})
