// Who is waiting for this Prometheus's owner to say yes: asked of the daemon every few seconds now, and told by its WebSocket frames when it
// sends them (pairing_pending, pairing_resolved: the daemon's PR 3). Everything that touches the world comes in as `deps`, so a smoke can run
// all of it with a fake daemon and a clock turned by hand.
//
// A Beacon that is NOT an owner (a device that was itself approved) is told 403 and stops asking; one that is signed out stops too. Nothing
// here logs or keeps a device name or an address: they are shown, then forgotten.
import { checkApproveRequest, decideOutcome, parseFrame, parseRequestList, type ApproveRequest, type DecideOutcome, type WaitingRequest } from '@shared/join-owner'

export const POLL_MS = 3_000
export const BACKOFF_MS = 15_000
export const MISSES_BEFORE_BACKOFF = 3
const REQUEST_ID = /^[0-9a-f]{32}$/
/** A verdict that ends the request for good, so it leaves the list whichever screen answered. */
const ENDS_REQUEST: readonly DecideOutcome[] = ['ok', 'handled', 'expired', 'gone']

export interface WatcherDeps {
  list: () => Promise<{ status: number; body: unknown; serverNowSec: number | null } | 'unreachable'>
  decide: (requestId: string, verb: 'approve' | 'deny', body?: Record<string, unknown>) => Promise<{ status: number } | 'unreachable'>
  now: () => number
  schedule: (fn: () => void, ms: number) => () => void
  publish: (requests: WaitingRequest[]) => void
  /** Ms between asks; `null` = never ask, only take frames (a probe's way of proving the frames work on their own). Default: POLL_MS. */
  pollMs?: number | null
}

export class PairingWatcher {
  private items = new Map<string, WaitingRequest>()
  private active = false
  private misses = 0
  private cancel: (() => void) | null = null
  private published = ''

  constructor(private readonly deps: WatcherDeps) {}

  /** Start asking (at once, then every few seconds), unless the daemon's frames are all there is to go on (`pollMs: null`). */
  start(): void {
    if (this.active) return
    this.active = true
    this.misses = 0
    if (this.pollMs() !== null) this.arm(0)
  }

  stop(): void {
    this.active = false
    this.cancel?.()
    this.cancel = null
  }

  /** The connection changed: forget everyone and everything learned about who this Beacon is. */
  reset(): void {
    this.stop()
    this.misses = 0
    this.items.clear()
    this.publishIfChanged()
  }

  /** Who is waiting, oldest first, without the ones whose time is up. */
  current(): WaitingRequest[] {
    const now = this.deps.now()
    return [...this.items.values()].filter((r) => r.deadlineMs > now).sort((a, b) => a.createdAt - b.createdAt)
  }

  async tick(): Promise<void> {
    if (!this.active) return
    const r = await this.deps.list()
    if (!this.active) return
    if (r === 'unreachable') return this.missed()
    const parsed = parseRequestList(r.status, r.body, r.serverNowSec, this.deps.now())
    if (parsed.kind === 'not-owner' || parsed.kind === 'signed-out') {
      // Nothing to show, and nothing to ask again: this Beacon is not an owner, or its token is not good. A new connection resets this.
      this.items.clear()
      this.publishIfChanged()
      return
    }
    if (parsed.kind === 'failed') return this.missed()
    this.misses = 0
    const next = new Map<string, WaitingRequest>()
    for (const q of parsed.requests) next.set(q.requestId, this.items.get(q.requestId) ?? q) // the daemon's list is the authority; a deadline once seen stands
    this.items = next
    this.publishIfChanged()
    this.arm(this.pollMs() ?? POLL_MS)
  }

  /** A WebSocket frame. Returns true for a pairing frame, even a malformed one: it must never reach the activity feed. */
  takesFrame(type: unknown, payload: unknown, tsSeconds: unknown): boolean {
    if (type !== 'pairing_pending' && type !== 'pairing_resolved') return false
    const ev = parseFrame(type, payload, tsSeconds, this.deps.now())
    if (ev?.kind === 'pending') {
      if (!this.items.has(ev.request.requestId)) this.items.set(ev.request.requestId, ev.request)
    } else if (ev?.kind === 'resolved') {
      this.items.delete(ev.requestId)
    }
    this.publishIfChanged()
    return true
  }

  async approve(req: ApproveRequest): Promise<DecideOutcome> {
    const ok = checkApproveRequest(req)
    if (!ok) return 'refused'
    // Only these two keys are ever sent: the daemon refuses any other.
    const body = ok.name === undefined ? { match_code: ok.code } : { match_code: ok.code, name: ok.name }
    return this.decide(ok.requestId, 'approve', body)
  }

  async deny(requestId: string): Promise<DecideOutcome> {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return 'refused'
    return this.decide(requestId, 'deny')
  }

  private async decide(requestId: string, verb: 'approve' | 'deny', body?: Record<string, unknown>): Promise<DecideOutcome> {
    const r = await this.deps.decide(requestId, verb, body)
    const outcome = r === 'unreachable' ? 'lost' : decideOutcome(r.status)
    if (ENDS_REQUEST.includes(outcome)) {
      this.items.delete(requestId)
      this.publishIfChanged()
    }
    return outcome
  }

  private missed(): void {
    this.misses++
    this.arm(this.misses >= MISSES_BEFORE_BACKOFF ? BACKOFF_MS : (this.pollMs() ?? POLL_MS))
  }

  private pollMs(): number | null {
    return this.deps.pollMs === undefined ? POLL_MS : this.deps.pollMs
  }

  private arm(ms: number): void {
    this.cancel?.()
    this.cancel = this.deps.schedule(() => void this.tick(), ms)
  }

  private publishIfChanged(): void {
    const now = this.current()
    const key = now.map((r) => r.requestId).join(',')
    if (key === this.published) return
    this.published = key
    this.deps.publish(now)
  }
}
