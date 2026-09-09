/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// The sentences the directory-sync result alert says out loud. Deliberately
// free of JSX so they stay unit-testable in the node test environment, and
// every claim here is one an admin acts on.
//
// The skipped and warning entries themselves are never worded — each is a
// sentence naming one person, a skipped entry by its full DN and a warning by
// the address it mapped to, which belongs in the audit trail rather than in the
// result of a button press — but their counts are, or "held back" reads as
// arbitrary.
import type {
  DirectorySyncReportDto,
  DirectorySyncResultDto,
} from '@workspace/contracts'
import type { DirectorySyncRun } from './use-directory-sync-run'

type ProblemCount = { count: number; one: string; many: string }

const unreadableEntries = (report: DirectorySyncReportDto): ProblemCount => ({
  count: report.skipped.length,
  one: 'directory entry could not be read',
  many: 'directory entries could not be read',
})

const duplicateAddresses = (report: DirectorySyncReportDto): ProblemCount => ({
  count: report.duplicateEmails.length,
  one: 'address appeared on more than one entry',
  many: 'addresses appeared on more than one entry',
})

// Entries, not accounts: the list holds one warning per directory entry, and
// two entries carrying the same address are two warnings about one person. The
// pass drops such an address rather than syncing either entry, so counting
// accounts here would claim more people than the run ever had.
const unusableDetails = (report: DirectorySyncReportDto): ProblemCount => ({
  count: report.warnings.length,
  one: 'directory entry had details the sync could not use',
  many: 'directory entries had details the sync could not use',
})

/**
 * "2 directory entries could not be read and 1 address appeared on more than
 * one entry." Empty when nothing is worth counting, so a caller can drop the
 * sentence rather than print a lead-in with nothing behind it.
 */
export function countedSentence(parts: ProblemCount[]): string {
  const counted = parts
    .filter((part) => part.count > 0)
    .map((part) => `${part.count} ${part.count === 1 ? part.one : part.many}`)

  if (counted.length === 0) {
    return ''
  }

  const listed =
    counted.length === 1
      ? counted[0]
      : `${counted.slice(0, -1).join(', ')} and ${counted[counted.length - 1]}`

  return `${listed}.`
}

/**
 * Why deactivation stopped, and what that did and did not affect.
 *
 * Only the two problems that actually withhold the phase are named as reasons.
 * A warning never holds anything back, so it is mentioned apart from them —
 * listed among the causes it would send an admin hunting for a directory fix
 * that changes nothing.
 */
export function withheldParagraph(report: DirectorySyncReportDto): string {
  const causes = countedSentence([
    unreadableEntries(report),
    duplicateAddresses(report),
  ])

  return [
    // Empty when the server withheld for a reason these lists do not carry.
    // The rest of the paragraph stands on its own, and the audit log has the
    // detail either way.
    causes,
    // Covers both causes without naming either: an entry the sync could not
    // read and an address it could not tell apart are equally unusable as
    // proof that somebody left.
    'Deactivation was held back for the whole pass — an entry the sync cannot account for could belong to someone who is still here.',
    'Only deactivation was held back: the create and update steps still ran.',
    report.warnings.length > 0 ? `Separately, ${warningsSentence(report)}` : '',
    'The audit log names the entries involved and what was wrong with each — correct them in the directory, then run the sync again.',
  ]
    .filter((sentence) => sentence.length > 0)
    .join(' ')
}

/** The warnings-only note, for a pass that withheld nothing. */
export function warningsSentence(report: DirectorySyncReportDto): string {
  return countedSentence([unusableDetails(report)])
}

/**
 * Counters as a sentence rather than a row of tiles: most runs change nothing,
 * and "No changes" reads better than three zeroes.
 */
export function countsSentence(report: DirectorySyncReportDto): string {
  const roleCount = (
    emails: string[],
    role: 'administrator' | 'employee',
    verb: 'granted' | 'revoked',
  ): string | null =>
    emails.length > 0
      ? `${emails.length} ${role} role${emails.length === 1 ? '' : 's'} ${verb}`
      : null

  const changes = [
    report.created.length > 0 ? `${report.created.length} created` : null,
    report.updated.length > 0 ? `${report.updated.length} updated` : null,
    report.deactivated.length > 0
      ? `${report.deactivated.length} deactivated`
      : null,
    // Role movements are applied changes of the same class as the three
    // counters above, so they join the list and displace "already matched" on
    // a pass that only moved roles. A newly created account moves two counters
    // by design — creation is a grant per the contract, and "1 created,
    // 1 employee role granted" is two facts about one person; netting them out
    // would hide the role behind the creation.
    roleCount(report.adminGranted, 'administrator', 'granted'),
    roleCount(report.adminRevoked, 'administrator', 'revoked'),
    roleCount(report.employeeGranted, 'employee', 'granted'),
    roleCount(report.employeeRevoked, 'employee', 'revoked'),
  ].filter((part): part is string => part !== null)

  if (changes.length > 0) {
    return `${changes.join(', ')}.`
  }

  // "Already matched" is a claim about the whole directory, so it may only be
  // made when the pass left nothing unresolved: a conflict means the two sides
  // disagree about someone, a withheld deactivation means the comparison never
  // ran to the end, and a warning means the directory carries a detail that
  // could not be used and was stored as null. A warning also comes back on
  // every pass until the directory is corrected, so counting it as resolved
  // would make the claim the standing description of a directory holding a
  // value the sync cannot read. The withhold is read as the flag the server
  // sets, not re-derived from the lists behind it, so a reason those lists do
  // not carry still silences the claim.
  const unresolved =
    report.conflicts.length > 0 ||
    report.deactivationWithheld ||
    report.warnings.length > 0 ||
    // A stale group member is the two sides visibly disagreeing: the access
    // group names a person the user tree does not carry, and the entry comes
    // back on every pass until the group is cleaned up — the same steady-state
    // reasoning as a warning.
    report.staleAccessMembers.length > 0

  return unresolved
    ? 'No account was created, updated, or deactivated.'
    : 'No accounts were created, updated, or deactivated — the directory already matched.'
}

/** The string union is assignable to MUI's AlertColor, kept UI-library-free. */
export type DirectorySyncFeedback = {
  severity: 'success' | 'info' | 'warning' | 'error'
  message: string
}

/**
 * The one alert the Directory card shows for a finished run, or null while
 * there is nothing to say — no run yet, or one still in flight, which the
 * button's own "Syncing…" label already covers.
 *
 * The severity carries the verdict, not just a tint: anything that stopped
 * short of a clean pass is warning or worse, so an admin who only glances at
 * the color still learns whether the directory can be trusted.
 */
export function directorySyncFeedback(
  run: DirectorySyncRun,
): DirectorySyncFeedback | null {
  if (run.status === 'idle' || run.status === 'running') {
    return null
  }

  if (run.status === 'error') {
    return { severity: 'error', message: run.message }
  }

  const { result } = run
  if (result.status === 'already-running') {
    return {
      severity: 'info',
      message:
        'Another sync is already running — a scheduled pass or another administrator got there first. Nothing was changed by this attempt.',
    }
  }

  if (result.status === 'empty-directory') {
    // "No usable entries", not "empty": the server answers this way both for a
    // directory with nothing in it and for one whose every entry was skipped
    // as unmappable — "came back empty" would send an admin debugging the
    // connection while the entries sit right there.
    return {
      severity: 'warning',
      message:
        'The directory returned no usable entries, so nothing was synced and nobody was deactivated. That is almost always a configuration problem rather than an empty company, so the run was recorded as a failure.',
    }
  }

  const { report } = result
  const message = [
    // Counters first, then the reasons: the counters alone read as "all fine",
    // which is exactly the false claim a withheld deactivation or a reappeared
    // account must not let stand.
    countsSentence(report),
    report.deactivationWithheld ? withheldParagraph(report) : '',
    conflictsSentence(report),
    staleAccessSentence(report),
    // A warning never withholds anything, so it is named apart from the
    // reasons — but only when the withheld paragraph has not already done so.
    // The second half names neither a number nor anybody being synced: the
    // count in front of it can be one account or many, and a pass that changed
    // nobody dropped a detail without writing a single row.
    !report.deactivationWithheld && report.warnings.length > 0
      ? `Separately, ${warningsSentence(report)} Only those details were dropped; the audit log says what could not be used.`
      : '',
  ]
    .filter((sentence) => sentence.length > 0)
    .join(' ')

  return {
    // A withheld deactivation, a reappeared account, and a stale group member
    // all leave the admin something to resolve, so none may read as green.
    // Role movements deliberately do not raise the color: they are applied
    // changes of the same class as created/updated — and creation is a grant,
    // so a yellow on role activity would turn every onboarding pass yellow
    // and wear the color out.
    severity:
      report.deactivationWithheld ||
      report.conflicts.length > 0 ||
      report.staleAccessMembers.length > 0
        ? 'warning'
        : 'success',
    message,
  }
}

/**
 * The re-hire case: a deactivated account that reappeared in the directory.
 * Named in the alert because it is the one outcome that waits for a conscious
 * admin decision — the sync never reactivates anyone on its own, so nothing
 * else will ever point at these rows on this surface.
 */
function conflictsSentence(report: DirectorySyncReportDto): string {
  const count = report.conflicts.length
  if (count === 0) {
    return ''
  }

  return `${count} previously deactivated ${
    count === 1 ? 'account is' : 'accounts are'
  } back in the directory. The sync never reactivates anyone — a genuine re-hire must be reactivated from their profile.`
}

/**
 * Members of the application's access groups that matched nobody in the user
 * tree. Worded with the same hedge as the contract: the usual cause is
 * offboarding that forgot the groups, but a search base or filter that misses
 * their subtree, or a member added while the pass was reading, produces the
 * same shape — so the sentence asks for verification, never for blind cleanup.
 * Only an addition can fake the shape mid-pass: the user tree is read before
 * the groups, so a member removed in between simply misses the snapshot.
 */
function staleAccessSentence(report: DirectorySyncReportDto): string {
  const count = report.staleAccessMembers.length
  if (count === 0) {
    return ''
  }

  return `${count} ${
    count === 1 ? 'member' : 'members'
  } of the application's access groups matched nobody in the synced staff tree. That usually means someone left the staff tree without being removed from the groups, but a search base or filter that misses their subtree, or a member added while the pass was reading, looks the same — verify before removing anyone from the groups; the audit log lists the DNs.`
}

/**
 * Whether a finished run changed what the directory list and detail panes
 * show. Only a completed pass that actually wrote something counts: reloading
 * the list starts it over at the first page, throwing away every page the
 * admin pulled in with "Load more" — a steep price for redrawing the same
 * rows, and most passes change nobody. A pass that only moved roles still
 * counts: roles are drawn as the chips on the rows and as the header cards
 * counting active role holders, both read from the list payload, so skipping
 * the refetch would leave both surfaces showing roles the pass just changed.
 * Conflicts and stale group members are excluded on the price-of-reload
 * reasoning: the sync writes no row for either.
 */
export function directorySyncChangedAccounts(
  result: DirectorySyncResultDto | null,
): boolean {
  if (result?.status !== 'completed') {
    return false
  }

  const { report } = result
  return (
    report.created.length +
      report.updated.length +
      report.deactivated.length +
      report.adminGranted.length +
      report.adminRevoked.length +
      report.employeeGranted.length +
      report.employeeRevoked.length >
    0
  )
}
