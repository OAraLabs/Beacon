import Database from 'better-sqlite3'
import { APP_SCHEMA, SCHEMA } from './schema'

export type CacheDb = Database.Database

/**
 * Open (and migrate) the local cache. Electron-free on purpose — the caller passes the path
 * (main uses app.getPath('userData'); the smoke uses a temp file), so the cache layer runs
 * under ELECTRON_RUN_AS_NODE without the app module.
 */
export function openCache(path: string): CacheDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Open Beacon's own store, app.db (APP_SCHEMA): settings, the saved connection, the list of Prometheus folders. */
export function openAppDb(path: string): CacheDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(APP_SCHEMA)
  // An app.db made before the identity pins (PR 1's): the two columns, NULL (nothing pinned yet) on every row.
  const cols = db.prepare(`PRAGMA table_info(daemon_folders)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'instance_id')) db.exec(`ALTER TABLE daemon_folders ADD COLUMN instance_id TEXT`)
  if (!cols.some((c) => c.name === 'node_pub')) db.exec(`ALTER TABLE daemon_folders ADD COLUMN node_pub TEXT`)
  return db
}

/** Additive, idempotent migrations for caches created before a column existed. The cache is
 * disposable, but ALTER ADD COLUMN is O(1) and preserves it (no re-pull needed). */
function migrate(db: CacheDb): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'content_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN content_json TEXT`)
  }
  // Prometheus P9.3: provenance + is_trusted. Same shape as content_json — an existing cache never
  // gains a column from editing SCHEMA alone (CREATE TABLE IF NOT EXISTS no-ops on it), so each is
  // ALTERed here too. NULL on existing rows reads as (user, trusted) downstream, the daemon's own
  // default, so a pre-#123 cache renders unchanged rather than badging the owner's history as machinery.
  if (!cols.some((c) => c.name === 'provenance')) {
    db.exec(`ALTER TABLE messages ADD COLUMN provenance TEXT`)
  }
  if (!cols.some((c) => c.name === 'is_trusted')) {
    db.exec(`ALTER TABLE messages ADD COLUMN is_trusted INTEGER`)
  }
  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so an existing cache
  // never gains a column from editing SCHEMA alone — it has to be altered here too.
  const sess = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>
  if (!sess.some((c) => c.name === 'pinned')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0`)
  }
  // Multi-computer v0.4 (docs/MULTI-COMPUTER-v0.4.md §3): a home-network Prometheus's TLS pin, kept with its profile. NULL on
  // every existing row: a plain connection, exactly as before.
  const gw = db.prepare(`PRAGMA table_info(gateway_profiles)`).all() as Array<{ name: string }>
  if (!gw.some((c) => c.name === 'pin')) {
    db.exec(`ALTER TABLE gateway_profiles ADD COLUMN pin TEXT`)
  }
}
