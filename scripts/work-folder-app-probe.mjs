#!/usr/bin/env node
// work-folder-app-probe — a conversation's working folder IN THE REAL APP, against a stand-in
// Prometheus on loopback that, like the real one, accepts only a folder it can see and names its
// real path back.
//
// Launch 1, a Prometheus that shares this disk: Beacon proves that (the stand-in sees the marker
// folder Beacon makes), the header always shows the folder, a link that leads to the home folder
// is refused as the home folder, the question names the real path and lists what is granted, the
// set is one PUT of that path, a set the stand-in resolves elsewhere is taken back, and a check
// that fails later keeps the chip, marked as unchecked.
// Launch 2, the same address but a Prometheus that cannot see this disk (what an SSH tunnel or a
// container looks like): no picker, no "on this computer", and main refuses a pick without a dialog.
//
//   npm run build && npm run probe:work-folder
//
// The system folder picker is replaced, in this run only, by a function that returns the folder
// the probe names: no dialog is shown. The probe makes one folder of its own in the home folder
// (beacon-probe-<random>, with a subfolder and a link in it) and removes it at the end; nothing
// else on the disk is touched. Its own scratch profile and stand-in daemon.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
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
const HOME = realpathSync(homedir())
const tidy = (s) => String(s).replaceAll(HOME, '~')
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${tidy(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const SID = 'beacon:folder-probe'

// The probe's own corner of the home folder.
const BASE = join(HOME, `beacon-probe-${Math.random().toString(36).slice(2, 8)}`)
const GOOD = join(BASE, 'Work Folder')
const LINK_HOME = join(BASE, 'link-to-home')
const LINK_GOOD = join(BASE, 'link-to-work')
mkdirSync(GOOD, { recursive: true })
symlinkSync(HOME, LINK_HOME)
symlinkSync(GOOD, LINK_GOOD)
const SHOWN = `~${GOOD.slice(HOME.length)}`

// ── the stand-in Prometheus ───────────────────────────────────────────────────────────────────
// sharesDisk false = it cannot see this computer's folders. resolveTo set = it names another folder
// back than it was given. failGets = it cannot answer which folder a conversation has.
const daemon = { bound: null, writes: [], markers: [], sharesDisk: true, resolveTo: null, failGets: false }
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url === '/api/hello') return json(res, 200, { v: '0.9.20', name: 'Stand-in', agent: 'Atlas', fp: 'f'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/devices') return json(res, 200, [])
    if (url === '/api/sessions') return json(res, 200, [{ session_id: SID, title: 'Folder probe', gateway: 'beacon', message_count: 0, last_active: Math.floor(Date.now() / 1000), created_at: Math.floor(Date.now() / 1000) }])
    const m = /^\/api\/sessions\/(.+)\/workspace$/.exec(url)
    if (m) {
      const session = m[1]
      if (req.method === 'GET') {
        if (daemon.failGets) return json(res, 500, { error: 'store is busy' })
        const b = session === SID ? daemon.bound : null
        return json(res, 200, b ? { source: 'session', workspace: b, daemon_workspace_roots: ['~/.prometheus/workspace'] } : { source: 'daemon', workspace: null, daemon_workspace_roots: ['~/.prometheus/workspace'] })
      }
      const mine = session === SID
      ;(mine ? daemon.writes : daemon.markers).push(`${req.method} ${body}`)
      if (req.method === 'DELETE') {
        if (mine) daemon.bound = null
        return json(res, 200, { ok: true, session_id: session, workspace: null })
      }
      const path = JSON.parse(body).path
      // As Prometheus does: a folder it cannot see is refused; one it can is named by its real path.
      const visible = daemon.sharesDisk && existsSync(path) && statSync(path).isDirectory()
      if (!visible) return json(res, 400, { error: `${path} is not an existing directory` })
      const resolved = (mine && daemon.resolveTo) || realpathSync(path)
      if (mine) daemon.bound = resolved
      return json(res, 200, { ok: true, session_id: session, workspace: resolved })
    }
    if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) return json(res, 200, { messages: [], watermark: 0 })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '127.0.0.1', r))

function seed() {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-work-folder-'))
  execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
    INSERT INTO gateway_profiles VALUES ('standin', 'http://127.0.0.1:${rest.address().port}', 'ws://127.0.0.1:${wsHttp.address().port}', 1, NULL);`])
  return profile
}

async function drive(run) {
  const profile = seed()
  const app = await launchApp({ profile })
  try {
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
    const connected = await until(() => ev(`window.beacon.connection.status().then((s) => s.state)`), (v) => v === 'connected', 15000)
    // The picker, stood in for: main's dialog returns whatever the probe last named.
    await app.mainEval(`(() => { globalThis.__pick = null; globalThis.__pickCalls = 0; __electron.dialog.showOpenDialog = async () => { globalThis.__pickCalls++; return globalThis.__pick ? { canceled: false, filePaths: [globalThis.__pick] } : { canceled: true, filePaths: [] } }; return true })()`)
    const pickNext = (p) => app.mainEval(`(() => { globalThis.__pick = ${JSON.stringify(p)}; return true })()`)
    const pickCalls = () => app.mainEval(`globalThis.__pickCalls`)
    await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Chats'); b?.click(); return true })()`)
    await until(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true, 8000)
    await sleep(800)
    await ev(`(() => { const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.includes(${JSON.stringify(SID)})); b?.click(); return !!b })()`)
    const CHIP = `document.querySelector('[data-testid="work-folder-chip"]')`
    const PANEL = `document.querySelector('.work-folder-panel')`
    const chip = () => ev(`${CHIP} ? { text: ${CHIP}.textContent.trim(), title: ${CHIP}.title, state: ${CHIP}.dataset.state } : null`)
    const panel = () => ev(`${PANEL}?.innerText ?? null`)
    const press = (label) => ev(`(() => { const b = [...(${PANEL}?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)
    const has = (label) => ev(`[...(${PANEL}?.querySelectorAll('button') ?? [])].some((x) => x.textContent.trim() === ${JSON.stringify(label)})`)
    const openPanel = async () => {
      if ((await panel()) === null) await ev(`${CHIP}.click()`)
      return until(panel, (v) => v !== null)
    }
    await run({ app, ev, until, connected, chip, panel, press, has, pickNext, pickCalls, openPanel, CHIP })
  } finally {
    await app.quit().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
}

try {
  // ── launch 1: a Prometheus that shares this disk ────────────────────────────────────────────
  await drive(async ({ app, ev, until, connected, chip, panel, press, has, pickNext, pickCalls, openPanel, CHIP }) => {
    check(connected === 'connected', 'connected to the stand-in Prometheus over loopback')
    const none = await until(chip, (v) => v !== null, 8000)
    check(none?.text === 'No folder' && none.state === 'none', "an open conversation's header shows it has no folder", JSON.stringify(none))
    const first = await openPanel()
    check(/No working folder/.test(first), 'the chip opens a panel that says so')
    check((await until(() => has('Choose a folder…'), (v) => v === true)) === true, 'and offers Choose a folder…, once the shared disk is proved')
    check(daemon.markers.length === 2 && /^PUT .*beacon-here-/.test(daemon.markers[0]) && daemon.markers[1].startsWith('DELETE'), 'the proof was one marker folder shown to Prometheus under a throwaway session, then taken back', daemon.markers.join(' | ').slice(0, 160))
    const markerPath = JSON.parse(daemon.markers[0].slice(4)).path
    check(!existsSync(markerPath), 'and the marker folder is gone from this disk')
    check(daemon.writes.length === 0 && (await has('Stop using this folder')) === false, "nothing was done to the conversation itself, and there is nothing to stop yet")

    // A folder that is really "everything" is refused before any question.
    await pickNext(HOME)
    await press('Choose a folder…')
    check(/whole home folder/.test(await until(panel, (v) => /whole home folder/.test(v ?? ''))), 'choosing the whole home folder is refused, and says why')
    check((await has('Use this folder')) === false && daemon.writes.length === 0, 'with no question asked and nothing sent')
    // A link that LEADS to the home folder is the home folder: Prometheus would follow it.
    await pickNext(LINK_HOME)
    await press('Choose a folder…')
    await sleep(500)
    check(/whole home folder/.test((await panel()) ?? '') && (await has('Use this folder')) === false && daemon.writes.length === 0, 'so is a link that leads to the home folder: it is judged by where it leads')

    // Cancelling the picker changes nothing.
    await pickNext(null)
    const callsBefore = await pickCalls()
    await press('Choose a folder…')
    await sleep(400)
    check((await pickCalls()) === callsBefore + 1 && daemon.writes.length === 0 && (await has('Use this folder')) === false, 'cancelling the picker changes nothing')

    // A real folder, reached through a link: the question names where it really is, and what is granted.
    await pickNext(LINK_GOOD)
    await press('Choose a folder…')
    const ask = await until(panel, (v) => /Let your assistant work in/.test(v ?? ''))
    check(ask.includes(`Let your assistant work in ${SHOWN}?`), 'a folder of your own is asked about first, by its real name (not the link that led to it)', ask.split('\n')[0])
    check((await ev(`document.querySelector('[data-testid="work-folder-confirm-path"]')?.textContent`)) === GOOD, 'with its full real path in view')
    check(/without asking you each time/.test(ask) && /run commands there/.test(ask) && /instruction files/.test(ask) && /keep a copy/.test(ask) && /next reply/.test(ask), 'the question lists what setting it does: changes without asking, commands, instruction files, a copy for undo')
    check((await ev(`document.activeElement?.textContent?.trim()`)) === 'Cancel', 'the question takes the keyboard, on Cancel')
    check(daemon.writes.length === 0, 'nothing is sent while the question is up')
    await press('Cancel')
    await sleep(300)
    check(daemon.writes.length === 0 && (await chip()).text === 'No folder', 'Cancel leaves the conversation with no folder')

    // A set that Prometheus resolves to ANOTHER folder than the one agreed to is taken back.
    daemon.resolveTo = join(BASE, 'somewhere-else')
    await pickNext(GOOD)
    await press('Choose a folder…')
    await until(panel, (v) => /Let your assistant work in/.test(v ?? ''))
    await press('Use this folder')
    const back = await until(panel, (v) => /taken it back/.test(v ?? ''), 6000)
    check(/took that to mean a different folder/.test(back) && /taken it back/.test(back), 'when Prometheus binds a different folder than the one agreed to, Beacon says so')
    check(daemon.writes.length === 2 && daemon.writes[0].startsWith('PUT') && daemon.writes[1].startsWith('DELETE') && daemon.bound === null, 'and has already taken it back')
    check((await chip()).text === 'No folder', 'the header says No folder')
    daemon.resolveTo = null
    daemon.writes.length = 0

    await pickNext(GOOD)
    await press('Choose a folder…')
    await until(panel, (v) => /Let your assistant work in/.test(v ?? ''))
    await press('Use this folder')
    const set = await until(chip, (v) => v?.text === 'Work Folder')
    check(set?.text === 'Work Folder' && set.state === 'bound', 'after Use this folder, the header shows the folder by name', JSON.stringify(set))
    check(set?.title === `Your assistant is working in ${SHOWN}, on this computer.`, 'and its full line says where', set?.title)
    check(daemon.writes.length === 1 && daemon.writes[0] === `PUT ${JSON.stringify({ path: GOOD })}`, 'Prometheus was sent exactly one PUT, with the real path that was agreed to', daemon.writes.join(' | '))
    const said = await panel()
    check(said.includes(`now works in ${SHOWN}, from its next reply`), 'the panel says it is set, and from when')
    check((await ev(`document.querySelector('[data-testid="work-folder-path"]')?.textContent`)) === SHOWN, 'and shows the path')
    check((await has('Stop using this folder')) === true && (await has('Choose another folder…')) === true, 'with Stop using this folder and Choose another folder…')

    // A later check that fails does not make the chip go away: it says it could not check.
    daemon.failGets = true
    await ev(`(window.dispatchEvent(new Event('focus')), true)`)
    const lost = await until(chip, (v) => v?.state === 'unknown', 5000)
    check(lost?.state === 'unknown' && lost.text === 'Work Folder?', 'when Beacon cannot check, the chip stays, marked as unchecked', JSON.stringify(lost))
    check(/could not check/.test(lost?.title ?? '') && (lost?.title ?? '').includes(`last working in ${SHOWN}`), 'and says what it last knew')
    daemon.failGets = false
    await ev(`(window.dispatchEvent(new Event('focus')), true)`)
    check((await until(chip, (v) => v?.state === 'bound', 5000))?.text === 'Work Folder', 'and is sure again once the check goes through')

    // The header at the narrowest window the app allows.
    await openPanel()
    const fits = await app.mainEval(`(async () => { const w = __electron.BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('#')); const [mw, mh] = w.getMinimumSize(); w.setSize(Math.max(mw, 1), Math.max(mh, 600)); await new Promise((r) => setTimeout(r, 500)); return w.getSize() })()`)
    const measure = `(() => { const h = document.querySelector('.thread-head').getBoundingClientRect(); const kids = [...document.querySelectorAll('.thread-head .thread-tools > *')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.getBoundingClientRect()); return kids.every((r) => r.left >= h.left - 1 && r.right <= h.right + 1) })()`
    const withChip = await ev(measure)
    await ev(`(document.querySelector('.work-folder').style.display = 'none', true)`)
    const without = await ev(measure)
    await ev(`(document.querySelector('.work-folder').style.display = '', true)`)
    if (without === false) console.log(`[probe] SKIP  at the smallest window (${fits?.join('×')}) the header's tools already overflow without the chip, so "the chip does not push them out" cannot be shown here`)
    else check(withChip === true, `at the smallest window (${fits?.join('×')}) the header's tools still fit with the chip`)
    const boxes = await ev(`(() => { const p = document.querySelector('.work-folder-panel')?.getBoundingClientRect(); const pane = document.querySelector('.thread-head').getBoundingClientRect(); const name = document.querySelector('.work-folder-name'); return p ? { left: Math.round(p.left - pane.left), right: Math.round(pane.right - p.right), name: name && getComputedStyle(name).display !== 'none' ? name.textContent : null } : null })()`)
    check(!!boxes && boxes.left >= 0 && boxes.right >= 0, 'the open panel is wholly inside the conversation pane', JSON.stringify(boxes))
    check(typeof boxes?.name === 'string' && boxes.name.length > 0, 'and in a pane this narrow the chip still shows the folder name')
    if (process.env.PROBE_SHOT_DIR) {
      const shot = await app.page.send('Page.captureScreenshot', { format: 'png' })
      if (shot.result?.data) writeFileSync(join(process.env.PROBE_SHOT_DIR, 'work-folder.png'), Buffer.from(shot.result.data, 'base64'))
    }

    // Esc closes the panel; the chip still says where the conversation is working.
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check((await until(panel, (v) => v === null)) === null && (await chip()).text === 'Work Folder', 'Esc closes the panel and the header still shows the folder')

    await openPanel()
    await press('Stop using this folder')
    check((await until(chip, (v) => v?.text === 'No folder'))?.text === 'No folder', 'Stop using this folder puts the header back to No folder')
    check(daemon.writes.length === 2 && daemon.writes[1].startsWith('DELETE'), 'by one DELETE to Prometheus')
    check(/no longer works in that folder/.test(await panel()) && /untouched/.test(await panel()) && existsSync(GOOD), 'and says the folder itself is untouched, which it is')
  })

  // ── launch 2: the same loopback address, but Prometheus cannot see this disk ────────────────
  // What an SSH tunnel, a container's forwarded port or a virtual machine looks like to Beacon.
  daemon.sharesDisk = false
  daemon.bound = '/srv/shared/reports'
  daemon.writes.length = 0
  daemon.markers.length = 0
  await drive(async ({ ev, until, connected, chip, panel, has, pickNext, pickCalls, openPanel }) => {
    check(connected === 'connected', 'connected again, to a Prometheus on loopback that does not share this disk')
    const there = await until(chip, (v) => v?.state === 'bound', 8000)
    check(there?.text === 'reports' && /working in \/srv\/shared\/reports, on the Prometheus computer\./.test(there.title), 'the header shows the folder, and does not call it "on this computer"', JSON.stringify(there))
    const p = await openPanel()
    const words = await until(panel, (v) => /through this computer/.test(v ?? ''), 6000)
    check(/reaches Prometheus through this computer, but the two do not share its folders/.test(words) && /\/workspace/.test(words), 'the panel says it is reached through this computer without sharing its folders, and the way that does work', (words ?? p).slice(0, 200))
    check((await has('Choose a folder…')) === false && (await has('Choose another folder…')) === false, 'and offers no picker')
    check(daemon.markers.some((m) => m.startsWith('PUT')) && daemon.markers.some((m) => m.startsWith('DELETE')), 'it found that out by trying the marker, and took the attempt back')
    await pickNext(GOOD)
    const direct = await ev(`window.beacon.workFolder.pick()`)
    check(direct?.kind === 'not-here' && (await pickCalls()) === 0, 'asked for a picker anyway, main refuses without opening a dialog', JSON.stringify(direct))
    check(daemon.writes.length === 0, 'and nothing was done to the conversation')
  })
} finally {
  for (const s of [rest, wsHttp]) s.close()
  rmSync(BASE, { recursive: true, force: true })
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
