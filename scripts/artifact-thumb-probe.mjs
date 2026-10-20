// artifact-thumb-probe — does a raster image mentioned in chat actually arrive as a THUMBNAIL?
//
// WHY THIS EXISTS. The chip change routes an <img> at beacon-artifact://image/<id>, and three
// things have to be true at once for a pixel to appear: the shell CSP must admit that scheme for
// img-src, the privileged scheme must be registered BEFORE app.whenReady (Chromium refuses after),
// and main must answer with a Content-Type sniffed from the bytes under nosniff. smoke:artifacts
// pins the model — which artifacts qualify, what the sniffer returns, that main calls it. It
// cannot pin any of those three, because none of them is a pure function. A green smoke with a
// blank <img> is exactly the failure this probe exists to catch.
//
// THE THREE PAYLOADS. Each is a different question:
//   real.png      a genuine PNG — must decode, so naturalWidth > 0 and the src is the protocol URL
//   jpeg.png      JPEG bytes under a .png name and an octet-stream mime — must STILL decode, because
//                 the served type comes from the bytes. This is the assertion that proves the
//                 sniffer is on the serving path rather than merely defined.
//   fake.png      markup renamed .png — must FAIL to load (415), and the chip must DEGRADE back to
//                 a download button. A broken-image glyph where a filename used to be is a
//                 regression, and it is invisible to every pure test.
//
// WHY A STUB GATEWAY. The outbox is real files on the real daemon; a probe that reads them would
// test whatever happens to be there. The stub serves the manifest and the bytes itself, so the
// fixtures above are the fixtures, every run.
//
// Run: npm run build && DISPLAY=:1 node scripts/artifact-thumb-probe.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync, readFileSync } from 'node:fs'
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

// ── fixtures ───────────────────────────────────────────────────────────────────────────
// Built from scratch rather than read off disk: the probe must not depend on what happens to be
// in a checkout, and each payload has to be a KNOWN answer to a specific question.
const u8 = (...n) => Buffer.from(n)
const ascii = (s) => Buffer.from(s, 'latin1')

// A real 4x3 solid-red PNG, hand-assembled (IHDR + one IDAT + IEND). zlib is in node's stdlib.
const { deflateSync, crc32 } = await import('node:zlib')
const pngChunk = (type, data) => {
  const body = Buffer.concat([ascii(type), data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length >>> 0, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}
// 4x3 truecolour RGB: width, height, bit depth 8, colour type 2, no interlace.
const ihdrBuf = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from([0, 0, 0, 3]), Buffer.from([8, 2, 0, 0, 0])])
const raw = Buffer.concat(Array.from({ length: 3 }, () => Buffer.concat([u8(0), Buffer.from([200, 40, 40, 200, 40, 40, 200, 40, 40, 200, 40, 40])])))
const REAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', ihdrBuf),
  pngChunk('IDAT', deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0))
])

// A REAL 6x5 JPEG carrying a .png NAME — the case that proves the served type comes from the
// payload. It has to be genuinely decodable, not merely jpeg-magic-prefixed: a truncated header
// sniffs correctly but Chromium cannot paint it, so the probe would fail on the FIXTURE while the
// serving path was fine (that exact false failure happened once, and cost a debugging cycle).
const JPEG_NAMED_PNG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAFAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzqiiiv6TP50P/2Q==',
  'base64'
)
// Markup renamed .png — must be refused, not served under an image type.
const FAKE_PNG = ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>window.PWNED=1</script></svg>')

const { createHash } = await import('node:crypto')
const cid = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
const FIX = {
  real: { id: cid(REAL_PNG), name: 'real.png', bytes: REAL_PNG, mime: 'image/png' },
  jpeg: { id: cid(JPEG_NAMED_PNG), name: 'jpeg.png', bytes: JPEG_NAMED_PNG, mime: 'application/octet-stream' },
  fake: { id: cid(FAKE_PNG), name: 'fake.png', bytes: FAKE_PNG, mime: 'image/png' }
}
// A docx-shaped row: must STAY a plain chip. Same magic-prefix family as a zip, and an image gate
// that leaked on it would mojibake a document into a thumbnail.
const DOC = Buffer.from('UEsDBBQAAAAIAA==', 'base64')
FIX.doc = { id: cid(DOC), name: 'report.docx', bytes: DOC, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }

console.log('[probe] fixtures: ' + Object.entries(FIX).map(([k, v]) => `${k}=${v.id}`).join(' '))
const BYTES = Object.fromEntries(Object.values(FIX).map((f) => [f.id, f.bytes]))

// ── the stub gateway ───────────────────────────────────────────────────────────────────
// Serves exactly the artifact contract Beacon speaks: the manifest, and the bytes BY CONTENT ID.
// The daemon's real route answers application/octet-stream + attachment — which is why the
// thumbnail route sniffs the type in MAIN instead of trusting the response.
const SESSION = 'desktop:artifact-thumb-probe'
const HITS = []
const FETCHED_IDS = [] // every content id the app asked for bytes — the gate's observable effect
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
        id: f.id, name: f.name, path: f.name, size: f.bytes.length, mtime: now - i, mime: f.mime
      }))
    })
  }
  const m = url.match(/^\/api\/artifacts\/([0-9a-f]{16})/)
  if (m) {
    const b = BYTES[m[1]]
    FETCHED_IDS.push(m[1])
    if (!b) return json(res, 404, { error: 'unknown artifact id' })
    // The daemon's REAL headers: octet-stream and attachment. Beacon must not depend on either.
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${FIX[Object.keys(FIX).find((k) => FIX[k].id === m[1])].name}"`,
      'content-length': b.length
    })
    return res.end(b)
  }
  // One assistant turn mentioning every fixture by name — that mention is what grows a chip.
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
      session_id: SESSION, gateway: 'desktop', title: 'thumb probe', created_at: nowS - 60,
      last_active: nowS - 60, message_count: 1, watermark: 0
    }])
  }
  json(res, 404, { detail: 'not stubbed: ' + url })
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port

// The WS must SETTLE at connected. A churning socket makes main broadcast connection-changed,
// App.tsx bumps connGen and MainView REMOUNTS — which throws away the renderer state mid-drive
// (measured: identical code passing and failing across two runs in restore-outcome-probe).
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
// Own instance, own --user-data-dir: an installed Beacon holds the single-instance lock and a
// second `electron .` would quit at once, measuring nothing. A fresh dir also means nothing from
// a previous run can make an assertion pass.
// The port is ALLOCATED, not derived from the pid. A computed port can already be held by a
// leftover Electron from an earlier run, and then /json/list happily answers from THAT instance —
// so the probe drives a stale build and reports PASS for a feature the build under test does not
// have. That is not hypothetical: it happened while mutation-testing this very probe, and it made a
// deleted protocol route look like it still served thumbnails.
const { createServer: netServer } = await import('node:net')
const CDP_PORT = await new Promise((res, rej) => {
  const srv = netServer()
  srv.on('error', rej)
  srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)) })
})
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-thumb-probe-'))
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

// IDENTITY BEFORE ATTACH. With --remote-debugging-port Chromium prints, on OUR child's stderr:
//   DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>
// Waiting for OUR port in OUR child's own output proves the endpoint answers from this build and
// this user-data-dir; only then is /json/list consulted. (The form is "DevTools listening", not
// "Debugger listening" — the latter belongs to --inspect on the node target. Verified against a
// live launch, 2026-09-30, because guessing it here would have made the guard never fire.)
let announced = null
for (let i = 0; i < 80 && !announced; i++) {
  await sleep(250)
  const m = mainLog.join('').match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${CDP_PORT}/[^\\s]+)`))
  if (m) announced = m[1]
  if (child.exitCode !== null || child.signalCode !== null) break
}
if (!announced) {
  console.log(`NEVER SAW OUR OWN DEVTOOLS ENDPOINT on port ${CDP_PORT} — refusing to attach to a listener that might be another instance. main log tail:\n` + mainLog.join('').slice(-2000))
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') PAGE_ERRORS.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
})
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => {
  const i = ++msgId
  const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ result: { exceptionDetails: { text: `timeout after 25s: ${method}` } } }) } }, 25000)
  pending.set(i, (m) => { clearTimeout(timer); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
{ const i = ++msgId; ws.send(JSON.stringify({ id: i, method: 'Runtime.enable' })) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

// ── drive it ─────────────────────────────────────────────────────────────────────────────
// A DISABLED button is not clickable and clicking one is a silent no-op, so it does not count as a
// step (restore-outcome-probe learned this the expensive way: it reported a click landing while the
// button was still disabled, then failed three steps later with no clue why).
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

console.log('[probe] waiting for the app to reach its main view…')
const booted = await until(`document.querySelector('[aria-label="Views"]') ? true : null`, 40000)
if (!booted) {
  console.log('NEVER REACHED THE MAIN VIEW (nav rail absent) — main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
check(true, 'main view is up (nav rail present)')

// The chips render inside ChatShell, which only mounts for an ACTIVE session — so the probe has to
// open Chats and select the stub row first. Groups render COLLAPSED until expanded, so the row is
// in the DOM but not yet clickable; expand on EVERY POLL, not once up front, because the list loads
// asynchronously and a one-shot expand that beats it expands nothing (measured: 2 of 6 runs of the
// restore probe failed exactly that way).
check(await clickButton('Chats'), '[drive] opened the Chats surface')
const selected = await until(`(() => {
  for (const h of document.querySelectorAll('button.session-group-head[aria-expanded="false"]')) h.click()
  const rows = [...document.querySelectorAll('button.session-row')].filter((b) => b.offsetParent !== null)
  const hit = rows.find((b) => (b.textContent ?? '').includes('thumb probe')) ?? rows[0]
  if (!hit) return null
  hit.click()
  return true
})()`, 20000)
check(Boolean(selected), '[drive] selected the stub session')

console.log('[probe] waiting for the chat view to load the manifest and the turn…')
const seen = await until(`
  (() => {
    const chips = document.querySelectorAll('.artifact-chip, .artifact-thumb')
    const imgs = document.querySelectorAll('.artifact-thumb-img')
    return chips.length >= 3 && imgs.length >= 1
      ? { chips: chips.length, imgs: imgs.length }
      : null
  })()
`)
if (!seen) {
  const diag = await evaluate(`JSON.stringify({
    chips: document.querySelectorAll('.artifact-chip').length,
    thumbs: document.querySelectorAll('.artifact-thumb').length,
    body: document.body.innerText.slice(0, 300)
  })`)
  console.log('NEVER RENDERED — ' + diag)
  console.log('[probe] hits so far: ' + HITS.slice(0, 25).join(' | '))
  console.log('main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
console.log(`[probe] rendered ${seen.chips} chip/thumb nodes, ${seen.imgs} thumbnails`)

// THE load-bearing assertion: a real <img> that DECODED. naturalWidth > 0 only after Chromium
// fetched beacon-artifact://image/<id> AND parsed the bytes as an image — which is precisely what
// a CSP block, a missing scheme registration, or a wrong Content-Type all prevent. A src being
// present proves nothing; a decoded bitmap proves the whole chain.
const decoded = await until(`
  (() => {
    const img = [...document.querySelectorAll('.artifact-thumb-img')].find(i => i.naturalWidth > 0)
    return img ? { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') } : null
  })()
`)
check(decoded !== null, 'a thumbnail DECODED in the real app (naturalWidth > 0)')
if (decoded) {
  check(decoded.w === 4 && decoded.h === 3, `it decoded the ACTUAL fixture bytes, 4x3 (got ${decoded.w}x${decoded.h}) — not a placeholder, not a fallback icon`)
  check(decoded.src.startsWith('beacon-artifact://image/'), `its src is the protocol URL, by content id (got ${decoded.src.slice(0, 45)})`)
  check(!decoded.src.includes('.png') && !decoded.src.includes('/home/'), 'the URL carries NO filename and NO path — content id only')
}

// The JPEG-named-.png fixture is the assertion that proves the SNIFFER is on the serving path.
// Its manifest mime is octet-stream and its name lies; if main served either claim, Chromium
// would refuse to decode it. It decodes only because imageMimeFromBytes read the bytes.
const sniffed = await until(`
  (() => {
    const i = [...document.querySelectorAll('.artifact-thumb-img')].find(x => x.alt === 'jpeg.png')
    return i && i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight, complete: i.complete } : null
  })()
`)
check(sniffed !== null, 'JPEG bytes under a .png name and an octet-stream mime STILL decoded — the served type came from the bytes, not the URL or the manifest')
check(sniffed !== null && sniffed.w === 6 && sniffed.h === 5, `and it decoded the real 6x5 jpeg bitmap, not just "some image" (got ${sniffed ? sniffed.w + 'x' + sniffed.h : 'nothing'})`)

// The refusal half. fake.png is markup; main answers 415 and the <img> fails, which must DEGRADE
// to a download chip. Two separate claims: the image did not load, and a button took its place.
const refused = await evaluate(`
  (() => {
    const i = [...document.querySelectorAll('.artifact-thumb-img')].find(x => x.alt === 'fake.png')
    const chip = [...document.querySelectorAll('.artifact-chip')].find(x => x.innerText.includes('fake.png'))
    return {
      thumbPresent: !!i,
      thumbBroken: i ? (i.complete && i.naturalWidth === 0) : null,
      chipPresent: !!chip,
      pwned: window.PWNED === 1
    }
  })()
`)
check(refused && refused.pwned !== true, 'the markup-renamed-.png payload NEVER EXECUTED (window.PWNED stayed undefined)')
check(refused && (refused.chipPresent || refused.thumbBroken),
  `fake.png degraded rather than leaving a broken glyph (chip=${refused?.chipPresent}, brokenThumb=${refused?.thumbBroken})`)

// The docx must stay an ordinary chip. An image gate that leaked here would render a document as
// mojibake — the exact failure previewKindFor's comment warns about.
const doc = await evaluate(`
  (() => {
    const img = [...document.querySelectorAll('.artifact-thumb-img')].find(x => x.alt === 'report.docx')
    const chip = [...document.querySelectorAll('.artifact-chip')].find(x => x.innerText.includes('report.docx'))
    return { thumb: !!img, chip: !!chip }
  })()
`)
check(doc && !doc.thumb, 'report.docx grew NO thumbnail')
check(doc && doc.chip, 'report.docx stayed a download chip')

// The DOM assertion above is NOT sufficient on its own, and mutation-testing proved it: with the
// gate wide open a docx thumbnail IS attempted, its bytes are refused 415 by main, the <img> fails
// and onError DEGRADES it back to a chip — so "grew no thumbnail" passes for the wrong reason and
// cannot distinguish a correct exclusion from a rescued leak. What does distinguish them is whether
// the bytes were ever asked for. A correct gate never fetches a non-image at all.
check(!FETCHED_IDS.includes(FIX.doc.id),
  `report.docx bytes were NEVER FETCHED — excluded by the gate, not merely rescued by degradation (fetched: ${FETCHED_IDS.length} ids)`)
check(FETCHED_IDS.includes(FIX.real.id) && FETCHED_IDS.includes(FIX.jpeg.id),
  'both genuine images WERE fetched — the gate is not simply refusing everything')

// Click-to-open: the pane must resolve the SAME reference, not a base64 copy.
const clicked = await evaluate(`
  (() => {
    const i = [...document.querySelectorAll('.artifact-thumb-img')].find(x => x.naturalWidth > 0)
    if (!i) return { noThumb: true }
    i.click()
    return { noThumb: false }
  })()
`)
const pane = clicked && !clicked.noThumb ? await until(`
  (() => {
    const p = [...document.querySelectorAll('img')].find(x => (x.getAttribute('src') || '').startsWith('beacon-artifact://image/') && x.closest('img') !== null && x.naturalWidth > 0 && !x.classList.contains('artifact-thumb-img'))
    return p ? { w: p.naturalWidth, src: (p.getAttribute('src') || '').slice(0, 45) } : null
  })()
`) : null
check(!!pane, `clicking a thumbnail opened the preview pane at full size by REFERENCE (${pane ? pane.src : 'no pane'})`)

// Page errors are a finding: a CSP violation or an unhandled rejection in the protocol handler
// shows up here and nowhere else in this probe.
const cspNoise = PAGE_ERRORS.filter((e) => /Content Security Policy|Refused to load|beacon-artifact/i.test(e))
check(cspNoise.length === 0, `no CSP violation or protocol error in the page console${cspNoise.length ? ': ' + cspNoise[0].slice(0, 160) : ''}`)

// The stub must have been asked by CONTENT ID and never by path — the wire contract, verified
// from the receiving end rather than asserted about the sending end.
const badHits = HITS.filter((h) => /\/api\/artifacts\/(?!([0-9a-f]{16}))/i.test(h.split(' ')[1] ?? ''))
check(badHits.length === 0, `every bytes fetch went by 16-hex content id, never a path (${HITS.filter((h) => h.includes('/api/artifacts/')).length} fetches)`)

console.log('')
console.log(`[probe] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (decode, sniff-on-the-wire, refusal+degrade, docx stays a chip, click-to-pane, no CSP noise)`)
if (mainLog.length) {
  const noise = mainLog.join('').match(/(error|refus|throw)[^\n]*/gi) ?? []
  if (noise.length) console.log('[probe] main log noted: ' + noise.slice(0, 4).join(' | ').slice(0, 400))
}
await reapAndExit(failures === 0 ? 0 : 1)
