/**
 * approval-not-resolved-smoke — a 200 that says nothing was answered, headless.
 *
 * Seen on a real Mac: eight approvals of one worker request, each answered 200 by Prometheus, none taking the card down for good. The
 * 200's body was {ok:false, message:"No pending request: <id>"}: the request had been answered (or its worker had stopped) and was still
 * listed. Beacon read only the status, so each approve looked like success, the poll brought the card back, and nothing said why.
 *
 *   1. RestClient.resolveApproval: {ok:false} is an error carrying the daemon's words; every other 200 is still a success;
 *   2. the card's line for it (plain words, fixed for "no pending request"), and nothing else is mistaken for it;
 *   3. wiring: the card stays, Approve goes, the owner button is not offered, and the refusal for who is asking is still its own.
 *
 * Run: npm run build && npm run smoke:approval-not-resolved
 */
import { readFileSync } from 'node:fs'
import { NOT_PENDING_LINE, NOT_RESOLVED_CODE, notResolvedLine, readNotResolved } from '@shared/approval-refusal'
import { isNotAPerson } from '@shared/daemon-api'
import { RestClient } from './connection/rest'

const MIN_CHECKS = 35
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
    console.error(`approval-not-resolved smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`approval-not-resolved smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`approval-not-resolved smoke: PASS ✓ (${checks} checks: the 200 that says no, the words, wiring)`)
})

/** What Prometheus's approve route sends (web/server.py approve_action): {ok, remembered, grant_id, message, skipped}. */
const ANSWERED = JSON.stringify({ ok: true, remembered: false, grant_id: null, message: 'Approved: c3116fad', skipped: 0 })
const NOT_PENDING = JSON.stringify({ ok: false, remembered: false, grant_id: null, message: 'No pending request: c3116fad', skipped: 0 })

async function resolve(text: string, status = 200, kind: 'approve' | 'deny' = 'approve'): Promise<Error | null> {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => new Response(text, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    await new RestClient('http://gw', 'tok').resolveApproval('c3116fad', kind === 'approve' ? { kind: 'approve', scope: 'once' } : { kind: 'deny' })
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    globalThis.fetch = orig
  }
}
const viaIpc = (e: Error): Error => new Error(`Error invoking remote method 'approvals:resolve': Error: ${e.message}`)

async function main(): Promise<void> {
  console.log('1. the client')
  check((await resolve(ANSWERED)) === null, 'a 200 that says ok:true is an answer')
  const e = await resolve(NOT_PENDING)
  check(e !== null && /^HTTP 200 \[not_resolved\]: POST \/api\/approvals\/c3116fad\/approve — No pending request: c3116fad$/.test(e.message), 'a 200 that says ok:false is an error, with the daemon\'s own words', e?.message)
  const d = await resolve(NOT_PENDING, 200, 'deny')
  check(d !== null && /\/deny — No pending request/.test(d.message), 'and so is a deny that answered nothing')
  check((await resolve(JSON.stringify({ ok: true }), 200, 'deny')) === null, 'a deny that did answer is fine')
  for (const [name, text] of Object.entries({ empty: '', 'not JSON': 'OK', array: '[]', 'null': 'null', 'object, no ok': '{}', 'ok as text': '{"ok":"false"}', 'ok null': '{"ok":null}', 'ok 0': '{"ok":0}', number: '7' })) {
    check((await resolve(text)) === null, `a 200 whose body is ${name} is still a success (an older Prometheus, or one that does not say)`)
  }
  const noMessage = await resolve('{"ok":false}')
  check(noMessage !== null && /\[not_resolved\]/.test(noMessage.message), 'ok:false with no message is still not an answer')
  const long = await resolve(JSON.stringify({ ok: false, message: 'x'.repeat(900) }))
  check(long !== null && long.message.length < 400, 'a long message is cut', String(long?.message.length))
  const r401 = await resolve(JSON.stringify({ error: 'x', code: 'not_a_person' }), 401)
  check(r401 !== null && isNotAPerson(r401) && notResolvedLine(r401) === null, 'a 401 not_a_person stays its own refusal, and is not this')
  const r400 = await resolve(JSON.stringify({ error: 'scope must be one of x' }), 400)
  check(r400 !== null && notResolvedLine(r400) === null && /HTTP 400/.test(r400.message), 'a 400 is shown as before')

  console.log('2. the words')
  check(readNotResolved(NOT_PENDING) === 'No pending request: c3116fad', 'the daemon\'s message is read')
  check(readNotResolved(ANSWERED) === null && readNotResolved('') === null && readNotResolved('{"ok":false,"message":4}') === '', 'only ok:false is "not answered"; a message that is not text is nothing')
  check(notResolvedLine(viaIpc(e as Error)) === NOT_PENDING_LINE, 'through the bridge\'s wrapping, "no pending request" is the one plain line')
  check(NOT_PENDING_LINE === 'Prometheus says nothing is waiting for this answer any more. It was most likely answered already, or the worker that asked has stopped. Minimize it; Prometheus drops it when it expires.', 'the line is the agreed wording')
  check(!/\b[45]\d\d\b|HTTP|\/api\/|ok:|null|undefined|\bid\b/.test(NOT_PENDING_LINE), 'with no code, route or jargon in it')
  const other = notResolvedLine(new Error(`HTTP 200 [${NOT_RESOLVED_CODE}]: POST /api/approvals/c1/approve — Not approved: c1 can only be approved once — /approve c1`))
  check(other !== null && /^Prometheus did not take this answer: Not approved: c1 can only be approved once/.test(other), 'another message from Prometheus is shown as what it said')
  check(notResolvedLine(new Error(`HTTP 200 [${NOT_RESOLVED_CODE}]: POST /api/approvals/c1/approve — `)) === NOT_PENDING_LINE, 'no message at all reads as nothing waiting')
  check(notResolvedLine(new Error('HTTP 200: POST /api/approvals/c1/approve')) === null && notResolvedLine(new Error('fetch failed')) === null && notResolvedLine(null) === null && notResolvedLine(undefined) === null && notResolvedLine('x') === null, 'nothing else is mistaken for it')
  check(notResolvedLine(new Error('HTTP 500 [not_resolved]: POST /api/approvals/c1/approve — No pending request')) === null, 'only a 200 is')

  console.log('3. wiring')
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const main = src('src/renderer/src/components/MainView.tsx')
  const rest = src('src/main/connection/rest.ts')
  check(/readNotResolved\(await fullText\(res\)\)/.test(rest) && /HTTP 200 \[\$\{NOT_RESOLVED_CODE\}\]/.test(rest), 'the client reads every 200\'s body')
  check(/const none = notResolvedLine\(err\)/.test(main) && /setNotWaiting\(\(m\) => \(\{ \.\.\.m, \[requestId\]: none \}\)\)/.test(main), 'the card is given the line')
  check(/cannotApprove=\{cannotApprove\[a\.requestId\] \?\? notWaiting\[a\.requestId\] \?\? null\}/.test(main), 'in place of Approve (the same slot the refusal for who is asking uses)')
  check((main.match(/approvals=\{rowApprovals\}/g) ?? []).length === 2 && /new Set\(rowApprovals\.map/.test(main) && /approvals\.filter\(\(a\) => !notWaiting\[a\.requestId\]\)/.test(main), 'the short rows (Today, Mission, the desktop-prompt pane) stop offering a request Prometheus is not waiting for')
  check(/setCannotApprove\(keep\)\s*setNotWaiting\(keep\)/.test(main), 'the lines leave with the request, so the same id listed again later is a new question')
  check(!/const none = notResolvedLine\(err\)\s*if \(none\) \{\s*\/\/[^\n]*\n\s*setNotWaiting[\s\S]{0,120}setApprovals/.test(main), 'a request Prometheus says is gone is not put back by the answer (a still-listed one comes back with the poll)')
  check(/onMakeOwner=\{cannotApprove\[a\.requestId\] \? openMakeOwner : undefined\}/.test(main), 'and "Make this Beacon an owner" is offered only for that refusal')
  check(/const line = approval \? cannotApproveLine\(approval, err\) : null\s*if \(line\) \{[\s\S]{0,200}return\s*\}[\s\S]{0,260}const none = notResolvedLine/.test(main), 'the refusal for who is asking is still checked first')
  check(/if \(!waits && approval\) setApprovals\(\(p\) => \(p\.some\(\(a\) => a\.requestId === requestId\) \? p : \[\.\.\.p\.slice\(0, Math\.max\(0, at\)\)/.test(main), 'a card taken down for the answer comes straight back, where it was')
}

main().catch((err) => {
  console.error('smoke threw:', err)
  failures++
})
