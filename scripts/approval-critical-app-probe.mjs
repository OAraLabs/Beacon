#!/usr/bin/env node
// approval-critical-app-probe — what an approval NOTIFICATION offers, IN THE REAL APP, against a
// stand-in Prometheus on loopback that does, and then does not, advertise `approval_critical` in
// its `subscribed` reply. First, in the window: a critical request is approved from its full card
// and nowhere else, and the A and D keys act only while focus is on the cards. Then notifications. It pushes approval requests over the socket and reads the notifications
// main makes: a critical request has no buttons and says to answer it in Beacon; an ordinary one
// keeps Approve and Deny; and a Prometheus that advertises nothing behaves as it always did.
//
//   npm run build && npm run probe:approval-critical
//
// Its own scratch profile and stand-in daemon; the user's profile and Prometheus are not touched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver, and notification buttons are a macOS thing)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

// ── the stand-in Prometheus ───────────────────────────────────────────────────────────────────
const daemon = { advertises: true, sockets: new Set(), resolved: [], polled: [], polls: 0, pending: new Map() }
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (req.method === 'POST' && /^\/api\/approvals\/[^/]+\/(approve|deny)$/.test(url)) {
      daemon.resolved.push(url)
      // As the daemon does: the request stops being pending, and every client is told.
      const id = url.split('/')[3]
      daemon.pending.delete(id)
      for (const ws of daemon.sockets) ws.send(JSON.stringify({ type: 'approval_resolved', timestamp: Date.now() / 1000, payload: { request_id: id, resolution: url.endsWith('/approve') ? 'approved' : 'denied' } }))
      return json(res, 200, { ok: true })
    }
    if (url === '/api/hello') return json(res, 200, { v: '0.9.21', name: 'Stand-in', agent: 'Atlas', fp: 'd'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/approvals') {
      daemon.polls++
      return json(res, 200, [...daemon.pending.values(), ...daemon.polled]) // what is pending, and requests found by the poll alone
    }
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  daemon.sockets.add(ws)
  ws.on('close', () => daemon.sockets.delete(ws))
  ws.on('message', (m) => {
    let f = null
    try {
      f = JSON.parse(m.toString())
    } catch {
      return
    }
    // The reply to the subscribe frame, shaped as the daemon sends it.
    if (f?.type === 'subscribe') {
      ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: f.payload?.capabilities ?? [], server_capabilities: daemon.advertises ? ['voice_input', 'approval_critical'] : ['voice_input'], channels: [] } }))
      daemon.subscribes = (daemon.subscribes ?? 0) + 1
    }
  })
  ws.send(JSON.stringify({ type: 'connected' }))
})
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const push = (request, { stays = false } = {}) => {
  const now = Date.now() / 1000
  const payload = { tool_name: 'bash', created_at: now, expires_at: now + 1800, extents: {}, arguments: null, ...request }
  // `stays`: pending until answered, so the page's poll keeps finding it and its card stays up.
  if (stays) daemon.pending.set(payload.request_id, payload)
  for (const ws of daemon.sockets) ws.send(JSON.stringify({ type: 'approval_pending', timestamp: now, payload }))
}

const profile = mkdtempSync(join(tmpdir(), 'beacon-approval-critical-profile-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('standin', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])

let app = null
try {
  app = await launchApp({ profile })
  const ev = app.page.evaluate
  const until = async (fn, pred, ms = 6000) => {
    let v
    for (let t = 0; t < ms; t += 100) {
      v = await fn()
      if (pred(v)) return v
      await sleep(100)
    }
    return v
  }
  check((await until(() => ev(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)) === 'connected', 'connected to the stand-in Prometheus')
  check((await until(async () => daemon.subscribes ?? 0, (v) => v >= 1)) >= 1, 'Beacon subscribed, and was told what this Prometheus does')

  // ── in the window: a critical request is approved from its full card and nowhere else ───────
  const CARD = (id) => `document.querySelector('[data-approval-id="${id}"]')`
  const key = async (k, code, vk, held = false) => {
    await app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, autoRepeat: held })
    await app.page.send('Input.dispatchKeyEvent', { type: 'char', key: k, code, windowsVirtualKeyCode: vk, text: k })
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  }
  const clickAt = async (expr) => {
    const r = await ev(`(() => { const el = ${expr}; if (!el) return null; const q = el.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
    if (!r) return false
    await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    return true
  }
  const answers = (id) => daemon.resolved.filter((u) => u.includes(`/${id}/`)).map((u) => u.split('/').pop())
  // The short rows: Mission's "needs you" list (a profile that already has a Prometheus opens in the full view).
  const ROWBTN = `[...document.querySelectorAll('[data-testid^="approval-row-"]')]`
  const rowButtons = () => ev(`(() => { const b = ${ROWBTN}[0]; return b ? [...b.parentElement.querySelectorAll('button')].map((x) => x.textContent.trim()) : [] })()`)
  const titles = await ev(`[...document.querySelectorAll('nav[aria-label="Views"] > button')].map((x) => x.title)`)
  await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => /^(Mission|Today)/.test(x.title)); b?.click(); return !!b })()`)
  console.log(`[probe] views: ${titles.join(', ')}`)

  push({ request_id: 'k-ord', description: 'List the files in the project folder', critical: false }, { stays: true })
  check((await until(() => ev(`!!${CARD('k-ord')}`), (v) => v === true)) === true, 'an ordinary request brings up its card')
  check((await ev(`${CARD('k-ord')}.dataset.critical`)) === 'no' && (await ev(`!!${CARD('k-ord')}.querySelector('[data-testid="approval-critical-note"]')`)) === false, 'not marked critical')
  check((await until(rowButtons, (v) => v.includes('Approve once'))).join() === 'Approve once,Deny', 'its short row offers Approve once and Deny, as before', (await rowButtons()).join())
  // A stray keystroke: focus is on the page, not on the cards.
  await ev(`(document.activeElement?.blur?.(), document.body.focus(), true)`)
  check((await ev(`${CARD('k-ord')}.dataset.keysLive`)) === 'no' && /Click this card, or Tab to it, to answer with A or D/.test(await ev(`${CARD('k-ord')}.innerText`)), 'with focus elsewhere the card says to click it to use the keys, and shows no key hints')
  await key('a', 'KeyA', 65)
  await key('d', 'KeyD', 68)
  await sleep(500)
  check(answers('k-ord').length === 0 && (await ev(`!!${CARD('k-ord')}`)) === true, 'A and D typed with focus anywhere else in the window answer nothing')
  const onRow = await ev(`(() => { const b = ${ROWBTN}[0]; b?.focus(); return !!b && document.activeElement === b })()`)
  await key('a', 'KeyA', 65)
  await sleep(400)
  check(onRow === true && answers('k-ord').length === 0, 'nor with focus on a button outside the cards (the Approve on the short row)')
  // The person puts focus on the cards: a click on the card.
  check(await clickAt(`${CARD('k-ord')}.querySelector('div')`), 'clicked the card')
  check((await until(() => ev(`${CARD('k-ord')}.dataset.keysLive`), (v) => v === 'yes', 2000)) === 'yes' && / A/.test(await ev(`[...${CARD('k-ord')}.querySelectorAll('button')].map((b) => b.textContent).join('|')`)), 'now focus is on the card, and the key hints are shown')
  // A second ordinary request stacks under it. Focus is on the first card.
  push({ request_id: 'k-ord2', description: 'Read the project notes', critical: false }, { stays: true })
  await until(() => ev(`!!${CARD('k-ord2')}`), (v) => v === true)
  await key('a', 'KeyA', 65, true)
  await sleep(400)
  check(answers('k-ord').length === 0 && answers('k-ord2').length === 0, 'a held A (a repeat) answers nothing')
  await key('a', 'KeyA', 65)
  check((await until(async () => answers('k-ord'), (v) => v.length > 0, 4000)).join() === 'approve', 'and A approves the ordinary request, once', answers('k-ord').join())
  check((await until(() => ev(`!!${CARD('k-ord')}`), (v) => v === false, 5000)) === false, 'its card goes away')
  // The card under it is now the first, and focus is not on it.
  await key('a', 'KeyA', 65)
  await key('a', 'KeyA', 65)
  await sleep(500)
  check(answers('k-ord2').length === 0 && (await ev(`${CARD('k-ord2')}.dataset.keysLive`)) === 'no', 'the next card is not answered by A pressed again: focus was on the card that left, not on this one')
  await clickAt(`${CARD('k-ord2')}.querySelector('div')`)
  await until(() => ev(`${CARD('k-ord2')}.dataset.keysLive`), (v) => v === 'yes', 2000)
  await key('d', 'KeyD', 68)
  check((await until(async () => answers('k-ord2'), (v) => v.length > 0, 4000)).join() === 'deny', 'clicked, it is the one D denies', answers('k-ord2').join())
  await until(() => ev(`!!${CARD('k-ord2')}`), (v) => v === false, 5000)

  push({ request_id: 'k-crit', description: 'git push origin main', critical: true }, { stays: true })
  check((await until(() => ev(`${CARD('k-crit')}?.dataset.critical ?? null`), (v) => v !== null)) === 'yes', 'a critical request brings up its card, marked critical')
  check(/This request can be approved only here, with the button/.test(await ev(`${CARD('k-crit')}.innerText`)), 'the card says it can be approved only there')
  const critRow = await until(rowButtons, (v) => v.includes('Answer on the card'))
  check(critRow.join() === 'Answer on the card,Deny' && (await ev(`document.querySelectorAll('[data-testid="approval-row-approve"]').length`)) === 0, 'its short row has no Approve: it offers "Answer on the card", and Deny', critRow.join())
  await ev(`(() => { document.querySelector('[data-testid="approval-row-show"]').click(); return true })()`)
  check((await until(() => ev(`${CARD('k-crit')}.dataset.keysLive`), (v) => v === 'yes', 2000)) === 'yes' && (await ev(`document.activeElement === ${CARD('k-crit')}`)) === true && answers('k-crit').length === 0, '"Answer on the card" puts focus on that request\'s card and answers nothing')
  check(!/ A$/.test(await ev(`[...${CARD('k-crit')}.querySelectorAll('button')].find((b) => /Approve once/.test(b.textContent)).textContent`)), 'the Approve button on a critical card shows no A')
  await key('a', 'KeyA', 65)
  await key('A', 'KeyA', 65)
  await sleep(500)
  check(answers('k-crit').length === 0 && (await ev(`!!${CARD('k-crit')}`)) === true, 'with focus on the cards, A still does not approve a critical request')
  await ev(`(() => { [...${CARD('k-crit')}.querySelectorAll('button')].find((b) => /Approve once/.test(b.textContent)).click(); return true })()`)
  check((await until(async () => answers('k-crit'), (v) => v.length > 0, 4000)).join() === 'approve', 'its own button approves it', answers('k-crit').join())
  await until(() => ev(`!!${CARD('k-crit')}`), (v) => v === false, 5000)

  push({ request_id: 'k-crit2', description: 'rm -rf build', critical: true }, { stays: true })
  await until(() => ev(`!!${CARD('k-crit2')}`), (v) => v === true)
  check((await ev(`${CARD('k-crit2')}.dataset.keysLive`)) === 'no' && (await ev(`!!document.activeElement?.closest('[data-approval-id]')`)) === false, 'a new card appearing does not take the focus: the keys are off until the person goes to it')
  await key('d', 'KeyD', 68)
  await sleep(400)
  check(answers('k-crit2').length === 0, 'so D typed then answers nothing')
  await clickAt(`${CARD('k-crit2')}.querySelector('div')`)
  await until(() => ev(`${CARD('k-crit2')}.dataset.keysLive`), (v) => v === 'yes', 2000)
  await key('d', 'KeyD', 68)
  check((await until(async () => answers('k-crit2'), (v) => v.length > 0, 4000)).join() === 'deny', 'with focus on the cards, D denies a critical request', answers('k-crit2').join())
  await until(() => ev(`!!${CARD('k-crit2')}`), (v) => v === false, 5000)

  // A request that does not say, from this Prometheus (it advertises the flag): card-only too.
  push({ request_id: 'k-silent', description: 'A request that does not say either way' }, { stays: true })
  check((await until(() => ev(`${CARD('k-silent')}?.dataset.critical ?? null`), (v) => v !== null)) === 'yes' && (await until(rowButtons, (v) => v.length > 0)).join() === 'Answer on the card,Deny', 'a request that does not say, from a Prometheus that advertises the flag, is card-only as well')
  await ev(`(() => { [...${CARD('k-silent')}.querySelectorAll('button')].find((b) => /^Deny/.test(b.textContent)).click(); return true })()`)
  await until(() => ev(`!!${CARD('k-silent')}`), (v) => v === false, 5000)
  const answeredInWindow = daemon.resolved.length
  check(answeredInWindow === 5, 'five answers in all, each one made on purpose', daemon.resolved.join(' '))

  // Watch the notifications main makes, and keep them off the screen. A focused window gets no
  // approval notification at all (the card is the surface), so the window is hidden for the run.
  const watching = await app.mainEval(`(() => { globalThis.__notes = []; const P = __electron.Notification.prototype; P.show = function () { globalThis.__notes.push({ title: this.title, body: this.body, actions: (this.actions ?? []).map((a) => a.text) }) }; for (const w of __electron.BrowserWindow.getAllWindows()) w.hide(); return __electron.Notification.isSupported() && __electron.BrowserWindow.getAllWindows().every((w) => !w.isFocused()) })()`)
  check(watching === true, 'the probe can see the notifications main makes, and no Beacon window has the focus')
  const notes = () => app.mainEval(`globalThis.__notes.slice()`)
  const next = async (n) => (await until(notes, (v) => v.length >= n, 5000))[n - 1]
  const IN_APP = / — answer it in Beacon$/

  // ── a Prometheus that advertises the flag ───────────────────────────────────────────────────
  push({ request_id: 'ordinary-1', description: 'List the files in the project folder', critical: false })
  const a = await next(1)
  check(a && a.actions.join() === 'Approve,Deny' && !IN_APP.test(a.body), 'an ordinary request keeps Approve and Deny on its notification', JSON.stringify(a))
  push({ request_id: 'critical-1', description: 'git push origin main', critical: true })
  const b = await next(2)
  check(b && b.actions.length === 0, 'a critical request has no Approve (and no Deny) on its notification', JSON.stringify(b))
  check(b && IN_APP.test(b.body) && b.body.includes('git push origin main'), 'and says what is asked and to answer it in Beacon', b?.body)
  push({ request_id: 'silent-1', description: 'A request that does not say either way' })
  const c = await next(3)
  check(c && c.actions.length === 0 && IN_APP.test(c.body), 'a request that does not say, from a Prometheus that promised every request would, is treated as critical', JSON.stringify(c))
  push({ request_id: 'odd-1', description: 'A request whose flag is a word', critical: 'false' })
  const d = await next(4)
  check(d && d.actions.length === 0, 'so is one whose flag is not a plain true or false', JSON.stringify(d))
  push({ request_id: 'critical-1', description: 'git push origin main', critical: false })
  await sleep(600)
  check((await notes()).length === 4, 'a second frame for a request already notified makes no second notification (and cannot swap in buttons)')
  check(daemon.resolved.length === answeredInWindow, 'nothing was answered by any of that')

  // ── the same address, now an older Prometheus: the socket drops, the next reply advertises nothing ──
  daemon.advertises = false
  const before = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  check((await until(async () => daemon.subscribes, (v) => v > before, 20000)) > before, 'Beacon reconnected and subscribed again')
  await sleep(300)
  push({ request_id: 'old-1', description: 'A request from a Prometheus that knows no flag' })
  const e = await next(5)
  check(e && e.actions.join() === 'Approve,Deny' && !IN_APP.test(e.body), 'with nothing advertised, a request that does not say behaves as it always did: Approve and Deny', JSON.stringify(e))
  push({ request_id: 'old-2', description: 'rm -rf build', critical: true })
  const f = await next(6)
  check(f && f.actions.length === 0 && IN_APP.test(f.body), 'a plain critical: true is still honoured (only a Prometheus that knows the flag sends it)', JSON.stringify(f))

  // ── found by the poll, not pushed: the other way a request reaches a notification ───────────
  const now = Date.now() / 1000
  const polledAt = daemon.polls
  daemon.polled = [{ request_id: 'polled-1', tool_name: 'message', description: 'Send the report to the whole team', created_at: now, expires_at: now + 1800, extents: {}, arguments: null, critical: true }]
  const viaPoll = (await until(notes, (v) => v.length >= 7, 15000))[6]
  if (daemon.polls === polledAt) check(false, 'the page polled for approvals while the window was hidden (without that this path is not covered here)')
  else check(viaPoll && viaPoll.actions.length === 0 && IN_APP.test(viaPoll.body) && viaPoll.body.includes('Send the report'), 'a critical request found by the poll, with no frame, has no buttons either', JSON.stringify(viaPoll))
  daemon.polled = []

  // ── and back: advertised again on the next connection ──────────────────────────────────────
  daemon.advertises = true
  const again = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > again, 20000)
  await sleep(300)
  push({ request_id: 'silent-2', description: 'Another request that does not say' })
  const g = await next(8)
  check(g && g.actions.length === 0, 'advertised again on the next connection, a request that does not say is critical again', JSON.stringify(g))
  check(daemon.resolved.length === answeredInWindow, 'and no notification answered anything')
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
