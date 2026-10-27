#!/usr/bin/env node
// onboarding-path-b-probe — "Yes, I have Prometheus": from the question to a chosen computer, IN THE REAL
// APP, with real clicks and key presses, on the discovery engine's real IPC and real Bonjour.
//
// What it guards:
//   * W2 recommends "connect to it" only when a Prometheus has actually answered on this Mac, names it, and
//     never overrides a choice the person made;
//   * B1 explains the Local Network permission BEFORE anything can ask for it, once;
//   * B3 lists what was found, selects the one result for you, selects nothing when there are several, and
//     does not enable Connect until a row is chosen;
//   * B-empty gives the reasons, says "denied" only when macOS really refused, and opens the right settings
//     pane from a button;
//   * a computer whose fingerprint changed since last time stops at a warning;
//   * connect by address keeps the port that was typed and says what went wrong in words;
//   * none of it says "daemon", "token", "address" ... outside the Advanced screen, in the RENDERED text;
//   * none of it connects: no gateway saved, no credential stored, and the computers were asked only for
//     their hello.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:onboarding-path-b
//
// SAFE BY CONSTRUCTION (see onboarding-discovery-probe.mjs): the stub is on an EPHEMERAL port of 127.0.0.1
// (BEACON_DISCOVERY_PORT, honoured only by a non-release build), never 8005; Bonjour is on dns-sd's
// LOCAL-ONLY interface, so nothing leaves the machine and no Local Network prompt appears;
// BEACON_DISCOVERY_SOURCES is set in every launch; shell.openExternal is replaced before it is clicked.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep, sql } from './app-driver.mjs'
import { keptCount } from './lib/profile-db.mjs'
import { FP_A, advertise, dnssdChildren, helloGets, helloStub, makeFakes, noCreds, stopAdvertisers, stopStub } from './lib/discovery-fixtures.mjs'
import { bannedHits, clickText, pageText, press, startChecks, waitFor } from './lib/probe-kit.mjs'

const check = startChecks('onboarding-path-b', 75)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
const WINDOW_MS = 2500
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const ORIG_PATH = process.env.PATH
const root = mkdtempSync(join(tmpdir(), 'beacon-pathb-probe-'))
const fakes = makeFakes(root)
const freshProfile = () => mkdtempSync(join(root, 'profile-'))
const deadPort = await new Promise((res) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => res(p))
  })
})
const stub = await helloStub()

const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
async function launch(extra, profile = freshProfile()) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY')) delete process.env[k]
  process.env.PATH = ORIG_PATH
  process.env.BEACON_ONBOARDING = 'v4'
  Object.assign(process.env, { BEACON_DISCOVERY_PORT: String(stub.port), BEACON_DISCOVERY_WINDOW_MS: String(WINDOW_MS) }, extra)
  const app = await launchApp({ profile, readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
  return { app, profile }
}
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? 'none'`)
const onScreen = (app, id, ms = 6000) => waitFor(() => screenId(app), (v) => v === id, ms)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const screenText = (app) => pageText(app, '[data-screen]')
const radios = (app) => app.page.evaluate(`[...document.querySelectorAll('[data-screen] [role="radio"]')].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), on: r.getAttribute('aria-checked') === 'true' }))`)
const button = (app, text) =>
  app.page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}) && x.offsetParent !== null); return b ? { disabled: b.disabled } : null })()`)
const hasButton = async (app, text) => (await button(app, text)) !== null
// An empty or stand-in screen contains no banned word, so this also demands the screen's own title: on the
// build before this change the "Not built yet" stand-in passed every one of these.
// "Or type its address" is the way into Advanced (COPY.advanced.orType), held to Advanced's words like the screen it opens: not read here.
const noJargon = async (app, label, title) => {
  const text = await app.page.evaluate(`(() => { const r = document.querySelector('[data-screen]')?.cloneNode(true); if (!r) return ''; r.querySelectorAll('[data-or-type]').forEach((e) => e.remove()); return r.innerText })()`)
  const hits = bannedHits(text, WORDS)
  const t = await h1(app)
  check(text.length > 60 && t.startsWith(title) && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : t.startsWith(title) ? `${text.length} characters checked` : `title is "${t}", not "${title}"`)
}
/** Welcome → the question → a search → Continue; through B1 if it is showing. Returns where it landed. The search is "connect to
 *  it" when nothing answered on this Mac, and "look for another computer" when something did (then "connect to it" is that one). */
async function toSearch(app) {
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await sleep(300)
  const offered = (await radios(app)).some((r) => r.text.startsWith('Look for another computer'))
  await clickText(app, offered ? 'Look for another computer' : 'Yes, connect to it')
  await clickText(app, 'Continue')
  return waitFor(() => screenId(app), (v) => v !== 'W2', 4000)
}
const throughB1 = async (app) => {
  if ((await screenId(app)) === 'B1') await clickText(app, 'Continue')
}

let app
try {
  // ── P1: W2 follows what was found on this Mac ────────────────────────────────────────────────
  console.log('\n[probe] === P1: the question follows what answered on this Mac ===')
  const dead = await launch({ BEACON_DISCOVERY_SOURCES: 'loopback', BEACON_DISCOVERY_PORT: String(deadPort) })
  app = dead.app
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await sleep(1500)
  let rs = await radios(app)
  check(rs.length === 3 && rs[0].on && rs[0].text.includes('Recommended') && !rs[1].text.includes('Recommended'), 'P1 with nothing on this Mac, "set it up here" is selected and Recommended, as before', JSON.stringify(rs.map((r) => [r.on, r.text.includes('Recommended')])))
  await app.quit()

  const p1 = await launch({ BEACON_DISCOVERY_SOURCES: 'loopback' })
  app = p1.app
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  // Found by title, not position: with a Prometheus found here the question also offers another computer and an address (P1b).
  const card = (r, title) => r.find((x) => x.text.startsWith(title))
  const moved = await waitFor(() => radios(app), (r) => card(r, 'Yes, connect to it')?.text.includes('Recommended'), 5000)
  check(card(moved, 'Yes, connect to it')?.text.includes('Recommended') && card(moved, 'Yes, connect to it').on && !card(moved, 'No, set it up on this Mac')?.text.includes('Recommended'), 'P1 a Prometheus that answers on this Mac moves "Recommended" and the selection to "connect to it"', JSON.stringify(moved.map((r) => [r.on, r.text.slice(0, 30)])))
  check(card(moved, 'Yes, connect to it')?.text.includes('We found Probe Mac mini running on this Mac.'), 'P1 …and the card names it', card(moved, 'Yes, connect to it')?.text)
  await noJargon(app, 'P1 the question with a Prometheus found', 'Do you already have Prometheus?')
  await clickText(app, 'No, set it up on this Mac')
  await sleep(600)
  rs = await radios(app)
  check(card(rs, 'No, set it up on this Mac')?.on && !card(rs, 'Yes, connect to it')?.on && card(rs, 'Yes, connect to it')?.text.includes('Recommended'), 'P1 a choice the person makes is kept; the tag stays with the recommendation', JSON.stringify(rs.map((r) => [r.on, r.text.includes('Recommended')])))
  check(helloGets(stub).length >= 1 && noCreds(stub) && stub.requests.length === helloGets(stub).length, 'P1 finding it sent one question, GET /api/hello, with no credential, and nothing else', `${stub.requests.length} requests`)

  // ── P1b (0.4.2): found here, the question still offers another computer and an address ─────────
  console.log('\n[probe] === P1b: found on this Mac, and still another computer or an address ===')
  rs = await radios(app)
  const titles = rs.map((r) => r.text)
  check(rs.length === 5 && titles[0].startsWith('Yes, connect to it') && titles[1].startsWith('Look for another computer') && titles[2].startsWith('Type its address') && titles.some((t) => t.startsWith('No, set it up on this Mac')) && titles.some((t) => t.startsWith("I'm just looking")), 'P1b with a Prometheus found on this Mac: connect to it, look for another computer, type its address, set it up here, just looking', JSON.stringify(titles.map((t) => t.slice(0, 32))))
  check((await clickText(app, 'Type its address')) === 'clicked' && (await clickText(app, 'Continue')) === 'clicked' && (await onScreen(app, 'B-adv')) === 'B-adv' && norm(await pageText(app, '[data-screen] input')) === '' && (await app.page.evaluate(`document.querySelector('[data-screen] input')?.placeholder ?? ''`)).startsWith('my-computer.local'), '"Type its address" + Continue opens connect by address (its example is generic)', await screenId(app))
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2' && (await radios(app)).find((r) => r.on)?.text.startsWith('Type its address'), 'P1b Back from there is the question, with that answer still chosen', JSON.stringify((await radios(app)).map((r) => r.on)))
  await clickText(app, 'Yes, connect to it')
  check((await clickText(app, 'Continue')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3' && (await h1(app)) === 'We found Probe Mac mini', 'P1b "Yes, connect to it" goes straight to the one found on this Mac', `${await screenId(app)}: ${await h1(app)}`)
  rs = await radios(app)
  await sleep(800)
  check(rs.length === 1 && rs[0].on && rs[0].text.startsWith('This Mac') && (await dnssdChildren()) === 0, 'P1b …one row, selected, and no network lookup ran (no Local Network prompt for a computer on this Mac)', JSON.stringify({ rows: rs.map((r) => r.text), lookups: await dnssdChildren() }))
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'P1b Back from it is the question')
  await clickText(app, 'Look for another computer')

  // ── P2: B1, then the list ────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P2: B1 explains first, then the search ===')
  await clickText(app, 'Continue')
  const onB1 = (await onScreen(app, 'B1')) === 'B1' && (await h1(app)) === 'Let Beacon look on your network'
  check(onB1, 'P2 the first time, "look for another computer" opens the Local Network explanation, not a search', `${await screenId(app)}: ${await h1(app)}`)
  check(onB1 && norm(await screenText(app)).includes("Looking doesn't connect you to anything") && norm(await screenText(app)).includes('Choose Allow'), 'P2 …saying what Beacon is about to ask, and that looking connects nothing')
  await noJargon(app, 'P2 B1', 'Let Beacon look on your network')
  check(onB1 && (await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'P2 Back from B1 is the question')
  await clickText(app, 'Continue')
  await onScreen(app, 'B1')
  check((await clickText(app, 'Continue')) === 'clicked', 'P2 Continue on B1 is clickable')
  check((await onScreen(app, 'B3')) === 'B3', 'P2 …and the search finds the Prometheus on this Mac', await screenId(app))
  check((await h1(app)) === 'We found Probe Mac mini', 'P2 one result: the title names it', await h1(app))
  rs = await radios(app)
  check(rs.length === 1 && rs[0].on && rs[0].text.startsWith('This Mac') && rs[0].text.includes('running here') && rs[0].text.includes('"Atlas"'), 'P2 …the one row is selected for you: "This Mac · running here · "Atlas""', rs[0]?.text)
  check((await button(app, 'Connect'))?.disabled === false, 'P2 Connect is enabled')
  await noJargon(app, 'P2 B3 (one result)', 'We found Probe Mac mini')
  check((await clickText(app, 'Connect')) === 'clicked' && (await onScreen(app, 'B4')) === 'B4', 'P2 Connect goes on to the wait for approval (B4)', await screenId(app))
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'P2 Back from there is the list')
  await press(app, 'Escape')
  check((await onScreen(app, 'W2')) === 'W2', 'P2 Esc from the list is the question')
  await app.quit()
  app = (await launch({ BEACON_DISCOVERY_SOURCES: 'loopback' }, p1.profile)).app
  const landed = await toSearch(app)
  check(landed === 'B2' || landed === 'B3', 'P2 on the next launch the explanation is not shown again', landed)
  await app.quit()

  // ── P3: several computers, found on the home network ─────────────────────────────────────────
  console.log('\n[probe] === P3: several results, none selected ===')
  advertise(['-R', 'Probe Mac', '_prometheus._tcp', 'local', String(stub.port), 'v=0.9.6', 'name=Probe Mac mini', 'agent=Atlas', `fp=${FP_A}`, 'pair=approve'])
  // Discovery shows only what answers hello (docs/MULTI-COMPUTER-v0.4.md §4): each advertised computer has a live hello behind it.
  // A computer on the home network speaks TLS (#721): a plain one there cannot be joined (src/shared/plain-lan.ts), so it is not a row.
  const officeStub = await helloStub({ tls: true })
  officeStub.hello = { v: '0.9.6', name: 'Probe Office', agent: 'Zed', fp: officeStub.fp, pair: 'code', tls: true }
  // Both answer after the same short wait, so they arrive together (a TLS hello is a little slower than a plain one, and the first of
  // two to arrive alone would be selected for you).
  officeStub.delayMs = 400
  stub.delayMs = 400
  advertise(['-P', 'Probe Office', '_prometheus._tcp', 'local', String(officeStub.port), 'probe-office.local', '127.0.0.1', 'v=0.9.6', 'name=Probe Office', 'agent=Zed', `fp=${officeStub.fp}`, 'pair=code', 'tls=1'])
  await sleep(1500)
  const p3 = await launch({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' })
  app = p3.app
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await sleep(1200)
  check((await screenId(app)) === 'W2' && (await dnssdChildren()) === 0, 'P3 while Welcome and the question are showing, no network lookup is running (so nothing could raise the permission prompt before B1 explains it)')
  await clickText(app, 'Yes, connect to it')
  await clickText(app, 'Continue')
  await waitFor(() => screenId(app), (v) => v !== 'W2', 4000)
  await sleep(1000)
  check((await screenId(app)) === 'B1' && (await dnssdChildren()) === 0, 'P3 …nor while B1 is explaining why Beacon wants to look')
  await throughB1(app)
  check((await onScreen(app, 'B3')) === 'B3', 'P3 two advertised computers lead to the list', await screenId(app))
  check((await h1(app)) === 'Choose your Prometheus', 'P3 …titled "Choose your Prometheus"', await h1(app))
  rs = await radios(app)
  check(rs.length === 2 && rs.every((r) => !r.on), 'P3 with several, nothing is selected for you', JSON.stringify(rs.map((r) => r.on)))
  check((await button(app, 'Connect'))?.disabled === true, 'P3 …and Connect waits until a row is chosen')
  const office = rs.find((r) => r.text.startsWith('Probe Office'))
  check(!!office && office.text.includes('on your home network') && office.text.includes('"Zed"') && rs.some((r) => r.text.startsWith('This Mac')), 'P3 rows say where each is: "Probe Office · on your home network · "Zed"", and "This Mac" for the one on this Mac', JSON.stringify(rs.map((r) => r.text)))
  await noJargon(app, 'P3 B3 (several)', 'Choose your Prometheus')
  check((await clickText(app, 'Probe Office')) === 'clicked' && (await button(app, 'Connect'))?.disabled === false, 'P3 a real click on a row selects it and enables Connect')
  check((await clickText(app, "Don't see it?")) === 'clicked' && (await onScreen(app, 'B-empty')) === 'B-empty', 'P3 "Don\'t see it?" is the reasons screen', await screenId(app))
  const reasons = norm(await screenText(app))
  check(reasons.includes('asleep or turned off') && reasons.includes('different Wi-Fi network') && !reasons.includes("isn't allowed"), 'P3 …with the usual reasons, and no claim about permission (nothing was refused)')
  await noJargon(app, 'P3 B-empty', "We couldn't find Prometheus")
  check((await h1(app)) === "We couldn't find Prometheus" && !(await hasButton(app, 'Open Settings')), 'P3 …and no Open Settings button')
  const lookClick = await clickText(app, 'Look again')
  const during = await waitFor(dnssdChildren, (n) => n >= 1, 2000)
  check(lookClick === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'P3 "Look again" searches again and finds them', await screenId(app))
  await clickText(app, 'Back')
  await onScreen(app, 'W2')
  const gone = await waitFor(dnssdChildren, (n) => n === 0, 4000)
  check(during >= 1 && gone === 0, 'P3 a running search owns a lookup process, and leaving the list stops it', `${during} then ${gone}`)
  await app.quit()
  stub.delayMs = 0
  await stopStub(officeStub)

  // ── P4: nothing found, and then something appears ────────────────────────────────────────────
  console.log('\n[probe] === P4: nothing found, then look again ===')
  stopAdvertisers()
  await sleep(800)
  const p4 = await launch({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' })
  app = p4.app
  await toSearch(app)
  await throughB1(app)
  check((await onScreen(app, 'B-empty', 9000)) === 'B-empty', 'P4 a search that finds nothing ends on "We couldn\'t find Prometheus", not a blank wait', await screenId(app))
  check((await h1(app)) === "We couldn't find Prometheus" && !(await hasButton(app, 'Open Settings')), 'P4 …without a permission claim')
  const orType = await app.page.evaluate(`document.querySelector('[data-reason="none"] [data-or-type]')?.innerText ?? ''`)
  check(/type its address/i.test(orType), 'P4 …and offers to type its address', orType)
  check((await clickText(app, orType.trim())) === 'clicked' && (await onScreen(app, 'B-adv')) === 'B-adv', 'P4 …which opens connect by address', await screenId(app))
  await clickText(app, 'Back')
  await onScreen(app, 'B-empty')
  check((await clickText(app, 'Set it up on this Mac instead')) === 'clicked' && (await onScreen(app, 'A1')) === 'A1', 'P4 "Set it up on this Mac instead" goes to path A')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'B-empty')) === 'B-empty', 'P4 …and Back returns to the reasons')
  const lateStub = await helloStub()
  lateStub.hello = { v: '0.9.6', name: 'Probe Late', agent: 'Nova', fp: '0000000000000007', pair: 'approve' }
  advertise(['-R', 'Probe Late', '_prometheus._tcp', 'local', String(lateStub.port), 'v=0.9.6', 'name=Probe Late', 'agent=Nova', 'fp=0000000000000007', 'pair=approve'])
  await sleep(800)
  await clickText(app, 'Look again')
  const late = await waitFor(() => radios(app), (r) => r.some((x) => x.text.includes('"Nova"')), 9000)
  check((await screenId(app)) === 'B3' && late.some((r) => r.text.includes('"Nova"')), 'P4 a computer that appears after the first search is found by "Look again"', `${await screenId(app)}: ${JSON.stringify(late.map((r) => r.text))}`)
  await app.quit()
  await stopStub(lateStub)
  stopAdvertisers()

  // ── P5: macOS refused ────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P5: permission denied ===')
  const p5 = await launch({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_DNSSD: fakes.deniedDnsSd })
  app = p5.app
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  const windowsBefore = await app.mainEval(`__electron.BrowserWindow.getAllWindows().length`)
  await toSearch(app)
  await throughB1(app)
  check((await onScreen(app, 'B-empty', 9000)) === 'B-empty', 'P5 a refusal ends the search on the reasons screen', await screenId(app))
  const deniedLine = await app.page.evaluate(`document.querySelector('[data-reason="denied"]')?.innerText ?? ''`)
  check(norm(deniedLine).length > 0 && (await h1(app)) === "Beacon isn't allowed to look on your network" && /System Settings/.test(norm(deniedLine)) && /Privacy & Security/.test(norm(deniedLine)) && /Local Network/.test(norm(deniedLine)) && /turn on Beacon/.test(norm(deniedLine)), 'P5 …which says Beacon is not allowed to look, and how to allow it (System Settings, Privacy & Security, Local Network, turn on Beacon)', `${await h1(app)} | ${deniedLine}`)
  await noJargon(app, 'P5 B-empty (denied)', "Beacon isn't allowed to look on your network")
  check((await clickText(app, 'Open Settings')) === 'clicked', 'P5 Open Settings is clickable')
  const opened = await waitFor(() => app.mainEval(`globalThis.__opened`), (v) => Array.isArray(v) && v.length > 0, 3000)
  check(JSON.stringify(opened) === JSON.stringify([SETTINGS_URL]), 'P5 …and opens exactly the Local Network pane of System Settings', JSON.stringify(opened))
  check(opened?.length === 1 && (await app.mainEval(`__electron.BrowserWindow.getAllWindows().length`)) === windowsBefore, 'P5 …without making a window of its own')
  await app.quit()

  // ── P8: found, but it needs an update ──────────────────────────────────────────────────────────
  console.log('\n[probe] === P8: only a Prometheus that needs an update ===')
  stopAdvertisers()
  const oldStub = await helloStub()
  oldStub.hello = { v: '0.9.5', name: 'Probe Old Mini', agent: 'Nova', fp: '00000000000000c7', pair: 'approve' }
  advertise(['-P', 'Probe Old Mini', '_prometheus._tcp', 'local', String(oldStub.port), 'probe-old-mini.local', '127.0.0.1', 'v=0.9.5', 'name=Probe Old Mini', 'agent=Nova', 'fp=00000000000000c7', 'pair=approve'])
  await sleep(1500)
  const pOld = await launch({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' })
  app = pOld.app
  await toSearch(app)
  await throughB1(app)
  check((await onScreen(app, 'B-empty', 9000)) === 'B-empty' && helloGets(oldStub).length >= 1, 'P8 a search that found only a plain Prometheus on the home network ends on the reasons screen, not a list it cannot join', await screenId(app))
  const outdated = norm(await app.page.evaluate(`document.querySelector('[data-reason="outdated"]')?.innerText ?? ''`))
  check((await h1(app)).includes('Probe Old Mini') && outdated.includes('Update Prometheus on that computer and turn on home network'), 'P8 …naming it, and saying: update Prometheus on that computer and turn on home network', `${await h1(app)} | ${outdated}`)
  await app.quit()
  stopAdvertisers()
  await stopStub(oldStub)

  // ── P6: connect by address ───────────────────────────────────────────────────────────────────
  console.log('\n[probe] === P6: connect by address (Advanced) ===')
  const p6 = await launch({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' })
  app = p6.app
  await toSearch(app)
  await throughB1(app)
  await onScreen(app, 'B-empty', 9000)
  check((await clickText(app, 'Advanced')) === 'clicked' && (await onScreen(app, 'B-adv')) === 'B-adv' && (await h1(app)) === 'Connect by address', 'P6 an "Advanced" link leads to connect by address (the technical words live behind it)', await screenId(app))
  const type = async (text) => {
    await app.page.evaluate(`(() => { const i = document.querySelector('[data-screen="B-adv"] input'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  }
  await type('not an address!')
  await clickText(app, 'Find it')
  check(norm(await screenText(app)).includes("doesn't look like a computer name or address"), 'P6 something that is not an address is told so, in words')
  const asked = stub.requests.length
  await type(`127.0.0.1:${deadPort}`)
  await clickText(app, 'Find it')
  const unreach = await waitFor(() => screenText(app), (t) => norm(t).includes('Nothing answered there'), 4000)
  check(norm(unreach).includes('Nothing answered there') && (await screenId(app)) === 'B-adv', 'P6 nothing listening there says so, and stays on the screen')
  stub.mode = 'text'
  await type(`127.0.0.1:${stub.port}`)
  await clickText(app, 'Find it')
  const notP = await waitFor(() => screenText(app), (t) => norm(t).includes("isn't a Prometheus"), 4000)
  check(norm(notP).includes("isn't a Prometheus"), 'P6 something that answers but is not a Prometheus says so')
  stub.mode = 'ok'
  await type(`127.0.0.1:${stub.port}`)
  await clickText(app, 'Find it')
  check((await onScreen(app, 'B3')) === 'B3', 'P6 a typed address that answers leads to the list', await screenId(app))
  rs = await radios(app)
  check(rs.length === 1 && rs[0].on && rs[0].text.includes(`at 127.0.0.1:${stub.port}`), 'P6 …one row, selected, showing the port that was TYPED (never silently 8005)', rs[0]?.text)
  check(stub.requests.length > asked && noCreds(stub), 'P6 typing an address cost credential-free hello requests only')
  check(rs.length === 1 && (await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'P6 Back from that list is the question')
  await app.quit()

  // ── P7: a computer that does not look like last time ─────────────────────────────────────────
  console.log('\n[probe] === P7: this looks different from last time ===')
  const p7 = await launch({ BEACON_DISCOVERY_SOURCES: 'loopback' })
  app = p7.app
  await app.page.evaluate(`window.beacon.settings.set('onboarding:known-computers', JSON.stringify({ 'Probe Mac mini': 'ffffffffffffffff' }))`)
  check((await app.page.evaluate(`window.beacon.settings.get('onboarding:known-computers')`)).includes('ffffffffffffffff'), 'P7 this Mac knows a computer of that name by another fingerprint (precondition)')
  await app.quit()
  app = (await launch({ BEACON_DISCOVERY_SOURCES: 'loopback' }, p7.profile)).app
  await toSearch(app)
  await throughB1(app)
  await onScreen(app, 'B3')
  rs = await radios(app)
  check(rs.length === 1 && rs[0].text.includes('This looks different from last time'), 'P7 the row carries "This looks different from last time"', rs[0]?.text)
  await clickText(app, 'Connect')
  check((await onScreen(app, 'B-differs')) === 'B-differs', 'P7 Connect stops at a warning instead of going on', await screenId(app))
  const warn = norm(await screenText(app))
  check(warn.includes("Probe Mac mini isn't the same computer this Mac connected to before") && warn.includes("don't continue"), 'P7 …that names the computer and says not to go on if Prometheus was not reinstalled there')
  await noJargon(app, 'P7 B-differs', 'This looks different from last time')
  check((await clickText(app, 'Go back')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'P7 "Go back" returns to the list')
  await clickText(app, 'Connect')
  await onScreen(app, 'B-differs')
  check((await clickText(app, "It's fine, continue")) === 'clicked' && (await onScreen(app, 'B4')) === 'B4', 'P7 "It\'s fine, continue" goes on, because Prometheus can really have been reinstalled')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'B3')) === 'B3', 'P7 Back from there skips the warning')

  // ── P8: through all of it, nothing connected ─────────────────────────────────────────────────
  console.log('\n[probe] === P8: finding it never connected ===')
  const outside = await app.page.evaluate(`performance.getEntriesByType('resource').filter((e) => !e.name.startsWith('file:')).map((e) => e.name)`)
  check((await screenId(app)) === 'B3' && outside.length === 0, 'P8 the screens asked nothing of the network themselves (only main asked, through discovery)', JSON.stringify(outside))
  const profiles = [dead.profile, p1.profile, p3.profile, p4.profile, p5.profile, p6.profile, p7.profile]
  await app.quit()
  check(helloGets(stub).length > 0 && profiles.every((p) => keptCount(p) === 0 && !existsSync(join(p, 'api-credential.bin'))), 'P8 after every walk above, no address was saved and no credential stored, in any of the profiles', `${profiles.length} profiles`)
  // B4 is a real screen now: opening it asks the computer once (POST /api/pair/requests, no credential), here twice (P2 and P7).
  const asks = stub.requests.filter((q) => q.method === 'POST' && q.url === '/api/pair/requests')
  check(helloGets(stub).length > 0 && noCreds(stub) && asks.length === 2 && asks.every((q) => !('authorization' in q.headers) && !('cookie' in q.headers) && !('origin' in q.headers)) && stub.requests.length === helloGets(stub).length + asks.length, 'P8 and the stub saw only GET /api/hello and one credential-free ask (POST /api/pair/requests) for each of the two times the wait for approval opened', `${helloGets(stub).length} hellos, ${asks.length} asks, ${stub.requests.length} requests`)
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  await stopStub(stub)
  stopAdvertisers()
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
