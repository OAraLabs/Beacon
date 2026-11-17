/**
 * home-approval-probe — the Home Assistant approval card, PAINTED, in the real built app, at a
 * 1512×944 window (docs/HA-UI-DATA-CONTRACT.md §3.1).
 *
 * home-approval-smoke pins the logic and reads the sources; it cannot prove the JSX renders. This
 * drives Electron over CDP, reads the live DOM and measures it.
 *
 * A FAKE GATEWAY serves made-up fixtures (src/shared/home-fixtures.ts, the same file the smoke
 * uses) on the REST port, so each payload travels the real path: fetch → rest.ts listApprovals() →
 * rawToApproval → IPC → MainView → HomeApprovalCard. It also plays the part of the daemon's
 * /api/home/actions/{id}: 404 for the first two seconds after an approval (the action has not run
 * yet), then the server's re-read. Nothing here talks to Home Assistant, and nothing here is real.
 *
 * Run: npm run build && npm run probe:home-approval   (macOS; needs a free REST port)
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import {
  BULK_EIGHT,
  CRITICAL_LOCK,
  ORDINARY_LIGHT,
  RESULT_CONFIRMED,
  RESULT_UNCONFIRMED,
  SENSITIVE_SCENE,
  UNKNOWN_CURRENT
} from '../src/shared/home-fixtures.ts'

const PORT = 8777
const WIDTH = 1512
const HEIGHT = 944
const shots = mkdtempSync(join(tmpdir(), 'beacon-home-approval-'))

const GENERIC = {
  request_id: 'generic-write',
  tool_name: 'write_file',
  description: 'write /home/demo/notes.txt',
  created_at: 1_790_000_000,
  extents: { always: 'write_file on exactly /home/demo/notes.txt — permanently, until revoked' },
  arguments: null
}

let pending = []
const answered = [] // { id, verb: 'approve'|'deny', body }
const approvedAt = new Map()
let listServed = 0
let capable = false // whether this fake Prometheus advertises home/1 on GET /api/status

const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = req.url ?? ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const act = url.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/)
    if (req.method === 'POST' && act) {
      answered.push({ id: act[1], verb: act[2], body })
      pending = pending.filter((p) => p.request_id !== act[1])
      if (act[2] === 'approve') approvedAt.set(act[1], Date.now())
      return res.end('{}')
    }
    if (url === '/api/status') return res.end(JSON.stringify({ state: 'idle', model: 'stub-model', capabilities: capable ? ['home/1'] : [] }))
    if (url.startsWith('/api/approvals') && req.method === 'GET') {
      listServed += 1
      const now = Math.floor(Date.now() / 1000)
      return res.end(JSON.stringify(pending.map((p) => ({ ...p, created_at: now - 3, expires_at: now + 1797 }))))
    }
    const result = url.match(/^\/api\/home\/actions\/([^/]+)$/)
    if (result) {
      const id = decodeURIComponent(result[1])
      const t = approvedAt.get(id)
      if (t === undefined || Date.now() - t < 2000) {
        res.statusCode = 404
        return res.end('{"error":"not_found"}')
      }
      const wire = id === 'home-unknown' ? { ...RESULT_CONFIRMED, request_id: id, results: [{ ...RESULT_CONFIRMED.results[0], device_id: 'dev-living-lamp', name: 'Living room lamp', message: 'Living room lamp is on' }] } : { ...RESULT_UNCONFIRMED, request_id: id }
      return res.end(JSON.stringify(wire))
    }
    res.statusCode = 404
    res.end('[]')
  })
})
await new Promise((r) => gateway.listen(PORT, '127.0.0.1', r))

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(PORT)
// A live socket, so the probe can push the daemon's frames (an approval answered somewhere else arrives as one).
const sockets = new Set()
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  sockets.add(ws)
  ws.on('close', () => sockets.delete(ws))
  ws.send(JSON.stringify({ type: 'connected' }))
})
await new Promise((r) => wsHttp.listen(0, '127.0.0.1', r))
const pushFrame = (frame) => sockets.forEach((ws) => ws.send(JSON.stringify(frame)))
process.env.BEACON_GATEWAY_WS_PORT = String(wsHttp.address().port)
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${join(shots, 'profile')}`.trim()

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
const until = async (fn, ms = 9000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await evaluate(fn).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(300)
  }
}
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s?.result?.data) writeFileSync(join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64'))
}
const press = async (key) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key })
}
const CARD = `document.querySelector('[data-testid="home-approval"]')`
const snap = (req) => `(() => {
  const c = document.querySelector('[data-testid="home-approval"][data-request="${req}"]')
  if (!c) return null
  const r = c.getBoundingClientRect()
  const q = (s) => c.querySelector(s)
  return {
    tier: c.dataset.tier,
    title: q('[data-testid="home-title"]')?.innerText,
    badge: q('[data-testid="home-tier"]')?.innerText.trim(),
    badgeHasGlyph: !!q('[data-testid="home-tier"] svg'),
    rows: [...c.querySelectorAll('[data-testid="home-row"]')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim()),
    more: q('[data-testid="home-more"]') ? { text: q('[data-testid="home-more"]').innerText.trim(), expanded: q('[data-testid="home-more"]').getAttribute('aria-expanded') } : null,
    approve: !!q('.approval-btn-approve'),
    deny: !!q('.approval-btn-deny'),
    disclosure: q('.approval-disclosure-head')?.innerText.trim() ?? null,
    options: [...c.querySelectorAll('.approval-scope-btn')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()),
    critical: q('[data-testid="home-critical-note"]')?.innerText.trim() ?? null,
    text: c.innerText,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }
  }
})()`
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`

await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

// ── 0. Home shows only when the Prometheus advertises it ─────────────────────
console.log('\n=== 0. the capability gate ===')
capable = false
pending = [ORDINARY_LIGHT]
const generic = await until(`(() => { const b = document.querySelector('.approval-btn-approve'); return b ? { home: !!document.querySelector('[data-testid="home-approval"]'), text: document.body.innerText.includes('Turn on Hall light') } : null })()`)
check(!!generic && generic.home === false && generic.text === true, 'a Home approval on a Prometheus that does not advertise Home is the generic card, with its description')
capable = true
const lit = await until(`(() => { const c = document.querySelector('[data-testid="home-approval"]'); return c ? c.dataset.request : null })()`, 15000)
check(lit === 'home-ordinary', 'when the Prometheus starts advertising Home, the same approval becomes the Home card')

// ── A. Ordinary: the common case ─────────────────────────────────────────────
console.log('\n=== A. one Ordinary light ===')
pending = [ORDINARY_LIGHT]
const a = await until(snap('home-ordinary'))
check(listServed > 0, 'the app fetched the fake gateway: the payload travelled the real REST path')
if (!a) {
  console.error(`  FATAL: the Home card never appeared.\n${mainLog.join('').slice(-1200)}`)
  gateway.close()
  process.exit(1)
}
check(a.tier === 'ordinary' && a.badge === 'Ordinary', `tier badge says the word (got "${a.badge}")`)
check(a.badgeHasGlyph, 'and carries a glyph, so colour is never the only signal')
check(a.title === 'Hall light', `title is the device (got "${a.title}")`)
check(a.rows.length === 1 && a.rows[0].includes('Hall light') && a.rows[0].includes('Hall') && a.rows[0].includes('off → on, 60%'), 'room and current → requested are shown', JSON.stringify(a.rows))
check(a.approve && a.deny, 'Approve once and Deny are there')
check(/Always allow/.test(a.disclosure ?? ''), `an Ordinary device offers "Always allow…" (got "${a.disclosure}")`)
check(a.options.length === 0, 'and its options are closed until opened: nothing that outlives the call is one click from Approve')
check(a.rect.bottom <= HEIGHT && a.rect.right <= WIDTH && a.rect.width <= 561, 'the card sits inside the 1512×944 window', JSON.stringify(a.rect))
await evaluate(click('[data-testid="home-approval"] .approval-disclosure-head'))
const a2 = await until(`(() => { const s = ${snap('home-ordinary')}; return s && s.options.length ? s : null })()`, 3000)
check(!!a2 && a2.options.length === 2, 'opening it lists the options')
check(!!a2 && a2.options.some((o) => o.includes('permanently, until revoked')), "each shows the daemon's own words for what it grants", JSON.stringify(a2?.options))
await shot('ordinary')

await evaluate(click('[data-testid="home-approval"] .approval-btn-approve'))
await sleep(600)
check(answered.length === 1 && answered[0].verb === 'approve' && answered[0].body.includes('"once"'), 'Approve once posts scope "once"', JSON.stringify(answered))
check((await evaluate(`document.querySelectorAll('[data-testid="home-answered"]').length`)) === 0, 'a card answered here never becomes "answered elsewhere"')
const waiting = await until(`document.querySelector('[data-testid="home-result"]') ? document.querySelector('[data-testid="home-result"]').innerText : null`, 4000)
check(!!waiting && /Waiting for Home Assistant/.test(waiting), 'the card becomes a result card that says it is waiting, not done', waiting ?? '')
const warn = await until(`(() => { const l = document.querySelector('[data-testid="home-result-line"]'); return l ? { glyph: l.dataset.glyph, text: l.innerText.replace(/\\s+/g, ' ') } : null })()`, 12000)
check(!!warn && warn.glyph === 'warn', 'the server\'s re-read says the light still reports off: a WARNING', JSON.stringify(warn))
check(!!warn && /Not confirmed/.test(warn.text) && /still reports off/.test(warn.text), 'it says "Not confirmed" and the server\'s sentence', warn?.text ?? '')
await shot('warning')

// ── a confirmed result looks different ───────────────────────────────────────
pending = [UNKNOWN_CURRENT]
const u = await until(snap('home-unknown'))
check(!!u && u.rows[0]?.includes('current state unknown → on'), 'an unreadable current state says "current state unknown"', JSON.stringify(u?.rows))
await evaluate(click('[data-testid="home-approval"][data-request="home-unknown"] .approval-btn-approve'))
const ok = await until(`(() => { const ls = [...document.querySelectorAll('[data-testid="home-result-line"]')]; const l = ls.find((x) => x.innerText.includes('Living room lamp is on')); return l ? { glyph: l.dataset.glyph, text: l.innerText.replace(/\\s+/g, ' ') } : null })()`, 12000)
check(!!ok && ok.glyph === 'check' && /Confirmed/.test(ok.text), 'a confirmed re-read shows a check and "Confirmed"', JSON.stringify(ok))
check(!!warn && !!ok && warn.glyph !== ok.glyph && !warn.text.startsWith(ok.text.split(' ')[0]), 'the warning and the success are visibly different')
await shot('confirmed')
await evaluate(`[...document.querySelectorAll('[data-testid="home-result"] button[aria-label="Dismiss"]')].forEach((b) => b.click()); true`)
check(!!(await until(`document.querySelectorAll('[data-testid="home-result"]').length === 0`, 3000)), 'Dismiss clears the result cards')

// ── B. Sensitive ─────────────────────────────────────────────────────────────
console.log('\n=== B. a Sensitive scene ===')
pending = [SENSITIVE_SCENE]
const s = await until(snap('home-sensitive'))
check(!!s && s.badge === 'Sensitive' && s.badgeHasGlyph, `badge is the word Sensitive with a glyph (got "${s?.badge}")`)
check(!!s && s.approve && s.deny, 'Approve once and Deny')
check(!!s && s.disclosure === null && s.options.length === 0, 'no "Always allow" on a Sensitive device that is asked every time')
check(!!s && /Ask once/.test(s.text), 'a line says how to be offered it ("Ask once")')
check(!!s && /Scenes always ask/.test(s.text), "the daemon's reason is shown")
check(!!s && s.rows[0]?.includes('current state unknown → activated'), 'unknown current state', JSON.stringify(s?.rows))

// ── C. Bulk ──────────────────────────────────────────────────────────────────
console.log('\n=== C. a bulk call of 8 ===')
pending = [BULK_EIGHT]
const c = await until(snap('home-bulk'))
check(!!c && c.title === '8 devices', `title counts them (got "${c?.title}")`)
check(!!c && c.rows.length === 5, `5 rows shown (got ${c?.rows.length})`)
check(!!c && c.more?.text === 'and 3 more' && c.more.expanded === 'false', 'with "and 3 more", collapsed', JSON.stringify(c?.more))
await evaluate(click('[data-testid="home-more"]'))
const c2 = await until(`(() => { const s = ${snap('home-bulk')}; return s && s.rows.length === 8 ? s : null })()`, 3000)
check(!!c2, 'clicking it lists all 8')
check(!!c2 && c2.more?.expanded === 'true' && c2.more.text === 'Show fewer', 'and it says it is open, offering "Show fewer"')
check(!!c2 && c2.rows.some((r) => r.includes('current state unknown')), 'a device whose state could not be read says so inside the list')
check(!!c2 && c2.rect.bottom <= HEIGHT, 'all 8 fit inside the window', JSON.stringify(c2?.rect))
await shot('bulk')

// ── D. Critical ──────────────────────────────────────────────────────────────
console.log('\n=== D. Critical ===')
answered.length = 0
pending = [CRITICAL_LOCK]
const k = await until(snap('home-critical'))
check(!!k && k.badge === 'Critical' && k.badgeHasGlyph, `badge is the word Critical with a glyph (got "${k?.badge}")`)
check(!!k && !k.approve && k.deny, 'no Approve at all, only Deny')
check(!!k && k.disclosure === null && k.options.length === 0, 'and no lasting option, though the fixture offered extents')
check(!!k && /can't be controlled/.test(k.critical ?? ''), 'a sentence says why', k?.critical ?? '')
await press('a')
await sleep(500)
check(answered.length === 0, 'the A key does not approve a Critical call')
await shot('critical')
await press('d')
await sleep(800)
check(answered.length === 1 && answered[0].verb === 'deny', 'the D key still denies', JSON.stringify(answered))

// ── E. nothing else changed ──────────────────────────────────────────────────
console.log('\n=== E. an ordinary approval is untouched ===')
pending = [GENERIC]
const g = await until(`(() => { const b = document.querySelector('.approval-btn-approve'); return b && !document.querySelector('[data-testid="home-approval"]') ? document.body.innerText.includes('write_file') : null })()`)
check(g === true, 'a non-Home approval still gets the generic card')

// ── F. answered somewhere else ───────────────────────────────────────────────
console.log('\n=== F. answered somewhere else ===')
// The earlier scenarios swapped one pending approval for another, which is exactly an answer from elsewhere: those cards are here too.
await evaluate(`document.querySelectorAll('[data-testid="home-answered"] button[aria-label="Dismiss"]').forEach((b) => b.click()); true`)
const away = { ...ORDINARY_LIGHT, request_id: 'home-away' }
pending = [away]
await until(snap('home-away'))
pending = []
pushFrame({ type: 'approval_resolved', payload: { request_id: 'home-away', resolution: 'approved', answered_on: 'Telegram' } })
const ans = await until(`(() => { const c = document.querySelector('[data-testid="home-answered"][data-request="home-away"]'); return c ? { title: c.querySelector('[data-testid="home-answered-title"]').innerText, text: c.innerText.replace(/\\s+/g, ' '), buttons: [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.innerText.trim()), live: !!document.querySelector('[data-testid="home-approval"]') } : null })()`, 8000)
check(!!ans && ans.title === 'Answered on Telegram' && /It was approved\./.test(ans.text), 'a card answered on Telegram says "Answered on Telegram" and what the answer was', JSON.stringify(ans))
check(!!ans && ans.buttons.join() === 'Dismiss' && ans.live === false, 'and its buttons are gone: only Dismiss is left, and no live Home card remains')
await evaluate(`document.querySelector('[data-testid="home-answered"][data-request="home-away"] button[aria-label="Dismiss"]')?.click(); true`)
check(!!(await until(`!document.querySelector('[data-testid="home-answered"][data-request="home-away"]')`, 3000)), 'Dismiss clears it')
await sleep(7000) // two polls: a poll that was in flight must not bring a second card back
check((await evaluate(`!document.querySelector('[data-testid="home-answered"][data-request="home-away"]')`)) === true, 'and it stays cleared')
const gone = { ...ORDINARY_LIGHT, request_id: 'home-gone' }
pending = [gone]
await until(snap('home-gone'))
pending = [] // no frame this time: the poll notices first
const noframe = await until(`(() => { const c = document.querySelector('[data-testid="home-answered"][data-request="home-gone"]'); return c ? c.querySelector('[data-testid="home-answered-title"]').innerText : null })()`, 9000)
check(noframe === 'Answered elsewhere', 'a card that left with no frame to explain it says "Answered elsewhere" and claims nothing more', noframe ?? '')
await shot('answered')
await evaluate(`document.querySelectorAll('[data-testid="home-answered"] button[aria-label="Dismiss"]').forEach((b) => b.click()); true`)

const MIN_CHECKS = 47
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
gateway.close()
console.log(`\n[probe] screenshots in ${shots}`)
console.log(`${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
