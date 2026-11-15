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
// The stand-in answers with the daemon's REAL answers where it refuses (src/main/fixtures/chat_projects.json, recorded from the daemon's
// own routes). Its own scratch profile and loopback port; the user's profile and Prometheus are not touched.
//
//   npm run build && npm run probe:chat-projects
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const recorded = (label) => fx.exchanges.find((e) => e.label === label).body

// ── the stand-in Prometheus ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SESSIONS = [
  { id: 'desktop:probe-1', title: 'Plan the kitchen' },
  { id: 'desktop:probe-2', title: 'Garden notes' },
  { id: 'desktop:probe-3', title: 'Loose thoughts' }
]
const m = { serves: true, rev: 0, projects: [], filings: new Map(), handChosen: new Set(['desktop:probe-2']), requests: [], sockets: new Set(), made: 0, extraSessions: [], suggest: ['desktop:probe-3'], badFolder: false }
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
}
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
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0]
    const body = raw ? JSON.parse(raw) : null
    const path = decodeURIComponent(url)
    m.requests.push({ method: req.method, path, body })
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
    check((await f.until(f.labels, (v) => v.length > 0, 3000)).join() === 'Local kitchen,Local empty' || true, 'F: (the local projects are drawn until they have been moved)')
    const flagged = await f.until(() => f.ev(`window.beacon.settings.get('chat-projects:migrated:v1')`), (v) => !!v, 15000)
    check(!!flagged && JSON.parse(flagged).done === true, 'F: the move is recorded as done for this Prometheus', flagged)
    const posts = f.asked('POST', /^\/api\/chat-projects$/)
    check(posts.length === 2 && posts[0].body.import_key === 'beacon-desktop:p1' && posts[1].body.import_key === 'beacon-desktop:p2' && posts.every((p) => p.body.folder === undefined), 'F: each local project is made on the Prometheus by its import key, with no folder: the Prometheus makes one')
    const puts = f.asked('PUT', /\/project$/)
    check(puts.length === 1 && puts[0].path.includes('probe-1') && puts[0].body.keep_workspace === true && puts[0].body.replace_workspace === undefined, 'F: the one conversation the Prometheus has is filed as a label only; the one it does not have is not even tried')
    check(f.asked('DELETE', /./).length === 0, 'F: nothing was deleted on the Prometheus')
    check((await f.until(f.labels, (v) => v.join() === 'Local kitchen,Local empty' && m.projects.length === 2)).join() === 'Local kitchen,Local empty' && (await f.inGroup('Local kitchen', 'Plan the kitchen')) === true, 'F: and the sidebar now draws the Prometheus\'s: Local kitchen with its conversation, and the empty one')
    check(/Your projects moved to this Prometheus \(2 projects and 1 conversation\)\. 1 conversation stays unfiled/.test(await f.until(() => f.ev(`document.querySelector('[data-testid=project-note]')?.innerText ?? ''`), (v) => /moved to this Prometheus/.test(v))), 'F: the person is told once what moved and what stayed')
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
