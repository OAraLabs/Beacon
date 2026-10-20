/**
 * Headless smoke for retiring an optimistic row whose WS echo was MISSED (audit P9.6, Prometheus#496).
 *
 * THE DEFECT. A client writes an optimistic row keyed by its own client_msg_id on send, then
 * re-keys it to the durable rowid when the WS user-echo arrives (relinkByClientMsgId). Miss that
 * echo — a socket drop between the send returning 200 and the echo, or a restart in that window —
 * and nothing retired the optimistic row. Reconcile then inserts the CONFIRMED row under
 * str(rowId), a different primary key, so both persist and the duplicate renders at the bottom of
 * the thread forever (getMessages sorts row_id IS NULL last). Only the slash-command case had a fix
 * (dropTransientCommandRow); the ordinary user-message case did not.
 *
 * The fix is reconcile-time retirement by client_msg_id, which the daemon now persists and returns
 * on GET history (Prometheus#496). No content matching: two identical sends are legitimately two
 * messages, and matching on text would merge them.
 *
 * Run: npm run smoke:retire-optimistic
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] optimistic-row retirement on a missed echo (P9.6) ======')

const dir = mkdtempSync(join(tmpdir(), 'beacon-retire-'))
const db = openCache(join(dir, 'cache.db'))
const repo = new CacheRepo(db)
const SID = 'beacon:missed-echo'

// ── THE BUG: optimistic row + reconcile WITHOUT the correlation id ────────────
// This is what happens against an older daemon (no client_msg_id on the wire): the confirmed row
// lands beside the optimistic one and the duplicate survives. Pinned as the KNOWN GAP, because the
// client cannot retire what it has no key to match on.
{
  const cmid = `cmid-old-${process.pid}`
  repo.addOptimisticMessage(SID, 'user', 'sent before the socket dropped', cmid)
  const before = repo.getMessages(SID).length
  repo.reconcileSession(SID, [{ rowId: 100, ordinal: 0, role: 'user', content: 'sent before the socket dropped' }], 100)
  const rows = repo.getMessages(SID)
  assert(rows.length === before + 1, 'KNOWN GAP (no client_msg_id): the confirmed row lands BESIDE the optimistic one')
  assert(rows.some((r) => r.row_id === null) && rows.some((r) => r.row_id === 100),
    'KNOWN GAP (no client_msg_id): both survive — the duplicate is real')
}

// ── THE FIX: the same shape WITH the correlation id the daemon now returns ────
{
  const SID2 = 'beacon:with-id'
  const cmid = `cmid-new-${process.pid}`
  repo.addOptimisticMessage(SID2, 'user', 'typed this', cmid)
  assert(repo.getMessages(SID2).length === 1, 'precondition: one optimistic row, row_id NULL')
  assert(repo.getMessages(SID2)[0].row_id === null, 'precondition: it is unconfirmed')

  // Reconcile brings the daemon's confirmed row, carrying the SAME client_msg_id.
  repo.reconcileSession(SID2, [{ rowId: 200, ordinal: 0, role: 'user', content: 'typed this', clientMsgId: cmid }], 200)

  const rows = repo.getMessages(SID2)
  assert(rows.length === 1, `the duplicate is RETIRED — exactly one row survives (got ${rows.length})`)
  assert(rows[0].row_id === 200 && rows[0].id === '200', 'and the survivor is the CONFIRMED row, not the optimistic one')
  assert(!rows.some((r) => r.row_id === null), 'no optimistic row is left behind')
}

// ── the refusal direction: retirement must not over-fire ──────────────────────
{
  // A DIFFERENT client_msg_id must not retire anything. Two identical-content sends are two
  // messages; only a matching id proves they are the same one.
  const SID3 = 'beacon:distinct-ids'
  repo.addOptimisticMessage(SID3, 'user', 'same words', 'cmid-A')
  repo.reconcileSession(SID3, [{ rowId: 300, ordinal: 0, role: 'user', content: 'same words', clientMsgId: 'cmid-B' }], 300)
  const rows = repo.getMessages(SID3)
  assert(rows.length === 2, `a NON-matching id retires nothing — identical content stays two messages (got ${rows.length})`)
  assert(rows.some((r) => r.row_id === null), 'and the optimistic row is untouched')
}
{
  // Assistant turns and injected turns carry no client_msg_id. Retirement must be a no-op for them,
  // or a reconcile of an assistant row could delete a pending user row that happens to share a session.
  const SID4 = 'beacon:no-id'
  repo.addOptimisticMessage(SID4, 'user', 'mine', 'cmid-C')
  repo.reconcileSession(SID4, [{ rowId: 400, ordinal: 1, role: 'assistant', content: 'a reply' }], 400)
  const rows = repo.getMessages(SID4)
  assert(rows.length === 2, 'an assistant row with no client_msg_id retires nothing')
  assert(rows.some((r) => r.row_id === null && r.client_msg_id === 'cmid-C'), 'the pending user row is intact')
}
{
  // THE ORDERING THAT MAKES `row_id IS NULL` LOAD-BEARING. If the live echo DOES arrive, relinkByClientMsgId
  // re-keys the optimistic row to its rowid but KEEPS its client_msg_id. A reconcile that then pulls
  // the same row carries that id too — so without `row_id IS NULL` the DELETE would match the
  // already-confirmed row and destroy the message the user can see. (An earlier version of the fix
  // carried an `id != canonicalId` guard instead; mutation-testing showed THAT was unreachable, while
  // this condition is not. This case is what pins the difference.)
  const SID6 = 'beacon:echo-then-reconcile'
  const cmid = `cmid-E-${process.pid}`
  repo.addOptimisticMessage(SID6, 'user', 'echo arrives first', cmid)
  // Live echo re-keys it: row_id set, client_msg_id RETAINED.
  const relinked = repo.relinkByClientMsgId(SID6, cmid, 600, 0, 'user', 'echo arrives first', Date.now())
  assert(relinked === 'relinked', `precondition: the echo re-keyed the row (got ${relinked})`)
  const kept = repo.getMessages(SID6)
  assert(kept.length === 1 && kept[0].row_id === 600 && kept[0].client_msg_id === cmid,
    'precondition: the confirmed row still carries the client_msg_id (so it COULD be matched)')
  // Now reconcile pulls the same row with the same id.
  repo.reconcileSession(SID6, [{ rowId: 600, ordinal: 0, role: 'user', content: 'echo arrives first', clientMsgId: cmid }], 600)
  const after = repo.getMessages(SID6)
  assert(after.length === 1 && after[0].row_id === 600,
    `the CONFIRMED row survives an echo-then-reconcile (got ${after.length} rows) — row_id IS NULL is load-bearing`)
}
{
  // Idempotence: reconciling the SAME confirmed row twice must not delete the confirmed row itself.
  const SID5 = 'beacon:idempotent'
  const cmid = `cmid-D-${process.pid}`
  repo.addOptimisticMessage(SID5, 'user', 'once', cmid)
  repo.reconcileSession(SID5, [{ rowId: 500, ordinal: 0, role: 'user', content: 'once', clientMsgId: cmid }], 500)
  repo.reconcileSession(SID5, [{ rowId: 500, ordinal: 0, role: 'user', content: 'once', clientMsgId: cmid }], 500)
  const rows = repo.getMessages(SID5)
  assert(rows.length === 1 && rows[0].row_id === 500, 'a second reconcile of the same row keeps the confirmed row')
}

db.close()
console.log(`[smoke] retire-optimistic: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
if (failures > 0) process.exit(1)
