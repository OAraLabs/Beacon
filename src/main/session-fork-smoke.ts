/**
 * Headless smoke for edit/branch (B4, Beacon half). Pure model only.
 *
 * There is no branch in the data model, deliberately: LCM is linear and the daemon answers an
 * edit by COPYING history into a new session up to the point before the edited message. So the
 * client's whole job is picking the right fork point and being honest about what happens — and
 * the fork point is the part that is easy to get wrong in a way nothing would notice.
 *
 * Run: npm run smoke:session-fork
 */
import {
  canEditIntoBranch,
  editUnavailableReason,
  forkBanner,
  forkBody,
  forkPointBefore,
  parseForkOrigin,
  parseForkResult,
  type ForkableRow
} from '@shared/session-fork'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// Rows as ChatShell holds them: durable rows carry a rowid, an in-flight one does not.
const ROWS: ForkableRow[] = [
  { key: '100', role: 'user', rowId: 100 },
  { key: '101', role: 'assistant', rowId: 101 },
  { key: '102', role: 'user', rowId: 102 },
  { key: '103', role: 'assistant', rowId: 103 }
]

console.log('[smoke] === 1. the fork point is the row BEFORE the edited one ===')
assert(forkPointBefore(ROWS, '102') === 101, `editing the 2nd user turn forks at 101 (got ${forkPointBefore(ROWS, '102')})`)
// The edited message must NOT be copied — the branch is the conversation as it stood before it.
assert(forkPointBefore(ROWS, '102') !== 102, 'never forks AT the edited message — that would copy the text being replaced')
assert(forkPointBefore(ROWS, '103') === 102, 'the point is positional, not role-based')

console.log('[smoke] === 2. the first message cannot branch ===')
// A fork of nothing is not a fork; the daemon 404s. The control must know that in advance.
assert(forkPointBefore(ROWS, '100') === null, 'nothing precedes the first message')
assert(canEditIntoBranch(ROWS, '100') === false, 'so it is not editable into a branch')
assert(
  (editUnavailableReason(ROWS, '100') || '').includes('first message'),
  `and the tooltip says why (${editUnavailableReason(ROWS, '100')})`
)

console.log('[smoke] === 3. only your own messages ===')
assert(canEditIntoBranch(ROWS, '102') === true, 'a user message with history before it is editable')
assert(canEditIntoBranch(ROWS, '103') === false, 'an ASSISTANT message is not')
assert(
  (editUnavailableReason(ROWS, '103') || '').includes('your own'),
  'editing what the agent said would fabricate history the daemon copies verbatim'
)
assert(editUnavailableReason(ROWS, '102') === null, 'an available control has no reason text')
// A machine turn with the USER role (a task's report, a supervisor's inject) is not yours either:
// a branch from an edit of it would put its text in the operator's mouth.
const WITH_MACHINE: ForkableRow[] = [
  ...ROWS,
  { key: '104', role: 'user', rowId: 104, provenance: 'task_supervisor' },
  { key: '105', role: 'user', rowId: 105, provenance: 'user' }
]
assert(canEditIntoBranch(WITH_MACHINE, '104') === false, 'a machine turn that arrived with the user role is not editable')
assert(
  (editUnavailableReason(WITH_MACHINE, '104') || '').includes('your own'),
  `and the tooltip says why (${editUnavailableReason(WITH_MACHINE, '104')})`
)
assert(canEditIntoBranch(WITH_MACHINE, '105') === true, 'an explicit user provenance still is')
assert(editUnavailableReason(ROWS, 'nope') !== null, 'an unknown key is explained, not silently disabled')

console.log('[smoke] === 4. optimistic rows are skipped ===')
// A row still in flight has no rowid on the daemon; it cannot bound a copy.
const WITH_PENDING: ForkableRow[] = [
  { key: '200', role: 'user', rowId: 200 },
  { key: 'local-x', role: 'assistant', rowId: null },
  { key: 'local-y', role: 'user', rowId: null }
]
assert(forkPointBefore(WITH_PENDING, 'local-y') === 200, 'skips past an unpersisted row to the last durable one')
assert(canEditIntoBranch(WITH_PENDING, 'local-y') === true, 'and the edit is still offered')
assert(forkPointBefore([{ key: 'a', role: 'user', rowId: null }], 'a') === null, 'nothing durable at all → no fork point')
assert(forkPointBefore(ROWS, 'missing') === null, 'an unknown key yields no point rather than a wrong one')

console.log('[smoke] === 5. the wire ===')
assert(forkBody(101).at_rowid === 101, 'the body carries the fork point')
const res = parseForkResult({ session_id: 'beacon:new', origin_session: 'beacon:old', origin_rowid: 101, copied: 2 })
assert(res?.sessionId === 'beacon:new' && res?.copied === 2, 'the result parses')
assert(parseForkResult({ origin_session: 'x' }) === null, 'a result with NO session id is null — there is nowhere to go')
assert(parseForkResult(null) === null && parseForkResult('no' as unknown) === null, 'junk degrades')

console.log('[smoke] === 6. provenance ===')
const origin = parseForkOrigin({ origin: { origin_session: 'beacon:old', origin_rowid: 101, created_at: 5 } })
assert(origin?.originSession === 'beacon:old', 'the origin parses')
assert(parseForkOrigin({ origin: null }) === null, 'an unforked session has no origin')
assert(parseForkOrigin({}) === null && parseForkOrigin(null) === null, 'junk degrades to no banner')
assert(forkBanner(origin!, 'Voice spec').includes('Voice spec'), 'the banner prefers a human title')
assert(forkBanner(origin!, '   ').includes('beacon:old'), 'and falls back to the id when the title is blank')
assert(forkBanner(origin!, undefined).includes('beacon:old'), 'or absent')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (fork point, first message, role, optimistic rows, wire, provenance)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
