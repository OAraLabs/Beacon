// Drive the REAL built Beacon over CDP: launch, wait for the window, read what the app actually
// shows. THE hand-verification harness (see PARITY-PLAN verification records) — import it from a
// probe script: `import { evaluate, sleep, send, mainLog } from './cdp-harness.mjs'`.
// BEACON_APP=packaged drives a packaged PROBE build instead of the repo build. Committed to the
// repo (2026-08-29) after the OS tmp cleaner purged the session-scratchpad copy mid-session —
// probes may copy it into a scratchpad, but this file is the source of truth.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// THE CHECKOUT THIS HARNESS DRIVES. Derived from this file's own location, not hard-coded:
// this script lives at <checkout>/scripts/, so a probe imported from a WORKTREE now drives that
// worktree's build. It used to be the literal '/Users/<you>/projects/beacon-desktop', which
// meant a worktree probe launched the MAIN checkout and confidently measured code the branch
// had never touched — the silent-wrong-target failure, with every assertion still reporting.
// In the main checkout the derived value IS that literal, so nothing about those runs changes.
// BEACON_CDP_REPO overrides it for the deliberate cross-checkout case.
const REPO = process.env.BEACON_CDP_REPO ?? fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PORT = 9222 + (process.pid % 700)
const launchedAt = Date.now()

// BEACON_APP=packaged drives a packaged bundle instead of the repo build — same harness, so a
// packaged-only failure shows up as the same assertions going red. It used to be the INSTALLED
// /Applications/Beacon.app; a release build refuses --remote-debugging-port (src/shared/release-gate.ts),
// so the default is now the probe build (`npm run pack:mac:probe`), and BEACON_BUNDLE names another.
const BUNDLE = process.env.BEACON_BUNDLE ?? join(REPO, 'dist-probe/mac-arm64/Beacon.app')
const PACKAGED = join(BUNDLE, 'Contents/MacOS/Beacon')
// BEACON_CDP_ARGS appends extra Electron switches (space-separated). Added 2026-09-19 for one
// concrete reason: `app.requestSingleInstanceLock()` is keyed on the userData path, so with the
// INSTALLED Beacon open — the normal state on this machine — the dev launch quits on launch and
// every probe reports "NO PAGE TARGET". Passing `--user-data-dir=<tmp>` gives the probe its own
// lock and its own profile. Opt-in and appended last: unset, nothing about the launch changes.
const EXTRA = (process.env.BEACON_CDP_ARGS ?? '').split(' ').filter(Boolean)
// THE ELECTRON BINARY ITSELF, LEADING ITS OWN PROCESS GROUP. This was `npx electron .`, and the
// reap signalled the npx process — which never reached the Electron it had started (npx → the
// electron cli → Electron). Beacon does not exit on a plain SIGTERM either (observed; most likely
// the window close it triggers is the hide-to-tray one), and the SIGKILL that should have backed
// it up was a setTimeout, which never fires on the 'exit' path every probe leaves by. Measured
// 2026-10-11: each probe run left one live Beacon behind. Now the repo's own `electron` package
// names the binary (what npx ran), `detached` makes it a process-group leader, and the reap ends
// the whole group, synchronously. Pinned by `npm run probe:harness-reap`.
const ELECTRON = createRequire(join(REPO, 'package.json'))('electron')
const SPAWN_OPTS = { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, detached: true }
const child = process.env.BEACON_APP === 'packaged'
  ? spawn(PACKAGED, [`--remote-debugging-port=${PORT}`, ...EXTRA], SPAWN_OPTS)
  : spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, ...EXTRA], { ...SPAWN_OPTS, cwd: REPO })
const mainLog = []

// ── ALWAYS take the app down with us ─────────────────────────────────────────────────────────
// SIGTERM to the group, a short grace, then SIGKILL to the group — all synchronous, because this
// also runs from process.on('exit'), where no timer or callback runs again. The group, not the
// pid: Chromium's helpers (zygote, gpu, renderers) are in it too. Nothing outside the group the
// harness itself started is signalled.
const REAP_GRACE_MS = 1000
const signalGroup = (sig) => {
  try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
}
let __reaped = false
const reap = () => {
  if (__reaped) return
  __reaped = true
  if (!child.pid) return // never started: nothing to end
  signalGroup('SIGTERM')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REAP_GRACE_MS)
  signalGroup('SIGKILL')
}
process.on('exit', reap)
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })
process.on('SIGINT', () => { reap(); process.exit(130) })
process.on('SIGTERM', () => { reap(); process.exit(143) })
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))

// ── FAIL CLOSED: refuse to drive a build older than the source ───────────────────────────────
function newestMtime(dir, exts) {
  let newest = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (!exts || exts.some((e) => entry.name.endsWith(e))) {
        const m = statSync(full).mtimeMs
        if (m > newest) newest = m
      }
    }
  }
  walk(dir)
  return newest
}

{
  const srcNewest = newestMtime(join(REPO, 'src'), ['.ts', '.tsx', '.css', '.html'])
  const target = process.env.BEACON_APP === 'packaged'
    ? join(BUNDLE, 'Contents/Resources/app.asar')
    : join(REPO, 'out/renderer/index.html')
  let builtAt = 0
  try {
    builtAt = statSync(target).mtimeMs
  } catch {
    console.log(`FATAL: nothing built at ${target} — run \`npm run build\` (or install-local) first.`)
    process.exit(4)
  }
  if (srcNewest > builtAt) {
    const age = Math.round((srcNewest - builtAt) / 1000)
    console.log(`FATAL: source is ${age}s NEWER than the build being driven.`)
    console.log(`       build:  ${new Date(builtAt).toISOString()}  (${target})`)
    console.log(`       source: ${new Date(srcNewest).toISOString()}`)
    console.log('       A failed or skipped build means this probe would describe code nobody changed.')
    process.exit(5)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A previous run's Electron holding this port would answer /json/list — refuse to start.
try {
  const pre = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(700) })
  if (pre.ok) {
    console.log(`FATAL: port ${PORT} already serving CDP before launch — a stale Electron is alive.`)
    child.kill(); process.exit(3)
  }
} catch { /* nothing listening — the good case */ }

async function targets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await res.json()
  } catch { return [] }
}

let page = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const list = await targets()
  page = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
  if (page) break
}
if (!page) {
  console.log('NO PAGE TARGET — main log tail:\n' + mainLog.join('').slice(-2000))
  child.kill(); process.exit(2)
}
console.log(`[cdp] attached: ${page.url.split('/').slice(-1)[0]}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails
    return { __error: d.exception?.description ?? d.text ?? 'exception' }
  }
  return r.result?.result?.value
}
globalThis.__evaluate = evaluate
globalThis.__child = child
globalThis.__launchedAt = launchedAt
globalThis.__mainLog = mainLog
export { evaluate, child, launchedAt, mainLog, sleep, send }
