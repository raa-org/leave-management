/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type {
  AdminActivityFeedDto,
  AdminActivityQueryDto,
  AdminAuditLogPageDto,
  AdminEmployeeDetailDto,
  AdminEmployeeFilterOptionsDto,
  AdminEmployeeListDto,
  AdminEmployeeOptionDto,
  AdminEmployeesQueryDto,
  AppRoleName,
  AuditCategory,
  AuditEventType,
  AdjustEmployeeVacationBalanceDto,
  CloneHolidayCalendarDto,
  CountryCatalogEntryDto,
  CountryDto,
  CreateLeavePolicyDto,
  DirectorySyncResultDto,
  DirectorySyncStatusDto,
  EmployeePolicyDto,
  EmployeeProfileFilter,
  HolidayCalendarDto,
  ImportBatchSummaryDto,
  ImportEmployeeRequestDto,
  ImportEmployeeResultDto,
  ImportValidationReportDto,
  LeaveApprovalActionDto,
  LeavePolicyDto,
  LeaveRequestDetailDto,
  LeaveRequestStatus,
  LeaveSettingsDto,
  LeaveType,
  PolicyTransferPreflightDto,
  TransferEmployeePolicyDto,
  UpdateEmployeeAdminDto,
  UpdateHolidayCalendarDto,
  UpdateLeavePolicyDto,
  UpdateLeaveSettingsDto,
  ValidateImportRequestDto,
} from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'
import { configureWorkdayHours } from '../../lib/leave-format'

type FetchLike = typeof fetch

// Point the shared day-figure renderers at the org's workday length, then hand
// the settings straight back so the call sites read as plain fetches.
function rememberWorkdayHours(settings: LeaveSettingsDto): LeaveSettingsDto {
  configureWorkdayHours(settings.hoursPerDay)
  return settings
}

// The contracts DTO, widened so UI selects can pass '' for "no filter" —
// toQueryString drops empty values before the request is built.
export type AdminActivityQuery = Omit<
  AdminActivityQueryDto,
  'status' | 'leaveType'
> & {
  status?: LeaveRequestStatus | ''
  leaveType?: LeaveType | ''
}

// Same widening for the employees directory query: the role, account and
// profile selects pass '' for "all" and toQueryString strips it before the
// request is built. The account status is a boolean in the contract, but it
// travels as 'true'/'false' — exactly the strings the API parses it back from —
// so the page hands its whole filter object over unmapped instead of copying it
// field by field at both the first-page and the load-more call. The employment
// date bounds need no widening: they are already optional strings, and the
// range field leaves them '' while unset.
export type AdminEmployeesQuery = Omit<
  AdminEmployeesQueryDto,
  'roleName' | 'active' | 'profile'
> & {
  roleName?: AppRoleName | ''
  active?: 'true' | 'false' | ''
  profile?: EmployeeProfileFilter | ''
}

export type AdminAuditLogsQuery = {
  cursor?: string
  limit?: number
  userId?: string
  category?: AuditCategory
  eventType?: AuditEventType
  from?: string
  to?: string
}

// Shape of the test-only /api/admin/test-tooling endpoint (see the API's
// TestToolingController). `enabled` mirrors the server's TEST_TOOLING_ENABLED
// flag; `offsetMs` is the shift of the "Time-travelling" clock from real time.
export type TestToolingState = {
  enabled: boolean
  now: string
  offsetMs: number
}

export type SetTestToolingInput = { now?: string; offsetMs?: number }

// Result of the per-user leave-data reset test tool.
export type ResetUserResult = { userId: string; displayName: string }

// Directory-wide reset test tool. An empty `keep` requires `all: true` — the
// server refuses an unconfirmed full wipe.
export type ResetDirectoryInput = {
  keep: string[]
  all: boolean
  clearAudit: boolean
}

export type ResetDirectoryResult = {
  deletedUsers: number
  deletedRequests: number
  deletedLedgerEntries: number
  deletedDeliveries: number
  clearedAuditLogs: number
}

export type AdminApiClient = {
  getActivity: (input?: AdminActivityQuery) => Promise<AdminActivityFeedDto>
  getAuditLogs: (input?: AdminAuditLogsQuery) => Promise<AdminAuditLogPageDto>
  getEmployees: (input?: AdminEmployeesQuery) => Promise<AdminEmployeeListDto>
  getEmployeeOptions: () => Promise<AdminEmployeeOptionDto[]>
  getEmployeeFilterOptions: () => Promise<AdminEmployeeFilterOptionsDto>
  getEmployeeDetail: (employeeId: string) => Promise<AdminEmployeeDetailDto>
  updateEmployee: (
    employeeId: string,
    input: UpdateEmployeeAdminDto,
  ) => Promise<AdminEmployeeDetailDto>
  // Sticky one-shot ± on the current open vacation year (sick out of scope).
  adjustEmployeeVacationBalance: (
    employeeId: string,
    input: AdjustEmployeeVacationBalanceDto,
  ) => Promise<AdminEmployeeDetailDto>
  // The leave policy catalog. Terms are immutable once created, so the patch
  // takes only the non-term fields; retiring a policy (effectiveTo) is refused
  // while any live membership would outlive it.
  getPolicies: () => Promise<LeavePolicyDto[]>
  createPolicy: (input: CreateLeavePolicyDto) => Promise<LeavePolicyDto>
  updatePolicy: (
    policyId: string,
    input: UpdateLeavePolicyDto,
  ) => Promise<LeavePolicyDto>
  setDefaultPolicy: (policyId: string) => Promise<LeavePolicyDto[]>
  // Refused with 409 `policy_in_use` once any membership ever referenced it.
  deletePolicy: (policyId: string) => Promise<{ deleted: true }>
  getEmployeePolicy: (employeeId: string) => Promise<EmployeePolicyDto>
  // Read-only dry run: what the transfer would adjust, what blocks it, and
  // which paid requests fall inside the target policy's probation window.
  preflightPolicyTransfer: (
    employeeId: string,
    input: TransferEmployeePolicyDto,
  ) => Promise<PolicyTransferPreflightDto>
  transferEmployeePolicy: (
    employeeId: string,
    input: TransferEmployeePolicyDto,
  ) => Promise<AdminEmployeeDetailDto>
  cancelScheduledPolicyTransfer: (
    employeeId: string,
  ) => Promise<AdminEmployeeDetailDto>
  getLeaveRequestDetail: (requestId: string) => Promise<LeaveRequestDetailDto>
  // Settles a request from a single administrator decision, bypassing the
  // all-approvers gate. `comment` is the mandatory override reason; the server
  // rejects a blank one.
  forceDecideRequest: (
    requestId: string,
    input: LeaveApprovalActionDto,
  ) => Promise<LeaveRequestDetailDto>
  // Whether this deployment has the directory sync at all. Answers
  // `enabled: false` rather than failing when the feature is off.
  getDirectorySyncStatus: () => Promise<DirectorySyncStatusDto>
  // Runs a full sync and resolves with its report. Synchronous by design — the
  // caller waits for the pass. The non-completed outcomes (already-running,
  // empty-directory) arrive as a normal resolved value carrying `status`, not
  // as a rejection.
  runDirectorySync: () => Promise<DirectorySyncResultDto>
  // The import wizard drives these one chunk (validate) or one employee
  // (preview/apply) at a time, so progress is real and each employee commits
  // on its own.
  validateImport: (
    input: ValidateImportRequestDto,
  ) => Promise<ImportValidationReportDto>
  previewImportEmployee: (
    input: ImportEmployeeRequestDto,
  ) => Promise<ImportEmployeeResultDto>
  applyImportEmployee: (
    input: ImportEmployeeRequestDto,
  ) => Promise<ImportEmployeeResultDto>
  completeImport: (input: ImportBatchSummaryDto) => Promise<void>
  getCountries: () => Promise<CountryDto[]>
  getCountryCatalog: () => Promise<CountryCatalogEntryDto[]>
  getSettings: () => Promise<LeaveSettingsDto>
  updateSettings: (input: UpdateLeaveSettingsDto) => Promise<LeaveSettingsDto>
  listHolidays: (input?: {
    countryCode?: string
    year?: number
  }) => Promise<HolidayCalendarDto[]>
  updateHolidayCalendar: (
    input: UpdateHolidayCalendarDto,
  ) => Promise<HolidayCalendarDto>
  cloneHolidayCalendar: (
    input: CloneHolidayCalendarDto,
  ) => Promise<HolidayCalendarDto>
  deleteHolidayCalendar: (input: {
    countryCode: string
    year: number
  }) => Promise<void>
  getTestTooling: () => Promise<TestToolingState>
  setTestTooling: (input: SetTestToolingInput) => Promise<TestToolingState>
  resetTestTooling: () => Promise<TestToolingState>
  resetUserLeaveData: (userId: string) => Promise<ResetUserResult>
  resetDirectory: (input: ResetDirectoryInput) => Promise<ResetDirectoryResult>
}

/**
 * A failed API call, carrying what the response actually said. `apiWorded`
 * marks a message the API itself wrote (the `message` field of a JSON error
 * body); everything else — a gateway's HTML page, a truncated body, a network
 * failure — is text written for no human, and a caller showing errors to
 * people can tell the two apart. `details` keeps the REST of the parsed body,
 * which the policy engine relies on: its refusals carry the duplicate policy's
 * identity or the earliest permissible backdate, and a dialog offering
 * "use that one instead" needs the field, not the sentence.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiWorded: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function isApiWordedError(error: unknown): boolean {
  return error instanceof ApiError && error.apiWorded
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(input, init)
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    let apiWorded = false
    let details: Record<string, unknown> = {}

    try {
      const payload = (await response.json()) as {
        message?: string | string[]
      } & Record<string, unknown>
      if (Array.isArray(payload.message)) {
        message = payload.message.join(', ')
        apiWorded = true
      } else if (typeof payload.message === 'string') {
        message = payload.message
        apiWorded = true
      }
      const { message: _worded, ...rest } = payload
      details = rest
    } catch {
      try {
        const text = await response.text()
        if (text.trim()) {
          message = text.trim()
        }
      } catch {
        // Keep the status-based fallback if the body is unreadable.
      }
    }

    throw new ApiError(message, response.status, apiWorded, details)
  }

  return (await response.json()) as T
}

function toQueryString(
  input: Record<string, string | number | undefined | ''>,
): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === '') {
      continue
    }
    params.set(key, String(value))
  }

  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

// Resolve the global fetch at CALL time, not import time, so the module-level
// `adminApi` below routes through the session-expiry-wrapped window.fetch that
// main.tsx installs after this module is imported.
const lazyGlobalFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

export function createAdminApiClient(fetchImpl: FetchLike = lazyGlobalFetch): AdminApiClient {
  return {
    getActivity: (input) =>
      fetchJson<AdminActivityFeedDto>(
        fetchImpl,
        apiUrl(`/api/admin/activity${toQueryString(input ?? {})}`),
      ),
    getAuditLogs: (input) =>
      fetchJson<AdminAuditLogPageDto>(
        fetchImpl,
        apiUrl(`/api/admin/audit${toQueryString(input ?? {})}`),
      ),
    getEmployees: (input) =>
      fetchJson<AdminEmployeeListDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees${toQueryString(input ?? {})}`),
      ),
    getEmployeeOptions: () =>
      fetchJson<AdminEmployeeOptionDto[]>(
        fetchImpl,
        apiUrl('/api/admin/employees/options'),
      ),
    getEmployeeFilterOptions: () =>
      fetchJson<AdminEmployeeFilterOptionsDto>(
        fetchImpl,
        apiUrl('/api/admin/employees/filter-options'),
      ),
    getEmployeeDetail: (employeeId) =>
      fetchJson<AdminEmployeeDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}`),
      ),
    updateEmployee: (employeeId, input) =>
      fetchJson<AdminEmployeeDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}`),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    adjustEmployeeVacationBalance: (employeeId, input) =>
      fetchJson<AdminEmployeeDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}/vacation-balance`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    getPolicies: () =>
      fetchJson<LeavePolicyDto[]>(fetchImpl, apiUrl('/api/admin/policies')),
    createPolicy: (input) =>
      fetchJson<LeavePolicyDto>(fetchImpl, apiUrl('/api/admin/policies'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    updatePolicy: (policyId, input) =>
      fetchJson<LeavePolicyDto>(
        fetchImpl,
        apiUrl(`/api/admin/policies/${policyId}`),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    setDefaultPolicy: (policyId) =>
      fetchJson<LeavePolicyDto[]>(
        fetchImpl,
        apiUrl('/api/admin/policies/default'),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policyId }),
        },
      ),
    // Through fetchJson, not a bare fetch: the refusal body carries the reason
    // an admin needs (the policy is referenced by history, retire it instead).
    deletePolicy: (policyId) =>
      fetchJson<{ deleted: true }>(
        fetchImpl,
        apiUrl(`/api/admin/policies/${policyId}`),
        { method: 'DELETE' },
      ),
    getEmployeePolicy: (employeeId) =>
      fetchJson<EmployeePolicyDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}/policy`),
      ),
    preflightPolicyTransfer: (employeeId, input) =>
      fetchJson<PolicyTransferPreflightDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}/policy/preflight`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    transferEmployeePolicy: (employeeId, input) =>
      fetchJson<AdminEmployeeDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}/policy`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    cancelScheduledPolicyTransfer: (employeeId) =>
      fetchJson<AdminEmployeeDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/employees/${employeeId}/policy/scheduled`),
        { method: 'DELETE' },
      ),
    getLeaveRequestDetail: (requestId) =>
      fetchJson<LeaveRequestDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/leave-requests/${requestId}`),
      ),
    forceDecideRequest: (requestId, input) =>
      fetchJson<LeaveRequestDetailDto>(
        fetchImpl,
        apiUrl(`/api/admin/leave-requests/${requestId}/force-decision`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    getDirectorySyncStatus: () =>
      fetchJson<DirectorySyncStatusDto>(fetchImpl, apiUrl('/api/admin/ldap-sync')),
    runDirectorySync: async () => {
      try {
        return await fetchJson<DirectorySyncResultDto>(
          fetchImpl,
          apiUrl('/api/admin/ldap-sync'),
          { method: 'POST' },
        )
      } catch (error) {
        // The API words its own sync failures for people; that phrase passes
        // through. Anything else — a gateway's HTML page, a dropped connection
        // — is noise, and worse, arrives when the server may already have
        // accepted the POST: the run may or may not have happened, and only a
        // phrase that admits that is honest to show.
        if (isApiWordedError(error)) {
          throw error
        }
        throw new Error(
          'The sync request failed — the run may or may not have happened. The audit log has the answer.',
        )
      }
    },
    validateImport: (input) =>
      fetchJson<ImportValidationReportDto>(
        fetchImpl,
        apiUrl('/api/admin/import/validate'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    previewImportEmployee: (input) =>
      fetchJson<ImportEmployeeResultDto>(
        fetchImpl,
        apiUrl('/api/admin/import/employees/preview'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    applyImportEmployee: (input) =>
      fetchJson<ImportEmployeeResultDto>(
        fetchImpl,
        apiUrl('/api/admin/import/employees/apply'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    completeImport: async (input) => {
      await fetchJson<{ recorded: true }>(
        fetchImpl,
        apiUrl('/api/admin/import/complete'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      )
    },
    getCountries: () =>
      fetchJson<CountryDto[]>(fetchImpl, apiUrl('/api/admin/countries')),
    getCountryCatalog: () =>
      fetchJson<CountryCatalogEntryDto[]>(
        fetchImpl,
        apiUrl('/api/admin/country-catalog'),
      ),
    // Both settings calls re-point the display divisor: the console renders day
    // figures on pages that never load the employee dashboard, and an admin who
    // has just changed the workday length must see the new one immediately.
    getSettings: async () =>
      rememberWorkdayHours(
        await fetchJson<LeaveSettingsDto>(fetchImpl, apiUrl('/api/admin/settings')),
      ),
    updateSettings: async (input) =>
      rememberWorkdayHours(
        await fetchJson<LeaveSettingsDto>(fetchImpl, apiUrl('/api/admin/settings'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    listHolidays: (input) =>
      fetchJson<HolidayCalendarDto[]>(
        fetchImpl,
        apiUrl(`/api/admin/holidays${toQueryString(input ?? {})}`),
      ),
    updateHolidayCalendar: (input) =>
      fetchJson<HolidayCalendarDto>(fetchImpl, apiUrl('/api/admin/holidays'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    cloneHolidayCalendar: (input) =>
      fetchJson<HolidayCalendarDto>(
        fetchImpl,
        apiUrl('/api/admin/holidays/clone'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    deleteHolidayCalendar: async (input) => {
      const response = await fetchImpl(
        apiUrl(`/api/admin/holidays${toQueryString({ ...input })}`),
        { method: 'DELETE' },
      )
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }
    },
    getTestTooling: () =>
      fetchJson<TestToolingState>(fetchImpl, apiUrl('/api/admin/test-tooling')),
    setTestTooling: (input) =>
      fetchJson<TestToolingState>(fetchImpl, apiUrl('/api/admin/test-tooling'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    resetTestTooling: () =>
      fetchJson<TestToolingState>(fetchImpl, apiUrl('/api/admin/test-tooling'), {
        method: 'DELETE',
      }),
    resetUserLeaveData: (userId) =>
      fetchJson<ResetUserResult>(
        fetchImpl,
        apiUrl('/api/admin/test-tooling/reset-user'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        },
      ),
    resetDirectory: (input) =>
      fetchJson<ResetDirectoryResult>(
        fetchImpl,
        apiUrl('/api/admin/test-tooling/reset-directory'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
  }
}

export const adminApi = createAdminApiClient()
