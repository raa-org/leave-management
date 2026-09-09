/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Logger } from '@nestjs/common'
import { Client, type Entry } from 'ldapts'
import {
  DirectoryGroupUnreadableError,
  DirectoryReadError,
} from './directory-sync-failure'
import { LDAP_SYNC_ATTRIBUTES, stringValues } from './ldap-entry.mapper'
import type { LdapSyncSettings } from './ldap-sync.config'

/**
 * One directory read, complete: the staff tree plus the membership of both
 * lrs-* groups. The three always travel together because the sync cannot act
 * on a subset — entries without membership cannot say who is an app user,
 * membership without entries cannot say who exists — so a partial result is
 * not a value this type can express.
 */
export interface DirectoryFetch {
  /** Every entry matching the configured base DN and user filter (the staff tree). */
  entries: Entry[]
  /**
   * uniqueMember values of the admins group, in directory order, trimmed
   * with blank values dropped (the shared attribute-reading rule) but
   * otherwise as stored — a nameAndOptionalUID suffix included, when one
   * occurs; normalizing and matching them is the orchestrator's job.
   */
  adminMemberDns: string[]
  /** Same, for the employees group. */
  employeeMemberDns: string[]
}

/** The only object class the lrs-* groups have; anything else at the DN is a misconfiguration. */
const GROUP_FILTER = '(objectClass=groupOfUniqueNames)'

/**
 * Reads the directory for one sync pass. Deliberately dumb: it connects,
 * pages through the user search, reads both group entries, and hands back raw
 * results. Interpreting them (attribute mapping, DN matching, validation) is
 * the mapper's and orchestrator's job, and writing to the database is the
 * domain's.
 *
 * Not a Nest provider yet — the module assembles it and supplies the
 * settings through a factory. Constructing it directly keeps it unit-testable
 * without a DI container.
 */
export class LdapDirectoryClient {
  private readonly logger = new Logger(LdapDirectoryClient.name)

  constructor(private readonly settings: LdapSyncSettings) {
    // Announce the weakened posture once, at construction (= at bootstrap when
    // the module wires it), so it shows up in the boot log instead of only
    // after the first scheduled run. The config has already refused this
    // outside explicitly-local environments.
    if (settings.skipCertVerify) {
      this.logger.warn(
        'LDAP TLS certificate verification is DISABLED (LDAP_TLS_SKIP_CERT_VERIFY=true). ' +
          'The connection is still encrypted but the server is not authenticated — ' +
          'use this for local debugging only.',
      )
    }
  }

  /**
   * Fetch the staff entries and the membership of both lrs-* groups, on one
   * bound connection.
   *
   * Any failure (network, bad credentials, untrusted certificate, an
   * unreadable group) throws a DirectoryReadError wrapping it: the caller
   * catches it, logs, and leaves the database untouched so a half-read
   * directory can never look like "everyone left". A GROUP failure is
   * deliberately not softer than a user-search failure — membership decides
   * who exists and who stays active, so a pass that read the people but not
   * the groups has nothing safe to write. The wrapper is what earns a
   * failure here the right to be reported as the directory's, while
   * everything the sync does afterwards is reported as ours.
   */
  async fetchDirectory(): Promise<DirectoryFetch> {
    const client = new Client({
      url: this.settings.url,
      // Both default to "wait forever" in ldapts. connectTimeout is the one
      // that keeps an unreachable host from holding the admin's request — and
      // any shutdown waiting on it — until the OS gives up on the TCP connect,
      // a minute or more later with nothing to show for the wait. timeout is a
      // deadline per message (the bind, then each page), so it bounds a step
      // and not this read: a directory that keeps answering page by page may
      // take much longer than either value, by design.
      connectTimeout: this.settings.connectTimeoutMs,
      timeout: this.settings.timeoutMs,
      ...(this.settings.tlsOptions
        ? { tlsOptions: this.settings.tlsOptions }
        : {}),
    })

    this.logger.log(
      `Reading ${this.settings.baseDn} from ${this.settings.url} …`,
    )

    try {
      await client.bind(this.settings.bindDn, this.settings.bindPassword)

      // ldapts drives the paged-results control itself and returns the pages
      // already concatenated; pageSize only caps how much crosses the wire at
      // once, which is what keeps us under the server's result-size limit.
      // Requesting only the mapper's attribute list keeps the transfer small —
      // an entry can carry dozens of attributes we have no use for, photos
      // included.
      let entries: Entry[]
      try {
        ;({ searchEntries: entries } = await client.search(
          this.settings.baseDn,
          {
            scope: 'sub',
            filter: this.settings.userFilter,
            attributes: LDAP_SYNC_ATTRIBUTES,
            paged: { pageSize: this.settings.pageSize },
          },
        ))
      } catch (error) {
        // Three searches share this pass; the classified failure sentence the
        // admin sees cannot say which one failed, so each search names its
        // own inputs here — context for whoever reads the log, not a
        // diagnosis (the cause may equally be the network or the server).
        this.logger.error(
          `The user search failed (LDAP_BASE_DN=${JSON.stringify(this.settings.baseDn)}, ` +
            `LDAP_USER_FILTER=${JSON.stringify(this.settings.userFilter)}).`,
        )
        throw error
      }

      this.logger.log(
        `Read ${entries.length} entries from ${this.settings.baseDn}.`,
      )

      // Groups AFTER the user tree, on the same bound connection: their
      // membership decides which of the entries just read are app users at
      // all, so a pass that cannot read them aborts here rather than sync a
      // directory it cannot interpret.
      const adminMemberDns = await this.readGroupMemberDns(
        client,
        this.settings.adminGroupDn,
        'admins',
        'LDAP_ADMIN_GROUP_DN',
      )
      const employeeMemberDns = await this.readGroupMemberDns(
        client,
        this.settings.employeeGroupDn,
        'employees',
        'LDAP_EMPLOYEE_GROUP_DN',
      )

      return { entries, adminMemberDns, employeeMemberDns }
    } catch (error) {
      // Marked here, at the only place that can still tell: past this method a
      // connection failure from our own database is indistinguishable from an
      // unreachable directory, and both end up in front of the same admin.
      throw new DirectoryReadError(error)
    } finally {
      // Never let a teardown failure replace the real error: an unbind that
      // throws while the connection is already broken would otherwise mask
      // the bind/search failure the caller needs to see.
      try {
        await client.unbind()
      } catch (error) {
        this.logger.warn(
          `Failed to unbind from LDAP: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  /**
   * Read one lrs-* group's uniqueMember values, base-scope — the group IS the
   * entry, so there is nothing to page.
   *
   * Failures name the env variable whose DN was searched: the classified
   * sentence the admin later sees covers the whole pass and cannot say which
   * search failed, so the log is where "which one, and what was it asked" has
   * to live. A search that succeeds with NO entry is promoted to a failure
   * here: base-scope can only come back empty when the DN exists but is not a
   * readable groupOfUniqueNames (wrong object, or an ACL hiding it) — for
   * membership purposes that is exactly as unusable as an unreachable server,
   * and quietly returning [] would read as "nobody is an app user".
   *
   * An EMPTY member list from a readable group is returned as-is — telling a
   * truly empty group apart from a hidden attribute is the orchestrator's
   * refuse-decision, not a transport concern.
   */
  private async readGroupMemberDns(
    client: Client,
    groupDn: string,
    groupLabel: string,
    envVar: string,
  ): Promise<string[]> {
    let groupEntries: Entry[]
    try {
      ;({ searchEntries: groupEntries } = await client.search(groupDn, {
        scope: 'base',
        filter: GROUP_FILTER,
        attributes: ['uniqueMember'],
      }))
    } catch (error) {
      this.logger.error(
        `Reading the ${groupLabel} group failed (${envVar}=${JSON.stringify(groupDn)}). ` +
          'If the cause below is noSuchObject, that variable points at nothing on this ' +
          'server — mind that the group OU differs per environment ' +
          '(ou=leaverequest-app in production, ou=leaverequest-dev-app in dev).',
      )
      throw error
    }
    if (groupEntries.length === 0) {
      this.logger.error(
        `The ${groupLabel} group at ${envVar}=${JSON.stringify(groupDn)} matched no ` +
          `${GROUP_FILTER} entry — the DN resolves, but not to a group this service ` +
          'account can read. Check the object class at that DN and the ACL for the ' +
          'bind account.',
      )
      throw new DirectoryGroupUnreadableError(
        `the ${groupLabel} group at ${JSON.stringify(groupDn)} is not a readable groupOfUniqueNames`,
      )
    }
    const members = stringValues(groupEntries[0]?.['uniqueMember'])
    this.logger.log(
      `Read ${members.length} member value(s) from the ${groupLabel} group.`,
    )
    return members
  }
}
