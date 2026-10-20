// dock-fit-probe — does every dock pane, and every rail view, actually FIT inside the window?
//
// WHY THIS EXISTS. `.side-panel` was `height: 100vh`, but it sits in a `.layout` that is sized
// AROUND the 38px window chrome (#root stacks the chrome above the app; .shell, .view-area and
// .layout all shrink to what is left). A 100vh child of a row that is vh-38 tall overshoots by
// exactly the chrome, and `.view-area { overflow: hidden }` clips it: every dock pane — inspector,
// browser, terminal — lost its bottom 38px. The terminal's refusal bar, anchored to the pane's
// bottom, was cut off mid-word, taking the one sentence that said how to fix the refusal with it;
// a web page lost the last 38px of its viewport, and a long preview its tail. The memory note from
// 2026-09-18 had flagged it ("if anything looks 38px off") and nothing measured it.
//
// No smoke can see this: it is a layout fact about a real window, not a property of the source.
// So this opens each pane with its real shortcut and measures: the dock's bottom edge must not
// pass the view area's, and the dock must be exactly as tall as the row it sits in.
//
// Run: npm run build && node scripts/dock-fit-probe.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (ok, what) => {
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

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

// ── the page a local link points at ──────────────────────────────────────────────────────
// A real local web server, on loopback, standing in for "the page the agent served". The pane
// loads it for real, so its <title> coming back through the pane state is proof of a load.
const LINK_HITS = []
const linkSite = createServer((req, res) => {
  LINK_HITS.push(`${req.method} ${req.url}`)
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${body}</h1></body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (req.url === '/page') return res.end(page('pane link probe page', 'the served page'))
  if (req.url === '/other') return res.end(page('pane link probe other', 'the second page'))
  res.end(page('pane link probe 404', 'unexpected'))
})
await new Promise((r) => linkSite.listen(0, '127.0.0.1', r))
const LINK_PORT = linkSite.address().port
const PAGE_URL = `http://127.0.0.1:${LINK_PORT}/page`
const OTHER_URL = `http://127.0.0.1:${LINK_PORT}/other`
const PUBLIC_URL = 'https://example.com/docs'

// ── the stub gateway ───────────────────────────────────────────────────────────────────
const SESSION = 'desktop:dock-fit-probe'
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const site = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url === '/api/artifacts') return json(res, 200, { artifacts: [] })
  if (url.startsWith('/api/sessions/') && url.includes('/messages')) {
    const text = `Served it for you: [the table](${PAGE_URL}). The docs are at [the docs](${PUBLIC_URL}). A second page: [the other one](${OTHER_URL}).`
    return json(res, 200, {
      watermark: 1,
      messages: [{
        message_id: 1, ordinal: 0, session_id: SESSION, role: 'assistant', content: text,
        content_json: null, provenance: 'user', is_trusted: true, client_msg_id: null,
        timestamp: Math.floor(Date.now() / 1000)
      }]
    })
  }
  if (url.startsWith('/api/sessions')) {
    const nowS = Math.floor(Date.now() / 1000)
    return json(res, 200, [{
      session_id: SESSION, gateway: 'desktop', title: 'dock probe', created_at: nowS - 60,
      last_active: nowS - 60, message_count: 1, watermark: 0
    }])
  }
  json(res, 404, { detail: 'not stubbed: ' + url })
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port

// The WS must SETTLE at connected (a churning socket remounts MainView mid-drive).
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (sock) => {
  try { sock.send(JSON.stringify({ type: 'connected' })) } catch { /* closing */ }
  sock.on('error', () => undefined)
})
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))
const WS_PORT = wsSite.address().port

// ── launch the real built app ────────────────────────────────────────────────────────────
// Own instance, own --user-data-dir, ALLOCATED debugging port (never derived from a pid: a stale
// Electron on a computed port answers /json/list and the probe happily drives the wrong build).
const { createServer: netServer } = await import('node:net')
const CDP_PORT = await new Promise((res, rej) => {
  const srv = netServer()
  srv.on('error', rej)
  srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)) })
})
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-dock-fit-probe-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: {
    ...process.env,
    BEACON_GATEWAY_HOST: '127.0.0.1',
    BEACON_GATEWAY_API_PORT: String(API_PORT),
    BEACON_GATEWAY_WS_PORT: String(WS_PORT)
  }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
const closeStubs = () => { for (const s of [wss, wsSite, site, linkSite]) { try { s.close() } catch { /* gone */ } } }
async function reapAndExit(code) {
  reap(); closeStubs()
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) process.exit(code)
    await sleep(100)
  }
  killGroup('SIGKILL'); await sleep(300); process.exit(code)
}
process.on('exit', reap)
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })

// IDENTITY BEFORE ATTACH: wait for OUR port in OUR child's own stderr.
let announced = null
for (let i = 0; i < 80 && !announced; i++) {
  await sleep(250)
  const m = mainLog.join('').match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${CDP_PORT}/[^\\s]+)`))
  if (m) announced = m[1]
  if (child.exitCode !== null || child.signalCode !== null) break
}
if (!announced) {
  console.log(`NEVER SAW OUR OWN DEVTOOLS ENDPOINT on port ${CDP_PORT} — main log tail:\n` + mainLog.join('').slice(-2000))
  await reapAndExit(2)
}
console.log(`[probe] attached identity confirmed: ${announced.slice(0, 60)}…`)

let page = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
    if (page) break
  } catch { /* not up yet */ }
  await sleep(500)
}
if (!page) {
  console.log('NO PAGE TARGET — main log tail:\n' + mainLog.join('').slice(-2000))
  await reapAndExit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const PAGE_ERRORS = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') PAGE_ERRORS.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception')
})
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => {
  const i = ++msgId
  const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: { message: `timeout after 25s: ${method}` } }) } }, 25000)
  pending.set(i, (m) => { clearTimeout(timer); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
await send('Runtime.enable')
await send('Page.enable')
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.error) return { __error: r.error.message }
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
  return r.result?.result?.value
}
async function until(expr, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evaluate(expr)
    if (v && !v.__error) return v
    await sleep(250)
  }
  return null
}
const clickButton = (text) => evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled)
  const hit = btns.find((b) => (b.textContent ?? '').trim().includes(${JSON.stringify(text)}))
  if (!hit) return false
  hit.click()
  return true
})()`)

// A TRUSTED click at an element's centre, through CDP's input path. `modifiers`: Alt 1, Ctrl 2, Meta 4, Shift 8.
async function realClick(selector, { modifiers = 0 } = {}) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!rect || rect.__error) return false
  await send('Page.bringToFront')
  const at = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...at })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at })
  return true
}
const clicks = () => evaluate('window.__clicks')
const tabs = () => evaluate('window.beacon.browser.state().then((s) => s.tabs.map((t) => ({ url: t.url, title: t.title })))')

console.log('[probe] waiting for the app to reach its main view…')
const booted = await until(`document.querySelector('[aria-label="Views"]') ? true : null`, 40000)
if (!booted) {
  console.log('NEVER REACHED THE MAIN VIEW — main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
check(true, 'main view is up (nav rail present)')
check(await clickButton('Chats'), '[drive] opened the Chats surface')
const selected = await until(`(() => {
  for (const h of document.querySelectorAll('button.session-group-head[aria-expanded="false"]')) h.click()
  const rows = [...document.querySelectorAll('button.session-row')].filter((b) => b.offsetParent !== null)
  const hit = rows.find((b) => (b.textContent ?? '').includes('dock probe')) ?? rows[0]
  if (!hit) return null
  hit.click()
  return true
})()`, 20000)
check(Boolean(selected), '[drive] selected the stub session')
await sleep(1500)

// The dock's chords are toggles, but pressing one for a DIFFERENT pane switches to it, so ⌘2, ⌘3, ⌘1
// in turn never closes anything. (Meta = 4.)
async function chord(key) {
  await send('Page.bringToFront')
  const code = 'Digit' + key
  const base = { key, code, modifiers: 4, windowsVirtualKeyCode: 48 + Number(key), nativeVirtualKeyCode: 48 + Number(key) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const measure = () => evaluate(`(() => {
  const r = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null }
  const sp = r('.side-panel'), body = r('.side-panel-body'), va = r('.view-area'), ly = r('.layout')
  if (!sp || !va || !ly) return null
  const head = document.querySelector('.side-panel-head')
  return {
    pane: head ? head.innerText.replace(/\\s+/g, ' ').slice(0, 30) : '',
    dockTop: Math.round(sp.top), dockBottom: Math.round(sp.bottom), dockHeight: Math.round(sp.height),
    bodyBottom: body ? Math.round(body.bottom) : null,
    areaBottom: Math.round(va.bottom), layoutHeight: Math.round(ly.height), viewport: document.documentElement.clientHeight
  }
})()`)

for (const [key, name] of [['2', 'browser'], ['3', 'terminal'], ['1', 'inspector']]) {
  await chord(key)
  const m = await until(`(() => {
    const h = document.querySelector('.side-panel-head')
    return h && h.innerText.toLowerCase().includes(${JSON.stringify(name)}) ? true : null
  })()`, 8000)
  check(m !== null, `[drive] ⌘${key} showed the ${name} pane`)
  await sleep(400)
  const g = await measure()
  check(g !== null, `${name}: the dock and the view area were measurable`)
  if (!g) continue
  console.log(`[probe] ${name}: dock ${g.dockTop}→${g.dockBottom} (${g.dockHeight}px) · view area ends ${g.areaBottom} · layout ${g.layoutHeight}px · viewport ${g.viewport}`)
  check(g.dockBottom <= g.areaBottom, `${name}: the dock does not pass the bottom of the view area (${g.dockBottom} vs ${g.areaBottom}) — nothing in it is clipped`)
  check(g.dockHeight === g.layoutHeight, `${name}: the dock is exactly as tall as the row it sits in (${g.dockHeight} vs ${g.layoutHeight})`)
  check(g.bodyBottom === null || g.bodyBottom <= g.areaBottom, `${name}: the pane body ends inside the window (${g.bodyBottom} vs ${g.areaBottom})`)
}

// ── every rail view, not just the dock ───────────────────────────────────────────────────
// `.surface` (Mission, Coding, Workspace, Activity, Config) had the same `height: 100vh`. A view
// area's direct children must end where it ends — and so must the topmost box inside them that
// passes it, unless a scroll container between them takes the overflow on purpose.
for (const n of ['Mission', 'Chats', 'Coding', 'Workspace', 'Activity', 'Config']) {
  const clicked = await evaluate(`(() => { const nav = document.querySelector('[aria-label="Views"]'); const b = [...nav.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(${JSON.stringify(n)})); if (!b) return false; b.click(); return true })()`)
  check(clicked === true, `[drive] opened ${n}`)
  await sleep(900)
  const over = await evaluate(`(() => {
    const va = document.querySelector('.view-area'); if (!va) return null
    const lim = va.getBoundingClientRect().bottom + 1
    const scrolls = (el) => { const o = getComputedStyle(el).overflowY; return o === 'auto' || o === 'scroll' || o === 'hidden' }
    const out = []
    for (const el of va.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.height === 0 || r.bottom <= lim) continue
      const p = el.parentElement
      if (p && p !== va && p.getBoundingClientRect().bottom > lim) continue // only the topmost offender
      // inside a scroll container that itself ends in view: overflow is the point, not a defect
      let inScroll = false
      for (let q = p; q && q !== va; q = q.parentElement) if (scrolls(q) && q.getBoundingClientRect().bottom <= lim) { inScroll = true; break }
      if (!inScroll) out.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' +' + Math.round(r.bottom - lim + 1))
    }
    return out.slice(0, 6)
  })()`)
  check(Array.isArray(over) && over.length === 0, `${n}: nothing in the view passes the bottom of the view area${Array.isArray(over) && over.length ? ' — ' + over.join(' | ') : ''}`)
}

console.log('')
console.log(`[probe] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (every dock pane and every rail view fits inside the window)`)
await reapAndExit(failures === 0 ? 0 : 1)
