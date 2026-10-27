// Where a Beacon profile keeps its rows (docs/MULTI-PROMETHEUS.md §3), for probes that read or seed a profile's database.
//
// Before the first launch of a build with per-Prometheus folders, everything is in beacon.db (a probe that SEEDS beacon.db before
// launching still works: the app moves it on that launch). After it:
//   app.db                 this Beacon's own rows: settings classified Beacon-wide, saved connections ('beacon')
//   daemons/<id>/cache.db  one Prometheus's rows: conversations, messages, outbox, drafts, groups ('prometheus')
// 'prometheus' means the most recently used folder, the one the app opened last.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The database file holding a profile's rows of this scope. */
export function profileDb(profile, scope = 'prometheus') {
  const app = join(profile, 'app.db')
  if (!existsSync(app)) return join(profile, 'beacon.db')
  if (scope === 'beacon') return app
  const id = execFileSync('sqlite3', [`file:${app}?mode=ro`, 'SELECT id FROM daemon_folders ORDER BY last_active DESC LIMIT 1']).toString().trim()
  if (!id) throw new Error(`no Prometheus folder in ${profile} yet`)
  return join(profile, 'daemons', id, 'cache.db')
}

/** Every database file in a profile, relative to it: beacon.db, or app.db and each folder's cache.db. */
export function profileDbFiles(profile) {
  if (!existsSync(join(profile, 'app.db'))) return existsSync(join(profile, 'beacon.db')) ? ['beacon.db'] : []
  const dir = join(profile, 'daemons')
  const folders = existsSync(dir) ? readdirSync(dir).filter((id) => existsSync(join(dir, id, 'cache.db'))) : []
  return ['app.db', ...folders.map((id) => join('daemons', id, 'cache.db'))]
}

/** Copy every database of profile `src` into `dest` with SQLite's backup API (`-readonly`, so the source is never written). */
export function copyProfileDbs(src, dest) {
  const files = profileDbFiles(src)
  if (files.length === 0) throw new Error(`no Beacon database in ${src}`)
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true })
    execFileSync('sqlite3', ['-readonly', join(src, f), `.backup '${join(dest, f)}'`])
  }
}

/** Run one statement in every database of a profile that has a settings table (all of them): for clearing settings rows a probe
 *  needs absent, wherever their scope put them. */
export function sqlEach(profile, stmt) {
  for (const f of profileDbFiles(profile)) execFileSync('sqlite3', [join(profile, f), stmt])
}

/** Whether a profile keeps its saved connections on its folder rows (layout 3 and later) rather than in gateway_profiles. */
function recordsOnFolders(profile) {
  const app = join(profile, 'app.db')
  if (!existsSync(app)) return false
  return execFileSync('sqlite3', [`file:${app}?mode=ro`, "SELECT count(*) FROM pragma_table_info('daemon_folders') WHERE name = 'ws_url'"]).toString().trim() === '1'
}

/** The saved connection Beacon connects to at launch, as 'api_base|ws_url|pin' (pin empty when none), or '' with none: from the
 *  active folder's row (layout 3) or the default gateway_profiles row (before it), whichever this profile has. */
export function savedConnection(profile) {
  const db = profileDb(profile, 'beacon')
  const sql = recordsOnFolders(profile)
    ? "SELECT api_base || '|' || ws_url || '|' || COALESCE(pin, '') FROM daemon_folders WHERE ws_url IS NOT NULL AND id = (SELECT value FROM settings WHERE key = 'daemons:active')"
    : "SELECT api_base || '|' || ws_url || '|' || COALESCE(pin, '') FROM gateway_profiles WHERE is_default = 1"
  return execFileSync('sqlite3', [`file:${db}?mode=ro`, sql]).toString().trim()
}

/** How many Prometheus a profile keeps a saved connection for. */
export function keptCount(profile) {
  const db = profileDb(profile, 'beacon')
  const sql = recordsOnFolders(profile) ? 'SELECT count(*) FROM daemon_folders WHERE ws_url IS NOT NULL' : 'SELECT count(*) FROM gateway_profiles'
  return Number(execFileSync('sqlite3', [`file:${db}?mode=ro`, sql]).toString().trim())
}
