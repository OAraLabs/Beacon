#!/usr/bin/env node
// window-guard-probe — can a foreign page end up at the top of a Beacon window and use its bridge?
//
// Every Beacon window (main, quick-capture, tray HUD, the terminal and browser pop-outs) loads the
// preload, so whatever document sits in its top frame gets `window.beacon`. Two things stand between
// a foreign page and that bridge, and this probe drives the REAL app against both:
//
//   1. the NAVIGATION GUARD (will-navigate / will-redirect / window.open). A page-initiated navigation
//      to a foreign http page — the shape a dropped link or an injected `location =` takes — must be
//      refused in every window, and a `window.open` from a satellite must not mint a bridged child.
//   2. the SENDER CHECK (isShellSender, in front of every IPC handler in main). If a foreign document
//      gets there anyway (main force-loads it here, standing in for a guard someone forgets on the
//      next window), privileged IPC must refuse it; and a window Beacon did not create must be refused
//      even when it shows the shell page.
//
// The privileged calls are all READ-ONLY, and each has an answer a refusal cannot fake:
//   terminal.peers()        its refusal is a distinct value (`error: 'refused'`), no pty opened.
//   settings.get(SENTINEL)  the probe seeds that row into the scratch profile first (directly in main,
//                           not through any handler), so the shell reads the value and a refusal
//                           reads null. Without the seed both would read null.
//   daemon.get(unique path) the stub gateway answers `model: 'stub'` and logs every path it serves,
//                           so a refusal is a null reply AND no request at the gateway.
//   browser.state()         the pane's state (it has `tabs`) for its two host windows, the main window
//                           and the browser pop-out; null for anyone else. A foreign page in the MAIN
//                           window is a host by identity, so only the shell-page check refuses it.
// No write is ever sent through the bridge: if a check were missing, a write would land.
//
// Each check states the SAFE outcome. Against a build of the unfixed code the FAIL lines are the proof
// of the finding; the FACT lines say what was observed either way.
//
// RUN: npm run build && node scripts/window-guard-probe.mjs      (macOS; the HUD needs the tray)
//      BEACON_BUNDLE=dist-probe/mac-arm64/Beacon.app node scripts/window-guard-probe.mjs   (a PACKAGED
//      probe build, `npm run pack:mac:probe`: its own binary, and the shell page and preload inside its
//      app.asar. A release build refuses --inspect, so it cannot be probed this way.)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const REPO = process.cwd()
const BUNDLE = process.env.BEACON_BUNDLE ? resolve(REPO, process.env.BEACON_BUNDLE) : null
const BIN = BUNDLE && join(BUNDLE, 'Contents/MacOS/Beacon')
const ASAR = BUNDLE && join(BUNDLE, 'Contents/Resources/app.asar')
const APP_ROOT = ASAR ?? REPO // where out/ is, as the app itself sees it
const SHELL_FILE = join(APP_ROOT, 'out/renderer/index.html')
const PRELOAD = join(APP_ROOT, 'out/preload/index.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A probe reports on whatever was last built: refuse a build older than the source.
{
  let newest = 0
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|tsx|css|html)$/.test(e.name)) newest = Math.max(newest, statSync(f).mtimeMs) } }
  walk(join(REPO, 'src'))
  // Packaged: this process is plain Node and cannot see inside the asar, so the asar itself is the build.
  for (const built of BUNDLE ? [BIN, ASAR] : [SHELL_FILE, join(REPO, 'out/main/index.js'), PRELOAD]) {
    if (!existsSync(built)) { console.error(`nothing built at ${built} — run npm run build`); process.exit(2) }
    if (newest > statSync(built).mtimeMs) { console.error(`source is newer than ${built} — rebuild before probing`); process.exit(2) }
  }
}

// ── verdict: registered on 'exit' so an early return or a throw cannot skip it ────────────────────
const EXPECTED_CHECKS = 51
let checks = 0
let failures = 0
let reported = false
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
const fact = (label) => console.log(`  FACT ${label}`)
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 70 - t.length))}`)
process.on('exit', () => {
  if (reported) return
  reported = true
  if (checks !== EXPECTED_CHECKS) {
    console.log(`\nRESULT: INCOMPLETE — ${checks} checks ran, expected ${EXPECTED_CHECKS}`)
    process.exitCode = 1
    return
  }
  console.log(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`)
  if (failures) process.exitCode = 1
})

// ── servers: a stub gateway (skips the setup wizard) and a FOREIGN site on its own origin ────────
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s) }
const apiHits = []
const api = createServer((req, res) => { apiHits.push(req.url ?? ''); if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 }); json(res, 200, []) })
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const wsHost = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsHost })
wss.on('connection', (s) => { try { s.send(JSON.stringify({ type: 'connected' })) } catch {} s.on('error', () => {}) })
await new Promise((r) => wsHost.listen(0, '127.0.0.1', r))
const foreignHits = []
const foreign = createServer((req, res) => {
  foreignHits.push(req.url ?? '')
  const body = '<!doctype html><title>foreign</title><p>a page that is not Beacon</p>'
  res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
  res.end(body)
})
await new Promise((r) => foreign.listen(0, '127.0.0.1', r))
const FOREIGN = `http://127.0.0.1:${foreign.address().port}`

// ── launch THIS checkout's build on a scratch profile ─────────────────────────────────────────────
const INSPECT = 9500 + ((process.pid + 7) % 300)
try { if ((await fetch(`http://127.0.0.1:${INSPECT}/json/version`, { signal: AbortSignal.timeout(500) })).ok) throw new Error(`port ${INSPECT} already serves an inspector — a stale Electron is alive`) } catch (e) { if (String(e.message).includes('stale')) throw e }
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-window-guard-'))
const APP_ARGS = [`--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`, '--use-mock-keychain']
const child = spawn(BUNDLE ? BIN : 'npx', BUNDLE ? APP_ARGS : ['electron', '.', ...APP_ARGS], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(api.address().port), BEACON_GATEWAY_WS_PORT: String(wsHost.address().port) }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const reap = () => { if (reaped) return; reaped = true; try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} } for (const s of [wss, wsHost, api, foreign]) { try { s.close() } catch {} } try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {} }
process.on('exit', reap)
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.stack ?? e); console.error(mainLog.join('').slice(-1500)); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.stack ?? e); console.error(mainLog.join('').slice(-1500)); reap(); process.exit(1) })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); process.exit(2) } })

// ── the main-process inspector ────────────────────────────────────────────────────────────────────
let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250)
  try { target = (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json()).find((t) => t.type === 'node') } catch {}
}
if (!target) throw new Error('no main-process inspector target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('inspector socket failed')), { once: true }) })
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out — is a modal blocking main?`)) } }, 20000)
})
const M = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`main eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result?.value
}
await send('Runtime.enable')
// Retry until Electron's module loader is hooked; never return the module by value (both are known
// ways a one-shot attach reports "Internal error" on macOS).
for (let i = 0; ; i++) {
  const t = await M(`(() => { try { if (process.mainModule) globalThis.__electron = process.mainModule.require('electron') } catch {} return typeof globalThis.__electron?.app })()`)
  if (t === 'object') break
  if (i > 80) throw new Error('electron API never became reachable in main')
  await sleep(250)
}

// A window's shell renderer, identified by its hash route ('' = the main window).
const SHELL_URL = pathToFileURL(SHELL_FILE).href
await M(`globalThis.__win = (route) => globalThis.__electron.BrowserWindow.getAllWindows().find((w) => {
  if (w.isDestroyed() || w.__probeStranger) return false
  try { const u = new URL(w.webContents.getURL()); return u.protocol === 'file:' && decodeURIComponent(u.pathname) === ${JSON.stringify(SHELL_FILE)} && u.hash === (route ? '#' + route : '') } catch { return false }
}) ?? null; true`)

async function waitFor(expr, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await M(expr).catch(() => false)) return true; await sleep(200) }
  return false
}
const mainUp = await waitFor(`(() => { const w = __win(''); return !!w && !w.webContents.isLoading() })()`, 30000)
check(mainUp, 'the main window is up on THIS checkout\'s shell page', mainLog.join('').slice(-800))
// The page the sender check compares against, asked of the RUNNING check: the shell-windows chunk main
// actually loaded (inside app.asar when packaged), not a path this probe works out for itself.
const running = await M(`(() => {
  const cache = process.getBuiltinModule('module')._cache
  const file = Object.keys(cache).find((f) => f.includes('/out/main/chunks/shell-windows-') && f.endsWith('.js'))
  return file ? { file, shellUrl: cache[file].exports.shellUrl() } : null
})()`)
fact(`the running sender check (${running?.file ?? 'not found'}) compares against ${running?.shellUrl ?? '—'}`)
check(running !== null && running.shellUrl === SHELL_URL, 'the running sender check, loaded from a shared chunk, compares against THIS build\'s shell page', JSON.stringify(running))
await waitFor(`__win('').webContents.executeJavaScript("!!document.querySelector('nav[aria-label=\\"Views\\"]')")`, 20000)

// ── open every window type through its REAL code path ─────────────────────────────────────────────
// capture and HUD are opened by module-private functions (a global shortcut and the tray). They are
// reached through the inspector: an IPC handler defined in main's module closes over them, and V8
// lists a closure's scopes. That calls the same function the shortcut and the tray do.
//
// What ipcMain holds is handleFromShell's wrapper, and shell-windows is in a shared chunk (see
// smoke:shell-url), so the wrapper's own scopes are that chunk's. index.ts's are one closure in, on
// the handler it wraps. The search follows function-valued closure variables one level down.
async function grabModuleFn(name) {
  const scopesOf = async (objectId) => {
    const props = await send('Runtime.getProperties', { objectId, ownProperties: false })
    const scopes = props.internalProperties?.find((p) => p.name === '[[Scopes]]')
    if (!scopes) return []
    const list = await send('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true })
    const out = []
    for (const s of list.result) if (s.value?.objectId) out.push({ kind: s.value.description ?? '', vars: (await send('Runtime.getProperties', { objectId: s.value.objectId, ownProperties: true })).result })
    return out
  }
  const h = await send('Runtime.evaluate', { expression: `__electron.ipcMain._invokeHandlers.get('close-mode:get')` })
  let frontier = [h.result.objectId]
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = []
    for (const id of frontier) {
      for (const s of await scopesOf(id)) {
        const hit = s.vars.find((v) => v.name === name && v.value?.type === 'function')
        if (hit) {
          await send('Runtime.callFunctionOn', { objectId: hit.value.objectId, functionDeclaration: `function (n) { globalThis[n] = this }`, arguments: [{ value: `__fn_${name}` }] })
          return true
        }
        if (s.kind.startsWith('Closure')) for (const v of s.vars) if (v.value?.type === 'function' && v.value.objectId) next.push(v.value.objectId)
      }
    }
    frontier = next
  }
  return false
}
check(await grabModuleFn('toggleCaptureWindow'), 'reached toggleCaptureWindow (what the capture shortcut calls)')
check(await grabModuleFn('toggleHudWindow'), 'reached toggleHudWindow (what a tray click calls on macOS)')
await M(`__fn_toggleCaptureWindow(); true`)
await M(`__fn_toggleHudWindow(); true`)
// The pop-outs are opened from the main window's own bridge, exactly as their buttons do.
await M(`__win('').webContents.executeJavaScript('window.beacon.terminal.popOut()')`)
await M(`__win('').webContents.executeJavaScript('window.beacon.browser.detach(), true')`)

const ROUTES = ['', 'capture', 'hud', 'terminal', 'browser']
const NAME = { '': 'main window', capture: 'quick-capture', hud: 'tray HUD', terminal: 'terminal pop-out', browser: 'browser pop-out' }
for (const r of ROUTES) {
  const up = await waitFor(`(() => { const w = __win(${JSON.stringify(r)}); return !!w && !w.webContents.isLoading() })()`)
  check(up, `${NAME[r]} exists and shows the shell page (#${r || '—'})`)
}
// The bridge exists in every one of them — that is what makes a foreign document there matter.
for (const r of ROUTES) {
  const t = await M(`__win(${JSON.stringify(r)})?.webContents.executeJavaScript('typeof window.beacon') ?? 'no window'`)
  check(t === 'object', `${NAME[r]}: the shell page has window.beacon (control: the bridge is present)`, `got ${t}`)
}

// Reads what the document in a window's top frame is, and what the bridge does for it there.
async function probeTop(expr) {
  return M(`(async () => {
    const w = ${expr}
    if (!w || w.isDestroyed()) return { url: null }
    const url = w.webContents.getURL()
    let bridge = 'n/a', peers = 'n/a'
    try { bridge = await w.webContents.executeJavaScript('typeof window.beacon') } catch (e) { bridge = 'threw' }
    if (bridge === 'object') {
      try { peers = await w.webContents.executeJavaScript('window.beacon.terminal.peers().then((r) => (r && r.error === "refused") ? "refused" : "accepted")') } catch (e) { peers = 'threw' }
    }
    return { url, bridge, peers }
  })()`)
}
// settings.get and daemon.get from a window's top frame. Each reply is classified against the one
// answer only an accepted call can produce; `reached` is whether the gateway saw the daemon read.
const SENTINEL_KEY = 'probe:window-guard-sentinel'
const SENTINEL_VALUE = `seeded-${process.pid}-${Date.now()}`
let readSeq = 0
async function probeReads(expr) {
  const path = `/api/status?probe=${++readSeq}`
  const r = await M(`(async () => {
    const w = ${expr}
    if (!w || w.isDestroyed()) return null
    const js = (s) => w.webContents.executeJavaScript(s).catch((e) => 'threw: ' + e.message)
    return {
      settings: await js(${JSON.stringify(`window.beacon.settings.get(${JSON.stringify(SENTINEL_KEY)})`)}),
      daemon: await js(${JSON.stringify(`window.beacon.daemon.get(${JSON.stringify(path)})`)}),
      browser: await js('window.beacon.browser.state()')
    }
  })()`)
  const kind = (v, accepted) => (accepted ? 'accepted' : v === null ? 'refused' : `other ${JSON.stringify(v)}`.slice(0, 80))
  return {
    settings: kind(r?.settings, r?.settings === SENTINEL_VALUE),
    daemon: kind(r?.daemon, r?.daemon?.model === 'stub'),
    browser: kind(r?.browser, Array.isArray(r?.browser?.tabs)),
    reached: apiHits.includes(path)
  }
}
// The browser pane answers only its two hosts, so a correct shell page elsewhere is refused by it.
const PANE_HOSTS = new Set(['', 'browser'])
const paneAnswer = (r) => (PANE_HOSTS.has(r) ? 'accepted' : 'refused')
const isForeign = (u) => typeof u === 'string' && u.startsWith(FOREIGN)
const restore = (r) => M(`(() => { const w = globalThis.__lastWin; if (w && !w.isDestroyed()) w.loadURL(${JSON.stringify(SHELL_URL)} + ${JSON.stringify(r ? '#' + r : '')}); return true })()`)

// ── 1. the navigation guard ───────────────────────────────────────────────────────────────────────
section('1. a page-initiated navigation to a foreign page is refused in every Beacon window')
{
  // CONTROL: the probe's navigation must actually raise will-navigate, or every "refused" below
  // would be a navigation that never happened. The main window's guard refuses file:// on every
  // version of this code, and says so in main's log.
  const before = mainLog.join('').split('refused will-navigate').length
  await M(`__win('').webContents.executeJavaScript("location.href = 'file:///etc/hosts'; true")`)
  await sleep(1200)
  const after = mainLog.join('').split('refused will-navigate').length
  const stayed = await M(`__win('') !== null`)
  check(after > before && stayed, 'control: the probe\'s navigation reaches will-navigate (main refused a file:// target and logged it)')
}
for (const r of ROUTES) {
  const hitsBefore = foreignHits.length
  await M(`(() => { globalThis.__lastWin = __win(${JSON.stringify(r)}); globalThis.__lastWin.webContents.executeJavaScript("location.href = '${FOREIGN}/nav?w=${r || 'main'}'; true").catch(() => {}); return true })()`)
  await sleep(1500)
  const top = await probeTop('globalThis.__lastWin')
  fact(`${NAME[r]}: top frame after location= ${isForeign(top.url) ? 'IS THE FOREIGN PAGE' : 'is still the shell'}; foreign server hits +${foreignHits.length - hitsBefore}; bridge ${top.bridge}; terminal.peers ${top.peers}`)
  check(!isForeign(top.url), `${NAME[r]}: navigation to a foreign page was refused`, `landed on the foreign page; window.beacon is ${top.bridge}; terminal.peers() was ${top.peers}`)
  if (isForeign(top.url)) await restore(r)
  await waitFor(`(() => { const w = __win(${JSON.stringify(r)}); return !!w && !w.webContents.isLoading() })()`)
}

section('1b. a synthetic dropped link (FACT only — see below)')
{
  // A synthetic drop through CDP Input.dispatchDragEvent (via webContents.debugger), aimed away
  // from the composer. It is NOT a check: on the unfixed build (2026-09-24) it did not navigate the
  // window either, so it cannot tell a guarded window from an unguarded one — CDP's drag does not
  // seem to reach Chromium's navigate-on-drop default. A real drop needs a person or an OS-level
  // drag. What section 1 does prove covers it: a drop's only effect on the shell is the navigation
  // it starts, and every page-initiated navigation to a foreign page is refused.
  const hitsBefore = foreignHits.length
  const dropped = await M(`(async () => {
    const w = __win(''); globalThis.__lastWin = w
    const d = w.webContents.debugger
    try { d.attach('1.3') } catch (e) { return 'attach failed: ' + e.message }
    const [cw, ch] = w.getContentSize()
    const at = { x: Math.round(cw / 2), y: Math.round(ch / 3) }
    const data = { items: [{ mimeType: 'text/uri-list', data: '${FOREIGN}/drop' }, { mimeType: 'text/plain', data: '${FOREIGN}/drop' }], dragOperationsMask: 1 | 2 | 16 }
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await d.sendCommand('Input.dispatchDragEvent', { type, ...at, data })
    } catch (e) { return 'dispatch failed: ' + e.message } finally { try { d.detach() } catch {} }
    return 'dispatched'
  })()`)
  await sleep(1500)
  const top = await probeTop('globalThis.__lastWin')
  fact(`drop: ${dropped}; top frame ${isForeign(top.url) ? 'IS THE FOREIGN PAGE' : 'is still the shell'}; foreign server hits +${foreignHits.length - hitsBefore}; bridge ${top.bridge}; terminal.peers ${top.peers}`)
  if (isForeign(top.url)) await restore('')
  await waitFor(`(() => { const w = __win(''); return !!w && !w.webContents.isLoading() })()`)
}

section('1c. window.open from a satellite does not create a bridged window')
for (const r of ['capture', 'hud']) {
  const before = await M(`__electron.BrowserWindow.getAllWindows().length`)
  await M(`__win(${JSON.stringify(r)}).webContents.executeJavaScript("window.open('${FOREIGN}/open?w=${r}'), true").catch(() => {}); true`)
  await sleep(1500)
  const after = await M(`__electron.BrowserWindow.getAllWindows().length`)
  const kid = await M(`(async () => {
    const w = __electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('${FOREIGN}/open'))
    if (!w) return null
    globalThis.__lastWin = w
    let bridge = 'n/a'
    try { bridge = await w.webContents.executeJavaScript('typeof window.beacon') } catch { bridge = 'threw' }
    return { bridge }
  })()`)
  fact(`${NAME[r]}: window.open → windows ${before} → ${after}; ${kid ? `a child on the foreign page, window.beacon ${kid.bridge}` : 'no child on the foreign page'}`)
  check(!kid, `${NAME[r]}: window.open of a foreign page made no window`, kid ? `a child window opened on it with window.beacon ${kid.bridge}` : '')
  if (kid) await M(`(() => { globalThis.__lastWin.destroy(); return true })()`)
}

// ── 2. the sender check ───────────────────────────────────────────────────────────────────────────
section('2. the sender check: only a Beacon window showing the shell page is accepted')
{
  // The settings sentinel, written straight into the scratch profile's app.db from main (a second
  // connection; WAL lets it share the file). Not through settings.set or any other handler.
  const seeded = await M(`(() => {
    // Resolved from the built main bundle, as the app resolves it: process.mainModule here is Electron's own.
    const Database = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(APP_ROOT, 'out/main/index.js'))})('better-sqlite3')
    const db = new Database(${JSON.stringify(join(USER_DATA, 'app.db'))}, { fileMustExist: true })
    try {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(${JSON.stringify(SENTINEL_KEY)}, ${JSON.stringify(SENTINEL_VALUE)})
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(${JSON.stringify(SENTINEL_KEY)})?.value ?? null
    } finally { db.close() }
  })()`)
  check(seeded === SENTINEL_VALUE, 'setup: a sentinel settings row is seeded in the scratch profile (directly in main, not through IPC)', `read back ${JSON.stringify(seeded)}`)
  // Positive control first: the real shell is accepted, or every refusal below means nothing.
  for (const r of ROUTES) {
    const top = await probeTop(`__win(${JSON.stringify(r)})`)
    check(top.peers === 'accepted', `${NAME[r]}: the shell page itself is ACCEPTED by the terminal guard (control)`, `got ${top.peers}`)
  }
  for (const r of ROUTES) {
    const rd = await probeReads(`__win(${JSON.stringify(r)})`)
    check(rd.settings === 'accepted' && rd.daemon === 'accepted' && rd.reached && rd.browser === paneAnswer(r), `${NAME[r]}: the shell page itself reads settings.get and daemon.get, the gateway sees the read, and browser.state is ${paneAnswer(r)} (control)`, JSON.stringify(rd))
  }
  // A foreign document force-loaded by main (loadURL skips will-navigate — a stand-in for a window
  // whose guard is missing) still has the bridge, and must be refused.
  for (const r of ['', 'hud']) {
    await M(`(() => { globalThis.__lastWin = __win(${JSON.stringify(r)}); globalThis.__lastWin.loadURL('${FOREIGN}/forced?w=${r || 'main'}'); return true })()`)
    await waitFor(`!globalThis.__lastWin.webContents.isLoading() && globalThis.__lastWin.webContents.getURL().startsWith('${FOREIGN}')`)
    const top = await probeTop('globalThis.__lastWin')
    const rd = await probeReads('globalThis.__lastWin')
    fact(`${NAME[r]} force-loaded with a foreign page: bridge ${top.bridge}; terminal.peers ${top.peers}; settings.get ${rd.settings}; daemon.get ${rd.daemon}, gateway ${rd.reached ? 'REACHED' : 'not reached'}; browser.state ${rd.browser}`)
    check(isForeign(top.url) && top.bridge === 'object', `${NAME[r]}: the force-loaded foreign page is really there and has the bridge (setup)`, JSON.stringify(top))
    check(top.peers === 'refused', `${NAME[r]}: the terminal guard REFUSES a foreign document in a Beacon window`, `got ${top.peers}`)
    check(rd.settings === 'refused', `${NAME[r]}: settings.get REFUSES a foreign document in a Beacon window (null, not the stored value)`, `got ${rd.settings}`)
    check(rd.daemon === 'refused' && !rd.reached, `${NAME[r]}: daemon.get REFUSES a foreign document in a Beacon window, and the gateway never sees the request`, JSON.stringify(rd))
    if (r === '') check(rd.browser === 'refused', 'main window: browser.state REFUSES a foreign document there, though the main window is a pane host', `got ${rd.browser}`)
    await restore(r)
    await waitFor(`(() => { const w = __win(${JSON.stringify(r)}); return !!w && !w.webContents.isLoading() })()`)
  }
  // A window Beacon never created, showing the real shell page with the real preload.
  await M(`(() => {
    const w = new __electron.BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(PRELOAD)}, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    w.__probeStranger = true
    globalThis.__stranger = w
    w.loadURL(${JSON.stringify(SHELL_URL + '#hud')})
    return true
  })()`)
  await waitFor(`!globalThis.__stranger.webContents.isLoading()`)
  const top = await probeTop('globalThis.__stranger')
  const rd = await probeReads('globalThis.__stranger')
  fact(`a stranger window on the shell page: bridge ${top.bridge}; terminal.peers ${top.peers}; settings.get ${rd.settings}; daemon.get ${rd.daemon}, gateway ${rd.reached ? 'REACHED' : 'not reached'}; browser.state ${rd.browser}`)
  check(top.bridge === 'object' && typeof top.url === 'string' && top.url.startsWith(SHELL_URL), 'the stranger window really shows the shell page with the bridge (setup)', JSON.stringify(top))
  check(top.peers === 'refused', 'the terminal guard REFUSES a window Beacon did not create, even on the shell page', `got ${top.peers}`)
  check(rd.settings === 'refused', 'settings.get REFUSES a window Beacon did not create, even on the shell page', `got ${rd.settings}`)
  check(rd.daemon === 'refused' && !rd.reached, 'daemon.get REFUSES a window Beacon did not create, and the gateway never sees the request', JSON.stringify(rd))
  await M(`(() => { globalThis.__stranger.destroy(); return true })()`)
}

// After everything, the real windows still work (a guard that broke the app would pass section 1).
section('3. the real windows still work')
for (const r of ROUTES) {
  const top = await probeTop(`__win(${JSON.stringify(r)})`)
  const rd = await probeReads(`__win(${JSON.stringify(r)})`)
  check(top.url !== null && top.peers === 'accepted' && rd.settings === 'accepted' && rd.daemon === 'accepted' && rd.reached && rd.browser === paneAnswer(r), `${NAME[r]}: still on the shell and still accepted (terminal.peers, settings.get, daemon.get; browser.state ${paneAnswer(r)})`, JSON.stringify({ ...top, ...rd }))
}

// The inspector socket and the stub servers keep this process alive, so end it explicitly; the
// verdict runs on 'exit'.
ws.close()
reap()
process.exit()
