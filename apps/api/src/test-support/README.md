# test-support

Shared fixtures/helpers for the API specs (real-Postgres suites).

## Submitting a leave request in a test? Three things are mandatory

`submitLeaveRequest` guards reject anything less (feature: "start date,
country and holiday calendar required"), so every requester fixture needs:

1. **`employmentStartDate`** — the accrual anchor. Without it the profile is
   `pending_setup` and submission throws. Use `'2026-01-01'` (January 1 of the
   fixture year) to accrue from the start of the year — the classic
   "full-year employee" setup most balance arithmetic assumes.
2. **`countryCode`** — selects the holiday calendar that decides which
   requested days are paid. Also part of profile readiness.
3. **A holiday calendar row for (country, request year)** — an ABSENT calendar
   blocks submission; a present-but-EMPTY one passes without excluding any
   dates (so `requestedDays` assertions stay simple):

   ```ts
   import { seedHolidayCalendar } from '../test-support/holiday-calendars'

   await seedHolidayCalendar(service) // UA / 2026 / no holidays, by default
   ```

Symptoms of a missing piece (typical after merging a branch that predates the
guards): `Your profile is not set up yet…`, `No holiday calendar is configured
for UA 2026…`, or `Set the employment start date before editing the
allocation…` (the last one fires from `setEmployeeAllocation`, which needs the
start date only).

## Other helpers here

- `test-database.ts` — `initTestDataSource()` / `truncateAll()` against the
  `leave_management_test` database (see `DB_*` env vars).
- `test-ids.ts` — `testUuid('slug')`, deterministic uuids for fixtures.
