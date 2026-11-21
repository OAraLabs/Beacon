// The gym dashboard's reader (@shared/gym): ask the transport for the document, read it as a status, answer the page.
//
// Main does this, never the page: the page asks for "the gym's status" and is given the parsed numbers or a reason. Where the
// document comes from is the transport's business alone (./gym-transport.ts: today the gym's status service over Tailscale,
// later the Prometheus gateway). This file would not change if it did.
//
// A non-release build can read a file instead (BEACON_GYM_STATUS_FILE), as BEACON_TAILNET_STATUS_FILE does, so the panel can be
// looked at without a gym. The answer says it is a sample and the panel says so on screen.
import { readFileSync } from 'node:fs'
import { GYM_READ_COPY, parseGymStatus, type GymRead, type GymStatus } from '@shared/gym'
import type { GymTransport } from './gym-transport'

export interface GymReaderDeps {
  transport: GymTransport
  /** A sample status file (a non-release build only; the caller decides), or null. */
  sampleFile?: string | null
  now?: () => number
}

export class GymStatusReader {
  /** The last status shown, for a transport that says "the same as last time". */
  private kept: GymStatus | null = null

  constructor(private readonly deps: GymReaderDeps) {}

  /** Counts settings changes, so an answer that was asked for before one is not shown after it. */
  private generation = 0

  /** Forget the kept status (the settings changed: what was kept may be another gym's). */
  forget(): void {
    this.kept = null
    this.generation++
  }

  async read(): Promise<GymRead> {
    const now = (this.deps.now ?? Date.now)()
    const unreadable: GymRead = { kind: 'unreadable', detail: GYM_READ_COPY.unreadable }
    if (this.deps.sampleFile) {
      try {
        const status = parseGymStatus(JSON.parse(readFileSync(this.deps.sampleFile, 'utf8')))
        return status ? { kind: 'shown', status, readAt: now, sample: true } : unreadable
      } catch {
        return unreadable
      }
    }
    const asked = this.generation
    const got = await this.deps.transport.fetch()
    if (asked !== this.generation) return this.read() // the settings changed while it was in flight: that answer is the old gym's
    if (got.kind === 'same') {
      if (this.kept) return { kind: 'shown', status: this.kept, readAt: now, sample: false }
      // "Unchanged", but nothing is kept to show (the settings were saved again while a request was in flight, say). The
      // transport forgets that ETag and the document is asked for in full, once.
      this.deps.transport.discardLast?.()
      const again = await this.deps.transport.fetch()
      const status = again.kind === 'document' && asked === this.generation ? parseGymStatus(again.json) : null
      if (!status) return unreadable
      this.kept = status
      return { kind: 'shown', status, readAt: now, sample: false }
    }
    if (got.kind === 'unreadable') return unreadable
    if (got.kind !== 'document') return got
    const status = parseGymStatus(got.json)
    if (!status) {
      // Not a status: nothing older is passed off as current, and the transport must not call this document "unchanged".
      this.kept = null
      this.deps.transport.discardLast?.()
      return unreadable
    }
    this.kept = status
    return { kind: 'shown', status, readAt: now, sample: false }
  }
}
