#!/usr/bin/env node
// connectors-app-probe — Config → Connectors IN THE REAL APP, against a stand-in Prometheus on
// loopback: a server at an address is added with a token, the token goes out ONCE in that POST and
// is afterwards nowhere (not in the page, not in any file of the profile), a refusal that quotes it
// is blanked, and a Beacon that signs in with a device key is told plainly why it cannot change the
// list instead of being offered a form that would be refused.
//
//   npm run build && npm run probe:connectors
//
// Its own scratch profile and its own fake daemon: the user's profile and Prometheus are not touched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const TOKEN = `tok_probe_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

// ── the stand-in Prometheus ───────────────────────────────────────────────────────────────────
const daemon = { mainKey: true, servers: [], posts: [], refuseNext: null, devicesDelayMs: 0, dropNext: false }
const listed = (s) => ({ name: s.name, source: 'store', enabled: true, url: s.url, transport: s.transport, header_names: Object.keys(s.headers ?? {}).sort(), health: { state: 'connected', transport: 'http', detail: '' }, tools: [{ tool_name: 'search', description: 'Search notes', read_only_hint: true }] })
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0]
    if (url === '/api/hello') return json(res, 200, { v: '0.9.20', name: 'Stand-in', agent: 'Atlas', fp: 'e'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    // The main key is no device (no row of its own); a device key has one, here an owner's.
    if (url === '/api/devices') return void setTimeout(() => json(res, 200, daemon.mainKey ? [{ id: 'd1', name: 'Phone', owner: false }] : [{ id: 'd0', name: 'This Beacon', owner: true, is_self: true }]), daemon.devicesDelayMs)
    if (url === '/api/mcp/servers' && req.method === 'GET') return json(res, 200, { wired: true, servers: daemon.servers.map(listed) })
    if (url === '/api/mcp/servers' && req.method === 'POST') {
      daemon.posts.push(body)
      if (!daemon.mainKey) return json(res, 401, { error: 'defining an MCP server starts a process on this host; that requires the global token, not a device token' })
      if (daemon.refuseNext) {
        const r = daemon.refuseNext
        daemon.refuseNext = null
        return json(res, 400, { error: r(JSON.parse(body)) })
      }
      daemon.servers.push(JSON.parse(body))
      // A Prometheus that stored the server and then never answered (it is still connecting to it
      // when Beacon stops waiting): the socket just goes away.
      if (daemon.dropNext) {
        daemon.dropNext = false
        return void req.socket.destroy()
      }
      return json(res, 200, { ok: true, applies: 'live' })
    }
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const api = `http://127.0.0.1:${rest.address().port}`
const wsUrl = `ws://127.0.0.1:${wsHttp.address().port}`

const profile = mkdtempSync(join(tmpdir(), 'beacon-connectors-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('standin', '${api}', '${wsUrl}', 1, NULL);`])

/** Every file under the profile that contains `needle`, as raw bytes. */
function filesHolding(dir, needle, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) filesHolding(full, needle, out)
    else if (e.isFile() && statSync(full).size < 64 * 1024 * 1024 && readFileSync(full).includes(needle)) out.push(full.slice(profile.length + 1))
  }
  return out
}

let app = null
try {
  app = await launchApp({ profile })
  const ev = app.page.evaluate
  const until = async (fn, pred, ms = 6000) => {
    let v
    for (let t = 0; t < ms; t += 100) {
      v = await fn()
      if (pred(v)) return v
      await sleep(100)
    }
    return v
  }
  check((await until(() => ev(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)) === 'connected', 'connected to the stand-in Prometheus')
  const openTab = async () => {
    await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Mission' || x.title === 'Today'); b?.click(); return true })()`)
    await sleep(200)
    await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Config'); b?.click(); return true })()`)
    await until(() => ev(`!!document.querySelector('[data-testid="config-tab-groups"]')`), (v) => v === true)
    await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="config-tab-groups"] button')].find((x) => x.textContent.trim() === 'Connectors'); b?.click(); return true })()`)
  }
  const text = () => ev(`document.querySelector('[data-testid="config-tab-groups"]')?.closest('div')?.parentElement?.parentElement?.innerText ?? document.body.innerText`)
  const button = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`
  const click = (label) => ev(`(() => { const b = ${button(label)}; if (!b || b.disabled) return false; b.click(); return true })()`)
  const field = (aria) => `document.querySelector('input[aria-label=${JSON.stringify(aria)}]')`
  const type = (aria, v) => ev(`(() => { const el = ${field(aria)}; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const status = () => ev(`[...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).filter(Boolean).join(' | ')`)

  // ── the main key: the form ──────────────────────────────────────────────────────────────────
  await openTab()
  check((await until(() => ev(`!!${button('＋ Add server')}`), (v) => v === true)) === true, 'with the main key, Connectors offers Add server')
  check(!(await text()).includes('needs the main key'), 'and no main-key note')
  await click('＋ Add server')
  check((await until(() => ev(`!!${field('Server address')}`), (v) => v === true)) === true, 'the form opens on "At an address"')
  check((await ev(`${field('Token')}?.type`)) === 'password', 'the token field is a password field')

  await type('Server name', 'notes')
  await type('Server address', 'http://example.com/mcp')
  await type('Token', TOKEN)
  await click('Add')
  check(/Use https:\/\//.test(await until(status, (v) => v.length > 0)), 'plain http to the internet is refused in the form', await status())
  check(daemon.posts.length === 0, 'and nothing was sent')

  // A refusal that quotes the header back: it must be blanked on screen.
  await type('Server address', 'https://example.com/mcp')
  daemon.refuseNext = (b) => `header 'Authorization' value ${b.headers.Authorization} was not accepted`
  await click('Add')
  const refusal = await until(status, (v) => /did not accept/.test(v))
  check(/did not accept that: header 'Authorization' value ••• was not accepted/.test(refusal), "a refusal that quotes the token shows ••• in its place", refusal)
  check(!refusal.includes(TOKEN), 'the token is not in the message')
  check((await ev(`${field('Token')}?.value`)) === '', 'the token field was emptied when the answer came')
  check((await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)})`)) === false, 'and the token is nowhere in the page while the form is still open')
  check((await ev(`!!${field('Server address')}`)) === true, 'the form stays open to try again')

  // The real add.
  await type('Token', TOKEN)
  await click('Add')
  check((await until(() => Promise.resolve(daemon.servers.length), (v) => v === 1)) === 1, 'the server was added')
  const sent = JSON.parse(daemon.posts.at(-1))
  check(JSON.stringify(sent) === JSON.stringify({ name: 'notes', url: 'https://example.com/mcp', transport: 'streamable-http', headers: { Authorization: `Bearer ${TOKEN}` } }), 'the POST carried the address, the transport and the one sign-in header', JSON.stringify(sent).replace(TOKEN, '<token>'))
  check(daemon.posts.filter((p) => p.includes(TOKEN)).length === 2, 'the token left Beacon only in the POSTs the person pressed Add for (the refused one and this one)')
  const card = await until(text, (v) => /Signs in with a token Prometheus keeps \(Authorization\)/.test(v))
  check(/Signs in with a token Prometheus keeps \(Authorization\)\. It is never shown here\./.test(card), 'its card says it signs in with a token Prometheus keeps, by header name only')
  check((await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)})`)) === false, 'the token is nowhere in the page')
  check((await ev(`[...document.querySelectorAll('input')].some((i) => i.value.includes(${JSON.stringify(TOKEN)}))`)) === false, 'nor in any input')
  await sleep(1200) // let any debounced write land before reading the profile's files
  const holding = filesHolding(profile, TOKEN)
  check(holding.length === 0, 'and in no file of the profile: settings, cache, logs', holding.join(', ') || 'none')
  check(filesHolding(profile, 'standin').length > 0, 'the control: that search does find a string the profile holds')
  const logged = app.log.join("").includes(TOKEN)
  if (logged) console.log("[probe] where: " + app.log.join("").split("\n").filter((l) => l.includes(TOKEN)).map((l) => l.replaceAll(TOKEN, "<token>").slice(0, 260)).join("\n[probe] where: "))
  check(!logged, "nor in the app's own output")

  // ── no answer: the server was stored, the reply never came ──────────────────────────────────
  await click('＋ Add server')
  await until(() => ev(`!!${field('Server address')}`), (v) => v === true)
  await type('Server name', 'slow')
  await type('Server address', 'https://slow.example.com/mcp')
  await type('Token', TOKEN)
  daemon.dropNext = true
  await click('Add')
  const after = await until(text, (v) => /did not answer in time/.test(v), 8000)
  check(/Prometheus did not answer in time\. It may still be connecting to the server/.test(after), 'a write with no answer says so, and does not call it a refusal', after.slice(0, 160))
  check(!/Enter the token again/.test(after), 'and does not ask for the token again')
  check((await until(text, (v) => /slow/.test(v) && /slow\.example\.com/.test(v))).includes('slow.example.com'), 'the list was read again, and shows the server Prometheus did store')
  check((await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)})`)) === false, 'the token is not in the page after that either')

  // ── a device key: the note, and nothing that would be refused ───────────────────────────────
  // The answer to "which key is this" is held back, to look at the moment before it comes.
  daemon.mainKey = false
  daemon.devicesDelayMs = 2500
  await sleep(5200) // past the few seconds the tab remembers its last answer
  await openTab()
  await until(text, (v) => /notes/.test(v))
  check((await ev(`!!${button('＋ Add server')} || !!${button('Remove')} || !!${button('Disable')}`)) === false, 'before the answer comes, no write control is on screen: a click cannot land in the gap')
  check(!(await text()).includes('needs the main key'), 'and nothing is claimed yet either')
  const note = await until(text, (v) => /needs the main key/.test(v), 8000)
  check(/Adding or changing tool servers needs the main key/.test(note) && /Settings → Connection → Advanced/.test(note), 'with a device key, Connectors says plainly that changes need the main key, and where to enter it')
  check(!/global token|HTTP 401/.test(note), "in Beacon's words, not the daemon's")
  check((await ev(`!!${button('＋ Add server')}`)) === false, 'Add server is not offered')
  check((await ev(`!!${button('Remove')} || !!${button('Disable')}`)) === false, 'nor Disable or Remove on the card')
  check(/notes/.test(note) && /connected · 1 tool/.test(note), 'the list itself is still shown')
  // Were such a write sent anyway, its refusal is about that route, not about this Beacon's key:
  // it must not turn the whole app to "key refused".
  const refusedWrite = await ev(`window.beacon.daemon.write('/api/mcp/servers', { name: 'x', command: 'true' }, 'POST').then(() => 'accepted', (e) => String(e.message))`)
  check(/HTTP 401/.test(refusedWrite), 'the control: Prometheus does refuse a device key that write', refusedWrite.slice(0, 120))
  await sleep(400)
  const auth = await ev(`window.beacon.connection.status().then((s) => s.restAuth)`)
  check(auth !== 'unauthorized', "and that refusal does not mark this Beacon's key as rejected across the app", String(auth))
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
