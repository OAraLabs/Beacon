#!/usr/bin/env node
// record-pair-fp — record what a REAL Prometheus with `pair.fp` (Prometheus #695 from 3090556) says about its fingerprint, in
// hello and beside the secret, at each point Beacon reads them: a fresh install in setup mode, after setup completes (the same
// process falls through into the full daemon), and after `--pair`'s fresh secret on a configured daemon. Into
// src/main/fixtures/pair_fp_695.json, so smoke:prometheus-install holds Beacon's comparison to the daemon's real answers.
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone at #695>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   node scripts/record-pair-fp.mjs
//
// The daemon runs the way the app's launcher starts it (`-m prometheus daemon --bind 127.0.0.1`, PROMETHEUS_INSTALL_KIND=app), in
// a SCRATCH HOME on ephemeral ports (never 8005 or 8010). Secrets and tokens stay in this process; fingerprints are public (they
// are in hello) and are kept as they are.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = process.env.BEACON_REAL_DAEMON_SRC
const PY = process.env.BEACON_REAL_DAEMON_PY
if (!SRC || !PY) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pair_fp_695.json', import.meta.url))
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const api = await freePort()
const ws = await freePort()
if ([8005, 8006, 8010, 8011].includes(api) || [8005, 8006, 8010, 8011].includes(ws)) throw new Error('refusing the real ports')
const home = mkdtempSync(join(tmpdir(), 'beacon-record-fp-'))
mkdirSync(join(home, 'tmp'))
const pairing = join(home, 'Library/Application Support/Prometheus/pairing')
const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), PYTHONPATH: SRC, PYTHONDONTWRITEBYTECODE: '1', PROMETHEUS_INSTALL_KIND: 'app', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws), LANG: 'en_US.UTF-8' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(250)
  }
}
async function call(method, path, body, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, json }
  } catch {
    return { status: 0, json: null }
  }
}
const fpFile = () => (existsSync(join(pairing, 'pair.fp')) ? readFileSync(join(pairing, 'pair.fp'), 'utf8') : null)
const look = async (label) => {
  const h = await call('GET', '/api/hello')
  const file = fpFile()
  return { at: label, hello_status: h.status, hello_fp: h.json?.fp ?? null, hello_agent: h.json?.agent ?? null, hello_pair: h.json?.pair ?? null, pair_fp_file: file === null ? null : JSON.stringify(file), equal_as_strings: (h.json?.fp ?? null) === (file === null ? '' : file.trim()) }
}
const procs = []
const start = () => {
  const p = spawn(PY, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SRC)}); import runpy; sys.argv = ['prometheus', 'daemon', '--bind', '127.0.0.1']; runpy.run_module('prometheus', run_name='__main__')`], { env, stdio: 'ignore', detached: true })
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
  if (!(await until(() => p.exitCode !== null || p.signalCode !== null, 15000))) {
    try {
      process.kill(-p.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}
const rec = { daemon: 'Prometheus #695 at 3090556, run as the app runs it (PROMETHEUS_INSTALL_KIND=app, --bind 127.0.0.1), scratch home', looks: [] }
try {
  let p = start()
  const up = await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000)
  if (!up) throw new Error('setup mode did not answer in 60 s')
  rec.looks.push(await look('fresh install, setup mode'))
  const secret = readFileSync(join(pairing, 'pair.secret'), 'utf8').trim()
  const pair = await call('POST', '/api/setup/pair', { code: secret })
  const master = pair.json?.token
  rec.looks.push(await look('setup mode, paired'))
  await call('POST', '/api/setup/configure', { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-ant-record-placeholder-not-a-key' }, master)
  await call('POST', '/api/setup/complete', {}, master)
  const configured = await until(async () => (await call('GET', '/api/status', null, master)).status === 200, 60000)
  rec.complete_reached_status_200 = !!configured
  rec.looks.push(await look('after complete: the same process is the full daemon, /api/status 200'))
  await stop(p)
  p = start()
  await until(async () => (await call('GET', '/api/status', null, master)).status === 200, 60000)
  rec.looks.push(await look('the configured daemon restarted'))
} finally {
  for (const p of procs) await stop(p)
  rmSync(home, { recursive: true, force: true })
}
writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n')
console.log(JSON.stringify(rec, null, 1))
