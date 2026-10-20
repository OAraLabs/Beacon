#!/usr/bin/env node
// models-health-app-probe — the Models rows on Mission and Config › Models, in the BUILT app, against a REAL Prometheus (owner decision, 2026-10-18,
// for 0.4.8). Prometheus checks a local model's server once at boot and calls the reading stale 60 s later (backend_probe.ttl_s); the
// film's take showed "Local · default STALE" at 61 s. Beacon now never shows stale as a status: an owner looking at a stale row has it
// checked again (POST /api/backends/<name>/probe, rate-limited), and the row reads UP or DOWN from that.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies>  BEACON_PROMETHEUS_SRC=<prometheus clone>/src
//   npm run build && node scripts/models-health-app-probe.mjs
//
// The world is scripts/lib/model-daemon.mjs: scratch homes, loopback, ephemeral ports, the mDNS sandbox and the listen tripwire.
//   L  a local model (the world's stand-in llama.cpp server) that is up: opened more than 60 s after Prometheus started, the Local row
//      reads UP on Mission and Config › Models, "stale" is nowhere, a re-check was asked for, and not more than a few times;
//   D  the same server stopped: the row reads DOWN, with a plain one-line reason (never the probe's raw error);
//   C  cloud only (Anthropic, the way Path A sets it up): the default row is named by its model, not "Local".
// macOS (app-driver).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { modelDaemonConfigured, startWorld } from './lib/model-daemon.mjs'
import { startChecks, waitFor } from './lib/probe-kit.mjs'

if (process.platform !== 'darwin' || !modelDaemonConfigured()) {
  console.log('[probe] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC. A skipped probe is not a passed one.')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if ((k.startsWith('BEACON_') && !['BEACON_SIGNED_PYTHON', 'BEACON_PROMETHEUS_SRC'].includes(k)) || k.startsWith('PROMETHEUS_')) delete process.env[k]
const check = startChecks('models-health', 13)
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const RAW_ERR = /ConnectError|Connect call failed|ECONNREFUSED|Errno|Traceback|probe timed out|httpx|All connection attempts failed/

async function clickBy(app, finder) {
  const at = await app.page.evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === el || el.contains(h)) } })()`)
  if (!at?.hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
const rail = (l) => `() => [...document.querySelectorAll('nav[aria-label="Views"] button')].find((b) => b.offsetParent && b.innerText.trim() === ${JSON.stringify(l)})`
const tab = (l) => `() => [...document.querySelectorAll('button,[role=tab]')].find((b) => b.offsetParent && !b.closest('nav[aria-label="Views"]') && b.getBoundingClientRect().top < 240 && b.innerText.trim() === ${JSON.stringify(l)})`
async function go(app, page, sub) {
  await waitFor(() => clickBy(app, rail(page)), Boolean, 8000)
  if (sub) await waitFor(() => clickBy(app, tab(sub)), Boolean, 8000)
  await sleep(1500)
}
/** Mission's Models card, as drawn: each row's text and its status word. */
const missionModels = (app) =>
  app.page.evaluate(`(() => {
    const card = [...document.querySelectorAll('section, div')].find((d) => /^models ·/i.test((d.firstElementChild?.innerText ?? '').trim()) || /^MODELS ·/.test((d.innerText ?? '').trim()))
    return card ? card.innerText : null
  })()`)
const pageText = (app) => app.page.evaluate('document.body.innerText')

const profiles = []
let app = null
let world = null
async function launchOwner(d, token) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]
  Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(d.api), BEACON_GATEWAY_WS_PORT: String(d.ws) })
  const profile = mkdtempSync(join(tmpdir(), 'beacon-models-health-'))
  profiles.push(profile)
  const a = await launchApp({ profile })
  // Every request Beacon sends to the backend probe route, recorded in main (its REST goes through the global fetch there). Before the
  // connection: Mission is the landing view, and it asks the moment it has the owner's role.
  await a.mainEval(`(() => { globalThis.__probes = []; if (!globalThis.__probeHooked) { const f = globalThis.fetch; globalThis.fetch = async (...x) => { const u = String(x[0] && x[0].url ? x[0].url : x[0]); if (/\\/api\\/backends(\\/|\\?|$)/.test(u)) globalThis.__probes.push((x[1] && x[1].method || 'GET') + ' ' + u.replace(/^https?:\\/\\/[^/]+/, '')); return f(...x) }; globalThis.__probeHooked = true } return true })()`)
  const saved = await a.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.api}, wsPort: ${d.ws}, token: ${JSON.stringify(token)} }).then((r) => r.ok)`)
  const up = await waitFor(async () => (await a.page.evaluate('window.beacon.connection.status()'))?.state, (s) => s === 'connected', 20000)
  return { a, saved, up }
}
const probes = async () => JSON.parse(await app.mainEval('JSON.stringify(globalThis.__probes ?? [])'))

try {
  world = await startWorld()
  // ── L: a local model, up ──
  console.log('\n[probe] === L. a local model, up, read more than 60 s after Prometheus started ===')
  const d = await world.localConfigured()
  check(d.listening().every((n) => n.startsWith('127.0.0.1:')), 'setup: a Prometheus with a local model, every listener on 127.0.0.1', d.listening().join(' '))
  const before = await d.call('GET', '/api/models', undefined, d.master)
  const localRow = (before.json?.models ?? []).find((m) => m.key === 'local')
  check(localRow?.backend === 'local' && localRow?.health && localRow.health.ok === true, 'setup: its Local row has a health reading, and the boot check found the server', JSON.stringify(localRow?.health))
  // Wait out the daemon's 60 s, so the reading is stale when Beacon first reads it (the film's 61 s).
  const wait = Math.max(0, d.bootedAt + 65_000 - Date.now())
  console.log(`[probe] waiting ${Math.round(wait / 1000)} s for the boot reading to go stale`)
  await sleep(wait)
  const staleNow = (await d.call('GET', '/api/models', undefined, d.master)).json?.models?.find((m) => m.key === 'local')?.health?.stale
  check(staleNow === true, 'setup: Prometheus now calls the Local reading stale (what the film saw)', String(staleNow))
  const L = await launchOwner(d, d.master)
  app = L.a
  check(L.saved === true && L.up === 'connected', 'setup: Beacon connected as the owner', JSON.stringify({ saved: L.saved, up: L.up }))
  await go(app, 'Mission')
  const seen = []
  for (let i = 0; i < 10; i++) {
    seen.push(norm(await missionModels(app)))
    await sleep(1500)
  }
  const lastSeen = seen[seen.length - 1]
  check(seen.every((t) => !/stale/i.test(t)) && /Local[^\n]*default[\s\S]*UP/i.test(lastSeen), 'Mission: the Local row reads UP, and "stale" is never shown, though Prometheus\'s reading was stale', seen.find((t) => /stale/i.test(t)) ?? (lastSeen || `no Models card; the page reads: ${norm(await pageText(app)).slice(0, 400)}`))
  const asked = await probes()
  check(asked.some((p) => /^POST \/api\/backends\/local\/probe$/.test(p)) && asked.length <= 3, `a fresh check was asked for (the owner route), and not more than a few times in 15 s (${asked.length})`, JSON.stringify(asked))
  await go(app, 'Config', 'Models')
  const cfg = norm(await waitFor(() => pageText(app), (t) => !/Loading/.test(t), 12000))
  check(!/\bstale\b/i.test(cfg) && /\bup\b/i.test(cfg), 'Config › Models: the local row is up, and "stale" is nowhere (not as a state, not in the summary)', cfg.match(/.{0,80}stale.{0,40}/i)?.[0] ?? cfg.slice(0, 200))

  // ── D: the same server stopped ──
  console.log('\n[probe] === D. the local server stopped ===')
  await world.llama.stop()
  await go(app, 'Mission')
  const down = await waitFor(async () => norm(await missionModels(app)), (t) => /DOWN/.test(t), 90_000)
  check(/DOWN/.test(down) && !/stale/i.test(down), 'Mission: with the server stopped, the Local row reads DOWN (from the check, though the daemon says available: true)', down)
  check(!RAW_ERR.test(down) && /(answer|reach|respond|check)/i.test(down), 'and says why in plain words, one line, not the probe\'s raw error', down)
  await go(app, 'Config', 'Models')
  const cfgDown = norm(await waitFor(() => pageText(app), (t) => /\bdown\b/i.test(t), 20000))
  check(/\bdown\b/i.test(cfgDown) && !RAW_ERR.test(cfgDown), 'Config › Models: down, with the plain reason (the raw error at most in a tooltip)', cfgDown.match(/.{0,80}down.{0,80}/i)?.[0] ?? '')
  const afterDown = await probes()
  check(afterDown.length <= 12, `the re-checks stay rate-limited while it is down (${afterDown.length} in all)`, JSON.stringify(afterDown))
  await app.quit()
  app = null

  // ── C: cloud only ──
  console.log('\n[probe] === C. cloud only (Anthropic, as Path A sets it up) ===')
  const c = await world.configured()
  const C = await launchOwner(c, c.master)
  app = C.a
  await go(app, 'Mission')
  const cloud = norm(await waitFor(async () => norm(await missionModels(app)), (t) => /default/.test(t), 15000))
  check(
    /default/.test(cloud) && !/\bLocal\b[^\n]{0,4}·\s*default/.test(cloud) && /sonnet|claude/i.test(cloud) && /·\s*default\s+(KEY|SUB|RDY)\b/.test(cloud),
    'Mission: the cloud default row is named by its model (claude-sonnet-5), not "Local", and answers like a cloud row (its key), not an unchecked UP',
    cloud
  )
  await go(app, 'Config', 'Models')
  const cloudCfg = norm(await waitFor(() => pageText(app), (t) => !/Loading/.test(t), 12000))
  check(!/\blocal\b\s+(anthropic|claude)/i.test(cloudCfg), 'Config › Models: the cloud default is not called "local" either', cloudCfg.match(/.{0,60}(local|anthropic).{0,60}/i)?.[0] ?? '')
  await app.quit()
  app = null
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  if (world) {
    const r = await world.stopAll()
    if (r.alive || r.tripped.length) console.log(`[probe] world teardown: alive ${r.alive}, tripped ${r.tripped.join(' | ')}`)
  }
  await sleep(500)
  for (const p of profiles) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
