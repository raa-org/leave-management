/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { LeaveType } from '@workspace/contracts'
import type { EmployeePolicyDto, LeavePolicyDto } from '@workspace/contracts'
import { ApiError } from './admin-api'
import {
  emptyPolicyTermsDraft,
  policyCopyDraft,
  policyDraftToPayload,
} from './policy-ui'
import {
  adjustmentPreviewLines,
  apiErrorDetails,
  batchPreflightSummary,
  effectiveDateHint,
  memberSinceLabel,
  moveResultSummary,
  probationMemberLabel,
  scheduledDepartureLabel,
  blockingRequestLines,
  currentPolicyLine,
  policyIncrementHint,
  policyMembershipSummary,
  initialTransferSelection,
  policyTermChips,
  policyTermsSummary,
  policyValidityLabel,
  probationLine,
  scheduledTransferLine,
  shapeMembershipTimeline,
  transferModeCopy,
} from './policy-format'

const policy = (overrides: Partial<LeavePolicyDto> = {}): LeavePolicyDto => ({
  policyId: 'policy-1',
  name: 'Standard',
  vacationDays: 25,
  sickDays: 5,
  vacationAnnualIncrement: 0,
  vacationIncrementEveryYears: 1,
  probationMonths: 0,
  paidSickDuringProbation: false,
  effectiveFrom: '2026-01-01',
  isDefault: false,
  termsFingerprint: 'v=25.00;s=5.00;vi=0.00;vc=none;p=0;ps=0',
  memberCount: 0,
  scheduledInCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('policyTermsSummary', () => {
  it('states the plain allowance', () => {
    expect(policyTermsSummary(policy())).toBe('25+5 days')
  })

  it('adds the annual increment and its cap', () => {
    expect(
      policyTermsSummary(
        policy({ vacationAnnualIncrement: 2, vacationIncrementCapDays: 35 }),
      ),
    ).toBe('25+5 days, +2/yr max 35')
    expect(
      policyTermsSummary(policy({ vacationAnnualIncrement: 2 })),
    ).toBe('25+5 days, +2/yr')
  })

  it('states the cadence when the rise is not yearly', () => {
    // '+5/yr' for a rise that lands once every three years would promise three
    // times the growth.
    expect(
      policyTermsSummary(
        policy({
          vacationDays: 15,
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
          vacationIncrementCapDays: 30,
        }),
      ),
    ).toBe('15+5 days, +5/3yr max 30')
  })

  it('names the probation period and whether sick stays paid inside it', () => {
    expect(policyTermsSummary(policy({ probationMonths: 3 }))).toBe(
      '25+5 days, probation 3 mo',
    )
    expect(
      policyTermsSummary(
        policy({ probationMonths: 3, paidSickDuringProbation: true }),
      ),
    ).toBe('25+5 days, probation 3 mo (sick paid)')
  })

  it('handles the zero-allowance deal', () => {
    expect(policyTermsSummary(policy({ vacationDays: 0, sickDays: 0 }))).toBe(
      '0+0 days',
    )
  })
})

describe('initialTransferSelection', () => {
  it('arrives ticked when the member list already chose', () => {
    // The regression: an empty start made "Move selected" open a dialog whose
    // confirm read "Nothing to move" and could never be pressed, because with
    // one member there was no list on screen to tick either.
    expect(initialTransferSelection('move', ['a', 'b'])).toEqual(['a', 'b'])
    expect(initialTransferSelection('move', ['a'])).toEqual(['a'])
  })

  it('starts empty when the dialog is the one doing the asking', () => {
    // Pre-selecting a whole directory fired a dry run per person on open.
    expect(initialTransferSelection('add', ['a', 'b'])).toEqual([])
  })

  it('copies rather than aliasing the caller array', () => {
    const ids = ['a']
    const picked = initialTransferSelection('move', ids)
    picked.push('b')
    expect(ids).toEqual(['a'])
  })
})

describe('policyTermChips', () => {
  it('states vacation and sick in full words, never an abbreviation', () => {
    // The prototype wrote "vac"; the owner asked for the whole word.
    expect(policyTermChips(policy())).toEqual([
      { value: '25', unit: 'vacation' },
      { value: '5', unit: 'sick' },
    ])
  })

  it('carries the yearly increment and its cap in the unit', () => {
    expect(
      policyTermChips(
        policy({ vacationAnnualIncrement: 2, vacationIncrementCapDays: 30 }),
      ),
      // "max 30" rather than "to 30": the cap ceilings the TOTAL allowance,
      // not the amount added, and "to" reads as either.
    ).toContainEqual({ value: '+2', unit: '/yr, max 30' })
    expect(
      policyTermChips(policy({ vacationAnnualIncrement: 2 })),
    ).toContainEqual({ value: '+2', unit: '/yr' })
  })

  it('puts the cadence in the unit, leaving the amount comparable down the column', () => {
    expect(
      policyTermChips(
        policy({
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
        }),
      ),
    ).toContainEqual({ value: '+5', unit: '/3yr' })
    expect(
      policyTermChips(
        policy({
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
          vacationIncrementCapDays: 30,
        }),
      ),
    ).toContainEqual({ value: '+5', unit: '/3yr, max 30' })
  })

  it('adds probation only when there is one, and flags paid sick', () => {
    expect(policyTermChips(policy())).toHaveLength(2)
    expect(policyTermChips(policy({ probationMonths: 3 }))).toContainEqual({
      value: '3',
      unit: 'mo probation',
    })
    expect(
      policyTermChips(policy({ probationMonths: 3, paidSickDuringProbation: true })),
    ).toContainEqual({ value: '3', unit: 'mo probation, sick paid' })
  })
})

describe('policyIncrementHint', () => {
  it('leaves the every-year wording exactly as it was', () => {
    expect(policyIncrementHint(policy())).toBe('The allowance stays flat.')
    expect(policyIncrementHint(policy({ vacationAnnualIncrement: 2 }))).toBe(
      'Added every year of employment.',
    )
    expect(
      policyIncrementHint(
        policy({ vacationAnnualIncrement: 2, vacationIncrementCapDays: 35 }),
      ),
    ).toBe('Added every year of employment, until the allowance reaches 35 days.')
  })

  it('names the day the step lands on once the period is longer than a year', () => {
    // The fact nothing else on screen carries: the step falls on the calendar
    // boundary, not on the hire anniversary.
    expect(
      policyIncrementHint(
        policy({
          vacationDays: 15,
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
        }),
      ),
    ).toBe('Added every 3 years of employment, on 1 January.')
    expect(
      policyIncrementHint(
        policy({
          vacationDays: 15,
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
          vacationIncrementCapDays: 30,
        }),
      ),
    ).toBe(
      'Added every 3 years of employment, on 1 January, until the allowance reaches 30 days.',
    )
  })

  it('reads a ceiling one rise above the base as the one-off it is', () => {
    // "+5 after 3 years" has no field of its own: base 15, +5, cap 20 can rise
    // once and never again, and saying "every 3 years" would promise growth
    // the engine will not give.
    expect(
      policyIncrementHint(
        policy({
          vacationDays: 15,
          vacationAnnualIncrement: 5,
          vacationIncrementEveryYears: 3,
          vacationIncrementCapDays: 20,
        }),
      ),
    ).toBe('Added once, after 3 years of employment, on 1 January.')
  })
})

describe('policyValidityLabel', () => {
  const today = '2026-07-15'

  it('reports an in-force policy as active', () => {
    expect(policyValidityLabel(policy(), today).tone).toBe('active')
  })

  it('distinguishes not-yet-started, retiring and retired', () => {
    expect(
      policyValidityLabel(policy({ effectiveFrom: '2026-09-01' }), today).tone,
    ).toBe('pending')
    expect(
      policyValidityLabel(policy({ effectiveTo: '2026-12-31' }), today).tone,
    ).toBe('retiring')
    const retired = policyValidityLabel(
      policy({ effectiveTo: '2026-03-31' }),
      today,
    )
    expect(retired.tone).toBe('retired')
    expect(retired.label).toContain('Retired')
  })
})

describe('policyMembershipSummary', () => {
  it('singularizes one member and appends scheduled arrivals', () => {
    expect(policyMembershipSummary(policy({ memberCount: 1 }))).toBe('1 member')
    expect(policyMembershipSummary(policy({ memberCount: 12 }))).toBe(
      '12 members',
    )
    expect(
      policyMembershipSummary(policy({ memberCount: 3, scheduledInCount: 2 })),
    ).toBe('3 members, 2 scheduled')
  })
})

describe('transferModeCopy', () => {
  it('explains the retroactive mode against the APPLIED anchor, not the picked date', () => {
    const copy = transferModeCopy(
      'retroactive',
      'Senior',
      '2026-06-15',
      '2026-01-01',
    )
    expect(copy).toContain('Recalculate')
    expect(copy).toContain('Senior')
    // The engine snapped the anchor to Jan 1; the copy must say so.
    expect(copy).not.toContain('15')
  })

  it('explains the prospective mode against the picked date', () => {
    const copy = transferModeCopy('prospective', 'Senior', '2026-10-01')
    expect(copy).toContain('stays as it was computed')
    expect(copy).toContain('from that date on')
  })
})

describe('adjustmentPreviewLines', () => {
  it('words a grant and a clawback with the resulting annual total', () => {
    const lines = adjustmentPreviewLines([
      {
        year: 2026,
        leaveType: LeaveType.Vacation,
        delta: 1.67,
        newYearTotal: 25,
      },
      { year: 2026, leaveType: LeaveType.Sick, delta: -2.92, newYearTotal: 0 },
    ])
    // Days and hours, floored to the hour grid: 1.67 of an eight-hour day is
    // one day and five hours, with the leftover minutes nobody can book gone.
    expect(lines[0]).toContain('adds 1d 5h')
    expect(lines[0]).toContain('becomes 25d')
    expect(lines[1]).toContain('removes 2d 7h')
  })

  it('returns nothing when the transfer moves no balance', () => {
    expect(adjustmentPreviewLines([])).toEqual([])
  })
})

describe('blockingRequestLines', () => {
  it('names the period and the paid days each blocking request holds', () => {
    const lines = blockingRequestLines([
      {
        requestId: 'request-1',
        leaveType: LeaveType.Vacation,
        startDate: '2026-08-03',
        endDate: '2026-08-07',
        paidDays: 5,
      },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('5d paid')
  })
})

describe('apiErrorDetails', () => {
  it('extracts the duplicate policy so the dialog can offer it', () => {
    const details = apiErrorDetails(
      new ApiError('Identical terms', 409, true, {
        code: 'duplicate_policy_terms',
        existingPolicyId: 'policy-9',
        existingPolicyName: 'Standard',
      }),
    )
    expect(details).toEqual({
      kind: 'duplicatePolicy',
      message: 'Identical terms',
      existingPolicyId: 'policy-9',
      existingPolicyName: 'Standard',
    })
  })

  it('extracts the earliest permissible backdate', () => {
    const details = apiErrorDetails(
      new ApiError('Too far back', 400, true, {
        code: 'backdate_out_of_range',
        earliestPermissibleDate: '2026-01-01',
      }),
    )
    expect(details.kind).toBe('backdateOutOfRange')
    expect(
      details.kind === 'backdateOutOfRange'
        ? details.earliestPermissibleDate
        : null,
    ).toBe('2026-01-01')
  })

  it('recognizes an in-use policy refusal', () => {
    expect(
      apiErrorDetails(
        new ApiError('Referenced', 409, true, { code: 'policy_in_use' }),
      ).kind,
    ).toBe('policyInUse')
  })

  it('falls back to a plain message for anything else', () => {
    expect(apiErrorDetails(new Error('boom'))).toEqual({
      kind: 'plain',
      message: 'boom',
    })
    // A structured code we know but without its payload degrades safely.
    expect(
      apiErrorDetails(
        new ApiError('Identical terms', 409, true, {
          code: 'duplicate_policy_terms',
        }),
      ).kind,
    ).toBe('plain')
    expect(apiErrorDetails('not an error').message).toBe('The request failed.')
  })
})

describe('shapeMembershipTimeline', () => {
  it('orders newest first and keeps superseded rows flagged', () => {
    const rows = shapeMembershipTimeline([
      {
        membershipId: 'm1',
        policyId: 'p1',
        policyName: 'Old',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-07-01',
        superseded: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        membershipId: 'm2',
        policyId: 'p2',
        policyName: 'New',
        effectiveFrom: '2026-07-01',
        superseded: false,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ])
    expect(rows.map((row) => row.policyName)).toEqual(['New', 'Old'])
    expect(rows[0]?.periodLabel.startsWith('From ')).toBe(true)
    expect(rows[1]?.superseded).toBe(true)
    expect(rows[1]?.periodLabel).toContain(' to ')
  })
})

describe('employee policy lines', () => {
  const employeePolicy = (
    overrides: Partial<EmployeePolicyDto> = {},
  ): EmployeePolicyDto => ({
    current: {
      membershipId: 'm1',
      policyId: 'p1',
      policyName: 'Standard',
      effectiveFrom: '2026-01-01',
      superseded: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    history: [],
    ...overrides,
  })

  it('leads with the current policy and its start', () => {
    expect(currentPolicyLine(employeePolicy())).toContain('Standard')
  })

  it('reports a pending transfer only while one exists', () => {
    expect(scheduledTransferLine(employeePolicy())).toBeNull()
    const line = scheduledTransferLine(
      employeePolicy({
        scheduled: {
          membershipId: 'm2',
          policyId: 'p2',
          policyName: 'Senior',
          effectiveFrom: '2026-09-01',
          superseded: false,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      }),
    )
    expect(line).toContain('Senior')
    expect(line).toContain('scheduled')
  })

  it('reports probation only while the window is still running', () => {
    expect(probationLine(employeePolicy())).toBeNull()
    expect(
      probationLine(
        employeePolicy({ probation: { endsOn: '2026-09-01', active: false } }),
      ),
    ).toBeNull()
    expect(
      probationLine(
        employeePolicy({ probation: { endsOn: '2026-09-01', active: true } }),
      ),
    ).toContain('unpaid')
  })
})

describe('member management helpers', () => {
  it('labels a member row from the facts the directory row carries', () => {
    expect(memberSinceLabel('2026-07-15')).toContain('Member since')
    expect(memberSinceLabel(undefined)).toBe('Member')
    expect(
      scheduledDepartureLabel({
        policyName: 'Senior',
        effectiveFrom: '2026-09-01',
      }),
    ).toContain('Leaves for Senior on')
    expect(scheduledDepartureLabel(undefined)).toBeNull()
    expect(probationMemberLabel('2026-09-01')).toContain('On probation to')
    expect(probationMemberLabel(undefined)).toBeNull()
  })

  it('says which tense the chosen effective date puts the move in', () => {
    expect(effectiveDateHint('2026-09-01', '2026-07-31')).toContain(
      'Nothing changes until',
    )
    expect(effectiveDateHint('2026-07-31', '2026-07-31')).toContain(
      'take effect today',
    )
    expect(effectiveDateHint('2026-06-01', '2026-07-31')).toContain(
      'in the past',
    )
  })

  it('folds per-employee dry runs into one honest headline', () => {
    const summary = batchPreflightSummary([
      {
        employeeId: 'u1',
        displayName: 'Alex Morgan',
        feasible: true,
        blockingRequests: [],
        probationWarnings: [],
      },
      {
        employeeId: 'u2',
        displayName: 'Sam Rivera',
        feasible: false,
        blockingRequests: [
          {
            requestId: 'r1',
            leaveType: LeaveType.Vacation,
            startDate: '2026-12-07',
            endDate: '2026-12-18',
            paidDays: 10,
          },
        ],
        probationWarnings: [],
      },
    ])
    expect(summary.movable).toBe(1)
    expect(summary.blocked).toBe(1)
    expect(summary.headline).toBe('1 will move, 1 blocked')
    expect(summary.blockedLines[0]).toContain('Sam Rivera cannot move')
    expect(summary.blockedLines[0]).toContain('10d paid')
    // Named requests exist, so the line may ask for them to be resolved.
    expect(summary.blockedLines[0]).toContain('Resolve those requests')

    // A refusal the SERVER explained is repeated verbatim. Guessing here once
    // told an admin someone had "already used more days than the new terms
    // grant" when the real cause was an unreachable transfer mode.
    const refused = batchPreflightSummary([
      {
        employeeId: 'u4',
        displayName: 'Robin Fox',
        feasible: false,
        blockingRequests: [],
        probationWarnings: [],
        refusal:
          'The prospective mode cannot reach at or before the current membership began (2026-01-01).',
      },
    ])
    expect(refused.blockedLines[0]).toBe(
      'Robin Fox cannot move: the prospective mode cannot reach at or before the current membership began (2026-01-01).',
    )
    expect(refused.blockedLines[0]).not.toContain('already used more days')

    // A capitalised identifier opening the sentence survives the join.
    expect(
      batchPreflightSummary([
        {
          employeeId: 'u5',
          displayName: 'Robin Fox',
          feasible: false,
          blockingRequests: [],
          probationWarnings: [],
          refusal: 'UTC offsets are not supported here.',
        },
      ]).blockedLines[0],
    ).toContain('cannot move: UTC offsets')

    // A refusal with NO blocking requests is a balance shortfall, not a
    // request to resolve. Saying "resolve those requests" there names things
    // that do not exist and asks for an action nobody can take.
    const shortfall = batchPreflightSummary([
      {
        employeeId: 'u3',
        displayName: 'Robin Fox',
        feasible: false,
        blockingRequests: [],
        probationWarnings: [],
      },
    ])
    expect(shortfall.blockedLines[0]).toContain('already used more days')
    expect(shortfall.blockedLines[0]).toContain('Schedule this move for January 1')
    expect(shortfall.blockedLines[0]).not.toContain('Resolve those requests')

    const clean = batchPreflightSummary([
      {
        employeeId: 'u1',
        displayName: 'Alex Morgan',
        feasible: true,
        blockingRequests: [],
        probationWarnings: [],
      },
    ])
    expect(clean.headline).toBe('1 will move')
    expect(clean.blockedLines).toEqual([])
  })

  it('warns about probation without blocking on it', () => {
    const summary = batchPreflightSummary([
      {
        employeeId: 'u1',
        displayName: 'Nico Brand',
        feasible: true,
        blockingRequests: [],
        probationWarnings: [
          {
            requestId: 'r2',
            leaveType: LeaveType.Vacation,
            startDate: '2026-08-03',
            endDate: '2026-08-07',
            paidDays: 5,
          },
        ],
      },
    ])
    expect(summary.movable).toBe(1)
    expect(summary.blocked).toBe(0)
    expect(summary.warningLines[0]).toContain('Nico Brand has 1 paid request')
  })

  it('reports a partial batch as what it is', () => {
    const partial = moveResultSummary(
      [{ displayName: 'Alex' }, { displayName: 'Sam', error: 'Blocked.' }],
      'Senior',
    )
    expect(partial.headline).toBe('1 moved to Senior, 1 refused')
    expect(partial.detail).toContain('keep their current policy')
    expect(partial.failures).toEqual(['Sam: Blocked.'])

    const clean = moveResultSummary([{ displayName: 'Alex' }], 'Senior')
    expect(clean.headline).toBe('1 moved to Senior')
    expect(clean.failures).toEqual([])
  })
})

describe('policyDraftToPayload', () => {
  it('accepts the untouched form, whose defaults are a probation-free policy', () => {
    // The checkbox defaults to on and is disabled while probation is zero, so
    // nobody can clear it by hand: refusing that combination made the default
    // form impossible to submit.
    const result = policyDraftToPayload({
      ...emptyPolicyTermsDraft('2026-08-10'),
      name: 'Standard',
    })

    expect(result).toEqual({
      payload: expect.objectContaining({
        probationMonths: 0,
        paidSickDuringProbation: false,
      }),
    })
  })

  it('keeps the flag once the policy really has a probation window', () => {
    const result = policyDraftToPayload({
      ...emptyPolicyTermsDraft('2026-08-10'),
      name: 'With probation',
      probationMonths: '3',
    })

    expect(result).toEqual({
      payload: expect.objectContaining({
        probationMonths: 3,
        paidSickDuringProbation: true,
      }),
    })
  })

  it('carries the increment period, and settles it at 1 when nothing is added', () => {
    expect(
      policyDraftToPayload({
        ...emptyPolicyTermsDraft('2026-08-10'),
        name: 'Senior UA',
        vacationDays: '15',
        increment: '5',
        incrementEveryYears: '3',
      }),
    ).toEqual({
      payload: expect.objectContaining({
        vacationAnnualIncrement: 5,
        vacationIncrementEveryYears: 3,
      }),
    })

    // The period control is disabled at a zero increment, so a period left
    // over from an earlier edit must not travel: it would fingerprint a twin
    // of the flat policy.
    expect(
      policyDraftToPayload({
        ...emptyPolicyTermsDraft('2026-08-10'),
        name: 'Flat',
        increment: '0',
        incrementEveryYears: '3',
      }),
    ).toEqual({
      payload: expect.objectContaining({ vacationIncrementEveryYears: 1 }),
    })
  })

  it('accepts a flat draft whatever the disabled period box holds', () => {
    // The stepper is dark at a zero increment, so a value left behind by an
    // earlier edit cannot be corrected: refusing it pointed the operator at a
    // control they could not reach, and cancelling the form was the only way
    // out. An increment that quantizes to nothing counts as none, exactly as
    // the writer decides it.
    for (const [increment, incrementEveryYears] of [
      ['0', ''],
      ['0', '0'],
      ['0', '2.5'],
      ['0', '99'],
      ['0.001', '0'],
    ] as const) {
      expect(
        policyDraftToPayload({
          ...emptyPolicyTermsDraft('2026-08-10'),
          name: 'Flat',
          vacationDays: '20',
          increment,
          incrementEveryYears,
        }),
      ).toEqual({
        payload: expect.objectContaining({
          vacationDays: 20,
          vacationIncrementEveryYears: 1,
        }),
      })
    }
  })

  it('refuses a period that is not a whole number of years in range', () => {
    for (const incrementEveryYears of ['0', '2.5', '51', '-1', '']) {
      expect(
        policyDraftToPayload({
          ...emptyPolicyTermsDraft('2026-08-10'),
          name: 'Senior UA',
          increment: '5',
          incrementEveryYears,
        }),
      ).toEqual({
        error: 'Add the extra days every whole number of years, from 1 to 50.',
      })
    }
  })
})

describe('policyCopyDraft', () => {
  it('carries every term of the original, the increment period included', () => {
    // Terms are immutable, so duplicating is the only way to revise a deal: a
    // term dropped here reads as a copy, and silently grants different leave.
    const draft = policyCopyDraft(
      policy({
        name: 'Senior UA',
        vacationDays: 15,
        sickDays: 5,
        vacationAnnualIncrement: 5,
        vacationIncrementEveryYears: 3,
        vacationIncrementCapDays: 30,
        probationMonths: 3,
        paidSickDuringProbation: true,
      }),
      '2026-08-10',
    )

    expect(draft).toMatchObject({
      name: 'Senior UA (copy)',
      vacationDays: '15',
      sickDays: '5',
      increment: '5',
      incrementEveryYears: '3',
      capDays: '30',
      probationMonths: '3',
      paidSickDuringProbation: true,
      // The copy starts when it is made, not when the original did.
      effectiveFrom: '2026-08-10',
    })
    expect(policyDraftToPayload(draft)).toEqual({
      payload: expect.objectContaining({ vacationIncrementEveryYears: 3 }),
    })
  })

  it('leaves an uncapped policy uncapped rather than writing a zero ceiling', () => {
    expect(
      policyCopyDraft(policy({ vacationAnnualIncrement: 2 }), '2026-08-10')
        .capDays,
    ).toBe('')
  })
})
