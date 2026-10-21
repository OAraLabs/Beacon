// machine-notice-probe — does a turn the daemon could NOT audit render as "not audited" in the
// real app, and never as an empty, clean "files touched" list?
//
// WHY THIS EXISTS. smoke:match-spec pins the parser and the caption. It cannot pin what only the
// app can answer: that a user-role notice reaches MachineNoticeCard through the real fetch → mapper
// → ChatShell path, that the caption a person reads says "not audited", that the raw header never
// paints into the thread, and that the unparsed command is actually behind the row (a <details>
// that opens and shows every line), not only in a hover title.
//
// THE FIXTURES are the daemon's own text: Prometheus `FileMutationVerifier._format_summary` run
// on 2026-10-12, the same strings smoke:match-spec carries.
//   UNAUDITED  nothing trackable, one multi-line command it could not lex (×2) — the live bug
//   PARTIAL    ✓ ⚠ ⚠ ✗ rows plus one UNAUDITED row — the old parser showed only the ✓
//   CLEAN      one ✓ row — must still read "files touched"
//
// Run: npm run build && node scripts/machine-notice-probe.mjs
//      PROBE_SHOT=<png> saves a screenshot of the thread.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let checks = 0
const check = (ok, what) => {
  checks++
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
  if (src > statSync(built).mtimeMs && !process.env.PROBE_ALLOW_STALE) {
    console.log(`FATAL: source is newer than the build by ${Math.round((src - statSync(built).mtimeMs) / 1000)}s — run \`npm run build\`.`)
    process.exit(5)
  }
}

// ── fixtures: the daemon's own text ─────────────────────────────────────────────────────
const UNAUDITED = '[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? UNAUDITED, could not parse this command — python3 -c "\nimport datetime\nprint(datetime.datetime.now())\n" (×2)\n   (this turn may have written files this hook could not see)'
const PARTIAL = '[FILE MUTATION VERIFIER]\nFiles touched this turn:\n   ✓ /w/notes.md — write_file: created (+6964 bytes)\n   ⚠ /w/same.md — edit_file: CLAIMED but NO CHANGE ON DISK\n   ⚠ /w/gone.txt — redirect_write: CLAIMED but FILE ABSENT\n   ✗ /w/bad.md — write_file: modified (+4 bytes) — permission denied\n   ? UNAUDITED, could not parse this command — python3 -c "\nimport datetime\nprint(datetime.datetime.now())\n"'
const CLEAN = '[FILE MUTATION VERIFIER]\nFiles touched this turn:\n   ✓ /w/a.md — write_file: created (+12 bytes)'
const COMMAND = 'python3 -c "\nimport datetime\nprint(datetime.datetime.now())\n"'

const SESSION = 'desktop:machine-notice-probe'
const HITS = []
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const t0 = Math.floor(Date.now() / 1000) - 120
const msg = (ordinal, role, content) => ({
  message_id: ordinal + 1, ordinal, session_id: SESSION, role, content, content_json: null,
  provenance: 'user', is_trusted: true, client_msg_id: null, timestamp: t0 + ordinal
})
const MESSAGES = [
  msg(0, 'user', 'What time is it?'),
  msg(1, 'user', UNAUDITED),
  msg(2, 'assistant', 'It is just after noon.'),
  msg(3, 'user', 'Now write the notes.'),
  msg(4, 'user', PARTIAL),
  msg(5, 'assistant', 'Some of that did not land.'),
  msg(6, 'user', 'One more.'),
  msg(7, 'user', CLEAN),
  msg(8, 'assistant', 'Done.')
]
const site = createServer((req, res) => {
  const url = req.url ?? ''
  HITS.push(`${req.method} ${url.split('?')[0]}`)
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url.startsWith('/api/sessions/') && url.includes('/messages')) {
    return json(res, 200, { watermark: MESSAGES.length, messages: MESSAGES })
  }
  if (url.startsWith('/api/sessions')) {
    return json(res, 200, [{
      session_id: SESSION, gateway: 'desktop', title: 'notice probe', created_at: t0,
      last_active: t0 + 9, message_count: MESSAGES.length, watermark: 0
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
// Own instance, own --user-data-dir (no credential, mock keychain: nothing can reach a real
// daemon or prompt for a password), ALLOCATED debugging port.
const { createServer: netServer } = await import('node:net')
const CDP_PORT = await new Promise((res, rej) => {
  const srv = netServer()
  srv.on('error', rej)
  srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)) })
})
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-notice-probe-'))
const child = spawn('npx', ['electron', '.', '--use-mock-keychain', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`], {
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

let page = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
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
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') PAGE_ERRORS.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception')
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
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
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = await evaluate(expr)
    if (v && !v.__error) return v
    await sleep(250)
  }
  return null
}
const clickButton = (text) => evaluate(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled)
    .find((b) => (b.textContent ?? '').trim().includes(${JSON.stringify(text)}))
  if (!hit) return false
  hit.click()
  return true
})()`)

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
  const hit = [...document.querySelectorAll('button.session-row')].filter((b) => b.offsetParent !== null)
    .find((b) => (b.textContent ?? '').includes('notice probe'))
  if (!hit) return null
  hit.click()
  return true
})()`, 20000)
check(Boolean(selected), '[drive] selected the stub session')

// Wait for the LAST assistant line, so every notice before it has had its chance to render.
const loaded = await until(`document.body.innerText.includes('Some of that did not land.') && document.body.innerText.includes('Done.') ? true : null`, 20000)
if (!loaded) {
  console.log('THE THREAD NEVER LOADED — ' + JSON.stringify(await evaluate(`document.body.innerText.slice(0, 400)`)))
  console.log('[probe] hits: ' + HITS.slice(0, 25).join(' | '))
  await reapAndExit(3)
}
check(HITS.some((h) => h.startsWith('GET /api/sessions/') && h.includes('/messages')), 'the thread came from the stub gateway (real fetch → mapper → ChatShell path)')

// ── read every card as painted ───────────────────────────────────────────────────────────
const cards = await evaluate(`[...document.querySelectorAll('.machine-notice')].map((c) => ({
  cap: c.querySelector('.machine-notice-cap')?.textContent ?? null,
  text: c.innerText,
  rows: c.querySelectorAll(':scope > .machine-notice-row').length,
  bad: c.querySelectorAll(':scope > .machine-notice-row .machine-notice-dot.is-bad').length,
  details: [...c.querySelectorAll('details.machine-notice-unaudited')].map((d) => ({
    open: d.open,
    summary: d.querySelector('summary')?.innerText ?? '',
    ring: Boolean(d.querySelector('summary .machine-notice-dot.is-unknown')),
  })),
  overflow: c.scrollWidth - c.clientWidth,
}))`)
check(Array.isArray(cards) && cards.length === 3, `three notice cards rendered (got ${Array.isArray(cards) ? cards.length : JSON.stringify(cards)})`)
const [un, part, clean] = Array.isArray(cards) ? cards : []

// THE BUG: an UNAUDITED-only notice read "files touched" over the raw header.
check(un?.cap === 'not audited', `the unaudited card's caption is "not audited" (got ${JSON.stringify(un?.cap)})`)
check(un && !un.text.includes('[FILE MUTATION VERIFIER]'), 'and the raw "[FILE MUTATION VERIFIER]" header is not painted in it')
check(un?.rows === 0 && un?.details.length === 1, `no file rows, one not-audited row (got ${un?.rows} rows, ${un?.details.length} folded)`)
check(un?.details[0]?.ring === true, 'its dot is the hollow "unknown" ring, not a clean or failed dot')
check(/could not parse/.test(un?.details[0]?.summary ?? '') && /python3 -c "/.test(un?.details[0]?.summary ?? '') && /×2/.test(un?.details[0]?.summary ?? ''), `the row reads could-not-parse, the command's first line and ×2 (got ${JSON.stringify(un?.details[0]?.summary)})`)
check(un?.details[0]?.open === false, 'the command starts folded behind the row')
check(!(await evaluate(`document.body.innerText.includes('[FILE MUTATION VERIFIER]')`)), 'no notice header is painted anywhere in the thread')

// The command behind the row: open it with a real click on the summary, read every line.
const opened = await evaluate(`(() => {
  const s = document.querySelectorAll('.machine-notice')[0]?.querySelector('details.machine-notice-unaudited summary')
  if (!s) return false
  s.click()
  return true
})()`)
check(opened === true, '[drive] clicked the not-audited row')
const shown = await until(`(() => {
  const d = document.querySelectorAll('.machine-notice')[0]?.querySelector('details.machine-notice-unaudited')
  const pre = d?.querySelector('pre')
  if (!d?.open || !pre) return null
  const r = pre.getBoundingClientRect()
  return { text: pre.textContent, h: r.height, w: r.width }
})()`, 5000)
check(shown?.text === COMMAND, `the full command, every line, is behind the row (got ${JSON.stringify(shown?.text)})`)
check((shown?.h ?? 0) > 20 && (shown?.w ?? 0) > 40, `and it is painted, not just in the DOM (${shown ? Math.round(shown.w) + 'x' + Math.round(shown.h) : 'nothing'})`)

// The partial audit: the old parser showed ONE clean ✓ row here.
check(part?.cap === 'files touched · not fully audited', `the partial card says it is partial (got ${JSON.stringify(part?.cap)})`)
check(part?.rows === 4 && part?.bad === 3, `four file rows, three of them marked bad (got ${part?.rows} rows, ${part?.bad} bad)`)
check(part?.details.length === 1, 'plus its not-audited row')

// The clean audit still reads as one.
check(clean?.cap === 'files touched' && clean?.rows === 1 && clean?.details.length === 0, `the clean card is unchanged: "files touched", one row (got ${JSON.stringify(clean?.cap)}, ${clean?.rows})`)

check((cards ?? []).every((c) => c.overflow <= 0), `no card overflows its width (${(cards ?? []).map((c) => c.overflow).join(', ')})`)
check(PAGE_ERRORS.length === 0, `no page exceptions${PAGE_ERRORS.length ? ': ' + PAGE_ERRORS.slice(0, 2).join(' | ') : ''}`)

if (process.env.PROBE_SHOT) {
  await evaluate(`document.querySelectorAll('.machine-notice')[0]?.scrollIntoView({ block: 'start' })`)
  await sleep(300)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.result.data, 'base64'))
    console.log(`[probe] screenshot -> ${process.env.PROBE_SHOT}`)
  }
}

const MIN_CHECKS = 20
check(checks >= MIN_CHECKS - 1, `ran ${checks + 1} checks (a probe that skipped a section must not pass)`)
console.log(`[probe] outcome: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
await reapAndExit(failures === 0 ? 0 : 1)
