#!/usr/bin/env node
// chat-projects-app-probe: the sidebar's projects, IN THE REAL APP, against a stand-in Prometheus on loopback, in four situations:
//
//   A  it serves projects and there are no local ones: the sidebar draws ITS projects, and every change a person makes (move a
//      conversation in, a folder already chosen, start one inside, rename, delete, a new project) is asked of it, nothing more;
//   B  it does NOT serve projects (today's Prometheus) and there are local ones: the sidebar is what it always was, and the
//      Prometheus is asked nothing about projects at all;
//   C  it serves them, but the local projects have not been moved to it: the local ones stay on screen, untouched, and nothing
//      is changed on the Prometheus;
//   D  it serves them and the local projects have been moved: its projects are drawn, and the local copy is left exactly as it was.
//
//   G  it serves projects: a project's instructions and reference files, in the window its menu opens: save, an edit made elsewhere
//      (told, then a conflict the person settles), a file that would shadow another, files added, replaced, saved and deleted.
//
// The stand-in answers with the daemon's REAL answers where it refuses (src/main/fixtures/chat_projects.json, recorded from the daemon's
// own routes). Its own scratch profile and loopback port; the user's profile and Prometheus are not touched.
//
//   npm run build && npm run probe:chat-projects
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

const fx = JSON.parse(readFileSync(new URL('../src/main/fixtures/chat_projects.json', import.meta.url), 'utf8'))
const recorded = (label) => [...fx.exchanges, ...fx.content.exchanges].find((e) => e.label === label).body

// ── the stand-in Prometheus ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SESSIONS = [
  { id: 'desktop:probe-1', title: 'Plan the kitchen' },
  { id: 'desktop:probe-2', title: 'Garden notes' },
  { id: 'desktop:probe-3', title: 'Loose thoughts' }
]
const m = { instr: { content: '', rev: '' }, shadow: false, files: new Map(), serves: true, rev: 0, projects: [], filings: new Map(), handChosen: new Set(['desktop:probe-2']), requests: [], sockets: new Set(), made: 0, extraSessions: [], suggest: ['desktop:probe-3'], badFolder: false }
const resetModel = (serves) => {
  m.serves = serves
  m.rev = 0
  m.projects = []
  m.filings = new Map()
  m.requests = []
  m.made = 0
  m.extraSessions = []
  m.suggest = ['desktop:probe-3']
  m.badFolder = false
  m.instr = { content: '', rev: '' }
  m.shadow = false
  m.files = new Map()
}
const revOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const fileRow = (name) => ({ name, size: m.files.get(name).byteLength, mtime: 1793667600, mime: name.endsWith('.md') ? 'text/markdown' : 'text/plain' })
const proj = (id, name) => ({
  id,
  name,
  folder: `/stand-in/projects/${name.toLowerCase().replace(/\W+/g, '-')}`,
  folder_managed: true,
  instructions_chars: 0,
  instructions_rev: '',
  files: 0,
  sessions: [...m.filings.values()].filter((p) => p === id).length,
  import_key: null,
  created_at: 1793667600,
  updated_at: 1793667600
})
const frame = (change, projectId, sessionId = null) => {
  m.rev++
  for (const ws of m.sockets) ws.send(JSON.stringify({ type: 'chat_project_changed', timestamp: Date.now() / 1000, payload: { rev: m.rev, project_id: projectId, change, session_id: sessionId } }))
}
const sessionRows = () =>
  [...SESSIONS, ...m.extraSessions].map((s, i) => ({
    session_id: s.id,
    title: s.title,
    gateway: 'desktop',
    created_at: 1793667000 + i,
    last_active: 1793667600 + i,
    message_count: 2,
    watermark: 2,
    ...(m.serves ? { chat_project_id: m.filings.get(s.id) ?? null } : {})
  }))
// What was written to the Prometheus, other than Beacon's own handshake (it proves who is answering before it sends a key).
const writes = () => m.requests.filter((r) => r.method !== 'GET' && r.path !== '/api/identity/challenge')
const rest = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const buf = Buffer.concat(chunks)
    const url = (req.url ?? '').split('?')[0]
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').split('?')[1] : ''
    const fileRoute = /^\/api\/chat-projects\/[^/]+\/files\/[^/]+$/.test(url)
    const body = !fileRoute && buf.length ? JSON.parse(buf.toString()) : null
    const path = decodeURIComponent(url)
    m.requests.push({ method: req.method, path, body, query, bytes: fileRoute && buf.length ? buf : null })
    if (url === '/api/hello') return json(res, 200, { v: '0.9.21', name: 'Stand-in', agent: 'Atlas', fp: 'd'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/sessions' && req.method === 'GET') return json(res, 200, sessionRows())
    if (url === '/api/sessions' && req.method === 'POST') {
      const id = `desktop:probe-new-${m.extraSessions.length + 1}`
      m.extraSessions.push({ id, title: 'A new conversation' })
      if (body?.chat_project_id) m.filings.set(id, body.chat_project_id)
      frame('membership', body?.chat_project_id ?? null, id)
      return json(res, 200, { session_id: id, gateway: 'desktop', chat_project_id: body?.chat_project_id ?? null, workspace: '/stand-in/projects/x' })
    }
    if (!m.serves && /^\/api\/chat-project/.test(path)) return json(res, 404, { detail: 'Not Found' })
    if (url === '/api/chat-projects' && req.method === 'GET') return json(res, 200, { role: 'owner', rev: m.rev, projects: m.projects.map((p) => proj(p.id, p.name)) })
    if (url === '/api/chat-projects' && req.method === 'POST') {
      if (m.badFolder) return json(res, 400, recorded('create, the home folder')) // a Prometheus whose projects folder is not usable
      const have = m.projects.find((p) => (body?.import_key && p.key === body.import_key) || p.name.toLowerCase() === String(body?.name).trim().toLowerCase())
      if (have && body?.import_key) return json(res, 200, { ok: true, project: proj(have.id, have.name), created: false })
      if (have) return json(res, 409, recorded('create, a name taken (with another folder)'))
      const p = { id: `cp_${String(++m.made).padStart(12, '0')}`, name: String(body.name).trim(), key: body.import_key ?? null }
      m.projects.push(p)
      frame('created', p.id)
      return json(res, 201, { ok: true, project: proj(p.id, p.name), created: true })
    }
    const instr = /^\/api\/chat-projects\/([^/]+)\/instructions$/.exec(path)
    if (instr && req.method === 'GET') return json(res, 200, { ...m.instr, max_chars: 12000, effective: m.instr.content ? [{ path: '/stand-in/projects/kitchen-remodel/PROMETHEUS.md', chars: m.instr.content.length }] : [] })
    if (instr && req.method === 'PUT') {
      if (body.base_rev !== m.instr.rev) return json(res, 409, { error: 'the instructions changed since they were read', kind: 'conflict', content: m.instr.content, rev: m.instr.rev })
      if (m.shadow && !body.shadow_ok) return json(res, 409, recorded('save that would shadow it'))
      m.instr = { content: body.content, rev: revOf(body.content) }
      frame('instructions', instr[1])
      return json(res, 200, { ok: true, rev: m.instr.rev })
    }
    if (/^\/api\/chat-projects\/[^/]+\/files$/.test(path) && req.method === 'GET') return json(res, 200, { files: [...m.files.keys()].map(fileRow) })
    const fileOne = /^\/api\/chat-projects\/([^/]+)\/files\/(.+)$/.exec(path)
    if (fileOne) {
      const name = fileOne[2]
      if (req.method === 'PUT') {
        if (name.startsWith('.')) return json(res, 400, { error: 'a file name is one segment', kind: 'bad_name' })
        if (m.files.has(name) && query !== 'replace=true') return json(res, 409, recorded('add it again'))
        m.files.set(name, buf)
        frame('files', fileOne[1])
        return json(res, 200, { ok: true, file: { name, size: buf.byteLength, mtime: 1793667600 } })
      }
      if (!m.files.has(name)) return json(res, 404, { error: 'no such reference file', kind: 'unknown_file' })
      if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' }).end(m.files.get(name))
      if (req.method === 'DELETE') {
        m.files.delete(name)
        frame('files', fileOne[1])
        return json(res, 200, { ok: true })
      }
    }
    const one = /^\/api\/chat-projects\/([^/]+)$/.exec(path)
    if (one && req.method === 'PUT') {
      const p = m.projects.find((x) => x.id === one[1])
      if (!p) return json(res, 404, recorded('get, unknown'))
      p.name = String(body.name).trim()
      frame('updated', p.id)
      return json(res, 200, { ok: true, project: proj(p.id, p.name) })
    }
    if (one && req.method === 'DELETE') {
      const p = m.projects.find((x) => x.id === one[1])
      if (!p) return json(res, 404, recorded('delete, a project that is not there'))
      let n = 0
      for (const [sid, pid] of [...m.filings]) if (pid === p.id) (m.filings.delete(sid), n++)
      m.projects = m.projects.filter((x) => x.id !== p.id)
      frame('deleted', p.id)
      return json(res, 200, { ok: true, id: p.id, unfiled: n })
    }
    if (url === '/api/chat-project-suggestions') {
      const out = {}
      for (const id of m.suggest) if (!m.filings.has(id)) out[id] = { key: 'new-thing', label: 'new-thing', share: 1, calls: 4, project: null }
      return json(res, 200, { suggestions: out, rev: m.rev })
    }
    const filing = /^\/api\/sessions\/([^/]+)\/project$/.exec(path)
    if (filing && req.method === 'PUT') {
      const sid = filing[1]
      if (body.chat_project_id === null) {
        m.filings.delete(sid)
        frame('membership', null, sid)
        return json(res, 200, { ok: true, session_id: sid, chat_project_id: null, workspace: null })
      }
      const p = m.projects.find((x) => x.id === body.chat_project_id)
      if (!p) return json(res, 404, recorded('file, a project that is not there'))
      if (m.handChosen.has(sid) && !body.keep_workspace && !body.replace_workspace) return json(res, 409, recorded('file, a folder was chosen by hand'))
      m.filings.set(sid, p.id)
      frame('membership', p.id, sid)
      return json(res, 200, { ok: true, session_id: sid, chat_project_id: p.id, workspace: body.keep_workspace ? null : proj(p.id, p.name).folder })
    }
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  m.sockets.add(ws)
  ws.on('close', () => m.sockets.delete(ws))
  ws.on('message', (raw) => {
    let f = null
    try {
      f = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (f?.type === 'subscribe') {
      ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: f.payload?.capabilities ?? [], server_capabilities: m.serves ? ['voice_input', 'projects'] : ['voice_input'], channels: [] } }))
    }
  })
  ws.send(JSON.stringify({ type: 'connected' }))
})
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))

// ── one app, one scratch profile, for one situation ──────────────────────────────────────────────────────────────────────────────
const profiles = []
async function open({ localStore, migrated, served = false }) {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-chat-projects-profile-'))
  profiles.push(profile)
  const settings = []
  if (localStore) settings.push(`INSERT INTO settings VALUES ('sessions:projects:v1', '${JSON.stringify(localStore).replace(/'/g, "''")}');`)
  if (migrated) settings.push(`INSERT INTO settings VALUES ('chat-projects:migrated:v1', '{"done":true}');`)
  if (served) settings.push(`INSERT INTO settings VALUES ('chat-projects:served:v1', '1');`)
  execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('standin', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  ${settings.join('\n')}`])
  const app = await launchApp({ profile })
  const ev = app.page.evaluate
  const until = async (fn, pred = (v) => !!v, ms = 8000) => {
    let v
    for (let t = 0; t < ms; t += 100) {
      v = await fn()
      if (pred(v)) return v
      await sleep(100)
    }
    return v
  }
  // A fresh profile opens on Mission: go to Chats, and wait for the list.
  await until(() => ev(`(() => { if (document.querySelector('.session-list .session-row')) return true; const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Chats' || b.getAttribute('aria-label') === 'Chats' || b.getAttribute('title') === 'Chats'); if (b) b.click(); return false })()`), (v) => v === true, 30000)
  await ev(`[...document.querySelectorAll('.session-group-head[aria-expanded="false"]')].forEach((b) => b.click()); true`)
  const rightClick = async (expr) => {
    const r = await ev(`(() => { const el = ${expr}; if (!el) return null; const q = el.getBoundingClientRect(); return { x: q.left + Math.min(40, q.width / 2), y: q.top + q.height / 2 } })()`)
    if (!r) return false
    await app.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 })
    await app.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 })
    return true
  }
  const row = (title) => `[...document.querySelectorAll('.session-row')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`
  const head = (name) => `[...document.querySelectorAll('.session-group-head')].find((h) => h.innerText.includes(${JSON.stringify(name)}))`
  const item = (text) => `[...document.querySelectorAll('.ctx-menu [role=menuitem]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`
  const clickItem = async (text) => {
    const ok = await until(() => ev(`(() => { const b = ${item(text)}; if (!b) return false; b.click(); return true })()`), (v) => v === true, 4000)
    return ok === true
  }
  const labels = () => ev(`[...document.querySelectorAll('.session-group.is-project .session-group-label')].map((e) => e.textContent.trim())`)
  const inGroup = (name, title) => ev(`(() => { const g = [...document.querySelectorAll('.session-group')].find((g) => g.querySelector('.session-group-head')?.innerText.includes(${JSON.stringify(name)})); return !!g && [...g.querySelectorAll('.session-row')].some((r) => r.innerText.includes(${JSON.stringify(title)})) })()`)
  const text = () => ev(`document.body.innerText`)
  const asked = (method, re) => m.requests.filter((r) => r.method === method && re.test(r.path))
  return { app, ev, until, rightClick, row, head, item, clickItem, labels, inGroup, text, asked, profile, quit: () => app.quit().catch(() => undefined) }
}

try {
  // ── A: it serves projects, and there are no local ones ────────────────────────────────────────────────────────────────────────
  {
    resetModel(true)
    m.projects = [{ id: 'cp_000000000101', name: 'Kitchen remodel' }, { id: 'cp_000000000102', name: 'Garden' }]
    m.made = 200
    m.filings.set('desktop:probe-1', 'cp_000000000101')
    const a = await open({ localStore: null, migrated: false })
    check((await a.until(a.labels, (v) => v.length >= 2)).join() === 'Kitchen remodel,Garden', 'A: the sidebar draws the Prometheus\'s projects, in its order', (await a.labels()).join())
    check((await a.inGroup('Kitchen remodel', 'Plan the kitchen')) === true, 'A: a conversation the Prometheus has filed is in that project')
    check(a.asked('GET', /^\/api\/chat-projects$/).length >= 1 && a.asked('GET', /^\/api\/chat-project-suggestions$/).length >= 1, 'A: Beacon read the list and the suggestions')
    check(/1 session could go in a project/.test(await a.until(a.text, (v) => /could go in a project/.test(v))), 'A: the Prometheus\'s suggestion for a conversation is offered')

    // Move an ordinary conversation into a project: asked of the Prometheus, and said in words.
    await a.rightClick(a.row('Loose thoughts'))
    check(await a.clickItem('Move to Kitchen remodel'), 'A: the conversation\'s menu lists the Prometheus\'s projects')
    const put3 = await a.until(() => a.asked('PUT', /probe-3\/project$/), (v) => v.length > 0)
    check(put3.length === 1 && put3[0].body.chat_project_id === 'cp_000000000101' && put3[0].body.keep_workspace === undefined && put3[0].body.replace_workspace === undefined, 'A: a move is one PUT with the project id and no flag that changes its folder\'s fate')
    check(/Moved to “Kitchen remodel”\. It now works in …\/projects\/kitchen-remodel\./.test(await a.until(async () => (await a.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`)), (v) => v.length > 0)), 'A: and says where the conversation works now')
    check((await a.until(() => a.inGroup('Kitchen remodel', 'Loose thoughts'), (v) => v === true)) === true, 'A: it shows in the project, from the Prometheus\'s filing')

    // A folder somebody already chose: the Prometheus asks; the person answers.
    await a.rightClick(a.row('Garden notes'))
    await a.clickItem('Move to Garden')
    const q = await a.until(() => a.ev(`document.querySelector('[data-testid=project-question]')?.innerText ?? ''`), (v) => v.length > 0)
    check(/already works in a folder that was chosen for it/.test(q) && /Garden/.test(q) && /Leave its folder alone/.test(q) && /Use the project's folder/.test(q), 'A: a folder already chosen is a question with both answers in it', q)
    check(a.asked('PUT', /probe-2\/project$/).length === 1 && a.asked('PUT', /probe-2\/project$/)[0].body.keep_workspace === undefined, 'A: nothing was decided for the person: one PUT, and it was refused')
    await a.ev(`document.querySelector('[data-testid=project-question-cancel]').click(); true`)
    await sleep(300)
    check(a.asked('PUT', /probe-2\/project$/).length === 1 && !(m.filings.has('desktop:probe-2')), 'A: Cancel sends nothing more, and the conversation stays where it was')
    await a.rightClick(a.row('Garden notes'))
    await a.clickItem('Move to Garden')
    await a.until(() => a.ev(`!!document.querySelector('[data-testid=project-question]')`), (v) => v === true)
    await a.ev(`document.querySelector('[data-testid=project-question-0]').click(); true`)
    const put2 = await a.until(() => a.asked('PUT', /probe-2\/project$/), (v) => v.length >= 3)
    check(put2.length === 3 && put2[2].body.keep_workspace === true && m.filings.get('desktop:probe-2') === 'cp_000000000102', 'A: "Leave its folder alone" files it as a label only (keep_workspace)')
    check(/Filed in “Garden”\. Its own folder was left as it was\./.test(await a.until(() => a.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => /Filed in/.test(v))), 'A: and says its folder was left as it was')

    // Start a conversation inside a project.
    await a.rightClick(a.head('Garden'))
    check(await a.clickItem('New conversation here'), 'A: a project\'s menu offers "New conversation here"')
    const started = await a.until(() => a.asked('POST', /^\/api\/sessions$/), (v) => v.length > 0)
    check(started.length === 1 && started[0].body.gateway === 'desktop' && started[0].body.chat_project_id === 'cp_000000000102', 'A: it asks the Prometheus to start one in that project')

    // Rename and delete.
    await a.rightClick(a.head('Garden'))
    await a.clickItem('Rename')
    await a.until(() => a.ev(`!!document.querySelector('.project-naming input')`), (v) => v === true)
    await a.ev(`(() => { const i = document.querySelector('.project-naming input'); i.focus(); i.select(); return true })()`)
    await a.app.page.send('Input.insertText', { text: 'Back garden' })
    await a.app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await a.app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    const ren = await a.until(() => a.asked('PUT', /^\/api\/chat-projects\/cp_000000000102$/), (v) => v.length > 0)
    check(ren.length === 1 && ren[0].body.name === 'Back garden', 'A: a rename is a PUT with the new name')
    check((await a.until(a.labels, (v) => v.includes('Back garden'))).includes('Back garden'), 'A: and the list shows it')
    await a.rightClick(a.head('Back garden'))
    await a.clickItem('Delete project')
    const del = await a.until(() => a.asked('DELETE', /^\/api\/chat-projects\/cp_000000000102$/), (v) => v.length > 0)
    check(del.length === 1, 'A: a delete is a DELETE')
    check(/Project deleted\./.test(await a.until(() => a.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => /deleted/.test(v))) && /folder and files are still on that computer/.test(await a.text()), 'A: and says its folder and files are still on that computer')
    check(!(await a.labels()).includes('Back garden'), 'A: the project is gone from the list')

    // A new project from a conversation's menu.
    await a.rightClick(a.row('Loose thoughts'))
    await a.clickItem('New project')
    await a.until(() => a.ev(`!!document.querySelector('.project-naming input')`), (v) => v === true)
    await a.app.page.send('Input.insertText', { text: 'Reading list' })
    await a.app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await a.app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    const made = await a.until(() => a.asked('POST', /^\/api\/chat-projects$/), (v) => v.length > 0)
    check(made.length === 1 && made[0].body.name === 'Reading list' && made[0].body.folder === undefined, 'A: a new project is a POST with its name and no folder: the Prometheus makes one')
    check((await a.until(() => a.inGroup('Reading list', 'Loose thoughts'), (v) => v === true)) === true, 'A: and the conversation it was made from is filed in it')
    await a.quit()
  }

  // ── A2: accepting a batch of suggestions, one of them with a folder already chosen ──────────────────────────────────────────────
  {
    resetModel(true)
    m.suggest = ['desktop:probe-3', 'desktop:probe-2'] // probe-2 has a folder chosen for it
    const a = await open({ localStore: null, migrated: false })
    await a.until(() => a.text(), (v) => /2 sessions could go in a project/.test(v))
    check(/2 sessions could go in a project/.test(await a.text()), 'A2: two suggestions from the Prometheus')
    await a.ev(`document.querySelector('.project-review-toggle').click(); true`)
    await a.until(() => a.ev(`!!document.querySelector('.project-review-btn')`), (v) => v === true)
    await a.ev(`[...document.querySelectorAll('.project-review-btn:not(.is-quiet)')][0].click(); true`)
    const sawQuestion = []
    const watch = setInterval(() => a.ev(`!!document.querySelector('[data-testid=project-question]')`).then((v) => v && sawQuestion.push(1)).catch(() => undefined), 50)
    const made2 = await a.until(() => a.asked('POST', /^\/api\/chat-projects$/), (v) => v.length > 0)
    check(made2.length === 1 && made2[0].body.name === 'new-thing', 'A2: accepting makes the project, once')
    const p2 = await a.until(() => a.asked('PUT', /probe-2\/project$/), (v) => v.length >= 2)
    clearInterval(watch)
    check(p2.length === 2 && p2[0].body.keep_workspace === undefined && p2[1].body.keep_workspace === true, 'A2: a folder already chosen: asked, then filed as a label only, never moved')
    check(a.asked('PUT', /probe-3\/project$/).length === 1 && a.asked('PUT', /probe-3\/project$/)[0].body.keep_workspace === undefined, 'A2: the other is filed normally')
    const noteText = await a.until(() => a.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => /Moved 1 conversation/.test(v))
    check(/Moved 1 conversation to “new-thing”/.test(noteText) && /One conversation already had a folder chosen for it/.test(noteText), 'A2: one note says both: how many were moved, and that one kept its folder', noteText)
    check(sawQuestion.length === 0, 'A2: no question was put to the person for a batch: nothing was decided for them, and it was said afterwards')
    check(m.filings.get('desktop:probe-2') && m.filings.get('desktop:probe-3'), 'A2: both are filed')
    await a.quit()
  }

  // ── G: a project's instructions and reference files ───────────────────────────────────────────────────────────────────────────
  {
    resetModel(true)
    m.projects = [{ id: 'cp_000000000101', name: 'Kitchen remodel' }]
    m.made = 200
    const g = await open({ localStore: null, migrated: false })
    await g.until(g.labels, (v) => v.length >= 1)
    const scratch = mkdtempSync(join(tmpdir(), 'beacon-chat-projects-files-'))
    profiles.push(scratch)
    const dlg = (open, save) => g.app.mainEval(`(() => { const d = __electron.dialog; d.showOpenDialog = async () => (${JSON.stringify(open)} ? { canceled: false, filePaths: ${JSON.stringify(open ?? [])} } : { canceled: true, filePaths: [] }); d.showSaveDialog = async () => (${JSON.stringify(save)} ? { canceled: false, filePath: ${JSON.stringify(save)} } : { canceled: true }); return true })()`)
    const modal = () => g.ev(`document.querySelector('[data-testid=project-settings]')?.innerText ?? ''`)
    const click = (id) => g.ev(`(() => { const b = document.querySelector('[data-testid=${id}]'); if (!b || b.disabled) return false; b.click(); return true })()`)
    // A button that is off while the last call is still being read is waited for, not skipped.
    const clickWhenReady = (id) => g.until(() => click(id), (v) => v === true, 5000)
    const type = async (text) => {
      await g.ev(`(() => { const t = document.querySelector('[data-testid=project-instructions]'); t.focus(); t.select(); return true })()`)
      await g.app.page.send('Input.insertText', { text })
    }
    const val = () => g.ev(`document.querySelector('[data-testid=project-instructions]')?.value ?? null`)
    const reqs = (method, re) => g.asked(method, re)

    check((await g.rightClick(g.head('Kitchen remodel'))) && (await g.clickItem('Instructions and files')), 'G: a project\'s menu offers "Instructions and files…"')
    check(/No reference files yet/.test(await g.until(modal, (v) => /No reference files yet/.test(v))) && (await val()) === '', 'G: the window opens on the Prometheus\'s instructions (none yet) and files (none yet)')
    check(reqs('GET', /instructions$/).length === 1 && reqs('GET', /files$/).length === 1, 'G: both were read once')
    check((await click('project-instructions-save')) === false, 'G: Save is off until something is changed')

    await type('Be brief.')
    check(/9 of 12,000 characters/.test(await g.until(() => g.ev(`document.querySelector('[data-testid=project-instructions-count]')?.innerText ?? ''`), (v) => /9 of/.test(v))), 'G: the count shows against the limit the Prometheus gave')
    check(await click('project-instructions-save'), 'G: Save is on once the text changes')
    const put1 = await g.until(() => reqs('PUT', /instructions$/), (v) => v.length >= 1)
    check(put1.length === 1 && put1[0].body.content === 'Be brief.' && put1[0].body.base_rev === '' && put1[0].body.shadow_ok === undefined, 'G: a save sends the text and the revision it was made from, and no permission to shadow anything')
    check(/Saved/.test(await g.until(modal, (v) => /Saved/.test(v))) && m.instr.content === 'Be brief.', 'G: and says so')

    // Changed elsewhere, nothing unsaved here: the window follows.
    m.instr = { content: 'Be brief. Metric units.', rev: revOf('Be brief. Metric units.') }
    frame('instructions', 'cp_000000000101')
    check((await g.until(val, (v) => v === 'Be brief. Metric units.')) === 'Be brief. Metric units.', 'G: an edit made elsewhere shows up by itself when nothing here was changed')

    // Changed elsewhere while this one is being edited: told, then a conflict the person settles.
    await type('Be brief and kind.')
    m.instr = { content: 'Elsewhere.', rev: revOf('Elsewhere.') }
    frame('instructions', 'cp_000000000101')
    check(/changed on Prometheus while you were editing/.test(await g.until(modal, (v) => /while you were editing/.test(v))) && (await val()) === 'Be brief and kind.', 'G: an edit elsewhere while this one is unsaved is told, and what was typed is kept')
    await click('project-instructions-save')
    const conflictText = await g.until(() => g.ev(`document.querySelector('[data-testid=project-instructions-theirs]')?.innerText ?? ''`), (v) => v.length > 0)
    check(conflictText === 'Elsewhere.' && m.instr.content === 'Elsewhere.' && /Nothing was saved/.test(await modal()), 'G: a save from the revision that was read is a conflict: what is there is shown, and nothing was overwritten')
    await click('project-instructions-use-theirs')
    check((await val()) === 'Elsewhere.' && (await g.ev(`!document.querySelector('[data-testid=project-instructions-conflict]')`)), 'G: "Use what is there" drops the draft for the Prometheus\'s text')
    await type('Mine, after theirs.')
    await click('project-instructions-save')
    const put2 = await g.until(() => reqs('PUT', /instructions$/), (v) => v.length >= 4)
    check(put2[put2.length - 1].body.base_rev === revOf('Elsewhere.') && m.instr.content === 'Mine, after theirs.', 'G: after taking theirs, the next save is made from their revision and goes through')
    m.instr = { content: 'Again elsewhere.', rev: revOf('Again elsewhere.') }
    frame('instructions', 'cp_000000000101')
    await g.until(val, (v) => v === 'Again elsewhere.')
    await type('Mine, over it.')
    m.instr = { content: 'A third edit.', rev: revOf('A third edit.') }
    await click('project-instructions-save')
    await g.until(() => g.ev(`!!document.querySelector('[data-testid=project-instructions-conflict]')`), (v) => v === true)
    await click('project-instructions-keep-mine')
    await g.until(() => m.instr.content === 'Mine, over it.', (v) => v === true)
    check(m.instr.content === 'Mine, over it.', 'G: "Keep mine and save over it" saves from the revision that was shown: the person decided, having seen it')

    // A stale revision and a file that would be shadowed together: the person is asked about each once, and the save lands.
    m.shadow = true
    await type('Both at once.')
    m.instr = { content: 'Elsewhere, again.', rev: revOf('Elsewhere, again.') }
    await click('project-instructions-save')
    await g.until(() => g.ev(`!!document.querySelector('[data-testid=project-instructions-conflict]')`), (v) => v === true)
    await click('project-instructions-keep-mine')
    await g.until(() => g.ev(`!!document.querySelector('[data-testid=project-instructions-shadow]')`), (v) => v === true)
    await click('project-instructions-save-anyway')
    await g.until(() => m.instr.content === 'Both at once.', (v) => v === true)
    const lastPut = reqs('PUT', /instructions$/).slice(-1)[0]
    check(m.instr.content === 'Both at once.' && lastPut.body.base_rev === revOf('Elsewhere, again.') && lastPut.body.shadow_ok === true, 'G: a conflict and a file that would be shadowed, one after the other, are two questions and then a save: no loop, and "Save anyway" is made from the revision that was shown')
    m.shadow = false

    // A file that would be shadowed.
    m.shadow = true
    await type('Shadowing.')
    const before = reqs('PUT', /instructions$/).length
    await click('project-instructions-save')
    const sh = await g.until(() => g.ev(`document.querySelector('[data-testid=project-instructions-shadow]')?.innerText ?? ''`), (v) => v.length > 0)
    check(/CLAUDE\.md/.test(sh) && /Nothing was saved/.test(sh) && m.instr.content === 'Both at once.', 'G: a save that would stop another file being read says which, and saves nothing', sh)
    await click('project-instructions-save-anyway')
    const anyway = await g.until(() => reqs('PUT', /instructions$/), (v) => v.length > before + 1)
    check(anyway[anyway.length - 1].body.shadow_ok === true && m.instr.content === 'Shadowing.', 'G: only "Save anyway" sends the permission')
    m.shadow = false

    // Files.
    writeFileSync(join(scratch, 'notes.md'), '# Notes\nBuy milk.\n')
    await dlg([join(scratch, 'notes.md')], null)
    await clickWhenReady('project-files-add')
    check((await g.until(() => g.ev(`[...document.querySelectorAll('[data-testid=project-file-name]')].map((e) => e.textContent).join()`), (v) => v === 'notes.md')) === 'notes.md', 'G: a file chosen in the system panel is added and listed')
    const up = reqs('PUT', /files\/notes\.md$/)
    check(up.length === 1 && up[0].bytes?.toString() === '# Notes\nBuy milk.\n' && up[0].query === '', 'G: it went up as the file\'s own bytes under its own name, without ?replace')
    check(!up[0].body, 'G: and nothing about this computer\'s path went with it')
    await clickWhenReady('project-files-add')
    check(/notes\.md is already there/.test(await g.until(() => g.ev(`document.querySelector('[data-testid=project-files-report]')?.innerText ?? ''`), (v) => v.length > 0)) && m.files.get('notes.md').toString() === '# Notes\nBuy milk.\n', 'G: the same name again is said to be there, and left alone')
    writeFileSync(join(scratch, 'other-name.md'), '# Notes\nBuy milk and eggs.\n')
    await dlg([join(scratch, 'other-name.md')], null)
    await clickWhenReady('project-file-replace')
    const rep = await g.until(() => reqs('PUT', /files\/notes\.md$/), (v) => v.length >= 3)
    check(rep[rep.length - 1].query === 'replace=true' && m.files.get('notes.md').toString() === '# Notes\nBuy milk and eggs.\n', 'G: Replace… puts the chosen file (whatever it is called here) in that row\'s place, with ?replace=true, because the person asked for that on that file')
    const out = join(scratch, 'saved-copy.md')
    await dlg(null, out)
    await clickWhenReady('project-file-save')
    check((await g.until(() => { try { return readFileSync(out, 'utf8') } catch { return '' } }, (v) => v.length > 0)) === '# Notes\nBuy milk and eggs.\n', 'G: Save as… writes the file where the person chose, byte for byte')
    await clickWhenReady('project-file-delete')
    check(/Delete from Prometheus's computer\?/.test(await modal()) && reqs('DELETE', /files\/notes\.md$/).length === 0 && m.files.size === 1, 'G: Delete asks first, and nothing is deleted yet')
    await clickWhenReady('project-file-delete-yes')
    check((await g.until(() => reqs('DELETE', /files\/notes\.md$/), (v) => v.length === 1)).length === 1 && (await g.until(modal, (v) => /No reference files yet/.test(v))).length > 0 && m.files.size === 0, 'G: confirming deletes that one file, and the list is empty')
    writeFileSync(join(scratch, '.hidden'), 'x')
    await dlg([join(scratch, '.hidden')], null)
    await clickWhenReady('project-files-add')
    check(/\.hidden: Prometheus can't use that file name/.test(await g.until(() => g.ev(`document.querySelector('[data-testid=project-files-report]')?.innerText ?? ''`), (v) => v.length > 0)), 'G: a name the Prometheus refuses is said, in plain words, with the name')

    // Closing with unsaved text.
    await type('Unsaved words.')
    await click('project-settings-close')
    check(/not saved/.test(await g.until(() => g.ev(`document.querySelector('[data-testid=project-settings-discard]')?.innerText ?? ''`), (v) => v.length > 0)) && (await g.ev(`!!document.querySelector('[data-testid=project-settings]')`)), 'G: closing with unsaved text asks first')
    await click('project-settings-discard-yes')
    check((await g.until(() => g.ev(`!document.querySelector('[data-testid=project-settings]')`), (v) => v === true)) === true && m.instr.content === 'Shadowing.', 'G: and discarding closes the window and sends nothing')
    await g.quit()
  }

  // ── B: today's Prometheus: no projects, and local ones ────────────────────────────────────────────────────────────────────────
  {
    resetModel(false)
    const local = { projects: [{ id: 'p1', name: 'Local kitchen' }], assign: { 'desktop:probe-1': 'p1' }, dismissed: {} }
    const b = await open({ localStore: local, migrated: false })
    check((await b.until(b.labels, (v) => v.length >= 1)).join() === 'Local kitchen' && (await b.inGroup('Local kitchen', 'Plan the kitchen')) === true, 'B: a Prometheus that does not serve projects: the local projects are drawn, as always')
    await sleep(1500)
    check(m.requests.filter((r) => /chat-project/.test(r.path)).length === 0, 'B: and it is asked nothing about projects: not one request', JSON.stringify(m.requests.filter((r) => /chat-project/.test(r.path))))
    await b.rightClick(b.row('Loose thoughts'))
    await b.clickItem('Move to Local kitchen')
    check((await b.until(() => b.inGroup('Local kitchen', 'Loose thoughts'), (v) => v === true)) === true, 'B: a move is local, as always')
    await sleep(500)
    check(writes().length === 0, 'B: and nothing was written to the Prometheus', JSON.stringify(writes()))
    check(((await b.text()).match(/Moved to/g) ?? []).length === 0 && (await b.ev(`!!document.querySelector('[data-testid=project-note]')`)) === false, 'B: and there is no note about a folder: a local move changes none')
    await b.rightClick(b.head('Local kitchen'))
    check((await b.until(() => b.ev(`!!document.querySelector('.ctx-menu')`), (v) => v === true)) === true && !(await b.ev(`!![...document.querySelectorAll('.ctx-menu [role=menuitem]')].find((x) => /Instructions and files/.test(x.textContent))`)), 'B: a local project\'s menu has no "Instructions and files…": they belong to a Prometheus that keeps projects')
    await b.quit()
  }

  // ── C: it serves projects, but cannot make its projects folder, so the local ones cannot be moved ──────────────────────────────
  {
    resetModel(true)
    m.badFolder = true
    m.projects = [{ id: 'cp_000000000301', name: 'Daemon only' }]
    const local = { projects: [{ id: 'p1', name: 'Local kitchen' }], assign: { 'desktop:probe-1': 'p1' }, dismissed: {} }
    const c = await open({ localStore: local, migrated: false })
    await c.until(() => c.labels(), (v) => v.length >= 1)
    const sentence = await c.until(() => c.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => v.length > 0, 15000)
    check(/can't make folders for projects yet/.test(sentence), 'C: a Prometheus that cannot make its projects folder: Beacon says so, and that the projects stay here', sentence)
    check((await c.labels()).join() === 'Local kitchen', 'C: the local projects keep being drawn, and the Prometheus\'s are not', (await c.labels()).join())
    check(writes().length === 1 && writes()[0].method === 'POST' && m.filings.size === 0, 'C: and the one attempt was the only thing written: nothing else was tried', JSON.stringify(writes()))
    check(!(await c.ev(`window.beacon.settings.get('chat-projects:migrated:v1')`)), 'C: and the move is not recorded as done')
    await c.rightClick(c.row('Loose thoughts'))
    await c.clickItem('Move to Local kitchen')
    await c.until(() => c.inGroup('Local kitchen', 'Loose thoughts'), (v) => v === true)
    await sleep(500)
    check(writes().length === 1 && m.filings.size === 0, 'C: a move the person makes meanwhile is local, as always: nothing more is written to the Prometheus')
    await c.quit()
  }

  // ── D: it serves them, and the local ones have been moved ─────────────────────────────────────────────────────────────────────
  {
    resetModel(true)
    m.projects = [{ id: 'cp_000000000401', name: 'Moved kitchen' }]
    m.filings.set('desktop:probe-1', 'cp_000000000401')
    // The stored store holds entries this version would drop on reading (a case-duplicate name, a filing to a project that is gone, a
    // field it doesn't know): a dismissal must leave every one of them exactly where it is.
    const local = { projects: [{ id: 'p1', name: 'Local kitchen' }, { id: 'p2', name: 'LOCAL KITCHEN' }], assign: { 'desktop:probe-1': 'p1', 'desktop:ghost': 'p-gone' }, dismissed: {}, future: { keep: ['me'] } }
    const d = await open({ localStore: local, migrated: true })
    check((await d.until(d.labels, (v) => v.includes('Moved kitchen'))).join() === 'Moved kitchen', 'D: once the local projects have been moved, the Prometheus\'s are drawn, and the local ones are not', (await d.labels()).join())
    check((await d.inGroup('Moved kitchen', 'Plan the kitchen')) === true, 'D: with its filing')
    check(/1 session could go in a project/.test(await d.until(d.text, (v) => /could go in a project/.test(v))), 'D: there is a suggestion for a loose conversation')
    await d.rightClick(d.row('Loose thoughts'))
    check(await d.clickItem('Don’t suggest'), 'D: its menu offers to stop suggesting')
    await d.until(() => d.text(), (v) => !/could go in a project/.test(v))
    check(!/could go in a project/.test(await d.text()), 'D: a suggestion the person said no to stays gone')
    await sleep(600)
    const kept = JSON.parse(execFileSync('sqlite3', [d.profile + '/daemons/legacy-1/cache.db', "select value from settings where key='sessions:projects:v1'"]).toString().trim())
    check(JSON.stringify(kept.projects) === JSON.stringify(local.projects) && JSON.stringify(kept.assign) === JSON.stringify(local.assign) && JSON.stringify(kept.future) === JSON.stringify(local.future), 'D: the local copy is exactly as it was after the dismissal: both projects, both filings (one to a project that is gone) and the field it does not know')
    check(kept.dismissed['desktop:probe-3'] === 'new-thing', 'D: and the dismissal is kept on this computer')
    check(writes().length === 0, 'D: and nothing was written to the Prometheus', JSON.stringify(writes()))
    await d.quit()
  }

  // ── F: it serves them, and there are local projects that have not been moved: they are moved, once ───────────────────────────
  {
    resetModel(true)
    const local = { projects: [{ id: 'p1', name: 'Local kitchen' }, { id: 'p2', name: 'Local empty' }], assign: { 'desktop:probe-1': 'p1', 'desktop:ghost': 'p1' }, dismissed: {}, future: { keep: ['me'] } }
    const f = await open({ localStore: local, migrated: false })
    const flagged = await f.until(() => f.ev(`window.beacon.settings.get('chat-projects:migrated:v1')`), (v) => !!v, 15000)
    check(!!flagged && JSON.parse(flagged).done === true, 'F: the move is recorded as done for this Prometheus', flagged)
    const posts = f.asked('POST', /^\/api\/chat-projects$/)
    check(posts.length === 2 && posts[0].body.import_key === 'beacon-desktop:p1' && posts[1].body.import_key === 'beacon-desktop:p2' && posts.every((p) => p.body.folder === undefined), 'F: each local project is made on the Prometheus by its import key, with no folder: the Prometheus makes one')
    const puts = f.asked('PUT', /\/project$/)
    check(puts.length === 1 && puts[0].path.includes('probe-1') && puts[0].body.keep_workspace === true && puts[0].body.replace_workspace === undefined, 'F: the one conversation the Prometheus has is filed as a label only; the one it does not have is not even tried')
    check(f.asked('DELETE', /./).length === 0, 'F: nothing was deleted on the Prometheus')
    check((await f.until(f.labels, (v) => v.join() === 'Local kitchen,Local empty' && m.projects.length === 2)).join() === 'Local kitchen,Local empty' && (await f.inGroup('Local kitchen', 'Plan the kitchen')) === true, 'F: and the sidebar now draws the Prometheus\'s: Local kitchen with its conversation, and the empty one')
    check(/Your projects moved to this Prometheus \(2 projects and 1 conversation\)\. 1 conversation couldn't be filed here and stays unfiled/.test(await f.until(() => f.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => /moved to this Prometheus/.test(v))), 'F: the person is told once what moved and what stayed')
    await sleep(800)
    const stored = JSON.parse(execFileSync('sqlite3', [f.profile + '/daemons/legacy-1/cache.db', "select value from settings where key='sessions:projects:v1'"]).toString().trim())
    check(JSON.stringify(stored.projects) === JSON.stringify(local.projects) && JSON.stringify(stored.assign) === JSON.stringify(local.assign) && JSON.stringify(stored.future) === JSON.stringify(local.future), 'F: the local copy is exactly as it was: kept, and not read for grouping any more')
    await f.quit()
  }

  // ── E: a Prometheus that has served projects and is not saying so now ───────────────────────────────────────────────────────────
  {
    resetModel(false)
    const e = await open({ localStore: null, migrated: false, served: true })
    await sleep(1500)
    await e.rightClick(e.row('Loose thoughts'))
    await e.clickItem('New project')
    await e.until(() => e.ev(`!!document.querySelector('.project-naming input')`), (v) => v === true)
    await e.app.page.send('Input.insertText', { text: 'Made too early' })
    await e.app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await e.app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    check(/still loading from Prometheus/.test(await e.until(() => e.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => v.length > 0)), 'E: a Prometheus that has served projects and is not saying so now: a project is not made, and Beacon says why')
    await sleep(400)
    const stored = execFileSync('sqlite3', [e.profile + '/daemons/legacy-1/cache.db', "select count(*) from settings where key='sessions:projects:v1'"]).toString().trim()
    check(stored === '0' && (await e.labels()).length === 0, 'E: and nothing was made locally, which would have kept the Prometheus\'s projects from ever being drawn')
    check(m.requests.filter((r) => /chat-project/.test(r.path)).length === 0, 'E: it was asked nothing about projects either')
    await e.quit()
  }
} finally {
  for (const s of [rest, wsHttp]) s.close()
  for (const p of profiles) rmSync(p, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
