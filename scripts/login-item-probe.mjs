#!/usr/bin/env node
// login-item-probe — does the REAL handler honour the gate, and round-trip the OS readback?
//
// smoke:login-item proves the MODEL (which platforms can honour the switch, the win32 readback rule)
// and that main's SOURCE gates the OS call. A source regex can't prove the live consequence that
// matters most here: that invoking the SHIPPED login-item:set handler on an unsupported platform
// actually does NOT reach app.setLoginItemSettings. The gate existing in the text is not the same as
// the gate holding at runtime — and a login item registered by a dev build (registering the raw
// electron binary) or a no-op-platform write is exactly the silent-lie this feature must not have.
//
// So this patches app.setLoginItemSettings / app.getLoginItemSettings from the MAIN inspector to
// RECORD calls, then drives the real ipcMain invoke-handlers (the same ones the renderer's
// beacon.loginItem.get/set reach) and reads back what the OS API received. Same shape as badge-probe.
//
// WHAT IT CANNOT PROVE: that registration actually works on macOS/Windows. This probe launches
// `electron .`, so isPackaged is false on EVERY platform: on Linux and on a Mac/Windows dev build
// alike, the point is that main calls neither OS API at all. The packaged branches below run only
// if a packaged build is launched, which this probe does not do. The real registration is the
// Mac/Windows step named in the PR.
//
// RUN: npm run build && node scripts/login-item-probe.mjs
// SANDBOXED: PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

const INSPECT = 9700 + ((process.pid + 53) % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-login-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`], {
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
// Retry until electron's `app` is reachable, and never return the module by value. A one-shot
// createRequire(cwd)('electron') here threw "Internal error" intermittently on macOS: run too early
// it resolves the npm package's path string, and returning the module by value fails to serialize.
// Same loop as close-mode-probe.
for (let __i = 0; ; __i++) { const __t = await M.evaluate(`(() => { try { if (process.mainModule) globalThis.__electron = process.mainModule.require('electron') } catch {} return typeof globalThis.__electron?.app })()`); if (__t === 'object') break; if (__i > 80) throw new Error('electron API never became reachable in main'); await new Promise((r) => setTimeout(r, 250)) }

const untilUp = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows().length > 0`).catch(() => false)) return true; await sleep(500) } return false }
check(await untilUp(), 'the app is up before we drive the login-item handlers')
const untilShell = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`(() => { const w = globalThis.__electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('#')); return !!w && !w.webContents.isLoading() && w.webContents.getURL().startsWith('file:') })()`).catch(() => false)) return true; await sleep(250) } return false }
check(await untilShell(), 'the main window shows the shell page (every handler answers only the shell)')

// Patch the two OS APIs to RECORD calls, still calling through (badge-probe's pattern). On Linux both
// are no-ops, but what we're testing is whether main CALLS them — and it must NOT on this platform.
await M.evaluate(`
  globalThis.__setCalls = []
  globalThis.__getCalls = 0
  const app = globalThis.__electron.app
  globalThis.__origSet = app.setLoginItemSettings.bind(app)
  globalThis.__origGet = app.getLoginItemSettings.bind(app)
  app.setLoginItemSettings = (s) => { globalThis.__setCalls.push(JSON.parse(JSON.stringify(s ?? null))); return globalThis.__origSet(s) }
  app.getLoginItemSettings = (o) => { globalThis.__getCalls++; return globalThis.__origGet(o) }
  globalThis.__shellEvent = () => { const w = globalThis.__electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('#')); if (!w || w.webContents.isLoading() || !w.webContents.getURL().startsWith('file:')) throw new Error('the main window is not on the shell page yet, so its IPC would be refused'); return { sender: w.webContents, senderFrame: w.webContents.mainFrame } }
  globalThis.__invoke = (ch, arg) => globalThis.__electron.ipcMain._invokeHandlers.get(ch)(globalThis.__shellEvent(), arg)
  globalThis.__platform = process.platform
`)
check(await M.evaluate(`typeof globalThis.__origSet === 'function' && typeof globalThis.__invoke === 'function'`), 'the OS APIs are patched (recording) and the real invoke-handlers are reachable')
const platform = await M.evaluate(`globalThis.__platform`)
const packaged = await M.evaluate(`globalThis.__electron.app.isPackaged`)
console.log(`     (running on ${platform}, isPackaged=${packaged})`)

// Drive the SHIPPED handlers, not copies. Each checks its sender first and answers a bare {} with
// null, so the stand-in event is the main window's own webContents and main frame.
const invokeGet = () => M.evaluate(`globalThis.__invoke('login-item:get')`)
const invokeSet = (v) => M.evaluate(`globalThis.__invoke('login-item:set', ${JSON.stringify(v)})`)
const setCalls = () => M.evaluate(`globalThis.__setCalls`)
const getCalls = () => M.evaluate(`globalThis.__getCalls`)

section('the gate holds at runtime on an unsupported platform')
if (platform === 'darwin' || platform === 'win32') {
  console.log('  (skipped — this probe is on a supported platform; the gate\'s no-op behavior is the Linux/dev case)')
} else {
  const r = await invokeSet(true)
  const calls = await setCalls()
  check(calls.length === 0, `login-item:set(true) did NOT call app.setLoginItemSettings on ${platform} (got ${calls.length} call(s)) — on Linux it is a silent no-op, and writing one would be a dead control that claims to have done something`)
  check(r && r.supported === false, `the handler returned supported:false (got ${JSON.stringify(r)}) — the UI renders the switch disabled with a reason, not a control that lies`)
  check(typeof r.reason === 'string' && r.reason.length > 0, `and it carries a reason string (got ${JSON.stringify(r && r.reason)})`)
}

section('the gate holds in an unpackaged build regardless of platform')
{
  // This launched app is unpackaged (dev / electron .), so isPackaged is false — the gate must keep the
  // OS write off even on a supported platform, because it would register the raw electron binary.
  //
  // HONEST LIMIT: on an UNSUPPORTED platform (Linux) this section cannot isolate the packaging gate.
  // unavailableReason checks platform FIRST, so a Linux dev build reports 'not available on Linux yet'
  // and the two reasons collapse into one — the packaging gate is only separately observable on a
  // darwin/win32 UNPACKAGED build (i.e. a Mac dev build). Asserting the packaged-only reason here on
  // Linux would fail for a reason unrelated to the code, so this branch only checks that on Linux the
  // reason is the platform one, and reserves the packaged-only assertion for a supported platform.
  if (packaged) {
    console.log('  (skipped — this build is packaged; the dev-build gate is the unpackaged case)')
  } else if (platform === 'darwin' || platform === 'win32') {
    const r = await invokeSet(true)
    const calls = await setCalls()
    check(calls.length === 0, `an UNPACKAGED build did not call setLoginItemSettings (got ${calls.length}) — registering the raw electron binary as a startup item would be a lie that outlives this process`)
    check(r && r.supported === false && r.reason === 'packaged builds only', `the handler says why (got ${JSON.stringify(r && r.reason)})`)
  } else {
    const r = await invokeGet()
    check(r && r.supported === false, `on ${platform} the build is also unpackaged, but the PLATFORM gate fires first — supported:false either way (got reason ${JSON.stringify(r && r.reason)})`)
    check(r && r.reason === 'not available on Linux yet', `so the reason is the platform one, not the packaged one — confirming platform outranks packaging, as the model specifies`)
    console.log('  NOTE: the packaged-only reason is NOT separately observable on an unsupported platform.')
    console.log('        Verify it on a Mac dev build (`npm run dev` → Settings → Startup shows "packaged builds only").')
  }
}

section('GET queries the OS only where the platform AND the packaging can honour it')
{
  // main reads the OS only when the model says both gates pass: on Linux the API is a no-op, and in
  // an unpackaged build it would report the raw electron binary's registration. The expectation is
  // derived from platform and isPackaged here, not from the handler's own `supported`, so a model
  // that wrongly called a dev build supported would fail this section rather than steer it.
  const supportedPlatform = platform === 'darwin' || platform === 'win32'
  const osReadable = supportedPlatform && packaged === true
  await M.evaluate(`globalThis.__getCalls = 0`)
  const r = await invokeGet()
  const calls = await getCalls()
  check(r && typeof r === 'object' && 'supported' in r && 'enabled' in r, `GET returned a well-formed LoginItemState (got ${JSON.stringify(r)})`)
  check(r && r.supported === osReadable, `supported is ${osReadable} on ${platform} with isPackaged=${packaged} (got ${JSON.stringify(r && r.supported)})`)
  if (osReadable) {
    check(calls >= 1, `GET queried app.getLoginItemSettings live (got ${calls} call(s)) — the OS is the source of truth, not a cached row`)
  } else {
    const where = supportedPlatform ? `an unpackaged ${platform} build, where it would read the raw electron binary's registration` : `${platform}, where the API is a no-op`
    check(calls === 0, `GET did NOT query the OS (got ${calls} call(s)) on ${where} — it short-circuits to unsupported rather than trusting that report`)
    check(r && r.enabled === false, `and reports enabled:false (got ${r && r.enabled}) where the switch cannot be honoured`)
  }
}

section('SET returns the OS readback shape, not an echo of the request')
{
  const r = await invokeSet(false)
  check(r && 'supported' in r && 'enabled' in r && 'reason' in r && 'needsApproval' in r && 'deactivated' in r, `the SET result has the full LoginItemState shape (got keys ${r ? Object.keys(r).join(',') : 'null'}) — it is a re-read, not { enabled: <what we asked> }`)
}

section('result')
console.log(failures === 0 ? 'PASS — the real handlers honour the gate and round-trip the OS readback' : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (verify on the Mac / Windows):')
console.log('  * that registration actually WORKS — setLoginItemSettings is @platform darwin,win32, and this')
console.log('    probe runs an unpackaged build, where the whole point is that it is NOT called. In an INSTALLED')
console.log('    Beacon on the Mac, toggle "Launch at login" in Settings, then confirm Beacon appears in System')
console.log('    Settings → General → Login Items, and that it really starts on the next sign-in. On Windows,')
console.log('    confirm the Task Manager → Startup entry.')
console.log('  * the macOS requires-approval and Windows deactivated-run-key states — model-tested in')
console.log('    smoke:login-item, but only reachable on those platforms.')
if (mainLog.length) console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-240))
await reapAndExit(failures === 0 ? 0 : 1)
