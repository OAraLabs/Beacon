/**
 * Forget-session smoke: proves CacheRepo.deleteSession purges a session's rows from the durable
 * local cache. Headless / main-process (ELECTRON_RUN_AS_NODE), NO daemon required — this exercises
 * the cache layer in isolation (better-sqlite3 needs the Electron ABI, hence `electron` + the env).
 *
 *   npm run build && npm run smoke:forget
 *
 * Proves: (1) deleteSession removes EVERY row for the target session across all three tables —
 * messages, outbox, sessions; (2) a control session is left fully intact (delete is scoped by id);
 * (3) it is idempotent — forgetting again, or forgetting an unknown id, is a safe no-op.
 *
 * This is the desktop half of "Forget session"; the daemon half (DELETE /api/sessions removing the
 * in-memory entry) is covered by Prometheus tests/test_api_session_delete.py.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openCache } from './cache/db'
import { CacheRepo, type CanonicalMessage } from './cache/repo'

const DB_PATH = '/tmp/beacon-forget-smoke.db'
const NONCE = `${process.pid}.${Date.now()}`
const FORGET = `desktop:s4-forgetme-${NONCE}` // the junk session we will forget
const KEEP = `desktop:keepme-${NONCE}` // control: must survive untouched

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
function cleanDb(): void {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f)
}

/** Seed a session with N optimistic message + 1 outbox row + the given canonical (confirmed) rows. */
function seed(repo: CacheRepo, sessionId: string, canon: CanonicalMessage[]): void {
  repo.ensureSession(sessionId, 'desktop')
  const cmid = randomUUID()
  const optimisticId = repo.addOptimisticMessage(sessionId, 'user', `pending ${sessionId}`, cmid)
  repo.attachOutbox(sessionId, `pending ${sessionId}`, randomUUID(), cmid, optimisticId)
  repo.reconcileSession(sessionId, canon, canon[canon.length - 1]?.rowId ?? 0)
}

function main(): void {
  cleanDb()
  const db = openCache(DB_PATH)
  const repo = new CacheRepo(db)

  // Direct SQL counts give an unambiguous before/after on each of the three tables.
  const nMessages = (sid: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).get(sid) as { n: number }).n
  const nOutbox = (sid: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE session_id = ?`).get(sid) as { n: number }).n
  const nSessions = (sid: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`).get(sid) as { n: number }).n
  const listed = (sid: string): boolean => repo.getSessions().some((s) => s.id === sid)

  // ── seed: FORGET = 1 optimistic + 2 confirmed msgs (3) + 1 outbox; KEEP = 1 + 1 (2) + 1 ──
  seed(repo, FORGET, [
    { rowId: 1001, ordinal: 0, role: 'user', content: 'hello' },
    { rowId: 1002, ordinal: 1, role: 'assistant', content: 'hi there' }
  ])
  seed(repo, KEEP, [{ rowId: 2001, ordinal: 0, role: 'user', content: 'keep me' }])

  console.log('\n[smoke] === preconditions: both sessions have rows in all three tables ===')
  assert(nMessages(FORGET) === 3, `FORGET has 3 messages (got ${nMessages(FORGET)})`)
  assert(nOutbox(FORGET) === 1, `FORGET has 1 outbox row (got ${nOutbox(FORGET)})`)
  assert(nSessions(FORGET) === 1 && listed(FORGET), 'FORGET is in sessions + sidebar list')
  assert(nMessages(KEEP) === 2, `KEEP has 2 messages (got ${nMessages(KEEP)})`)
  assert(nOutbox(KEEP) === 1, `KEEP has 1 outbox row (got ${nOutbox(KEEP)})`)
  assert(nSessions(KEEP) === 1 && listed(KEEP), 'KEEP is in sessions + sidebar list')

  // ── act: forget FORGET ──────────────────────────────────────────────────────
  console.log('\n[smoke] === deleteSession(FORGET) ===')
  repo.deleteSession(FORGET)

  console.log('\n[smoke] === every FORGET row is gone, across all three tables ===')
  assert(nMessages(FORGET) === 0, `FORGET messages purged (got ${nMessages(FORGET)})`)
  assert(nOutbox(FORGET) === 0, `FORGET outbox purged (got ${nOutbox(FORGET)})`)
  assert(nSessions(FORGET) === 0, `FORGET session row purged (got ${nSessions(FORGET)})`)
  assert(!listed(FORGET), 'FORGET no longer appears in the sidebar list')
  assert(repo.getMessages(FORGET).length === 0, 'repo.getMessages(FORGET) is empty')

  console.log('\n[smoke] === the control session is untouched (delete is scoped by id) ===')
  assert(nMessages(KEEP) === 2, `KEEP messages intact (got ${nMessages(KEEP)})`)
  assert(nOutbox(KEEP) === 1, `KEEP outbox intact (got ${nOutbox(KEEP)})`)
  assert(nSessions(KEEP) === 1 && listed(KEEP), 'KEEP still listed')

  console.log('\n[smoke] === idempotency: forget again + forget an unknown id are safe no-ops ===')
  let threw = false
  try {
    repo.deleteSession(FORGET) // already gone
    repo.deleteSession(`desktop:never-existed-${NONCE}`)
  } catch {
    threw = true
  }
  assert(!threw, 'repeat / unknown deleteSession did not throw')
  assert(nMessages(FORGET) === 0 && nSessions(FORGET) === 0, 'FORGET still fully gone after repeat')
  assert(nMessages(KEEP) === 2 && listed(KEEP), 'KEEP still intact after the no-op deletes')

  // ── A6: session-scoped settings hygiene ──────────────────────────────────
  console.log('[smoke] === A6. settings rows go with the session ===')
  repo.setSetting(`title:${KEEP}`, 'keep me')
  repo.setSetting(`pinned:${KEEP}`, '1')
  repo.setSetting('title:ghost-session', 'orphan from before the hygiene existed')
  repo.setSetting(`viewed:ghost-session`, '42')
  repo.setSetting(`pinned:${KEEP}-cleared`, '') // an empty value is a cleared flag, not data
  repo.setSetting('theme', 'NOX') // control: a NON-session setting must never be touched
  // `draft:` rows — the composer text that survives a relaunch (@shared/drafts). They are
  // per-session state like title/viewed/pinned, so they must be covered by BOTH mechanisms: the
  // forget-time delete and the orphan sweep. Missing from SESSION_SETTING_PREFIXES, a forgotten
  // session would leak one draft row each, forever, which is precisely the leak this block exists
  // to prevent — and nothing would have said so.
  repo.setSetting(`draft:${KEEP}`, 'half a thought')
  repo.setSetting('draft:ghost-session', 'an orphaned draft')
  repo.setSetting(`draft:${KEEP}-cleared`, '') // a sent draft clears the row; the empty must be swept
  repo.deleteSessionSettings(FORGET) // idempotent even though FORGET never had rows
  const pruned = repo.pruneSessionSettings()
  // 5, not 3: the two pre-existing orphans/empties above plus the ghost draft and the cleared draft.
  // Asserted as an exact number because "the sweep removed things" passes just as happily when it
  // removes too many — and too many means it ate a live session's draft.
  assert(pruned === 5, `the sweep removed exactly the orphans + empties (got ${pruned})`)
  assert(repo.getSetting(`title:${KEEP}`) === 'keep me', 'a LIVE session keeps its title')
  assert(repo.getSetting(`pinned:${KEEP}`) === '1', 'a LIVE session keeps its pin')
  assert(repo.getSetting(`draft:${KEEP}`) === 'half a thought', 'a LIVE session keeps its draft — the sweep must not eat typing')
  assert(repo.getSetting('title:ghost-session') === null, 'an orphaned title row is gone')
  assert(repo.getSetting('draft:ghost-session') === null, 'an orphaned draft row is gone')
  assert(repo.getSetting(`draft:${KEEP}-cleared`) === null, 'a cleared (empty) draft row is swept rather than left blank forever')
  assert(repo.getSetting('theme') === 'NOX', 'non-session settings are untouched by the sweep')
  repo.setSetting(`title:${KEEP}2`, 'x') // (no such session — simulate forget-time cleanup)
  repo.setSetting(`draft:${KEEP}2`, 'text in the field when forget ran')
  repo.deleteSessionSettings(`${KEEP}2`)
  assert(repo.getSetting(`title:${KEEP}2`) === null, 'forget-time cleanup removes the exact rows')
  assert(repo.getSetting(`draft:${KEEP}2`) === null, 'forget-time cleanup removes the draft row too — the durable half of the forget')

  // ── report ────────────────────────────────────────────────────────────────
  console.log('\n[smoke] ========================= RESULT =========================')
  console.log(`[smoke] FORGET rows (msgs/outbox/sessions): ${nMessages(FORGET)}/${nOutbox(FORGET)}/${nSessions(FORGET)}`)
  console.log(`[smoke] KEEP   rows (msgs/outbox/sessions): ${nMessages(KEEP)}/${nOutbox(KEEP)}/${nSessions(KEEP)}`)
  console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓ (deleteSession purges all three tables, scoped, idempotent)' : `FAIL ✗ (${failures})`}`)
  console.log('[smoke] ===========================================================')

  db.close()
  cleanDb()
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
}
