#!/usr/bin/env node
// work-folder-app-probe — a conversation's working folder IN THE REAL APP, against a stand-in
// Prometheus on loopback (so Prometheus is "on this computer"): the header always shows the
// folder, the picker's answer goes through the refusals and the confirmation before anything is
// set, the set and the clear reach Prometheus as PUT and DELETE, and a second launch against the
// same stand-in reached by a non-loopback name is offered no picker.
//
//   npm run build && npm run probe:work-folder
//
// The system folder picker is replaced, in this run only, by a function that returns the folder
// the probe names: no dialog is shown and nothing on the real disk is read or written. Its own
// scratch profile and fake daemon; the user's profile and Prometheus are not touched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 300)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const SID = 'beacon:folder-probe'
const HOME = homedir()
const GOOD = join(HOME, 'Documents', 'Probe Folder')

// ── the stand-in Prometheus ───────────────────────────────────────────────────────────────────
const daemon = { bound: null, writes: [] }
const rest = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url === '/api/hello') return json(res, 200, { v: '0.9.20', name: 'Stand-in', agent: 'Atlas', fp: 'f'.repeat(16), pair: 'approve', tls: false })
    if (url === '/api/status') return json(res, 200, { state: 'idle', provider: 'anthropic', model: 'stub-model' })
    if (url === '/api/devices') return json(res, 200, [])
    if (url === '/api/sessions') return json(res, 200, [{ session_id: SID, title: 'Folder probe', gateway: 'beacon', message_count: 0, last_active: Math.floor(Date.now() / 1000), created_at: Math.floor(Date.now() / 1000) }])
    if (url === `/api/sessions/${SID}/workspace`) {
      if (req.method === 'GET') return json(res, 200, daemon.bound ? { source: 'session', workspace: daemon.bound, daemon_workspace_roots: ['~/.prometheus/workspace'] } : { source: 'daemon', workspace: '~/.prometheus/workspace', daemon_workspace_roots: ['~/.prometheus/workspace'] })
      daemon.writes.push(`${req.method} ${body}`)
      if (req.method === 'PUT') {
        daemon.bound = JSON.parse(body).path
        return json(res, 200, { ok: true, session_id: SID, workspace: daemon.bound })
      }
      if (req.method === 'DELETE') {
        daemon.bound = null
        return json(res, 200, { ok: true, session_id: SID, workspace: null })
      }
    }
    if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) return json(res, 200, { messages: [], watermark: 0 })
    json(res, 200, [])
  })
})
const wsHttp = createServer()
new WebSocketServer({ server: wsHttp }).on('connection', (ws) => ws.send(JSON.stringify({ type: 'connected' })))
// On every interface, so the second launch can reach the same stand-in by a name that is not loopback.
for (const s of [rest, wsHttp]) await new Promise((r) => s.listen(0, '0.0.0.0', r))

function seed(host) {
  const profile = mkdtempSync(join(tmpdir(), 'beacon-work-folder-'))
  execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
    INSERT INTO gateway_profiles VALUES ('standin', 'http://${host}:${rest.address().port}', 'ws://${host}:${wsHttp.address().port}', 1, NULL);`])
  return profile
}

async function drive(profile, run) {
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
    const chip = () => ev(`${CHIP} ? { text: ${CHIP}.textContent.trim(), title: ${CHIP}.title } : null`)
    const panel = () => ev(`${PANEL}?.innerText ?? null`)
    const press = (label) => ev(`(() => { const b = [...(${PANEL}?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)
    const has = (label) => ev(`[...(${PANEL}?.querySelectorAll('button') ?? [])].some((x) => x.textContent.trim() === ${JSON.stringify(label)})`)
    await run({ app, ev, until, connected, chip, panel, press, has, pickNext, pickCalls, CHIP })
  } finally {
    await app.quit().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
}

try {
  // ── launch 1: Prometheus on this computer (loopback) ────────────────────────────────────────
  await drive(seed('127.0.0.1'), async ({ app, ev, until, connected, chip, panel, press, has, pickNext, pickCalls, CHIP }) => {
    check(connected === 'connected', 'connected to the stand-in Prometheus over loopback')
    const none = await until(chip, (v) => v !== null, 8000)
    check(none?.text === 'No folder', "an open conversation's header shows it has no folder", JSON.stringify(none))
    await ev(`${CHIP}.click()`)
    check(/No working folder/.test(await until(panel, (v) => v !== null)), 'the chip opens a panel that says so')
    check((await has('Choose a folder…')) === true, 'and, on this computer, offers Choose a folder…')
    check((await has('Stop using this folder')) === false, 'with nothing to stop yet')

    // A folder that is really "everything" is refused before any confirmation.
    await pickNext(HOME)
    await press('Choose a folder…')
    check(/whole home folder/.test(await until(panel, (v) => /whole home folder/.test(v ?? ''))), 'choosing the whole home folder is refused, and says why')
    check((await has('Use this folder')) === false && daemon.writes.length === 0, 'with no confirmation offered and nothing sent')
    await pickNext(join(HOME, '.ssh'))
    await press('Choose a folder…')
    check(/settings and keys/.test(await until(panel, (v) => /settings and keys/.test(v ?? ''))), 'so is the folder that holds keys')
    check(daemon.writes.length === 0, 'still nothing sent')

    // Cancelling the picker changes nothing.
    await pickNext(null)
    const callsBefore = await pickCalls()
    await press('Choose a folder…')
    await sleep(400)
    check((await pickCalls()) === callsBefore + 1 && daemon.writes.length === 0 && (await has('Use this folder')) === false, 'cancelling the picker changes nothing')

    // A real folder: the confirmation comes first, and says what is granted.
    await pickNext(GOOD)
    await press('Choose a folder…')
    const ask = await until(panel, (v) => /Let your assistant work in/.test(v ?? ''))
    check(/Let your assistant work in ~\/Documents\/Probe Folder\?/.test(ask), 'a folder of your own is asked about first, by name', ask.split('\n')[0])
    check(/read, change and delete files/.test(ask) && /next reply/.test(ask), 'the question says what the assistant will be able to do, and from when')
    check(daemon.writes.length === 0, 'nothing is sent while the question is up')
    await press('Cancel')
    await sleep(300)
    check(daemon.writes.length === 0 && (await chip()).text === 'No folder', 'Cancel leaves the conversation with no folder')

    await pickNext(GOOD)
    await press('Choose a folder…')
    await until(panel, (v) => /Let your assistant work in/.test(v ?? ''))
    await press('Use this folder')
    const set = await until(chip, (v) => v?.text === 'Probe Folder')
    check(set?.text === 'Probe Folder', 'after Use this folder, the header shows the folder by name', JSON.stringify(set))
    check(set?.title === 'Your assistant is working in ~/Documents/Probe Folder, on this computer.', 'and its full line says where', set?.title)
    check(daemon.writes.length === 1 && daemon.writes[0] === `PUT ${JSON.stringify({ path: GOOD })}`, 'Prometheus was sent exactly one PUT, with the chosen path', daemon.writes.join(' | ').replaceAll(HOME, '~'))
    const said = await panel()
    check(/now works in ~\/Documents\/Probe Folder, from its next reply/.test(said), 'the panel says it is set, and from when')
    check((await ev(`document.querySelector('[data-testid="work-folder-path"]')?.textContent`)) === '~/Documents/Probe Folder', 'and shows the path')
    check((await has('Stop using this folder')) === true && (await has('Choose another folder…')) === true, 'with Stop using this folder and Choose another folder…')
    // The header at the narrowest window the app allows: the chip must not push the title or the
    // other tools out. PROBE_SHOT_DIR=<dir> also writes the picture, for looking at.
    const fits = await app.mainEval(`(async () => { const w = __electron.BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('#')); const [mw, mh] = w.getMinimumSize(); w.setSize(Math.max(mw, 1), Math.max(mh, 600)); await new Promise((r) => setTimeout(r, 500)); return w.getSize() })()`)
    // Measured against the same header WITHOUT the chip: the chip may not make it overflow, and the
    // panel must open inside the conversation pane.
    const measure = `(() => { const h = document.querySelector('.thread-head').getBoundingClientRect(); const kids = [...document.querySelectorAll('.thread-head .thread-tools > *')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.getBoundingClientRect()); return kids.every((r) => r.left >= h.left - 1 && r.right <= h.right + 1) })()`
    const withChip = await ev(measure)
    await ev(`(document.querySelector('.work-folder').style.display = 'none', true)`)
    const without = await ev(measure)
    await ev(`(document.querySelector('.work-folder').style.display = '', true)`)
    check(withChip === without || withChip === true, `at the smallest window (${fits?.join('×')}) the chip does not push the header's tools out`, `with: ${withChip}, without: ${without}`)
    const boxes = await ev(`(() => { const p = document.querySelector('.work-folder-panel')?.getBoundingClientRect(); const pane = document.querySelector('.thread-head').getBoundingClientRect(); const name = document.querySelector('.work-folder-name'); return p ? { left: Math.round(p.left - pane.left), right: Math.round(pane.right - p.right), nameShown: !!name && getComputedStyle(name).display !== 'none' } : null })()`)
    check(!!boxes && boxes.left >= 0 && boxes.right >= 0, 'and the open panel is wholly inside the conversation pane', JSON.stringify(boxes))
    check(boxes?.nameShown === false, 'in a pane this narrow the chip is its icon alone (the name is in its tooltip)')
    if (process.env.PROBE_SHOT_DIR) {
      const shot = await app.page.send('Page.captureScreenshot', { format: 'png' })
      if (shot.result?.data) writeFileSync(join(process.env.PROBE_SHOT_DIR, 'work-folder.png'), Buffer.from(shot.result.data, 'base64'))
    }

    // Esc closes the panel; the chip still says where the conversation is working.
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check((await until(panel, (v) => v === null)) === null && (await chip()).text === 'Probe Folder', 'Esc closes the panel and the header still shows the folder')

    await ev(`${CHIP}.click()`)
    await until(panel, (v) => v !== null)
    await press('Stop using this folder')
    check((await until(chip, (v) => v?.text === 'No folder'))?.text === 'No folder', 'Stop using this folder puts the header back to No folder')
    check(daemon.writes.length === 2 && daemon.writes[1].startsWith('DELETE'), 'by one DELETE to Prometheus')
    check(/no longer works in that folder/.test(await panel()) && /untouched/.test(await panel()), 'and says the folder itself is untouched')
  })

  // ── launch 2: the same Prometheus, reached by a name that is not loopback ───────────────────
  // To Beacon that is "another computer": it cannot know the two share a disk, so no picker.
  daemon.bound = '/srv/shared/reports'
  daemon.writes.length = 0
  const lan = execFileSync('sh', ['-c', "ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true"]).toString().trim()
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(lan)) console.log('[probe] SKIP  this Mac has no network address to reach the stand-in by, so the "another computer" launch cannot be shown here; smoke:work-folder covers the rule')
  else {
    await drive(seed(lan), async ({ ev, until, connected, chip, panel, has, pickCalls, CHIP }) => {
      if (connected !== 'connected') return console.log('[probe] SKIP  Beacon would not connect to the stand-in by its network address (plain http off this computer is refused), so this launch cannot be shown here')
      const there = await until(chip, (v) => v !== null, 8000)
      check(there?.text === 'reports' && /working in \/srv\/shared\/reports, on /.test(there.title) && !/on this computer/.test(there.title), 'reached by another address, the header still shows the folder, and says it is on that computer')
      await ev(`${CHIP}.click()`)
      const p = await until(panel, (v) => v !== null)
      check(/so the folder is one on that computer/.test(p) && /\/workspace/.test(p), 'the panel says why there is no picker, and the way that does work')
      check((await has('Choose a folder…')) === false && (await has('Choose another folder…')) === false, 'and offers no picker')
      const direct = await ev(`window.beacon.workFolder.pick()`)
      check(direct?.kind === 'not-here' && (await pickCalls()) === 0, 'asked for one anyway, main refuses without opening a dialog', JSON.stringify(direct))
    })
  }
} finally {
  for (const s of [rest, wsHttp]) s.close()
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
