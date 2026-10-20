#!/usr/bin/env node
// record-pair-local — record how a REAL Prometheus daemon (main, with #694 and #696) answers same-Mac pairing on a CONFIGURED daemon
// (`POST /api/pair/local`), into src/main/fixtures/pair_local_696.json, so smoke:prometheus-install holds Beacon's reading of it to the
// daemon's real answers and not to a second reading of the contract (docs/design/macos-app-installer.md on Prometheus #695).
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone at main>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   node scripts/record-pair-local.mjs
//
// The secret is written the way `Prometheus --pair` writes it (prometheus.config.local_pairing.replace_secret, into the daemon's own
// PROMETHEUS_LOCAL_PAIRING_DIR inside the scratch home); its value and every token stay in this process, and the fixture keeps their SHAPE.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pair_local_696.json', import.meta.url))
const d = await startRealDaemon({ name: 'Pair-local Recorder' })
const pairingDir = join(d.home, '.prometheus/local-pairing')
const shape = (v) =>
  v === null || typeof v !== 'object'
    ? v
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'token' ? (typeof x === 'string' ? `<string ${x.length}>` : typeof x) : x]))
const writeSecret = () =>
  execFileSync(process.env.BEACON_REAL_DAEMON_PY, ['-c', 'from prometheus.config.local_pairing import replace_secret; print(replace_secret())'], {
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: process.env.BEACON_REAL_DAEMON_SRC, HOME: d.home, PROMETHEUS_LOCAL_PAIRING_DIR: pairingDir },
    encoding: 'utf8'
  }).trim()
async function post(path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}
const statusWith = async (token) => (await fetch(`http://127.0.0.1:${d.port}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status
const rec = { daemon: 'Prometheus main (#694 + #696), real create_app', module: d.module.replace(process.env.BEACON_REAL_DAEMON_SRC, '<src>') }
try {
  // What a configured daemon says about itself (no credential), the shape Beacon checks before it sends a secret.
  const hello = await fetch(`http://127.0.0.1:${d.port}/api/hello`)
  rec.hello = { status: hello.status, json: await hello.json() }
  const first = writeSecret()
  rec.secret_shape = { length: first.length, base64url: /^[A-Za-z0-9_-]+$/.test(first) }
  rec.wrong = shape((await post('/api/pair/local', { code: first.slice(0, -1) + (first.endsWith('A') ? 'B' : 'A') })).json)
  const a = await post('/api/pair/local', { code: first, name: 'Beacon on this Mac' })
  rec.first = { status: a.status, json: shape(a.json), is_the_global_token: a.json?.token === d.token, file_after: existsSync(join(pairingDir, 'pair.secret')) }
  rec.first_token_status = await statusWith(a.json?.token)
  rec.again = { status: (await post('/api/pair/local', { code: first })).status }
  // A re-pair (a Beacon reinstall): a fresh secret, a second owner credential, and the first one revoked.
  const second = writeSecret()
  const b = await post('/api/pair/local', { code: second, name: 'Beacon on this Mac' })
  rec.second = { status: b.status, json: shape(b.json) }
  rec.after_repair_first_token_status = await statusWith(a.json?.token)
  rec.after_repair_second_token_status = await statusWith(b.json?.token)
  rec.no_name = shape((await post('/api/pair/local', { code: writeSecret() })).json)
} finally {
  d.stop()
}
writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n')
console.log(JSON.stringify(rec, null, 1))
