#!/usr/bin/env node
// plain-public-app-probe — the BUILT app refusing plain http/ws to an address that is not this computer, the home network or
// Tailscale (src/main/plain-public.ts, owner decision 2026-10-17 for 0.4.6), saved connections included, with words that say use https or
// Tailscale; and nothing sent there first.
//
//   npm run build && node scripts/plain-public-app-probe.mjs
//
// A plain fake Prometheus (REST and the WebSocket) on 127.0.0.1, ephemeral ports. BEACON_PUBLIC_HOSTS=127.0.0.1 makes the app
// treat 127.0.0.1 as a public address (a non-release build only): the stand-in for one on the internet, so nothing here listens
// or connects beyond loopback. The fake counts every request and every socket, so "nothing was sent" is a count, not a hope.
//   1. a plain connection to it saved before (seeded): Beacon does not connect, sends it nothing (no REST call, no socket), and
//      says why, in the words, where the connection is shown;
//   2. Settings: re-saving that saved address is refused too (unlike the home network's rule); so is a new one, and a Test; and
//      the older ways in (an address and key; a 6-digit setup code) refuse one too; nothing sent, nothing saved;
//   3. onboarding, a typed address that speaks only plain: the words, and it was never asked in plain.
// macOS (app-driver). No daemon, no Keychain (no credential is saved).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, profileDb, sleep } from './app-driver.mjs'

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
const MIN_CHECKS = 10
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})
const WORDS = /https:\/\//
const TAILSCALE = /Tailscale/
const says = (t) => typeof t === 'string' && WORDS.test(t) && TAILSCALE.test(t)

// ── the fake Prometheus: plain, counting everything ──────────────────────────────────────────────────────────────────────────
const seen = { requests: 0, sockets: 0, notHttp: 0, paths: [] }
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const rest = createServer((req, res) => {
  seen.requests++
  seen.paths.push(`${req.method} ${req.url}`)
  if (req.url === '/api/hello') return json(res, 200, { v: '0.9.13', name: 'Far Prometheus', agent: 'Prometheus', fp: '0123456789abcdef', pair: 'approve' })
  if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  if (req.url === '/api/setup/pair') return json(res, 200, { token: 'probe-token-never-kept' })
  json(res, 200, [])
})
rest.on('clientError', (_e, sock) => (seen.notHttp++, sock.destroy()))
const wsHttp = createServer()
const wss = new WebSocketServer({ server: wsHttp })
wss.on('connection', (ws) => {
  seen.sockets++
  ws.on('error', () => {})
  ws.send(JSON.stringify({ type: 'connected' }))
})
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
await new Promise((r) => wsHttp.listen(0, '127.0.0.1', r))
const API = rest.address().port
const WS = wsHttp.address().port
if ([API, WS].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
process.env.BEACON_PUBLIC_HOSTS = '127.0.0.1,127.0.0.3'

const profile = mkdtempSync(join(tmpdir(), 'beacon-plain-public-probe-'))
execFileSync('sqlite3', [
  join(profile, 'beacon.db'),
  `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
   INSERT INTO gateway_profiles VALUES ('far', 'http://127.0.0.1:${API}', 'ws://127.0.0.1:${WS}', 1, NULL);`
])
const fresh = mkdtempSync(join(tmpdir(), 'beacon-plain-public-probe-fresh-'))
const row = () => execFileSync('sqlite3', [`file:${profileDb(profile, 'beacon')}?mode=ro`, `SELECT api_base || '|' || ws_url FROM gateway_profiles WHERE is_default = 1`], { encoding: 'utf8' }).trim()
const SAVED = `http://127.0.0.1:${API}|ws://127.0.0.1:${WS}`
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
  // 1. the saved plain connection to a public address: not made, nothing sent, and why
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  // Every uncaught exception and unhandled rejection in main, recorded (with a listener present, Electron shows no native dialog:
  // Will saw "A JavaScript error occurred in the main process" from the connection test's socket timeout during a mutation run).
  // Before the probe adds its own: the app's floor (src/main/index.ts), so no exception reaches a dialog whatever its cause.
  // By name: something else in main already listens for uncaughtException, so a count proved nothing (a mutation survived it).
  const floor = await app.mainEval(`process.listeners('uncaughtException').some((f) => f.name === 'beaconNoDialogException') && process.listeners('unhandledRejection').some((f) => f.name === 'beaconNoDialogRejection')`)
  await app.mainEval(`(() => { globalThis.__uncaught = []; process.on('uncaughtException', (e) => globalThis.__uncaught.push('exception: ' + String(e && e.stack || e).slice(0, 300))); process.on('unhandledRejection', (e) => globalThis.__uncaught.push('rejection: ' + String(e && e.stack || e).slice(0, 300))); return true })()`)
  const st = await until(async () => {
    const s = await app.page.evaluate('window.beacon.connection.status()')
    return s?.refused ? s : null
  }, 10000)
  await sleep(3000) // long enough for a dial, a REST read and a retry, had any been made
  const body = await app.page.evaluate('document.body.innerText')
  check(!!st && says(st.refused) && st.state !== 'connected', 'a plain connection to a public address saved before is not made: its status carries the words (use https or Tailscale)', JSON.stringify(st))
  check(seen.requests === 0 && seen.sockets === 0, 'and nothing was sent there: no REST call, no socket (the key never left)', JSON.stringify(seen))
  check(
    await app.page.evaluate(`(() => { const c = document.querySelector('[data-testid="plain-public-card"]'); return !!c && c.getBoundingClientRect().width > 0 && /https:\\/\\//.test(c.innerText) && /Tailscale/.test(c.innerText) })()`),
    'the words are on screen, in the connection card',
    body.replace(/\s+/g, ' ').slice(0, 300)
  )
  // (A fixed card has no offsetParent, so it is measured.) Mission, where the app opens, in the refused state: a calm state or nothing on every card, never an error (Will saw PLANS print
  // "Could not load stories: Error invoking remote method 'daemon:get': Error: Beacon …").
  const RAW = /Could not load|Failed to list|Error invoking|Error:|HTTP \d{3}|\/api\/|Catalog unavailable|— · — · —|\bup 0s\b|daemon unreachable|Not authorized|Authentication failed/
  const card = await app.page.evaluate(`document.querySelector('[data-testid="plain-public-card"]')?.innerText ?? ''`)
  const mission = body.replace(card, '')
  check(!RAW.test(mission), 'Mission in the refused state: no card shows an error, a route or a placeholder reading', (mission.match(RAW) ?? [''])[0] + ' … ' + mission.replace(/\s+/g, ' ').slice(0, 300))

  // 2. Settings and the older ways in
  const resave = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://127.0.0.1:${API}', wsUrl: 'ws://127.0.0.1:${WS}' })`)
  const moved = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://127.0.0.3:${API}', wsUrl: 'ws://127.0.0.3:${WS}' })`)
  const tested = await app.page.evaluate(`window.beacon.connection.test({ apiBase: 'http://127.0.0.1:${API}', wsUrl: 'ws://127.0.0.1:${WS}' })`)
  check(
    resave?.saved === false && says(resave.error) && moved?.saved === false && says(moved.error) && tested?.ok === false && says(tested.label) && row() === SAVED,
    'Settings: re-saving the saved plain public address is refused too (unlike the home network), so is a new one, and a Test of one; nothing saved',
    JSON.stringify({ resave, moved, tested, row: row() })
  )
  const setupSave = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${API}, wsPort: ${WS}, token: '' })`)
  const setupPair = await app.page.evaluate(`window.beacon.setup.pair({ address: '127.0.0.1', code: '123456' })`)
  check(
    setupSave?.ok === false && says(setupSave.error) && setupPair?.ok === false && says(setupPair.error) && row() === SAVED && seen.requests === 0,
    'the older ways in refuse one too (an address with a key; a 6-digit setup code): the words, nothing sent, nothing saved',
    JSON.stringify({ setupSave, setupPair, row: row(), seen })
  )
  // A Test of an address that is allowed but never answers (127.0.0.2: nothing there): the socket times out while still connecting,
  // which is the path that took main down. It must come back as words, with nothing uncaught.
  const silent = await app.page.evaluate(`window.beacon.connection.test({ apiBase: 'http://127.0.0.2:${API}', wsUrl: 'ws://127.0.0.2:${WS}' })`)
  await sleep(1500)
  const uncaught = await app.mainEval('JSON.stringify(globalThis.__uncaught ?? null)')
  check(
    silent && silent.ok === false && uncaught === '[]' && floor === true,
    "a Test of an address where nothing answers ends in words, nothing in main was uncaught, and the app's own handlers keep any future one from a native dialog",
    `${JSON.stringify(silent)} ${uncaught} floor=${floor}`
  )
  await app.quit()
  app = null

  // 3. onboarding, a typed address that speaks only plain
  process.env.BEACON_DISCOVERY_SOURCES = 'loopback'
  process.env.BEACON_DISCOVERY_PORT = '9' // nothing there: loopback finds nothing, so W2 asks the plain question
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
  const before = { ...seen }
  const found = await click(app, '[data-screen] button, [data-screen] a', 'Find it')
  const error = await until(() => app.page.evaluate(`document.querySelector('.setup-error')?.innerText ?? null`), 10000)
  // Onboarding keeps to its own plain-words list (src/shared/onboarding-banned-words.json bans "HTTPS", "Tailscale" and "address"), so
  // it says the same thing without them and points to "Need help?" (the setup guide) for the secure ways.
  check(
    adv === 'B-adv' && found && /outside your home network/.test(error ?? '') && /encrypted connection/.test(error ?? '') && /Need help\?/.test(error ?? ''),
    'onboarding, a typed public address that speaks only plain: in its own plain words (outside your home network, not encrypted, where to look)',
    JSON.stringify({ adv, found, error })
  )
  check(seen.requests === before.requests && seen.sockets === before.sockets, 'and it was never asked in plain', JSON.stringify({ before, after: seen }))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) {
    s.closeAllConnections?.()
    s.close()
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
