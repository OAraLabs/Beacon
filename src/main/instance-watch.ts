import { UNKNOWN, aiLabel, nextCheckMs, type InstanceHealth } from '@shared/instance-watch'
import type { PinnedIdentity, Verdict } from '@shared/identity-challenge'
import { createProver } from './identity'
import type { RequestFn } from './pairing/http'

/** A Prometheus to check: the fields of its saved connection the check needs. */
export interface WatchTarget {
  id: string
  apiBase: string
  wsUrl: string
  pin: string | null
}

export interface WatchDeps {
  /** Every Prometheus Beacon keeps that it isn't on now. */
  targets: () => WatchTarget[]
  /** That Prometheus's own key, or null. */
  keyOf: (id: string) => string | null
  /** The node key pinned for it, or null. */
  pinsOf: (id: string) => PinnedIdentity | null
  /** Pin a first good answer (as the connection does). */
  pin: (id: string, p: PinnedIdentity) => void
  /** No key, no redirect; pinned to `pin` for a TLS Prometheus. */
  requestFor: (t: WatchTarget) => RequestFn
  /** Whether the address may be used at all (src/main/plain-public.ts). */
  refusal: (t: WatchTarget) => Promise<string | null>
  verify: (message: string, signature: string, publicKey: string) => boolean
  now: () => number
  /** Something changed: the list should be read again. */
  onChange: () => void
}

/**
 * The 60-second check of every Prometheus Beacon keeps but isn't on (docs/MULTI-PROMETHEUS.md §7), for its row in the list: one
 * GET /api/status each, with that Prometheus's own key, and only after it has proved who it is, exactly as a connection would
 * (src/main/identity.ts). One that can't be reached is checked every 5 minutes, and never announced. No socket is opened: the
 * Prometheus Beacon isn't on is read, never streamed. And never relayed: what one says goes to its own row, nowhere else
 * (docs/MULTI-PROMETHEUS.md §2 rule 5).
 */
export class InstanceWatch {
  private readonly rows = new Map<string, InstanceHealth>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private running = false

  constructor(readonly deps: WatchDeps) {}

  health(id: string): InstanceHealth {
    return this.rows.get(id) ?? UNKNOWN
  }

  /** Check every target once, now. */
  async checkAll(): Promise<void> {
    await Promise.all(this.deps.targets().map((t) => this.check(t)))
  }

  start(): void {
    this.running = true
    this.refresh()
  }

  stop(): void {
    this.running = false
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** The list changed (a save, a switch): drop rows no longer watched (the active one included), and check new ones now. */
  refresh(): void {
    const ids = new Set(this.deps.targets().map((t) => t.id))
    for (const id of [...this.rows.keys()]) if (!ids.has(id)) this.rows.delete(id)
    for (const [id, timer] of [...this.timers]) {
      if (ids.has(id)) continue
      clearTimeout(timer)
      this.timers.delete(id)
    }
    if (!this.running) return
    for (const id of ids) if (!this.timers.has(id)) this.schedule(id, 0)
  }

  private schedule(id: string, ms: number): void {
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        const t = this.deps.targets().find((x) => x.id === id)
        if (!t || !this.running) return
        void this.check(t).finally(() => {
          if (this.running && this.deps.targets().some((x) => x.id === id)) this.schedule(id, nextCheckMs(this.health(id)))
        })
      }, ms)
    )
  }

  private async check(t: WatchTarget): Promise<void> {
    const before = this.health(t.id)
    const after = await this.ask(t, before).catch((): InstanceHealth => unreachable(before, this.deps.now()))
    this.rows.set(t.id, after)
    if (after.state !== before.state || after.ai !== before.ai) this.deps.onChange()
  }

  private async ask(t: WatchTarget, before: InstanceHealth): Promise<InstanceHealth> {
    if (await this.deps.refusal(t)) return { state: 'refused', ai: null, since: null }
    const request = this.deps.requestFor(t)
    const seen: { verdict: Verdict | null } = { verdict: null }
    const prove = createProver({
      apiBase: t.apiBase,
      request,
      pinned: () => this.deps.pinsOf(t.id),
      tlsSpki: t.pin,
      verify: this.deps.verify,
      nowS: () => Math.floor(this.deps.now() / 1000),
      onVerdict: (v) => {
        seen.verdict = v
        if (v.kind === 'first') this.deps.pin(t.id, { instanceId: v.instanceId, nodePub: v.nodePub })
        return undefined
      }
    })
    // Asked once: no answer is "can't reach it", checked again later, never waited out here.
    const refused = await prove({ waiting: () => undefined, stopped: () => true })
    if (refused !== null) return seen.verdict === null ? unreachable(before, this.deps.now()) : { state: 'different', ai: null, since: null }
    const key = this.deps.keyOf(t.id)
    const r = await request({ method: 'GET', url: `${t.apiBase}/api/status`, headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: 5_000 })
    if (r === 'wrong-key') return { state: 'different', ai: null, since: null } // a pinned TLS Prometheus presenting another key
    if (r === 'unreachable' || r === 'too-big') return unreachable(before, this.deps.now())
    if (r.status === 401) return { state: 'key-refused', ai: null, since: null }
    // 403: an approved device a Prometheus older than route_access's /api/status entry turns away. It answered; it just won't say.
    if (r.status === 403) return { state: 'connected', ai: null, since: this.deps.now() }
    if (r.status !== 200) return unreachable(before, this.deps.now())
    const body = (r.json ?? {}) as { provider?: unknown; model?: unknown }
    return { state: 'connected', ai: aiLabel(body.provider, body.model), since: this.deps.now() }
  }
}

/** Can't be reached: since when it first couldn't be, kept across checks. */
function unreachable(before: InstanceHealth, now: number): InstanceHealth {
  return { state: 'unreachable', ai: before.ai, since: before.state === 'unreachable' ? before.since : now }
}
