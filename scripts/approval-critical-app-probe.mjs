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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const daemon = { advertises: true, silent: true, sockets: new Set(), resolved: [], polled: [], polls: 0, pending: new Map() }
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (req.method === 'POST' && /^\/api\/approvals\/k-worker\/approve$/.test(url)) {
      // As the daemon answers a worker's request approved without a person's credential: it stays pending.
      daemon.refusedWorker = (daemon.refusedWorker ?? 0) + 1
      return json(res, 401, { error: 'worker requests need a person to approve them', code: 'not_a_person' })
    }
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
    if (f?.type === 'subscribe' && daemon.silent) {
      daemon.subscribes = (daemon.subscribes ?? 0) + 1 // a Prometheus too old to reply
      return
    }
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
  // An approve within half a second of the stack of cards changing is ignored (APPROVAL_SETTLE_MS),
  // and the stack can change once more after a push or an answer, when the page's next poll lands
  // (a poll already on its way can briefly disagree with the frames). So: let one fresh poll land,
  // then let the half second pass.
  const settle = async () => {
    const seen = daemon.polls
    await until(async () => daemon.polls, (v) => v > seen + 1, 8000)
    await sleep(700)
  }
  const answers = (id) => daemon.resolved.filter((u) => u.includes(`/${id}/`)).map((u) => u.split('/').pop())
  // The short rows: Mission's "needs you" list (a profile that already has a Prometheus opens in the full view).
  const ROWBTN = `[...document.querySelectorAll('[data-testid^="approval-row-"]')]`
  const rowButtons = () => ev(`(() => { const b = ${ROWBTN}[0]; return b ? [...b.parentElement.querySelectorAll('button')].map((x) => x.textContent.trim()) : [] })()`)
  const titles = await ev(`[...document.querySelectorAll('nav[aria-label="Views"] > button')].map((x) => x.title)`)
  await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => /^(Mission|Today)/.test(x.title)); b?.click(); return !!b })()`)
  console.log(`[probe] views: ${titles.join(', ')}`)

  // ── first, a Prometheus that never replies to subscribe (one too old to) ────────────────────
  // Until it has had a few seconds of connected silence, Beacon does not know what it supports,
  // and a request that does not say is answered on its card. After that it is an ordinary one.
  const connectedAt = Date.now()
  push({ request_id: 'k-old', description: 'A request from a Prometheus that says nothing' }, { stays: true })
  const early = await until(() => ev(`${CARD('k-old')}?.dataset.critical ?? null`), (v) => v !== null)
  if (Date.now() - connectedAt < 3500) check(early === 'yes', 'in the first seconds, before it is known what this Prometheus supports, a request that does not say is card-only')
  else console.log('[probe] note: the app took too long to show the first card to observe the unknown window')
  const settled = await until(() => ev(`${CARD('k-old')}?.dataset.critical ?? null`), (v) => v === 'no', 10000)
  check(settled === 'no' && (await ev(`window.beacon.connection.status().then((s) => s.approvalCritical)`)) === false, 'after a few seconds of connected silence it is an ordinary request: this Prometheus is taken not to mark requests')
  check((await until(rowButtons, (v) => v.includes('Approve once'))).join() === 'Approve once,Deny', 'its short row offers Approve once, as it always did', (await rowButtons()).join())
  await clickAt(`${CARD('k-old')}.querySelector('div')`)
  await until(() => ev(`${CARD('k-old')}.dataset.keysLive`), (v) => v === 'yes', 2000)
  await key('a', 'KeyA', 65)
  check((await until(async () => answers('k-old'), (v) => v.length > 0, 4000)).join() === 'approve', 'and A, with focus on its card, approves it', answers('k-old').join())
  await until(() => ev(`!!${CARD('k-old')}`), (v) => v === false, 5000)
  await settle()
  // ── what the person sees when main refuses ─────────────────────────────────────────────────
  // The one way the window and main can disagree: a frame said critical, then the poll row for the
  // same request carries no flag. This Prometheus advertises nothing, so the window reads the row
  // as ordinary and its short row offers Approve; main remembers what the frame said.
  await settle()
  const nowS = Date.now() / 1000
  const row = { request_id: 'k-disagree', tool_name: 'bash', description: 'git push --force origin main', created_at: nowS, expires_at: nowS + 1800, extents: {}, arguments: null }
  for (const ws of daemon.sockets) ws.send(JSON.stringify({ type: 'approval_pending', timestamp: nowS, payload: { ...row, critical: true } }))
  daemon.pending.set('k-disagree', row) // the poll's copy: no flag
  await until(() => ev(`!!${CARD('k-disagree')}`), (v) => v === true)
  const rowApprove = await until(() => ev(`!!document.querySelector('[data-testid="approval-row-approve"]')`), (v) => v === true, 8000)
  check(rowApprove === true, 'the window, going by the poll row, offers Approve once on the short row')
  await settle()
  await ev(`(() => { document.querySelector('[data-testid="approval-row-approve"]').click(); return true })()`)
  const shown = await until(() => ev(`${CARD('k-disagree')}?.innerText ?? ''`), (v) => /can be approved only on its card/.test(v), 2500)
  check(/This request can be approved only on its card in Beacon, with the Approve button\. Nothing was approved\./.test(shown) && answers('k-disagree').length === 0, 'main refuses it, Prometheus is not asked, and the card is back within moments saying why', shown.replace(/\n/g, ' | ').slice(-200))
  check(!/Error invoking remote method|approval:resolve/.test(shown), 'in plain words, without the plumbing')
  await settle()
  await clickAt(`[...${CARD('k-disagree')}.querySelectorAll('button')].find((b) => /^Approve once/.test(b.textContent))`)
  check((await until(async () => answers('k-disagree'), (v) => v.length > 0, 4000)).join() === 'approve', "and the card's own Approve button approves it", answers('k-disagree').join())
  await until(() => ev(`!!${CARD('k-disagree')}`), (v) => v === false, 5000)
  await settle()

  // ── a double-click cannot approve the next card ─────────────────────────────────────────────
  push({ request_id: 'k-dbl1', description: 'List the downloads folder' }, { stays: true })
  push({ request_id: 'k-dbl2', description: 'Delete the downloads folder' }, { stays: true })
  await until(() => ev(`!!${CARD('k-dbl1')} && !!${CARD('k-dbl2')}`), (v) => v === true)
  await settle()
  const first = await ev(`(() => { const b = [...${CARD('k-dbl1')}.querySelectorAll('button')].find((x) => /^Approve once/.test(x.textContent)); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
  for (const n of [1, 2]) {
    await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: n })
    await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: first.x, y: first.y, button: 'left', clickCount: n })
    await sleep(150)
  }
  await sleep(800)
  check(answers('k-dbl1').join() === 'approve' && answers('k-dbl2').length === 0 && (await ev(`!!${CARD('k-dbl2')}`)) === true, 'a double-click on Approve approves the first request only: the card that slid under the pointer is not answered')
  await settle()
  await ev(`(() => { [...${CARD('k-dbl2')}.querySelectorAll('button')].find((b) => /^Deny/.test(b.textContent)).click(); return true })()`)
  await until(() => ev(`!!${CARD('k-dbl2')}`), (v) => v === false, 5000)
  await settle()

  // The Prometheus at this address is upgraded: the next connection gets a reply, and it is believed at once.
  daemon.silent = false
  const subs0 = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > subs0, 20000)
  check((await until(() => ev(`window.beacon.connection.status().then((s) => s.approvalCritical)`), (v) => v === true, 5000)) === true, 'upgraded to one that replies and advertises the flag, it is believed at once')

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
  check((await until(() => ev(`${CARD('k-ord')}.dataset.keysLive`), (v) => v === 'yes', 2000)) === 'yes' && /A approves once, D denies/.test(await ev(`${CARD('k-ord')}.innerText`)), 'now focus is on the card, and it says what the keys do')
  // A second ordinary request stacks under it. Focus is on the first card.
  push({ request_id: 'k-ord2', description: 'Read the project notes', critical: false }, { stays: true })
  await until(() => ev(`!!${CARD('k-ord2')}`), (v) => v === true)
  await settle()
  await key('a', 'KeyA', 65, true)
  await sleep(400)
  check(answers('k-ord').length === 0 && answers('k-ord2').length === 0, 'a held A (a repeat) answers nothing')
  await key('a', 'KeyA', 65)
  check((await until(async () => answers('k-ord'), (v) => v.length > 0, 4000)).join() === 'approve', 'and A approves the ordinary request, once', answers('k-ord').join())
  check((await until(() => ev(`!!${CARD('k-ord')}`), (v) => v === false, 5000)) === false, 'its card goes away')
  await settle()
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
  await settle()

  push({ request_id: 'k-crit', description: 'git push origin main', critical: true }, { stays: true })
  check((await until(() => ev(`${CARD('k-crit')}?.dataset.critical ?? null`), (v) => v !== null)) === 'yes', 'a critical request brings up its card, marked critical')
  check(/This request can be approved only here, with the button/.test(await ev(`${CARD('k-crit')}.innerText`)), 'the card says it can be approved only there')
  const critRow = await until(rowButtons, (v) => v.includes('Answer on the card'))
  check(critRow.join() === 'Answer on the card,Deny' && (await ev(`document.querySelectorAll('[data-testid="approval-row-approve"]').length`)) === 0, 'its short row has no Approve: it offers "Answer on the card", and Deny', critRow.join())
  await ev(`(() => { document.querySelector('[data-testid="approval-row-show"]').click(); return true })()`)
  check((await until(() => ev(`${CARD('k-crit')}.dataset.keysLive`), (v) => v === 'yes', 2000)) === 'yes' && (await ev(`document.activeElement === ${CARD('k-crit')}`)) === true && answers('k-crit').length === 0, '"Answer on the card" puts focus on that request\'s card and answers nothing')
  check(/D denies\./.test(await ev(`${CARD('k-crit')}.querySelector('[data-testid="approval-keys-hint"]').textContent`)) && !/A approves/.test(await ev(`${CARD('k-crit')}.innerText`)), 'a critical card with focus says D denies, and never that A approves')
  await key('a', 'KeyA', 65)
  await key('A', 'KeyA', 65)
  await sleep(500)
  check(answers('k-crit').length === 0 && (await ev(`!!${CARD('k-crit')}`)) === true, 'with focus on the cards, A still does not approve a critical request')
  await ev(`(() => { [...${CARD('k-crit')}.querySelectorAll('button')].find((b) => /Approve once/.test(b.textContent)).click(); return true })()`)
  check((await until(async () => answers('k-crit'), (v) => v.length > 0, 4000)).join() === 'approve', 'its own button approves it', answers('k-crit').join())
  await until(() => ev(`!!${CARD('k-crit')}`), (v) => v === false, 5000)
  await settle()

  push({ request_id: 'k-crit2', description: 'rm -rf build', critical: true }, { stays: true })
  await until(() => ev(`!!${CARD('k-crit2')}`), (v) => v === true)
  await settle()
  check((await ev(`${CARD('k-crit2')}.dataset.keysLive`)) === 'no' && (await ev(`!!document.activeElement?.closest('[data-approval-id]')`)) === false, 'a new card appearing does not take the focus: the keys are off until the person goes to it')
  await key('d', 'KeyD', 68)
  await sleep(400)
  check(answers('k-crit2').length === 0, 'so D typed then answers nothing')
  await clickAt(`${CARD('k-crit2')}.querySelector('div')`)
  await until(() => ev(`${CARD('k-crit2')}.dataset.keysLive`), (v) => v === 'yes', 2000)
  await key('d', 'KeyD', 68)
  check((await until(async () => answers('k-crit2'), (v) => v.length > 0, 4000)).join() === 'deny', 'with focus on the cards, D denies a critical request', answers('k-crit2').join())
  await until(() => ev(`!!${CARD('k-crit2')}`), (v) => v === false, 5000)
  await settle()

  // ── a real pointer click on Approve, on a card that does not have the focus ───────────────
  // Mouse-down gives the card the focus; nothing may move before mouse-up, or the click misses.
  push({ request_id: 'k-click', description: 'Show the disk usage', critical: false }, { stays: true })
  await until(() => ev(`!!${CARD('k-click')}`), (v) => v === true)
  await settle()
  await ev(`(document.activeElement?.blur?.(), true)`)
  const BTN = `[...${CARD('k-click')}.querySelectorAll('button')].find((b) => /^Approve once/.test(b.textContent))`
  const box = (expr) => ev(`(() => { const q = (${expr}).getBoundingClientRect(); return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)].join() })()`)
  check((await ev(`${CARD('k-click')}.dataset.keysLive`)) === 'no', 'before the click the card does not have the focus')
  const cardBefore = await box(CARD('k-click'))
  const btnBefore = await box(BTN)
  const at = await ev(`(() => { const q = (${BTN}).getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
  await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(250) // long enough for the card to take focus and re-render
  check((await ev(`${CARD('k-click')}.dataset.keysLive`)) === 'yes' && (await box(BTN)) === btnBefore && (await box(CARD('k-click'))) === cardBefore, 'with the mouse held down on Approve the card has the focus, and neither the card nor the button has moved or resized', `${btnBefore} -> ${await box(BTN)}`)
  await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  check((await until(async () => answers('k-click'), (v) => v.length > 0, 4000)).join() === 'approve', 'so one click on Approve approves it', answers('k-click').join())
  await until(() => ev(`!!${CARD('k-click')}`), (v) => v === false, 5000)
  await settle()

  // ── what Prometheus advertises changes while the mouse is already down on Approve ──────────
  // A request that does not say, from a Prometheus that says nothing, is an ordinary one; a reconnect that now advertises the flag
  // makes the same card critical (and its note appear). Neither the card nor the button may move or resize, or the click misses.
  daemon.advertises = false
  const subsF = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > subsF, 20000)
  await until(() => ev(`window.beacon.connection.status().then((s) => s.approvalCritical)`), (v) => v === false, 5000)
  push({ request_id: 'k-flip', description: 'Show the disk usage again' }, { stays: true })
  await until(() => ev(`!!${CARD('k-flip')}`), (v) => v === true)
  await settle()
  await ev(`(document.activeElement?.blur?.(), true)`)
  const FBTN = `[...${CARD('k-flip')}.querySelectorAll('button')].find((b) => /^Approve once/.test(b.textContent))`
  check((await ev(`${CARD('k-flip')}.dataset.critical`)) === 'no' && (await ev(`!!${CARD('k-flip')}.querySelector('[data-testid="approval-critical-note"]')`)) === false && (await ev(`${CARD('k-flip')}.innerText.includes('approved only here')`)) === false, 'an unmarked request from a Prometheus that says it marks nothing is ordinary, and its card shows no critical note')
  const flipCard = await box(CARD('k-flip'))
  const flipBtn = await box(FBTN)
  const flipAt = await ev(`(() => { const q = (${FBTN}).getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } })()`)
  await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: flipAt.x, y: flipAt.y, button: 'left', clickCount: 1 })
  await sleep(250)
  daemon.advertises = true
  const subsG = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > subsG, 20000)
  check((await until(() => ev(`${CARD('k-flip')}?.dataset.critical ?? null`), (v) => v === 'yes', 6000)) === 'yes' && (await ev(`!!${CARD('k-flip')}.querySelector('[data-testid="approval-critical-note"]')`)) === true, 'with the mouse still down, the reconnect that advertises the flag makes the card critical and its note appears')
  check((await box(CARD('k-flip'))) === flipCard && (await box(FBTN)) === flipBtn, 'and neither the card nor the Approve button moved or resized when it did', `${flipBtn} -> ${await box(FBTN)}; card ${flipCard} -> ${await box(CARD('k-flip'))}`)
  await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: flipAt.x, y: flipAt.y, button: 'left', clickCount: 1 })
  check((await until(async () => answers('k-flip'), (v) => v.length > 0, 4000)).join() === 'approve', 'so the click still lands: Approve, from the card, is accepted for a request that became critical', answers('k-flip').join())
  await until(() => ev(`!!${CARD('k-flip')}`), (v) => v === false, 5000)
  await settle()

  // ── what the card says about the arguments it shows ─────────────────────────────────────────
  // The requests are the ones a real daemon filed and listed (src/main/fixtures/approval_arguments.json, recorded by
  // scripts/record-approval-arguments.py): its own cut, its own mask, its own "not shown" row, and an agent's invisible characters.
  // One at a time: a stack of five cards runs off the bottom of the window.
  {
    const fx = JSON.parse(readFileSync(new URL('../src/main/fixtures/approval_arguments.json', import.meta.url), 'utf8'))
    const rows = Object.fromEntries(Object.keys(fx.calls).map((name, i) => [name, fx.list[i]]))
    daemon.advertises = true
    const has = (id, tid) => ev(`!!${CARD(id)}.querySelector('[data-testid="${tid}"]')`)
    const text = (id) => ev(`${CARD(id)}.innerText`)
    const TAGS = /\[(CUT|PART HIDDEN|LEFT OUT|ODD CHARACTERS)\]/
    const show = async (name) => {
      const id = `a-${name}`
      push({ request_id: id, tool_name: rows[name].tool_name, description: rows[name].description, arguments: rows[name].arguments, critical: false }, { stays: true })
      await until(() => ev(`!!${CARD(id)}`), (v) => v === true)
      await settle()
      return id
    }
    const picture = async (id, name) => {
      if (!process.env.PROBE_SHOT_DIR) return
      const r = await ev(`(() => { const q = ${CARD(id)}.getBoundingClientRect(); return { x: q.left, y: q.top, width: q.width, height: q.height } })()`)
      const shot = await app.page.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } })
      writeFileSync(join(process.env.PROBE_SHOT_DIR, `approval-arguments-${name}.png`), Buffer.from(shot.result.data, 'base64'))
    }
    const deny = async (id) => {
      await ev(`(() => { [...${CARD(id)}.querySelectorAll('button')].find((b) => /^Deny/.test(b.textContent)).click(); return true })()`)
      await until(() => ev(`!!${CARD(id)}`), (v) => v === false, 5000)
      await settle()
    }

    let id = await show('short')
    check(!(await has(id, 'approval-args-incomplete')) && !(await has(id, 'approval-args-invisibles')) && !TAGS.test(await text(id)), 'arguments that fit, with nothing cut or masked, say nothing about it')
    await picture(id, 'short')
    await deny(id)

    id = await show('long')
    const longText = await text(id)
    check((await has(id, 'approval-args-incomplete')) && /\[CUT\]/.test(longText) && /more chars\)/.test(longText) && /not seeing the whole call/.test(longText), 'a value the daemon cut: the card says first that it is not the whole call, tags the value CUT, and shows the daemon\'s count')
    check(longText.indexOf('not seeing the whole call') > -1 && longText.indexOf('not seeing the whole call') < longText.indexOf('With'), 'the notice is above the arguments')
    await picture(id, 'long')
    await deny(id)

    id = await show('masked')
    const maskedText = await text(id)
    check((await has(id, 'approval-args-incomplete')) && /\[PART HIDDEN\]/.test(maskedText) && /Bearer \*\*\*/.test(maskedText) && !/\[CUT\]/.test(maskedText), 'a value the daemon masked: tagged PART HIDDEN, the mask still shown, not called cut')
    await picture(id, 'masked')
    await deny(id)

    id = await show('odd')
    const oddText = await text(id)
    check((await has(id, 'approval-args-invisibles')) && !(await has(id, 'approval-args-incomplete')) && oddText.includes('notes/\u27e8U+202E\u27e9txt.sh') && /\[ODD CHARACTERS\]/.test(oddText), 'characters that do not draw are written out as ⟨U+…⟩ where they were, the card says so, and does not claim anything was cut')
    await picture(id, 'odd')
    await deny(id)

    id = await show('many')
    const manyText = await text(id)
    check((await has(id, 'approval-args-incomplete')) && /\[LEFT OUT\]/.test(manyText) && /9 more argument\(s\) not shown/.test(manyText), 'arguments the daemon left out: the notice, and its own "(9 more argument(s) not shown)" row tagged LEFT OUT')
    await picture(id, 'many')
    // The card still keeps its size under a held mouse with all of this on it (and Approve is on screen to be pressed).
    await ev(`(document.activeElement?.blur?.(), true)`)
    const ABTN = `[...${CARD(id)}.querySelectorAll('button')].find((b) => /^Approve once/.test(b.textContent))`
    const aCard = await box(CARD(id))
    const aBtn = await box(ABTN)
    const aAt = await ev(`(() => { const q = (${ABTN}).getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, vh: innerHeight } })()`)
    check(aAt.y > 0 && aAt.y < aAt.vh, 'Approve is on screen for that test', JSON.stringify(aAt))
    await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: aAt.x, y: aAt.y, button: 'left', clickCount: 1 })
    await sleep(250)
    check((await ev(`${CARD(id)}.dataset.keysLive`)) === 'yes' && (await box(CARD(id))) === aCard && (await box(ABTN)) === aBtn, 'with the mouse held down on Approve, a card with notices, tags and a long list has the focus and has not moved or resized', `${aBtn} -> ${await box(ABTN)}`)
    await app.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'left' })
    await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 })
    await deny(id)
  }

  // ── main refuses too: an approve of a critical request that is not from the card's button ───
  push({ request_id: 'k-guard', description: 'git push --force', critical: true }, { stays: true })
  await until(() => ev(`!!${CARD('k-guard')}`), (v) => v === true)
  await settle()
  const tryResolve = (id, decision, from) => ev(`window.beacon.approvals.resolve(${JSON.stringify(id)}, ${JSON.stringify(decision)}${from === undefined ? '' : `, ${JSON.stringify(from)}`}).then(() => 'went through', (e) => String(e?.message ?? e))`)
  for (const from of ['row', 'key', 'notification', undefined, 'CARD']) {
    const r = await tryResolve('k-guard', { kind: 'approve', scope: 'once' }, from)
    check(/can be approved only on its card/.test(r) && answers('k-guard').length === 0, `an approve of a critical request sent to main as coming from ${JSON.stringify(from) ?? 'nowhere'} is refused, and Prometheus is not asked`, r)
  }
  check(/can be approved only on its card/.test(await tryResolve('k-guard', { kind: 'approve', scope: 'always' }, 'row')) && answers('k-guard').length === 0, 'so is a lasting approve')
  check(/can be approved only on its card/.test(await tryResolve('never-seen', { kind: 'approve', scope: 'once' }, 'row')) && answers('never-seen').length === 0, 'and an approve of a request main has never seen, from this Prometheus')
  check((await ev(`!!${CARD('k-guard')}`)) === true, 'the request is still pending, its card still up')
  check((await tryResolve('k-guard', { kind: 'deny' }, 'row')) === 'went through' && answers('k-guard').join() === 'deny', 'a deny from a row goes through')
  await until(() => ev(`!!${CARD('k-guard')}`), (v) => v === false, 5000)
  await settle()
  push({ request_id: 'k-guard2', description: 'git push --force', critical: true }, { stays: true })
  await until(() => ev(`!!${CARD('k-guard2')}`), (v) => v === true)
  await settle()
  check((await tryResolve('k-guard2', { kind: 'approve', scope: 'once' }, 'card')) === 'went through' && answers('k-guard2').join() === 'approve', "an approve marked as from the card's own button goes through (the button itself is driven above)")
  await until(() => ev(`!!${CARD('k-guard2')}`), (v) => v === false, 5000)
  await settle()

  // ── the key hints follow focus when the focused button goes away ──────────────────────────
  // A worker's request this Beacon may not approve: Approve is refused, and the card replaces the
  // button with a sentence. The button had the focus; no blur fires for an element that is removed.
  push({ request_id: 'k-worker', description: 'Run the migration', critical: false, worker_task_id: 'task-1', once_only: true }, { stays: true })
  await until(() => ev(`!!${CARD('k-worker')}`), (v) => v === true)
  await settle()
  const APPROVE_BTN = `[...${CARD('k-worker')}.querySelectorAll('button')].find((b) => /^Approve once/.test(b.textContent))`
  await ev(`(() => { (${APPROVE_BTN}).focus(); return true })()`)
  check((await until(() => ev(`${CARD('k-worker')}.dataset.keysLive`), (v) => v === 'yes', 2000)) === 'yes', 'with focus on its Approve button the worker card says the keys work')
  check(await clickAt(APPROVE_BTN), 'clicked Approve on a worker request this Beacon may not approve')
  check((await until(async () => daemon.refusedWorker ?? 0, (v) => v >= 1, 4000)) >= 1, 'Prometheus refused it')
  check((await app.mainEval(`1`)) === 1, 'main is answering')
  check((await until(() => ev(`!!${CARD('k-worker')}.querySelector('[data-testid="approval-cannot-approve"]')`), (v) => v === true, 4000)) === true && (await ev(`!!(${APPROVE_BTN})`)) === false, 'the card says so, and the Approve button (which had the focus) is gone')
  check((await ev(`!!document.activeElement?.closest('[data-approval-id]')`)) === false, 'focus is no longer on the card')
  const hintsOff = await until(() => ev(`${CARD('k-worker')}.dataset.keysLive`), (v) => v === 'no', 3000)
  check(hintsOff === 'no' && /Click this card, or Tab to it/.test(await ev(`${CARD('k-worker')}.innerText`)) && !/D denies\./.test(await ev(`${CARD('k-worker')}.querySelector('[data-testid="approval-keys-hint"]').textContent`)), 'and the card stops saying the keys work, and says again how to use them')
  await key('d', 'KeyD', 68)
  await sleep(400)
  check(answers('k-worker').length === 0, 'D pressed then answers nothing, as the card now says')
  await ev(`(() => { [...${CARD('k-worker')}.querySelectorAll('button')].find((b) => /^Deny/.test(b.textContent)).click(); return true })()`)
  await until(() => ev(`!!${CARD('k-worker')}`), (v) => v === false, 5000)
  await settle()

  // A request that does not say, from this Prometheus (it advertises the flag): card-only too.
  push({ request_id: 'k-silent', description: 'A request that does not say either way' }, { stays: true })
  check((await until(() => ev(`${CARD('k-silent')}?.dataset.critical ?? null`), (v) => v !== null)) === 'yes' && (await until(rowButtons, (v) => v.length > 0)).join() === 'Answer on the card,Deny', 'a request that does not say, from a Prometheus that advertises the flag, is card-only as well')
  await ev(`(() => { [...${CARD('k-silent')}.querySelectorAll('button')].find((b) => /^Deny/.test(b.textContent)).click(); return true })()`)
  await until(() => ev(`!!${CARD('k-silent')}`), (v) => v === false, 5000)
  await settle()
  check(daemon.resolved.length === 19, 'nineteen answers in all, each one made on purpose', daemon.resolved.join(' '))

  const answeredInWindow = daemon.resolved.length

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

  // ── silence never withdraws a "yes" ────────────────────────────────────────────────────────
  daemon.advertises = true
  const subsA = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > subsA, 20000)
  await until(() => ev(`window.beacon.connection.status().then((s) => s.approvalCritical)`), (v) => v === true, 5000)
  daemon.silent = true
  const subsB = daemon.subscribes
  for (const ws of daemon.sockets) ws.terminate()
  await until(async () => daemon.subscribes, (v) => v > subsB, 20000)
  await sleep(6500)
  check((await ev(`window.beacon.connection.status().then((s) => s.approvalCritical)`)) === true, 'a Prometheus that said yes and then goes quiet (a reconnect with no reply, six seconds on) is still taken to mark requests: only a reply withdraws a yes')
  daemon.silent = false

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
