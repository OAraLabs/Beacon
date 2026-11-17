// Approving a phone that asked to join (the phone-onboarding plan, desktop item 2), in the real app: a stand-in Prometheus lists one
// waiting request (its device name chosen by the requester) and takes approve/deny the way Prometheus's join-request routes do. The
// prompt's button says "Approve as chat-only" (what Prometheus grants: an ordinary, scoped device); "Make it an owner…" shows the steps
// and exactly `oara pair --owner`, which Copy puts on the clipboard, and Enter on Copy copies without approving. Not now sets it aside;
// Config → Devices lists it under "Waiting to join", and Review brings the prompt back. Approve sends the typed digits and nothing that
// asks for more than chat.
//
//   npm run build && npm run probe:approve-phone
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
const MIN_CHECKS = 11
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const RID = 'a1'.repeat(16)
const now = Math.floor(Date.now() / 1000)
const pending = { request_id: RID, device_name: "Alex's iPhone", platform: 'ios', source_ip: '192.0.2.7', match_code: '4821', created_at: now, expires_at: now + 300, ttl_seconds: 300 }
let state = 'pending'
const decisions = []
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = req.url ?? ''
    if (url === '/api/hello') return json(res, 200, { v: '0.9.20', name: 'Stand-in', agent: 'Atlas', fp: 'a'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/pair/requests' && req.method === 'GET') return json(res, 200, { requests: state === 'pending' ? [pending] : [] })
    const m = /^\/api\/pair\/requests\/([0-9a-f]{32})\/(approve|deny)$/.exec(url)
    if (m && req.method === 'POST') {
      decisions.push({ verb: m[2], body: body ? JSON.parse(body) : null })
      if (m[2] === 'approve') {
        const b = body ? JSON.parse(body) : {}
        if (Object.keys(b).some((k) => !['name', 'match_code'].includes(k))) return json(res, 400, { error: 'invalid_request', fields: Object.keys(b) })
        if (b.match_code !== undefined && b.match_code !== pending.match_code) return json(res, 422, { error: 'code_mismatch' })
        state = 'approved'
        return json(res, 200, { request_id: RID, status: 'approved', device_id: 'dev-1', name: pending.device_name, platform: 'ios' })
      }
      state = 'denied'
      return json(res, 200, { request_id: RID, status: 'denied' })
    }
    if (url.startsWith('/api/status')) return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub' })
    if (url === '/api/devices') return json(res, 200, { devices: [] })
    json(res, 404, {})
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const profile = mkdtempSync(join(tmpdir(), 'beacon-approve-phone-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('Home mini', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const PROMPT = `document.querySelector('[data-pair-prompt] [role="dialog"]')`
const buttonIn = (root, text) => `[...(${root}?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(text)})`
let app = null
let clipboardBefore = null // the person's own clipboard, put back at the end (Copy writes the real one)
try {
  app = await launchApp({ profile })
  clipboardBefore = await app.mainEval(`__electron.clipboard.readText()`)
  check(!!(await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)), 'connected to the stand-in')
  const shown = await until(() => app.page.evaluate(`${PROMPT}?.innerText ?? null`), 10000)
  check(!!shown && shown.includes("Alex's iPhone"), 'the prompt shows the waiting request', shown)
  check(!!(await app.page.evaluate(`!!${buttonIn(PROMPT, 'Approve as chat-only')}`)), 'its button says "Approve as chat-only"')

  // Make it an owner…: the steps and exactly the command; Copy copies; Enter on Copy does not approve.
  await app.page.evaluate(`document.querySelector('[data-testid="make-owner-how"]').click(); true`)
  const steps = await until(() => app.page.evaluate(`document.querySelector('[data-testid="owner-steps"]')?.innerText ?? null`), 3000)
  check(!!steps && /chat-only/.test(steps) && /eight digits/.test(steps) && /Terminal on this Mac/.test(steps), "the steps: chat-only first, the command on this Mac (it's reached at 127.0.0.1), eight digits on the phone", steps)
  check((await app.page.evaluate(`document.querySelector('[data-testid="owner-command"]')?.innerText.trim()`)) === 'oara pair --owner', 'the command, exactly: oara pair --owner')
  await app.mainEval(`(() => { __electron.clipboard.writeText('before'); return true })()`)
  await app.page.evaluate(`(() => { const f = document.querySelector('input[inputmode="numeric"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(f, '4821'); f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await app.page.evaluate(`document.querySelector('[data-testid="owner-copy"]').focus(); true`)
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const clip = await until(async () => { const c = await app.mainEval(`__electron.clipboard.readText()`); return c === 'oara pair --owner' ? c : null }, 3000)
  check(clip === 'oara pair --owner', 'Copy put exactly the command on the clipboard', await app.mainEval(`__electron.clipboard.readText()`))
  await sleep(500)
  check(decisions.length === 0 && state === 'pending', 'and Enter on Copy approved nothing', JSON.stringify(decisions))

  // Not now, then Config → Devices → Review brings it back.
  await app.page.evaluate(`${buttonIn(PROMPT, 'Not now')}.click(); true`)
  check(!!(await until(async () => !(await app.page.evaluate(`!!${PROMPT}`)), 3000)), 'Not now sets it aside')
  await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Config"]')?.click(); true`)
  await until(() => app.page.evaluate(`!!document.querySelector('[data-testid="config-tab-groups"]')`), 8000)
  await app.page.evaluate(`[...document.querySelectorAll('button, [role="tab"]')].find((b) => b.innerText.trim() === 'Devices')?.click(); true`)
  const listed = await until(() => app.page.evaluate(`document.querySelector('[data-testid="waiting-to-join"]')?.innerText ?? null`), 8000)
  check(!!listed && /Waiting to join/i.test(listed) && listed.includes("Alex's iPhone"), 'Config → Devices lists it under "Waiting to join"', listed)
  await app.page.evaluate(`document.querySelector('[data-testid="review-join"]').click(); true`)
  check(!!(await until(() => app.page.evaluate(`!!${PROMPT}`), 3000)), 'Review brings the prompt back')

  // Approve as chat-only, with the typed digits: the body asks for nothing more.
  await app.page.evaluate(`(() => { const f = document.querySelector('input[inputmode="numeric"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(f, '4821'); f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await app.page.evaluate(`${buttonIn(PROMPT, 'Approve as chat-only')}.click(); true`)
  const done = await until(async () => (state === 'approved' ? true : null), 5000)
  check(!!done && decisions.length === 1 && decisions[0].verb === 'approve' && JSON.stringify(Object.keys(decisions[0].body ?? {})) === '["match_code"]' && decisions[0].body.match_code === '4821', 'Approve sends only the typed digits (nothing asks for owner)', JSON.stringify(decisions))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app && typeof clipboardBefore === 'string') await app.mainEval(`(() => { __electron.clipboard.writeText(${JSON.stringify(clipboardBefore)}); return true })()`).catch(() => undefined)
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
