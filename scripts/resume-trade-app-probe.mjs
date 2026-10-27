#!/usr/bin/env node
// resume-trade-app-probe — O10: a relaunch part-way through O9's owner trade, in the BUILT app, against a REAL Prometheus from
// source, with real clicks.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies>
//   export BEACON_PROMETHEUS_SRC=<prometheus clone at main>/src
//   npm run build && node scripts/resume-trade-app-probe.mjs [screenshot-dir]
//
// The world (as onboarding-model-probe's): a real Prometheus in a scratch home on loopback and ephemeral ports, a stand-in for the
// app launcher's `--pair` that refuses its FIRST call, and Beacon on a scratch profile with a mock keychain. Then:
//   * Prometheus is configured and completed with its master token (what A5 does before the trade), and Beacon holds that master
//     token for Prometheus on this Mac, marked as A-inst marks it (onboarding:credential = master): Beacon stopped after complete;
//   * Beacon is QUIT AND RELAUNCHED: it must open on "Finishing setup", never the app with the master key;
//   * the trade runs; the first --pair is refused, so the card says so and the master token is still what Beacon holds;
//   * Try again finishes the trade: "Say hello", an owner credential in the daemon's own registry, the master token gone from Beacon;
//   * relaunched once more, Beacon opens the app.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, profileDb, sleep } from './app-driver.mjs'

const PY = process.env.BEACON_SIGNED_PYTHON
const SRC = process.env.BEACON_PROMETHEUS_SRC
const SHOTS = process.argv[2] ?? null
if (process.platform !== 'darwin' || !PY || !SRC) {
  console.log('[probe] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 600)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 9
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const until = async (fn, ms, every = 200) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(every)
  }
}
const freePort = () => new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

// ── the world ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'beacon-resume-trade-probe-'))
const home = join(root, 'home')
const site = join(root, 'site')
mkdirSync(join(home, 'tmp'), { recursive: true })
mkdirSync(site)
// Stand-in OpenRouter (the exchange) and stand-in provider (what Prometheus's key check calls), recording every request.
const stub = { requests: [], issued: [], chatStatus: 402 }
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? ''
    stub.requests.push({ method: req.method, path: req.url, auth: String(auth), body })
    const json = (code, o) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)))
    if (req.method === 'POST' && req.url === '/api/v1/auth/keys') {
      const key = 'sk-or-v1-probe' + randomBytes(24).toString('hex')
      stub.issued.push({ key, body: JSON.parse(body || '{}') })
      return json(200, { key })
    }
    if (req.method === 'GET' && req.url === '/api/v1/key') return stub.issued.some((i) => `Bearer ${i.key}` === auth) ? json(200, { data: { label: 'probe' } }) : json(401, { error: 'no' })
    if (req.method === 'POST' && req.url === '/api/v1/chat/completions') return json(stub.chatStatus, stub.chatStatus === 200 ? { choices: [{ message: { content: 'hi' } }] } : { error: { message: 'Insufficient credits' } })
    if (req.method === 'GET' && req.url === '/v1/models') return json(401, { error: { type: 'authentication_error' } }) // Anthropic and OpenAI: a refused key
    json(404, {})
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const STUB = `http://127.0.0.1:${server.address().port}`
writeFileSync(
  join(site, 'sitecustomize.py'),
  `import os\nbase = os.environ.get('BEACON_PROBE_PROVIDER_BASE')\nif base:\n    import prometheus.providers.key_check as kc\n    kc._OPENROUTER = base + '/api/v1'\n    kc._ANTHROPIC = base + '/v1'\n    kc._OPENAI = base + '/v1'\n`
)
// The launcher's --pair, as packaging/macos/launcher/main.swift does it.
const launcher = join(root, 'launcher.sh')
const secretPath = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
writeFileSync(
  launcher,
  `#!/bin/sh\n[ "$1" = "--pair" ] || { echo '{"ok":false,"state":"unexpected"}'; exit 2; }\nif [ ! -e "${root}/failed-once" ]; then : > "${root}/failed-once"; echo "$* (failed)" >> "${root}/launcher-calls"; echo '{"ok":false,"state":"probe_refused_once","detail":"the probe refuses the first --pair"}'; exit 1; fi\nd="$HOME/Library/Application Support/Prometheus/pairing"\nmkdir -p "$d" && chmod 700 "$d"\ns=$(/usr/bin/openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\\n')\numask 077; printf '%s\\n' "$s" > "$d/.pair.secret.$$" && mv "$d/.pair.secret.$$" "$d/pair.secret"\necho "$*" >> "${root}/launcher-calls"\nprintf '{"ok":true,"state":"pair_secret_written","path":"%s","detail":"","agent":"probe","app_version":"0.9.6"}\\n' "$d/pair.secret"\n`
)
chmodSync(launcher, 0o755)
const api = await freePort()
const ws = await freePort()
if ([api, ws].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
const daemon = spawn(PY, ['-B', '-m', 'prometheus', 'daemon'], {
  env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: `${site}:${SRC}`, PROMETHEUS_INSTALL_KIND: 'app', PROMETHEUS_WEB_BIND: '127.0.0.1', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws), BEACON_PROBE_PROVIDER_BASE: STUB },
  stdio: 'ignore',
  detached: true
})
const call = async (method, path, body, token) => {
  try {
    const r = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
    return { status: r.status, json: await r.json().catch(() => null) }
  } catch {
    return { status: 0, json: null }
  }
}

let app = null
const page = () => app.page
const screen = () => page().evaluate(`document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null`)
const h1 = () => page().evaluate(`document.querySelector('[data-screen] h1')?.innerText ?? null`)
const text = () => page().evaluate(`document.querySelector('[data-screen]')?.innerText ?? ''`)
const onScreen = (id, ms = 10000) => until(async () => ((await screen()) === id ? id : null), ms, 150)
/** A real click on the button or link whose text is `label` (exact, trimmed): scrolled into view, hit-tested, then a mouse press. */
async function click(label) {
  const at = await page().evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-screen] button, [data-screen] a')].find((b) => b.innerText.trim().replace(/\\s*↗$/, '') === ${JSON.stringify(label)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, hit: !!hit && (hit === el || el.contains(hit)), disabled: !!el.disabled }
  })()`)
  if (!at?.hit || at.disabled) return false
  for (const type of ['mousePressed', 'mouseReleased']) await page().send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
async function type(selector, value) {
  await page().evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); return true })()`)
  await page().send('Input.insertText', { text: value })
}
async function shot(name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await page().send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const keptSha = () =>
  app.mainEval(`(() => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto')
    const f = path.join(__electron.app.getPath('userData'), 'api-credential.bin')
    return fs.existsSync(f) ? crypto.createHash('sha256').update(__electron.safeStorage.decryptString(fs.readFileSync(f))).digest('hex') : null
  })()`)
const marker = (profile) => spawnSync('/usr/bin/sqlite3', [`file:${profileDb(profile, 'beacon')}?mode=ro`, `SELECT value FROM settings WHERE key = 'onboarding:credential'`], { encoding: 'utf8' }).stdout.trim()
const inApp = () => page().evaluate(`!!document.querySelector('nav[aria-label="Views"]')`)
const calls = () => (existsSync(join(root, 'launcher-calls')) ? readFileSync(join(root, 'launcher-calls'), 'utf8').trim().split('\n') : [])
const env = { BEACON_ONBOARDING: 'v4', BEACON_DISCOVERY_PORT: String(api), BEACON_PROMETHEUS_HOME: home, BEACON_PROMETHEUS_LAUNCHER: launcher, BEACON_OPENROUTER_BASE: STUB }

try {
  if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error('setup mode did not answer')
  await until(() => existsSync(secretPath), 5000)
  const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secretPath, 'utf8').trim() })).json?.token
  if (!master) throw new Error('no master token')
  // What A5 does before the trade: configure (a placeholder Anthropic key: configure makes no network call) and complete.
  const conf = await call('POST', '/api/setup/configure', { provider: 'anthropic', api_key: 'sk-ant-api03-probe' + randomBytes(20).toString('hex') }, master)
  const done = await call('POST', '/api/setup/complete', {}, master)
  const up = await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000)
  check(conf.status === 200 && done.status === 200 && !!up && (await call('GET', '/api/setup/status')).status === 401, 'the real daemon is configured and completed with its master token, and answers as configured (A5 stopped after complete)', JSON.stringify({ conf: conf.status, done: done.status, up }))

  const profile = join(root, 'profile')
  mkdirSync(profile)
  Object.assign(process.env, env)
  app = await launchApp({ profile, readySelector: '[data-screen]' })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  // A-inst's end state: the master token kept for Prometheus on this Mac, marked as such (saveLocalConnection writes the mark;
  // setup.save stands in for the keeping, then the mark is written as A-inst writes it).
  const saved = await page().evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${api}, wsPort: ${ws}, token: ${JSON.stringify(master)} }).then((r) => r.ok)`)
  await page().evaluate(`window.beacon.settings.set('onboarding:credential', 'master')`)
  check(saved === true && (await keptSha()) === sha256(master) && marker(profile) === 'master', 'Beacon holds the master token for Prometheus on this Mac, marked master', marker(profile))
  await app.quit()
  app = null

  // ── the relaunch part-way through ──
  app = await launchApp({ profile, readySelector: '[data-screen], nav[aria-label="Views"]' })
  const first = await until(async () => ((await inApp()) ? 'app' : await screen()), 15000)
  check(first === 'A5', 'relaunched part-way through the trade: Beacon opens on "Finishing setup", not the app with the master key', String(first))
  await shot('relaunch-a5')
  const card = await until(async () => page().evaluate(`document.querySelector('[data-failure]')?.getAttribute('data-failure') ?? null`), 90000)
  check(card === 'trade' && (await keptSha()) === sha256(master) && marker(profile) === 'master' && !(await inApp()), 'the trade ran and the first --pair was refused: "Beacon couldn\'t finish connecting", and Beacon still holds (and marks) the master token, still not in the app', JSON.stringify({ card, calls: calls() }))
  await shot('trade-refused')
  check((await click('Try again')) && (await onScreen('F1', 90000)) === 'F1', 'Try again finishes the trade: "Say hello to your assistant"', `${await screen()}: ${(await text()).slice(0, 200)}`)
  await shot('f1')
  const kept = await keptSha()
  const devicesDb = spawnSync('/usr/bin/find', [home, '-name', 'devices.db'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const ownerRow = kept && devicesDb ? spawnSync('/usr/bin/sqlite3', [`file:${devicesDb}?mode=ro`, `SELECT d.name || '|' || (d.revoked_at IS NULL) FROM api_devices d JOIN owner_devices o ON o.device_id = d.id WHERE d.token_sha256 = '${kept}'`], { encoding: 'utf8' }).stdout.trim() : ''
  check(!!kept && kept !== sha256(master) && ownerRow === 'Beacon on this Mac|1' && marker(profile) === 'owner', 'Beacon now holds an owner credential from the daemon\'s own registry ("Beacon on this Mac"), marked owner; the master token is gone from Beacon', JSON.stringify({ ownerRow, master: kept === sha256(master), mark: marker(profile) }))
  check(JSON.stringify(calls()) === '["--pair (failed)","--pair"]', 'the launcher was asked for a secret twice (the refused one, then Try again); configure and complete were not asked again', JSON.stringify(calls()))
  const yaml = existsSync(join(home, '.prometheus/prometheus.yaml')) ? readFileSync(join(home, '.prometheus/prometheus.yaml'), 'utf8') : ''
  check(/provider: anthropic/.test(yaml), 'Prometheus keeps the configuration it had before the relaunch', yaml.split('\n').filter((l) => /provider|model/.test(l)).join(' | '))
  await app.quit()
  app = null

  // ── and once the trade is done, a relaunch is the app ──
  app = await launchApp({ profile, readySelector: '[data-screen], nav[aria-label="Views"]' })
  const last = await until(async () => ((await inApp()) ? 'app' : null), 15000)
  check(last === 'app', 'relaunched after the trade: Beacon opens the app', String(await screen()))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  try {
    process.kill(-daemon.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
  await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 15000)
  try {
    process.kill(-daemon.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  server.closeAllConnections()
  server.close()
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (e) {
    console.log(`[probe] could not remove ${root}: ${e.code}`)
  }
}
