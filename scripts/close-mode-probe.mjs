#!/usr/bin/env node
// close-mode-probe — does ✕ actually hide to tray, and does the quit setting actually quit?
//
// smoke:tray-hint proves the MODEL (planClose's truth table) and that main's source WIRES it. It
// cannot prove the live consequence: that closing the window in tray mode HIDES it while the app
// keeps running, and that in quit mode the process EXITS rather than surviving headless with no
// window. That second one is a real defect this probe exists to catch — `window-all-closed` is a
// deliberate no-op (tray persistence), so a ✕-means-quit setting that merely "lets the close through"
// would strand the app with no window and no way back. Only a launched app shows which happened.
//
// It drives the REAL shipped handlers via the main inspector: the close-mode IPC handler (the same
// one the renderer's setCloseMode reaches) and win.close() (the same path the ✕ button takes). The
// hint notification's PIXELS are Mac-bound (headless Linux reports Notification.isSupported() false),
// so this asserts the hint ROW was persisted once — the durable proof showHint fired — not the toast.
//
// RUN: npm run build && DISPLAY=:1 node scripts/close-mode-probe.mjs
// SANDBOXED: PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`); if (!ok) failures++ }
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 64 - t.length))}`)

const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s) }
const site = createServer((req, res) => { const u = req.url ?? ''; if (u.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 }); json(res, 200, []) })
await new Promise((r) => site.listen(0, '127.0.0.1', r)); const API_PORT = site.address().port
const wsSite = createServer(); const { WebSocketServer } = await import('ws'); const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (s) => { try { s.send(JSON.stringify({ type: 'connected' })) } catch {} s.on('error', () => {}) })
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r)); const WS_PORT = wsSite.address().port

const INSPECT = 9700 + ((process.pid + 29) % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-closemode-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(API_PORT), BEACON_GATEWAY_WS_PORT: String(WS_PORT) }
})
const mainLog = []; child.stdout.on('data', (d) => mainLog.push(String(d))); child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
let expectExit = false       // set true before the quit-mode close, so an exit there is the PASS condition
let exitedCode = null
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
const closeStubs = () => { for (const c of [wss, wsSite, site]) { try { c.close() } catch {} } }
async function reapAndExit(code) { reap(); closeStubs(); for (let i = 0; i < 20; i++) { if (child.exitCode !== null || child.signalCode !== null) { try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {} process.exit(code) } await sleep(100) } killGroup('SIGKILL'); process.exit(code) }
process.on('exit', () => { reap(); closeStubs() })
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })
child.on('exit', (c, s) => {
  exitedCode = c
  if (expectExit) return            // the quit-mode close is supposed to end the process
  if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) }
})

async function attach(port, pick, tries = 80) { for (let i = 0; i < tries; i++) { await sleep(500); try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick); if (t) return t } catch {} } return null }
async function client(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`${method} timed out`)) } }, 20000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value }
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }) })
  return { send, evaluate, ws }
}

const nodeT = await attach(INSPECT, (t) => t.type === 'node')
check(!!nodeT, 'main-process inspector target found (--inspect)', nodeT ? '' : mainLog.join('').slice(-600))
if (!nodeT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const M = await client(nodeT.webSocketDebuggerUrl); await M.send('Runtime.enable')
for (let __i = 0; ; __i++) { const __t = await M.evaluate(`(() => { try { if (process.mainModule) globalThis.__electron = process.mainModule.require('electron') } catch {} return typeof globalThis.__electron?.app })()`); if (__t === 'object') break; if (__i > 80) throw new Error('electron API never became reachable in main'); await new Promise((r) => setTimeout(r, 250)) }

const untilUp = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows().length > 0`).catch(() => false)) return true; await sleep(500) } return false }
check(await untilUp(), 'the app is up (a window exists) before we drive a close')

// Instrument the quit COMMITMENT, not the OS exit. Headless Electron under --inspect does not
// reliably terminate its OS process within a probe's patience (the debugger session and the read-only
// /run dconf path keep it lingering even after teardown — measured: a bare app.quit() control also
// failed to exit). But `before-quit` firing is the app COMMITTING to teardown (killing terminals,
// stopping the connection, closing the DB), and that is precisely the headless-strand distinction
// this probe exists to prove: tray mode must NOT fire it (the app survives with no window — that IS
// the tray-persistence design), quit mode MUST (it commits rather than stranding).
await M.evaluate(`globalThis.__beforeQuit = 0; globalThis.__electron.app.on('before-quit', () => globalThis.__beforeQuit++)`)

// Reach into the REAL handlers the renderer uses, exactly like badge-probe drives the real
// approvals:count handler. ipcMain.handle stores the fn in _invokeHandlers. Every handler checks its
// sender first (isShellSender: a window Beacon created, its top frame, the shell page) and answers a
// bare {} with null, so the stand-in event is the main window's own webContents and main frame.
await M.evaluate(`globalThis.__shellEvent = () => { const w = globalThis.__electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('#')); if (!w || w.webContents.isLoading() || !w.webContents.getURL().startsWith('file:')) throw new Error('the main window is not on the shell page yet, so its IPC would be refused'); return { sender: w.webContents, senderFrame: w.webContents.mainFrame } }; true`)
const HINT_KEY = 'window:tray-hint-shown'
const readHintRow = () => M.evaluate(`globalThis.__electron.ipcMain._invokeHandlers.get('settings:get')(globalThis.__shellEvent(), ${JSON.stringify(HINT_KEY)})`)
const setCloseMode = (mode) => M.evaluate(`globalThis.__electron.ipcMain._invokeHandlers.get('close-mode:set')(globalThis.__shellEvent(), ${JSON.stringify(mode)})`)
const winState = () => M.evaluate(`(() => { const w = globalThis.__electron.BrowserWindow.getAllWindows()[0]; return w ? { visible: w.isVisible(), destroyed: w.isDestroyed() } : null })()`)
const showWindow = () => M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows()[0].show()`)
const closeWindow = () => M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows()[0].close()`)
const beforeQuitCount = () => M.evaluate(`globalThis.__beforeQuit`).catch(() => -1) // -1 = inspector died (teardown ran)

section('default mode: ✕ hides to tray, the app survives, the hint is taught once')
{
  // Let the app's own startup show land first: main calls win.show() on ready-to-show, and on macOS a
  // close driven before that fired was undone by it (the window came back visible). Headless
  // ready-to-show does not auto-paint, so show() explicitly too — the close handler's hide is what we
  // are testing, not the startup show.
  for (let i = 0; i < 40; i++) { if (await M.evaluate(`!globalThis.__electron.BrowserWindow.getAllWindows()[0].webContents.isLoading()`).catch(() => false)) break; await sleep(250) }
  await sleep(1000)
  // Read only once the shell page is up: before that the sender check refuses the stand-in event, and
  // its null would pass this check without reading anything.
  const before = await readHintRow()
  check(before === null || before === undefined || before === '', `no hint row yet on a fresh profile (got ${JSON.stringify(before)})`)
  await showWindow(); await sleep(200)
  const s0 = await winState()
  check(s0 && s0.visible === true, `the window is visible before the close (got ${JSON.stringify(s0)})`)

  await closeWindow()
  await sleep(400)
  const s1 = await winState()
  check(s1 && s1.visible === false && s1.destroyed === false, `✕ HID the window without destroying it (got ${JSON.stringify(s1)}) — this is the tray-survives behavior`)
  check(await beforeQuitCount() === 0, 'tray mode did NOT fire before-quit — the app stays up with no window, which is the tray-persistence design (quitting here would be the regression)')
  const row1 = await readHintRow()
  const notifySupported = await M.evaluate(`globalThis.__electron.Notification.isSupported()`)
  if (notifySupported) check(row1 === '1', `the first hide persisted the hint row (got ${JSON.stringify(row1)}) — showHint fired and was recorded once`)
  else check(row1 === null || row1 === undefined || row1 === '', `no notification can be raised here (isSupported false), so the hint row stays UNSET for the next hide to retry (got ${JSON.stringify(row1)})`)
}

section('second close: still hides, hint is NOT re-taught')
{
  await showWindow(); await sleep(150)
  const rowBefore = await readHintRow()
  const supported2 = await M.evaluate(`globalThis.__electron.Notification.isSupported()`)
  await closeWindow()
  await sleep(350)
  const s = await winState()
  check(s && s.visible === false && s.destroyed === false, `the second ✕ also hides (got ${JSON.stringify(s)})`)
  const rowAfter = await readHintRow()
  if (supported2) check(rowBefore === '1' && rowAfter === '1', `the hint row is unchanged (${JSON.stringify(rowBefore)} → ${JSON.stringify(rowAfter)}) — hintShown was true, so showHint was false and the toast did not re-fire`)
  else check(!rowAfter, `still no notification support, so still no row (got ${JSON.stringify(rowAfter)}) — the retry stays open`)
}

section('quit mode: ✕ COMMITS to teardown — the headless-strand guard')
{
  const mode = await setCloseMode('quit')
  check(mode === 'quit', `close-mode:set returned 'quit' (got ${JSON.stringify(mode)}) — the real handler ran and main's closeToTray is now false`)
  await showWindow(); await sleep(150)
  // Record what main does during the teardown, in a file, since the inspector dies with the app.
  // before-quit closes the cache DB BEFORE the windows close, so a close handler that reads the DB on
  // a committed quit throws "The database connection is not open" — invisible to a check that only
  // asks whether before-quit fired.
  const REC = join(USER_DATA, 'teardown-record.txt')
  const armed = await M.evaluate(`(() => { const fs = process.getBuiltinModule('fs'); const rec = (l) => fs.appendFileSync(${JSON.stringify(REC)}, l + '\\n')
    process.on('uncaughtException', (e) => rec('UNCAUGHT ' + String((e && e.message) || e)))
    const w = globalThis.__electron.BrowserWindow.getAllWindows()[0]
    w.prependListener('close', () => rec('close:start')); w.on('close', () => rec('close:end'))
    return true })()`)
  check(armed === true, 'the teardown recorder is installed in main (uncaughtException + both ends of the close)')
  // From here the app tearing down (inspector dying) is expected, not an early-death failure.
  expectExit = true
  await closeWindow()
  let committed = false
  for (let i = 0; i < 40; i++) {
    const n = await beforeQuitCount()
    if (n === -1 || n >= 1 || child.exitCode !== null) { committed = true; break } // inspector died OR before-quit fired OR process exited
    await sleep(250)
  }
  await sleep(1500) // let the re-entrant close from app.quit() run
  let teardown = ''; try { teardown = readFileSync(REC, 'utf8') } catch {}
  check(/close:start/.test(teardown), `the recorder saw the close (got ${JSON.stringify(teardown)}) — a silent file would make the next check vacuous`)
  check(!/UNCAUGHT/.test(teardown), `main threw nothing during the quit teardown (got ${JSON.stringify(teardown)}) — a throw here is an error dialog on every quit`)
  check(committed, `the app COMMITTED to quitting after ✕ in quit mode (before-quit fired / inspector torn down / exitCode=${child.exitCode}) — proving it does NOT survive headless. window-all-closed is a no-op, so a bare "let the close through" would have left it running with no window; the handler's explicit isQuitting=true + app.quit() is what commits it.`)
}

section('result')
console.log(failures === 0 ? 'PASS — ✕ hides to tray and teaches once; the quit setting commits to teardown' : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (verify on the Mac):')
console.log('  * the hint is asserted as a persisted ROW, not a rendered toast. Headless Linux reports')
console.log('    Notification.isSupported() false. On the MAC, confirm the "Beacon is still running" coach')
console.log('    actually appears the first time you press ✕, and never again after.')
console.log('  * quit mode is asserted as before-quit FIRING (the commitment), not as OS-process exit —')
console.log('    under --inspect the headless process lingers even after a bare app.quit() (measured control).')
console.log('    On the MAC, confirm ✕ in Quit mode really closes the app, dock icon and all.')
console.log('  * the tray-icon affordance (reopen from tray) is the Mac/Linux GUI; not driven here.')
if (!expectExit) console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-300))
await reapAndExit(failures === 0 ? 0 : 1)
