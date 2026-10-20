#!/usr/bin/env node
// onboarding-approve-prompt-probe — "Approve new device?" in a Beacon that is already connected as its Prometheus's OWNER, IN THE REAL APP,
// against the REAL Prometheus pairing routes (#698), with real clicks and real typing.
//
// The probe plays the NEW DEVICE over real HTTP: it asks to join, polls with its poll secret, and unseals the token it is given with its own
// X25519 key (Node's crypto; the contract's recipe). Beacon is the owner: it is connected with the daemon's global token and finds who is waiting by
// polling GET /api/pair/requests, and by the daemon's pairing frames when it sends them (Prometheus #699 and later; the F scenarios).
//   * a request appears within a few seconds, with the device's name, what it is and where it came from, and NOT the four digits;
//   * approving needs the digits TYPED from the new device: a wrong one is refused (422), the request stays, the right one connects it, and the
//     token the new device unseals really works against the daemon;
//   * Deny, Not now, Esc and another channel answering first each take the prompt away the right way, with the daemon agreeing;
//   * a Beacon that is itself a scoped (approved) device never shows a prompt;
//   * the daemon's REAL WebSocket frames (Prometheus #699): with Beacon's asking turned off (BEACON_PAIRING_POLL=off, a dev/probe-build
//     setting) a request still appears within seconds and goes away when answered elsewhere; a Beacon that connects AFTER requests were made is
//     backfilled, oldest first; and a scoped Beacon on the same bridge is sent nothing.
//
// RUN (macOS; needs a checkout of Prometheus #698 or later; not part of verify):
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   npm run build && npm run probe:onboarding-approve-prompt
// Without both variables it says SKIPPED and exits 3: a skipped probe is not a passed one.
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'
import { clickText, pageText, press, startChecks, typeInto, waitFor } from './lib/probe-kit.mjs'

if (!realDaemonConfigured()) {
  console.log('[probe] onboarding-approve-prompt: SKIPPED — set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY (see the header). A skipped probe is not a passed one.')
  process.exit(3)
}
const check = startChecks('onboarding-approve-prompt', 28)
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]
const SHOTS = process.env.PROBE_SHOTS ?? ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'beacon-approve-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

// ── the new device, played over real HTTP ────────────────────────────────────────────────────────
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
function newDevice(name, platform = 'macos') {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { name, platform, privateKey, pub, id: null, secret: null, code: null }
}
async function ask(d, device) {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/pair/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_name: device.name, platform: device.platform, public_key: device.pub.toString('base64url') })
  })
  const body = await res.json()
  device.id = body.request_id
  device.secret = body.poll_secret
  device.code = body.match_code
  return { status: res.status, body }
}
const pollDevice = async (d, device) => (await (await fetch(`http://127.0.0.1:${d.port}/api/pair/requests/${device.id}`, { headers: { 'x-pairing-secret': device.secret } })).json())
function unseal(device, sealed) {
  const eph = Buffer.from(sealed.ephemeral_public_key, 'base64url')
  const shared = diffieHellman({ privateKey: device.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI, eph]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(device.id, 'ascii'), 'prometheus-pair-v1/seal', 32))
  const body = Buffer.from(sealed.ciphertext, 'base64url')
  const dec = createDecipheriv('chacha20-poly1305', key, Buffer.from(sealed.nonce, 'base64url'), { authTagLength: 16 })
  dec.setAAD(Buffer.from(device.id, 'ascii'))
  dec.setAuthTag(body.subarray(body.length - 16))
  return JSON.parse(Buffer.concat([dec.update(body.subarray(0, body.length - 16)), dec.final()]).toString('utf8'))
}

// ── the owner's Beacon ───────────────────────────────────────────────────────────────────────────
let current = null
async function launchConnected(d, token, env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY') || k === 'BEACON_ONBOARDING' || k === 'BEACON_PAIRING_POLL') delete process.env[k]
  Object.assign(process.env, env)
  const app = await launchApp({ profile: mkdtempSync(join(root, 'profile-')), readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
  current = app
  const saved = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.port}, wsPort: ${d.wsPort}, token: ${JSON.stringify(token)} })`)
  if (saved?.ok !== true) throw new Error(`could not connect Beacon to the daemon: ${JSON.stringify(saved)}`)
  await app.page.send('Page.reload') // CDP reload (location.reload() is refused in a built app)
  await waitFor(() => app.page.evaluate(`!!document.querySelector('nav[aria-label="Views"]')`), (v) => v === true, 15000)
  return app
}
const connectedOverWs = (app) => waitFor(() => app.page.evaluate(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)
const prompt = (app) => app.page.evaluate(`(() => { const p = document.querySelector('[data-pair-prompt]'); return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null })()`)
const waitPrompt = (app, ms = 12000) => waitFor(() => prompt(app), (v) => v !== null, ms)
const waitNoPrompt = (app, ms = 12000) => waitFor(() => prompt(app), (v) => v === null, ms)
const hasButton = (app, text, enabled) => app.page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-pair-prompt] button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); return b ? (${JSON.stringify(enabled)} === undefined ? true : (!b.disabled) === ${JSON.stringify(enabled)}) : false })()`)
const field = '[data-pair-prompt] input'
const owner = (d) => (method, path, body) => d.owner(method, path, body)
async function shot(app, name) {
  if (!SHOTS) return
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
}
const open = async (d) => (await d.owner('GET', '/api/pair/requests')).body?.requests ?? []

const daemons = []
let app
try {
  const rd = await startRealDaemon({ name: 'Probe Prometheus' })
  daemons.push(rd)
  console.log(`[probe] the real daemon: port ${rd.port}`)

  // ── O1: nobody is waiting ────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === O1: nobody waiting ===')
  app = await launchConnected(rd, rd.token)
  await sleep(7000)
  check((await prompt(app)) === null, 'O1 with nobody waiting there is no prompt (Beacon has asked the daemon a few times by now)')

  // ── O2: a new device asks ────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === O2: a new device asks, the owner types its code ===')
  const ipad = newDevice('Kitchen iPad', 'ios')
  const made = await ask(rd, ipad)
  check(made.status === 201, 'O2 (setup) the new device asked the real daemon to join', String(made.status))
  const text = await waitPrompt(app)
  check(text !== null && text.includes('Approve new device?') && text.includes('Kitchen iPad wants to connect.') && text.includes('iPhone or iPad · from 127.0.0.1'), 'O2 within a few seconds Beacon asks "Approve new device?", naming the device, what it is and where it came from', String(text).slice(0, 200))
  check(text !== null && !new RegExp(`(^|\\D)${ipad.code}(\\D|$)`).test(text.replace('127.0.0.1', '')) && (await hasButton(app, 'Approve', false)), 'O2 the four digits the daemon lists are NOT on screen, and Approve cannot be pressed until four are typed', String(text).slice(0, 120))
  await shot(app, '21-approve-new-device.png')
  const wrong = ipad.code.slice(0, 3) + String((Number(ipad.code[3]) + 1) % 10)
  check((await typeInto(app, field, '12')) === 'typed' && (await hasButton(app, 'Approve', false)), 'O2 one, two or three digits are not enough: Approve stays disabled until there are four')
  check((await typeInto(app, field, wrong)) === 'typed' && (await hasButton(app, 'Approve', true)), 'O2 typing four digits enables Approve (a real keyboard)')
  check((await clickText(app, 'Approve')) === 'clicked', 'O2 Approve is clickable')
  const refusal = await waitFor(() => prompt(app), (v) => v !== null && v.includes("doesn't match"), 6000)
  check(refusal !== null && refusal.includes("That code doesn't match the one on the new device.") && (await open(rd)).length === 1, 'O2 a WRONG code is refused by the daemon (422): Beacon says so in plain words and the request stays open', String(refusal).slice(0, 160))
  await shot(app, '22-wrong-code.png')
  await typeInto(app, field, ipad.code)
  await clickText(app, 'Approve')
  check((await waitNoPrompt(app, 8000)) === null, 'O2 the RIGHT code approves it and the prompt goes away')
  const got = await waitFor(() => pollDevice(rd, ipad), (b) => b.status === 'approved', 8000)
  check(got.status === 'approved' && typeof got.sealed === 'object', 'O2 the new device is told it was approved, with a sealed answer', JSON.stringify(got).slice(0, 80))
  const plain = unseal(ipad, got.sealed)
  const asScoped = await fetch(`http://127.0.0.1:${rd.port}/api/sessions`, { headers: { authorization: `Bearer ${plain.token}` } })
  check(asScoped.status === 200 && plain.name === 'Kitchen iPad', 'O2 the token the new device unseals WORKS against the daemon, and it carries the name it asked under', `${asScoped.status} ${plain.name}`)
  const mine = (await rd.owner('GET', '/api/devices')).body.find((x) => x.id === plain.device_id)
  check(mine && mine.owner === false && mine.revoked_at === null, 'O2 the daemon lists it as an ordinary device, not an owner')
  await pollDevice(rd, ipad).catch(() => undefined)
  await fetch(`http://127.0.0.1:${rd.port}/api/pair/requests/${ipad.id}`, { method: 'DELETE', headers: { 'x-pairing-secret': ipad.secret } })

  // ── O3: deny ────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === O3: deny ===')
  const phone = newDevice('Stranger Phone', 'android')
  await ask(rd, phone)
  await waitPrompt(app)
  check((await clickText(app, 'Deny')) === 'clicked' && (await waitNoPrompt(app, 8000)) === null, 'O3 Deny takes the prompt away')
  check((await waitFor(() => pollDevice(rd, phone), (b) => b.status === 'denied', 8000)).status === 'denied', 'O3 …and the new device is told no')

  // ── O4: another channel answers first ────────────────────────────────────────────────────────────
  console.log('\n[probe] === O4: answered somewhere else ===')
  const tablet = newDevice('Office Tablet', 'android')
  await ask(rd, tablet)
  await waitPrompt(app)
  await rd.owner('POST', `/api/pair/requests/${tablet.id}/approve`, { match_code: tablet.code })
  check((await waitNoPrompt(app, 10000)) === null, 'O4 when the request is answered somewhere else, the prompt goes away by itself')

  // ── O5: Not now, Esc, and several at once ───────────────────────────────────────────────────────
  console.log('\n[probe] === O5: Not now, Esc, several waiting ===')
  const a = newDevice('Alpha Laptop', 'windows')
  const b = newDevice('Beta Laptop', 'linux')
  await ask(rd, a)
  await ask(rd, b)
  const two = await waitFor(() => prompt(app), (v) => v !== null && v.includes('1 more waiting'), 10000)
  check(two !== null && two.includes('Alpha Laptop wants to connect.') && two.includes('Windows PC · from'), 'O5 with two waiting, the one that has waited longest is first, and it says another is waiting', String(two).slice(0, 160))
  check((await clickText(app, 'Not now')) === 'clicked', 'O5 Not now is clickable')
  const second = await waitFor(() => prompt(app), (v) => v !== null && v.includes('Beta Laptop'), 5000)
  check(second !== null && (await open(rd)).length === 2, 'O5 Not now moves on to the next without answering (the daemon still has both)', String(second).slice(0, 100))
  await press(app, 'Escape')
  check((await waitNoPrompt(app, 5000)) === null && (await open(rd)).length === 2, 'O5 Esc is Not now: the prompt goes, nothing is answered')
  const c = newDevice('Gamma Desktop', 'macos')
  await ask(rd, c)
  const third = await waitFor(() => prompt(app), (v) => v !== null && v.includes('Gamma Desktop'), 10000)
  check(third !== null, 'O5 a NEW request after "Not now" is asked about again', String(third).slice(0, 80))
  for (const dev of [a, b, c]) await rd.owner('POST', `/api/pair/requests/${dev.id}/deny`, {})
  await app.quit()

  // ── F: the daemon's REAL WebSocket frames, with asking turned off ─────────────────────────────
  console.log('\n[probe] === F: real pairing frames (Beacon never asks; only the daemon can tell it) ===')
  if (rd.frames) {
    const frameApp = await launchConnected(rd, rd.token, { BEACON_PAIRING_POLL: 'off' })
    app = frameApp
    check((await connectedOverWs(frameApp)) === 'connected', 'F1 (setup) Beacon is connected to the real daemon over the WebSocket, with its asking turned off')
    const live = newDevice('Frame Phone', 'ios')
    await ask(rd, live)
    const livePrompt = await waitFor(() => prompt(frameApp), (v) => v !== null && v.includes('Frame Phone'), 6000)
    check(livePrompt !== null && livePrompt.includes('Frame Phone wants to connect.') && livePrompt.includes('iPhone or iPad · from 127.0.0.1'), 'F1 with asking turned off, a request still appears within seconds: the daemon\'s pairing_pending frame told Beacon', String(livePrompt).slice(0, 140))
    await rd.owner('POST', `/api/pair/requests/${live.id}/deny`, {})
    check((await waitNoPrompt(frameApp, 6000)) === null, 'F1 …and when it is answered somewhere else the daemon\'s pairing_resolved frame takes the prompt away')
    await frameApp.quit()

    // a request that exists BEFORE Beacon connects can only arrive as the backfill; two, to see the order
    const first = newDevice('Backfill Alpha', 'windows')
    const second = newDevice('Backfill Beta', 'linux')
    await ask(rd, first)
    await sleep(1200)
    await ask(rd, second)
    const lateApp = await launchConnected(rd, rd.token, { BEACON_PAIRING_POLL: 'off' })
    app = lateApp
    const backfilled = await waitFor(() => prompt(lateApp), (v) => v !== null && v.includes('Backfill'), 12000)
    check(backfilled !== null && backfilled.includes('Backfill Alpha wants to connect.') && backfilled.includes('1 more waiting'), 'F2 a Beacon that connects AFTER two requests were made is told about them (the daemon\'s backfill), the one that has waited longest first', String(backfilled).slice(0, 160))
    await shot(lateApp, '23-approve-new-device-two-waiting.png')
    check((await clickText(lateApp, 'Deny')) === 'clicked' && (await waitFor(() => prompt(lateApp), (v) => v !== null && v.includes('Backfill Beta'), 6000)) !== null, 'F2 answering the first brings up the second')
    check((await waitFor(() => pollDevice(rd, first), (b) => b.status === 'denied', 6000)).status === 'denied', 'F2 …and the first device was told no')
    await rd.owner('POST', `/api/pair/requests/${second.id}/deny`, {})
    await waitNoPrompt(lateApp, 6000)
    await lateApp.quit()

    // a scoped Beacon, over the same real bridge: the daemon sends it nothing
    const scopedFrames = await launchConnected(rd, plain.token, { BEACON_PAIRING_POLL: 'off' })
    app = scopedFrames
    await connectedOverWs(scopedFrames)
    const secret = newDevice('Frame Ghost', 'ios')
    await ask(rd, secret)
    await sleep(5000)
    check((await prompt(scopedFrames)) === null && (await open(rd)).length === 1, 'F3 a Beacon that is itself a scoped device, connected over the real bridge, is sent no pairing frame, so it shows nothing though a request is waiting')
    await rd.owner('POST', `/api/pair/requests/${secret.id}/deny`, {})
    await scopedFrames.quit()
  } else {
    console.log('[probe] F SKIPPED: this daemon does not send pairing frames (Prometheus #699 and later does)')
  }

  // ── O6: a Beacon that is itself a scoped device ──────────────────────────────────────────────────
  console.log('\n[probe] === O6: a scoped Beacon ===')
  app = await launchConnected(rd, plain.token)
  const late = newDevice('Late Phone', 'ios')
  await ask(rd, late)
  await sleep(9000)
  check((await prompt(app)) === null && (await open(rd)).length === 1, 'O6 a Beacon whose own token is a device that was approved (not an owner) never shows a prompt, though a request is waiting')
  await rd.owner('POST', `/api/pair/requests/${late.id}/deny`, {})
  await app.quit()
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await current?.quit().catch(() => undefined)
  for (const d of daemons) d?.stop()
  console.log('\n[probe] profiles and daemon homes left in tmp for inspection (fresh, probe-only).')
}
