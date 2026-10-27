import { UNKNOWN, type InstanceHealth } from '@shared/instance-watch'
import type { PinnedIdentity } from '@shared/identity-challenge'
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
 * The 60-second check of every Prometheus Beacon keeps but isn't on (docs/MULTI-PROMETHEUS.md §7).
 *
 * TODAY: nothing is checked; every one reads 'unknown'. smoke:instance-watch is red against this on purpose.
 */
export class InstanceWatch {
  constructor(readonly deps: WatchDeps) {}

  /** Check every target once, now (the smoke's entry, and what the timers call). */
  async checkAll(): Promise<void> {}

  health(_id: string): InstanceHealth {
    return UNKNOWN
  }

  start(): void {}
  stop(): void {}
}
