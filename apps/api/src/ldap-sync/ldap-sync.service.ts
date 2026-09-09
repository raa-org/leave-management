/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Logger } from '@nestjs/common'
import type { Entry } from 'ldapts'
import { AppRoleName } from '@workspace/contracts'
import { ClockService } from '../domain/clock.service'
import { LeaveDomainService } from '../domain/leave-domain.service'
import type {
  DirectorySyncReport,
  DirectoryUserInput,
} from '../domain/leave-domain.types'
import { DirectoryMembershipRefusedError } from './directory-sync-failure'
import { LdapDirectoryClient } from './ldap-client'
import { normalizeDn, stripUniqueMemberUid } from './ldap-dn'
import { mapLdapEntry } from './ldap-entry.mapper'

export type LdapSyncRunResult =
  /** A full pass ran; the report carries the per-entry skip reasons too. */
  | { status: 'completed'; report: DirectorySyncReport }
  /** Another replica (or a manual run) holds the sync lock — nothing was done. */
  | { status: 'already-running' }
  /**
   * LDAP answered but no entry was usable. Nothing is synced and NOBODY is
   * deactivated: an unexpectedly empty directory is far more likely a broken
   * filter/base DN than the whole company resigning at once.
   */
  | { status: 'empty-directory' }

/**
 * Orchestrates one sync pass: read the directory → decide who is an app user
 * (lrs-* group membership, matched by DN) → map the members → hand the batch
 * to the domain. This is the one place where the staff tree and the groups
 * meet, so the membership decisions live here: which entries enter the batch,
 * which roles each carries, which group members are stale, and when the
 * numbers are suspicious enough to refuse the pass outright. All user-table
 * decisions (locking, matching, deactivation policy, audit) live in
 * LeaveDomainService; all LDAP I/O lives in LdapDirectoryClient.
 *
 * Mutual exclusion is the domain's: syncUsersFromDirectory takes a
 * transaction-scoped advisory lock as the first statement of its own
 * transaction and returns null when another pass holds it. The LDAP read
 * therefore happens OUTSIDE any lock — two replicas may both fetch (harmless
 * reads); only one applies its batch, and the loser's next scheduled pass
 * re-reads a fresh directory anyway.
 *
 * Errors (LDAP down, bad credentials, database failure) propagate to the
 * caller: the scheduler catches and logs them so a failed pass
 * never crashes the app, and the database is left untouched (the domain
 * transaction either never started or rolled back).
 *
 * Not a Nest provider yet — the module wires it via a factory, same as the
 * client. Plain constructor keeps it unit-testable without a DI container.
 */
export class LdapSyncService {
  private readonly logger = new Logger(LdapSyncService.name)

  constructor(
    private readonly client: LdapDirectoryClient,
    private readonly domain: LeaveDomainService,
    private readonly clock: ClockService,
  ) {}

  async runSync(): Promise<LdapSyncRunResult> {
    // Captured BEFORE the read: rows created after this instant may
    // legitimately be missing from the fetched snapshot, and the domain must
    // never deactivate what the fetch could not have seen. Through the
    // domain's clock so the comparison against users.createdAt (stamped by
    // the same clock, including the QA test-tooling offset) stays coherent.
    const fetchedAt = this.clock.nowIso()
    const { entries, adminMemberDns, employeeMemberDns } =
      await this.client.fetchDirectory()

    // A read that found no entries is judged before ANY membership work: an
    // empty staff tree is almost always a user-search configuration problem
    // (broken base DN or filter), and measuring membership against it would
    // blame the groups instead — every legitimate member would come out
    // "stale", with cleanup advice that, followed, strips the whole
    // company's app access.
    if (entries.length === 0) {
      // No stale members and no non-member count on this path: membership
      // was never judged, per the rationale above.
      return this.recordEmptyPass(0, [], [], 0, fetchedAt)
    }

    // Group members are matched to entries by DN. Both sides come from the
    // same server, so normalization folds case, separator spacing and
    // Unicode composition (see ldap-dn); a member value may additionally
    // carry the nameAndOptionalUID bit-string suffix, cut before
    // normalizing. Each value is processed exactly once into a
    // {raw, display, key} record (see groupMemberDns), so the spelling a
    // report or log shows and the key that judged it can never drift apart.
    const adminMembers = groupMemberDns(adminMemberDns)
    const employeeMembers = groupMemberDns(employeeMemberDns)
    // Entry DNs are likewise normalized once, next to their entry, and the
    // guard derives the key Sets it judges with and hands them back — one
    // derivation serves the refuse verdict and the membership loop alike,
    // so the two cannot diverge.
    const entryRecords = entries.map((entry) => ({
      entry,
      key: normalizeDn(entry.dn),
    }))
    const { adminKeys, employeeKeys } = this.refuseUnusableMembership(
      entryRecords,
      adminMembers,
      employeeMembers,
    )

    const users: DirectoryUserInput[] = []
    const skipped: string[] = []
    const warnings: string[] = []
    // Entries present in the staff tree but in neither group: test, guest and
    // technical accounts. Counted for the summary line, but deliberately not
    // named anywhere — they are the NORMAL case, recurring every pass, and
    // per-name output would bury the log lines that need acting on.
    let nonMembers = 0
    for (const { entry, key } of entryRecords) {
      // Membership decides FIRST, on the DN alone: a non-member entry is not
      // an app user, so its attributes are never mapped — a guest account
      // with a broken mail must not surface as a skip (which would withhold
      // deactivation) or a warning (which would page an admin) for a person
      // the sync was never going to store.
      const roleNames: AppRoleName[] = []
      if (employeeKeys.has(key)) {
        roleNames.push(AppRoleName.Employee)
      }
      if (adminKeys.has(key)) {
        roleNames.push(AppRoleName.Administrator)
      }
      if (roleNames.length === 0) {
        nonMembers += 1
        continue
      }

      const mapping = mapLdapEntry(entry)
      if (!mapping.ok) {
        skipped.push(mapping.reason)
        this.logger.warn(`Skipping directory entry: ${mapping.reason}`)
        continue
      }
      for (const warning of mapping.warnings) {
        warnings.push(warning)
        this.logger.warn(`Directory entry warning: ${warning}`)
      }
      // Hand the domain exactly the DirectoryUserInput shape — the mapper's
      // internal `normalizedEmail` is re-derived downstream, so it must not
      // leak into the domain contract.
      users.push({
        email: mapping.user.email,
        displayName: mapping.user.displayName,
        countryCode: mapping.user.countryCode,
        roleNames,
      })
    }

    // Group members with no entry in the staff tree: someone left the
    // company and their group membership was not cleaned up (the groups
    // grant app access, not employment, so offboarding routinely forgets
    // them). Matched against ALL entries — including ones the mapper later
    // skips — because a member whose entry merely failed to map is still
    // present in the tree, and telling an admin to remove them from the
    // groups would be wrong advice. Deduplicated by key (a person sits in
    // both groups), reporting the first spelling — uid suffix cut, since
    // the suffix is not part of the DN.
    const entryKeySet = new Set(entryRecords.map((record) => record.key))
    const staleAccessMembers: string[] = []
    const staleSeen = new Set<string>()
    for (const member of [...adminMembers, ...employeeMembers]) {
      if (entryKeySet.has(member.key) || staleSeen.has(member.key)) {
        continue
      }
      staleSeen.add(member.key)
      staleAccessMembers.push(member.display)
    }
    if (staleAccessMembers.length > 0) {
      // Worded as a likelihood, not a diagnosis, and with no deactivation
      // claim: the same no-matching-entry shape is produced by an
      // offboarding that skipped the group cleanup (the usual case), by a
      // base DN / user filter that misses the members' subtree, and by a
      // member added between this pass's user search and its group reads —
      // and whether this pass deactivates anything is the domain's decision,
      // which has not run yet. The DN list is capped: a bulk mismatch must
      // not bury the log (the full list rides the pass's audit row — the
      // completed row via the report, the empty row via recordEmptyPass).
      const shown = staleAccessMembers.slice(0, 10)
      const rest = staleAccessMembers.length - shown.length
      this.logger.warn(
        `${staleAccessMembers.length} lrs group member(s) match no entry in the staff ` +
          `tree — usually someone who left the company without being removed from ` +
          `the app groups, though a search base/filter missing their subtree or a ` +
          `mid-pass addition produces the same shape. Verify, then remove these DNs ` +
          `from the lrs-* groups: ${shown.join('; ')}` +
          (rest > 0
            ? `; and ${rest} more (the full list is in this pass's audit row).`
            : '.'),
      )
    }
    if (nonMembers > 0) {
      this.logger.log(
        `${nonMembers} directory entr${nonMembers === 1 ? 'y' : 'ies'} in ` +
          `neither lrs group stay${nonMembers === 1 ? 's' : ''} out of the sync ` +
          '(test/guest/technical accounts).',
      )
    }

    if (users.length === 0) {
      // Stale members and the non-member count ride along: this row is the
      // only trace the pass leaves, and the stale warning above has already
      // promised the full DN list in the audit trail.
      return this.recordEmptyPass(
        entries.length,
        skipped,
        staleAccessMembers,
        nonMembers,
        fetchedAt,
      )
    }

    if (skipped.length > 0) {
      // The domain withholds the deactivation phase for this pass: a skipped
      // entry is a person the directory lists but we could not key, so
      // absence cannot be trusted.
      this.logger.warn(
        `Deactivation will be withheld: ${skipped.length} unusable directory ` +
          'entries mean absence cannot be trusted this pass.',
      )
    }

    const report = await this.domain.syncUsersFromDirectory(users, {
      fetchedAt,
      skipped,
      warnings,
      staleAccessMembers,
    })
    if (report === null) {
      this.logger.log(
        'Skipping directory sync: another run holds the sync lock.',
      )
      return { status: 'already-running' }
    }

    this.logger.log(
      `Directory sync completed: created=${report.created.length} ` +
        `updated=${report.updated.length} deactivated=${report.deactivated.length} ` +
        `adminGranted=${report.adminGranted.length} adminRevoked=${report.adminRevoked.length} ` +
        `employeeGranted=${report.employeeGranted.length} employeeRevoked=${report.employeeRevoked.length} ` +
        `conflicts=${report.conflicts.length} duplicates=${report.duplicateEmails.length} ` +
        `skipped=${skipped.length} warnings=${warnings.length} ` +
        `nonMembers=${nonMembers} staleMembers=${staleAccessMembers.length}`,
    )
    return { status: 'completed', report }
  }

  /**
   * The empty-pass outcome: warn, best-effort lifecycle trace, and the
   * empty-directory status. Two paths end here — a user search that found
   * nothing at all (no membership judged: stale list empty, non-members
   * zero), and a member set whose entries all failed to map — where the
   * stale members and the non-member count carry over, because this row is
   * the pass's only trace and the stale warning promises the full DN list
   * in the audit trail.
   *
   * The trace is a lifecycle row the domain writes on its non-transactional
   * manager (no transaction was opened for this outcome), recorded as
   * ldap_sync.failed — an empty read is a degraded pass (usually a broken
   * filter/base DN), not a healthy one. fetchedAt doubles as the occurredAt
   * so the row shares the run's instant (and the QA test clock) instead of a
   * second wall-clock read.
   *
   * Best-effort: the trace must never turn a benign empty read into a thrown
   * error. If the write itself fails (e.g. the DB is momentarily
   * unavailable), log the miss and still return empty-directory — otherwise
   * the caller would mis-handle a clean empty result as a hard failure.
   */
  private async recordEmptyPass(
    entriesRead: number,
    skipped: string[],
    staleAccessMembers: string[],
    nonMembers: number,
    fetchedAt: string,
  ): Promise<LdapSyncRunResult> {
    this.logger.warn(
      `Directory returned no usable entries (${entriesRead} read, ` +
        `${skipped.length} skipped) — nothing synced, nobody deactivated.`,
    )
    try {
      await this.domain.recordDirectorySyncEmpty({
        entriesRead,
        skipped,
        staleAccessMembers,
        nonMembers,
        occurredAt: fetchedAt,
      })
    } catch (error) {
      this.logger.error(
        `Failed to record the empty-directory lifecycle row: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return { status: 'empty-directory' }
  }

  /**
   * The mass-deactivation guards. The domain deactivates every active account
   * absent from the batch, so a batch hollowed out for a SUSPICIOUS reason
   * must never reach it — and both reasons here are far more likely a
   * configuration or matching defect than a real "nobody works here anymore":
   *
   * - the employees group with zero members (alone, or with the admins group
   *   also empty): nearly every account's access rides on it, so its
   *   emptiness means wholesale deactivation — never a state this deployment
   *   reaches on purpose, but exactly what an ACL quietly hiding uniqueMember
   *   from the sync account produces, and ACLs are per entry, so one group
   *   can go dark while the other reads fine. The admins group is judged
   *   differently: empty, it admits nobody on its own and endangers at most
   *   the few admin-only accounts, so it warns instead of refusing — a
   *   benign zero-admins directory must not wedge the sync;
   * - the employees group matching NOT ONE entry (alone, or together with
   *   the admins side): the groups and the user tree disagree about the DNs
   *   of everyone whose access rides on that group — a wrong per-environment
   *   folder in the group variables, a base DN that misses the members'
   *   subtree, or a normalization defect. A matching admins group must NOT
   *   soften this: a batch shrunk to the admins deactivates the whole staff
   *   just as surely. A PARTIAL employees match is fine (individual
   *   mismatches surface as staleAccessMembers), and an admins-side total
   *   miss alone is tolerated for the same blast-radius reason as an empty
   *   admins group.
   *
   * Thrown as DirectoryMembershipRefusedError: the scheduler's and the manual
   * endpoint's existing catch paths record it as ldap_sync.failed and show
   * the message verbatim, so a refusal is loud on every surface without a new
   * outcome type. Nothing has been written when this throws.
   *
   * Returns the membership key Sets it judged with, so the caller matches
   * against the very derivation the verdict used.
   */
  private refuseUnusableMembership(
    entryRecords: ReadonlyArray<{ entry: Entry; key: string }>,
    adminMembers: readonly GroupMemberDn[],
    employeeMembers: readonly GroupMemberDn[],
  ): { adminKeys: ReadonlySet<string>; employeeKeys: ReadonlySet<string> } {
    const total = entryRecords.length
    if (adminMembers.length === 0 && employeeMembers.length === 0) {
      this.logger.error(
        `Directory sync refused: both lrs groups came back with zero members while ` +
          `the user search returned ${total} entr${total === 1 ? 'y' : 'ies'}. ` +
          'Acting on this would deactivate every account. Check the service ' +
          "account's read access to the groups' uniqueMember attribute and the " +
          'group contents themselves. Nothing was written.',
      )
      throw new DirectoryMembershipRefusedError(
        'Both lrs groups came back without a single member, so nobody would remain ' +
          'an app user and every account would have been deactivated. The sync ' +
          'refused to act and nothing was written. An empty membership list is far ' +
          'more likely a read-permission problem on the sync account than a real ' +
          'decision — the directory administrators can confirm.',
      )
    }

    if (employeeMembers.length === 0) {
      this.logger.error(
        `Directory sync refused: the employees group (LDAP_EMPLOYEE_GROUP_DN) ` +
          `came back with zero members while the user search returned ` +
          `${total} entr${total === 1 ? 'y' : 'ies'}. Nearly ` +
          `every account's access rides on that group, so acting would ` +
          `deactivate the staff wholesale. Check the service account's read ` +
          "access to the group's uniqueMember attribute and the group contents " +
          'themselves. Nothing was written.',
      )
      throw new DirectoryMembershipRefusedError(
        'The lrs employees group came back without a single member while the ' +
          'admins group has them, so every account outside the admins group ' +
          'would have been deactivated. The sync refused to act and nothing ' +
          'was written. A group emptying out wholesale is far more likely a ' +
          'read-permission problem on the sync account (or an accidental ' +
          'group wipe) than a real decision — the directory administrators ' +
          'can confirm.',
      )
    }
    // An empty admins group is named but NOT refused: it admits nobody on
    // its own, so its emptiness endangers at most the few admin-only
    // accounts — nothing like the employees group's wholesale radius. A
    // benign zero-admins directory must not wedge the sync.
    if (adminMembers.length === 0) {
      this.logger.warn(
        'The admins group (LDAP_ADMIN_GROUP_DN) has zero members this pass — ' +
          'no account is admitted by it.',
      )
    }

    // The key Sets are derived HERE, once, and returned to the caller: the
    // verdict below and the membership loop judge the same objects, so the
    // two cannot diverge.
    const adminKeys = new Set(adminMembers.map((member) => member.key))
    const employeeKeys = new Set(employeeMembers.map((member) => member.key))
    // The employees group carries nearly everyone's access, so it must match
    // ON ITS OWN: a matching admins side would otherwise shrink the batch to
    // the admins and deactivate the rest — the wholesale event this guard
    // exists to refuse. (The group is non-empty here; emptiness refused
    // above.)
    const employeesMatched = entryRecords.some(({ key }) =>
      employeeKeys.has(key),
    )
    if (employeesMatched) {
      return { adminKeys, employeeKeys }
    }

    // Raw-next-to-normalized samples from both sides, so a normalization or
    // suffix defect is visible in the log itself instead of needing a live
    // reproduction against the directory.
    const memberSamples = [...adminMembers, ...employeeMembers]
      .slice(0, 3)
      .map(
        (member) =>
          `${JSON.stringify(member.raw)} -> ${JSON.stringify(member.key)}`,
      )
    const entrySamples = entryRecords
      .slice(0, 3)
      .map(
        ({ entry, key }) =>
          `${JSON.stringify(entry.dn)} -> ${JSON.stringify(key)}`,
      )
    const distinctMembers = new Set([...adminKeys, ...employeeKeys]).size
    const adminsMatched = entryRecords.some(({ key }) => adminKeys.has(key))
    this.logger.error(
      `Directory sync refused: not one of the employees group's ` +
        `${employeeKeys.size} member DN(s) matches any of the ${total} user ` +
        `entries` +
        (adminsMatched
          ? ' (the admins group matches, which would shrink the batch to the admins alone)'
          : `, and neither does any of the ${distinctMembers} distinct member DN(s) overall`) +
        `. Sample member values (raw -> normalized): ${memberSamples.join(', ')}. ` +
        `Sample entry DNs (raw -> normalized): ${entrySamples.join(', ')}. ` +
        'Check that LDAP_ADMIN_GROUP_DN/LDAP_EMPLOYEE_GROUP_DN point at THIS ' +
        "environment's folder and that LDAP_BASE_DN covers the members' subtree. " +
        'Nothing was written.',
    )
    throw new DirectoryMembershipRefusedError(
      'Not one member of the lrs employees group matched any entry of the staff ' +
        'tree, so every account outside the admins group would have been ' +
        'deactivated. The sync refused to act and nothing was written. The ' +
        'groups and the staff tree disagree about DNs — most likely the group ' +
        "settings point at another environment's folder, or the search base " +
        "does not cover the members' subtree. The server log shows samples of " +
        'both sides.',
    )
  }
}

/**
 * One group member value with every derivation the pass needs, computed
 * exactly once: the value as the client hands it over (raw — trimmed by the
 * shared attribute reading, otherwise as the group stores it; what a
 * diagnostic log shows), the spelling reports carry (display — the uid suffix cut,
 * since the suffix is not part of the DN), and the comparison key (the
 * shared DN normalization over that same spelling — exactly the pipeline
 * entry DNs go through, minus the suffix step entries cannot carry).
 * Deriving them together is what keeps a reported spelling and the key
 * that judged it from ever drifting apart.
 */
interface GroupMemberDn {
  raw: string
  display: string
  key: string
}

function groupMemberDns(rawValues: readonly string[]): GroupMemberDn[] {
  return rawValues.map((raw) => {
    // A legal suffix-only value (empty DN + uid, e.g. `#'0101'B`) strips to
    // '' — fall back to the raw spelling so reports never carry a blank row.
    const display = stripUniqueMemberUid(raw) || raw
    return { raw, display, key: normalizeDn(display) }
  })
}
