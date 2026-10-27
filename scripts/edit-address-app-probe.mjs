// Settings → Connection, a new address where ANOTHER Prometheus answers (docs/MULTI-PROMETHEUS.md §6, Edit address), in the real app:
// a scratch profile connected to stand-in A; B, at another loopback port, answers hello with another fp. Saving B's address must save
// nothing and ask B only who it is, with no key; the form shows the card, and Add it keeps B as a new Prometheus beside A.
// No key is ever saved (no Keychain prompt), and the user's own profile is never touched.
//
//   npm run build && npm run probe:edit-address
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'
import { keptCount, savedConnection } from './lib/profile-db.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 7
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
function prometheus(fp) {
  const seen = []
  const rest = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization })
    if (req.url === '/api/hello') return json(res, 200, { v: '0.9.16', name: 'Stand-in', agent: 'Atlas', fp, pair: 'approve', tls: false })
    if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub' })
    json(res, 404, {})
  })
  const wsHttp = createServer()
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
  return { rest, wsHttp, seen }
}
const A = prometheus('a'.repeat(16))
const B = prometheus('b'.repeat(16))
for (const s of [A.rest, A.wsHttp, B.rest, B.wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const port = (s) => s.address().port
const [AAPI, AWS, BAPI, BWS] = [port(A.rest), port(A.wsHttp), port(B.rest), port(B.wsHttp)]

const profile = mkdtempSync(join(tmpdir(), 'beacon-p3c-probe-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('mini', 'http://127.0.0.1:${AAPI}', 'ws://127.0.0.1:${AWS}', 1, NULL);`])
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
let app = null
try {
  app = await launchApp({ profile })
  const up = await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)
  check(!!up, 'connected to A')
  const before = savedConnection(profile)
  const bBefore = B.seen.length
  const res = await app.page.evaluate(`window.beacon.connection.saveSettings({ apiBase: 'http://127.0.0.1:${BAPI}', wsUrl: 'ws://127.0.0.1:${BWS}' })`)
  check(res?.saved === false && res.other?.kind === 'different', 'the bridge: B at the new address is "different", not saved', JSON.stringify(res))
  check(savedConnection(profile) === before && keptCount(profile) === 1, 'nothing changed on disk', `${savedConnection(profile)} / ${keptCount(profile)}`)
  const bAsked = B.seen.slice(bBefore)
  check(bAsked.every((r) => r.path === '/api/hello' || r.path === '/api/identity/challenge') && bAsked.every((r) => !r.auth), 'B was only asked who it is, with no key', JSON.stringify(bAsked))

  // The real form: open Settings, Advanced, type B's addresses, Save; the card; Add it.
  await app.page.evaluate(`window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'connection' } }))`)
  await until(() => app.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.startsWith('Advanced: how Beacon reaches Prometheus'))`), 5000)
  // Opened at the connection section, Advanced starts open: click it only if the fields aren't showing.
  await app.page.evaluate(`document.querySelector('input[placeholder="http://host:8005"]') || [...document.querySelectorAll('button')].find((b) => b.innerText.startsWith('Advanced: how Beacon reaches Prometheus')).click()`)
  await until(() => app.page.evaluate(`!!document.querySelector('input[placeholder="http://host:8005"]')`), 3000)
  const set = (ph, v) => `(() => { const el = document.querySelector('input[placeholder="${ph}"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`
  await app.page.evaluate(set('http://host:8005', `http://127.0.0.1:${BAPI}`))
  await app.page.evaluate(set('ws://host:8010', `ws://127.0.0.1:${BWS}`))
  await app.page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Save & test' && !b.disabled)?.click()`)
  const card = await until(() => app.page.evaluate(`document.querySelector('[data-testid="edit-address-other"]')?.innerText ?? null`), 8000)
  check(!!card && card.includes("That's a different Prometheus. Add it as a new one?") && card.includes('Add it'), 'the form shows the card, with Add it', card)
  await app.page.evaluate(`[...document.querySelectorAll('[data-testid="edit-address-other"] button')].find((b) => b.innerText.trim() === 'Add it').click()`)
  const two = await until(async () => (keptCount(profile) === 2 ? 2 : null), 8000)
  check(two === 2 && savedConnection(profile).startsWith(`http://127.0.0.1:${BAPI}|`), 'Add it: B is kept as a new one and is the active one; A stays kept', `${savedConnection(profile)} / ${keptCount(profile)}`)
  const list = await app.page.evaluate('window.beacon.instances.list()')
  check(list.length === 2 && list.some((i) => i.active && i.host.endsWith(`:${BAPI}`)) && list.some((i) => !i.active && i.host.endsWith(`:${AAPI}`)), 'the list has both, B active', JSON.stringify(list))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const s of [A.rest, A.wsHttp, B.rest, B.wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
}
if (failures || checks < MIN_CHECKS) {
  console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
  process.exit(1)
}
console.log(`\n[probe] OK — ${checks} checks passed`)
