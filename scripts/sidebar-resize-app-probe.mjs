#!/usr/bin/env node
// sidebar-resize-app-probe: drive the BUILT app over CDP and check the sessions list's resize handle
// with real mouse input: drag, the min/max bounds, double-click reset, arrow keys, longer titles when
// wider, persistence across a real reload, and the fit against a narrow window and an open dock.
//
// Safety, in order:
//   - Scratch profile (--user-data-dir): the operator's Beacon and its profile are never touched.
//   - No api-credential.bin and --use-mock-keychain: no Keychain modal, and every daemon call 401s,
//     so nothing here can write to the daemon (a pin toggle fails closed).
//   - A per-run CDP port, refused if anything already answers on it.
//
// macOS only (the profile path). Run after `npm run build`:
//   node scripts/sidebar-resize-app-probe.mjs
// Env: BEACON_PROFILE_SRC (default ~/Library/Application Support/beacon-desktop)
//      PROBE_SHOT (optional PNG path for a final screenshot)

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.BEACON_PROFILE_SRC ?? join(homedir(), 'Library/Application Support/beacon-desktop')
const PORT = 9300 + Math.floor(Math.random() * 500)
const MIN_CHECKS = 14

let checks = 0
let failures = 0
function check(cond, label, detail) {
  checks += 1
  console.log(`[probe] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`)
  if (!cond) failures += 1
}
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`[probe] FAIL only ${checks} checks ran (expected >= ${MIN_CHECKS})`)
    process.exitCode = 1
  } else if (failures) {
    console.error(`[probe] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`[probe] PASS ${checks} checks`)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`)
    return r.ok
  } catch {
    return false
  }
}

// ── profile ──
if (await answers(PORT)) {
  console.error(`[probe] port ${PORT} already answers; refusing to attach to a stranger`)
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'beacon-resize-probe-'))
// A consistent snapshot of a live WAL database: sqlite's own backup, read-only.
execFileSync('sqlite3', ['-readonly', join(SRC, 'beacon.db'), `.backup '${join(profile, 'beacon.db')}'`])
// Start from no projects, so the probe's assertions are about what IT did.
execFileSync('sqlite3', [join(profile, 'beacon.db'), "DELETE FROM settings WHERE key IN ('sessions:width:v1', 'side-panel:open')"])
for (const f of ['window-state.json']) if (existsSync(join(SRC, f))) writeFileSync(join(profile, f), execFileSync('cat', [join(SRC, f)]))

const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--use-mock-keychain'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))

let ws
let nextId = 1
const pending = new Map()
const listeners = []
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout ${method}`))), 20000)
  })
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
function waitEvent(method, ms = 5000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    listeners.push((m) => {
      if (m.method === method) {
        clearTimeout(t)
        resolve(m.params)
        return true
      }
      return false
    })
  })
}
async function until(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* retry */
    }
    if (Date.now() > end) return null
    await sleep(step)
  }
}


async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
}
const W = () => ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`)
const handle = () => ev(`(() => { const r = document.querySelector('.sidebar-divider').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
async function dragBy(dx) {
  const h = await handle()
  await mouse('mouseMoved', h.x, h.y)
  await mouse('mousePressed', h.x, h.y)
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', h.x + (dx * i) / 8, h.y, { buttons: 1 })
  await mouse('mouseReleased', h.x + dx, h.y)
  await sleep(250)
}
async function toChats() {
  return until(
    () =>
      ev(`(() => {
        if (document.querySelector('.session-list .session-row')) return true
        const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Chats' || b.getAttribute('title') === 'Chats')
        if (b) b.click()
        return false
      })()`),
    30000,
    500
  )
}

try {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !t.url.includes('#'))
  }, 60000, 500)
  check(!!target, 'the shell page came up on the probe port')
  if (!target) throw new Error('no page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      return
    }
    for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i](msg)) listeners.splice(i, 1)
  }
  await send('Runtime.enable')
  await send('Page.enable')
  const consoleErrors = []
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '))
    return false
  })
  // A known window width, so the bounds below are about this probe, not about the screen it ran on.
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 0, mobile: false })
  check((await toChats()) === true, 'on Chats with the sessions list showing')
  await sleep(500)

  // 1. default, and a real drag right
  const w0 = await W()
  check(w0 === 264, `starts at the default width (${w0})`, w0)
  // Titles are no longer cut in code, so nothing but layout keeps them out from under the row's
  // overlay buttons. Pinned rows show their 📌 at rest: no title may run under a visible button.
  // Measured at the default width AND wider, with the pointer parked off the list (no hover state).
  const overlapsFn = () =>
    ev(`(() => {
      const bad = []
      for (const wrap of document.querySelectorAll('.session-row-wrap')) {
        const t = wrap.querySelector('.session-title')
        if (!t) continue
        // The TEXT's right edge, not the element's: the title box is flex:1 and spans the row even
        // when the words are short. A Range gives the laid-out text; capped by the box (ellipsis).
        // (scrollWidth is no good: it is never smaller than the box, so short titles read as full.)
        const tr = t.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(t)
        const textRight = Math.min(range.getBoundingClientRect().right, tr.right)
        for (const b of wrap.querySelectorAll('button.session-rename, button.session-forget')) {
          if (Number(getComputedStyle(b).opacity) === 0) continue
          const br = b.getBoundingClientRect()
          if (textRight > br.left + 0.5 && tr.left < br.right) bad.push(t.textContent.slice(0, 24) + ' [' + Math.round(textRight) + '>' + Math.round(br.left) + ']')
        }
      }
      return bad
    })()`)
  const titleLen = () => ev(`(() => { const t = [...document.querySelectorAll('.session-row .session-title')].map((e) => ({ full: e.textContent.length, fits: e.scrollWidth <= e.clientWidth })); return t })()`)
  const before = await titleLen()
  const longest = Math.max(...before.map((t) => t.full))
  check(longest > 24, `titles are no longer cut at 24 characters in the text (longest ${longest})`, longest)
  const clippedBefore = before.filter((t) => !t.fits).length
  // Pins arrive after the list paints (the daemon-owned flag is migrated in); wait for them, or the
  // overlap check below runs on rows that have nothing pinned yet and passes vacuously.
  const pinsUp = await until(() => ev(`document.querySelectorAll('.session-row-wrap .pin-mark, .session-row-wrap button.session-pin[aria-pressed="true"]').length`), 10000)
  check(pinsUp > 0, `pinned rows are on screen before the overlap check (${pinsUp})`, pinsUp)
  await mouse('mouseMoved', 900, 500)
  const ov0 = await overlapsFn()
  check(ov0.length === 0, `no title runs under a visible row button at the default width (${ov0.length}: ${ov0.slice(0, 3).join(' | ')})`, ov0)
  await dragBy(140)
  const w1 = await W()
  check(Math.abs(w1 - 404) <= 2, `a real drag 140px right widened the list to ~404 (${w1})`, w1)
  await mouse('mouseMoved', 900, 500)
  const ovWide = await overlapsFn()
  check(ovWide.length === 0, `no title runs under a visible row button at ${w1}px (${ovWide.length}: ${ovWide.slice(0, 3).join(' | ')})`, ovWide)
  const clippedAfter = (await titleLen()).filter((t) => !t.fits).length
  check(clippedAfter < clippedBefore, `wider list → fewer titles ellipsized (${clippedBefore} → ${clippedAfter})`, { clippedBefore, clippedAfter })
  const convW = await ev(`Math.round(document.querySelector('.layout > .sidebar').nextElementSibling.getBoundingClientRect().width)`)
  check(convW >= 380, `the conversation column still has its minimum (${convW})`, convW)

  // 2. bounds: way past the max, way under the min
  await dragBy(600)
  check((await W()) === 520, `dragging far right stops at the 520 cap (${await W()})`)
  // Within the window first (the pointer never leaves it), then past the window's left edge.
  await dragBy(-400)
  check((await W()) === 200, `dragging left past the minimum stops at 200 (${await W()})`)
  await mouse('mouseMoved', 900, 500)
  const ovMin = await overlapsFn()
  check(ovMin.length === 0, `no title runs under a visible row button at the 200 minimum (${ovMin.length}: ${ovMin.slice(0, 3).join(' | ')})`, ovMin)
  await dragBy(200)
  const pre = await W()
  const hh = await handle()
  await dragBy(-700)
  check(pre > 200 && hh.x - 700 < 0 && (await W()) === 200, `dragging past the window's left edge also stops at 200, not back at the default (${await W()})`)

  // 3. double-click resets, keyboard nudges
  const h = await handle()
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h.x, y: h.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x, y: h.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h.x, y: h.y, button: 'left', clickCount: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x, y: h.y, button: 'left', clickCount: 2 })
  await sleep(250)
  check((await W()) === 264, `double-click resets to the default (${await W()})`)
  await ev(`document.querySelector('.sidebar-divider').focus(); true`)
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  }
  await sleep(200)
  check((await W()) === 264 + 48, `three → presses on the focused handle add 3 × 16px (${await W()})`)

  // 4. persistence across a REAL reload (CDP Page.reload)
  await dragBy(100)
  const kept = await W()
  await ev(`window.__probeMarker = 1; true`)
  await send('Page.reload', {})
  await until(() => ev(`document.readyState === 'complete' && window.__probeMarker === undefined`), 30000)
  await toChats()
  const afterReload = await until(async () => { const w = await W(); return w === kept ? w : null }, 8000)
  check(afterReload === kept, `the width survived a real reload (${kept} → ${afterReload ?? (await W())})`, { kept })

  // 5. a narrow window fits the list down (conversation keeps 380), and widening gives it back
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 0, mobile: false })
  await sleep(500)
  // Beacon zooms its UI, so a 760px window is fewer CSS px wide: work from the page's own width.
  const inner = await ev(`innerWidth`)
  const narrow = await W()
  const narrowConv = await ev(`Math.round(document.querySelector('.layout > .sidebar').nextElementSibling.getBoundingClientRect().width)`)
  check(narrow === inner - 60 - 380 && narrowConv >= 379, `in a narrow window (${inner} CSS px) the list fits down to ${inner - 60 - 380} so the conversation keeps 380 (list ${narrow}, conversation ${narrowConv})`, { inner, narrow, narrowConv })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 0, mobile: false })
  await sleep(500)
  check((await W()) === kept, `widening the window gives the dragged width back (${await W()})`)

  // 6. with the dock open (inspector: ⌘1, it never collapses the list), the list's room shrinks
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 0, mobile: false })
  await sleep(300)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '1', code: 'Digit1', modifiers: 4, windowsVirtualKeyCode: 49 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', modifiers: 4, windowsVirtualKeyCode: 49 })
  const dockW = await until(() => ev(`(() => { const d = document.querySelector('[data-testid="side-panel"]'); return d ? Math.round(d.getBoundingClientRect().width) : null })()`), 4000)
  if (!dockW) {
    // ⌘1 may be a menu accelerator CDP keys never reach; open the dock through its header button.
    await ev(`[...document.querySelectorAll('button')].find((b) => /inspector/i.test(b.getAttribute('title') ?? '') || /inspector/i.test(b.getAttribute('aria-label') ?? ''))?.click(); true`)
  }
  const dock2 = await until(() => ev(`(() => { const d = document.querySelector('[data-testid="side-panel"]'); return d ? Math.round(d.getBoundingClientRect().width) : null })()`), 4000)
  check(!!dock2, `the dock opened (${dock2}px)`, dock2)
  await dragBy(500)
  const withDock = await W()
  const conv3 = await ev(`Math.round(document.querySelector('.layout > .sidebar').nextElementSibling.getBoundingClientRect().width)`)
  check(conv3 >= 379 && withDock < 520, `beside the open dock the list stops where the conversation keeps 380 (list ${withDock}, conversation ${conv3}, dock ${dock2})`, { withDock, conv3, dock2 })

  // The dock's divider had the same fault: drag it right by more than the dock's width.
  {
    const d = await ev(`(() => { const r = document.querySelector('.side-panel-divider').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    const inspMin = 260
    const dw0 = await ev(`Math.round(document.querySelector('[data-testid="side-panel"]').getBoundingClientRect().width)`)
    await mouse('mouseMoved', d.x, d.y)
    await mouse('mousePressed', d.x, d.y)
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', d.x + (dw0 + 150) * i / 8, d.y, { buttons: 1 })
    await mouse('mouseReleased', d.x + dw0 + 150, d.y)
    await sleep(300)
    const dw1 = await ev(`Math.round(document.querySelector('[data-testid="side-panel"]').getBoundingClientRect().width)`)
    check(dw1 === inspMin, `dragging the dock's divider right past its own width stops at its minimum ${inspMin}, not back at the default (${dw0} → ${dw1})`, { dw0, dw1 })
  }

  if (process.env.PROBE_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`[probe] screenshot → ${process.env.PROBE_SHOT}`)
  }
  check(consoleErrors.length === 0, `no renderer exceptions or console errors (${consoleErrors.length})`, consoleErrors.slice(0, 3))
} catch (e) {
  check(false, `probe crashed: ${e instanceof Error ? e.message : e}`)
} finally {
  try {
    ws?.close()
  } catch {}
  child.kill('SIGTERM')
  await sleep(1500)
  if (child.exitCode === null) child.kill('SIGKILL')
  await sleep(500)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Helpers can still be writing the profile just after quit; a leftover temp dir is not a failure.
  }
}
