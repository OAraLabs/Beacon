#!/usr/bin/env node
// onboarding-approval-probe — asking a Prometheus that already has an owner to let THIS Mac connect (B4, B-ok and the cards
// around them), IN THE REAL APP, against the REAL Prometheus pairing routes (#698), with real clicks.
//
// The daemon is not a stub: scripts/lib/serve_real_daemon.py builds prometheus.web.server.create_app (real bearer middleware,
// real DeviceStore, real pairing store) and serves it on an ephemeral loopback port. The OWNER's side (seeing the request,
// approving or denying it) is done over real HTTP with the daemon's global token, because the owner's Beacon screens are a
// separate change. So this holds Beacon to what the daemon actually does:
//   * the four digits Beacon works out for itself ARE the digits the daemon lists for the owner;
//   * a wrong typed code is refused (422) and Beacon keeps waiting; the right one connects;
//   * the token Beacon unsealed and kept WORKS against the daemon (the new device's last_seen_at moves), and Beacon told the
//     daemon it had arrived (a second approval is then 409 "delivered", not "approved");
//   * Back and Esc withdraw the request (the daemon's list empties); deny, an already-open request, a daemon that is not
//     offering approval, and a daemon that vanishes are each met with plain words and a way forward;
//   * the copy rules, on the RENDERED text.
//
// RUN (macOS; needs a checkout of Prometheus #698 or later and a Python with its dependencies; not part of verify):
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   npm run build && npm run probe:onboarding-approval          (PROBE_SLOW=1 adds the 60-second expiry)
// Without both variables the probe says SKIPPED and exits 3: a skipped probe is not a passed one.
//
// SAFE BY CONSTRUCTION: daemons on EPHEMERAL loopback ports with a temporary home (never 8005/8010, never the real ~/.prometheus);
// a fresh Beacon profile and --use-mock-keychain per launch (no real Keychain prompt); BEACON_DISCOVERY_SOURCES=loopback.
import { execFileSync, spawnSync } from 'node:child_process'
import WebSocket from 'ws'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'
import { bannedHits, clickText, pageText, press, startChecks, waitFor } from './lib/probe-kit.mjs'
import { makeFakes } from './lib/discovery-fixtures.mjs'

if (!realDaemonConfigured()) {
  console.log('[probe] onboarding-approval: SKIPPED — set BEACON_REAL_DAEMON_SRC (a Prometheus #698+ checkout\'s src) and BEACON_REAL_DAEMON_PY (a Python with its dependencies). A skipped probe is not a passed one.')
  process.exit(3)
}
const check = startChecks('onboarding-approval', 60)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]
const SHOTS = process.env.PROBE_SHOTS ?? ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const root = mkdtempSync(join(tmpdir(), 'beacon-approval-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const MY_NAME = (() => {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 }).toString().trim()
  } catch {
    return ''
  }
})()

let current = null
async function launch(daemon, sources = 'loopback') {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY')) delete process.env[k]
  process.env.BEACON_ONBOARDING = 'v4'
  Object.assign(process.env, { BEACON_DISCOVERY_SOURCES: sources, BEACON_DISCOVERY_PORT: String(daemon.port), BEACON_DISCOVERY_WINDOW_MS: '2500' })
  const app = await launchApp({ profile: mkdtempSync(join(root, 'profile-')), readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
  current = app
  return app
}
/** The same daemon, but found as ANOTHER computer: a fake `tailscale` (scripts/lib/discovery-fixtures.mjs) lists one peer at
 *  127.0.0.1, so Beacon meets it as a computer on the private network, not "this Mac". For the scenarios about waiting on someone
 *  ELSE to say yes: a Prometheus on this Mac is told to say yes here instead (A12). */
const fakes = makeFakes(root)
async function launchElsewhere(daemon) {
  const path = process.env.PATH
  process.env.PATH = `${fakes.bin}:${path}`
  try {
    return await launch(daemon, 'tailnet')
  } finally {
    process.env.PATH = path
  }
}
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? (document.querySelector('nav[aria-label="Views"]') ? 'app' : 'none')`)
const onScreen = (app, id, ms = 8000) => waitFor(() => screenId(app), (v) => v === id, ms)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const screenText = async (app) => norm(await pageText(app, '[data-screen]'))
const hasButton = (app, text) => app.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && b.offsetParent !== null)`)
const shownCode = (app) => app.page.evaluate(`document.querySelector('.onb-code')?.dataset.code ?? null`)
const waitCode = (app, ms = 10000) => waitFor(() => shownCode(app), (v) => typeof v === 'string' && /^\d{4}$/.test(v), ms)
async function noJargon(app, label, title) {
  const text = await screenText(app)
  const hits = bannedHits(text, WORDS)
  const t = await h1(app)
  check(text.length > 40 && t.startsWith(title) && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : t.startsWith(title) ? `${text.length} characters checked` : `title is "${t}", not "${title}"`)
}
async function shot(app, name) {
  if (!SHOTS) return
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
}
/** Welcome → the question → "connect to it" → (B1) → the list → Connect: the wait for approval.
 *  The question re-lays itself out when the quiet search finds the Prometheus on this Mac ("We found … running on this Mac", and a
 *  "Look for another computer" choice appears): clicks are by position, so they wait for that, or one can land on whatever moved under
 *  it (seen: a run ending on the question, or on connect by address). A computer found ELSEWHERE does not change the question. */
async function toB3(app, { here = true } = {}) {
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  if (here) await waitFor(() => screenText(app), (t) => t.includes('running on this Mac') && t.includes('Look for another computer'), 8000)
  await clickText(app, 'Yes, connect to it')
  await clickText(app, 'Continue')
  if ((await onScreen(app, 'B1', 3000)) === 'B1') await clickText(app, 'Continue')
  return onScreen(app, 'B3')
}
const pending = async (d) => (await d.owner('GET', '/api/pair/requests')).body?.requests ?? []
const devices = async (d) => (await d.owner('GET', '/api/devices')).body ?? []

/** An owner's socket over the daemon's real WebSocket bridge: authenticated with the global token, recording every frame. */
async function connectOperator(d) {
  const ws = new WebSocket(`ws://127.0.0.1:${d.wsPort}`)
  const frames = []
  ws.on('message', (m) => frames.push(JSON.parse(String(m))))
  await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)))
  ws.send(JSON.stringify({ type: 'auth', token: d.token }))
  await waitFor(() => frames.some((f) => f.type === 'connected'), (v) => v === true, 6000)
  return { ws, frames }
}
const daemons = []
const start = async (opts) => {
  const d = await startRealDaemon(opts)
  daemons.push(d)
  return d
}
let app
try {
  const rd = await start({ name: 'Probe Prometheus' })
  console.log(`[probe] the real daemon: ${rd.module.replace(/.*scratchpad\//, '…/')}  port ${rd.port}`)
  check(rd.port !== 8005 && rd.port !== 8010 && (await (await fetch(`http://127.0.0.1:${rd.port}/api/hello`)).json()).pair === 'approve', 'setup the real Prometheus pairing app is up on an ephemeral port and says it offers approval (hello: pair "approve")')

  // ── A1: asked, approved, connected ──────────────────────────────────────────────────────────────
  console.log('\n[probe] === A1: ask, approve, connected ===')
  app = await launch(rd)
  check((await toB3(app)) === 'B3' && (await screenText(app)).includes('Probe Prometheus'), 'A1 the real daemon\'s real hello puts it in the list under its own name')
  check((await clickText(app, 'Connect')) === 'clicked' && (await onScreen(app, 'B4')) === 'B4', 'A1 Connect goes on to the wait for approval', await screenId(app))
  const code = await waitCode(app)
  check(/^\d{4}$/.test(code ?? '') && (await h1(app)) === 'Waiting for approval', 'A1 it shows "Waiting for approval" and four digits', `${await h1(app)} / ${code}`)
  const wait = await screenText(app)
  check(wait.includes("We've asked Probe Prometheus to let this Mac connect.") && wait.includes('Make sure it shows this code:') && /Ends in [45]:\d\d/.test(wait) && wait.includes('Prometheus is running on this Mac') && !wait.includes('Open Beacon on the computer running Prometheus'), 'A1 it says who it asked, which code to look for, how long is left, and (Prometheus is on THIS Mac) that the person can say yes here, not "open Beacon on the computer running Prometheus"', wait.slice(0, 260))
  check(MY_NAME === '' || wait.includes(`This Mac will appear as ${MY_NAME}.`), 'A1 …and the name this Mac asked under (the computer\'s own name)', `${MY_NAME} / ${wait.slice(0, 160)}`)
  await noJargon(app, 'A1 the wait', 'Waiting for approval')
  check(await hasButton(app, 'Back'), 'A1 there is a Back')
  await shot(app, '17-waiting-for-approval.png')
  const open = await pending(rd)
  check(open.length === 1 && open[0].match_code === code, 'A1 the four digits Beacon worked out for itself are the digits the daemon lists for its owner', JSON.stringify(open.map((o) => o.match_code)))
  check(open[0]?.device_name === MY_NAME && open[0]?.platform === 'macos' && open[0]?.source_ip === '127.0.0.1' && open[0]?.ttl_seconds === 300, 'A1 the owner sees this Mac\'s name, "macos", where it came from and a five-minute lifetime', JSON.stringify(open[0]))
  const id = open[0]?.request_id
  const wrong = code.slice(0, 3) + String((Number(code[3]) + 1) % 10)
  const refused = await rd.owner('POST', `/api/pair/requests/${id}/approve`, { match_code: wrong })
  await sleep(2600)
  check(refused.status === 422 && (await screenId(app)) === 'B4' && (await pending(rd)).length === 1, 'A1 an owner who types the WRONG code is refused (422), the request stays open, and Beacon keeps waiting', `${refused.status} ${await screenId(app)}`)
  const approved = await rd.owner('POST', `/api/pair/requests/${id}/approve`, { match_code: code })
  check(approved.status === 200 && approved.body?.status === 'approved' && typeof approved.body?.device_id === 'string', 'A1 the right code approves it', JSON.stringify(approved))
  check((await onScreen(app, 'B-ok', 12000)) === 'B-ok' && (await h1(app)) === "You're connected", 'A1 Beacon notices within a poll and shows "You\'re connected"', await screenId(app))
  const ok = await screenText(app)
  check(ok.includes('This Mac can now talk to Probe Prometheus.') && !(await hasButton(app, 'Back')) && (await hasButton(app, 'Say hello')), 'A1 …names the computer, has "Say hello", and nothing to go back to')
  await noJargon(app, 'A1 connected', "You're connected")
  await shot(app, '18-youre-connected.png')
  const mine = (await devices(rd)).find((x) => x.id === approved.body?.device_id)
  check(mine && mine.name === MY_NAME && mine.owner === false && mine.revoked_at === null, 'A1 the daemon lists this Mac as an ordinary (not owner) device that is not revoked', JSON.stringify(mine))
  // Make Beacon use what it kept: an authenticated GET through the connection main brought up with the saved token.
  const viaBeacon = await app.page.evaluate(`window.beacon.daemon.get('/api/sessions').then((r) => ({ got: r !== null, kind: Array.isArray(r) ? 'list' : typeof r })).catch((e) => ({ got: false, error: String(e) }))`)
  const seen = await waitFor(async () => (await devices(rd)).find((x) => x.id === approved.body?.device_id)?.last_seen_at ?? null, (v) => v !== null, 10000)
  check(viaBeacon?.got === true && seen !== null, 'A1 the token Beacon unsealed and kept WORKS: a request made through Beacon is answered, and the daemon has seen this device use it (last_seen_at moved)', JSON.stringify({ viaBeacon, seen }))
  const again = await rd.owner('POST', `/api/pair/requests/${id}/approve`, {})
  check(again.status === 409 && again.body?.status === 'delivered', 'A1 Beacon told the daemon the token arrived (a second approval is "delivered", not "approved")', JSON.stringify(again))
  check((await pending(rd)).length === 0, 'A1 nothing is left waiting on the daemon')
  check((await clickText(app, 'Say hello')) === 'clicked' && (await onScreen(app, 'F1')) === 'F1', 'A1 "Say hello" goes on to the first message', await screenId(app))
  await app.quit()

  // ── A2: declined, then asked again ───────────────────────────────────────────────────────────────
  console.log('\n[probe] === A2: declined, ask again ===')
  app = await launch(rd)
  await toB3(app)
  await clickText(app, 'Connect')
  const code2 = await waitCode(app)
  const first = (await pending(rd))[0]
  const denied = await rd.owner('POST', `/api/pair/requests/${first?.request_id}/deny`, {})
  check(denied.status === 200 && (await waitFor(() => h1(app), (t) => t === 'The request was declined', 12000)) === 'The request was declined', 'A2 an owner who says no turns the wait into "The request was declined"', await h1(app))
  const declined = await screenText(app)
  check(declined.includes('Someone said no on another device.') && (await hasButton(app, 'Ask again')) && (await hasButton(app, 'Back')), 'A2 …in plain words, with Ask again and Back')
  await noJargon(app, 'A2 declined', 'The request was declined')
  await shot(app, '19-request-declined.png')
  check((await clickText(app, 'Ask again')) === 'clicked' && /^\d{4}$/.test((await waitCode(app)) ?? ''), 'A2 Ask again makes a fresh request and shows its code')
  const second = (await pending(rd))[0]
  check(second && second.request_id !== first.request_id, 'A2 …a new request on the daemon, not the old one', `${first?.request_id?.slice(0, 6)} / ${second?.request_id?.slice(0, 6)}`)
  await rd.owner('POST', `/api/pair/requests/${second?.request_id}/approve`, { match_code: second?.match_code })
  check((await onScreen(app, 'B-ok', 12000)) === 'B-ok', 'A2 and approving that one connects')
  await app.quit()

  // ── A3: Back and Esc withdraw ────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === A3: Back and Esc withdraw the request ===')
  app = await launch(rd)
  await toB3(app)
  await clickText(app, 'Connect')
  await waitCode(app)
  check((await pending(rd)).length === 1, 'A3 a request is open while waiting')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'A3 Back returns to the list')
  check((await waitFor(async () => (await pending(rd)).length, (n) => n === 0, 6000)) === 0, 'A3 …and the request is gone from the daemon (withdrawn, not left to expire)')
  await clickText(app, 'Connect')
  await waitCode(app)
  await press(app, 'Escape')
  check((await onScreen(app, 'B3')) === 'B3' && (await waitFor(async () => (await pending(rd)).length, (n) => n === 0, 6000)) === 0, 'A3 Esc does the same')
  await app.quit()

  // ── A4: a request from this Mac is already open ──────────────────────────────────────────────────
  console.log('\n[probe] === A4: a request from this Mac is already open ===')
  const strict = await start({ name: 'Strict Prometheus', perSource: 1 })
  const { publicKey } = generateKeyPairSync('x25519')
  const mineAlready = await fetch(`http://127.0.0.1:${strict.port}/api/pair/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_name: 'Something else', platform: 'macos', public_key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') })
  })
  const occupied = await mineAlready.json()
  app = await launch(strict)
  await toB3(app)
  await clickText(app, 'Connect')
  check((await waitFor(() => h1(app), (t) => t.startsWith('A request from this Mac is already open'), 10000)).startsWith('A request from this Mac is already open'), 'A4 when the daemon already has a request from this Mac, Beacon says so', await h1(app))
  const busy = await screenText(app)
  check(/Try again in about \d+ minutes?\./.test(busy) && (await hasButton(app, 'Try again')) && (await hasButton(app, 'Back')), 'A4 …how long to wait (the daemon\'s own number, in words), with Try again and Back', busy.slice(0, 200))
  await noJargon(app, 'A4 already open', 'A request from this Mac is already open')
  await fetch(`http://127.0.0.1:${strict.port}/api/pair/requests/${occupied.request_id}`, { method: 'DELETE', headers: { 'x-pairing-secret': occupied.poll_secret } })
  check((await clickText(app, 'Try again')) === 'clicked' && /^\d{4}$/.test((await waitCode(app)) ?? ''), 'A4 once the other request is gone, Try again waits for approval')
  await app.quit()

  // ── A5: a daemon that is not offering approval ───────────────────────────────────────────────────
  console.log('\n[probe] === A5: a daemon that does not offer approval ===')
  const closed = await start({ name: 'Closed Prometheus', requests: false })
  app = await launch(closed)
  await toB3(app)
  await clickText(app, 'Connect')
  check((await onScreen(app, 'B-nojoin')) === 'B-nojoin' && (await h1(app)) === "Closed Prometheus can't approve this Mac", 'A5 a daemon whose hello does not offer approval gets a card that says so', `${await screenId(app)}: ${await h1(app)}`)
  check((await hasButton(app, 'Connect another way')) && (await hasButton(app, 'Back')) && (await screenText(app)).includes('open Beacon on the computer running Prometheus and approve this Mac there'), 'A5 …with a way on (the older setup), Back, and where an owner would approve it (the computer running Prometheus)')
  await noJargon(app, 'A5 cannot approve', "Closed Prometheus can't approve this Mac")
  await shot(app, '20-cannot-approve.png')
  check((await pending(closed)).length === 0, 'A5 nothing was sent to it')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'A5 Back returns to the list')
  await clickText(app, 'Connect')
  await onScreen(app, 'B-nojoin')
  await clickText(app, 'Connect another way')
  check((await waitFor(() => screenId(app), (v) => v !== 'B-nojoin', 5000)) !== 'B-nojoin', 'A5 "Connect another way" leaves for the older setup', await screenId(app))
  await app.quit()

  // ── A6: the daemon goes away while waiting ───────────────────────────────────────────────────────
  console.log('\n[probe] === A6: the daemon disappears while Beacon waits ===')
  const doomed = await start({ name: 'Doomed Prometheus' })
  app = await launch(doomed)
  await toB3(app)
  await clickText(app, 'Connect')
  await waitCode(app)
  doomed.stop()
  check((await waitFor(() => h1(app), (t) => t.startsWith('We lost touch with Doomed Prometheus'), 25000)).startsWith('We lost touch with Doomed Prometheus'), 'A6 a daemon that stops answering ends the wait with "We lost touch" (after a few missed answers, not one)', await h1(app))
  check((await hasButton(app, 'Try again')) && (await hasButton(app, 'Back')), 'A6 …with Try again and Back')
  await noJargon(app, 'A6 lost touch', 'We lost touch with Doomed Prometheus')
  await app.quit()

  // ── A9: no one connected: a way out to the older setup, and the request is withdrawn ───────────
  console.log('\n[probe] === A9: no one connected, so there is another way ===')
  app = await launch(rd)
  await toB3(app)
  await clickText(app, 'Connect')
  await waitCode(app)
  check(await hasButton(app, 'Connect another way'), 'A9 while the daemon says no one is connected, the wait offers "Connect another way" (the older setup, where an API token can be pasted)')
  await shot(app, '24-waiting-nobody-connected.png')
  check((await clickText(app, 'Connect another way')) === 'clicked' && (await waitFor(() => screenId(app), (v) => v !== 'B4', 5000)) !== 'B4', 'A9 it leaves for the older setup', await screenId(app))
  check((await waitFor(async () => (await pending(rd)).length, (n) => n === 0, 6000)) === 0, 'A9 …and the request is withdrawn (leaving the wait always is)')
  await app.quit()

  // ── A10: an owner connects WHILE Beacon waits: the real poll says so ───────────────────────────
  console.log('\n[probe] === A10: an owner connects mid-wait ===')
  if (rd.frames) {
    app = await launchElsewhere(rd)
    await toB3(app, { here: false })
    await clickText(app, 'Connect')
    await waitCode(app)
    check((await screenText(app)).includes('No one is connected to approve this yet.') && (await hasButton(app, 'Connect another way')), 'A10 it starts as "no one is connected", with the other way offered')
    const late = await connectOperator(rd)
    const flipped = await waitFor(() => screenText(app), (t) => !t.includes('No one is connected'), 8000)
    check(!flipped.includes('No one is connected') && flipped.includes('If nothing happens, open Beacon on the computer running Prometheus.') && !(await hasButton(app, 'Connect another way')), 'A10 once an owner connects, the daemon\'s pending poll says so and the screen follows by itself: the quiet reminder, and no "Connect another way"', flipped.slice(0, 200))
    late.ws.close()
    await sleep(3500)
    const stays = await screenText(app)
    check(!stays.includes('No one is connected') && !(await hasButton(app, 'Connect another way')), 'A10 and when that owner leaves again (the real daemon then says false) it does NOT flip back: they were told')
    await clickText(app, 'Back')
    // Back withdraws the request asynchronously: wait for it, or the next scenario's owner socket is backfilled with this one first.
    await waitFor(async () => (await pending(rd)).length, (n) => n === 0, 6000)
    await app.quit()
  }

  // ── A8: an owner IS connected: the daemon says so, and its real frame carries the code ───────────
  console.log('\n[probe] === A8: an owner connected over the real WebSocket ===')
  if (rd.frames) {
    const op = await connectOperator(rd)
    app = await launchElsewhere(rd)
    await toB3(app, { here: false })
    await clickText(app, 'Connect')
    const code8 = await waitCode(app)
    const waiting8 = await screenText(app)
    check(!(await hasButton(app, 'Show me how')), 'A8 a computer found on the private network (not this Mac) is not offered "Show me how"')
    check(waiting8.includes('If nothing happens, open Beacon on the computer running Prometheus. It will show this request.') && !waiting8.includes('No one is connected') && !(await hasButton(app, 'Connect another way')), 'A8 when the daemon says an owner is connected to take the prompt, B4 gives the quiet reminder instead of "no one is connected", and no other way is pushed', waiting8.slice(0, 200))
    const pendingFrame = await waitFor(() => op.frames.find((f) => f.type === 'pairing_pending' && f.payload?.match_code === code8), (f) => !!f, 6000)
    check(pendingFrame?.payload?.match_code === code8 && pendingFrame?.payload?.device_name === MY_NAME, 'A8 the real pairing_pending frame the owner\'s socket got carries the SAME four digits Beacon computed for itself', JSON.stringify(pendingFrame?.payload ?? null).slice(0, 160))
    await clickText(app, 'Back')
    const resolved8 = await waitFor(() => op.frames.find((f) => f.type === 'pairing_resolved' && f.payload?.request_id === pendingFrame?.payload?.request_id), (f) => !!f, 6000)
    check(resolved8?.payload?.resolution === 'canceled' && resolved8?.payload?.request_id === pendingFrame?.payload?.request_id, 'A8 Back withdraws the request and the owner\'s socket is told (pairing_resolved, canceled)', JSON.stringify(resolved8?.payload ?? null).slice(0, 160))
    op.ws.close()
    await app.quit()
  } else {
    console.log('[probe] A8 SKIPPED: this daemon does not send pairing frames (Prometheus #699 and later does)')
  }

  // ── A12: Prometheus on this Mac and no other Beacon: say yes here, with Prometheus's own line ─────────
  // The onboarding shoot (2026-10-16): a Prometheus installed with pip or brew on this Mac, and no Beacon anywhere to approve. The
  // person is shown the one line (oara pair approve <id> --code <code>), and running THAT line, through the real Prometheus CLI,
  // lets this Mac in.
  console.log('\n[probe] === A12: Prometheus on this Mac, say yes here ===')
  const here = await start({ name: 'Probe Prometheus' })
  app = await launch(here)
  await toB3(app)
  await clickText(app, 'Connect')
  await onScreen(app, 'B4')
  const code12 = await waitCode(app)
  const w12 = await screenText(app)
  check(w12.includes('Prometheus is running on this Mac') && !w12.includes('Open Beacon on the computer running Prometheus') && !w12.includes('Approve it in Beacon on a computer') && (await hasButton(app, 'Show me how')), 'A12 for a Prometheus on this Mac the wait says so, sends the person to no other Beacon (neither "open Beacon on the computer running Prometheus" nor "approve it in Beacon on a computer that already uses Prometheus"), and offers "Show me how"', w12.slice(0, 300))
  await noJargon(app, 'A12 the wait, before "Show me how"', 'Waiting for approval')
  const how = await clickText(app, 'Show me how')
  const line = await waitFor(() => app.page.evaluate(`document.querySelector('[data-approve-command]')?.innerText?.trim() ?? null`), (v) => typeof v === 'string' && v.length > 0, 4000)
  await shot(app, '21-say-yes-here.png')
  const open12 = await pending(here)
  check(how === 'clicked' && open12.length === 1 && line === `oara pair approve ${open12[0]?.request_id?.slice(0, 8)} --code ${code12}`, 'A12 "Show me how" shows the one line: oara pair approve <this request> --code <the code on the screen>', `${line} / ${open12[0]?.request_id}`)
  // The page's clipboard writes are recorded instead of reaching the system clipboard: the person running the probe keeps theirs.
  await app.page.evaluate(`(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(String(t)) }; return true })()`)
  const copied = await clickText(app, 'Copy')
  const clip = await waitFor(() => app.page.evaluate(`JSON.stringify(window.__copied ?? [])`), (v) => v === JSON.stringify([line]), 3000)
  check(copied === 'clicked' && clip === JSON.stringify([line]), 'A12 Copy copies exactly that line, once', clip)
  // The line, run through the REAL Prometheus CLI (oara's own `pair` parser and run_pair_command), in a scratch home, against this
  // daemon. The token reaches it through the environment, never the command line.
  const cliHome = mkdtempSync(join(root, 'cli-home-'))
  const cli = spawnSync(process.env.BEACON_REAL_DAEMON_PY, ['-c', [
    'import argparse, json, os, shlex, sys',
    'from prometheus.cli.pair import add_pair_subparser, run_pair_command',
    'words = shlex.split(sys.argv[1]); assert words[0] == "oara", words',
    'p = argparse.ArgumentParser(prog="oara"); add_pair_subparser(p.add_subparsers(dest="command"))',
    'args = p.parse_args(words[1:]); out = []',
    'rc = run_pair_command(args, {"web": {"api_token": os.environ["PROBE_TOKEN"], "api_port": int(os.environ["PROBE_PORT"]), "bind": "127.0.0.1"}}, out=out.append)',
    'print(json.dumps({"rc": rc, "out": out}))'
  ].join('\n'), line ?? ''], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: cliHome, PYTHONPATH: process.env.BEACON_REAL_DAEMON_SRC, PROBE_TOKEN: here.token, PROBE_PORT: String(here.port), LANG: 'en_US.UTF-8' } })
  let ran = null
  try {
    ran = JSON.parse((cli.stdout ?? '').trim().split('\n').pop())
  } catch {
    ran = { rc: cli.status, out: [(cli.stderr ?? '').slice(-400)] }
  }
  check(ran?.rc === 0, 'A12 that exact line, run through the real Prometheus CLI on this Mac, approves the request', JSON.stringify(ran))
  check((await onScreen(app, 'B-ok', 12000)) === 'B-ok' && (await h1(app)) === "You're connected", 'A12 …and Beacon notices within a poll: "You\'re connected", no other Beacon needed', await screenId(app))
  const mine12 = (await devices(here)).find((x) => x.name === MY_NAME && x.revoked_at === null)
  check(!!mine12, 'A12 the daemon lists this Mac as a device', JSON.stringify((await devices(here)).map((x) => x.name)))
  await app.quit()

  // ── A7: nobody answers in time (slow) ────────────────────────────────────────────────────────────
  if (process.env.PROBE_SLOW === '1') {
    console.log('\n[probe] === A7: nobody answers in time (60 s) ===')
    const brief = await start({ name: 'Brief Prometheus', ttl: 60 })
    app = await launch(brief)
    await toB3(app)
    await clickText(app, 'Connect')
    await waitCode(app)
    check((await waitFor(() => h1(app), (t) => t === 'No one approved in time', 90000)) === 'No one approved in time' && (await hasButton(app, 'Ask again')), 'A7 a request nobody answers ends in "No one approved in time", with Ask again')
    await app.quit()
  }
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await current?.quit().catch(() => undefined)
  for (const d of daemons) d?.stop()
  console.log('\n[probe] profiles and daemon homes left in tmp for inspection (fresh, probe-only).')
}
