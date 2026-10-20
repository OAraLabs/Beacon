#!/usr/bin/env node
/*
 * Live visual walk (Makeover verification) — drives the REAL running app over the Chrome DevTools
 * Protocol and captures rendered screenshots for the owner-eyes checklist in
 * docs/MAKEOVER-EXECUTION.md. No test framework, no app changes: launch the app with
 *   --remote-debugging-port=9223 --inspect=9229
 * then run stages:
 *   node scripts/visual-walk.cjs setup     # first-run: Test → Connect (token from env, never printed)
 *   node scripts/visual-walk.cjs views     # screenshot all 9 views + config tabs
 *   node scripts/visual-walk.cjs overlays  # palette, shortcut sheet, connection popover
 *   node scripts/visual-walk.cjs chat      # new chat, rename, live tool turn → timeline, jump chip
 *   node scripts/visual-walk.cjs window    # resize → window-state.json persistence
 *   node scripts/visual-walk.cjs capture   # hotkey registration + #capture window UI
 * PNGs land in /tmp/beacon-walk (override with WALK_OUT).
 */
const WebSocket = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const PORT = process.env.WALK_CDP_PORT || '9223'
const NODE_PORT = process.env.WALK_INSPECT_PORT || '9229'
const OUT = process.env.WALK_OUT || '/tmp/beacon-walk'
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets(port = PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`)
  return r.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    let id = 0
    const pending = new Map()
    ws.on('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id
            pending.set(i, { res, rej })
            ws.send(JSON.stringify({ id: i, method, params }))
          }),
        close: () => ws.close()
      })
    )
    ws.on('message', (d) => {
      let m
      try {
        m = JSON.parse(d.toString())
      } catch {
        return
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p.rej(new Error(m.error.message))
        else p.res(m.result)
      }
    })
    ws.on('error', reject)
  })
}

async function mainPage() {
  const targets = await listTargets()
  const page = targets.find((t) => t.type === 'page' && !t.url.includes('#capture'))
  if (!page) throw new Error('no main page target; targets: ' + targets.map((t) => `${t.type} ${t.url}`).join(' | '))
  return connect(page.webSocketDebuggerUrl)
}

async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result?.value
}

async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log(`  [shot] ${name}`)
}

async function waitFor(c, expression, ms = 15000, step = 300) {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await ev(c, expression)) return
    } catch {
      /* page may be mid-navigation */
    }
    if (Date.now() > end) throw new Error('timeout waiting for: ' + expression)
    await sleep(step)
  }
}

const Q = JSON.stringify
const click = (sel) => `(() => { const el = document.querySelector(${Q(sel)}); if (!el) return false; el.click(); return true })()`
const clickText = (sel, text) =>
  `(() => { const els = [...document.querySelectorAll(${Q(sel)})]; const el = els.find(e => e.textContent.trim().includes(${Q(text)})); if (!el) return false; el.click(); return true })()`
// React-controlled inputs need the native value setter + an input event.
const setValue = (sel, v) =>
  `(() => { const el = document.querySelector(${Q(sel)}); if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${Q(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
const key = (k, mods = {}) =>
  `(window.dispatchEvent(new KeyboardEvent('keydown', { key: ${Q(k)}, ctrlKey: ${!!mods.ctrl}, bubbles: true })), true)`

// ── stages ────────────────────────────────────────────────────────────────────

async function stageSetup() {
  const c = await mainPage()
  await waitFor(c, `!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 20000)
  await ev(c, `document.fonts.ready.then(() => true)`)
  const fonts = await ev(
    c,
    `JSON.stringify({ inter: document.fonts.check('12px "Inter Variable"'), mono: document.fonts.check('12px "JetBrains Mono Variable"'), body: getComputedStyle(document.body).fontFamily.slice(0, 40) })`
  )
  console.log('  fonts:', fonts)

  const inSetup = await ev(c, `!!document.querySelector('.setup-card')`)
  if (inSetup) {
    console.log('  first-run setup detected — walking Test → Connect')
    await ev(c, setValue('.setup-card input[placeholder*="Tailscale"], .setup-card input', '127.0.0.1'))
    const token = process.env.PROMETHEUS_API_TOKEN || ''
    if (token) await ev(c, setValue('.setup-card input[type="password"]', token)) // value travels over CDP only — never logged
    await shot(c, '01-first-run-filled')
    await ev(c, clickText('.setup-card button', 'Test'))
    await waitFor(c, `!!document.querySelector('.setup-test-ok') || !!document.querySelector('.setup-error')`, 15000)
    const label = await ev(c, `(document.querySelector('.setup-test-ok') || document.querySelector('.setup-error'))?.textContent`)
    console.log('  test result:', label)
    await shot(c, '02-first-run-tested')
    await ev(c, clickText('.setup-card button', 'Connect'))
  }
  await waitFor(c, `!!document.querySelector('nav[aria-label="Views"]')`, 25000)
  await waitFor(c, `!!document.querySelector('.status-connected')`, 20000).catch(() => console.log('  (WS not connected yet — continuing)'))
  await sleep(1200)
  await shot(c, '03-chat-connected')
  const indicator = await ev(c, `document.querySelector('[aria-label="Connection status"]')?.textContent?.trim()`)
  console.log('  rail indicator:', indicator)
  c.close()
}

/** 401 → recovery loop: indicator popover → Open Settings → token → Save & test → lock clears. */
async function stageRecover() {
  const c = await mainPage()
  await ev(c, click('[aria-label="Connection status"]'))
  await waitFor(c, `!!document.querySelector('[aria-label="Connection details"]')`, 5000)
  await sleep(250)
  await shot(c, '04-popover-401')
  await ev(c, clickText('[aria-label="Connection details"] button', 'Open Settings'))
  await waitFor(c, `[...document.querySelectorAll('h2')].some(h => h.textContent.includes('Connection Settings'))`, 6000)
  await sleep(400)
  await shot(c, '05-settings-open')
  const token = process.env.PROMETHEUS_API_TOKEN || ''
  if (!token) throw new Error('PROMETHEUS_API_TOKEN not in env')
  await ev(c, setValue('input[type="password"]', token)) // value travels over CDP only — never logged
  await ev(c, clickText('button', 'Save & test'))
  await waitFor(c, `document.body.textContent.includes('Connected ✓')`, 15000)
  await shot(c, '06-settings-saved')
  await ev(c, clickText('button', 'Close'))
  await sleep(2500) // connection rebuilt + panels remount (beacon:connection-changed)
  const ind = await ev(c, `document.querySelector('[aria-label="Connection status"]')?.textContent?.trim()`)
  console.log('  indicator after recovery:', ind)
  await shot(c, '07-recovered')
  c.close()
}

async function stageViews() {
  const c = await mainPage()
  const views = ['Mission', 'Activity', 'Tool Feed', 'Status', 'Sessions', 'Board', 'Files', 'Config']
  for (const label of views) {
    const ok = await ev(c, clickText('nav[aria-label="Views"] > button', label))
    if (!ok) throw new Error('nav button not found: ' + label)
    await sleep(1600) // let the panel fetch
    await shot(c, `10-view-${label.toLowerCase().replace(/\s+/g, '')}`)
  }
  for (const tab of ['Memory', 'Telemetry', 'Sentinel', 'Skills']) {
    const ok = await ev(c, clickText('button', tab))
    if (!ok) {
      console.log('  (tab not found: ' + tab + ')')
      continue
    }
    await sleep(1200)
    await shot(c, `11-config-${tab.toLowerCase()}`)
  }
  await ev(c, clickText('nav[aria-label="Views"] > button', 'Chat'))
  await sleep(400)
  c.close()
}

async function stageOverlays() {
  const c = await mainPage()
  await ev(c, key('k', { ctrl: true }))
  await waitFor(c, `!!document.querySelector('[aria-label="Command palette"]')`, 4000)
  await sleep(250)
  await shot(c, '20-palette-open')
  await ev(c, setValue('[aria-label="Search commands"]', 'mem'))
  await sleep(350)
  await shot(c, '21-palette-query-mem')
  await ev(c, key('Escape'))
  await sleep(250)

  await ev(c, key('?'))
  await waitFor(c, `!!document.querySelector('[aria-label="Keyboard shortcuts"]')`, 4000)
  await shot(c, '22-shortcut-sheet')
  await ev(c, key('Escape'))
  await sleep(250)

  await ev(c, click('[aria-label="Connection status"]'))
  await waitFor(c, `!!document.querySelector('[aria-label="Connection details"]')`, 4000)
  await shot(c, '23-connection-popover')
  await ev(c, key('Escape'))
  c.close()
}

async function stageChat() {
  const c = await mainPage()
  await ev(c, clickText('nav[aria-label="Views"] > button', 'Chat'))
  await sleep(400)

  // New chat (POST /api/sessions) → fresh session keeps the model's context small/fast.
  const made = await ev(c, click('[aria-label="New chat"]'))
  console.log('  new chat clicked:', made)
  await sleep(1800)
  await shot(c, '30-new-chat')

  // Local rename of the ACTIVE session row (hover affordances are clickable headlessly).
  await ev(c, `(() => { const row = document.querySelector('.session-row.is-active'); if (!row) return false; row.parentElement.querySelector('.session-rename')?.click(); return true })()`)
  await sleep(300)
  await ev(c, setValue('.session-rename-input', 'visual walk'))
  await ev(c, `(() => { const el = document.querySelector('.session-rename-input'); if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  await sleep(500)
  await shot(c, '31-renamed')

  // Live tool turn → the timeline strip with real durations.
  await ev(c, setValue('.composer textarea', 'Use your sessions_list tool, then reply DONE.'))
  await ev(c, click('.send-btn'))
  await sleep(1500)
  await shot(c, '32-sent-optimistic')

  // Wait for the first tool chip (running state), then capture immediately.
  const sawChip = await (async () => {
    const end = Date.now() + 240000
    while (Date.now() < end) {
      const n = await ev(c, `document.querySelectorAll('[aria-label="Tool activity"] button').length`)
      if (n > 0) return true
      await sleep(1500)
    }
    return false
  })()
  if (sawChip) await shot(c, '33-timeline-live')
  else console.log('  (no tool chip within 240s — model may have answered without tools)')

  // Wait for the reply to finish (caret gone + an assistant row exists).
  await waitFor(c, `!document.querySelector('.caret') && [...document.querySelectorAll('.msg-assistant')].length > 0`, 300000, 2000)
  await sleep(500)
  await shot(c, '34-reply-done')
  const summary = await ev(c, `document.querySelector('[aria-label="Tool activity"]')?.textContent?.trim()?.slice(0, 120) ?? '(no strip)'`)
  console.log('  timeline strip:', summary)

  // Chip → Hermes preview pane.
  await ev(c, click('[aria-label="Tool activity"] button'))
  await sleep(600)
  await shot(c, '35-chip-hermes')

  // Jump chip: scroll away from the bottom → 'Latest' appears; click returns + clears it.
  await ev(c, `(document.querySelector('.messages').scrollTop = 0, true)`)
  await sleep(500)
  const chip = await ev(c, `!!document.querySelector('.jump-latest')`)
  console.log('  jump chip visible after scroll-up:', chip)
  await shot(c, '36-jump-chip')
  await ev(c, click('.jump-latest'))
  await sleep(400)
  c.close()
}

/** Evaluate in the MAIN process via the node inspector. process.mainModule is gone in Electron 33,
 * but the inspector's command-line API supplies `require` — hence includeCommandLineAPI. */
async function mainEval(expression) {
  const list = await (await fetch(`http://127.0.0.1:${NODE_PORT}/json`)).json()
  const m = await connect(list[0].webSocketDebuggerUrl)
  await m.send('Runtime.enable', {})
  const r = await m.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true })
  m.close()
  if (r.exceptionDetails) throw new Error('main eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result?.value
}

async function stageWindow() {
  // Electron's CDP has no Browser.setWindowBounds — drive the resize from the main-process
  // inspector instead, then verify the debounced window-state.json write.
  const bounds = await mainEval(
    `(() => { const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find(x => !x.getTitle().includes('Capture')); if (!w) return 'no window'; w.setSize(1280, 880); return JSON.stringify(w.getBounds()) })()`
  )
  console.log('  resized to:', bounds)
  await sleep(1000) // 300ms debounce + write
  // userData differs by launch mode: packaged/dev = beacon-desktop, bare `electron out/main` = Electron.
  const stateFile = ['beacon-desktop', 'Electron']
    .map((d) => path.join(os.homedir(), '.config', d, 'window-state.json'))
    .find((f) => fs.existsSync(f))
  console.log('  window-state.json:', stateFile ? `${stateFile} → ${fs.readFileSync(stateFile, 'utf8')}` : 'MISSING')
}

async function stageCapture() {
  // Hotkey REGISTRATION via the main-process inspector (the OS-level chord can't be synthesized
  // without xdotool), then spawn the real #capture renderer through the real preload for visuals.
  const reg = await mainEval(
    `(() => { const { globalShortcut } = require('electron'); return JSON.stringify({ summon: globalShortcut.isRegistered('CommandOrControl+Shift+B'), capture: globalShortcut.isRegistered('CommandOrControl+Shift+Space') }) })()`
  )
  console.log('  globalShortcut registered:', reg)

  // Paths resolved DRIVER-side: app.getAppPath() is unreliable under a bare-file launch.
  const preload = path.resolve('out/preload/index.js')
  const indexHtml = path.resolve('out/renderer/index.html')
  await mainEval(`(() => {
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({ width: 620, height: 380, show: true, frame: false, alwaysOnTop: true,
      title: 'Beacon Quick Capture', backgroundColor: '#0b0d12',
      webPreferences: { preload: ${Q(preload)}, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    void win.loadFile(${Q(indexHtml)}, { hash: 'capture' })
    return true
  })()`)
  await sleep(2500)
  const targets = await listTargets()
  const cap = targets.find((t) => t.type === 'page' && t.url.includes('#capture'))
  if (!cap) {
    console.log('  (capture target did not appear)')
  } else {
    const c = await connect(cap.webSocketDebuggerUrl)
    await waitFor(c, `!!document.querySelector('textarea')`, 8000)
    await sleep(400)
    await shot(c, '40-quick-capture')
    c.close()
  }
}

const stages = { setup: stageSetup, recover: stageRecover, views: stageViews, overlays: stageOverlays, chat: stageChat, window: stageWindow, capture: stageCapture }
const stage = process.argv[2]
if (!stages[stage]) {
  console.error('usage: visual-walk.cjs <setup|views|overlays|chat|window|capture>')
  process.exit(2)
}
stages[stage]()
  .then(() => {
    console.log(`[walk:${stage}] done`)
    process.exit(0)
  })
  .catch((e) => {
    console.error(`[walk:${stage}] FAILED:`, e.message)
    process.exit(1)
  })
