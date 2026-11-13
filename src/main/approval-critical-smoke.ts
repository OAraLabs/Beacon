/**
 * approval-critical-smoke — the two pure rules in @shared/approval-critical, headless, and that
 * main uses them.
 *
 *   1. what a Prometheus advertises, run through the sequences a connection really goes through;
 *   2. who may approve: main refuses an approve for a critical request unless it came from the
 *      full card's own button;
 *   3. the book main keeps of what each request said;
 *   4. the wiring: the connection feeds the first rule and keeps its one timer; every approve in
 *      main goes through the second.
 *
 * Run: npm run build && npm run smoke:approval-critical
 */
import { readFileSync } from 'node:fs'
import {
  APPROVAL_CRITICAL_WAIT_MS,
  CAP_INITIAL,
  CARD_ONLY_REFUSAL,
  CRITICAL_BOOK_MAX,
  APPROVAL_SETTLE_MS,
  approveRefusal,
  approveTooSoon,
  capStep,
  refusalWords,
  isApprovalAnswerPath,
  noteCritical,
  type CapEvent,
  type CapState
} from '@shared/approval-critical'
import type { ApprovalDecision } from '@shared/ipc'

const MIN_CHECKS = 132
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`approval-critical smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`approval-critical smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`approval-critical smoke: PASS ✓ (${checks} checks: what a Prometheus advertises, who may approve, the book, wiring)`)
})

const run = (events: CapEvent[], from: CapState = CAP_INITIAL): CapState => events.reduce(capStep, from)
const YES: CapEvent = { said: true }
const NO: CapEvent = { said: false }

console.log('1. what a Prometheus advertises')
check(CAP_INITIAL.value === null && !CAP_INITIAL.waiting && APPROVAL_CRITICAL_WAIT_MS === 5000, 'it starts unknown, with nothing being timed')
check(run(['attempt', 'connected', YES]).value === true && run(['attempt', 'connected', NO]).value === false, 'a reply is believed: yes or no')
check(run(['attempt', YES, 'connected']).value === true && !run(['attempt', YES, 'connected']).waiting, 'a reply that lands just before "connected" is kept, and no silence is timed after it')
// An old Prometheus that never replies.
check(run(['attempt', 'connected']).waiting === true && run(['attempt', 'connected']).value === null, 'connected and never said: its silence is timed, and it is still unknown meanwhile')
check(run(['attempt', 'connected', 'expired']).value === false, 'five seconds of connected silence from one that never said is taken for "no"')
// The first version's blocker: the wait ran while nothing was connected.
check(run(['attempt']).waiting === false && run(['attempt', 'expired']).value === null, 'nothing is timed before a socket is up: an attempt that has not connected is never turned into "no"')
check(run(['attempt', 'connected', 'left']).waiting === false && run(['attempt', 'connected', 'left', 'expired']).value === null, 'leaving connected ends the timing: a drop before the reply is not silence')
check(run(['attempt', 'connected', 'dial', 'expired']).value === null && run(['attempt', 'connected', 'attempt', 'expired']).value === null, 'so does a new dial, and a new attempt (a manual reconnect in the moment between connected and the reply)')
check(run(['attempt', 'connected', 'stop', 'expired']).value === null && !run(['attempt', 'connected', 'stop']).waiting, 'and stopping the connection')
// Silence never replaces an answer.
const yes = run(['attempt', 'connected', YES])
check(run(['left', 'dial', 'connected'], yes).value === true && !run(['left', 'dial', 'connected'], yes).waiting, 'a Prometheus that said yes and reconnects without replying is not timed at all')
check(run(['left', 'dial', 'connected', 'expired'], yes).value === true && run(['attempt', 'expired'], yes).value === true, 'and a stray timer cannot turn its yes into a no')
check(run(['left', 'attempt', 'left', 'dial', 'left', 'dial', 'connected', 'left', 'expired'], yes).value === true, 'through a wake, failed dials and backoff, a yes stays a yes')
check(run(['left', 'dial', 'connected', NO], yes).value === false, 'a yes is withdrawn by a reply that does not list the capability (a Prometheus rolled back)')
const no = run(['attempt', 'connected', 'expired'])
check(run(['left', 'dial', 'connected'], no).waiting === false && run(['left', 'dial', 'connected', 'expired'], no).value === false, 'a settled "no" is not timed again either')
check(run(['left', 'dial', 'connected', YES], no).value === true, 'and is replaced the moment a reply says yes (a Prometheus upgraded)')
// A slow reply after the wait.
check(run(['attempt', 'connected', 'expired', YES]).value === true, 'a reply that comes after the wait still corrects it')
// Repeats and stale events.
check(run(['attempt', 'connected', 'connected']).waiting === true && run(['attempt', 'connected', 'connected', 'expired']).value === false, '"connected" twice is one wait')
check(run(['expired']).value === null && run(['left']).value === null && run(['stop', 'expired']).value === null, 'an expiry with nothing being timed changes nothing')
check(run(['attempt', 'connected', YES, 'expired']).value === true && run(['attempt', 'connected', NO, 'expired']).value === false, 'an expiry after a reply changes nothing')
{
  // Exhaustive, to depth 6: from any reachable state, "no" is reached only by a reply that says no,
  // or by an expiry that directly follows a stretch of being connected, never said, with no
  // attempt, dial, drop or stop in between.
  const all: CapEvent[] = ['attempt', 'dial', 'connected', 'left', 'stop', 'expired', YES, NO]
  let bad = ''
  let walked = 0
  const name = (t: CapEvent[]): string => t.map((x) => (typeof x === 'string' ? x : `said:${x.said}`)).join(' > ')
  const walk = (s: CapState, trail: CapEvent[]): void => {
    if (trail.length === 6) return
    for (const e of all) {
      const n = capStep(s, e)
      walked++
      const t = [...trail, e]
      if (bad) return
      // "no" only from a reply that says no, or from an expiry while silence was being timed.
      if (n.value === false && s.value !== false && !(e === NO || (e === 'expired' && s.waiting))) bad = `became no: ${name(t)}`
      // "yes" only from a reply that says yes; a yes is lost only to a reply that says no.
      if (n.value === true && s.value !== true && e !== YES) bad = `became yes without a reply: ${name(t)}`
      if (s.value === true && n.value !== true && e !== NO) bad = `lost a yes without a reply: ${name(t)}`
      // Silence is timed only for one that has never said, starts only at 'connected', and every
      // other thing that happens to the connection ends it.
      if (n.waiting && (n.value !== null || n.said)) bad = `timing one that has said: ${name(t)}`
      if (n.waiting && !s.waiting && e !== 'connected') bad = `timing started without connected: ${name(t)}`
      if (n.waiting && e !== 'connected') bad = `timing survived ${typeof e === 'string' ? e : 'a reply'}: ${name(t)}`
      walk(n, t)
    }
  }
  walk(CAP_INITIAL, [])
  check(bad === '' && walked > 200000, `every sequence of six events (${walked} steps): "no" comes only from a reply or from an expiry while connected silence was being timed; "yes" comes and goes only by a reply; anything but "connected" ends the timing`, bad)
}

console.log('2. who may approve')
const approve: ApprovalDecision = { kind: 'approve', scope: 'once' }
const always: ApprovalDecision = { kind: 'approve', scope: 'always' } as ApprovalDecision
const deny: ApprovalDecision = { kind: 'deny' }
for (const from of ['key', 'row', 'notification', undefined, null, '', 'CARD', 'card ', 0, {}, ['card']] as unknown[]) {
  check(approveRefusal(approve, from, true, true) === CARD_ONLY_REFUSAL, `an approve of a critical request from ${JSON.stringify(from) ?? 'nothing'} is refused`)
}
check(approveRefusal(approve, 'card', true, true) === null && approveRefusal(always, 'card', true, undefined) === null, "from the card's own button it goes ahead")
check(approveRefusal(always, 'row', true, false) === CARD_ONLY_REFUSAL && approveRefusal(approve, 'key', true, undefined) === CARD_ONLY_REFUSAL, 'critical: true is refused elsewhere whatever the Prometheus advertises, for any scope')
check(approveRefusal(approve, 'row', undefined, true) === CARD_ONLY_REFUSAL && approveRefusal(approve, 'key', undefined, undefined) === CARD_ONLY_REFUSAL, 'a request that did not say (or that main never saw) is refused elsewhere when its Prometheus advertises the flag, and while that is not known')
check(approveRefusal(approve, 'row', undefined, false) === null && approveRefusal(approve, 'key', undefined, false) === null && approveRefusal(approve, 'notification', undefined, false) === null, 'with an older Prometheus (it advertises nothing) the short answers work as they always did')
check(approveRefusal(approve, 'row', false, true) === null && approveRefusal(approve, 'key', false, undefined) === null, 'a request that says it is not critical is approved from anywhere')
for (const from of ['key', 'row', 'notification', 'card', undefined] as unknown[]) {
  check(approveRefusal(deny, from, true, true) === null, `deny is never refused (from ${String(from)})`)
}
check(approveRefusal(null, 'row', true, true) === null && approveRefusal(undefined, 'row', true, true) === null, 'no decision is not an approve (the daemon call rejects it as before)')
check(/only on its card/.test(CARD_ONLY_REFUSAL) && /Nothing was approved/.test(CARD_ONLY_REFUSAL), 'the refusal says where to approve it, and that nothing happened')

console.log('3. the book')
{
  const book = new Map<string, boolean | undefined>()
  noteCritical(book, 'a', true)
  noteCritical(book, 'b', undefined)
  noteCritical(book, 'c', false)
  check(book.get('a') === true && book.has('b') && book.get('b') === undefined && book.get('c') === false, 'what each request said is kept, "did not say" included')
  noteCritical(book, 'a', false)
  check(book.get('a') === false && [...book.keys()].join() === 'b,c,a', 'a request noted again takes what it says now, and counts as the newest')
  for (let i = 0; i < CRITICAL_BOOK_MAX + 50; i++) noteCritical(book, `r${i}`, true)
  check(book.size === CRITICAL_BOOK_MAX && !book.has('b') && !book.has('a') && book.has(`r${CRITICAL_BOOK_MAX + 49}`), 'the book is bounded: the oldest are forgotten')
  check(approveRefusal(approve, 'row', book.get('a'), true) === CARD_ONLY_REFUSAL, 'and a forgotten request is judged like one that did not say')
  // A later note that does not say never weakens one that did.
  const b2 = new Map<string, boolean | undefined>()
  noteCritical(b2, 'x', true)
  noteCritical(b2, 'x', undefined)
  check(b2.get('x') === true && approveRefusal(approve, 'row', b2.get('x'), false) === CARD_ONLY_REFUSAL, 'a request that said critical, then turns up again without the flag (a frame, then a poll row), is still critical: even an older-looking Prometheus cannot approve it from a row')
  noteCritical(b2, 'y', false)
  noteCritical(b2, 'y', undefined)
  check(b2.get('y') === false, 'likewise one that said it is not')
  noteCritical(b2, 'x', false)
  noteCritical(b2, 'y', true)
  check(b2.get('x') === false && b2.get('y') === true, 'an explicit answer does replace the earlier one: the daemon decides')
}

console.log('3b. the general daemon write is not a second way to answer')
{
  const TAB = String.fromCharCode(9)
  const NL = String.fromCharCode(10)
  const refused = [
    '/api/approvals/abc/approve', '/api/approvals/abc/deny', '/api/approvals/abc/approve/', '/api/approvals/abc/approve?x=1', '/api/approvals/abc/approve#y',
    '/api//approvals//abc//approve', '/api/approvals/abc/%61pprove', '/api/approvals/abc/%2561pprove', '/api/%61pprovals/abc/approve', '/API/Approvals/abc/APPROVE',
    '/api/approvals/a%2Fb/approve', '/api/approvals/abc/x/approve', '/api/approvals/approve/approve', '/api/approvals/abc\\approve',
    // What a review found: each of these is normalised by the URL parser to /api/approvals/X/approve.
    '/api/approvals/grants/%2e%2e/X/approve', '/api/approvals/grants/.%2e/X/approve', '/api/approvals/grants/%2E%2E/X/deny', '/api/approvals/grants/../X/approve',
    `/api/approvals/X/appr${TAB}ove`, `/api/approvals/X/approve${NL}`, `/api/appro${TAB}vals/X/approve`, `/api/appro${NL}vals/X/approve`,
    '/api/x%3F/%2e%2e/approvals/X/approve', '/api/x%23/%2e%2e/approvals/X/approve', '/api/x/..%2Fapprovals/X/approve', '/api/%2561pprovals/X/approve', '/api/%252561pprovals/X/approve',
    '/api/approvals/%E0%A4%A/approve', '/api/a%70provals%ZZ/X/approve',
    // And everything else under approvals that is not the grants list or one grant.
    '/api/approvals', '/api/approvals/', '/api/approvals/abc', '/api/approvals/abc/payload', '/api/approvals/grants/', '/api/approvals/grants/a/b', '/api/approvals/grants/g1/deny', '/api/approvals/grants/approve/x',
    '/api/approvals/grants/%2e%2e', '/api/approvals/grants/..', '/api/approvals/grants/.', '/api/approvals/grants/g 1', '/api/approvals/grants?x=1', '/api/approvals/grantsX'
  ]
  for (const p of refused) check(isApprovalAnswerPath(p), `${JSON.stringify(p)} is refused`)
  // The parser agrees these would have reached an answer route, which is why they must be refused.
  const lands = (p: string): string => new URL(`http://daemon.invalid${p}`).pathname
  check(['/api/approvals/grants/%2e%2e/X/approve', `/api/approvals/X/appr${TAB}ove`, `/api/approvals/X/approve${NL}`, '/api/x%3F/%2e%2e/approvals/X/approve'].every((p) => lands(p) === '/api/approvals/X/approve'), 'the first four of those really are /api/approvals/X/approve once the URL is parsed (the control for this list)')
  const allowed = ['/api/approvals/grants', '/api/approvals/grants/g1', '/api/approvals/grants/3f2a-91bc_x:y~z', '/api/approvals/grants/approve', '/api/approvals/grants/deny']
  for (const p of allowed) check(!isApprovalAnswerPath(p) && lands(p) === p, `${p} is allowed, and is sent exactly as written`)
  const others = ['/api/sessions/approve', '/api/sessions/s1/workspace', '/api/mcp/servers', '/api/devices/d1/approve', '/api/approve', '/api/cron', '', '/']
  for (const p of others) check(!isApprovalAnswerPath(p), `${p || '(empty)'} has nothing to do with approvals`)
  check(!isApprovalAnswerPath(undefined) && !isApprovalAnswerPath(null) && !isApprovalAnswerPath(42), 'something that is not a path is not one')
  // Every string the allowlist admits is sent unchanged by the parser: nothing it lets through can turn into something else.
  const alphabet = ['a', 'Z', '0', '_', '.', '~', ':', '-', '..', '%2e', '/', '?', '#', TAB, ' ', '%2F', '\\']
  let wrong = ''
  let tried = 0
  const grow = (id: string, depth: number): void => {
    const p = `/api/approvals/grants/${id}`
    tried++
    if (!isApprovalAnswerPath(p) && lands(p) !== p && !wrong) wrong = JSON.stringify(p)
    if (depth < 4) for (const c of alphabet) grow(id + c, depth + 1)
  }
  for (const c of alphabet) grow(c, 1)
  check(wrong === '' && tried > 80000, `of ${tried} grant paths built from ordinary and awkward pieces, every one the allowlist admits is sent exactly as written`, wrong)
}

console.log('3c. the window: a stack that just moved, and a refusal in plain words')
check(APPROVAL_SETTLE_MS === 500 && approveTooSoon(approve, 0) && approveTooSoon(approve, 499) && !approveTooSoon(approve, 500) && !approveTooSoon(approve, 60000), 'an approve within half a second of the stack of cards changing is dropped; after that it is taken')
check(approveTooSoon(approve, NaN) && approveTooSoon(always, -5), 'a time that makes no sense counts as too soon')
check(!approveTooSoon(deny, 0) && !approveTooSoon(deny, NaN), 'a deny is never dropped')
check(refusalWords(new Error(`Error invoking remote method 'approval:resolve': Error: ${CARD_ONLY_REFUSAL}`)) === CARD_ONLY_REFUSAL && refusalWords(new Error('HTTP 400: nope')) === 'HTTP 400: nope' && refusalWords('plain') === 'plain', 'a refusal is shown without the plumbing around it, and anything else is left as it is')

console.log('4. wiring')
{
  const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
  const conn = read('src/main/connection/index.ts')
  // The connection feeds the first rule everything that happens to it.
  const feeds: [string, RegExp][] = [
    ['a new attempt', /start\(\): void \{\s*this\.halted = false\s*this\.capEvent\('attempt'\)/],
    ['a new dial', /beforeRedial: async \(\) => \{\s*this\.capEvent\('dial'\)/],
    ['connected, and leaving it', /this\.capEvent\(state === 'connected' \? 'connected' : 'left'\)/],
    ['stop', /this\.halted = true\s*this\.capEvent\('stop'\)/],
    ['a subscribed reply', /if \(ev\.type === 'subscribed'\) this\.capEvent\(\{ said: advertisesApprovalCritical\(ev\.payload\) \}\)/]
  ]
  for (const [what, re] of feeds) check(re.test(conn), `the connection tells the rule about ${what}`)
  const capFn = conn.slice(conn.indexOf('private capEvent('), conn.indexOf('private setWsAuth('))
  check(/const next = capStep\(this\.cap, e\)/.test(capFn) && (conn.match(/capStep\(/g) ?? []).length === 1, 'every one of them goes through capStep, in one place')
  check(/if \(next\.waiting && !this\.capTimer\)[\s\S]{0,160}setTimeout\(\(\) => \{\s*this\.capTimer = null\s*this\.capEvent\('expired'\)\s*\}, APPROVAL_CRITICAL_WAIT_MS\)/.test(capFn) && /if \(!next\.waiting && this\.capTimer\) \{\s*clearTimeout\(this\.capTimer\)\s*this\.capTimer = null/.test(capFn), 'one timer, running exactly while the rule says silence is being timed; its expiry is just another event')
  check(/if \(next\.value !== was\)[\s\S]{0,200}this\.emit\('status', this\.status\)/.test(capFn) && (conn.match(/\.\.\.\(this\.cap\.value !== null \? \{ approvalCritical: this\.cap\.value \} : \{\}\),/g) ?? []).length === 2, 'a change reaches every window in the status, and the status keeps it across state changes and a refusal')
  check(!/approvalCriticalWait|approvalCriticalSaid|private approvalCritical\b/.test(conn), 'the old hand-kept fields are gone: there is one source of this state')
  // Every approve in main goes through the second rule.
  const resolveFn = conn.slice(conn.indexOf('  resolveApproval('), conn.indexOf('  resolveApproval(') + 900)
  check(/resolveApproval\(requestId: string, decision: ApprovalDecision, from\?: ApprovalSurface\): Promise<void> \{\s*const refusal = approveRefusal\(decision, from, this\.criticalBook\.get\(requestId\), this\.cap\.value \?\? undefined\)\s*if \(refusal\) return Promise\.reject\(new Error\(refusal\)\)/.test(resolveFn), 'the connection asks approveRefusal before any answer is sent, with what the request said and what its Prometheus advertises')
  const writeFn = conn.slice(conn.indexOf('  writeDaemon(path: string'), conn.indexOf('  writeDaemon(path: string') + 900)
  check(/if \(isApprovalAnswerPath\(path\)\) return Promise\.reject\(/.test(writeFn) && writeFn.indexOf('isApprovalAnswerPath(path)') < writeFn.indexOf('this.rest.writeDaemon(') && (conn.match(/this\.rest\.writeDaemon\(/g) ?? []).length === 2, 'the general daemon write refuses an approval answer before anything is sent, on both of its ways out')
  check(resolveFn.indexOf('approveRefusal(') < resolveFn.indexOf('this.rest.resolveApproval(') && (conn.match(/this\.rest\.resolveApproval\(/g) ?? []).length === 1, 'and the daemon is called in that one place, after it')
  check(/if \(ev\.type === 'approval_pending'\)[\s\S]{0,200}noteCritical\(this\.criticalBook, a\.requestId, a\.critical\)/.test(conn) && /listApprovals\(\): Promise<ApprovalRequest\[\]> \{[\s\S]{0,300}for \(const a of list\) noteCritical\(this\.criticalBook, a\.requestId, a\.critical\)/.test(conn), 'the book is written from both ways a request arrives: the frame and the poll')
  const ipc = read('src/main/ipc.ts')
  check(/resolveApproval\(req\.requestId, req\.decision, req\.from\)/.test(ipc) && !/resolveApproval\(req\.requestId, req\.decision\)/.test(ipc), "the window's answer is passed on with where it was given")
  const main = read('src/main/index.ts')
  check(/\.resolveApproval\(requestId, decision, 'notification'\)/.test(main) && (main.match(/\.resolveApproval\(/g) ?? []).length === 1, "a notification's button says it is one")
  const preload = read('src/preload/index.ts')
  check(/resolve: \(requestId: string, decision: ApprovalDecision, from\?: ApprovalSurface\) =>\s*ipcRenderer\.invoke\(IPC\.APPROVAL_RESOLVE, \{ requestId, decision, from \}\)/.test(preload), 'the bridge carries it')
  // The window says where each answer was given.
  const view = read('src/renderer/src/components/MainView.tsx')
  const card = read('src/renderer/src/components/ExecApprovalCard.tsx')
  check(/onResolve=\{\(d, from\) => void resolveApproval\(a\.requestId, d, from\)\}/.test(view) && (view.match(/void resolveApproval\(id, d, 'row'\)/g) ?? []).length === 3, 'the card passes on where its answer came from; the three short surfaces say "row"')
  const resolve = view.slice(view.indexOf('const resolveApproval = useCallback('), view.indexOf('const resolveApproval = useCallback(') + 3600)
  check(/const at = approvalsRef\.current\.findIndex\(\(a\) => a\.requestId === requestId\)\s*const place = approvalPlaces\.current\.get\(requestId\)\s*const since = at < 0 \? Infinity : place && place\.index === at \? Date\.now\(\) - place\.at : 0\s*if \(approveTooSoon\(decision, since\)\) return/.test(resolve) && resolve.indexOf('approveTooSoon(') < resolve.indexOf('b.approvals.resolve('), 'every answer in the window passes the settle check before it is sent, timed from when THAT request came to its place in the stack; a card whose place is not yet recorded counts as having just moved')
  check(/if \(places\.get\(id\)\?\.index !== index\) places\.set\(id, \{ index, at: now \}\)/.test(view) && /if \(!ids\.includes\(id\)\) places\.delete\(id\)/.test(view) && /useLayoutEffect\(\(\) => \{\s*const now = Date\.now\(\)[\s\S]{0,420}\}, \[approvalIds\]\)/.test(view), 'a request\'s clock restarts when it appears or moves, and at no other time, before the new stack is painted')
  check(/if \(!waits && approval\) setApprovals\(\(p\) => \(p\.some\(\(a\) => a\.requestId === requestId\) \? p : \[\.\.\.p\.slice\(0, Math\.max\(0, at\)\), approval, \.\.\.p\.slice\(Math\.max\(0, at\)\)\]\)\)\s*setApprovalErrors\(\(m\) => \(\{ \.\.\.m, \[requestId\]: refusalWords\(err\) \}\)\)/.test(resolve), 'a refused answer puts the card straight back where it was, with the refusal in plain words')
  const rendererFiles = ['MainView', 'ExecApprovalCard', 'MissionControl', 'MissionHome', 'TodayHome', 'ProgressPane', 'SidePanel', 'TrayHud', 'QuickCapture', 'ChatShell', 'ChatHome', 'ConfigPanel'].map((n) => [n, read(`src/renderer/src/components/${n}.tsx`)] as const)
  check(rendererFiles.filter(([, src]) => /approvals\.resolve\(/.test(src)).map(([n]) => n).join() === 'MainView' && (view.match(/approvals\.resolve\(/g) ?? []).length === 1 && !/resolveApproval\([^)]*'card'\)/.test(view), 'one place in the window sends an answer to main, and it never says "card" on its own account')
  const keyFn = card.slice(card.indexOf('const onKey = (e: KeyboardEvent)'), card.indexOf("window.addEventListener('keydown', onKey)"))
  check(/onResolve\(\{ kind: 'approve', scope: 'once' \}, 'key'\)/.test(keyFn) && /onResolve\(\{ kind: 'deny' \}, 'key'\)/.test(keyFn) && !/'card'/.test(keyFn), 'an answer by key says "key"')
  const buttons = card.slice(card.indexOf("window.addEventListener('keydown', onKey)"))
  const approves = [...buttons.matchAll(/onResolve\(\{ kind: 'approve', scope: [^}]*\}(, '[a-z]+')?\)/g)].map((m) => m[0])
  check(approves.length >= 2 && approves.every((a) => /, 'card'\)$/.test(a)), `every Approve BUTTON on the card says "card" (${approves.length} of them)`, approves.join(' | '))
}
