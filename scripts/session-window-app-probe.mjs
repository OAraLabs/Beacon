#!/usr/bin/env node
// session-window-app-probe: drive the BUILT app over CDP and check session windows end to end
// (@shared/session-windows): pop a conversation out with a real click, read it in its own window, see
// the draft travel both ways (including a close inside the draft-save debounce), return it from the
// main window and from the pop-out's own button, and bring a pop-out back after a relaunch.
//
// Safety, as the other probes: a scratch COPY of the operator's profile (--user-data-dir), no
// api-credential.bin and --use-mock-keychain (no Keychain prompt, every daemon call 401s so nothing
// here can write to the daemon), a per-run CDP port refused if anything already answers on it.
//
// macOS only (the profile path). Run after `npm run build`:
//   node scripts/session-window-app-probe.mjs
// Env: BEACON_PROFILE_SRC (default ~/Library/Application Support/beacon-desktop)

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.BEACON_PROFILE_SRC ?? join(homedir(), 'Library/Application Support/beacon-desktop')
const PORT = 9300 + Math.floor(Math.random() * 500)
const MIN_CHECKS = 30

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
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
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
  return { send, ev, click, errors, close: () => ws.close(), url: target.url }
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
const profile = mkdtempSync(join(tmpdir(), 'beacon-popout-probe-'))
execFileSync('sqlite3', ['-readonly', join(SRC, 'beacon.db'), `.backup '${join(profile, 'beacon.db')}'`])
// Start with no drafts and no session windows, so what the probe sees is what it did.
execFileSync('sqlite3', [join(profile, 'beacon.db'), "DELETE FROM settings WHERE key LIKE 'draft:%' OR key = 'sessions:last'"])
// Two sessions with cached history (the probe has no daemon; history comes from the cache).
const picks = execFileSync('sqlite3', [join(profile, 'beacon.db'), "SELECT s.id FROM sessions s WHERE s.pinned = 0 AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role IN ('user','assistant')) >= 4 ORDER BY s.last_active DESC LIMIT 2"])
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean)
const [A, B] = picks
if (existsSync(join(SRC, 'window-state.json'))) writeFileSync(join(profile, 'window-state.json'), readFileSync(join(SRC, 'window-state.json')))

let app = launch(profile)
let main = null
let pop = null
try {
  check(picks.length === 2, `two sessions with cached history to work with (${picks.join(', ')})`, picks)
  main = await mainPage()
  check(!!main, 'the main window came up')
  if (!main) throw new Error('no main page')
  check((await toChats(main)) === true, 'on Chats')
  await main.ev(`[...document.querySelectorAll('.session-group-head[aria-expanded="false"]')].forEach((b) => b.click()); true`)

  // ── 1. open A in the main window, type a draft, pop it out with the header button ──
  await main.click(rowFor(A))
  const aMsgs = await until(() => main.ev(`(() => { const n = document.querySelectorAll('.app [data-row-id]').length; return n > 0 ? n : null })()`), 15000)
  check(!!aMsgs, `A's conversation rendered in the main window (${aMsgs} rows)`, aMsgs)
  await main.click(composer)
  await main.send('Input.insertText', { text: 'draft typed in main' })
  await sleep(700) // past the 400 ms debounce
  check((await main.ev(`${composer}.value`)) === 'draft typed in main', 'typed a draft into A in the main window')
  check(await main.click(`document.querySelector('.thread-popout')`), 'clicked "Open in its own window" in the header')

  const aTarget = await until(() => sessionTarget(A), 15000, 300)
  check(!!aTarget, 'a session window for A appeared (#session= route)', A)
  if (!aTarget) throw new Error('no pop-out')
  pop = await connect(aTarget)
  const popRows = await until(() => pop.ev(`(() => { const n = document.querySelectorAll('.app [data-row-id]').length; return n > 0 ? n : null })()`), 15000)
  check(!!popRows, `the pop-out renders A's conversation (${popRows} rows)`, popRows)
  const popDraft = await until(() => pop.ev(`${composer}?.value || null`), 5000)
  check(popDraft === 'draft typed in main', `the draft moved into the pop-out ("${popDraft}")`, popDraft)
  check((await pop.ev(`document.title`)).endsWith('— Beacon'), `the pop-out's title names the session (${await pop.ev(`document.title`)})`)
  check(!(await pop.ev(`!!document.querySelector('.sidebar, .rail-scroll')`)), 'the pop-out is just the conversation: no sidebar, no rail')
  if (process.env.PROBE_SHOT) {
    for (const [page, suffix] of [[pop, 'popout'], [main, 'main']]) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(process.env.PROBE_SHOT.replace(/\.png$/, `-${suffix}.png`), Buffer.from(shot.data, 'base64'))
    }
  }

  // ── 2. the main window gives A up ──
  const ph = await until(() => main.ev(`!!document.querySelector('.popped-placeholder')`), 5000)
  check(ph === true && !(await main.ev(`!!${composer}`)), 'the main window shows the placeholder, not a second copy of A')
  check(await main.ev(`!!${rowFor(A)}?.querySelector('.popped-mark')`), "A's sidebar row carries the 'own window' marker")
  check(JSON.stringify(await main.ev(`window.beacon.sessionWindows.list()`)) === JSON.stringify([A]), 'main reports exactly A as popped out')
  await main.click(rowFor(A))
  await sleep(600)
  check((await main.ev(`!!document.querySelector('.popped-placeholder') && !${composer}`)) === true, "clicking A's row does not open it in the main window too (one place at a time)")
  check((await targets()).filter((t) => t.url.includes('#session=')).length === 1, 'and does not open a second pop-out for it')

  // ── 3. type in the pop-out, then return it from the MAIN window inside the debounce ──
  await pop.click(composer)
  await pop.send('Input.insertText', { text: ' + more in the pop-out' })
  // No wait: the close must save what the debounce has not written yet.
  check(await main.click(`[...document.querySelectorAll('.popped-placeholder-btn')].find((b) => /Return it here/.test(b.textContent))`), 'clicked "Return it here" in the main window, inside the save debounce')
  const gone = await until(async () => !(await sessionTarget(A)), 8000, 200)
  check(gone === true, "A's window closed")
  const back = await until(() => main.ev(`${composer}?.value || null`), 8000)
  check(back === 'draft typed in main + more in the pop-out', `A is back in the main window with the WHOLE draft ("${back}")`, back)
  check((await main.ev(`1 + 1`)) === 2 && (await main.ev(`window.beacon.sessionWindows.list()`)).length === 0, 'main is responsive after the window closed (no hang) and nothing is popped out')
  pop.close()
  pop = null

  // ── 4. pop B out from the sidebar's right-click menu, return it with the pop-out's own button ──
  await main.click(rowFor(B), 'right')
  const item = await until(() => main.ev(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].map((b) => b.textContent).includes('Open in its own window')`), 3000)
  check(item === true, 'right-click on a session offers "Open in its own window"')
  await main.click(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Open in its own window')`)
  const bTarget = await until(() => sessionTarget(B), 15000, 300)
  check(!!bTarget, 'B opened in its own window from the menu')
  check((await main.ev(`!!document.querySelector('.popped-placeholder')`)) === false, 'popping out a session that was NOT open leaves the main window on A')
  // One place at a time, the case that can fail: clicking a popped-out session that is NOT the open
  // one must bring its window forward and leave the main window where it was. (Clicking the OPEN
  // one's row changes nothing either way, so that check alone could never fail.)
  await main.click(rowFor(B))
  await sleep(600)
  const stayed = await main.ev(`(() => { const a = ${rowFor(A)}; return !!a?.classList.contains('is-active') && !document.querySelector('.popped-placeholder') && !!document.querySelector('.app textarea') })()`)
  check(stayed === true, "clicking popped-out B's row leaves the main window on A (B is not opened here too)")
  check((await targets()).filter((t) => t.url.includes('#session=')).length === 1, 'and does not open a second window for B')
  pop = await connect(bTarget)
  await until(() => pop.ev(`!!document.querySelector('.thread-popout.is-popped')`), 10000)
  check(await pop.click(`document.querySelector('.thread-popout.is-popped')`), 'clicked "Return to main window" in the pop-out')
  const bGone = await until(async () => !(await sessionTarget(B)), 8000, 200)
  check(bGone === true, "B's window closed")
  // B's row is the ACTIVE one and its chat is mounted: a check that only looked for "a composer and no
  // placeholder" would pass with the main window still on A.
  const mainOnB = await until(() => main.ev(`(() => { const r = ${rowFor(B)}; return r?.classList.contains('is-active') && !!document.querySelector('.app textarea') && !document.querySelector('.popped-placeholder') ? true : null })()`), 8000)
  check(mainOnB === true && (await main.ev(`window.beacon.sessionWindows.list()`)).length === 0, 'the main window now shows B (its row is the active one): the session came back where you can see it')
  pop.close()
  pop = null

  // ── 5. relaunch: a pop-out open when Beacon went away comes back ──
  await main.click(rowFor(A), 'right')
  await until(() => main.ev(`!!document.querySelector('.ctx-menu')`), 3000)
  await main.click(`[...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find((b) => b.textContent === 'Open in its own window')`)
  check(!!(await until(() => sessionTarget(A), 15000, 300)), 'A popped out again before the relaunch')
  const errs = [...main.errors]
  main.close()
  main = null
  await stop(app)
  app = launch(profile)
  main = await mainPage()
  const restored = await until(() => sessionTarget(A), 30000, 500)
  check(!!restored, 'after a relaunch, A came back in its own window')
  check(JSON.stringify(await main.ev(`window.beacon.sessionWindows.list()`)) === JSON.stringify([A]), 'and main knows it is popped out')
  check(errs.length === 0, `no renderer exceptions or console errors in the main window (${errs.length})`, errs.slice(0, 3))
} catch (e) {
  check(false, `probe crashed: ${e instanceof Error ? e.message : e}`)
} finally {
  try {
    pop?.close()
    main?.close()
  } catch {}
  await stop(app)
  const hung = app.log.join('').match(/\[session-windows\] the window did not confirm its save in time[^\n]*/)
  if (hung) console.log('[probe] note: main logged a save timeout:', hung[0])
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Helpers can still be writing the profile just after quit; a leftover temp dir is not a failure.
  }
}
