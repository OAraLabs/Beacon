#!/usr/bin/env node
// pair-pin-app-probe — Config → Devices → Enrol in the BUILT app, against a REAL Prometheus, with real clicks: the pairing code carries
// the daemon's TLS pin when it serves TLS (beacon-ios #32 / D22), is refused before any token is spent when the TLS ports do not answer
// with that key, and stays today's plain code when there is no TLS.
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus tree with #721 and #700>/src
//   export BEACON_REAL_DAEMON_PY=<a python with Prometheus's dependencies>
//   npm run build && npm run probe:pair-pin [screenshot-dir]
//
// The daemons are scripts/lib/serve_real_daemon.py (the real app; --tls serves it a second time over the instance certificate on
// 127.0.0.1 with app.state.lan_tls set, so GET /api/network reports tls.enabled and the real spki_sha256). Beacon holds the global
// token (minting is global-only) and is connected by NAME ("localhost": the code's host is never an IP). iOS dials 8006/8011; a probe
// cannot take those, so a non-release build reads the ports from BEACON_PAIR_TLS_PORTS (src/shared/devices.ts pairTlsPorts).
//
// 1. TLS on, the ports answering: Enrol → a code, marked pinned with exactly the daemon's own pin; one device minted.
// 2. TLS on, the ports pointed somewhere dead: Enrol → refused, naming 8006/8011 and iPhone; NO device minted.
// 3. TLS off: Enrol → a code with no pin (today's code); one device minted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

const SHOTS = process.argv[2] ?? null
if (process.platform !== 'darwin' || !realDaemonConfigured()) {
  console.log('[probe] SKIPPED: macOS, with BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k === 'BEACON_PAIR_TLS_PORTS') delete process.env[k]

let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 600)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 14
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})
const until = async (fn, ms, every = 150) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(every)
  }
}
const deadPort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

let app = null
const profiles = []
async function click(selector) {
  const at = await app.page.evaluate(`(() => {
    const el = typeof ${JSON.stringify(selector)} === 'string' && ${JSON.stringify(selector)}.startsWith('text=')
      ? [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(selector)}.slice(5) && b.offsetParent !== null)
      : document.querySelector(${JSON.stringify(selector)})
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
async function shot(name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const panel = () =>
  app.page.evaluate(`(() => {
    const qr = document.querySelector('[data-testid="pair-code"]')
    const input = document.querySelector('input[placeholder="Device name…"]')
    return { qr: !!qr, pinned: qr ? qr.getAttribute('data-pinned') : null, pin: qr ? qr.getAttribute('data-pin') : null, svg: !!(qr && qr.querySelector('svg')), text: (() => { let el = input; while (el && el.parentElement && !(el.innerText || '').includes('enrolled') ) el = el.parentElement; while (el && el.parentElement && !el.querySelector('[style*="overflow-y: auto"]')) el = el.parentElement; return (el?.innerText ?? document.body.innerText).slice(0, 4000) })() }
  })()`)

/** Launch Beacon against `d`, connected by name with the global token; open Config → Devices; enrol `name`. */
async function enrolAgainst(d, name, ports) {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-pair-pin-profile-'))
  profiles.push(profile)
  Object.assign(process.env, { BEACON_GATEWAY_HOST: 'localhost', BEACON_GATEWAY_API_PORT: String(d.port), BEACON_GATEWAY_WS_PORT: String(d.wsPort), BEACON_PAIR_TLS_PORTS: ports })
  app = await launchApp({ profile })
  await app.page.evaluate(`window.beacon.setup.save({ address: 'localhost', apiPort: ${d.port}, wsPort: ${d.wsPort}, token: ${JSON.stringify(d.token)} }).then((r) => r.ok)`)
  await click('nav[aria-label="Views"] [title="Config"]')
  await until(() => app.page.evaluate(`!!document.querySelector('[data-testid="config-tab-groups"]')`), 8000)
  await click('text=Devices')
  const ready = await until(() => app.page.evaluate(`!!document.querySelector('input[placeholder="Device name…"]')`), 8000)
  if (!ready) return 'no devices panel'
  await click('input[placeholder="Device name…"]')
  await app.page.send('Input.insertText', { text: name })
  await app.page.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'ios')); if (s) { s.value = 'ios'; s.dispatchEvent(new Event('change', { bubbles: true })) } return true })()`)
  await sleep(300)
  return click('[aria-label="Enrol device"]')
}
const devicesNamed = async (d, name) => {
  const r = await d.owner('GET', '/api/devices')
  const rows = Array.isArray(r.body) ? r.body : r.body?.devices ?? []
  return rows.filter((x) => x.name === name && !x.revoked_at).length
}

const daemons = []
try {
  // ── 1 and 2: a daemon serving TLS ────────────────────────────────────────────────────────────────────────────────────
  const t = await startRealDaemon({ name: 'Probe TLS Prometheus', tls: true })
  daemons.push(t)
  const net = await t.owner('GET', '/api/network')
  check(net.body?.tls?.enabled === true && net.body?.tls?.spki_sha256 === t.pin && /^[0-9a-f]{64}$/.test(t.pin ?? ''), 'the real daemon serves TLS and GET /api/network reports its pin', JSON.stringify(net.body?.tls))

  check((await enrolAgainst(t, 'Probe iPhone', `${t.tlsPort},${t.tlsWsPort}`)) === 'clicked', 'a real click on Enrol (TLS on, its ports answering)')
  const p1 = await until(async () => { const p = await panel(); return p.qr && p.svg ? p : null }, 15000)
  check(!!p1 && p1.pinned === 'true' && p1.pin === t.pin, 'the code is marked pinned, with exactly the daemon\'s own pin', JSON.stringify({ pinned: p1?.pinned, pin: p1?.pin, want: t.pin }))
  check(!!p1 && /encrypted/i.test(p1.text), 'and says so beside it', p1?.text?.slice(0, 300))
  check((await devicesNamed(t, 'Probe iPhone')) === 1, 'one device was minted for it')
  await shot('1-pinned')
  await app.quit()
  app = null

  const dead1 = await deadPort()
  const dead2 = await deadPort()
  check((await enrolAgainst(t, 'Probe iPhone 2', `${dead1},${dead2}`)) === 'clicked', 'a real click on Enrol (TLS on, nothing on the ports an iPhone would dial)')
  const p2 = await until(async () => { const p = await panel(); return /8006/.test(p.text) && /8011/.test(p.text) ? p : null }, 15000)
  check(!!p2 && !p2.qr && /iPhone/.test(p2.text), 'refused, naming 8006/8011 and iPhone; no code shown', JSON.stringify({ qr: p2?.qr, text: (await panel()).text.slice(0, 400) }))
  await sleep(800)
  check((await devicesNamed(t, 'Probe iPhone 2')) === 0, 'and NO device was minted: the one-shot token was never spent')
  await shot('2-refused')
  await app.quit()
  app = null

  // ── 3: a daemon without TLS ──────────────────────────────────────────────────────────────────────────────────────────
  const p = await startRealDaemon({ name: 'Probe Plain Prometheus', tls: false })
  daemons.push(p)
  const net3 = await p.owner('GET', '/api/network')
  check(net3.body?.tls?.enabled === false, 'the second daemon has no TLS (home network off)', JSON.stringify(net3.body?.tls))
  check((await enrolAgainst(p, 'Probe Plain iPhone', `${dead1},${dead2}`)) === 'clicked', 'a real click on Enrol (TLS off)')
  const p3 = await until(async () => { const x = await panel(); return x.qr && x.svg ? x : null }, 15000)
  check(!!p3 && p3.pinned === 'false' && !p3.pin, 'a code with no pin: today\'s plain code', JSON.stringify({ pinned: p3?.pinned, pin: p3?.pin }))
  check(!!p3 && !/encrypted/i.test(p3.text), 'and no "encrypted" line')
  check((await devicesNamed(p, 'Probe Plain iPhone')) === 1, 'one device was minted for it')
  await shot('3-plain')
  check(true, 'ran to the end')
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  for (const d of daemons) d.stop()
  await sleep(500)
  for (const pr of profiles) rmSync(pr, { recursive: true, force: true })
}
