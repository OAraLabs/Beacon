// artifact-view-probe — does the View button on a chat chip actually SHOW the page, sandboxed?
//
// WHY THIS EXISTS. smoke:artifacts pins the model (which kinds are renderable, that the chip and
// the Artifacts panel share one target builder, that the chip never names the browser pane). It
// cannot pin what only the real app can answer: that a click on View lands a live document in the
// dock's inspector pane, that the page's own inline script RUNS there, that the sandbox and the
// protocol's CSP still hold it (its attempt to reach the network never leaves the page), and that
// the browser pane — the human-driven one — was never touched. Those are four separate ways a
// green smoke can sit beside a dead or an unsafe button.
//
// THE FIXTURES, each a different question:
//   compare.html   a self-contained page whose script (a) rewrites its own DOM and (b) tries to
//                  fetch() the stub. (a) proves it executed; (b) must be blocked by connect-src
//                  'none' BEFORE a request is sent, so the stub's hit log is the evidence.
//   diagram.svg    the second renderable kind — must decode as an <img>, not execute.
//   ghost.html     listed in the manifest, bytes 404 — View must fail VISIBLY on the button and
//                  open nothing (a pane that quietly never opens reads as a dead button).
//   notes.md       text, NOT renderable — must have no View button.
//   report.docx    binary — must have no View button.
//
// WHY A STUB GATEWAY. Same reason as artifact-thumb-probe: the real outbox is whatever happens to
// be on the daemon; the stub makes the fixtures the fixtures, every run.
//
// Run: npm run build && node scripts/artifact-view-probe.mjs
//      PROBE_SHOT=<png> saves a screenshot of the rendered pane for a person to look at.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

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

// ── fixtures ───────────────────────────────────────────────────────────────────────────
const cid = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
// bytes are filled after the stub is listening: the page needs the stub's port to aim its fetch.
const FIX = {
  html: { name: 'compare.html', mime: 'text/html', bytes: null },
  svg: {
    name: 'diagram.svg',
    mime: 'image/svg+xml',
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c33"/></svg>')
  },
  ghost: { name: 'ghost.html', mime: 'text/html', bytes: null, missing: true },
  md: { name: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# notes\n') },
  doc: {
    name: 'report.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer.from('UEsDBBQAAAAIAA==', 'base64')
  }
}
FIX.ghost.id = cid(Buffer.from('ghost'))
for (const f of [FIX.svg, FIX.md, FIX.doc]) f.id = cid(f.bytes)

const SESSION = 'desktop:artifact-view-probe'
const HITS = []
const BYTES = {}
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const site = createServer((req, res) => {
  const url = req.url ?? ''
  HITS.push(`${req.method} ${url.split('?')[0]}`)
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url === '/api/artifacts') {
    const now = Date.now() / 1000
    return json(res, 200, {
      artifacts: Object.values(FIX).map((f, i) => ({
        id: f.id, name: f.name, path: f.name, size: f.bytes ? f.bytes.length : 10, mtime: now - i, mime: f.mime
      }))
    })
  }
  const m = url.match(/^\/api\/artifacts\/([0-9a-f]{16})/)
  if (m) {
    const b = BYTES[m[1]]
    if (!b) return json(res, 404, { error: 'unknown artifact id' })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length })
    return res.end(b)
  }
  if (url.startsWith('/api/sessions/') && url.includes('/messages')) {
    const text = Object.values(FIX).map((f) => `Published ${f.name}.`).join(' ')
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
      session_id: SESSION, gateway: 'desktop', title: 'view probe', created_at: nowS - 60,
      last_active: nowS - 60, message_count: 1, watermark: 0
    }])
  }
  json(res, 404, { detail: 'not stubbed: ' + url })
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port

FIX.html.bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>probe page</title>
<style>body{font-family:sans-serif;margin:16px} th{position:sticky;top:0;background:#eee} td,th{border:1px solid #999;padding:4px 8px}</style></head>
<body><h1 id="h">Agent comparison</h1>
<table><tr><th>Product</th><th>Loop</th></tr><tr><td>OpenClaw</td><td>300s</td></tr></table>
<p id="js">js:pending</p><p id="net">net:pending</p>
<script>
document.getElementById('js').textContent = 'js:ran';
fetch('http://127.0.0.1:${API_PORT}/beacon-pwn')
  .then(function () { document.getElementById('net').textContent = 'net:LEAKED' })
  .catch(function () { document.getElementById('net').textContent = 'net:blocked' })
</script></body></html>`)
FIX.html.id = cid(FIX.html.bytes)
for (const f of Object.values(FIX)) if (f.bytes && !f.missing) BYTES[f.id] = f.bytes
console.log('[probe] fixtures: ' + Object.entries(FIX).map(([k, v]) => `${k}=${v.id}`).join(' '))

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
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-view-probe-'))
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
const closeStubs = () => { for (const s of [wss, wsSite, site]) { try { s.close() } catch { /* gone */ } } }
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
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++msgId
  const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: { message: `timeout after 25s: ${method}` } }) } }, 25000)
  pending.set(i, (m) => { clearTimeout(timer); res(m) })
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
})
await send('Runtime.enable')
await send('Page.enable')
async function evaluate(expression, sessionId) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.error) return { __error: r.error.message }
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
  return r.result?.result?.value
}
async function until(expr, ms = 30000, sessionId) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evaluate(expr, sessionId)
    if (v && !v.__error) return v
    await sleep(250)
  }
  return null
}
// A DISABLED button is not clickable and clicking one is a silent no-op, so it does not count.
const clickButton = (text, { exact = false } = {}) => evaluate(`(() => {
  const want = ${JSON.stringify(text)}
  const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled)
  const hit = btns.find((b) => {
    const t = (b.textContent ?? '').trim()
    return ${exact ? 't === want' : 't.includes(want)'}
  })
  if (!hit) return false
  hit.click()
  return true
})()`)
// The View button that sits in the same group as the chip naming `file`.
const viewButtonFor = (file) => `(() => {
  const group = [...document.querySelectorAll('.artifact-chip-group')].find((g) => g.innerText.includes(${JSON.stringify(file)}))
  return group ? group.querySelector('.artifact-chip-view') : null
})()`

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
  const hit = rows.find((b) => (b.textContent ?? '').includes('view probe')) ?? rows[0]
  if (!hit) return null
  hit.click()
  return true
})()`, 20000)
check(Boolean(selected), '[drive] selected the stub session')

console.log('[probe] waiting for the chat view to load the manifest and the turn…')
const seen = await until(`document.querySelectorAll('.artifact-chip').length >= 5 ? document.querySelectorAll('.artifact-chip').length : null`)
if (!seen) {
  const diag = await evaluate(`JSON.stringify({ chips: document.querySelectorAll('.artifact-chip').length, body: document.body.innerText.slice(0, 300) })`)
  console.log('NEVER RENDERED — ' + diag)
  console.log('[probe] hits so far: ' + HITS.slice(0, 25).join(' | '))
  console.log('main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
console.log(`[probe] rendered ${seen} chips`)

// The browser pane must be untouched by everything below. Read its tab count NOW so a pane that
// was already holding tabs cannot mask a View that opened one.
const tabsBefore = await evaluate(`window.beacon.browser.state().then((s) => s.tabs.length)`)

// ── which chips grow a View button ───────────────────────────────────────────────────────
const has = async (file) => Boolean(await evaluate(`${viewButtonFor(file)} !== null`))
check(await has('compare.html'), 'compare.html grew a View button')
check(await has('diagram.svg'), 'diagram.svg grew a View button')
check(await has('ghost.html'), 'ghost.html grew a View button (renderability is by kind, not by whether the bytes exist)')
check(!(await has('notes.md')), 'notes.md (text, not renderable) grew NO View button')
check(!(await has('report.docx')), 'report.docx (binary) grew NO View button')
check(
  await evaluate(`[...document.querySelectorAll('.artifact-chip')].some((c) => c.innerText.includes('report.docx') && !c.classList.contains('artifact-chip-view'))`),
  'report.docx is still an ordinary download chip'
)

// ── View on the page ─────────────────────────────────────────────────────────────────────
check(await evaluate(`(() => { const b = ${viewButtonFor('compare.html')}; if (!b || b.disabled) return false; b.click(); return true })()`), '[drive] clicked View on compare.html')
const frameInfo = await until(`(() => {
  const f = document.querySelector('iframe[title="compare.html"]')
  return f ? { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') } : null
})()`, 15000)
check(frameInfo !== null, 'the pane opened an iframe for compare.html')
if (frameInfo) {
  check(frameInfo.src === `beacon-artifact://render/${FIX.html.id}?kind=html`, `its src is the render URL by CONTENT ID (got ${frameInfo.src})`)
  check(frameInfo.sandbox === 'allow-scripts', `sandboxed with allow-scripts and NOT allow-same-origin (got "${frameInfo.sandbox}")`)
}

// Reach INTO the iframe by CDP. From the shell page its document is opaque (that is the point),
// and it is not even in the shell's frame tree: the sandboxed, opaque-origin frame runs out of
// process, so it is its own CDP target. Attach to THAT target (flattened session) and evaluate in
// it. Poll — the target appears after the frame attaches.
let frameSession = null
let frameTargetUrl = null
for (let i = 0; i < 40 && !frameSession; i++) {
  const targets = await send('Target.getTargets')
  const t = (targets.result?.targetInfos ?? []).find((x) => x.type === 'iframe' && x.url.startsWith('beacon-artifact://render/'))
  if (t) {
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
    if (a.result?.sessionId) { frameSession = a.result.sessionId; frameTargetUrl = t.url }
  }
  if (!frameSession) await sleep(250)
}
check(frameSession !== null, 'attached to the rendered frame over CDP (its own process target — the opaque origin is real isolation)')
if (frameSession) check(frameTargetUrl.includes(FIX.html.id), 'and it is the compare.html frame, by content id')
if (frameSession) {
  const rendered = await until(`document.getElementById('js') ? document.getElementById('js').textContent : null`, 10000, frameSession)
  check(rendered === 'js:ran', `the page's inline script EXECUTED inside the pane (got ${JSON.stringify(rendered)})`)
  const heading = await evaluate(`document.getElementById('h') ? document.getElementById('h').textContent : null`, frameSession)
  check(heading === 'Agent comparison', 'the document rendered (heading present)')
  // The network attempt: wait for its verdict to land in the DOM, then check the stub's own log.
  const net = await until(`(() => { const t = document.getElementById('net').textContent; return t === 'net:pending' ? null : t })()`, 10000, frameSession)
  // net:blocked alone does not discriminate: the stub sends no CORS headers, so a fetch the CSP let
  // through would ALSO land in the page's catch. The stub's own hit log, next, is what tells them
  // apart (mutation-tested: with connect-src opened, only that check fails).
  check(net === 'net:blocked', `the page's fetch() did not succeed inside the sandbox (got ${JSON.stringify(net)})`)
  check(!HITS.some((h) => h.includes('beacon-pwn')), 'and the stub NEVER SAW the request — the CSP stopped it before it left the page')
}

if (process.env.PROBE_SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.result.data, 'base64'))
    console.log(`[probe] screenshot -> ${process.env.PROBE_SHOT}`)
  }
}

// Source toggle: the peek text, so a person can read what the agent wrote.
check(await clickButton('Source'), '[drive] clicked the Source toggle')
const src = await until(`(() => { const p = [...document.querySelectorAll('pre')].find((x) => x.textContent.includes('Agent comparison')); return p ? true : null })()`, 8000)
check(src !== null, 'the Source view shows the page source')
check(await clickButton('Rendered'), '[drive] back to Rendered')

// ── View on the svg ──────────────────────────────────────────────────────────────────────
check(await evaluate(`(() => { const b = ${viewButtonFor('diagram.svg')}; if (!b || b.disabled) return false; b.click(); return true })()`), '[drive] clicked View on diagram.svg')
const svg = await until(`(() => {
  const i = [...document.querySelectorAll('img')].find((x) => (x.getAttribute('src') || '').includes('kind=svg'))
  return i && i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null
})()`, 10000)
check(svg !== null && svg.w === 40 && svg.h === 30, `the svg DECODED at its real size, 40x30 (got ${svg ? svg.w + 'x' + svg.h : 'nothing'})`)

// ── a failed View says so, and opens nothing ─────────────────────────────────────────────
const before = await evaluate(`document.querySelectorAll('iframe[title="ghost.html"]').length`)
check(await evaluate(`(() => { const b = ${viewButtonFor('ghost.html')}; if (!b || b.disabled) return false; b.click(); return true })()`), '[drive] clicked View on ghost.html (bytes 404)')
const failed = await until(`(() => { const b = ${viewButtonFor('ghost.html')}; return b && b.innerText.includes('could not open') ? b.innerText : null })()`, 10000)
check(failed !== null, `the button SAYS it failed (${failed ?? 'no message'}) — not a silent dead click`)
check((await evaluate(`document.querySelectorAll('iframe[title="ghost.html"]').length`)) === before, 'and no pane was opened for it')

// ── the browser pane was never touched ──────────────────────────────────────────────────
const tabsAfter = await evaluate(`window.beacon.browser.state().then((s) => s.tabs.length)`)
check(tabsBefore === tabsAfter, `the browser pane gained no tabs from any of this (${tabsBefore} -> ${tabsAfter})`)

const bad = PAGE_ERRORS.filter((e) => /Content Security Policy|Refused to|beacon-artifact/i.test(e))
check(bad.length === 0, `no CSP violation or protocol error on the shell page${bad.length ? ': ' + bad[0].slice(0, 160) : ''}`)

console.log('')
console.log(`[probe] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (which kinds get View, page runs sandboxed, network blocked, svg decodes, failure is visible, browser pane untouched)`)
if (mainLog.length) {
  const noise = mainLog.join('').match(/(error|refus|throw)[^\n]*/gi) ?? []
  if (noise.length) console.log('[probe] main log noted: ' + noise.slice(0, 4).join(' | ').slice(0, 400))
}
await reapAndExit(failures === 0 ? 0 : 1)
