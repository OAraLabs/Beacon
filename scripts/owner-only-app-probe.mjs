#!/usr/bin/env node
// owner-only-app-probe — an approved (scoped) device sees plain words, not Prometheus's refusals, IN THE BUILT APP, against a REAL
// Prometheus (the 0.4.5 raw-error sweep, S1–S9 and E4; films/onboarding/sweep-045/SWEEP.md).
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<a python with its dependencies>
//   npm run build && node scripts/owner-only-app-probe.mjs
//
// The daemon is scripts/lib/serve_real_daemon.py (the real app and its WebSocket bridge, a throwaway home and token, ephemeral 127.0.0.1
// ports, never 8005/8010). The devices are minted the way Prometheus mints them (POST /api/devices with the global token). Beacon is
// the dev build on a scratch profile with the mock keychain, pointed at the daemon by BEACON_GATEWAY_*, its key saved the way Settings saves one.
//   1. As a scoped device: every owner-only screen (Mission's owner part; Coding; Workspace › Files/Artifacts/Board/Documents/Wiki/
//      Checkpoints/Skills; Activity › Status; Config › Models/Connectors/Skills/Profiles/Grants/Telemetry/Usage/Memory/Sentinel/Wiki/
//      Cron/Config) shows the note and "Make this Beacon an owner"; every screen an approved device may use shows no note; Devices
//      keeps its own row; no screen shows a code, a route, a placeholder reading, or "· offline" while connected.
//   2. "Make this Beacon an owner" opens Settings at that section. A real one-time code (POST /api/pair/owner-codes, what
//      `oara pair --owner` asks for) typed there makes it an owner: the words say so (no key it never typed), the role becomes owner,
//      the worker-model line is not a stale "Only the owner…", and the owner-only screens load.
//   3. As the global token (the owner): no note anywhere.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'
import { startChecks, waitFor } from './lib/probe-kit.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] owner-only: SKIPPED — macOS only (app-driver)')
  process.exit(3)
}
if (!realDaemonConfigured()) {
  console.log('[probe] owner-only: SKIPPED — set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY. A skipped probe is not a passed one.')
  process.exit(3)
}
const check = startChecks('owner-only', 48)
const NOTE = 'is for the owner of this Prometheus'
const BUTTON = 'Make this Beacon an owner'
// What the sweep found on these screens, and anything else raw.
const RAW = /· offline|(^| )\{\}( |$)|HTTP \d{3}|\b40[0-9]\b|operator_only|\/api\/|Could not load|Failed to list|Catalog unavailable|predates|too old|redeploy|Error invoking|— · — · —|\bup 0s\b|daemon may be/
// As an OWNER, "Catalog unavailable." is true of this daemon: serve_real_daemon.py runs no model router, and /api/models answers 503
// "model router unavailable". It was only misleading on an approved device, where the answer was a refusal.
const RAW_OWNER = new RegExp(RAW.source.replace('|Catalog unavailable', ''))
const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

// Owner-only by Prometheus's own list of what a scoped device may use (web/route_access.py SCOPED_ALLOWED), not by what the sweep saw:
// Artifacts, Checkpoints, Workspace › Skills, Coding, Grants and Config › Config showed empty readings there that are really refusals.
const OWNER_ONLY = [
  ['Mission'],
  ['Coding', 'Run'], ['Coding', 'Loop Manager'],
  ['Workspace', 'Files'], ['Workspace', 'Artifacts'], ['Workspace', 'Board'], ['Workspace', 'Documents'], ['Workspace', 'Wiki'],
  ['Workspace', 'Checkpoints'], ['Workspace', 'Skills'],
  ['Activity', 'Status'],
  ['Config', 'Models'], ['Config', 'Connectors'], ['Config', 'Skills'], ['Config', 'Profiles'], ['Config', 'Grants'], ['Config', 'Telemetry'],
  ['Config', 'Usage'], ['Config', 'Memory'], ['Config', 'Sentinel'], ['Config', 'Wiki'], ['Config', 'Cron'], ['Config', 'Config']
]
const ALLOWED = [['Chats'], ['Workspace', 'Integrations'], ['Activity', 'Live'], ['Activity', 'Tool Feed'], ['Config', 'Skin']]

async function clickBy(app, finder) {
  const at = await app.page.evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === el || el.contains(h)) } })()`)
  if (!at?.hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
const railItem = (label) => `() => [...document.querySelectorAll('nav[aria-label="Views"] button, nav[aria-label="Views"] a')].find((b) => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)}) ?? null`
const tabItem = (label) => `() => [...document.querySelectorAll('button,[role=tab]')].find((b) => { if (!b.offsetParent || b.closest('nav[aria-label="Views"]')) return false; const r = b.getBoundingClientRect(); return r.top > 40 && r.top < 240 && b.innerText.trim() === ${JSON.stringify(label)} }) ?? null`
async function go(app, [page, tab]) {
  const a = await clickBy(app, railItem(page))
  await sleep(600)
  const b = tab ? await clickBy(app, tabItem(tab)) : true
  await sleep(2200)
  return a && b
}
/** Open `where` as an owner and say what is wrong with it, or null: it must load (no "Loading…" left within 12 s: Config › Models takes
 *  > 3.5 s on a fresh daemon, measured on 0.4.5 too), show no note and nothing raw, and have words of its own beyond the rail and the
 *  pill rows (a screen waiting for a role that never came would otherwise pass blank). */
async function ownerScreenProblem(app, where) {
  const ok = await go(app, where)
  if (!ok) return 'could not open'
  const t = norm(await waitFor(() => pageText(app), (x) => !/Loading…|loading…/.test(x), 12000))
  const chrome = await app.page.evaluate(`[...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean)`)
  let own = t
  for (const c of chrome) own = own.split(c).join(' ')
  own = norm(own.replace(/\bBeacon\b/g, ' '))
  if (t.includes(NOTE)) return 'note shown'
  if (/Loading…|loading…/.test(t)) return 'still loading'
  if (RAW_OWNER.test(t)) return t.match(RAW_OWNER)[0]
  // A true empty state is short ("No skills" is true of a fresh daemon); a blank surface has nothing at all.
  if (own.length < 5) return `blank (${own.slice(0, 60)})`
  return null
}
/** The note's box against what it holds: sized to its content means no taller than its children and padding (it was stretched to the
 *  height of the page), and no wider than the 460 it is allowed. */
const noteGeometry = (app) =>
  app.page.evaluate(`[...document.querySelectorAll('[data-testid="owner-only-note"]')].map((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const kids = [...el.children]
    const inner = kids.reduce((h, c) => h + c.getBoundingClientRect().height, 0) + (parseFloat(cs.rowGap) || 0) * Math.max(0, kids.length - 1) +
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    return { area: el.dataset.area, w: Math.round(r.width), h: Math.round(r.height), inner: Math.round(inner) }
  })`)
const badGeometry = (g) => g.w > 470 || Math.abs(g.h - g.inner) > 2
const pageText = (app) => app.page.evaluate(`(document.querySelector('main') ?? document.body).innerText`)
const status = (app) => app.page.evaluate('window.beacon.connection.status()')

const daemons = []
let app = null
const profiles = []
async function launchAs(d, token) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') && !k.startsWith('BEACON_REAL_DAEMON')) delete process.env[k]
  Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(d.port), BEACON_GATEWAY_WS_PORT: String(d.wsPort) })
  const profile = mkdtempSync(join(tmpdir(), 'beacon-owner-only-'))
  profiles.push(profile)
  const a = await launchApp({ profile })
  // The app reads its key from the keychain only (the mock one here): saved the way Settings saves an address and key.
  const saved = await a.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.port}, wsPort: ${d.wsPort}, token: ${JSON.stringify(token)} }).then((r) => r.ok)`)
  const up = await waitFor(async () => (await a.page.evaluate('window.beacon.connection.status()'))?.state, (s) => s === 'connected', 15000)
  check(saved === true && up === 'connected', 'setup: Beacon saved the key and connected', JSON.stringify({ saved, up }))
  return a
}

try {
  const d = await startRealDaemon({ name: 'Owner Probe Prometheus' })
  daemons.push(d)
  check(d.port !== 8005 && d.wsPort !== 8010, 'setup: the real Prometheus app and bridge are up on ephemeral ports', `${d.port}/${d.wsPort}`)
  const minted = await d.owner('POST', '/api/devices', { name: 'Probe MacBook', platform: 'macos', owner: false })
  check(minted.status === 201 && typeof minted.body?.token === 'string', 'setup: a scoped device minted the way Prometheus mints one', JSON.stringify(minted.status))

  // ── 1. as the scoped device ──
  console.log('\n[probe] === 1. an approved (scoped) device ===')
  app = await launchAs(d, minted.body.token)
  const role = await waitFor(async () => (await status(app))?.role ?? null, (r) => r === 'limited', 15000)
  check(role === 'limited', 'the connection knows this Beacon is an approved device, not the owner (role "limited", from GET /api/devices)', JSON.stringify(await status(app)))
  // From here on, every answer Prometheus gives this device is recorded in main (Beacon's REST goes through the global fetch there): the
  // walk below opens every screen, and an approved device should be refused nothing, because nothing it may not read is asked.
  await sleep(1500)
  const recording = await app.mainEval(`(() => { globalThis.__refused = []; if (!globalThis.__refusedHooked) { const f = globalThis.fetch; globalThis.fetch = async (...a) => { const r = await f(...a); if (r.status === 403) globalThis.__refused.push(String(a[0] && a[0].url ? a[0].url : a[0]).replace(/^https?:\\/\\/[^/]+/, '')); return r }; globalThis.__refusedHooked = true } return true })()`)
  const geometry = []
  for (const where of OWNER_ONLY) {
    const ok = await go(app, where)
    const t = norm(await pageText(app))
    const label = where.join(' › ')
    geometry.push(...(await noteGeometry(app)))
    check(ok && t.includes(NOTE) && t.includes(BUTTON) && !RAW.test(t), `${label}: the note ("… ${NOTE} …") and "${BUTTON}", nothing raw`, ok ? (t.match(RAW)?.[0] ?? t.slice(0, 200)) : 'could not open it')
  }
  await go(app, ['Mission'])
  const mission = norm(await pageText(app))
  check(/needs you/i.test(mission) && /activity/i.test(mission), 'Mission keeps what an approved device may see: "needs you" (its own approvals) and the live activity', mission.slice(0, 200))
  const allowedBad = []
  for (const where of ALLOWED) {
    const ok = await go(app, where)
    const t = norm(await pageText(app))
    if (!ok || t.includes(NOTE) || RAW.test(t)) allowedBad.push(`${where.join(' › ')}: ${ok ? (t.includes(NOTE) ? 'note shown' : t.match(RAW)?.[0]) : 'could not open'}`)
  }
  check(allowedBad.length === 0, `the ${ALLOWED.length} screens an approved device may use show no note and nothing raw`, allowedBad.join(' | '))
  await go(app, ['Config', 'Devices'])
  const devices = norm(await pageText(app))
  geometry.push(...(await noteGeometry(app)))
  const misfit = geometry.filter(badGeometry)
  check(geometry.length >= OWNER_ONLY.length + 1 && misfit.length === 0, `every note (${geometry.length}) is sized to its content: no taller than what it holds, no wider than 460`, JSON.stringify(misfit.slice(0, 6)))
  const enrolButton = await app.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.offsetParent && b.innerText.trim() === 'Enrol')`)
  check(
    /Probe MacBook · this device/.test(devices) && devices.includes(NOTE) && !enrolButton && !RAW.test(devices),
    'Config › Devices: its own row (it may sign itself out), the note where Enrol was (adding a device is the owner\'s), nothing raw',
    `${enrolButton ? 'Enrol shown; ' : ''}${devices.slice(0, 300)}`
  )

  const refused = await app.mainEval('JSON.stringify(globalThis.__refused ?? null)')
  check(recording === true && refused === '[]', `walking all ${OWNER_ONLY.length + ALLOWED.length + 1} screens, Prometheus refused this device nothing: nothing it may not read was asked`, String(refused))
  // The page's first moments: main knows the role, a freshly loaded page does not yet, and Mission (where it lands) must wait rather
  // than ask. A CDP reload (location.reload() is refused in a built app), with a marker that proves it happened, the recorder still on.
  await app.mainEval('(() => { globalThis.__refused = []; return true })()')
  await app.page.evaluate('window.__beforeReload = 1')
  await app.page.send('Page.reload', {})
  const reloaded = await waitFor(
    () => app.page.evaluate(`window.__beforeReload === undefined && !!document.querySelector('nav[aria-label="Views"]')`).catch(() => false),
    (v) => v === true,
    15000
  )
  await sleep(3500)
  const refusedOnLoad = await app.mainEval('JSON.stringify(globalThis.__refused ?? null)')
  const landed = norm(await pageText(app))
  check(
    reloaded === true && refusedOnLoad === '[]' && landed.includes(NOTE),
    'reloaded, the page starts before it knows the role: it lands on Mission\'s note and asks nothing it would be refused',
    `${reloaded ? '' : 'no reload; '}${refusedOnLoad} ${landed.slice(0, 120)}`
  )

  // ── 2. becoming an owner ──
  console.log('\n[probe] === 2. Make this Beacon an owner ===')
  await go(app, ['Workspace', 'Files'])
  const clicked = await clickBy(app, `() => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.innerText.trim() === ${JSON.stringify(BUTTON)}) ?? null`)
  // In view means really seen: the section's title and its code field are each the element under their own centre (Settings scrolls
  // inside its own box, so a section clipped below that box is still "inside the window" by its rectangle), and the field has focus.
  const section = await waitFor(
    () =>
      app.page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="make-owner"]'); const input = document.querySelector('[data-testid="make-owner-code"]')
        if (!el || !input) return null
        const seen = (n) => { const r = n.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === n || n.contains(h)) }
        return (seen(el.firstElementChild) && seen(input) ? 'visible' : 'hidden') + (document.activeElement === input ? '+focused' : '')
      })()`),
    (v) => v === 'visible+focused',
    6000
  )
  check(clicked && section === 'visible+focused', `"${BUTTON}" opens Settings with that section in view and its code field ready to type in`, String(section))
  // 0.4.7 (filming Path B): the offer opened the whole Settings sheet, whose top showed http://127.0.0.1:8005 and "The token
  // authenticates both transports: the REST bearer header and the WebSocket first-frame handshake." It opens the owner section only.
  const sheet = await app.page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="make-owner"]'); if (!el) return null
    let m = el; while (m.parentElement && !(getComputedStyle(m).position === 'fixed')) m = m.parentElement
    const inputs = [...m.querySelectorAll('input')].filter((i) => i.getBoundingClientRect().width > 0)
    return { text: m.innerText, inputs: inputs.map((i) => i.dataset.testid ?? i.placeholder ?? i.type) }
  })()`)
  check(
    !!sheet && /Make this Beacon an owner/.test(sheet.text) && !/https?:\/\/|:80\d\d|authenticates|transports|REST|WebSocket|Bearer|token/i.test(sheet.text) && sheet.inputs.length === 1 && sheet.inputs[0] === 'make-owner-code',
    'the offer opens a sheet with the owner section only: no address, no key field, no transport sentence',
    JSON.stringify(sheet)
  )
  const code = await d.owner('POST', '/api/pair/owner-codes')
  check(code.status === 201 && /^\d{8}$/.test(String(code.body?.code ?? '')), 'setup: a one-time owner code from Prometheus (what `oara pair --owner` asks for)', JSON.stringify({ status: code.status }))
  await app.page.evaluate(`(() => { const i = document.querySelector('[data-testid="make-owner-code"]'); i.focus(); return true })()`)
  await app.page.send('Input.insertText', { text: String(code.body?.code ?? '') })
  await clickBy(app, `() => document.querySelector('[data-testid="make-owner-go"]')`)
  const done = await waitFor(() => app.page.evaluate(`document.querySelector('[data-testid="make-owner"]')?.innerText ?? ''`), (t) => /now an owner/.test(t), 10000)
  check(/now an owner/.test(done) && !/typed in|owner key/.test(done), 'it says this Beacon is now an owner, and nothing about a key the person never typed', norm(done).slice(0, 200))
  const role2 = await waitFor(async () => (await status(app))?.role ?? null, (r) => r === 'owner', 15000)
  check(role2 === 'owner', 'the role becomes owner once it reconnects with its owner key', JSON.stringify(await status(app)))
  const closed = await clickBy(app, `() => document.querySelector('button[aria-label="Close"]')`)
  await sleep(800)
  check(closed && (await app.page.evaluate(`!document.querySelector('[data-testid="make-owner"]')`)), 'the owner sheet closes', String(closed))
  // Settings itself (the gear on Mission): the address and the key are under a collapsed Advanced section, in plain words.
  await go(app, ['Mission'])
  const gear = await clickBy(app, `() => document.querySelector('button[aria-label="Connection settings"]')`)
  await sleep(1500)
  const plainTop = norm(await app.page.evaluate('document.body.innerText'))
  const fieldShown = () => app.page.evaluate(`[...document.querySelectorAll('input')].some((i) => i.getBoundingClientRect().width > 0 && /:8005|http/.test(i.placeholder + ' ' + i.value))`)
  const shownBefore = await fieldShown()
  check(
    gear && /Advanced/.test(plainTop) && !shownBefore && !/http:\/\/127\.0\.0\.1|authenticates both transports|first-frame/.test(plainTop),
    'Settings: no address and no transport sentence until Advanced is opened',
    `${shownBefore ? 'address field shown; ' : ''}${plainTop.slice(0, 300)}`
  )
  const opened = await clickBy(app, `() => [...document.querySelectorAll('summary, button')].find((b) => b.offsetParent && /^Advanced/.test(b.innerText.trim()))`)
  await sleep(800)
  const advancedText = norm(await app.page.evaluate('document.body.innerText'))
  check(
    opened && (await fieldShown()) && !/transports|bearer header|first-frame|REST bearer/i.test(advancedText),
    'Advanced opens to the address and the key, said in plain words',
    advancedText.slice(0, 400)
  )
  const settingsText = advancedText
  check(
    /Background workers run on/.test(settingsText) && !/Only the owner of this Prometheus can change the worker model/.test(settingsText),
    'Settings reads the worker model again as an owner: the control, not the stale "Only the owner … can change the worker model."',
    settingsText.match(/Only the owner[^.]*\./)?.[0] ?? (/Background workers run on/.test(settingsText) ? 'the control is there' : 'no worker-model control')
  )
  await clickBy(app, `() => document.querySelector('button[aria-label="Close"]')`)
  await sleep(800)
  const asOwner = []
  for (const where of [['Mission'], ['Workspace', 'Files'], ['Config', 'Usage'], ['Config', 'Models']]) {
    const p = await ownerScreenProblem(app, where)
    if (p) asOwner.push(`${where.join(' › ')}: ${p}`)
  }
  check(role2 === 'owner' && asOwner.length === 0, 'as an owner now, the owner-only screens load their panels: no note, nothing raw, no "Loading…" left', role2 !== 'owner' ? `role ${role2}` : asOwner.join(' | '))
  await app.quit()
  app = null

  // ── 3. the global token ──
  console.log('\n[probe] === 3. the global token (the owner) ===')
  app = await launchAs(d, d.token)
  const role3 = await waitFor(async () => (await status(app))?.role ?? null, (r) => r === 'owner', 15000)
  check(role3 === 'owner', 'the global API token is the owner (no device row of its own)', JSON.stringify(await status(app)))
  const ownerBad = []
  for (const where of OWNER_ONLY) {
    const p = await ownerScreenProblem(app, where)
    if (p) ownerBad.push(`${where.join(' › ')}: ${p}`)
  }
  check(role3 === 'owner' && ownerBad.length === 0, `as the owner, all ${OWNER_ONLY.length} owner-only screens load: no note, no "Loading…" left, words of their own`, role3 !== 'owner' ? `role ${role3}` : ownerBad.join(' | '))
  // 0.4.7: a fresh daemon has made no tool calls. Mission and Config › Telemetry say so, never a red "0%".
  await go(app, ['Mission'])
  const missionTele = norm(await pageText(app))
  await go(app, ['Config', 'Telemetry'])
  const configTele = norm(await pageText(app))
  check(
    /No tool calls yet/.test(missionTele) && !/(^|\s)0%/.test(missionTele) && /No tool calls yet/.test(configTele) && !/(^|\s)0%/.test(configTele),
    'no tool calls yet: Mission and Config › Telemetry say "No tool calls yet", with no percentage',
    `${missionTele.match(/.{0,60}(tool calls|0%).{0,40}/)?.[0]} | ${configTele.match(/.{0,60}(0%|calls).{0,40}/)?.[0]}`
  )

  // ── 4. the role remembered ──
  // Relaunched with Prometheus gone, GET /api/devices cannot answer, so a role on the connection can only be the one remembered for
  // this address and key (an approved device then opens on the note, not on a refusal it would read first).
  console.log('\n[probe] === 4. the role, remembered ===')
  await app.quit()
  app = null
  d.stop()
  await sleep(800)
  app = await launchApp({ profile: profiles[profiles.length - 1] })
  await sleep(2500)
  const remembered = await status(app)
  check(remembered?.role === 'owner' && remembered.state !== 'connected', 'relaunched with Prometheus stopped, Beacon still knows its role here (remembered, not asked)', JSON.stringify(remembered))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const d of daemons) d.stop()
  await sleep(500)
  for (const p of profiles) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  for (const d of daemons) rmSync(d.home, { recursive: true, force: true })
}
