/**
 * approval-push-smoke — the pure core of approvals-over-WS (feat/approval-push-ws).
 *
 * PINS THE CONTRACT of shared/approval-push.ts:
 *   1. rawToApproval is ONE mapper for both transports (WS frame + REST poll
 *      serve the daemon's same serialize_pending dict) — malformed fields
 *      degrade honestly, never fabricate.
 *
 *      THIS IS NOW TRUE BY WIRING, not by assertion. When this line was first
 *      written, connection/rest.ts mapped the same dict inline with DIFFERENT
 *      rules (no tool_name fallback, no description fallback, and a missing
 *      request_id became a row with `requestId: undefined` instead of a drop).
 *      The claim was false for as long as it stood. What makes it true is that
 *      listApprovals() calls rawToApproval — approval-smoke section 1e pins
 *      that the poll path really does inherit these rules, so a future inline
 *      mapper there turns this comment red instead of quietly rotting.
 *   2. applyApprovalFrame: pending UPSERTS by requestId (frame + poll race →
 *      no duplicates), resolved REMOVES for every resolution.
 *   3. decisionGradeBody: full description up to budget, word-boundary cut —
 *      the notification button has NO confirmation step, so the target must
 *      be visible in the body.
 *   4. `arguments` — the thing being approved — rides the PUSH frame, not the
 *      poll alone. This is the transport that lands FIRST, so it is the card
 *      the operator sees and may answer; arguments carried only on the REST
 *      mapper would appear up to a poll interval late, and `A` is one key.
 *
 * THE POLL IS NOT REDUNDANT — a WS-only client that missed a frame would show
 * a ghost approval forever. This smoke pins push behavior; the poll stays by
 * design (see shared/approval-push.ts header).
 *
 * Run: npm run smoke:approval-push
 */
import {
  applyApprovalFrame,
  BODY_BUDGET,
  decisionGradeBody,
  notificationPlan,
  rawToApproval,
  type RawApprovalPush
} from '@shared/approval-push'
import { readFileSync } from 'node:fs'
import type { ApprovalRequest } from '@shared/ipc'

/**
 * MIN_CHECKS — the count guard.
 *
 * This harness counts FAILURES. A section that never runs therefore reports zero failures and the
 * file exits 0: a smoke that silently stopped testing is indistinguishable from one that passed.
 * An early return, a throw swallowed upstream, a fixture that stops matching so a loop iterates
 * zero times — each of those turns this file green while proving nothing.
 *
 * So the count is pinned as well as the failures. Raise it when you add assertions; a DROP means
 * assertions stopped running and is exactly the event this guard exists to make loud.
 */
const MIN_CHECKS = 53

let failures = 0
let checks = 0
function check(cond: boolean, label: string): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const RAW: RawApprovalPush = {
  request_id: 'abc123',
  tool_name: 'bash',
  description: 'git push origin main',
  created_at: 1786921774.256,
  expires_at: 1786923574.256,
  extents: { 'until-restart': 'this path, until the daemon restarts' }
}

console.log('\n=== 1. rawToApproval — snake→camel, honest degradation ===')
const a = rawToApproval(RAW)
check(a !== null, 'valid raw parses')
check(a!.requestId === 'abc123', 'requestId mapped')
check(a!.toolName === 'bash', 'toolName mapped')
check(a!.createdAt === 1786921774256, 'created_at epoch s → ms')
check(a!.expiresAt === 1786923574256, 'expires_at epoch s → ms')
check(Object.keys(a!.extents).length === 1, 'extents passed through')

check(rawToApproval({ ...RAW, request_id: '' }) === null, 'empty request_id → null (no ghost row)')
check(rawToApproval({ ...RAW, request_id: 42 }) === null, 'non-string request_id → null')
const malformed = rawToApproval({ ...RAW, extents: ['not', 'a', 'dict'] })
check(
  malformed !== null && Object.keys(malformed.extents).length === 0,
  'malformed extents → {} (the honest "no grant on offer" case, never fabricated)'
)
const noExpiry = rawToApproval({ ...RAW, expires_at: undefined })
check(
  noExpiry !== null && noExpiry.expiresAt === undefined,
  'absent expires_at stays undefined (a 0 would render a false "expired")'
)

console.log('\n=== 1b. arguments ride the PUSH frame, not the poll alone ===')
// Captured from Prometheus bf4e1fe's own `redact_arguments` on 2026-09-19 — the same
// serialize_pending dict the REST list serves, which is exactly why it must arrive here
// too. Push lands FIRST; an operator can answer the pushed card before any poll replaces
// it, so arguments that only the REST mapper carried would be seconds late on the one
// surface where lateness decides whether a keystroke was read before it was approved.
const TYPED: RawApprovalPush = {
  request_id: 'cu-1',
  tool_name: 'computer_type_text',
  description: 'computer_type_text acts on the desktop: Prometheus may type text in firefox',
  created_at: 1789000000,
  extents: {},
  arguments: { app: 'firefox', delivery: 'background', text: 'transfer 500 to account 9' }
}
const typed = rawToApproval(TYPED)
check(typed !== null, 'a computer-use frame parses')
check(typed!.arguments?.text === 'transfer 500 to account 9', 'the PAYLOAD reaches the card over WS, intact')
check(
  Object.keys(typed!.arguments ?? {}).join(',') === 'app,delivery,text',
  `the daemon's key order survives the push mapper (got ${Object.keys(typed!.arguments ?? {}).join(',')})`
)
check(Object.keys(typed!.extents).length === 0, 'extents {} rides through — the permanent no-grant case')

// THE DRIFT THIS CATCHES: the two mappers are separate functions reading one daemon dict.
// A field added to rest.ts and forgotten here is invisible until someone approves a blank
// card. Compare the two transports on the SAME payload rather than trusting the docstring
// that says there is one mapper.
const viaFrame = applyApprovalFrame([], { type: 'approval_pending', payload: TYPED as unknown as Record<string, unknown> })
check(
  JSON.stringify(viaFrame[0]?.arguments) === JSON.stringify(TYPED.arguments),
  'the frame path and the raw mapper agree — no arguments lost between them'
)

check(rawToApproval({ ...TYPED, arguments: null })!.arguments === undefined, 'null arguments → undefined (no empty block)')
check(rawToApproval({ ...TYPED, arguments: ['a'] })!.arguments === undefined, 'array-shaped arguments → undefined')
const noArgs = { ...TYPED }
delete noArgs.arguments
check(rawToApproval(noArgs)!.arguments === undefined, 'an older daemon that sends no arguments → undefined, not a crash')

console.log('\n=== 2. applyApprovalFrame — upsert + remove ===')
const pending = (raw: RawApprovalPush) => ({ type: 'approval_pending' as const, payload: raw as Record<string, unknown> })
const resolved = (rid: string, resolution: string) => ({
  type: 'approval_resolved' as const,
  payload: { request_id: rid, resolution } as Record<string, unknown>
})

let list: ApprovalRequest[] = []
list = applyApprovalFrame(list, pending(RAW))
check(list.length === 1, 'pending inserts')
// THE RACE: the poll and its frame both arrive → exactly one row.
list = applyApprovalFrame(list, pending(RAW))
check(list.length === 1, 'duplicate pending UPSERTS — frame+poll race produces one row')
const other = { ...RAW, request_id: 'def456', description: 'curl example.com' }
list = applyApprovalFrame(list, pending(other))
check(list.length === 2, 'a second distinct request coexists')

list = applyApprovalFrame(list, resolved('abc123', 'approved'))
check(list.length === 1 && list[0].requestId === 'def456', 'resolved(approved) removes its row')
list = applyApprovalFrame(list, resolved('def456', 'denied'))
check(list.length === 0, 'resolved(denied) removes too')
list = applyApprovalFrame(list, resolved('ghost999', 'expired'))
check(list.length === 0, 'resolved for an unknown id is a no-op (stale notification is clean)')
const badFrame = applyApprovalFrame(list, { type: 'approval_pending', payload: { tool_name: 'x' } })
check(badFrame.length === 0, 'pending without request_id inserts nothing')

console.log('\n=== 3. decisionGradeBody — the target must be visible ===')
const short = decisionGradeBody('bash', 'git push origin main')
check(short === 'bash: git push origin main', 'under budget: full description, verbatim')
const longDesc = `rm -r ${'x'.repeat(300)}`
const long = decisionGradeBody('bash', longDesc)
check(long.length <= BODY_BUDGET + 1, `over budget: within budget+ellipsis (${long.length})`)
check(/…\s\(\+\d+ more chars\)$/.test(long), `over budget: the cut STATES how much it hid (${long.slice(-24)})`)
// A marker that lies is worse than no marker — a silent cut wearing a receipt. Recompute
// the arithmetic from the strings rather than trusting the number it prints.
const hiddenN = Number(/\(\+(\d+) more chars\)$/.exec(long)?.[1])
const shownN = long.replace(/…\s\(\+\d+ more chars\)$/, '').length
check(
  shownN + hiddenN === `bash: ${longDesc}`.length,
  `the stated count is TRUE: ${shownN} shown + ${hiddenN} hidden === ${`bash: ${longDesc}`.length} full`
)
check(long.length <= BODY_BUDGET, `the marker is reserved OUT of the budget, not appended past it (${long.length} <= ${BODY_BUDGET})`)
check(long.includes('rm -r'), 'over budget: the COMMAND — the decision target — survives the cut')
check(!long.includes(' x…'), 'the cut lands on a word boundary, not mid-token')

console.log('\n=== 4. notificationPlan — no argument in the body means no button ===')
// THE REGRESSION, in the captured bytes. The darwin notification renders an "Approve"
// button that resolves the request on the spot, with no confirmation step. Its body came
// from decisionGradeBody(toolName, description) — which never saw `arguments` — so for the
// request below it truncated at exactly the clause that mattered and never reached the text
// that would be typed. One tap approved a keystroke nobody had read.
const CAPTURED_DESC =
  'computer_type_text acts on the desktop: Prometheus may type text in firefox, in the background ' +
  "(without raising the window) — no lasting grant is offered: the value of text cannot be part of a " +
  "remembered grant, so remembering this would mean 'type text in firefox' — approve it once instead, each time"
const CAPTURED_ARGS = { app: 'firefox', delivery: 'background', text: 'transfer 500 to account 9' }

const oldBody = decisionGradeBody('computer_type_text', CAPTURED_DESC)
check(
  !oldBody.includes('transfer 500 to account 9'),
  'PREMISE: the description alone cannot carry the payload — pinned so the defect cannot be called theoretical'
)
const typedPlan = notificationPlan('computer_type_text', CAPTURED_DESC, CAPTURED_ARGS)
check(typedPlan.offersActions === false, 'a request carrying arguments offers NO action buttons')
check(
  !typedPlan.body.includes('transfer 500 to account 9'),
  'and the body does not pretend to show the payload either — a partial value beside a live button reads as complete'
)
check(typedPlan.body.includes('3 arguments not shown'), 'the omission is STATED, with its count — the operator is told what is missing')
check(typedPlan.body.includes('approve in Beacon'), 'and told where the decision can actually be made')
check(typedPlan.body.length <= BODY_BUDGET, `the note is reserved out of the budget (${typedPlan.body.length} <= ${BODY_BUDGET})`)
check(
  typedPlan.body.trimEnd().endsWith('approve in Beacon'),
  'the note is the LAST thing in the body — an overrun would cost exactly the sentence explaining why there is nothing to tap'
)

// THE INVARIANT, as a property rather than an example: whenever an argument value is
// absent from the body, the buttons must be absent too. Stated this way, a future body
// that "helpfully" fits one argument in cannot quietly re-arm the button.
for (const [label, args] of [
  ['the captured type_text', CAPTURED_ARGS],
  ['a single argument', { text: 'rm -rf /' }],
  ['a masked one', { api_key: '***', text: 'hunter2' }],
  ['an overflow row', { field_00: 'v', '…': '(13 more argument(s) not shown)' }]
] as [string, Record<string, string>][]) {
  const plan = notificationPlan('t', 'short reason', args)
  const everyValueShown = Object.values(args).every((v) => plan.body.includes(v))
  check(
    everyValueShown || !plan.offersActions,
    `${label}: a body missing an argument NEVER accompanies a live button`
  )
}

check(notificationPlan('t', 'r', { text: 'x' }).body.includes('1 argument not shown'), 'one argument reads "1 argument", not "1 arguments"')

// THE OTHER HALF. Disarming every notification would satisfy everything above while
// deleting the feature, so pin that the ordinary case keeps its buttons.
const plainPlan = notificationPlan('bash', 'git push origin main')
check(plainPlan.offersActions === true, 'a request with NO arguments still offers its buttons — the fallback is targeted, not blanket')
check(plainPlan.body === 'bash: git push origin main', 'and its body is unchanged, verbatim')
check(notificationPlan('bash', 'git push', {}).offersActions === true, 'an empty argument map is the nothing-to-show case, not a payload')

console.log('\n=== 5. main actually WIRES it — the pure plan is worthless unwired ===')
// Everything above proves notificationPlan decides correctly. None of it proves main ASKS.
// A plan computed and ignored is the fix-with-no-surface failure: green tests over a
// notification still carrying a live button. main is Electron-only and cannot be imported
// headless, so read its source — the same approach approval-disclosure-smoke takes.
const mainSrc = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
check(mainSrc.length > 1000, `main's source was located (${mainSrc.length} chars) — a failed read would pass every check below vacuously`)
check(
  /process\.platform === 'darwin' && plan\.offersActions/.test(mainSrc),
  'the darwin action buttons are GATED on plan.offersActions, not on the platform alone'
)
check(!/body: decisionGradeBody\(/.test(mainSrc), 'main no longer builds the body from the arguments-blind helper')
check(/body: plan\.body/.test(mainSrc), 'main takes the body from the SAME call that decided the buttons — one source, no drift')

// Every call site must hand over the arguments. Count first: an expression that matched
// nothing would make the `every` below true for want of anything to be false about.
const callSites: string[] = []
for (const m of mainSrc.matchAll(/notifyApproval\(/g)) {
  if (mainSrc.slice(Math.max(0, m.index - 9), m.index).includes('function')) continue
  let depth = 0
  let i = m.index + 'notifyApproval'.length
  const start = i
  for (; i < mainSrc.length; i++) {
    if (mainSrc[i] === '(') depth++
    else if (mainSrc[i] === ')') { depth--; if (depth === 0) break }
  }
  callSites.push(mainSrc.slice(start, i + 1))
}
check(callSites.length === 2, `both notifyApproval call sites were found — the WS frame path and the poll path (got ${callSites.length})`)
check(
  callSites.length > 0 && callSites.every((c) => c.includes('.arguments')),
  `every call site passes the arguments (${callSites.filter((c) => !c.includes('.arguments')).length} do not)`
)

// The verdict runs on process EXIT for the same reason approval-smoke's does: a run that leaves
// early must not be able to leave quietly. See the note there — a mutation proved a mid-file bail
// exited 0 with a third of the assertions unrun.
let reported = false
process.on('exit', () => {
  if (reported) return
  reported = true
  console.log('\n=== result ===')
  if (checks < MIN_CHECKS) {
    console.error(`only ${checks} of ${MIN_CHECKS} expected assertions RAN — a section stopped executing`)
    process.exitCode = 1
    return
  }
  console.log(`assertions run: ${checks} (floor ${MIN_CHECKS})`)
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('all assertions passed')
})
