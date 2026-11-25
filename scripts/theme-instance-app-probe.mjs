#!/usr/bin/env node
// The skin per Prometheus, IN THE REAL APP, against two stand-in Prometheus on loopback (the real add flow, real folders):
//   - what is picked while on one stays with it; switching swaps to the skin last chosen there, with no step through another skin
//     (a MutationObserver on <html data-theme> records every plate worn across the switch);
//   - two may share a skin; a Prometheus added starts on whatever is showing and keeps it;
//   - an existing Beacon's one skin (the old Beacon-wide setting) becomes its Prometheus's own at the first launch of this version.
//
//   npm run build && npm run probe:theme-instance
//
// PROBE_SHOT_DIR=<dir> writes screenshots there. Scratch profiles only; keys go through safeStorage under --use-mock-keychain.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 20
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
function nodeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'), priv: privateKey }
}
const message = (nonce, id, pub, at) => ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${id ?? ''}`, `node_pub=${pub}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')
function prometheus({ fp, name, token, provider = 'anthropic' }) {
  const key = nodeKey()
  const instanceId = randomUUID()
  const seen = []
  const frames = []
  const rest = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/api/hello') return json(res, 200, { v: '0.9.20', name, agent: 'Atlas', fp, pair: 'approve', tls: false })
      if (req.url === '/api/identity/challenge') {
        const nonce = JSON.parse(body || '{}').nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        return json(res, 200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64') })
      }
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' })
      if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', provider, model: 'stub-model' })
      json(res, 200, [])
    })
  })
  const wsHttp = createServer()
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
    ws.on('message', (m) => frames.push(m.toString()))
    ws.send(JSON.stringify({ type: 'connected' }))
  })
  return { rest, wsHttp, seen, frames, key }
}
const A = prometheus({ fp: 'a'.repeat(16), name: 'Mini', token: 'KEY-A' })
const B = prometheus({ fp: 'b'.repeat(16), name: 'Laptop', token: 'KEY-B', provider: 'ollama' })
const servers = [A, B].flatMap((p) => [p.rest, p.wsHttp])
for (const s of servers) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const api = (p) => `http://127.0.0.1:${p.rest.address().port}`
const ws = (p) => `ws://127.0.0.1:${p.wsHttp.address().port}`
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const SHOTS = process.env.PROBE_SHOT_DIR
const profiles = []
const seedProfile = (legacyTheme) => {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-theme-instance-'))
  profiles.push(profile)
  const settings = legacyTheme ? `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('theme:v1', '${legacyTheme}');` : ''
  execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('mini', '${api(A)}', '${ws(A)}', 1, NULL); ${settings}`])
  return profile
}
const INSTANCE_KEY = 'theme:instance:v1'
const WEAR = `document.documentElement.getAttribute('data-theme')`
let app = null
const ev = (code) => app.page.evaluate(code)
const connected = () => until(async () => (await ev('window.beacon.connection.status()'))?.state === 'connected', 15000)
const setting = (k) => ev(`window.beacon.settings.get(${JSON.stringify(k)})`)
const openSkin = async () => {
  await ev(`(() => { const b = document.querySelector('nav[aria-label="Views"] button[title="Config"]'); b?.click(); return true })()`)
  await until(() => ev(`!!document.querySelector('[data-testid="config-tab-groups"]')`), 8000)
  await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="config-tab-groups"] button')].find((x) => x.textContent.trim() === 'Skin'); b?.click(); return true })()`)
  return until(() => ev(`!!document.querySelector('.skin-grid')`), 5000)
}
/** Pick a plate by its label in the Skin tab. */
const pick = async (label) => {
  await openSkin()
  await ev(`(() => { const c = [...document.querySelectorAll('.skin-card')].find((x) => x.querySelector('.skin-card-name')?.textContent.trim() === ${JSON.stringify(label)}); c?.click(); return !!c })()`)
  await sleep(500)
}
/** Record every plate <html> wears from now on, across whatever happens next. */
const watch = () => ev(`(() => { window.__worn = []; new MutationObserver(() => window.__worn.push(${WEAR})).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); return true })()`)
/** The plates worn in order, a plate set again over itself counted once (the same skin applied twice is not a change). */
const wornSeq = async () => (await ev('window.__worn')).filter((t, i, a) => i === 0 || t !== a[i - 1])
const shot = async (name) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data ?? r.result?.data, 'base64'))
}
try {
  // ── Phase 1: a fresh Beacon on A; pick, add B, switch both ways ───────────────────────────
  console.log('phase 1: pick on A, add B, switch')
  app = await launchApp({ profile: seedProfile(null) })
  check(!!(await connected()), 'on A')
  const aId = (await ev('window.beacon.instances.list()'))[0]?.id
  check((await ev(WEAR)) === 'dark', 'a Beacon that never picked wears NOX')
  await pick('LVX')
  check((await ev(WEAR)) === 'light' && (await setting(INSTANCE_KEY)) === 'light', 'picked LVX on A: worn, and kept for A')
  const added = await ev(`window.beacon.instances.add({ apiBase: ${JSON.stringify(api(B))}, wsUrl: ${JSON.stringify(ws(B))}, token: 'KEY-B' })`)
  check(added?.added === true, 'added B', JSON.stringify(added))
  check(!!(await until(async () => (await ev('window.beacon.instances.list()')).find((i) => i.active)?.id !== aId, 8000)) && !!(await connected()), 'now on B')
  const bId = (await ev('window.beacon.instances.list()')).find((i) => i.active)?.id
  check((await ev(WEAR)) === 'light', 'B started on whatever was showing (LVX)')
  check(await until(async () => (await setting(INSTANCE_KEY)) === 'light', 4000), 'and keeps it as its own')
  await pick('AVRVM')
  check((await ev(WEAR)) === 'avrvm' && (await setting(INSTANCE_KEY)) === 'avrvm', 'picked AVRVM on B')
  await shot('theme-instance-on-b')
  await watch()
  check((await ev(`window.beacon.instances.switch(${JSON.stringify(aId)})`)) === true, 'switch to A')
  await until(async () => (await ev(WEAR)) === 'light', 6000)
  await sleep(1200)
  const toA = await wornSeq()
  check(toA.join() === 'light', 'on A: its own skin (LVX), and nothing else was worn on the way (no flash of B\'s)', toA.join(' > '))
  check((await setting(INSTANCE_KEY)) === 'light', 'A still has LVX')
  await shot('theme-instance-on-a')
  await watch()
  check((await ev(`window.beacon.instances.switch(${JSON.stringify(bId)})`)) === true, 'switch back to B')
  await until(async () => (await ev(WEAR)) === 'avrvm', 6000)
  await sleep(1200)
  const toB = await wornSeq()
  check(toB.join() === 'avrvm', 'on B: AVRVM again, with nothing else worn on the way', toB.join(' > '))
  // Two may share a skin.
  await pick('LVX')
  check((await ev(WEAR)) === 'light' && (await setting(INSTANCE_KEY)) === 'light', 'B picks LVX too: two Prometheus may share a skin')
  await watch()
  await ev(`window.beacon.instances.switch(${JSON.stringify(aId)})`)
  await sleep(1500)
  check((await ev(WEAR)) === 'light' && (await wornSeq()).every((t) => t === 'light'), 'switching between two on the same skin never leaves it')
  // SYSTEMA stays its own.
  await pick('SYSTEMA')
  check((await setting(INSTANCE_KEY)) === 'system', 'A picks SYSTEMA: kept as "system"')
  await ev(`window.beacon.instances.switch(${JSON.stringify(bId)})`)
  await sleep(1500)
  check((await ev(WEAR)) === 'light' && (await setting(INSTANCE_KEY)) === 'light', 'B did not follow A onto SYSTEMA')
  await ev(`window.beacon.instances.switch(${JSON.stringify(aId)})`)
  await sleep(1500)
  check((await setting(INSTANCE_KEY)) === 'system' && ['dark', 'light'].includes(await ev(WEAR)), 'and A is still on SYSTEMA')
  await app.quit().catch(() => undefined)
  app = null

  // ── Phase 2: an existing Beacon with one skin, before this version ────────────────────────
  console.log('phase 2: an existing Beacon\'s one skin')
  app = await launchApp({ profile: seedProfile('aether') })
  check(!!(await connected()), 'on A (an existing profile that had picked AETHER)')
  check(await until(async () => (await ev(WEAR)) === 'aether', 6000), 'it wears AETHER as before')
  check(await until(async () => (await setting(INSTANCE_KEY)) === 'aether', 4000), 'and AETHER is now A\'s own skin')
  const added2 = await ev(`window.beacon.instances.add({ apiBase: ${JSON.stringify(api(B))}, wsUrl: ${JSON.stringify(ws(B))}, token: 'KEY-B' })`)
  check(added2?.added === true, 'added B')
  await until(async () => (await ev('window.beacon.instances.list()')).find((i) => i.active)?.label !== 'mini', 8000)
  await connected()
  check((await ev(WEAR)) === 'aether' && (await until(async () => (await setting(INSTANCE_KEY)) === 'aether', 4000)), 'B starts on what is showing (AETHER)')
  await pick('NOX')
  const aList = await ev('window.beacon.instances.list()')
  const a2 = aList.find((i) => !i.active)?.id
  await ev(`window.beacon.instances.switch(${JSON.stringify(a2)})`)
  await sleep(1500)
  check((await ev(WEAR)) === 'aether', 'A kept AETHER when B went to NOX')
  await app.quit().catch(() => undefined)
  app = null

} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of servers) s.close()
  for (const p of profiles) rmSync(p, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 && checks >= MIN_CHECKS ? 0 : 1)
