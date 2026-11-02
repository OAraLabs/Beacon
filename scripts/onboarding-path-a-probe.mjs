#!/usr/bin/env node
// onboarding-path-a-probe — "No, set it up on this Mac": the check of this Mac (A1) and the one confirmation
// (A-confirm), IN THE REAL APP, with real clicks.
//
// What it guards:
//   * the check says what is wrong in words and gives a button that helps: not enough free space (with the amount,
//     and Open Storage settings), macOS too old (and a link to update it), an Intel chip, a computer this is not
//     offered on, and a Prometheus that is already here;
//   * a Prometheus already on this Mac is recognised however it shows itself (the discovery hello, setup mode, or
//     the 401 of a configured daemon: the order settled with the installer session) and "Connect to it" goes to the
//     list with that computer selected, without a search that could raise the macOS prompt;
//   * a fact Beacon cannot read never blocks anyone;
//   * checking and confirming DOWNLOAD NOTHING: the stub sees only credential-free GETs, and the confirmation is the
//     one decision before anything starts;
//   * the confirmation says the size the release manifest gives (the only thing it asks the release for), and the
//     constant at once when the release cannot answer or stalls;
//   * no banned word on any of it, in the RENDERED text.
//
// The facts of this Mac are overridden through BEACON_MAC_CHECK, honoured only by a non-release build; the probe
// changes it mid-run (through main) to prove "Check again" re-reads them.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:onboarding-path-a
//
// SAFE BY CONSTRUCTION: the stub is on an EPHEMERAL loopback port (BEACON_DISCOVERY_PORT, honoured only by a
// non-release build), never 8005, so another session's daemon is never asked; shell.openExternal is replaced before
// it is clicked; a fresh profile and --use-mock-keychain per launch. Confirming starts setting Prometheus up, which this probe
// does not follow (probe:onboarding-install does): its release is a loopback port where nothing listens (or, for the size, a
// stub on an ephemeral loopback port that serves a manifest and no zip), its home a scratch
// folder and its launcher /usr/bin/false (all BEACON_PROMETHEUS_*, non-release only), so nothing is fetched from GitHub,
// nothing is put in the real Applications and nothing is run.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { bannedHits, clickText, pageText, startChecks, waitFor } from './lib/probe-kit.mjs'
import { stubDaemon } from './lib/stub-daemon.mjs'
import { createServer } from 'node:net'
import http from 'node:http'

const check = startChecks('onboarding-path-a', 46)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const STORAGE_URL = 'x-apple.systempreferences:com.apple.settings.Storage'
const UPDATE_URL = 'https://support.apple.com/en-us/108382'
const GB = 1024 ** 3
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const root = mkdtempSync(join(tmpdir(), 'beacon-patha-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const d = await stubDaemon()
d.profile = 'none'
const CLOSED = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

// The constant the confirmation falls back to, read from the source the app was built from (DOWNLOAD_ESTIMATE_FROM).
const FALLBACK_MB = Math.round(Number(readFileSync(new URL('../src/shared/mac-check.ts', import.meta.url), 'utf8').match(/DOWNLOAD_ESTIMATE_FROM = \{[^}]*zipBytes: ([\d_]+)/)[1].replace(/_/g, '')) / 1e6)
// The release stub for the size: a manifest only (no zip is served), or a release that takes the request and never answers.
const STUB_SIZE = 64_400_000
const rel = { mode: 'answer', requests: [] }
const relServer = http.createServer((req, res) => {
  rel.requests.push({ method: req.method, path: req.url, auth: 'authorization' in req.headers, cookie: 'cookie' in req.headers })
  if (rel.mode === 'stall') return // never answered; the app gives up on its own
  if (req.url === '/rel/prometheus-mac.json') return res.writeHead(302, { location: '/rel/download/v0.9.99/prometheus-mac.json' }).end()
  if (req.url === '/rel/download/v0.9.99/prometheus-mac.json') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '0.9.99', asset: 'Prometheus-0.9.99-arm64.zip', sha256: 'a'.repeat(64), size: STUB_SIZE, team_id: '53JM8W47RL' }))
  }
  res.writeHead(404).end()
})
const REL = await new Promise((r) => relServer.listen(0, '127.0.0.1', () => r(relServer.address().port)))

const GOOD = { platform: 'darwin', arch: 'arm64', macos: '15.6.1', freeBytes: 50 * GB, memoryBytes: 16 * GB }
async function launch(facts, profile = 'none', releasePort = CLOSED) {
  d.profile = profile
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY') || k.startsWith('BEACON_PROMETHEUS') || k === 'BEACON_MAC_CHECK') delete process.env[k]
  Object.assign(process.env, { BEACON_PROMETHEUS_RELEASE: `http://127.0.0.1:${releasePort}/rel`, BEACON_PROMETHEUS_HOME: join(root, 'home'), BEACON_PROMETHEUS_LAUNCHER: '/usr/bin/false' })
  process.env.BEACON_ONBOARDING = 'v4'
  Object.assign(process.env, { BEACON_DISCOVERY_SOURCES: 'loopback', BEACON_DISCOVERY_PORT: String(d.apiPort), BEACON_DISCOVERY_WINDOW_MS: '2500', BEACON_MAC_CHECK: JSON.stringify({ ...GOOD, ...facts }) })
  const app = await launchApp({ profile: mkdtempSync(join(root, 'profile-')), readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  return app
}
const setFacts = (app, facts) => app.mainEval(`process.env.BEACON_MAC_CHECK = ${JSON.stringify(JSON.stringify({ ...GOOD, ...facts }))}; true`)
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? 'none'`)
const onScreen = (app, id, ms = 6000) => waitFor(() => screenId(app), (v) => v === id, ms)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const screenText = async (app) => norm(await pageText(app, '[data-screen]'))
const hasButton = (app, text) => app.page.evaluate(`[...document.querySelectorAll('button, a[href]')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && b.offsetParent !== null)`)
const linkOf = (app, text) => app.page.evaluate(`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)})); return a ? { href: a.href, target: a.target } : null })()`)
const radios = (app) => app.page.evaluate(`[...document.querySelectorAll('[data-screen] [role="radio"]')].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), on: r.getAttribute('aria-checked') === 'true' }))`)
// An empty or stand-in screen contains no banned word: demand the screen's own title, too.
async function noJargon(app, label, title) {
  const text = await screenText(app)
  const hits = bannedHits(text, WORDS)
  const t = await h1(app)
  check(text.length > 40 && t.startsWith(title) && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : t.startsWith(title) ? `${text.length} characters checked` : `title is "${t}", not "${title}"`)
}
/** Welcome → the question → "set it up on this Mac" (chosen explicitly) → Continue. */
async function toCheck(app) {
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await clickText(app, 'No, set it up on this Mac')
  await clickText(app, 'Continue')
}
const opened = (app) => app.mainEval(`globalThis.__opened`)
const credFree = () => d.requests.every((q) => q.method === 'GET' && !('authorization' in q.headers) && !('cookie' in q.headers))

let app
try {
  // ── P1: a Mac that can run it ────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P1: all well ===')
  app = await launch({})
  await toCheck(app)
  const checking = await waitFor(() => screenText(app), (t) => t.includes('Checking this Mac'), 2500)
  check((await screenId(app)) === 'A1' && checking.includes('Checking this Mac') && checking.includes('Making sure Prometheus will run well here'), 'P1 a first look says what it is doing: "Checking this Mac…"', checking.slice(0, 100))
  check((await onScreen(app, 'A-confirm', 6000)) === 'A-confirm', 'P1 a Mac that can run it goes on to the one confirmation', await screenId(app))
  check((await h1(app)) === 'Set up Prometheus on this Mac', 'P1 …titled "Set up Prometheus on this Mac"', await h1(app))
  const confirm = await screenText(app)
  check(confirm.includes('Beacon will get Prometheus from OAra Labs') && confirm.includes('Applications folder') && confirm.includes('keeps running when you log in') && !/Settings|turn (it|that) off|newer/.test(confirm), 'P1 it says what will happen (where it comes from, where it goes, that it keeps running) and promises no switch or check Beacon does not have yet')
  await noJargon(app, 'P1 the confirmation', 'Set up Prometheus on this Mac')
  check((await hasButton(app, 'Set up Prometheus')) && (await hasButton(app, 'Back')), 'P1 one button to go on, and Back')
  check(confirm.includes(`(about ${FALLBACK_MB} MB)`), `P1 with a release that cannot be reached, it says the constant (about ${FALLBACK_MB} MB)`, confirm.match(/\(about [^)]*\)/)?.[0])
  const paths = new Set(d.requests.map((q) => q.path))
  check(paths.size === 3 && d.requests.every((q) => q.method === 'GET' && ['/api/hello', '/api/setup/status', '/api/status'].includes(q.path)) && credFree(), 'P1 checking looked for a Prometheus already here by all three ways it can show itself (hello, setup mode, a daemon that asks for a credential), as GETs with no credential', JSON.stringify([...new Set(d.requests.map((q) => `${q.method} ${q.path}`))]))
  check((await h1(app)) === 'Set up Prometheus on this Mac' && (await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'P1 Back from the confirmation is the question')
  await clickText(app, 'Continue')
  await onScreen(app, 'A-confirm')
  const before = d.requests.length
  check((await clickText(app, 'Set up Prometheus')) === 'clicked' && (await onScreen(app, 'A-inst')) === 'A-inst' && (await waitFor(() => h1(app), (t) => t === 'Setting up Prometheus' || t === "We couldn't get Prometheus", 5000)) !== 'Not built yet', 'P1 confirming goes on to setting it up (A-inst), a real screen', `${await screenId(app)}: ${await h1(app)}`)
  check((await screenId(app)) === 'A-inst' && d.requests.length === before && d.requests.every((q) => q.method === 'GET'), 'P1 …and the computer the check looked at was sent nothing (getting Prometheus asks its release, never the computer)')
  await app.quit()

  // ── P1s: the size, from the release manifest ─────────────────────────────────────────────────
  console.log('\n[probe] === P1s: the confirmation says the release manifest\'s size ===')
  rel.mode = 'answer'
  rel.requests = []
  app = await launch({}, 'none', REL)
  await toCheck(app)
  await onScreen(app, 'A-confirm', 6000)
  const sized = await waitFor(() => screenText(app), (t) => t.includes('(about 64 MB)'), 4000)
  check(sized.includes('(about 64 MB)'), 'P1s the manifest says 64,400,000 bytes, and the confirmation says about 64 MB', sized.match(/\(about [^)]*\)/)?.[0])
  check(rel.requests.length > 0 && rel.requests.every((q) => q.method === 'GET' && !q.auth && !q.cookie && q.path.endsWith('/prometheus-mac.json')), 'P1s …and the release was asked for its manifest only (no zip), as GETs with no credential', JSON.stringify(rel.requests))
  await app.quit()

  console.log('\n[probe] === P1t: a release that never answers ===')
  rel.mode = 'stall'
  rel.requests = []
  app = await launch({}, 'none', REL)
  await toCheck(app)
  await onScreen(app, 'A-confirm', 6000)
  const atOnce = await screenText(app)
  check(atOnce.includes(`(about ${FALLBACK_MB} MB)`), `P1t the confirmation says the constant (about ${FALLBACK_MB} MB) as soon as it is on screen, without waiting for the release`, atOnce.match(/\(about [^)]*\)/)?.[0])
  await sleep(3500) // past main's timeout for the manifest
  const after = await screenText(app)
  check(rel.requests.length > 0 && after.includes(`(about ${FALLBACK_MB} MB)`) && (await hasButton(app, 'Set up Prometheus')), 'P1t …the release was asked, and once main gave up it still says the constant, with the button there', JSON.stringify({ asked: rel.requests.length, said: after.match(/\(about [^)]*\)/)?.[0] }))
  await app.quit()
  rel.mode = 'answer'

  // ── P2: not enough room ──────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P2: not enough free space ===')
  app = await launch({ freeBytes: 0.6 * GB })
  await toCheck(app)
  check((await waitFor(() => h1(app), (t) => t === 'This Mac needs more free space.', 5000)) === 'This Mac needs more free space.', 'P2 too little room is "This Mac needs more free space."', await h1(app))
  const space = await screenText(app)
  check(space.includes('Prometheus needs about 2 GB; this Mac has 0.6 GB free.'), 'P2 …saying how much is needed and how much there is', space)
  await noJargon(app, 'P2 not enough space', 'This Mac needs more free space.')
  check((await clickText(app, 'Open Storage settings')) === 'clicked' && JSON.stringify(await waitFor(() => opened(app), (v) => v.length > 0, 3000)) === JSON.stringify([STORAGE_URL]), 'P2 Open Storage settings opens the Storage pane of System Settings, and nothing else', JSON.stringify(await opened(app)))
  await setFacts(app, { freeBytes: 30 * GB })
  check((await clickText(app, 'Check again')) === 'clicked' && (await onScreen(app, 'A-confirm', 6000)) === 'A-confirm', 'P2 once there is room, Check again reads the Mac again and goes on', await screenId(app))
  await app.quit()
  app = await launch({ freeBytes: 0.6 * GB })
  await toCheck(app)
  await onScreen(app, 'A1')
  await waitFor(() => h1(app), (t) => t.includes('free space'), 5000)
  check((await h1(app)) === 'This Mac needs more free space.' && (await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'P2 Back from the card is the question')
  await app.quit()

  // ── P3: macOS too old ────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P3: macOS too old ===')
  app = await launch({ macos: '12.7.6' })
  await toCheck(app)
  check((await waitFor(() => h1(app), (t) => t === 'This Mac needs a newer macOS.', 5000)) === 'This Mac needs a newer macOS.', 'P3 an old macOS is "This Mac needs a newer macOS."', await h1(app))
  check((await screenText(app)).includes('Prometheus needs macOS 13 or later.'), 'P3 …saying which version it needs')
  await noJargon(app, 'P3 macOS too old', 'This Mac needs a newer macOS.')
  const upd = await linkOf(app, 'How to update')
  check(upd?.href === UPDATE_URL && upd?.target === '_blank', 'P3 "How to update" is a link to Apple\'s page that opens in the browser', JSON.stringify(upd))
  await app.quit()

  // ── P4: an Intel chip ────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P4: an Intel chip ===')
  app = await launch({ arch: 'x64' })
  await toCheck(app)
  check((await waitFor(() => h1(app), (t) => t === 'This Mac has an Intel chip.', 5000)) === 'This Mac has an Intel chip.', 'P4 an Intel chip is "This Mac has an Intel chip."', await h1(app))
  check((await screenText(app)).includes('Prometheus for Mac needs Apple silicon (M1 or later). You can still use Beacon with Prometheus on another computer.'), 'P4 …saying what it needs, and that Beacon can still be used with a Prometheus elsewhere')
  await noJargon(app, 'P4 an Intel chip', 'This Mac has an Intel chip.')
  check((await clickText(app, 'Connect to another computer')) === 'clicked', 'P4 "Connect to another computer" is clickable')
  const elsewhere = await waitFor(() => screenId(app), (v) => v === 'B1' || v === 'B2' || v === 'B3', 4000)
  check(elsewhere === 'B1', 'P4 …and goes to the search for a computer, explaining the permission first (B1)', elsewhere)
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'A1')) === 'A1' && (await h1(app)) === 'This Mac has an Intel chip.', 'P4 Back from there returns to the card')
  await app.quit()

  // ── P5: not a Mac ────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P5: a computer this is not offered on ===')
  app = await launch({ platform: 'linux', arch: 'x64', macos: null })
  await toCheck(app)
  check((await waitFor(() => h1(app), (t) => t === "Setting up isn't available on this computer yet.", 5000)) === "Setting up isn't available on this computer yet.", 'P5 another kind of computer is told setting up is not available yet', await h1(app))
  await noJargon(app, 'P5 not offered here', "Setting up isn't available on this computer yet.")
  check(await hasButton(app, 'Connect to another computer'), 'P5 …with a way to use Beacon with Prometheus elsewhere')
  await app.quit()

  // ── P6: a Prometheus is already here ─────────────────────────────────────────────────────────
  console.log('\n[probe] === P6: Prometheus is already on this Mac ===')
  for (const [profile, label] of [['hello', 'answers the discovery hello'], ['setup', 'is in setup mode'], ['configured', 'is a running daemon that asks for a credential']]) {
    d.requests.length = 0
    app = await launch({ freeBytes: 0.6 * GB }, profile) // the low space is deliberate: an existing Prometheus needs none
    await toCheck(app)
    const t = await waitFor(() => h1(app), (x) => x === 'Prometheus is already on this Mac.', 6000)
    check(t === 'Prometheus is already on this Mac.', `P6 a Prometheus that ${label} is recognised, even on a Mac with too little room to install another`, `${profile}: ${await h1(app)}`)
    if (profile === 'hello') {
      await noJargon(app, 'P6 already here', 'Prometheus is already on this Mac.')
      check((await h1(app)) === 'Prometheus is already on this Mac.' && d.requests.length > 0 && credFree() && d.requests.every((q) => q.method === 'GET'), 'P6 recognising it sent no credential')
      check((await clickText(app, 'Connect to it')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'P6 "Connect to it" goes to the list', await screenId(app))
      const rs = await radios(app)
      check(rs.length === 1 && rs[0].on && rs[0].text.startsWith('This Mac') && rs[0].text.includes('running here'), 'P6 …with "This Mac" selected: no search was needed to find it', JSON.stringify(rs))
      check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'A1')) === 'A1', 'P6 Back from the list is the card')
    }
    await app.quit()
  }

  // ── P7: facts Beacon cannot read never block ─────────────────────────────────────────────────
  console.log('\n[probe] === P7: unknown facts ===')
  app = await launch({ freeBytes: null, macos: null })
  await toCheck(app)
  check((await onScreen(app, 'A-confirm', 6000)) === 'A-confirm', 'P7 free space and a macOS version that cannot be read do not stop anyone', await screenId(app))
  const outside = await app.page.evaluate(`performance.getEntriesByType('resource').filter((e) => !e.name.startsWith('file:')).map((e) => e.name)`)
  check((await screenId(app)) === 'A-confirm' && outside.length === 0, 'P7 the screens loaded nothing from the network themselves', JSON.stringify(outside))
  await app.quit()

  // ── P8: a check that cannot be made never blocks ─────────────────────────────────────────────
  console.log('\n[probe] === P8: the check itself fails ===')
  app = await launch({})
  await app.mainEval(`__electron.ipcMain.removeHandler('patha:check'); true`)
  // Positive control: prove the fault is in place (the invoke rejects), or a pass below would mean nothing.
  const rejected = await app.page.evaluate(`window.beacon.pathA.check().then(() => 'resolved', () => 'rejected')`)
  check(rejected === 'rejected', 'P8 the check of this Mac really cannot be made (the request is refused)', rejected)
  await toCheck(app)
  check((await onScreen(app, 'A-confirm', 6000)) === 'A-confirm' && (await h1(app)) === 'Set up Prometheus on this Mac', 'P8 …and Beacon goes on to the confirmation instead of stopping someone for it', `${await screenId(app)}: ${await h1(app)}`)
  await app.quit()
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  await d.stop()
  relServer.closeAllConnections?.()
  relServer.close()
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
