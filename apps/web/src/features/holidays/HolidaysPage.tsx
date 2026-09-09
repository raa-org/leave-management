/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { AppState } from '../../store'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  HOLIDAY_ACCENT,
  LegendSwatch,
} from '../../components/date-picker/CalendarSurface'
import {
  formatDate,
  formatRelativeTime,
  formatWeekdayLong,
  yearFromIso,
} from '../../lib/leave-format'
import { RELATIVE_TIME_TICK_MS, useNowTick } from '../../lib/use-auto-refresh'
import { employeeFeatureActions } from '../employee/employee-feature.store'
import {
  CalendarGlyph,
  ChevronGlyph,
  EmployeePageFrame,
  EmptyState,
  ErrorSection,
  ListGlyph,
  LoadingSection,
  SectionCard,
  SegmentedControl,
  WarnTriangleGlyph,
} from '../employee/employee-ui'
import {
  availableYears,
  isUpcomingSoon,
  resolveDefaultCountry,
  resolveDefaultYear,
} from './holiday-year'
import { HolidayYearCalendar } from './HolidayYearCalendar'
import {
  holidaysActions,
  selectCountries,
  selectHolidayCalendar,
  selectHolidayCountry,
  type HolidaysPartialState,
} from './holidays.store'

type ViewMode = 'calendar' | 'list'

// Prototype .ctrl-label: the small uppercase caption above each control.
function ControlLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: '#98a2b3',
      }}
    >
      {children}
    </Typography>
  )
}

export function HolidaysPageContent() {
  const dispatch = useDispatch()
  const countries = useSelector(selectCountries)
  // Read the employee's own country (to preselect it) and the server clock (to
  // decide the current year) from the shared employee dashboard, without a
  // dedicated fetch — dashboardRequested keeps the snapshot in place.
  const dashboard = useSelector((state: AppState) => state.dashboard.data)

  useEffect(() => {
    dispatch(holidaysActions.countriesNeeded())
    dispatch(employeeFeatureActions.dashboardRequested())
  }, [dispatch])

  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('calendar')

  const nowMs = useNowTick(RELATIVE_TIME_TICK_MS)

  // Falls back to the first country until the list (and the employee's own
  // country) is known; user selection always wins once made.
  const defaultCountry = resolveDefaultCountry(
    countries.items,
    dashboard
      ? (dashboard.holidayCalendarCountryCode ?? dashboard.countryCode)
      : undefined,
  )
  const activeCountry = selectedCountry ?? defaultCountry ?? null

  useEffect(() => {
    if (activeCountry) {
      dispatch(holidaysActions.countryCalendarsNeeded(activeCountry))
    }
  }, [activeCountry, dispatch])

  const countryEntry = useSelector((state: HolidaysPartialState) =>
    selectHolidayCountry(state, activeCountry ?? undefined),
  )

  // Server time is authoritative for "current year" (matches the dashboard's
  // calendar notices); the client clock is only a fallback before it loads.
  const currentYear =
    (dashboard?.generatedAt ? yearFromIso(dashboard.generatedAt) : null) ??
    new Date().getFullYear()
  // The server instant's UTC day, for the today ring and the "soon" pills -
  // undefined until the dashboard snapshot arrives.
  const todayIso = dashboard?.generatedAt ? dashboard.generatedAt.slice(0, 10) : undefined

  const years = useMemo(
    () => availableYears(countryEntry?.calendarsByYear ?? {}, currentYear),
    [countryEntry?.calendarsByYear, currentYear],
  )
  // Clamp a stale selection (e.g. after switching to a country that lacks the
  // previously picked year) back to a sensible default.
  const activeYear =
    selectedYear !== null && years.includes(selectedYear)
      ? selectedYear
      : resolveDefaultYear(years, currentYear)

  const calendar = useSelector((state: HolidaysPartialState) =>
    selectHolidayCalendar(state, activeCountry ?? undefined, activeYear),
  )

  const activeCountryName =
    countries.items.find((country) => country.code === activeCountry)?.name ??
    activeCountry ??
    ''

  const sortedHolidays = useMemo(
    () =>
      [...(calendar?.holidays ?? [])].sort((left, right) =>
        left.date.localeCompare(right.date),
      ),
    [calendar],
  )

  return (
    <EmployeePageFrame
      title="Holiday calendars"
      subtitle="Browse the public holidays and non-working days configured for each country."
      statusIndicator={
        countryEntry?.fetchedAt !== undefined ? (
          <ShellStatusPill
            label={`Live · updated ${formatRelativeTime(new Date(countryEntry.fetchedAt).toISOString(), nowMs)}`}
          />
        ) : undefined
      }
    >
      {renderBody()}
    </EmployeePageFrame>
  )

  function renderBody() {
    if (
      countries.status === 'idle' ||
      (countries.status === 'loading' && countries.items.length === 0)
    ) {
      return <LoadingSection label="Loading countries" />
    }
    if (countries.status === 'failed' && countries.items.length === 0) {
      return (
        <ErrorSection
          title="Countries unavailable"
          message={countries.error ?? 'The country list could not be loaded.'}
        />
      )
    }
    if (countries.items.length === 0) {
      return (
        <SectionCard title="No countries configured">
          <EmptyState
            title="Nothing to show yet"
            message="No countries have been set up. Once an administrator adds one, its holiday calendar will appear here."
          />
        </SectionCard>
      )
    }

    // Everything lives on ONE panel like the prototype: the card has no
    // header of its own - the controls bar opens it.
    return (
      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '16px',
          bgcolor: 'background.paper',
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
        }}
      >
        {/* Prototype .controls */}
        <Stack
          direction="row"
          spacing={2.25}
          rowGap={1.5}
          useFlexGap
          flexWrap="wrap"
          alignItems="flex-end"
          sx={{ p: '18px 20px' }}
        >
          <Stack spacing={0.75}>
            <ControlLabel>Country</ControlLabel>
            <TextField
              select
              value={activeCountry ?? ''}
              onChange={(event) => {
                setSelectedCountry(event.target.value)
                // Let the new country resolve its own default year.
                setSelectedYear(null)
              }}
              inputProps={{
                'data-testid': 'holidays-country-select',
                'aria-label': 'Country',
              }}
              sx={{
                minWidth: 220,
                maxWidth: 320,
                '& .MuiOutlinedInput-root': { borderRadius: '11px' },
                '& .MuiSelect-select': { fontSize: 14, fontWeight: 700, py: '10px' },
              }}
            >
              {countries.items.map((country) => (
                <MenuItem key={country.code} value={country.code}>
                  {country.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack spacing={0.75}>
            <ControlLabel>Year</ControlLabel>
            <YearStepper year={activeYear} years={years} onChange={setSelectedYear} />
          </Stack>

          <Stack spacing={0.75} sx={{ ml: { sm: 'auto' } }}>
            <ControlLabel>Display</ControlLabel>
            <SegmentedControl
              ariaLabel="Display mode"
              value={viewMode}
              onChange={setViewMode}
              options={[
                {
                  value: 'calendar',
                  label: 'Calendar',
                  icon: <CalendarGlyph size={15} />,
                },
                { value: 'list', label: 'List', icon: <ListGlyph size={15} /> },
              ]}
            />
          </Stack>
        </Stack>

        {renderSummaryRow()}
        {renderContent()}
      </Box>
    )
  }

  // Prototype .summary-row: the holiday count on the left, the legend
  // trailing. The legend explains only what the active view draws: all three
  // swatches for the calendar grid, just the holiday one for the list, and
  // nothing when the year has no calendar.
  function renderSummaryRow() {
    if (!activeCountry) {
      return null
    }
    const missingYear = !calendar && countryEntry?.status === 'succeeded'
    if (!calendar && !missingYear) {
      // Loading/failed states carry their own body rows below.
      return null
    }
    return (
      <Stack
        direction="row"
        spacing={2}
        rowGap={0.75}
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        sx={{ px: '20px', pb: 0.5 }}
      >
        <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.secondary' }}>
          {missingYear ? (
            <>
              No calendar configured for{' '}
              <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
                {activeCountryName}, {activeYear}
              </Box>
              .
            </>
          ) : (
            <>
              <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
                {sortedHolidays.length}
              </Box>{' '}
              public {sortedHolidays.length === 1 ? 'holiday' : 'holidays'} in{' '}
              <Box component="b" sx={{ color: 'text.primary', fontWeight: 800 }}>
                {activeCountryName}, {activeYear}
              </Box>
            </>
          )}
        </Typography>
        {missingYear ? null : (
          <Stack
            direction="row"
            spacing={1.75}
            alignItems="center"
            sx={{ ml: 'auto' }}
          >
            <LegendSwatch tone="holiday" label="Public holiday" />
            {viewMode === 'calendar' ? (
              <>
                <LegendSwatch tone="weekend" label="Weekend" />
                <LegendSwatch tone="today" label="Today" />
              </>
            ) : null}
          </Stack>
        )}
      </Stack>
    )
  }

  function renderContent() {
    if (!activeCountry) {
      return null
    }

    // A present calendar wins even while the country is revalidating, so the
    // view never flickers off just because the TTL expired.
    if (calendar) {
      return (
        // The list sits tighter under the summary than the grid does
        // (prototype .list-wrap 6px top vs .year-grid 14px).
        <Box sx={{ p: viewMode === 'calendar' ? '14px 20px 22px' : '6px 20px 22px' }}>
          {viewMode === 'calendar' ? (
            <HolidayYearCalendar
              year={activeYear}
              holidays={sortedHolidays}
              todayIso={todayIso}
            />
          ) : sortedHolidays.length > 0 ? (
            <HolidayList holidays={sortedHolidays} todayIso={todayIso} />
          ) : (
            <EmptyState
              title="No public holidays"
              message={`No holidays are recorded in the ${activeYear} calendar for ${activeCountryName}.`}
            />
          )}
        </Box>
      )
    }

    // No calendar for this (country, year). Distinguish "still loading" from
    // "confirmed none": only a SUCCEEDED read means the calendar truly isn't
    // filled — otherwise the notice would flash during the first fetch.
    if (!countryEntry || countryEntry.status === 'loading') {
      return (
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          role="status"
          aria-live="polite"
          sx={{ px: '20px', py: 3 }}
        >
          <CircularProgress size={20} aria-label="Loading" />
          <Typography variant="body2" color="text.secondary">
            Loading holidays.
          </Typography>
        </Stack>
      )
    }
    if (countryEntry.status === 'failed') {
      return (
        <Box sx={{ p: '8px 20px 22px' }}>
          <Alert severity="error">
            {countryEntry.error ?? 'The holiday calendar could not be loaded.'}
          </Alert>
        </Box>
      )
    }

    // Prototype .warn: the not-filled notice as a warning panel.
    return (
      <Stack
        direction="row"
        spacing={1.5}
        data-testid="holidays-not-filled"
        sx={(theme) => ({
          m: '8px 20px 22px',
          p: 2,
          border: `1px solid ${alpha(theme.palette.warning.main, 0.28)}`,
          bgcolor: alpha(theme.palette.warning.main, 0.1),
          borderRadius: '14px',
        })}
      >
        <Box sx={{ color: 'warning.dark', pt: '1px', flexShrink: 0 }}>
          <WarnTriangleGlyph size={18} />
        </Box>
        <Box>
          <Typography sx={{ fontSize: 14, fontWeight: 800, color: 'warning.dark' }}>
            The holiday calendar for {activeCountryName} in {activeYear} has not
            been filled in yet.
          </Typography>
          <Typography
            sx={{ mt: 0.5, fontSize: 13, color: 'text.secondary', lineHeight: 1.5 }}
          >
            Pick another year, or contact your administrator to set it up.
          </Typography>
        </Box>
      </Stack>
    )
  }
}

// Year navigation as calendar-style arrows (prototype .year: 34px bordered
// squares around a 20/800 tabular year). `years` is sorted newest-first
// (availableYears), so the OLDER year sits at the next index and the NEWER one
// at the previous. Arrows disable at the ends of the offered range - the list
// may be SPARSE, so an arrow steps to the next OFFERED year, not year+-1.
function YearStepper({
  year,
  years,
  onChange,
}: {
  year: number
  years: number[]
  onChange: (year: number) => void
}) {
  const index = years.indexOf(year)
  const olderYear = index >= 0 && index < years.length - 1 ? years[index + 1] : undefined
  const newerYear = index > 0 ? years[index - 1] : undefined
  const arrowSx = (theme: import('@mui/material/styles').Theme) => ({
    width: 34,
    height: 34,
    borderRadius: '10px',
    border: '1px solid rgba(16, 24, 40, 0.14)',
    color: 'text.secondary',
    '&:hover': {
      borderColor: theme.palette.primary.main,
      color: theme.palette.primary.main,
      bgcolor: alpha(theme.palette.primary.main, 0.08),
    },
    '&.Mui-disabled': { opacity: 0.4 },
  })
  return (
    <Stack direction="row" spacing={1.25} alignItems="center">
      <IconButton
        aria-label="Previous year"
        disabled={olderYear === undefined}
        onClick={() => olderYear !== undefined && onChange(olderYear)}
        sx={arrowSx}
      >
        <Box sx={{ display: 'inline-flex', transform: 'rotate(180deg)' }} aria-hidden>
          <ChevronGlyph size={16} />
        </Box>
      </IconButton>
      <Typography
        component="p"
        aria-live="polite"
        sx={{
          minWidth: 66,
          textAlign: 'center',
          fontSize: 20,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {year}
      </Typography>
      <IconButton
        aria-label="Next year"
        disabled={newerYear === undefined}
        onClick={() => newerYear !== undefined && onChange(newerYear)}
        sx={arrowSx}
      >
        <ChevronGlyph size={16} />
      </IconButton>
    </Stack>
  )
}

// Prototype list view: Date / Day / Holiday, with a warning dot before the
// name and a "soon" pill for holidays within the next two weeks (server
// clock). Exported for direct render tests - the page's view toggle is local
// state renderToString cannot reach.
export function HolidayList({
  holidays,
  todayIso,
}: {
  holidays: { date: string; name: string }[]
  todayIso?: string
}) {
  return (
    <TableContainer>
      <Table
        size="small"
        aria-label="Public holidays"
        sx={{
          '& th': {
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: '#98a2b3',
            border: 'none',
            borderBottom: '1px solid',
            borderColor: 'divider',
            py: 1.25,
          },
          '& td': {
            fontSize: 13.5,
            border: 'none',
            borderBottom: '1px solid',
            borderColor: 'divider',
            py: 1.5,
          },
          '& tbody tr:hover': { bgcolor: 'rgba(16, 24, 40, 0.02)' },
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 150 }}>Date</TableCell>
            <TableCell sx={{ width: 130 }}>Day</TableCell>
            <TableCell>Holiday</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {holidays.map((holiday) => (
            <TableRow key={`${holiday.date}-${holiday.name}`}>
              <TableCell
                sx={{
                  fontWeight: 800,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatDate(holiday.date)}
              </TableCell>
              <TableCell
                sx={{ color: 'text.secondary', fontWeight: 600, whiteSpace: 'nowrap' }}
              >
                {formatWeekdayLong(holiday.date)}
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={1.1} alignItems="center">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: HOLIDAY_ACCENT.main,
                      flexShrink: 0,
                    }}
                    aria-hidden
                  />
                  <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                    {holiday.name}
                  </Typography>
                  {todayIso && isUpcomingSoon(holiday.date, todayIso) ? (
                    <Typography
                      component="span"
                      sx={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: HOLIDAY_ACCENT.text,
                        bgcolor: HOLIDAY_ACCENT.tint,
                        borderRadius: '999px',
                        px: 1,
                        py: '2px',
                      }}
                    >
                      soon
                    </Typography>
                  ) : null}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

export function HolidaysPage() {
  return <HolidaysPageContent />
}

export default HolidaysPage
