// Phase 0 packaging spike for the terminal pane (docs: claude/BEACON-TERMINAL-SCOPE.md) — drives
// the PACKAGED bundle (the probe build in dist-probe/mac-arm64 by default; BEACON_BUNDLE=<path/to/Beacon.app>),
// never dev. A release build refuses --inspect and --remote-debugging-port, so it must be a probe build:
//   1. main-process pty spawn over the Node inspector (--inspect): node-pty must load from the
//      bundle asar, spawn-helper must exist under app.asar.unpacked and exec, a zsh round-trip
//      must echo. This is the hardened-runtime + asar + arm64 bundle path the user actually runs.
//   2. renderer CSP vs xterm.js over CDP: load the packaged xterm.css, mount a Terminal, and read
//      securitypolicyviolation + console "Refused" lines. Positive control: an inline <script> must
//      be refused first — proves the CSP is actually ON in this document, so a clean xterm pass
//      means something (see memory: global-hooks-rewrite-your-headers — dev never installs the hook).
// Usage: npm run pack:mac:probe && npm run probe:terminal-packaged
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const APP = process.env.BEACON_BUNDLE ?? join(REPO, 'dist-probe/mac-arm64/Beacon.app')
const BIN = join(APP, 'Contents/MacOS/Beacon')
const ASAR = join(APP, 'Contents/Resources/app.asar')
if (!existsSync(BIN)) { console.log('FATAL: no bundle at', BIN); process.exit(4) }
const INSPECT = 9300 + (process.pid % 500)
const CDP = INSPECT + 1
const userData = mkdtempSync(join(tmpdir(), 'beacon-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const p of [INSPECT, CDP]) {
  try { const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(500) }); if (r.ok) { console.log('FATAL: port busy', p); process.exit(3) } } catch {}
}
const child = spawn(BIN, [`--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)))
const reap = () => { try { child.kill('SIGTERM') } catch {} ; setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1500).unref?.() }
process.on('exit', reap)
let failures = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++ }

async function attach(port, pick) {
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find(pick)
      if (t) return t
    } catch {}
  }
  return null
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map(); const events = []
  let id = 0
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  return new Promise((res, rej) => { ws.onopen = () => res({ send, evaluate, events, ws }); ws.onerror = rej })
}

// ── 1. main process: pty spawn ────────────────────────────────────────────────────────────
const node = await attach(INSPECT, (t) => t.type === 'node')
check(!!node, 'main-process inspector target found', node ? node.url : log.join('').slice(-800))
if (node) {
  const m = await client(node.webSocketDebuggerUrl)
  await m.send('Runtime.enable')
  const info = await m.evaluate(`(() => { const require = process.mainModule.require('module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json'); const r = require.resolve('node-pty'); const helper = require('path').join(require('path').dirname(r), '../build/Release/spawn-helper').replace('app.asar', 'app.asar.unpacked'); return { r, arch: process.arch, exec: process.execPath, electron: process.versions.electron, helper, helperOnDisk: require('fs').existsSync(helper) } })()`)
  console.log('  main:', JSON.stringify(info))
  check(typeof info?.r === 'string' && info.r.startsWith(ASAR + '/'), 'node-pty resolves from inside the bundle asar', info?.r ?? info?.__error)
  check(info?.helperOnDisk === true, 'spawn-helper is on disk under app.asar.unpacked', info?.helper)
  check(info?.arch === 'arm64', 'main process is arm64', info?.arch)
  check(info?.exec === BIN, 'execPath is the packaged binary', info?.exec)
  const rt = await m.evaluate(`new Promise((resolve) => {
    const require = process.mainModule.require('module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json'); const pty = require('node-pty'); const os = require('os')
    let out = ''; let t
    try {
      const p = pty.spawn('/bin/zsh', ['-f'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: process.env })
      p.onData((d) => { out += d })
      p.onExit(({ exitCode }) => { clearTimeout(t); resolve({ exitCode, pid: p.pid, ok: /PTY_OK_42/.test(out), tail: out.slice(-200) }) })
      setTimeout(() => p.write('echo PTY_OK_$((6*7)); exit\\r'), 500)
      t = setTimeout(() => resolve({ timeout: true, tail: out.slice(-200) }), 8000)
    } catch (e) { resolve({ threw: String(e && e.stack || e) }) }
  })`)
  console.log('  pty:', JSON.stringify(rt))
  check(rt?.ok === true, 'packaged main spawned a zsh pty and echoed through it')
  check(rt?.exitCode === 0, 'pty exit code 0', String(rt?.exitCode))
  m.ws.close()
}

// ── 2. renderer: CSP vs xterm.js ──────────────────────────────────────────────────────────
const page = await attach(CDP, (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
check(!!page, 'renderer page target found', page?.url)
if (page) {
  const r = await client(page.webSocketDebuggerUrl)
  await r.send('Runtime.enable'); await r.send('Log.enable')
  const csp = await r.evaluate(`(() => { window.__viol = []; document.addEventListener('securitypolicyviolation', (e) => window.__viol.push(e.violatedDirective + ' ' + (e.blockedURI||'') + ' ' + e.sourceFile + ':' + e.lineNumber)); return location.href })()`)
  console.log('  page:', csp)
  // positive control — the CSP must refuse an inline script in this document
  const ctl = await r.evaluate(`(() => { const s = document.createElement('script'); s.textContent = 'window.__inline_ran = true'; document.head.appendChild(s); return new Promise((res) => setTimeout(() => res({ ran: !!window.__inline_ran, viol: window.__viol.slice() }), 300)) })()`)
  check(ctl?.ran === false && ctl.viol.some((v) => v.startsWith('script-src')), 'CSP is ON: inline <script> refused (positive control)', JSON.stringify(ctl))
  await r.evaluate(`window.__viol = []`)
  r.events.length = 0
  // xterm.css from INSIDE the packaged asar, as the built app would reference it
  const cssUrl = 'file://' + ASAR + '/node_modules/@xterm/xterm/css/xterm.css'
  const css = await r.evaluate(`new Promise((resolve) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(cssUrl)}; l.onload = () => resolve('load'); l.onerror = () => resolve('error'); document.head.appendChild(l); setTimeout(() => resolve('timeout'), 5000) })`)
  check(css === 'load', 'packaged xterm.css loaded under the CSP', String(css))
  // xterm.js itself: evaluated over CDP (CDP is not subject to the page CSP) — we are testing
  // the STYLESHEET + xterm's runtime <style> injection, not script delivery (Vite bundles it as 'self').
  const src = readFileSync(join(REPO, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8')
  await r.send('Runtime.evaluate', { expression: src + '\n;window.__X = (typeof Terminal !== "undefined" ? Terminal : window.Terminal);' })
  const term = await r.evaluate(`new Promise((resolve) => {
    const X = window.__X && (window.__X.Terminal || window.__X)
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:320px;z-index:99999;background:#000'; document.body.appendChild(host)
    const t = new X({ cols: 60, rows: 10, fontFamily: '"JetBrains Mono Variable", monospace' })
    t.open(host)
    t.write('CSP_XTERM_OK_' + (6*7) + '\\r\\n', () => setTimeout(() => {
      const rows = host.querySelector('.xterm-rows')
      const ta = host.querySelector('.xterm-helper-textarea')
      const cs = ta && getComputedStyle(ta)
      const row = rows && rows.firstElementChild
      resolve({
        text: rows ? rows.textContent.slice(0, 80) : null,
        helperOffscreen: cs ? (cs.position === 'absolute' && cs.opacity === '0') : null,   // rule from xterm.css
        rowHeight: row ? row.getBoundingClientRect().height : 0,                            // rule from xterm's injected <style>
        styleEls: document.querySelectorAll('style').length,
        viol: window.__viol.slice()
      })
    }, 300))
  })`)
  console.log('  xterm:', JSON.stringify(term))
  check(typeof term?.text === 'string' && term.text.includes('CSP_XTERM_OK_42'), 'xterm rendered text in the packaged document')
  check(term?.helperOffscreen === true, 'xterm.css rules APPLIED (helper textarea positioned by the sheet)')
  check(term?.rowHeight > 0, 'xterm runtime <style> injection applied (row has a height)', String(term?.rowHeight))
  check(Array.isArray(term?.viol) && term.viol.length === 0, 'zero CSP violations while mounting xterm', JSON.stringify(term?.viol))
  await sleep(500)
  const refused = r.events.filter((e) => e.method === 'Log.entryAdded' && /Refused|Content Security Policy/i.test(e.params.entry.text)).map((e) => e.params.entry.text)
  check(refused.length === 0, 'no "Refused" console lines from the page', refused.join(' | ').slice(0, 400))
  r.ws.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
reap()
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500)
