import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { fpFromPin, settingScope, validFp } from '@shared/daemon-profiles'
import type { SocketEvent } from '@shared/socket-log'
import type { UiTraceEvent } from '@shared/ui-trace'
import type { WatchdogEvent } from '@shared/watchdog-log'
import { openAppDb, openCache, type CacheDb } from './db'
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

const LEGACY_DB = 'beacon.db'
const APP_DB = 'app.db'
const DAEMONS_DIR = 'daemons'
const CACHE_DB = 'cache.db'
const BACKUP_DIR = 'backup-pre-daemons'
/** The folder the one pre-existing cache moves into. Its fp is bound on first contact (at once for a TLS profile: its pin says). */
export const LEGACY_FOLDER_ID = 'legacy-1'
/** app.db setting written LAST by the migration (and at once on a fresh install): the layout is in place. */
export const LAYOUT_KEY = 'daemons:layout'

/** The migration's steps, for smoke:daemon-folders to stop the process after each. */
export type MigrationStep = 'backup' | 'app' | 'move'

/** Thrown by an injected crash: the smoke's stand-in for the process dying there. Never caught by the fallback. */
export class InjectedCrash extends Error {}

export interface DaemonFoldersOptions {
  /** SMOKE ONLY: stop after this step, as a crash would. */
  crashAfter?: MigrationStep
}

/**
 * Where Beacon keeps what it caches (docs/MULTI-PROMETHEUS.md §3):
 *
 *   app.db                  this Beacon's settings, the saved connection, the list of folders (APP_SCHEMA)
 *   daemons/<id>/cache.db   one Prometheus's conversations, messages, outbox and per-conversation settings
 *
 * One folder is open at a time, the one `open` last returned. Settings are routed by key (@shared/daemon-profiles): a
 * Prometheus's go to its open folder, and with no folder open they are not there to read and are not written. So nothing a
 * Prometheus wrote can be listed, sent or shown while another is open: there is no table the two share.
 *
 * If the move can't be made (a disk that refuses), Beacon keeps today's single beacon.db, logs why, and tries again next launch.
 */
export class DaemonFolders implements BeaconStore {
  readonly app: CacheRepo
  private readonly appDb: CacheDb
  /** True when the migration could not run: beacon.db is then both Beacon's store and the one cache, as before. */
  private readonly single: boolean
  private current: { id: string; db: CacheDb; repo: CacheRepo } | null = null

  constructor(
    private readonly root: string,
    opts: DaemonFoldersOptions = {}
  ) {
    let single = false
    try {
      migrate(root, opts)
    } catch (err) {
      if (err instanceof InjectedCrash) throw err
      console.error('[cache] could not move to one folder per Prometheus; keeping beacon.db as it is:', (err as Error).message)
      single = true
    }
    this.single = single
    this.appDb = single ? openCache(join(root, LEGACY_DB)) : openAppDb(join(root, APP_DB))
    this.app = new CacheRepo(this.appDb)
  }

  /** The cache for this Prometheus, opened (and the one before it closed). See `resolve` for which folder that is. */
  open(who: DaemonIdentity): DaemonFolder {
    if (this.single) return { id: LEGACY_DB, repo: this.app }
    const id = this.resolve(who)
    this.touch(id, who.apiBase)
    if (this.current?.id === id) return this.current
    this.closeCurrent()
    const dir = join(this.root, DAEMONS_DIR, id)
    mkdirSync(dir, { recursive: true })
    const db = openCache(join(dir, CACHE_DB))
    const repo = new CacheRepo(db)
    this.current = { id, db, repo }
    // A6 hygiene, per folder: per-conversation rows whose conversation this folder no longer holds.
    const pruned = repo.pruneSessionSettings()
    if (pruned > 0) console.log(`[cache] pruned ${pruned} orphaned session-scoped settings row(s) in ${id}`)
    return this.current
  }

  /**
   * The file that holds the key Beacon uses with the Prometheus whose folder is `id` (docs/MULTI-PROMETHEUS.md §3).
   *
   * TODAY: the one api-credential.bin, whichever Prometheus it is for. smoke:credential-origin is red against this on purpose.
   */
  keyPath(_id: string): string {
    return join(this.root, 'api-credential.bin')
  }

  /** The open folder's id, or null. */
  currentId(): string | null {
    return this.single ? LEGACY_DB : (this.current?.id ?? null)
  }

  /**
   * hello has said who answers for folder `id`: the folder that Prometheus's things belong in. The same folder when it had no fp
   * yet (it is bound now, for good) or already had this one; another folder when this fp is someone else's, or when `id` was bound
   * to a different Prometheus (then the one at this address now gets its own folder). The caller reopens when the answer differs.
   */
  bind(id: string, fp: string): string {
    if (this.single || !validFp(fp)) return id
    const owner = this.row('SELECT id FROM daemon_folders WHERE fp = ?', fp)
    if (owner) return owner.id
    const row = this.row('SELECT id, fp, api_base FROM daemon_folders WHERE id = ?', id)
    if (row && row.fp === null) {
      this.appDb.prepare('UPDATE daemon_folders SET fp = ? WHERE id = ?').run(fp, id)
      return id
    }
    return this.resolve({ apiBase: row?.api_base ?? '', fp })
  }

  /** This Prometheus is reached at a new address now (Settings → Connection, Edit address): its folder, key and all, goes with it, so
   *  the new address opens it. hello at the new address still has the last word (`bind`). */
  moveAddress(id: string, apiBase: string): void {
    if (this.single) return
    this.appDb.prepare('UPDATE daemon_folders SET api_base = ?, last_active = ? WHERE id = ?').run(apiBase, Date.now(), id)
  }

  /** Stop using the open folder (Start over): a Prometheus's settings then read as absent and are not written. */
  closeCurrent(): void {
    if (!this.current) return
    this.current.db.close()
    this.current = null
  }

  close(): void {
    this.closeCurrent()
    this.appDb.close()
  }

  /**
   * Which folder holds this Prometheus's things, creating its row if it has none:
   * - fp known: the folder bound to it; else a folder at this address that no fp was bound to yet (the cache opened before hello
   *   answered, or the legacy one), bound now; else a new folder named by the fp.
   * - fp not known (a plain connection, before hello): the folder last used at this address, whatever it is bound to (hello then
   *   corrects it through `bind`); else a new unbound folder.
   */
  private resolve({ apiBase, fp }: DaemonIdentity): string {
    if (validFp(fp)) {
      const bound = this.row('SELECT id FROM daemon_folders WHERE fp = ?', fp)
      if (bound) return bound.id
      const unbound =
        this.row('SELECT id FROM daemon_folders WHERE api_base = ? AND fp IS NULL ORDER BY last_active DESC LIMIT 1', apiBase) ?? this.unclaimed()
      if (unbound) {
        this.appDb.prepare('UPDATE daemon_folders SET fp = ? WHERE id = ?').run(fp, unbound.id)
        return unbound.id
      }
      return this.create(fp, fp, apiBase)
    }
    const last = this.row('SELECT id FROM daemon_folders WHERE api_base = ? ORDER BY last_active DESC LIMIT 1', apiBase) ?? this.unclaimed()
    return last ? last.id : this.create(`new-${randomBytes(4).toString('hex')}`, null, apiBase)
  }

  /** The legacy folder when its cache had no saved connection (a profile run on an environment-given gateway): no address and no
   *  fp, so nothing else can claim it. The first connection does. */
  private unclaimed(): { id: string } | undefined {
    return this.appDb.prepare('SELECT id FROM daemon_folders WHERE api_base IS NULL AND fp IS NULL LIMIT 1').get() as { id: string } | undefined
  }

  private create(id: string, fp: string | null, apiBase: string): string {
    this.appDb.prepare('INSERT INTO daemon_folders (id, fp, api_base, last_active) VALUES (?, ?, ?, ?)').run(id, fp, apiBase, Date.now())
    return id
  }

  private touch(id: string, apiBase: string): void {
    this.appDb.prepare('UPDATE daemon_folders SET api_base = ?, last_active = ? WHERE id = ?').run(apiBase, Date.now(), id)
  }

  private row(sql: string, arg: string): { id: string; fp: string | null; api_base: string | null } | undefined {
    return this.appDb.prepare(sql).get(arg) as { id: string; fp: string | null; api_base: string | null } | undefined
  }

  /** The repo a key's row lives in, or null for a Prometheus's key while none is open. */
  private storeFor(key: string): CacheRepo | null {
    if (this.single || settingScope(key) === 'beacon') return this.app
    return this.current?.repo ?? null
  }

  getSetting(key: string): string | null {
    return this.storeFor(key)?.getSetting(key) ?? null
  }
  setSetting(key: string, value: string): void {
    this.storeFor(key)?.setSetting(key, value)
  }
  deleteSessionSettings(sessionId: string): void {
    this.cacheRepo()?.deleteSessionSettings(sessionId)
  }
  pruneSessionSettings(): number {
    return this.cacheRepo()?.pruneSessionSettings() ?? 0
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
  // The diagnostic tables are a Prometheus's (they name its sessions and its socket), so a support export from one holds nothing
  // from another. With no folder open there is nothing to describe, and the row is dropped.
  recordSocketEvent(e: SocketEvent): void {
    this.cacheRepo()?.recordSocketEvent(e)
  }
  recordUiTrace(e: UiTraceEvent): void {
    this.cacheRepo()?.recordUiTrace(e)
  }
  recordWatchdogEvent(e: WatchdogEvent): void {
    this.cacheRepo()?.recordWatchdogEvent(e)
  }
  getSessions(): ReturnType<CacheRepo['getSessions']> {
    return this.cacheRepo()?.getSessions() ?? []
  }

  private cacheRepo(): CacheRepo | null {
    return this.single ? this.app : (this.current?.repo ?? null)
  }
}

/**
 * The once-only move from one beacon.db to app.db + daemons/legacy-1/cache.db (docs/MULTI-PROMETHEUS.md §3.1). Every step is
 * idempotent and LAYOUT_KEY is written last, so a crash anywhere is finished by the next launch. Until the move, beacon.db is
 * the truth: a step that re-runs copies from it again.
 */
function migrate(root: string, opts: DaemonFoldersOptions): void {
  const crash = (step: MigrationStep): void => {
    if (opts.crashAfter === step) throw new InjectedCrash(`injected crash after ${step}`)
  }
  const legacy = join(root, LEGACY_DB)
  const target = join(root, DAEMONS_DIR, LEGACY_FOLDER_ID, CACHE_DB)
  const appDb = openAppDb(join(root, APP_DB))
  try {
    if (appDb.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(LAYOUT_KEY) === '1') return
    if (existsSync(legacy)) {
      backupOnce(root, legacy)
      crash('backup')
      copyBeaconRows(legacy, appDb)
      crash('app')
      mkdirSync(dirname(target), { recursive: true })
      // copyBeaconRows checkpointed and closed beacon.db, so the -wal/-shm beside it are gone or empty; carried along if not.
      for (const ext of ['-wal', '-shm']) if (existsSync(legacy + ext)) renameSync(legacy + ext, target + ext)
      renameSync(legacy, target)
      crash('move')
    }
    appDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LAYOUT_KEY, '1')
  } finally {
    appDb.close()
  }
}

/** Step 0: a copy of beacon.db, taken once, before anything moves, with a MANIFEST written last (size and SHA-256). Never written
 *  again. A later release deletes it, once that release has proven it reads the new layout. */
function backupOnce(root: string, legacy: string): void {
  const dir = join(root, BACKUP_DIR)
  const manifest = join(dir, 'MANIFEST')
  if (existsSync(manifest)) return
  checkpoint(legacy)
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, LEGACY_DB)
  copyFileSync(legacy, copy)
  const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
  const want = sha(legacy)
  if (sha(copy) !== want) throw new Error('the backup copy of beacon.db does not match it')
  writeFileSync(manifest, `${LEGACY_DB} ${statSync(copy).size} ${want}\n`)
}

/** Fold the WAL into beacon.db, so the file alone holds everything. */
function checkpoint(path: string): void {
  const db = new Database(path)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** Step 1: this Beacon's settings, the saved connection, and the legacy folder's row, from beacon.db into app.db. REPLACE, because
 *  beacon.db stays the truth until it moves. The legacy folder is bound to the saved connection's address, and to its fp at once
 *  when that connection is pinned (@shared/daemon-profiles fpFromPin). */
function copyBeaconRows(legacy: string, appDb: CacheDb): void {
  // Opened the way the app opens a cache, so an older or partial beacon.db gains its missing tables and columns first (the
  // backup above keeps it as it was).
  const old = openCache(legacy)
  try {
    const settings = old.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string | null }>
    const profiles = old
      .prepare('SELECT name, api_base, ws_url, is_default, pin FROM gateway_profiles')
      .all() as Array<{ name: string; api_base: string; ws_url: string; is_default: number; pin: string | null }>
    appDb.transaction(() => {
      const setRow = appDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      for (const s of settings) if (settingScope(s.key) === 'beacon') setRow.run(s.key, s.value)
      const profileRow = appDb.prepare('INSERT OR REPLACE INTO gateway_profiles (name, api_base, ws_url, is_default, pin) VALUES (?, ?, ?, ?, ?)')
      for (const p of profiles) profileRow.run(p.name, p.api_base, p.ws_url, p.is_default, p.pin)
      const def = profiles.find((p) => p.is_default === 1) ?? null
      appDb
        .prepare('INSERT OR REPLACE INTO daemon_folders (id, fp, api_base, last_active) VALUES (?, ?, ?, ?)')
        .run(LEGACY_FOLDER_ID, fpFromPin(def?.pin), def?.api_base ?? null, Date.now())
    })()
    old.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    old.close()
  }
}
