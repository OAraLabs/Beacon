#!/usr/bin/env node
// setup-resume-probe — can someone who stops half-way through setup, or whose Prometheus goes away,
// always get back to a working screen IN THE REAL APP? The 0.3.0 bug this guards: pairing saves the
// connection before the model/identity/apply steps, startup asked only "is a connection saved?", so
// quitting after pairing opened the main app on a Prometheus still in setup mode — and nothing in
// the app could get back to setup. `smoke:setup-wizard` proves the pure routing rule; only the built
// app shows that startup, the wizard and Settings actually follow it.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:setup-resume
//
// SAFE BY CONSTRUCTION:
//   * every launch uses a FRESH EMPTY profile (--user-data-dir in tmp), never a copy of the user's;
//     --use-mock-keychain keeps the stored credential off the real Keychain (app-driver.mjs);
//   * the "Prometheus" is a stub on 127.0.0.1:8005/8010 in this process. The probe refuses to start
//     if either port is already taken, so it can never talk to a real daemon;
//   * BEACON_GATEWAY_* are removed from the environment: they would bypass setup entirely.
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep, sql } from './app-driver.mjs'
import { keptCount, profileDbFiles } from './lib/profile-db.mjs'

const API_PORT = 8005
const WS_PORT = 8010
const CODE = '482913'
const MIN_CHECKS = 30

let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}
// The verdict lives on 'exit', so an early exit or a throw can't skip the count guard.
process.on('exit', (code) => {
  if (checks < MIN_CHECKS) {
    console.log(`[probe] setup-resume: only ${checks} checks ran (expected at least ${MIN_CHECKS}) — INCOMPLETE`)
    process.exitCode = 1
    return
  }
  console.log(failures === 0 ? `[probe] setup-resume: all ${checks} checks passed` : `[probe] setup-resume: ${failures} of ${checks} FAILED`)
  if (failures > 0 || code !== 0) process.exitCode = 1
})

for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

// ── preconditions ───────────────────────────────────────────────────────────────────────────
function portTaken(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), res(true)))
    s.once('error', () => res(false))
  })
}
for (const p of [API_PORT, WS_PORT]) {
  if (await portTaken(p)) {
    console.log(`[probe] ABORT: something already listens on 127.0.0.1:${p}. Refusing to run next to a real Prometheus.`)
    process.exit(2)
  }
}

// ── the stub Prometheus ─────────────────────────────────────────────────────────────────────
// mode 'setup': a first-boot daemon in setup mode (the real setup_server's routes and status codes).
// mode 'configured': a running daemon — bearer on every /api/ route, a WS with first-frame auth.
// stop(): nothing listens at all.
const stub = {
  mode: 'setup',
  token: 'stub-token-A',
  configuredFlag: false,
  pairs: 0,
  detects: [],
  http: null,
  ws: null
}
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (stub.mode === 'setup') {
      if (url.pathname === '/api/setup/status' && req.method === 'GET')
        return json(res, 200, { setup_mode: true, configured: stub.configuredFlag, pairing: 'available', version: 'stub' })
      if (url.pathname === '/api/setup/pair' && req.method === 'POST') {
        const code = JSON.parse(body || '{}').code
        if (code !== CODE) return json(res, 401, { error: 'invalid_code', attempts_remaining: 4 })
        stub.pairs++
        return json(res, 200, { token: stub.token, api_base_port: API_PORT, ws_port: WS_PORT })
      }
      if (url.pathname === '/api/setup/detect' && req.method === 'GET') {
        stub.detects.push(bearer)
        if (bearer !== stub.token) return json(res, 401, { error: 'unauthorized' })
        return json(res, 200, {
          backends: [{ name: 'stub llama.cpp', provider: 'llama_cpp', base_url: 'http://127.0.0.1:8080', models: ['stub-model'], latency_ms: 3 }],
          cloud_providers: []
        })
      }
      return json(res, 403, { error: 'setup_mode' })
    }
    // configured: the real daemon's bearer middleware answers every /api/ path 401 without the token
    if (url.pathname.startsWith('/api/') && bearer !== stub.token) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/api/status') return json(res, 200, { status: 'ok', model: 'stub-model' })
    if (url.pathname === '/api/sessions') return json(res, 200, { sessions: [] })
    return json(res, 404, { error: 'not_found' })
  })
}
async function stubStart(mode) {
  stub.mode = mode
  if (!stub.http) {
    stub.http = createServer(handle)
    await new Promise((r) => stub.http.listen(API_PORT, '127.0.0.1', r))
  }
  if (mode === 'configured' && !stub.ws) {
    stub.ws = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT })
    await new Promise((r) => stub.ws.once('listening', r))
    stub.ws.on('connection', (sock) => {
      sock.once('message', (raw) => {
        let f = null
        try { f = JSON.parse(String(raw)) } catch { /* not JSON */ }
        if (f?.type === 'auth' && f.token === stub.token) sock.send(JSON.stringify({ type: 'connected' }))
        else sock.close(4401)
      })
    })
  }
  if (mode !== 'configured' && stub.ws) await stubCloseWs()
}
async function stubCloseWs() {
  if (!stub.ws) return
  for (const c of stub.ws.clients) c.terminate()
  await new Promise((r) => stub.ws.close(r))
  stub.ws = null
}
async function stubStop() {
  await stubCloseWs()
  if (stub.http) {
    stub.http.closeAllConnections?.()
    await new Promise((r) => stub.http.close(r))
    stub.http = null
  }
}

// ── app helpers ─────────────────────────────────────────────────────────────────────────────
// The v0.4 first run ([data-screen]) is the first run since it went live (ONBOARDING_V4_LIVE); the legacy wizard (.wiz-card) still
// picks up a part-way setup the new flow doesn't resume (src/shared/onboarding.ts onboardingEntry).
const EITHER = '.wiz-card, [data-screen], nav[aria-label="Views"]'
const freshProfile = () => mkdtempSync(join(tmpdir(), 'beacon-setup-probe-'))
const launch = (profile) => launchApp({ profile, readySelector: EITHER })

async function screen(app) {
  return app.page.evaluate(`document.querySelector('.wiz-card') ? 'wizard' : document.querySelector('[data-screen]') ? 'onboarding' : document.querySelector('nav[aria-label="Views"]') ? 'app' : 'neither'`)
}
/** The v0.4 first run's screen id (W1, A2, …), or null when it isn't showing. */
async function v4Screen(app) {
  return app.page.evaluate(`document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null`)
}
/** Whether the profile holds a key for any Prometheus: each one's own daemons/<id>/credential.bin (or, before keys moved into
 *  folders, the one api-credential.bin). */
function hasKey(profile) {
  const folders = profileDbFiles(profile).filter((f) => f !== 'app.db' && f !== 'beacon.db').map((f) => join(profile, f.replace(/cache\.db$/, 'credential.bin')))
  return existsSync(join(profile, 'api-credential.bin')) || folders.some((f) => existsSync(f))
}
async function activeStep(app) {
  // The label span, not the whole row: the row's text starts with the step number ("3Model").
  return app.page.evaluate(`document.querySelector('.wiz-rail .wiz-step.active > span:not(.wiz-dot)')?.firstChild?.textContent?.trim() ?? null`)
}
async function waitFor(fn, pred, ms) {
  const end = Date.now() + ms
  let v
  for (;;) {
    v = await fn()
    if (pred(v) || Date.now() > end) return v
    await sleep(250)
  }
}
async function pageText(app, sel) {
  return app.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`)
}
/** A REAL click: find the button by its text, prove nothing covers its centre, then press there. */
async function clickButton(app, text) {
  const where = await app.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}) && x.offsetParent !== null)
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === b || b.contains(top)), disabled: b.disabled }
  })()`)
  if (!where) return `no visible button starting "${text}"`
  if (!where.hit) return `"${text}" is covered at its centre`
  if (where.disabled) return `"${text}" is disabled`
  for (const type of ['mousePressed', 'mouseReleased'])
    await app.page.send('Input.dispatchMouseEvent', { type, x: where.x, y: where.y, button: 'left', clickCount: 1 })
  return 'clicked'
}
const BANNER = '[role="alert"].unreachable-banner'
/** A listener that accepts and drops every connection, recording when each dial arrived: the
 *  socket's own reconnect schedule, made visible. */
async function blackhole(port) {
  const attempts = []
  const srv = createTcpServer((sock) => {
    attempts.push(Date.now())
    sock.destroy()
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  return { attempts, close: () => new Promise((r) => srv.close(r)) }
}

try {
  // ── S1: paired, then quit before finishing → the next launch reopens setup at Model ─────────
  console.log('\n[probe] === S1: quit after pairing, relaunch ===')
  const P1 = freshProfile()
  await stubStart('setup')
  let app = await launch(P1)
  check((await screen(app)) === 'onboarding' && (await v4Screen(app)) === 'W1', 'S1 an empty profile opens the first run, at Welcome', await v4Screen(app))
  // The same IPC the Pair button calls; this scenario is about what happens on the NEXT launch.
  const paired = await app.page.evaluate(`window.beacon.setup.pair({ address: '127.0.0.1', code: '${CODE}' })`)
  check(paired?.ok === true && stub.pairs === 1, 'S1 pairing with the code succeeds', JSON.stringify(paired))
  await app.quit()
  app = await launch(P1)
  const s1 = await screen(app)
  check(s1 === 'onboarding', 'S1 relaunch after pairing reopens setup, not the main app', s1)
  check((await v4Screen(app)) === 'A2', 'S1 …resumed at "How should your assistant think?" (A2), the step after pairing', await v4Screen(app))
  check(stub.detects.includes(stub.token), 'S1 the saved pairing was checked with Prometheus before resuming (one authed detect with it)', JSON.stringify(stub.detects))
  await app.quit()

  // ── S2: the same profile, Prometheus now configured → the app, connected, no banner ─────────
  console.log('\n[probe] === S2: configured Prometheus, relaunch ===')
  await stubStart('configured')
  app = await launch(P1)
  check((await screen(app)) === 'app', 'S2 a configured Prometheus opens the main app', await screen(app))
  const st2 = await waitFor(() => app.page.evaluate(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 10000)
  check(st2 === 'connected', 'S2 the connection comes up (the stub WS answers the first-frame auth)', st2)
  await sleep(6000)
  check((await app.page.evaluate(`!!document.querySelector(${JSON.stringify(BANNER)})`)) === false, 'S2 no "can\'t reach" banner while connected (6 s)')
  await app.quit()

  // ── S3: Prometheus unreachable → the app with a way out ─────────────────────────────────────
  console.log('\n[probe] === S3: unreachable Prometheus ===')
  await stubStop()
  // Nothing answers: Beacon asks the identity challenge (docs/MULTI-PROMETHEUS.md §8) before any key goes out, so its automatic retries
  // are those asks, at the REST port. The socket dials only once one is answered.
  const bh3 = await blackhole(API_PORT)
  app = await launch(P1)
  check((await screen(app)) === 'app', 'S3 an unreachable Prometheus still opens the app (not setup)', await screen(app))
  const b3 = await waitFor(() => pageText(app, BANNER), (t) => t.length > 0, 15000)
  check(b3.includes("Can't reach Prometheus") && b3.includes('127.0.0.1'), 'S3 a banner says it can\'t reach Prometheus, and where', JSON.stringify(b3))
  check(/Try again/.test(b3) && /Change connection/.test(b3), 'S3 …with Try again and Change connection', JSON.stringify(b3))
  // Try again has to reconnect NOW, not on the retries' own schedule, or it does nothing the backoff wouldn't have done anyway. Wait
  // until Beacon has asked 5 times (its next ask is then 30 s away), bring Prometheus back, click, and require "connected" in 2.5 s.
  await waitFor(async () => bh3.attempts.length, (n) => n >= 5, 45000)
  check(bh3.attempts.length >= 5, 'S3 the retries have backed off (5 automatic asks seen)', `${bh3.attempts.length} asks`)
  const lastDial = bh3.attempts.at(-1)
  await bh3.close()
  await stubStart('configured')
  const clicked3 = Date.now()
  check((await clickButton(app, 'Try again')) === 'clicked', 'S3 Try again is clickable (real click, not covered)')
  const st3 = await waitFor(() => app.page.evaluate(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 2500)
  check(
    st3 === 'connected' && clicked3 - lastDial < 8000,
    'S3 Try again reconnects at once, inside the backoff window',
    `${st3}, ${Date.now() - clicked3} ms after the click, ${clicked3 - lastDial} ms after the last automatic ask`
  )
  const gone3 = await waitFor(() => app.page.evaluate(`!!document.querySelector(${JSON.stringify(BANNER)})`), (v) => v === false, 5000)
  check(gone3 === false, 'S3 the banner goes away when connected')
  await stubStop()
  const back3 = await waitFor(() => pageText(app, BANNER), (t) => t.length > 0, 15000)
  check(back3.includes("Can't reach Prometheus"), 'S3 the banner comes back when it drops again')
  check((await clickButton(app, 'Change connection')) === 'clicked', 'S3 Change connection is clickable')
  const settings3 = await waitFor(() => app.page.evaluate(`[...document.querySelectorAll('h2')].some((h) => h.innerText.includes('Connection Settings'))`), (v) => v === true, 4000)
  check(settings3 === true, 'S3 Change connection opens Connection Settings')
  await app.quit()

  // ── S4: Settings → Set up again → setup, with the saved address and credential gone ────────
  console.log('\n[probe] === S4: Settings → Set up again ===')
  await stubStart('configured')
  app = await launch(P1)
  check((await screen(app)) === 'app', 'S4 starts in the main app')
  check(hasKey(P1), 'S4 a credential is stored before (precondition)')
  await app.page.evaluate(`window.dispatchEvent(new Event('beacon:open-settings')); true`)
  await waitFor(() => app.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith('Set up again'))`), (v) => v === true, 4000)
  check((await clickButton(app, 'Set up again')) === 'clicked', 'S4 Settings has a clickable "Set up again…"')
  const warn4 = await app.page.evaluate(`document.body.innerText`)
  check(/pairing code or the API token/.test(warn4), 'S4 it warns what you will need to connect again, before doing anything')
  check(hasKey(P1), 'S4 the first click forgets nothing')
  check((await clickButton(app, 'Forget and set up again')) === 'clicked', 'S4 the confirm button is clickable')
  const s4 = await waitFor(() => screen(app), (v) => v === 'onboarding', 5000)
  check(s4 === 'onboarding', 'S4 confirming opens setup', s4)
  check((await v4Screen(app)) === 'W1', 'S4 …from the start (Welcome)', await v4Screen(app))
  check(!hasKey(P1), 'S4 the stored credential is deleted')
  await app.quit()
  check(keptCount(P1) === 0, 'S4 the saved address is deleted')
  app = await launch(P1)
  check((await screen(app)) === 'onboarding' && (await v4Screen(app)) === 'W1', 'S4 a relaunch stays in setup, at Welcome')
  await app.quit()

  // ── S5: a saved pairing the setup-mode Prometheus no longer accepts → back to Connect ───────
  console.log('\n[probe] === S5: stale pairing ===')
  const P2 = freshProfile()
  await stubStart('setup')
  stub.token = 'stub-token-A'
  app = await launch(P2)
  const p5 = await app.page.evaluate(`window.beacon.setup.pair({ address: '127.0.0.1', code: '${CODE}' })`)
  check(p5?.ok === true, 'S5 pairs (precondition)')
  await app.quit()
  stub.token = 'stub-token-B' // a reinstalled Prometheus: same address, new pairing
  app = await launch(P2)
  // The new flow resumes this Mac's paired setup at A2; a pairing Prometheus refuses can't go on there, so it is the wizard's Connect.
  check((await screen(app)) === 'wizard', 'S5 relaunch opens setup at the wizard, not the new flow at A2 with a key that cannot work', `${await screen(app)} ${await v4Screen(app)}`)
  const step5 = await waitFor(() => activeStep(app), (v) => v === 'Connect', 10000)
  check(step5 === 'Connect', 'S5 a rejected saved pairing lands on Connect', step5)
  const err5 = `${await pageText(app, '.wiz-resume')} ${await pageText(app, '.setup-error')}`
  check(/[Pp]air again/.test(err5), 'S5 …saying to pair again', JSON.stringify(err5))
  check((await app.page.evaluate(`document.querySelector('.wiz-pane input')?.value ?? ''`)).includes('127.0.0.1'), 'S5 …with the address filled in')
  await app.quit()

  // ── S6: an address saved without pairing (Quick connect) on a setup-mode Prometheus ─────────
  console.log('\n[probe] === S6: saved without pairing ===')
  const P3 = freshProfile()
  stub.token = 'stub-token-A'
  app = await launch(P3)
  const sv = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', token: '' })`)
  check(sv?.ok === true, 'S6 Quick connect saves an address with no token (precondition)')
  await app.quit()
  app = await launch(P3)
  check((await screen(app)) === 'wizard', 'S6 relaunch opens setup, not the main app', await screen(app))
  check((await activeStep(app)) === 'Connect', 'S6 …at Connect, to pair', await activeStep(app))
  check((await pageText(app, '.wiz-resume')).includes('pair'), 'S6 …and says it still needs pairing', await pageText(app, '.wiz-resume'))
  await app.quit()

  // ── S7: back out of a resumed setup ───────────────────────────────────────────────────────
  // The new flow has no "Start over" at A2: it resumes as if Prometheus had just been set up here, with Welcome and the choice of
  // where behind it, so Back is the way out (src/shared/onboarding.ts initialOnboardingState).
  console.log('\n[probe] === S7: back out of a resumed setup ===')
  const P4 = freshProfile()
  app = await launch(P4)
  const p7 = await app.page.evaluate(`window.beacon.setup.pair({ address: '127.0.0.1', code: '${CODE}' })`)
  check(p7?.ok === true, 'S7 pairs (precondition)')
  await app.quit()
  app = await launch(P4)
  check((await v4Screen(app)) === 'A2', 'S7 resumed at A2', await v4Screen(app))
  check((await clickButton(app, 'Back')) === 'clicked', 'S7 "Back" is clickable')
  if ((await v4Screen(app)) !== 'W1') await clickButton(app, 'Back')
  const step7 = await waitFor(() => v4Screen(app), (v) => v === 'W1', 5000)
  check(step7 === 'W1', 'S7 Back returns to Welcome', step7)
  await app.quit()
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await stubStop()
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
