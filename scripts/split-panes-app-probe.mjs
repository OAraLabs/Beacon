#!/usr/bin/env node
// split-panes-app-probe: drive the BUILT app over CDP and check split panes (@shared/split-panes) with
// real input: a real drag of a session onto a pane's edge, focus moving between panes WITHOUT
// remounting either conversation, a sidebar click replacing the focused pane, "Open beside", the
// no-room fallback to its own window, a pane's close button, per-pane drafts, a layout that survives
// a reload, and panes that keep their minimum width when the window narrows.
//
// Safety, as the other probes: a scratch COPY of the operator's profile (--user-data-dir), no
// api-credential.bin and --use-mock-keychain (no Keychain prompt, every daemon call 401s so nothing
// here can write to the daemon), a per-run CDP port refused if anything already answers on it.
//
// macOS only (the profile path). Run after `npm run build`:
//   node scripts/split-panes-app-probe.mjs
// Env: BEACON_PROFILE_SRC (default ~/Library/Application Support/beacon-desktop)

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyProfileDbs, profileDb, sqlEach } from './lib/profile-db.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.BEACON_PROFILE_SRC ?? join(homedir(), 'Library/Application Support/beacon-desktop')
const PORT = 9300 + Math.floor(Math.random() * 500)
const MIN_CHECKS = 33

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
async function answers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
  } catch {
    return false
  }
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()

/** One CDP connection to one page. */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let nextId = 1
  const pending = new Map()
  const errors = []
  const api = {}
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.method && api.onEvent) api.onEvent(msg)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception')
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout ${method}`))), 20000)
    })
  }
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const click = async (expr, button = 'left') => {
    await ev(`(${expr})?.scrollIntoView({ block: 'center', behavior: 'instant' }); true`)
    await sleep(200)
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!p) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: 1 })
    return true
  }
  await send('Runtime.enable')
  await send('Page.enable')
  return Object.assign(api, { send, ev, click, errors, close: () => ws.close(), url: target.url })
}

function launch(profile) {
  const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--use-mock-keychain'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  return { child, log }
}
async function stop(app) {
  app.child.kill('SIGTERM')
  await sleep(1500)
  if (app.child.exitCode === null) app.child.kill('SIGKILL')
  await until(async () => !(await answers(PORT)), 10000, 300)
}
async function mainPage() {
  const t = await until(async () => (await targets()).find((t) => t.type === 'page' && /index\.html/.test(t.url) && !t.url.includes('#')), 60000, 500)
  return t ? connect(t) : null
}
const sessionTarget = async (id) => (await targets()).find((t) => t.type === 'page' && t.url.includes(`#session=${encodeURIComponent(id)}`))
async function toChats(page) {
  return until(
    () =>
      page.ev(`(() => {
        if (document.querySelector('.session-list .session-row')) return true
        const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Chats' || b.getAttribute('title') === 'Chats')
        if (b) b.click()
        return false
      })()`),
    30000,
    500
  )
}
const rowFor = (id) => `[...document.querySelectorAll('.session-row')].find((r) => (r.getAttribute('title') ?? '').endsWith(${JSON.stringify(id)}))`
const composer = `document.querySelector('.app textarea')`

// ── profile ──
if (await answers(PORT)) {
  console.error(`[probe] port ${PORT} already answers; refusing to attach to a stranger`)
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'beacon-panes-probe-'))
copyProfileDbs(SRC, profile) // beacon.db, or app.db and each Prometheus folder (lib/profile-db.mjs)
// No saved layout, drafts, list width or projects: what the probe sees is what it did.
sqlEach(profile, "DELETE FROM settings WHERE key LIKE 'draft:%' OR key IN ('sessions:last', 'chat:panes:v1', 'sessions:width:v1', 'side-panel:open', 'sessions:projects:v1')")
const ids = execFileSync('sqlite3', [profileDb(profile), "SELECT s.id FROM sessions s WHERE s.pinned = 0 AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role IN ('user','assistant')) >= 4 ORDER BY s.last_active DESC LIMIT 6"])
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean)
const [A, B, C, D, E, F] = ids
if (existsSync(join(SRC, 'window-state.json'))) writeFileSync(join(profile, 'window-state.json'), readFileSync(join(SRC, 'window-state.json')))

const app = launch(profile)
let main = null
const paneSessions = () => main.ev(`[...document.querySelectorAll('.panes > .pane')].map((p) => p.getAttribute('data-session'))`)
const focusedSession = () => main.ev(`document.querySelector('.panes > .pane.is-focused')?.getAttribute('data-session') ?? null`)
const pane = (id) => `document.querySelector('.panes > .pane[data-session=${JSON.stringify(id)}]')`
const rowsIn = (id) => main.ev(`${pane(id)}?.querySelectorAll('[data-row-id]').length ?? 0`)

/** A real, browser-initiated drag of a sidebar row onto a zone of a pane (CDP drag interception). */
async function dragRowTo(id, paneId, zone) {
  await main.send('Input.setInterceptDrags', { enabled: true })
  await main.ev(`(${rowFor(id)})?.scrollIntoView({ block: 'center', behavior: 'instant' }); true`)
  await sleep(250)
  const from = await main.ev(`(() => { const r = (${rowFor(id)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const got = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000)
    main.onEvent = (m) => {
      if (m.method === 'Input.dragIntercepted') {
        clearTimeout(t)
        resolve(m.params)
      }
    }
  })
  await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y - i * 3, button: 'left', buttons: 1 })
  const drag = await got
  // The zones exist only while a session drag is on: measure the target now.
  const zones = await until(() => main.ev(`(() => { const z = ${pane(paneId)}?.querySelector('.pane-drop-zone.is-${zone}'); if (!z) return null; const r = z.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: z.textContent } })()`), 3000)
  if (drag && zones) {
    for (const type of ['dragEnter', 'dragOver']) await main.send('Input.dispatchDragEvent', { type, x: zones.x, y: zones.y, data: drag.data })
    await main.send('Input.dispatchDragEvent', { type: 'drop', x: zones.x, y: zones.y, data: drag.data })
  }
  await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zones?.x ?? from.x, y: zones?.y ?? from.y, button: 'left', clickCount: 1 })
  await main.send('Input.setInterceptDrags', { enabled: false })
  await sleep(400)
  return { started: !!drag, zone: zones }
}

try {
  check(ids.length === 6, `six sessions with cached history (${ids.length})`)
  main = await mainPage()
  if (!main) throw new Error('no main page')
  // A known width: 2000 window px. Beacon zooms its UI, so the page's own innerWidth is what counts.
  await main.send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1100, deviceScaleFactor: 0, mobile: false })
  check((await toChats(main)) === true, 'on Chats')
  await main.ev(`[...document.querySelectorAll('.session-group-head[aria-expanded="false"]')].forEach((b) => b.click()); true`)
  const inner = await main.ev('innerWidth')
  const room = inner - 60 - 264
  const fits = Math.max(1, Math.min(4, Math.floor((room + 1) / 381)))
  console.log(`[probe] innerWidth ${inner}: room for ${fits} panes beside the list`)

  // ── 1. one pane looks like before ──
  await main.click(rowFor(A))
  await until(() => rowsIn(A), 15000)
  check(JSON.stringify(await paneSessions()) === JSON.stringify([A]) && !(await main.ev(`!!document.querySelector('.pane.is-split')`)), 'one conversation = one pane, no split chrome')
  check((await main.ev(`!!document.querySelector('.thread-close-pane')`)) === false, 'a lone pane has no close button')

  // ── 2. a REAL drag of B onto A's right edge splits ──
  const d1 = await dragRowTo(B, A, 'right')
  check(d1.started && !!d1.zone, `a real drag of a session row showed the pane's drop zones ("${d1.zone?.label}")`, d1)
  check(JSON.stringify(await paneSessions()) === JSON.stringify([A, B]), 'dropping on the right zone split: [A, B]', await paneSessions())
  check((await focusedSession()) === B, 'the new pane has focus')
  check((await until(() => rowsIn(B), 15000)) > 0 && (await rowsIn(A)) > 0, `both panes show their conversation (A ${await rowsIn(A)} rows, B ${await rowsIn(B)} rows)`)
  check((await main.ev(`!!document.querySelector('.pane-drop')`)) === false, 'the drop zones are gone after the drop')

  // ── 3. focus moves between panes WITHOUT remounting either conversation ──
  await main.ev(`${pane(B)}.querySelector('.app').__probeMark = 'b'; ${pane(A)}.querySelector('.app').__probeMark = 'a'; true`)
  await main.click(`${pane(A)}.querySelector('[data-row-id]')`)
  check((await focusedSession()) === A, 'a click in pane A focuses it')
  check((await main.ev(`${pane(B)}.querySelector('.app').__probeMark === 'b' && ${pane(A)}.querySelector('.app').__probeMark === 'a'`)) === true, 'neither conversation was remounted by the focus change (same element, mark intact)')
  check((await main.ev(`!!${pane(A)}.querySelector('.thread-close-pane') && !!${pane(B)}.querySelector('.thread-close-pane')`)) === true, 'split panes each get a close button')

  // ── 4. per-pane drafts ──
  await main.click(`${pane(A)}.querySelector('textarea')`)
  await main.send('Input.insertText', { text: 'draft in A' })
  await main.click(`${pane(B)}.querySelector('textarea')`)
  await main.send('Input.insertText', { text: 'draft in B' })
  await sleep(500)
  check((await main.ev(`${pane(A)}.querySelector('textarea').value + '|' + ${pane(B)}.querySelector('textarea').value`)) === 'draft in A|draft in B', 'each pane keeps its own draft')

  // ── 4b. the divider between panes: a real drag, its limits, reset, keys, and it is saved ──
  const paneWidthsNow = () => main.ev(`[...document.querySelectorAll('.panes > .pane')].map((p) => Math.round(p.getBoundingClientRect().width))`)
  const divider = (i) => `document.querySelector('.panes > .pane-divider[data-boundary="${i}"]')`
  async function dragDivider(i, dx) {
    await main.ev(`(${divider(i)})?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); true`)
    await sleep(150)
    const p = await main.ev(`(() => { const r = (${divider(i)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 } })()`)
    await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    for (let k = 1; k <= 8; k++) await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + (dx * k) / 8, y: p.y, button: 'left', buttons: 1 })
    await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y, button: 'left', clickCount: 1 })
    await sleep(350)
  }
  check(await main.ev(`!!${divider(0)}`), 'a divider sits between the two panes')
  const w0 = await paneWidthsNow()
  await main.ev(`${pane(A)}.querySelector('.app').__probeMark2 = 'a'; ${pane(B)}.querySelector('.app').__probeMark2 = 'b'; true`)
  await dragDivider(0, 120)
  const w1 = await paneWidthsNow()
  check(Math.abs(w1[0] - (w0[0] + 120)) <= 2 && Math.abs(w1[1] - (w0[1] - 120)) <= 2, `a real drag of the divider 120px right moved exactly that boundary (${w0.join('/')} → ${w1.join('/')})`, { w0, w1 })
  check((await main.ev(`${pane(A)}.querySelector('.app').__probeMark2 === 'a' && ${pane(B)}.querySelector('.app').__probeMark2 === 'b'`)) === true, 'resizing did not remount either conversation')
  const saved = await main.ev(`window.beacon.settings.get('chat:panes:v1')`)
  check(/"weights":\[/.test(saved ?? ''), 'the new widths are saved with the layout', saved)
  await dragDivider(0, 5000)
  const w2 = await paneWidthsNow()
  check(w2[1] >= 379 && w2[1] <= 381, `a drag far past the neighbour stops at its 380px minimum (${w2.join('/')})`, w2)
  const div0 = await main.ev(`(() => { const r = (${divider(0)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 } })()`)
  for (const clickCount of [1, 2]) {
    await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: div0.x, y: div0.y, button: 'left', clickCount })
    await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: div0.x, y: div0.y, button: 'left', clickCount })
  }
  await sleep(350)
  const w3 = await paneWidthsNow()
  check(Math.abs(w3[0] - w3[1]) <= 2, `a double-click makes the panes equal again (${w3.join('/')})`, w3)
  await main.ev(`(${divider(0)}).focus(); true`)
  for (let k = 0; k < 2; k++) {
    await main.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  }
  await sleep(300)
  const w4 = await paneWidthsNow()
  check(Math.abs(w4[0] - (w3[0] + 32)) <= 2, `two → presses on the focused divider move it 2 × 16px (${w3[0]} → ${w4[0]})`, { w3, w4 })
  await dragDivider(0, -150) // leave a visibly uneven split for the reload check later

  // ── 5. sidebar clicks: replace the focused pane; a session already on screen gets focus ──
  await main.click(`${pane(A)}.querySelector('[data-row-id]')`)
  await main.click(rowFor(C))
  await until(async () => JSON.stringify(await paneSessions()) === JSON.stringify([C, B]), 5000)
  check(JSON.stringify(await paneSessions()) === JSON.stringify([C, B]) && (await focusedSession()) === C, 'clicking C in the list replaced the FOCUSED pane (A), left B alone')
  await main.click(rowFor(B))
  await sleep(300)
  check(JSON.stringify(await paneSessions()) === JSON.stringify([C, B]) && (await focusedSession()) === B, 'clicking B (already on screen) focuses its pane, opens nothing twice')

  // ── 6. right-click → Open beside, up to what fits; then "no room" and its own window ──
  if ((await paneSessions()).length < fits) {
    const n0 = (await paneSessions()).length
    await main.click(rowFor(D), 'right')
    await until(() => main.ev(`!!document.querySelector('.ctx-menu')`), 3000)
    check(await main.click(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Open beside')`), 'right-click → "Open beside"')
    await sleep(400)
    const p = await paneSessions()
    check(p.length === n0 + 1 && p.includes(D) && (await focusedSession()) === D, `"Open beside" added D next to the focused pane and focused it (${p.length} panes)`, p)
  }
  // Fill to the limit by dragging onto the last pane's right edge.
  for (let guard = 0; guard < 4 && (await paneSessions()).length < fits; guard++) {
    const cur = await paneSessions()
    const candidate = [D, E, F].find((x) => !cur.includes(x))
    await dragRowTo(candidate, cur[cur.length - 1], 'right')
    if ((await paneSessions()).length === cur.length) break
  }
  const full = await paneSessions()
  if (process.env.PROBE_SHOT) {
    const shot = await main.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.env.PROBE_SHOT.replace(/\.png$/, '-full.png'), Buffer.from(shot.data, 'base64'))
  }
  check(full.length === fits, `the row fills to exactly what fits (${full.length} of ${fits})`, full)
  const spare = [D, E, F].find((x) => !full.includes(x))
  await main.click(rowFor(spare), 'right')
  await until(() => main.ev(`!!document.querySelector('.ctx-menu')`), 3000)
  const noRoom = await main.ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent.startsWith('Open beside')); return b ? { text: b.textContent, disabled: b.disabled } : null })()`)
  check(!!noRoom && noRoom.disabled && /no room/.test(noRoom.text), `with the row full, "Open beside" is disabled and says why (${noRoom?.text})`, noRoom)
  await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const d2 = await dragRowTo(spare, full[0], 'left')
  check(/No room/.test(d2.zone?.label ?? ''), `the side drop zone says there is no room ("${d2.zone?.label}")`)
  const popped = await until(() => sessionTarget(spare), 10000, 300)
  check(!!popped && (await paneSessions()).length === fits, 'and dropping there opened it in its own window instead, the row unchanged')

  // ── 7. a pane's close button ──
  const beforeClose = await paneSessions()
  const victim = beforeClose[beforeClose.length - 1]
  await main.click(`${pane(victim)}.querySelector('.thread-close-pane')`)
  await sleep(300)
  const afterClose = await paneSessions()
  check(afterClose.length === beforeClose.length - 1 && !afterClose.includes(victim), `the close button removed that pane (${beforeClose.length} → ${afterClose.length})`, afterClose)
  check(await main.ev(`!!${rowFor(victim)}`), 'the conversation itself is still in the list')

  // ── 8. the layout survives a real reload ──
  const keep = await paneSessions()
  const keepFocus = await focusedSession()
  const keepWidths = await paneWidthsNow()
  await main.ev(`window.__probeMarker = 1; true`)
  await main.send('Page.reload', {})
  await until(() => main.ev(`document.readyState === 'complete' && window.__probeMarker === undefined`), 30000)
  await toChats(main)
  const restored = await until(async () => { const p = await paneSessions(); return p.length === keep.length ? p : null }, 15000)
  check(JSON.stringify(restored) === JSON.stringify(keep) && (await focusedSession()) === keepFocus, `the split came back after a reload (${keep.length} panes, same focus)`, { restored, keep })
  const backWidths = await until(async () => { const w = await paneWidthsNow(); return w.length === keepWidths.length ? w : null }, 5000)
  check(!!backWidths && backWidths.every((w, i) => Math.abs(w - keepWidths[i]) <= 3), `and so did the pane widths (${keepWidths.join('/')} → ${backWidths?.join('/')})`, { keepWidths, backWidths })
  const composers = await main.ev(`[...document.querySelectorAll('.panes > .pane')].filter((p) => p.querySelector('textarea')).length`)
  check(composers === keep.length, `every restored pane has its conversation and composer (${composers} of ${keep.length})`)

  // ── 9. a narrower window never crushes a pane below its minimum ──
  await main.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 0, mobile: false })
  await sleep(500)
  const widths = await main.ev(`[...document.querySelectorAll('.panes > .pane')].map((p) => Math.round(p.getBoundingClientRect().width))`)
  check(widths.length >= 2 && widths.every((w) => w >= 379), `narrowed window: every pane keeps >= 380px (${widths.join(', ')}); the row scrolls instead`, widths)
  await main.send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1100, deviceScaleFactor: 0, mobile: false })
  await sleep(400)
  if (process.env.PROBE_SHOT) {
    const shot = await main.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'))
  }
  check(main.errors.length === 0, `no renderer exceptions or console errors (${main.errors.length})`, main.errors.slice(0, 3))
} catch (e) {
  check(false, `probe crashed: ${e instanceof Error ? e.message : e}`)
} finally {
  try {
    main?.close()
  } catch {}
  await stop(app)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Helpers can still be writing the profile just after quit; a leftover temp dir is not a failure.
  }
}
