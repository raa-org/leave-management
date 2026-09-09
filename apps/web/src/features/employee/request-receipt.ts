/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { LeaveAvailabilityPreviewDto, LeaveType } from '@workspace/contracts'
import { formatDays, roundDays } from '../../lib/leave-format'
import { fundingOf, keepFundingYears, type YearFunding } from './leave-year-model'

/**
 * A row's figure, floored to complete hours. Leftover minutes stay on the
 * books and appear in the hover tooltip (exactBookableTooltip), so a chip
 * never promises 2d 1h when only 2d can be taken.
 */
function days(value: number, sign: '' | '+' | '-' = ''): string {
  return `${sign}${formatDays(value)}`
}

function amount(
  value: number,
  sign: '' | '+' | '-' = '',
): Pick<ReceiptRow, 'value' | 'rawDays'> {
  return { value: days(value, sign), rawDays: value }
}

/**
 * Why an arriving band is the size it is. Shared with the meter chips so the
 * hover on "+9d accrues" and the receipt row tell the same story.
 *
 * A future year kept on screen only because it already holds booked leave is
 * not accruing "by this request's dates": the 9d is this year's allowance
 * minus the days already borrowed (15d still to land, 6d booked, 9d left).
 */
export function describeArriving(funding: YearFunding): string {
  if (funding.deficitDays > 0) {
    return (
      `${formatDays(funding.arrivingGrossDays)} still accrue in ${funding.year}, ` +
      `but leave already booked has borrowed ${formatDays(funding.deficitDays)} of it. ` +
      `${formatDays(funding.arrivingNetDays)} is what remains after those bookings.`
    )
  }
  if (funding.future && !funding.touched) {
    return (
      `${formatDays(funding.arrivingNetDays)} of ${funding.year}'s own accrual ` +
      `still to land this year, on top of carryover. Not tied to this request's dates.`
    )
  }
  return funding.touched
    ? 'Not accrued yet. These days build up month by month between now and the leave, and are all in your balance by the time it starts.'
    : 'Not accrued yet. These days build up month by month between now and year end.'
}

function arrivingLabel(funding: YearFunding): string {
  if (funding.future) {
    return funding.touched
      ? 'Accrued by the leave dates'
      : `Still to accrue in ${funding.year}`
  }
  if (funding.touched) {
    return 'Arriving by the leave dates'
  }
  return 'Arriving by year end'
}

function involvesHours(value: number): boolean {
  const amount = Math.abs(roundDays(value))
  return Math.abs(amount - Math.trunc(amount + 1e-9)) > 0.0005
}

/** default: a ledger line. sum: a total under a rule. muted: a consequence
 *  nobody acts on. unpaid: the one figure that is not a balance day. */
export type ReceiptTone = 'default' | 'sum' | 'muted' | 'unpaid'

/** Names a METER BAND, never a colour: the component owns the pigment, so a
 *  band recoloured on the bar recolours its swatch here by construction. */
export type ReceiptSwatch = 'available' | 'arriving' | 'carry' | 'unpaid'

export type ReceiptRow = {
  /** Stable identity for React and for tests. Never the label, which is copy. */
  key: string
  label: string
  /** Pre-formatted, floored, sign included: "9d", "+10d 4h", "-4h". */
  value: string
  /** The unformatted figure, so the receipt can hover the exact books value. */
  rawDays?: number
  /** Extra hover copy, stacked with exactBookableTooltip when both exist. */
  title?: string
  tone: ReceiptTone
  swatch?: ReceiptSwatch
  /** A second, muted line under the row. */
  finePrint?: string
  /** Hairline above this row: the ledger's "a sum follows" rule. */
  ruleAbove?: boolean
}

export type ReceiptYearSection = {
  year: number
  /** "2026 · pays for 4d" */
  heading: string
  rows: ReceiptRow[]
}

export type ReceiptVerdict = {
  tone: 'paid' | 'partial' | 'unpaid' | 'checking'
  label: string
}

export type RequestReceipt =
  | { kind: 'empty'; message: string }
  | { kind: 'zero-cost'; message: string }
  /** No answer yet for anything: a skeleton, so the sticky rail does not jump. */
  | { kind: 'pending' }
  /** The check failed. The bars beside it still show where the reader stands. */
  | { kind: 'unavailable'; message: string }
  | {
      kind: 'receipt'
      sections: ReceiptYearSection[]
      verdict: ReceiptVerdict
      /** True while these figures describe dates other than the ones on the form. */
      stale: boolean
    }

const EMPTY_MESSAGE =
  'Nothing selected yet. Weekends and public holidays inside the range are free; they never spend balance.'
const ZERO_COST_MESSAGE =
  'The selected dates contain no working days, so this request would spend nothing. Include at least one working day to submit it.'
const UNAVAILABLE_MESSAGE =
  'Could not check these dates. The balance beside this card still shows where you stand today.'

/**
 * The request as a funding receipt: one section per leave year it touches, plus
 * this year whenever it only feeds the carryover, each section adding up like a
 * ledger from what the year holds to what it hands on.
 *
 * It reads the preview and nothing else. A local estimate cannot honestly
 * produce a carryover, an arriving figure for next year, or what a year expires
 * under a policy the client is not allowed to see, so offering one would put a
 * second, quieter source of truth beside the bars.
 */
export function buildRequestReceipt(input: {
  leaveType: LeaveType
  startDate: string
  endDate: string
  /** Working DATES of the selection: whether there is anything to charge. */
  chargeableDays: number
  /** What those dates cost, part days included. Left out, only the period is
   *  compared against the preview, which is all a whole-day composer has. */
  costDays?: number
  /** The last preview the store holds, whatever dates it describes. */
  preview?: LeaveAvailabilityPreviewDto
  previewStatus: 'idle' | 'loading' | 'succeeded' | 'failed'
  /** Modify mode: days the leave being replaced hands back. */
  replacedDays?: number
}): RequestReceipt {
  if (!input.startDate) {
    return { kind: 'empty', message: EMPTY_MESSAGE }
  }
  if (input.chargeableDays <= 0) {
    return { kind: 'zero-cost', message: ZERO_COST_MESSAGE }
  }
  const preview = input.preview
  if (!preview) {
    return input.previewStatus === 'failed'
      ? { kind: 'unavailable', message: UNAVAILABLE_MESSAGE }
      : { kind: 'pending' }
  }

  // The same predicate the bars use to decide whether the server's verdict is
  // about these dates, so the two surfaces go stale and fresh together. The
  // cost is part of it: a stepper moved inside an unchanged period changes what
  // the request costs, and dates alone cannot tell that verdict from this one.
  const stale =
    preview.leaveType !== input.leaveType ||
    preview.startDate !== input.startDate ||
    preview.endDate !== input.endDate ||
    (input.costDays !== undefined &&
      Math.abs(preview.requestedDays - input.costDays) >= 0.0005)

  const sections = keepFundingYears(
    preview.years.map((year) => fundingOf(year)),
    preview.currentYear,
  ).map((funding, index, all) =>
      yearSection(funding, {
        first: index === 0,
        hasNext: index < all.length - 1,
        // One section means one year, and the calendar beside this card
        // already says which: naming it again would be noise. Two sections
        // cannot do without it, since the whole point is which year pays.
        named: all.length > 1,
        replacedDays: input.replacedDays ?? 0,
      }),
    )

  return {
    kind: 'receipt',
    sections,
    verdict: verdictOf(preview, stale),
    stale,
  }
}

// The verdict reads the preview's own total, never the sum of the sections: if
// the per-year split ever drifted from it, the strip, the submit note and the
// availability banner would still agree with each other.
function verdictOf(
  preview: LeaveAvailabilityPreviewDto,
  stale: boolean,
): ReceiptVerdict {
  if (stale) {
    return { tone: 'checking', label: 'Checking these dates' }
  }
  if (preview.unpaidDays <= 0) {
    return { tone: 'paid', label: 'Fully paid' }
  }
  // Red means the balance pays for nothing at all, which is a different message
  // from "most of it is covered". A threshold in days would be arbitrary.
  return preview.paidDays <= 0
    ? { tone: 'unpaid', label: `All ${formatDays(preview.unpaidDays)} unpaid` }
    : {
        tone: 'partial',
        label: `${formatDays(preview.unpaidDays)} of ${formatDays(preview.requestedDays)} unpaid`,
      }
}

/**
 * One year as ledger rows.
 *
 * The first row is always "what the year already holds, net of what is already
 * claimed", whether that is days accrued or days carried in, and its fine print
 * names the gross figure and the claim whenever they differ. One mechanism,
 * two labels.
 */
function yearSection(
  funding: YearFunding,
  context: {
    first: boolean
    hasNext: boolean
    named: boolean
    replacedDays: number
  },
): ReceiptYearSection {
  const rows: ReceiptRow[] = []
  const replacedNote =
    context.replacedDays > 0
      ? ` Already counts the ${formatDays(context.replacedDays)} the leave you are changing hands back.`
      : ''

  if (funding.future) {
    rows.push({
      key: 'carried-in',
      label: `Carried over from ${funding.year - 1}`,
      ...amount(funding.carryInDays, '+'),
      tone: funding.carryInDays > 0 ? 'default' : 'muted',
      swatch: 'carry',
      ...(replacedNote ? { finePrint: replacedNote.trim() } : {}),
    })
  } else {
    rows.push({
      key: 'available',
      label: 'Available now',
      ...amount(funding.availableNow),
      tone: 'default',
      swatch: 'available',
      ...(funding.deficitDays > 0 || replacedNote
        ? {
            finePrint:
              (funding.deficitDays > 0
                ? `Leave already booked has borrowed ${formatDays(funding.deficitDays)} from accrual still to come.`
                : '') + replacedNote,
          }
        : {}),
    })
  }

  // The arriving line exists to explain that the balance GROWS before the
  // leave. Booking inside the month its accrual already posted, nothing grows,
  // and the line reads "+0d" over a sum that restates the line above it: three
  // rows to say one number. So when nothing arrives, neither row is drawn and
  // the ledger goes straight from what is available to what the request costs.
  // A deficit still gets both, because then the zero is the ANSWER: leave
  // already booked has spoken for the accrual this one hoped to reach.
  const arrives = funding.arrivingNetDays > 0 || funding.deficitDays > 0

  if (arrives) {
    rows.push({
      key: 'arriving',
      label: arrivingLabel(funding),
      ...amount(funding.arrivingNetDays, '+'),
      tone: funding.arrivingNetDays > 0 ? 'default' : 'muted',
      swatch: 'arriving',
      title: describeArriving(funding),
      ...(funding.deficitDays > 0
        ? {
            finePrint: `${formatDays(funding.arrivingGrossDays)} will accrue; ${formatDays(funding.deficitDays)} of it repays days already borrowed.`,
          }
        : {}),
    })

    rows.push({
      key: 'pool',
      label: funding.touched ? 'Free by the leave dates' : 'Free at year end',
      ...amount(funding.poolDays),
      tone: 'sum',
      ruleAbove: true,
    })
  }

  if (funding.touched) {
    rows.push({
      key: 'takes',
      label: 'This request takes',
      ...amount(funding.requestedDays, '-'),
      tone: 'default',
    })
    if (funding.unpaidDays > 0) {
      rows.push({
        key: 'unpaid',
        label: 'Unpaid',
        ...amount(funding.unpaidDays),
        tone: 'unpaid',
        swatch: 'unpaid',
        ...(involvesHours(funding.unpaidDays) || involvesHours(funding.paidDays)
          ? {
              finePrint:
                'A working day is paid in full or unpaid in full. Leftover hours cannot cover part of a longer day.',
            }
          : {}),
      })
    }
  }

  if (context.hasNext) {
    if (funding.touched) {
      rows.push({
        key: 'leftover',
        label: 'Left at year end',
        ...amount(funding.leftoverAtYearEnd),
        tone: 'sum',
        ruleAbove: true,
        ...(funding.fundsBookedCarryover
          ? {
              finePrint: `Not free to book later this year: it has to remain so ${formatDays(funding.carryOutDays)} can carry over.`,
            }
          : {}),
      })
    }
    rows.push({
      key: 'carry-out',
      label: `Carries over to ${funding.year + 1}`,
      ...amount(funding.carryOutDays),
      tone: funding.carryOutDays > 0 ? 'default' : 'muted',
      swatch: 'carry',
      ...(funding.fundsBookedCarryover
        ? {
            finePrint: `Needed to fund leave already booked in ${funding.year + 1}. Taking more of this year's leftover would leave that leave unpaid.`,
          }
        : funding.future
          ? {
              finePrint:
                'Projected under the current carryover policy; confirmed at year end.',
            }
          : {}),
    })
    if (funding.expiringDays > 0) {
      rows.push({
        key: 'expires',
        label: 'Expires at year end',
        ...amount(funding.expiringDays),
        tone: 'muted',
      })
    }
  } else if (funding.touched) {
    rows.push({
      key: 'free-after',
      label: 'Free after approval',
      ...amount(funding.freeAfterRequest),
      tone: 'sum',
      ruleAbove: true,
    })
  }

  return {
    year: funding.year,
    heading: sectionHeading(funding, context.named),
    rows,
  }
}

function sectionHeading(funding: YearFunding, named: boolean): string {
  const body =
    funding.requestedDays <= 0
      ? funding.future && funding.holdsBookedLeave
        ? 'already booked'
        : funding.carryOutDays > 0
          ? 'funds the carryover'
          : 'nothing to give'
      : funding.unpaidDays <= 0
        ? `pays for ${days(funding.paidDays)}`
        : funding.paidDays <= 0
          ? `pays for none of ${days(funding.requestedDays)}`
          : `pays for ${days(funding.paidDays)} of ${days(funding.requestedDays)}`
  // Named, the year opens the line and the clause follows it in lower case.
  // Unnamed, the clause IS the line and starts the card, so it leads.
  return named
    ? `${funding.year} · ${body}`
    : body.charAt(0).toUpperCase() + body.slice(1)
}
