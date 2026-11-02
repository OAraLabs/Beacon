#!/usr/bin/env node
// onboarding-welcome-probe — the first three screens of the v0.4.0 onboarding (Welcome, "Do you
// already have Prometheus?", "Just looking") and the empty home "Not now" leaves behind, IN THE REAL
// APP, with real clicks and key presses.
//
// What it guards: someone who has never used a terminal opens Beacon for the first time. 0.3.0 greeted
// them with "daemon", "gateway", "API token" and a port number. These screens must (a) say none of the
// banned words IN THE RENDERED TEXT, not just in a strings file, (b) offer three plain choices with one
// preselected and recommended, (c) let "just looking" end somewhere that is not a dead end, and
// remember it across a relaunch, and (d) be THE first run: since the go-live (ONBOARDING_V4_LIVE,
// src/shared/onboarding-gate.ts) an empty profile opens it with no flag at all. The flag no longer opens or closes anything; S2-S7
// still set it, which changes nothing, and S1 proves the default.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:onboarding-welcome
//
// SAFE BY CONSTRUCTION:
//   * every launch uses a FRESH EMPTY profile (--user-data-dir in tmp) and --use-mock-keychain
//     (app-driver.mjs), so nothing here can touch the user's Beacon or Keychain;
//   * no Prometheus is involved: a fresh profile has no saved connection, so the app never dials one,
//     and S4 asserts the whole walk made no network request. BEACON_GATEWAY_* are removed (they bypass
//     setup). That is why it needs no port guard, and why another session's daemon on 8005 is no concern.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { bannedHits, clickText, pageText, press, startChecks, waitFor } from './lib/probe-kit.mjs'

const check = startChecks('onboarding-welcome', 51)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const GUIDE = 'https://github.com/OAraLabs/Beacon/blob/main/docs/SETUP.md'
const SITE = 'https://oara.ai/beacon'

for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const READY = '.wiz-card, [data-screen], nav[aria-label="Views"]'
const freshProfile = () => mkdtempSync(join(tmpdir(), 'beacon-onboarding-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
/** A loopback port nothing listens on. */
const deadPort = () => new Promise((res) => { const sv = createServer(); sv.listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => res(port)) }) })
const launch = (profile, v4 = true) => {
  if (v4) process.env.BEACON_ONBOARDING = 'v4'
  else delete process.env.BEACON_ONBOARDING
  return launchApp({ profile, readySelector: READY })
}
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? (document.querySelector('.wiz-card') ? 'legacy' : document.querySelector('nav[aria-label="Views"]') ? 'app' : 'none')`)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const buttonStarting = (app, text) =>
  app.page.evaluate(`[...document.querySelectorAll('button, a[href]')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && b.offsetParent !== null)`)
const radios = (app) =>
  app.page.evaluate(`[...document.querySelectorAll('[data-screen] [role="radio"]')].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), on: r.getAttribute('aria-checked') === 'true' }))`)
const linkHref = (app, text) =>
  app.page.evaluate(`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)})); return a ? { href: a.href, target: a.target } : null })()`)
const onScreen = (app, id) => waitFor(() => screenId(app), (v) => v === id, 5000)
const screenText = (app) => pageText(app, '[data-screen]')
// An empty string contains no banned word, so this also demands the screen is really there: an id,
// and enough text to be a screen. Without that it passed on the 0.3.0 build, where no such screen exists.
const noJargon = async (app, label) => {
  const text = await screenText(app)
  const hits = bannedHits(text, WORDS)
  check(text.length > 60 && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : text.length > 60 ? `${WORDS.length} words checked in ${text.length} characters` : `no screen text (${text.length} characters)`)
}

let app
try {
  // ── S1: the new first run is the default ─────────────────────────────────────────────────────
  console.log('\n[probe] === S1: without BEACON_ONBOARDING the new first run opens ===')
  app = await launch(freshProfile(), false)
  check((await onScreen(app, 'W1')) === 'W1', 'S1 an empty profile, with no flag, opens the new first run at Welcome', await screenId(app))
  check((await h1(app)) === 'Welcome to Beacon' && !(await app.page.evaluate(`!!document.querySelector('.wiz-card')`)), 'S1 …"Welcome to Beacon", not the old wizard', await h1(app))
  await app.quit()

  // ── S2: Welcome ──────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === S2: Welcome ===')
  const P1 = freshProfile()
  app = await launch(P1)
  check((await onScreen(app, 'W1')) === 'W1', 'S2 an empty profile with the flag opens the Welcome screen', await screenId(app))
  check((await h1(app)) === 'Welcome to Beacon', 'S2 title is "Welcome to Beacon"', await h1(app))
  const w1 = norm(await screenText(app))
  check(w1.includes("Prometheus is your assistant's brain"), "S2 it says what Prometheus is, in one line")
  check(w1.includes('about five minutes'), 'S2 it says how long this takes')
  check(await buttonStarting(app, 'Get started'), 'S2 there is a "Get started" button')
  check((await screenId(app)) === 'W1' && !(await buttonStarting(app, 'Back')), 'S2 there is no Back on the first screen (and it is the first screen)')
  const guide = await linkHref(app, 'Read the setup guide')
  check(guide?.href === GUIDE && guide?.target === '_blank', 'S2 "Read the setup guide" is a link that opens in the browser', JSON.stringify(guide))
  check((await screenId(app)) === 'W1' && !(await app.page.evaluate(`!!document.querySelector('.wiz-rail')`)), 'S2 the old 8-step rail is not on this screen (and this is Welcome)')
  await noJargon(app, 'S2 Welcome')

  // ── S3: Do you already have Prometheus? ──────────────────────────────────────────────────────
  console.log('\n[probe] === S3: W2, three choices ===')
  check((await clickText(app, 'Get started')) === 'clicked', 'S3 "Get started" is clickable (real click)')
  check((await onScreen(app, 'W2')) === 'W2', 'S3 it opens the question screen', await screenId(app))
  check((await h1(app)) === 'Do you already have Prometheus?', 'S3 title is the question', await h1(app))
  let rs = await radios(app)
  check(rs.length === 3, 'S3 there are exactly three choices', String(rs.length))
  check(rs.filter((r) => r.on).length === 1, 'S3 exactly one is preselected', JSON.stringify(rs.map((r) => r.on)))
  check(rs[0]?.on === true && rs[0].text.startsWith('No, set it up on this Mac') && rs[0].text.includes('Recommended'), 'S3 the preselected one is "set it up on this Mac", tagged Recommended', rs[0]?.text)
  check(rs[1]?.text.startsWith('Yes, connect to it') && rs[2]?.text.startsWith("I'm just looking"), 'S3 the other two are "connect to it" and "just looking"', JSON.stringify(rs.slice(1).map((r) => r.text.slice(0, 24))))
  check((await buttonStarting(app, 'Continue')) === true, 'S3 there is a Continue')
  await noJargon(app, 'S3 W2')
  check((await clickText(app, "Yes, connect to it")) === 'clicked', 'S3 a real click picks "connect to it"')
  rs = await radios(app)
  check(rs[1]?.on === true && rs.filter((r) => r.on).length === 1, 'S3 …and only that one is selected now')
  check(rs[0]?.text.includes('Recommended') && !rs[1]?.text.includes('Recommended'), 'S3 …the Recommended tag stays on the first (a recommendation is not a selection)')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W1')) === 'W1', 'S3 Back returns to Welcome')
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await press(app, 'Escape')
  check((await onScreen(app, 'W1')) === 'W1', 'S3 Esc also goes back')

  // ── S4: Just looking ─────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === S4: C1, the tour ===')
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await clickText(app, "I'm just looking")
  check((await clickText(app, 'Continue')) === 'clicked', 'S4 Continue is clickable on "just looking"')
  check((await onScreen(app, 'C1')) === 'C1', 'S4 it opens the tour', await screenId(app))
  check((await h1(app)) === "Here's what Beacon does", 'S4 title is "Here\'s what Beacon does"', await h1(app))
  const c1 = norm(await screenText(app))
  check(['Chat with your assistant', 'Watch it work', 'You stay in charge'].every((t) => c1.includes(t)), 'S4 it shows the three cards')
  const site = await linkHref(app, 'Visit the website')
  check(site?.href === SITE && site?.target === '_blank', 'S4 "Visit the website" opens oara.ai/beacon in the browser', JSON.stringify(site))
  check((await buttonStarting(app, 'Set it up')) && (await buttonStarting(app, 'Not now')) && (await buttonStarting(app, 'Back')), 'S4 it offers Set it up, Not now and Back')
  await noJargon(app, 'S4 C1')
  await clickText(app, 'Back')
  await onScreen(app, 'W2')
  rs = await radios(app)
  check(rs[2]?.on === true, 'S4 Back to the question keeps "just looking" selected', JSON.stringify(rs.map((r) => r.on)))
  await clickText(app, 'Continue')
  await onScreen(app, 'C1')
  check((await clickText(app, 'Set it up')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'S4 "Set it up" goes to the question')
  const outside = await app.page.evaluate(`performance.getEntriesByType('resource').filter((e) => !e.name.startsWith('file:')).map((e) => e.name)`)
  check((await screenId(app)) === 'W2' && outside.length === 0, 'S4 the whole walk (Welcome → question → tour → question) asked nothing of the network', `on ${await screenId(app)}; ${JSON.stringify(outside)}`)

  // ── S5: Not now ──────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === S5: Not now leaves an empty home, and remembers ===')
  await clickText(app, "I'm just looking")
  await clickText(app, 'Continue')
  await onScreen(app, 'C1')
  check((await clickText(app, 'Not now')) === 'clicked', 'S5 "Not now" is clickable')
  check((await onScreen(app, 'UNCONNECTED')) === 'UNCONNECTED', 'S5 it lands on the empty home, not a blank window', await screenId(app))
  check((await h1(app)) === "Beacon isn't connected yet", 'S5 title is "Beacon isn\'t connected yet"', await h1(app))
  check(await buttonStarting(app, 'Set it up'), 'S5 there is a way back in: "Set it up"')
  check(await app.page.evaluate(`!!document.querySelector('.app-chrome')`), 'S5 the window keeps its normal title bar')
  await noJargon(app, 'S5 empty home')
  await app.quit()
  app = await launch(P1)
  check((await onScreen(app, 'UNCONNECTED')) === 'UNCONNECTED', 'S5 after a relaunch it is still the empty home (a "just looking" person is not greeted again)', await screenId(app))
  check((await clickText(app, 'Set it up')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'S5 "Set it up" goes to the question')
  await app.quit()
  app = await launch(P1)
  check((await onScreen(app, 'W1')) === 'W1', 'S5 once they chose to set up, a relaunch starts at Welcome', await screenId(app))

  // ── S6: "set it up on this Mac" ends at its one confirmation, and nothing is done before it ──────────────
  // Every screen is built now (PENDING_SCREENS is empty): the step after A-confirm is the real installer (A-inst), which downloads
  // Prometheus, puts it in Applications and starts it. So this probe never presses "Set up Prometheus". It checks that the path
  // reaches A-confirm, that A-confirm is the real confirmation (not a stand-in), and that Back leaves it. Tripwires in case a
  // press slips through: the installer's release is a loopback port nothing listens on, its home a scratch folder that must stay
  // empty. The look at this Mac is deterministic: the facts are given, and the port a Prometheus would answer on is one nothing
  // listens on, so another session's daemon on 8005 cannot turn the check into "already on this Mac".
  console.log('\n[probe] === S6: set it up on this Mac, up to the confirmation ===')
  await app.quit()
  const tripHome = mkdtempSync(join(tmpdir(), 'beacon-onboarding-probe-home-'))
  process.env.BEACON_DISCOVERY_SOURCES = 'loopback'
  process.env.BEACON_DISCOVERY_PORT = String(await deadPort())
  process.env.BEACON_MAC_CHECK = JSON.stringify({ platform: 'darwin', arch: 'arm64', macos: '15.6.1', freeBytes: 50e9, memoryBytes: 16e9 })
  process.env.BEACON_PROMETHEUS_RELEASE = `http://127.0.0.1:${await deadPort()}`
  process.env.BEACON_PROMETHEUS_HOME = tripHome
  app = await launch(P1)
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await clickText(app, 'Continue') // "set it up on this Mac" is preselected
  check((await onScreen(app, 'A-confirm', 8000)) === 'A-confirm', 'S6 "set it up on this Mac" is checked and leads to the one confirmation', await screenId(app))
  const confirmText = await screenText(app)
  check(
    (await h1(app)) === 'Set up Prometheus on this Mac' && confirmText.includes('Applications folder') && (await buttonStarting(app, 'Set up Prometheus')) && !confirmText.includes('Not built yet') && !(await buttonStarting(app, 'Use the old setup')),
    'S6 the confirmation is the real screen: it says what will happen, offers "Set up Prometheus", and is no stand-in',
    confirmText.slice(0, 200)
  )
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'S6 Back from the confirmation is the question again', await screenId(app))
  await clickText(app, 'Continue')
  check((await onScreen(app, 'A-confirm', 8000)) === 'A-confirm' && readdirSync(tripHome).length === 0, 'S6 …and back to the confirmation; nothing was downloaded or put anywhere before the button is pressed', JSON.stringify(readdirSync(tripHome)))
  rmSync(tripHome, { recursive: true, force: true })
  delete process.env.BEACON_PROMETHEUS_RELEASE
  delete process.env.BEACON_PROMETHEUS_HOME
  delete process.env.BEACON_MAC_CHECK
  delete process.env.BEACON_DISCOVERY_PORT
  delete process.env.BEACON_DISCOVERY_SOURCES
  await sleep(100)

  // ── S7: starting over is a new first run ────────────────────────────────────────────────────
  // Set up again (Settings) and Start over both go through setup.forget(). A "Not now" remembered from
  // the last first run must not decide where the next one opens.
  console.log('\n[probe] === S7: forgetting the connection forgets "Not now" ===')
  await app.quit()
  const P2 = freshProfile()
  app = await launch(P2)
  await onScreen(app, 'W1')
  await app.page.evaluate(`window.beacon.settings.set('onboarding:browsing', '1')`)
  const before = await app.page.evaluate(`window.beacon.settings.get('onboarding:browsing')`)
  check(before === '1', 'S7 "Not now" is remembered (precondition)', JSON.stringify(before))
  const forgot = await app.page.evaluate(`window.beacon.setup.forget()`)
  const after = await app.page.evaluate(`window.beacon.settings.get('onboarding:browsing')`)
  check(forgot?.ok === true && after !== '1', 'S7 forgetting the connection clears it', `forget ${JSON.stringify(forgot)}, key ${JSON.stringify(after)}`)
  await app.quit()
  app = await launch(P2)
  check((await onScreen(app, 'W1')) === 'W1', 'S7 …so the next first run opens at Welcome, not the empty home', await screenId(app))
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
