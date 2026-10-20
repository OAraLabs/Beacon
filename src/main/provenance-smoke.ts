/**
 * Headless smoke for per-message provenance + trust (Prometheus#123, audit P9.3).
 *
 * The interesting failures are not "does a user row stay unbadged" — that is the easy half. They
 * are the three ways moving two new fields across four boundaries loses them, and the one the type
 * system cannot catch: the MIGRATION. A cache that already exists on the owner's machine has no
 * `provenance`/`is_trusted` columns, and `CREATE TABLE IF NOT EXISTS` will never add them — only
 * `migrate()`'s ALTER does. Every other smoke opens a FRESH temp DB, which hits CREATE TABLE and
 * therefore never exercises the upgrade path. This one builds an old-schema cache first, then
 * opens it, so a regression in migrate() fails here instead of silently on the operator's real
 * cache after an update.
 *
 * Run: npm run smoke:provenance
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import {
  USER_PROVENANCE,
  isMachineryProvenance,
  isOperatorTurn,
  isTrustedFromWire,
  lastOperatorTurn,
  provenanceLabel
} from '@shared/provenance'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] provenance + trust (Prometheus#123) ======================')

// ── the decoder: is_trusted ────────────────────────────────────────────────
// Absent reads as TRUE (the daemon's own default) so a pre-#123 daemon does not paint the operator's whole
// history as untrusted. A string 'false' or number 0 is NOT the boolean — refused, like
// pinnedFromWire refuses 'true' and 1.
assert(isTrustedFromWire(undefined) === true, 'an ABSENT is_trusted reads as trusted (older daemon)')
assert(isTrustedFromWire(null) === true, 'null reads as trusted')
assert(isTrustedFromWire(true) === true, 'boolean true is trusted')
assert(isTrustedFromWire(false) === false, 'boolean false is untrusted')
assert(isTrustedFromWire('false') === true, 'the string "false" is NOT untrusted — the daemon never sends it')
assert(isTrustedFromWire(0) === true, 'nor is the number 0')

// ── the decoder: provenance ────────────────────────────────────────────────
// The safe direction splits by presence: ABSENT means pre-feature daemon → user; a PRESENT-but-
// unmapped string means a newer daemon added a machinery source → not-user. An allowlist that
// treated unknown as user would silently render a new automated source as the operator's own words.
assert(isMachineryProvenance(null) === false, 'absent provenance is not machinery')
assert(isMachineryProvenance(undefined) === false, 'undefined provenance is not machinery')
assert(isMachineryProvenance('') === false, 'empty provenance is not machinery')
assert(isMachineryProvenance(USER_PROVENANCE) === false, 'provenance "user" is not machinery')
assert(isMachineryProvenance('task_supervisor') === true, 'task_supervisor IS machinery')
assert(isMachineryProvenance('compactor') === true, 'compactor IS machinery')
assert(isMachineryProvenance('file_mutation_verifier') === true, 'file_mutation_verifier IS machinery')
assert(isMachineryProvenance('some_future_source') === true, 'an UNKNOWN provenance is machinery — safe direction')

// ── the label: known sources name themselves, unknown falls back ───────────
assert(provenanceLabel('user') === null, 'a user row gets NO label (no badge)')
assert(provenanceLabel(null) === null, 'an absent provenance gets no label')
assert(provenanceLabel('task_supervisor') === 'task supervisor', 'task_supervisor → "task supervisor"')
assert(provenanceLabel('file_mutation_verifier') === 'file-mutation verifier', 'file_mutation_verifier → human label')
assert(provenanceLabel('some_future_source') === 'automated', 'an unknown source labels as "automated", not raw snake_case')

// ── THE MIGRATION: an existing old-schema cache gains the columns ───────────
// Build a messages table WITHOUT provenance/is_trusted (the pre-#123 shape), put a row in it, then
// openCache() → SCHEMA no-ops (table exists), migrate() ALTERs the columns in. This is the path a
// real update walks and no fresh-DB smoke reaches.
const dir = mkdtempSync(join(tmpdir(), 'beacon-prov-'))
const oldPath = join(dir, 'cache.db')
{
  const old = new Database(oldPath)
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, gateway TEXT, title TEXT, created_at INTEGER,
      last_active INTEGER, message_count INTEGER DEFAULT 0, watermark INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, row_id INTEGER, ordinal INTEGER, role TEXT NOT NULL,
      content TEXT, content_json TEXT, tool_calls TEXT, created_at INTEGER NOT NULL,
      client_msg_id TEXT,
      PRIMARY KEY (session_id, id)
    );
  `)
  old.prepare(`INSERT INTO sessions (id, gateway, created_at) VALUES (?, ?, ?)`).run('s1', 'beacon', Date.now())
  // A row written by the OLD schema — no provenance, no is_trusted.
  old.prepare(
    `INSERT INTO messages (session_id, id, row_id, ordinal, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s1', '1', 1, 0, 'user', 'typed before the upgrade', Date.now())
  old.close()
}

const db = openCache(oldPath) // runs SCHEMA (no-op) + migrate (ALTER)
const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
assert(cols.some((c) => c.name === 'provenance'), 'migrate() ADDs the provenance column to an existing cache')
assert(cols.some((c) => c.name === 'is_trusted'), 'migrate() ADDs the is_trusted column to an existing cache')

// The pre-existing row must read NULL in both — which the read path decodes to (user, trusted), so
// an upgraded cache renders the operator's old history UNBADGED, not flagged as machinery.
const oldRow = db.prepare(`SELECT provenance, is_trusted FROM messages WHERE id = '1'`).get() as {
  provenance: string | null
  is_trusted: number | null
}
assert(oldRow.provenance === null, 'an old row reads provenance NULL (→ user, unbadged)')
assert(oldRow.is_trusted === null, 'an old row reads is_trusted NULL (→ trusted)')

// ── the round-trip: a machinery row written through the repo carries both ───
const repo = new CacheRepo(db)
repo.upsertSessionMeta('s2', 'beacon', 'Automated one', Date.now(), 1, 0, false)
repo.reconcileSession(
  's2',
  [
    { rowId: 10, ordinal: 0, role: 'assistant', content: 'from the supervisor', provenance: 'task_supervisor', isTrusted: true },
    { rowId: 11, ordinal: 1, role: 'assistant', content: 'fetched a page', provenance: 'user', isTrusted: false }
  ],
  11
)
const rows = db
  .prepare(`SELECT id, provenance, is_trusted FROM messages WHERE session_id = 's2' ORDER BY row_id`)
  .all() as Array<{ id: string; provenance: string | null; is_trusted: number | null }>
const r10 = rows.find((r) => r.id === '10')!
const r11 = rows.find((r) => r.id === '11')!
assert(r10.provenance === 'task_supervisor', 'a machinery provenance round-trips through the cache')
assert(r10.is_trusted === 1, 'isTrusted:true stores as 1')
assert(r11.is_trusted === 0, 'isTrusted:false stores as 0 (distinct from NULL legacy)')
assert(r11.provenance === 'user', 'an explicit "user" provenance is stored verbatim, not nulled')

// And the conflict path: a re-pull that UPGRADES a row to untrusted must overwrite, not COALESCE
// away (the same lesson as the pin un-pin — a stale-merge here would freeze trust state).
repo.reconcileSession('s2', [{ rowId: 10, ordinal: 0, role: 'assistant', content: 'from the supervisor', provenance: 'task_supervisor', isTrusted: false }], 11)
const after = db.prepare(`SELECT is_trusted FROM messages WHERE id = '10'`).get() as { is_trusted: number }
assert(after.is_trusted === 0, 'a re-pull can flip a cached row to untrusted (not COALESCEd away)')

db.close()

// ── What Retry and Edit may act on ──────────────────────────────────────────────────────────
// A machine turn can arrive with the USER role: a background task's or a worker's report
// (task_supervisor), a coding supervisor's inject (supervisor), an orchestrator nudge. Retry
// re-sends "the last user message" and Edit copies it back into the composer — on one of these,
// either would send the machine's (often untrusted) text as the operator's own words.
console.log('[smoke] === operator turns: what Retry and Edit may act on ===')
assert(isOperatorTurn({ role: 'user', provenance: 'user' }), "the operator's own message is an operator turn")
assert(
  isOperatorTurn({ role: 'user' }) && isOperatorTurn({ role: 'user', provenance: null }) && isOperatorTurn({ role: 'user', provenance: '' }),
  'so is one with no provenance (an older daemon, an optimistic row not yet echoed)'
)
for (const p of ['task_supervisor', 'supervisor', 'orchestrator', 'file_mutation_verifier', 'teacher_escalation', 'compactor', 'a_source_added_later']) {
  assert(!isOperatorTurn({ role: 'user', provenance: p }), `a user-role turn from ${p} is NOT the operator's`)
}
assert(!isOperatorTurn({ role: 'assistant', provenance: 'user' }), 'an assistant turn is not')
const turns = [
  { key: '1', role: 'user', provenance: 'user', text: 'run the tests in the background' },
  { key: '2', role: 'assistant', provenance: 'user', text: 'started' },
  { key: '3', role: 'user', provenance: 'task_supervisor', text: 'A background task you started has finished.' },
  { key: '4', role: 'user', provenance: undefined, text: '' }
]
assert(
  lastOperatorTurn(turns, (r) => !!r.text)?.key === '1',
  `Retry's target skips a NEWER machine turn and an empty row (got ${lastOperatorTurn(turns, (r) => !!r.text)?.key})`
)
assert(
  lastOperatorTurn([{ key: '9', role: 'user', provenance: 'task_supervisor', text: 'x' }], (r) => !!r.text) === undefined,
  'with no operator turn there is nothing to retry — never the machine turn instead'
)

console.log(`[smoke] provenance: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
if (failures > 0) process.exit(1)
