// "Add a phone" in the real app (@shared/phone-join): a stand-in Prometheus with a real Ed25519 node key, reached at 127.0.0.1, and this
// Mac's tailnet from a fixture (BEACON_TAILNET_STATUS_FILE; BEACON_PHONE_JOIN_PORT stands in for 8005: both read by debuggable builds
// only). From Mission Control the title bar's switcher offers "Add a phone…"; its QR is exactly beacon://join with this Mac's Tailscale
// short name, the node key Beacon pinned (in hex) and the name, and nothing else: no number address, no token. Config → Devices has the
// same entry. A Prometheus that listens to its own computer only gets words that say what to do instead of a code.
//
//   npm run build && npm run probe:add-phone
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 10
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const NODE_B64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')
const NODE_HEX = Buffer.from(NODE_B64, 'base64').toString('hex')
const INSTANCE = randomUUID()
const net = { mode: 'home_network', bind: '0.0.0.0' }
const message = (nonce, at) => ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${INSTANCE}`, `node_pub=${NODE_B64}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')
const seen = []
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push(req.url ?? '')
    if (req.url === '/api/hello') return json(res, 200, { v: '0.9.20', name: 'Stand-in', agent: 'Atlas', fp: 'a'.repeat(16), pair: 'approve', tls: false })
    if (req.url === '/api/identity/challenge') {
      const nonce = JSON.parse(body || '{}').nonce ?? ''
      const at = Math.floor(Date.now() / 1000)
      return json(res, 200, { v: 1, instance_id: INSTANCE, node_pub: NODE_B64, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, at)), privateKey).toString('base64') })
    }
    if (req.url === '/api/network') return json(res, 200, { ...net, tls: null, advertising: false, advertising_reason: null, applied: 'live', warnings: [], can_change: true })
    if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub' })
    if (req.url === '/api/devices') return json(res, 200, { devices: [] })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const PORT = rest.address().port

const profile = mkdtempSync(join(tmpdir(), 'beacon-add-phone-'))
const tailnetFile = join(profile, 'tailnet-status.json')
const TS_SELF = ['100', '101', '102', '103'].join('.') // the CGNAT shape Tailscale uses, built at run time (no literal in the source)
writeFileSync(tailnetFile, JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-computer.tail0000.ts.net.', TailscaleIPs: [TS_SELF] }, Peer: {} })) // precommit:allow-example-host
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('Home mini', 'http://127.0.0.1:${PORT}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])
Object.assign(process.env, { BEACON_TAILNET_STATUS_FILE: tailnetFile, BEACON_PHONE_JOIN_PORT: String(PORT) })

const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const DIALOG = `document.querySelector('[role="dialog"][aria-label="Add a phone"]')`
const covered = `(() => { const root = ${DIALOG}; if (!root) return null; const drag = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).webkitAppRegion === 'drag').map((e) => e.getBoundingClientRect()); return [...root.querySelectorAll('button, select')].filter((e) => { const q = e.getBoundingClientRect(); const x = q.x + q.width / 2, y = q.y + q.height / 2; return drag.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) }).length })()`
const close = () => app.page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)

let app = null
try {
  app = await launchApp({ profile })
  await app.mainEval(`(() => { __electron.BrowserWindow.getAllWindows()[0].setContentSize(1512, 944); return true })()`)
  check(!!(await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)), 'connected to the stand-in, reached at 127.0.0.1')
  const pinned = await until(async () => ((await app.page.evaluate('window.beacon.instances.list()'))[0]?.proved ? true : null), 8000)
  check(!!pinned, 'its node key is pinned (it proved who it is)')

  // From Mission Control: the title bar's switcher → Add a phone….
  await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Mission"]')?.click(); true`)
  await sleep(400)
  await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]').click(); true`)
  const item = await until(() => app.page.evaluate(`document.querySelector('[data-testid="title-switcher"] [data-testid="phone-add"]')?.innerText ?? null`), 3000)
  check(item === 'Add a phone…', 'the switcher offers "Add a phone…"', item)
  await app.page.evaluate(`document.querySelector('[data-testid="title-switcher"] [data-testid="phone-add"]').click(); true`)
  const url = await until(() => app.page.evaluate(`${DIALOG}?.querySelector('[data-testid="phone-join"]')?.dataset.url ?? null`), 5000)
  check(url === `beacon://join?host=my-computer&node=${NODE_HEX}&name=Home%20mini`, "the code: this Mac's Tailscale short name, the pinned node key in hex, the name", url)
  check(!!url && !/127\.0\.0\.1|100\.\d+\.\d+\.\d+|token|secret|pin=/.test(url), 'no number address and no secret in it', url)
  check((await app.page.evaluate(`!!${DIALOG}?.querySelector('[data-testid="phone-join"] svg')`)) === true, 'drawn as a QR')
  check((await app.page.evaluate(covered)) === 0, 'nothing in the dialog on a drag region')
  await close()
  check(!!(await until(async () => !(await app.page.evaluate(`!!${DIALOG}`)), 2000)), 'Esc closes it')

  // Config → Devices has the same entry.
  await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Config"]')?.click(); true`)
  await until(() => app.page.evaluate(`!!document.querySelector('[data-testid="config-tab-groups"]')`), 8000)
  await app.page.evaluate(`[...document.querySelectorAll('button, [role="tab"]')].find((b) => b.innerText.trim() === 'Devices')?.click(); true`)
  const devBtn = await until(() => app.page.evaluate(`!!document.querySelector('[data-testid="devices-add-phone"]')`), 8000)
  check(!!devBtn, 'Config → Devices has "Add a phone"')
  await app.page.evaluate(`document.querySelector('[data-testid="devices-add-phone"]').click(); true`)
  const url2 = await until(() => app.page.evaluate(`${DIALOG}?.querySelector('[data-testid="phone-join"]')?.dataset.url ?? null`), 5000)
  check(url2 === url, 'and it opens the same code', url2)
  await close()
  await sleep(300)

  // It listens to its own computer only: words, not a code.
  net.bind = '127.0.0.1'
  await app.page.evaluate(`window.dispatchEvent(new CustomEvent('beacon:add-phone')); true`)
  const why = await until(() => app.page.evaluate(`${DIALOG}?.querySelector('[data-testid="phone-join-why"]')?.innerText ?? null`), 5000)
  check(!!why && /Other computers/.test(why) && !/HTTP|\b40\d\b/.test(why) && !(await app.page.evaluate(`!!${DIALOG}?.querySelector('[data-testid="phone-join"]')`)), 'listening to its own computer only: says to turn on Other computers, and shows no code', why)
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  rest.close()
  wsHttp.close()
  rmSync(profile, { recursive: true, force: true })
}
if (failures || checks < MIN_CHECKS) {
  console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
  process.exit(1)
}
console.log(`\n[probe] OK — ${checks} checks passed`)
