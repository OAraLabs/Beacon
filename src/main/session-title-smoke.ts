/**
 * Session-title smoke: the daemon's generated title must reach the row label, and must be
 * CORRECTABLE once stored.
 *
 * Three separate defects had to line up for a session list to show raw ids while the daemon was
 * serving real titles, and each looked reasonable alone:
 *
 *   1. `rest.ts` mapped `title: s.session_id` — it never read the daemon's `title` field. The
 *      "daemon's session_id echo" that downstream documented and worked around was manufactured
 *      HERE, by discarding the field and substituting the id.
 *   2. `upsertSessionMeta` used `COALESCE(sessions.title, excluded.title)` — EXISTING wins — so
 *      once an id landed in that column it could never be replaced. `ensureSession` used the
 *      opposite order; the two writers disagreed.
 *   3. the display layer preferred a first-message snippet unconditionally, reasonably, because
 *      of (1).
 *
 * Fixing only (3) — which is where the symptom was visible — would have been inert. This file
 * pins (2) and the display precedence; (1) is a one-line field read covered by the live probe.
 *
 * Run: npm run smoke:session-title
 */
import { existsSync, unlinkSync } from 'node:fs'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { sessionDisplayTitle } from '@shared/session-tree'

const DB_PATH = '/tmp/beacon-session-title-smoke.db'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(p)) unlinkSync(p)
const repo = new CacheRepo(openCache(DB_PATH))
const ID = 'ios:31db8132-6634-4646-a570-0e8c88464b36'
const REAL = 'Project Directory Structure Analysis'

console.log('[smoke] === 1. a stored title is CORRECTABLE ===')
// The pre-fix world: an id was written into the title column by an older build.
repo.upsertSessionMeta(ID, 'ios', ID, Date.now(), 3, 10)
assert(repo.getSessions().find((r) => r.id === ID)?.title === ID, 'seeded with the id, as an old cache would be')
// The daemon now serves a real title. EXISTING-wins would strand the id forever.
repo.upsertSessionMeta(ID, 'ios', REAL, Date.now(), 3, 10)
assert(
  repo.getSessions().find((r) => r.id === ID)?.title === REAL,
  'a real title REPLACES a previously stored id — existing-wins stranded it permanently'
)

console.log('')
console.log('[smoke] === 2. but "no title" never erases a good one ===')
repo.upsertSessionMeta(ID, 'ios', null, Date.now(), 4, 11)
assert(
  repo.getSessions().find((r) => r.id === ID)?.title === REAL,
  'a NULL incoming keeps the stored title — the daemon having nothing to say is not a correction'
)
assert(repo.getSessions().find((r) => r.id === ID)?.message_count === 4, 'and the rest of the row still updates')

console.log('')
console.log('[smoke] === 3. the display precedence over what is stored ===')
assert(sessionDisplayTitle(REAL, 'list the files please', ID) === REAL, 'a real title beats the snippet')
assert(sessionDisplayTitle(ID, 'list the files please', ID) === 'list the files please', 'an id-as-title is an echo → snippet')
assert(sessionDisplayTitle(null, '', ID) === ID, 'nothing usable → the id, never a blank row')

for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(p)) unlinkSync(p)
console.log('')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (correctable, null-safe, precedence)`)
process.exit(failures === 0 ? 0 : 1)
