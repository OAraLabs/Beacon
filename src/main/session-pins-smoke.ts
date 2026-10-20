/**
 * Headless smoke for daemon-side pins (Prometheus#351, Beacon half).
 *
 * The interesting failures are not "does a pin round-trip" — the daemon does that. They are the
 * two ways moving state across a boundary loses it: the pins that already exist locally, and the
 * cached column that CREATE TABLE IF NOT EXISTS will never add to an existing cache.
 *
 * Run: npm run smoke:session-pins
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { needsPinMigration, pinBody, pinFailureNotice, pinnedFromWire } from '@shared/session-pins'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] session pins (Prometheus#351) ============================')

// ── the wire shape ────────────────────────────────────────────────────────
assert(pinBody(true).pinned === true, 'pinBody sends a real boolean')
assert(pinBody(false).pinned === false, 'and false is sent, not omitted')
assert(typeof pinBody(true).pinned === 'boolean', 'never a string or a 1 — the route rejects those')

// ── migrating the pins that already exist on this machine ─────────────────
assert(needsPinMigration(undefined, '1'), 'a local pin the daemon has never heard of migrates')
assert(needsPinMigration(false, '1'), 'and one the daemon reports as unpinned migrates too')
assert(!needsPinMigration(true, '1'), 'one the daemon ALREADY has does not migrate again')
assert(!needsPinMigration(undefined, null), 'no local pin, nothing to migrate')
assert(!needsPinMigration(undefined, ''), 'a cleared local row is not a pin')
assert(!needsPinMigration(true, null), 'a daemon pin with no local row is left alone')

// ── the wire boundary tolerates ABSENCE (iOS note: a pre-#351 daemon omits the key) ─────
assert(pinnedFromWire(undefined) === false, 'an ABSENT pinned key reads as not pinned (older daemon)')
assert(pinnedFromWire(null) === false, 'null reads as not pinned')
assert(pinnedFromWire(true) === true, 'true is a pin')
assert(pinnedFromWire(false) === false, 'false is not')
assert(pinnedFromWire('true') === false, 'the string "true" is NOT a pin — the daemon refuses it, so must we')
assert(pinnedFromWire(1) === false, 'nor is 1')

// ── a failed write is named, per direction ────────────────────────────────
assert(/pin that conversation/.test(pinFailureNotice(true)), 'a failed pin says pin')
assert(/unpin that conversation/.test(pinFailureNotice(false)), 'a failed unpin says unpin')
assert(pinFailureNotice(true) !== pinFailureNotice(false), 'the two are distinguishable')
assert(/HTTP 503/.test(pinFailureNotice(true, 'HTTP 503')), 'and the daemon detail survives')

// ── the cache column ──────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'beacon-pins-'))
const db = openCache(join(dir, 'cache.db'))
const repo = new CacheRepo(db)
repo.upsertSessionMeta('beacon:a', 'beacon', 'Pinned one', Date.now(), 3, 10, true)
repo.upsertSessionMeta('beacon:b', 'beacon', 'Plain one', Date.now(), 3, 10, false)
const rows = db.prepare(`SELECT id, pinned FROM sessions ORDER BY id`).all() as Array<{ id: string; pinned: number }>
assert(rows.find((r) => r.id === 'beacon:a')?.pinned === 1, 'a pin is cached')
assert(rows.find((r) => r.id === 'beacon:b')?.pinned === 0, 'and an unpinned session is cached as 0')

// The daemon OWNS this value, so an unpin has to be able to travel. A MAX/COALESCE merge here
// would make a pin permanent — the bug this assertion exists to prevent.
repo.upsertSessionMeta('beacon:a', 'beacon', 'Pinned one', Date.now(), 4, 11, false)
const after = db.prepare(`SELECT pinned FROM sessions WHERE id = 'beacon:a'`).get() as { pinned: number }
assert(after.pinned === 0, 'an UNPIN from the daemon overwrites a cached pin (not COALESCEd away)')

// A six-argument caller must not silently unpin, or every older code path becomes an unpinner.
assert(
  (() => {
    repo.upsertSessionMeta('beacon:c', 'beacon', 'Legacy caller', Date.now(), 1, 1)
    const r = db.prepare(`SELECT pinned FROM sessions WHERE id = 'beacon:c'`).get() as { pinned: number }
    return r.pinned === 0
  })(),
  'the six-arg signature still compiles and defaults to unpinned'
)

// ── the migration CREATE TABLE cannot do ──────────────────────────────────
// An existing cache never gains a column from editing SCHEMA: IF NOT EXISTS does nothing to a
// table that is already there. Drop the column the way an older cache lacks it, and reopen.
const legacyPath = join(dir, 'legacy.db')
const legacy = openCache(legacyPath)
legacy.exec(`ALTER TABLE sessions DROP COLUMN pinned`)
const before = (legacy.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).some((c) => c.name === 'pinned')
legacy.close()
const reopened = openCache(legacyPath)
const gained = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).some((c) => c.name === 'pinned')
assert(!before, 'precondition: the older cache really lacks the column')
assert(gained, 'and reopening it ADDS the column rather than failing on every query')
reopened.close()

console.log('[smoke] =========================================================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
