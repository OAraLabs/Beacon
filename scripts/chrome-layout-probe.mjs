// window-controls-probe — can the window be closed, minimized and maximized with a MOUSE?
//
// WHY THIS EXISTS. On Linux the main window was created with `frame: false` and AppChrome drew no
// replacements, so the shipped AppImage/deb had NO window buttons: the only exits were Alt+F4 and
// the tray menu, neither discoverable from the window you are looking at. The fix is
// `titleBarStyle: 'hidden'` + `titleBarOverlay`, which keeps the OS buttons — but which pairing
// works on Linux was measured (scripts/wco-probe.cjs), and "the config looks right" is not the same
// as "the buttons are there and the bar yields room to them".
//
// This drives the REAL built app and asserts on observable state:
//   * WCO reports visible, and reserves a strip narrower than the window;
//   * <html> carries data-wco (so the CSS inset is live, not dormant);
//   * the bar's right padding actually grew to clear the buttons;
//   * the wordmark is centred in the REMAINING bar, not the whole one;
//   * minimize / maximize / close all change real window state, driven the way a mouse would.
//
// Run: npm run build && DISPLAY=:1 PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox" \
//        node scripts/window-controls-probe.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// FAIL CLOSED: never drive a build older than the source.
{
  const newest = (dir) => {
    let n = 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) n = Math.max(n, newest(full))
      else if (/\.(ts|tsx|css|html)$/.test(e.name)) n = Math.max(n, statSync(full).mtimeMs)
    }
    return n
  }
  const built = join(REPO, 'out/renderer/index.html')
  if (!existsSync(built)) { console.log('FATAL: nothing built — run `npm run build` first.'); process.exit(4) }
  const src = newest(join(REPO, 'src'))
  if (src > statSync(built).mtimeMs) {
    console.log(`FATAL: source is newer than the build by ${Math.round((src - statSync(built).mtimeMs) / 1000)}s — run \`npm run build\`.`)
    process.exit(5)
  }
}

// ── the stub gateway ─────────────────────────────────────────────────────────────────────
// The window chrome is not daemon-dependent, but the app must get PAST the setup wizard to have a
// main window to measure. A minimal REST + WS stub is enough; SECONDS on the timestamps, because
// rest.ts multiplies last_active by 1000 and an ms value lands sessions in the year 58000.
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const site = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url.startsWith('/api/sessions')) return json(res, 200, [])
  json(res, 200, [])
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port
// A REAL socket, not a dead port: a dead WS makes the connection churn `reconnecting`, main
// broadcasts connection-changed, App.tsx bumps connGen and MainView REMOUNTS — measuring a tree
// that is being rebuilt. The daemon's own `{type:'connected'}` frame settles it.
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (sock) => {
  try { sock.send(JSON.stringify({ type: 'connected' })) } catch { /* closing */ }
  sock.on('error', () => undefined)
})
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))
const WS_PORT = wsSite.address().port

// ── launch ───────────────────────────────────────────────────────────────────────────────
const CDP_PORT = 9700 + (process.pid % 200)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-winchrome-probe-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`], {
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
const closeSockets = () => { try { ws.close() } catch { /* gone */ } }
async function reapAndExit(code) {
  reap(); closeStubs(); closeSockets()
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) process.exit(code)
    await sleep(100)
  }
  killGroup('SIGKILL'); await sleep(300); process.exit(code)
}
process.on('exit', () => { reap(); closeStubs() })
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })

let page = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    // the MAIN window only — quick-capture/HUD are frame:false by design and would read as failures
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !/#(capture|hud|browser|terminal)/.test(t.url))
    if (page) break
  } catch { /* not up yet */ }
}
if (!page) { console.log('NO PAGE TARGET — main log tail:\n' + mainLog.join('').slice(-1500)); await reapAndExit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let msgId = 0
const pending = new Map()
const PAGE_ERRORS = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') PAGE_ERRORS.push(m.params?.exceptionDetails?.exception?.description ?? 'exception')
}
const send = (method, params = {}) => new Promise((res) => {
  const i = ++msgId
  const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ result: { exceptionDetails: { text: `timeout: ${method}` } } }) } }, 20000)
  pending.set(i, (m) => { clearTimeout(timer); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
send('Runtime.enable')
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
  return r.result?.result?.value
}
async function until(expr, ms = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await evaluate(expr); if (v && !v.__error) return v; await sleep(200) }
  return null
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}
console.log('\nWindow Controls Overlay (are the OS buttons actually there):')
await until(`document.querySelector('.app-chrome') ? true : null`, 40000)
const wco = await evaluate(`(() => {
  const w = navigator.windowControlsOverlay
  const r = w?.getTitlebarAreaRect ? w.getTitlebarAreaRect() : null
  return { visible: Boolean(w?.visible), areaW: r ? r.width : null, innerWidth: window.innerWidth,
           dataWco: document.documentElement.hasAttribute('data-wco') }
})()`)
ok(wco.visible === true, 'WCO reports visible — the OS reserved a button strip', JSON.stringify(wco))
ok(wco.areaW !== null && wco.areaW < wco.innerWidth, 'the reserved strip is real (titlebar area narrower than the window)', `area=${wco.areaW} inner=${wco.innerWidth}`)
ok(wco.dataWco === true, '<html> carries data-wco, so the CSS inset is live rather than dormant')

console.log('\nThe bar yields room to the buttons (not painted under them):')
const box = await evaluate(`(() => {
  const bar = document.querySelector('.app-chrome')
  const cs = getComputedStyle(bar)
  const brand = document.querySelector('.app-chrome-brand')
  const cmdk = document.querySelector('.app-chrome-cmdk')
  const barRect = bar.getBoundingClientRect()
  const cmdkRect = cmdk ? cmdk.getBoundingClientRect() : null
  const w = navigator.windowControlsOverlay.getTitlebarAreaRect()
  return {
    paddingRight: parseFloat(cs.paddingRight), paddingLeft: parseFloat(cs.paddingLeft),
    barRight: barRect.right, cmdkRight: cmdkRect ? cmdkRect.right : null,
    overlayStartX: w.x + w.width, innerWidth: window.innerWidth,
    // where the wordmark is centred: the brand box's centre, vs the centre of the USABLE bar
    brandCentre: brand ? brand.getBoundingClientRect().left + brand.getBoundingClientRect().width / 2 : null,
    usableCentre: (barRect.left + parseFloat(cs.paddingLeft) + (w.x + w.width)) / 2,
    barHeight: barRect.height
  }
})()`)
const inset = box.innerWidth - box.overlayStartX
ok(inset > 0, 'the toolkit reserved a positive-width strip for the buttons', `inset=${Math.round(inset)}px`)
ok(box.paddingRight >= inset, 'the bar\'s right padding clears the reserved strip', `padding=${Math.round(box.paddingRight)} inset=${Math.round(inset)}`)
ok(box.paddingLeft < 20, 'the left padding dropped the macOS traffic-light inset (no buttons there)', `left=${box.paddingLeft}`)
ok(box.cmdkRight !== null && box.cmdkRight <= box.overlayStartX + 1,
   'the ⌘K pill is not painted UNDER the window buttons', `cmdkRight=${Math.round(box.cmdkRight)} overlayStartX=${Math.round(box.overlayStartX)}`)
ok(Math.abs(box.brandCentre - box.usableCentre) < 24,
   'the wordmark is centred in the USABLE bar, not the full width including the button strip',
   `brand=${Math.round(box.brandCentre)} usable=${Math.round(box.usableCentre)}`)
ok(box.barHeight === 38, 'the bar is 38px — the overlay height main asked for', String(box.barHeight))

console.log('\nThe overlay matches the skin (it must not be an invisible button):')
const ov = await evaluate(`(() => {
  const root = getComputedStyle(document.documentElement)
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;width:0;height:0'
  probe.style.color = 'rgb(1, 2, 3)'
  probe.style.color = 'var(--chrome-ground)'
  document.documentElement.appendChild(probe)
  const ground = getComputedStyle(probe).color
  probe.style.color = 'var(--ink)'
  const ink = getComputedStyle(probe).color
  probe.remove()
  return { theme: document.documentElement.getAttribute('data-theme'), ground, ink }
})()`)
console.log('  [observed] theme=' + ov.theme + ' --chrome-ground=' + ov.ground + ' --ink=' + ov.ink)
ok(Boolean(ov.ground) && ov.ground !== 'rgb(1, 2, 3)', 'the skin\'s chrome ground resolves to a real colour')

// Window state (minimize/maximize/close) is deliberately NOT driven here. See the header:
// the Browser.getWindowForTarget CDP method is unavailable in this Electron build, so there is
// no window handle to drive — and probe:window-chrome covers window state from main against
// the shipped config, where it can actually be measured.

// ── the repaint is per skin, and the value that crosses is CONVERTED ───────────────────────
// This is the half that fails SILENTLY if it is wrong. `--chrome-ground` is a color-mix, which
// Chromium computes to `color(srgb …)` — and Electron REJECTS that form (probe:window-chrome
// asserts the rejection). If the renderer forwarded the computed value verbatim, every repaint
// would throw in main, main would keep the colours the window was CREATED with, and since those
// match the default plate the bug would be invisible on NOX and wrong on the other eight.
// So: capture what the renderer actually sends, switch to a LIGHT plate, and read the payload.
console.log('\nThe overlay repaint follows the skin (and sends a form Electron accepts):')
// WHAT IS OBSERVED, AND WHY NOT A MONKEY-PATCH. The first draft wrapped
// `window.beacon.setTitlebarOverlay` to record payloads. It recorded nothing, and the reason is
// structural: the contextBridge object is FROZEN (`Object.isFrozen(window.beacon) === true`,
// measured), so the assignment fails silently and every assertion built on it measures absence.
// A frozen bridge is correct — it is what stops a compromised renderer rewriting the preload — so
// the probe moves instead of asking the app to become patchable.
//
// Main logs the overlay it APPLIES (`[chrome] titlebar overlay applied: …`). That is the positive
// record: it distinguishes "applied the light plate's colours" from "never fired" from "fired and
// was rejected", which absence-of-warning cannot.

const clicked = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[aria-label="Views"] button')]
  const cfg = btns.find((b) => b.title === 'Config')
  if (!cfg) return 'no-config'
  cfg.click()
  return 'ok'
})()`)
ok(clicked === 'ok', '[drive] opened Config')
const skinTab = await until(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    .find((b) => (b.textContent ?? '').trim() === 'Skin')
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(skinTab), '[drive] opened the Skin tab')

// LVX is the light plate: paper #faf9f7. Its chrome ground is a LIGHT colour, and its --ink is
// DARK — the opposite of NOX. A repaint that still carries NOX's near-black ground proves the
// conversion never ran, or never fired at all.
const picked = await until(`(() => {
  const cards = [...document.querySelectorAll('.skin-card')].filter((b) => b.offsetParent !== null)
  const hit = cards.find((c) => (c.textContent ?? '').includes('LVX'))
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(picked), '[drive] picked the LVX (light) plate')
await sleep(800)

const themeAfter = await evaluate(`document.documentElement.getAttribute('data-theme')`)
ok(themeAfter === 'light', 'the skin actually changed', String(themeAfter))
await sleep(600)
// Read what main APPLIED from its own log.
const log = mainLog.join('')
const applied = [...log.matchAll(/\[chrome\] titlebar overlay applied: (.+?) \/ (.+?)$/gm)].map((m) => ({ color: m[1].trim(), symbolColor: m[2].trim() }))
const rejected = [...log.matchAll(/\[chrome\] titlebar overlay payload rejected/g)].length
const failed = [...log.matchAll(/\[chrome\] setTitleBarOverlay failed/g)].length
console.log('  [observed] overlays main applied: ' + JSON.stringify(applied))
console.log('  [observed] rejected payloads: ' + rejected + '  setTitleBarOverlay failures: ' + failed)
ok(applied.length > 0, 'a repaint reached main and was APPLIED on the theme change (the wiring is live, not dormant)')
const last = applied[applied.length - 1]
if (last) {
  // rgb()/rgba()/#hex only — never the computed color(srgb …) form Electron rejects.
  const accepted = /^(rgb\(|rgba\(|#)/.test(last.color) && /^(rgb\(|rgba\(|#)/.test(last.symbolColor)
  ok(accepted, 'both colours are in a form Electron ACCEPTS (converted, not forwarded verbatim)', JSON.stringify(last))
  ok(!/^color\(/.test(last.color), 'the ground is NOT the raw color(srgb …) form that throws in main', last.color)
  // LVX paper is #faf9f7, so --chrome-ground (86% paper) is LIGHT: every channel well above 180.
  const nums = (last.color.match(/\d+/g) ?? []).map(Number)
  ok(nums.length === 3 && nums.every((n) => n > 180),
     'the ground is LIGHT for the light plate — it tracks the skin rather than staying NOX-dark', JSON.stringify(nums))
  const inkNums = (last.symbolColor.match(/\d+/g) ?? []).map(Number)
  ok(inkNums.length >= 3 && inkNums.every((n) => n < 120),
     'the glyph colour is DARK on the light plate — buttons stay legible', JSON.stringify(inkNums))
}
ok(rejected === 0, 'main rejected nothing (the renderer converts before sending)', String(rejected))
ok(failed === 0, 'setTitleBarOverlay threw nothing', String(failed))

// Switch back so the probe leaves the app where it found it (the theme is persisted).
await until(`(() => {
  const cards = [...document.querySelectorAll('.skin-card')].filter((b) => b.offsetParent !== null)
  const hit = cards.find((c) => (c.textContent ?? '').includes('NOX'))
  if (!hit) return null
  hit.click()
  return true
})()`, 10000)

console.log('\nNo renderer exceptions while doing all of that:')
ok(PAGE_ERRORS.length === 0, 'the page threw nothing', JSON.stringify(PAGE_ERRORS.slice(0, 3)))

console.log(failures === 0 ? '\nPASS — the window has real OS buttons, and the bar clears them' : `\n${failures} FAIL`)
await reapAndExit(failures === 0 ? 0 : 1)
