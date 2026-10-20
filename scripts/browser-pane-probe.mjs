// Drive the REAL app and exercise the browser pane end to end — the hand-verification for the
// browser-pane phases (docs: the PR descriptions). Runs against the repo build by default, or the
// PACKAGED bundle with BEACON_BUNDLE=<path/to/Beacon.app> — the packaged run is the one that
// matters for CSP + session questions, because the shell's CSP hook only exists in packaged builds.
//
//   npm run build && node scripts/browser-pane-probe.mjs
//   npm run pack:mac:probe && BEACON_BUNDLE=dist-probe/mac-arm64/Beacon.app node scripts/browser-pane-probe.mjs
// (a PROBE build: a release build refuses --inspect and --remote-debugging-port, see electron-builder.probe.yml)
//
// What it proves, each as a PASS/FAIL line (never a silent skip):
//   embed     WebContentsView exists, sits exactly over the pane's hole, hides under an overlay
//   session   its own in-memory partition; the shell's default session sees none of its cookies
//   hardening sandbox/contextIsolation/no-node/no-preload; the page has no bridge
//   csp       the PAGE's own inline script runs and its data: font loads — the shell CSP does not
//             leak into it (packaged: positive control first — the shell CSP refuses inline script)
//   phase 1   error pages (dns / refused / cert), permissions denied + said so, download blocked,
//             window.open → system browser (recorded, no window created)
//   phase 2   Send to chat lands url + selection in the composer, and nothing was sent
//   panel     the pane lives in the chat view's side panel: switching to the terminal and
//             collapsing the panel each ZERO the view's rect (not paint over it) with no reload;
//             the divider resizes the hole and the view follows; state survives a shell reload
//   invariant the page never gets window.beacon; a hostile page cannot reach the shell
//
// A fresh --user-data-dir every run: nothing from a previous run can make an assertion pass.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, mkdtempSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const BUNDLE = process.env.BEACON_BUNDLE ? join(process.cwd(), process.env.BEACON_BUNDLE).replace(/\/\//g, '/') : null
const PACKAGED = !!BUNDLE
const BIN = PACKAGED ? join(BUNDLE, 'Contents/MacOS/Beacon') : null
if (PACKAGED && !existsSync(BIN)) {
  console.log('FATAL: no bundle at', BIN)
  process.exit(4)
}
if (!PACKAGED && !existsSync(join(REPO, 'out/renderer/index.html'))) {
  console.log('FATAL: nothing built — run `npm run build` first')
  process.exit(4)
}
const INSPECT = 9400 + (process.pid % 400)
const CDP = INSPECT + 1
const userData = mkdtempSync(join(tmpdir(), 'beacon-browser-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonce = `${process.pid}-${Date.now()}`

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`)
  if (!ok) failures++
}
const section = (s) => console.log(`\n── ${s}`)

for (const p of [INSPECT, CDP]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(500) })
    if (r.ok) {
      console.log('FATAL: port busy', p)
      process.exit(3)
    }
  } catch {
    /* free */
  }
}

// ── the site under test ──────────────────────────────────────────────────────────────────
const woff2 = readFileSync(join(REPO, 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2')).toString('base64')
const downloadName = `probe-${nonce}.bin`
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>@font-face{font-family:'ProbeFont';src:url(data:font/woff2;base64,${woff2}) format('woff2')} body{font-family:ProbeFont,monospace;padding:20px}</style>
<script>window.__inline = 42; window.__cspViolations = []; document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI))</script>
</head><body>${body}</body></html>`
const site = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Set-Cookie', `probe=${nonce}; Path=/`)
    res.end(
      page(
        'Probe Page',
        `<nav>NAV-CHROME-TEXT</nav><main><h1>Probe heading</h1><p id="sel">SELECTABLE-${nonce}</p><p>BODY-${nonce}</p></main>
         <a id="blank" href="/two" target="_blank">blank</a> <a id="dl" href="/${downloadName}" download>download</a>
         <button id="popup" onclick="window.open('/two')">popup</button>`
      )
    )
  } else if (u.pathname === '/two') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(page('Second Page', `<main>SECOND-${nonce}</main>`))
  } else if (u.pathname === `/${downloadName}`) {
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
    res.end(Buffer.alloc(1024, 1))
  } else {
    res.statusCode = 404
    res.end('nope')
  }
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${site.address().port}`
// a port nothing listens on (bind, read, release) — port 1 would be ERR_UNSAFE_PORT, a different page
const CLOSED_PORT = await new Promise((r) => {
  const t = createServer()
  t.listen(0, '127.0.0.1', () => {
    const p = t.address().port
    t.close(() => r(p))
  })
})

// a self-signed https server for the certificate-error page
let HTTPS_BASE = null
try {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-probe-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  const tls = createHttpsServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (_req, res) => res.end('tls'))
  await new Promise((r) => tls.listen(0, '127.0.0.1', r))
  HTTPS_BASE = `https://localhost:${tls.address().port}`
} catch (e) {
  console.log('note: no openssl — the certificate-error page will not be exercised:', e.message)
}

// ── launch ───────────────────────────────────────────────────────────────────────────────
// BEACON_GATEWAY_HOST makes decideStartup() 'connect' with no stored profile, so the main view
// renders (with a failing connection) instead of the first-run wizard. The daemon is not needed.
const env = { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(CLOSED_PORT), BEACON_GATEWAY_WS_PORT: String(CLOSED_PORT), ELECTRON_ENABLE_LOGGING: '1' }
const args = [`--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`]
const child = PACKAGED
  ? spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  : spawn('npx', ['electron', '.', ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env })
const log = []
child.stdout.on('data', (d) => log.push(String(d)))
child.stderr.on('data', (d) => log.push(String(d)))
let reaped = false
const reap = () => {
  if (reaped) return
  reaped = true
  try {
    child.kill('SIGTERM')
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }, 1500).unref?.()
}
process.on('exit', reap)
process.on('uncaughtException', (e) => {
  console.error('probe threw:', e?.stack ?? e)
  reap()
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('probe rejected:', e?.stack ?? e)
  reap()
  process.exit(1)
})

async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find(pick)
      if (t) return t
    } catch {
      /* not yet */
    }
  }
  return null
}
async function targets(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    return []
  }
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  const events = []
  let id = 0
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) events.push(m)
  }
  // Every call has a deadline: a CDP call that never answers must surface as a FAIL line, never
  // as a probe that sits there forever (which is what a piped `tail` made look like silence).
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      const timer = setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i)
          res({ result: { exceptionDetails: { text: `timeout after 15s: ${method}` } } })
        }
      }, 15000)
      pending.set(i, (m) => {
        clearTimeout(timer)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  return new Promise((res, rej) => {
    ws.onopen = () => res({ send, evaluate, events, ws })
    ws.onerror = rej
  })
}
/** Poll an expression in a client until it is truthy (or the deadline passes). */
async function until(c, expr, ms = 8000) {
  const t0 = Date.now()
  let v
  while (Date.now() - t0 < ms) {
    v = await c.evaluate(expr)
    if (v && !v.__error) return v
    await sleep(150)
  }
  if (v && v.__error) {
    console.log(`  (until: ${v.__error})`)
    return null
  }
  return v
}

// main-process inspector
const node = await attach(INSPECT, (t) => t.type === 'node')
check(!!node, 'main-process inspector target found', node ? '' : log.join('').slice(-600))
if (!node) {
  reap()
  process.exit(1)
}
const M = await client(node.webSocketDebuggerUrl)
await M.send('Runtime.enable')
// `electron` from the main process. The inspector's evaluate scope has no `require` and the
// bundle sets no process.mainModule; createRequire from the Node `module` builtin goes through the
// same patched resolver the app uses, so 'electron' resolves in dev and in the packaged asar alike.
const R = `(process.getBuiltinModule('module').createRequire(process.cwd() + '/'))`
const E = `(${R}('electron'))`

// shell renderer
const shellT = await attach(CDP, (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
check(!!shellT, 'shell renderer target found', shellT?.url)
if (!shellT) {
  reap()
  process.exit(1)
}
const S = await client(shellT.webSocketDebuggerUrl)
await S.send('Runtime.enable')
await S.send('Log.enable')
const shellReady = await until(S, `!!document.querySelector('.shell') && !!document.querySelector('.rail-scroll')`, 20000)
check(shellReady === true, 'main view rendered (env gateway → no first-run wizard)', shellReady === true ? '' : await S.evaluate('document.body.innerText.slice(0,200)'))

section(PACKAGED ? 'shell CSP (packaged)' : 'shell CSP (dev — hook not installed, by design)')
if (PACKAGED) {
  // Read the startup refusals FIRST (Log.enable replays what was logged before we attached), so
  // the positive control's own refusal below cannot count against the app.
  await sleep(300)
  const refused = S.events.filter((e) => e.method === 'Log.entryAdded' && /Refused to/.test(e.params.entry.text)).map((e) => e.params.entry.text.slice(0, 160))
  check(refused.length === 0, 'no CSP refusal logged during shell startup (fonts included)', refused.join(' | '))
  const ctl = await S.evaluate(`(() => { window.__v = []; document.addEventListener('securitypolicyviolation', e => window.__v.push(e.violatedDirective)); const s = document.createElement('script'); s.textContent = 'window.__inline_ran = true'; document.head.appendChild(s); return new Promise(res => setTimeout(() => res({ ran: !!window.__inline_ran, v: window.__v }), 300)) })()`)
  check(ctl?.ran === false && ctl.v.some((d) => d.startsWith('script-src')), 'positive control: the shell CSP refuses an inline <script>', JSON.stringify(ctl))
  const fonts = await S.evaluate(`Array.from(document.fonts).filter(f => f.status === 'error').map(f => f.family + ' ' + f.status)`)
  check(Array.isArray(fonts) && fonts.length === 0, 'no font face in the shell is in status "error"', JSON.stringify(fonts))
}

section('open the pane, navigate')
const noPanel = await S.evaluate(`!document.querySelector('.side-panel')`)
check(noPanel === true, 'the side panel starts collapsed (fresh profile)')
// R3: from Mission there is no dock control to click (the group lives in the thread header), so
// the chord opens it — and brings the chat view up with the pane.
const opened = await S.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })); return true })()`)
check(opened === true, 'browser toggle in the nav rail clicked')
const hole = await until(S, `!!document.querySelector('.layout .side-panel[data-pane="browser"] .browser-hole')`)
check(hole === true, 'pane mounted INSIDE the chat view\'s side panel (.layout .side-panel .browser-hole)')
// R3 says the pane collapses the session list "so the thread keeps its reading width". This
// asserted the GESTURE — that `.layout .sidebar` is gone — and that is not what ships.
// `showSessions()` deliberately encodes the REASON instead, and says so: it collapses the list
// only when keeping it would squeeze the conversation below CONVERSATION_MIN_WIDTH, because at
// the shipped 392px dock a wide window has nothing to protect and "taking the list away is pure
// loss: you lose your place in 182 sessions to gain width the thread did not need".
//
// So this probe was asserting a rule the app had deliberately superseded. `side-panel-smoke.ts`
// already pins the shipped rule in both directions and passes; the two disagreed, and the one
// that was wrong is the one nobody runs (#151).
//
// What must hold either way is the invariant R3 exists to protect: the conversation is on screen
// beside the pane, with its reading width.
const chatBeside = await S.evaluate(`(() => {
  const c = document.querySelector('.layout .app') || document.querySelector('.layout .chat-home')
  if (!c) return { present: false }
  return { present: true, width: c.getBoundingClientRect().width, sidebar: document.querySelector('.layout .sidebar')?.getBoundingClientRect().width ?? null }
})()`)
check(
  chatBeside?.present === true && chatBeside.width >= 380,
  'the conversation (chat/home) is on screen beside the pane with its reading width — the panel replaced nothing it should not',
  JSON.stringify(chatBeside)
)
async function navigate(url) {
  return S.evaluate(`(() => { const i = document.querySelector('.browser-url'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(url)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true })()`)
}
await navigate(BASE + '/')
const viewT = await attach(CDP, (t) => t.type === 'page' && t.url.startsWith(BASE), 30)
check(!!viewT, 'a page target for the browsed URL appeared', viewT?.url ?? JSON.stringify(await targets(CDP)))
if (!viewT) {
  reap()
  process.exit(1)
}
const V = await client(viewT.webSocketDebuggerUrl)
await V.send('Runtime.enable')
const title = await until(V, `document.readyState === 'complete' && document.title`)
check(title === 'Probe Page', 'the page loaded in the view', title)

// BEACON_SHOT_DIR=<dir>: OS-level screenshots (the native view is not part of the shell's own
// document, so only a screen capture shows the pane as a person sees it). Needs the window on
// screen and the caller's Screen Recording permission; a black/blank PNG means the latter.
async function shot(name) {
  if (!process.env.BEACON_SHOT_DIR) return
  const b = await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); w.show(); w.focus(); return w.getBounds() })()`)
  await sleep(600)
  const out = join(process.env.BEACON_SHOT_DIR, `${name}.png`)
  try {
    execFileSync('screencapture', ['-x', '-o', '-R', `${b.x},${b.y},${b.width},${b.height}`, out], { stdio: 'ignore' })
    console.log(`shot: ${out}`)
  } catch (e) {
    console.log(`shot: FAILED ${name} — ${e.message}`)
  }
}
await shot('browser-pane')

section('embed: WebContentsView, geometry, occlusion')
const embed = await M.evaluate(`(() => { const { BrowserWindow, webContents, WebContentsView } = ${E};
  const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(BASE)}));
  if (!wc) return { err: 'no webContents for the site' };
  const wins = BrowserWindow.getAllWindows();
  let holder = null, view = null;
  for (const w of wins) for (const v of w.contentView.children) if (v.webContents && v.webContents.id === wc.id) { holder = w; view = v }
  return { found: !!view, isWCV: view instanceof WebContentsView, holderIsMain: holder === wins.find(w => w.getTitle() === 'Beacon'),
    bounds: view && view.getBounds(), zoom: holder && holder.webContents.getZoomFactor(), windows: wins.length, type: wc.getType() } })()`)
check(embed?.found === true && embed.isWCV === true, 'the page lives in a WebContentsView (not <webview>, not a BrowserWindow)', JSON.stringify(embed))
check(embed?.holderIsMain === true, 'attached to the main shell window', JSON.stringify(embed))
const holeRect = await S.evaluate(`(() => { const r = document.querySelector('.browser-hole').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
const z = embed?.zoom ?? 1
const near = (a, b) => Math.abs(a - b) <= 2
check(
  embed?.bounds && near(embed.bounds.x, holeRect.x * z) && near(embed.bounds.y, holeRect.y * z) && near(embed.bounds.width, holeRect.width * z) && near(embed.bounds.height, holeRect.height * z),
  'view bounds match the chrome hole (±2px, zoom-scaled)',
  `view=${JSON.stringify(embed?.bounds)} hole=${JSON.stringify(holeRect)} zoom=${z}`
)
check(embed?.bounds && embed.bounds.width > 100 && embed.bounds.height > 100, 'view is sized (visible) while the page shows')
// occlusion: open the command palette over it
await S.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`)
await sleep(300)
// Electron 33's View has no getVisible; main hides by setVisible(false) + a zero rect, and the
// zero rect is the observable half.
const viewHidden = () => M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const v = w.contentView.children.find(v => v.webContents); if (!v) return 'no-view'; const b = v.getBounds(); return b.width === 0 && b.height === 0 })()`)
const hidden = await viewHidden()
check(hidden === true, 'view hides (zero rect) while the command palette covers the hole', String(hidden))
// the palette closes on Escape in ITS input (React onKeyDown), so send the key to the focused element
await S.evaluate(`(document.querySelector('[role="dialog"] input') || document.activeElement || window).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
let closed = await until(S, `!document.querySelector('[role="dialog"]')`, 2000)
if (closed !== true) {
  // React may have deferred the unmount past our read; the scrim click is the other close path.
  await S.evaluate(`document.querySelector('[role="dialog"]')?.parentElement?.click(); true`)
  closed = await until(S, `!document.querySelector('[role="dialog"]')`, 2000)
}
check(closed === true, 'the palette closed on Escape (probe precondition)', String(closed))
let shown = true
for (let i = 0; i < 20 && shown !== false; i++) {
  await sleep(150)
  shown = await viewHidden()
}
check(shown === false, 'view shows again (sized) once the palette closes', String(shown))

section('side panel: switch, collapse, resize — the view is hidden, never merely covered')
// At the default 1100px window the panel is already at its fitted maximum (the conversation keeps
// its 380px); pin that first, then give the window room so the divider has somewhere to go.
const fittedSmall = await S.evaluate(`(() => { const p = document.querySelector('.side-panel').getBoundingClientRect().width; const c = (document.querySelector('.layout .app') || document.querySelector('.layout .chat-home')).getBoundingClientRect().width; return { panel: p, conversation: c, window: window.innerWidth } })()`)
check(fittedSmall?.conversation >= 380 && fittedSmall.panel >= 320, `at ${fittedSmall?.window}px the panel is fitted so the conversation keeps ≥380px`, JSON.stringify(fittedSmall))
await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); w.setSize(1500, 900); return true })()`)
// R3: the browser pane's desired width is 392 until dragged; at 1100px it was fitted DOWN, so
// the room a 1500px window gives must hand exactly that back.
const grew = await until(S, `window.innerWidth >= 1400 && document.querySelector('.side-panel').getBoundingClientRect().width === 392 ? document.querySelector('.side-panel').getBoundingClientRect().width : null`, 6000)
check(grew === 392, `with a 1500px window the panel takes its desired width — the 392px R3 default (${grew})`)
const wcIdBefore = await M.evaluate(`(() => { const wc = ${E}.webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(BASE)})); return wc ? wc.id : null })()`)
await V.evaluate(`window.__panelMarker = 'panel-' + ${JSON.stringify(nonce)}; true`)
// Switch to the terminal pane with ⌘3, not by clicking `.dock-group`.
//
// Measured: at this point the probe is on chat-HOME (⌘2 from Mission opens the pane and brings the
// chat view up, but selects no thread), and there `{dockGroup: false, header: false}` — the dock
// group lives in the THREAD header, and ChatHome offers the same two toggles as labeled composer
// buttons instead. So the old selector matched nothing, `.click()` threw inside the evaluate, and
// the wait below timed out. Three failures came from that one line, and one of them —
// "the terminal pane unmounted" — PASSED, because a pane that never mounted is also not mounted.
//
// The chord is the affordance both views share, it is what R3 documents (⌘1/⌘2/⌘3), and it is
// already how this probe opens the browser pane twenty lines up.
await S.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true })); return true })()`)
const termUp = await until(S, `!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && !document.querySelector('.browser-hole:not([hidden] *)') || (!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && document.querySelector('.browser-pane')?.hidden === true)`, 15000)
check(termUp === true, 'the terminal pane took the panel (xterm mounted; the browser chrome is hidden, still mounted)')
let hiddenForTerminal = null
for (let i = 0; i < 20 && hiddenForTerminal !== true; i++) {
  await sleep(150)
  hiddenForTerminal = await viewHidden()
}
check(hiddenForTerminal === true, 'the WebContentsView rect is ZERO while the terminal shows (hidden, not covered)', String(hiddenForTerminal))
const stillAttachedT = await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const v = w.contentView.children.find(v => v.webContents); return v ? v.webContents.id : null })()`)
check(stillAttachedT === wcIdBefore, 'the same web contents stay attached to the main window (nothing moved, nothing closed)', `${stillAttachedT} vs ${wcIdBefore}`)
const aliveT = await V.evaluate(`({ marker: window.__panelMarker, title: document.title })`)
check(aliveT?.marker === 'panel-' + nonce && aliveT.title === 'Probe Page', 'NO reload: the page kept its JS state across the switch', JSON.stringify(aliveT))
// back to the browser pane
// ⌘2 again, for the same reason as ⌘3 above: on chat-home there is no `.dock-group` to click, so
// this line threw and the pane never came back — which is why the two assertions below passed
// vacuously (a browser pane that never returned is also "not the terminal", and a terminal that
// never mounted is also "unmounted").
await S.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })); return true })()`)
let shownAgain = true
for (let i = 0; i < 20 && shownAgain !== false; i++) {
  await sleep(150)
  shownAgain = await viewHidden()
}
check(shownAgain === false, 'switching back to the browser pane sizes the view again', String(shownAgain))
check((await S.evaluate(`!document.querySelector('.xterm')`)) === true, 'the terminal pane unmounted (its xterm is gone; the pty lives on in main)')
const holeAfterSwitch = await S.evaluate(`(() => { const r = document.querySelector('.browser-hole').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
const boundsAfterSwitch = await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const v = w.contentView.children.find(v => v.webContents); return v ? v.getBounds() : null })()`)
check(boundsAfterSwitch && near(boundsAfterSwitch.x, holeAfterSwitch.x * z) && near(boundsAfterSwitch.width, holeAfterSwitch.width * z) && near(boundsAfterSwitch.height, holeAfterSwitch.height * z), 'view bounds match the panel hole again (±2px)', `view=${JSON.stringify(boundsAfterSwitch)} hole=${JSON.stringify(holeAfterSwitch)}`)
// collapse via the panel's close
await S.evaluate(`document.querySelector('button[aria-label="Close the side panel"]').click(); true`)
const collapsed = await until(S, `!document.querySelector('.side-panel') && !document.querySelector('.browser-hole')`)
check(collapsed === true, 'the panel collapsed (no .side-panel, no hole)')
let hiddenCollapsed = null
for (let i = 0; i < 20 && hiddenCollapsed !== true; i++) {
  await sleep(150)
  hiddenCollapsed = await viewHidden()
}
check(hiddenCollapsed === true, 'the WebContentsView rect is ZERO while the panel is collapsed', String(hiddenCollapsed))
// Read the control that is actually on screen. The dock segment exists only in the thread header;
// on chat-home the same toggle is a labeled composer button. Both carry the title and aria-pressed,
// so ask for the state rather than for one particular element — the old query returned an ERROR
// object (the element was null and .getAttribute threw), which rendered as "[object Object]" and
// read like a wrong value rather than a missing element.
const railOff = await S.evaluate(`(() => {
  const b = document.querySelector('.dock-group button[title*="browser pane"], button[title*="browser pane"]')
  return b ? b.getAttribute('aria-pressed') : 'NO-CONTROL-FOUND'
})()`)
check(railOff === 'false', 'the browser toggle reads not-pressed while collapsed', String(railOff))
check((await S.evaluate(`!!document.querySelector('.rail-scroll button[title*="pane"]')`)) === false, 'the rail holds no pane toggle (R3)')
// reopen with ⌘2
await S.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })); true`)
const reopened = await until(S, `!!document.querySelector('.side-panel[data-pane="browser"] .browser-hole')`)
check(reopened === true, '⌘2 reopened the panel on the browser pane')
let shownReopen = true
for (let i = 0; i < 20 && shownReopen !== false; i++) {
  await sleep(150)
  shownReopen = await viewHidden()
}
check(shownReopen === false, 'the view is sized again after reopening', String(shownReopen))
const aliveR = await V.evaluate(`({ marker: window.__panelMarker })`)
check(aliveR?.marker === 'panel-' + nonce, 'and the page still has its JS state (no reload across collapse/reopen)', JSON.stringify(aliveR))
// resize with the divider: real pointer events (pointer capture + the drag shield)
const widthBefore = await S.evaluate(`document.querySelector('.side-panel').getBoundingClientRect().width`)
const PE = `(type, cx) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: 300, isPrimary: true })`
await S.evaluate(`(() => { window.__div = document.querySelector('.side-panel-divider'); const r = window.__div.getBoundingClientRect(); window.__dx = r.left + r.width / 2; window.__div.dispatchEvent((${PE})('pointerdown', window.__dx)); return true })()`)
const shield = await until(S, `!!document.querySelector('.side-panel-drag-shield')`, 2000)
check(shield === true, 'pointerdown on the divider raised the drag shield over the whole window')
let hiddenDuringDrag = null
for (let i = 0; i < 20 && hiddenDuringDrag !== true; i++) {
  await sleep(150)
  hiddenDuringDrag = await viewHidden()
}
check(hiddenDuringDrag === true, 'the view hides (zero rect) while the drag is in progress — the shield covers the hole', String(hiddenDuringDrag))
await S.evaluate(`(() => { const ev = ${PE}; window.__div.dispatchEvent(ev('pointermove', window.__dx - 60)); window.__div.dispatchEvent(ev('pointermove', window.__dx - 120)); window.__div.dispatchEvent(ev('pointerup', window.__dx - 120)); return true })()`)
const shieldGone = await until(S, `!document.querySelector('.side-panel-drag-shield')`, 2000)
check(shieldGone === true, 'the shield left on release')
const widthAfter = await until(S, `(() => { const w = document.querySelector('.side-panel').getBoundingClientRect().width; return w > ${widthBefore} + 100 ? w : null })()`)
check(typeof widthAfter === 'number' && near(widthAfter, widthBefore + 120), `dragging the divider 120px left widened the panel (${widthBefore} → ${widthAfter})`)
let shownDrag = true
for (let i = 0; i < 20 && shownDrag !== false; i++) {
  await sleep(150)
  shownDrag = await viewHidden()
}
const holeAfterDrag = await S.evaluate(`(() => { const r = document.querySelector('.browser-hole').getBoundingClientRect(); return { x: r.left, width: r.width } })()`)
const boundsAfterDrag = await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const v = w.contentView.children.find(v => v.webContents); return v ? v.getBounds() : null })()`)
check(shownDrag === false && boundsAfterDrag && near(boundsAfterDrag.x, holeAfterDrag.x * z) && near(boundsAfterDrag.width, holeAfterDrag.width * z), 'after the drag the view follows the wider hole (±2px)', `view=${JSON.stringify(boundsAfterDrag)} hole=${JSON.stringify(holeAfterDrag)}`)
const persistedW = await S.evaluate(`window.beacon.settings.get('panel:width:v1')`)
check(typeof persistedW === 'string' && near(Number(persistedW), widthAfter), 'the width persisted to the settings store', persistedW)
// the conversation is still usable beside the widened panel
const chatOk = await S.evaluate(`(() => { const c = document.querySelector('.layout .app') || document.querySelector('.layout .chat-home'); const ta = c && c.querySelector('textarea'); const r = c && c.getBoundingClientRect(); return { width: r ? r.width : 0, composer: !!ta, composerVisible: !!ta && ta.getBoundingClientRect().width > 100, sidebar: document.querySelector('.layout .sidebar')?.getBoundingClientRect().width } })()`)
// Same correction as above: the composer and the reading width are the contract; whether the list
// is up is derived from the room, not asserted unconditionally.
check(chatOk?.width >= 380 && chatOk.composer && chatOk.composerVisible, 'the conversation keeps ≥380px with a visible composer beside the widened panel (R3)', JSON.stringify(chatOk))

// ...and the OTHER direction, which the old unconditional assertion made untestable: squeeze the
// window until keeping the list WOULD cost the thread its minimum, and the list must yield. Without
// this, an app that never collapses the list would satisfy everything above.
await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); w.setSize(1000, 900); return true })()`)
const squeezed = await until(S, `(() => {
  const c = document.querySelector('.layout .app') || document.querySelector('.layout .chat-home')
  if (!c || window.innerWidth > 1050) return null
  return { width: c.getBoundingClientRect().width, sidebar: document.querySelector('.layout .sidebar')?.getBoundingClientRect().width ?? null, window: window.innerWidth }
})()`, 6000)
check(
  squeezed && squeezed.sidebar === null && squeezed.width >= 380,
  'squeezed to 1000px the session list YIELDS and the thread keeps its minimum (R3, the reason)',
  JSON.stringify(squeezed)
)
// state survives a shell reload: open + browser + width. The reloaded shell lands on Mission (the
// default view), where the panel is not SHOWING and the dock group is not rendered (it is the
// thread header's) — so ⌘2 must OPEN (bring the chat view up with the pane), never close what the
// user cannot see.
await S.send('Page.reload')
await sleep(800)
const onMission = await until(S, `!!document.querySelector('.shell') && !document.querySelector('.side-panel') && !document.querySelector('.dock-group') ? 1 : 0`, 20000)
check(onMission === 1, 'after the reload: Mission is up, no panel showing, no dock group (open is a property of the chat view)')
await S.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })); true`)
const afterReload = await until(S, `(() => { const p = document.querySelector('.layout .side-panel[data-pane="browser"] .browser-hole'); return p ? document.querySelector('.side-panel').getBoundingClientRect().width : null })()`, 20000)
check(typeof afterReload === 'number' && near(afterReload, widthAfter), `the toggle from Mission OPENED the panel on the chat view: browser pane, persisted width (${afterReload})`)
let shownReload = true
for (let i = 0; i < 30 && shownReload !== false; i++) {
  await sleep(150)
  shownReload = await viewHidden()
}
check(shownReload === false, 'the view is sized in the reloaded shell', String(shownReload))
const aliveReload = await V.evaluate(`({ marker: window.__panelMarker })`)
check(aliveReload?.marker === 'panel-' + nonce, 'the page did not reload with the shell', JSON.stringify(aliveReload))
await shot('side-panel-browser')

section('session isolation + hardening')
const ses = await M.evaluate(`(() => { const { session, webContents } = ${E};
  const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(BASE)}));
  const p = wc.getLastWebPreferences ? wc.getLastWebPreferences() : {};
  return { partitioned: wc.session === session.fromPartition('browser-pane'), notDefault: wc.session !== session.defaultSession,
    storagePath: wc.session.storagePath ?? null, isPersistent: wc.session.isPersistent(),
    sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, preload: p.preload || null, webviewTag: p.webviewTag } })()`)
check(ses?.partitioned === true && ses.notDefault === true, "the view's session is the 'browser-pane' partition, not the shell's default session", JSON.stringify(ses))
check(ses?.isPersistent === false && ses.storagePath === null, 'the partition is in-memory (no persist: prefix, no storage path)', JSON.stringify(ses))
check(ses?.sandbox === true && ses.contextIsolation === true && ses.nodeIntegration === false && !ses.preload && ses.webviewTag === false, 'webPreferences: sandbox on, contextIsolation on, nodeIntegration off, no preload, no <webview>', JSON.stringify(ses))
const cookies = await M.evaluate(`(async () => { const { session } = ${E}; const a = await session.fromPartition('browser-pane').cookies.get({ url: ${JSON.stringify(BASE)} }); const b = await session.defaultSession.cookies.get({ url: ${JSON.stringify(BASE)} }); return { view: a.map(c => c.name + '=' + c.value), shell: b.map(c => c.name) } })()`)
check(cookies?.view?.includes(`probe=${nonce}`) && cookies.shell.length === 0, "the site's cookie is in the browser partition and NOT in the shell session", JSON.stringify(cookies))
const inPage = await V.evaluate(`({ req: typeof require, proc: typeof process, beacon: typeof window.beacon, ipc: typeof window.ipcRenderer, electron: typeof window.electron })`)
check(inPage?.req === 'undefined' && inPage.proc === 'undefined' && inPage.beacon === 'undefined' && inPage.ipc === 'undefined', 'INVARIANT: the page has no require/process/window.beacon — no bridge of any kind', JSON.stringify(inPage))

section("csp: the shell's policy does not leak into the page")
const cspInPage = await V.evaluate(`(async () => { try { await document.fonts.load('12px ProbeFont') } catch {} return { inline: window.__inline, font: document.fonts.check('12px ProbeFont'), violations: window.__cspViolations, statuses: Array.from(document.fonts).map(f => f.family + ':' + f.status) } })()`)
check(cspInPage?.inline === 42, "the page's own inline <script> ran (no app CSP on the page)", JSON.stringify(cspInPage))
check(cspInPage?.font === true && (cspInPage.statuses || []).some((s) => /ProbeFont:loaded/.test(s)), 'a data: font in the page loads (the shell CSP font-src question does not apply here)', JSON.stringify(cspInPage))
check(Array.isArray(cspInPage?.violations) && cspInPage.violations.length === 0, 'no securitypolicyviolation in the page', JSON.stringify(cspInPage?.violations))

section('phase 1: permissions denied and said so')
const geoQ = await V.evaluate(`navigator.permissions.query({ name: 'geolocation' }).then(p => p.state, e => 'err:' + e.message)`)
check(geoQ === 'denied', "permissions.query('geolocation') → denied", JSON.stringify(geoQ))
// getCurrentPosition on macOS is gated by the OS location service BEFORE Chromium asks the app;
// Beacon has no location usage string, so the OS never answers and neither does the site's
// callback. Recorded as a note, not asserted: the outcome is "no grant, no prompt", but the pane
// cannot announce a request that never reaches it.
const geo = await V.evaluate(`Promise.race([new Promise(r => navigator.geolocation.getCurrentPosition(() => r('granted'), e => r('denied:' + e.code))), new Promise(r => setTimeout(() => r('no-answer-in-3s'), 3000))])`)
console.log(`note: getCurrentPosition → ${JSON.stringify(geo)} (macOS location service gates this before Chromium asks the app)`)
check(geo !== 'granted', 'getCurrentPosition did not grant')
const notif = await V.evaluate(`Notification.requestPermission()`)
check(notif === 'denied', 'Notification.requestPermission → denied', notif)
const media = await V.evaluate(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', e => 'denied:' + e.name)`)
check(typeof media === 'string' && media.startsWith('denied'), 'getUserMedia → denied', media)
const notices = await until(S, `(() => { const t = Array.from(document.querySelectorAll('.browser-notice')).map(n => n.textContent); return t.some(x => /location/.test(x)) && t.some(x => /notifications/.test(x)) && t.some(x => /camera or microphone/.test(x)) ? t : null })()`)
check(Array.isArray(notices), 'the chrome shows the denials (location, notifications, media)', JSON.stringify(notices) + ' | ' + JSON.stringify(await S.evaluate(`Array.from(document.querySelectorAll('.browser-notice')).map(n => n.textContent)`)))

section('phase 1: downloads blocked')
await V.evaluate(`document.getElementById('dl').click(); true`)
const dlNotice = await until(S, `Array.from(document.querySelectorAll('.browser-notice')).map(n => n.textContent).find(x => /Download blocked/.test(x)) || null`)
check(typeof dlNotice === 'string' && dlNotice.includes(downloadName), 'the chrome says the download was blocked, by name', dlNotice)
await sleep(600)
const landed = existsSync(join(homedir(), 'Downloads', downloadName)) || readdirSync(join(userData)).some((f) => f.includes(downloadName))
check(!landed, 'nothing was written to ~/Downloads or userData')

section('phase 1/4: window.open / target=_blank → a new TAB, never a popup, never the system browser')
await M.evaluate(`(() => { const e = ${E}; global.__opened = []; e.shell.openExternal = (u) => { global.__opened.push(u); return Promise.resolve() }; return true })()`)
const winsBefore = await M.evaluate(`${E}.BrowserWindow.getAllWindows().length`)
const tabsBefore = await S.evaluate(`document.querySelectorAll('.browser-tab').length`)
await V.evaluate(`document.getElementById('popup').click(); true`)
await sleep(700)
await V.evaluate(`document.getElementById('blank').click(); true`)
await sleep(900)
const popup = await M.evaluate(`({ opened: global.__opened, windows: ${E}.BrowserWindow.getAllWindows().length, wcs: ${E}.webContents.getAllWebContents().map(w => w.getURL()).filter(u => u.startsWith(${JSON.stringify(BASE)})) })`)
const tabsAfter = await S.evaluate(`Array.from(document.querySelectorAll('.browser-tab')).map(t => ({ title: t.textContent, active: t.getAttribute('aria-selected') === 'true' }))`)
check(popup?.opened?.length === 0, 'shell.openExternal was NOT called (tabs exist, so the page opens here)', JSON.stringify(popup?.opened))
check(popup?.windows === winsBefore, 'no new BrowserWindow was created', `${popup?.windows} vs ${winsBefore}`)
check(tabsAfter.length === tabsBefore + 2 && tabsAfter[tabsAfter.length - 1].active, 'two new tabs opened (window.open, target=_blank), the last one active', JSON.stringify(tabsAfter))
check(popup?.wcs?.length === 3 && popup.wcs.filter((u) => u === BASE + '/two').length === 2, 'three web contents for the site: the original page and two /two tabs', JSON.stringify(popup?.wcs))
const popupNotice = await S.evaluate(`Array.from(document.querySelectorAll('.browser-notice')).map(n => n.textContent).find(x => /system browser/.test(x)) || null`)
check(popupNotice === null, 'no "system browser" notice (nothing left the app)')
// back to the original page for the rest; the /two tabs go away
for (let k = 0; k < 2; k++) {
  await S.evaluate(`(() => { const active = document.querySelector('.browser-tab[aria-selected="true"] .browser-tab-x'); active.click(); return true })()`)
  await sleep(400)
}
const oneLeft = await until(S, `document.querySelectorAll('.browser-tab').length === 1 && document.querySelector('.browser-tab[aria-selected="true"]') !== null`)
check(oneLeft === true, 'closing both /two tabs leaves the original tab, active')
const wcsAfterClose = await until(M, `(() => { const u = ${E}.webContents.getAllWebContents().map(w => w.getURL()).filter(u => u.startsWith(${JSON.stringify(BASE)})); return u.length === 1 ? u : null })()`)
check(!!wcsAfterClose && wcsAfterClose[0] === BASE + '/', 'the closed tabs\' web contents are gone', JSON.stringify(wcsAfterClose))

section('phase 1: readable error pages')
async function expectError(url, re, label) {
  await navigate(url)
  const head = await until(S, `(() => { const h = document.querySelector('.browser-error-headline'); return h && ${re}.test(h.textContent) ? h.textContent + ' | ' + document.querySelector('.browser-error-code').textContent : null })()`, 15000)
  check(typeof head === 'string', label, head ?? (await S.evaluate(`document.querySelector('.browser-hole')?.innerText.slice(0,200)`)))
  const vis = await viewHidden()
  check(vis === true, `  …and the native view is hidden (zero rect) under the error page`, String(vis))
}
await expectError('http://nonexistent-host-probe.invalid/', '/could not be found/', 'DNS failure → "could not be found"')
await expectError(`http://127.0.0.1:${CLOSED_PORT}/`, '/refused the connection/', 'connection refused → "refused the connection"')
if (HTTPS_BASE) await expectError(HTTPS_BASE + '/', '/certificate problem/', 'self-signed cert → "certificate problem" (no way to proceed)')
const bad = await S.evaluate(`(async () => { const r = await window.beacon.browser.navigate('javascript:alert(1)'); return r })()`)
check(bad?.ok === false && /http/.test(bad.reason), 'javascript: in the URL bar is refused with a reason', JSON.stringify(bad))
const badFile = await S.evaluate(`(async () => { const r = await window.beacon.browser.navigate('file:///etc/hosts'); return r })()`)
check(badFile?.ok === false, 'file: in the URL bar is refused', JSON.stringify(badFile))

section('phase 2: send to chat')
await navigate(BASE + '/')
const V2t = await attach(CDP, (t) => t.type === 'page' && t.url === BASE + '/', 20)
const V2 = V2t ? (V2t.id === viewT.id ? V : await client(V2t.webSocketDebuggerUrl)) : null
if (V2 && V2 !== V) await V2.send('Runtime.enable')
const back = V2 ? await until(V2, `document.readyState === 'complete' && document.title === 'Probe Page'`) : null
check(back === true, 'back on the probe page')
const sendBtn = await S.evaluate(`!!document.querySelector('button[aria-label="Send to chat"]')`)
if (!sendBtn) {
  console.log('note: no "Send to chat" button — phase 2 not built yet; skipping its assertions')
} else {
  // open a chat so a composer exists: the sidebar's New chat → Home composer
  await S.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /new chat/i.test(b.textContent || b.title || '')); if (b) b.click(); return !!b })()`)
  await V2.evaluate(`(() => { const el = document.getElementById('sel'); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return String(s) })()`)
  await S.evaluate(`document.querySelector('button[aria-label="Send to chat"]').click(); true`)
  const composed = await until(S, `(() => { const t = Array.from(document.querySelectorAll('textarea')).find(t => /From the browser/.test(t.value)); return t ? t.value : null })()`)
  check(typeof composed === 'string' && composed.includes(BASE + '/') && composed.includes(`SELECTABLE-${nonce}`) && !composed.includes(`BODY-${nonce}`), 'selection + URL landed in the composer (selection wins over page text)', composed?.slice(0, 200))
  check(typeof composed === 'string' && /Selected text:/.test(composed) && /"""/.test(composed), 'the page text is fenced and labelled as coming from the browser')
  await shot('browser-send-to-chat')
  // clear selection → page text, nav chrome excluded when <main> exists
  await V2.evaluate(`window.getSelection().removeAllRanges(); true`)
  await S.evaluate(`(() => { const t = Array.from(document.querySelectorAll('textarea'))[0]; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await S.evaluate(`document.querySelector('button[aria-label="Send to chat"]').click(); true`)
  const composed2 = await until(S, `(() => { const t = Array.from(document.querySelectorAll('textarea')).find(t => /Page text:/.test(t.value)); return t ? t.value : null })()`)
  check(typeof composed2 === 'string' && composed2.includes(`BODY-${nonce}`) && !composed2.includes('NAV-CHROME-TEXT'), 'with no selection, the readable (<main>) text lands — nav chrome excluded', composed2?.slice(0, 200))
  // and NOTHING was sent: the outbox/optimistic rows are untouched — no user bubble with the text
  const sent = await S.evaluate(`Array.from(document.querySelectorAll('.message, .bubble, [class*="msg"]')).some(m => /From the browser/.test(m.textContent))`)
  check(sent === false, 'nothing was sent — the text sits in the composer only')
}

section('phase 3: pop-out — the same web contents move, nothing reloads')
const popBtn = await S.evaluate(`!!document.querySelector('button[aria-label="Pop out browser"]')`)
if (!popBtn) {
  console.log('note: no pop-out button — phase 3 not built yet; skipping its assertions')
} else {
  // a marker only a NON-reloaded page keeps, plus its history length
  const before = await V2.evaluate(`(window.__probeMarker = 'alive-' + ${JSON.stringify(nonce)}, { len: history.length, marker: window.__probeMarker })`)
  await S.evaluate(`document.querySelector('button[aria-label="Pop out browser"]').click(); true`)
  const popT = await attach(CDP, (t) => t.type === 'page' && t.url.includes('#browser'), 30)
  check(!!popT, 'a pop-out window (renderer #browser) appeared', popT?.url)
  const P = popT ? await client(popT.webSocketDebuggerUrl) : null
  if (P) await P.send('Runtime.enable')
  const popPane = P ? await until(P, `!!document.querySelector('.browser-pane.is-popout .browser-hole')`, 10000) : null
  check(popPane === true, 'the pop-out renders the pane chrome with a hole')
  const moved = await until(M, `(() => { const { BrowserWindow } = ${E}; const wins = BrowserWindow.getAllWindows(); const pop = wins.find(w => w.getTitle() === 'Beacon Browser'); const main = wins.find(w => w.getTitle() === 'Beacon'); if (!pop) return null; const inPop = pop.contentView.children.some(v => v.webContents && v.webContents.getURL().startsWith(${JSON.stringify(BASE)})); const inMain = main.contentView.children.some(v => v.webContents && v.webContents.getURL().startsWith(${JSON.stringify(BASE)})); const v = pop.contentView.children.find(v => v.webContents); return inPop && !inMain && v && v.getBounds().width > 100 ? { inPop, inMain, bounds: v.getBounds(), popBounds: pop.getBounds() } : null })()`, 10000)
  check(!!moved, 'the view now lives in the pop-out window and is sized there (not in the main window)', JSON.stringify(moved))
  const after = await V2.evaluate(`({ len: history.length, marker: window.__probeMarker, inline: window.__inline })`)
  check(after?.marker === before?.marker && after.len === before.len && after.inline === 42, 'NO reload: the page kept its JS state and history length', JSON.stringify({ before, after }))
  const dockState = await until(S, `!!document.querySelector('[data-testid="browser-detached"]')`)
  check(dockState === true, 'the dock shows the "popped out" placeholder with Reattach')
  // send to chat FROM the pop-out → routed to the main window's composer
  if (P) {
    await V2.evaluate(`(() => { const el = document.getElementById('sel'); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return String(s) })()`)
    await S.evaluate(`(() => { const t = Array.from(document.querySelectorAll('textarea'))[0]; if (!t) return false; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await P.evaluate(`document.querySelector('button[aria-label="Send to chat"]').click(); true`)
    const routed = await until(S, `(() => { const t = Array.from(document.querySelectorAll('textarea')).find(t => /From the browser/.test(t.value)); return t ? t.value : null })()`)
    check(typeof routed === 'string' && routed.includes(`SELECTABLE-${nonce}`), 'Send to chat from the pop-out lands in the MAIN window composer', routed?.slice(0, 120))
  }
  // reattach via the dock's button
  await S.evaluate(`document.querySelector('[data-testid="browser-detached"] button').click(); true`)
  const back = await until(M, `(() => { const { BrowserWindow } = ${E}; const wins = BrowserWindow.getAllWindows(); const pop = wins.find(w => w.getTitle() === 'Beacon Browser'); const main = wins.find(w => w.getTitle() === 'Beacon'); const inMain = main.contentView.children.some(v => v.webContents && v.webContents.getURL().startsWith(${JSON.stringify(BASE)})); const inPop = !!pop && pop.contentView.children.some(v => v.webContents && v.webContents.getURL().startsWith(${JSON.stringify(BASE)})); return (!pop || !pop.isVisible()) && inMain && !inPop ? { windows: wins.length, popHidden: !!pop && !pop.isVisible() } : null })()`, 10000)
  check(!!back, 'Reattach: the pop-out window is hidden and the view is back in the main window', JSON.stringify(back))
  const alive = await V2.evaluate(`({ marker: window.__probeMarker, title: document.title })`)
  check(alive?.marker === before?.marker && alive.title === 'Probe Page', 'the page survived the round trip without a reload', JSON.stringify(alive))
  // detach again, then CLOSE the pop-out window (red button path) → must reattach, not lose the page
  await S.evaluate(`document.querySelector('button[aria-label="Pop out browser"]').click(); true`)
  const popAgain = await until(M, `(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); return pop ? pop.getBounds() : null })()`, 10000)
  check(!!popAgain, 'detached a second time', JSON.stringify(popAgain))
  // bounds remembered: move the pop-out, close it, reopen — it must come back where it was
  await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); pop.setBounds({ x: 120, y: 140, width: 900, height: 640 }); return true })()`)
  await sleep(800) // trackWindowState debounce (300ms) + write
  await M.evaluate(`(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); pop.close(); return true })()`)
  const closedBack = await until(M, `(() => { const { BrowserWindow } = ${E}; const wins = BrowserWindow.getAllWindows(); const pop = wins.find(w => w.getTitle() === 'Beacon Browser'); const main = wins.find(w => w.getTitle() === 'Beacon'); const inMain = main.contentView.children.some(v => v.webContents && v.webContents.getURL().startsWith(${JSON.stringify(BASE)})); return (!pop || !pop.isVisible()) && inMain })()`, 10000)
  check(closedBack === true, 'closing the pop-out window reattaches (the page is not lost with the frame)')
  const alive2 = await V2.evaluate(`({ marker: window.__probeMarker })`)
  check(alive2?.marker === before?.marker, 'page still alive after the close path', JSON.stringify(alive2))
  await S.evaluate(`document.querySelector('button[aria-label="Pop out browser"]').click(); true`)
  const reopened = await until(M, `(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); if (!pop || !pop.isVisible()) return null; const b = pop.getBounds(); return Math.abs(b.x - 120) <= 2 && Math.abs(b.y - 140) <= 2 && b.width === 900 && b.height === 640 ? b : { wrong: b } })()`, 10000)
  check(!!reopened && !reopened.wrong, 'the pop-out reopened at its remembered bounds', JSON.stringify(reopened))
  check(existsSync(join(userData, 'browser-window-state.json')), 'browser-window-state.json was written under userData')
  await P?.ws.close()
  // leave it attached for the remaining checks
  await S.evaluate(`document.querySelector('[data-testid="browser-detached"] button').click(); true`)
  await until(M, `(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); return !pop || !pop.isVisible() })()`, 10000)
}

section('phase 4: tabs — new, switch, reorder, close')
const plus = await S.evaluate(`!!document.querySelector('button[aria-label="New tab"]')`)
if (!plus) {
  console.log('note: no tab strip — phase 4 not built yet; skipping')
} else {
  await S.evaluate(`document.querySelector('button[aria-label="New tab"]').click(); true`)
  const two = await until(S, `document.querySelectorAll('.browser-tab').length === 2 && document.querySelectorAll('.browser-tab')[1].getAttribute('aria-selected') === 'true'`)
  check(two === true, 'a new empty tab opens and becomes active')
  const focused = await until(S, `document.activeElement === document.querySelector('.browser-url')`, 3000)
  check(focused === true, 'the URL bar takes focus for the new tab', String(focused))
  await navigate(BASE + '/two')
  const twoT = await attach(CDP, (t) => t.type === 'page' && t.url === BASE + '/two', 20)
  check(!!twoT, 'the new tab loaded /two', twoT?.url)
  const activeIsTwo = await until(M, `(() => { const { BrowserWindow } = ${E}; const main = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const kids = main.contentView.children.filter(v => v.webContents); return kids.length === 1 && kids[0].webContents.getURL() === ${JSON.stringify(BASE + '/two')} && kids[0].getBounds().width > 100 ? kids[0].webContents.getURL() : null })()`)
  check(!!activeIsTwo, 'exactly one view is attached to the window — the active tab (/two), sized')
  const firstAlive = await V2.evaluate(`({ marker: window.__probeMarker, title: document.title })`)
  check(firstAlive?.title === 'Probe Page', 'the background tab is alive (its page still answers)', JSON.stringify(firstAlive))
  // switch back by clicking the first tab
  await S.evaluate(`document.querySelectorAll('.browser-tab')[0].click(); true`)
  const backToOne = await until(M, `(() => { const { BrowserWindow } = ${E}; const main = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon'); const kids = main.contentView.children.filter(v => v.webContents); return kids.length === 1 && kids[0].webContents.getURL() === ${JSON.stringify(BASE + '/')} })()`)
  check(backToOne === true, 'selecting the first tab swaps the attached view back')
  const urlBar = await until(S, `document.querySelector('.browser-url').value === ${JSON.stringify(BASE + '/')}`)
  check(urlBar === true, 'the URL bar follows the active tab')
  // reorder: drag tab 1 (/two) onto tab 0 with real DragEvents
  const reordered = await S.evaluate(`(() => { const tabs = document.querySelectorAll('.browser-tab'); const src = tabs[1], dst = tabs[0]; const dt = new DataTransfer(); src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true })()`)
  const order = reordered ? await until(S, `(() => { const t = Array.from(document.querySelectorAll('.browser-tab')).map(x => x.title); return t[0] === ${JSON.stringify(BASE + '/two')} && t[1] === ${JSON.stringify(BASE + '/')} ? t : null })()`) : null
  check(Array.isArray(order), 'drag-and-drop reorders the strip (/two first)', JSON.stringify(order))
  const stillActive = await S.evaluate(`document.querySelector('.browser-tab[aria-selected="true"]').title`)
  check(stillActive === BASE + '/', 'reordering does not change which tab is active')
  // close the /two tab (now first) via its ×
  await S.evaluate(`document.querySelectorAll('.browser-tab')[0].querySelector('.browser-tab-x').click(); true`)
  const closed = await until(M, `(() => { const u = ${E}.webContents.getAllWebContents().map(w => w.getURL()).filter(u => u.startsWith(${JSON.stringify(BASE)})); return u.length === 1 && u[0] === ${JSON.stringify(BASE + '/')} })()`)
  check(closed === true, 'closing a background tab destroys its web contents and leaves the active one')
  const one = await S.evaluate(`document.querySelectorAll('.browser-tab').length`)
  check(one === 1, 'one tab left in the strip', String(one))
}

section('invariant at runtime: a hostile page')
const hostile = await V2.evaluate(`(() => { const out = {}; try { out.top = window.top === window } catch (e) { out.top = 'x:' + e.name }; try { out.opener = window.opener } catch (e) { out.opener = 'x' }; out.beacon = typeof window.beacon; out.postMessage = typeof window.parent.postMessage; return out })()`)
check(hostile?.top === true && (hostile.opener === null || hostile.opener === undefined) && hostile.beacon === 'undefined', 'the page is top-level, has no opener, and no bridge', JSON.stringify(hostile))
const noInject = await M.evaluate(`(() => { const s = ${R}('fs').readFileSync(${JSON.stringify(PACKAGED ? join(BUNDLE, 'Contents/Resources/app.asar/out/main/index.js') : join(REPO, 'out/main/index.js'))}, 'utf8'); return { execJs: (s.match(/\\.executeJavaScript\\(/g) || []).length, isolated: (s.match(/executeJavaScriptInIsolatedWorld\\(/g) || []).length, sendInput: (s.match(/sendInputEvent\\(/g) || []).length, insertCSS: (s.match(/insertCSS\\(/g) || []).length } })()`)
check(noInject?.execJs === 0 && noInject.sendInput === 0 && noInject.insertCSS === 0 && noInject.isolated === 1, 'the built main has no executeJavaScript / sendInputEvent / insertCSS; exactly one isolated-world extraction', JSON.stringify(noInject))

section('result')
if (failures) console.log('app log tail:\n' + log.join('').slice(-1500))
const mainErrors = log.join('').split('\n').filter((l) => /\[browser\]|Refused|CSP|Error:/i.test(l)).slice(0, 12)
if (mainErrors.length) console.log('main log lines of interest:\n  ' + mainErrors.join('\n  '))
console.log(`\n${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} — browser-pane probe (${PACKAGED ? 'PACKAGED ' + BUNDLE : 'repo build'})`)
reap()
site.close()
process.exit(failures ? 1 : 0)
