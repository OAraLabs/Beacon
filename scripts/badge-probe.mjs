#!/usr/bin/env node
// badge-probe — when the approval count changes, does the OS badge actually get set?
//
// smoke:badge proves the MODEL: badgeCount/displayedBadgeCount return the right number, clamped like
// the ipc handler. It cannot prove the CONSEQUENCE — that main calls app.setBadgeCount with that
// number when the real APPROVALS_COUNT ipc arrives, and clears it on zero. A correct model wired to
// nothing is the defect; only a launched app shows the wiring.
//
// So this drives the REAL built app: it patches app.setBadgeCount from the MAIN inspector to record
// every call, then emits the real ipc channel (ipcMain.emit('approvals:count', event, n) — the same
// handler a renderer's notifyCount reaches, given the main window's own sender) and reads back the counts
// setBadgeCount received. The badge is @platform linux,darwin and needs Unity/permission to PAINT, so
// the probe asserts the CALL, not the pixels — what Linux can prove.
//
// RUN: npm run build && node scripts/badge-probe.mjs
// SANDBOXED (read-only /dev/shm): PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
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

const INSPECT = 9700 + ((process.pid + 17) % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-badge-'))
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
await M.evaluate(`globalThis.__electron = (process.getBuiltinModule('module').createRequire(process.cwd() + '/'))('electron')`)

// Wait for the app to be up (the tray/window exist), then patch setBadgeCount to RECORD calls.
const untilUp = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`!!globalThis.__electron.app && globalThis.__electron.BrowserWindow.getAllWindows().length > 0`).catch(() => false)) return true; await sleep(500) } return false }
check(await untilUp(), 'the app is up (a window exists) before we drive the badge')
const untilShell = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`(() => { const w = globalThis.__electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('#')); return !!w && !w.webContents.isLoading() && w.webContents.getURL().startsWith('file:') })()`).catch(() => false)) return true; await sleep(250) } return false }
check(await untilShell(), 'the main window shows the shell page (the approvals:count handler answers only the shell)')
await M.evaluate(`
  globalThis.__badges = []
  const app = globalThis.__electron.app
  globalThis.__origSetBadge = app.setBadgeCount
  app.setBadgeCount = (n) => { globalThis.__badges.push(n); return globalThis.__origSetBadge.call(app, n) }
  globalThis.__ipc = globalThis.__electron.ipcMain
  globalThis.__shellEvent = () => { const w = globalThis.__electron.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('#')); if (!w || w.webContents.isLoading() || !w.webContents.getURL().startsWith('file:')) throw new Error('the main window is not on the shell page yet, so its IPC would be refused'); return { sender: w.webContents, senderFrame: w.webContents.mainFrame } }
`)
check(await M.evaluate(`typeof globalThis.__origSetBadge === 'function' && globalThis.__badges.length >= 0`), 'app.setBadgeCount patched (recording, still calling through)')

// Emit the REAL ipc channel the renderer's notifyCount uses — the shipped handler, not a copy of it.
// It checks its sender first and drops a bare {}, so the stand-in event is the main window's own
// webContents and main frame.
async function setApprovals(n) {
  await M.evaluate(`globalThis.__ipc.emit('approvals:count', globalThis.__shellEvent(), ${n})`)
  await sleep(200)
  return await M.evaluate(`globalThis.__badges`)
}
const lastBadge = async () => { const b = await M.evaluate(`globalThis.__badges`); return b.length ? b[b.length - 1] : null }

section('an approval count drives the OS badge')
{
  await M.evaluate(`globalThis.__badges = []`)
  await setApprovals(3)
  check(await lastBadge() === 3, `3 approvals → setBadgeCount(3) (got ${await lastBadge()})`)
  check(await M.evaluate(`globalThis.__electron.app.getBadgeCount()`) === 3 || process.platform !== 'linux', 'app.getBadgeCount() reads 3 back where the platform supports it (Linux without Unity returns the count but does not paint)')
}

section('zero approvals CLEARS the badge')
{
  await setApprovals(0)
  check(await lastBadge() === 0, `0 approvals → setBadgeCount(0), which Electron renders as NO badge (got ${await lastBadge()})`)
}

section('the count is clamped before it reaches the OS surface')
{
  await setApprovals(-5)
  check(await lastBadge() === 0, `a negative count → 0 (got ${await lastBadge()}) — the OS badge is outside the app's own validation, so a -1 on the dock is not acceptable`)
  await M.evaluate(`globalThis.__ipc.emit('approvals:count', globalThis.__shellEvent(), 2.9)`)
  await sleep(150)
  check(await lastBadge() === 2, `a fractional count → floored to 2 (got ${await lastBadge()}), matching the tray line`)
}

section('a large count is capped for display, not shown raw')
{
  await setApprovals(150)
  const shown = await lastBadge()
  check(shown === 99, `150 approvals → the badge DISPLAYS 99 (got ${shown}) — a three-digit numeral overflows the dock icon; the tray line still shows the true count`)
}

section('no badge is set when the count does not change')
{
  await setApprovals(7)
  const before = (await M.evaluate(`globalThis.__badges`)).length
  await setApprovals(7) // same value
  const after = (await M.evaluate(`globalThis.__badges`)).length
  // updateTray() guards on `next !== pendingApprovals`, so a repeat should NOT re-set the badge.
  check(after === before, `re-sending the SAME count does not re-call setBadgeCount (was ${before}, now ${after}) — the change guard means the dock is not thrashed on every poll`)
}

section('result')
console.log(failures === 0 ? 'PASS — the approval count reaches app.setBadgeCount, clamped and capped, and clears on zero' : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (platform-bound, verify on the Mac):')
console.log('  * the badge is asserted as a CALL to app.setBadgeCount, not as pixels. On Linux it only PAINTS')
console.log('    under a Unity-style shell whose .desktop name matches; on macOS it needs notification permission.')
console.log('    On the MAC, confirm the dock icon actually shows the number, and that 99 renders sanely.')
console.log('  * Windows is guarded out in code (setBadgeCount is @platform linux,darwin) — a Windows taskbar')
console.log('    overlay badge would be a separate feature, not exercised here at all')
console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-300))
await reapAndExit(failures === 0 ? 0 : 1)
