#!/usr/bin/env node
// record-network-setting — record what a REAL Prometheus answers to the home-network switch: GET/PUT /api/network
// (Prometheus #700, on main) and POST /api/restart (Prometheus #724), into src/main/fixtures/network_setting_700.json, so
// smoke:network-setting holds Beacon's reading to the daemon's real answers and not to a reading of the contract.
//
//   export BEACON_SIGNED_PYTHON=<a python3.12 with Prometheus's dependencies, e.g. the notarized app's signed one>
//   export BEACON_NETWORK_SRC=<prometheus clone at main, with #700>/src  BEACON_RESTART_SRC=<prometheus clone at #724>/src
//   node scripts/record-network-setting.mjs
//
// Everything stays on THIS Mac: loopback only, scratch homes, ephemeral ports (never 8005 or 8010). home_network is SAVED and
// then saved back to this_mac without a restart in between, so no daemon ever listens on the home network here. The master
// token and device tokens stay in this process.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PY = process.env.BEACON_SIGNED_PYTHON
const NET = process.env.BEACON_NETWORK_SRC
// Both routes are on Prometheus main since #724 merged (2026-10-11): one source does for both, unless told otherwise.
const RST = process.env.BEACON_RESTART_SRC || NET
if (!PY || !NET) {
  console.log('[record] SKIPPED: set BEACON_SIGNED_PYTHON and BEACON_NETWORK_SRC (and BEACON_RESTART_SRC for another tree)')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/network_setting_700.json', import.meta.url))
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
const procs = []
const homes = []
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
/** A configured daemon from `src` in a scratch home, on loopback, made the way Beacon makes one. */
async function configured(src) {
  const api = await freePort()
  const ws = await freePort()
  if ([8005, 8006, 8010, 8011].includes(api) || [8005, 8006, 8010, 8011].includes(ws)) throw new Error('refusing the real ports')
  const home = mkdtempSync(join(tmpdir(), 'beacon-record-net-'))
  homes.push(home)
  mkdirSync(join(home, 'tmp'))
  const base = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: src, PROMETHEUS_INSTALL_KIND: 'app' }
  const start = (env) => {
    const p = spawn(PY, ['-B', '-m', 'prometheus', 'daemon'], { env: { ...base, ...env }, stdio: 'ignore', detached: true })
    procs.push(p)
    return p
  }
  const call = async (method, path, body, token, headers = {}) => {
    try {
      const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
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
  let p = start({ PROMETHEUS_WEB_BIND: '127.0.0.1', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws) })
  if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error(`setup mode did not answer (${src})`)
  const secret = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
  await until(() => existsSync(secret), 5000)
  const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secret, 'utf8').trim() })).json?.token
  await call('POST', '/api/setup/configure', { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-ant-record-placeholder-not-a-key' }, master)
  await call('POST', '/api/setup/complete', {}, master)
  if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not come up configured')
  await stop(p)
  // Started the way an installed daemon is: no --bind and no PROMETHEUS_WEB_BIND, so the file decides (bind_source "config").
  p = start({})
  if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not restart from its config')
  const device = (await call('POST', '/api/devices', { name: 'Recorder phone', platform: 'ios' }, master)).json?.token
  return { p, call, master, device }
}
const pick = (r) => ({ status: r.status, json: r.json })
const rec = { recorded: new Date().toISOString().slice(0, 10) }
try {
  // ── GET/PUT /api/network: Prometheus main (#700) ──
  const a = await configured(NET)
  rec.network = { src: process.env.BEACON_SRC_LABEL ?? 'Prometheus main' }
  rec.network.get_this_mac = pick(await a.call('GET', '/api/network', undefined, a.master))
  rec.network.put_home_network = pick(await a.call('PUT', '/api/network', { mode: 'home_network' }, a.master))
  rec.network.get_pending = pick(await a.call('GET', '/api/network', undefined, a.master))
  rec.network.put_this_mac_back = pick(await a.call('PUT', '/api/network', { mode: 'this_mac' }, a.master))
  rec.network.get_after_back = pick(await a.call('GET', '/api/network', undefined, a.master))
  rec.network.put_open = pick(await a.call('PUT', '/api/network', { mode: 'open' }, a.master))
  rec.network.put_extra_key = pick(await a.call('PUT', '/api/network', { mode: 'this_mac', bind: '0.0.0.0' }, a.master))
  rec.network.get_no_token = pick(await a.call('GET', '/api/network'))
  rec.network.get_scoped_device = pick(await a.call('GET', '/api/network', undefined, a.device))
  rec.network.put_scoped_device = pick(await a.call('PUT', '/api/network', { mode: 'home_network' }, a.device))
  await stop(a.p)
  // A Prometheus from before #724 (no restart route): what Beacon gets when it asks anyway. Asked of a daemon from that older tree.
  if (process.env.BEACON_NO_ROUTE_SRC) {
    const old = await configured(process.env.BEACON_NO_ROUTE_SRC)
    rec.network.restart_without_route = { ...pick(await old.call('POST', '/api/restart', undefined, old.master)), src: 'Prometheus main 76134d6 (before #724)' }
    await stop(old.p)
  }
  // ── POST /api/restart: Prometheus #724 ──
  const b = await configured(RST)
  rec.restart = { src: process.env.BEACON_SRC_LABEL ?? 'Prometheus main' }
  rec.restart.network_before = pick(await b.call('GET', '/api/network', undefined, b.master))
  const before = (await b.call('GET', '/api/hello')).json
  rec.restart.with_origin = pick(await b.call('POST', '/api/restart', undefined, b.master, { origin: 'http://localhost:3000' }))
  rec.restart.scoped_device = pick(await b.call('POST', '/api/restart', undefined, b.device))
  rec.restart.no_token = pick(await b.call('POST', '/api/restart'))
  const t0 = Date.now()
  rec.restart.operator = pick(await b.call('POST', '/api/restart', undefined, b.master))
  let gone = false
  const back = await until(async () => {
    const h = await b.call('GET', '/api/hello')
    if (h.status === 0) gone = true
    return gone && h.status === 200 ? h : null
  }, 60000)
  rec.restart.went_away = gone
  rec.restart.back_ms = back ? Math.round((Date.now() - t0) / 100) * 100 : null
  rec.restart.back_same_fp = !!back && back.json?.fp === before?.fp && !!before?.fp
  rec.restart.same_process = b.p.exitCode === null && b.p.signalCode === null
  rec.restart.master_still_works = (await b.call('GET', '/api/status', undefined, b.master)).status
  rec.restart.network_after = pick(await b.call('GET', '/api/network', undefined, b.master))
  await stop(b.p)
} finally {
  for (const p of procs) await stop(p)
  for (const h of homes) rmSync(h, { recursive: true, force: true })
}
writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n')
console.log(JSON.stringify(rec, null, 1))
