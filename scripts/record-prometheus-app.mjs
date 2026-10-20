#!/usr/bin/env node
// record-prometheus-app — record what the REAL Prometheus.app (Prometheus #695) and the macOS tools that judge it actually say, into
// src/main/fixtures/prometheus_app_695.json, so smoke:prometheus-install holds Beacon's reading of them to real answers and not to a
// second reading of the contract (docs/design/macos-app-installer.md on Prometheus #695).
//
//   export BEACON_PROMETHEUS_TEST_ZIP=<a notarized Prometheus-<version>-arm64.zip built from Prometheus #695>
//   node scripts/record-prometheus-app.mjs
//
// What it records:
//   * codesign --verify -R (Beacon's own requirement), codesign -d, spctl -a -t exec -vv and syspolicy_check distribution, on the real
//     app and on apps that must fail: a tampered copy, an ad-hoc signed copy, and two real apps signed by someone else or as something
//     else (Calculator.app; Beacon.app if it is installed: right team, wrong bundle id);
//   * the real daemon's answers, run from the app's own `--run` in a SCRATCH HOME on ephemeral ports (never launchd, never 8005): setup
//     status in setup mode, the setup-mode pair, a configured daemon's 401, the launcher's `--pair` line, and `POST /api/pair/local`.
// Secrets and tokens never leave this process: the fixture keeps their shape. Paths under the scratch folder are replaced by <scratch>.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ZIP = process.env.BEACON_PROMETHEUS_TEST_ZIP
if (!ZIP || !existsSync(ZIP)) {
  console.log('[record] SKIPPED: set BEACON_PROMETHEUS_TEST_ZIP')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/prometheus_app_695.json', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'beacon-record-app-'))
// syspolicy_check also prints the folder by its own name, wrapped across lines: that goes too.
const scrub = (s) => s.split(root).join('<scratch>').replace(/beacon-record-app-[A-Za-z0-9]+/g, '<scratch>')
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { exit: r.status, stdout: scrub(String(r.stdout ?? '')), stderr: scrub(String(r.stderr ?? '')) }
}
// Beacon's requirement, the same text src/shared/prometheus-app.ts builds (the smoke checks the two agree).
const REQ = 'anchor apple generic and identifier "com.oaralabs.prometheus" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and (certificate leaf[subject.OU] = "53JM8W47RL")'
const judge = (app) => ({
  verify: run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${REQ}`, app]),
  display: run('/usr/bin/codesign', ['-d', '--verbose=2', app]),
  spctl: run('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', app]),
  syspolicy: run('/usr/bin/syspolicy_check', ['distribution', app])
})

const src = join(root, 'src')
mkdirSync(src)
run('/usr/bin/ditto', ['-x', '-k', ZIP, src])
const APP = join(src, 'Prometheus.app')
const copy = (name, mutate) => {
  const dir = join(root, name)
  mkdirSync(dir)
  cpSync(APP, join(dir, 'Prometheus.app'), { recursive: true, verbatimSymlinks: true })
  mutate(join(dir, 'Prometheus.app'))
  return join(dir, 'Prometheus.app')
}
const lib = join(APP, 'Contents/Resources/python/lib')
const py = readdirSync(lib).find((d) => d.startsWith('python3'))
const rec = { recorded: new Date().toISOString().slice(0, 10), app_version: run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(APP, 'Contents/Info.plist')]).stdout.trim(), macos: run('/usr/bin/sw_vers', ['-productVersion']).stdout.trim(), requirement: REQ, tools: {} }
rec.tools.real = judge(APP)
rec.tools.tampered = judge(copy('tampered', (a) => appendFileSync(join(a, `Contents/Resources/python/lib/${py}/site-packages/prometheus/__init__.py`), '\n# tampered\n')))
rec.tools.adhoc = judge(copy('adhoc', (a) => run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', a])))
rec.tools.calculator = judge('/System/Applications/Calculator.app')
if (existsSync('/Applications/Beacon.app')) rec.tools.beacon = judge('/Applications/Beacon.app')

// ── the daemon, from the app's own --run, in a scratch home ───────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const api = await freePort()
const ws = await freePort()
if ([8005, 8010].includes(api) || [8005, 8010].includes(ws)) throw new Error('refusing the real ports')
const home = join(root, 'home')
mkdirSync(join(home, 'tmp'), { recursive: true })
const placed = join(home, 'Applications/Prometheus.app')
mkdirSync(join(home, 'Applications'))
cpSync(APP, placed, { recursive: true, verbatimSymlinks: true })
const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws) }
const launcher = join(placed, 'Contents/MacOS/Prometheus')
const secretPath = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
const shape = (v) => (v === null || typeof v !== 'object' ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'token' ? (typeof x === 'string' ? `<string ${x.length}>` : typeof x) : typeof x === 'string' ? scrub(x) : x])))
const req = (method, path, body, headers = {}) =>
  new Promise((res) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request({ host: '127.0.0.1', port: api, path, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers }, timeout: 15000 }, (x) => {
      let t = ''
      x.on('data', (c) => (t += c))
      x.on('end', () => {
        let j = null
        try {
          j = JSON.parse(t)
        } catch {
          /* not JSON */
        }
        res({ status: x.statusCode, json: j })
      })
    })
    r.on('error', (e) => res({ status: 0, error: e.code }))
    data ? r.end(data) : r.end()
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(250)
  }
}
const procs = []
const start = () => {
  const p = spawn(launcher, ['--run'], { env, stdio: 'ignore', detached: true })
  procs.push(p)
  return p
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return
  try {
    process.kill(-p.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
  if (!(await until(() => p.exitCode !== null || p.signalCode !== null, 10000))) {
    try {
      process.kill(-p.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}
const d = { api_port: '<ephemeral>', ws_port: '<ephemeral>' }
try {
  let p = start()
  d.setup_status = await until(async () => {
    const r = await req('GET', '/api/setup/status')
    return r.status === 200 ? r : null
  }, 20000)
  d.secret_shape = await until(() => (existsSync(secretPath) ? readFileSync(secretPath, 'utf8') : ''), 5000).then((s) => ({ bytes: s.length, trimmed: s.trim().length, base64url: /^[A-Za-z0-9_-]+$/.test(s.trim()) }))
  const secret = readFileSync(secretPath, 'utf8').trim()
  const pair = await req('POST', '/api/setup/pair', { code: secret })
  d.setup_pair = { status: pair.status, json: { ...shape(pair.json), api_base_port: pair.json?.api_base_port === api ? '<the port it was reached on>' : pair.json?.api_base_port, ws_port: pair.json?.ws_port === ws ? '<its ws port>' : pair.json?.ws_port } }
  d.setup_pair_again = await req('POST', '/api/setup/pair', { code: secret })
  const auth = { authorization: `Bearer ${pair.json?.token}` }
  await req('POST', '/api/setup/configure', { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-ant-record-placeholder-not-a-key' }, auth)
  await req('POST', '/api/setup/complete', {}, auth)
  await until(async () => (await req('GET', '/api/status', undefined, auth)).status === 200, 30000)
  await stop(p)
  p = start()
  await until(async () => (await req('GET', '/api/status', undefined, auth)).status === 200, 30000)
  d.configured_setup_status = await req('GET', '/api/setup/status')
  d.configured_status = await req('GET', '/api/status')
  // Unscrubbed: the line is parsed first, and only the parsed path is replaced (scrubbing the raw text first garbles the path).
  const raw = spawnSync(launcher, ['--pair'], { env, encoding: 'utf8' })
  const pr = { exit: raw.status, stdout: String(raw.stdout ?? '') }
  // The launcher's JSON escapes "/" as "\/" (Foundation's JSONSerialization), so the path is replaced in the parsed line, not the text.
  const line = JSON.parse(pr.stdout.trim().split('\n').pop())
  d.launcher_pair = { exit: pr.exit, lines: pr.stdout.trim().split('\n').length, escapes_slashes: pr.stdout.includes('\\/'), json: { ...line, path: line.path === secretPath ? '<home>/Library/Application Support/Prometheus/pairing/pair.secret' : `UNEXPECTED ${scrub(line.path)}` } }
  const s2 = readFileSync(secretPath, 'utf8').trim()
  const local = await req('POST', '/api/pair/local', { code: s2, name: 'Beacon on this Mac' })
  d.pair_local = { status: local.status, json: { ...shape(local.json), api_base_port: local.json?.api_base_port === api ? '<the port it was reached on>' : local.json?.api_base_port, ws_port: local.json?.ws_port === ws ? '<its ws port>' : local.json?.ws_port }, is_the_daemons_own_token: local.json?.token === pair.json?.token }
  d.pair_local_again = await req('POST', '/api/pair/local', { code: s2 })
} finally {
  for (const p of procs) await stop(p)
}
rec.daemon = d
writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n')
console.log(`[record] wrote ${OUT}`)
const alive = run('/bin/sh', ['-c', `pgrep -f '${placed}' || true`]).stdout.trim()
rmSync(root, { recursive: true, force: true })
if (alive) {
  console.log(`[record] a daemon is still running: ${alive}`)
  process.exit(1)
}
