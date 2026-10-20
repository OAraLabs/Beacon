#!/usr/bin/env node
// make-owner-app-probe — Settings → "Make this Beacon an owner" in the BUILT app, against a REAL Prometheus (main with #748), with
// real clicks and typing.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies, e.g. ~/projects/Prometheus/.venv/bin/python>
//   export BEACON_PROMETHEUS_SRC=<prometheus tree at main, with #748>/src
//   npm run build && npm run probe:make-owner [screenshot-dir]
//
// The world (scripts/lib/model-daemon.mjs): a configured daemon in a scratch home on loopback, mDNS sandbox and listen tripwire each
// proved first. Beacon is connected with the API token, as a Beacon on another computer is after typing it into Settings. The code
// is minted the way `oara pair --owner` mints it (POST /api/pair/owner-codes with the API token, from this host).
//
// 1. The section is there, and says how to get a code.
// 2. A wrong code: "That code didn't work…", and Beacon still holds the API token.
// 3. A real code, typed as shown ("1234 5678" with the space): "This Beacon is now an owner." Prometheus lists an owner device under
//    this computer's name, marked owner-code; the code is spent; Beacon's kept credential is that owner token and not the API token;
//    the connection comes back up with it, and it reads what only the owner may (GET /api/model).
// 4. No token in the page.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './app-driver.mjs'
import { modelDaemonConfigured, sleep, startWorld, until } from './lib/model-daemon.mjs'

const SHOTS = process.argv[2] ?? null
if (process.platform !== 'darwin' || !modelDaemonConfigured()) {
  console.log('[probe] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 700)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 17
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const world = await startWorld()
const profile = mkdtempSync(join(tmpdir(), 'beacon-make-owner-profile-'))
let app = null
const SECTION = '[data-testid="make-owner"]'
const section = () => app.page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(SECTION)}); if (!s) return null; const b = s.querySelector('[data-testid="make-owner-go"]'); return { text: s.innerText, go: !!b && !b.disabled } })()`)
const settle = (pred, ms = 10000) => until(async () => { const s = await section(); return s && pred(s) ? s : null }, ms, 150)
async function click(selector) {
  const at = await app.page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!(hit && (hit === el || el.contains(hit)))) return 'covered'
    if (el.disabled) return 'disabled'
    return { x, y }
  })()`)
  if (typeof at === 'string') return at
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return 'clicked'
}
async function type(selector, value) {
  const r = await click(selector)
  if (r !== 'clicked') return r
  await app.page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.select?.(); return true })()`)
  await app.page.send('Input.insertText', { text: value })
  return 'typed'
}
async function shot(name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
/** The credential Beacon keeps, as a digest (never printed). */
const keptDigest = () =>
  app.mainEval(`(() => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto')
    const f = path.join(__electron.app.getPath('userData'), 'api-credential.bin')
    return fs.existsSync(f) ? crypto.createHash('sha256').update(__electron.safeStorage.decryptString(fs.readFileSync(f))).digest('hex') : null
  })()`)

try {
  const d = await world.configured()
  Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(d.api), BEACON_GATEWAY_WS_PORT: String(d.ws) })
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  const saved = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.api}, wsPort: ${d.ws}, token: ${JSON.stringify(d.master)} }).then((r) => r.ok)`)
  check(saved === true && (await keptDigest()) === sha256(d.master), 'Beacon holds the API token, as a Beacon on another computer does after typing it in Settings')
  await app.page.evaluate(`window.dispatchEvent(new Event('beacon:open-settings')); true`)

  // ── 1. the section ───────────────────────────────────────────────────────────────────────────────────────────────────
  const s1 = await settle((s) => /Make this Beacon an owner/.test(s.text))
  check(!!s1 && /oara pair --owner/.test(s1.text) && /computer running Prometheus/.test(s1.text), 'Settings → Make this Beacon an owner: how to get a code (oara pair --owner on the computer running Prometheus)', s1?.text)
  check(!!s1 && !s1.go, 'the button waits for a code', JSON.stringify(s1))
  await shot('1-section')

  // ── 2. a wrong code ──────────────────────────────────────────────────────────────────────────────────────────────────
  check((await type('[data-testid="make-owner-code"]', '0000-0000')) === 'typed' && (await click('[data-testid="make-owner-go"]')) === 'clicked', 'a wrong code, then the button')
  const s2 = await settle((s) => /didn't work/.test(s.text))
  check(!!s2 && !/now an owner/.test(s2.text) && (await keptDigest()) === sha256(d.master), "\"That code didn't work…\" (and never \"now an owner\"), and Beacon still holds the API token", s2?.text)

  // ── 3. the real code ─────────────────────────────────────────────────────────────────────────────────────────────────
  const mint = await d.call('POST', '/api/pair/owner-codes', undefined, d.master)
  // The route answers the eight digits; `oara pair --owner` prints them as 1234-5678 (owner_codes.format_code).
  const code = String(mint.json?.code ?? '').replace('-', '')
  check(mint.status === 201 && /^\d{8}$/.test(code), 'a code is minted the way oara pair --owner mints it', JSON.stringify({ status: mint.status, shape: String(code).replace(/\d/g, '9') }))
  check((await type('[data-testid="make-owner-code"]', `${code.slice(0, 4)} ${code.slice(4)}`)) === 'typed' && (await click('[data-testid="make-owner-go"]')) === 'clicked', 'the code typed as shown, with a space, then the button')
  const s3 = await settle((s) => /now an owner/.test(s.text), 15000)
  check(!!s3, '"This Beacon is now an owner."', JSON.stringify(await section()))
  await shot('3-owner')
  const status = await d.call('GET', `/api/pair/owner-codes/${mint.json?.code_id}`, undefined, d.master)
  check(status.json?.status === 'redeemed' && status.json?.redeemed_by?.platform === 'macos' && status.json?.redeemed_by?.source === '127.0.0.1', 'Prometheus: the code is spent, by a Mac', JSON.stringify(status.json))
  const devs = (await d.call('GET', '/api/devices', undefined, d.master)).json
  const owners = (devs?.devices ?? devs ?? []).filter((x) => x.owner && (x.marked_by ?? x.owner_source) === 'owner-code')
  check(owners.length === 1 && owners[0].name === status.json?.redeemed_by?.name, 'Prometheus lists one owner device from the code, under the name this Beacon gave it', JSON.stringify(owners.map((o) => o.name)))
  const kept = await keptDigest()
  check(!!kept && kept !== sha256(d.master), 'Beacon no longer keeps the API token', kept === sha256(d.master) ? 'still the API token' : String(kept))
  const db = spawnSync('/usr/bin/find', [d.home, '-name', 'devices.db'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const row = db ? spawnSync('/usr/bin/sqlite3', [`file:${db}?mode=ro`, `SELECT d.name FROM api_devices d JOIN owner_devices o ON o.device_id = d.id WHERE d.token_sha256 = '${kept}' AND d.revoked_at IS NULL`], { encoding: 'utf8' }).stdout.trim() : ''
  check(row !== '' && row === owners[0]?.name, "…it keeps that owner device's token (the daemon's own registry)", `row "${row}"`)
  const up = await until(async () => {
    const st = await app.page.evaluate('window.beacon.connection.status()')
    return st?.state === 'connected' ? st : null
  }, 20000)
  // Up is not enough (it was up with the API token too): the daemon must have seen the OWNER device talk to it since the switch.
  const seen = await until(() => {
    const r = spawnSync('/usr/bin/sqlite3', [`file:${db}?mode=ro`, `SELECT last_seen_at FROM api_devices WHERE token_sha256 = '${kept}'`], { encoding: 'utf8' }).stdout.trim()
    return r && r !== '' ? r : null
  }, 20000)
  check(!!up && !!seen, 'the connection is up again, and Prometheus has seen the owner device itself talk to it (its last_seen_at)', JSON.stringify({ up: !!up, seen }))
  const asOwner = await app.page.evaluate(`window.beacon.daemon.get('/api/model').then((m) => !!m && typeof m === 'object' && 'running' in m, () => false)`)
  check(asOwner === true, 'and through Beacon it reads what only the owner may (GET /api/model)')

  // ── 4. no token in the page ──────────────────────────────────────────────────────────────────────────────────────────
  const dump = await app.page.evaluate(`JSON.stringify({ html: document.documentElement.outerHTML, ls: Object.entries(localStorage), ss: Object.entries(sessionStorage) })`)
  check(!dump.includes(d.master) && !/[A-Za-z0-9_-]{40,}/.test(await app.page.evaluate(`document.querySelector(${JSON.stringify(SECTION)})?.innerText ?? ''`)), 'no token is in the page')
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  const end = await world.stopAll()
  check(end.alive === 0 && end.tripped.length === 0, 'every daemon stopped, and none listened beyond 127.0.0.1', JSON.stringify(end))
  rmSync(profile, { recursive: true, force: true })
}
