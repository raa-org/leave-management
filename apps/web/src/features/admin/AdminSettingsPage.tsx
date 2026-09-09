/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useMemo, useState } from 'react'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type {
  CountryCatalogEntryDto,
  CountryDto,
  HolidayCalendarDto,
  LeavePolicyDto,
  LeaveSettingsDto,
} from '@workspace/contracts'
import {
  CarryoverCapMode,
  CarryoverPolicy,
  isRealIsoDate,
  isWeekendIso,
  normalizeCountryCode,
} from '@workspace/contracts'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import {
  ArrowGlyph,
  CalendarGlyph,
  CheckGlyph,
  ChevronGlyph,
  DaysStepper,
  GlobeGlyph,
  PeopleGlyph,
  SectionCard,
  SegmentedControl,
  SlidersGlyph,
  UndoGlyph,
} from '../employee/employee-ui'
import { ShellStatusPill } from '../../components/layout/AppShell'
import { buildSettingsPayload } from './settings-payload'
import {
  countryDraftProblem,
  countryRemovalProblem,
  countryTimezoneOptions,
} from './settings-format'
import { useLocation } from 'react-router-dom'
import { AdminLayout } from './AdminLayout'
import { adminApi, type AdminApiClient } from './admin-api'
import { AdminPolicyCatalog } from './AdminPolicyCatalog'
import { ImportExportViews } from './import/ImportExportViews'
import { DownloadGlyph, UploadGlyph } from './import/import-wizard-glyphs'
import { ShieldGlyph, tealFocusSx } from './policy-ui'
import { describeCarryoverRule, sortCalendars } from './admin-formatters'
import { DateField } from '../../components/date-picker'
import {
  UserMultiSelect,
  excludeEmails,
  type UserOption,
} from '../../components/user-select'

type SettingsView = 'policies' | 'calendars' | 'import' | 'export'

// The tab survives a refresh and /admin/import keeps working through the
// location hash (the profile page's tab pattern): '#import', '#export' and
// '#calendars' name their views, Policies stays the clean no-hash default.
const viewFromHash = (hash: string): SettingsView =>
  hash === '#import'
    ? 'import'
    : hash === '#export'
      ? 'export'
      : hash === '#calendars'
        ? 'calendars'
        : 'policies'

type AdminSettingsPageProps = {
  api?: AdminApiClient
  initialSettings?: LeaveSettingsDto
  initialHolidayCalendars?: HolidayCalendarDto[]
  /** useState initializer only; lets SSR tests reach a non-default view. */
  initialView?: SettingsView
  /** Seeds the policy catalog synchronously for server-rendered tests. */
  initialPolicies?: LeavePolicyDto[]
  /**
   * useState initializer only; opens the calendar editor for this country so
   * server-rendered tests can reach the drilled-in view (effects do not run
   * under renderToStaticMarkup, so it is otherwise unreachable).
   */
  initialCalendarCountry?: string
}

type PanelState<T> = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: T | null
}

type SaveState = {
  status: 'idle' | 'saving' | 'success' | 'error'
  error: string | null
}

type DefaultsFormState = {
  defaultVacationDays: string
  defaultSickDays: string
  approvalRequired: boolean
  // Email arrays end to end: the pickers select from the user directory but
  // the settings contract stays email-based, so no parse/format step remains.
  defaultApproverEmails: string[]
  defaultCcApproverEmails: string[]
  carryoverPolicy: CarryoverPolicy
  carryoverCapDays: string
  carryoverCapMode: CarryoverCapMode
  carryoverCapPercent: string
  defaultTimezone: string
}

// `id` is a client-only stable key: the rows now hold internal picker state
// (an open popover), so keying by array index would re-associate that state to
// a different holiday when a middle row is removed. It never reaches the API.
type HolidayRow = { id: string; date: string; name: string }

let holidayRowSeq = 0
const nextHolidayRowId = () => `holiday-row-${(holidayRowSeq += 1)}`

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

// Day of week for a calendar date, UTC-pinned to match how holiday dates are
// treated everywhere else (isWeekendIso, the API's resolveLeaveDays): the input
// is a calendar date, not an instant, so the viewer's zone must not shift it.
function holidayDayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getUTCDay()
}

// A stable, distinct badge color per country code for the "All calendars"
// overview (the data carries no per-country color). Deterministic so the same
// country always reads the same hue across renders.
const COUNTRY_BADGE_COLORS = [
  '#155eef',
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#be185d',
  '#0369a1',
  '#15803d',
  '#b42318',
] as const
// The prototype labels a control with a small caps caption ABOVE its box, not
// with MUI's floating in-outline label. Mixing the two in one row (a floating
// "Country" beside a caps "LEAVE YEAR") made the picker read as two unrelated
// controls. text.secondary rather than text.disabled: the caption is a label,
// not disabled text, and disabled grey is the one grey the rest of the app's
// captions avoid.
const capsLabelSx = {
  display: 'block',
  mb: 0.75,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'text.secondary',
} as const

// A delete control should say what it will do before the click. The holiday
// rows already reddened on hover; the country rows did not.
const deleteIconSx = {
  flexShrink: 0,
  color: 'text.secondary',
  '&:hover': { color: 'error.main', bgcolor: 'rgba(180, 35, 24, 0.08)' },
} as const

function countryBadgeColor(code: string): string {
  let hash = 0
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) >>> 0
  }
  return COUNTRY_BADGE_COLORS[hash % COUNTRY_BADGE_COLORS.length]
}

// Timezone options for a country row's picker: the country's full zone list
// from the catalog (a country can span several), so the admin picks the office
// zone manually. Guarantees the row's current value is present even if the
// catalog dropped it or has not loaded yet.
// After a save, refresh only the fields the saved card owns. Everything else
// in the form is another card's draft and must survive untouched.
function reconcileSavedPanel(
  current: DefaultsFormState,
  panel: GeneralPanelKey,
  saved: LeaveSettingsDto,
): DefaultsFormState {
  if (panel === 'approvers') {
    return {
      ...current,
      approvalRequired: saved.approvalRequired ?? true,
      defaultApproverEmails: [...saved.defaultApproverEmails],
      defaultCcApproverEmails: [...saved.defaultCcApproverEmails],
    }
  }
  return {
    ...current,
    carryoverPolicy: saved.carryoverPolicy ?? CarryoverPolicy.Capped,
    carryoverCapDays: String(saved.carryoverCapDays ?? 0),
    carryoverCapMode: saved.carryoverCapMode ?? CarryoverCapMode.Percent,
    carryoverCapPercent: String(saved.carryoverCapPercent ?? 50),
  }
}


const emptyDefaultsForm: DefaultsFormState = {
  defaultVacationDays: '',
  defaultSickDays: '',
  approvalRequired: true,
  defaultApproverEmails: [],
  defaultCcApproverEmails: [],
  carryoverPolicy: CarryoverPolicy.Capped,
  carryoverCapDays: '0',
  carryoverCapMode: CarryoverCapMode.Percent,
  carryoverCapPercent: '50',
  defaultTimezone: 'Europe/Kyiv',
}

function toDefaultsForm(settings: LeaveSettingsDto): DefaultsFormState {
  return {
    defaultVacationDays: String(settings.defaultVacationDays),
    defaultSickDays: String(settings.defaultSickDays),
    approvalRequired: settings.approvalRequired ?? true,
    defaultApproverEmails: [...settings.defaultApproverEmails],
    defaultCcApproverEmails: [...settings.defaultCcApproverEmails],
    carryoverPolicy: settings.carryoverPolicy ?? CarryoverPolicy.Capped,
    carryoverCapDays: String(settings.carryoverCapDays ?? 0),
    carryoverCapMode: settings.carryoverCapMode ?? CarryoverCapMode.Percent,
    carryoverCapPercent: String(settings.carryoverCapPercent ?? 50),
    defaultTimezone: settings.defaultTimezone ?? 'Europe/Kyiv',
  }
}

// The General sub-tab is one settings object rendered across separate cards
// (prototype parity). Each card owns its Save; this key names which card last
// triggered the shared save flow so its footer alone shows saving/saved/error.
type GeneralPanelKey =
  | 'carryover'
  | 'approvers'
  | 'countries'

const CARRYOVER_CHOICES: {
  value: CarryoverPolicy
  title: string
  description: string
}[] = [
  {
    value: CarryoverPolicy.None,
    title: 'No carryover',
    description: 'Unused days are forfeited at year end.',
  },
  {
    value: CarryoverPolicy.Capped,
    title: 'Capped',
    description: 'Carry over unused days up to a limit.',
  },
  {
    value: CarryoverPolicy.Full,
    title: 'All carry over',
    description: 'All unused days carry over to next year.',
  },
]

// The unit of the number beside them, not mode names a field label then
// restates. The two percent options carry their base in the label rather than
// leaving it to the footer note: that base is the ONLY thing separating them,
// so a bare "Percent" would make the choice unreadable. Sized to content for
// the same reason the labels differ in length — an equal-width track would
// inflate "Days" into a slab beside "% of allowance".
const CARRYOVER_CAP_MODE_OPTIONS: {
  value: CarryoverCapMode
  label: string
}[] = [
  { value: CarryoverCapMode.Days, label: 'Days' },
  { value: CarryoverCapMode.Percent, label: '% of unused' },
  { value: CarryoverCapMode.PercentOfTotal, label: '% of allowance' },
]

// The two approval modes, in the same descriptive-card language the carryover
// policy uses. Written as full sentences because this choice changes what
// happens to every future request, and the difference between the two is a
// rule rather than a number.
const APPROVAL_MODE_CHOICES: {
  required: boolean
  title: string
  description: string
}[] = [
  {
    required: true,
    title: 'Approval required',
    description:
      'Every request needs at least one deciding approver. The default approvers below are applied to each submission.',
  },
  {
    required: false,
    title: 'Approval optional',
    description:
      'Requests approve automatically. A deciding approver the employee adds voluntarily still decides.',
  },
]

// Same .seg / .seg-opt cards as the carryover policy, two across. Kept a
// separate component rather than generalizing CarryoverChoice: that one owns
// the cap reveal underneath it, which has no counterpart here.
function ApprovalModeChoice({
  value,
  onChange,
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Box
      role="radiogroup"
      aria-label="Approval requirement"
      sx={{
        display: 'grid',
        gap: '10px',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
      }}
    >
      {APPROVAL_MODE_CHOICES.map((choice) => {
        const selected = choice.required === value
        return (
          <ButtonBase
            key={choice.title}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice.required)}
            data-testid={
              choice.required ? 'approval-required-option' : 'approval-optional-option'
            }
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: '3px',
              textAlign: 'left',
              p: '13px 14px',
              borderRadius: '12px',
              border: '1.5px solid',
              borderColor: selected ? 'secondary.main' : 'rgba(16, 24, 40, 0.14)',
              bgcolor: selected ? 'rgba(15, 118, 110, 0.1)' : 'transparent',
              boxShadow: selected ? '0 0 0 3px rgba(15, 118, 110, 0.08)' : 'none',
              transition: 'all 0.15s ease',
              '&:hover': { borderColor: 'secondary.main' },
            }}
          >
            <Box
              component="span"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                fontSize: 13.5,
                fontWeight: 800,
              }}
            >
              <Box
                component="span"
                sx={{
                  width: 16,
                  height: 16,
                  flexShrink: 0,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  border: '1.5px solid',
                  borderColor: selected ? 'secondary.main' : 'rgba(16, 24, 40, 0.14)',
                  bgcolor: selected ? 'secondary.main' : 'transparent',
                  color: '#fff',
                }}
              >
                {selected ? <CheckGlyph size={10} /> : null}
              </Box>
              {choice.title}
            </Box>
            <Box
              component="span"
              sx={{
                fontSize: 11.5,
                fontWeight: 500,
                lineHeight: 1.45,
                color: 'text.secondary',
              }}
            >
              {choice.description}
            </Box>
          </ButtonBase>
        )
      })}
    </Box>
  )
}

// Prototype .seg / .seg-opt: three descriptive cards read as one choice. The
// selected card gets the teal border + tint + a filled tick. Selecting Capped
// reveals the dashed-teal .cap-row, where a segmented control picks whether the
// cap counts days, a share of the leftover, or a share of the whole annual
// allowance. Not the plain SegmentedControl for the policy itself: that control
// has no room for the per-option descriptions.
function CarryoverChoice({
  value,
  capDays,
  capMode,
  capPercent,
  onValueChange,
  onCapDaysChange,
  onCapModeChange,
  onCapPercentChange,
}: {
  value: CarryoverPolicy
  capDays: string
  capMode: CarryoverCapMode
  capPercent: string
  onValueChange: (value: CarryoverPolicy) => void
  onCapDaysChange: (value: string) => void
  onCapModeChange: (value: CarryoverCapMode) => void
  onCapPercentChange: (value: string) => void
}) {
  return (
    <Stack spacing={1.5}>
      <Box
        role="radiogroup"
        aria-label="Carryover policy"
        sx={{
          display: 'grid',
          gap: '10px',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
        }}
      >
        {CARRYOVER_CHOICES.map((choice) => {
          const selected = choice.value === value
          return (
            <ButtonBase
              key={choice.value}
              role="radio"
              aria-checked={selected}
              onClick={() => onValueChange(choice.value)}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '3px',
                textAlign: 'left',
                p: '13px 14px',
                borderRadius: '12px',
                border: '1.5px solid',
                borderColor: selected ? 'secondary.main' : 'rgba(16, 24, 40, 0.14)',
                bgcolor: selected ? 'rgba(15, 118, 110, 0.1)' : 'transparent',
                boxShadow: selected ? '0 0 0 3px rgba(15, 118, 110, 0.08)' : 'none',
                transition: 'all 0.15s ease',
                '&:hover': { borderColor: 'secondary.main' },
              }}
            >
              <Box
                component="span"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  fontSize: 13.5,
                  fontWeight: 800,
                }}
              >
                <Box
                  component="span"
                  sx={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    border: '1.5px solid',
                    borderColor: selected ? 'secondary.main' : 'rgba(16, 24, 40, 0.14)',
                    bgcolor: selected ? 'secondary.main' : 'transparent',
                    color: '#fff',
                  }}
                >
                  {selected ? <CheckGlyph size={10} /> : null}
                </Box>
                {choice.title}
              </Box>
              <Box
                component="span"
                sx={{
                  fontSize: 11.5,
                  fontWeight: 500,
                  lineHeight: 1.45,
                  color: 'text.secondary',
                }}
              >
                {choice.description}
              </Box>
            </ButtonBase>
          )
        })}
      </Box>
      {value === CarryoverPolicy.Capped ? (
        // The prototype's .cap-row reveal, read as one sentence on one
        // baseline: "Carry over at most 50 Percent". Every child is now a bare
        // 40px control with no label stacked above it, which is what lets the
        // row center honestly (a labelled stepper beside an unlabelled toggle
        // could never line up).
        <Box
          role="group"
          aria-label="Carryover cap"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            rowGap: 1.25,
            flexWrap: 'wrap',
            p: '12px 14px',
            border: '1px dashed rgba(15, 118, 110, 0.4)',
            bgcolor: 'rgba(15, 118, 110, 0.1)',
            borderRadius: '12px',
          }}
        >
          <Typography
            component="span"
            sx={{ fontSize: 13, fontWeight: 700, color: 'text.primary' }}
          >
            Carry over at most
          </Typography>
          {/* The value and its unit are one reading, so they group tighter than
              the sentence lead-in and can never wrap apart. That pairing is
              what gives the bare number its unit, with no end adornment. */}
          <Stack direction="row" spacing={1} alignItems="center">
            {capMode === CarryoverCapMode.Days ? (
              <DaysStepper
                hideLabel
                label="Days carried over"
                value={capDays}
                onChange={onCapDaysChange}
              />
            ) : (
              // Both percent modes edit the same number and differ only in what
              // it is a percentage of, so they share one stepper — switching
              // between them keeps the figure the admin typed.
              <DaysStepper
                hideLabel
                label="Percent carried over"
                value={capPercent}
                onChange={onCapPercentChange}
                max={100}
              />
            )}
            <SegmentedControl
              ariaLabel="Carryover cap unit"
              accent="secondary"
              // A step deeper than the panel's own 0.1 tint: the default cool
              // grey-blue track clashes with this teal surface.
              trackColor="rgba(15, 118, 110, 0.16)"
              sizing="content"
              value={capMode}
              onChange={onCapModeChange}
              options={CARRYOVER_CAP_MODE_OPTIONS}
            />
          </Stack>
        </Box>
      ) : null}
    </Stack>
  )
}

// Prototype .card-foot: a left-aligned note, then the panel's own Saved pill
// and Save button. Only the card that last triggered the shared save flow
// (`active`) shows the saving spinner / Saved confirmation / error.
function CardSaveFooter({
  note,
  active,
  state,
  label,
  onSave,
}: {
  note: string
  active: boolean
  state: SaveState
  label: string
  onSave: () => void
}) {
  const saving = active && state.status === 'saving'
  return (
    <Stack spacing={1.5}>
      {active && state.status === 'error' && state.error ? (
        <Alert severity="error">{state.error}</Alert>
      ) : null}
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        useFlexGap
      >
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
          {note}
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center">
          {active && state.status === 'success' ? (
            <Stack
              direction="row"
              spacing={0.5}
              alignItems="center"
              sx={{ color: 'success.main', fontSize: 12.5, fontWeight: 700 }}
            >
              <CheckGlyph size={14} />
              Saved
            </Stack>
          ) : null}
          <Button
            color="secondary"
            startIcon={
              saving ? (
                <CircularProgress size={18} color="inherit" />
              ) : (
                <SaveRoundedIcon />
              )
            }
            onClick={onSave}
            disabled={saving}
          >
            {label}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  )
}

export default function AdminSettingsPage({
  api = adminApi,
  initialSettings,
  initialHolidayCalendars,
  initialView,
  initialCalendarCountry,
  initialPolicies,
}: AdminSettingsPageProps) {
  const location = useLocation()
  const [settingsPanel, setSettingsPanel] = useState<PanelState<LeaveSettingsDto>>(() => ({
    status: initialSettings ? 'success' : 'idle',
    error: null,
    data: initialSettings ?? null,
  }))
  const [holidaysPanel, setHolidaysPanel] = useState<PanelState<HolidayCalendarDto[]>>(() => ({
    status: initialHolidayCalendars ? 'success' : 'idle',
    error: null,
    data: initialHolidayCalendars ? sortCalendars(initialHolidayCalendars) : null,
  }))
  const [defaultsForm, setDefaultsForm] = useState<DefaultsFormState>(
    initialSettings ? toDefaultsForm(initialSettings) : emptyDefaultsForm,
  )
  const [countryRows, setCountryRows] = useState<CountryDto[]>(
    initialSettings?.countries.map((country) => ({ ...country })) ?? [],
  )
  const [countryCatalog, setCountryCatalog] = useState<CountryCatalogEntryDto[]>(
    [],
  )
  const [employeeOptions, setEmployeeOptions] = useState<UserOption[]>([])
  const [settingsSaveState, setSettingsSaveState] = useState<SaveState>({
    status: 'idle',
    error: null,
  })
  // Which General card last triggered the shared save flow, so only that
  // card's footer reflects saving/saved/error.
  const [savingPanel, setSavingPanel] = useState<GeneralPanelKey | null>(null)
  const [holidaySaveState, setHolidaySaveState] = useState<SaveState>({
    status: 'idle',
    error: null,
  })

  // The add/edit country dialog. `editingCode` null means a new country;
  // editing never changes which country a row IS, since that would be a delete
  // plus an add.
  const [countryDialog, setCountryDialog] = useState<{
    editingCode: string | null
    code: string
    name: string
    timezone: string
  } | null>(null)
  const [countryDialogError, setCountryDialogError] = useState<string | null>(null)
  const [removingCountry, setRemovingCountry] = useState<CountryDto | null>(null)
  // Tracked separately from `countryCatalog` itself, which the work schedule
  // card reads as a plain array. Without it a mid-flight or failed catalog load
  // shows an empty picker with no explanation.
  const [catalogStatus, setCatalogStatus] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle')

  // Non-null means the calendar editor has REPLACED the country roster. Never
  // seeded from the loaded data: landing on the tab must show the roster, not
  // whichever country happened to sort first.
  const [openCalendarCountry, setOpenCalendarCountry] = useState<string | null>(
    initialCalendarCountry ? normalizeCountryCode(initialCalendarCountry) : null,
  )
  const [holidayYear, setHolidayYear] = useState<number | null>(
    initialCalendarCountry
      ? (initialHolidayCalendars ?? [])
          .filter(
            (calendar) =>
              calendar.country.code ===
              normalizeCountryCode(initialCalendarCountry),
          )
          .reduce<number | null>(
            (latest, calendar) =>
              latest === null || calendar.year > latest ? calendar.year : latest,
            null,
          )
      : null,
  )
  const [calendarName, setCalendarName] = useState<string>('')
  const [holidayRows, setHolidayRows] = useState<HolidayRow[]>([])
  const [newYear, setNewYear] = useState<string>('')
  // Deleting a calendar is destructive (drops the year's holidays), so it is
  // gated behind a confirmation dialog.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // Which Settings view is on screen (prototype .stabs). Each view keeps its
  // own independent save flow. Seeded from the SSR-test prop when given,
  // otherwise from the hash so /admin/settings#import deep-links work.
  const [settingsView, setSettingsView] = useState<SettingsView>(
    () => initialView ?? viewFromHash(location.hash),
  )

  // Switching tabs rewrites the hash without pushing history entries; the
  // guard keeps node-rendered tests (no window) from throwing.
  const selectSettingsView = (next: SettingsView) => {
    setSettingsView(next)
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const base = window.location.pathname + window.location.search
      window.history.replaceState(
        null,
        '',
        next === 'policies' ? base : `${base}#${next}`,
      )
    }
  }

  useEffect(() => {
    if (initialSettings && initialHolidayCalendars) {
      return
    }

    let active = true
    setSettingsPanel((current) => ({ ...current, status: 'loading', error: null }))
    setHolidaysPanel((current) => ({ ...current, status: 'loading', error: null }))

    Promise.all([api.getSettings(), api.listHolidays()])
      .then(([settings, holidays]) => {
        if (!active) {
          return
        }

        const sortedHolidays = sortCalendars(holidays)
        setSettingsPanel({ status: 'success', error: null, data: settings })
        setHolidaysPanel({ status: 'success', error: null, data: sortedHolidays })
        setDefaultsForm(toDefaultsForm(settings))
        setCountryRows(settings.countries.map((country) => ({ ...country })))
      })
      .catch((error: Error) => {
        if (!active) {
          return
        }
        setSettingsPanel({ status: 'error', error: error.message, data: null })
        setHolidaysPanel({ status: 'error', error: error.message, data: null })
      })

    return () => {
      active = false
    }
  }, [api, initialHolidayCalendars, initialSettings])

  // Catalog powering the country picker (add a country from a list, not free text).
  useEffect(() => {
    let active = true
    setCatalogStatus('loading')
    api
      .getCountryCatalog()
      .then((entries) => {
        if (active) {
          setCountryCatalog(entries)
          setCatalogStatus('success')
        }
      })
      .catch(() => {
        if (active) {
          setCountryCatalog([])
          setCatalogStatus('error')
        }
      })
    return () => {
      active = false
    }
  }, [api])

  // Directory powering the default approver/CC pickers (choose users from a
  // list, not free-text emails). A load failure degrades gracefully: stored
  // defaults still render as plain email chips and can be removed.
  useEffect(() => {
    let active = true
    api
      .getEmployeeOptions()
      .then((entries) => {
        if (active) {
          setEmployeeOptions(
            entries.map((entry) => ({
              userId: entry.employeeId,
              displayName: entry.displayName,
              email: entry.email,
            })),
          )
        }
      })
      .catch(() => {
        if (active) {
          setEmployeeOptions([])
        }
      })
    return () => {
      active = false
    }
  }, [api])

  // A user belongs in EITHER default approvers OR default CC, never both:
  // each picker's options exclude the other list's selection.
  const defaultApproverOptions = useMemo(
    () => excludeEmails(employeeOptions, defaultsForm.defaultCcApproverEmails),
    [employeeOptions, defaultsForm.defaultCcApproverEmails],
  )
  const defaultCcOptions = useMemo(
    () => excludeEmails(employeeOptions, defaultsForm.defaultApproverEmails),
    [employeeOptions, defaultsForm.defaultApproverEmails],
  )

  // Countries offered in the holiday picker: those defined in settings.
  // Years that exist for the selected country, plus the year being edited even
  // if it is a not-yet-saved new calendar.
  const yearOptions = useMemo(() => {
    const years = new Set<number>()
    for (const calendar of holidaysPanel.data ?? []) {
      if (calendar.country.code === openCalendarCountry) {
        years.add(calendar.year)
      }
    }
    if (holidayYear !== null) {
      years.add(holidayYear)
    }
    return [...years].sort((left, right) => left - right)
  }, [holidaysPanel.data, openCalendarCountry, holidayYear])

  // Saved calendar years grouped by country, powering the "All calendars"
  // overview (which years each country has) and the sensible-year pick when a
  // country is selected.
  // The country whose calendars are on screen. The roster draft first (its name
  // is what the admin just clicked), then the loaded calendars, since a country
  // can own one while its draft row has been removed.
  const openCountry = useMemo<CountryDto | null>(() => {
    if (!openCalendarCountry) {
      return null
    }
    const drafted = countryRows.find(
      (row) => normalizeCountryCode(row.code) === openCalendarCountry,
    )
    if (drafted) {
      return drafted
    }
    const fromCalendars = (holidaysPanel.data ?? []).find(
      (calendar) => calendar.country.code === openCalendarCountry,
    )?.country
    return fromCalendars ?? { code: openCalendarCountry, name: openCalendarCountry }
  }, [countryRows, holidaysPanel.data, openCalendarCountry])

  const calendarYearsByCountry = useMemo(() => {
    const byCountry = new Map<string, number[]>()
    for (const calendar of holidaysPanel.data ?? []) {
      const years = byCountry.get(calendar.country.code)
      if (years) {
        years.push(calendar.year)
      } else {
        byCountry.set(calendar.country.code, [calendar.year])
      }
    }
    for (const years of byCountry.values()) {
      years.sort((left, right) => left - right)
    }
    return byCountry
  }, [holidaysPanel.data])

  // Load the editable draft whenever the target calendar (country, year) or the
  // loaded data changes.
  useEffect(() => {
    const calendar = holidaysPanel.data?.find(
      (item) => item.country.code === openCalendarCountry && item.year === holidayYear,
    )
    setHolidayRows(
      calendar
        ? calendar.holidays.map((holiday) => ({
            id: nextHolidayRowId(),
            date: holiday.date,
            name: holiday.name,
          }))
        : [],
    )
    setCalendarName(calendar?.name ?? '')
  }, [holidaysPanel.data, openCalendarCountry, holidayYear])

  const applySavedCalendar = (saved: HolidayCalendarDto) => {
    setHolidaysPanel((current) => ({
      status: 'success',
      error: null,
      data: sortCalendars([
        ...(current.data ?? []).filter(
          (calendar) =>
            !(
              calendar.country.code === saved.country.code &&
              calendar.year === saved.year
            ),
        ),
        saved,
      ]),
    }))
  }

  // Each card writes ONLY its own fields and echoes the server's value for the
  // rest, so a draft in a neighbouring card is neither committed nor discarded.
  // buildSettingsPayload owns that rule; see its comment for what it does not
  // fix (two tabs can still clobber each other).
  //
  // `rows` overrides the country draft for callers that changed it in the same
  // tick, since state has not flushed yet when they call.
  const saveSettings = async (panel: GeneralPanelKey, rows?: CountryDto[]) => {
    const server = settingsPanel.data
    if (!server) {
      return false
    }
    setSavingPanel(panel)
    setSettingsSaveState({ status: 'saving', error: null })
    try {
      const saved = await api.updateSettings(
        buildSettingsPayload(panel, server, {
          carryoverPolicy: defaultsForm.carryoverPolicy,
          carryoverCapDays: defaultsForm.carryoverCapDays,
          carryoverCapMode: defaultsForm.carryoverCapMode,
          carryoverCapPercent: defaultsForm.carryoverCapPercent,
          approvalRequired: defaultsForm.approvalRequired,
          defaultApproverEmails: defaultsForm.defaultApproverEmails,
          defaultCcApproverEmails: defaultsForm.defaultCcApproverEmails,
          defaultTimezone: defaultsForm.defaultTimezone,
          countryRows: rows ?? countryRows,
        }),
      )
      setSettingsPanel({ status: 'success', error: null, data: saved })
      // Only the saving panel's draft is reset. A blanket reset would now
      // DISCARD a neighbouring card's draft instead of committing it, which
      // trades an unwanted write for silent data loss.
      if (panel === 'countries') {
        setCountryRows(saved.countries.map((country) => ({ ...country })))
      } else {
        setDefaultsForm((current) => reconcileSavedPanel(current, panel, saved))
      }
      setSettingsSaveState({ status: 'success', error: null })
      return true
    } catch (error) {
      setSettingsSaveState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to save settings.',
      })
      return false
    }
  }

  const saveHolidayCalendar = async () => {
    if (!openCalendarCountry || holidayYear === null) {
      setHolidaySaveState({
        status: 'error',
        error: 'Choose a country and a year before saving.',
      })
      return
    }
    setHolidaySaveState({ status: 'saving', error: null })
    try {
      const saved = await api.updateHolidayCalendar({
        countryCode: openCalendarCountry,
        year: holidayYear,
        name: calendarName.trim() || null,
        holidays: holidayRows
          .map((row) => ({ date: row.date.trim(), name: row.name.trim() }))
          .filter((row) => row.date !== ''),
      })
      applySavedCalendar(saved)
      setHolidaySaveState({ status: 'success', error: null })
    } catch (error) {
      setHolidaySaveState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to save holiday calendar.',
      })
    }
  }

  const addYear = () => {
    const parsed = Number(newYear)
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 3000) {
      setHolidaySaveState({ status: 'error', error: 'Enter a valid year to add.' })
      return
    }
    setNewYear('')
    setHolidaySaveState({ status: 'idle', error: null })
    setHolidayYear(parsed)
  }

  // Drill into one country's calendars, landing on its latest saved year. The
  // year resets to null when the country has none: carrying the PREVIOUS
  // country's year over drew it as a selected chip on a calendar that does not
  // exist.
  const saveCountries = async (rows: CountryDto[]) => {
    const previous = countryRows
    setCountryRows(rows)
    const ok = await saveSettings('countries', rows)
    if (!ok) {
      // The roster is shown optimistically, so a refusal would otherwise leave
      // the page insisting a country is gone while the server still has it --
      // and the next unrelated save would try to remove it all over again.
      setCountryRows(previous)
    }
    return ok
  }

  const openCalendar = (code: string) => {
    const normalized = normalizeCountryCode(code)
    setOpenCalendarCountry(normalized)
    const years = calendarYearsByCountry.get(normalized)
    setHolidayYear(years && years.length > 0 ? years[years.length - 1] : null)
    setHolidaySaveState({ status: 'idle', error: null })
  }

  // Back to the roster. A confirmation left open must not survive the exit.
  const closeCalendar = () => {
    setOpenCalendarCountry(null)
    setHolidayYear(null)
    setConfirmDeleteOpen(false)
    setHolidaySaveState({ status: 'idle', error: null })
  }

  const deleteCalendar = async () => {
    if (!openCalendarCountry || holidayYear === null) {
      return
    }
    setHolidaySaveState({ status: 'saving', error: null })
    try {
      await api.deleteHolidayCalendar({ countryCode: openCalendarCountry, year: holidayYear })
      const remaining = (holidaysPanel.data ?? []).filter(
        (calendar) =>
          !(calendar.country.code === openCalendarCountry && calendar.year === holidayYear),
      )
      setHolidaysPanel({ status: 'success', error: null, data: sortCalendars(remaining) })
      const nextYear =
        remaining.find((calendar) => calendar.country.code === openCalendarCountry)?.year ?? null
      setHolidayYear(nextYear)
      setHolidaySaveState({ status: 'success', error: null })
    } catch (error) {
      setHolidaySaveState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to delete calendar.',
      })
    }
  }

  const saving = holidaySaveState.status === 'saving'

  // Holidays summary (prototype .rows-sum): total count, plus how many land on a
  // weekend, flagged because those days never spend balance anyway.
  const weekendHolidayCount = holidayRows.filter(
    (row) => isRealIsoDate(row.date) && isWeekendIso(row.date),
  ).length

  // Per-card footer notes (prototype .foot-note), kept truthful to the form.
  const decidingCount = defaultsForm.defaultApproverEmails.length
  const ccCount = defaultsForm.defaultCcApproverEmails.length
  // In optional mode the deciding count would be a lie (nothing is routed to
  // them), so the note reports the rule instead of counting an inert list.
  const approverPanelNote = defaultsForm.approvalRequired
    ? `Approval required · ${decidingCount} deciding · ${ccCount} copied`
    : `Approval optional · deciding defaults kept, not applied · ${ccCount} copied on every request`
  const carryoverNote = describeCarryoverRule(
    defaultsForm.carryoverPolicy,
    defaultsForm.carryoverCapMode,
    defaultsForm.carryoverCapDays,
    defaultsForm.carryoverCapPercent,
  )
  const countriesWithCalendar = new Set(
    (holidaysPanel.data ?? []).map((calendar) => calendar.country.code),
  )
  const countriesNeedingCalendar = countryRows.filter(
    (country) => !countriesWithCalendar.has(normalizeCountryCode(country.code)),
  ).length
  const countriesNote =
    countryRows.length === 0
      ? 'No countries yet. Add one to enable holiday calendars.'
      : `${countryRows.length} ${countryRows.length === 1 ? 'country' : 'countries'}` +
        (countriesNeedingCalendar > 0
          ? ` · ${countriesNeedingCalendar} ${countriesNeedingCalendar === 1 ? 'needs' : 'need'} a calendar`
          : ' · all have calendars')

  return (
    <AdminLayout
      title="Settings"
      subtitle="Leave policies decide what every employee is entitled to. Countries and their holiday calendars decide which days count. Import and export move a whole year of leave in and out of the system."
      statusIndicator={
        <ShellStatusPill label="Live · saved changes apply immediately" />
      }
    >
      {/* Prototype .tabs: three views of one Settings surface, each with its
          own save flow. sizing="content" keeps the one-word tab from inflating
          to the width of the five-word one. */}
      <Box>
        <SegmentedControl
          ariaLabel="Settings section"
          accent="secondary"
          sizing="content"
          value={settingsView}
          onChange={selectSettingsView}
          options={[
            { value: 'policies', label: 'Policies', icon: <ShieldGlyph size={16} /> },
            {
              value: 'calendars',
              label: 'Countries and holiday calendars',
              icon: <GlobeGlyph size={16} />,
            },
            {
              value: 'import',
              label: 'Import',
              icon: <UploadGlyph size={16} />,
            },
            {
              value: 'export',
              label: 'Export',
              icon: <DownloadGlyph size={16} />,
            },
          ]}
        />
      </Box>

      {settingsView === 'import' || settingsView === 'export' ? (
        <ImportExportViews api={api} active={settingsView} />
      ) : settingsView === 'policies' ? (
        settingsPanel.status === 'loading' && !settingsPanel.data ? (
          <SectionCard
            title="Year-end carryover"
            caption="How unused days roll into the next leave year."
            icon={<SlidersGlyph />}
            accent="secondary"
          >
            <Stack spacing={1.5}>
              <Skeleton variant="rounded" height={56} />
              <Skeleton variant="rounded" height={120} />
              <Skeleton variant="rounded" height={140} />
            </Stack>
          </SectionCard>
        ) : (
          <>
            {settingsPanel.error ? (
              <Alert severity="error">{settingsPanel.error}</Alert>
            ) : null}

            <AdminPolicyCatalog
              api={api}
              today={new Date().toISOString().slice(0, 10)}
              {...(initialPolicies ? { initialPolicies } : {})}
            />
            {/* 2. Year-end carryover */}
            <SectionCard
              title="Year-end carryover"
              caption="What happens to unused vacation days when the leave year rolls over. Applies to vacation only: sick leave is re-granted in full each year, so its leftover always expires."
              icon={<UndoGlyph />}
              accent="secondary"
            >
              <Stack spacing={2.5}>
                <CarryoverChoice
                  value={defaultsForm.carryoverPolicy}
                  capDays={defaultsForm.carryoverCapDays}
                  capMode={defaultsForm.carryoverCapMode}
                  capPercent={defaultsForm.carryoverCapPercent}
                  onValueChange={(policy) => {
                    setDefaultsForm((current) => ({
                      ...current,
                      carryoverPolicy: policy,
                    }))
                  }}
                  onCapDaysChange={(value) => {
                    setDefaultsForm((current) => ({
                      ...current,
                      carryoverCapDays: value,
                    }))
                  }}
                  onCapModeChange={(mode) => {
                    setDefaultsForm((current) => ({
                      ...current,
                      carryoverCapMode: mode,
                    }))
                  }}
                  onCapPercentChange={(value) => {
                    setDefaultsForm((current) => ({
                      ...current,
                      carryoverCapPercent: value,
                    }))
                  }}
                />
                <CardSaveFooter
                  note={carryoverNote}
                  active={savingPanel === 'carryover'}
                  state={settingsSaveState}
                  label="Save policy"
                  onSave={() => {
                    void saveSettings('carryover')
                  }}
                />
              </Stack>
            </SectionCard>

            {/* 3. Approvals and default approvers */}
            <SectionCard
              title="Approvals and default approvers"
              caption="Whether leave requests need approval, and who is asked or copied by default. CC recipients are copied under either mode."
              icon={<PeopleGlyph />}
              accent="secondary"
            >
              <Stack spacing={2.5}>
                <ApprovalModeChoice
                  value={defaultsForm.approvalRequired}
                  onChange={(approvalRequired) => {
                    setDefaultsForm((current) => ({ ...current, approvalRequired }))
                  }}
                />

                {!defaultsForm.approvalRequired ? (
                  // The deciding defaults stay stored but stop being applied,
                  // and that has to be said where they are edited: a list that
                  // still shows two names while nothing is ever routed to them
                  // is the one way this setting can mislead.
                  <Alert
                    severity="warning"
                    icon={false}
                    data-testid="approval-optional-notice"
                    sx={{ borderRadius: '11px', fontSize: 12.5, lineHeight: 1.55 }}
                  >
                    <strong>Approval is optional.</strong> A request submitted
                    without a deciding approver is approved automatically with the
                    comment &quot;Processed automatically&quot;. The default
                    deciding approvers below are <strong>not applied</strong>; they
                    are kept for when the requirement is turned back on. A deciding
                    approver the employee picks still decides the request as usual,
                    and CC recipients are still copied on every request.
                  </Alert>
                ) : null}

                <Box
                  sx={
                    defaultsForm.approvalRequired
                      ? undefined
                      : { opacity: 0.55, filter: 'saturate(0.6)' }
                  }
                >
                  <UserMultiSelect
                    label={
                      defaultsForm.approvalRequired
                        ? 'Default approvers'
                        : 'Default approvers (not applied)'
                    }
                    placeholder="Search by name or email"
                    helperText={
                      defaultsForm.approvalRequired
                        ? 'Chosen from system users. Added to every new leave request as approvers the requester cannot remove.'
                        : 'Kept, but not applied while approval is optional. Turn the requirement back on and these apply again.'
                    }
                    value={defaultsForm.defaultApproverEmails}
                    onChange={(emails) => {
                      setDefaultsForm((current) => ({
                        ...current,
                        defaultApproverEmails: emails,
                      }))
                    }}
                    options={defaultApproverOptions}
                    chipStyle="neutral"
                    testId="default-approvers-select"
                  />
                </Box>

                <UserMultiSelect
                  label="Default CC recipients"
                  placeholder="Search by name or email"
                  helperText="Chosen from system users. Copied on every new leave request under either approval mode, as recipients the requester cannot remove. They are notified, they never decide."
                  value={defaultsForm.defaultCcApproverEmails}
                  onChange={(emails) => {
                    setDefaultsForm((current) => ({
                      ...current,
                      defaultCcApproverEmails: emails,
                    }))
                  }}
                  options={defaultCcOptions}
                  chipStyle="cc"
                  testId="default-cc-select"
                />
                <CardSaveFooter
                  note={approverPanelNote}
                  active={savingPanel === 'approvers'}
                  state={settingsSaveState}
                  label="Save approvers"
                  onSave={() => {
                    void saveSettings('approvers')
                  }}
                />
              </Stack>
            </SectionCard>

          </>
        )
      ) : !settingsPanel.data && settingsPanel.status !== 'error' ? (
        // Skeleton for every state that has no data yet, not just 'loading':
        // the panel starts 'idle', and a first paint on 'idle' showed the work
        // schedule's placeholder times as if they were the saved configuration.
        // On 'error' we fall through, so the alert below can say what broke.
        <SectionCard
          title="Countries and holiday calendars"
          caption="Countries you employ people in. Each needs a holiday calendar per leave year, so weekends and public holidays never charge a balance."
          icon={<GlobeGlyph />}
          accent="secondary"
        >
          <Stack spacing={1.5}>
            <Skeleton variant="rounded" height={48} />
            <Skeleton variant="rounded" height={48} />
            <Skeleton variant="rounded" height={48} />
          </Stack>
        </SectionCard>
      ) : (
        <>
            {settingsPanel.error ? (
              <Alert severity="error">{settingsPanel.error}</Alert>
            ) : null}

            {/* The roster. One row per country: who we employ people in, what
                zone their day ends in, and whether their calendars exist. The
                calendar link drills in, replacing this card with the editor. */}
            {openCalendarCountry === null ? (
            <SectionCard
              title="Countries and holiday calendars"
              caption="Countries you employ people in. Each needs a holiday calendar per leave year, so weekends and public holidays never charge a balance."
              icon={<GlobeGlyph />}
              accent="secondary"
              side={
                <Button
                  size="small"
                  variant="contained"
                  color="secondary"
                  startIcon={<AddRoundedIcon />}
                  onClick={() => {
                    setCountryDialog({
                      editingCode: null,
                      code: '',
                      name: '',
                      timezone: '',
                    })
                    setCountryDialogError(null)
                  }}
                >
                  Add country
                </Button>
              }
            >
              <Stack spacing={2}>
                {/* This card had nowhere to show a save failure at all: the
                    message landed in state and was never rendered, so a refused
                    country save looked like nothing happening. */}
                {savingPanel === 'countries' &&
                settingsSaveState.status === 'error' &&
                settingsSaveState.error ? (
                  <Alert severity="error">{settingsSaveState.error}</Alert>
                ) : null}
                <Stack spacing={1}>
                  {countryRows.length === 0 ? (
                    <Box
                      sx={{
                        border: '1px dashed',
                        borderColor: 'rgba(16, 24, 40, 0.14)',
                        borderRadius: '12px',
                        p: 3,
                        textAlign: 'center',
                        fontSize: 13.5,
                        color: 'text.secondary',
                      }}
                    >
                      No countries yet. Add the first one to enable its holiday
                      calendars.
                    </Box>
                  ) : null}
                  {countryRows.map((country, index) => {
                    const code = normalizeCountryCode(country.code)
                    const years = calendarYearsByCountry.get(code) ?? []
                    // The server refuses to remove a country anything still
                    // points at, and the row used to simply reappear with no
                    // reason given. The greyed-out button carries the reason
                    // now, so it is never a mystery.
                    const removalProblem = countryRemovalProblem(country, years)
                    return (
                      <Stack
                        key={country.code || index}
                        direction="row"
                        spacing={1.625}
                        alignItems="center"
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: '12px',
                          p: '11px 14px',
                        }}
                      >
                        <Box
                          component="span"
                          aria-hidden
                          sx={{
                            width: 34,
                            height: 26,
                            flexShrink: 0,
                            borderRadius: '6px',
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 11,
                            fontWeight: 800,
                            color: '#fff',
                            bgcolor: countryBadgeColor(code),
                          }}
                        >
                          {code}
                        </Box>
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
                            {country.name}
                          </Typography>
                          {country.timezone ? (
                            <Typography sx={{ fontSize: 12, color: '#667085' }}>
                              {country.timezone}
                            </Typography>
                          ) : (
                            <Typography
                              sx={{ fontSize: 12, color: 'warning.dark', fontWeight: 700 }}
                            >
                              No timezone set
                            </Typography>
                          )}
                        </Box>
                        <Typography
                          sx={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
                        >
                          {years.length > 0 ? (
                            <Box component="span" sx={{ color: 'secondary.main' }}>
                              {years.length}{' '}
                              {years.length === 1 ? 'calendar' : 'calendars'}
                              <Box
                                component="span"
                                sx={{ color: 'text.secondary', fontWeight: 600 }}
                              >
                                {' · '}
                                {years.join(', ')}
                              </Box>
                            </Box>
                          ) : (
                            <Box component="span" sx={{ color: 'warning.dark' }}>
                              No calendar yet
                            </Box>
                          )}
                        </Typography>
                        <ButtonBase
                          onClick={() => {
                            openCalendar(code)
                          }}
                          sx={{
                            flexShrink: 0,
                            gap: '6px',
                            px: '10px',
                            py: '5px',
                            borderRadius: '8px',
                            fontFamily: 'inherit',
                            fontSize: 12.5,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                            color: 'secondary.main',
                            '&:hover': { bgcolor: 'rgba(15, 118, 110, 0.1)' },
                          }}
                        >
                          {years.length > 0 ? 'Manage calendar' : 'Add calendar'}
                          <ArrowGlyph size={13} />
                        </ButtonBase>
                        <IconButton
                          aria-label={`Edit ${country.name}`}
                          size="small"
                          sx={{ flexShrink: 0, color: 'text.secondary' }}
                          onClick={() => {
                            setCountryDialog({
                              editingCode: code,
                              code,
                              name: country.name,
                              timezone: country.timezone ?? '',
                            })
                            setCountryDialogError(null)
                          }}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                        {/* The span is load-bearing: MUI sets pointer-events:
                            none on a disabled ButtonBase, so a tooltip attached
                            to the button itself never fires and the explanation
                            would be invisible to everyone. The wrapper still
                            receives the hover. The reason is on the label too,
                            since a tooltip is hover-only and a disabled button
                            is out of the tab order. */}
                        <Tooltip title={removalProblem ?? ''}>
                          <Box
                            component="span"
                            sx={{ display: 'inline-flex', flexShrink: 0 }}
                          >
                            <IconButton
                              aria-label={
                                removalProblem
                                  ? `Remove ${country.name}. ${removalProblem}`
                                  : `Remove ${country.name}`
                              }
                              size="small"
                              disabled={removalProblem !== null}
                              sx={deleteIconSx}
                              onClick={() => {
                                setRemovingCountry(country)
                              }}
                            >
                              <DeleteOutlineRoundedIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </Tooltip>
                      </Stack>
                    )
                  })}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {countriesNote}
                </Typography>
              </Stack>
            </SectionCard>
            ) : (
            <Stack spacing={2}>
              <Box>
                <Button
                  variant="text"
                  onClick={closeCalendar}
                  startIcon={
                    <Box
                      component="span"
                      sx={{ display: 'inline-flex', transform: 'rotate(180deg)' }}
                    >
                      <ChevronGlyph size={15} />
                    </Box>
                  }
                  sx={{
                    px: 1,
                    minHeight: 34,
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#667085',
                    '&:hover': { color: 'secondary.main', bgcolor: 'transparent' },
                  }}
                >
                  All countries
                </Button>
              </Box>
            <SectionCard
              title={`${openCountry?.name ?? openCalendarCountry} holiday calendars`}
              caption="One calendar per leave year. Request calculations exclude these non-working days."
              icon={<CalendarGlyph />}
              accent="secondary"
            >
              <Stack
                spacing={2.5}
                sx={tealFocusSx}
              >
                {holidaysPanel.error ? (
                  <Alert severity="error">{holidaysPanel.error}</Alert>
                ) : null}
                {holidaySaveState.status === 'error' && holidaySaveState.error ? (
                  <Alert severity="error">{holidaySaveState.error}</Alert>
                ) : null}

                {holidaysPanel.status === 'loading' && !holidaysPanel.data ? (
                  <Stack spacing={1.5}>
                    <Skeleton variant="rounded" height={56} />
                    <Skeleton variant="rounded" height={220} />
                  </Stack>
                ) : (
                  <>
                    {/* The country is already chosen by drilling in, so the
                        picker row carries only the leave year. */}
                      <Box sx={{ flex: 1, minWidth: 240 }}>
                        <Typography component="span" sx={capsLabelSx}>
                          Leave year
                        </Typography>
                        <Box
                          sx={{
                            display: 'flex',
                            gap: 0.875,
                            flexWrap: 'wrap',
                            alignItems: 'center',
                          }}
                        >
                          {yearOptions.map((year) => {
                            const selected = year === holidayYear
                            return (
                              // Prototype .ychip: a hairline chip that turns
                              // teal on hover and fills teal when picked. MUI's
                              // outlined Chip palette rings it in a mid grey
                              // far heavier than every other line on the card.
                              <ButtonBase
                                key={year}
                                aria-pressed={selected}
                                onClick={() => {
                                  setHolidayYear(year)
                                  setHolidaySaveState({ status: 'idle', error: null })
                                }}
                                sx={{
                                  height: 40,
                                  px: '14px',
                                  borderRadius: '10px',
                                  border: '1px solid',
                                  fontFamily: 'inherit',
                                  fontSize: 13,
                                  fontWeight: 800,
                                  fontVariantNumeric: 'tabular-nums',
                                  transition: 'all 0.15s ease',
                                  ...(selected
                                    ? {
                                        color: '#fff',
                                        bgcolor: 'secondary.main',
                                        borderColor: 'secondary.main',
                                        boxShadow:
                                          '0 6px 14px -8px rgba(15, 118, 110, 0.5)',
                                      }
                                    : {
                                        color: 'text.secondary',
                                        borderColor: 'rgba(16, 24, 40, 0.14)',
                                        bgcolor: 'background.paper',
                                        '&:hover': {
                                          color: 'secondary.main',
                                          borderColor: 'secondary.main',
                                        },
                                      }),
                                }}
                              >
                                {year}
                              </ButtonBase>
                            )
                          })}
                          {/* Prototype .addyear: a small year input + a dashed
                              teal affordance to create a NEW (empty) calendar. */}
                          <Box
                            sx={{ display: 'inline-flex', gap: 0.75, alignItems: 'center' }}
                          >
                            <TextField
                              size="small"
                              placeholder="Year"
                              value={newYear}
                              slotProps={{
                                htmlInput: {
                                  'aria-label': 'New year',
                                  inputMode: 'numeric',
                                  maxLength: 4,
                                  style: {
                                    textAlign: 'center',
                                    fontVariantNumeric: 'tabular-nums',
                                  },
                                },
                              }}
                              sx={{
                                width: 92,
                                '& .MuiOutlinedInput-root': {
                                  height: 40,
                                  fontSize: 13,
                                  fontWeight: 800,
                                },
                              }}
                              onChange={(event) => {
                                setNewYear(event.target.value)
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  addYear()
                                }
                              }}
                            />
                            <Button
                              variant="outlined"
                              color="secondary"
                              size="small"
                              startIcon={<AddRoundedIcon />}
                              onClick={addYear}
                              sx={{
                                borderStyle: 'dashed',
                                height: 40,
                                minHeight: 40,
                                px: '14px',
                                fontSize: 13,
                              }}
                            >
                              Add year
                            </Button>
                          </Box>
                        </Box>
                      </Box>

                    <Box sx={{ maxWidth: 360 }}>
                      <Typography
                        component="label"
                        htmlFor="calendar-name"
                        sx={capsLabelSx}
                      >
                        Calendar name (optional)
                      </Typography>
                      <TextField
                        id="calendar-name"
                        value={calendarName}
                        placeholder={`${openCalendarCountry ?? ''} ${holidayYear ?? ''}`.trim()}
                        onChange={(event) => {
                          setCalendarName(event.target.value)
                        }}
                      />
                    </Box>

                    <Stack spacing={1.5}>
                      {/* Prototype .rows-head: "Holidays" with a right-aligned
                          count summary (weekend tally in the warning color). */}
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontSize: 13, fontWeight: 800 }}>
                          Holidays
                        </Typography>
                        <Typography
                          component="span"
                          sx={{
                            ml: 'auto',
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'text.secondary',
                          }}
                        >
                          <Box component="span" sx={{ color: 'text.primary', fontWeight: 700 }}>
                            {holidayRows.length}
                          </Box>{' '}
                          {holidayRows.length === 1 ? 'holiday' : 'holidays'}
                          {weekendHolidayCount > 0 ? (
                            <>
                              {' · '}
                              <Box
                                component="span"
                                sx={{ color: 'warning.dark', fontWeight: 700 }}
                              >
                                {weekendHolidayCount} on a weekend
                              </Box>
                            </>
                          ) : null}
                        </Typography>
                      </Stack>

                      {holidayRows.length === 0 ? (
                        // Prototype .empty: dashed panel inviting the first row.
                        <Box
                          sx={{
                            border: '1px dashed',
                            borderColor: 'rgba(16, 24, 40, 0.14)',
                            borderRadius: '12px',
                            p: 3,
                            textAlign: 'center',
                            fontSize: 13.5,
                            color: 'text.secondary',
                          }}
                        >
                          No holidays for this calendar yet. Add the first one below.
                        </Box>
                      ) : null}
                      {holidayRows.map((row, index) => {
                        // Prototype .hdow: the weekday derived from the date,
                        // UTC-pinned like every other holiday-date read; weekends
                        // read "Sat · wknd" in the warning color.
                        const validDate = isRealIsoDate(row.date)
                        const weekend = validDate && isWeekendIso(row.date)
                        const dowLabel = validDate
                          ? WEEKDAY_LABELS[holidayDayOfWeek(row.date)]
                          : '··'
                        return (
                          // Prototype .hrow: each holiday is a bordered row holding
                          // the date, a weekday badge, the name field, and a delete
                          // that reddens on hover.
                          <Stack
                            key={row.id}
                            direction="row"
                            spacing={1.25}
                            alignItems="center"
                            sx={{
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: '12px',
                              p: '7px 11px',
                              transition: 'border-color 0.15s ease',
                              '&:hover': { borderColor: 'rgba(16, 24, 40, 0.14)' },
                              // Compact the inputs to the prototype .hrow height
                              // (MUI small is taller than the mock's 34px rows).
                              '& .MuiOutlinedInput-root': { height: 38, fontSize: 13.5 },
                              '& .MuiInputLabel-root': { fontSize: 13 },
                            }}
                          >
                            <DateField
                              // Empty label, not a missing one: repeating
                              // "Date" and "Holiday name" down 13 rows turns an
                              // editable table into a wall of captions. The
                              // accessible name comes from ariaLabel instead.
                              label=""
                              value={row.date}
                              ariaLabel={`Holiday date ${index + 1}`}
                              sx={{
                                width: 172,
                                flexShrink: 0,
                                '& input': {
                                  fontWeight: 600,
                                  fontVariantNumeric: 'tabular-nums',
                                },
                              }}
                              onChange={(value) => {
                                setHolidayRows((rows) =>
                                  rows.map((current) =>
                                    current.id === row.id ? { ...current, date: value } : current,
                                  ),
                                )
                              }}
                            />
                            <Box
                              component="span"
                              sx={{
                                minWidth: 66,
                                flexShrink: 0,
                                textAlign: 'center',
                                fontSize: 11,
                                fontWeight: 700,
                                color: weekend ? 'warning.dark' : 'text.secondary',
                              }}
                            >
                              {weekend ? `${dowLabel} · wknd` : dowLabel}
                            </Box>
                            <TextField
                              value={row.name}
                              fullWidth
                              placeholder="Holiday name"
                              slotProps={{ htmlInput: { 'aria-label': `Holiday name ${index + 1}` } }}
                              onChange={(event) => {
                                const value = event.target.value
                                setHolidayRows((rows) =>
                                  rows.map((current, rowIndex) =>
                                    rowIndex === index ? { ...current, name: value } : current,
                                  ),
                                )
                              }}
                            />
                            <IconButton
                              aria-label={`Remove holiday ${index + 1}`}
                              size="small"
                              sx={{ ...deleteIconSx, width: 32, height: 32 }}
                              onClick={() => {
                                setHolidayRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
                              }}
                            >
                              <DeleteOutlineRoundedIcon />
                            </IconButton>
                          </Stack>
                        )
                      })}
                      <Button
                        variant="outlined"
                        color="secondary"
                        startIcon={<AddRoundedIcon />}
                        disabled={holidayYear === null}
                        onClick={() => {
                          setHolidayRows((rows) => [
                            ...rows,
                            {
                              id: nextHolidayRowId(),
                              date: holidayYear !== null ? `${holidayYear}-01-01` : '',
                              name: '',
                            },
                          ])
                        }}
                        sx={{
                          borderStyle: 'dashed',
                          borderRadius: '12px',
                          justifyContent: 'center',
                          fontSize: 13,
                          minHeight: 42,
                          '&:hover': {
                            borderStyle: 'dashed',
                            bgcolor: 'rgba(15, 118, 110, 0.06)',
                          },
                        }}
                      >
                        Add holiday
                      </Button>
                    </Stack>

                    {/* Prototype .card-foot: the actions sit in the card's own
                        recessed strip, with the destructive one kept at the far
                        end from "Add holiday" above, so the calendar is not
                        deleted by a misclick meant for adding a row. */}
                    <Stack
                      direction="row"
                      justifyContent="space-between"
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                      sx={{
                        gap: 1.25,
                        mx: { xs: -2.5, md: -3 },
                        mb: { xs: -2.5, md: -3 },
                        px: { xs: 2.5, md: 3 },
                        py: 1.75,
                        borderTop: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'rgba(16, 24, 40, 0.015)',
                      }}
                    >
                      <Button
                        color="error"
                        variant="outlined"
                        startIcon={<DeleteOutlineRoundedIcon />}
                        disabled={holidayYear === null || saving}
                        onClick={() => {
                          setConfirmDeleteOpen(true)
                        }}
                      >
                        Delete calendar
                      </Button>
                      <Stack direction="row" spacing={1.5} alignItems="center">
                        {holidaySaveState.status === 'success' ? (
                          <Stack
                            direction="row"
                            spacing={0.5}
                            alignItems="center"
                            sx={{
                              color: 'success.main',
                              fontSize: 12.5,
                              fontWeight: 700,
                            }}
                          >
                            <CheckGlyph size={14} />
                            Saved
                          </Stack>
                        ) : null}
                        <Button
                          color="secondary"
                          startIcon={
                            saving ? (
                              <CircularProgress size={18} color="inherit" />
                            ) : (
                              <SaveRoundedIcon />
                            )
                          }
                          disabled={holidayYear === null || saving}
                          onClick={() => {
                            void saveHolidayCalendar()
                          }}
                        >
                          Save calendar
                        </Button>
                      </Stack>
                    </Stack>
                  </>
                )}
              </Stack>
            </SectionCard>

              {/* Prototype .note: blue-tinted info box explaining how these
                  dates flow into employee calculations. */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1.25,
                  p: '13px 14px',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '12px',
                  bgcolor: 'rgba(21, 94, 239, 0.03)',
                }}
              >
                <Box
                  component="svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                  sx={{ width: 18, height: 18, flexShrink: 0, mt: '1px', color: 'primary.main' }}
                >
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M12 8h.01M11 12h1v4h1"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Box>
                <Typography sx={{ fontSize: 12.5, lineHeight: 1.5, color: 'text.secondary' }}>
                  Employees see these dates in their{' '}
                  <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>
                    Holiday calendars
                  </Box>{' '}
                  view. A working-day request that spans a holiday or weekend
                  automatically skips those days when balances are calculated.
                </Typography>
              </Box>
            </Stack>
            )}

        </>
      )}

      {/* One dialog for adding and for editing. It commits straight away, like
          the policy dialog it mirrors: since each card now saves only its own
          fields, a country write no longer drags a neighbouring card's draft
          along, and there is never an unsaved row whose calendar cannot be
          opened. */}
      {countryDialog ? (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          onClose={() => setCountryDialog(null)}
          aria-labelledby="country-dialog-title"
        >
          <DialogTitle id="country-dialog-title">
            {countryDialog.editingCode ? 'Country settings' : 'Add a country'}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2} sx={{ pt: 1, ...tealFocusSx }}>
              {countryDialogError ? (
                <Alert severity="error">{countryDialogError}</Alert>
              ) : null}

              {catalogStatus === 'error' ? (
                <Alert severity="error">
                  The country catalog could not be loaded, so there is nothing
                  to pick from.
                </Alert>
              ) : null}

              {countryDialog.editingCode ? (
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Box
                    component="span"
                    aria-hidden
                    sx={{
                      width: 34,
                      height: 26,
                      flexShrink: 0,
                      borderRadius: '6px',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 800,
                      color: '#fff',
                      bgcolor: countryBadgeColor(countryDialog.code),
                    }}
                  >
                    {countryDialog.code}
                  </Box>
                  <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
                    {countryDialog.name}
                  </Typography>
                </Stack>
              ) : (
                <Autocomplete
                  options={countryCatalog.filter(
                    (entry) =>
                      !countryRows.some(
                        (row) => normalizeCountryCode(row.code) === entry.code,
                      ),
                  )}
                  getOptionLabel={(option) => `${option.name} (${option.code})`}
                  value={
                    countryCatalog.find(
                      (entry) => entry.code === countryDialog.code,
                    ) ?? null
                  }
                  loading={catalogStatus === 'loading'}
                  onChange={(_event, entry) => {
                    setCountryDialog((current) =>
                      current
                        ? {
                            ...current,
                            code: entry?.code ?? '',
                            name: entry?.name ?? '',
                            // Pre-filled with the catalog's representative zone;
                            // a multi-zone country can then be pinned below.
                            timezone: entry?.timezone ?? '',
                          }
                        : current,
                    )
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Country"
                      placeholder="Search countries..."
                    />
                  )}
                />
              )}

              <TextField
                select
                label="Timezone"
                value={countryDialog.timezone}
                disabled={!countryDialog.code}
                helperText="A leave day is spent at midnight on this zone's calendar, and the leave year turns over on it too."
                onChange={(event) => {
                  const timezone = event.target.value
                  setCountryDialog((current) =>
                    current ? { ...current, timezone } : current,
                  )
                }}
              >
                {countryTimezoneOptions(
                  countryCatalog,
                  countryDialog.code,
                  countryDialog.timezone,
                ).map((tz) => (
                  <MenuItem key={tz} value={tz}>
                    {tz}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => setCountryDialog(null)}
              color="inherit"
              disabled={savingPanel === 'countries' && settingsSaveState.status === 'saving'}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="secondary"
              disabled={savingPanel === 'countries' && settingsSaveState.status === 'saving'}
              onClick={() => {
                const draft = countryDialog
                const problem = countryDraftProblem(draft, countryRows, countryCatalog)
                if (problem) {
                  setCountryDialogError(problem)
                  return
                }
                const code = normalizeCountryCode(draft.code)
                const next: CountryDto[] = draft.editingCode
                  ? countryRows.map((row) =>
                      normalizeCountryCode(row.code) === draft.editingCode
                        ? { ...row, timezone: draft.timezone }
                        : row,
                    )
                  : [
                      ...countryRows,
                      { code, name: draft.name, timezone: draft.timezone },
                    ]
                void saveCountries(next).then((ok) => {
                  if (ok) {
                    setCountryDialog(null)
                  }
                })
              }}
            >
              {countryDialog.editingCode ? 'Save' : 'Add country'}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {removingCountry ? (
        <Dialog
          open
          onClose={() => setRemovingCountry(null)}
          aria-labelledby="remove-country-title"
        >
          <DialogTitle id="remove-country-title">
            Remove {removingCountry.name}?
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={1.5}>
              <Typography variant="body2" color="text.secondary">
                Nothing points at this country: nobody is assigned to it and it
                has no holiday calendars. Removing it only takes it off this
                list.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                If someone from this country signs in later, it is added back on
                its own, with the catalog timezone rather than any zone that was
                pinned here.
              </Typography>
              {/* The refusal can still arrive: this page may have been loaded
                  before a new hire landed in the country. Say it where the
                  click happened, not only on the card behind the dialog. */}
              {savingPanel === 'countries' &&
              settingsSaveState.status === 'error' &&
              settingsSaveState.error ? (
                <Alert severity="error">{settingsSaveState.error}</Alert>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="outlined"
              color="inherit"
              onClick={() => setRemovingCountry(null)}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => {
                const target = normalizeCountryCode(removingCountry.code)
                void saveCountries(
                  countryRows.filter(
                    (row) => normalizeCountryCode(row.code) !== target,
                  ),
                ).then((ok) => {
                  if (ok) {
                    setRemovingCountry(null)
                  }
                })
              }}
            >
              Remove
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      <Dialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        aria-labelledby="delete-calendar-title"
      >
        <DialogTitle id="delete-calendar-title">
          Delete this calendar?
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 14 }}>
            This permanently removes the{' '}
            <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>
              {openCountry?.name ?? openCalendarCountry} {holidayYear}
            </Box>{' '}
            holiday calendar and every holiday in it. Employees in this country
            will no longer see these dates, and this cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            variant="outlined"
            color="inherit"
            onClick={() => setConfirmDeleteOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            startIcon={
              saving ? (
                <CircularProgress size={18} color="inherit" />
              ) : (
                <DeleteOutlineRoundedIcon />
              )
            }
            disabled={saving}
            onClick={() => {
              void deleteCalendar().finally(() => setConfirmDeleteOpen(false))
            }}
          >
            Delete calendar
          </Button>
        </DialogActions>
      </Dialog>
    </AdminLayout>
  )
}
