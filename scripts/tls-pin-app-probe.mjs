#!/usr/bin/env node
// tls-pin-app-probe — the BUILT app holding a home-network Prometheus to its pinned key (docs/MULTI-COMPUTER-v0.4.md §3.3, §3.4).
//
//   npm run build && node scripts/tls-pin-app-probe.mjs [screenshot.png]
//
// A fake Prometheus on 127.0.0.1 speaking only TLS (REST and the WebSocket, each its own port, one self-signed P-256 key, A), and a
// scratch Beacon profile whose saved connection is https/wss with A's pin, seeded the way a join over TLS saves it. Then:
//   1. Beacon comes up connected through the self-signed certificate, by its key alone (REST answered, the WebSocket upgraded);
//   2. the fake starts presenting another key (B): on the redial Beacon sends it NOTHING (no request, no upgrade) and says so at
//      once, with the §3.4 card ("This isn't the Prometheus you connected to");
//   3. the fake presents A again: Beacon reconnects and the card goes;
//   4. Settings' Save (the page's own bridge, what the form calls): the same addresses keep the pin and reconnect by it; http:// and
//      ws:// for the pinned computer are refused and nothing is saved (no way around the card through Settings).
// macOS (app-driver). No daemon, no Keychain (no credential is saved; the fake does not ask for one), ephemeral ports.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k.startsWith('PROMETHEUS_')) delete process.env[k]
const SHOT = process.argv[2] ?? null
let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 12
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'beacon-tls-probe-'))
function cert(name) {
  const k = join(dir, `${name}.key`)
  const c = join(dir, `${name}.crt`)
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '2', '-subj', `/CN=prometheus-${name}.local`], { stdio: 'ignore' })
  const pem = readFileSync(c, 'utf8')
  const spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  return { key: readFileSync(k, 'utf8'), cert: pem, pin: createHash('sha256').update(spki).digest('hex') }
}
const A = cert('a')
const B = cert('b')

// ── the fake Prometheus: TLS only ──────────────────────────────────────────────────────────────────────────────────────────
const seen = { requests: 0, upgrades: 0 }
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
const rest = createServer({ key: A.key, cert: A.cert }, (req, res) => {
  seen.requests++
  if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 })
  json(res, 200, [])
})
const wsHttps = createServer({ key: A.key, cert: A.cert })
const wss = new WebSocketServer({ noServer: true })
wsHttps.on('upgrade', (req, socket, head) => {
  seen.upgrades++
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {})
    ws.send(JSON.stringify({ type: 'connected' }))
  })
})
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
await new Promise((r) => wsHttps.listen(0, '127.0.0.1', r))
const API = rest.address().port
const WS = wsHttps.address().port
if ([API, WS].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
/** Present another key from the next connection on, and drop every connection open now (so a redial is a new handshake). */
function present(c) {
  for (const s of [rest, wsHttps]) {
    s.setSecureContext({ key: c.key, cert: c.cert })
    s.closeAllConnections()
  }
  for (const client of wss.clients) client.terminate()
}

// The computer is reached by a .local name, the way a join from Bonjour saves it (prometheus-<fp8>.local in real life): a
// LocalOnly mDNS record for 127.0.0.1, under a probe-only service type so no Prometheus browser ever sees it. macOS resolves an
// IPv4-only .local name in ~5 s unless asked for IPv4 (see localLookupWith); a reconnect has to be quick anyway.
const HOST = `beacon-tls-probe-${process.pid}.local`
const mdns = spawn('/usr/bin/dns-sd', ['-lo', '-t', '120', '-P', 'Beacon TLS probe', '_beacon-probe._tcp', 'local', String(API), HOST, '127.0.0.1'], { stdio: 'ignore' })
// The app is launched only once the name resolves: what is measured below is Beacon's lookup, not the registration's start-up.
const { lookup } = await import('node:dns/promises')
let resolved = false
for (let i = 0; i < 40 && !resolved; i++) {
  resolved = await lookup(HOST, { family: 4 }).then((r) => r.address === '127.0.0.1', () => false)
  if (!resolved) await sleep(250)
}
if (!resolved) throw new Error(`${HOST} never resolved: the probe cannot run`)

// ── a scratch profile with the pinned connection, saved the way a join over TLS saves it ─────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'beacon-tls-probe-profile-'))
execFileSync('sqlite3', [
  join(profile, 'beacon.db'),
  `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
   INSERT INTO gateway_profiles VALUES ('mini', 'https://${HOST}:${API}', 'wss://${HOST}:${WS}', 1, '${A.pin}');`
])

let app = null
const status = () => app.page.evaluate('window.beacon.connection.status()')
const cardText = () => app.page.evaluate(`document.querySelector('[data-testid="wrong-key-card"]')?.innerText ?? null`)
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
try {
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  const up = await until(async () => (await status())?.state === 'connected', 15000)
  check(!!up && seen.requests > 0 && seen.upgrades >= 1, 'connected by the pin alone: the self-signed certificate is accepted by its key (REST answered, the WebSocket upgraded)', JSON.stringify({ status: await status(), seen }))
  check((await cardText()) === null, 'no card while the key is the pinned one')
  const t0 = Date.now()
  await app.page.evaluate('window.beacon.connection.reconnect()')
  await sleep(150)
  const quick = await until(async () => (await status())?.state === 'connected', 15000)
  const took = Date.now() - t0
  check(!!quick && took < 2500, `a reconnect by its .local name takes ${took} ms (IPv4 first; with the default lookup alone Beacon did not connect within 15 s here)`, String(took))

  present(B)
  const before = { ...seen }
  await app.page.evaluate('window.beacon.connection.reconnect()')
  const wrong = await until(async () => (await status())?.wrongKey ?? null, 10000)
  check(!!wrong && wrong.pinned === A.pin && wrong.presented === B.pin, 'another key: the status names the pinned and the presented keys', JSON.stringify(wrong))
  const text = await until(cardText, 5000)
  check(!!text && text.includes("This isn't the Prometheus you connected to") && text.includes('sent it nothing') && text.includes('Connect again') && !/continue/i.test(text), 'the §3.4 card shows at once: its title, "sent it nothing", [Connect again], and no way to continue anyway', text)
  await sleep(2500) // let any redial happen
  check(seen.requests === before.requests && seen.upgrades === before.upgrades, 'and the computer presenting the other key got NOTHING: no request, no upgrade', JSON.stringify({ before, after: seen }))
  if (SHOT) {
    const shot = await app.page.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))
  }

  present(A)
  await app.page.evaluate('window.beacon.connection.reconnect()')
  const back = await until(async () => (await status())?.state === 'connected', 15000)
  const st = await status()
  check(!!back && !st.wrongKey, 'the pinned key again: connected, and the status no longer names a wrong key', JSON.stringify(st))
  check((await until(async () => (await cardText()) === null, 5000)) === true || (await cardText()) === null, 'and the card is gone')

  // 4. Settings' Save on the pinned connection (review of PR 244, F1).
  const row = () => spawnSync('/usr/bin/sqlite3', [`file:${join(profile, 'beacon.db')}?mode=ro`, `SELECT api_base || '|' || ws_url || '|' || COALESCE(pin, '') FROM gateway_profiles WHERE is_default = 1`], { encoding: 'utf8' }).stdout.trim()
  const pinnedRow = `https://${HOST}:${API}|wss://${HOST}:${WS}|${A.pin}`
  const same = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'https://${HOST}:${API}', wsUrl: 'wss://${HOST}:${WS}' })`)
  const again = await until(async () => (await status())?.state === 'connected', 15000)
  check(same?.saved === true && row() === pinnedRow && !!again && !(await status()).wrongKey, "Settings' Save with the same addresses: the pin is kept, and Beacon reconnects by it", JSON.stringify({ same, row: row(), status: await status() }))
  const plain = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://${HOST}:${API}', wsUrl: 'ws://${HOST}:${WS}' })`)
  check(plain?.saved === false && /https:\/\//.test(plain?.error ?? '') && row() === pinnedRow, "Settings' Save with http:// and ws:// for the pinned computer: refused with why, and nothing saved", JSON.stringify({ plain, row: row() }))
  const plainTry = spawnSync('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', `http://127.0.0.1:${API}/api/status`], { encoding: 'utf8' }).stdout
  check(plainTry === '000', 'the fake speaks TLS only (a plain request to it gets no HTTP answer), so everything above went over TLS', plainTry)
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  mdns.kill('SIGTERM')
  for (const c of wss.clients) c.terminate()
  wss.close()
  for (const s of [rest, wsHttps]) {
    s.closeAllConnections()
    s.close()
  }
  // quit() returns before Electron's helpers stop writing the profile: retry, and never let cleanup turn a result into a crash.
  for (const d of [profile, dir]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (e) {
      console.log(`[probe] could not remove ${d}: ${e.code}`)
    }
  }
}
