#!/usr/bin/env node
// live-announce-probe — does a REAL streamed reply land in the live region ONCE, and stay silent
// per token?
//
// smoke:live-announce proves the MODEL and that ChatShell's source wires it. It cannot prove the
// behavior this whole feature exists for, because that behavior only happens when a reducer mutates a
// row per delta and React reconciles it: a live region placed on the list would announce every token
// (a few hundred per reply), and a live region keyed wrong would announce the same reply twice or
// never. Both defects read as correct source.
//
// So this drives the REAL app: it seeds a session into a scratch profile, opens it by clicking the
// sidebar row, then pushes genuine chat:stream frames (delta ×N, then done) into the renderer over
// the shipped channel and reads the live region's text back out of the DOM after each one.
//
// RUN: npm run build && DISPLAY=:1 node scripts/live-announce-probe.mjs
// SANDBOXED: PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const REPO = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`); if (!ok) failures++ }
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 64 - t.length))}`)

const SCRATCH = 'beacon:aria-probe'
const EARLY = 'beacon:early-race-probe'
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s) }
const site = createServer((req, res) => { const u = req.url ?? ''; if (u.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 }); json(res, 200, []) })
await new Promise((r) => site.listen(0, '127.0.0.1', r)); const API_PORT = site.address().port
const wsSite = createServer(); const { WebSocketServer } = await import('ws'); const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (s) => { try { s.send(JSON.stringify({ type: 'connected' })) } catch {} s.on('error', () => {}) })
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r)); const WS_PORT = wsSite.address().port

const INSPECT = 9700 + ((process.pid + 89) % 200)
const CDP = INSPECT + 1
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-aria-'))

// Seed the scratch cache with the session AND a real backlog the probe will open. Done by opening the
// app's own DB file with better-sqlite3 BEFORE launch, so openCache() finds the rows rather than the
// sidebar listing nothing to click.
//
// The backlog is load-bearing, not decoration: history.fetch() reads through this cache, so without
// seeded messages the session opens EMPTY and the "does not recite its backlog" check passes
// vacuously — there is no backlog to recite. An earlier version of this probe had exactly that hole
// and reported green with the arming logic deleted outright.
{
  const dbPath = join(USER_DATA, 'beacon.db')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, gateway TEXT, title TEXT, last_active INTEGER, message_count INTEGER DEFAULT 0, watermark INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0)`)
  db.prepare(`INSERT OR REPLACE INTO sessions (id, gateway, title, last_active, message_count, watermark, pinned) VALUES (?, 'beacon', ?, ?, 2, 8000, 0)`)
    .run(SCRATCH, SCRATCH, Date.now())
  db.exec(`CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, row_id INTEGER, ordinal INTEGER, role TEXT NOT NULL, content TEXT, content_json TEXT, provenance TEXT, is_trusted INTEGER, tool_calls TEXT, created_at INTEGER NOT NULL, client_msg_id TEXT, PRIMARY KEY (session_id, id))`)
  const ins = db.prepare(`INSERT OR REPLACE INTO messages (session_id, id, row_id, ordinal, role, content, content_json, provenance, is_trusted, tool_calls, created_at, client_msg_id) VALUES (?, ?, ?, ?, ?, ?, NULL, 'user', 1, NULL, ?, NULL)`)
  const now = Date.now()
  ins.run(SCRATCH, '8000', 8000, 0, 'user', 'an older question from the backlog', now - 60000)
  // The row the arming logic must mark as already-heard: the newest settled assistant reply on screen.
  ins.run(SCRATCH, '8001', 8001, 1, 'assistant', 'an older answer that must NOT be recited on open', now - 59000)
  // A second session for the early-frame race (#185 review): opened LAST, with main holding its
  // history reply so a stream frame can render before the backlog lands.
  db.prepare(`INSERT OR REPLACE INTO sessions (id, gateway, title, last_active, message_count, watermark, pinned) VALUES (?, 'beacon', ?, ?, 2, 8101, 0)`)
    .run(EARLY, EARLY, Date.now() - 1000)
  ins.run(EARLY, '8100', 8100, 0, 'user', 'an early-session question', now - 50000)
  ins.run(EARLY, '8101', 8101, 1, 'assistant', 'an early-session answer that must NOT be recited', now - 49000)
  db.close()
  check(existsSync(dbPath), `scratch cache seeded with the session row and a 2-message backlog (${SCRATCH})`)
}

const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(API_PORT), BEACON_GATEWAY_WS_PORT: String(WS_PORT) }
})
const mainLog = []; child.stdout.on('data', (d) => mainLog.push(String(d))); child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
const closeStubs = () => { for (const c of [wss, wsSite, site]) { try { c.close() } catch {} } }
async function reapAndExit(code) { reap(); closeStubs(); for (let i = 0; i < 20; i++) { if (child.exitCode !== null || child.signalCode !== null) { try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {} process.exit(code) } await sleep(100) } killGroup('SIGKILL'); process.exit(code) }
process.on('exit', () => { reap(); closeStubs() })
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) } })

async function list(port) { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json() } catch { return [] } }
async function attachTo(port, pick, tries = 80) { for (let i = 0; i < tries; i++) { await sleep(500); const t = (await list(port)).find(pick); if (t) return t } return null }
async function client(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`${method} timed out`)) } }, 20000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value }
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }) })
  return { send, evaluate, ws }
}

const nodeT = await attachTo(INSPECT, (t) => t.type === 'node')
check(!!nodeT, 'main-process inspector found (--inspect)', nodeT ? '' : mainLog.join('').slice(-600))
if (!nodeT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const M = await client(nodeT.webSocketDebuggerUrl); await M.send('Runtime.enable')
for (let __i = 0; ; __i++) { const __t = await M.evaluate(`(() => { try { if (process.mainModule) globalThis.__electron = process.mainModule.require('electron') } catch {} return typeof globalThis.__electron?.app })()`); if (__t === 'object') break; if (__i > 80) throw new Error('electron API never became reachable in main'); await new Promise((r) => setTimeout(r, 250)) }

// The shell's PAGE target is on the CDP port; --inspect serves only the main node target.
const pageT = await attachTo(CDP, (t) => t.type === 'page' && (t.url || '').includes('index.html'))
check(!!pageT, 'shell page target found (--remote-debugging-port)', pageT ? '' : mainLog.join('').slice(-600))
if (!pageT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const P = await client(pageT.webSocketDebuggerUrl); await P.send('Runtime.enable')

let up = false
for (let i = 0; i < 60; i++) { if (await P.evaluate(`!!window.beacon && !!document.querySelector('nav[aria-label="Views"]')`).catch(() => false)) { up = true; break } await sleep(500) }
check(up, 'the shell is up (nav rail rendered)')

// Open Chats, then the seeded session — a real click on the real sidebar row.
await P.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Chats"]')?.click(); true`)
let opened = false
for (let i = 0; i < 40; i++) {
  const clicked = await P.evaluate(`(() => { const b = [...document.querySelectorAll('button.session-row')].find(x => (x.title||'').includes(${JSON.stringify(SCRATCH)})); if (b) { b.click(); return true } return false })()`)
  if (clicked) {
    await sleep(700)
    const active = await P.evaluate(`document.querySelector('button.session-row.is-active')?.title ?? ''`)
    if (String(active).includes(SCRATCH)) { opened = true; break }
  }
  await sleep(500)
}
check(opened, `opened the seeded session by clicking its sidebar row (ChatShell is now mounted)`)

// The live region, read straight out of the DOM. sr-only + aria-live=polite + aria-atomic is how the
// smoke identifies it; read by that same signature so the probe cannot read some other status div.
const liveText = () =>
  P.evaluate(`(() => { const r = document.querySelector('div.sr-only[aria-live="polite"][aria-atomic="true"]'); return r ? r.textContent : null })()`)
// Push a frame over the SHIPPED channel — the same webContents.send main's broadcast() uses, so this
// is the real path into the reducer, not a copy of it.
const pushFrame = (frame) =>
  M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows().forEach(w => w.webContents.send('chat:stream', ${JSON.stringify(frame)})); true`)

section('opening a session does NOT recite its backlog')
{
  // FIRST prove the backlog is actually on screen. Without this the next check is vacuous: an empty
  // session has no backlog to recite, so "the region is empty" passes whether or not arming exists.
  // (That hole was real — this probe reported green with initialWatermark deleted outright.)
  let backlogVisible = ''
  for (let i = 0; i < 20; i++) {
    backlogVisible = await P.evaluate(`[...document.querySelectorAll('.msg')].map(m => m.textContent || '').join(' | ')`) ?? ''
    if (backlogVisible.includes('must NOT be recited')) break
    await sleep(400)
  }
  check(backlogVisible.includes('must NOT be recited'), `the seeded backlog really rendered — the newest settled reply is on screen (${JSON.stringify(backlogVisible.slice(0, 70))})`)

  const t = await liveText()
  check(t === '' || t === null, `yet the live region is empty right after opening (got ${JSON.stringify(t)}) — the watermark armed on the backlog, so nothing is published. This is the check that fails if arming is dropped.`)
  check(t !== null, 'and the region EXISTS (sr-only polite+atomic) — if this is null the element is missing entirely, not merely empty')
  check(!(t ?? '').includes('must NOT be recited'), 'explicitly: the backlog text is NOT what got announced')
}

const MSG = 'aria-probe-msg'
section('streaming deltas announce NOTHING (the flood, prevented)')
{
  const deltas = ['Sure', ', let me', ' look', ' into', ' that', ' for you', ' right now', '.']
  for (const d of deltas) {
    await pushFrame({ kind: 'delta', sessionId: SCRATCH, messageId: MSG, content: d })
    await sleep(120)
  }
  const mid = await liveText()
  check((mid ?? '') === '', `after ${deltas.length} deltas the live region is STILL empty (got ${JSON.stringify(mid)}) — a live region on the list would have announced every one of these`)
  const rowText = await P.evaluate(`(() => { const rows = [...document.querySelectorAll('.msg-assistant')]; return rows.length ? (rows[rows.length-1].textContent||'').slice(-40) : null })()`)
  check(typeof rowText === 'string' && rowText.includes('right now'), `while the VISIBLE row did stream the partial text (…${JSON.stringify(rowText)}) — proving the deltas really arrived and were rendered, so the empty live region is suppression, not a broken stream`)
}

section('the done frame publishes the whole reply, once')
{
  await pushFrame({ kind: 'done', sessionId: SCRATCH, messageId: MSG, rowId: 9001 })
  let text = null
  for (let i = 0; i < 20; i++) { text = await liveText(); if (text && text.trim().length > 0) break; await sleep(300) }
  check(!!text && text.trim().length > 0, `the live region now carries the reply (got ${JSON.stringify((text ?? '').slice(0, 60))})`)
  const full = await P.evaluate(`(() => { const rows = [...document.querySelectorAll('.msg-assistant')]; return rows.length ? (rows[rows.length-1].textContent||'') : '' })()`)
  check((text ?? '').includes('Sure') && (text ?? '').includes('right now'), 'and it is the COMPLETE text, not a fragment — aria-atomic means the whole thing is spoken')
  check((text ?? '').length > 0 && (text ?? '').length <= Math.max(full.length, 80), `the announcement is bounded by the message, not a concatenation of every delta (len ${(text ?? '').length} vs row len ${full.length})`)

  // Republishing the SAME reply would put the same TEXT in a NEW node (the child is keyed on a seq),
  // so comparing text cannot see it. Watch the node instead: mark the published child and count
  // every mutation in the region from here on. The next section reads both after the repeated done
  // AND a re-render (turn two's first delta) — a repeated done alone re-renders nothing (the row
  // already re-keyed to its rowId, so the reducer returns the same state), which is why the old
  // text check could not fail.
  const watching = await P.evaluate(`(() => {
    const r = document.querySelector('div.sr-only[aria-live="polite"][aria-atomic="true"]')
    if (!r || !r.firstElementChild) return false
    r.firstElementChild.dataset.probeMark = '1'
    window.__regionMuts = 0
    new MutationObserver((ms) => { window.__regionMuts += ms.length }).observe(r, { childList: true, subtree: true, characterData: true })
    return true
  })()`)
  check(watching === true, 'the published node is marked and the region is under a MutationObserver')
  await pushFrame({ kind: 'done', sessionId: SCRATCH, messageId: MSG, rowId: 9001 })
  await sleep(900)
}

section('a second turn replaces, and is announced as new')
{
  const MSG2 = 'aria-probe-msg-2'
  await pushFrame({ kind: 'delta', sessionId: SCRATCH, messageId: MSG2, content: 'Second answer' })
  await sleep(400)
  const rowsNow = await P.evaluate(`[...document.querySelectorAll('.msg-assistant')].map(m => m.textContent || '').join(' | ')`)
  check(rowsNow.includes('Second answer'), 'turn two\'s first delta really rendered (the list re-rendered after the announcement)')
  const node = await P.evaluate(`(() => { const r = document.querySelector('div.sr-only[aria-live="polite"][aria-atomic="true"]'); return { muts: window.__regionMuts, marked: r?.firstElementChild?.dataset.probeMark === '1' } })()`)
  check(node.muts === 0 && node.marked, `neither the repeated done nor that re-render republished turn one: 0 mutations in the region (got ${node.muts}) and the published node is the same node (marked=${node.marked}) — the watermark holds`)
  check((await liveText() ?? '').includes('Sure'), `mid-stream of turn two the region still shows turn ONE (got ${JSON.stringify((await liveText() ?? '').slice(0, 24))}) — not the partial`)
  await pushFrame({ kind: 'done', sessionId: SCRATCH, messageId: MSG2, rowId: 9002 })
  let t2 = null
  for (let i = 0; i < 20; i++) { t2 = await liveText(); if ((t2 ?? '').includes('Second')) break; await sleep(300) }
  check((t2 ?? '').includes('Second'), `turn two's reply replaces turn one's in the region (got ${JSON.stringify((t2 ?? '').slice(0, 40))}) — one region, current text, never an accumulating log`)
  check(!(t2 ?? '').includes('Sure'), `and turn one's text is GONE from it (not appended) — aria-atomic on a single region, not a growing list`)
}

section('a STOPPED reply is announced as stopped, not as finished')
{
  const MSG3 = 'aria-probe-msg-3'
  await pushFrame({ kind: 'delta', sessionId: SCRATCH, messageId: MSG3, content: 'Partial answer cut' })
  await sleep(200)
  await pushFrame({ kind: 'done', sessionId: SCRATCH, messageId: MSG3, rowId: 9003, interrupted: true })
  let t3 = null
  for (let i = 0; i < 20; i++) { t3 = await liveText(); if ((t3 ?? '').includes('Partial')) break; await sleep(300) }
  const badge = await P.evaluate(`!!document.querySelector('.msg-interrupted')`)
  check(badge, 'the visible row shows its stopped state (the done frame really carried interrupted:true)')
  check((t3 ?? '').includes('Partial answer cut'), `the stopped reply's text is announced (got ${JSON.stringify((t3 ?? '').slice(0, 50))})`)
  check((t3 ?? '').startsWith('Reply stopped.'), `and it is announced AS stopped (got ${JSON.stringify((t3 ?? '').slice(0, 50))}) — read as finished, a partial reply misstates what the agent did`)
}

section('a stream frame that lands BEFORE history does not cause a backlog recital')
{
  // The race (#185 review): ChatShell used to arm on the first render that HAS ROWS. A stream frame
  // for the session can render a pending row before history.fetch resolves; arming on that render
  // marks nothing as heard (a pending row is never the watermark), so when history then replaces the
  // list, its newest settled reply is "news" and gets recited. Construct the losing interleaving
  // deterministically: hold main's history:fetch reply, open the session, push a frame, release.
  const held = await M.evaluate(`(() => {
    const { ipcMain } = globalThis.__electron
    const orig = ipcMain._invokeHandlers?.get('history:fetch')
    if (!orig) return 'no handler map'
    let release
    globalThis.__historyGate = new Promise((r) => (release = r))
    globalThis.__releaseHistory = release
    globalThis.__historyHeld = 0
    ipcMain._invokeHandlers.set('history:fetch', async (e, ...a) => { globalThis.__historyHeld++; await globalThis.__historyGate; return orig(e, ...a) })
    globalThis.__restoreHistory = () => ipcMain._invokeHandlers.set('history:fetch', orig)
    return 'held'
  })()`)
  check(held === 'held', `main's history:fetch reply is held (got ${JSON.stringify(held)})`)
  let opened2 = false
  for (let i = 0; i < 40 && !opened2; i++) {
    await P.evaluate(`(() => { const b = [...document.querySelectorAll('button.session-row')].find(x => (x.title||'').includes(${JSON.stringify(EARLY)})); if (b && !b.classList.contains('is-active')) b.click(); return true })()`)
    await sleep(400)
    const active = await P.evaluate(`document.querySelector('button.session-row.is-active')?.title ?? ''`)
    opened2 = String(active).includes(EARLY)
  }
  let fetches = 0
  for (let i = 0; i < 20 && fetches === 0; i++) { fetches = await M.evaluate('globalThis.__historyHeld'); if (!fetches) await sleep(200) }
  check(opened2 && fetches >= 1, `opened the second session, and its history fetch is waiting at the gate (held ${fetches})`)
  await pushFrame({ kind: 'delta', sessionId: EARLY, messageId: 'aria-probe-early-msg', content: 'an in-progress early reply' })
  await sleep(700)
  const early = await P.evaluate(`[...document.querySelectorAll('.msg')].map(m => m.textContent || '').join(' | ')`)
  check(early.includes('in-progress early reply') && !early.includes('must NOT be recited'), `the stream frame rendered BEFORE the backlog (on screen: ${JSON.stringify(early.slice(0, 60))}) — the losing order really happened`)
  await M.evaluate('globalThis.__releaseHistory(); globalThis.__restoreHistory(); true')
  let landed = ''
  for (let i = 0; i < 20; i++) { landed = await P.evaluate(`[...document.querySelectorAll('.msg')].map(m => m.textContent || '').join(' | ')`); if (landed.includes('must NOT be recited')) break; await sleep(300) }
  check(landed.includes('early-session answer that must NOT be recited'), 'the held history then landed — the backlog is on screen')
  await sleep(600)
  const t4 = await liveText()
  check(!(t4 ?? '').includes('must NOT be recited'), `and the live region did NOT recite that backlog (got ${JSON.stringify(t4)})`)
}

section('result')
console.log(failures === 0 ? 'PASS — one announcement per settled turn, nothing per token, no backlog recital' : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (verify with a real screen reader):')
console.log('  * that VoiceOver / NVDA actually VOICES this region. A correct aria-live + aria-atomic region is')
console.log('    the mechanism; whether a given reader honours it politely (and does not interrupt mid-word)')
console.log('    is only knowable by running one. macOS VoiceOver is the target to check.')
console.log('  * the frames here are pushed via webContents.send on the shipped channel — the same call main\'s')
console.log('    broadcast() makes — but they originate from the probe, not a real daemon turn.')
if (mainLog.length) console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-240))
await reapAndExit(failures === 0 ? 0 : 1)
