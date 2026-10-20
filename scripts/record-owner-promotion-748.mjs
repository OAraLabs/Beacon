#!/usr/bin/env node
// record-owner-promotion-748 — what a REAL Prometheus (main with #748) answers when a Beacon on another computer redeems an owner
// code: POST /api/pair/owner, and around it the code's mint (what `oara pair --owner` asks, from this host, with the API token) and
// status. Into src/main/fixtures/owner_promotion_748.json, so smoke:owner-promotion holds Beacon's reading to the daemon's real answers.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies, e.g. ~/projects/Prometheus/.venv/bin/python>
//   export BEACON_PROMETHEUS_SRC=<prometheus tree at main, with #748>/src
//   node scripts/record-owner-promotion-748.mjs
//
// A scratch home on loopback (scripts/lib/model-daemon.mjs: mDNS sandbox and listen tripwire, each proved first). No token or code
// is recorded: each is replaced by its shape.
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { modelDaemonConfigured, startWorld } from './lib/model-daemon.mjs'

if (process.platform !== 'darwin' || !modelDaemonConfigured()) {
  console.log('[record] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/owner_promotion_748.json', import.meta.url))
const world = await startWorld()
const rec = { recorded: new Date().toISOString().slice(0, 10), daemon: 'Prometheus main with #748 (4122b7e), configured, scratch home, loopback' }
const secrets = []
let homeDir = ''
try {
  const d = await world.configured()
  homeDir = d.home
  secrets.push(d.master, d.device)
  const raw = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${d.api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json }
  }
  const mint = async () => {
    const r = await raw('POST', '/api/pair/owner-codes', undefined, { authorization: `Bearer ${d.master}` })
    if (r.json?.code) secrets.push(r.json.code, r.json.code.replace('-', ''))
    return r
  }
  const R = '/api/pair/owner'
  const me = { device_name: 'Probe MacBook', platform: 'macos' }
  const m1 = await mint()
  rec.mint = m1
  rec.redeem = {
    wrong: await raw('POST', R, { code: '0000-0000', ...me }),
    code_as_number: await raw('POST', R, { code: 12345678, ...me }),
    no_name: await raw('POST', R, { code: m1.json?.code, platform: 'macos' }),
    not_json: await raw('POST', R, 'nope'),
    from_a_browser: await raw('POST', R, { code: m1.json?.code, ...me }, { origin: 'https://elsewhere.example' }),
    ok: await raw('POST', R, { code: m1.json?.code, ...me })
  }
  const owner = rec.redeem.ok.json?.token
  if (owner) secrets.push(owner)
  rec.redeem.again = await raw('POST', R, { code: m1.json?.code, ...me })
  rec.status_after = await raw('GET', `/api/pair/owner-codes/${m1.json?.code_id}`, undefined, { authorization: `Bearer ${d.master}` })
  rec.owner_reads_model = { status: (await raw('GET', '/api/model', undefined, { authorization: `Bearer ${owner}` })).status }
  rec.owner_mints = await raw('POST', '/api/pair/owner-codes', undefined, { authorization: `Bearer ${owner}` })
  rec.device_mints = await raw('POST', '/api/pair/owner-codes', undefined, { authorization: `Bearer ${d.device}` })
  // What Beacon sends: the code with spaces as typed? No: Beacon sends the code it normalised. With its current key as a bearer, and
  // nothing else: does the public route mind a credential it does not need?
  const m2 = await mint()
  rec.redeem.with_bearer = await raw('POST', R, { code: m2.json?.code?.replace('-', ''), ...me }, { authorization: `Bearer ${d.master}` })
  if (rec.redeem.with_bearer.json?.token) secrets.push(rec.redeem.with_bearer.json.token)
  const devices = await raw('GET', '/api/devices', undefined, { authorization: `Bearer ${d.master}` })
  rec.devices_after = { status: devices.status, owners_named: (devices.json?.devices ?? devices.json ?? []).filter?.((x) => x.owner || x.is_owner).map((x) => ({ name: x.name, platform: x.platform, owner: x.owner ?? x.is_owner, marked_by: x.marked_by ?? x.owner_source })) }
  rec.listened = d.listening()
} finally {
  const end = await world.stopAll()
  rec.tripwire = end.tripped
}
let text = JSON.stringify(rec, null, 2).split(homeDir).join('<home>').split(hostname()).join('<this Mac>')
for (const s of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(s).join(/^\d{4}-?\d{4}$/.test(s) ? '<8 digits>' : '<token>')
if (rec.tripwire.length) throw new Error(`the tripwire fired: ${rec.tripwire.join(' | ')}`)
writeFileSync(OUT, text + '\n')
console.log(text)
