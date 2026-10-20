// restore-outcome-probe — is the result of a RESTORE readable after the restore commits?
//
// WHY THIS EXISTS. Issue #167: restore() sets `outcome` and bumps `nonce` in the same handler, and
// the `[active, nonce]` effect nulled `outcome` on its way past — so the sentence carrying the
// counts, including the error count, was written and destroyed one tick later. A restore reporting
// `2 errors` looked identical to one that succeeded, on the panel's ONE irreversible action.
//
// WHY A PROBE AND NOT A SMOKE. The defect is a React effect-ordering + mount-scope question: is the
// outcome node still in the document after the refresh the restore itself triggers. No pure model
// function can answer that. smoke:checkpoints pins the sentence builder; this pins the sentence
// reaching a screen.
//
// WHY A STUB GATEWAY. A real restore rewrites and DELETES files in a session's workspace. The daemon
// cannot be the subject of a test that runs on demand, so the probe serves the wire itself and
// answers POST …/restore with a result carrying ERRORS — the case where silence is most expensive.
// Nothing on disk is touched by this script.
//
// THE CONTROL. The probe asserts the outcome is visible AND that the checkpoint detail box is GONE.
// That second assertion is the load-bearing one: the nonce bump clears `selected`, so the detail box
// unmounts, and it is the box the outcome line used to render INSIDE. A future edit that moves the
// line back into the detail box — the original defect, and the fix the issue text proposed, which is
// insufficient — fails here rather than passing silently.
//
// Run: npm run build && DISPLAY=:1 node scripts/restore-outcome-probe.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// FAIL CLOSED: never drive a build older than the source (the trap that makes a green probe mean
// nothing — it measured the last build, not this edit).
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
// Serves the endpoints the renderer touches to reach and exercise the Checkpoints panel. Every
// response is the daemon's real shape, read off @shared/checkpoints' DTOs.
const SESSION = 'desktop:restore-outcome-probe'
const CID = 'ckpt0000000001'
let sawRestore = null // records the real POST body — the probe asserts on what was SENT

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const HITS = []
const site = createServer((req, res) => {
  const url = req.url ?? ''
  HITS.push(`${req.method} ${url}`)
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (url.startsWith('/api/sessions/') && url.endsWith('/checkpoints') && req.method === 'GET') {
    return json(res, 200, {
      session_id: SESSION,
      checkpoints: [{ id: CID, label: 'turn 1', created_at: Date.now() - 60000, files: 3, bytes: 4096, skipped: 0 }]
    })
  }
  if (url.startsWith('/api/sessions/') && url.endsWith('/workspace') && req.method === 'GET') {
    return json(res, 200, { source: 'session', workspace: '/tmp/probe-ws', daemon_workspace_roots: ['/tmp/probe-ws'] })
  }
  if (url.startsWith('/api/sessions/') && url.endsWith(`/checkpoints/${CID}`) && req.method === 'GET') {
    return json(res, 200, {
      id: CID, label: 'turn 1', created_at: Date.now() - 60000, files: 3, bytes: 4096, skipped: 0,
      diff: { changed: ['a.md'], deleted: [], added: ['b.md'], unchanged: ['c.md'] }
    })
  }
  if (url.endsWith('/restore') && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      sawRestore = raw
      const body = JSON.parse(raw || '{}')
      // A dry run answers with what WOULD change; the commit answers with what DID, and carries an
      // ERROR — the shape the defect hid. One file rewritten, one removed, one error.
      return json(res, 200, body.dry_run
        ? { checkpoint: CID, dry_run: true, restored: ['a.md'], deleted: ['b.md'], unchanged: ['c.md'], errors: [] }
        : { checkpoint: CID, dry_run: false, restored: ['a.md'], deleted: ['b.md'], unchanged: [], errors: [{ path: 'locked.md', error: 'permission denied' }] })
    })
    return
  }
  if (url.startsWith('/api/sessions/') && url.includes('/messages')) return json(res, 200, { watermark: 0, messages: [] })
  if (url.startsWith('/api/sessions')) {
    // SECONDS, not ms. rest.ts multiplies last_active/created_at by 1000 to get ms, so serving ms
    // here lands the session in the year 58000 and the Sidebar's calendar-day bucketing drops the
    // row entirely — the panel then has no active session and there is nothing to restore. The
    // probe must speak the daemon's real contract or it tests its own fiction.
    const nowS = Math.floor(Date.now() / 1000)
    return json(res, 200, [
      { session_id: SESSION, gateway: 'desktop', title: 'restore probe', created_at: nowS - 60, last_active: nowS - 60, message_count: 0, watermark: 0 }
    ])
  }
  json(res, 404, { detail: 'not stubbed: ' + url })
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const API_PORT = site.address().port

// ── the stub WS ──────────────────────────────────────────────────────────────────────────
// The panel under test is pure REST, so the socket's DATA is irrelevant. Its STATE is not.
//
// Serving a dead WS port made the connection churn `reconnecting` forever, and that is not
// cosmetic: main broadcasts a connection-changed event, App.tsx bumps `connGen`, and MainView
// REMOUNTS (`key={connGen}`). A remount mid-drive throws away the renderer's `sessions` state and
// the panel's, so clicks land on a tree being rebuilt. That produced a run where every assertion
// up to `confirmed the restore` passed and then the commit silently became a second dry run — a
// flake indistinguishable from the defect, which is the worst possible failure mode for a probe
// that exists to tell them apart. Measured: the identical code passed and failed across two runs.
//
// So the stub answers the daemon's own handshake frame and then stays open and silent. The
// connection settles at `connected` and stops remounting the tree under the probe.
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (sock) => {
  // The daemon's frame that flips the manager to `connected` (connection/ws.ts).
  try { sock.send(JSON.stringify({ type: 'connected' })) } catch { /* closing */ }
  sock.on('error', () => undefined)
})
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))
const WS_PORT = wsSite.address().port

// ── launch the real built app ────────────────────────────────────────────────────────────
// Own instance, own --user-data-dir: an installed Beacon may hold the single-instance lock
// (main/index.ts) and a second `electron .` would quit at once, measuring nothing. A fresh
// user-data-dir also means nothing from a previous run can make an assertion pass.
//
// Extra Electron flags come from the environment rather than being hardcoded: a sandboxed runner
// needs --disable-dev-shm-usage/--no-sandbox, and --no-sandbox must never be a committed default
// for a probe that launches the product.
const CDP_PORT = 9600 + (process.pid % 300)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-restore-probe-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // so the whole process GROUP can be signalled — npx spawns Electron as a grandchild
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
const closeStubs = () => { try { wss.close() } catch { /* gone */ }; try { wsSite.close() } catch { /* gone */ }; try { site.close() } catch { /* gone */ } }
async function reapAndExit(code) {
  reap()
  closeStubs()
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) process.exit(code)
    await sleep(100)
  }
  killGroup('SIGKILL')
  await sleep(300)
  process.exit(code)
}
process.on('exit', reap)
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })

let page = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
    if (page) break
  } catch { /* not up yet */ }
}
if (!page) {
  console.log('NO PAGE TARGET — main log tail:\n' + mainLog.join('').slice(-1500))
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
  const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ result: { exceptionDetails: { text: `timeout after 20s: ${method}` } } }) } }, 20000)
  pending.set(i, (m) => { clearTimeout(timer); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
{ const i = ++msgId; ws.send(JSON.stringify({ id: i, method: 'Runtime.enable' })) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
  return r.result?.result?.value
}
/** Poll an expression until truthy, or null on deadline. */
async function until(expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evaluate(expr)
    if (v && !v.__error) return v
    await sleep(200)
  }
  return null
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}
/** Click the first visible button whose text matches, by exact or substring. Returns whether found. */
// A DISABLED button is not clickable, and clicking one is a silent no-op — so it does not count.
// Without this the helper reported "opened the Restore confirmation" on a click that landed while
// Restore… was still disabled awaiting the dry run, and the probe then failed three steps later.
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

// ── drive to the Checkpoints panel ───────────────────────────────────────────────────────
console.log('[drive] waiting for the app to reach its main view')
const booted = await until(`document.querySelector('[aria-label="Views"]') ? true : null`, 40000)
if (!booted) {
  console.log('FAIL never reached the main view (nav rail absent) — main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(3)
}
ok(true, 'main view is up (nav rail present)')

// The session list only renders inside the Chats surface, so select the session there first:
// the panel takes `active` from MainView, and with no active session it renders its "no session"
// state and has nothing to restore.
ok(await clickButton('Chats'), '[drive] opened the Chats surface')
// Source groups render COLLAPSED until expanded (aria-expanded="false" on the group head), so the
// row exists in the store and in the DOM but is not yet a clickable session-row. Expand collapsed
// groups ON EVERY POLL, not once up front: the list loads asynchronously, and a one-shot expand
// that runs before it arrives expands nothing — the stub `desktop:` session then lands in a
// collapsed Desktop group and the wait times out. Measured: 2 of 6 runs failed that way.
const selected = await until(`(() => {
  for (const h of document.querySelectorAll('button.session-group-head[aria-expanded="false"]')) h.click()
  const rows = [...document.querySelectorAll('button.session-row')].filter((b) => b.offsetParent !== null)
  const hit = rows.find((b) => (b.textContent ?? '').includes('restore probe')) ?? rows[0]
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(selected), '[drive] selected the stub session')

ok(await clickButton('Workspace'), '[drive] opened the Workspace surface')
const pill = await until(`(() => {
  const nav = document.querySelector('[data-testid="subnav"] nav')
  const hit = nav && [...nav.querySelectorAll('button.pill')].find((b) => (b.textContent ?? '').trim().startsWith('Checkpoints'))
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(pill), '[drive] opened the Checkpoints pill')

const row = await until(`(() => {
  const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
  const hit = btns.find((b) => (b.title ?? '').startsWith('ckpt') || (b.textContent ?? '').includes('turn 1'))
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(row), '[drive] selected the checkpoint row')

const previewBtn = await until(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    .find((b) => (b.textContent ?? '').trim() === 'Preview restore')
  if (!hit) return null
  hit.click()
  return true
})()`, 15000)
ok(Boolean(previewBtn), '[drive] ran Preview restore')

// The detail box (and therefore the old home of the outcome line) is present NOW. Recording that
// is what makes the post-restore "detail box is gone" assertion meaningful rather than vacuous.
const detailBefore = await until(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    .find((b) => (b.textContent ?? '').trim().startsWith('Restore'))
  return hit ? true : null
})()`, 10000)
ok(Boolean(detailBefore), '[drive] the detail box with Restore… is present before committing')

// ── commit the restore ───────────────────────────────────────────────────────────────────
// Restore… is disabled until the dry run's plan arrives (busy || !dryPlan). Wait for it to ENABLE —
// clicking earlier is a no-op, and on a slow preview that was 1 run in 6.
const restoreOpen = Boolean(await until(`(() => {
  const hit = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && !b.disabled && (b.textContent ?? '').trim() === 'Restore…')
  if (!hit) return null
  hit.click()
  return true
})()`, 10000))
ok(restoreOpen, '[drive] opened the Restore confirmation')
// InlineConfirm renders confirmLabel "Restore" (exact) beside "Cancel"; the trigger was "Restore…".
const confirmed = await until(`(() => {
  const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
  const hit = btns.find((b) => (b.textContent ?? '').trim() === 'Restore')
  if (!hit) return null
  hit.click()
  return true
})()`, 10000)
ok(Boolean(confirmed), '[drive] confirmed the restore')

// ── the subject: what is readable afterwards ─────────────────────────────────────────────
const outcome = await until(`(() => {
  const nodes = [...document.querySelectorAll('[role="status"]')].filter((n) => n.offsetParent !== null)
  const hit = nodes.find((n) => (n.textContent ?? '').includes('Restore'))
  if (!hit) return null
  return { text: (hit.textContent ?? '').trim(), color: getComputedStyle(hit).color }
})()`, 10000)

console.log('[render] OBSERVED  restore outcome line visible after committing: ' + (outcome ? 'true' : 'false'))
if (outcome) console.log('[render] OBSERVED  outcome text: ' + JSON.stringify(outcome.text))

ok(Boolean(outcome), 'the restore outcome line is READABLE after the refresh the restore triggers (#167)')
if (outcome) {
  // The counts, including the error count — the whole point of the line.
  ok(/rewrote 1 file/.test(outcome.text), 'it states what was rewritten', outcome.text)
  ok(/removed 1 created since/.test(outcome.text), 'it states what was removed', outcome.text)
  ok(/1 error/.test(outcome.text), 'it states the ERROR count — the number the defect hid', outcome.text)
  // ok:false must render in the error colour, or a failed restore still looks like a success.
  const errColor = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--c-err').trim()`)
  const toRgb = (hex) => {
    const h = String(hex ?? '').replace('#', '').trim()
    if (h.length !== 6) return null
    const n = parseInt(h, 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  }
  ok(outcome.color === toRgb(errColor), 'the line wears the error colour, not the neutral one', `${outcome.color} vs --c-err ${errColor}`)
}

// THE PLACEMENT PIN. The nonce bump clears `selected`, so the detail box UNMOUNTS after a commit.
// The outcome line used to render INSIDE that box, which is why it vanished (#167) — and it is why
// the fix the issue text proposes (moving `setOutcome(null)` to the [active] effect) is not enough:
// the line would still be torn down with its container.
//
// This asserts the CONJUNCTION, and the conjunction is what discriminates. Measured both ways:
//   * unfixed — the line lives in the box, the box unmounts, so `outcome` is null AND the box is
//     gone. Asserting "the box is gone" ALONE passes there, which is worthless: mutation-testing
//     this probe caught that. Only "line visible WHILE the box is gone" separates the two.
//   * fixed — the line is at panel level, so it survives its old container's unmount.
// So a future edit that moves the line back inside the detail box fails here, and the assertion
// cannot pass vacuously because the precondition below is asserted separately.
const detailAfter = await evaluate(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    .find((b) => (b.textContent ?? '').trim() === 'Preview restore')
  return Boolean(hit)
})()`)
// FAIL CLOSED. "The box is gone" is only evidence about the outcome's placement if the box was
// there first. Without this guard the pin passes vacuously whenever the drive never reached the
// detail box — the shape of assertion issue #151 names as unable to fail: it reads as reassurance
// about the fix while measuring nothing at all.
ok(Boolean(detailBefore), 'PRECONDITION: the detail box was mounted before the commit (else the placement pin proves nothing)')
ok(
  detailBefore === true && detailAfter === false && Boolean(outcome),
  'PLACEMENT: the outcome line is on screen WHILE the detail box it used to live in has unmounted',
  `boxBefore=${String(detailBefore)} boxAfter=${String(detailAfter)} outcomeVisible=${Boolean(outcome)}`
)

// What was actually sent: a commit, not a dry run, for the right checkpoint.
ok(Boolean(sawRestore), 'the stub received the restore POST')
if (sawRestore) {
  const body = JSON.parse(sawRestore)
  ok(body.dry_run === false, 'the POST was the COMMIT, not the dry run', JSON.stringify(body))
  ok(body.confirm === CID, 'the POST confirmed the selected checkpoint', JSON.stringify(body))
}

console.log('[page-errors] ' + JSON.stringify(PAGE_ERRORS.slice(0, 8), null, 1))
// ── a mutation this probe CANNOT catch, recorded rather than faked ───────────────────────
// Removing `setOutcome(null)` from the [active] effect altogether SURVIVES this probe. It is an
// EQUIVALENT mutant, and the reason is structural: every path that changes the active session also
// sets the view to 'chat' (MainView's select/jumpToHit/launch-restore/forget all pair the two), so
// the Checkpoints panel UNMOUNTS on a session change and remounts with `outcome` at its initial
// null. There is no reachable state where a session switches underneath a mounted panel, so no
// assertion here could discriminate.
//
// This block used to assert exactly that unreachable property — "the outcome did not follow to the
// new session" — and it passed with the reset deleted, i.e. it was green while measuring nothing.
// That is the shape issue #151 names as an assertion that cannot fail, so it was REMOVED rather
// than kept as the appearance of coverage. What IS load-bearing, and what the mutations below
// prove, is the two halves the PLACEMENT pin covers: the reset must not ride the nonce effect
// (mutation 3 fails), and the line must render at panel level, not inside the detail box
// (mutation 2 fails). Keeping the reset in the [active] effect mirrors `wsOutcome` beside it and
// costs nothing, but do not claim it as tested.

console.log('[stub] requests served: ' + JSON.stringify(HITS.slice(0, 40), null, 1))
console.log(failures === 0 ? '\nPASS — the restore outcome is readable, with its error count' : `\n${failures} FAIL`)
await reapAndExit(failures === 0 ? 0 : 1)
