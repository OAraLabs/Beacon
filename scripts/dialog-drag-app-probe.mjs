// Dialogs over drag regions, in the real app at a 1512×944 window: a window-drag region (`-webkit-app-region: drag`) sits ABOVE the
// page for the OS, so a control drawn over one can't be clicked: the click drags the window. Mission Control's header and an open
// conversation's header are drag regions at the height where Connection Settings puts "Advanced", which is how adding a second
// Prometheus failed on a real Mac. For Settings opened with ⌘, (the real menu item) from every view, and for the connection popover
// and the command palette, no control inside may sit on a drag region. And Settings keeps keyboard focus: Tab cycles only through
// its own controls, Esc closes it.
//
// CDP clicks skip drag regions, so this checks geometry against the computed `-webkit-app-region` of every element, not by clicking.
//
//   npm run build && npm run probe:dialog-drag
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 25
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const now = Math.floor(Date.now() / 1000)
const rest = createServer((req, res) => {
  const url = req.url ?? ''
  if (url === '/api/hello') return json(res, 200, { v: '0.9.17', name: 'Stand-in', agent: 'Atlas', fp: 'a'.repeat(16), pair: 'approve', tls: false })
  if (url === '/api/sessions') return json(res, 200, [{ session_id: 'beacon:3b8e1c2a-5d4f-4a6b-9c7d-1e2f3a4b5c6d', gateway: 'beacon', title: 'A conversation', created_at: now, last_active: now, message_count: 0 }])
  if (url.startsWith('/api/sessions/')) return json(res, 200, { messages: [], watermark: 0 })
  if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub' })
  json(res, 404, {})
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const profile = mkdtempSync(join(tmpdir(), 'beacon-dialog-drag-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('mini', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])

const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}

/** In the page: the controls under `rootExpr` whose centre sits on a drag region, as "label @y". */
const coveredIn = (rootExpr) => `(() => {
  const root = ${rootExpr}
  if (!root) return null
  const drag = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).webkitAppRegion === 'drag').map((e) => e.getBoundingClientRect())
  const controls = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((e) => e.getClientRects().length > 0)
  const covered = controls.filter((e) => { const q = e.getBoundingClientRect(); const x = q.x + q.width / 2, y = q.y + q.height / 2; return drag.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) })
  return { controls: controls.length, covered: covered.map((e) => ((e.innerText || e.getAttribute('aria-label') || e.placeholder || e.tagName).trim().slice(0, 40)) + ' @' + Math.round(e.getBoundingClientRect().y)) }
})()`
const SETTINGS = `(document.querySelector('[role="dialog"][aria-label="Connection Settings"]') ?? [...document.querySelectorAll('h2')].find((h) => h.innerText.trim() === 'Connection Settings')?.parentElement?.parentElement)`
const KEYS = { Tab: 9, Escape: 27 }
let app = null
const press = async (key, shift = false) => {
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers: shift ? 8 : 0 }
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(80)
}
const openSettingsFromMenu = `(() => { const find = (items) => { for (const it of items) { if (it.label === 'Settings…') return it; if (it.submenu) { const f = find(it.submenu.items); if (f) return f } } return null }; find(__electron.Menu.getApplicationMenu().items).click(); return true })()`

try {
  app = await launchApp({ profile })
  await app.mainEval(`(() => { __electron.BrowserWindow.getAllWindows()[0].setContentSize(1512, 944); return true })()`)
  check(!!(await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)), 'connected to the stand-in')

  for (const view of ['Mission', 'Chats', 'Coding', 'Workspace', 'Activity', 'Config']) {
    await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="${view}"]')?.click(); true`)
    await sleep(600)
    if (view === 'Chats') {
      await until(() => app.page.evaluate(`!!document.querySelector('.session-row')`), 8000)
      await app.page.evaluate(`document.querySelector('.session-row')?.click(); true`)
      const head = await until(() => app.page.evaluate(`(() => { const h = document.querySelector('.thread-head'); return h && getComputedStyle(h).webkitAppRegion === 'drag' ? Math.round(h.getBoundingClientRect().x) + ',' + Math.round(h.getBoundingClientRect().y) : null })()`), 8000)
      check(!!head, 'Chats: a conversation is open, its header a drag region', head)
    }
    const label = view === 'Chats' ? 'Chats, a conversation open' : view
    await app.mainEval(openSettingsFromMenu)
    const open = await until(() => app.page.evaluate(`!!${SETTINGS}`), 5000)
    // Advanced opened by script: its fields are what the person needs to reach.
    await app.page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.startsWith('Advanced: how Beacon reaches')); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true })()`)
    await sleep(300)
    const c = await app.page.evaluate(coveredIn(SETTINGS))
    check(!!open && !!c && c.controls >= 6 && c.covered.length === 0, `${label}: Settings (⌘,) has no control on a drag region`, JSON.stringify(c))

    // Focus: Tab and Shift-Tab stay inside, Esc closes.
    const inside = () => app.page.evaluate(`(() => { const r = ${SETTINGS}; return !!r && r.contains(document.activeElement) })()`)
    let stayed = true
    for (let i = 0; i < (c?.controls ?? 6) + 3; i++) {
      await press('Tab')
      if (!(await inside())) stayed = false
    }
    for (let i = 0; i < 3; i++) {
      await press('Tab', true)
      if (!(await inside())) stayed = false
    }
    check(stayed, `${label}: Tab and Shift-Tab keep focus inside Settings`, await app.page.evaluate(`(document.activeElement?.innerText || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || '').slice(0, 60)`))
    await press('Escape')
    const closed = await until(async () => !(await app.page.evaluate(`!!${SETTINGS}`)), 2000)
    check(!!closed, `${label}: Esc closes Settings`)
    if (!closed) await app.page.evaluate(`document.querySelector('[aria-label="Close"]')?.click(); true`)
    await sleep(300)
  }

  // Each ⌘, left one line saying what changed the view (src/shared/view-trail.ts), in the profile's logs.
  const logFile = join(profile, 'logs', 'view-trail.log')
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []
  const chatLine = lines.find((l) => / on chat;/.test(l)) ?? ''
  check(lines.length === 6 && lines.every((l) => l.includes('settings opened (menu or tray)')), 'each ⌘, wrote one line to logs/view-trail.log', lines.join('\n').slice(0, 400))
  check(/mission → chat after click Chats/.test(chatLine) && /renderer up \d/.test(chatLine), 'the line for Chats says how the view got there, and how long the page has been up', chatLine)

  // The connection popover and the command palette, from Mission Control (its header is a drag region).
  await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Mission"]')?.click(); true`)
  await sleep(600)
  await app.page.evaluate(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Connection status'))?.click(); true`)
  const pop = await until(() => app.page.evaluate(coveredIn(`document.querySelector('[role="dialog"][aria-label="Connection details"]')`)), 3000)
  check(!!pop && pop.controls >= 2 && pop.covered.length === 0, 'the connection popover has no control on a drag region', JSON.stringify(pop))
  await app.page.evaluate(`document.querySelector('[role="dialog"][aria-label="Connection details"]')?.previousElementSibling?.click(); true`)
  await sleep(300)
  await app.page.evaluate(`document.querySelector('.app-chrome-cmdk')?.click(); true`)
  const pal = await until(() => app.page.evaluate(coveredIn(`document.querySelector('[role="dialog"][aria-label^="Command"]')`)), 3000)
  check(!!pal && pal.controls >= 1 && pal.covered.length === 0, 'the command palette has no control on a drag region', JSON.stringify(pal))
  await press('Escape')
  await sleep(300)
  const free = await app.page.evaluate(`[...document.querySelectorAll('.topbar, .app-chrome')].every((e) => getComputedStyle(e).webkitAppRegion === 'drag')`)
  check(free, 'with nothing open, the title bar and the view header drag the window again')
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  rest.close()
  wsHttp.close()
  rmSync(profile, { recursive: true, force: true })
}
if (failures || checks < MIN_CHECKS) {
  console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
  process.exit(1)
}
console.log(`\n[probe] OK — ${checks} checks passed`)
