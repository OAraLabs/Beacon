// Headless smoke (ELECTRON_RUN_AS_NODE electron out/main/order-smoke.js).
// Proves orderForRender: confirmed rows sort by durable rowId; live rowid-less rows (a streaming
// assistant reply, an optimistic user echo, a live tool row) slot into their chronological position
// instead of sinking below every confirmed row — the bug where user messages stacked above replies.

import { finalizeRow, orderForRender } from '@shared/message-order'
import { forkPointBefore } from '@shared/session-fork'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

type Row = { key: string; rowId: number | null }
const row = (key: string, rowId: number | null): Row => ({ key, rowId })
const keys = (rows: Row[]): string =>
  orderForRender(rows)
    .map((r) => r.key)
    .join(',')

console.log('orderForRender (live interleaving):')
{
  // The bug: 3 user msgs confirmed (durable rowids), 3 assistant replies still streaming (rowId null,
  // inserted right after each user msg). Must render interleaved, NOT all-users-then-all-assistants.
  const rows = [
    row('u-doc', 1560),
    row('a-doc', null),
    row('u-pdf', 1562),
    row('a-pdf', null),
    row('u-why', 1564),
    row('a-why', null)
  ]
  check('streaming replies stay interleaved', keys(rows) === 'u-doc,a-doc,u-pdf,a-pdf,u-why,a-why')
}
{
  // Regression: a fully-confirmed (reloaded) list sorts strictly ascending by rowId, even shuffled.
  const rows = [row('c', 1565), row('a', 1560), row('b', 1562)]
  check('confirmed rows sort by rowId', keys(rows) === 'a,b,c')
}
{
  // A leading optimistic user row (null before any confirmed row) sorts first, not last.
  const rows = [row('opt', null), row('hist', 1560)]
  check('leading optimistic row sorts first', keys(rows) === 'opt,hist')
}
{
  // Consecutive rowid-less rows (live tool row + streaming assistant) keep insertion order.
  const rows = [row('u', 1560), row('tool', null), row('asst', null), row('u2', 1562)]
  check('consecutive null rows keep insertion order', keys(rows) === 'u,tool,asst,u2')
}
{
  // The OLD behavior sank all nulls to the bottom (u1,u2,a1,a2). Guard against regressing to it.
  const rows = [row('u1', 1560), row('a1', null), row('u2', 1562), row('a2', null)]
  check('not grouped (old-behavior regression guard)', keys(rows) !== 'u1,u2,a1,a2')
}


// ── P9.8 (Prometheus#129): finalizeRow re-keys a streamed row on chat_done ──────────────
// The done frame carries the assistant turn's durable rowid. Taking it closes the null-rowId
// window that otherwise lasts until reconcile; in that window an edit-into-branch computes its
// fork point THROUGH the fractional placeholder orderForRender assigns (lastRow+0.5), forking
// before the reply. These pin the rule; the integration check below pins the bug it closes.
console.log('\nfinalizeRow (re-key on chat_done):')
{
  // A present rowid re-keys to str(rowId) — the SAME key reconcile assigns, so they converge.
  const fin = finalizeRow(row('stream-m1', null), 1561)
  check('a present rowId re-keys the row', fin.rowId === 1561 && fin.key === '1561')
  check('and the key is str(rowId), matching reconcile', fin.key === String(1561))
}
{
  // An absent rowid (older daemon / persist surfaced none — the wire omits it) leaves the row
  // untouched: reconcile still fills it in. This is the refusal direction — an unconditional
  // re-key would corrupt the synthetic handle the live stream keys on.
  const fin = finalizeRow(row('stream-m1', null), undefined)
  check('an absent rowId leaves the row unchanged', fin.rowId === null && fin.key === 'stream-m1')
}
{
  check('a zero rowId is not a valid re-key', finalizeRow(row('s', null), 0).rowId === null)
  check('a negative rowId is not a valid re-key', finalizeRow(row('s', null), -5).rowId === null)
  check('a NaN rowId is not a valid re-key', finalizeRow(row('s', null), NaN).rowId === null)
}
{
  // THE BUG, end to end. Sequence: user msg (durable 1560) -> assistant reply (STREAMED, rowId
  // null until reconcile) -> user immediately types another msg and edits it into a branch.
  // forkPointBefore scans BACK from the new user row for the last DURABLE row, which must be the
  // assistant reply (1561) so the branch keeps it. While the reply is still rowId-null it is
  // SKIPPED, and the fork lands on 1560 — the branch drops the reply that just finished. That is
  // the "fork before last reply" the audit named; finalizeRow on chat_done is what closes it.
  const u = (key: string, rowId: number | null) => ({ key, role: 'user', rowId })
  const a = (key: string, rowId: number | null) => ({ key, role: 'assistant', rowId })
  const newUser = u('u2', null) // optimistic, just typed
  // Reply NOT yet finalized (the race window before this fix):
  const racing = [u('u1', 1560), a('a1', null), newUser]
  check('while the reply is rowId-null, the fork SKIPS it and lands on the older user row',
    forkPointBefore(racing, 'u2') === 1560)
  // Reply finalized by chat_done (what this fix does):
  const settled = [u('u1', 1560), finalizeRow(a('a1', null), 1561), newUser]
  check('once chat_done re-keys the reply, the fork bounds on the reply itself',
    forkPointBefore(settled, 'u2') === 1561)
  check('so the branch KEEPS the just-finished reply instead of dropping it',
    forkPointBefore(settled, 'u2') !== forkPointBefore(racing, 'u2'))
}

if (failures > 0) {
  console.error(`\n[order-smoke] FAILED — ${failures} check(s)`)
  process.exit(1)
}
console.log('\n[order-smoke] PASS')
process.exit(0)
