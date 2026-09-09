/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import type { DirectorySyncReportDto } from '@workspace/contracts'
import { emptyDirectorySyncReport } from '@workspace/contracts'
import {
  countsSentence,
  directorySyncChangedAccounts,
  directorySyncFeedback,
  warningsSentence,
  withheldParagraph,
} from './directory-sync-messages'
import type { DirectorySyncRun } from './use-directory-sync-run'

// A clean pass: every list empty, nothing held back. Each test names only the
// fields it is about, so a reader sees the shape that produces the sentence.
function report(
  overrides: Partial<DirectorySyncReportDto> = {},
): DirectorySyncReportDto {
  return {
    ...emptyDirectorySyncReport(),
    ...overrides,
  }
}

describe('countsSentence', () => {
  it('names only the counters that moved', () => {
    expect(
      countsSentence(
        report({ created: ['a@example.com'], deactivated: ['b@example.com'] }),
      ),
    ).toBe('1 created, 1 deactivated.')
  })

  it('claims the directory already matched only when nothing was left unresolved', () => {
    expect(countsSentence(report())).toContain('the directory already matched')
  })

  it('withholds the already-matched claim when a conflict is unresolved', () => {
    // The row is deactivated here and present in LDAP there — the two sides
    // demonstrably do not match, even though no account changed.
    expect(countsSentence(report({ conflicts: ['a@example.com'] }))).toBe(
      'No account was created, updated, or deactivated.',
    )
  })

  it('withholds the already-matched claim when a detail could not be used', () => {
    // The directory holds a value that was stored as null here, so the two
    // sides do not match even though no account changed.
    expect(
      countsSentence(
        report({
          warnings: ['account "a@example.com" has country code "Berlin"'],
        }),
      ),
    ).toBe('No account was created, updated, or deactivated.')
  })

  it('counts role grants and revocations as changes', () => {
    expect(
      countsSentence(
        report({
          adminGranted: ['a@example.com'],
          employeeRevoked: ['b@example.com', 'c@example.com'],
        }),
      ),
    ).toBe('1 administrator role granted, 2 employee roles revoked.')
  })

  it('never claims a match over a role-only pass', () => {
    // A person moved out of the admin group with no profile change: rows moved
    // in user_roles even though no account did, and "already matched" would
    // stand over a revocation the admin never saw.
    const sentence = countsSentence(report({ adminRevoked: ['a@example.com'] }))

    expect(sentence).toBe('1 administrator role revoked.')
    expect(sentence).not.toContain('already matched')
  })

  it('reports a created account and its creation grant as two facts', () => {
    // Creation is a grant per the contract, so one new person moves two
    // counters; netting them out would hide the role behind the creation.
    expect(
      countsSentence(
        report({
          created: ['a@example.com'],
          employeeGranted: ['a@example.com'],
        }),
      ),
    ).toBe('1 created, 1 employee role granted.')
  })

  it('keeps the counters in one fixed order', () => {
    // The order is part of the sentence: account movements first, then roles,
    // administrator before employee, grant before revoke. A reorder would make
    // screenshots and the audit trail disagree about the same pass.
    expect(
      countsSentence(
        report({
          created: ['a@example.com'],
          updated: ['b@example.com'],
          deactivated: ['c@example.com'],
          adminGranted: ['d@example.com'],
          adminRevoked: ['e@example.com'],
          employeeGranted: ['f@example.com'],
          employeeRevoked: ['g@example.com'],
        }),
      ),
    ).toBe(
      '1 created, 1 updated, 1 deactivated, 1 administrator role granted, 1 administrator role revoked, 1 employee role granted, 1 employee role revoked.',
    )
  })

  it('withholds the already-matched claim when a group member matched nobody', () => {
    // The access group names a person the user tree does not carry — the two
    // sides demonstrably disagree, even though no account changed.
    expect(
      countsSentence(
        report({ staleAccessMembers: ['cn=gone,ou=leaverequest-app'] }),
      ),
    ).toBe('No account was created, updated, or deactivated.')
  })

  it('withholds the already-matched claim whenever deactivation was withheld', () => {
    // A pass that stopped before comparing never established a match at all,
    // and the flag says so even when the lists behind it are empty.
    expect(
      countsSentence(
        report({
          skipped: ['entry "uid=bob" has no mail'],
          deactivationWithheld: true,
        }),
      ),
    ).not.toContain('already matched')
    expect(
      countsSentence(report({ deactivationWithheld: true })),
    ).not.toContain('already matched')
  })
})

describe('withheldParagraph', () => {
  it('counts the problems that held deactivation back', () => {
    expect(
      withheldParagraph(
        report({
          skipped: ['entry "uid=bob" has no mail'],
          duplicateEmails: ['a@example.com'],
          deactivationWithheld: true,
        }),
      ),
    ).toMatch(
      /^1 directory entry could not be read and 1 address appeared on more than one entry\./,
    )
  })

  it('keeps warnings out of the reasons and names them apart', () => {
    // A warning never withholds anything; listed as a cause it would send an
    // admin fixing directory entries that change nothing.
    const paragraph = withheldParagraph(
      report({
        skipped: ['entry "uid=bob" has no mail'],
        warnings: ['country code "Germany" is not an ISO 3166-1 alpha-2 code'],
        deactivationWithheld: true,
      }),
    )

    expect(paragraph).toMatch(/^1 directory entry could not be read\./)
    expect(paragraph).toContain(
      'Separately, 1 directory entry had details the sync could not use.',
    )
  })

  it('describes the phases rather than asserting accounts were created', () => {
    // Nothing was created or updated in this pass, so the paragraph may only
    // say which steps ran — not that they produced anything.
    expect(
      withheldParagraph(
        report({
          skipped: ['entry "uid=bob" has no mail'],
          deactivationWithheld: true,
        }),
      ),
    ).toContain(
      'Only deactivation was held back: the create and update steps still ran.',
    )
  })

  it('does not blame unreadable entries when duplicates held the pass back', () => {
    // Duplicated addresses are read perfectly well and dropped as ambiguous,
    // so the explanation has to cover both kinds of unusable entry.
    const paragraph = withheldParagraph(
      report({
        duplicateEmails: ['a@example.com'],
        deactivationWithheld: true,
      }),
    )

    expect(paragraph).toMatch(/^1 address appeared on more than one entry\./)
    expect(paragraph).not.toContain('cannot read')
  })

  it('still reads as a sentence when the server withheld for an uncounted reason', () => {
    // deactivationWithheld is the server's decision; the lists explaining it
    // may be empty if the rule ever grows a trigger they do not carry.
    const paragraph = withheldParagraph(report({ deactivationWithheld: true }))

    expect(paragraph).toMatch(/^Deactivation was held back for the whole pass/)
  })
})

describe('warningsSentence', () => {
  it('pluralizes on the count', () => {
    expect(warningsSentence(report({ warnings: ['one'] }))).toBe(
      '1 directory entry had details the sync could not use.',
    )
    expect(warningsSentence(report({ warnings: ['one', 'two'] }))).toBe(
      '2 directory entries had details the sync could not use.',
    )
  })
})

describe('directorySyncFeedback', () => {
  const completed = (
    overrides: Partial<DirectorySyncReportDto> = {},
  ): DirectorySyncRun => ({
    status: 'done',
    result: { status: 'completed', report: report(overrides) },
  })

  it('says nothing before a run and while one is in flight', () => {
    // The button carries its own "Syncing…" label; an alert on top of it would
    // say the same thing twice.
    expect(directorySyncFeedback({ status: 'idle' })).toBeNull()
    expect(directorySyncFeedback({ status: 'running' })).toBeNull()
  })

  it('passes a failure through as an error, word for word', () => {
    // The message arrives already worded for people — the server picks the
    // phrase and keeps the raw error in the audit log.
    expect(
      directorySyncFeedback({
        status: 'error',
        message: 'The directory did not answer in time.',
      }),
    ).toEqual({
      severity: 'error',
      message: 'The directory did not answer in time.',
    })
  })

  it('counts a pass that changed people as a success', () => {
    expect(
      directorySyncFeedback(
        completed({ created: ['a@example.com'], updated: ['b@example.com'] }),
      ),
    ).toEqual({ severity: 'success', message: '1 created, 1 updated.' })
  })

  it('counts a pass that changed nobody as a success too', () => {
    const feedback = directorySyncFeedback(completed())

    expect(feedback?.severity).toBe('success')
    expect(feedback?.message).toBe(
      'No accounts were created, updated, or deactivated — the directory already matched.',
    )
  })

  it('turns a withheld deactivation yellow and says why', () => {
    // The counters alone would read as "all fine" — the whole point of the
    // second phrase is that they are not the whole story.
    const feedback = directorySyncFeedback(
      completed({
        skipped: ['entry "uid=bob" has no mail'],
        deactivationWithheld: true,
      }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toContain(
      'No account was created, updated, or deactivated.',
    )
    expect(feedback?.message).toContain('Deactivation was held back')
  })

  it('keeps warnings in a green pass without turning it yellow', () => {
    const feedback = directorySyncFeedback(
      completed({
        created: ['a@example.com'],
        warnings: ['country code "Germany" is not an ISO 3166-1 alpha-2 code'],
      }),
    )

    expect(feedback?.severity).toBe('success')
    expect(feedback?.message).toBe(
      '1 created. Separately, 1 directory entry had details the sync could not use. Only those details were dropped; the audit log says what could not be used.',
    )
  })

  it('reports a warning without claiming anybody was synced', () => {
    // The same entry warns on every pass until the directory is corrected, so
    // this is what a run looks like for as long as the field goes unfixed —
    // and nothing was written, which is why the note may not say the account
    // was synced anyway.
    const feedback = directorySyncFeedback(
      completed({
        warnings: ['account "a@example.com" has country code "Berlin"'],
      }),
    )

    expect(feedback?.severity).toBe('success')
    expect(feedback?.message).toBe(
      'No account was created, updated, or deactivated. Separately, 1 directory entry had details the sync could not use. Only those details were dropped; the audit log says what could not be used.',
    )
  })

  it('keeps a pass that only moved roles green and says what moved', () => {
    // Role movements are applied changes, not something left for the admin to
    // resolve — a yellow here would turn every onboarding pass yellow, since
    // creation is a grant per the contract.
    const feedback = directorySyncFeedback(
      completed({ employeeGranted: ['a@example.com'] }),
    )

    expect(feedback?.severity).toBe('success')
    expect(feedback?.message).toBe('1 employee role granted.')
  })

  it('turns a pass with stale group members yellow and hedges the cleanup', () => {
    const feedback = directorySyncFeedback(
      completed({ staleAccessMembers: ['cn=gone,ou=leaverequest-app'] }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toContain(
      "1 member of the application's access groups matched nobody in the synced staff tree.",
    )
    // The hedge is load-bearing: a bad search base or filter, or a member
    // added while the pass was reading, produces the same shape as a genuine
    // leaver, so the sentence must never order an unconditional cleanup.
    expect(feedback?.message).toContain('or filter that misses their subtree')
    expect(feedback?.message).toContain('verify before removing')
    expect(feedback?.message).not.toContain('already matched')
  })

  it('turns even a creating pass yellow when a group member is stale', () => {
    const feedback = directorySyncFeedback(
      completed({
        created: ['a@example.com'],
        staleAccessMembers: ['cn=gone,ou=leaverequest-app', 'cn=left,ou=leaverequest-app'],
      }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toContain('1 created.')
    expect(feedback?.message).toContain(
      "2 members of the application's access groups matched nobody in the synced staff tree.",
    )
  })

  it('names the reappeared account before the stale group member', () => {
    // Both sentences hand the admin an action item; which one they read first
    // must not drift with a refactor, so the order is pinned, re-hire first —
    // it is the only one blocking a real person from using the app.
    const feedback = directorySyncFeedback(
      completed({
        conflicts: ['rehire@example.com'],
        staleAccessMembers: ['cn=gone,ou=leaverequest-app'],
      }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toMatch(
      /back in the directory[\s\S]*matched nobody in the synced staff tree/,
    )
  })

  it('keeps role counters in front of a withheld explanation', () => {
    // A pass can move roles and still withhold deactivation; suppressing the
    // role counters whenever the flag is set would hide applied changes.
    const feedback = directorySyncFeedback(
      completed({
        employeeGranted: ['a@example.com'],
        skipped: ['entry "uid=bob" has no mail'],
        deactivationWithheld: true,
      }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toMatch(/^1 employee role granted\./)
    expect(feedback?.message).toContain('Deactivation was held back')
  })

  it('appends the warnings note to a role-only pass', () => {
    // The warnings tail must not be gated on account counters: a pass that
    // only moved roles still dropped the detail it warns about.
    const feedback = directorySyncFeedback(
      completed({
        adminGranted: ['a@example.com'],
        warnings: ['country code "Berlin" is not an ISO 3166-1 alpha-2 code'],
      }),
    )

    expect(feedback?.severity).toBe('success')
    expect(feedback?.message).toBe(
      '1 administrator role granted. Separately, 1 directory entry had details the sync could not use. Only those details were dropped; the audit log says what could not be used.',
    )
  })

  it('turns a pass with a reappeared account yellow and says what to do', () => {
    // A conflict is the one outcome waiting for a conscious admin decision;
    // green with no mention would leave a re-hire deactivated indefinitely
    // with nothing on this surface ever pointing at them.
    const feedback = directorySyncFeedback(
      completed({ created: ['new@example.com'], conflicts: ['rehire@example.com'] }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toContain('1 created.')
    expect(feedback?.message).toContain(
      '1 previously deactivated account is back in the directory.',
    )
    expect(feedback?.message).toContain('reactivated from their profile')
  })

  it('names reappeared accounts after the withheld explanation too', () => {
    const feedback = directorySyncFeedback(
      completed({
        skipped: ['entry "uid=bob" has no mail'],
        conflicts: ['a@example.com', 'b@example.com'],
        deactivationWithheld: true,
      }),
    )

    expect(feedback?.severity).toBe('warning')
    expect(feedback?.message).toContain('Deactivation was held back')
    expect(feedback?.message).toContain(
      '2 previously deactivated accounts are back in the directory.',
    )
  })

  it('reports the two non-completed outcomes in their own colors', () => {
    const alreadyRunning = directorySyncFeedback({
      status: 'done',
      result: { status: 'already-running' },
    })
    expect(alreadyRunning?.severity).toBe('info')
    expect(alreadyRunning?.message).toContain(
      'Another sync is already running',
    )

    // "No usable entries", not "empty": the same status also covers a
    // directory whose every entry was skipped as unmappable.
    const emptyDirectory = directorySyncFeedback({
      status: 'done',
      result: { status: 'empty-directory' },
    })
    expect(emptyDirectory?.severity).toBe('warning')
    expect(emptyDirectory?.message).toContain(
      'The directory returned no usable entries',
    )
  })
})

describe('directorySyncChangedAccounts', () => {
  it('is false when no pass ran to completion', () => {
    expect(directorySyncChangedAccounts(null)).toBe(false)
    expect(directorySyncChangedAccounts({ status: 'already-running' })).toBe(
      false,
    )
    expect(directorySyncChangedAccounts({ status: 'empty-directory' })).toBe(
      false,
    )
  })

  it('is false for a completed pass that moved nobody', () => {
    // Conflicts, warnings, and stale group members leave every row as it was:
    // reloading the list would throw away the admin's "Load more" pages to
    // redraw the same rows. A stale member's own account, if any, follows the
    // ordinary absence rule and shows up in `deactivated` instead.
    expect(
      directorySyncChangedAccounts({
        status: 'completed',
        report: report({
          conflicts: ['a@example.com'],
          warnings: ['w'],
          staleAccessMembers: ['cn=gone,ou=leaverequest-app'],
        }),
      }),
    ).toBe(false)
  })

  it('is true as soon as any counter moved', () => {
    for (const overrides of [
      { created: ['a@example.com'] },
      { updated: ['a@example.com'] },
      { deactivated: ['a@example.com'] },
    ]) {
      expect(
        directorySyncChangedAccounts({
          status: 'completed',
          report: report(overrides),
        }),
      ).toBe(true)
    }
  })

  it('is true when a pass only moved roles', () => {
    // Roles render as the row chips and the header cards of active holders,
    // both from the list payload — a role-only pass redraws them too.
    for (const overrides of [
      { adminGranted: ['a@example.com'] },
      { adminRevoked: ['a@example.com'] },
      { employeeGranted: ['a@example.com'] },
      { employeeRevoked: ['a@example.com'] },
    ]) {
      expect(
        directorySyncChangedAccounts({
          status: 'completed',
          report: report(overrides),
        }),
      ).toBe(true)
    }
  })
})
