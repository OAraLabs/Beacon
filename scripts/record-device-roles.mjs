#!/usr/bin/env node
// record-device-roles — what a REAL Prometheus answers GET /api/devices for each kind of credential Beacon can hold, into
// src/main/fixtures/device_roles.json, so @shared/device-role reads the real shapes: a scoped (approved) device, an owner device, and
// the global API token. Plus one owner-only route as each (GET /api/status), to record what "limited" means on the wire.
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<a python with its dependencies>
//   node scripts/record-device-roles.mjs
//
// The daemon is scripts/lib/serve_real_daemon.py: the real app on an ephemeral 127.0.0.1 port, a throwaway home and token. The two
// devices are minted the way Prometheus mints them (POST /api/devices with the global token: owner false, then owner true from this
// Mac). Tokens and ids are throwaway and are not recorded (ids are replaced by placeholders).
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/device_roles.json', import.meta.url))
let source = 'unknown'
try {
  source = execFileSync('git', ['-C', dirname(process.env.BEACON_REAL_DAEMON_SRC), 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim()
} catch {
  /* not a clone */
}
const d = await startRealDaemon({ name: 'Role Record Prometheus', ws: false })
const as = async (token, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await r.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text.slice(0, 200)
  }
  return { status: r.status, body: json }
}
try {
  const scoped = await d.owner('POST', '/api/devices', { name: 'Sam’s MacBook', platform: 'macos', owner: false })
  const owner = await d.owner('POST', '/api/devices', { name: 'Beacon on this Mac', platform: 'macos', owner: true })
  if (scoped.status !== 201 || owner.status !== 201) throw new Error(`minting failed: ${JSON.stringify({ scoped, owner })}`)
  const ids = new Map([[scoped.body.id, '<scoped-device-id>'], [owner.body.id, '<owner-device-id>']])
  const scrub = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && ids.has(x) ? ids.get(x) : typeof x === 'number' && x > 1e9 ? 1760000000 : x)))
  const answers = {
    global_token: await as(d.token, 'GET', '/api/devices'),
    scoped_device: await as(scoped.body.token, 'GET', '/api/devices'),
    owner_device: await as(owner.body.token, 'GET', '/api/devices'),
    status_as_scoped_device: await as(scoped.body.token, 'GET', '/api/status'),
    status_as_owner_device: { status: (await as(owner.body.token, 'GET', '/api/status')).status }
  }
  writeFileSync(OUT, JSON.stringify({ about: 'Real answers from Prometheus (scripts/lib/serve_real_daemon.py, a throwaway home and token on 127.0.0.1) to GET /api/devices for the three kinds of credential Beacon can hold, and GET /api/status as a scoped and an owner device. Recorded by scripts/record-device-roles.mjs; device ids replaced, times fixed, no token kept.', source, recorded: new Date().toISOString().slice(0, 10), answers: scrub(answers) }, null, 2) + '\n')
  console.log(`[record] wrote ${OUT}`)
  for (const [k, v] of Object.entries(answers)) console.log(`  ${k}: ${v.status} ${JSON.stringify(scrub(v.body ?? null)).slice(0, 220)}`)
} finally {
  d.stop()
  rmSync(d.home, { recursive: true, force: true })
}
