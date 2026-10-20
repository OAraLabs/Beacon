// Joining a Prometheus that already has an owner, the requesting device's side (docs/PAIRING-APPROVAL-API.md, 4):
//
//   begin   POST /api/pair/requests with this device's name and PUBLIC key; work out the 4-digit code ourselves and compare it
//           with the computer's (a difference means something may be in between: withdraw and say so);
//   poll    GET /api/pair/requests/{id} with the poll secret in a HEADER (never in an address), not faster than once a second;
//   finish  on approval: unseal the token with the private key (it never leaves this process), KEEP it, and only then tell the
//           computer it arrived (DELETE). A token that could not be kept is never acknowledged: the computer revokes an
//           uncollected device by itself, so nothing is left half-granted.
//
// Everything that touches the world arrives as `deps`, so a smoke can run all of it against a fake computer. One attempt at a
// time; the private key and the poll secret live in this object and nowhere else (not on disk, not in the page).
import { hostScope } from '@shared/plain-lan'
import { plainPublicRefusal } from '../plain-public'
import { gatewayFromEndpoint } from '../connection/config'
import { approveHereCommand, cleanDeviceName, parseCreated, parsePoll, portsFromEndpoints, type Approved, type BeginResult, type Created, type JoinFailure, type JoinFailureKind, type PollOutcome } from '@shared/join'
import type { GatewayConfig } from '../connection/config'
import type { RequestFn } from './http'
import type { Hello } from '@shared/discovery'
import { checkFirstContact } from '../tls-pin'
import { decodeB64url, matchCode, newRequesterKeys, unseal, type RequesterKeys } from './seal'

/** Polls closer together than this are not sent (the computer answers 429 below one second). */
export const MIN_POLL_GAP_MS = 1_000
/** This many answers missing in a row is "lost touch". */
export const LOST_AFTER_MISSES = 3
const ACK_TRIES = 3
const ACK_GAP_MS = 300

export interface JoinTarget {
  host: string
  apiPort: number
  /** What the computer calls itself (the "known computers" memory and the screens). */
  name: string
  /** Its fingerprint from hello, or ''. */
  fp: string
  /** Its hello said it speaks TLS. */
  tls: boolean
}
export interface SavedConnection {
  gateway: GatewayConfig
  token: string
  computerName: string
  fp: string
}
export interface JoinDeps {
  request: RequestFn
  now: () => number
  /** Keep the connection (the address, the token in the keychain, the computer in the known list). Throws when it cannot. */
  save: (c: SavedConnection) => void
  /** Bring the saved connection up. Called after the computer has been told the token arrived. */
  activate: () => void
  newKeys?: () => RequesterKeys
  /** A computer whose hello says TLS (docs/MULTI-COMPUTER-v0.4.md §3.2): hello over TLS with no pin, and the key it presented;
   *  then a request helper pinned to that key. Without them a TLS computer is "needs a newer Beacon". */
  helloOverTls?: (host: string, port: number) => Promise<{ hello: Hello | null; spkiHex: string | null }>
  pinnedRequest?: (pin: string) => RequestFn
}
interface Attempt {
  created: Created
  keys: RequesterKeys
  target: JoinTarget
  base: string
  /** How this attempt talks to the computer: plain, or pinned to the key it presented (`pin`) for a TLS computer. Every request
   *  of the attempt (polls, the acknowledgement, a withdrawal) goes through it. */
  request: RequestFn
  pin: string | null
  lastPollAt: number
  misses: number
  /** Has anyone who can approve been told? From the 201, then the pending polls; it only ever becomes true (the daemon forgets it once an owner who
   *  connected after the request was made disconnects again, but that owner was told). */
  notified: boolean
}

const fail = (kind: JoinFailureKind): { ok: false; failure: JoinFailure } => ({ ok: false, failure: { kind } })
const failed = (kind: JoinFailureKind): PollOutcome => ({ state: 'failed', failure: { kind } })
const waiting = (a: Attempt): PollOutcome => ({ state: 'waiting', notified: a.notified })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class JoinSession {
  private attempt: Attempt | null = null
  /** The tail of the operations so far. begin, poll and cancel run one after another in the order they were called: a screen
   *  that starts, is torn down and starts again calls begin, cancel, begin together, and run side by side they would leave a
   *  request open that nobody can withdraw (the computer allows one per Mac, so the next ask would be refused). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: JoinDeps) {}

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** An attempt is waiting for an answer. */
  active(): boolean {
    return this.attempt !== null
  }

  begin(target: JoinTarget, deviceName: string, platform: string): Promise<BeginResult> {
    return this.serial(() => this.beginNow(target, deviceName, platform))
  }

  poll(): Promise<PollOutcome> {
    return this.serial(() => this.pollNow())
  }

  /** Going Back, or asking again: withdraw the request. Best effort, never throws. */
  cancel(): Promise<void> {
    return this.serial(() => this.cancelNow())
  }

  private async beginNow(target: JoinTarget, deviceName: string, platform: string): Promise<BeginResult> {
    await this.cancelNow() // whatever was waiting is withdrawn first: one attempt at a time
    const name = cleanDeviceName(deviceName)
    if (!name) return fail('refused')
    // A computer that speaks TLS (docs/MULTI-COMPUTER-v0.4.md §3.2): hello over TLS first, with no pin and no credential, to learn
    // the key it presents; its fp must be that key (and the one it was found with, when it was found with one), or nothing more
    // is sent. From then on every request of the attempt is pinned to that key.
    // No plain join to the home network (src/shared/plain-lan.ts): a hidden TLS flag, or a plain-only record carrying a real
    // computer's fp, ends here, before anything is sent. This Mac and Tailscale stay plain.
    if (!target.tls && hostScope(target.host) === 'home-network') return fail('not-encrypted')
    // Nor a plain join across the internet (src/main/plain-public.ts), before anything is sent.
    const at = target.host.includes(':') ? `[${target.host}]` : target.host
    if (!target.tls && (await plainPublicRefusal(`http://${at}:${target.apiPort}`, `ws://${at}:${target.apiPort}`))) return fail('not-encrypted-public')
    let request = this.deps.request
    let pin: string | null = null
    if (target.tls) {
      if (!this.deps.helloOverTls || !this.deps.pinnedRequest) return fail('needs-newer-beacon')
      const met = await this.deps.helloOverTls(target.host, target.apiPort)
      if (!met.hello || !met.spkiHex) return fail('lost')
      if (met.hello.fp !== met.spkiHex.slice(0, 16) || (target.fp !== '' && target.fp !== met.hello.fp)) return fail('not-same-computer')
      pin = met.spkiHex
      request = this.deps.pinnedRequest(pin)
    }
    const keys = (this.deps.newKeys ?? newRequesterKeys)()
    const base = baseUrl(target)
    const res = await request({ method: 'POST', url: `${base}/api/pair/requests`, body: JSON.stringify({ device_name: name, platform, public_key: keys.publicB64 }) })
    if (res === 'wrong-key') return fail('not-same-computer') // another key since the hello: nothing was sent to it
    if (res === 'unreachable') return fail('lost')
    if (res === 'too-big') return fail('unreadable')
    const parsed = parseCreated(res.status, res.json, res.retryAfter)
    if (!parsed.ok) return parsed
    const created = parsed.created
    const attempt: Attempt = { created, keys, target, base, request, pin, lastPollAt: this.deps.now(), misses: 0, notified: created.notified }
    // First contact over TLS: the instance key the computer names must be the key its certificate carried. The code below is
    // computed over the named key, so a code over another key would be a code over a key Beacon never met.
    if (pin !== null && checkFirstContact({ spkiHex: pin, helloFp: pin.slice(0, 16), instancePublicKey: created.instancePublicKey }) !== null) {
      await this.withdraw(attempt)
      return fail('not-same-computer')
    }
    // The code is worked out HERE from this Mac's key, the computer's key and the request id. If it is not the one the computer
    // sent, the key it saw is not the key we sent: withdraw, and show nothing.
    const der = decodeB64url(created.instancePublicKey)
    let local: string | null = null
    try {
      local = der ? matchCode(keys.publicRaw, der, created.requestId) : null
    } catch {
      local = null
    }
    if (local === null) {
      await this.withdraw(attempt)
      return fail('unreadable')
    }
    if (local !== created.matchCode) {
      await this.withdraw(attempt)
      return fail('mismatch')
    }
    this.attempt = attempt
    return { ok: true, matchCode: local, ttlSeconds: created.ttlSeconds, pollIntervalSeconds: created.pollIntervalSeconds, notified: created.notified, deviceName: name, approveCommand: approveHereCommand(created.requestId, local) }
  }

  private async pollNow(): Promise<PollOutcome> {
    const a = this.attempt
    if (!a) return failed('gone')
    const now = this.deps.now()
    if (now - a.lastPollAt < MIN_POLL_GAP_MS) return waiting(a)
    a.lastPollAt = now
    const res = await a.request({ method: 'GET', url: `${a.base}/api/pair/requests/${a.created.requestId}`, headers: { 'x-pairing-secret': a.created.pollSecret } })
    if (this.attempt !== a) return failed('gone') // withdrawn while the answer was on its way
    if (res === 'too-big') return this.abandon('unreadable')
    if (res === 'wrong-key') return this.abandon('not-same-computer') // another key mid-wait: the poll never reached it
    if (res === 'unreachable') {
      a.misses++
      return a.misses >= LOST_AFTER_MISSES ? this.abandon('lost') : waiting(a)
    }
    a.misses = 0
    const p = parsePoll(res.status, res.json, res.retryAfter)
    switch (p.kind) {
      case 'pending':
        if (p.notified === true) a.notified = true
        return waiting(a)
      case 'denied':
      case 'expired':
      case 'canceled':
        this.attempt = null
        return { state: p.kind }
      case 'delivered':
        return this.abandon('gone') // already collected, and not by us
      case 'failed':
        return p.failure.kind === 'slow-down' ? waiting(a) : this.abandon(p.failure.kind)
      case 'approved':
        return this.finish(a, p.approved)
    }
  }

  private async cancelNow(): Promise<void> {
    const a = this.attempt
    this.attempt = null
    if (a) await this.withdraw(a)
  }

  private abandon(kind: JoinFailureKind): PollOutcome {
    this.attempt = null
    return failed(kind)
  }

  private async finish(a: Attempt, approved: Approved): Promise<PollOutcome> {
    const ports = portsFromEndpoints(approved.endpoints, a.target.apiPort, a.pin !== null)
    if (!ports.ok) return this.abandon(ports.kind)
    // Over TLS the computer names its own pin in the answer (tls.spki_sha256, Prometheus #745): when it does, it must be the key
    // Beacon met, all 64 characters. (Its absence is not a refusal: the handshake and the 201 already bound the key.)
    const said = approved.tls !== null && typeof approved.tls === 'object' ? (approved.tls as Record<string, unknown>).spki_sha256 : undefined
    if (a.pin !== null && said !== undefined && said !== a.pin) return this.abandon('not-same-computer')
    const opened = unseal(approved.sealed, a.keys.privateKey, a.created.requestId)
    // The device the token was sealed for must be the device the computer says it approved.
    if (!opened || opened.deviceId !== approved.deviceId) return this.abandon('unopened')
    const gateway = gatewayFromEndpoint(a.target.host, { apiPort: ports.apiPort, wsPort: ports.wsPort }, undefined, a.pin !== null ? { pin: a.pin } : undefined)
    if (!gateway) return this.abandon('unreadable')
    try {
      // Over TLS the computer proved its fp (hello's, the first 16 of the key it presented): a typed address had none to start with.
      this.deps.save({ gateway, token: opened.token, computerName: a.target.name, fp: a.pin !== null ? a.pin.slice(0, 16) : a.target.fp })
    } catch {
      return this.abandon('not-saved') // NOT acknowledged: the computer revokes an uncollected device by itself
    }
    // Now, and only now, say it arrived. A few tries: an unacknowledged device is revoked after a few minutes.
    for (let i = 0; i < ACK_TRIES; i++) {
      const r = await a.request({ method: 'DELETE', url: `${a.base}/api/pair/requests/${a.created.requestId}`, headers: { 'x-pairing-secret': a.created.pollSecret } })
      if (typeof r === 'object' && r.status === 204) break
      if (i < ACK_TRIES - 1) await sleep(ACK_GAP_MS)
    }
    this.attempt = null
    this.deps.activate()
    return { state: 'connected', computerName: a.target.name }
  }

  private async withdraw(a: Attempt): Promise<void> {
    await a
      .request({ method: 'DELETE', url: `${a.base}/api/pair/requests/${a.created.requestId}`, headers: { 'x-pairing-secret': a.created.pollSecret }, timeoutMs: 3_000 })
      .catch(() => undefined)
  }
}

function baseUrl(t: JoinTarget): string {
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host
  return `${t.tls ? 'https' : 'http'}://${host}:${t.apiPort}`
}
