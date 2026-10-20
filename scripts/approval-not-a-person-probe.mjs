/**
 * approval-not-a-person-probe — a worker's request that this Beacon is not allowed to approve, in the real built app.
 *
 * Prometheus #744: a worker's request is approved only with a DEVICE token (a person's). The API token, or an open daemon, gets
 * `401 {"error": "Only a person may approve a worker's request: …", "code": "not_a_person"}` and the request stays pending. Before
 * this fix Beacon took the card down on Approve, the 401 came back, the 3 s poll put the card back with "HTTP 401: …" and Approve
 * again, and the 401 also lit the connection's "token rejected" state (any 401 did). Over Config the card was see-through too.
 *
 * What this drives, with REAL clicks and keys over CDP against a fake daemon serving Prometheus's own bytes:
 *   1. the card over Config paints an opaque surface (computed alpha 1, nothing between it and the page fading it);
 *   2. Approve → one POST, the 401 → the card STAYS (never gone across two polls), says the one line, offers no Approve, keeps Deny;
 *   3. `A` sends nothing more; the connection does not report a rejected token;
 *   4. Deny → the deny POST → the card goes.
 *
 * Run: npm run build && npm run probe:approval-not-a-person      (needs 127.0.0.1:8767 free; nothing else)
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { bannedHits } from './lib/banned-hits.mjs'

const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const PORT = 8767
const UD = `/tmp/beacon-not-a-person-probe-ud-${process.pid}`
const LINE = "This Beacon can't approve worker requests yet. Approve it from Telegram with /approve, or from a Beacon set up as an owner device."

const now = Math.floor(Date.now() / 1000)
// The shape Prometheus serves for a worker's request (#720): once-only, the worker's task id and its conversation.
const WORKER = {
  request_id: 'probe-worker-1',
  tool_name: 'bash',
  description: 'bash: ls ~/projects',
  created_at: now - 3,
  expires_at: now + 1797,
  extents: {},
  arguments: null,
  worker_task_id: 'w7',
  session_id: 'web:probe-session',
  once_only: true
}
// Prometheus #744's exact refusal (web/server.py _worker_approve_refusal). This fake daemon is an open one (the app sends no key), so
// it is the open-daemon branch: the longer sentence, which puts the code at character 178 of a 200-character body.
const REFUSAL = {
  error: "Only a person may approve a worker's request: no API token is configured, so no caller can be told apart from a model. Answer it from Beacon or the chat it came from.",
  code: 'not_a_person'
}

let pending = true
let approves = 0
let denies = 0
let listServed = 0
const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = req.url ?? ''
  if (req.method === 'GET' && url.startsWith('/api/approvals')) {
    listServed += 1
    res.end(JSON.stringify(pending ? [WORKER] : []))
    return
  }
  if (req.method === 'POST' && url === `/api/approvals/${WORKER.request_id}/approve`) {
    approves += 1
    res.statusCode = 401
    res.end(JSON.stringify(REFUSAL))
    return
  }
  if (req.method === 'POST' && url === `/api/approvals/${WORKER.request_id}/deny`) {
    denies += 1
    pending = false
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.statusCode = 404
  res.end('[]')
})
await new Promise((resolve, reject) => {
  gateway.once('error', reject)
  gateway.listen(PORT, '127.0.0.1', resolve)
})
console.log(`[probe] fake daemon on 127.0.0.1:${PORT}`)

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(PORT)
process.env.BEACON_GATEWAY_WS_PORT = '59998' // dead on purpose: the REST poll is the path under test
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${UD} --use-mock-keychain`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

let failures = 0
let checks = 0
function check(cond, label, detail = '') {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures += 1
  }
}

// The card root: climb from a Deny button to the child of the fixed overlay MainView stacks the cards in. (Climbing while the parent
// holds one Deny reaches <body> when there is one card, and then every reading is the page's.)
const CARD = `(() => {
  for (const btn of document.querySelectorAll('.approval-btn-deny')) {
    let el = btn
    while (el.parentElement && getComputedStyle(el.parentElement).position !== 'fixed') el = el.parentElement
    if (el.parentElement && el.textContent.includes('Worker w7 asks')) return el
  }
  return null
})()`

/** A real click at the centre of the first visible element matching `selector`, after checking nothing covers it. */
async function click(selector, within = 'document') {
  const at = await evaluate(`(() => {
    const root = ${within === 'card' ? CARD : 'document'}
    if (!root) return { why: 'no card' }
    const el = [...root.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent !== null)
    if (!el) return { why: 'nothing visible matches' }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === el || el.contains(top)) }
  })()`)
  if (!at || at.why) return at?.why ?? 'no answer'
  if (!at.hit) return 'covered at its centre'
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return 'clicked'
}
async function pressKey(key, code, vk) {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' ? key : undefined })
}

const cardState = () =>
  evaluate(`(() => {
    const card = ${CARD}
    const indicator = document.querySelector('[aria-label^="Connection status"]')
    if (!card) return { present: false, indicator: indicator ? indicator.getAttribute('title') : null }
    const approve = card.querySelector('.approval-btn-approve')
    return {
      present: true,
      text: card.innerText,
      approve: !!approve && approve.offsetParent !== null,
      deny: !!card.querySelector('.approval-btn-deny'),
      indicator: indicator ? indicator.getAttribute('title') : null
    }
  })()`)

try {
  // ── the card arrives ───────────────────────────────────────────────────────────────────────
  let s = null
  for (let i = 0; i < 40 && !s?.present; i++) {
    await sleep(500)
    s = await cardState()
  }
  check(listServed > 0, `the app polled the fake daemon (${listServed} time(s)): the request travelled the real REST path`)
  if (!s?.present) throw new Error(`the worker's card never appeared; last=${JSON.stringify(s)}\n${mainLog.join('').slice(-1500)}`)
  check(s.approve && s.deny, 'before any answer the card offers Approve and Deny')

  // ── 1. over Config, the card is opaque ─────────────────────────────────────────────────────
  const toConfig = await click('nav[aria-label="Views"] [title="Config"]')
  check(toConfig === 'clicked', `a real click on the rail's Config entry (${toConfig})`)
  let onConfig = false
  for (let i = 0; i < 20 && !onConfig; i++) {
    await sleep(250)
    onConfig = await evaluate(`!!document.querySelector('[data-testid="config-tab-groups"]')`)
  }
  check(onConfig, 'Config is on screen under the card')
  const paint = await evaluate(`(() => {
    const card = ${CARD}
    if (!card) return null
    // Every ancestor's opacity multiplies into the card's; any one under 1 makes it see-through whatever its background says.
    let opacity = 1
    for (let el = card; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity)
    // Resolve the computed background to rgba with a 1x1 canvas: color-mix() computes to a color() string this side can't parse alone.
    const c = document.createElement('canvas'); c.width = c.height = 1
    const g = c.getContext('2d')
    g.clearRect(0, 0, 1, 1)
    g.fillStyle = getComputedStyle(card).backgroundColor
    g.fillRect(0, 0, 1, 1)
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data
    return { bg: getComputedStyle(card).backgroundColor, rgba: [r, gg, b, a], opacity }
  })()`)
  check(paint && paint.rgba[3] === 255, `the card's own background is fully opaque (computed ${paint?.bg} → alpha ${paint?.rgba?.[3]}/255)`)
  check(paint && paint.opacity === 1, `nothing above the card fades it (combined opacity ${paint?.opacity})`)
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  if (shot1?.result?.data) writeFileSync('/tmp/approval-not-a-person-config.png', Buffer.from(shot1.result.data, 'base64'))

  // ── 2. Approve → 401 not_a_person ──────────────────────────────────────────────────────────
  const approved = await click('.approval-btn-approve', 'card')
  check(approved === 'clicked', `a real click on Approve (${approved})`)
  for (let i = 0; i < 20 && approves === 0; i++) await sleep(100)
  check(approves === 1, `Approve sent one POST (${approves})`)
  // Watch from the moment the POST lands through more than two 3 s polls: the card must never leave, and the connection must never
  // call the key rejected (a successful poll clears that state again within 3 s, so it is sampled from the start, not at the end).
  const samples = []
  const polledBefore = listServed
  for (let i = 0; i < 40; i++) {
    samples.push(await cardState())
    await sleep(150)
  }
  const rejected = samples.filter((x) => /token rejected/.test(x.indicator ?? '')).length
  check(rejected === 0, `the connection never reports a rejected key after the refusal (${rejected} of ${samples.length} samples did)`)
  check(listServed - polledBefore >= 2, `the app polled again while the card was watched (${listServed - polledBefore} times), so "stays" spans real polls`)
  const gone = samples.filter((x) => !x.present).length
  check(gone === 0, `after the refusal the card stays put through two polls (${samples.length} samples, ${gone} without it)`)
  const last = samples[samples.length - 1]
  check(last.present && last.text.includes(LINE), 'the card says the one line', last.text?.slice(0, 300))
  check(last.present && !/HTTP 401|not_a_person|\{"error"/.test(last.text), 'no raw status, code or body is shown', last.text?.slice(0, 300))
  check(last.present && !last.approve, 'Approve is no longer offered on this card')
  check(last.present && last.deny, 'Deny is still offered')
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  if (shot2?.result?.data) writeFileSync('/tmp/approval-not-a-person-refused.png', Buffer.from(shot2.result.data, 'base64'))
  const ownWords = last.present ? last.text.replace(WORKER.description, '') : ''
  const banned = bannedHits(ownWords, WORDS)
  check(banned.length === 0, 'the card\'s own words keep to the plain-language list', banned.join(', '))

  // ── 3. nothing approves again; the key is not called rejected ──────────────────────────────
  await pressKey('a', 'KeyA', 65)
  await sleep(600)
  check(approves === 1, `pressing A sends no second approve (${approves})`)
  const nowIndicator = (await cardState()).indicator ?? ''
  check(!/token rejected/.test(last.indicator ?? '') && !/token rejected/.test(nowIndicator), `the connection does not report a rejected key (${last.indicator} | ${nowIndicator})`)

  // ── 4. Deny still works ────────────────────────────────────────────────────────────────────
  const denied = await click('.approval-btn-deny', 'card')
  check(denied === 'clicked', `a real click on Deny (${denied})`)
  for (let i = 0; i < 20 && denies === 0; i++) await sleep(100)
  check(denies === 1, `Deny sent one POST (${denies})`)
  let after = null
  for (let i = 0; i < 16; i++) {
    await sleep(250)
    after = await cardState()
    if (!after.present) break
  }
  check(after && !after.present, 'after Deny the card goes')
} catch (e) {
  console.error(`  FATAL ${e instanceof Error ? e.message : e}`)
  failures += 1
} finally {
  gateway.close()
}

const MIN_CHECKS = 21
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected ${MIN_CHECKS}`)
  failures += 1
}
console.log(`\n${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures} of ${checks})`}\n`)
process.exit(failures === 0 ? 0 : 1)
