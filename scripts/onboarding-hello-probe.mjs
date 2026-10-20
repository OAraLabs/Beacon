#!/usr/bin/env node
// onboarding-hello-probe — "Say hello to your assistant" (F1), the end of both paths, IN THE REAL APP, on a
// connected stub Prometheus, with real clicks, real typing and real key presses.
//
// The first message is where someone finds out the whole thing works. This holds it to:
//   * what it shows: a prefilled first chip tagged Recommended, two more, a text field they can overwrite;
//   * what it does: ONE session as a real conversation (gateway "beacon", not the hidden "beacon-verify" one the
//     old wizard's smoke test used), the typed message, and no more than that;
//   * the first reply: shown, then "You're all set." and a way into the app, with no Back and no Esc out;
//   * the three ways it goes wrong, each in plain words with a button that fixes it: no answer in time
//     (keep waiting, or try again), the computer gone (reconnect), and Back before the reply;
//   * the copy rules, on the RENDERED text (the assistant's own reply excluded: it is not our copy);
//   * saying how another computer joins ONLY after the first reply.
//
// The connection is made the way the pairing step will make it: setup.save with the PORTS the computer was found
// on (a typed or discovered port is never silently replaced by 8005). The probe reaches the first message the way a dev build
// can: through the confirmation on "set it up on this Mac" to setting it up, which has a dev-only "Skip to the first message"
// while onboarding is not live. Setting it up starts and stops at once: its release is a loopback port where nothing listens
// (BEACON_PROMETHEUS_RELEASE, non-release only), its home a scratch folder, its launcher /usr/bin/false. (Approval, B4, and
// setting it up have their own probes, against a real daemon and the real Prometheus.app.)
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:onboarding-hello
//
// SAFE BY CONSTRUCTION: the stub daemon is on EPHEMERAL loopback ports (never 8005/8010), so another session's
// daemon is untouched; no credential is stored (the stub needs none); a fresh profile and --use-mock-keychain per
// launch; BEACON_DISCOVERY_SOURCES=loopback means no Bonjour and no network scan. PROBE_HOST exists for one
// reason: a red run against a build that predates port support must not be able to reach 8005, so it is run
// with PROBE_HOST=127.0.0.2, where nothing listens.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { bannedHits, clickText, pageText, press, startChecks, textWithout, typeInto, waitFor } from './lib/probe-kit.mjs'
import { stubDaemon } from './lib/stub-daemon.mjs'
import { createServer } from 'node:net'

const check = startChecks('onboarding-hello', 45)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const HOST = process.env.PROBE_HOST ?? '127.0.0.1'
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const root = mkdtempSync(join(tmpdir(), 'beacon-hello-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const d = await stubDaemon()
const CLOSED = await new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

async function launch(extra = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY') || k.startsWith('BEACON_PROMETHEUS') || k === 'BEACON_HELLO_TIMEOUT_MS') delete process.env[k]
  Object.assign(process.env, { BEACON_PROMETHEUS_RELEASE: `http://127.0.0.1:${CLOSED}/rel`, BEACON_PROMETHEUS_HOME: join(root, 'home'), BEACON_PROMETHEUS_LAUNCHER: '/usr/bin/false' })
  process.env.BEACON_ONBOARDING = 'v4'
  Object.assign(process.env, { BEACON_DISCOVERY_SOURCES: 'loopback', BEACON_DISCOVERY_PORT: String(d.apiPort), BEACON_DISCOVERY_WINDOW_MS: '2500' }, extra)
  // The look at this Mac is given its facts (an Apple silicon Mac on a current macOS with room), and the stub answers nothing at
  // /api/hello, so the check does not take it for a Prometheus already on this Mac.
  d.profile = 'none'
  process.env.BEACON_MAC_CHECK = JSON.stringify({ platform: 'darwin', arch: 'arm64', macos: '15.6.1', freeBytes: 50e9, memoryBytes: 16e9 })
  return launchApp({ profile: mkdtempSync(join(root, 'profile-')), readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
}
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? (document.querySelector('nav[aria-label="Views"]') ? 'app' : 'none')`)
const onScreen = (app, id, ms = 6000) => waitFor(() => screenId(app), (v) => v === id, ms)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const screenText = async (app) => norm(await textWithout(app, '[data-screen]', '[data-untrusted]'))
const hasButton = (app, text) => app.page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && b.offsetParent !== null)`)
const buttonState = (app, text) => app.page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}) && x.offsetParent !== null); return b ? { disabled: b.disabled } : null })()`)
const inputValue = (app) => app.page.evaluate(`document.querySelector('[data-screen="F1"] input, [data-screen="F1"] textarea')?.value ?? null`)
const chips = (app) => app.page.evaluate(`[...document.querySelectorAll('[data-screen="F1"] [data-chip]')].map((c) => ({ text: c.innerText.replace(/\\s+/g, ' ').trim(), recommended: c.innerText.includes('Recommended') }))`)
// An empty or stand-in screen contains no banned word: demand the screen's own title, too.
async function noJargon(app, label, title) {
  const text = await screenText(app)
  const hits = bannedHits(text, WORDS)
  const t = await h1(app)
  check(text.length > 40 && t.startsWith(title) && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : t.startsWith(title) ? `${text.length} characters checked` : `title is "${t}", not "${title}"`)
}

/** Welcome → the question → "set it up on this Mac" → the confirmation → its stand-in. Then connect the way the set-up will (the
 *  ports it was found on), and skip ahead to the first message. */
async function toHello(app) {
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await clickText(app, 'No, set it up on this Mac')
  await clickText(app, 'Continue')
  await onScreen(app, 'A-confirm', 8000)
  await clickText(app, 'Set up Prometheus')
  await onScreen(app, 'A-inst')
  const saved = await app.page.evaluate(`window.beacon.setup.save({ address: ${JSON.stringify(HOST)}, apiPort: ${d.apiPort}, wsPort: ${d.wsPort} })`)
  const up = await waitFor(() => app.page.evaluate(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 10000)
  await clickText(app, 'Skip to the first message')
  return { saved, up }
}

let app
try {
  // ── H1: the happy path ───────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === H1: compose, send, the first reply ===')
  d.replyDelayMs = 1500
  app = await launch()
  const { saved, up } = await toHello(app)
  check(saved?.ok === true && up === 'connected', 'H1 the connection is made to the ports the computer was found on, not 8005', JSON.stringify({ saved, up }))
  check((await onScreen(app, 'F1')) === 'F1' && (await h1(app)) === 'Say hello to your assistant', 'H1 the first message screen opens', `${await screenId(app)}: ${await h1(app)}`)
  const compose = await screenText(app)
  check(compose.includes('Try this, or type your own.') && !/another computer|phone/i.test(compose), 'H1 it says what to do, and does not yet talk about other computers')
  check((await inputValue(app)) === 'What can you help me with?', 'H1 the field is prefilled with the first suggestion', await inputValue(app))
  const cs = await chips(app)
  check(cs.length === 3 && cs[0].text.startsWith('What can you help me with?') && cs[0].recommended && !cs[1].recommended && !cs[2].recommended, 'H1 three suggestions, the first tagged Recommended', JSON.stringify(cs))
  check(cs[1]?.text === 'Plan a simple dinner for tonight' && cs[2]?.text === "Explain something I've always wondered about", 'H1 the other two are the dinner and the curiosity suggestions', JSON.stringify(cs.slice(1)))
  await noJargon(app, 'H1 compose', 'Say hello to your assistant')
  check((await buttonState(app, 'Send'))?.disabled === false, 'H1 Send is enabled with a message in the field')
  check((await clickText(app, 'Plan a simple dinner for tonight')) === 'clicked' && (await inputValue(app)) === 'Plan a simple dinner for tonight', 'H1 a real click on a suggestion puts it in the field')
  check((await typeInto(app, '[data-screen="F1"] input, [data-screen="F1"] textarea', 'Hello there, who are you?')) === 'typed' && (await inputValue(app)) === 'Hello there, who are you?', 'H1 real typing replaces it with the person\'s own words', await inputValue(app))
  await typeInto(app, '[data-screen="F1"] input, [data-screen="F1"] textarea', '')
  check((await buttonState(app, 'Send'))?.disabled === true, 'H1 an empty field cannot be sent')
  await typeInto(app, '[data-screen="F1"] input, [data-screen="F1"] textarea', 'Hello there, who are you?')
  check((await clickText(app, 'Send')) === 'clicked', 'H1 Send is clickable')
  const waiting = await waitFor(() => screenText(app), (t) => t.includes('Thinking'), 2500)
  check(waiting.includes('Thinking') && (await buttonState(app, 'Send')) === null, 'H1 while it waits it says "Thinking…", and there is no second Send to press', waiting.slice(0, 80))
  const done = await waitFor(() => screenText(app), (t) => t.includes("You're all set."), 8000)
  check(done.includes("You're all set."), 'H1 the first reply ends in "You\'re all set."', done.slice(0, 120))
  const reply = norm(await pageText(app, '[data-screen="F1"] [data-untrusted]'))
  check(reply.includes("Hello! I'm Atlas. You said: Hello there, who are you?"), "H1 …showing what the assistant said, to the message that was sent", reply)
  check(done.includes('To use another computer too, open Beacon there. This Mac will ask you to approve it.') && !/Settings/.test(done), 'H1 only now does it say how another computer joins (open Beacon there; this Mac, where Prometheus runs, approves it), and it names no Settings')
  check(!(await hasButton(app, 'Back')) && (await hasButton(app, 'Start chatting')), 'H1 there is no Back after the reply, and a way into the app')
  await press(app, 'Escape')
  check((await screenId(app)) === 'F1', 'H1 Esc does not leave the finished screen')
  await noJargon(app, 'H1 the finished screen', "You're all set")
  check(d.created.length === 1 && d.created[0].gateway === 'beacon', 'H1 exactly one session was made, as a real conversation (gateway "beacon", not the hidden "beacon-verify")', JSON.stringify(d.created))
  check(d.sends.length === 1 && d.sends[0].message === 'Hello there, who are you?', 'H1 exactly one message was sent: the typed one', JSON.stringify(d.sends))
  check((await clickText(app, 'Start chatting')) === 'clicked' && (await onScreen(app, 'app', 10000)) === 'app', 'H1 Start chatting opens the app', await screenId(app))
  const outside = await app.page.evaluate(`performance.getEntriesByType('resource').filter((e) => !e.name.startsWith('file:')).map((e) => e.name)`)
  check((await screenId(app)) === 'app' && outside.length === 0, 'H1 the screens loaded nothing from the network themselves', JSON.stringify(outside))
  await app.quit()

  // ── H2: no answer in time ────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === H2: no answer yet ===')
  d.mode = 'never'
  d.sends.length = 0
  app = await launch({ BEACON_HELLO_TIMEOUT_MS: '2500' })
  await toHello(app)
  await onScreen(app, 'F1')
  await clickText(app, 'Send')
  const slow = await waitFor(() => screenText(app), (t) => t.includes('No answer yet.'), 8000)
  check(slow.includes('No answer yet.') && slow.includes('It may still be working.'), 'H2 a slow answer is "No answer yet. It may still be working."', slow.slice(0, 120))
  check((await hasButton(app, 'Keep waiting')) && (await hasButton(app, 'Try again')), 'H2 …with Keep waiting and Try again')
  await noJargon(app, 'H2 no answer yet', 'No answer yet')
  check((await clickText(app, 'Keep waiting')) === 'clicked' && (await waitFor(() => screenText(app), (t) => t.includes('Thinking'), 2000)).includes('Thinking'), 'H2 Keep waiting goes back to waiting')
  d.release()
  check((await waitFor(() => screenText(app), (t) => t.includes("You're all set."), 8000)).includes("You're all set."), 'H2 …and a late answer still arrives and finishes it')
  await app.quit()

  d.sends.length = 0
  d.created.length = 0
  app = await launch({ BEACON_HELLO_TIMEOUT_MS: '2500' })
  await toHello(app)
  await onScreen(app, 'F1')
  await clickText(app, 'Send')
  await waitFor(() => screenText(app), (t) => t.includes('No answer yet.'), 8000)
  check((await clickText(app, 'Try again')) === 'clicked', 'H2 Try again is clickable')
  await waitFor(() => d.sends.length, (n) => n >= 2, 4000)
  check(d.sends.length === 2 && d.created.length === 1 && d.sends[0].session === d.sends[1].session, 'H2 Try again sends the message again, in the SAME conversation', JSON.stringify({ sends: d.sends.length, created: d.created.length }))
  await app.quit()

  // ── H3: the computer went away ───────────────────────────────────────────────────────────────
  console.log('\n[probe] === H3: we lost touch ===')
  d.mode = 'reply'
  d.replyDelayMs = 300
  d.sends.length = 0
  d.created.length = 0
  app = await launch()
  await toHello(app)
  await onScreen(app, 'F1')
  await d.stop()
  await clickText(app, 'Send')
  const lost = await waitFor(() => screenText(app), (t) => t.includes('We lost touch with Prometheus.'), 12000)
  check(lost.includes('We lost touch with Prometheus.') && (await hasButton(app, 'Reconnect')), 'H3 a computer that has gone away is "We lost touch with Prometheus." with a Reconnect button', lost.slice(0, 120))
  await noJargon(app, 'H3 lost touch', 'We lost touch')
  check(lost.includes('We lost touch') && d.created.length === 0 && d.sends.length === 0, 'H3 nothing was created or sent while it was away')
  await d.start()
  await sleep(500)
  check((await clickText(app, 'Reconnect')) === 'clicked', 'H3 Reconnect is clickable')
  check((await waitFor(() => screenText(app), (t) => t.includes("You're all set."), 15000)).includes("You're all set."), 'H3 once it is back, Reconnect finishes the job')
  check(d.created.length === 1 && d.sends.length === 1, 'H3 …with one session and one message, not a pile of retries', JSON.stringify({ created: d.created.length, sends: d.sends.length }))
  await app.quit()

  // ── H4: Back before the reply ────────────────────────────────────────────────────────────────
  console.log('\n[probe] === H4: Back while waiting ===')
  d.mode = 'never'
  app = await launch()
  await toHello(app)
  await onScreen(app, 'F1')
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'A-inst')) === 'A-inst', 'H4 before a message is sent, Back is the previous step', await screenId(app))
  await clickText(app, 'Skip to the first message')
  await onScreen(app, 'F1')
  await clickText(app, 'Send')
  await waitFor(() => screenText(app), (t) => t.includes('Thinking'), 2500)
  check((await clickText(app, 'Back')) === 'clicked' && (await onScreen(app, 'A-inst')) === 'A-inst', 'H4 while waiting, Back is still the previous step')
  const polls = d.count(`/api/sessions/s${d.sessions.size}/messages`)
  await sleep(3000)
  check(d.sends.length >= 1 && d.count(`/api/sessions/s${d.sessions.size}/messages`) === polls, 'H4 …and the waiting stops: nothing keeps asking after Back', `${polls} then ${d.count(`/api/sessions/s${d.sessions.size}/messages`)}`)
  await app.quit()

  // ── H5: the computer says no ─────────────────────────────────────────────────────────────────
  console.log('\n[probe] === H5: the computer refuses ===')
  d.mode = 'error'
  d.sends.length = 0
  d.created.length = 0
  app = await launch()
  await toHello(app)
  await onScreen(app, 'F1')
  await clickText(app, 'Send')
  const refusedText = await waitFor(() => screenText(app), (t) => t.includes("couldn't take that message"), 8000)
  check(refusedText.includes("Prometheus couldn't take that message") && (await hasButton(app, 'Try again')) && !refusedText.includes('lost touch'), 'H5 a computer that answers and says no is NOT "we lost touch": it says it could not take the message, with Try again', refusedText.slice(0, 120))
  await noJargon(app, 'H5 could not take the message', "Prometheus couldn't take that message")
  d.mode = 'reply'
  check((await clickText(app, 'Try again')) === 'clicked' && (await waitFor(() => screenText(app), (t) => t.includes("You're all set."), 10000)).includes("You're all set."), 'H5 once it will take it, Try again finishes the job')
  check(d.created.length === 1 && d.sends.length === 1, 'H5 …with one conversation and one message', JSON.stringify({ created: d.created.length, sends: d.sends.length }))
  await app.quit()

  // ── H6: a dropped request is not "lost touch" ────────────────────────────────────────────────
  console.log('\n[probe] === H6: a flaky network ===')
  d.mode = 'reply'
  d.replyDelayMs = 6000
  d.pollFailures = 2
  d.sends.length = 0
  d.created.length = 0
  app = await launch()
  await toHello(app)
  await onScreen(app, 'F1')
  await clickText(app, 'Send')
  await sleep(4200)
  const flaky = await screenText(app)
  check(d.pollFailures === 0 && flaky.includes('Thinking') && !flaky.includes('lost touch') && !flaky.includes("couldn't take"), 'H6 two dropped requests in a row while waiting are not "we lost touch": it keeps waiting', `${d.pollFailures} left: ${flaky.slice(0, 80)}`)
  check((await waitFor(() => screenText(app), (t) => t.includes("You're all set."), 8000)).includes("You're all set."), 'H6 …and the reply still arrives and finishes it')
  await app.quit()
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  await d.stop()
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
