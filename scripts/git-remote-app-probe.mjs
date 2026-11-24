#!/usr/bin/env node
// git-remote-app-probe — git state from a Prometheus that advertises git/1, IN THE REAL APP,
// against a stand-in Prometheus on loopback that is NOT on this computer's disk: its folders do
// not exist here, and the shared-disk proof is refused. The answers it serves are the ones
// Prometheus 0.9.22 captured (scripts/fixtures/git-status-0.9.22.json).
//
//   npm run build && npm run probe:git-remote
//
// Phase A: git/1 advertised: rows and chip come from the route, a `workspace_git_changed` frame
//          makes a row read again, the Git pane says why it has no file list, nothing is sent.
// Phase B: git/1 not advertised: the route is never asked.
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
const json = (res, code, body, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
const FX = JSON.parse(readFileSync(new URL('./fixtures/git-status-0.9.22.json', import.meta.url), 'utf8'))
const answer = (name) => FX[name].body

const SESSIONS = [
  { id: 'beacon:r-changed', title: 'Rework the site header', fx: 'changed_ahead_behind_open_pr' },
  { id: 'beacon:r-clean', title: 'Tidy the meeting notes', fx: 'clean_main' },
  { id: 'beacon:r-draft', title: 'Add the search endpoint', fx: 'draft_pr' },
  { id: 'beacon:r-merging', title: 'Merge the docs branch', fx: 'merge_conflict' },
  { id: 'beacon:r-none', title: 'Plan the week', fx: 'no_work_folder' }
]

async function phase(advertise) {
  const daemon = { gitGets: {}, markers: 0, sent: [], answers: Object.fromEntries(SESSIONS.map((s) => [s.id, s.fx])), sockets: new Set() }
  const rest = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0])
      if (url === '/api/hello') return json(res, 200, { v: '0.9.22', name: 'Stand-in', agent: 'Atlas', fp: 'e'.repeat(16), pair: 'approve', tls: false })
      if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
      if (url === '/api/devices') return json(res, 200, [])
      const now = Math.floor(Date.now() / 1000)
      if (url === '/api/sessions' && req.method === 'GET') return json(res, 200, SESSIONS.map((s, i) => ({ session_id: s.id, title: s.title, gateway: 'beacon', message_count: 2, last_active: now - i * 600, created_at: now - 86400 })))
      const g = /^\/api\/sessions\/(.+)\/git$/.exec(url)
      if (g) {
        daemon.gitGets[g[1]] = (daemon.gitGets[g[1]] ?? 0) + 1
        if (!advertise) return json(res, 404, { detail: 'Not Found' })
        const name = daemon.answers[g[1]]
        return name ? json(res, 200, answer(name)) : json(res, 404, { detail: 'unknown session' })
      }
      if (req.method !== 'GET' && !/\/workspace$/.test(url)) daemon.sent.push(`${req.method} ${url}`)
      const w = /^\/api\/sessions\/(.+)\/workspace$/.exec(url)
      if (w) {
        if (req.method === 'GET') return json(res, 200, { source: 'session', workspace: '/home/demo/work/site', daemon_workspace_roots: [] })
        if (req.method === 'PUT') {
          daemon.markers++
          return json(res, 400, { error: 'workspace is not an existing directory' }) // another computer's disk: this is the daemon's own wording
        }
        return json(res, 200, { ok: true, session_id: w[1], workspace: null })
      }
      if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) return json(res, 200, { messages: [], watermark: 0 })
      json(res, 200, [])
    })
  })
  const wsHttp = createServer()
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
    daemon.sockets.add(ws)
    ws.on('close', () => daemon.sockets.delete(ws))
    ws.on('message', (raw) => {
      let f = null
      try {
        f = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (f?.type !== 'subscribe') daemon.sent.push(`ws ${String(f?.type)}`)
      if (f?.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: f.payload?.capabilities ?? [], server_capabilities: advertise ? ['voice_input', 'git/1'] : ['voice_input'], channels: [] } }))
    })
    ws.send(JSON.stringify({ type: 'connected' }))
  })
  const frame = (sessionId) => {
    for (const ws of daemon.sockets) ws.send(JSON.stringify({ type: 'workspace_git_changed', timestamp: Date.now() / 1000, payload: { session_id: sessionId, read_at: Date.now() / 1000 } }))
  }
  for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const profile = mkdtempSync(join(tmpdir(), 'beacon-git-remote-profile-'))
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
    check((await until(() => ev(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)) === 'connected', `phase ${advertise ? 'A' : 'B'}: connected to the stand-in Prometheus`)
    const status = await until(() => ev(`window.beacon.connection.status()`), (v) => v.gitStatus !== undefined, 8000)
    check(status?.gitStatus === advertise, advertise ? 'the connection status says the Prometheus reads git (git/1)' : 'the connection status says it does not', JSON.stringify(status?.gitStatus))
    await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Chats'); b?.click(); return true })()`)
    await until(() => ev(`document.querySelectorAll('button.session-row').length`), (v) => v >= SESSIONS.length, 10000)
    const mark = (id) => ev(`(() => { const row = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes(${JSON.stringify(id)})); const m = row?.querySelector('[data-testid="git-mark"]'); return m ? { kind: m.dataset.kind, text: m.textContent.trim(), words: m.getAttribute('title'), width: Math.round(m.getBoundingClientRect().width) } : null })()`)
    const settled = (id, kind) => until(() => mark(id), (v) => v?.kind === kind, 12000)
    const gets = () => Object.values(daemon.gitGets).reduce((a, b) => a + b, 0)

    if (!advertise) {
      await sleep(5000)
      check(gets() === 0, 'a Prometheus without git/1 is never asked for git state', JSON.stringify(daemon.gitGets))
      const m = await mark('beacon:r-changed')
      check(m === null || m.kind === 'none' || m.width === 0, 'and no row shows a mark (it is on another computer: nothing to read)', JSON.stringify(m))
      await shot('git-remote-off')
      return
    }

    // ── Phase A ───────────────────────────────────────────────────────────────────────────────
    const changed = await settled('beacon:r-changed', 'changes')
    check(changed?.kind === 'pr-open' && /^#71/.test(changed.text), 'a conversation with a pull request shows the pull request number on its row', JSON.stringify(changed))
    check(/feat|fix\/gym-promote-rollback/.test(changed?.words ?? '') && /3 changed files/.test(changed?.words ?? ''), 'and says the branch and the count in words', changed?.words)
    const clean = await settled('beacon:r-clean', 'branch')
    check(clean?.kind === 'branch' && clean.text === '' && /nothing changed/.test(clean.words ?? ''), 'a clean repository shows the plain branch mark', JSON.stringify(clean))
    const merging = await settled('beacon:r-merging', 'alert')
    check(merging?.kind === 'alert' && /a merge is under way/.test(merging.words ?? ''), 'a merge stopped on a conflict shows the warning mark', JSON.stringify(merging))
    const draft = await until(() => mark('beacon:r-draft'), (v) => /^#46/.test(v?.text ?? ''), 12000)
    check(/^#46/.test(draft?.text ?? ''), 'a draft pull request shows its number', JSON.stringify(draft))
    await sleep(1200)
    const none = await mark('beacon:r-none')
    check(none?.kind === 'none' && none.width === 0, 'a conversation the Prometheus says has no folder shows nothing, and takes no room', JSON.stringify(none))
    check(SESSIONS.every((s) => (daemon.gitGets[s.id] ?? 0) >= 1), 'each conversation was asked about, over the route', JSON.stringify(daemon.gitGets))
    await shot('git-remote-list')

    // A change on the Prometheus's side that it does not announce is not read for minutes: the frame is what makes it read now.
    const before = { clean: daemon.gitGets['beacon:r-clean'], draft: daemon.gitGets['beacon:r-draft'] }
    daemon.answers['beacon:r-clean'] = 'changed_ahead_behind_no_gh'
    daemon.answers['beacon:r-draft'] = 'detached_head'
    frame('beacon:r-clean')
    const updated = await until(() => mark('beacon:r-clean'), (v) => v?.kind === 'changes', 8000)
    check(updated?.kind === 'changes' && updated.text === '3', 'a workspace_git_changed frame makes that conversation read again at once, and its row follows', JSON.stringify(updated))
    await sleep(2500)
    const quiet = await mark('beacon:r-draft')
    check(/^#46/.test(quiet?.text ?? '') && daemon.gitGets['beacon:r-draft'] === before.draft, 'a conversation with no frame is not read again just because another changed', JSON.stringify([quiet, daemon.gitGets['beacon:r-draft'], before.draft]))
    frame('beacon:not-a-session-on-screen')
    await sleep(800)
    check(!('beacon:not-a-session-on-screen' in daemon.gitGets), 'a frame for a conversation nobody is looking at asks for nothing')
    frame('beacon:r-draft')
    const draft2 = await until(() => mark('beacon:r-draft'), (v) => v?.kind !== 'pr-draft', 8000)
    check(draft2?.kind === 'branch', 'and its own frame brings the change', JSON.stringify(draft2))

    // The open conversation: chip, then the pane says why there is no file list.
    await ev(`(() => { const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes('beacon:r-changed')); b?.click(); return !!b })()`)
    const chip = await until(() => ev(`(() => { const c = document.querySelector('[data-testid="git-chip"]'); return c ? { kind: c.dataset.kind, text: c.innerText.replace(/\\s+/g, ' ').trim() } : null })()`), (v) => v !== null, 10000)
    check(chip?.kind === 'pr-open' && /3 .*#71/.test(chip.text), 'the open conversation shows the chip from the Prometheus\'s answer', JSON.stringify(chip))
    await shot('git-remote-chip')
    await ev(`(() => { document.querySelector('[data-testid="git-chip"]').click(); return true })()`)
    const panel = await until(() => ev(`(() => { const p = document.querySelector('[data-testid="git-panel"]'); return p ? { text: p.innerText, remote: !!p.querySelector('[data-testid="git-panel-remote"]'), files: p.querySelectorAll('[data-testid="git-file"]').length, link: p.querySelector('[data-testid="git-pr-link"]')?.getAttribute('href') ?? null, actions: [...p.querySelectorAll('[data-testid="git-action"]')].map((b) => b.dataset.action).join() } : null })()`), (v) => v?.remote === true, 8000)
    check(panel?.remote === true && panel.files === 0 && /another computer/.test(panel.text), 'the Git pane says the files are not shown because Prometheus is on another computer, and lists none', JSON.stringify(panel))
    check(panel?.link === 'https://github.com/OAraLabs/Beacon/pull/71', 'it links the pull request, as the answer gave it', panel?.link)
    check((panel?.actions ?? '').length > 0, 'and still offers the prepared requests (they work wherever Prometheus is)', panel?.actions)
    await shot('git-remote-panel')
    const sent = daemon.sent.filter((x) => !/identity\/challenge/.test(x)) // Beacon's own proof of who it is talking to, before any key
    check(sent.length === 0, 'nothing was sent to Prometheus: no write, no frame', sent.join(' | '))
    const most = Math.max(...Object.values(daemon.gitGets))
    check(most <= 8, `no conversation was asked for more than a handful of times (most: ${most})`, JSON.stringify(daemon.gitGets))
  } finally {
    await app?.quit().catch(() => undefined)
    for (const s of [rest, wsHttp]) s.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

await phase(true)
await phase(false)
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
