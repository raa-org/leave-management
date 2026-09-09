/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

/**
 * Marks a failure the directory read itself raised, so that only those are
 * described to an administrator as the directory's fault.
 *
 * Everything a sync does after the read talks to our own database, and Postgres
 * reports ECONNREFUSED, ETIMEDOUT and ECONNRESET in exactly the shape an
 * unreachable LDAP host does. Without this marker an outage of ours reads as
 * "could not reach the directory server", and the administrator spends it
 * talking to whoever runs the directory.
 *
 * The cause's message and stack become this error's own, so the lifecycle row
 * and the server log carry the text they would have carried unwrapped; the
 * cause itself stays reachable, and it is what gets classified.
 */
export class DirectoryReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DirectoryReadError'
    if (cause instanceof Error && cause.stack !== undefined) {
      this.stack = cause.stack
    }
  }
}

/**
 * A configured lrs-* group DN that resolves to something the sync cannot use:
 * a base-scope search found no groupOfUniqueNames entry there, so the object
 * at the DN has a different class, or an ACL hides it from the service
 * account. Thrown by the client mid-read and wrapped in DirectoryReadError
 * like every other read failure; classification recognizes it by type, so
 * the admin sentence names the condition instead of the unknown bucket.
 */
export class DirectoryGroupUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryGroupUnreadableError'
  }
}

/**
 * A pass that REFUSED to act because the membership data adds up to
 * "deactivate everyone": a group without a single member, or not a single
 * group member matching any directory entry. Nothing has been written when
 * this is thrown.
 *
 * The message is already worded for an administrator, and
 * describeDirectorySyncFailure passes it through verbatim: only the refusing
 * code knows which precondition broke and what the numbers were, so wording
 * it anywhere else would flatten every refusal into one vague sentence.
 */
export class DirectoryMembershipRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryMembershipRefusedError'
  }
}

/**
 * Turns whatever went wrong during a directory sync into one sentence an
 * administrator can act on.
 *
 * The raw error is the wrong thing to show: it carries hosts, ports, base DNs
 * and driver internals, which belong in the audit trail and the server log
 * rather than on an admin's screen. But "it failed, look elsewhere" is not
 * actionable either — whether the directory was unreachable, refused the
 * credentials, or presented a certificate we do not trust decides who fixes it
 * and how. So the cause is named, and only the cause.
 */
export function describeDirectorySyncFailure(error: unknown): string {
  // A membership refusal already speaks admin — it names the broken
  // precondition and says nothing was written — so it passes through as-is.
  if (error instanceof DirectoryMembershipRefusedError) {
    return error.message
  }
  // Anything that did not come out of the directory read is ours, and is not
  // guessed at any further: our database announces its own outages elsewhere,
  // whereas an admin misdirected to the directory has nothing to go on. The
  // read is the first thing a pass does, so reaching this line at all means
  // the directory already answered — which is the useful half of the sentence.
  if (!(error instanceof DirectoryReadError)) {
    return 'The directory was read, but the sync then stopped on an unexpected error. The server log has the details.'
  }

  switch (classify(error.cause)) {
    case 'unreachable':
      return 'Could not reach the directory server. It may be down, or this deployment may need to be on the company network.'
    case 'connect-timed-out':
      return 'No connection to the directory server could be opened in time, so nothing was ever asked of it. The link may be blocked by a firewall, or the host may be unreachable from this deployment; if the network is known to be good, the connect timeout can be raised.'
    case 'timed-out':
      return 'The directory server did not answer one request in time. It may be overloaded or the link to it slow; if the directory itself is healthy, this deployment can allow longer for each request or ask for smaller pages.'
    case 'server-time-limit':
      return 'The directory server gave up on the search itself, on a time limit of its own. That limit lives on the directory rather than in this deployment, so it has to be raised there — or the search made cheaper with a narrower user filter.'
    case 'plaintext-port':
      return 'The directory server answered, but not with TLS. The port in the connection URL is almost certainly the plaintext one (389) rather than the TLS one (636).'
    case 'credentials':
      return 'The directory server refused the account this app signs in with. Its password or DN needs updating.'
    case 'auth-method':
      return "The directory server refused the way this app signs in, rather than the account itself: it asks for stronger or different authentication than the simple bind this app performs over TLS. That is settled in the directory's policy for this account, not in this deployment's settings."
    case 'missing-entry':
      return "The directory has no entry at one of the configured DNs: either the search base or one of the group DNs in this deployment's settings points at nothing on the server. The server log names the search it happened in and the variable that fed it."
    case 'unreadable-group':
      return "One of the configured group DNs resolves, but not to a group this app's account can read: the object there is not a groupOfUniqueNames, or an ACL hides it (or its uniqueMember attribute) from the service account. The server log names the group and the variable that fed it."
    case 'permissions':
      return 'The directory server accepted the account this app signs in with but refused the read. That account needs permission to read the configured base DN.'
    case 'certificate':
      return 'The directory server presented a certificate this app does not trust. Its certificate or the configured authority needs attention.'
    case 'unknown':
      return 'Reading the directory failed on an unexpected error. The audit log and the server log have the details.'
  }
}

type FailureKind =
  | 'unreachable'
  | 'connect-timed-out'
  | 'timed-out'
  | 'server-time-limit'
  | 'plaintext-port'
  | 'missing-entry'
  | 'unreadable-group'
  | 'credentials'
  | 'auth-method'
  | 'permissions'
  | 'certificate'
  | 'unknown'

// The result codes a directory returns that say something an administrator can
// act on. Three of them separate fixes that all look like "the bind failed":
// the credentials the app presents, a bind the server will not accept in this
// form, and an account allowed to sign in but not to read the tree. The fourth,
// timeLimitExceeded, is not about the bind at all — the server abandoned the
// search on a budget of its own, which nothing in this deployment can raise, so
// it must not arrive as one of our own timeouts advising a longer wait here.
// inappropriateAuthentication sits with invalidCredentials rather than with the
// method codes: the server is saying the credentials offered are not usable for
// the bind it wants — an empty or unverifiable password on the service account
// produces it — so it lands on whoever owns that account, exactly as a wrong
// password does.
// noSuchObject sits here because three configured DNs feed searches (the base
// plus both group DNs), and from any of them it always means the same one
// thing — a DN in this deployment's settings that the server does not have —
// which earns it a named sentence rather than the unknown bucket's
// read-the-logs advice.
const LDAP_RESULT_CODES = new Map<number, FailureKind>([
  [3, 'server-time-limit'], // timeLimitExceeded
  [7, 'auth-method'], // authMethodNotSupported
  [8, 'auth-method'], // strongerAuthRequired
  [13, 'auth-method'], // confidentialityRequired
  [32, 'missing-entry'], // noSuchObject
  [48, 'credentials'], // inappropriateAuthentication
  [49, 'credentials'], // invalidCredentials
  [50, 'permissions'], // insufficientAccessRights
])

// OpenSSL's chain-verification codes as Node surfaces them, plus Node's own
// hostname-mismatch code. Spelled out rather than matched by a CERT_ prefix,
// which misses SELF_SIGNED_CERT_IN_CHAIN, UNABLE_TO_GET_ISSUER_CERT_LOCALLY and
// ERR_TLS_CERT_ALTNAME_INVALID alike — most of what a directory behind a private
// CA actually produces. Node happens to word all of those with "certificate" in
// the message too, so the text match below is a second net under them; this set
// is what keeps the answer from depending on wording Node is free to change.
// A TLS handshake against a port that is not speaking TLS. Kept apart from the
// certificate codes because the certificate sentence would be actively wrong
// here: nothing was presented for us to distrust. EPROTO is deliberately
// absent — it also covers genuine protocol failures against a real TLS server.
const PLAINTEXT_PORT_CODES = new Set([
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
])

const CERTIFICATE_CODES = new Set([
  'CERT_CHAIN_TOO_LONG',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

// Three signals, most trustworthy first: the numeric result code the directory
// itself returned, the string code Node attaches to a socket or TLS failure,
// and the text. The text is not decoration — ldapts turns its own timeouts and
// every post-connect socket failure into plain Errors carrying no code at all,
// so dropping it would lose whole causes, not just polish.
function classify(error: unknown): FailureKind {
  if (!(error instanceof Error)) {
    return 'unknown'
  }

  // Typed before coded: the client diagnoses this condition itself (a
  // zero-entry base-scope group search carries no server result code at
  // all), and the type is the only signal that survives the
  // DirectoryReadError wrapping.
  if (error instanceof DirectoryGroupUnreadableError) {
    return 'unreadable-group'
  }

  const resultCode = ldapResultCode(error)
  if (resultCode !== null) {
    const named = LDAP_RESULT_CODES.get(resultCode)
    if (named !== undefined) {
      return named
    }
  }

  const code = errorCode(error)
  const text = `${error.name} ${error.message}`.toLowerCase()

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return isConnectPhase(text) ? 'connect-timed-out' : 'timed-out'
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return 'unreachable'
  }
  if (PLAINTEXT_PORT_CODES.has(code)) {
    return 'plaintext-port'
  }
  if (CERTIFICATE_CODES.has(code)) {
    return 'certificate'
  }

  if (text.includes('invalidcredentials') || text.includes('invalid credentials')) {
    return 'credentials'
  }
  if (text.includes('certificate') || text.includes('self-signed') || text.includes('self signed')) {
    return 'certificate'
  }
  // 'timedout' additionally catches ETIMEDOUT/ESOCKETTIMEDOUT when they only
  // survive as message text (see below) rather than as a code.
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('timedout')
  ) {
    return isConnectPhase(text) ? 'connect-timed-out' : 'timed-out'
  }
  // The raw Node error, code intact, only surfaces while connecting. Once the
  // connection is up, ldapts wraps socket failures into plain Errors — "Socket
  // error. Message type: SearchRequest (0x63)\nread ECONNRESET", "Connection
  // closed before message response was received…" — so the code, if present at
  // all, is a substring of the message.
  if (
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('ehostunreach') ||
    text.includes('enetunreach') ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('epipe') ||
    text.includes('socket error') ||
    text.includes('connection closed')
  ) {
    return 'unreachable'
  }

  return 'unknown'
}

// `code` is not on the Error type but is what Node and the LDAP driver both
// attach to signal what actually went wrong. They disagree on its type — Node
// writes a string, ldapts the number the server returned — so each reader takes
// only its own, and a result code of 49 is no longer thrown away for not being
// a string.
// Which side of the connection a timeout fell on. Nothing is asked of the
// directory until the socket is up, so a connect timeout cannot be answered by
// a longer per-request budget or by smaller pages, and the two cannot share one
// sentence without one of them being told to tune a setting that had no part in
// it. Both forms of the connect case are readable off the text: Node prefixes
// its connect failures with the syscall, and the driver words its own connect
// timer as "Connection timeout".
function isConnectPhase(text: string): boolean {
  return (
    text.includes('connect etimedout') || text.includes('connection timeout')
  )
}

function errorCode(error: Error): string {
  const code: unknown = (error as unknown as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : ''
}

function ldapResultCode(error: Error): number | null {
  const code: unknown = (error as unknown as Record<string, unknown>)['code']
  return typeof code === 'number' ? code : null
}
