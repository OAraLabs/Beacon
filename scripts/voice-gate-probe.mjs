/**
 * voice-gate-probe — the three voice fixes, in the real built app, on FRESH profiles.
 *
 *   [fix 1] No `oara` integration → no Voice segment and no dictation button, and nothing asks for
 *           the microphone. With it configured, both are there. Read-aloud is there either way.
 *   [fix 2] Configured but broken (the host refuses, or never answers) → nothing asks for the
 *           microphone. Configured and working → the mic IS asked for, and only AFTER the bridge
 *           answered and the listener's socket opened.
 *   [fix 3] A refusal on Home shows on Home, without Electron's "Error invoking remote method"
 *           wrapper, and is gone once a conversation starts.
 *
 * HOW THE MIC IS OBSERVED. Main's default-session permission handler is replaced over the inspector
 * with one that RECORDS every request and DENIES it. getUserMedia reaches that handler before any
 * device is touched, so a denied request never reaches the OS prompt, and the record is exactly
 * "the app asked for the mic". A self-test asks once from the page first and requires the record to
 * see it: an instrument that cannot see an ask would pass every "no ask" check below.
 *
 * WHY FRESH PROFILES. The question is what a first-time user sees. Each scenario launches on an
 * empty --user-data-dir (plus, where the scenario says so, an integrations.json), with
 * --use-mock-keychain and no credential, so the macOS Keychain is never touched. The daemon is a
 * local fake (BEACON_GATEWAY_HOST), which also skips the setup wizard a real first run walks through.
 *
 * Run: npm run build && npm run probe:voice-gate   (macOS). The working-bridge scenario's fake VAD
 * listener takes a spare port and names it as the oara entry's `options.vadPort` in integrations.json, so it
 * needs no fixed port free, and its socket opening proves the configured port is honoured (a Beacon
 * that ignored it would dial the default 8012 and never reach the listener).
 * PROBE_SHOTS=<dir> saves a screenshot of each Home state.
 */
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

const SHOTS = process.env.PROBE_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let checks = 0
let failures = 0
const failed = []
function check(ok, label, detail = '') {
  checks += 1
  if (ok) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures += 1
    failed.push(label)
  }
}
const EXPECTED_CHECKS = 42
process.on('exit', () => {
  if (checks !== EXPECTED_CHECKS) {
    console.log(`\nINCOMPLETE — ${checks} checks ran, expected ${EXPECTED_CHECKS}`)
    process.exitCode = 1
    return
  }
  console.log(`\n${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures} of ${checks}):\n  - ${failed.join('\n  - ')}`}`)
  process.exitCode = failures === 0 ? 0 : 1
})

// ── the fake daemon: just enough to mint a session from Home ──────────────────────────────────
let minted = 0
const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.method === 'POST' && req.url === '/api/sessions') {
    minted += 1
    res.end(JSON.stringify({ session_id: `beacon:voice-gate-probe-${minted}` }))
    return
  }
  res.statusCode = 404
  res.end('[]')
})
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const gwPort = await listen(gateway)
async function deadPort() {
  const s = createTcpServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}
process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(gwPort)
process.env.BEACON_GATEWAY_WS_PORT = String(await deadPort())

// ── one scenario = one fresh profile, one launch ──────────────────────────────────────────────
async function scenario(name, integrations, body) {
  console.log(`\n=== ${name} ===`)
  const profile = mkdtempSync(join(tmpdir(), 'beacon-voice-gate-'))
  if (integrations) writeFileSync(join(profile, 'integrations.json'), JSON.stringify(integrations, null, 2))
  let app
  try {
    app = await launchApp({ profile })
  } catch (err) {
    check(false, `${name}: the app launched`, String(err).slice(0, 400))
    return
  }
  try {
    await body(app)
  } catch (err) {
    check(false, `${name}: the scenario ran to the end`, err instanceof Error ? err.stack : String(err))
  } finally {
    await app.quit()
    rmSync(profile, { recursive: true, force: true })
  }
}

/** Replace main's permission handler with a recorder that denies, then prove it records. */
async function instrumentMic(app, name) {
  const installed = await app.mainEval(`(() => {
    globalThis.__asks = []
    __electron.session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      globalThis.__asks.push({ permission, mediaTypes: (details && details.mediaTypes) || [], at: Date.now() })
      cb(false)
    })
    return true
  })()`)
  const self = await app.page.evaluate(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name)`)
  const seen = await app.mainEval(`globalThis.__asks.filter((a) => a.permission === 'media').length`)
  check(installed === true && self === 'NotAllowedError' && seen === 1, `${name}: the mic recorder sees an ask (self-test: ${self}, ${seen} recorded)`)
  await app.mainEval(`(globalThis.__asks = [], true)`)
  // Every text the voice line takes, and where it painted. A refusal can repeat an earlier one word
  // for word, so "a notice is showing" proves nothing about the LAST click; the log since the click does.
  await app.page.evaluate(`(() => {
    window.__notices = []
    const read = () => [...document.querySelectorAll('.voice-notice')].map((e) => (e.closest('.chat-home') ? 'home: ' : 'conv: ') + e.textContent.trim()).join(' | ')
    new MutationObserver(() => {
      const t = read()
      if (t !== window.__notices[window.__notices.length - 1]) window.__notices.push(t)
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
    return true
  })()`)
}
const noticeMark = (app) => app.page.evaluate(`window.__notices.length`)
/** Poll the log from `mark` on for an entry matching `re`. Returns it and everything logged since. */
async function noticeSince(app, mark, re, ms = 9000) {
  const t0 = Date.now()
  let since = []
  while (Date.now() - t0 < ms) {
    since = await app.page.evaluate(`window.__notices.slice(${mark})`)
    const hit = since.find((n) => re.test(n))
    if (hit) return { text: hit, ms: Date.now() - t0, since }
    await sleep(100)
  }
  return { text: null, ms: Date.now() - t0, since }
}
const micAsks = (app) => app.mainEval(`globalThis.__asks.filter((a) => a.permission === 'media')`)

async function openChat(app) {
  await app.page.evaluate(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] button')].find((x) => x.title === 'Chats'); if (b) b.click(); return !!b })()`)
  for (let i = 0; i < 40; i++) {
    if (await app.page.evaluate(`!!document.querySelector('.chat-home textarea')`)) return true
    await sleep(150)
  }
  return false
}

/** Everything a scenario asserts about the composer, read from the live DOM. */
const COMPOSER = `(() => {
  const home = document.querySelector('.chat-home')
  const scope = home || document
  const text = (els) => [...els].map((e) => e.textContent.trim()).filter(Boolean)
  const notices = text(scope.querySelectorAll('.voice-notice'))
  return {
    home: !!home,
    // The conversation's own composer. Absence checks below are only about a surface that is ON
    // screen: "no Voice segment" on a page that is still Loading… passes and proves nothing.
    thread: !home && [...document.querySelectorAll('textarea')].some((t) => t.placeholder.startsWith('Message Prometheus')),
    voice: scope.querySelectorAll('.mode-opt-voice').length,
    dictate: scope.querySelectorAll('button[aria-label="Dictate into the message box"], button[aria-label="Stop dictating and insert the transcript"]').length,
    readAloud: document.querySelectorAll('button[aria-label="Read replies aloud"]').length,
    notices
  }
})()`

/** A real mouse click at the element's centre (so a covered or zero-size control cannot pass). */
async function click(app, selector) {
  const r = await app.page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }
  })()`)
  if (!r || !r.w || !r.h) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 })
  }
  return true
}

async function shot(app, file) {
  if (!SHOTS) return
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (r?.result?.data) {
    writeFileSync(join(SHOTS, file), Buffer.from(r.result.data, 'base64'))
    console.log(`  [shot] ${join(SHOTS, file)}`)
  }
}

// ── A. a fresh install: no integrations.json ─────────────────────────────────────────────────
await scenario('A. fresh profile, no integrations.json', null, async (app) => {
  await instrumentMic(app, 'A')
  check(await openChat(app), 'A: Chats opens the Home composer')
  const dom = await app.page.evaluate(COMPOSER)
  check(dom.home && dom.voice === 0, '[fix 1] A: no Voice segment on Home', JSON.stringify(dom))
  check(dom.home && dom.dictate === 0, '[fix 1] A: no dictation button on Home', JSON.stringify(dom))
  await shot(app, 'A-fresh-home.png')
  // Try every voice control that IS on screen, the way a curious first-time user would.
  const tried = []
  if (await click(app, '.chat-home .mode-opt-voice')) tried.push('Voice')
  if (await click(app, '.chat-home button[aria-label="Dictate into the message box"]')) tried.push('Dictate')
  await sleep(1500)
  const asks = await micAsks(app)
  check(asks.length === 0, `[fix 1] A: nothing asked for the microphone (clicked: ${tried.join(', ') || 'nothing — no control to click'})`, `${asks.length} ask(s)`)
  // Into a conversation: the gate holds there too, and read-aloud (system voices) is untouched.
  await app.page.evaluate(`document.querySelector('.chat-home textarea').focus()`)
  await app.page.send('Input.insertText', { text: 'hello from the voice-gate probe' })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  let conv = null
  for (let i = 0; i < 40; i++) {
    conv = await app.page.evaluate(COMPOSER)
    if (conv.thread) break
    await sleep(150)
  }
  check(conv && conv.thread, 'A: a conversation opened from Home', JSON.stringify(conv))
  check(conv && conv.thread && conv.voice === 0 && conv.dictate === 0, '[fix 1] A: no Voice segment and no dictation button in the conversation either', JSON.stringify(conv))
  check(conv && conv.readAloud === 1, '[fix 1] A: read-aloud is still there (system voices, not OAra)', JSON.stringify(conv))
})

// ── B. oara configured, pointed at a host that is down ───────────────────────────────────────
const downPort = await deadPort()
await scenario(`B. oara → 127.0.0.1:${downPort} (down)`, [{ id: 'oara', name: 'OAra Voice', baseUrl: `http://127.0.0.1:${downPort}`, authRef: 'none', enabled: true }], async (app) => {
  await instrumentMic(app, 'B')
  check(await openChat(app), 'B: Chats opens the Home composer')
  let dom = null
  for (let i = 0; i < 20; i++) {
    dom = await app.page.evaluate(COMPOSER)
    if (dom.voice > 0) break
    await sleep(150)
  }
  check(dom.voice === 1, '[fix 1] B: configured → the Voice segment is there', `found ${dom.voice}`)
  check(dom.dictate === 1, '[fix 1] B: configured → the dictation button is there', `found ${dom.dictate}`)

  // Electron's wrapper, read off a real invoke: the shape the notice must NOT carry.
  const raw = await app.page.evaluate(`window.beacon.voice.dictate('').then(() => null, (e) => e.message)`)
  check(typeof raw === 'string' && raw.startsWith("Error invoking remote method 'voice:dictate': Error: "), 'B: a rejected invoke really arrives wrapped (the fixture the smoke strips)', String(raw))

  let mark = await noticeMark(app)
  check(await click(app, '.chat-home .mode-opt-voice'), 'B: clicked Voice on Home')
  const v = await noticeSince(app, mark, /^home: (?!Checking)/)
  await sleep(1000) // a late ask would land here
  const vAsks = await micAsks(app)
  check(vAsks.length === 0, '[fix 2] B: Voice with the host down → nothing asked for the microphone', `${vAsks.length} ask(s)`)
  check(v.text !== null, '[fix 3] B: the refusal shows on Home', `logged since the click: ${JSON.stringify(v.since)}`)
  check(v.text !== null && !/Error invoking remote method/.test(v.text), "[fix 3] B: without Electron's wrapper", String(v.text))
  check(v.text !== null && /not answering at 127\.0\.0\.1:\d+ \(bridge: connection refused\)/.test(v.text), '[fix 2] B: it names the host and the cause', String(v.text))
  console.log(`  [notice after ${v.ms} ms] ${v.text}`)
  await shot(app, 'B-down-home-voice.png')

  mark = await noticeMark(app)
  check(await click(app, '.chat-home button[aria-label="Dictate into the message box"]'), 'B: clicked Dictate on Home')
  // The same words as Voice's refusal, so it must be a NEW one: checking, then refused, after the click.
  const d = await noticeSince(app, mark, /^home: OAra Voice is not answering/)
  await sleep(1000)
  const dAsks = await micAsks(app)
  check(dAsks.length === 0, '[fix 2] B: Dictate with the host down → nothing asked for the microphone', `${dAsks.length} ask(s)`)
  const checkedFirst = d.since.findIndex((n) => /^home: Checking OAra Voice/.test(n))
  check(d.text !== null && checkedFirst !== -1 && checkedFirst < d.since.indexOf(d.text) && !/Error invoking remote method/.test(d.text), '[fix 3] B: Dictate\'s own refusal (checking → refused) shows on Home, unwrapped', JSON.stringify(d.since))

  // Start a conversation from Home. The old error must not follow.
  await app.page.evaluate(`document.querySelector('.chat-home textarea').focus()`)
  await app.page.send('Input.insertText', { text: 'hello from the voice-gate probe' })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  let conv = null
  for (let i = 0; i < 40; i++) {
    conv = await app.page.evaluate(COMPOSER)
    if (conv.thread) break
    await sleep(150)
  }
  check(conv && conv.thread, 'B: a conversation opened from Home', JSON.stringify(conv))
  await sleep(500)
  conv = await app.page.evaluate(COMPOSER)
  // ANY voice-line text, not just OAra's words: an app that asks for the mic first leaves "Permission
  // denied" or "Microphone unavailable" behind, and that must not follow the user either.
  const stale = conv.notices.filter((n) => /OAra|not answering|Error invoking|[Vv]oice|[Mm]icrophone|Permission|[Dd]ictation/.test(n))
  check(conv.thread && stale.length === 0, '[fix 3] B: the Home error does not show up in the new conversation', JSON.stringify(conv))
  await shot(app, 'B-down-new-conversation.png')

  // …and a refusal INSIDE a conversation still shows there.
  mark = await noticeMark(app)
  check(await click(app, '.mode-opt-voice'), 'B: clicked Voice in the conversation')
  const c = await noticeSince(app, mark, /^conv: .*not answering/)
  await sleep(500)
  check(c.text !== null, '[fix 2] B: in a conversation too, the check refuses (host named) and says so there', JSON.stringify(c.since))
  const cAsks = await micAsks(app)
  check(cAsks.length === 0, '[fix 2] B: …still without asking for the microphone', `${cAsks.length} ask(s)`)
})

// ── C. oara configured, pointed at a host that never answers (an offline tailnet peer) ───────
await scenario('C. oara → 192.0.2.1:8015 (TEST-NET, never answers)', [{ id: 'oara', name: 'OAra Voice', baseUrl: 'http://192.0.2.1:8015', authRef: 'none', enabled: true }], async (app) => {
  await instrumentMic(app, 'C')
  check(await openChat(app), 'C: Chats opens the Home composer')
  for (let i = 0; i < 20 && (await app.page.evaluate(COMPOSER)).voice === 0; i++) await sleep(150)
  const mark = await noticeMark(app)
  check(await click(app, '.chat-home .mode-opt-voice'), 'C: clicked Voice on Home')
  const v = await noticeSince(app, mark, /^home: (?!Checking)/, 10000)
  await sleep(1000)
  const asks = await micAsks(app)
  check(asks.length === 0, '[fix 2] C: a host that never answers → nothing asked for the microphone', `${asks.length} ask(s)`)
  check(v.text !== null && /not answering at 192\.0\.2\.1:8015 \(bridge: (no answer within 4 s|host unreachable)\)/.test(v.text), '[fix 2] C: it ends on its own bound, with a named reason', `${v.text} after ${v.ms} ms`)
  check(v.since.some((n) => /^home: Checking OAra Voice/.test(n)), '[fix 2] C: while it waits, Home says it is checking — not a click that did nothing', JSON.stringify(v.since))
  console.log(`  [notice after ${v.ms} ms] ${v.text}`)
})

// ── D. oara configured and WORKING: the mic is asked for, and only after the checks ──────────
const hits = []
const bridge = createServer((req, res) => {
  hits.push({ path: req.url, at: Date.now() })
  res.setHeader('content-type', 'application/json')
  res.end(req.url === '/integration/manifest' ? JSON.stringify({ contract_version: 1, id: 'oara', name: 'OAra Voice', views: [], capabilities: [] }) : '{}')
})
const bridgePort = await listen(bridge)
const opens = []
const vad = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise((r) => vad.once('listening', r))
const VAD_PORT = vad.address().port
vad.on('connection', () => opens.push(Date.now()))
check(VAD_PORT !== 8012 && VAD_PORT > 0, `D: the fake listener has a spare port (${VAD_PORT}), not the default, so reaching it proves the configured one is used`)
await scenario(`D. oara → a working fake bridge (127.0.0.1:${bridgePort}) + listener (:${VAD_PORT}, set as vadPort)`, [{ id: 'oara', name: 'OAra Voice', baseUrl: `http://127.0.0.1:${bridgePort}`, authRef: 'none', enabled: true, options: { vadPort: VAD_PORT } }], async (app) => {
  await instrumentMic(app, 'D')
  check(await openChat(app), 'D: Chats opens the Home composer')
  for (let i = 0; i < 20 && (await app.page.evaluate(COMPOSER)).voice === 0; i++) await sleep(150)
  hits.length = 0
  opens.length = 0
  check(await click(app, '.chat-home .mode-opt-voice'), 'D: clicked Voice on Home')
  let asks = []
  for (let i = 0; i < 40 && asks.length === 0; i++) {
    await sleep(150)
    asks = await micAsks(app)
  }
  const manifest = hits.find((h) => h.path === '/integration/manifest')
  check(asks.length === 1, '[fix 2] D: a working setup → Voice DOES ask for the microphone (once)', `${asks.length} ask(s)`)
  check(!!manifest && asks.length > 0 && manifest.at <= asks[0].at, '[fix 2] D: …after the bridge answered', `manifest at ${manifest?.at}, ask at ${asks[0]?.at}`)
  check(opens.length > 0 && asks.length > 0 && opens[0] <= asks[0].at, "[fix 2] D: …and after the listener's socket opened", `open at ${opens[0]}, ask at ${asks[0]?.at}`)
  const denied = await noticeSince(app, 0, /^home: .*(Permission|Microphone)/)
  check(denied.text !== null, 'D: the denied mic is named on Home', JSON.stringify(denied.since))

  await app.mainEval(`(globalThis.__asks = [], true)`)
  hits.length = 0
  check(await click(app, '.chat-home button[aria-label="Dictate into the message box"]'), 'D: clicked Dictate on Home')
  asks = []
  for (let i = 0; i < 40 && asks.length === 0; i++) {
    await sleep(150)
    asks = await micAsks(app)
  }
  const m2 = hits.find((h) => h.path === '/integration/manifest')
  check(asks.length === 1 && !!m2 && m2.at <= asks[0].at, '[fix 2] D: Dictate asks for the microphone only after the bridge answered', `manifest at ${m2?.at}, asks ${JSON.stringify(asks)}`)
})
vad.close()
bridge.close()
gateway.close()
process.exit()
