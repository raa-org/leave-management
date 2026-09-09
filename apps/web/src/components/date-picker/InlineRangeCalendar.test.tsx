/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineRangeCalendar, RANGE_DAY_COMPONENTS } from './InlineRangeCalendar'

// Records what the calendar hands DayPicker, then renders the real thing, so
// the identity spec at the bottom of this file can look at the `components`
// prop while every other spec here still asserts against real markup.
// vi.hoisted because the mock factory is lifted above the imports.
const spy = vi.hoisted(() => ({ components: [] as unknown[] }))

vi.mock('@daypicker/react', async () => {
  const actual =
    await vi.importActual<typeof import('@daypicker/react')>('@daypicker/react')
  return {
    ...actual,
    DayPicker: (props: Record<string, unknown>) => {
      spy.components.push(props.components)
      return createElement(actual.DayPicker, props)
    },
  }
})

// Server-rendered markup only (node env, no jsdom): enough to prove which days
// carry the unpaid marker and whether the legend explains it, which is the
// whole contract between the composer and this calendar. The two-month layout
// is behind a media query that never matches here, so the range below stays
// inside one month and every day of it is on screen.
const PERIOD = { startDate: '2026-03-16', endDate: '2026-03-27' }

function render(unpaidDates?: string[]): string {
  return renderToString(
    <InlineRangeCalendar
      value={PERIOD}
      onChange={() => {}}
      {...(unpaidDates ? { unpaidDates: new Set(unpaidDates) } : {})}
    />,
  )
}

// The days on screen carrying the marker. A date also appears as a hidden
// filler cell in the neighbouring month's grid, so those copies are dropped.
function markedDays(markup: string): string[] {
  const cells = markup.matchAll(
    /<td class="([^"]*dp-unpaid[^"]*)"[^>]*data-day="([^"]+)"/g,
  )
  return [...cells]
    .filter(([, classes]) => !classes.includes('rdp-hidden'))
    .map(([, , day]) => day as string)
    .sort()
}

describe('InlineRangeCalendar unpaid marking', () => {
  it('marks exactly the days the server called unpaid, wherever they fall', () => {
    // 25 March sits in the MIDDLE of the range: accrual arriving mid-leave
    // funds days after a day it could not, so the unpaid days are not a
    // trailing run and the calendar must not assume they are.
    const markup = render(['2026-03-25', '2026-03-27'])

    expect(markedDays(markup)).toEqual(['2026-03-25', '2026-03-27'])
  })

  // UNPAID_MARKING_DISABLED: the calendar deliberately marks nothing right now
  // (see the commented rules in InlineRangeCalendar). Skipped rather than
  // deleted, and skipped rather than commented out, so every run reports that
  // the treatment is parked and these two are waiting for it to come back.
  it.skip('draws the marking in the shared unpaid accent, with rounded corners', () => {
    const rule = render(['2026-03-25']).match(
      /\.dp-unpaid \.rdp-day_button\{[^}]*\}/,
    )?.[0]

    // The same coral the balance meter hatches its unpaid band with: one
    // concept, one colour, on both surfaces that mark it.
    expect(rule).toContain('rgba(224, 79, 57, 0.85)')
    // The radius has to be restated here: the library zeroes it on every day
    // inside a range, so without this the box comes out square on exactly the
    // days most likely to be unpaid.
    expect(rule).toContain('border-radius:8px')
  })

  it('marks the last day of the range, where the marking is hardest to see', () => {
    // The range end is solid primary with white text; without its own rule the
    // coral outline vanishes on exactly the day a request most often leaves
    // unpaid.
    expect(render(['2026-03-27'])).toContain(
      'dp-unpaid rdp-selected rdp-range_end',
    )
  })

  it('marks nothing when the whole request is paid', () => {
    expect(markedDays(render())).toEqual([])
    expect(markedDays(render([]))).toEqual([])
  })

  it.skip('explains the marking in the footer only while a split is on screen', () => {
    expect(render(['2026-03-25'])).toContain('Unpaid')
    // A fully paid request must not carry a legend entry for a marking that is
    // nowhere on the calendar.
    expect(render()).not.toContain('Unpaid')
    expect(render([])).not.toContain('Unpaid')
  })

  it('keeps the weekend and holiday legends either way', () => {
    for (const markup of [render(), render(['2026-03-25'])]) {
      expect(markup).toContain('Weekend')
      expect(markup).toContain('Public holiday')
    }
  })
})

// The per-day hours editor, server-rendered like the marking specs above. What
// can be proved without a DOM is the whole contract with the composer: which
// dates get a row, which cells get a badge, and that the panel is out of the
// tab order while it is closed.
const HOURS_PERIOD = { startDate: '2026-03-16', endDate: '2026-03-18' }

// React splits adjacent text nodes with an empty comment when it renders to a
// string ("8<!-- -->h"), which no reader ever sees; the assertions below are
// about the words, so it is stitched back together first.
function renderEditor(
  enabled: boolean,
  hoursByDate: Record<string, number> = {},
): string {
  return renderToString(
    <InlineRangeCalendar
      value={HOURS_PERIOD}
      onChange={() => {}}
      partialDays={{
        enabled,
        onEnabledChange: () => {},
        hoursPerDay: 8,
        hoursByDate,
        onHoursChange: () => {},
      }}
    />,
  ).split('<!-- -->').join('')
}

describe('InlineRangeCalendar partial days', () => {
  it('offers a switch and one row per chargeable date', () => {
    const markup = renderEditor(true)

    expect(markup).toContain('Partial days')
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-checked="true"')
    // Mon 16 to Wed 18 March 2026: three working days, three steppers.
    for (const label of ['Mon, Mar 16', 'Tue, Mar 17', 'Wed, Mar 18']) {
      expect(markup).toContain(`Decrease hours for ${label}`)
      expect(markup).toContain(`Increase hours for ${label}`)
    }
    expect(markup).toContain('8h = a full working day.')
  })

  // Both cases below shipped broken and were caught by eye, not by a spec: the
  // markup was right and the CSS was not, which is exactly what a markup
  // assertion cannot see. They read the emitted rule instead.
  it('leaves the stepper buttons room for their own glyph', () => {
    // The theme gives every Button paddingInline 18. In a 26px square that
    // leaves no content width, so the minus and plus were pushed out and
    // clipped by the group's overflow: the stepper rendered as a bare number
    // with nothing to press.
    const markup = renderEditor(true)
    const attributes = /class="([^"]*)"[^>]*aria-label="Decrease hours/.exec(
      markup,
    )
    const emotionClass = (attributes?.[1] ?? '')
      .split(' ')
      .find((name) => name.startsWith('css-'))
    expect(emotionClass).toBeDefined()
    const rule = new RegExp(`\\.${emotionClass}\\{([^}]*)\\}`).exec(markup)
    expect(rule?.[1]).toMatch(/padding:\s*0/)
  })

  it('spreads the footer so the tools sit at the right edge', () => {
    // A flat row whose last child carried `ml: auto` looked right and rendered
    // wrong: Stack's own spacing is a descendant selector, so it outranks the
    // child's margin and pinned the switch and Clear back beside the legend.
    const markup = renderEditor(true)
    expect(markup).toMatch(/justify-content:\s*space-between/)
  })

  it('gives a weekend no row at all', () => {
    // Sat 21 and Sun 22 March cost nothing, and the server refuses hours
    // booked against them outright.
    const markup = renderToString(
      <InlineRangeCalendar
        value={{ startDate: '2026-03-20', endDate: '2026-03-23' }}
        onChange={() => {}}
        partialDays={{
          enabled: true,
          onEnabledChange: () => {},
          hoursPerDay: 8,
          hoursByDate: {},
          onHoursChange: () => {},
        }}
      />,
    )

    expect(markup).toContain('Decrease hours for Fri, Mar 20')
    expect(markup).toContain('Decrease hours for Mon, Mar 23')
    expect(markup).not.toContain('Mar 21')
    expect(markup).not.toContain('Mar 22')
  })

  it('opens every date on a full day', () => {
    // The steppers read the workday until one of them is moved, so opening the
    // editor never changes what the request costs.
    expect(renderEditor(true).match(/>8h</g)).toHaveLength(3)
  })

  it('badges only the days that are actually short', () => {
    const markup = renderEditor(true, { '2026-03-17': 4 })

    expect(markup).toMatch(/class="dp-hours-badge[^"]*">4h<\/span>/)
    // The badge is added to the day button, never in place of its number: the
    // override replaces the library's own button, so the day it names has to
    // be rendered back out with it.
    expect(markup).toMatch(/>17<span class="dp-hours-badge/)
    expect(markup).toContain('>16</button>')
    // One badge, not one per selected day: a full day is what the cell
    // already means.
    expect(markup.match(/class="dp-hours-badge/g)).toHaveLength(1)
  })

  it('marks nothing on the calendar while the switch is off', () => {
    // The hours are reset by the composer on the way out, but a closed editor
    // must not be showing badges from them either way.
    // The class rule is always in the stylesheet; what must not exist is an
    // element carrying it.
    expect(renderEditor(false, { '2026-03-17': 4 })).not.toContain(
      'class="dp-hours-badge',
    )
  })

  it('keeps the closed panel out of the tab order', () => {
    // Kept mounted so the slide runs in both directions; `visibility` is what
    // takes the rows out of the accessibility tree while it is closed.
    expect(renderEditor(false)).toContain('visibility:hidden')
    expect(renderEditor(true)).toContain('visibility:visible')
    expect(renderEditor(false)).toContain('aria-checked="false"')
  })

  it('says what the selection costs once a day is shortened', () => {
    // Two whole days plus four hours, and the count of dates stays beside it:
    // the two figures answer different questions.
    expect(renderEditor(true, { '2026-03-17': 4 })).toContain(
      '3 working days · 2d 4h (2 full + 1 × 4h)',
    )
    // An untouched selection says only what it always said.
    expect(renderEditor(true)).not.toContain('full +')
  })

  it('offers no switch at all when the caller books whole days only', () => {
    expect(renderToString(<InlineRangeCalendar value={HOURS_PERIOD} onChange={() => {}} />))
      .not.toContain('Partial days')
  })
})

// The calendar overrides RDP's DayButton to carry the holiday tooltip and the
// part-day badge. RDP treats a NEW component identity as a different component,
// so an override rebuilt on any render unmounts and remounts every day cell in
// the grid. The composer re-renders on every keystroke of its comment box and
// on every debounced availability verdict, which made that the ordinary case,
// whole-day requests included.
//
// No DOM here (node env), so what is pinned is the thing that makes the remount
// impossible: the override is a module constant, and each mount is handed the
// very same object whatever the composer state around it.
describe('InlineRangeCalendar day cell identity', () => {
  beforeEach(() => {
    spy.components.length = 0
  })

  it('hands DayPicker the same components object across unrelated state', () => {
    // Two renders differing in everything a composer keystroke can move: the
    // selection, the holiday names, whether the hours editor is open, and the
    // hours themselves.
    renderToString(
      <InlineRangeCalendar
        value={PERIOD}
        onChange={() => {}}
        holidayNames={new Map([['2026-03-19', 'Statehood Day']])}
      />,
    )
    renderToString(
      <InlineRangeCalendar
        value={HOURS_PERIOD}
        onChange={() => {}}
        partialDays={{
          enabled: true,
          onEnabledChange: () => {},
          hoursPerDay: 8,
          hoursByDate: { '2026-03-17': 4 },
          onHoursChange: () => {},
        }}
      />,
    )

    expect(spy.components).toHaveLength(2)
    expect(spy.components[0]).toBe(RANGE_DAY_COMPONENTS)
    expect(spy.components[1]).toBe(RANGE_DAY_COMPONENTS)
  })

  it('hands it the same object for a plain whole-day request too', () => {
    // The regression that mattered most: an ordinary request with no part days
    // at all. The composer always supplies holiday names (they are what the
    // tooltip needs), so the override was always in play and was rebuilt on
    // every render, whole days or not.
    const holidayNames = new Map([['2026-03-19', 'Statehood Day']])
    renderToString(
      <InlineRangeCalendar
        value={PERIOD}
        onChange={() => {}}
        holidayNames={holidayNames}
      />,
    )
    renderToString(
      <InlineRangeCalendar
        value={{ startDate: '2026-04-06', endDate: '2026-04-08' }}
        onChange={() => {}}
        holidayNames={holidayNames}
      />,
    )

    expect(spy.components[0]).toBe(spy.components[1])
  })

  it('still decorates the cells it is given data for', () => {
    // The constant reads its badges and holiday names from context, so making
    // it stable must not have made it inert.
    const markup = renderToString(
      <InlineRangeCalendar
        value={HOURS_PERIOD}
        onChange={() => {}}
        partialDays={{
          enabled: true,
          onEnabledChange: () => {},
          hoursPerDay: 8,
          hoursByDate: { '2026-03-17': 4 },
          onHoursChange: () => {},
        }}
      />,
    )
      .split('<!-- -->')
      .join('')

    expect(markup).toMatch(/>17<span class="dp-hours-badge[^"]*">4h<\/span>/)
  })
})
