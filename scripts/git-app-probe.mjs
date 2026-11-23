#!/usr/bin/env node
// git-app-probe — git state in the session list and the conversation header, IN THE REAL APP,
// against a stand-in Prometheus on loopback that shares this computer's disk, and real
// repositories in a throwaway corner of the home folder.
//
//   npm run build && npm run probe:git
//
// PROBE_SHOT_DIR=<dir> writes screenshots there. Its own scratch profile, stand-in daemon and
// folders; the user's profile, Prometheus and repositories are not touched.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
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
const HOME = realpathSync(homedir())
const tidy = (s) => String(s).replaceAll(HOME, '~')
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${tidy(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

// The probe's own corner of the home folder, and the repositories in it.
const BASE = join(HOME, `beacon-probe-${Math.random().toString(36).slice(2, 8)}`)
const gitHome = mkdtempSync(join(tmpdir(), 'beacon-git-probe-home-'))
const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: gitHome, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const make = (name) => {
  const dir = join(BASE, name)
  mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '.')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'b.txt'), 'two\n')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', 'first')
  return dir
}
mkdirSync(BASE)
const CHANGED = make('Site')
g(CHANGED, 'checkout', '-q', '-b', 'feat/header')
writeFileSync(join(CHANGED, 'a.txt'), 'one, edited\n')
writeFileSync(join(CHANGED, 'new.txt'), 'new\n')
writeFileSync(join(CHANGED, 'more.txt'), 'more\n')
const CLEAN = make('Notes')
const UP = join(BASE, 'upstream.git')
g(BASE, 'clone', '-q', '--bare', CLEAN, UP)
const AHEAD = join(BASE, 'Api')
g(BASE, 'clone', '-q', UP, AHEAD)
g(AHEAD, 'commit', '-q', '--allow-empty', '-m', 'local one')
g(AHEAD, 'commit', '-q', '--allow-empty', '-m', 'local two')
const MERGING = make('Docs')
g(MERGING, 'checkout', '-q', '-b', 'other')
writeFileSync(join(MERGING, 'a.txt'), 'theirs\n')
g(MERGING, 'commit', '-q', '-am', 'theirs')
g(MERGING, 'checkout', '-q', 'main')
writeFileSync(join(MERGING, 'a.txt'), 'ours\n')
g(MERGING, 'commit', '-q', '-am', 'ours')
try {
  g(MERGING, 'merge', '-q', 'other')
} catch {
  /* the conflict is the point */
}
const PLAIN = join(BASE, 'Plain Folder')
mkdirSync(PLAIN)

const SESSIONS = [
  { id: 'beacon:git-changed', title: 'Rework the site header', folder: CHANGED },
  { id: 'beacon:git-clean', title: 'Tidy the meeting notes', folder: CLEAN },
  { id: 'beacon:git-ahead', title: 'Add the search endpoint', folder: AHEAD },
  { id: 'beacon:git-merging', title: 'Merge the docs branch', folder: MERGING },
  { id: 'beacon:git-plain', title: 'Sort the downloads', folder: PLAIN },
  { id: 'beacon:git-none', title: 'Plan the week', folder: null }
]

// ── the stand-in Prometheus: it shares this disk, so it accepts a folder that exists ─────────
// `sent`: anything that is not a read of what the probe set up (the proof's own folder writes aside) and
// every socket frame but the subscription: a message sent to the assistant would be one of these.
const daemon = { gets: {}, markers: 0, sent: [] }
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url === '/api/hello') return json(res, 200, { v: '0.9.21', name: 'Stand-in', agent: 'Atlas', fp: 'e'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/devices') return json(res, 200, [])
    const now = Math.floor(Date.now() / 1000)
    if (url === '/api/sessions' && req.method === 'GET') return json(res, 200, SESSIONS.map((s, i) => ({ session_id: s.id, title: s.title, gateway: 'beacon', message_count: 2, last_active: now - i * 600, created_at: now - 86400 })))
    if (req.method !== 'GET' && !/\/workspace$/.test(url)) daemon.sent.push(`${req.method} ${url}`)
    const m = /^\/api\/sessions\/(.+)\/workspace$/.exec(url)
    if (m) {
      const known = SESSIONS.find((s) => s.id === m[1])
      if (req.method === 'GET') {
        daemon.gets[m[1]] = (daemon.gets[m[1]] ?? 0) + 1
        return json(res, 200, known?.folder ? { source: 'session', workspace: known.folder, daemon_workspace_roots: [] } : { source: 'daemon', workspace: null, daemon_workspace_roots: [] })
      }
      if (req.method === 'PUT') {
        // The shared-disk proof: a folder this computer made is one this Prometheus can see.
        let path = null
        try {
          path = JSON.parse(body).path
        } catch {
          /* no path */
        }
        daemon.markers++
        return typeof path === 'string' && existsSync(path) ? json(res, 200, { ok: true, session_id: m[1], workspace: realpathSync(path) }) : json(res, 400, { error: 'not a folder here' })
      }
      return json(res, 200, { ok: true, session_id: m[1], workspace: null })
    }
    if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) return json(res, 200, { messages: [], watermark: 0 })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let f = null
    try {
      f = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (f?.type !== 'subscribe') daemon.sent.push(`ws ${String(f?.type)}`)
    if (f?.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() / 1000, payload: { sessions: [], capabilities: f.payload?.capabilities ?? [], server_capabilities: [], channels: [] } }))
  })
  ws.send(JSON.stringify({ type: 'connected' }))
})
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))

const profile = mkdtempSync(join(tmpdir(), 'beacon-git-profile-'))
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
  await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Chats'); b?.click(); return true })()`)
  await until(() => ev(`document.querySelectorAll('button.session-row').length`), (v) => v >= SESSIONS.length, 10000)
  const mark = (id) => ev(`(() => { const row = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes(${JSON.stringify(id)})); const m = row?.querySelector('[data-testid="git-mark"]'); return m ? { kind: m.dataset.kind, text: m.textContent.trim(), words: m.getAttribute('title'), width: Math.round(m.getBoundingClientRect().width), svg: !!m.querySelector('svg') } : null })()`)
  const settled = (id, kind) => until(() => mark(id), (v) => v?.kind === kind, 12000)

  const changed = await settled('beacon:git-changed', 'changes')
  check(changed?.kind === 'changes' && changed.text === '3' && changed.svg, 'a conversation whose folder has three changed files shows the branch mark with a 3', JSON.stringify(changed))
  check(/Git: feat\/header · 3 changed files/.test(changed?.words ?? ''), 'and says the branch and the count in words', changed?.words)
  const clean = await settled('beacon:git-clean', 'branch')
  check(clean?.kind === 'branch' && clean.text === '' && /Git: main · nothing changed$/.test(clean.words ?? ''), 'a clean repository shows the plain branch mark, with no number', JSON.stringify(clean))
  const ahead = await settled('beacon:git-ahead', 'moved')
  check(ahead?.kind === 'moved' && /nothing changed · 2 ahead of origin\/main$/.test(ahead.words ?? ''), 'a repository two commits ahead of its upstream shows the moved mark, and says how far', JSON.stringify(ahead))
  const merging = await settled('beacon:git-merging', 'alert')
  check(merging?.kind === 'alert' && /a merge is under way/.test(merging.words ?? '') && /1 in conflict/.test(merging.words ?? ''), 'a merge stopped on a conflict shows the warning mark, and says why', JSON.stringify(merging))
  await sleep(1500)
  const plain = await mark('beacon:git-plain')
  const none = await mark('beacon:git-none')
  check((daemon.gets['beacon:git-plain'] ?? 0) >= 1 && (daemon.gets['beacon:git-none'] ?? 0) >= 1, 'both were asked about (so "nothing" below is an answer, not a row that was never read)', JSON.stringify(daemon.gets))
  check(plain?.kind === 'none' && plain.width === 0 && none?.kind === 'none' && none.width === 0, 'a folder that is not a repository, and a conversation with no folder, show nothing and take no room', JSON.stringify([plain, none]))
  const kinds = [changed, clean, ahead, merging].map((m) => m?.kind)
  check(new Set(kinds).size === 4, 'the four states are four different marks')
  check(daemon.markers === 1, 'the shared-disk proof was asked of Prometheus once', String(daemon.markers))
  await shot('git-session-list')

  // Open the conversation with changes: its header has the branch chip.
  await ev(`(() => { const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes('beacon:git-changed')); b?.click(); return !!b })()`)
  const chip = () => ev(`(() => { const c = document.querySelector('[data-testid="git-chip"]'); return c ? { kind: c.dataset.kind, text: c.innerText.replace(/\\s+/g, ' ').trim(), words: c.getAttribute('title') } : null })()`)
  const first = await until(chip, (v) => v !== null, 10000)
  check(first?.kind === 'changes' && /feat\/header/.test(first.text) && /\b3\b/.test(first.text), 'the open conversation shows its branch and the number of changed files beside its folder', JSON.stringify(first))
  check((await ev(`(() => { const f = document.querySelector('[data-testid="work-folder-chip"]'); const c = document.querySelector('[data-testid="git-chip"]'); if (!f || !c) return null; const a = f.getBoundingClientRect(), b = c.getBoundingClientRect(); return Math.abs(a.top - b.top) < 3 && Math.abs(a.height - b.height) < 3 && b.left > a.left })()`)) === true, 'the chip sits on the same line as the folder chip, the same height, after it')
  await shot('git-header-chip')
  // The folder changes under it: the chip follows without anyone asking.
  writeFileSync(join(CHANGED, 'fourth.txt'), 'another\n')
  const followed = await until(chip, (v) => /\b4\b/.test(v?.text ?? ''), 20000)
  check(/\b4\b/.test(followed?.text ?? ''), 'a file added in the folder shows up in the chip within a few seconds', JSON.stringify(followed))
  const rowFollowed = await until(() => mark('beacon:git-changed'), (v) => v?.text === '4', 6000)
  check(rowFollowed?.text === '4', 'and on its row in the list: the two read the same answer')
  // ── the Git panel: the changed files, a diff, Esc ──────────────────────────────────────────
  await ev(`(() => { document.querySelector('[data-testid="git-chip"]').click(); return true })()`)
  const panel = () => ev(`(() => { const p = document.querySelector('[data-testid="git-panel"]'); return p ? { text: p.innerText, files: [...p.querySelectorAll('[data-testid="git-file"]')].map((f) => f.dataset.path + '=' + f.querySelector('.git-file-what').textContent) } : null })()`)
  const listed = await until(panel, (v) => (v?.files.length ?? 0) >= 4, 8000)
  check(listed?.files.slice().sort().join('|') === 'a.txt=modified|fourth.txt=new file|more.txt=new file|new.txt=new file', 'clicking the chip lists the changed files, each with what happened to it', JSON.stringify(listed?.files))
  check(/NOT STAGED\s*1/i.test(listed?.text ?? '') && /UNTRACKED\s*3/i.test(listed?.text ?? '') && /Git: feat\/header · 4 changed files/.test(listed?.text ?? ''), 'grouped, with the same words as the chip at the top', (listed?.text ?? '').replace(/\n/g, ' | ').slice(0, 200))
  await ev(`(() => { [...document.querySelectorAll('[data-testid="git-file"]')].find((f) => f.dataset.path === 'a.txt').click(); return true })()`)
  const diff = await until(() => ev(`document.querySelector('[data-testid="git-diff"]')?.innerText ?? null`), (v) => v !== null, 8000)
  check(/^-one$/m.test(diff ?? '') && /^\+one, edited$/m.test(diff ?? ''), "clicking a file shows its diff: the line that went and the line that came", (diff ?? '').replace(/\n/g, ' | ').slice(0, 200))
  check((await ev(`(() => { const a = document.querySelector('.git-diff-line.is-add'), d = document.querySelector('.git-diff-line.is-del'); return !!a && !!d && getComputedStyle(a).color !== getComputedStyle(d).color })()`)) === true, 'added and removed lines are told apart (and each starts with its own sign)')
  // Wholly visible: inside the conversation's header side to side, and the element actually on top at its corners is the panel itself.
  const vis = await ev(`(() => { const el = document.querySelector('[data-testid="git-panel"]'); const p = el.getBoundingClientRect(); const h = el.closest('.thread-head').getBoundingClientRect(); const at = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && el.contains(t) }; return { inside: p.left >= h.left && p.right <= h.right && p.bottom <= window.innerHeight, corners: [at(p.left + 4, p.top + 4), at(p.right - 4, p.top + 4), at(p.left + 4, p.bottom - 4), at(p.right - 4, p.bottom - 4)], width: Math.round(p.width) } })()`)
  check(vis.inside && vis.corners.every(Boolean), 'the panel is wholly visible: inside the conversation pane, with nothing over its corners', JSON.stringify(vis))
  await shot('git-panel')
  // The file changes again while its diff is open: the diff follows, without being clicked, and never goes blank.
  writeFileSync(join(CHANGED, 'a.txt'), 'one, edited twice\n')
  let blank = false
  const followedDiff = await until(async () => {
    const t = await ev(`document.querySelector('[data-testid="git-diff"]')?.innerText ?? null`)
    if (t === null) blank = true
    return t ?? ''
  }, (v) => /\+one, edited twice/.test(v), 20000)
  check(/^\+one, edited twice$/m.test(followedDiff) && !blank, 'an open diff follows the file as it changes, and is never blanked while it does', followedDiff.replace(/\n/g, ' | ').slice(-80))
  // A new file: the whole file, added.
  await ev(`(() => { [...document.querySelectorAll('[data-testid="git-file"]')].find((f) => f.dataset.path === 'new.txt').click(); return true })()`)
  const diff2 = await until(() => ev(`document.querySelector('[data-testid="git-diff"]')?.innerText ?? ''`), (v) => /\+new/.test(v), 8000)
  check(/^\+new$/m.test(diff2), "a new file's diff is its content, added")
  // ── the action buttons: each only fills the message box ───────────────────────────────────
  /** Open the panel if it is not open: a click on the chip toggles it. */
  const openPanel = async () => {
    if ((await panel()) === null) await ev(`(() => { document.querySelector('[data-testid="git-chip"]').click(); return true })()`)
    await until(acts, (v) => v.length > 0, 5000)
  }
  const acts = () => ev(`[...document.querySelectorAll('[data-testid="git-action"]')].map((b) => b.dataset.action).join()`)
  check((await acts()) === 'commit,branch,push', 'a branch with changed files and no upstream offers: commit, start a branch, push', await acts())
  check(/usual approvals/.test((await panel())?.text ?? '') && /you send it/.test((await panel())?.text ?? ''), 'and the panel says they only fill the message box, and that the usual approvals apply')
  await shot('git-actions')
  const draft = () => ev(`document.querySelector('.composer-shell textarea')?.value ?? null`)
  check((await draft()) === '', 'the message box is empty to begin with')
  // Chat mode has no tools: a request to commit would be useless there, so the button sets Agent.
  const agentOn = () => ev(`[...document.querySelectorAll('.mode-toggle .mode-opt')].find((b) => /^Agent/.test(b.textContent.trim()))?.getAttribute('aria-pressed')`)
  await ev(`(() => { [...document.querySelectorAll('.mode-toggle .mode-opt')].find((b) => /^Chat/.test(b.textContent.trim()))?.click(); return true })()`)
  await openPanel()
  check((await agentOn()) === 'false', 'with the conversation in Chat mode (no tools) to begin with')
  const sentBefore = daemon.sent.length
  await ev(`(() => { document.querySelector('[data-testid="git-action"][data-action="commit"]').click(); return true })()`)
  await sleep(600)
  const d1 = await draft()
  check(/^Look at what has changed with git status and git diff\. Stage only the files that belong to this work, by name/.test(d1 ?? '') && /don’t push\.$/.test(d1 ?? ''), 'clicking "Commit these changes" puts the prepared request in the message box', d1)
  check((await panel()) === null && (await ev(`document.activeElement?.tagName`)) === 'TEXTAREA', 'the panel closes and the message box has the keyboard, ready to send, change or clear')
  check((await agentOn()) === 'true', 'and the conversation is in Agent mode, the mode with tools')
  check(daemon.sent.length === sentBefore, 'nothing was sent to Prometheus: no message, no frame', daemon.sent.slice(sentBefore).join(' | '))
  check((await ev(`window.beacon.approvals.list().then((l) => l.length)`)) === 0, 'and nothing is waiting for approval: the buttons start nothing')
  // Reopen, and ask for another: it goes after what is there, in its own paragraph.
  await openPanel()
  await ev(`(() => { document.querySelector('[data-testid="git-action"][data-action="push"]').click(); return true })()`)
  await sleep(600)
  const d2 = await draft()
  check((d2 ?? '').startsWith(d1 ?? '#') && /\n\nPush the current branch to a remote branch of the same name \(git push -u origin HEAD\)\. .*Don’t force-push\. Tell me what was pushed\.$/.test(d2 ?? ''), 'a second button adds its request after the first, in its own paragraph', d2)
  check(daemon.sent.length === sentBefore, 'still nothing sent')
  // Typing in the box is the person's: clear it before the rest.
  await ev(`(() => { const t = document.querySelector('.composer-shell textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await openPanel()
  await app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check((await until(panel, (v) => v === null, 3000)) === null && (await ev(`document.activeElement?.dataset.testid`)) === 'git-chip', 'Esc closes the panel and gives the focus back to the chip')

  // A clean repository on main: a new branch is the only thing to offer; commit, push and a pull request are not.
  await ev(`(() => { const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes('beacon:git-clean')); b?.click(); return !!b })()`)
  await until(() => chip(), (v) => v?.kind === 'branch', 10000)
  await openPanel()
  check((await acts()) === 'branch', 'on a clean main: only "Start a new branch"; no commit (nothing changed), no push or pull request (the default branch)', await acts())
  await app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(panel, (v) => v === null, 3000)
  // A conversation with no repository has no chip.
  await ev(`(() => { const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes('beacon:git-none')); b?.click(); return !!b })()`)
  await sleep(2500)
  check((await chip()) === null, 'a conversation with no folder has no branch chip')
  // What it cost Prometheus: a handful of reads per conversation, not a stream.
  const most = Math.max(...Object.values(daemon.gets))
  check(most <= 26, `no conversation's folder was asked for more than a couple of dozen times in this run (most: ${most})`, JSON.stringify(daemon.gets))
} finally {
  await app?.quit().catch(() => undefined)
  for (const s of [rest, wsHttp]) s.close()
  rmSync(profile, { recursive: true, force: true })
  rmSync(gitHome, { recursive: true, force: true })
  rmSync(BASE, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
