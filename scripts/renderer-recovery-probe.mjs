#!/usr/bin/env node
// renderer-recovery-probe — when the MAIN window's renderer process dies, does the window come back?
//
// WHY A PROBE AND NOT ONLY A SMOKE. smoke:recovery proves the POLICY: given a reason, a crash history
// and the quitting flag, crashDecision returns reload / stop / ignore, and the threshold is not off by
// one. It cannot prove the CONSEQUENCE — that main actually calls webContents.loadURL again and that a
// person ends up looking at a working window instead of a frozen one. A decision function can be
// perfectly correct and still be wired to nothing, and that wiring is the whole point of this change.
//
// So this drives the REAL built app: webContents.forcefullyCrashRenderer() kills the renderer for
// real, and the assertions read back the window's state through CDP afterwards.
//
// WHAT IS MEASURED, and why each is there:
//   1. the renderer really died (precondition — without it every check below is vacuous)
//   2. the window RECOVERS: a live DOM again, and it is Beacon's, not a blank one
//   3. the recovery is not a fluke of the first crash — it happens again
//   4. a LOOP STOPS: on the third crash in the window, main stops reloading and raises the native
//      dialog. (2) and (3) are the control for this: they prove reloading works, so the stop is a
//      decision and not broken recovery.
//   5. the durable record exists on disk and names the reason — the answer to "did this start after
//      the update?", which no console line survives in a packaged build
//
// The dialog is native, so CDP cannot see it. It is observed by patching dialog.showMessageBox from
// the MAIN inspector: the bundle calls electron.dialog.showMessageBox through property lookup and
// Node caches modules per process, so the patch intercepts the shipped call path rather than a copy
// of it. The patch RECORDS and resolves immediately — it never shows a modal, so the probe cannot
// hang on a dialog nobody can click.
//
// RUN (not part of verify — it launches the built app; the runner has no display):
//   npm run build && node scripts/renderer-recovery-probe.mjs
//
// SANDBOXED RUNNERS (read-only /dev/shm): PROBE_ELECTRON_ARGS="--disable-dev-shm-usage"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
// `require` as an EXPRESSION evaluated in the inspector: getBuiltinModule('module').createRequire is
// the same idiom browser-pane-probe uses, so 'electron' resolves through the app's own loader in dev
// and in the packaged asar alike. The inspector scope has no bare `require`.
const R = `(process.getBuiltinModule('module').createRequire(process.cwd() + '/'))`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`)

// ── the stub gateway ─────────────────────────────────────────────────────────
// Recovery is not daemon-dependent, but the app must get PAST the setup wizard to have a main window
// to crash. A minimal REST + WS stub is enough. A REAL socket, not a dead port: a dead WS makes the
// connection churn `reconnecting`, which remounts MainView and would muddy "did the DOM come back".
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const site = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url.startsWith('/api/sessions')) return json(res, 200, [])
  json(res, 200, [])
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (sock) => {
  try { sock.send(JSON.stringify({ type: 'connected' })) } catch { /* closing */ }
  sock.on('error', () => undefined)
})
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))
const WS_PORT = wsSite.address().port

// ── launch ───────────────────────────────────────────────────────────────────
// --inspect reaches the MAIN process (forcefullyCrashRenderer is main-only); the remote-debugging
// port reaches the renderer (where recovery is observed). Both are needed and neither is sufficient.
const CDP = 9700 + (process.pid % 200)
const INSPECT = 9700 + ((process.pid + 7) % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-recovery-probe-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(API_PORT), BEACON_GATEWAY_WS_PORT: String(WS_PORT) }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
const closeStubs = () => { for (const c of [wss, wsSite, site]) { try { c.close() } catch { /* gone */ } } }
async function reapAndExit(code) {
  reap(); closeStubs()
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) process.exit(code)
    await sleep(100)
  }
  killGroup('SIGKILL')
  process.exit(code)
}
// ANY exit takes the app down — including an uncaught throw, which skips reapAndExit. Without this a
// probe that died mid-run left its Electron running (measured: on the mini one ran orphaned for 70
// minutes; here one survived an inspector 'Internal error'). reap() is synchronous, so it works in
// an 'exit' handler.
process.on('exit', () => reap())
process.on('uncaughtException', (e) => { console.error('[probe] threw: ' + (e?.stack ?? e)); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('[probe] rejected: ' + (e?.stack ?? e)); process.exit(1) })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) } })

// ── CDP ──────────────────────────────────────────────────────────────────────
async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find(pick)
      if (t) return t
    } catch { /* not yet */ }
  }
  return null
}
async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
async function client(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method) events.push(m)
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`${method} timed out`)) } }, 20000)
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.error) throw new Error(r.error.message)
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }) })
  return { send, evaluate, events, ws }
}
async function until(fn, ms = 25000, every = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

// ── main inspector ───────────────────────────────────────────────────────────
const nodeT = await attach(INSPECT, (t) => t.type === 'node')
check(!!nodeT, 'main-process inspector target found (--inspect)', nodeT ? '' : mainLog.join('').slice(-600))
if (!nodeT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const M = await client(nodeT.webSocketDebuggerUrl)
await M.send('Runtime.enable')

// `electron` in the inspector scope: no bare `require` there, so go through createRequire from the
// Node builtin — the same idiom browser-pane-probe uses. This resolves the REAL module object the
// bundle holds, which is why patching its .dialog below intercepts the shipped call path.
const E = `(${R}('electron'))`
// Retried, not one-shot: attached this early, main may not have finished starting, and the inspector
// answers the first evaluate with 'Internal error' (measured on macOS). Poll until it resolves.
const resolved = await until(async () => { await M.evaluate(`globalThis.__electron = ${E}`); return true })
check(!!resolved, 'electron resolved in the main inspector (polled until main was ready)')
check(await M.evaluate(`typeof globalThis.__electron.dialog?.showMessageBox === 'function'`), 'electron.dialog resolved in the main inspector')
check(await M.evaluate(`typeof globalThis.__electron.BrowserWindow?.getAllWindows === 'function'`), 'electron.BrowserWindow resolved in the main inspector')

// ── patch the native dialog so the probe can see the `stop` branch ───────────
// Native dialogs are invisible to CDP. This records the call and resolves immediately with button 0
// ("Quit Beacon"), so the probe never hangs on a modal nobody can click. It patches the REAL
// electron.dialog object, which is the one the bundle calls through — not a stand-in.
await M.evaluate(`
  globalThis.__dialogCalls = []
  const d = globalThis.__electron.dialog
  globalThis.__origShowMessageBox = d.showMessageBox
  d.showMessageBox = (opts) => {
    globalThis.__dialogCalls.push({ title: opts.title, message: opts.message, detail: opts.detail, buttons: opts.buttons })
    return Promise.resolve({ response: 0, checkboxChecked: false })
  }
  // app.quit would tear the app down mid-probe; record it instead.
  globalThis.__quitCalls = 0
  globalThis.__origQuit = globalThis.__electron.app.quit
  globalThis.__electron.app.quit = () => { globalThis.__quitCalls++ }
`)
check(await M.evaluate(`typeof globalThis.__origShowMessageBox === 'function' && globalThis.__dialogCalls.length === 0`), 'dialog patched (recording, non-blocking) before any crash')

// ── renderer inspector + the main window handle ──────────────────────────────
const pageT = await attach(CDP, (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
check(!!pageT, 'shell renderer target found', pageT ? '' : (await targets(CDP)).map((t) => `${t.type}:${t.url.slice(0, 70)}`).join(' | '))
if (!pageT) await reapAndExit(2)
let P = await client(pageT.webSocketDebuggerUrl)
await P.send('Runtime.enable')
check(await P.evaluate(`!!document.querySelector('.navrail') || !!document.querySelector('[class*=app-chrome], .messages')`), 'the main view is up before we crash it')

// The window handle in MAIN, used to crash it and to read back its state.
const WIN = `globalThis.__electron.BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Beacon')`
check(await M.evaluate(`!!(${WIN})`), "the main window is reachable from main by title 'Beacon'")

// A marker proving a given DOM is a NEW document rather than the one we crashed. Set after each
// recovery; if recovery is really a reload, the marker is gone from the new document.
const mark = async (tag) => { await P.evaluate(`window.__recoveryMarker = ${JSON.stringify(tag)}`) }
const marker = async () => P.evaluate(`window.__recoveryMarker ?? null`).catch(() => null)

async function crashRenderer() {
  await M.evaluate(`(${WIN}).webContents.forcefullyCrashRenderer()`)
}
/** Wait for the page target to come back with a LIVE Beacon DOM (not about:blank, not a stale target). */
async function awaitRecovery(ms = 20000) {
  const t0 = Date.now()
  let client2 = null
  for (;;) {
    const ts = await targets(CDP)
    const t = ts.find((x) => x.type === 'page' && x.url.includes('index.html') && !x.url.includes('#'))
    if (t) {
      try {
        if (!client2 || client2.__url !== t.webSocketDebuggerUrl) {
          if (client2) { try { client2.ws.close() } catch { /* gone */ } }
          client2 = await client(t.webSocketDebuggerUrl)
          client2.__url = t.webSocketDebuggerUrl
          await client2.send('Runtime.enable')
        }
        const live = await client2.evaluate(`(function(){ try { return !!document.querySelector('.messages, [class*=app-chrome], .navrail') } catch { return false } })()`)
        if (live) return client2
      } catch { /* target mid-navigation */ }
    }
    if (Date.now() - t0 > ms) return null
    await sleep(300)
  }
}

// ── 1. the renderer really dies ──────────────────────────────────────────────
section('precondition: forcefullyCrashRenderer kills the renderer')
await mark('pre-crash')
check(await marker() === 'pre-crash', 'the marker is set on the live document (so its disappearance proves a reload)')
const urlBefore = await M.evaluate(`(${WIN}).webContents.getURL()`)
await crashRenderer()
// WHY NOT isCrashed(). The first cut of this probe sampled webContents.isCrashed() ~1.2s after the
// crash and it read `false` — because by then the fix had ALREADY reloaded the window, so the
// renderer was alive again. Sampling a transient that recovery is designed to end is not a valid
// precondition; a passing reload would always look like "the crash never happened".
//
// The honest evidence is the handler's OWN log line, emitted synchronously when render-process-gone
// fires. If main logged it, the event reached the wired handler — which is precisely the thing under
// test (was it wired at all?). A crash with no reload would also log it; the recovery checks below
// are what distinguish those.
const crashLogged = await until(async () => {
  const line = mainLog.join('').match(/\[shell\] main window renderer ended \(([^)]+)\)/)
  return line ? line[1] : null
}, 8000)
check(!!crashLogged, 'render-process-gone FIRED and reached the wired handler (its own log line) — without this every check below is vacuous', mainLog.join('').slice(-300))
// The reason forcefullyCrashRenderer produces is PLATFORM-dependent — measured, Electron 44.4.1:
// Linux reports 'crashed', macOS reports 'killed'. Both are real render-process-gone reasons the
// policy reloads on. What this check exists to rule out is a SYNTHETIC or absent reason, and a
// 'clean-exit' (which the policy deliberately ignores), so it asserts the platform's real one.
const EXPECTED_REASON = process.platform === 'darwin' ? 'killed' : 'crashed'
check(crashLogged === EXPECTED_REASON, `the reason main saw is Electron's real one for this platform, '${EXPECTED_REASON}' (got ${JSON.stringify(crashLogged)}) — so the policy is not being fed a synthetic reason`)

// ── 2. the window recovers ───────────────────────────────────────────────────
section('crash 1 → main reloads the window and a person gets Beacon back')
let P2 = await awaitRecovery(25000)
check(!!P2, 'a renderer target comes back with a LIVE Beacon DOM (not about:blank)')
if (!P2) { console.error('no recovery; main log tail:\n' + mainLog.join('').slice(-1500)); await reapAndExit(1) }
check(await P2.evaluate(`window.__recoveryMarker ?? null`) === null, 'the marker is GONE — this is a NEW document, i.e. a real reload, not the crashed one repainted')
const urlAfter = await M.evaluate(`(${WIN}).webContents.getURL()`)
check(urlAfter === urlBefore && urlAfter.includes('index.html'), `the window reloaded the SAME app (${urlBefore.slice(-28)} → ${urlAfter.slice(-28)})`)
const dialogAfter1 = await M.evaluate(`globalThis.__dialogCalls.length`)
check(dialogAfter1 === 0, 'no dialog after the FIRST crash — a single crash recovers silently, which is the point')
check(await M.evaluate(`globalThis.__quitCalls`) === 0, 'and it did not quit the app')
P = P2

// ── 3. recovery is repeatable, not a fluke of the first crash ────────────────
section('crash 2 → recovers again (the control for the loop test below)')
await P.evaluate(`window.__recoveryMarker = 'before-crash-2'`)
await crashRenderer()
const P3 = await awaitRecovery(25000)
check(!!P3, 'the window recovers a SECOND time')
if (P3) {
  check(await P3.evaluate(`window.__recoveryMarker ?? null`) === null, 'again a NEW document, not the crashed one')
  check(await M.evaluate(`globalThis.__dialogCalls.length`) === 0, 'still no dialog at crash 2 — recovery has not started failing')
  P = P3
} else { await reapAndExit(1) }

// ── 4. a LOOP STOPS ──────────────────────────────────────────────────────────
// Crashes 1 and 2 recovered, so reloading demonstrably works. If crash 3 does NOT recover, that is a
// decision rather than broken recovery — which is the only way this assertion means anything.
section('crash 3 in the window → main STOPS reloading and raises the native dialog')
await crashRenderer()
const dialogSeen = await until(async () => {
  const n = await M.evaluate(`globalThis.__dialogCalls.length`)
  return n > 0 ? n : null
}, 20000)
check(!!dialogSeen, 'the stop dialog was raised on the THIRD crash in the window')
const calls = await M.evaluate(`globalThis.__dialogCalls`)
if (calls?.length) {
  const c = calls[calls.length - 1]
  // In the HEADLINE, not only the title: macOS does not render a message box's title at all.
  check(/stopped/i.test(c.message ?? ''), `the dialog's headline says recovery STOPPED (${JSON.stringify(c.message)}) — macOS shows no title, and a dead window and a paused one must not look the same`)
  check(/3/.test(c.message ?? '') && /(crashed|crash)/i.test(c.message ?? ''), 'the message carries the crash COUNT — the evidence, so a report is not just "it broke"')
  check(/reason=|oom|crashed|killed/i.test(`${c.message} ${c.detail}`), `the message or detail names the REASON (${JSON.stringify(c.detail).slice(0, 90)})`)
  check(/renderer-crashes\.json/.test(c.detail ?? ''), 'the detail names the RECORD FILE, so someone can go read it')
  check(Array.isArray(c.buttons) && c.buttons.length === 1 && /quit/i.test(c.buttons[0]), `one button and it is Quit — "reload anyway" would be a way to re-enter the loop by hand (${JSON.stringify(c.buttons)})`)
}
check(await M.evaluate(`globalThis.__quitCalls`) === 1, 'the app was told to quit after the dialog (button 0) — the honest exit')

// Did it actually STOP reloading? The window must not have come back with a live DOM.
const stillDown = await (async () => {
  await sleep(3000)
  const ts = await targets(CDP)
  const t = ts.find((x) => x.type === 'page' && x.url.includes('index.html') && !x.url.includes('#'))
  if (!t) return true
  try {
    const c = await client(t.webSocketDebuggerUrl)
    await c.send('Runtime.enable')
    const live = await c.evaluate(`(function(){ try { return !!document.querySelector('.messages, [class*=app-chrome], .navrail') } catch { return false } })()`)
    try { c.ws.close() } catch { /* gone */ }
    return !live
  } catch { return true }
})()
check(stillDown, 'and the window STAYED down — it did not reload into a fourth crash (a reload that cannot stop is not recovery)')

// ── 5. the durable record ────────────────────────────────────────────────────
section('the crash record survives the crash it describes')
const recordPath = join(USER_DATA, 'renderer-crashes.json')
check(existsSync(recordPath), 'renderer-crashes.json exists in userData')
if (existsSync(recordPath)) {
  const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
  check(Array.isArray(rec) && rec.length === 3, `it holds one row per crash, three of them (got ${Array.isArray(rec) ? rec.length : 'not an array'})`)
  const reasons = new Set(rec.map((r) => r.reason))
  check(reasons.size > 0 && [...reasons].every((r) => typeof r === 'string'), `every row names a reason (${[...reasons].join(',')})`)
  check(rec.every((r) => typeof r.at === 'number' && r.at > 1_600_000_000_000), 'every row carries an epoch-ms timestamp — without it the rows cannot be placed in a window')
  check(rec.every((r) => typeof r.appVersion === 'string' && r.appVersion.length > 0), `every row carries appVersion (${rec[0]?.appVersion}) — that is what makes "did this start after the update?" answerable`)
  check(rec[0].at >= rec[rec.length - 1].at, 'newest-first, as documented')
}

section('result')
console.log(failures === 0
  ? 'PASS — a crashed renderer is recovered, and a crash loop stops and says so'
  : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (platform-bound, verify on the Mac):')
console.log('  * the dialog is observed by patching electron.dialog, so its LAYOUT and its real modality')
console.log('    (whether it blocks, how it reads on macOS) are not seen here — only that the shipped')
console.log('    code path called it with these words and these buttons')
console.log('  * the macOS dock badge / traffic-light behaviour is not exercised at all')
console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-400))
await reapAndExit(failures === 0 ? 0 : 1)
