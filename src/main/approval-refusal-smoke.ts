/**
 * Approval refusal smoke (headless / ELECTRON_RUN_AS_NODE): a worker's request this Beacon may not approve.
 *
 * Prometheus #744 answers an approve of a worker's request made with the API token (or to an open daemon) with
 * `401 {"error": "Only a person may approve a worker's request: …", "code": "not_a_person"}`. Three things hang on Beacon reading
 * that right:
 *
 *   * the code is read from the WHOLE body. The REST errors carry the body cut to 200 characters, and #744 puts `code` after a
 *     sentence of 150 to 200; a reworded sentence would cut the code off and the card would fall back to Approve forever;
 *   * a not_a_person 401 is not a rejected key. Any 401 used to mark the connection "token rejected", so a refusal about WHO is
 *     asking read as the key being wrong;
 *   * the card's decision: the one line for a worker's request refused this way, nothing for anything else.
 *
 * The REST half runs the real RestClient against a stubbed fetch carrying Prometheus's own bytes.
 */
import { RestClient } from './connection/rest'
import { daemonErrorSentence, isAuthError, isNotAPerson, refusalCode } from '@shared/daemon-api'
import { CANNOT_APPROVE_WORKER, cannotApproveLine } from '@shared/approval-refusal'

const EXPECTED = 20
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[approval-refusal-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
function report(): void {
  if (checks !== EXPECTED) {
    console.log(`[approval-refusal-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(`[approval-refusal-smoke] ${failures === 0 ? 'PASS' : 'FAIL'} (${checks} checks, ${failures} failed)`)
  process.exitCode = failures === 0 ? 0 : 1
}
process.on('exit', report)

// Starlette's JSONResponse bytes (separators "," and ":"), from web/server.py _worker_approve_refusal at Prometheus 108853c.
const body = (why: string): string =>
  JSON.stringify({ error: `Only a person may approve a worker's request: ${why}. Answer it from Beacon or the chat it came from.`, code: 'not_a_person' })
const TOKEN_BODY = body('the API token cannot do this: a model can read it')
const OPEN_BODY = body('no API token is configured, so no caller can be told apart from a model')
// The same refusal reworded longer: the code lands past character 200.
const LONG_BODY = body('no API token is configured, so no caller can be told apart from a model, and a model may be the one asking right now')
// The computer routes' shape (web/server.py, computer start): the code IS the error.
const COMPUTER_BODY = JSON.stringify({ error: 'not_a_person', detail: 'Only a person may: computer use is off.' })

async function refusalOf(text: string, status: number): Promise<Error | null> {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => new Response(text, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
  try {
    await new RestClient('http://gw', 'tok').resolveApproval('w-1', { kind: 'approve', scope: 'once' })
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    globalThis.fetch = orig
  }
}
// What the renderer sees: Electron wraps a rejected invoke's message.
const viaIpc = (e: Error | null): Error => new Error(`Error invoking remote method 'approval:resolve': Error: ${e?.message ?? ''}`)

async function main(): Promise<void> {
  // ── the code, from the whole body ───────────────────────────────────────────────────────────
  assert(LONG_BODY.length > 200 && LONG_BODY.indexOf('"code"') > 200, `fixture: the long refusal puts its code past character 200 (${LONG_BODY.indexOf('"code"')})`)
  assert(refusalCode(TOKEN_BODY) === 'not_a_person', 'refusalCode: the API-token refusal')
  assert(refusalCode(COMPUTER_BODY) === 'not_a_person', 'refusalCode: an error that is itself a code')
  assert(refusalCode('{"error":"Only a person may approve"}') === null, 'refusalCode: a sentence is not a code')
  assert(refusalCode('<html>bad gateway</html>') === null && refusalCode('') === null, 'refusalCode: not JSON → none')

  for (const [name, text] of [['API token', TOKEN_BODY], ['open daemon', OPEN_BODY], ['reworded longer', LONG_BODY]] as const) {
    const e = await refusalOf(text, 401)
    assert(e !== null && isNotAPerson(viaIpc(e)), `RestClient → IPC: the ${name} refusal is read as not_a_person`, e?.message)
  }
  const e401 = await refusalOf(TOKEN_BODY, 401)
  assert(!!e401 && /^HTTP 401\b/.test(e401.message) && e401.message.includes(' — {"error":"Only a person'), 'the error still starts HTTP 401 and still carries the body after " — "', e401?.message)
  assert(daemonErrorSentence(e401) !== null, "the daemon's own sentence is still readable from it")

  // ── not a rejected key ─────────────────────────────────────────────────────────────────────
  assert(!isAuthError(viaIpc(e401)), 'a not_a_person 401 is not an auth error (the key was accepted)')
  const plain401 = await refusalOf('{"detail":"Unauthorized"}', 401)
  assert(isAuthError(plain401) && !isNotAPerson(plain401), 'an ordinary 401 is still an auth error')
  const noBody401 = await refusalOf('', 401)
  assert(isAuthError(noBody401), 'a 401 with no body is still an auth error (fail toward "check the key")')
  const sentence401 = await refusalOf(JSON.stringify({ error: 'something about not_a_person in prose' }), 401)
  assert(isAuthError(sentence401) && !isNotAPerson(sentence401), 'the words in a sentence are not the code')
  const e403 = await refusalOf(JSON.stringify({ error: 'x', code: 'not_a_person' }), 403)
  assert(!isNotAPerson(e403), 'not_a_person on another status is not this refusal')
  assert(!isNotAPerson(new Error('HTTP 401: POST /api/approvals/[not_a_person]/approve — ')), "a marker-looking request id isn't the marker")

  // ── the card's decision ─────────────────────────────────────────────────────────────────────
  const worker = { workerTaskId: 'w7' }
  assert(cannotApproveLine(worker, viaIpc(e401)) === CANNOT_APPROVE_WORKER, "a worker's request refused not_a_person → the one line")
  assert(cannotApproveLine({}, viaIpc(e401)) === null, 'an ordinary request refused the same way → no line (its error shows as before)')
  assert(cannotApproveLine(worker, plain401) === null, "a worker's request refused for the key → no line")
  assert(
    CANNOT_APPROVE_WORKER === "This Beacon can't approve worker requests yet. Approve it from Telegram with /approve, or from a Beacon set up as an owner device.",
    'the line is the agreed wording'
  )
}

main().catch((e) => {
  console.error('[approval-refusal-smoke] threw:', e)
  failures++
})
