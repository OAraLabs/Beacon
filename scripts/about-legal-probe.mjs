#!/usr/bin/env node
// about-legal-probe — does Settings → About open the files Beacon ships, and only those?
//
// smoke:legal-docs proves the path model and that main's SOURCE refuses before it opens. This drives the
// real app: opens Settings, finds the About section, clicks each button, and reads what main handed to
// shell.openPath. shell.openPath is replaced from the MAIN inspector with a recorder BEFORE any click, and
// the probe refuses to click if the replacement did not take, so nothing opens on this machine.
//
// WHAT IT CANNOT PROVE: the packaged paths (a release build refuses --inspect and remote debugging, and
// smoke:legal-docs + check-license-metadata cover where the packaged files are), or that the OS viewer
// shows the file.
//
// Scratch profile, --use-mock-keychain, and a local fake gateway: no Keychain prompt, no daemon, and the
// single-instance lock does not collide with an installed Beacon. An unpackaged run never claims beacon://.
//
// RUN: npm run build && node scripts/about-legal-probe.mjs [screenshot.png]
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
const SHOT = process.argv[2] ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
let checks = 0
const check = (ok, label, extra = '') => { checks++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`); if (!ok) failures++ }
const MIN_CHECKS = 12
process.on('exit', (code) => { if (code === 0 && (failures || checks < MIN_CHECKS)) process.exitCode = 1 })

const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s) }
const site = createServer((req, res) => { if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 }); json(res, 200, []) })
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const wsSite = createServer()
const { WebSocketServer } = await import('ws')
const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (s) => { try { s.send(JSON.stringify({ type: 'connected' })) } catch {} s.on('error', () => {}) })
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r))

const INSPECT = 9700 + ((process.pid + 71) % 200)
const CDP = 9500 + ((process.pid + 71) % 200)
for (const port of [INSPECT, CDP]) {
  const taken = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)
  if (taken) { console.error(`[probe] something already answers on ${port}; refusing to attach to a stranger`); process.exit(2) }
}
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-about-'))
const child = spawn('npx', ['electron', '.', `--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${USER_DATA}`, '--use-mock-keychain'], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(site.address().port), BEACON_GATEWAY_WS_PORT: String(wsSite.address().port) }
})
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d)))
child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
const closeStubs = () => { for (const c of [wss, wsSite, site]) { try { c.close() } catch {} } }
async function finish() {
  reaped = true
  killGroup('SIGTERM')
  closeStubs()
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(100)
  if (child.exitCode === null && child.signalCode === null) killGroup('SIGKILL')
  await sleep(300) // helpers still write the profile for a moment after the main process exits
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {}
  console.log(`\n[probe] outcome: ${failures === 0 && checks >= MIN_CHECKS ? 'PASS' : `FAIL (${failures} failed, ${checks} of at least ${MIN_CHECKS} checks ran)`}`)
  process.exit(failures === 0 && checks >= MIN_CHECKS ? 0 : 1)
}
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); failures++; void finish() })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) } })

async function target(port, pick) {
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick); if (t) return t } catch {}
  }
  return null
}
function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id) }
  const opened = new Promise((r) => { ws.onopen = r })
  const send = async (method, params = {}) => { await opened; return new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) }) }
  // macOS: the first evaluate after attach can throw "Internal error"; retry it.
  const evaluate = async (expression) => {
    for (let i = 0; i < 10; i++) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (!r.error && !r.result?.exceptionDetails) return r.result.result.value
      if (i === 9) throw new Error(`evaluate failed: ${JSON.stringify(r.error ?? r.result.exceptionDetails).slice(0, 300)}`)
      await sleep(300)
    }
  }
  return { send, evaluate, close: () => ws.close() }
}

console.log('\n── main: replace shell.openPath with a recorder ─────────────────')
const nodeTarget = await target(INSPECT, (t) => t.type === 'node')
if (!nodeTarget) { check(false, 'main inspector reachable'); await finish() }
const main = session(nodeTarget.webSocketDebuggerUrl)
const stubbed = await main.evaluate(`(() => {
  const { shell } = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron')
  globalThis.__legalOpened = []
  const stub = async (p) => { globalThis.__legalOpened.push(p); return '' }
  shell.openPath = stub
  return shell.openPath === stub
})()`)
check(stubbed === true, 'shell.openPath is the recorder (the assignment took)')
if (stubbed !== true) { console.error('[probe] refusing to click: a real click would open files on this machine'); await finish() }
const opened = () => main.evaluate('globalThis.__legalOpened.slice()')

console.log('\n── renderer: Settings → About ─────────────────────────────────────')
const page = await target(CDP, (t) => t.type === 'page' && /index\.html/.test(t.url) && !t.url.includes('#'))
if (!page) { check(false, 'the shell page is reachable over CDP'); await finish() }
check(page.url.startsWith(`file://${REPO}/out/renderer/`), "the page is this checkout's build", page.url)
const ui = session(page.webSocketDebuggerUrl)
let ready = false
for (let i = 0; i < 40 && !ready; i++) { ready = await ui.evaluate(`!!document.body && !/^\\s*Loading/.test(document.body.innerText) && !!window.beacon`); if (!ready) await sleep(250) }
check(ready, 'the app is past Loading… (connect mode, from the fake gateway)')
await ui.evaluate(`window.dispatchEvent(new Event('beacon:open-settings'))`)
let about = null
for (let i = 0; i < 40 && !about; i++) {
  about = await ui.evaluate(`(() => {
    const h = [...document.querySelectorAll('div')].find((d) => d.textContent === 'About' && d.children.length === 0)
    if (!h) return null
    h.parentElement.scrollIntoView({ block: 'end' })
    const sec = h.parentElement
    return { text: sec.innerText, buttons: [...sec.querySelectorAll('button')].map((b) => b.textContent.trim()) }
  })()`)
  if (!about) await sleep(250)
}
check(!!about, 'Settings has an About section')
check((about?.text ?? '').includes('Free · open source (MIT) · beta'), 'it says "Free · open source (MIT) · beta"', about?.text)
check(!/closed source/i.test(about?.text ?? ''), 'and no longer says "closed source"', about?.text)
check(JSON.stringify(about?.buttons) === JSON.stringify(['License', 'Third-party notices', 'Chromium licenses']), 'it has License, Third-party notices and Chromium licenses', JSON.stringify(about?.buttons))
if (SHOT) {
  await sleep(300)
  const shot = await ui.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) { writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64')); console.log(`  (screenshot: ${SHOT})`) }
}

const want = { 'License': `${REPO}/LICENSE`, 'Third-party notices': `${REPO}/THIRD_PARTY_NOTICES.txt`, 'Chromium licenses': `${REPO}/node_modules/electron/dist/LICENSES.chromium.html` }
for (const [label, path] of Object.entries(want)) {
  const before = (await opened()).length
  await ui.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  let got = await opened()
  for (let i = 0; i < 20 && got.length === before; i++) { await sleep(100); got = await opened() }
  const last = got[got.length - 1]
  check(got.length === before + 1 && last === path && existsSync(last), `${label} → main opens ${path.slice(REPO.length + 1)}, which exists`, `opened ${JSON.stringify(got.slice(before))}`)
}
const shownError = await ui.evaluate(`(() => { const h = [...document.querySelectorAll('div')].find((d) => d.textContent === 'About' && d.children.length === 0); return h.parentElement.lastElementChild.tagName === 'DIV' && h.parentElement.lastElementChild.querySelector('button') === null ? h.parentElement.lastElementChild.textContent : null })()`)
check(shownError === null, 'no error under the buttons', shownError)

console.log('\n── the channel refuses anything but a document name ───────────────')
const before = (await opened()).length
for (const bad of ['../../../etc/passwd', '/etc/passwd', 'LICENSE']) {
  const r = await ui.evaluate(`window.beacon.legal.open(${JSON.stringify(bad)})`)
  check(r?.ok === false && r.error === 'not a document Beacon ships', `legal.open(${JSON.stringify(bad)}) is refused`, JSON.stringify(r))
}
check((await opened()).length === before, 'and nothing was handed to shell.openPath for them')

main.close()
ui.close()
await finish()
