#!/usr/bin/env node
// plain-lan-app-probe — the BUILT app refusing new plain connections to the home network (src/shared/plain-lan.ts), and keeping a
// saved one working with its one-line notice.
//
//   npm run build && node scripts/plain-lan-app-probe.mjs
//
// A plain fake Prometheus (REST and the WebSocket) on 127.0.0.1, ephemeral ports. BEACON_HOME_NETWORK_HOSTS=127.0.0.1 makes the
// app treat 127.0.0.1 as a home-network address (a non-release build only): the stand-in for a LAN address, so nothing here listens
// or connects beyond loopback.
//   1. a plain connection to it saved before (seeded): Beacon still connects, and says "Not encrypted — update Prometheus and
//      turn on home network." in the connection popover and in Settings;
//   2. Settings: re-saving the saved addresses works; a new plain address there is refused with the words; so is a Test; and the
//      older ways in (an address and token; a 6-digit setup code) refuse one too;
//   3. onboarding, a typed address there that speaks only plain: "not encrypted" words, and it was never asked in plain.
// macOS (app-driver). No daemon, no Keychain (no credential is saved).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'
import { savedConnection } from './lib/profile-db.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]
let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 8
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})
const NOTICE = 'Not encrypted — update Prometheus and turn on home network.'
const REFUSED = 'Beacon only connects to computers on your home network over an encrypted connection. Update Prometheus on that computer and turn on home network, then connect to it again.'

// ── the fake Prometheus: plain ───────────────────────────────────────────────────────────────────────────────────────────────
const seen = { hellos: 0, requests: 0, notHttp: 0 }
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const rest = createServer((req, res) => {
  seen.requests++
  if (req.url === '/api/hello') {
    seen.hellos++
    return json(res, 200, { v: '0.9.6', name: 'Old Prometheus', agent: 'Prometheus', fp: '0123456789abcdef', pair: 'approve', tls: false })
  }
  if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  json(res, 200, [])
})
rest.on('clientError', (_e, sock) => (seen.notHttp++, sock.destroy()))
const wsHttp = createServer()
const wss = new WebSocketServer({ server: wsHttp })
wss.on('connection', (ws) => {
  ws.on('error', () => {})
  ws.send(JSON.stringify({ type: 'connected' }))
})
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
await new Promise((r) => wsHttp.listen(0, '127.0.0.1', r))
const API = rest.address().port
const WS = wsHttp.address().port
if ([API, WS].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
const other = createServer((_q, res) => json(res, 200, {}))
await new Promise((r) => other.listen(0, '127.0.0.1', r))
const OTHER = other.address().port
// 127.0.0.2: a stand-in nothing listens on (macOS has only 127.0.0.1 on lo0), for the two ways in that always use 8005/8010.
process.env.BEACON_HOME_NETWORK_HOSTS = '127.0.0.1,127.0.0.2'

const profile = mkdtempSync(join(tmpdir(), 'beacon-plain-lan-probe-'))
execFileSync('sqlite3', [
  join(profile, 'beacon.db'),
  `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
   INSERT INTO gateway_profiles VALUES ('mini', 'http://127.0.0.1:${API}', 'ws://127.0.0.1:${WS}', 1, NULL);`
])
const fresh = mkdtempSync(join(tmpdir(), 'beacon-plain-lan-probe-fresh-'))
const row = () => savedConnection(profile).replace(/\|[^|]*$/, '') // 'api_base|ws_url' (lib/profile-db.mjs, either layout)
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
async function click(app, selector, label) {
  const at = await app.page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => ${label ? `b.innerText.trim().split('\\n')[0].trim().replace(/\\s*↗$/, '') === ${JSON.stringify(label)}` : 'true'}); if (!el || el.disabled) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === el || el.contains(h)) } })()`)
  if (!at?.hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}

let app = null
try {
  // 1. the saved plain connection keeps working, with the notice
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  const up = await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)
  const st = await app.page.evaluate('window.beacon.connection.status()')
  check(!!up && st.notEncrypted === true && seen.requests > 0, 'a plain home-network connection saved before keeps working (connected), and its status says it is not encrypted', JSON.stringify({ st, seen }))
  const opened = await click(app, '.host-chip-btn')
  const popover = await until(() => app.page.evaluate(`document.querySelector('[role="dialog"][aria-label="Connection details"] [data-testid="not-encrypted-notice"]')?.innerText ?? null`), 5000)
  const settings = await app.page.evaluate('window.beacon.connection.getSettings()')
  check(opened && popover === NOTICE && settings.notEncrypted === true, 'the notice, in one line, in the connection popover (clicked) and for Settings', JSON.stringify({ opened, popover, settings }))

  // 2. Settings
  const resave = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://127.0.0.1:${API}', wsUrl: 'ws://127.0.0.1:${WS}' })`)
  check(resave?.saved === true && row() === `http://127.0.0.1:${API}|ws://127.0.0.1:${WS}`, "Settings: re-saving the saved plain addresses still works (it is not a new connection)", JSON.stringify({ resave, row: row() }))
  const before = seen.requests
  const moved = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://127.0.0.1:${OTHER}', wsUrl: 'ws://127.0.0.1:${OTHER}' })`)
  const tested = await app.page.evaluate(`window.beacon.connection.test({ apiBase: 'http://127.0.0.1:${OTHER}', wsUrl: 'ws://127.0.0.1:${OTHER}' })`)
  check(moved?.saved === false && moved.error === REFUSED && tested?.ok === false && tested.label === REFUSED && row() === `http://127.0.0.1:${API}|ws://127.0.0.1:${WS}`, 'Settings: a NEW plain home-network address is refused with the words, and so is a Test of one; nothing saved', JSON.stringify({ moved, tested, row: row() }))
  void before
  const setupSave = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.2', token: '' })`)
  const setupPair = await app.page.evaluate(`window.beacon.setup.pair({ address: '127.0.0.2', code: '123456' })`)
  check(setupSave?.ok === false && setupSave.error === REFUSED && setupPair?.ok === false && setupPair.error === REFUSED && row() === `http://127.0.0.1:${API}|ws://127.0.0.1:${WS}`, 'the older ways in refuse one too: an address with a token, and a 6-digit setup code (sent nowhere); nothing saved', JSON.stringify({ setupSave, setupPair, row: row() }))
  await app.quit()
  app = null

  // 3. onboarding, a typed address there that speaks only plain
  process.env.BEACON_ONBOARDING = 'v4'
  process.env.BEACON_DISCOVERY_SOURCES = 'loopback'
  process.env.BEACON_DISCOVERY_PORT = String(OTHER + 0) // nothing Prometheus-like there: loopback finds nothing
  other.close()
  app = await launchApp({ profile: fresh, readySelector: '[data-screen]' })
  const scr = () => app.page.evaluate(`document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null`)
  const onScr = (id, ms = 10000) => until(async () => ((await scr()) === id ? id : null), ms)
  await click(app, '[data-screen] button, [data-screen] a', 'Get started')
  await onScr('W2')
  await click(app, '[data-screen] button, [data-screen] a', 'Yes, connect to it')
  await click(app, '[data-screen] button, [data-screen] a', 'Continue')
  if ((await onScr('B1', 3000)) === 'B1') await click(app, '[data-screen] button, [data-screen] a', 'Continue')
  await onScr('B-empty', 15000)
  await click(app, '[data-screen] button, [data-screen] a', 'Advanced')
  const adv = await onScr('B-adv')
  await app.page.evaluate(`(() => { const el = document.querySelector('[data-screen] input'); el.focus(); return true })()`)
  await app.page.send('Input.insertText', { text: `127.0.0.1:${API}` })
  const hellosBefore = seen.hellos
  const notHttpBefore = seen.notHttp
  const found = await click(app, '[data-screen] button, [data-screen] a', 'Find it')
  const error = await until(() => app.page.evaluate(`document.querySelector('.setup-error')?.innerText ?? null`), 10000)
  check(adv === 'B-adv' && found && !!error && /encrypted connection/.test(error) && /update it and turn on home network/.test(error), 'onboarding, a typed home-network address that speaks only plain: the "not encrypted" words', JSON.stringify({ adv, found, error }))
  check(seen.notHttp > notHttpBefore && seen.hellos === hellosBefore, 'and it was asked over TLS only: never in plain', JSON.stringify({ notHttp: seen.notHttp - notHttpBefore, hellos: seen.hellos - hellosBefore }))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const s of [rest, wsHttp, other]) {
    s.closeAllConnections?.()
    s.close()
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
