/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  AuthMethodNotSupportedError,
  ConfidentialityRequiredError,
  InappropriateAuthError,
  InsufficientAccessError,
  InvalidCredentialsError,
  NoSuchObjectError,
  SizeLimitExceededError,
  StrongAuthRequiredError,
  TimeLimitExceededError,
} from 'ldapts'
import { describe, expect, it } from 'vitest'
import {
  DirectoryGroupUnreadableError,
  DirectoryMembershipRefusedError,
  DirectoryReadError,
  describeDirectorySyncFailure,
} from './directory-sync-failure'

function withCode(code: string, message = 'connect failed'): Error {
  return Object.assign(new Error(message), { code })
}

// Everything the directory read raises arrives wrapped; only wrapped failures
// may be described as the directory's, so every case below has to say so.
function fromDirectory(error: unknown): DirectoryReadError {
  return new DirectoryReadError(error)
}

/**
 * The sentence an administrator reads decides who fixes the problem, so each
 * cause has to be told apart — and none of them may leak the host, port or base
 * DN that the underlying error carries.
 */
describe('describeDirectorySyncFailure', () => {
  it('names a connection that never opened, without repeating the address', () => {
    const message = describeDirectorySyncFailure(
      fromDirectory(withCode('ETIMEDOUT', 'connect ETIMEDOUT 198.199.171.186:636')),
    )

    expect(message).toContain(
      'No connection to the directory server could be opened in time',
    )
    // The only lever that touches this one. Page size and the per-request
    // budget had no part in a socket that never came up, so advising them here
    // sends an operator to change settings that cannot move the outcome.
    expect(message).toContain('connect timeout can be raised')
    expect(message).not.toContain('smaller pages')
    expect(message).not.toContain('198.199.171.186')
    expect(message).not.toContain('636')
  })

  it('names an unreachable server without repeating the address', () => {
    const message = describeDirectorySyncFailure(
      fromDirectory(
        withCode('ECONNREFUSED', 'connect ECONNREFUSED 198.199.171.186:636'),
      ),
    )

    expect(message).toContain('Could not reach the directory server')
    expect(message).not.toContain('198.199.171.186')
    expect(message).not.toContain('636')
  })

  // One row per code the platform actually reports, so no branch can be
  // dropped silently: the helper's message carries no signal of its own. The
  // timeout codes are deliberately absent — what one means depends on which
  // side of the connection it fell on, so they are pinned phase by phase
  // instead of by code alone.
  it.each([
    ['ECONNREFUSED', 'Could not reach the directory server'],
    ['ENOTFOUND', 'Could not reach the directory server'],
    ['EHOSTUNREACH', 'Could not reach the directory server'],
    ['ENETUNREACH', 'Could not reach the directory server'],
    ['ECONNRESET', 'Could not reach the directory server'],
    ['EAI_AGAIN', 'Could not reach the directory server'],
    // A TLS handshake against a port that speaks plaintext. The certificate
    // sentence would be actively wrong here — nothing was presented to
    // distrust — so these must not fall in with the codes below.
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'not with TLS'],
    ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'not with TLS'],
    ['CERT_HAS_EXPIRED', 'certificate'],
    ['CERT_NOT_YET_VALID', 'certificate'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate'],
    // A directory behind a private CA produces these three far more often than
    // the expiry above, and none of them is named like the others.
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'certificate'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate'],
  ])('maps the %s code onto its cause', (code, phrase) => {
    expect(describeDirectorySyncFailure(fromDirectory(withCode(code)))).toContain(
      phrase,
    )
  })

  // The driver reports what the server itself decided as a NUMERIC code and
  // puts the class name in `name`, so these are built here the way ldapts
  // builds them rather than described second-hand.
  it.each([
    {
      error: new InvalidCredentialsError(),
      phrase: 'refused the account this app signs in with',
    },
    {
      // The server is refusing the credentials it was offered, not the
      // mechanism: an empty or unverifiable password on the service account
      // produces this, so it lands on whoever owns that account, exactly as a
      // wrong password does.
      error: new InappropriateAuthError(),
      phrase: 'refused the account this app signs in with',
    },
    { error: new StrongAuthRequiredError(), phrase: 'refused the way this app signs in' },
    {
      error: new AuthMethodNotSupportedError(),
      phrase: 'refused the way this app signs in',
    },
    {
      error: new ConfidentialityRequiredError(),
      phrase: 'refused the way this app signs in',
    },
    { error: new InsufficientAccessError(), phrase: 'refused the read' },
    {
      // Three configured DNs feed searches (the base and both groups); a typo
      // in any of them must name the settings as the place to fix, not send
      // the admin into generic logs-reading.
      error: new NoSuchObjectError(),
      phrase: 'no entry at one of the configured DNs',
    },
    {
      // The server's own budget, not ours. Its message says "Timeout limit", so
      // without the code behind it this arrives as one of our timeouts and the
      // admin is told to allow longer here, where nothing is waiting.
      error: new TimeLimitExceededError(),
      phrase: 'on a time limit of its own',
    },
  ])('reads the result code behind $error.name', ({ error, phrase }) => {
    expect(describeDirectorySyncFailure(fromDirectory(error))).toContain(phrase)
  })

  it('names the unreadable-group condition from the typed error alone', () => {
    // A zero-entry base-scope group search carries no server result code —
    // the client diagnoses it itself, so the TYPE is the only signal that
    // survives the DirectoryReadError wrapping and must reach the admin as
    // its own sentence, not the unknown bucket's read-the-logs advice.
    const description = describeDirectorySyncFailure(
      fromDirectory(
        new DirectoryGroupUnreadableError(
          'the admins group at "cn=lrs-admins,ou=x" is not a readable groupOfUniqueNames',
        ),
      ),
    )

    expect(description).toContain('not to a group')
    expect(description).toContain('groupOfUniqueNames')
  })

  it('passes a membership refusal through verbatim', () => {
    // The refusing code is the only place that knows which precondition broke
    // and what the numbers were; rewording it here would flatten every
    // refusal into one vague sentence. Note it is NOT a DirectoryReadError —
    // the read succeeded, the numbers just added up to "deactivate everyone".
    const refusal = new DirectoryMembershipRefusedError(
      'Both lrs groups came back without a single member — the sync refused to act.',
    )

    expect(describeDirectorySyncFailure(refusal)).toBe(refusal.message)
  })

  it('separates an account that may bind from one that may read', () => {
    // Two different people fix these: whoever holds the service account's
    // password, and whoever grants it rights on the tree.
    const refusedBind = describeDirectorySyncFailure(
      fromDirectory(new InvalidCredentialsError()),
    )
    const refusedRead = describeDirectorySyncFailure(
      fromDirectory(new InsufficientAccessError()),
    )

    expect(refusedBind).toContain('password or DN needs updating')
    expect(refusedRead).toContain('permission to read the configured base DN')
  })

  it("tells the driver's two timeouts apart, neither of which carries a code", () => {
    // These are the exact errors connectTimeout and timeout produce: ldapts
    // rejects with plain Errors, so the message text is the only signal of
    // which one fired — and they are answered by different settings.
    const neverOpened = describeDirectorySyncFailure(
      fromDirectory(new Error('Connection timeout')),
    )
    const unanswered = describeDirectorySyncFailure(
      fromDirectory(new Error('SearchRequest: Operation timed out')),
    )

    expect(neverOpened).toContain('nothing was ever asked of it')
    expect(neverOpened).not.toContain('smaller pages')
    expect(unanswered).toContain('did not answer one request in time')
    expect(unanswered).toContain('longer for each request')
    expect(unanswered).toContain('smaller pages')
  })

  it('recognises a connection that died between operations', () => {
    // Once connected, ldapts wraps socket failures into plain Errors and the
    // Node code survives only as message text.
    expect(
      describeDirectorySyncFailure(
        fromDirectory(
          new Error('Socket error. Message type: SearchRequest (0x63)\nread ECONNRESET'),
        ),
      ),
    ).toContain('Could not reach the directory server')
    expect(
      describeDirectorySyncFailure(
        fromDirectory(
          new Error(
            'Connection closed before message response was received. Message type: BindRequest (0x60)',
          ),
        ),
      ),
    ).toContain('Could not reach the directory server')
  })

  it('points a credentials failure at the service account', () => {
    // Whoever reads this has to know it is the app's own bind account at fault,
    // not their login. Built through the driver's own class, so it carries what
    // a real refusal carries: Active Directory answers with a bare vendor
    // string (80090308) that says nothing readable, and the numeric code is
    // what makes the case recognisable at all.
    const fromDriver = new InvalidCredentialsError(
      '80090308: LdapErr DSID-0C090447, comment: AcceptSecurityContext error',
    )

    expect(describeDirectorySyncFailure(fromDirectory(fromDriver))).toContain(
      'refused the account this app signs in with',
    )
    // The same refusal with nothing but text left on it — the class name is the
    // net under an error that reached us without its code, and it has to hold.
    expect(
      describeDirectorySyncFailure(
        fromDirectory(new Error('Invalid credentials during a bind operation.')),
      ),
    ).toContain('refused the account this app signs in with')
  })

  it('points a certificate failure at the certificate', () => {
    expect(
      describeDirectorySyncFailure(fromDirectory(withCode('CERT_HAS_EXPIRED'))),
    ).toContain('certificate')
    expect(
      describeDirectorySyncFailure(
        fromDirectory(new Error('self-signed certificate in chain')),
      ),
    ).toContain('certificate')
  })

  it('falls back to a plain sentence for an unrecognised directory failure', () => {
    // A result code the server really does return and this module has no
    // sentence for, built through the driver's class so the fallback is
    // exercised by something reachable rather than by an invented shape.
    const message = describeDirectorySyncFailure(
      fromDirectory(new SizeLimitExceededError()),
    )

    expect(message).toContain('Reading the directory failed')
    // Never echo the raw text: it is as likely to be a stack fragment or a SQL
    // statement as it is to be readable.
    expect(message).not.toContain('SearchRequest')
  })

  it('survives a rejection that is not an Error at all', () => {
    expect(describeDirectorySyncFailure(fromDirectory('boom'))).toContain(
      'Reading the directory failed',
    )
  })

  describe("failures that are not the directory's", () => {
    it('does not blame the directory for our own database being down', () => {
      // Postgres reports a refused connection exactly as an unreachable LDAP
      // host does. Reading the code alone would send the administrator to the
      // directory's owner while the outage is ours.
      const message = describeDirectorySyncFailure(
        withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'),
      )

      expect(message).toContain('The directory was read')
      expect(message).not.toContain('Could not reach the directory server')
      expect(message).not.toContain('127.0.0.1')
    })

    it.each([
      ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.9:5432'],
      ['ECONNRESET', 'read ECONNRESET'],
    ])('nor for a %s the database raised mid-transaction', (code, text) => {
      const message = describeDirectorySyncFailure(withCode(code, text))

      expect(message).toContain('The directory was read')
      expect(message).not.toContain('did not answer')
    })

    it('describes any other failure of ours without echoing it', () => {
      const message = describeDirectorySyncFailure(
        new Error('column x does not exist'),
      )

      expect(message).toContain('The directory was read')
      expect(message).not.toContain('column x')
    })

    it('survives a rejection that is not an Error at all', () => {
      expect(describeDirectorySyncFailure('boom')).toContain(
        'The directory was read',
      )
    })
  })
})
