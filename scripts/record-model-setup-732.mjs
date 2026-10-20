#!/usr/bin/env node
// record-model-setup-732 — what a REAL Prometheus (main with #732) answers to O9's calls: POST /api/setup/check-key and the
// OpenRouter /api/setup/configure, into src/main/fixtures/model_setup_732.json, so smoke:model-setup holds Beacon's reading to the
// daemon's real answers and not to a reading of the contract.
//
//   export BEACON_SIGNED_PYTHON=<a python3.12 with Prometheus's dependencies, e.g. the notarized app's signed one>
//   export BEACON_PROMETHEUS_SRC=<prometheus clone at main, with #732>/src
//   node scripts/record-model-setup-732.mjs
//
// A scratch home, loopback, ephemeral ports (never 8005 or 8010). The three provider checks send OBVIOUSLY FAKE keys (all
// zeros) to openrouter.ai, api.anthropic.com and api.openai.com: each provider refuses them on its free call, so nothing is
// spent (#732's key_check asks OpenRouter's paid one-token call only after a key is accepted). No real key is used or recorded.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PY = process.env.BEACON_SIGNED_PYTHON
const SRC = process.env.BEACON_PROMETHEUS_SRC
if (!PY || !SRC) {
  console.log('[record] SKIPPED: set BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/model_setup_732.json', import.meta.url))
const FAKE = { openrouter: 'sk-or-v1-' + '0'.repeat(64), anthropic: 'sk-ant-api03-' + '0'.repeat(90), openai: 'sk-proj-' + '0'.repeat(120) }
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const api = await freePort()
const ws = await freePort()
if ([api, ws].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
const home = mkdtempSync(join(tmpdir(), 'beacon-record-o9-'))
mkdirSync(join(home, 'tmp'))
const host = hostname()
const scrub = (s) => s.split(home).join('<home>').split(host).join('<this Mac>.local'.replace('.local.local', '.local')).split(host.replace(/\.local$/, '')).join('<this Mac>')
/** Every file under `dir` whose text contains `needle` (the key's home is recorded as a path, never the key). */
function filesWith(dir, needle, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) filesWith(f, needle, out)
    else if (e.isFile() && statSync(f).size < 1_000_000 && readFileSync(f, 'utf8').includes(needle)) out.push(f)
  }
  return out
}
const p = spawn(PY, ['-B', '-m', 'prometheus', 'daemon'], {
  env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: SRC, PROMETHEUS_INSTALL_KIND: 'app', PROMETHEUS_WEB_BIND: '127.0.0.1', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws) },
  stdio: 'ignore',
  detached: true
})
const call = async (method, path, body, token, timeoutMs = 30000) => {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, ms: Date.now() - t0 }
  } catch (e) {
    return { status: 0, json: null, ms: Date.now() - t0, error: String(e?.name) }
  }
}
const pick = ({ status, json }) => ({ status, json })
const rec = { recorded: new Date().toISOString().slice(0, 10), daemon: 'Prometheus main with #732 (e867e41 and later), setup mode, scratch home' }
try {
  if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error('setup mode did not answer')
  const secret = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
  await until(() => existsSync(secret), 5000)
  const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secret, 'utf8').trim() })).json?.token
  if (!master) throw new Error('no master token')
  const C = '/api/setup/check-key'
  rec.check_key = {
    no_token: pick(await call('POST', C, { provider: 'openrouter', api_key: FAKE.openrouter })),
    not_json: pick(await call('POST', C, 'nope', master)),
    base_url: pick(await call('POST', C, { provider: 'openrouter', api_key: FAKE.openrouter, base_url: 'https://evil.example' }, master)),
    unsupported: pick(await call('POST', C, { provider: 'gemini', api_key: FAKE.openrouter }, master)),
    empty_key: pick(await call('POST', C, { provider: 'openrouter', api_key: '' }, master)),
    not_a_key: pick(await call('POST', C, { provider: 'anthropic', api_key: 'short' }, master))
  }
  for (const provider of ['openrouter', 'anthropic', 'openai']) {
    const r = await call('POST', C, { provider, api_key: FAKE[provider] }, master)
    rec.check_key[`fake_${provider}`] = { ...pick(r), took_ms_rounded: Math.round(r.ms / 100) * 100 }
  }
  rec.configure_openrouter = pick(await call('POST', '/api/setup/configure', { provider: 'openrouter', api_key: FAKE.openrouter }, master))
  const yamlPath = join(home, '.prometheus/prometheus.yaml')
  rec.config_lines = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8').split('\n').filter((l) => /^\s*(provider|model|base_url):/.test(l)).slice(0, 8) : []
  rec.key_kept_in = filesWith(home, FAKE.openrouter).map((f) => f.replace(home, '<home>'))
  rec.key_in_config_yaml = existsSync(yamlPath) && readFileSync(yamlPath, 'utf8').includes(FAKE.openrouter)
  rec.complete = pick(await call('POST', '/api/setup/complete', {}, master))
  rec.status_after_complete = (await until(async () => {
    const r = await call('GET', '/api/status', undefined, master, 3000)
    return r.status === 200 ? r : null
  }, 60000)) ? 200 : 'never'
  const hello = (await call('GET', '/api/hello')).json
  rec.hello_after = hello ? { ...hello, fp: hello.fp ? '<16 hex>' : hello.fp } : null
} finally {
  try {
    process.kill(-p.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
  await until(() => p.exitCode !== null || p.signalCode !== null, 15000)
  try {
    process.kill(-p.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  rmSync(home, { recursive: true, force: true })
}
let text = scrub(JSON.stringify(rec, null, 2))
for (const k of Object.values(FAKE)) if (text.includes(k)) throw new Error('a key would be recorded: refusing')
writeFileSync(OUT, text + '\n')
console.log(text)
