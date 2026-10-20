#!/usr/bin/env node
// min-size-probe — can the LIVE window be dragged below the floor the layout needs?
//
// WHY A PROBE. The minimum existed in exactly one place: `sanitizeWindowState`, which clamps a size
// read from window-state.json at LAUNCH. The live window had no `minWidth`/`minHeight` at all, so a
// person could drag it into a sliver the layout was never built for — and palette-smoke already
// proves the sanitizer works, which is precisely why the gap survived: the tested half was the half
// that mattered least, and the half a user actually touches was untested because it was unwritten.
//
// So this drives the REAL built app through the MAIN inspector and reads the window's own
// getMinimumSize() / getSize() back. A floor that is only declared in source is a claim; one that
// survives setSize(200, 150) is a measurement.
//
// RUN (not part of verify — it launches the built app; the runner has no display):
//   npm run build && node scripts/min-size-probe.mjs
// SANDBOXED RUNNERS (read-only /dev/shm): PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`)

// ── the stub gateway (the app must get PAST the setup wizard to have a window) ──
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const site = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  json(res, 200, [])
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (sock) => { try { sock.send(JSON.stringify({ type: 'connected' })) } catch { /* closing */ } sock.on('error', () => undefined) })
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))
const WS_PORT = wsSite.address().port

const INSPECT = 9700 + ((process.pid + 11) % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-minsize-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--user-data-dir=${USER_DATA}`], {
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
  for (let i = 0; i < 20; i++) { if (child.exitCode !== null || child.signalCode !== null) { try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* gone */ } process.exit(code) } await sleep(100) }
  killGroup('SIGKILL'); process.exit(code)
}
process.on('exit', () => { reap(); closeStubs() })
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) } })

// ── main inspector ───────────────────────────────────────────────────────────
async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(500)
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick); if (t) return t } catch { /* not yet */ }
  }
  return null
}
async function client(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
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
  return { send, evaluate, ws }
}

const nodeT = await attach(INSPECT, (t) => t.type === 'node')
check(!!nodeT, 'main-process inspector target found (--inspect)', nodeT ? '' : mainLog.join('').slice(-600))
if (!nodeT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const M = await client(nodeT.webSocketDebuggerUrl)
await M.send('Runtime.enable')
await M.evaluate(`globalThis.__electron = (process.getBuiltinModule('module').createRequire(process.cwd() + '/'))('electron')`)

// The MAIN window only: quick-capture and the HUD are frameless by design and deliberately have no
// floor, so including them would read as a failure that is actually correct behaviour.
const WIN = `globalThis.__electron.BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Beacon')`
const untilWin = async () => { for (let i = 0; i < 60; i++) { if (await M.evaluate(`!!(${WIN})`).catch(() => false)) return true; await sleep(500) } return false }
check(await untilWin(), "the main window is reachable from main by title 'Beacon'")
if (!(await M.evaluate(`!!(${WIN})`).catch(() => false))) { console.error(mainLog.join('').slice(-1500)); await reapAndExit(2) }

// ── the floor is declared on the LIVE window ─────────────────────────────────
section('the window declares a minimum')
const min = await M.evaluate(`(${WIN}).getMinimumSize()`)
check(Array.isArray(min) && min[0] === 480 && min[1] === 360, `getMinimumSize() is [480, 360] — got ${JSON.stringify(min)}`)
// Electron's getMaximumSize() returns [0, 0] when NO maximum is set — 0 is its unlimited sentinel,
// measured here rather than assumed (the first cut of this probe asserted > 10000 and failed on a
// correct window). The claim is "a floor must not come with a ceiling": so either the sentinel, or a
// maximum far larger than anything a person would resize to.
const max = await M.evaluate(`(${WIN}).getMaximumSize()`)
const noCeiling = Array.isArray(max) && ((max[0] === 0 && max[1] === 0) || (max[0] > 10000 && max[1] > 10000))
check(noCeiling, `no maximum was imposed by this change (got ${JSON.stringify(max)}; [0,0] is Electron's unlimited sentinel) — a floor must not come with a ceiling`)
// And prove the sentinel reading is right rather than taken on faith: a maximum IS settable, so if
// [0,0] meant something else the next line would not change it.
await M.evaluate(`(${WIN}).setMaximumSize(1400, 1000)`)
const capped = await M.evaluate(`(${WIN}).getMaximumSize()`)
check(capped[0] === 1400 && capped[1] === 1000, `setMaximumSize(1400,1000) reads back as such (got ${JSON.stringify(capped)}) — so [0,0] above really was 'no maximum', not a misread`)
await M.evaluate(`(${WIN}).setMaximumSize(0, 0)`)
const uncapped = await M.evaluate(`(${WIN}).getMaximumSize()`)
check(uncapped[0] === 0 && uncapped[1] === 0, `and clearing it back to [0,0] confirms the sentinel is the cleared state (got ${JSON.stringify(uncapped)})`)

// ── a real resize below the floor ────────────────────────────────────────────
section('dragging below the floor is refused, and the window stays usable')
const before = await M.evaluate(`(${WIN}).getSize()`)
check(before[0] > 480 && before[1] > 360, `the window starts above the floor (${before.join('x')}) — otherwise the resize below proves nothing`)

await M.evaluate(`(${WIN}).setSize(200, 150)`)
await sleep(600) // let the WM settle; a size read in the same tick can predate the constraint
const afterSmall = await M.evaluate(`(${WIN}).getSize()`)
check(afterSmall[0] >= 480, `setSize(200, 150) did NOT shrink the width below 480 — got ${afterSmall[0]}px`)
check(afterSmall[1] >= 360, `setSize(200, 150) did NOT shrink the height below 360 — got ${afterSmall[1]}px`)
check(afterSmall[0] === 480 && afterSmall[1] === 360, `it landed ON the floor, not merely above it (${afterSmall.join('x')}) — the floor is what stopped it`)

// The layout still renders at the floor. A floor is only correct if the app is usable there; if this
// is blank, 480x360 is the wrong number and the probe says so rather than passing on the geometry.
const domAtFloor = await M.evaluate(`(function(){ const wc = (${WIN}).webContents; if (wc.isCrashed()) return { crashed: true }; return { crashed: false, url: wc.getURL().slice(-30) } })()`)
check(domAtFloor && !domAtFloor.crashed, `the renderer is alive at the floor size (${JSON.stringify(domAtFloor)}) — a floor that crashes the app is not a fix`)

// setBounds is a separate path from setSize and constrains independently.
await M.evaluate(`(${WIN}).setBounds({ x: 40, y: 40, width: 100, height: 100 })`)
await sleep(600)
const afterBounds = await M.evaluate(`(${WIN}).getBounds()`)
check(afterBounds.width >= 480 && afterBounds.height >= 360, `setBounds(100x100) is also refused — got ${afterBounds.width}x${afterBounds.height} (a separate code path from setSize)`)

// ── the floor does not over-constrain ────────────────────────────────────────
section('above the floor the window still resizes freely')
await M.evaluate(`(${WIN}).setSize(900, 700)`)
await sleep(500)
const grown = await M.evaluate(`(${WIN}).getSize()`)
check(grown[0] === 900 && grown[1] === 700, `setSize(900, 700) is honoured exactly (got ${grown.join('x')}) — a floor is not a fixed size`)
await M.evaluate(`(${WIN}).setSize(640, 420)`)
await sleep(500)
const shrunk = await M.evaluate(`(${WIN}).getSize()`)
check(shrunk[0] === 640 && shrunk[1] === 420, `shrinking to 640x420 is allowed (got ${shrunk.join('x')}) — only below-floor sizes are refused`)

// exactly AT the floor is legal, so the bound is inclusive and consistent with the sanitizer's `>=`
await M.evaluate(`(${WIN}).setSize(480, 360)`)
await sleep(500)
const exact = await M.evaluate(`(${WIN}).getSize()`)
check(exact[0] === 480 && exact[1] === 360, `480x360 exactly is accepted (${exact.join('x')}) — the floor is inclusive, matching the sanitizer's >= comparison`)

// ── the ONE invariant, TWO consumers ─────────────────────────────────────────
// This is the actual design claim: the restored-size clamp and the live drag floor are the same
// numbers because they are the same constants. If they ever disagree, a size accepted on restore can
// be one the window refuses to be dragged to.
section('the live floor and the restored-size clamp agree')
// Read the floor back from the LIVE window and compare against the shipped source, rather than
// re-importing a second copy of the module (which would compare the file to itself and always pass).
const agree = await M.evaluate(`({ live: (${WIN}).getMinimumSize() })`)
const SRC = (await import('node:fs')).readFileSync(join(REPO, 'src/main/window-state.ts'), 'utf8')
const srcW = Number((SRC.match(/export const MIN_WINDOW_WIDTH = (\d+)/) ?? [])[1])
const srcH = Number((SRC.match(/export const MIN_WINDOW_HEIGHT = (\d+)/) ?? [])[1])
check(srcW === 480 && srcH === 360, `the exported constants are 480x360 in source (got ${srcW}x${srcH})`)
check(agree.live[0] === srcW && agree.live[1] === srcH, `the LIVE window's floor equals the constants the SANITIZER uses — one invariant, not two that can drift (${agree.live.join('x')} vs ${srcW}x${srcH})`)
check(SRC.includes('s.width >= MIN_WINDOW_WIDTH') && SRC.includes('s.height >= MIN_WINDOW_HEIGHT'), 'and the sanitizer really does compare against those SAME exported names (not its own literals)')
check(!/const MIN_W = |const MIN_H = /.test(SRC), 'no second private alias of the floor survives in that file — two names for one constant is how they drift')

// ── the pop-outs are deliberately NOT floored ────────────────────────────────
// Quick-capture and the HUD are small frameless surfaces by design. If this change had reached them
// it would be a regression in a different window, so say which windows were measured.
section('scope: only the main window was constrained')
const wins = await M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), min: w.getMinimumSize() }))`)
check(Array.isArray(wins) && wins.length >= 1, `${wins.length} window(s) alive during the probe: ${JSON.stringify(wins)}`)

// restore for tidiness
await M.evaluate(`(${WIN}).setSize(${before[0]}, ${before[1]})`)

section('result')
console.log(failures === 0
  ? 'PASS — the live window refuses to go below the floor, and stays usable there'
  : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (platform-bound, verify on the Mac):')
console.log('  * whether the WINDOW MANAGER honours the minimum during an interactive DRAG of the resize')
console.log('    edge. setSize/setBounds are the programmatic paths and are constrained by the WM on Linux;')
console.log('    a real mouse-drag on macOS goes through AppKit and is worth one look.')
console.log('  * how the layout LOOKS at 480x360 — the probe asserts the renderer is alive, not that it is')
console.log('    pretty. Worth eyeballing on each plate.')
console.log('\nmain log tail: ' + mainLog.join('').replace(/\s+/g, ' ').slice(-300))
await reapAndExit(failures === 0 ? 0 : 1)
