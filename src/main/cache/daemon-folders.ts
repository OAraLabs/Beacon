import { join } from 'node:path'
import type { SocketEvent } from '@shared/socket-log'
import type { UiTraceEvent } from '@shared/ui-trace'
import type { WatchdogEvent } from '@shared/watchdog-log'
import { openCache, type CacheDb } from './db'
import { CacheRepo } from './repo'

/** Who a cache is for (docs/MULTI-PROMETHEUS.md §2): the address it was reached at, and its instance fingerprint when known. */
export interface DaemonIdentity {
  apiBase: string
  /** hello's `fp` (16 hex), or null while it is not known yet. */
  fp: string | null
}

/** One Prometheus's cache: the folder it lives in, and the repo over it. */
export interface DaemonFolder {
  id: string
  repo: CacheRepo
}

/** What main and the IPC handlers ask of the store: settings (routed by key), the saved connection, and the diagnostic tables. */
export type BeaconStore = Pick<
  CacheRepo,
  | 'getSetting'
  | 'setSetting'
  | 'deleteSessionSettings'
  | 'pruneSessionSettings'
  | 'getDefaultGatewayProfile'
  | 'upsertGatewayProfile'
  | 'deleteGatewayProfiles'
  | 'listGatewayProfiles'
  | 'recordSocketEvent'
  | 'recordUiTrace'
  | 'recordWatchdogEvent'
  | 'getSessions'
>

/**
 * Where Beacon keeps what it caches, per Prometheus (docs/MULTI-PROMETHEUS.md §3).
 *
 * TODAY'S LAYOUT, extracted as it is: one `beacon.db` for everything, whichever Prometheus is connected. `open` hands back
 * that same repo for every identity, so conversations, the outbox and per-conversation settings are shared by every
 * Prometheus Beacon is ever pointed at. smoke:daemon-isolation is red against this on purpose.
 */
export class DaemonFolders implements BeaconStore {
  private readonly db: CacheDb
  readonly app: CacheRepo

  constructor(root: string) {
    this.db = openCache(join(root, 'beacon.db'))
    this.app = new CacheRepo(this.db)
  }

  /** The cache for this Prometheus. */
  open(_who: DaemonIdentity): DaemonFolder {
    return { id: 'beacon', repo: this.app }
  }

  /** Stop using the open cache (Start over). */
  closeCurrent(): void {}

  close(): void {
    this.db.close()
  }

  getSetting(key: string): string | null {
    return this.app.getSetting(key)
  }
  setSetting(key: string, value: string): void {
    this.app.setSetting(key, value)
  }
  deleteSessionSettings(sessionId: string): void {
    this.app.deleteSessionSettings(sessionId)
  }
  pruneSessionSettings(): number {
    return this.app.pruneSessionSettings()
  }
  getDefaultGatewayProfile(): ReturnType<CacheRepo['getDefaultGatewayProfile']> {
    return this.app.getDefaultGatewayProfile()
  }
  upsertGatewayProfile(name: string, apiBase: string, wsUrl: string, isDefault: boolean, pin: string | null = null): void {
    this.app.upsertGatewayProfile(name, apiBase, wsUrl, isDefault, pin)
  }
  deleteGatewayProfiles(): void {
    this.app.deleteGatewayProfiles()
  }
  listGatewayProfiles(): ReturnType<CacheRepo['listGatewayProfiles']> {
    return this.app.listGatewayProfiles()
  }
  recordSocketEvent(e: SocketEvent): void {
    this.app.recordSocketEvent(e)
  }
  recordUiTrace(e: UiTraceEvent): void {
    this.app.recordUiTrace(e)
  }
  recordWatchdogEvent(e: WatchdogEvent): void {
    this.app.recordWatchdogEvent(e)
  }
  getSessions(): ReturnType<CacheRepo['getSessions']> {
    return this.app.getSessions()
  }
}
