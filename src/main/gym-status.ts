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

  /** Forget the kept status (the settings changed: what was kept may be another gym's). */
  forget(): void {
    this.kept = null
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
    const got = await this.deps.transport.fetch()
    if (got.kind === 'same') return this.kept ? { kind: 'shown', status: this.kept, readAt: now, sample: false } : unreadable
    if (got.kind === 'unreadable') return unreadable
    if (got.kind !== 'document') return got
    const status = parseGymStatus(got.json)
    if (!status) return unreadable
    this.kept = status
    return { kind: 'shown', status, readAt: now, sample: false }
  }
}
