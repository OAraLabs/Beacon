#!/usr/bin/env node
// onboarding-model-probe — O9 in the BUILT app, against a REAL Prometheus (main with #732), with real clicks (docs/ONBOARDING-v0.4.0-O9.md).
//
//   export BEACON_SIGNED_PYTHON=<a python3.12 with Prometheus's dependencies, e.g. the notarized app's signed one>
//   export BEACON_PROMETHEUS_SRC=<prometheus clone at main, with #732>/src
//   npm run build && node scripts/onboarding-model-probe.mjs [screenshot-dir]
//
// The world:
//   * a real Prometheus from source in setup mode, in a scratch home, on loopback and ephemeral ports (never 8005/8010);
//   * its key check pointed at a stand-in provider on this Mac: key_check's three provider addresses are module constants, set
//     by a sitecustomize in a scratch folder (the module's own docstring names a stand-in provider as the way to test it). The
//     route, its classification by status, configure, complete and the pairing are Prometheus's own. No third party is contacted;
//   * a stand-in OpenRouter on the same loopback server (BEACON_OPENROUTER_BASE): the exchange, and the provider calls;
//   * a stand-in for the app's launcher that does what `--pair` does (packaging/macos/launcher/main.swift writePairSecret: a
//     fresh random secret in pairing/pair.secret, mode 0600, and the JSON line);
//   * Beacon holding the setup-mode master token, as A-inst leaves it, and relaunched: it resumes at A2;
//   * the browser: shell.openExternal is replaced (from main's inspector) by a recorder; the probe then does what OpenRouter's
//     page does when the person authorizes: it calls the callback with a code and the state.
// Then: the shape card and a refused key on the paste screen; the sign-in with an account that has no credit; then with credit,
// on through "Finishing setup" to the first message; and the end state checked against the daemon and Beacon's own files.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'

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
const MIN_CHECKS = 22
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
const root = mkdtempSync(join(tmpdir(), 'beacon-o9-probe-'))
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
  `#!/bin/sh\n[ "$1" = "--pair" ] || { echo '{"ok":false,"state":"unexpected"}'; exit 2; }\nd="$HOME/Library/Application Support/Prometheus/pairing"\nmkdir -p "$d" && chmod 700 "$d"\ns=$(/usr/bin/openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\\n')\numask 077; printf '%s\\n' "$s" > "$d/.pair.secret.$$" && mv "$d/.pair.secret.$$" "$d/pair.secret"\necho "$*" >> "${root}/launcher-calls"\nprintf '{"ok":true,"state":"pair_secret_written","path":"%s","detail":"","agent":"probe","app_version":"0.9.6"}\\n' "$d/pair.secret"\n`
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
const opened = () => app.mainEval('globalThis.__opened.slice()')
/** Do what OpenRouter's page does when the person authorizes: call the callback with a code and the state. */
async function authorize(url, code) {
  const u = new URL(url)
  const cb = new URL(u.searchParams.get('callback_url'))
  const r = await fetch(`http://127.0.0.1:${cb.port}${cb.pathname}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(u.searchParams.get('state'))}`)
  return { status: r.status, body: await r.text(), challenge: u.searchParams.get('code_challenge') }
}

try {
  if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error('setup mode did not answer')
  await until(() => existsSync(secretPath), 5000)
  const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secretPath, 'utf8').trim() })).json?.token
  if (!master) throw new Error('no master token')
  const profile = join(root, 'profile')
  mkdirSync(profile)
  Object.assign(process.env, { BEACON_ONBOARDING: 'v4', BEACON_DISCOVERY_PORT: String(api), BEACON_PROMETHEUS_HOME: home, BEACON_PROMETHEUS_LAUNCHER: launcher, BEACON_OPENROUTER_BASE: STUB })
  app = await launchApp({ profile, readySelector: '[data-screen]' })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  check((await app.mainEval(`__electron.shell.openExternal.toString().includes('__opened')`)) === true, 'the browser is a recorder: nothing opens on this Mac')
  // A-inst's end state: the setup credential kept for Prometheus on this Mac. Then a relaunch of the page: setup resumes at A2.
  const saved = await page().evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${api}, wsPort: ${ws}, token: ${JSON.stringify(master)} }).then((r) => r.ok)`)
  await page().send('Page.reload')
  check(saved === true && (await onScreen('A2', 15000)) === 'A2' && (await h1()) === 'How should your assistant think?', 'resumed at A2: Prometheus on this Mac in setup mode, its setup credential kept (as A-inst leaves it)', await screen())
  await shot('a2')
  const a2 = await text()
  check(/Recommended/.test(a2) && /Coming soon/.test(a2), 'A2: a cloud AI, Recommended; privately on this Mac shown as coming soon', a2)

  check((await click('Continue')) && (await onScreen('A3c-1')) === 'A3c-1' && /\$5 is the smallest amount/.test(await text()), 'A3c-1: Sign in with OpenRouter, Recommended, with what it needs (credit) on the card', await text())
  await shot('a3c-1')
  check((await click('Other options')) && (await click('Use a key from Anthropic (Claude)')) && (await onScreen('A3c-2')) === 'A3c-2' && (await h1()) === 'Connect your Anthropic account', 'Other options → a key from Anthropic', await h1())
  check(/credit or a payment method/.test(await text()), 'A3c-2 says the account needs credit or a payment method (a good key is not proof of it)', await text())
  const before = stub.requests.length
  await type('[data-testid="pasted-key"]', 'sk-proj-' + 'x'.repeat(30))
  check((await click('Check key')) && (await until(async () => /look like a key from Anthropic/.test(await text()), 5000)) && stub.requests.length === before, "a key in OpenAI's shape under Anthropic is \"That doesn't look like a key from Anthropic\", and nothing is checked", JSON.stringify(stub.requests.slice(before)))
  const anthKey = 'sk-ant-api03-' + randomBytes(30).toString('hex')
  await click('Paste again')
  await type('[data-testid="pasted-key"]', anthKey)
  await click('Check key')
  const refused = await until(async () => /didn't accept this key/.test(await text()), 15000)
  const models = stub.requests.find((r) => r.path === '/v1/models')
  check(!!refused && !!models && models.auth === anthKey, "a key Anthropic refuses (401): \"Anthropic didn't accept this key\"; the pasted key reached the provider through Prometheus's check, and only there", JSON.stringify({ refused: !!refused, auth: models ? (models.auth === anthKey ? 'the pasted key' : 'another') : 'none' }))
  await shot('a3c-2-refused')

  check((await click('Back')) && (await onScreen('A3c-1')) === 'A3c-1' && (await click('Continue')) && (await onScreen('A3c-or')) === 'A3c-or', 'Back to the list, and Continue is the OpenRouter sign-in')
  const first = await until(async () => ((await opened()).length === 1 ? (await opened())[0] : null), 5000)
  const fu = first ? new URL(first) : null
  check(!!fu && fu.origin + fu.pathname === `${STUB}/auth` && /^http:\/\/localhost:\d+\/openrouter\/callback$/.test(fu.searchParams.get('callback_url') ?? '') && fu.searchParams.get('code_challenge_method') === 'S256' && /Waiting for you to finish in the browser/.test(await text()), 'the browser is sent to the (stand-in) authorization page with a localhost callback and an S256 challenge; the screen waits', first ?? 'nothing opened')
  await shot('a3c-or-waiting')
  stub.chatStatus = 402
  const auth1 = await authorize(first, 'probe-code-1')
  // The exchange follows the callback's answer: wait for it.
  await until(() => stub.issued.length >= 1, 5000)
  const ex1 = stub.issued[0]
  check(auth1.status === 200 && /close this tab/i.test(auth1.body) && ex1?.body.code === 'probe-code-1' && createHash('sha256').update(ex1.body.code_verifier ?? '').digest('base64url') === auth1.challenge, 'the callback is answered "you can close this tab", and the exchange carried the code with the verifier whose challenge the browser carried', JSON.stringify({ status: auth1.status, ex: ex1?.body.code }))
  const noCredit = await until(async () => /needs credit/.test(await text()), 20000)
  const chat1 = stub.requests.filter((r) => r.path === '/api/v1/chat/completions')
  check(!!noCredit && chat1.length === 1 && chat1[0].auth === `Bearer ${ex1?.key}` && /Add credit on OpenRouter/.test(await text()), 'an account with no credit (402 on the one-token check): "Your OpenRouter account needs credit", with Add credit; the key the exchange issued is the one Prometheus checked', JSON.stringify({ noCredit: !!noCredit, chats: chat1.length }))
  await shot('a3c-or-no-credit')

  stub.chatStatus = 200
  await click('Try again')
  const second = await until(async () => ((await opened()).length === 2 ? (await opened())[1] : null), 5000)
  check(!!second && new URL(second).searchParams.get('state') !== fu?.searchParams.get('state'), 'Try again starts a new sign-in (a new state)', second ?? 'nothing opened')
  await authorize(second, 'probe-code-2')
  await until(() => stub.issued.length >= 2, 5000)
  const key = stub.issued[1]?.key
  const reached = await until(async () => ((await screen()) === 'A5' || (await screen()) === 'F1' ? await screen() : null), 20000)
  check(reached === 'A5' || reached === 'F1', 'with credit, the sign-in goes on to "Finishing setup"', reached)
  await shot('a5')
  const f1 = await onScreen('F1', 90000)
  check(f1 === 'F1' && (await h1()) === 'Say hello to your assistant', 'Finishing setup ends at the first message', `${await screen()}: ${await text()}`)
  await shot('f1')

  // ── the end state, from the daemon's side and Beacon's ─────────────────────────────────────────────────────────────────
  const yaml = existsSync(join(home, '.prometheus/prometheus.yaml')) ? readFileSync(join(home, '.prometheus/prometheus.yaml'), 'utf8') : ''
  const envFile = existsSync(join(home, '.config/prometheus/env')) ? readFileSync(join(home, '.config/prometheus/env'), 'utf8') : ''
  check(/provider: openrouter/.test(yaml) && /model: anthropic\/claude-sonnet-5/.test(yaml) && !!key && envFile.includes(key) && !yaml.includes(key), 'Prometheus is configured for OpenRouter on its default paid choice, with the key from the sign-in in its own env file and not in its config', yaml.split('\n').filter((l) => /provider|model/.test(l)).join(' | '))
  const kept = await app.mainEval(`(() => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto')
    const f = path.join(__electron.app.getPath('userData'), 'api-credential.bin')
    return fs.existsSync(f) ? crypto.createHash('sha256').update(__electron.safeStorage.decryptString(fs.readFileSync(f))).digest('hex') : null
  })()`)
  const devicesDb = spawnSync('/usr/bin/find', [home, '-name', 'devices.db'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const ownerRow = kept && devicesDb ? spawnSync('/usr/bin/sqlite3', [`file:${devicesDb}?mode=ro`, `SELECT d.name || '|' || (d.revoked_at IS NULL) FROM api_devices d JOIN owner_devices o ON o.device_id = d.id WHERE d.token_sha256 = '${kept}'`], { encoding: 'utf8' }).stdout.trim() : ''
  check(!!kept && kept !== sha256(master) && ownerRow === 'Beacon on this Mac|1', 'the credential Beacon keeps is an owner credential in the daemon\'s own registry ("Beacon on this Mac", unrevoked), not the setup credential', `owner row: "${ownerRow}", master: ${kept === sha256(master)}`)
  const setting = spawnSync('/usr/bin/sqlite3', [`file:${join(profile, 'beacon.db')}?mode=ro`, `SELECT value FROM settings WHERE key = 'onboarding:credential'`], { encoding: 'utf8' }).stdout.trim()
  const calls = existsSync(join(root, 'launcher-calls')) ? readFileSync(join(root, 'launcher-calls'), 'utf8').trim().split('\n') : []
  check(setting === 'owner' && JSON.stringify(calls) === '["--pair"]', 'Beacon records the connection as an owner one; the launcher was asked for a secret once', JSON.stringify({ setting, calls }))
  const status = await until(async () => {
    const s = await page().evaluate('window.beacon.connection.status()')
    return s?.state === 'connected' ? s : null
  }, 15000)
  check(!!status, 'the connection is up with the owner credential', JSON.stringify(await page().evaluate('window.beacon.connection.status()')))
  // Neither key nor credential ever reached the page or Beacon's files (the owner credential lives encrypted, in api-credential.bin).
  const pageDump = await page().evaluate(`JSON.stringify({ text: document.body.innerText, html: document.documentElement.outerHTML.length, ls: Object.entries(localStorage), ss: Object.entries(sessionStorage) })`)
  const leaks = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.isFile() && statSync(f).size < 50_000_000) {
        const b = readFileSync(f)
        for (const [name, v] of [['openrouter key', key], ['anthropic key', anthKey], ['master token', master]]) if (v && b.includes(v)) leaks.push(`${name} in ${f.replace(profile, '<profile>')}`)
      }
    }
  }
  walk(profile)
  check(!pageDump.includes(key) && !pageDump.includes(anthKey) && !pageDump.includes(master) && leaks.length === 0, "no key and no setup credential in the page (text, storage) or anywhere in Beacon's profile on disk", leaks.join('; '))
  check((await call('GET', '/api/status', undefined, master)).status === 200, "the daemon still knows its own master token (retiring it is Prometheus's, #695's release gate): Beacon only stopped holding it")
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

