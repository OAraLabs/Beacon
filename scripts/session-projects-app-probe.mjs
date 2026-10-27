#!/usr/bin/env node
// session-projects-app-probe: drive the BUILT app's sidebar over CDP and check session projects
// end to end, with real input (a real right-click, a real browser-initiated drag), on a COPY of
// the operator's cache so the suggestions come from real sessions.
//
// Safety, in order:
//   - Scratch profile (--user-data-dir): the operator's Beacon and its profile are never touched.
//   - No api-credential.bin and --use-mock-keychain: no Keychain modal, and every daemon call 401s,
//     so nothing here can write to the daemon (a pin toggle fails closed).
//   - A per-run CDP port, refused if anything already answers on it.
//
// macOS only (the profile path). Run after `npm run build`:
//   node scripts/session-projects-app-probe.mjs
// Env: BEACON_PROFILE_SRC (default ~/Library/Application Support/beacon-desktop)
//      PROBE_SHOT (optional PNG path for a final screenshot)

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyProfileDbs, profileDb, sqlEach } from './lib/profile-db.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.BEACON_PROFILE_SRC ?? join(homedir(), 'Library/Application Support/beacon-desktop')
const PORT = 9300 + Math.floor(Math.random() * 500)
const MIN_CHECKS = 35

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
const profile = mkdtempSync(join(tmpdir(), 'beacon-projects-probe-'))
// A consistent snapshot of a live WAL database: sqlite's own backup, read-only.
copyProfileDbs(SRC, profile) // beacon.db, or app.db and each Prometheus folder (lib/profile-db.mjs)
// Start from no projects, so the probe's assertions are about what IT did.
sqlEach(profile, "DELETE FROM settings WHERE key = 'sessions:projects:v1'")
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

// DOM helpers, evaluated in the page.
const HELPERS = `
  window.__drags = window.__drags ?? (document.addEventListener('dragstart', () => window.__drags.n++, true), { n: 0 });
  window.__p = {
    groups() {
      return [...document.querySelectorAll('.session-list .session-group')].map((g) => ({
        project: g.classList.contains('is-project'),
        label: g.querySelector('.session-group-label')?.textContent ?? null,
        n: Number(g.querySelector('.session-group-n')?.textContent ?? 'NaN'),
        rows: [...g.querySelectorAll('.session-row')].map((r) => r.getAttribute('title'))
      }))
    },
    rect(el) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } },
    headOf(label) { return [...document.querySelectorAll('.session-group')].find((g) => g.querySelector('.session-group-label')?.textContent === label)?.querySelector('.session-group-head') ?? null },
    rowIn(label, i = 0) { const g = [...document.querySelectorAll('.session-group')].find((g) => g.querySelector('.session-group-label')?.textContent === label); return g ? g.querySelectorAll('.session-row')[i] ?? null : null },
  }; true`

// For a right-click target: scroll it into view, let that scroll event land (the menu closes when
// the sidebar scrolls, by design), then measure. Without the wait, the menu opened and closed a frame
// later, at random: the earlier "flaky menu" failures.
async function settledPoint(expr) {
  await ev(`(() => { const el = ${expr}; el?.scrollIntoView({ block: 'center', behavior: 'instant' }); return true })()`)
  await sleep(300)
  return ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
}

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
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

  // A fresh profile (and a reload) opens on Mission. Go to Chats through the rail, and require that it took.
  const toChats = async () => {
  await until(() => ev(`document.readyState === 'complete' && !!document.querySelector('nav, .nav-rail, [role=navigation]')`), 30000)
  const wentToChats = await until(
    () =>
      ev(`(() => {
        if (document.querySelector('.session-list')) return true
        const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Chats' || b.getAttribute('title') === 'Chats' || b.getAttribute('aria-label') === 'Chats')
        if (b) b.click()
        return false
      })()`),
    20000,
    500
  )
  await until(() => ev(`document.querySelectorAll('.session-list .session-row').length > 0`), 30000)
  // Collapsed groups (Older, Desktop, Harness) render no rows. Open them all, so the DOM holds every
  // row the list is showing and the counts below can be checked against it.
  await ev(`[...document.querySelectorAll('.session-group-head[aria-expanded="false"]')].forEach((b) => b.click()); true`)
  return wentToChats
  }
  check((await toChats()) === true, 'navigated to Chats (the sessions sidebar is mounted)')
  const listed = await until(() => ev(`!document.querySelector('.session-group-head[aria-expanded="false"]') && document.querySelectorAll('.session-list .session-row').length`), 10000)
  check(listed > 20, 'the sidebar rendered the cached sessions', listed)
  if (!listed) {
    // Say what IS on screen, so a failure here is diagnosable rather than a bare null.
    console.log('[probe] screen text:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 600)))
    if (process.env.PROBE_SHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'))
    }
    throw new Error('no sidebar: see the screen text above')
  }
  await ev(HELPERS)

  // ── 1. hints reach the renderer, and the strip counts what it should ──
  const hints = await ev(`window.beacon.sessions.projectHints()`)
  const hintIds = Object.keys(hints ?? {})
  check(hintIds.length >= 5, `main returned hints from the real cache (${hintIds.length})`, hintIds.length)
  const strip = await until(() => ev(`document.querySelector('.project-review-toggle')?.textContent ?? ''`), 10000)
  const stripN = Number((strip ?? '').match(/\d+/)?.[0] ?? NaN)
  check(stripN > 0, `the review strip shows a count (${strip})`, strip)
  // Independent count: hints for rows the list shows that are not pinned. Rows' titles carry the id.
  const expected = await ev(`(() => {
    const hints = ${JSON.stringify(hints)}
    const pinnedTitles = new Set((window.__p.groups().find((g) => g.label === 'Pinned')?.rows ?? []))
    const shownIds = [...document.querySelectorAll('.session-list .session-row')].filter((r) => !pinnedTitles.has(r.getAttribute('title'))).map((r) => r.getAttribute('title').split(' — ').pop())
    return shownIds.filter((id) => id in hints).length
  })()`)
  check(stripN === expected, `strip count equals the shown, unpinned rows with a hint (${expected})`, { stripN, expected })

  // ── 2. File all for the biggest suggested group ──
  await ev(`document.querySelector('.project-review-toggle').click(); true`)
  const groupsInStrip = await until(() =>
    ev(`[...document.querySelectorAll('.project-review-group')].map((g) => ({ name: g.querySelector('.project-review-name').firstChild.textContent, n: g.querySelectorAll('.project-review-row').length }))`)
  )
  check(Array.isArray(groupsInStrip) && groupsInStrip.length > 0, `the open strip lists suggested projects (${groupsInStrip?.map((g) => `${g.name}:${g.n}`).join(', ')})`)
  const big = [...groupsInStrip].sort((a, b) => b.n - a.n)[0]
  await ev(`[...document.querySelectorAll('.project-review-group')].find((g) => g.querySelector('.project-review-name').firstChild.textContent === ${JSON.stringify(big.name)}).querySelector('.project-review-btn').click(); true`)
  const filed = await until(() => ev(`window.__p.groups().find((g) => g.project && g.label === ${JSON.stringify(big.name)}) ?? null`))
  await ev(`document.querySelector('.project-review-toggle')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.project-review-toggle').click(); true`)
  check(!!filed && filed.n === big.n && filed.rows.length === big.n, `File all made project “${big.name}” holding its ${big.n} sessions`, filed)
  const leaked = await ev(`(() => { const ids = new Set(${JSON.stringify(filed?.rows ?? [])}); return window.__p.groups().filter((g) => !g.project).flatMap((g) => g.rows).filter((t) => ids.has(t)).length })()`)
  check(leaked === 0, 'those sessions left the date groups (one row, one place)', leaked)
  const order = await ev(`window.__p.groups().map((g) => g.project ? 'P' : g.label)`)
  const firstDate = order.findIndex((l) => ['Today', 'Yesterday', 'Earlier this week', 'Older'].includes(l))
  check(order.indexOf('P') > -1 && order.indexOf('P') < firstDate && (order[0] === 'Pinned' ? order.indexOf('P') === 1 : order.indexOf('P') === 0), `projects sit after Pinned, before the date groups (${order.join(' | ')})`, order)

  // ── 3. a REAL right-click on a dated row → Move to <project> ──
  const datedEl = `(() => { for (const l of ['Today','Yesterday','Earlier this week','Older']) { const r = window.__p.rowIn(l); if (r) return r } return null })()`
  const datedPt = await settledPoint(datedEl)
  const dated = datedPt ? { ...datedPt, title: await ev(`${datedEl}.getAttribute('title')`) } : null
  check(!!dated, 'found a dated row to move', dated)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dated.x, y: dated.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dated.x, y: dated.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dated.x, y: dated.y, button: 'right', clickCount: 1 })
  const items = await until(() => ev(`document.querySelector('.ctx-menu') ? [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].map((b) => b.textContent) : null`), 5000)
  check(!!items && items.includes(`Move to ${big.name}`) && items.includes('New project…'), `right-click opened the menu (${items?.join(' / ')})`, items)
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === ${JSON.stringify(`Move to ${big.name}`)}); return b ? window.__p.rect(b) : null })()`)
  await mouse('mousePressed', item.x, item.y)
  await mouse('mouseReleased', item.x, item.y)
  const afterMenu = await until(() => ev(`(() => { const g = window.__p.groups().find((g) => g.project && g.label === ${JSON.stringify(big.name)}); return g && g.rows.includes(${JSON.stringify(dated.title)}) ? g.n : null })()`), 5000)
  check(afterMenu === big.n + 1, `the menu moved the row into ${big.name} (${afterMenu})`, afterMenu)
  check(await ev(`!document.querySelector('.ctx-menu')`), 'the menu closed after the pick')

  // ── 4. a REAL drag (browser-initiated) from a dated row onto the drop-for-new zone ──
  await send('Input.setInterceptDrags', { enabled: true })
  const src = await ev(`(() => { for (const l of ['Today','Yesterday','Earlier this week','Older']) { const r = window.__p.rowIn(l); if (r) return { title: r.getAttribute('title'), ...window.__p.rect(r) } } return null })()`)
  const srcUnder = await ev(`(() => { const e = document.elementFromPoint(${src.x}, ${src.y}); return e?.closest('.session-row')?.getAttribute('title') ?? (e ? e.tagName + '.' + e.className : 'nothing') })()`)
  check(srcUnder === src.title, `the first drag's press point is on its row (${srcUnder})`, srcUnder)
  const intercepted = waitEvent('Input.dragIntercepted', 5000)
  await mouse('mouseMoved', src.x, src.y)
  await mouse('mousePressed', src.x, src.y)
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', src.x + i * 3, src.y - i * 4, { buttons: 1 })
  const drag = await intercepted
  check(!!drag && drag.data?.items?.some((it) => it.mimeType === 'application/x-beacon-session'), 'a real mouse drag started on the row and carries the session payload', drag?.data?.items?.map((i) => i.mimeType))
  const zone = await until(() => ev(`(() => { const z = document.querySelector('.project-dropzone'); return z ? window.__p.rect(z) : null })()`), 3000)
  check(!!zone, 'the drop-for-new-project zone appeared during the drag')
  // The zone floats over the list rather than pushing it: the dragged row did not move.
  const srcNow = await ev(`(() => { const r = [...document.querySelectorAll('.session-row')].find((r) => r.getAttribute('title') === ${JSON.stringify(src.title)}); return r ? window.__p.rect(r) : null })()`)
  check(srcNow && Math.abs(srcNow.y - src.y) < 1, `the list did not shift under the pointer when the zone appeared (Δy ${srcNow ? (srcNow.y - src.y).toFixed(1) : '?'})`)
  if (drag && zone) {
    for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: zone.x, y: zone.y, data: drag.data })
    check(await ev(`!!document.querySelector('.project-dropzone.is-over')`), 'the zone highlights while hovered')
    await send('Input.dispatchDragEvent', { type: 'drop', x: zone.x, y: zone.y, data: drag.data })
  }
  await mouse('mouseReleased', zone?.x ?? src.x, zone?.y ?? src.y)
  await send('Input.setInterceptDrags', { enabled: false })
  const naming = await until(() => ev(`document.activeElement?.getAttribute('aria-label') === 'New project name'`), 3000)
  check(naming === true, 'dropping there opened a focused name field')
  await send('Input.insertText', { text: 'Probe project' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const made = await until(() => ev(`window.__p.groups().find((g) => g.project && g.label === 'Probe project') ?? null`), 3000)
  check(!!made && made.rows.length === 1 && made.rows[0] === src.title, 'Enter created “Probe project” holding the dragged session', made)

  // ── 6. rename + delete via the header's right-click ──
  const ph = await settledPoint(`window.__p.headOf('Probe project')`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ph.x, y: ph.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ph.x, y: ph.y, button: 'right', clickCount: 1 })
  const hm = await until(() => ev(`document.querySelector('.ctx-menu') ? [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].map((b) => b.textContent) : null`), 3000)
  check(JSON.stringify(hm) === JSON.stringify(['Rename…', 'Delete project']), `the project header’s menu (${hm?.join(' / ')})`, hm)
  // A scroll OUTSIDE the sidebar (what a streaming reply does to the thread, many times a second)
  // must not close the menu. Scroll the first scrollable element that is not in the sidebar.
  const outside = await ev(`(() => {
    const el = [...document.querySelectorAll('*')].find((e) => !e.closest('.sidebar') && e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY))
    if (!el) return null
    el.scrollTop = el.scrollTop > 40 ? el.scrollTop - 40 : el.scrollTop + 40
    return el.className || el.tagName
  })()`)
  await sleep(300)
  check(!!outside && (await ev(`!!document.querySelector('.ctx-menu')`)), `a scroll outside the sidebar (${outside}) leaves the menu open`, outside)
  await ev(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Rename…').click(); true`)
  await until(() => ev(`document.activeElement?.getAttribute('aria-label') === 'Rename project Probe project'`), 3000)
  // ⌘A is a menu accelerator, which CDP key events never reach: select the field's text directly.
  await ev(`document.activeElement.select(); true`)
  await send('Input.insertText', { text: 'Renamed probe' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const renamed = await until(() => ev(`window.__p.groups().some((g) => g.project && g.label === 'Renamed probe')`), 3000)
  check(renamed === true, 'rename took', await ev(`window.__p.groups().filter((g) => g.project).map((g) => g.label)`))

  // ── 7. persistence across a REAL reload (CDP Page.reload; location.reload is refused by design) ──
  await ev(`window.__probeMarker = 1; true`)
  await send('Page.reload', { ignoreCache: false })
  const reloaded = await until(() => ev(`document.readyState === 'complete' && window.__probeMarker === undefined`), 30000)
  check(reloaded === true, 'the page really reloaded (marker gone)')
  check((await toChats()) === true, 'back on Chats after the reload')
  await ev(HELPERS)
  const persisted = await until(() => ev(`(() => { const ps = window.__p.groups().filter((g) => g.project); return ps.length ? ps.map((g) => g.label + ':' + g.n) : null })()`), 10000)
  check(!!persisted && persisted.includes(`${big.name}:${big.n + 1}`) && persisted.includes('Renamed probe:1'), `projects survived the reload (${persisted?.join(', ')})`, persisted)

  // ── 7b. a real drag from one project to another ──
  await send('Input.setInterceptDrags', { enabled: true })
  // Measure the target FIRST: rect() scrolls its element into view, and measuring the source and
  // then the target scrolled the list under the source's coordinates (the press hit a group header).
  const head = await ev(`(() => { const h = window.__p.headOf(${JSON.stringify(big.name)}); return h ? window.__p.rect(h) : null })()`)
  const from = await ev(`(() => { const r = window.__p.rowIn('Renamed probe'); return r ? { title: r.getAttribute('title'), ...window.__p.rect(r) } : null })()`)
  const under = await ev(`(() => { const e = document.elementFromPoint(${from.x}, ${from.y}); const r = e?.closest('.session-row'); return r ? r.getAttribute('title') : (e ? e.tagName + '.' + e.className : 'nothing') })()`)
  check(under === from.title, `the press point is on the row being dragged (${under})`, under)
  const intercepted2 = waitEvent('Input.dragIntercepted', 5000)
  await mouse('mouseMoved', from.x, from.y)
  await mouse('mousePressed', from.x, from.y)
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', from.x + i * 3, from.y - i * 4, { buttons: 1 })
  const drag2 = await intercepted2
  if (!drag2) console.log('[probe] second drag: page saw', await ev(`window.__drags.n`), 'dragstart events in total; pressed at', JSON.stringify(from))
  // Re-read the header: the floating zone does not move it, but measure where it is now anyway.
  const head2 = await ev(`(() => { const h = window.__p.headOf(${JSON.stringify(big.name)}); return h ? window.__p.rect(h) : null })()`)
  const tgt = head2 ?? head
  if (drag2) {
    for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: tgt.x, y: tgt.y + 2, data: drag2.data })
    check(await ev(`!!document.querySelector('.session-group.is-project.is-drop')`), 'the target project highlights during the drag')
    await send('Input.dispatchDragEvent', { type: 'drop', x: tgt.x, y: tgt.y + 2, data: drag2.data })
  } else check(false, 'second drag started')
  await mouse('mouseReleased', tgt.x, tgt.y)
  await send('Input.setInterceptDrags', { enabled: false })
  const moved = await until(() => ev(`(() => { const g = window.__p.groups().find((g) => g.project && g.label === ${JSON.stringify(big.name)}); return g && g.rows.includes(${JSON.stringify(from.title)}) ? true : null })()`), 3000)
  check(moved === true, `dragging onto the ${big.name} header filed it there`)
  const emptyShown = await ev(`(() => { const g = [...document.querySelectorAll('.session-group.is-project')].find((g) => g.querySelector('.session-group-label')?.textContent === 'Renamed probe'); return g ? (g.querySelector('.project-empty')?.textContent ?? 'no hint') : 'gone' })()`)
  check(emptyShown.startsWith('Drag sessions here'), `the emptied project stays, with a drop hint (${emptyShown})`, emptyShown)

  // ── 7c. Unfiled as one list, a drag onto it, and back by date ──
  const DATES = JSON.stringify(['Today', 'Yesterday', 'Earlier this week', 'Older'])
  const datedN = await ev(`window.__p.groups().filter((g) => ${DATES}.includes(g.label)).reduce((n, g) => n + g.n, 0)`)
  await ev(`document.querySelector('.filter-btn').click(); true`)
  const choice = await until(() => ev(`(() => { const b = [...document.querySelectorAll('.filter-popover .gw-chip')].find((b) => b.textContent.trim() === 'One list'); if (!b) return null; b.click(); return true })()`), 3000)
  await ev(`document.querySelector('.filter-done')?.click(); true`)
  const oneList = await until(() => ev(`(() => { const g = window.__p.groups(); const u = g.find((x) => x.label === 'Unfiled'); return u && !g.some((x) => ${DATES}.includes(x.label)) ? u.n : null })()`), 3000)
  check(choice === true && oneList === datedN, `"One list" put every dated session under Unfiled (${oneList} of ${datedN}), no date groups left`, { oneList, datedN })
  const order7c = await ev(`window.__p.groups().map((g) => g.project ? 'P' : g.label)`)
  check(order7c.indexOf('Unfiled') > order7c.lastIndexOf('P'), `Unfiled sits after the projects (${order7c.join(' | ')})`, order7c)
  await ev(`[...document.querySelectorAll('.session-group-head[aria-expanded="false"]')].forEach((b) => b.click()); true`)
  await send('Input.setInterceptDrags', { enabled: true })
  const uHead = await ev(`window.__p.rect(window.__p.headOf('Unfiled'))`)
  const uFrom = await ev(`(() => { const r = window.__p.rowIn(${JSON.stringify(big.name)}); return r ? { title: r.getAttribute('title'), ...window.__p.rect(r) } : null })()`)
  const uUnder = await ev(`(() => { const e = document.elementFromPoint(${uFrom.x}, ${uFrom.y}); return e?.closest('.session-row')?.getAttribute('title') ?? 'other' })()`)
  check(uUnder === uFrom.title, 'the press point is on the project row being dragged out', uUnder)
  const uDragP = waitEvent('Input.dragIntercepted', 5000)
  await mouse('mouseMoved', uFrom.x, uFrom.y)
  await mouse('mousePressed', uFrom.x, uFrom.y)
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', uFrom.x + i * 3, uFrom.y - i * 4, { buttons: 1 })
  const uDrag = await uDragP
  const uHead2 = await ev(`window.__p.rect(window.__p.headOf('Unfiled'))`)
  if (uDrag) {
    for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: uHead2.x, y: uHead2.y + 2, data: uDrag.data })
    await send('Input.dispatchDragEvent', { type: 'drop', x: uHead2.x, y: uHead2.y + 2, data: uDrag.data })
  }
  await mouse('mouseReleased', uHead2.x, uHead2.y)
  await send('Input.setInterceptDrags', { enabled: false })
  const refiled = await until(() => ev(`(() => { const u = window.__p.groups().find((g) => g.label === 'Unfiled'); return u && u.rows.includes(${JSON.stringify(uFrom.title)}) ? u.n : null })()`), 3000)
  check(!!uDrag && refiled === datedN + 1, `dragging a project session onto Unfiled took it out of the project (${refiled})`, { started: !!uDrag, refiled })
  // rect() scrolls the header into view; that scroll event lands a frame later and would close a
  // menu opened in the meantime (the menu closes on scroll by design). Let it settle, re-measure.
  const uh = await settledPoint(`window.__p.headOf('Unfiled')`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: uh.x, y: uh.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: uh.x, y: uh.y, button: 'right', clickCount: 1 })
  const um = await until(() => ev(`document.querySelector('.ctx-menu') ? [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].map((b) => b.textContent) : null`), 3000)
  check(JSON.stringify(um) === JSON.stringify(['Group unfiled by date']), `right-click on Unfiled offers the switch back (${um?.join(' / ')})`, um)
  await ev(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Group unfiled by date')?.click(); true`)
  const back = await until(() => ev(`(() => { const g = window.__p.groups(); return !g.some((x) => x.label === 'Unfiled') ? g.filter((x) => ${DATES}.includes(x.label)).reduce((n, x) => n + x.n, 0) : null })()`), 3000)
  check(back === datedN + 1, `back by date, with the refiled session among them (${back})`, back)

  if (process.env.PROBE_SHOT) {
    await ev(`document.querySelector('.project-review-toggle')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.project-review-toggle').click(); true`)
    await sleep(300)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`[probe] screenshot → ${process.env.PROBE_SHOT}`)
  }

  // ── 8. delete keeps the sessions ──
  const before = await ev(`document.querySelectorAll('.session-list .session-row').length`)
  const bh = await settledPoint(`window.__p.headOf(${JSON.stringify(big.name)})`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bh.x, y: bh.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bh.x, y: bh.y, button: 'right', clickCount: 1 })
  await until(() => ev(`!!document.querySelector('.ctx-menu')`), 3000)
  await ev(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Delete project').click(); true`)
  const gone = await until(() => ev(`!window.__p.groups().some((g) => g.project && g.label === ${JSON.stringify(big.name)})`), 3000)
  const after = await ev(`document.querySelectorAll('.session-list .session-row').length`)
  check(gone === true && after === before, `delete removed the project and kept every session (${before} → ${after} rows)`, { before, after })

  // ...and a scroll OF the sidebar still closes it: the row it pointed at has moved.
  const dh = await settledPoint(`[...document.querySelectorAll('.session-group')].find((g) => ['Today','Yesterday','Earlier this week','Older'].includes(g.querySelector('.session-group-label')?.textContent))?.querySelector('.session-group-head')`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dh.x, y: dh.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dh.x, y: dh.y, button: 'right', clickCount: 1 })
  const opened = await until(() => ev(`!!document.querySelector('.ctx-menu')`), 3000)
  await ev(`(() => { const l = document.querySelector('.session-list'); l.scrollTop = l.scrollTop > 40 ? l.scrollTop - 40 : l.scrollTop + 40; return true })()`)
  const closed = await until(() => ev(`!document.querySelector('.ctx-menu')`), 2000)
  check(opened === true && closed === true, 'a scroll of the sidebar closes the menu', { opened, closed })

  check(consoleErrors.length === 0, `no renderer exceptions or console errors (${consoleErrors.length})`, consoleErrors.slice(0, 3))
  const refused = mainLog.join('').match(/\[ipc\] project hints failed[^\n]*/)
  check(!refused, 'main logged no project-hint failure', refused?.[0])
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
