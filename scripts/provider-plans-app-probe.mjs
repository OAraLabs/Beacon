// Subscription plans in Config → Models, in the real app (.claude/private/handoff-provider-plans-contract.md): a scratch profile
// connected to a stand-in daemon that serves the plans fixture and records every PUT. With the capability, Qwen's row says
// "via Token Plan", its sheet offers the plans with their terms, and choosing another plan saves {plan} alone: no key, no URL.
// Without the capability the row is today's. No key is saved (no Keychain prompt); the user's own profile is never touched.
//
//   npm run build && npm run probe:provider-plans
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 6
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = JSON.parse(readFileSync(join(REPO, 'src/main/fixtures/provider_plans_assumed.json'), 'utf8'))
let withPlans = true
const puts = []
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const catalog = () => {
  if (withPlans) return FIXTURE
  const { capabilities: _c, ...rest } = FIXTURE
  return rest
}
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = req.url ?? ''
    if (url === '/api/hello') return json(res, 200, { v: '0.9.21', name: 'Plans Stand-in', agent: 'Prometheus', fp: '7777777777777777', pair: 'approve', tls: false })
    if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', provider: 'glm', model: 'glm-5.3' })
    if (url === '/api/providers/keys' && req.method === 'GET') return json(res, 200, catalog())
    if (url.startsWith('/api/providers/keys/') && req.method === 'PUT') {
      puts.push({ url, body })
      return json(res, 200, catalog())
    }
    if (url === '/api/models') return json(res, 200, { models: [] })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const API = rest.address().port
const WS = wsHttp.address().port

const fresh = () => {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-plans-probe-'))
  execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
    INSERT INTO gateway_profiles VALUES ('mini', 'http://127.0.0.1:${API}', 'ws://127.0.0.1:${WS}', 1, NULL);`])
  return profile
}
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const clickText = (app, sel, text) =>
  app.page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.innerText.trim() === ${JSON.stringify(text)} && !b.disabled); if (!el) return false; el.click(); return true })()`)
const qwenRow = (app, expr) => app.page.evaluate(`(() => { const row = [...document.querySelectorAll('[data-testid="provider-row"]')].find((r) => r.innerText.startsWith('Qwen')); return row ? (${expr}) : null })()`)
async function openModels(app) {
  await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)
  await until(() => clickText(app, 'nav button, nav a, button', 'Config'), 8000)
  await until(() => clickText(app, 'button, [role="tab"]', 'Models'), 8000)
  return until(() => qwenRow(app, 'true'), 8000)
}

const profiles = [fresh(), fresh()]
let app = null
try {
  app = await launchApp({ profile: profiles[0] })
  check(!!(await openModels(app)), 'Config → Models shows the Qwen row')
  const chip = await qwenRow(app, 'row.innerText')
  check(/via Token Plan/.test(chip ?? ''), 'with the capability, Qwen says "via Token Plan"', chip)
  await qwenRow(app, `([...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Change') || {}).click?.() ?? true`)
  const picker = await until(() => qwenRow(app, `row.querySelector('[data-testid="plan-picker"]')?.innerText ?? null`), 5000)
  check(!!picker && /Pay as you go/.test(picker) && /Coding Plan/.test(picker) && /interactive use in coding tools/.test(picker), 'its sheet offers the plans, with their terms as a label', picker)
  await qwenRow(app, `([...row.querySelectorAll('[data-testid="plan-picker"] label')].find((l) => l.innerText.startsWith('Coding Plan'))?.querySelector('input') || {}).click?.() ?? true`)
  const before = puts.length
  await qwenRow(app, `(row.querySelector('[data-testid="key-save"]') || {}).click?.() ?? true`)
  await until(async () => puts.length > before, 5000)
  const sent = puts.at(-1)
  check(sent?.url === '/api/providers/keys/qwen' && sent.body === JSON.stringify({ plan: 'coding-plan' }), 'choosing Coding Plan saves {plan} alone: no key, no URL', JSON.stringify(sent))
  await app.quit()
  app = null

  withPlans = false
  app = await launchApp({ profile: profiles[1] })
  check(!!(await openModels(app)), 'without the capability, the Qwen row is there')
  const plain = await qwenRow(app, 'row.innerText')
  const noPicker = await qwenRow(app, `[...row.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Replace key') && !row.querySelector('[data-testid="plan-picker"]')`)
  check(!/Token Plan/.test(plain ?? '') && noPicker === true, 'and it is today\'s row: "Replace key", no plans', plain)
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  for (const p of profiles) rmSync(p, { recursive: true, force: true })
}
if (failures || checks < MIN_CHECKS) {
  console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
  process.exit(1)
}
console.log(`\n[probe] OK — ${checks} checks passed`)
