import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { fpFromPin, settingScope, validFp } from '@shared/daemon-profiles'
import { CREDENTIAL_KIND_KEY } from '@shared/model-setup'
import type { PinnedIdentity } from '@shared/identity-challenge'
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
/** The one key file before keys moved into folders, and each folder's own. */
const LEGACY_KEY_FILE = 'api-credential.bin'
const KEY_FILE = 'credential.bin'
/** The folder the one pre-existing cache moves into. Its fp is bound on first contact (at once for a TLS profile: its pin says). */
export const LEGACY_FOLDER_ID = 'legacy-1'
/** app.db setting: the folder id of the Prometheus Beacon connects to at launch ('' with none). */
export const ACTIVE_KEY = 'daemons:active'

/** One Prometheus Beacon keeps (listInstances). No key: a list is shown, a key is never. */
export interface InstanceRecord {
  id: string
  label: string
  apiBase: string
  wsUrl: string
  pin: string | null
  fp: string | null
  instanceId: string | null
  nodePub: string | null
  lastActive: number
  active: boolean
}

interface InstanceRow {
  id: string
  fp: string | null
  api_base: string
  ws_url: string
  pin: string | null
  label: string | null
  instance_id: string | null
  node_pub: string | null
  last_active: number
}

/** app.db setting written LAST by each migration (and at once on a fresh install): which layout is in place. '1': conversations
 *  in folders. '2': keys in folders too. '3': each Prometheus's saved connection, and its credential facts, with its folder. */
export const LAYOUT_KEY = 'daemons:layout'
export const LAYOUT = '3'

/** The migration's steps, for smoke:daemon-folders to stop the process after each. */
export type MigrationStep = 'backup' | 'app' | 'move' | 'key' | 'record'

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
  open(who: DaemonIdentity & { id?: string }): DaemonFolder {
    if (this.single) return { id: LEGACY_DB, repo: this.app }
    // `id`: a folder already known to be this Prometheus's (its pinned node key answered), whatever the address and fp say.
    const id = who.id && this.row('SELECT id FROM daemon_folders WHERE id = ?', who.id) ? who.id : this.resolve(who)
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
   * The file that holds the key Beacon uses with the Prometheus whose folder is `id` (docs/MULTI-PROMETHEUS.md §3): its own
   * credential.bin, so a key is only ever read for the Prometheus that minted it, and goes when its folder goes. In the fallback
   * single-file layout, the one api-credential.bin as before.
   */
  keyPath(id: string): string {
    return this.single ? join(this.root, LEGACY_KEY_FILE) : join(this.root, DAEMONS_DIR, id, KEY_FILE)
  }

  /** The folder a Prometheus's things go in (see `resolve`), without opening it: where a save writes the key it is about to use. */
  folderFor(who: DaemonIdentity): string {
    return this.single ? LEGACY_DB : this.resolve(who)
  }

  /** The node key (and instance_id) pinned for folder `id`, or null when none is yet. */
  identityOf(id: string): PinnedIdentity | null {
    if (this.single) return null
    const r = this.appDb.prepare('SELECT instance_id, node_pub FROM daemon_folders WHERE id = ?').get(id) as
      | { instance_id: string | null; node_pub: string | null }
      | undefined
    return r?.node_pub ? { instanceId: r.instance_id, nodePub: r.node_pub } : null
  }

  /** Pin a Prometheus's node key (and instance_id) to its folder: from its first good answer, or a move the person confirmed. */
  pinIdentity(id: string, pin: PinnedIdentity): void {
    if (this.single) return
    this.appDb.prepare('UPDATE daemon_folders SET instance_id = ?, node_pub = ? WHERE id = ?').run(pin.instanceId, pin.nodePub, id)
  }

  /** The folder already pinned to this node key and instance_id: the same Prometheus, reached by another address or fp. */
  folderWithIdentity(pin: PinnedIdentity): string | undefined {
    if (this.single) return undefined
    const r = this.appDb
      .prepare('SELECT id FROM daemon_folders WHERE node_pub = ? AND (instance_id IS ? OR instance_id = ?) LIMIT 1')
      .get(pin.nodePub, pin.instanceId, pin.instanceId) as { id: string } | undefined
    return r?.id
  }

  /**
   * Keep a Prometheus Beacon has just connected to (docs/MULTI-PROMETHEUS.md §6, Add): its name, address, socket and pin, on the row
   * of the folder its things go in, and make it the active one. Every other Prometheus Beacon keeps stays as it was. Returns the id.
   */
  saveInstance(gw: { name: string; apiBase: string; wsUrl: string; pin?: string | null }, id?: string): string {
    if (this.single) {
      this.app.upsertGatewayProfile(gw.name, gw.apiBase, gw.wsUrl, true, gw.pin ?? null)
      return LEGACY_DB
    }
    const folder = id ?? this.folderFor({ apiBase: gw.apiBase, fp: fpFromPin(gw.pin) })
    this.appDb
      .prepare('UPDATE daemon_folders SET label = ?, api_base = ?, ws_url = ?, pin = ?, last_active = ? WHERE id = ?')
      .run(gw.name, gw.apiBase, gw.wsUrl, gw.pin ?? null, Date.now(), folder)
    this.setActive(folder)
    return folder
  }

  /** The Prometheus Beacon connects to at launch, or null with none kept. */
  activeInstance(): { id: string; gateway: { name: string; apiBase: string; wsUrl: string; pin: string | null } } | null {
    if (this.single) {
      const p = this.app.getDefaultGatewayProfile()
      return p ? { id: LEGACY_DB, gateway: p } : null
    }
    const id = this.app.getSetting(ACTIVE_KEY)
    const r = id ? this.instanceRow(id) : undefined
    return r ? { id: r.id, gateway: { name: r.label ?? 'mini', apiBase: r.api_base, wsUrl: r.ws_url, pin: r.pin } } : null
  }

  /** Every Prometheus Beacon keeps, the active one marked: what the sidebar list shows (PR 4). No key is in it. */
  listInstances(): InstanceRecord[] {
    if (this.single) {
      return this.app.listGatewayProfiles().map((p) => ({ id: LEGACY_DB, label: p.name, apiBase: p.apiBase, wsUrl: p.wsUrl, pin: null, fp: null, instanceId: null, nodePub: null, lastActive: 0, active: p.isDefault }))
    }
    const active = this.app.getSetting(ACTIVE_KEY)
    const rows = this.appDb
      .prepare('SELECT id, fp, api_base, ws_url, pin, label, instance_id, node_pub, last_active FROM daemon_folders WHERE ws_url IS NOT NULL ORDER BY last_active DESC')
      .all() as InstanceRow[]
    return rows.map((r) => ({ id: r.id, label: r.label ?? 'mini', apiBase: r.api_base, wsUrl: r.ws_url, pin: r.pin, fp: r.fp, instanceId: r.instance_id, nodePub: r.node_pub, lastActive: r.last_active, active: r.id === active }))
  }

  /** Make folder `id`'s Prometheus the active one (it must be one Beacon keeps). */
  setActive(id: string): void {
    if (this.single || !this.instanceRow(id)) return
    this.app.setSetting(ACTIVE_KEY, id)
  }

  /**
   * Forget the active Prometheus's saved connection (Start over, Set up again): it is no longer kept, nothing is active, and every other
   * Prometheus stays as it was. Its folder (cache and pins) stays on disk; its key is the caller's to clear.
   */
  forgetActive(): void {
    if (this.single) {
      this.app.deleteGatewayProfiles()
      return
    }
    const id = this.app.getSetting(ACTIVE_KEY)
    if (id) this.appDb.prepare('UPDATE daemon_folders SET ws_url = NULL WHERE id = ?').run(id)
    this.app.setSetting(ACTIVE_KEY, '')
  }

  /**
   * A setting of the Prometheus of folder `id`, written before that folder is open (a save, before bring-up): into ITS folder,
   * whichever is open now. A Beacon-wide key goes to app.db as always.
   */
  setSettingFor(id: string, key: string, value: string): void {
    if (this.single || settingScope(key) === 'beacon') return this.setSetting(key, value)
    if (this.current?.id === id) return this.current.repo.setSetting(key, value)
    const dir = join(this.root, DAEMONS_DIR, id)
    mkdirSync(dir, { recursive: true })
    const db = openCache(join(dir, CACHE_DB))
    try {
      new CacheRepo(db).setSetting(key, value)
    } finally {
      db.close()
    }
  }

  /** Read back what setSettingFor wrote, the same way. */
  getSettingFor(id: string, key: string): string | null {
    if (this.single || settingScope(key) === 'beacon') return this.getSetting(key)
    if (this.current?.id === id) return this.current.repo.getSetting(key)
    const path = join(this.root, DAEMONS_DIR, id, CACHE_DB)
    if (!existsSync(path)) return null
    const db = openCache(path)
    try {
      return new CacheRepo(db).getSetting(key)
    } finally {
      db.close()
    }
  }

  private instanceRow(id: string): InstanceRow | undefined {
    return this.appDb
      .prepare('SELECT id, fp, api_base, ws_url, pin, label, instance_id, node_pub, last_active FROM daemon_folders WHERE id = ? AND ws_url IS NOT NULL')
      .get(id) as InstanceRow | undefined
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
  // The saved connection, as main has always asked for it: now the active Prometheus's record (activeInstance, saveInstance,
  // forgetActive). The gateway_profiles table is read once, by the migration, and no longer written.
  getDefaultGatewayProfile(): ReturnType<CacheRepo['getDefaultGatewayProfile']> {
    return this.activeInstance()?.gateway ?? null
  }
  upsertGatewayProfile(name: string, apiBase: string, wsUrl: string, _isDefault: boolean, pin: string | null = null): void {
    this.saveInstance({ name, apiBase, wsUrl, pin })
  }
  deleteGatewayProfiles(): void {
    this.forgetActive()
  }
  listGatewayProfiles(): ReturnType<CacheRepo['listGatewayProfiles']> {
    return this.listInstances().map((i) => ({ name: i.label, apiBase: i.apiBase, wsUrl: i.wsUrl, isDefault: i.active }))
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
    const layout = appDb.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(LAYOUT_KEY)
    if (layout === LAYOUT) return
    if (layout !== '1' && existsSync(legacy)) {
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
    if (layout !== '2') {
      moveKey(root, appDb)
      crash('key')
    }
    moveRecord(root, appDb)
    crash('record')
    appDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LAYOUT_KEY, LAYOUT)
  } finally {
    appDb.close()
  }
}

/** The settings that are one Prometheus's facts about its key, Beacon-wide until layout 3 (PR 2 left them beside the one key file). */
const CREDENTIAL_FACTS = [CREDENTIAL_KIND_KEY, 'connection.deviceRole']

/**
 * Step 4: the saved connection onto its Prometheus's folder row, made the active one, and the facts about its key (the kind of
 * credential, the remembered device role) from app.db into that folder's cache.db. Copied before they are deleted from app.db,
 * so a crash between leaves them in both, and the next run copies again: the same value.
 */
function moveRecord(root: string, appDb: CacheDb): void {
  const profiles = appDb.prepare('SELECT name, api_base, ws_url, is_default, pin FROM gateway_profiles ORDER BY is_default DESC, name').all() as Array<{
    name: string
    api_base: string
    ws_url: string
    is_default: number
    pin: string | null
  }>
  let activeId: string | null = null
  for (const p of profiles) {
    const id = folderOfProfile(appDb, p.api_base, p.pin)
    appDb.prepare('UPDATE daemon_folders SET label = ?, api_base = ?, ws_url = ?, pin = ? WHERE id = ?').run(p.name, p.api_base, p.ws_url, p.pin, id)
    if (p.is_default === 1 && activeId === null) activeId = id
  }
  if (activeId === null) return
  const facts = CREDENTIAL_FACTS.map((k) => [k, appDb.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(k)] as const).filter(
    (f): f is readonly [string, string] => typeof f[1] === 'string'
  )
  if (facts.length > 0) {
    const dir = join(root, DAEMONS_DIR, activeId)
    mkdirSync(dir, { recursive: true })
    const db = openCache(join(dir, CACHE_DB))
    try {
      const repo = new CacheRepo(db)
      for (const [k, v] of facts) repo.setSetting(k, v)
    } finally {
      db.close()
    }
    for (const [k] of facts) appDb.prepare('DELETE FROM settings WHERE key = ?').run(k)
  }
  appDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ACTIVE_KEY, activeId)
}

/** The folder a saved profile belongs to (the one its key moved into in step 3), created when it has none. */
function folderOfProfile(appDb: CacheDb, apiBase: string, pin: string | null): string {
  const fp = fpFromPin(pin)
  const row =
    (fp ? (appDb.prepare('SELECT id FROM daemon_folders WHERE fp = ?').get(fp) as { id: string } | undefined) : undefined) ??
    (appDb.prepare('SELECT id FROM daemon_folders WHERE api_base = ? ORDER BY last_active DESC LIMIT 1').get(apiBase) as { id: string } | undefined) ??
    (appDb.prepare('SELECT id FROM daemon_folders WHERE api_base IS NULL AND fp IS NULL LIMIT 1').get() as { id: string } | undefined)
  if (row) return row.id
  const id = fp ?? `new-${randomBytes(4).toString('hex')}`
  appDb.prepare('INSERT INTO daemon_folders (id, fp, api_base, last_active) VALUES (?, ?, ?, ?)').run(id, fp, apiBase, Date.now())
  return id
}

/**
 * Step 3: the one api-credential.bin into the folder of the Prometheus it was minted by, the saved connection's (docs/MULTI-PROMETHEUS.md
 * §3.1). Copied to the backup first. A rename, so it is never in two places or none. With no saved connection it stays where it is:
 * there is no Prometheus to give it to, and nothing reads it there.
 */
function moveKey(root: string, appDb: CacheDb): void {
  const key = join(root, LEGACY_KEY_FILE)
  if (!existsSync(key)) return
  const backup = join(root, BACKUP_DIR, LEGACY_KEY_FILE)
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true })
    copyFileSync(key, backup)
  }
  const def = appDb.prepare('SELECT api_base, pin FROM gateway_profiles WHERE is_default = 1 ORDER BY name LIMIT 1').get() as
    | { api_base: string; pin: string | null }
    | undefined
  if (!def) return
  const fp = fpFromPin(def.pin)
  const row = (fp ? (appDb.prepare('SELECT id FROM daemon_folders WHERE fp = ?').get(fp) as { id: string } | undefined) : undefined) ??
    (appDb.prepare('SELECT id FROM daemon_folders WHERE api_base = ? ORDER BY last_active DESC LIMIT 1').get(def.api_base) as { id: string } | undefined) ??
    (appDb.prepare('SELECT id FROM daemon_folders WHERE id = ?').get(LEGACY_FOLDER_ID) as { id: string } | undefined)
  const id = row?.id ?? fp ?? LEGACY_FOLDER_ID
  if (!row) appDb.prepare('INSERT INTO daemon_folders (id, fp, api_base, last_active) VALUES (?, ?, ?, ?)').run(id, fp, def.api_base, Date.now())
  const target = join(root, DAEMONS_DIR, id, KEY_FILE)
  mkdirSync(dirname(target), { recursive: true })
  if (!existsSync(target)) renameSync(key, target)
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
