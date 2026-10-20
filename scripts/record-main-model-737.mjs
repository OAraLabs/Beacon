#!/usr/bin/env node
// record-main-model-737 — what a REAL configured Prometheus (main with #737) answers to the main-model calls: GET/PUT /api/model
// and POST /api/model/check-key, into src/main/fixtures/main_model_737.json, so smoke:main-model holds Beacon's reading to the
// daemon's real answers and not to a reading of the contract.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies, e.g. ~/projects/Prometheus/.venv/bin/python>
//   export BEACON_PROMETHEUS_SRC=<prometheus tree at main, with #737>/src
//   node scripts/record-main-model-737.mjs
//
// Nothing leaves this Mac: the key check is pointed at a stand-in provider (scripts/lib/model-daemon.mjs, which also proves the
// mDNS sandbox and the listen tripwire before any daemon starts). Every key is a probe key; none is recorded.
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GOOD, modelDaemonConfigured, startWorld, until } from './lib/model-daemon.mjs'

if (process.platform !== 'darwin' || !modelDaemonConfigured()) {
  console.log('[record] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/main_model_737.json', import.meta.url))
const BAD = 'sk-ant-api03-refused' + 'z'.repeat(40)
const world = await startWorld()
const rec = { recorded: new Date().toISOString().slice(0, 10), daemon: 'Prometheus main with #737 and #744 (70a52f7), configured for Anthropic, scratch home, stand-in provider' }
let homeDir = ''
try {
  const d = await world.configured()
  homeDir = d.home
  const pick = ({ status, json }) => ({ status, json })
  const M = '/api/model'
  const C = '/api/model/check-key'
  rec.get_configured = pick(await d.call('GET', M, undefined, d.master))
  rec.get_as_device = pick(await d.call('GET', M, undefined, d.device))
  rec.check = {
    held: pick(await d.call('POST', C, { provider: 'anthropic' }, d.master)),
    ok_openrouter: pick(await d.call('POST', C, { provider: 'openrouter', api_key: GOOD.openrouter }, d.master)),
    bad_anthropic: pick(await d.call('POST', C, { provider: 'anthropic', api_key: BAD }, d.master)),
    missing_openai: pick(await d.call('POST', C, { provider: 'openai' }, d.master)),
    not_json: pick(await d.call('POST', C, 'nope', d.master)),
    unsupported: pick(await d.call('POST', C, { provider: 'llama_cpp', api_key: GOOD.openai }, d.master))
  }
  world.stub.credit = false
  rec.check.no_credit_openrouter = pick(await d.call('POST', C, { provider: 'openrouter', api_key: GOOD.openrouter }, d.master))
  world.stub.credit = true
  rec.put = {
    key_rejected: pick(await d.call('PUT', M, { provider: 'anthropic', api_key: BAD }, d.master)),
    unsupported: pick(await d.call('PUT', M, { provider: 'llama_cpp' }, d.master)),
    base_url: pick(await d.call('PUT', M, { provider: 'openai', api_key: GOOD.openai, base_url: 'https://elsewhere.example' }, d.master)),
    missing_key: pick(await d.call('PUT', M, { provider: 'openai' }, d.master)),
    bad_model: pick(await d.call('PUT', M, { provider: 'openai', model: '', api_key: GOOD.openai }, d.master)),
    as_device: pick(await d.call('PUT', M, { provider: 'openrouter', api_key: GOOD.openrouter }, d.device)),
    gemini_unchecked: pick(await d.call('PUT', M, { provider: 'gemini', api_key: 'AIza-probe-' + 'g'.repeat(30) }, d.master))
  }
  rec.get_after_gemini = pick(await d.call('GET', M, undefined, d.master))
  world.stub.credit = false
  rec.put.openrouter_no_credit = pick(await d.call('PUT', M, { provider: 'openrouter', api_key: GOOD.openrouter }, d.master))
  world.stub.credit = true
  rec.put.openrouter = pick(await d.call('PUT', M, { provider: 'openrouter', api_key: GOOD.openrouter }, d.master))
  rec.get_pending = pick(await d.call('GET', M, undefined, d.master))
  // The restart applies it: the same process re-executes, on the same loopback ports.
  rec.restart = pick(await d.call('POST', '/api/restart', undefined, d.master))
  await until(async () => (await d.call('GET', '/api/hello')).status !== 200, 15000, 100)
  await until(async () => (await d.call('GET', M, undefined, d.master)).status === 200, 60000)
  rec.get_after_restart = pick(await d.call('GET', M, undefined, d.master))
  rec.listened = d.listening()
} finally {
  const end = await world.stopAll()
  rec.tripwire = end.tripped
  if (end.alive) console.log(`[record] WARNING: ${end.alive} daemon(s) still alive`)
}
const host = hostname()
let text = JSON.stringify(rec, null, 2)
text = text.split(homeDir).join('<home>').split(host).join('<this Mac>')
for (const k of [...Object.values(GOOD), BAD, ...world.stub.issued.map((i) => i.key)]) if (text.includes(k)) throw new Error('a key would be recorded: refusing')
if (rec.tripwire.length) throw new Error(`the tripwire fired: ${rec.tripwire.join(' | ')}`)
writeFileSync(OUT, text + '\n')
console.log(text)
