// Drive the REAL app and prove the Connection Settings action row stays reachable when the Updates
// panel renders a worst-case update error.
//
// WHY A REAL-APP PROBE. The fix is layout: a bounded modal, a scrolling body, and a clamped detail
// line. None of that is observable from a headless smoke — "is the Save & test button on screen"
// is a question only a layout engine can answer. The updater smoke proves main CAPS the string;
// this proves the dialog survives one that isn't capped.
//
// The control matters as much as the result: the probe first reproduces the ORIGINAL bug by
// undoing the fix's CSS in the live DOM, measures the button off-screen, then restores and
// measures it back. A probe that only ever sees the good state cannot tell you it measured
// anything.
//
//   npm run build && node scripts/settings-dialog-probe.mjs
//
// SELF-CONTAINED LAUNCH. It does NOT use cdp-harness.mjs, because the installed Beacon.app may be
// running and holds the single-instance lock (main/index.ts:104) — a second `electron .` would
// quit at once and the probe would measure nothing. This spawns its own instance with its own
// --user-data-dir (also: nothing from a previous run can make an assertion pass) and a
// BEACON_GATEWAY_HOST so startup takes the 'connect' path instead of the first-run wizard, which
// has no Connection Settings to open.
import { spawn } from 'node:child_process'
import { mkdtempSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const PORT = 9400 + (process.pid % 500)
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-settings-probe-'))

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

// `detached` so the whole process GROUP can be signalled: npx spawns Electron as a GRANDCHILD,
// so signalling npx alone leaves a GUI app running with a temp user-data-dir after every run.
const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1' }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))
// Reap for real. A bare SIGTERM followed by process.exit() loses the race — the probe is gone
// before Electron acts on the signal — and every run then leaks a GUI app holding a temp
// user-data-dir. Escalate to SIGKILL and wait for the exit before leaving.
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
async function reapAndExit(code) {
  reap()
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
    if (page) break
  } catch { /* not up yet */ }
}
if (!page) {
  console.log('NO PAGE TARGET — main log tail:\n' + mainLog.join('').slice(-1500))
  await reapAndExit(2)
}
console.log(`[cdp] attached: ${page.url.split('/').slice(-1)[0]}  (own user-data-dir)`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { pending.set(++msgId, res); ws.send(JSON.stringify({ id: msgId, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? 'exception' }
  return r.result?.result?.value
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}

// The real 1548-byte dump shape: `404 Not Found` + the whole header map, cookies included.
// The dump at its REAL size. The wire response (captured 2026-09-15) serialises to 1548 bytes;
// an undersized stand-in is the failure mode this probe is most likely to have — at 617 chars the
// pre-fix modal still fitted a 760px window, so the control passed while proving nothing.
const HEADER_MAP = JSON.stringify({
  date: 'Tue, 15 Sep 2026 23:41:37 GMT',
  'content-type': 'text/plain; charset=utf-8',
  vary: 'X-PJAX, X-PJAX-Container, Turbo-Visit, Turbo-Frame, X-Requested-With, X-GitHub-Client-Version,Accept-Encoding, Accept, X-Requested-With',
  'cache-control': 'no-cache',
  'strict-transport-security': 'max-age=31536000; includeSubdomains; preload',
  'content-security-policy': "default-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'unsafe-inline'",
  'x-frame-options': 'deny',
  'x-content-type-options': 'nosniff',
  'x-xss-protection': '0',
  'referrer-policy': 'origin-when-cross-origin, strict-origin-when-cross-origin',
  server: 'github.com',
  'set-cookie': [
    `_gh_sess=${'Ab3%xY9-'.repeat(52)}; path=/; HttpOnly; secure; SameSite=Lax`,
    `_octo=GH1.1.${'7f2a91c4'.repeat(4)}; expires=Wed, 15 Sep 2027 23:41:37 GMT; domain=.github.com; path=/; secure; SameSite=Lax`,
    'logged_in=no; expires=Wed, 15 Sep 2027 23:41:37 GMT; domain=.github.com; path=/; HttpOnly; secure; SameSite=Lax'
  ],
  'content-length': '9',
  'x-github-request-id': 'C622:1E81:C5B77:FAABB:6AA9D7B1',
  'x-github-edge-region': 'iad'
}, null, 2)
const DUMP = `404 Not Found\nHeaders: ${HEADER_MAP}`
if (DUMP.length < 1400) { console.log(`FATAL: probe fixture is only ${DUMP.length} chars — too small to reproduce the bug.`); process.exit(6) }

console.log('\n=== settings dialog: the action row survives a worst-case update error ===')
await sleep(2500)
// Pin the viewport: whether a 1548-char dump overflows must not depend on the tester's monitor.
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false })
await sleep(400)
console.log(`  (viewport pinned to 1000x700; fixture ${DUMP.length} chars)`)

// Open Connection Settings the way a person does — the app menu's Preferences broadcast.
const opened = await evaluate(`(() => {
  window.dispatchEvent(new Event('beacon:open-settings'))
  return true
})()`)

// The event name is a guess; fall back to finding and clicking the real control.
await sleep(600)
let present = await evaluate(`!!document.querySelector('h2')?.textContent?.includes('Connection Settings')`)
if (!present) {
  await evaluate(`(() => {
    const all = [...document.querySelectorAll('button,[role=button],a')]
    const b = all.find((e) => /settings|preferences/i.test(e.getAttribute('title') || e.textContent || ''))
    if (b) b.click()
    return !!b
  })()`)
  await sleep(800)
  present = await evaluate(`!!document.querySelector('h2')?.textContent?.includes('Connection Settings')`)
}
ok(present, 'Connection Settings dialog is open', present ? '' : 'could not open it — every measurement below would be vacuous')
if (!present) { console.log('  main log tail: ' + mainLog.join('').slice(-600)); console.log(`\nFAIL (${failures})\n`); await reapAndExit(1) }

// Since 0.4.7 the address, the key and the Test / Save & test row sit under Advanced, closed by default: open it, since the action row
// is what this probe measures.
const advancedOpened = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((e) => /^Advanced/.test((e.textContent || '').trim()))
  if (!b) return false
  if (b.getAttribute('aria-expanded') !== 'true') b.click()
  return true
})()`)
await sleep(400)
ok(advancedOpened, 'Advanced opened (the action row lives there since 0.4.7)')

// Locate the pieces by role, not by index.
const setup = await evaluate(`(() => {
  const h2 = [...document.querySelectorAll('h2')].find((e) => /Connection Settings/.test(e.textContent))
  const modal = h2.parentElement.parentElement
  const save = [...modal.querySelectorAll('button')].find((b) => /Save & test/.test(b.textContent))
  const updates = [...modal.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Updates')
  const detail = updates && updates.nextElementSibling
  window.__probe = { modal, save, detail }
  return { hasModal: !!modal, hasSave: !!save, hasDetail: !!detail }
})()`)
ok(setup.hasModal && setup.hasSave && setup.hasDetail, 'found modal, Save & test button, and the Updates detail line',
   JSON.stringify(setup))

const measure = `(() => {
  const { modal, save, detail } = window.__probe
  const m = modal.getBoundingClientRect(), s = save.getBoundingClientRect(), d = detail.getBoundingClientRect()
  return {
    vh: window.innerHeight,
    modalH: Math.round(m.height), modalBottom: Math.round(m.bottom), modalTop: Math.round(m.top),
    saveBottom: Math.round(s.bottom), saveTop: Math.round(s.top), saveH: Math.round(s.height),
    detailH: Math.round(d.height),
    saveOnScreen: s.top >= 0 && s.bottom <= window.innerHeight,
    saveInsideModal: s.bottom <= m.bottom + 1,
    detailChars: detail.textContent.length
  }
})()`

const baseline = await evaluate(measure)
ok(baseline.saveOnScreen, 'baseline: Save & test is on screen before any error', `bottom ${baseline.saveBottom} / vh ${baseline.vh}`)

// ── inject the worst case ────────────────────────────────────────────────────────────────────
await evaluate(`(() => { window.__probe.detail.textContent = ${JSON.stringify(DUMP)}; return true })()`)
await sleep(300)
const withDump = await evaluate(measure)
ok(withDump.detailChars > 500, 'the dump really is in the panel', `${withDump.detailChars} chars`)
ok(withDump.saveOnScreen, 'FIXED: Save & test is STILL on screen with the dump rendered',
   `save bottom ${withDump.saveBottom} / vh ${withDump.vh}`)
ok(withDump.saveInsideModal, 'FIXED: Save & test is still inside the modal', `save ${withDump.saveBottom} vs modal ${withDump.modalBottom}`)
ok(withDump.modalH <= withDump.vh, 'FIXED: the modal never exceeds the viewport', `${withDump.modalH} <= ${withDump.vh}`)
ok(withDump.detailH <= 60, 'FIXED: the detail line is clamped to ~3 lines', `${withDump.detailH}px`)
await (async () => {
  if (!process.env.BEACON_PROBE_SHOTS) return
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) (await import('node:fs')).writeFileSync(join(process.env.BEACON_PROBE_SHOTS, '01-with-the-fix.png'), Buffer.from(r.result.data, 'base64'))
})()

// ── the bearer-token badge tells the truth about what is PERSISTED ──────────────────────────
// It used to read straight off the store's hasToken, so it said "· saved" while you were typing a
// replacement and kept saying it if the save never landed — which is exactly what happened while
// the action row was off-screen. Typing must change it; only a real save may say "saved".
const badgeBefore = await evaluate(`(() => {
  const { modal } = window.__probe
  const span = [...modal.querySelectorAll('span')].find((e) => /^· (saved|none|unsaved)/.test(e.textContent.trim()))
  window.__badge = span
  const input = modal.querySelector('input[type=password]')
  window.__tokenInput = input
  return { text: span ? span.textContent.trim() : null, hasInput: !!input }
})()`)
ok(!!badgeBefore.text && badgeBefore.hasInput, 'found the bearer-token badge and field', JSON.stringify(badgeBefore))

// Type into the field the way React sees it (native setter + input event).
await evaluate(`(() => {
  const el = window.__tokenInput
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, 'a-typed-but-unsaved-token')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(300)
const badgeAfter = await evaluate(`(() => {
  const { modal } = window.__probe
  const span = [...modal.querySelectorAll('span')].find((e) => /^· /.test(e.textContent.trim()))
  return span ? span.textContent.trim() : null
})()`)
ok(/unsaved/.test(badgeAfter || ''), 'typing a token flips the badge to "unsaved"', `"${badgeBefore.text}" -> "${badgeAfter}"`)
ok(!/^· saved$/.test(badgeAfter || ''), 'the badge never claims "saved" for text that was only typed', `"${badgeAfter}"`)

// ── the Updates panel asks for nothing: the feed is public ───────────────────────────────────
// Until 0.3.0 this panel had an update-token field (a GitHub PAT for the private feed). The feed is
// the public OAraLabs/beacon now, so the panel has no field at all. Located first, then counted, so
// the absence is measured inside a container that was found — not asserted about a name that could
// never appear.
const updatesPanel = await evaluate(`(() => {
  const { modal } = window.__probe
  const heading = [...modal.querySelectorAll('div')].find((e) => e.textContent.trim() === 'Updates' && e.children.length === 0)
  if (!heading) return { found: false }
  const panel = heading.parentElement
  return {
    found: true,
    hasCheck: [...panel.querySelectorAll('button')].some((b) => /Check for updates|Working/.test(b.textContent)),
    inputs: panel.querySelectorAll('input').length,
    // The detail line is excluded: it holds whatever this probe injected above, not the panel's copy.
    mentionsToken: /token/i.test([...panel.childNodes].filter((n) => n !== window.__probe.detail).map((n) => n.textContent).join(' '))
  }
})()`)
ok(updatesPanel.found && updatesPanel.hasCheck, 'found the Updates panel (heading + Check for updates)', JSON.stringify(updatesPanel))
ok(updatesPanel.found && updatesPanel.inputs === 0, 'the Updates panel has no input — no update token to enter', `${updatesPanel.inputs} input(s)`)
ok(updatesPanel.found && !updatesPanel.mentionsToken, 'the Updates panel never mentions a token')

// ── the control: undo the fix's CSS in the live DOM and confirm the bug reproduces ───────────
await evaluate(`(() => {
  const { modal, detail } = window.__probe
  modal.style.maxHeight = 'none'
  detail.style.webkitLineClamp = 'unset'
  detail.style.display = 'block'
  detail.style.overflow = 'visible'
  const body = detail.closest('div[style*="overflow"]')
  if (body) { body.style.overflowY = 'visible'; body.style.minHeight = 'auto' }
  return true
})()`)
await sleep(300)
// BEACON_PROBE_SHOTS=<dir> writes before/after PNGs — a layout claim is worth looking at.
const SHOTS = process.env.BEACON_PROBE_SHOTS
const shoot = async (name) => {
  if (!SHOTS) return
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const data = r.result?.data
  if (data) { (await import('node:fs')).writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')) }
}
const unfixed = await evaluate(measure)
await shoot('02-without-the-fix.png')
console.log('  -- control: the same dump with the fix\'s CSS removed --')
ok(!unfixed.saveOnScreen || unfixed.modalH > unfixed.vh,
   'CONTROL: without the fix the dialog really does overflow (the bug reproduces)',
   `modal ${unfixed.modalH}px vs vh ${unfixed.vh}, save bottom ${unfixed.saveBottom}, detail ${unfixed.detailH}px`)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
await reapAndExit(failures === 0 ? 0 : 1)
