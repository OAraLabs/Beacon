#!/usr/bin/env node
// soul-app-probe — Config › Soul IN THE REAL APP, against a stand-in Prometheus on loopback that answers
// GET /api/soul as Prometheus does (scripts/fixtures/soul.json): the document, and each statement about the file.
//
//   npm run build && npm run probe:soul
//
// PROBE_SHOT_DIR=<dir> writes screenshots there. Own scratch profile and stand-in daemon.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if ((k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) && k !== 'PROBE_SHOT_DIR') delete process.env[k]
const SHOTS = process.env.PROBE_SHOT_DIR
let failures = 0
let checks = 0
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const FX = JSON.parse(readFileSync(new URL('./fixtures/soul.json', import.meta.url), 'utf8'))
const HOSTILE = { content: '# Soul\n\n<img src=x onerror="window.__soulPwn=1">\n<script>window.__soulPwn=2</script>\n[a link](https://evil.example/)\n', bytes: 120, modified_at: 1793667600 }
const BIG = { content: 'line of persona\n'.repeat(8000), bytes: 128000, modified_at: 1793667600 }

const state = { mode: 'document', gets: 0, other: [] }
const answer = (res) => {
  switch (state.mode) {
    case 'document': return json(res, 200, FX.document)
    case 'hostile': return json(res, 200, HOSTILE)
    case 'big': return json(res, 200, BIG)
    case 'empty': return json(res, 200, { content: '\n  \n', bytes: 4, modified_at: 1793667600 })
    case 'fault': return json(res, 500, { error: 'boom' })
    default: {
      const r = FX.refusals[state.mode]
      return json(res, r.status, r.body)
    }
  }
}
const rest = createServer((req, res) => {
  req.on('data', () => undefined)
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url === '/api/soul') {
      state.gets++
      if (req.method !== 'GET') state.other.push(`${req.method} ${url}`)
      return answer(res)
    }
    if (req.method !== 'GET' && !/identity\/challenge/.test(url)) state.other.push(`${req.method} ${url}`)
    if (url === '/api/hello') return json(res, 200, { v: '0.9.22', name: 'Stand-in', agent: 'Atlas', fp: 'e'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/devices') return json(res, 200, [])
    if (url === '/api/memory/current') return json(res, 200, { memory: { entries: [], char_count: 0, char_limit: 2200, entry_count: 0, content: '' }, user: { entries: [], char_count: 0, char_limit: 1375, entry_count: 0, content: '' } })
    if (url === '/api/sessions') return json(res, 200, [])
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let f = null
    try { f = JSON.parse(raw.toString()) } catch { return }
    if (f?.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: [], server_capabilities: [], channels: [] } }))
  })
  ws.send(JSON.stringify({ type: 'connected' }))
})
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const profile = mkdtempSync(join(tmpdir(), 'beacon-soul-profile-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('standin', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])

let app = null
try {
  app = await launchApp({ profile })
  const ev = app.page.evaluate
  const until = async (fn, pred, ms = 8000) => {
    let v
    for (let t = 0; t < ms; t += 150) {
      v = await fn()
      if (pred(v)) return v
      await sleep(150)
    }
    return v
  }
  const shot = async (name) => {
    if (!SHOTS) return
    mkdirSync(SHOTS, { recursive: true })
    const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data ?? r.result?.data, 'base64'))
    console.log(`[probe] shot: ${name}.png`)
  }
  check((await until(() => ev(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)) === 'connected', 'connected to the stand-in Prometheus')
  await until(() => ev(`window.beacon.connection.status().then((s) => s.role ?? 'owner')`), (v) => v === 'owner', 5000)
  await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Config'); b?.click(); return true })()`)
  await until(() => ev(`!!document.querySelector('[data-testid="config-tab-groups"]')`), (v) => v === true, 10000)
  const tabs = await ev(`[...document.querySelectorAll('[data-testid="config-tab-groups"] button')].map((b) => b.textContent.trim())`)
  const at = tabs.indexOf('Soul')
  check(at > 0 && tabs[at - 1] === 'Memory', 'Config has a Soul tab right after Memory', tabs.join(' | '))
  const tabBtn = (name) => ev(`(() => { const b = [...document.querySelectorAll('[data-testid="config-tab-groups"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(name)}); b?.click(); return !!b })()`)
  const view = () => ev(`(() => { const s = document.querySelector('[data-testid="soul"]'); const st = document.querySelector('[data-testid="soul-statement"]'); return { doc: !!s, text: document.querySelector('[data-testid="soul-text"]')?.textContent ?? null, size: document.querySelector('[data-testid="soul-size"]')?.textContent ?? null, edited: document.querySelector('[data-testid="soul-edited"]')?.textContent ?? null, empty: document.querySelector('[data-testid="soul-empty"]')?.textContent ?? null, statement: st?.innerText ?? null, retry: !!st?.querySelector('button'), editable: !!document.querySelector('[data-testid="soul"] textarea, [data-testid="soul"] input, [data-testid="soul"] [contenteditable]'), note: s?.innerText ?? '' } })()`)
  /** Open Soul fresh: another tab and back, so it asks again. */
  const open = async (mode, pred) => {
    state.mode = mode
    await tabBtn('Memory')
    await sleep(300)
    await tabBtn('Soul')
    return until(view, pred, 6000)
  }

  const doc = await open('document', (v) => v.doc)
  check(doc.doc && /^# Soul/.test(doc.text ?? '') && /Never invent a fact/.test(doc.text ?? ''), 'the persona is shown, as the daemon sent it', doc.text)
  check(doc.size === '189 bytes' && doc.edited === 'Edited 2026-11-03. This is the file Prometheus puts into every prompt.', 'with its size and the day it was last edited', JSON.stringify([doc.size, doc.edited]))
  check(/Read-only\./.test(doc.note) && !doc.editable, 'it says read-only and offers no way to edit')
  await shot('soul-document')
  const refusals = [
    ['missing', /^This Prometheus has no persona file yet\.$/],
    ['link', /is a link, so Prometheus won't read it/],
    ['too_large', /over 256 KB, which is too large to show here/],
    ['unreadable', /couldn't read its persona file/],
    ['route_absent', /too old to show its persona/]
  ]
  for (const [mode, re] of refusals) {
    const v = await open(mode, (x) => x.statement !== null)
    check(re.test(v.statement ?? '') && !v.retry && !/\b[45]\d\d\b|HTTP|\/api\/|error/i.test(v.statement ?? ''), `${mode}: a plain sentence, no code and no retry`, v.statement)
    if (mode === 'route_absent') await shot('soul-old-daemon')
  }
  const fault = await open('fault', (x) => x.statement !== null)
  check(/couldn't read the persona just now/.test(fault.statement ?? '') && fault.retry, 'a fault is "couldn\'t read just now", with Try again', fault.statement)
  state.mode = 'document'
  await ev(`document.querySelector('[data-testid="soul-statement"] button').click(); true`)
  const back = await until(view, (v) => v.doc, 6000)
  check(back.doc, 'Try again reads it again, and the persona comes up')
  const empty = await open('empty', (v) => v.doc)
  check(empty.empty === 'The persona file is empty.' && empty.text === null, 'an empty file is said to be empty')
  const hostile = await open('hostile', (v) => v.doc)
  const pwn = await ev(`({ flag: window.__soulPwn ?? null, imgs: document.querySelectorAll('[data-testid="soul"] img, [data-testid="soul"] script, [data-testid="soul"] a').length })`)
  check(pwn.flag === null && pwn.imgs === 0 && /<img src=x/.test(hostile.text ?? '') && /\[a link\]\(https:\/\/evil\.example\/\)/.test(hostile.text ?? ''), 'markup in the persona is shown as text: nothing runs, no image, no link', JSON.stringify(pwn))
  await shot('soul-hostile-text')
  const big = await open('big', (v) => v.doc)
  check(/Showing the first 100,000 of 128,000 characters\./.test(big.note) && (big.text ?? '').length === 100000 && big.size === '125.0 KB', 'a long persona is clipped, and says how much', big.size)
  check(state.other.length === 0, 'nothing but reads reached Prometheus: no write, no edit', state.other.join(' | '))
  check(state.gets >= 9, `each opening asked for it again (${state.gets} reads)`)
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
