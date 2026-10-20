// Joining a Prometheus that already has an owner: the wire, as the REQUESTING device reads it (docs/PAIRING-APPROVAL-API.md on
// Prometheus #697/#698). Pure: every function takes what a computer answered (untrusted, so every field is checked) and says
// what it means. The network is src/main/pairing/, the cryptography is src/main/pairing/seal.ts, the screens are
// src/renderer/src/components/onboarding/. (shared/pairing.ts is the older 6-digit-code path and is unrelated.)
//
// No Node/Electron imports (same rule as shared/setup-wizard.ts).
import { validHost, validPort } from './discovery'

/** Why a request to join, or the wait for its answer, did not go through. The screens give each its own words. */
export const JOIN_FAILURE_KINDS = [
  'unavailable', // 403 pairing_unavailable: this Prometheus is not taking new devices this way (setup mode, switched off, or no password at all)
  'closed', // 403 pairing_closed: only while its owner has "add a device" open
  'too-old', // the route is not there (the bearer gate's 401, a 404 or a 405 on the request route)
  'busy-here', // 429 per_source_pending: a request from this Mac is already waiting
  'busy-full', // 429 pending_full: its list of waiting requests is full
  'too-many', // 429 hourly: too many requests from this Mac this hour
  'slow-down', // any other 429
  'identity', // 503 identity_unavailable: it has no identity key yet
  'gone', // the poll found no such request: it was forgotten (a restart, or too long ago)
  'mismatch', // the code this Mac computed is not the code the computer sent: someone may be in between
  'unreadable', // an answer that is not what the contract describes
  'refused', // the computer said no in some other way
  'lost', // no answer at all
  'needs-newer-beacon', // the computer speaks TLS and this Beacon cannot yet check its certificate
  'not-encrypted', // a plain join to a home-network address: refused before anything is sent (src/shared/plain-lan.ts)
  'not-encrypted-public', // a plain join to an address on the internet: refused before anything is sent (src/main/plain-public.ts)
  'not-same-computer', // over TLS: the key it presented is not the one its hello or its answer names, or it changed mid-join (docs/MULTI-COMPUTER-v0.4.md §3.2)
  'not-saved', // approved, but this Mac could not keep the connection
  'unopened' // approved, but the sealed answer could not be opened
] as const
export type JoinFailureKind = (typeof JOIN_FAILURE_KINDS)[number]

export interface JoinFailure {
  kind: JoinFailureKind
  /** How long the computer asked us to wait, when it said (seconds, 1 to 3600). */
  retryAfterSeconds?: number
}

export interface Created {
  requestId: string
  pollSecret: string
  matchCode: string
  /** The computer's instance key, base64url of its SPKI DER. */
  instancePublicKey: string
  expiresAt: number
  ttlSeconds: number
  pollIntervalSeconds: number
  /** At least one of the owner's screens took the prompt. A hint: it is false when nobody is watching, and when no
   *  screen can be told yet. */
  notified: boolean
}
export type CreatedResult = { ok: true; created: Created } | { ok: false; failure: JoinFailure }

export interface Approved {
  deviceId: string
  /** Left as received: only the unsealing may judge it. */
  sealed: unknown
  /** Left as received: only portsFromEndpoints may judge it. */
  endpoints: unknown
  /** Left as received: the join holds its `spki_sha256` (Prometheus #745) to the key it met. */
  tls: unknown
  approvedAt: number
}
export type PollResult =
  /** `notified`: has anyone who can approve been told (Prometheus #699 puts it on the pending poll)? Absent from an older daemon. */
  | { kind: 'pending'; expiresAt: number; notified?: boolean }
  | { kind: 'approved'; approved: Approved }
  | { kind: 'denied' | 'expired' | 'canceled' | 'delivered' }
  | { kind: 'failed'; failure: JoinFailure }

/** What asking to join came back with: the four digits THIS device worked out, and the computer's lifetime for the request. */
export type BeginResult =
  | {
      ok: true
      matchCode: string
      ttlSeconds: number
      pollIntervalSeconds: number
      notified: boolean
      deviceName: string
      /** The one line that says yes from the computer Prometheus runs on (approveHereCommand), or null. */
      approveCommand: string | null
    }
  | { ok: false; failure: JoinFailure }

/** The one line that says yes to this request from the computer Prometheus runs on (Prometheus's own `oara pair approve`), or null. */
export function approveHereCommand(requestId: string, code: string): string | null {
  // A person pastes this into a shell, so it is built only from an id and a code that are exactly what the contract allows: nothing a
  // computer sends can add a word. Eight characters of the id are enough for `oara pair approve` (it takes a unique prefix of 6+).
  if (!REQUEST_ID.test(requestId) || !MATCH_CODE.test(code)) return null
  return `oara pair approve ${requestId.slice(0, 8)} --code ${code}`
}
/** One look at the wait: still waiting, connected (the token is kept and never leaves the main process), over, or failed. */
export type PollOutcome =
  /** Still waiting. `notified`: has anyone who can approve been told? Once true it stays true for the length of the wait. */
  | { state: 'waiting'; notified: boolean }
  | { state: 'connected'; computerName: string }
  | { state: 'denied' | 'expired' | 'canceled' }
  | { state: 'failed'; failure: JoinFailure }
/** What the page may tell the main process about the computer it chose. Everything else is main's. */
export interface JoinBeginRequest {
  host: string
  apiPort: number
  name: string
  fp: string
  tls: boolean
}

/** The page's request to join, or null when it is not exactly a request: a real host, a real port, a name, a fingerprint of 16 lower-case
 *  hex digits (or none), and a boolean. Anything else on the object is dropped. */
export function checkJoinRequest(raw: unknown): JoinBeginRequest | null {
  if (!isRecord(raw)) return null
  if (!validHost(raw.host) || !validPort(raw.apiPort)) return null
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 128) return null
  if (typeof raw.fp !== 'string' || !/^(?:[0-9a-f]{16})?$/.test(raw.fp)) return null
  if (typeof raw.tls !== 'boolean') return null
  return { host: raw.host, apiPort: raw.apiPort, name: raw.name, fp: raw.fp, tls: raw.tls }
}

export type PortsResult = { ok: true; apiPort: number; wsPort: number; guessed: boolean } | { ok: false; kind: 'needs-newer-beacon' | 'unreadable' }

/** The ways forward a failure offers besides Back (which every one has). "other-way" is the older setup. */
export type JoinAction = 'ask-again' | 'try-again' | 'other-way'
export function joinActions(kind: JoinFailureKind | 'denied' | 'expired' | 'canceled'): JoinAction[] {
  switch (kind) {
    case 'denied':
    case 'expired':
    case 'canceled':
    case 'gone':
    case 'not-saved':
    case 'unopened':
      return ['ask-again']
    case 'unavailable':
    case 'too-old':
      return ['other-way']
    case 'needs-newer-beacon':
      return []
    default:
      return ['try-again']
  }
}

/** While waiting for a yes: is "Connect another way" offered? Exactly when no one who can approve has been told. (The wait for approval is a
 *  dead end for someone whose Prometheus has no owner connected, for instance one installed from a terminal; the older setup is the way on.) */
export function waitingOffersOtherWay(notified: boolean): boolean {
  return !notified
}

export const MAX_DEVICE_NAME_CHARS = 64
/** The usual WebSocket port, used only when the computer did not say. */
export const DEFAULT_WS_PORT = 8010
/** The usual TLS WebSocket port of a home-network Prometheus (the pairing contract §7.3), used only when it did not say. */
export const DEFAULT_TLS_WS_PORT = 8011

const REQUEST_ID = /^[0-9a-f]{32}$/
const POLL_SECRET = /^[A-Za-z0-9_-]{43}$/
const MATCH_CODE = /^[0-9]{4}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const UNSAFE_NAME = /[\p{C}\p{Zl}\p{Zp}]/u

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** The name this device asks to be listed under, by the daemon's rules: 1 to 64 characters (counted as characters, not as
 *  UTF-16 units), after trimming, with no control, invisible-format or line-separator character. Refused, never cleaned up:
 *  what the owner sees must be what was sent. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  const chars = Array.from(t).length
  if (chars < 1 || chars > MAX_DEVICE_NAME_CHARS) return null
  return UNSAFE_NAME.test(t) ? null : t
}

/** The platform names the daemon knows. */
export function platformFor(nodePlatform: string): 'macos' | 'windows' | 'linux' | 'other' {
  return nodePlatform === 'darwin' ? 'macos' : nodePlatform === 'win32' ? 'windows' : nodePlatform === 'linux' ? 'linux' : 'other'
}

/** How long to wait: the body's number when it is a usable one, else the Retry-After header, kept to 1 s .. 1 h. */
function retryAfter(body: Record<string, unknown>, header: string | null | undefined): number | undefined {
  const clamp = (n: number): number => Math.min(3600, Math.max(1, Math.floor(n)))
  const fromBody = body.retry_after_seconds
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 1) return clamp(fromBody)
  if (typeof header === 'string' && /^\d{1,7}$/.test(header.trim())) {
    const n = Number(header.trim())
    if (n >= 1) return clamp(n)
  }
  return undefined
}

function withRetry(kind: JoinFailureKind, body: Record<string, unknown>, header: string | null | undefined): JoinFailure {
  const wait = retryAfter(body, header)
  return wait === undefined ? { kind } : { kind, retryAfterSeconds: wait }
}

function failureFor(route: 'create' | 'poll', status: number, rawBody: unknown, header: string | null | undefined): JoinFailure {
  const body = isRecord(rawBody) ? rawBody : {}
  const error = typeof body.error === 'string' ? body.error : ''
  const reason = typeof body.reason === 'string' ? body.reason : ''
  if (status === 0) return { kind: 'lost' }
  if (status === 429) {
    const kind = reason === 'per_source_pending' ? 'busy-here' : reason === 'pending_full' ? 'busy-full' : reason === 'hourly' ? 'too-many' : 'slow-down'
    return withRetry(route === 'create' ? kind : 'slow-down', body, header)
  }
  if (route === 'poll') return { kind: status === 404 ? 'gone' : 'refused' }
  if (status === 403) return { kind: error === 'pairing_unavailable' ? 'unavailable' : error === 'pairing_closed' ? 'closed' : 'refused' }
  if (status === 401 || status === 404 || status === 405) return { kind: 'too-old' }
  if (status === 503 && error === 'identity_unavailable') return { kind: 'identity' }
  return { kind: 'refused' }
}

/** The answer to `POST /api/pair/requests`. */
export function parseCreated(status: number, body: unknown, retryAfterHeader?: string | null): CreatedResult {
  if (status !== 201) return { ok: false, failure: failureFor('create', status, body, retryAfterHeader) }
  const unreadable: CreatedResult = { ok: false, failure: { kind: 'unreadable' } }
  if (!isRecord(body)) return unreadable
  const { request_id, poll_secret, match_code, instance_public_key, expires_at, ttl_seconds, poll_interval_seconds, notified } = body
  if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) return unreadable
  if (typeof poll_secret !== 'string' || !POLL_SECRET.test(poll_secret)) return unreadable
  if (typeof match_code !== 'string' || !MATCH_CODE.test(match_code)) return unreadable
  if (typeof instance_public_key !== 'string' || !B64URL.test(instance_public_key) || instance_public_key.length > 512) return unreadable
  if (!isCount(expires_at, 1, Number.MAX_SAFE_INTEGER)) return unreadable
  if (!isCount(ttl_seconds, 60, 900)) return unreadable
  if (!isCount(poll_interval_seconds, 1, 30)) return unreadable
  if (typeof notified !== 'boolean') return unreadable
  return {
    ok: true,
    created: {
      requestId: request_id,
      pollSecret: poll_secret,
      matchCode: match_code,
      instancePublicKey: instance_public_key,
      expiresAt: expires_at,
      ttlSeconds: ttl_seconds,
      pollIntervalSeconds: poll_interval_seconds,
      notified
    }
  }
}

/** The answer to `GET /api/pair/requests/{id}`. */
export function parsePoll(status: number, body: unknown, retryAfterHeader?: string | null): PollResult {
  const unreadable: PollResult = { kind: 'failed', failure: { kind: 'unreadable' } }
  if (status !== 200) return { kind: 'failed', failure: failureFor('poll', status, body, retryAfterHeader) }
  if (!isRecord(body) || typeof body.status !== 'string') return unreadable
  switch (body.status) {
    case 'pending':
      if (!isCount(body.expires_at, 1, Number.MAX_SAFE_INTEGER)) return unreadable
      // `notified` is a hint: read when it is a boolean, simply not known when it is absent (an older daemon) or anything else.
      return typeof body.notified === 'boolean' ? { kind: 'pending', expiresAt: body.expires_at, notified: body.notified } : { kind: 'pending', expiresAt: body.expires_at }
    case 'denied':
    case 'expired':
    case 'canceled':
    case 'delivered':
      return { kind: body.status }
    case 'approved': {
      const { device_id, sealed, endpoints, approved_at } = body
      if (typeof device_id !== 'string' || device_id.length < 1 || device_id.length > 128) return unreadable
      if (!isRecord(sealed)) return unreadable
      if (!isCount(approved_at, 0, Number.MAX_SAFE_INTEGER)) return unreadable
      return { kind: 'approved', approved: { deviceId: device_id, sealed, endpoints, tls: body.tls, approvedAt: approved_at } }
    }
    default:
      return unreadable
  }
}

function portOf(raw: unknown, kind: 'rest' | 'ws'): { port: number; tls: boolean } | 'bad' {
  if (typeof raw !== 'string') return 'bad'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'bad'
  }
  const plain = kind === 'rest' ? 'http:' : 'ws:'
  const secure = kind === 'rest' ? 'https:' : 'wss:'
  if (u.protocol !== plain && u.protocol !== secure) return 'bad'
  const port = u.port === '' ? (u.protocol === secure ? 443 : 80) : Number(u.port)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { port, tls: u.protocol === secure } : 'bad'
}

/** The two ports to connect on once approved, out of the `endpoints` the computer sent. Only the PORTS are used: the host
 *  is the one this Mac already reached it on, never one the answer names. An address that speaks TLS is not used, because
 *  this Beacon cannot check its certificate yet. With none given, the port it was reached on and the usual WebSocket
 *  port, marked as a guess. */
export function portsFromEndpoints(endpoints: unknown, fallbackApiPort: number, tls = false): PortsResult {
  const e = isRecord(endpoints) ? endpoints : {}
  const restGiven = e.rest !== null && e.rest !== undefined
  const wsGiven = e.ws !== null && e.ws !== undefined
  const rest = restGiven ? portOf(e.rest, 'rest') : null
  const ws = wsGiven ? portOf(e.ws, 'ws') : null
  if (tls) {
    // Joined over TLS (docs/MULTI-COMPUTER-v0.4.md §3.2): the computer must name TLS addresses. Its plain ones serve its own
    // loopback only in home-network mode, and nothing it says sends this Mac back to plain.
    if (rest === 'bad' || ws === 'bad' || (rest && !rest.tls) || (ws && !ws.tls)) return { ok: false, kind: 'unreadable' }
    return { ok: true, apiPort: rest ? rest.port : fallbackApiPort, wsPort: ws ? ws.port : DEFAULT_TLS_WS_PORT, guessed: !rest || !ws }
  }
  if ((rest && rest !== 'bad' && rest.tls) || (ws && ws !== 'bad' && ws.tls)) return { ok: false, kind: 'needs-newer-beacon' }
  if (rest === 'bad' || ws === 'bad') return { ok: false, kind: 'unreadable' }
  return { ok: true, apiPort: rest ? rest.port : fallbackApiPort, wsPort: ws ? ws.port : DEFAULT_WS_PORT, guessed: !rest || !ws }
}

/** How to say "try again in N seconds" to a person: the words to use and the number in them. */
export function waitPhrase(seconds: number | undefined): { key: 'seconds' | 'minute' | 'minutes' | 'soon'; n: number } {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 1) return { key: 'soon', n: 0 }
  if (seconds < 45) return { key: 'seconds', n: Math.ceil(seconds) }
  if (seconds < 90) return { key: 'minute', n: 1 }
  return { key: 'minutes', n: Math.round(seconds / 60) }
}

/** "4:32": whole minutes and seconds, never negative. */
export function clockText(seconds: number): string {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}
