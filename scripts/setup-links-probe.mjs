#!/usr/bin/env node
// setup-links-probe — do the links on the setup screens open in the browser, IN THE REAL APP?
// 0.3.0 printed the places you need to visit (api.slack.com/apps, the Discord developer portal,
// @BotFather) as plain text, and nothing on the way in linked to the setup guide, so someone
// without Prometheus had no next step at all. This walks the wizard with real clicks and typing,
// Welcome → Connect (pairs with a stub) → Model → Identity → Gateways, and clicks every link.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:setup-links
//
// SAFE BY CONSTRUCTION:
//   * shell.openExternal is REPLACED in main before anything is clicked, and records the URL, so no
//     browser opens on this Mac; the probe also asserts no window navigated and none was created;
//   * a fresh empty profile (--user-data-dir in tmp) and --use-mock-keychain (app-driver.mjs);
//   * the "Prometheus" is a setup-mode stub on 127.0.0.1:8005, and the probe refuses to start if 8005
//     or 8010 is already taken; BEACON_GATEWAY_* are removed (they bypass setup).
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'

const CODE = '482913'
const TOKEN = 'stub-token'
const MIN_CHECKS = 15
const WANT = {
  guide: 'https://github.com/OAraLabs/Beacon/blob/main/docs/SETUP.md',
  botfather: 'https://t.me/BotFather',
  slack: 'https://api.slack.com/apps',
  discord: 'https://discord.com/developers/applications'
}

let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}
process.on('exit', (code) => {
  if (checks < MIN_CHECKS) {
    console.log(`[probe] setup-links: only ${checks} checks ran (expected at least ${MIN_CHECKS}) — INCOMPLETE`)
    process.exitCode = 1
    return
  }
  console.log(failures === 0 ? `[probe] setup-links: all ${checks} checks passed` : `[probe] setup-links: ${failures} of ${checks} FAILED`)
  if (failures > 0 || code !== 0) process.exitCode = 1
})
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const portTaken = (port) =>
  new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), res(true)))
    s.once('error', () => res(false))
  })
for (const p of [8005, 8010]) {
  if (await portTaken(p)) {
    console.log(`[probe] ABORT: something already listens on 127.0.0.1:${p}. Refusing to run next to a real Prometheus.`)
    process.exit(2)
  }
}

// A first-boot Prometheus in setup mode: status, pair, detect (one local backend), 403 elsewhere.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8005')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const json = (status, b) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(b)))
    if (url.pathname === '/api/setup/status') return json(200, { setup_mode: true, configured: false, pairing: 'available', version: 'stub' })
    if (url.pathname === '/api/setup/pair')
      return JSON.parse(body || '{}').code === CODE ? json(200, { token: TOKEN, api_base_port: 8005, ws_port: 8010 }) : json(401, { error: 'invalid_code', attempts_remaining: 4 })
    if (url.pathname === '/api/setup/detect')
      return bearer === TOKEN
        ? json(200, { backends: [{ name: 'stub llama.cpp', provider: 'llama_cpp', base_url: 'http://127.0.0.1:8080', models: ['stub-model'], latency_ms: 3 }], cloud_providers: [] })
        : json(401, { error: 'unauthorized' })
    return json(403, { error: 'setup_mode' })
  })
})
await new Promise((r) => server.listen(8005, '127.0.0.1', r))

const profile = mkdtempSync(join(tmpdir(), 'beacon-links-probe-'))
let app
try {
  app = await launchApp({ profile, readySelector: '.wiz-card, nav[aria-label="Views"]' })
  const ev = app.page.evaluate
  check((await ev(`!!document.querySelector('.wiz-card')`)) === true, 'an empty profile opens setup')

  // Replace openExternal BEFORE any click: a link that works would otherwise open a real browser.
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  const opened = () => app.mainEval(`JSON.stringify(globalThis.__opened)`).then((s) => JSON.parse(s))
  const windows = () => app.mainEval(`__electron.BrowserWindow.getAllWindows().length`)
  const pageUrl = () => ev('location.href')
  const startUrl = await pageUrl()
  const startWindows = await windows()

  async function realClick(where, what) {
    if (!where) return `no ${what}`
    if (!where.hit) return `${what} is covered at its centre`
    for (const type of ['mousePressed', 'mouseReleased'])
      await app.page.send('Input.dispatchMouseEvent', { type, x: where.x, y: where.y, button: 'left', clickCount: 1 })
    await sleep(300)
    return 'clicked'
  }
  const locate = (finder) =>
    ev(`(() => {
      const el = (${finder})()
      if (!el || el.offsetParent === null) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return { x, y, hit: !!top && (top === el || el.contains(top)), disabled: !!el.disabled }
    })()`)
  const clickLink = async (href) =>
    realClick(await locate(`() => [...document.querySelectorAll('a')].find((a) => a.href === ${JSON.stringify(href)})`), `link to ${href}`)
  const clickButton = async (text) =>
    // Exact, or the text plus a suffix after a space ("Next →"): "Pair" must not hit the "Pairing code" tab.
    realClick(await locate(`() => [...document.querySelectorAll('button')].find((b) => { const t = b.innerText.trim(); return (t === ${JSON.stringify(text)} || t.startsWith(${JSON.stringify(text + ' ')})) && !b.disabled })`), `enabled button "${text}"`)
  async function typeInto(placeholderStart, text) {
    const r = await realClick(await locate(`() => [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').startsWith(${JSON.stringify(placeholderStart)}))`), `input "${placeholderStart}"`)
    if (r !== 'clicked') return r
    await app.page.send('Input.insertText', { text })
    return 'typed'
  }
  async function linkOpens(name) {
    const before = (await opened()).length
    const r = await clickLink(WANT[name])
    const after = await opened()
    check(r === 'clicked' && after.length === before + 1 && after.at(-1) === WANT[name], `${name}: a real click opens ${WANT[name]} in the browser`, r === 'clicked' ? `opened ${JSON.stringify(after.slice(before))}` : r)
  }
  const step = () => ev(`document.querySelector('.wiz-rail .wiz-step.active > span:not(.wiz-dot)')?.firstChild?.textContent?.trim() ?? null`)
  const waitStep = async (want, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end && (await step()) !== want) await sleep(200)
    return step()
  }

  // Welcome: someone without Prometheus has a next step.
  await linkOpens('guide')
  check((await clickButton('Next')) === 'clicked' && (await waitStep('Connect')) === 'Connect', 'Next → Connect')
  // Connect: the guide again, where the address is asked for.
  await linkOpens('guide')
  check((await typeInto('host:8005', '127.0.0.1')) === 'typed', 'type the address (real keystrokes)')
  check((await typeInto('6 digits', CODE)) === 'typed', 'type the pairing code')
  check((await clickButton('Pair')) === 'clicked' && (await waitStep('Model', 10000)) === 'Model', 'Pair → Model (the stub accepted the code)')
  await sleep(1500) // detect lands and selects the stub backend
  check((await clickButton('Next')) === 'clicked' && (await waitStep('Identity')) === 'Identity', 'Next → Identity')
  check((await clickButton('Next')) === 'clicked' && (await waitStep('Gateways')) === 'Gateways', 'Next → Gateways')
  // Gateways: each section's sign-up page is a link.
  for (const [section, name] of [['Telegram', 'botfather'], ['Slack', 'slack'], ['Discord', 'discord']]) {
    const r = await realClick(await locate(`() => [...document.querySelectorAll('button.wiz-gw-head')].find((b) => b.innerText.includes(${JSON.stringify(section)}))`), `${section} header`)
    if (r !== 'clicked') check(false, `${section}: section opens`, r)
    await linkOpens(name)
  }

  check((await pageUrl()) === startUrl, 'no link navigated the shell window', await pageUrl())
  check((await windows()) === startWindows, 'no link opened an Electron window', `${await windows()} windows`)
  const all = await opened()
  check(all.every((u) => Object.values(WANT).includes(u)), 'nothing else was opened', JSON.stringify(all))
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit()
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
}
