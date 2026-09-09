/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link as RouterLink } from 'react-router-dom'
import FilterAltOffRoundedIcon from '@mui/icons-material/FilterAltOffRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import Skeleton from '@mui/material/Skeleton'
import { alpha } from '@mui/material/styles'
import type {
  AdminEmployeeDetailDto,
  AdminEmployeeFilterOptionsDto,
  AdminEmployeeListDto,
  AdminEmployeeListItemDto,
  AppRoleName,
  CountryDto,
  DirectorySyncResultDto,
  DirectorySyncStatusDto,
} from '@workspace/contracts'
import {
  AppRoleName as AppRoleNameEnum,
  EmployeeProfileFilter,
  EmployeeProfileStatus,
} from '@workspace/contracts'
import { DateRangeField } from '../../components/date-picker'
import { FixedSizeList, type ListChildComponentProps } from 'react-window'
import { ShellStatusPill } from '../../components/layout/AppShell'
import {
  ApproverAvatar,
  BalanceMeter,
  ChevronGlyph,
  MetricTile,
  SectionCard,
  StatusPill,
} from '../employee/employee-ui'
import { AdminLayout } from './AdminLayout'
import {
  directorySyncChangedAccounts,
  directorySyncFeedback,
} from './directory-sync-messages'
import { useDirectorySyncRun } from './use-directory-sync-run'
import { adminApi, type AdminApiClient } from './admin-api'
import {
  countryLabel,
  formatDate,
  formatRoleName,
  summarizeEmployees,
} from './admin-formatters'
import { appendKeysetPage } from './keyset-paging'
import { adoptWorkdayHours, workdayHoursOf } from '../../lib/leave-format'
import {
  distinguishingRoles,
  EmployeeIdValue,
  Fact,
  InactiveFlag,
  NeedsSetupFlag,
  NotSet,
  profileStatusLabel,
  RoleChip,
} from './AdminEmployeeProfilePage'

const LIST_MAX_HEIGHT = 720
const EMPLOYEE_ROW_HEIGHT = 80
const LOAD_MORE_THRESHOLD = 4
const LIST_RING_INSET = 3
const LIST_WIDTH_FALLBACK = 480

type AdminEmployeesPageProps = {
  api?: AdminApiClient
  initialEmployees?: AdminEmployeeListDto
  initialEmployeeDetail?: AdminEmployeeDetailDto
  initialCountries?: CountryDto[]
  initialFilterOptions?: AdminEmployeeFilterOptionsDto
  initialDirectorySyncStatus?: DirectorySyncStatusDto
}

type EmployeeListFilters = {
  search: string
  roleName: AppRoleName | ''
  // '' means "no filter" — toQueryString drops empty values, so the request
  // omits the param entirely.
  countryCode: string
  projectId: string
  // The employee's CURRENT policy: the membership covering today.
  policyId: string
  // The account status is a boolean in the contract, but the select works in
  // strings and needs the same '' sentinel as its neighbours, so the string
  // form travels all the way: 'true'/'false' is what the API parses the boolean
  // back from.
  active: '' | 'true' | 'false'
  profile: EmployeeProfileFilter | ''
  // Both ends of the employment-start range, '' while unset. They are one
  // filter to the reader but two fields on the wire, and DateRangeField commits
  // them together on Done, so choosing a window costs one refetch rather than
  // one per end.
  employmentStartDateFrom: string
  employmentStartDateTo: string
}

type ListState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminEmployeeListDto
  loadingMore: boolean
  // The filters the visible data was built with. Every first-page load stores
  // a fresh object, so reference identity names one listing — the staleness
  // check in appendEmployeesPage relies on it.
  applied: EmployeeListFilters
}

type DetailState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
  data: AdminEmployeeDetailDto | null
  employeeId: string | null
}

// See AdminActivityPage's emptyFeed: a pre-response seed, replaced whole by the
// first payload.
const emptyList: AdminEmployeeListDto = {
  items: [],
  hoursPerDay: workdayHoursOf(),
}
// Where the directory starts, and where "Clear filters" returns it to. Only
// `active` is not blank: a deactivated employee is a departed one, so the
// working directory is the active population and seeing the leavers is the
// question an admin asks deliberately. The header cards ignore every filter
// (see getAdminEmployeeTotals), and the two role cards count active holders —
// so under this default they agree with the visible list, and it is the
// non-default choices (Deactivated, All accounts) that make them disagree;
// Accounts stays directory-wide either way.
const defaultEmployeeFilters: EmployeeListFilters = {
  search: '',
  roleName: '',
  countryCode: '',
  projectId: '',
  policyId: '',
  active: 'true',
  profile: '',
  employmentStartDateFrom: '',
  employmentStartDateTo: '',
}
const emptyFilterOptions: AdminEmployeeFilterOptionsDto = {
  countries: [],
  projects: [],
  policies: [],
}

// Every filter select states the scope it is currently showing, "All …"
// included. Without displayEmpty MUI renders a chosen '' as a zero-width space,
// so the widest option reads as an empty box — and while the field holds focus
// the label stays raised above that emptiness, which looks like a control that
// failed rather than one showing everything. Pinning shrink keeps the label up
// in both states instead of dropping into the box only when the value is blank.
const SELECT_SHOWS_SCOPE = {
  SelectProps: { displayEmpty: true },
  InputLabelProps: { shrink: true },
} as const

// Field-by-field, so that adding a filter to EmployeeListFilters extends every
// comparison at once instead of needing one more clause somewhere.
function sameFilters(
  left: EmployeeListFilters,
  right: EmployeeListFilters,
): boolean {
  return (Object.keys(left) as Array<keyof EmployeeListFilters>).every(
    (key) => left[key] === right[key],
  )
}

export default function AdminEmployeesPage({
  api = adminApi,
  initialEmployees,
  initialEmployeeDetail,
  initialCountries,
  initialFilterOptions,
  initialDirectorySyncStatus,
}: AdminEmployeesPageProps) {
  const [countries, setCountries] = useState<CountryDto[]>(initialCountries ?? [])
  const [filterOptions, setFilterOptions] =
    useState<AdminEmployeeFilterOptionsDto>(
      initialFilterOptions ?? emptyFilterOptions,
    )
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<AppRoleName | ''>(
    defaultEmployeeFilters.roleName,
  )
  const [countryFilter, setCountryFilter] = useState(
    defaultEmployeeFilters.countryCode,
  )
  const [projectFilter, setProjectFilter] = useState(
    defaultEmployeeFilters.projectId,
  )
  const [policyFilter, setPolicyFilter] = useState(
    defaultEmployeeFilters.policyId,
  )
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>(
    defaultEmployeeFilters.active,
  )
  const [profileFilter, setProfileFilter] = useState<EmployeeProfileFilter | ''>(
    defaultEmployeeFilters.profile,
  )
  // Two plain strings rather than one range object, so that re-committing the
  // same range is a no-op: React bails out of a state write that changes no
  // primitive, while a fresh {startDate, endDate} would be a new identity every
  // time and refetch the directory on a Done that changed nothing. Both are set
  // in one handler, so they still land in a single render.
  const [employmentFrom, setEmploymentFrom] = useState(
    defaultEmployeeFilters.employmentStartDateFrom,
  )
  const [employmentTo, setEmploymentTo] = useState(
    defaultEmployeeFilters.employmentStartDateTo,
  )
  const [listRetry, setListRetry] = useState(0)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
    initialEmployeeDetail?.employeeId ?? initialEmployees?.items[0]?.employeeId ?? null,
  )
  const [listState, setListState] = useState<ListState>(() => ({
    status: initialEmployees ? 'success' : 'idle',
    error: null,
    data: initialEmployees ?? emptyList,
    loadingMore: false,
    applied: defaultEmployeeFilters,
  }))
  const [detailState, setDetailState] = useState<DetailState>(() => ({
    status: initialEmployeeDetail ? 'success' : 'idle',
    error: null,
    data: initialEmployeeDetail ?? null,
    employeeId: initialEmployeeDetail?.employeeId ?? null,
  }))
  const [detailRetry, setDetailRetry] = useState(0)
  // Read off the live filter state rather than listState.applied, so the
  // control disappears the moment the last filter is cleared instead of one
  // fetch later. Search counts twice on purpose — what is typed AND what has
  // settled — because either alone leaves a window where something is filtering
  // and nothing offers to undo it: a half-typed query the debounce has not
  // delivered yet, or a delivered one the admin has already backspaced away.
  const filtersAreDefault =
    searchInput.trim() === defaultEmployeeFilters.search &&
    sameFilters(
      {
        search: appliedSearch,
        roleName: roleFilter,
        countryCode: countryFilter,
        projectId: projectFilter,
        policyId: policyFilter,
        active: activeFilter,
        profile: profileFilter,
        employmentStartDateFrom: employmentFrom,
        employmentStartDateTo: employmentTo,
      },
      defaultEmployeeFilters,
    )
  const clearFilters = useCallback(() => {
    setSearchInput(defaultEmployeeFilters.search)
    setAppliedSearch(defaultEmployeeFilters.search)
    setRoleFilter(defaultEmployeeFilters.roleName)
    setCountryFilter(defaultEmployeeFilters.countryCode)
    setProjectFilter(defaultEmployeeFilters.projectId)
    setPolicyFilter(defaultEmployeeFilters.policyId)
    setActiveFilter(defaultEmployeeFilters.active)
    setProfileFilter(defaultEmployeeFilters.profile)
    setEmploymentFrom(defaultEmployeeFilters.employmentStartDateFrom)
    setEmploymentTo(defaultEmployeeFilters.employmentStartDateTo)
  }, [])
  // Undefined until the status answers (or forever, if it fails): the Sync
  // control is offered only on a definite `enabled: true`, never on a guess.
  const [syncStatus, setSyncStatus] = useState<DirectorySyncStatusDto | undefined>(
    initialDirectorySyncStatus,
  )

  // Filters apply without a submit button: the role select takes effect
  // immediately, and typing in the search field settles into appliedSearch
  // after a short pause so the directory is not refetched on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      setAppliedSearch(searchInput.trim())
    }, 350)
    return () => {
      clearTimeout(handle)
    }
  }, [searchInput])

  // First page of the directory for the current filters. Selecting a row must
  // not appear in these deps, or every click would refetch the directory. The
  // server keeps `totals` on first-page responses only, so this always stores
  // a fresh copy; loadMore preserves it while appending.
  useEffect(() => {
    // Fresh object per load: its identity marks this listing for the
    // load-more staleness checks.
    const applied: EmployeeListFilters = {
      search: appliedSearch,
      roleName: roleFilter,
      countryCode: countryFilter,
      projectId: projectFilter,
      policyId: policyFilter,
      active: activeFilter,
      profile: profileFilter,
      employmentStartDateFrom: employmentFrom,
      employmentStartDateTo: employmentTo,
    }

    // A caller-supplied first page already answers the default question, so
    // there is nothing to ask again until something is chosen. Compared field
    // by field against the defaults rather than by listing the filters here: a
    // filter added to the type and forgotten in a hand-written condition would
    // leave this returning early, and the symptom is silence — the request is
    // never made and the untouched list keeps rendering under a chosen filter.
    if (initialEmployees && listRetry === 0 && sameFilters(applied, defaultEmployeeFilters)) {
      return
    }

    // Named `live` rather than the `active` its sibling effects use: the
    // directory has an `active` filter, and a cancel flag sharing that name
    // reads as one.
    let live = true
    setListState((current) => ({ ...current, status: 'loading', error: null }))

    // The filter object is the query: every field carries the '' sentinel
    // toQueryString drops, so there is nothing to map.
    api
      .getEmployees(applied)
      .then((data) => {
        if (!live) {
          return
        }

        setListState({
          status: 'success',
          error: null,
          data,
          loadingMore: false,
          applied,
        })

        // Fill the initial selection only. A refetch (filter change, retry)
        // must never steal the user's selection — the detail pane keeps
        // showing the selected employee even when the list no longer does.
        setSelectedEmployeeId(
          (current) => current ?? data.items[0]?.employeeId ?? null,
        )
      })
      .catch((error: Error) => {
        if (!live) {
          return
        }
        setListState((current) => ({
          ...current,
          status: 'error',
          error: error.message,
          loadingMore: false,
        }))
      })

    return () => {
      live = false
    }
  }, [
    activeFilter,
    api,
    appliedSearch,
    countryFilter,
    employmentFrom,
    employmentTo,
    initialEmployees,
    listRetry,
    policyFilter,
    profileFilter,
    projectFilter,
    roleFilter,
  ])

  // Appends the next keyset page of the listing the visible data belongs to.
  // Both the query params and the staleness check use the SNAPSHOTTED
  // listState.applied (not the live filter state), so a filter change racing
  // a slow page load can neither mix populations nor stamp a stale error.
  // Only a successfully loaded listing may be extended: after a failed filter
  // refetch the visible data belongs to the OLD filters, and appending to it
  // would present the old population as a fresh success under the new ones.
  // Triggered by the virtual list scrolling near its end (same contract as
  // the old "Load more" button).
  const loadMore = useCallback(() => {
    const cursor = listState.data.nextCursor
    const applied = listState.applied
    if (!cursor || listState.loadingMore || listState.status !== 'success') {
      return
    }
    setListState((current) => ({ ...current, loadingMore: true, error: null }))
    api
      .getEmployees({ ...applied, cursor })
      .then((data) => {
        setListState((current) => {
          const merged = appendKeysetPage(
            current,
            { cursor, applied },
            data,
            (item) => item.employeeId,
          )
          return merged
            ? { ...current, status: 'success', loadingMore: false, data: merged }
            : { ...current, loadingMore: false }
        })
      })
      .catch((error: Error) => {
        setListState((current) =>
          current.applied === applied
            ? { ...current, loadingMore: false, error: error.message }
            : { ...current, loadingMore: false },
        )
      })
  }, [
    api,
    listState.applied,
    listState.data.nextCursor,
    listState.loadingMore,
    listState.status,
  ])

  // Row clicks now just switch the previewed employee — the inline editor (and
  // its unsaved-edits guard) moved to the standalone profile page.
  const selectEmployee = useCallback((employeeId: string) => {
    setSelectedEmployeeId((current) =>
      current === employeeId ? current : employeeId,
    )
  }, [])

  // From the directory payload: the balance meter on every row is a day figure
  // and this route reads no settings response of its own.
  adoptWorkdayHours(listState.data.hoursPerDay)
  const employees = listState.data.items
  const hasMore = Boolean(listState.data.nextCursor)
  const contentHeight = Math.max(employees.length * EMPLOYEE_ROW_HEIGHT, 1)

  const listContainerRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState(LIST_WIDTH_FALLBACK)
  const [viewportCap, setViewportCap] = useState(LIST_MAX_HEIGHT)

  useEffect(() => {
    const node = listContainerRef.current
    if (!node) {
      return
    }
    const measure = () => {
      setListWidth(Math.max(0, Math.floor(node.getBoundingClientRect().width)))
      setViewportCap(
        Math.min(LIST_MAX_HEIGHT, Math.round(window.innerHeight * 0.62)),
      )
    }
    measure()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [employees.length])

  const listHeight = Math.min(viewportCap, contentHeight)
  const listInnerHeight = Math.max(1, listHeight - LIST_RING_INSET * 2)
  const listInnerWidth = Math.max(1, listWidth - LIST_RING_INSET * 2)

  const onDirectoryItemsRendered = useCallback(
    ({ visibleStopIndex }: { visibleStopIndex: number }) => {
      if (
        !hasMore ||
        listState.loadingMore ||
        visibleStopIndex < employees.length - 1 - LOAD_MORE_THRESHOLD
      ) {
        return
      }
      loadMore()
    },
    [hasMore, listState.loadingMore, employees.length, loadMore],
  )

  const directoryRowData = useMemo(
    () => ({
      items: employees,
      selectedEmployeeId,
      detailLoadingEmployeeId:
        detailState.status === 'loading' ? detailState.employeeId : null,
      onSelect: selectEmployee,
    }),
    [
      employees,
      selectedEmployeeId,
      detailState.status,
      detailState.employeeId,
      selectEmployee,
    ],
  )

  // Mirror detail state into a ref so the fetch effect can read the latest value
  // without listing it as a dependency (which previously caused an infinite
  // fetch-retry loop when a detail request failed).
  const detailStateRef = useRef(detailState)
  detailStateRef.current = detailState

  // Which detailRetry value produced the detail currently held. The skip below
  // compares against it, so asking for a refresh actually refetches instead of
  // matching on the employee id alone and keeping a snapshot something else has
  // since invalidated.
  const loadedDetailRetry = useRef(detailRetry)

  useEffect(() => {
    if (!selectedEmployeeId) {
      // Clear any previously loaded employee so the detail panel does not show
      // stale data next to the "select an employee" prompt.
      setDetailState({ status: 'idle', error: null, data: null, employeeId: null })
      return
    }

    // Already have this employee's detail loaded, and nothing has asked for it
    // to be reloaded; no need to refetch.
    if (
      detailStateRef.current.data?.employeeId === selectedEmployeeId &&
      detailStateRef.current.status === 'success' &&
      loadedDetailRetry.current === detailRetry
    ) {
      return
    }

    let active = true
    setDetailState((current) => ({
      ...current,
      status: 'loading',
      error: null,
      employeeId: selectedEmployeeId,
      // Drop the previously loaded employee while switching so its detail is not
      // shown under the new employee's loading skeleton (keep it only on retry
      // of the same employee).
      data: current.data?.employeeId === selectedEmployeeId ? current.data : null,
    }))

    api
      .getEmployeeDetail(selectedEmployeeId)
      .then((data) => {
        if (!active) {
          return
        }
        loadedDetailRetry.current = detailRetry
        setDetailState({
          status: 'success',
          error: null,
          data,
          employeeId: data.employeeId,
        })
      })
      .catch((error: Error) => {
        if (!active) {
          return
        }
        setDetailState({
          status: 'error',
          error: error.message,
          data: null,
          employeeId: selectedEmployeeId,
        })
      })

    return () => {
      active = false
    }
  }, [api, selectedEmployeeId, detailRetry])

  // Countries populate the location facts. This is a small, rarely-changing
  // global list, so it loads once and is shared across every employee. A failure
  // here is non-fatal: the facts fall back to the raw country code.
  useEffect(() => {
    if (initialCountries) {
      return
    }

    let active = true
    api
      .getCountries()
      .then((data) => {
        if (active) {
          setCountries(data)
        }
      })
      .catch(() => {
        // Non-fatal: leave the list empty; the facts show the raw code.
      })

    return () => {
      active = false
    }
  }, [api, initialCountries])

  // Choices for the Country/Project filters. Fetched once on mount (the sets
  // change only when OIDC mirrors a new project or someone is relocated). A
  // failure is deliberately non-fatal and silent: the directory itself must
  // never be blocked on it, so the two selects simply stay unoffered.
  useEffect(() => {
    if (initialFilterOptions) {
      return
    }

    let active = true
    api
      .getEmployeeFilterOptions()
      .then((data) => {
        if (active) {
          setFilterOptions(data)
        }
      })
      .catch(() => {
        // Non-fatal: keep the empty options; the filters stay hidden.
      })

    return () => {
      active = false
    }
  }, [api, initialFilterOptions])

  // Whether this deployment syncs from a directory at all. Non-fatal in
  // exactly the way the filter options are: a deployment without LDAP is the
  // common case, so a page that cannot answer the question simply does not
  // offer the button — it never blocks or alarms.
  useEffect(() => {
    if (initialDirectorySyncStatus) {
      return
    }

    let active = true
    api
      .getDirectorySyncStatus()
      .then((data) => {
        if (active) {
          setSyncStatus(data)
        }
      })
      .catch(() => {
        // Non-fatal: leaves the status unknown, so the Sync control is never
        // offered this visit.
      })

    return () => {
      active = false
    }
  }, [api, initialDirectorySyncStatus])

  // Both panes are refetched rather than patched locally, since the report
  // carries emails, not the rows they render. The detail pane must follow the
  // list: a pass that deactivates the selected employee would otherwise leave
  // the preview claiming they are still active, right beside their own row
  // showing the opposite. What counts as "changed" lives in the predicate,
  // where its gating is unit-tested.
  const handleSyncFinished = useCallback((result: DirectorySyncResultDto | null) => {
    if (!directorySyncChangedAccounts(result)) {
      return
    }

    setListRetry((count) => count + 1)
    setDetailRetry((count) => count + 1)
  }, [])

  const {
    run: syncRun,
    start: startSync,
    dismiss: dismissSyncFeedback,
  } = useDirectorySyncRun(api, handleSyncFinished)
  // Null while there is nothing to say — before any run, and during one, when
  // the button's own "Syncing…" label already covers it.
  const syncFeedback = directorySyncFeedback(syncRun)

  // Header cards read the server's directory-wide totals (kept on the list
  // payload), so they stay global while the list itself is filtered/paged.
  const summary = summarizeEmployees(listState.data)

  return (
    <AdminLayout
      title="Employee directory"
      subtitle="Search and filter the team, then open anyone to see their full profile: role, projects, balances, requests, and audit trail."
      statusIndicator={<ShellStatusPill label="Live · directory up to date" />}
      headerSupplement={
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          }}
        >
          {summary.map((item) => (
            <MetricTile key={item.label} label={item.label} value={item.value} size="lg" />
          ))}
        </Box>
      }
    >
      <Grid container spacing={2.25} alignItems="start">
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Directory"
            caption="Search by name or email, narrow by role, project, country, account, profile or start date."
            side={
              syncStatus?.enabled ? (
                <Button
                  size="small"
                  variant="outlined"
                  color="secondary"
                  // A no-op while a pass is in flight, so a second click cannot
                  // queue another sync behind the running one.
                  onClick={startSync}
                  startIcon={
                    syncRun.status === 'running' ? (
                      <CircularProgress size={14} color="inherit" />
                    ) : undefined
                  }
                >
                  {syncRun.status === 'running' ? 'Syncing…' : 'Sync from LDAP'}
                </Button>
              ) : null
            }
          >
            <Stack spacing={2}>
              {/* The wrapper stays mounted so the alert's arrival is announced:
                  a live region inserted together with its content is silent to
                  a screen reader. The message itself lives on the page, not in
                  a toast — a sync takes minutes and finishes after the admin
                  has looked away, so it must still be here when they look back.
                  Nothing persists: leaving the page or reloading clears it.
                  While empty, the negative margin cancels the Stack spacing the
                  next sibling gains from this extra child, so the card lays out
                  as if the wrapper were not there. */}
              <Box role="status" sx={{ '&:empty': { mb: -2 } }}>
                {syncFeedback ? (
                  <Alert
                    // MUI defaults the Alert to role="alert" — an assertive
                    // live region of its own, which nested inside the polite
                    // wrapper above would announce the message twice, once as
                    // an interruption. The wrapper is the only live region.
                    role="presentation"
                    severity={syncFeedback.severity}
                    onClose={dismissSyncFeedback}
                  >
                    {syncFeedback.message}
                  </Alert>
                ) : null}
              </Box>
              {/* Every control in these rows opts into the secondary palette,
                  so the focused outline and label match the teal controls
                  around them (the sync button above, the action buttons on the
                  rows). Without the prop MUI falls back to the primary blue,
                  which this app reserves for navigation state. Whoever adds a
                  control here has to pass it too, or that one field will focus
                  blue in a teal row.

                  Three blocks, split where the QUESTION changes. Search, Role,
                  Project, Country and the employment range all ask about the
                  person; Account and Profile ask about their record in this
                  system, which is why the divider sits between them. Search
                  takes a line of its own because a flex item that grows would
                  swallow the free space and pull the next select up beside it,
                  leaving the rest to wrap into an order nobody chose.

                  Wrapped in one Stack of its own so the whole filter area stays
                  a SINGLE child of the card's Stack: as four loose children the
                  outer spacing={2} would fall between every row and stand the
                  divider off by 16px on each side. */}
              <Stack spacing={1.5}>
                <TextField
                  label="Search"
                  color="secondary"
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value)
                  }}
                  placeholder="Name or email"
                  size="small"
                  fullWidth
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRoundedIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                />
                <Box
                  sx={{
                    display: 'flex',
                    columnGap: 1,
                    // Wider than the column gap: an outlined field floats its
                    // label onto its top border, so a wrapped row set 8px below
                    // its neighbour reads as a label crowding the field above
                    // rather than as the start of a new line.
                    rowGap: 2,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <TextField
                    select
                    label="Role"
                    {...SELECT_SHOWS_SCOPE}
                    color="secondary"
                    value={roleFilter}
                    size="small"
                    onChange={(event) => {
                      setRoleFilter(event.target.value as AppRoleName | '')
                      // Flush any half-typed search along with the role so the
                      // list refetches once, not twice (now + when the pending
                      // debounce lands).
                      setAppliedSearch(searchInput.trim())
                    }}
                    fullWidth={false}
                    sx={{ width: 168 }}
                  >
                    <MenuItem value="">All roles</MenuItem>
                    <MenuItem value={AppRoleNameEnum.Employee}>Employees</MenuItem>
                    <MenuItem value={AppRoleNameEnum.Administrator}>Administrators</MenuItem>
                  </TextField>
                  {/* Project and Country are offered only once their options
                      have loaded: an empty select would look like "no projects
                      exist" rather than "not loaded yet", and a failed options
                      fetch must not block the directory. */}
                  {filterOptions.projects.length > 0 ? (
                    <TextField
                      select
                      label="Project"
                      {...SELECT_SHOWS_SCOPE}
                      color="secondary"
                      value={projectFilter}
                      size="small"
                      onChange={(event) => {
                        setProjectFilter(event.target.value)
                        setAppliedSearch(searchInput.trim())
                      }}
                      fullWidth={false}
                      sx={{ width: 168 }}
                    >
                      <MenuItem value="">All projects</MenuItem>
                      {filterOptions.projects.map((project) => (
                        <MenuItem key={project.projectId} value={project.projectId}>
                          {project.name}
                        </MenuItem>
                      ))}
                    </TextField>
                  ) : null}
                  {filterOptions.policies.length > 0 ? (
                    <TextField
                      select
                      label="Policy"
                      {...SELECT_SHOWS_SCOPE}
                      color="secondary"
                      value={policyFilter}
                      size="small"
                      onChange={(event) => {
                        setPolicyFilter(event.target.value)
                        setAppliedSearch(searchInput.trim())
                      }}
                      fullWidth={false}
                      sx={{ width: 168 }}
                    >
                      <MenuItem value="">All policies</MenuItem>
                      {filterOptions.policies.map((policy) => (
                        <MenuItem key={policy.policyId} value={policy.policyId}>
                          {policy.name}
                        </MenuItem>
                      ))}
                    </TextField>
                  ) : null}
                  {filterOptions.countries.length > 0 ? (
                    <TextField
                      select
                      label="Country"
                      {...SELECT_SHOWS_SCOPE}
                      color="secondary"
                      value={countryFilter}
                      size="small"
                      onChange={(event) => {
                        setCountryFilter(event.target.value)
                        setAppliedSearch(searchInput.trim())
                      }}
                      fullWidth={false}
                      sx={{ width: 168 }}
                    >
                      <MenuItem value="">All countries</MenuItem>
                      {filterOptions.countries.map((country) => (
                        <MenuItem key={country.code} value={country.code}>
                          {country.name}
                        </MenuItem>
                      ))}
                    </TextField>
                  ) : null}
                  {/* The calendar answers "started on this day" (one click) or
                      "started inside this window" (two). It cannot express an
                      open end, so the one-sided query the contract allows is an
                      API capability rather than something this row offers.

                      Both endpoints commit together on Done, so one gesture is
                      one refetch. `plain`: this is a filter, not a leave request
                      — no holiday shading, no working-day count, no Done gate.
                      The admin names the days, so nothing here asks the server
                      what today is. Bounded width because the row is a flex wrap
                      and fullWidth would take the whole line. */}
                  <Box sx={{ width: 236 }}>
                    <DateRangeField
                      plain
                      fullWidth
                      color="secondary"
                      label="Employment start"
                      value={{
                        startDate: employmentFrom,
                        endDate: employmentTo,
                      }}
                      onChange={(range) => {
                        setEmploymentFrom(range.startDate)
                        setEmploymentTo(range.endDate)
                        setAppliedSearch(searchInput.trim())
                      }}
                    />
                  </Box>
                </Box>
                <Divider />
                <Box
                  sx={{
                    display: 'flex',
                    columnGap: 1,
                    rowGap: 2,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  {/* Neither needs loaded options — their values are a fixed set,
                      so unlike Project/Country they are always offered.
                      "Account" avoids "Activity", which names the request feed
                      elsewhere in the app. */}
                  <TextField
                    select
                    label="Account"
                    {...SELECT_SHOWS_SCOPE}
                    color="secondary"
                    value={activeFilter}
                    size="small"
                    onChange={(event) => {
                      setActiveFilter(event.target.value as '' | 'true' | 'false')
                      setAppliedSearch(searchInput.trim())
                    }}
                    fullWidth={false}
                    sx={{ width: 168 }}
                  >
                    <MenuItem value="">All accounts</MenuItem>
                    <MenuItem value="true">Active</MenuItem>
                    <MenuItem value="false">Inactive</MenuItem>
                  </TextField>
                  {/* Named combinations rather than one checkbox per field: with
                      checkboxes "both ticked" would have to mean either "missing
                      anything" or "missing everything", and whichever was chosen
                      the other reading answers a question the admin cannot tell
                      they asked. Spelling the populations out leaves nothing to
                      combine. "Complete" is about the card being filled in, NOT
                      about employment having begun — that is the row's own badge,
                      which judges by the employee's calendar day. */}
                  <TextField
                    select
                    label="Profile"
                    {...SELECT_SHOWS_SCOPE}
                    color="secondary"
                    value={profileFilter}
                    size="small"
                    onChange={(event) => {
                      setProfileFilter(
                        event.target.value as EmployeeProfileFilter | '',
                      )
                      setAppliedSearch(searchInput.trim())
                    }}
                    fullWidth={false}
                    sx={{ width: 188 }}
                  >
                    <MenuItem value="">All profiles</MenuItem>
                    <MenuItem value={EmployeeProfileFilter.MissingAny}>
                      Missing any detail
                    </MenuItem>
                    <MenuItem value={EmployeeProfileFilter.MissingStartDate}>
                      Missing start date
                    </MenuItem>
                    <MenuItem value={EmployeeProfileFilter.MissingCountry}>
                      Missing country
                    </MenuItem>
                    <MenuItem value={EmployeeProfileFilter.Complete}>
                      Complete
                    </MenuItem>
                  </TextField>
                  {/* Offered only once something is off the defaults, so the row
                      does not carry a control that would do nothing. It is the
                      only reset the employment range has: the selects each clear
                      through their own "All …" option, while the range field
                      commits from inside its popover and shows no clear control
                      of its own in this variant. */}
                  {filtersAreDefault ? null : (
                    <Button
                      color="secondary"
                      startIcon={<FilterAltOffRoundedIcon />}
                      onClick={clearFilters}
                    >
                      Clear filters
                    </Button>
                  )}
                </Box>
              </Stack>

              {listState.error ? (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => setListRetry((count) => count + 1)}
                    >
                      Retry
                    </Button>
                  }
                >
                  {listState.error}
                </Alert>
              ) : null}

              {listState.status === 'loading' && listState.data.items.length === 0 ? (
                <Stack spacing={1.25}>
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} variant="rounded" height={72} />
                  ))}
                </Stack>
              ) : null}

              {listState.status !== 'loading' && listState.data.items.length === 0 ? (
                <Alert severity="info">No employees match the current filters.</Alert>
              ) : null}

              {listState.data.items.length > 0 ? (
                /* Only the rows scroll; near-end scroll asks for the next
                   keyset page. The 3px padding keeps the selected row's ring
                   inside the clip box. */
                <Box>
                  <Box
                    ref={listContainerRef}
                    sx={{
                      height: listHeight,
                      overflow: 'hidden',
                      p: `${LIST_RING_INSET}px`,
                      m: `-${LIST_RING_INSET}px`,
                      boxSizing: 'border-box',
                    }}
                  >
                    <FixedSizeList
                      height={listInnerHeight}
                      width={listInnerWidth}
                      itemCount={employees.length}
                      itemSize={EMPLOYEE_ROW_HEIGHT}
                      itemData={directoryRowData}
                      overscanCount={6}
                      onItemsRendered={onDirectoryItemsRendered}
                    >
                      {DirectoryRow}
                    </FixedSizeList>
                  </Box>
                  {listState.loadingMore ? (
                    <Box sx={{ display: 'grid', placeItems: 'center', py: 1 }}>
                      <CircularProgress
                        size={18}
                        thickness={5}
                        aria-label="Loading more employees"
                      />
                    </Box>
                  ) : null}
                </Box>
              ) : null}
            </Stack>
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          {/* Header-less preview card: the prototype's preview begins directly
              with the clickable employee header, so it wears the SectionCard
              chrome (border/radius/padding) without a title/caption row. */}
          <Card sx={{ p: { xs: 2.5, md: 3 } }}>
            <Stack spacing={2}>
              {detailState.error ? (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => setDetailRetry((count) => count + 1)}
                    >
                      Retry
                    </Button>
                  }
                >
                  {detailState.error}
                </Alert>
              ) : null}

              {!selectedEmployeeId ? (
                <Alert severity="info">Select an employee to view detail.</Alert>
              ) : null}

              {detailState.status === 'loading' && selectedEmployeeId && !detailState.data ? (
                <Stack spacing={2}>
                  <Skeleton variant="text" width="46%" />
                  <Skeleton variant="rounded" height={96} />
                  <Skeleton variant="rounded" height={120} />
                </Stack>
              ) : null}

              {detailState.data ? (
                <EmployeePreview detail={detailState.data} countries={countries} />
              ) : null}
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </AdminLayout>
  )
}

type DirectoryRowData = {
  items: AdminEmployeeListItemDto[]
  selectedEmployeeId: string | null
  detailLoadingEmployeeId: string | null
  onSelect: (employeeId: string) => void
}

function DirectoryRow({
  index,
  style,
  data,
}: ListChildComponentProps<DirectoryRowData>) {
  const employee = data.items[index]
  if (!employee) {
    return null
  }
  return (
    <Box style={style} sx={{ boxSizing: 'border-box', pb: 1 }}>
      <EmployeeDirectoryRow
        employee={employee}
        selected={data.selectedEmployeeId === employee.employeeId}
        detailLoading={data.detailLoadingEmployeeId === employee.employeeId}
        onSelect={data.onSelect}
      />
    </Box>
  )
}

function EmployeeDirectoryRow({
  employee,
  selected,
  detailLoading,
  onSelect,
}: {
  employee: AdminEmployeeListItemDto
  selected: boolean
  detailLoading: boolean
  onSelect: (employeeId: string) => void
}) {
  const projectNames = employee.projects.map((project) => project.name).join(', ')
  // A deactivated account fades into the background: the avatar, name and
  // subline dim, while its Inactive flag stays at full strength so the row
  // still reads at a glance.
  // TODO: the dim costs text contrast. Over the white card, 0.55 takes the
  // 12px subline to 2.6:1 and the 14px/800 name to 4.0:1, both under the 4.5:1
  // WCAG AA asks for normal text (14px bold is not "large text"). No single
  // value serves both — the name needs >= 0.59, the subline >= 0.80, and at
  // 0.80 the dim stops being visible. Fix by dimming the avatar alone and
  // leaving both Typography at full strength: the avatar carries no
  // information and answers to the 3:1 non-text bar, and grayscale marks it
  // more strongly than opacity since it is the only color in the row.
  const dimmed = employee.active ? null : { opacity: 0.55 }

  return (
    <ButtonBase
      onClick={() => {
        onSelect(employee.employeeId)
      }}
      aria-pressed={selected}
      sx={(theme) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        width: '100%',
        height: '100%',
        textAlign: 'left',
        p: '11px 13px',
        borderRadius: '12px',
        border: '1px solid',
        borderColor: selected ? 'secondary.main' : 'divider',
        bgcolor: selected ? 'rgba(15, 118, 110, 0.08)' : 'transparent',
        boxShadow: selected
          ? `0 0 0 3px ${alpha(theme.palette.secondary.main, 0.08)}`
          : 'none',
        transition: 'all 0.15s ease',
        '&:hover': { bgcolor: 'rgba(16, 24, 40, 0.02)' },
      })}
    >
      <Box sx={{ display: 'flex', ...dimmed }}>
        <ApproverAvatar
          email={employee.email}
          displayName={employee.displayName}
          size={38}
        />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography noWrap sx={{ fontSize: 14, fontWeight: 800, ...dimmed }}>
            {employee.displayName}
          </Typography>
          {distinguishingRoles(employee.roleNames).map((roleName) => (
            <RoleChip key={roleName} role={formatRoleName(roleName)} />
          ))}
          {employee.active ? null : <InactiveFlag />}
          {/* Needs setup is an admin to-do, and a deactivated account is
              nobody's to-do: the sync leaves the profile card of a departed
              employee unfinished forever, so flagging it would fill the
              directory with work nobody should do. Inactive already explains
              why the row needs no attention. */}
          {employee.active &&
          employee.profileStatus === EmployeeProfileStatus.PendingSetup ? (
            <NeedsSetupFlag />
          ) : null}
        </Stack>
        <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary', ...dimmed }}>
          {employee.email}
          {projectNames ? ` · ${projectNames}` : ''}
        </Typography>
      </Box>
      {detailLoading ? <CircularProgress size={16} color="secondary" /> : null}
    </ButtonBase>
  )
}

// The read-only preview shown in the directory's right column (prototype
// renderDetail): a clickable header linking to the full profile, a facts grid,
// balance meters, the open/audit actions, and the latest request.
function EmployeePreview({
  detail,
  countries,
}: {
  detail: AdminEmployeeDetailDto
  countries: CountryDto[]
}) {
  const profileHref = `/admin/employees/${detail.employeeId}`
  const latest = detail.requestHistory[0]
  const previewRoles = distinguishingRoles(detail.roleNames)
  // A label on the header replaces its text in the accessible name, so the
  // Inactive flag inside would go unannounced — and stay unreachable by voice
  // control, which matches on that name — unless the state is spelled out here.
  const headerLabel = `Open the full profile of ${detail.displayName}${
    detail.active ? '' : ' (inactive account)'
  }`
  return (
    <Stack spacing={2}>
      <ButtonBase
        component={RouterLink}
        to={profileHref}
        aria-label={headerLabel}
        sx={{
          display: 'flex',
          gap: 1.75,
          alignItems: 'center',
          width: '100%',
          textAlign: 'left',
          borderRadius: '12px',
          p: 0.75,
          m: '-6px',
          transition: 'background 0.15s ease',
          '&:hover': { bgcolor: 'rgba(16, 24, 40, 0.03)' },
          '&:hover .preview-chev': { color: 'secondary.main', transform: 'translateX(2px)' },
        }}
      >
        <ApproverAvatar email={detail.email} displayName={detail.displayName} size={52} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography sx={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>
              {detail.displayName}
            </Typography>
            {detail.active ? null : <InactiveFlag />}
          </Stack>
          <Typography noWrap sx={{ fontSize: 13, color: 'text.secondary' }}>
            {detail.email}
          </Typography>
          {/* Most accounts chip no role at all, so the row appears only when it
              has something to hold — otherwise it leaves a gap under the email. */}
          {previewRoles.length > 0 ? (
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
              {previewRoles.map((roleName) => (
                <RoleChip key={roleName} role={formatRoleName(roleName)} />
              ))}
            </Stack>
          ) : null}
        </Box>
        <Box
          className="preview-chev"
          sx={{ color: '#98a2b3', flexShrink: 0, display: 'flex', transition: 'color 0.15s ease, transform 0.15s ease' }}
        >
          <ChevronGlyph size={18} />
        </Box>
      </ButtonBase>

      <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: '1fr 1fr' }}>
        <Fact
          label="Country"
          value={detail.countryCode ? countryLabel(detail.countryCode, countries) : <NotSet />}
        />
        <Fact
          label="Start date"
          value={detail.employmentStartDate ? formatDate(detail.employmentStartDate) : <NotSet />}
        />
        <Fact label="Employee ID" value={<EmployeeIdValue id={detail.employeeId} />} />
        <Fact label="Profile" value={profileStatusLabel(detail.profileStatus)} />
        <Fact
          wide
          label="Projects · positions"
          value={
            detail.projects.length === 0 ? (
              <Typography sx={{ fontSize: 13, color: 'text.secondary', fontWeight: 600 }}>
                None
              </Typography>
            ) : (
              <Stack spacing={0.25}>
                {detail.projects.map((project) => (
                  <Typography
                    key={project.projectId}
                    sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary' }}
                  >
                    {project.name}
                    {project.position ? `: ${project.position}` : ''}
                  </Typography>
                ))}
              </Stack>
            )
          }
        />
      </Box>

      <Box>
        <PreviewLabel>Balances</PreviewLabel>
        <Stack spacing={1}>
          {detail.balances.map((balance) => (
            <BalanceMeter key={balance.leaveType} balance={balance} variant="meter" />
          ))}
        </Stack>
      </Box>

      <Box>
        <PreviewLabel>Recent activity</PreviewLabel>
        {latest ? (
          <Stack
            direction="row"
            spacing={1.25}
            alignItems="center"
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '11px', p: '11px 13px' }}
          >
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary', fontWeight: 600 }}>
              Latest request
            </Typography>
            <Box sx={{ ml: 'auto' }}>
              <StatusPill status={latest.status} />
            </Box>
          </Stack>
        ) : (
          <Box
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '11px', p: '11px 13px' }}
          >
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              No leave requests yet.
            </Typography>
          </Box>
        )}
      </Box>
    </Stack>
  )
}

// Prototype .d-sec-t: a small uppercase label above a preview section.
function PreviewLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: '#98a2b3',
        mb: 1,
      }}
    >
      {children}
    </Typography>
  )
}
