/**
 * approval-worker-critical-probe — a worker's request that is also critical, and putting a card away, in the real built app.
 *
 * Seen on a real Mac: an `edit_file` outside the workspace from a worker, with its arguments cut. The card said "This Beacon can't
 * approve worker requests yet" AND "can be approved only here, with the button", offered only Deny, and covered the top of the window
 * until it was answered. What this drives, with REAL clicks and keys over CDP against a fake daemon:
 *
 *   1. a worker's critical request is approved with its card's button when the daemon accepts it (an owner device): one POST, card gone;
 *   2. one the daemon refuses for who is asking (401 not_a_person) says that once, never also "approved only here", keeps Deny, and
 *      offers "Make this Beacon an owner" (which opens that Settings section);
 *   3. a card can be put away to a badge: the app under it is usable, the request stays pending (it is polled, not dropped), `A` does
 *      nothing while it is away, the badge brings it back, and an approve soon after it comes back is the settle guard's to drop.
 *
 * Run: npm run build && npm run probe:approval-worker-critical      (needs 127.0.0.1:8768 free; nothing else)
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { bannedHits } from './lib/banned-hits.mjs'

const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const PORT = 8768
const UD = `/tmp/beacon-worker-critical-probe-ud-${process.pid}`
const LINE = "This Beacon can't approve worker requests yet. Approve it from Telegram with /approve, or from a Beacon set up as an owner device."
const APP_ONLY = 'This request can be approved only here, with the button.'

const now = Math.floor(Date.now() / 1000)
const row = (id, task, over = {}) => ({
  request_id: id,
  tool_name: 'edit_file',
  description: 'edit_file targets path outside workspace: /home/demo/docs/plan.md',
  created_at: now - 3,
  expires_at: now + 1797,
  extents: {},
  arguments: { path: '/home/demo/docs/plan.md', old_str: 'x' },
  arguments_cut: true,
  worker_task_id: task,
  session_id: 'web:probe-session',
  once_only: true,
  critical: true,
  ...over
})
const OWNED = row('probe-worker-own', 'w8') // the daemon accepts this one (an owner device token)
const REFUSED = row('probe-worker-ref', 'w7') // the daemon refuses this one (the API token)
// A request Prometheus answers 200 {ok:false, message:"No pending request: …"} and still lists (answered already, its worker gone): what a real Mac showed after eight approvals.
const GHOST = row('probe-worker-gho', 'w9')
const NOT_PENDING = { ok: false, remembered: false, grant_id: null, message: `No pending request: ${GHOST.request_id}`, skipped: 0 }
const REFUSAL = { error: "Only a person may approve a worker's request: the API token cannot do this: a model can read it. Answer it from Beacon or the chat it came from.", code: 'not_a_person' }

const state = { pending: new Set([OWNED.request_id, REFUSED.request_id, GHOST.request_id]), approves: { own: 0, ref: 0, gho: 0 }, denies: 0, listServed: 0 }
const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = req.url ?? ''
  if (req.method === 'GET' && url.startsWith('/api/approvals')) {
    state.listServed += 1
    res.end(JSON.stringify([OWNED, REFUSED, GHOST].filter((r) => state.pending.has(r.request_id))))
    return
  }
  if (req.method === 'POST' && url === `/api/approvals/${OWNED.request_id}/approve`) {
    state.approves.own += 1
    state.pending.delete(OWNED.request_id)
    res.end(JSON.stringify({ ok: true, remembered: false, grant_id: null, message: 'approved', skipped: 0 }))
    return
  }
  if (req.method === 'POST' && url === `/api/approvals/${GHOST.request_id}/approve`) {
    state.approves.gho += 1
    res.end(JSON.stringify(NOT_PENDING)) // 200, and it stays listed
    return
  }
  if (req.method === 'POST' && url === `/api/approvals/${REFUSED.request_id}/approve`) {
    state.approves.ref += 1
    res.statusCode = 401
    res.end(JSON.stringify(REFUSAL))
    return
  }
  if (req.method === 'POST' && url.endsWith('/deny')) {
    state.denies += 1
    state.pending.delete(url.split('/')[3])
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
process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(PORT)
process.env.BEACON_GATEWAY_WS_PORT = '59997' // dead on purpose: the REST poll is the path under test
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
const cardOf = (task) => `(() => { for (const el of document.querySelectorAll('[data-approval-id]')) if (el.textContent.includes('Worker ${task} asks')) return el; return null })()`
async function click(selector, within) {
  const at = await evaluate(`(() => {
    const root = ${within ? cardOf(within) : 'document'}
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
const until = async (fn, pred, ms = 8000) => {
  let v
  for (let t = 0; t < ms; t += 150) {
    v = await fn()
    if (pred(v)) return v
    await sleep(150)
  }
  return v
}
const view = (task) =>
  evaluate(`(() => {
    const card = ${cardOf(task)}
    return {
      present: !!card,
      text: card?.innerText ?? '',
      approve: !!card?.querySelector('.approval-btn-approve'),
      deny: !!card?.querySelector('.approval-btn-deny'),
      minimize: !!card?.querySelector('[data-testid="approval-minimize"]'),
      owner: !!card?.querySelector('[data-testid="approval-make-owner"]'),
      critical: card?.dataset.critical ?? null,
      badge: document.querySelector('[data-testid="approval-badge"]')?.innerText ?? null
    }
  })()`)

try {
  // ── arrival: both are critical, both approvable-looking ────────────────────────────────────
  const first = await until(() => view('w8'), (v) => v.present, 25000)
  if (!first.present) throw new Error(`the card never appeared\n${mainLog.join('').slice(-1500)}`)
  const second = await view('w7')
  check(first.critical === 'yes' && second.critical === 'yes', 'both worker requests arrive as critical cards')
  check(first.approve && second.approve && first.minimize, 'each offers Approve, Deny and Minimize before anything is tried', JSON.stringify([first.approve, second.approve, first.minimize]))
  check(first.text.includes(APP_ONLY), 'a critical card that can still be approved says it is approved here, with the button')

  // ── 1. the daemon accepts (an owner device) ────────────────────────────────────────────────
  // Not within the settle guard's window right after arrival.
  await sleep(1500)
  const ok = await click('.approval-btn-approve', 'w8')
  check(ok === 'clicked', `a real click on Approve of the worker's critical request (${ok})`)
  const done = await until(() => view('w8'), (v) => !v.present, 6000)
  check(state.approves.own === 1 && !done.present, `one approve POST, and the card goes (${state.approves.own})`)

  // ── 3a. put the other one away ─────────────────────────────────────────────────────────────
  const away = await click('[data-testid="approval-minimize"]', 'w7')
  check(away === 'clicked', `a real click on Minimize (${away})`)
  const hidden = await until(() => view('w7'), (v) => !v.present && v.badge !== null, 4000)
  check(!hidden.present && /1 request waiting/.test(hidden.badge ?? ''), 'the card goes to a one-line badge that says one request is waiting', JSON.stringify(hidden.badge))
  const covered = await evaluate(`(() => {
    const badge = document.querySelector('[data-testid="approval-badge"]').getBoundingClientRect()
    const area = document.querySelector('[data-approvals-area]').getBoundingClientRect()
    return { badgeH: Math.round(badge.height), areaH: Math.round(area.height) }
  })()`)
  check(covered.badgeH <= 30, `what a put-away request leaves is a badge ${covered.badgeH}px tall, not a card (another request's card may still be showing: ${covered.areaH}px in all)`, JSON.stringify(covered))
  const toConfig = await click('nav[aria-label="Views"] [title="Config"]')
  const onConfig = await until(() => evaluate(`!!document.querySelector('[data-testid="config-tab-groups"]')`), (v) => v === true, 4000)
  check(toConfig === 'clicked' && onConfig, 'the app underneath is usable: Config opened from the rail while a request waits')
  const polled = state.listServed
  await sleep(7000)
  check(state.listServed > polled, 'the request is still being polled: it stays in the queue, not dropped')
  check((await view('w7')).badge !== null && state.pending.has(REFUSED.request_id), 'and the badge is still there, the request still pending')
  await pressKey('d', 'KeyD', 68)
  await pressKey('a', 'KeyA', 65)
  await sleep(500)
  check(state.denies === 0 && state.approves.ref === 0, 'A and D do nothing while the card is away')

  // ── 3b. bring it back ──────────────────────────────────────────────────────────────────────
  const back = await click('[data-testid="approval-badge"]')
  check(back === 'clicked', `a real click on the badge (${back})`)
  const shown = await until(() => view('w7'), (v) => v.present, 4000)
  check(shown.present && shown.badge === null, 'the card is back and the badge is gone')
  // The card has just appeared under the pointer: an approve right then is dropped, so a click meant for the badge cannot approve.
  const early = await click('.approval-btn-approve', 'w7')
  await sleep(300)
  check(early === 'clicked' && state.approves.ref === 0, 'an Approve pressed the instant it came back sends nothing (the settle guard starts again)', String(state.approves.ref))

  // ── 2. the daemon refuses for who is asking ────────────────────────────────────────────────
  await sleep(1500)
  const tried = await click('.approval-btn-approve', 'w7')
  check(tried === 'clicked', `a real click on Approve once it has settled (${tried})`)
  const refused = await until(() => view('w7'), (v) => v.text.includes("can't approve worker requests"), 6000)
  check(state.approves.ref === 1, `one approve POST, refused (${state.approves.ref})`)
  check(refused.present && refused.text.includes(LINE), 'the card says it cannot approve this one, and why', refused.text.slice(0, 300))
  check(!refused.text.includes(APP_ONLY) && !/only here|only in the app|with the button/i.test(refused.text.replace(/edit_file targets[^\n]*/, '')), 'and never also that it can be approved only here')
  check(!refused.approve && refused.deny, 'Approve is gone and Deny is still offered')
  check(refused.owner, 'it offers "Make this Beacon an owner", the way to approve it from here')
  const ownWords = refused.text.replace(/edit_file targets[^\n]*/, '').replace(/path[\s\S]*plan\.md/, '')
  const banned = bannedHits(ownWords, WORDS)
  check(banned.length === 0, "the card's own words keep to the plain-language list", banned.join(', '))
  check(refused.minimize, 'and it can still be put away')
  await sleep(4000)
  check((await view('w7')).present, 'it stays across polls (the refusal is not forgotten and the card does not flicker)')
  const mk = await click('[data-testid="approval-make-owner"]', 'w7')
  const settings = await until(() => evaluate(`document.body.innerText.includes('Make this Beacon an owner') && !!document.querySelector('input[placeholder="1234-5678"]')`), (v) => v === true, 5000)
  check(mk === 'clicked' && settings === true, 'the button opens Settings at "Make this Beacon an owner", with its code box')
  check((await click('[aria-label="Close"]')) === 'clicked', 'Settings closes')
  await until(() => evaluate(`!document.querySelector('input[placeholder="1234-5678"]')`), (v) => v === true, 3000)
  const denied = await click('.approval-btn-deny', 'w7')
  const gone = await until(() => view('w7'), (v) => !v.present, 5000)
  check(denied === 'clicked' && state.denies === 1 && !gone.present, 'Deny still works, and the card goes', `click=${denied} denies=${state.denies} present=${gone.present}`)

  // ── 4. a request Prometheus says nothing is waiting for ─────────────────────────────────────
  const g0 = await until(() => view('w9'), (v) => v.present, 6000)
  check(g0.present && g0.approve, 'a request that is answered "no pending request" looks ordinary at first')
  await sleep(1500)
  const gtry = await click('.approval-btn-approve', 'w9')
  check(gtry === 'clicked', `a real click on its Approve (${gtry})`)
  const gsaid = await until(() => view('w9'), (v) => /nothing is waiting for this answer/.test(v.text), 6000)
  check(state.approves.gho === 1, `one approve POST (${state.approves.gho})`)
  check(gsaid.present && /nothing is waiting for this answer any more/.test(gsaid.text), 'the card says nothing is waiting for it, and why it may be', gsaid.text.slice(0, 300))
  check(!gsaid.approve && gsaid.deny && gsaid.minimize && !gsaid.owner, 'Approve is gone (so it cannot be pressed eight times), Deny and Minimize stay, and no owner button: it is not that refusal')
  check(!gsaid.text.includes(APP_ONLY), 'and it does not say it can be approved only here')
  const gbanned = bannedHits(gsaid.text.replace(/edit_file targets[^\n]*/, '').replace(/path[\s\S]*plan\.md/, ''), WORDS)
  check(gbanned.length === 0, "the card's own words keep to the plain-language list", gbanned.join(', '))
  await sleep(7000)
  const gstay = await view('w9')
  check(gstay.present && /nothing is waiting/.test(gstay.text) && state.approves.gho === 1, 'across the polls that keep listing it the card stays as it is, and nothing more is sent')
  await pressKey('a', 'KeyA', 65)
  await sleep(400)
  check(state.approves.gho === 1, 'and A sends nothing')
  const gaway = await click('[data-testid="approval-minimize"]', 'w9')
  const gbadge = await until(() => view('w9'), (v) => !v.present && /1 request waiting/.test(v.badge ?? ''), 4000)
  check(gaway === 'clicked' && !gbadge.present, 'it can be put away to the badge, where it waits to expire')
} catch (e) {
  console.error(`  FATAL ${e instanceof Error ? e.message : e}`)
  failures += 1
} finally {
  gateway.close()
}
const MIN_CHECKS = 37
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected ${MIN_CHECKS}`)
  failures += 1
}
console.log(`\n${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures} of ${checks})`}\n`)
process.exit(failures === 0 ? 0 : 1)
