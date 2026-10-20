// The OWNER's side of joining a Prometheus: seeing that a new device wants to connect, and answering (docs/PAIRING-APPROVAL-API.md on
// Prometheus #697/#698, sections 4.2b and 5.1). Pure: everything here takes what a computer sent (untrusted) and says what it means.
//
// Two things are deliberately NOT here. The four-digit code the daemon lists for its owner never reaches the page: the owner must TYPE
// the digits the new device shows, and the daemon checks them (422 when they differ), so a tap on "Approve" cannot approve a stranger.
// And no request is ever stored or logged: a device name and an address are shown, once, and forgotten.
//
// No Node/Electron imports (same rule as shared/setup-wizard.ts).
import { cleanDeviceName } from './join'

export interface WaitingRequest {
  requestId: string
  deviceName: string
  /** What to call it on screen: "Mac", "iPhone or iPad", ... */
  platform: string
  sourceIp: string
  /** Local clock (ms since 1970) after which the request is over. */
  deadlineMs: number
  /** When the daemon made it (its clock, whole seconds): only for putting the longest-waiting first. */
  createdAt: number
}
export type ListResult = { kind: 'ok'; requests: WaitingRequest[] } | { kind: 'not-owner' } | { kind: 'signed-out' } | { kind: 'failed' }
export type FrameEvent = { kind: 'pending'; request: WaitingRequest } | { kind: 'resolved'; requestId: string; resolution: string }
export type DecideOutcome = 'ok' | 'wrong-code' | 'handled' | 'expired' | 'gone' | 'not-owner' | 'signed-out' | 'refused' | 'lost'
export interface ApproveRequest {
  requestId: string
  /** The four digits the owner typed from the new device's screen. */
  code: string
  /** A new name for the device, if the owner changed it. */
  name?: string
}

export const MAX_WAITING = 20

/** How often a dev or probe build asks the daemon who is waiting, from BEACON_PAIRING_POLL: `off` (frames only: the daemon's WebSocket frames
 *  are then the only way a request is learned of) or a number of milliseconds between 200 and ten minutes. A release build, anything else, or
 *  nothing at all is the usual `fallback`. An environment variable must not be able to make a shipped Beacon stop looking. */
export function pairingPollMs(env: Readonly<Record<string, string | undefined>>, allowed: boolean, fallback = 3_000): number | null {
  const raw = env.BEACON_PAIRING_POLL
  if (!allowed || typeof raw !== 'string') return fallback
  if (raw === 'off') return null
  if (!/^[0-9]{1,7}$/.test(raw)) return fallback
  const n = Number(raw)
  return n >= 200 && n <= 600_000 ? n : fallback
}
/** No request lives longer than the daemon's largest allowed lifetime. */
const MAX_REMAINING_SECONDS = 900
const REQUEST_ID = /^[0-9a-f]{32}$/
const RESOLUTIONS: readonly string[] = ['approved', 'denied', 'expired', 'canceled']
const PLATFORM_NAMES: Record<string, string> = { macos: 'Mac', ios: 'iPhone or iPad', windows: 'Windows PC', linux: 'Linux computer', android: 'Android phone' }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** A fixed name for each platform the daemon knows; the daemon's own text is never echoed. */
export function platformLabel(p: unknown): string {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(PLATFORM_NAMES, p) ? PLATFORM_NAMES[p] : 'device'
}

/** One entry of the daemon's list, or of a pairing_pending frame; null when it is not exactly that. `remaining` is how many seconds
 *  are left on the DAEMON's clock; the deadline is then set on this Mac's. The code is not read at all. */
function waitingFrom(raw: unknown, remaining: (expiresAt: number) => number, localNowMs: number): WaitingRequest | null {
  if (!isRecord(raw)) return null
  const { request_id, device_name, platform, source_ip, expires_at, ttl_seconds, created_at } = raw
  if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) return null
  const deviceName = cleanDeviceName(device_name)
  if (!deviceName) return null
  if (typeof source_ip !== 'string' || source_ip.length < 1 || source_ip.length > 64 || /[\p{C}\s]/u.test(source_ip)) return null
  if (!isWhole(expires_at)) return null
  const left = remaining(expires_at)
  if (!(left > 0)) return null
  // Never more than the request's own lifetime (a Date header is whole seconds, so a fresh request can read one second over), and never more
  // than the longest the daemon allows.
  const lifetime = isWhole(ttl_seconds) && ttl_seconds >= 1 && ttl_seconds <= MAX_REMAINING_SECONDS ? ttl_seconds : MAX_REMAINING_SECONDS
  return { requestId: request_id, deviceName, platform: platformLabel(platform), sourceIp: source_ip, deadlineMs: localNowMs + Math.min(left, lifetime) * 1000, createdAt: isWhole(created_at) ? created_at : 0 }
}

/** The answer to `GET /api/pair/requests`. `serverNowSec` is the daemon's clock from its Date header, or null. */
export function parseRequestList(status: number, body: unknown, serverNowSec: number | null, localNowMs: number): ListResult {
  if (status === 401) return { kind: 'signed-out' }
  if (status === 403) return { kind: 'not-owner' }
  if (status !== 200 || !isRecord(body) || !Array.isArray(body.requests)) return { kind: 'failed' }
  const now = serverNowSec !== null && Number.isFinite(serverNowSec) ? serverNowSec : Math.floor(localNowMs / 1000)
  const requests: WaitingRequest[] = []
  for (const raw of body.requests) {
    const r = waitingFrom(raw, (expiresAt) => expiresAt - now, localNowMs)
    if (r) requests.push(r)
    if (requests.length >= MAX_WAITING) break
  }
  // The daemon lists the newest first, so read it backwards, then put the one that has waited longest first (a stable sort keeps the order
  // of requests made in the same second).
  return { kind: 'ok', requests: requests.reverse().sort((a, b) => a.createdAt - b.createdAt) }
}

/** A `pairing_pending` or `pairing_resolved` WebSocket frame (5.1); null for anything else. `tsSeconds` is the frame's own timestamp, the
 *  daemon's clock at sending, so the time left is the end time minus it. */
export function parseFrame(type: unknown, payload: unknown, tsSeconds: unknown, localNowMs: number): FrameEvent | null {
  if (!isRecord(payload)) return null
  if (type === 'pairing_pending') {
    const now = typeof tsSeconds === 'number' && Number.isFinite(tsSeconds) ? tsSeconds : localNowMs / 1000
    const request = waitingFrom(payload, (expiresAt) => expiresAt - now, localNowMs)
    return request ? { kind: 'pending', request } : null
  }
  if (type === 'pairing_resolved') {
    const { request_id, resolution } = payload
    if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id) || typeof resolution !== 'string' || !RESOLUTIONS.includes(resolution)) return null
    return { kind: 'resolved', requestId: request_id, resolution }
  }
  return null
}

/** What the daemon's status for approve or deny means for the screen. */
export function decideOutcome(status: number): DecideOutcome {
  switch (status) {
    case 200:
      return 'ok'
    case 422:
      return 'wrong-code'
    case 409:
      return 'handled'
    case 410:
      return 'expired'
    case 404:
      return 'gone'
    case 403:
      return 'not-owner'
    case 401:
      return 'signed-out'
    case 0:
      return 'lost'
    default:
      return 'refused'
  }
}

/** What the page may ask main to approve: an id, exactly four digits, and optionally a new name. Anything else on the object is dropped. */
export function checkApproveRequest(raw: unknown): ApproveRequest | null {
  if (!isRecord(raw)) return null
  if (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) return null
  if (typeof raw.code !== 'string' || !/^[0-9]{4}$/.test(raw.code)) return null
  if (raw.name === undefined) return { requestId: raw.requestId, code: raw.code }
  const name = cleanDeviceName(raw.name)
  return name ? { requestId: raw.requestId, code: raw.code, name } : null
}
