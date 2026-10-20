// pane-link-probe — does clicking a LOCAL link in chat actually open the browser pane, and ONLY then?
//
// WHY THIS EXISTS. smoke:pane-link pins the decision (which hosts are local, which clicks count) and
// the source wiring; browser-invariant-smoke R9 pins that nothing else can reach the pane. Neither
// can say that a real click in the real app lands a real page in the real pane — or that the cases
// that must NOT open it still don't. This drives the built app and answers both halves, one
// observable per claim:
//
//   - nothing happens when the message ARRIVES (the pane has no tabs while a local link sits there);
//   - a script-dispatched click (isTrusted false) does NOT open it — the line that makes "an agent
//     cannot" true — checked with a real DOM `.click()`, not assumed;
//   - a TRUSTED plain click on a public link does not, and keeps its default (the system browser);
//   - a trusted ⌘-click on a local link does not (the escape hatch);
//   - a trusted plain click on a local link DOES: the pane gets a tab at that URL, the page loads
//     (its <title> comes back through the pane's own state), the local server saw the request, the
//     link's default was stopped (so the system browser did NOT also open), and the dock shows the
//     browser pane;
//   - a second local link navigates the SAME tab (no pile of tabs).
//
// THE TRUSTED CLICK. A page cannot mint one: `el.click()` / dispatchEvent give isTrusted false. CDP
// Input.dispatchMouseEvent goes through the browser's own input path and gives true, so that is what
// stands in for a person's mouse. The untrusted case uses the plain DOM call on purpose.
//
// NO SYSTEM BROWSER GETS LAUNCHED. A click whose default is not prevented would reach
// shell.openExternal and open the real browser on the machine running this probe. A document-level
// BUBBLE listener — which runs after React's root handler, so it reads the verdict React's handler
// reached — records `defaultPrevented` and then prevents the default itself. The probe therefore
// sees what Beacon decided without ever acting on the "open the system browser" outcome.
//
// Run: npm run build && node scripts/pane-link-probe.mjs
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
const SESSION = 'desktop:pane-link-probe'
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
      session_id: SESSION, gateway: 'desktop', title: 'link probe', created_at: nowS - 60,
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
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-pane-link-probe-'))
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
  console.log('NEVER REACHED THE MAIN VIEW (nav rail absent) — main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
check(true, 'main view is up (nav rail present)')

check(await clickButton('Chats'), '[drive] opened the Chats surface')
const selected = await until(`(() => {
  for (const h of document.querySelectorAll('button.session-group-head[aria-expanded="false"]')) h.click()
  const rows = [...document.querySelectorAll('button.session-row')].filter((b) => b.offsetParent !== null)
  const hit = rows.find((b) => (b.textContent ?? '').includes('link probe')) ?? rows[0]
  if (!hit) return null
  hit.click()
  return true
})()`, 20000)
check(Boolean(selected), '[drive] selected the stub session')

const linksUp = await until(`document.querySelectorAll('.md-body a').length >= 3 ? document.querySelectorAll('.md-body a').length : null`)
if (!linksUp) {
  console.log('NEVER RENDERED the three links — ' + (await evaluate(`document.body.innerText.slice(0, 300)`)))
  console.log('main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
console.log(`[probe] rendered ${linksUp} links`)

// Record every anchor click AFTER React has handled it, then stop the default ourselves so the
// system browser is never launched by this probe (see the header).
await evaluate(`(() => {
  window.__clicks = []
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null
    if (!a) return
    window.__clicks.push({ href: a.getAttribute('href'), prevented: e.defaultPrevented, trusted: e.isTrusted, meta: e.metaKey })
    e.preventDefault()
  }, false)
  return true
})()`)
const LOCAL = `.md-body a[href="${PAGE_URL}"]`
const OTHER = `.md-body a[href="${OTHER_URL}"]`
const PUBLIC = `.md-body a[href="${PUBLIC_URL}"]`

// ── nothing on arrival ───────────────────────────────────────────────────────────────────
// A settle period first: an arrival-time navigation would be a race, and a probe that checks
// instantly would pass it. Three links are on screen and have been for the whole boot.
await sleep(1500)
const t0 = await tabs()
check(Array.isArray(t0) && t0.length === 0, `the pane has NO tab while local links sit in a message (${JSON.stringify(t0)}) — nothing happens on arrival`)
check(!LINK_HITS.length, 'and the local server has not been touched')

// ── an untrusted click ───────────────────────────────────────────────────────────────────
await evaluate(`document.querySelector(${JSON.stringify(LOCAL)}).click()`)
await sleep(800)
let c = await clicks()
check(c.length === 1 && c[0].trusted === false, `[drive] a script-dispatched click on the local link ran (isTrusted=${c[0]?.trusted})`)
check(c[0] && c[0].prevented === false, 'it was NOT intercepted — an untrusted click leaves the default alone')
check((await tabs()).length === 0 && !LINK_HITS.length, 'and the pane stayed empty: script can click a link, it cannot open the pane')

// ── trusted, but public ──────────────────────────────────────────────────────────────────
check(await realClick(PUBLIC), '[drive] a real click on the PUBLIC link')
await sleep(800)
c = await clicks()
check(c.length === 2 && c[1].trusted === true && c[1].prevented === false, `a trusted plain click on a public link is left to the system browser (trusted=${c[1]?.trusted}, prevented=${c[1]?.prevented})`)
check((await tabs()).length === 0, 'and the pane stayed empty')

// ── trusted, local, but with ⌘ held ──────────────────────────────────────────────────────
check(await realClick(LOCAL, { modifiers: 4 }), '[drive] a real ⌘-click on the LOCAL link')
await sleep(800)
c = await clicks()
check(c.length === 3 && c[2].trusted === true && c[2].meta === true && c[2].prevented === false, `⌘-click keeps the old behaviour: system browser (meta=${c[2]?.meta}, prevented=${c[2]?.prevented})`)
check((await tabs()).length === 0 && !LINK_HITS.length, 'and the pane stayed empty, the local server untouched')

// ── trusted, local, plain: the case this exists for ──────────────────────────────────────
check(await realClick(LOCAL), '[drive] a real plain click on the LOCAL link')
const opened = await until(`window.beacon.browser.state().then((s) => { const t = s.tabs[0]; return t && t.title === 'pane link probe page' ? { n: s.tabs.length, url: t.url, title: t.title, host: s.host } : null })`, 15000)
check(opened !== null, 'the pane opened a tab and the page LOADED (its own <title> came back through the pane state)')
if (opened) {
  check(opened.url === PAGE_URL, `at exactly the link's URL (${opened.url})`)
  check(opened.n === 1, 'one tab')
}
c = await clicks()
check(c.length === 4 && c[3].trusted === true && c[3].prevented === true, `React stopped the link's default, so the system browser did NOT also open (prevented=${c[3]?.prevented})`)
check(LINK_HITS.includes('GET /page'), 'the local server saw the pane\'s request for /page')
const dock = await evaluate(`document.body.innerText.includes('BROWSER') ? true : null`)
check(dock === true, 'the dock is showing the browser pane (its header is on screen)')

// ── a second local link navigates the SAME tab ───────────────────────────────────────────
check(await realClick(OTHER), '[drive] a real plain click on the second local link')
const moved = await until(`window.beacon.browser.state().then((s) => { const t = s.tabs[0]; return t && t.title === 'pane link probe other' ? { n: s.tabs.length, url: t.url } : null })`, 15000)
check(moved !== null && moved.n === 1 && moved.url === OTHER_URL, `it navigated the same tab, no pile of tabs (${moved ? moved.n + ' tab, ' + moved.url : 'no move'})`)

const bad = PAGE_ERRORS.filter((e) => /Content Security Policy|Refused to|will-navigate/i.test(e))
check(bad.length === 0, `no CSP or navigation error on the shell page${bad.length ? ': ' + bad[0].slice(0, 160) : ''}`)
const refused = mainLog.join('').match(/refused will-navigate[^\n]*/g)
check(!refused, `main refused no navigation of the shell page${refused ? ': ' + refused[0] : ''}`)

console.log('')
console.log(`[probe] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (nothing on arrival, untrusted refused, public + ⌘ left alone, local plain click opens the pane and loads the page)`)
await reapAndExit(failures === 0 ? 0 : 1)
