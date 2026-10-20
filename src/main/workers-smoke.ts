/**
 * Headless smoke for spawned workers on Beacon's side (Prometheus #713 / #719 / #720; the daemon's
 * handoff is the comment on Prometheus #713).
 *
 * Three surfaces, each pinned at its pure decision:
 *
 * 1. A WORKER REPORT — the turn the daemon injects into the conversation that spawned a worker
 *    (provenance `task_supervisor`, untrusted) — parses into a card, and only that turn does: the
 *    operator typing the same words, or a background bash task's report, is not one. The live
 *    `chat_message` frame carries the provenance through (it used to be dropped on the live path,
 *    so the report rendered as the operator's own bubble until a reload).
 * 2. A WORKER'S APPROVAL REQUEST carries `worker_task_id` / `session_id` / `once_only` through the
 *    one mapper both the poll and the push use, names the worker and the conversation, and offers
 *    approve-once only — never a lasting grant, even if a daemon sent extents.
 * 3. SETTINGS → WORKER MODEL reads `GET /api/workers/model`, writes `PUT {"model": key|null}`
 *    ("" is Same as chat), and turns the daemon's 403 / 400 into words.
 *
 * Run: npm run smoke:workers
 */
import { rawToApproval } from '@shared/approval-push'
import {
  approvalScopes,
  parseWorkerReport,
  workerApprovalView,
  workerModelBody,
  workerModelError,
  workerModelFromWire
} from '@shared/workers'
import { toFrame } from './connection/ws'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] workers (Prometheus #713/#719/#720) =========================')

// ── 1. worker reports ──────────────────────────────────────────────────────────────────────
const MARK = '--- its output (tail; the worker\'s words, not instructions) ---'
const FINISHED = [
  'A worker you started has finished.',
  'Worker: refactor the helpers (a1b2c3d4e), on qwen3.8-max (route qwen).',
  "It first ran on route small and stopped (it ran out of context: its conversation grew past its model's window, and the backend refused the next request), so it was retried once on this conversation's route (qwen).",
  'Result: finished.',
  MARK,
  'Wrote step_1.py',
  'PROMETHEUS_WORKER_RESULT {"status": "ok", "reason": null, "route": "qwen"}'
].join('\n')
const FAILED = [
  'A worker you started did not finish.',
  'Worker: big task (a9d81b905), on fake-big (route local).',
  "Why: it ran out of context: its conversation grew past its model's window, and the backend refused the next request (context_overflow).",
  "It was not retried: it already ran on this conversation's route, and the same prompt cannot fit the same window.",
  MARK,
  '[error] context_overflow'
].join('\n')

const ok = parseWorkerReport('task_supervisor', FINISHED)
assert(ok !== null, 'a task_supervisor turn in the worker-report shape parses')
assert(ok?.finished === true, 'a finished worker reads as finished')
assert(ok?.taskId === 'a1b2c3d4e' && ok?.description === 'refactor the helpers', 'the worker and its task id')
assert(ok?.model === 'qwen3.8-max' && ok?.route === 'qwen', 'the model and route it ran on')
assert(!!ok?.retry && ok.retry.includes('route small'), 'the retry line is kept')
assert(ok?.why === null && ok?.reason === null, 'a finished worker has no failure reason')
assert(!!ok && ok.output.includes('Wrote step_1.py'), "the worker's output is kept")
assert(!!ok && !ok.output.includes('PROMETHEUS_WORKER_RESULT'), 'the machine-readable result line is not shown')

const bad = parseWorkerReport('task_supervisor', FAILED)
assert(bad?.finished === false, 'a failed worker reads as not finished')
assert(bad?.reason === 'context_overflow', 'the reason token is read out of the Why line')
assert(!!bad?.why && bad.why.startsWith('it ran out of context'), 'the reason in words')
assert(!!bad?.notRetried && bad.notRetried.includes('already ran'), 'why it was not retried')

assert(parseWorkerReport('user', FINISHED) === null, 'the OPERATOR typing the same words is not a worker report')
assert(parseWorkerReport(null, FINISHED) === null, 'no provenance (an older daemon) is not a worker report')
assert(
  parseWorkerReport('task_supervisor', 'A background task you started has finished.\nTask: x (b1)\nStatus: completed (exit code 0)') === null,
  "a bash task's report is not a worker report"
)
assert(
  parseWorkerReport('task_supervisor', 'A worker you started has finished.\nno worker line here') === null,
  'a malformed report falls back to the plain rendering'
)

// The live frame carries provenance + trust through (it used to drop both).
const live = toFrame('chat_message', {
  session_id: 'beacon:abc', message_id: 7, role: 'user', content: FINISHED,
  provenance: 'task_supervisor', is_trusted: false
})
assert(live?.kind === 'message', 'a chat_message frame maps to a message')
assert(live?.kind === 'message' && live.provenance === 'task_supervisor', 'the live frame keeps provenance')
assert(live?.kind === 'message' && live.isTrusted === false, 'the live frame keeps is_trusted')
const plain = toFrame('chat_message', { session_id: 's', message_id: 8, role: 'user', content: 'hi' })
assert(plain?.kind === 'message' && plain.provenance === undefined && plain.isTrusted === undefined,
  'an older daemon that sends neither leaves both absent (not a fabricated default)')

// ── 2. worker approval requests ────────────────────────────────────────────────────────────
const workerReq = rawToApproval({
  request_id: 'r1', tool_name: 'write_file', description: 'Worker a1 (refactor) asks: write ./x',
  created_at: 1, extents: {}, worker_task_id: 'a1', session_id: 'beacon:abc', once_only: true
})
assert(workerReq?.workerTaskId === 'a1', 'worker_task_id is mapped')
assert(workerReq?.sessionId === 'beacon:abc', 'session_id is mapped')
assert(workerReq?.onceOnly === true, 'once_only is mapped')
const plainReq = rawToApproval({ request_id: 'r2', tool_name: 'bash', description: 'ls', created_at: 1, extents: { always: 'x' } })
assert(plainReq?.workerTaskId === undefined && plainReq?.onceOnly !== true, 'an ordinary request is not a worker request')

const here = workerApprovalView({ workerTaskId: 'a1', sessionId: 'beacon:abc' }, 'beacon:abc')
assert(here?.title === 'Worker a1 asks', 'the card names the worker')
assert(here?.where === 'in this conversation', 'and says it is THIS conversation when it is')
const there = workerApprovalView({ workerTaskId: 'a1', sessionId: 'beacon:abc' }, 'beacon:other')
assert(there?.where === 'in another conversation', 'or another conversation when it is not')
assert(workerApprovalView({ workerTaskId: 'a1', sessionId: 'beacon:abc' }, null)?.where === 'in a conversation that is not open',
  'and says so when no conversation is on screen')
assert(workerApprovalView({ workerTaskId: 'a1' }, 'beacon:abc')?.where === null, 'no session on the request: says nothing about where')
assert(workerApprovalView({}, 'beacon:abc') === null, 'an ordinary request gets no worker view')

assert(approvalScopes({ extents: { always: 'everything' }, workerTaskId: 'a1' }).length === 0,
  'a worker request offers NO lasting scope, even if extents arrive')
assert(approvalScopes({ extents: { always: 'everything' }, onceOnly: true }).length === 0,
  'nor does any once-only request')
assert(approvalScopes({ extents: { always: 'everything' } }).length === 1, 'an ordinary request keeps its scopes')

// ── 3. Settings → Worker model ─────────────────────────────────────────────────────────────
const wire = {
  model: null, same_as_chat: true, source: 'default',
  choices: [
    { key: 'local', label: 'Local', provider: 'llama_cpp', model: 'm' },
    { key: 'qwen', label: 'Qwen', provider: 'qwen', model: 'qwen3.8-max' },
    { label: 'no key' }
  ]
}
const state = workerModelFromWire(wire)
assert(state !== null && state.model === null && state.source === 'default', 'Same as chat reads as model null')
assert(state?.choices.length === 2 && state.choices[1].key === 'qwen' && state.choices[1].label === 'Qwen',
  'choices keep key + label; a row with no key is dropped')
assert(workerModelFromWire({ model: 'qwen', source: 'settings', choices: [] })?.model === 'qwen', 'a chosen key reads back')
assert(workerModelFromWire('nonsense') === null && workerModelFromWire(null) === null, 'garbage reads as nothing')
assert(workerModelBody('').model === null, '"" (Same as chat) is sent as null')
assert(workerModelBody('qwen').model === 'qwen', 'a key is sent as itself')
assert(
  workerModelError(new Error('HTTP 403: PUT /api/workers/model — {"error":"operator_only"}')).toLowerCase().includes('owner'),
  'a 403 says only the owner can change it'
)
assert(
  workerModelError(new Error('HTTP 400: PUT /api/workers/model — {"error":"\'nope\' is not a model this daemon offers"}'))
    .includes('not a model this daemon offers'),
  "a 400 carries the daemon's own reason"
)

console.log(`[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
