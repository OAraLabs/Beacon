/**
 * A LIVE FRAME FOR A SESSION THIS DESKTOP NEVER LISTED (handoff from the beacon-ios session,
 * 2026-08-30 — same hole they fixed as their DECISIONS D2; on iOS SQLite's default swallowed it,
 * here `PRAGMA foreign_keys = ON` turns it into a CRASH).
 *
 * The path: GatewaySocket → CacheService.onFrame → relinkByClientMsgId → its no-optimistic-row
 * branch → insertConfirmed → INSERT into `messages` whose session_id REFERENCES sessions(id),
 * with no parent row → SqliteError: FOREIGN KEY constraint failed → uncaught in the main process
 * → Electron error dialog → app dead. iOS-created sessions fan out to this desktop (it subscribes
 * to the firehose for unread state), so it is not exotic; Will hit it on the Devices screen.
 *
 * Two independent defects, so two independent assertions — fixing either alone still leaves a
 * crash-shaped app:
 *   1. the write must SUCCEED for an unlisted session (FK parent guaranteed), and
 *   2. a cache write that throws for ANY reason must not escape the frame handler (the cache is a
 *      cache, never a second source of truth — a disk/constraint error is not an app-killer).
 *
 * Run: npm run smoke:unlisted-session
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'

// The smoke runs from out/main/, so the source it asserts on is two levels up.
const REPO_SRC = join(__dirname, '..', '..', 'src', 'main')
const DB_PATH = `/tmp/beacon-unlisted-smoke.${process.pid}.db`
let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}
function clean(): void {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f)
}

clean()
const db = openCache(DB_PATH)
const repo = new CacheRepo(db)

console.log('[smoke] === 0. the pragma that turns a swallowed bug into a crash ===')
assert((db.pragma('foreign_keys', { simple: true }) as number) === 1, 'foreign_keys is ON (so an orphan write throws rather than silently landing)')

console.log('[smoke] === 1. a live echo for a NEVER-LISTED session ===')
const UNLISTED = `ios:${process.pid}-never-listed`
assert(repo.getMessages(UNLISTED).length === 0, 'precondition: the desktop has never listed this session')
let threw: string | null = null
try {
  // The exact third branch: an echo for a send this desktop did not originate.
  repo.relinkByClientMsgId(UNLISTED, `cmid-${process.pid}`, 4242, 0, 'user', 'hello from the phone', Date.now())
} catch (e) {
  threw = e instanceof Error ? e.message : String(e)
}
assert(threw === null, `the write does not throw (got: ${threw ?? 'no throw'})`)
const rows = repo.getMessages(UNLISTED)
assert(rows.length === 1 && rows[0].content === 'hello from the phone', 'the message is CACHED, not dropped — the row survives for the reader')

console.log('[smoke] === 2. the FK parent exists, without inventing session metadata ===')
const sess = db.prepare(`SELECT id, gateway, title, last_active FROM sessions WHERE id = ?`).get(UNLISTED) as
  | { id: string; gateway: string | null; title: string | null; last_active: number | null }
  | undefined
assert(!!sess, 'a parent session row exists (that is what the FK demands)')
assert(sess?.gateway === null && sess?.title === null, 'it invents NO gateway/title — the daemon stays the source of truth for those')

console.log('[smoke] === 3. the guarantee must not invent or overwrite session METADATA ===')
// NOT asserted: that last_active stays put. bumpWatermark() already sets it to now() on every
// confirmed insert, one line after this — and that is correct: a live frame IS activity. An
// earlier draft of this smoke pinned the opposite and was simply wrong about the system.
// What DOES matter is that guaranteeing a parent row never fabricates gateway/title, which the
// daemon owns, and never clobbers them on a session that already has them.
const OLD = `ios:${process.pid}-old-session`
repo.upsertSessionMeta(OLD, 'ios', 'an old conversation', Date.now() - 90 * 86_400_000, 0, 0)
repo.relinkByClientMsgId(OLD, `cmid2-${process.pid}`, 5150, 1, 'assistant', 'a late arrival', Date.now())
const after = db.prepare(`SELECT gateway, title FROM sessions WHERE id = ?`).get(OLD) as { gateway: string; title: string }
assert(after.gateway === 'ios', 'an existing session keeps its gateway')
assert(after.title === 'an old conversation', 'and keeps its title — the guarantee touches nothing but existence')

console.log('[smoke] === 4. a throwing cache write must not kill the app ===')
// The second defect, independent of the first: CacheService.onFrame is a fire-and-forget listener
// on the socket's 'stream' event. Whatever it throws propagates to the main process as an uncaught
// exception. Proven by SHAPE here (the guard is a source assertion — a real disk error cannot be
// staged in a smoke), and the shape is what regressed.
const svc = readFileSync(join(REPO_SRC, 'cache/service.ts'), 'utf8')
// The method that follows onFrame ends the slice, searched for FROM onFrame: an isConnected() call earlier in the file (release()
// has one) would otherwise end the slice before it starts and leave nothing to check.
const onFrameStart = svc.indexOf('private onFrame')
const onFrameBody = svc.slice(onFrameStart, svc.indexOf('\n  isConnected()', onFrameStart))
// A real try{…}catch BLOCK. An earlier draft matched /catch\s*\(/ and passed on the pre-fix
// source, because the slice contains `.catch(() => undefined)` from the reconcile line — a guard
// that green-lights the bug it exists for.
assert(/try\s*\{[\s\S]*\}\s*catch\s*\(/.test(onFrameBody), 'onFrame wraps its cache writes in a real try{…}catch block')
assert(/console\.(error|warn)/.test(onFrameBody), 'and it LOGS — swallowed silently is the other failure mode')

db.close()
clean()
console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (unlisted-session write, FK parent, no re-order, handler containment)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
