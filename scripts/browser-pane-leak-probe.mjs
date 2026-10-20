// Does the browser pane's lifecycle LEAK? Pop out / close N times and open / close N tabs against
// the real app, and read what Electron itself reports: web contents count, process count by
// type, and per-process working set. The question this answers (PR #113 review): "pop out and
// close fifty times in a long session — do you have fifty live views?"
//
//   npm run build && node scripts/browser-pane-leak-probe.mjs            # 30 cycles each
//   BEACON_LEAK_CYCLES=50 node scripts/browser-pane-leak-probe.mjs
//
// PASS/FAIL lines, never a silent skip. The thresholds are deliberately loose on memory (Chromium
// caches; a warm process is bigger than a cold one) and STRICT on counts: the number of web
// contents and renderer processes after N cycles must equal the number after 1 cycle.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(import.meta.url), '../..')
if (!existsSync(join(REPO, 'out/renderer/index.html'))) {
  console.log('FATAL: nothing built — run `npm run build` first')
  process.exit(4)
}
const CYCLES = Number(process.env.BEACON_LEAK_CYCLES ?? 30)
const INSPECT = 9800 + (process.pid % 150)
const CDP = INSPECT + 1
const userData = mkdtempSync(join(tmpdir(), 'beacon-leak-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`)
  if (!ok) failures++
}

const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><title>Leak ${req.url}</title><main>page ${req.url} ${'x'.repeat(2000)}</main>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${site.address().port}`
const CLOSED_PORT = await new Promise((r) => {
  const t = createServer()
  t.listen(0, '127.0.0.1', () => {
    const p = t.address().port
    t.close(() => r(p))
  })
})
const env = { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(CLOSED_PORT), BEACON_GATEWAY_WS_PORT: String(CLOSED_PORT) }
const child = spawn('npx', ['electron', '.', `--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env })
const log = []
child.stdout.on('data', (d) => log.push(String(d)))
child.stderr.on('data', (d) => log.push(String(d)))
const reap = () => {
  try {
    child.kill('SIGTERM')
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }, 1500).unref?.()
}
process.on('exit', reap)
process.on('uncaughtException', (e) => {
  console.error('probe threw:', e?.stack ?? e)
  reap()
  process.exit(1)
})

async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find(pick)
      if (t) return t
    } catch {
      /* not yet */
    }
  }
  return null
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let id = 0
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      const timer = setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i)
          res({ result: { exceptionDetails: { text: `timeout after 20s: ${method}` } } })
        }
      }, 20000)
      pending.set(i, (m) => {
        clearTimeout(timer)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  return new Promise((res, rej) => {
    ws.onopen = () => res({ send, evaluate, ws })
    ws.onerror = rej
  })
}
async function until(c, expr, ms = 10000) {
  const t0 = Date.now()
  let v
  while (Date.now() - t0 < ms) {
    v = await c.evaluate(expr)
    if (v && !v.__error) return v
    await sleep(120)
  }
  if (v && v.__error) console.log(`  (until: ${v.__error})`)
  return null
}

const node = await attach(INSPECT, (t) => t.type === 'node')
check(!!node, 'main-process inspector target found')
if (!node) process.exit(1)
const M = await client(node.webSocketDebuggerUrl)
await M.send('Runtime.enable')
const R = `(process.getBuiltinModule('module').createRequire(process.cwd() + '/'))`
const E = `(${R}('electron'))`
const shellT = await attach(CDP, (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
check(!!shellT, 'shell renderer target found')
if (!shellT) process.exit(1)
const S = await client(shellT.webSocketDebuggerUrl)
await S.send('Runtime.enable')
// Readiness is the SHELL, not a particular control. This waited on
// `button[title*="browser pane"]`, which R3 moved into the thread header — so it does not exist on
// the Mission view the app opens on, and this precondition had been failing ever since. Every
// assertion below cascaded from it, and the probe reported six failures that were all one stale
// selector. Nothing said so, because nothing runs this probe (#151).
//
// Matches browser-pane-probe.mjs, deliberately: the two should not disagree about what "the app is
// up" means, and that probe was updated for R3 while this one was not.
const ready = await until(S, `!!document.querySelector('.shell') && !!document.querySelector('.rail-scroll')`, 20000)
check(ready === true, 'main view rendered', ready === true ? '' : await S.evaluate('document.body.innerText.slice(0,200)'))
if (ready !== true) process.exit(1) // nothing below can mean anything without the shell
// R3: from Mission there is no dock control to click — the chord opens the pane and brings the
// chat view up with it. Same mechanism the browser-pane probe uses.
await S.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true })); return true })()`)
const hole = await until(S, `!!document.querySelector('.browser-hole')`, 10000)
check(hole === true, 'the browser pane mounted (⌘2 from Mission)')
async function navigate(url) {
  return S.evaluate(`(() => { const i = document.querySelector('.browser-url'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(url)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true })()`)
}
await navigate(`${BASE}/home`)
const loaded = await until(M, `${E}.webContents.getAllWebContents().some(w => w.getURL() === ${JSON.stringify(BASE + '/home')} && !w.isLoading())`)
check(loaded === true, 'the pane loaded a page')

/** What Electron reports: web contents, processes by type, working set (MB) by type + total. */
const sample = async (label) => {
  // let teardown settle: closed web contents and exited processes take a moment to fall out of the metrics
  await sleep(1500)
  const s = await M.evaluate(`(() => { const e = ${E}; const m = e.app.getAppMetrics(); const byType = {}; const memByType = {}; let total = 0;
    for (const p of m) { byType[p.type] = (byType[p.type] || 0) + 1; const mb = Math.round(p.memory.workingSetSize / 1024); memByType[p.type] = (memByType[p.type] || 0) + mb; total += mb }
    const wcs = e.webContents.getAllWebContents().map(w => w.getURL().slice(0, 60));
    const wins = e.BrowserWindow.getAllWindows().map(w => w.getTitle() + (w.isVisible() ? '' : ' (hidden)'));
    return { label: ${JSON.stringify(label)}, processes: m.length, byType, memByType, totalMB: total, webContents: wcs.length, wcs, wins } })()`)
  // A sample that could not be taken is a FINDING, not a crash. This used to read `s.label`
  // straight off the result: when the evaluate came back undefined the probe threw here and the
  // whole run died — taking the four tab-leak assertions below with it, unrun and unreported. A
  // probe that dies before reaching its subject reports nothing about the subject, which is worse
  // than reporting a failure, because the exit code still looks like it measured something.
  if (!s || typeof s !== 'object' || s.__error) {
    const why = s && s.__error ? s.__error : 'the main-process evaluate returned nothing'
    console.log(`  ${label}: SAMPLE UNAVAILABLE — ${why}`)
    return { label, unavailable: why, processes: null, byType: null, memByType: null, totalMB: null, webContents: null, wcs: [], wins: [] }
  }
  console.log(`  ${s.label}: processes=${s.processes} ${JSON.stringify(s.byType)} webContents=${s.webContents} totalMB=${s.totalMB} memMB=${JSON.stringify(s.memByType)} windows=${JSON.stringify(s.wins)}`)
  return s
}

console.log(`\n── pop out / close × ${CYCLES}`)
const popCycle = async () => {
  await S.evaluate(`document.querySelector('button[aria-label="Pop out browser"]').click(); true`)
  const out = await until(M, `(() => { const { BrowserWindow } = ${E}; const pop = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser'); return !!pop && pop.isVisible() && pop.contentView.children.some(v => v.webContents) })()`, 8000)
  if (out !== true) return false
  await M.evaluate(`(() => { const { BrowserWindow } = ${E}; BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Beacon Browser').close(); return true })()`)
  const back = await until(M, `(() => { const { BrowserWindow } = ${E}; const wins = BrowserWindow.getAllWindows(); const pop = wins.find(w => w.getTitle() === 'Beacon Browser'); const main = wins.find(w => w.getTitle() === 'Beacon'); return (!pop || !pop.isVisible()) && main.contentView.children.some(v => v.webContents) })()`, 8000)
  return back === true
}
check(await popCycle(), 'cycle 1: pop out, close, reattached')
const pop1 = await sample('after 1 pop-out cycle')
let popOk = true
for (let i = 2; i <= CYCLES; i++) {
  if (!(await popCycle())) {
    popOk = false
    console.log(`  cycle ${i} failed to complete`)
    break
  }
}
check(popOk, `cycles 2..${CYCLES} all completed (no hang)`)
const popN = await sample(`after ${CYCLES} pop-out cycles`)
check(popN.webContents === pop1.webContents, `web contents count unchanged after ${CYCLES} cycles`, `${pop1.webContents} → ${popN.webContents}`)
check(popN.processes === pop1.processes && JSON.stringify(popN.byType) === JSON.stringify(pop1.byType), `process count by type unchanged after ${CYCLES} cycles`, `${JSON.stringify(pop1.byType)} → ${JSON.stringify(popN.byType)}`)
const popGrowth = popN.totalMB - pop1.totalMB
check(popGrowth < 80, `total working set grew < 80 MB across ${CYCLES - 1} more cycles`, `${pop1.totalMB} → ${popN.totalMB} MB (${popGrowth >= 0 ? '+' : ''}${popGrowth})`)
const alive = await M.evaluate(`${E}.webContents.getAllWebContents().some(w => w.getURL() === ${JSON.stringify(BASE + '/home')})`)
check(alive === true, 'the original page is still alive after the cycles')

console.log(`\n── open / close a tab × ${CYCLES}`)
const tabsBefore = await sample('before tabs')
// Returns null on success, else the NAME of the step that did not complete. A bare false told us
// only that some cycle failed, which left the next reader re-deriving four candidate steps from
// the source before they could even start.
const tabCycle = async (i) => {
  await S.evaluate(`document.querySelector('button[aria-label="New tab"]').click(); true`)
  const opened = await until(S, `document.querySelectorAll('.browser-tab').length === 2`, 5000)
  if (opened !== true) return 'the new tab never appeared (still not 2 .browser-tab)'
  await navigate(`${BASE}/t${i}`)
  const loaded = await until(M, `${E}.webContents.getAllWebContents().some(w => w.getURL() === ${JSON.stringify(`${BASE}/t${i}`)} && !w.isLoading())`, 8000)
  if (loaded !== true) return `the tab never finished loading ${BASE}/t${i}`
  await S.evaluate(`document.querySelector('.browser-tab[aria-selected="true"] .browser-tab-x').click(); true`)
  const closed = await until(S, `document.querySelectorAll('.browser-tab').length === 1`, 5000)
  if (closed !== true) return 'the tab never closed (still not 1 .browser-tab)'
  return null
}
let tabFailure = null
for (let i = 1; i <= CYCLES; i++) {
  const why = await tabCycle(i)
  if (why) {
    tabFailure = `cycle ${i}: ${why}`
    console.log(`  tab ${tabFailure}`)
    break
  }
}
check(tabFailure === null, `${CYCLES} tab open/navigate/close cycles all completed`, tabFailure || '')
const tabsAfter = await sample(`after ${CYCLES} tab cycles`)
check(tabsAfter.webContents === tabsBefore.webContents, 'web contents count back to baseline after the tab cycles', `${tabsBefore.webContents} → ${tabsAfter.webContents}`)
check(JSON.stringify(tabsAfter.byType) === JSON.stringify(tabsBefore.byType), 'process count by type back to baseline after the tab cycles', `${JSON.stringify(tabsBefore.byType)} → ${JSON.stringify(tabsAfter.byType)}`)
const tabGrowth = tabsAfter.totalMB - tabsBefore.totalMB
check(tabGrowth < 80, `total working set grew < 80 MB across the tab cycles`, `${tabsBefore.totalMB} → ${tabsAfter.totalMB} MB (${tabGrowth >= 0 ? '+' : ''}${tabGrowth})`)
const leftover = tabsAfter.wcs.filter((u) => /\/t\d+$/.test(u))
check(leftover.length === 0, 'no closed tab\'s web contents survived', JSON.stringify(leftover))

console.log('')
if (failures) console.log('app log tail:\n' + log.join('').slice(-1200))
console.log(`${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} — browser-pane leak probe (${CYCLES} cycles each)`)
reap()
site.close()
process.exit(failures ? 1 : 0)
