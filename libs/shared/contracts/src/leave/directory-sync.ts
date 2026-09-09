/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Response shapes for the manual directory-sync endpoint (POST /admin/ldap-sync)
// and the web alert that renders one run's outcome. The domain produces
// these values; the API returns them verbatim, so the type lives in shared
// contracts rather than in the api package.

/**
 * Outcome of one directory sync pass, as email lists (counters are the
 * lengths). Feeds the manual-run report and the audit summary.
 */
export interface DirectorySyncReportDto {
  created: string[]
  updated: string[]
  deactivated: string[]
  /**
   * Deactivated users the directory still admits: their entry is in the
   * staff tree AND in at least one lrs-* group. An entry that merely
   * lingers in the tree with no group membership is an ordinary absence,
   * not a conflict. The sync never reactivates: these rows are left
   * untouched and flagged for manual resolution (either a directory
   * mistake or a real re-hire an admin must consciously reactivate).
   */
  conflicts: string[]
  /**
   * Emails appearing more than once in one directory batch (first raw
   * spelling seen, matching the casing convention of the other lists). The
   * LDAP unique overlay on `mail` is supposed to make this impossible, so any
   * entry here means that guarantee broke — the affected entries are not
   * upserted, and the protection against wrongful deactivation is that the
   * deactivation phase is WITHHELD for the whole pass.
   */
  duplicateEmails: string[]
  /**
   * Reasons the orchestrator skipped unmappable directory entries (no/invalid
   * mail, missing sn), echoed into the report and the audit summary. Any skip
   * withholds the deactivation phase — a skipped entry is a person the
   * directory lists but we could not key.
   */
  skipped: string[]
  /**
   * Non-fatal issues on entries that DID map — e.g. an unusable `l` country
   * value dropped to null. Mapping succeeded, so the entry goes on to the sync
   * itself; it can still be dropped there for a reason of its own, an address
   * that turned up on more than one entry being the one that happens. The
   * warning is surfaced here (and in the audit summary) so an admin sees data
   * problems in the run result, not only in the server logs.
   */
  warnings: string[]
  /**
   * Whether the pass skipped its deactivation phase because the batch could not
   * be trusted. Reported as the decision itself rather than left for the caller
   * to re-derive from `skipped`/`duplicateEmails`: the rule lives in one place,
   * so a future trigger that no list reflects still reaches every reader.
   */
  deactivationWithheld: boolean
  /**
   * Emails granted the administrator role by this pass, from the user_roles
   * diff it applied — never from the input flags, so an unchanged admin is
   * not re-reported every pass (best-effort when a concurrent sign-in of
   * the same person applies part of the same diff first — the stored rows
   * converge, the attribution may name either writer). A user CREATED by
   * this pass appears here too when the role is part of the creation:
   * coming into existence as an admin is an admin grant, and readers
   * watching for new admins must not have to cross-join with `created`.
   */
  adminGranted: string[]
  /**
   * Emails whose administrator role this pass revoked; same diff source.
   * Departures never appear here: deactivating an absent account keeps its
   * role rows untouched, so leaving the company is not a revocation.
   */
  adminRevoked: string[]
  /**
   * Same per-role reporting for the employee role — a role-only pass (a
   * person moved into or out of the employees group with no profile change)
   * must not read as a no-op. Same diff source and creation semantics as
   * the admin pair.
   */
  employeeGranted: string[]
  /** Emails whose employee role this pass revoked; same diff source. */
  employeeRevoked: string[]
  /**
   * Full DNs listed in the lrs-* groups that matched no entry of the user
   * search. Usually people who left the staff tree without being removed
   * from the app groups (the groups grant roles, not employment, so
   * offboarding routinely forgets them) — though a search base or filter
   * that misses their subtree, or a member added while the pass was
   * reading, produces the same shape, so the list asks for verification,
   * not blind cleanup. Accounts such members still have follow the ordinary
   * absent-from-directory rule, with the same deactivation withholds as any
   * other absence; the DNs are reported so an administrator has the group
   * cleanup spelled out.
   */
  staleAccessMembers: string[]
}

/**
 * The all-empty report. Single source for the sync's initial value and for
 * every test fixture, so a new report field cannot be defaulted two
 * different ways in different packages (the type alone catches a missing
 * field, not a wrong default).
 */
export function emptyDirectorySyncReport(): DirectorySyncReportDto {
  return {
    created: [],
    updated: [],
    deactivated: [],
    conflicts: [],
    duplicateEmails: [],
    skipped: [],
    warnings: [],
    deactivationWithheld: false,
    adminGranted: [],
    adminRevoked: [],
    employeeGranted: [],
    employeeRevoked: [],
    staleAccessMembers: [],
  }
}

/**
 * What the manual sync endpoint returns. A discriminated union so the caller
 * (and the web) branches on `status` rather than probing fields:
 * - `completed` — a pass ran; `report` carries the counters and email lists
 *   (a withheld-deactivation pass is still `completed`, told apart by the
 *   report's own `deactivationWithheld` flag).
 * - `already-running` — another run (a replica or a concurrent manual click)
 *   holds the advisory lock; nothing was done.
 * - `empty-directory` — LDAP answered but no entry was usable; nothing synced
 *   and nobody deactivated.
 */
export type DirectorySyncResultDto =
  | { status: 'completed'; report: DirectorySyncReportDto }
  | { status: 'already-running' }
  | { status: 'empty-directory' }

/**
 * What the status endpoint returns, so the directory page can decide whether to
 * offer a sync at all.
 */
export interface DirectorySyncStatusDto {
  /**
   * False when the deployment has LDAP sync switched off. The web hides the
   * button rather than letting an admin click into a guaranteed 409.
   */
  enabled: boolean
}
