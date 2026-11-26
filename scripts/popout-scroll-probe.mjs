#!/usr/bin/env node
// popout-scroll-probe — a conversation in its own window (session window) must not scroll past its own content: the document is the
// size of the window, and only the thread inside scrolls. Seen on a real Mac: the pop-out's scrollbar scrolled without end, carrying
// the header and composer up and off, and leaving a blank window.
//
//   npm run build && npm run probe:popout-scroll
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]
const MIN_CHECKS = 8
let failures = 0
let checks = 0
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const ID = 'beacon:popout-scroll'
const now = Math.floor(Date.now() / 1000)
const MANY = Array.from({ length: 60 }, (_, i) => ({ message_id: i + 1, ordinal: i + 1, role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}\n\n` + 'A line of the conversation that is long enough to wrap onto more than one line in a narrow window. '.repeat(6), timestamp: now - 3600 + i * 20, is_trusted: true }))
const state = { messages: MANY }
const rest = createServer((req, res) => {
  req.on('data', () => undefined)
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url === '/api/hello') return json(res, 200, { v: '0.9.22', name: 'Stand-in', agent: 'Atlas', fp: 'e'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/devices') return json(res, 200, [])
    if (url === '/api/sessions') return json(res, 200, [{ session_id: ID, title: 'Long conversation', gateway: 'beacon', message_count: state.messages.length, last_active: now, created_at: now - 86400 }])
    if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) return json(res, 200, { messages: state.messages, watermark: state.messages.length })
    if (url.startsWith('/api/lcm/')) return json(res, 200, { messages: state.messages, watermark: state.messages.length })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let f = null
    try { f = JSON.parse(raw.toString()) } catch { return }
    if (f?.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: [], server_capabilities: [], channels: [] } }))
  })
  ws.send(JSON.stringify({ type: 'connected' }))
})
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const profile = mkdtempSync(join(tmpdir(), 'beacon-popout-scroll-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('standin', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])

let app = null
try {
  app = await launchApp({ profile })
  await app.mainEval(`(() => { __electron.BrowserWindow.getAllWindows()[0].setContentSize(1300, 900); return true })()`)
  check((await app.page.evaluate('window.beacon.connection.status().then((s) => s.state)')) !== undefined, 'the app is up')
  await sleep(1500)
  check((await app.page.evaluate(`window.beacon.sessionWindows.open(${JSON.stringify(ID)})`)) === true, 'a conversation was popped out into its own window')
  /** Run code in the pop-out's page. */
  const inPop = (code) => app.mainEval(`(async () => { const w = __electron.BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#session=')); if (!w) return { gone: true }; return await w.webContents.executeJavaScript(${JSON.stringify(code)}) })()`)
  let ready = null
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300)
    ready = await inPop(`!!document.querySelector('.session-window .thread-head')`).catch(() => null)
  }
  check(ready === true, 'the pop-out shows its conversation')
  await app.mainEval(`(() => { const w = __electron.BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#session=')); w.setContentSize(900, 700); return true })()`)
  await sleep(1500)
  const geo = await inPop(`(() => {
    const el = document.scrollingElement
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom), pos: getComputedStyle(e).position, overflowY: getComputedStyle(e).overflowY } }
    return { inner: window.innerHeight, docScrollH: el.scrollHeight, docClientH: el.clientHeight, bodyH: Math.round(document.body.getBoundingClientRect().height), root: box('#root'), sw: box('.session-window'), app: box('.session-window > .app'), head: box('.thread-head'), composer: box('.composer-shell'), body: [...document.body.children].map((c) => c.tagName + '.' + c.className + ':' + Math.round(c.getBoundingClientRect().height)) }
  })()`)
  check(geo.docScrollH <= geo.docClientH + 1, `the document is no taller than the window (scrollHeight ${geo.docScrollH}, window ${geo.docClientH})`, JSON.stringify(geo))
  // Scroll the page as far as it will go: it must not move.
  const moved = await inPop(`(() => { window.scrollTo(0, 99999); document.scrollingElement.scrollTop = 99999; return { y: document.scrollingElement.scrollTop, headTop: Math.round(document.querySelector('.thread-head').getBoundingClientRect().top) } })()`)
  check(moved.y === 0 && moved.headTop >= 0, `scrolling the page moves nothing (scrollTop ${moved.y}, header top ${moved.headTop})`, JSON.stringify(moved))
  const comp = await inPop(`(() => { const r = document.querySelector('.composer-shell')?.getBoundingClientRect(); return r ? { bottom: Math.round(r.bottom), inner: window.innerHeight } : null })()`)
  check(comp && comp.bottom <= comp.inner + 1, 'the composer stays inside the window', JSON.stringify(comp))
  // The thread inside still scrolls: it is the one thing that should.
  const thread = await inPop(`(() => { const m = document.querySelector('.messages'); const before = m.scrollTop; m.scrollTop = 0; const top = m.scrollTop; m.scrollTop = 400; return { sh: m.scrollHeight, ch: m.clientHeight, top, moved: m.scrollTop, headTop: Math.round(document.querySelector('.thread-head').getBoundingClientRect().top) } })()`)
  check(thread.sh > thread.ch + 1000 && thread.moved > 0 && thread.headTop === 0, `the conversation still scrolls inside its own area (${thread.sh}px of messages in ${thread.ch}px), and the header stays put`, JSON.stringify(thread))
  // Nothing can scroll the window's own box either: it is not a scroll container.
  const box = await inPop(`(() => { const w = document.querySelector('.session-window'); w.scrollTop = 500; w.scrollTo?.(0, 500); return { top: w.scrollTop, headTop: Math.round(document.querySelector('.thread-head').getBoundingClientRect().top), overflow: getComputedStyle(w).overflowY } })()`)
  check(box.top === 0 && box.headTop === 0, `the pop-out's own box does not scroll either (scrollTop ${box.top}, overflow ${box.overflow})`, JSON.stringify(box))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 && checks >= MIN_CHECKS ? 0 : 1)
