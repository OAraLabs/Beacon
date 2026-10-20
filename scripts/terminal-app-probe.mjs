// Terminal pane — drive the REAL app over CDP (renderer) + the Node inspector (main) and read what
// the pane actually shows. Phase 1 acceptance: a typed command echoes, resize reaches the shell
// (`stty size` == the pane's row count), Ctrl-C interrupts, copy/paste go through xterm's own
// handlers, a window RELOAD re-attaches to the SAME pid with its scrollback, and app quit kills
// the shell (no orphan). Runs against a COPY of the user's profile in a scratch --user-data-dir so
// the running Beacon and its single-instance lock are untouched.
//   BEACON_APP=packaged → drive a packaged bundle (BEACON_BUNDLE, default the probe build in dist-probe/mac-arm64);
//   default: `npx electron .` on the repo build.
// Since the side panel (@shared/side-panel) the terminal is a PANE beside the chat, not a view:
// the rail's Terminal toggle opens the panel on it (and lands on the chat view), the panel's
// header's dock group switches browser ⇄ terminal, and ⌘3 toggles. Section 0 pins what the relocation must
// not have changed: the pty keeps its pid across a pane switch and a panel collapse.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const CDP = 9400 + (process.pid % 300)
const INSPECT = CDP + 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`); if (!ok) failures++ }

// A configured profile, copied: the setup wizard would otherwise gate the nav.
const userData = mkdtempSync(join(tmpdir(), 'beacon-term-probe-'))
const live = join(homedir(), 'Library/Application Support/beacon-desktop')
for (const f of readdirSync(live)) if (/^beacon\.db|^api-credential\.bin$|^window-state\.json$|^loop-projects\.json$|^integration-/.test(f)) cpSync(join(live, f), join(userData, f))
for (const p of [CDP, INSPECT]) { try { const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(500) }); if (r.ok) { console.log('FATAL: port busy', p); process.exit(3) } } catch {} }

const args = [`--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`]
// BEACON_APP=packaged drives a BUNDLE: BEACON_BUNDLE=<path/to/Beacon.app> (default the probe build,
// dist-probe/mac-arm64 from `npm run pack:mac:probe`: a release build refuses --remote-debugging-port;
// never /Applications by default, so the user's installed, running copy is left alone).
const bundle = process.env.BEACON_BUNDLE ?? join(REPO, 'dist-probe/mac-arm64/Beacon.app')
// `detached: true` puts the app in its OWN PROCESS GROUP so the reaper can signal the whole tree.
// Without it `child` is the `npx` wrapper and Electron is a GRANDCHILD: `child.kill()` signals npx,
// which need not forward it, and the app survives its own probe.
// The packaged branch adds --use-mock-keychain. A probe build has its own Keychain item
// ("beacon-desktop-probe Safe Storage"), so the copied api-credential.bin cannot decrypt in it
// anyway; without the mock, the attempt would silently create that item in the login keychain.
const child = process.env.BEACON_APP === 'packaged'
  ? spawn(join(bundle, 'Contents/MacOS/Beacon'), [...args, '--use-mock-keychain'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  : spawn('npx', ['electron', '.', ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const mainLog = []
child.stdout.on('data', (d) => mainLog.push(String(d))); child.stderr.on('data', (d) => mainLog.push(String(d)))
/// Signal the whole process group, falling back to the direct child if the group is gone.
const signalTree = (sig) => {
  try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* already gone */ } }
}
const stillAlive = () => { try { process.kill(-child.pid, 0); return true } catch { return false } }

/// Graceful, then forceful, then VERIFIED — and it waits, which the old one could not.
///
/// The previous reaper sent SIGTERM and scheduled SIGKILL on an unref'd timer. In the `exit`
/// handler that timer can never fire (handlers run synchronously as the process leaves), and the
/// watchdog called `reap(); process.exit(9)`, killing the parent before 1500 ms elapsed. So a HUNG
/// app — the only case that reaches the watchdog — received SIGTERM, ignored it, and outlived the
/// probe. The next run then found the debugging port occupied and hung at startup with zero output
/// and exit 9, which reads as a fresh failure rather than the previous run's leftovers. That cost
/// three runs to see (#151).
async function reap(graceMs = 1500) {
  signalTree('SIGTERM')
  const t0 = Date.now()
  while (Date.now() - t0 < graceMs && stillAlive()) await sleep(100)
  if (stillAlive()) signalTree('SIGKILL')
}
// Last resort, synchronous: whatever path exits, nothing is left behind. Unconditional SIGKILL is
// right here — by this point the graceful attempt has either happened or been skipped by a crash.
process.on('exit', () => signalTree('SIGKILL'))
// Parity with browser-pane-leak-probe.mjs, which has had this and therefore cleaned up after its
// own throw while this one did not.
const bail = (what) => (e) => {
  console.error(`probe ${what}:`, e?.stack ?? e)
  signalTree('SIGKILL')
  process.exit(1)
}
process.on('uncaughtException', bail('threw'))
// A CDP call that times out rejects, and at top level that is an unhandledRejection, NOT an
// uncaughtException — without this it would exit silently and leave the app running.
process.on('unhandledRejection', bail('had a rejected promise'))
// A hung evaluation (e.g. against a window the call itself destroys) must not hang the probe.
setTimeout(async () => {
  console.log('FATAL: probe watchdog fired (240 s)')
  await reap()
  process.exit(9)
}, 240000).unref?.()
const fireAndForget = (c, expr) => { c.send('Runtime.evaluate', { expression: expr }).catch(() => undefined) }

/// Poll the DevTools target list until `pick` matches, or the window closes.
///
/// The `fetch` carries a TIMEOUT, and that is the whole point of this comment. Without one a
/// single stalled connection never settles, the `await` never returns, and the "80 attempts"
/// bound becomes fiction: the loop cannot reach attempt 2. That is the intermittent startup hang
/// behind #151 — the 240 s watchdog firing with no output at all, on a run with no stray process
/// and no port conflict. Caught by the breadcrumb below it, which printed "attaching…" and then
/// nothing for four minutes. The port pre-check at the top of this file already used
/// `AbortSignal.timeout`; this one did not, and that asymmetry was the bug.
async function attach(port, pick) {
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const t = (await res.json()).find(pick)
      if (t) return t
    } catch { /* not up yet, or this poll stalled — try again */ }
  }
  return null
}
/// Every CDP call is BOUNDED.
///
/// `send` used to return a promise that resolved only when a matching response arrived, with no
/// timeout — so a socket that never opened, or a target that died mid-call, waited forever. The
/// 240 s watchdog then fired having printed NOTHING AT ALL, which reads as "the probe is broken"
/// rather than "one call never came back", and gives the next person no idea where it stopped.
/// Measured while fixing #151: this happens on roughly half of startups on this machine, with no
/// stray process and no port conflict — so leftovers were NOT the cause, contrary to the first
/// reading of it.
const CDP_CALL_TIMEOUT_MS = 20000
function client(wsUrl) {
  const ws = new WebSocket(wsUrl); const pending = new Map(); let id = 0
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    const timer = setTimeout(() => {
      pending.delete(i)
      rej(new Error(`CDP ${method} did not answer within ${CDP_CALL_TIMEOUT_MS} ms (socket ${ws.readyState === 1 ? 'open' : 'not open, readyState=' + ws.readyState})`))
    }, CDP_CALL_TIMEOUT_MS)
    pending.set(i, (m) => { clearTimeout(timer); res(m) })
    try { ws.send(JSON.stringify({ id: i, method, params })) } catch (e) { clearTimeout(timer); pending.delete(i); rej(e) }
  })
  const q = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  return new Promise((res, rej) => { ws.onopen = () => res({ send, q, ws }); ws.onerror = rej })
}
async function waitFor(q, expr, ms = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await q(expr); if (v) return v; await sleep(150) }
  return await q(expr)
}

// Breadcrumbs. A 240 s watchdog that fires having printed NOTHING tells the next person only that
// something stalled, not where — and this probe intermittently stalls BEFORE its first check
// (measured roughly 1 run in 3 on this machine, with no stray process and no port conflict, so
// leftovers are not the cause). These cost one line each and make the silence localisable.
console.log(`[startup] app spawned (pid ${child.pid}), attaching on CDP ${CDP} …`)
const page = await attach(CDP, (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
console.log(`[startup] renderer target ${page ? 'found' : 'NOT found'}`)
check(!!page, 'renderer page target found', page?.url ?? mainLog.join('').slice(-600))
if (!page) { console.log('FATAL: no renderer target appeared within the attach window'); await reap(); process.exit(2) }
const r = await client(page.webSocketDebuggerUrl)
await r.send('Runtime.enable'); await r.send('Page.enable')

const rows = `[...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent).join('\\n')`
const rowCount = `document.querySelectorAll('.xterm-rows > div').length`
const headerPid = `(() => { const m = (document.body.innerText.match(/pid (\\d+)/) || [])[1]; return m ? Number(m) : 0 })()`
// R3: the dock opens by chord from ANY view (⌘3 = terminal); the dock group lives in the thread
// header, so there is nothing to click on Mission. Pressing the chord on the showing pane would
// close it, so only send it when the pane is not already up (after a reload the persisted panel
// state brings it back by itself).
const DOCK_KEY = { inspector: '1', browser: '2', terminal: '3' }
const railToggle = (pane) => `(() => {
  const seg = document.querySelector('button[title*=${JSON.stringify(pane + ' pane')}]')
  const wasOpen = !!seg && seg.getAttribute('aria-pressed') === 'true'
  if (!wasOpen) window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(DOCK_KEY[pane])}, metaKey: true, bubbles: true }))
  return wasOpen ? 'already-open' : 'clicked'
})()`
async function gotoTerminal() {
  const nav = await waitFor(r.q, `document.querySelector('.side-panel[data-pane="terminal"] .xterm') ? 'already-open' : ${railToggle('terminal')}`, 20000)
  check(nav === 'clicked' || nav === 'already-open', `the terminal pane is up in the side panel (${nav})`)
  const mounted = await waitFor(r.q, `!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && ${headerPid}`, 15000)
  check(mounted > 0, 'the pane mounted xterm inside the side panel and shows a live pid', mounted)
  await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  return mounted
}
const key = async (key, code, vk, text, modifiers = 0) => {
  await r.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text, modifiers })
  await r.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
}
const enter = () => key('Enter', 'Enter', 13, '\r')
const type = async (s) => { await r.send('Input.insertText', { text: s }) }

// ── 0. the relocation: a pane beside the chat, and nothing restarts when it hides ────────────
// Start on Mission (the default view) so the toggle has to bring the chat view up too.
await waitFor(r.q, `!!document.querySelector('.shell')`, 20000)
await r.q(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === 'Mission'); b && b.click() })()`)
await sleep(300)
check(!(await r.q(`!!document.querySelector('.side-panel')`)), 'the side panel starts collapsed (fresh profile: no panel keys)')
const pid1 = await gotoTerminal()
check(!!(await r.q(`!!document.querySelector('.layout') && !!document.querySelector('.layout .side-panel[data-pane="terminal"]')`)), 'opening the terminal pane landed on the CHAT view: the thread layout + side panel present')
check((await r.q(`document.querySelector('.dock-group button[title*="terminal pane"]').getAttribute('aria-pressed')`)) === 'true', 'the thread header\'s dock segment reads pressed')
check(!(await r.q(`!!document.querySelector('.rail-scroll button[title*="pane"]')`)), 'the rail holds no pane toggle (R3)')
// R3's REASON, not its gesture. `showSessions()` collapses the list only when keeping it would
// squeeze the conversation below CONVERSATION_MIN_WIDTH — at the shipped 392px dock a wide window
// has nothing to protect, and side-panel-smoke.ts pins exactly that in both directions. This
// asserted the unconditional gesture and so contradicted the shipped rule; same correction as
// browser-pane-probe.mjs (#151).
const roomT = await r.q(`(() => {
  const c = document.querySelector('.layout .app') || document.querySelector('.layout .chat-home')
  return { width: c ? c.getBoundingClientRect().width : 0, sidebar: document.querySelector('.layout .sidebar')?.getBoundingClientRect().width ?? null, window: window.innerWidth }
})()`)
check(roomT && roomT.width >= 380, 'the thread keeps its reading width beside the terminal pane (R3: the reason, not the gesture)', JSON.stringify(roomT))
// switch the panel to the browser and back: the pty must keep its pid (no restart)
await r.q(`document.querySelector('.dock-group button[title*="browser pane"]').click()`)
check(!!(await waitFor(r.q, `document.querySelector('.side-panel[data-pane="browser"] .browser-hole') && !document.querySelector('.xterm') ? 1 : 0`, 6000)), 'switched to the browser pane: xterm unmounted, browser hole shown')
await r.q(`document.querySelector('.dock-group button[title*="terminal pane"]').click()`)
const pidAfterSwitch = await waitFor(r.q, `!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && ${headerPid}`, 15000)
check(pidAfterSwitch === pid1, `back on the terminal pane: the SAME pid (${pid1} → ${pidAfterSwitch}) — a switch never restarts the pty`)
// ⌘3 closes the panel; ⌘3 opens it again on the same shell
await r.q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))`)
check(!!(await waitFor(r.q, `!document.querySelector('.side-panel') ? 1 : 0`, 4000)), '⌘3 collapsed the panel')
check(!!(await r.q(`!!document.querySelector('.layout .sidebar')`)), 'the session list is back once the terminal pane is closed')
await r.q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))`)
const pidAfterCollapse = await waitFor(r.q, `!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && ${headerPid}`, 15000)
check(pidAfterCollapse === pid1, `⌘3 reopened it on the same pid (${pidAfterCollapse})`)
await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)

// ── 1. mount + echo ─────────────────────────────────────────────────────────
await sleep(800)
await type('echo REAL_$((6*7))'); await enter()
check(!!(await waitFor(r.q, `/REAL_42/.test(${rows}) ? 1 : 0`, 8000)), 'a typed command echoed back through the pty into xterm')
check(/zsh\s+pid \d+\s+·\s+\/Users\//.test(await r.q('document.body.innerText')), 'header shows shell, pid, and cwd = home')

// ── 2. resize → SIGWINCH ────────────────────────────────────────────────────
// Viewport emulation resizes the document the same way a window drag does (ResizeObserver → fit).
async function sizeCase(w, h) {
  await r.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false })
  await sleep(900)
  const n = await r.q(rowCount)
  // Re-focus the xterm textarea after the viewport override — the probe re-focuses at every other
  // typing site and this one was missed because the resize sits between them.
  //
  // NOT A FIX for the two resize checks, and said plainly so the next person does not assume it
  // was tried and worked: with this in place `stty size` STILL produces no output, and CDP
  // `Emulation.setFocusEmulationEnabled` made no difference either (tried, reverted — shipping a
  // speculative line that changed nothing would just cost the next reader the same experiment).
  // What IS established: the pane's row count is fine, the pty prints nothing at all, and the old
  // "no match" wording hid that by describing it as a row disagreement. See #151.
  await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  await type('stty size'); await enter()
  // Collapse whitespace BEFORE matching. The old regex looked for a literal `stty size` in the
  // raw row text, and at these widths the terminal is ~31 columns — so the prompt plus the command
  // is 35 characters and WRAPS MID-COMMAND. The rendered rows read `stty` / `size` on two separate
  // divs, joined by a newline, and a literal space cannot match a newline. The pty was answering
  // correctly the whole time (`15 31`, then `34 31`, exactly the pane's row count); the probe was
  // asking the buffer a question its own line-wrapping made unanswerable.
  //
  // This is why the failure detail said "no stty output at all" — also wrong, and wrong in the
  // direction that costs most: it described a pty that never replied, when the reply was on screen.
  const collapsed = `${rows}.replace(/\\s+/g, ' ')`
  const ok = await waitFor(r.q, `(() => { const all = [...${collapsed}.matchAll(/stty size (\\d+) (\\d+)/g)]; const m = all[all.length - 1]; return m && Number(m[1]) === ${n} ? m[1] + 'x' + m[2] : 0 })()`, 6000)
  const saw = ok ? null : await r.q(`(() => { const all = [...${collapsed}.matchAll(/stty size (\\d+) (\\d+)/g)]; const m = all[all.length - 1]; return m ? m[1] + 'x' + m[2] : 'no stty output found in the buffer' })()`)
  check(!!ok, `resize ${w}x${h}: stty rows == pane rows (${n})`, ok || `pane says ${n} rows, pty says ${saw}`)
}
await sizeCase(1100, 500) // (900 leaves the panel at its 320px minimum: ~36 cols, where a long prompt wraps `stty size` mid-word)
await sizeCase(1300, 800)
await r.send('Emulation.clearDeviceMetricsOverride')

// ── 3. Ctrl-C ───────────────────────────────────────────────────────────────
await type('sleep 30'); await enter(); await sleep(500)
await key('c', 'KeyC', 67, '\x03', 2)
await type('echo AFTER_$((1+1))'); await enter()
check(!!(await waitFor(r.q, `/AFTER_2/.test(${rows}) ? 1 : 0`, 4000)), 'Ctrl-C interrupted `sleep 30` (the next command ran within 4 s)')

// ── 4. copy (xterm's copy handler) + paste (xterm's paste handler) ──────────
await type('echo COPY_ME_$((5*5))'); await enter()
await waitFor(r.q, `/COPY_ME_25/.test(${rows}) ? 1 : 0`, 4000)
const copied = await r.q(`(() => {
  const row = [...document.querySelectorAll('.xterm-rows > div')].find((d) => /^COPY_ME_25/.test(d.textContent))
  if (!row) return 'no row'
  const rect = row.getBoundingClientRect(); return JSON.stringify({ x: rect.left + 2, y: rect.top + rect.height / 2, x2: rect.left + 9 * 12, w: rect.width })
})()`)
let sel = 'n/a'
try {
  const p = JSON.parse(copied)
  await r.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await r.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x2, y: p.y, button: 'left' })
  await r.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x2, y: p.y, button: 'left', clickCount: 1 })
  await sleep(200)
  await r.q(`document.execCommand('copy')`) // the DOM path ⌘C's editMenu role takes: a 'copy' event on the focused xterm textarea
  await sleep(200)
  sel = execSync('pbpaste').toString()
} catch (e) { sel = 'threw ' + e.message }
check(/COPY_ME/.test(sel), 'mouse-selected text reached the system clipboard via xterm\'s copy handler', JSON.stringify(sel.slice(0, 40)))
await r.q(`(() => { const ta = document.querySelector('.xterm-helper-textarea'); ta.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'echo PASTED_$((3*3))'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) })()`)
await enter()
check(!!(await waitFor(r.q, `/PASTED_9/.test(${rows}) ? 1 : 0`, 4000)), 'a paste event on xterm wrote into the pty and ran')

// ── 5. reload keeps the shell + scrollback ──────────────────────────────────
await r.send('Page.reload')
await sleep(1500)
const pid2 = await gotoTerminal()
check(pid2 === pid1 && pid1 > 0, `after a window reload the pane re-attached to the SAME pid (${pid1} → ${pid2})`)
check(!!(await waitFor(r.q, `/REAL_42/.test(${rows}) && /PASTED_9/.test(${rows}) ? 1 : 0`, 6000)), 'scrollback from before the reload is visible after it (replay)')
await type('echo STILL_$((7*7))'); await enter()
check(!!(await waitFor(r.q, `/STILL_49/.test(${rows}) ? 1 : 0`, 4000)), 'and the re-attached shell still takes input')

// ── 5a. tabs (Phase 3): concurrent ptys, switch, rename, close, and an exit shown in place ──
const tabsExpr = `[...document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')].map((t) => ({ title: t.textContent.replace('×','').trim(), active: t.getAttribute('aria-selected') === 'true', state: t.querySelector('span[aria-label]').getAttribute('aria-label') }))`
check((await r.q(`${tabsExpr}.length`)) === 1, 'one tab to start')
await r.q(`document.querySelector('button[aria-label="New shell"]').click()`)
const twoTabs = await waitFor(r.q, `${tabsExpr}.length === 2 && ${tabsExpr}[1].active ? 1 : 0`, 8000)
check(!!twoTabs, '"+" opened a second tab and made it active')
const pidTab2 = await waitFor(r.q, `(() => { const p = ${headerPid}; return p && p !== ${pid1} ? p : 0 })()`, 8000)
check(pidTab2 > 0 && pidTab2 !== pid1, `the second tab is a different shell (pid ${pidTab2} vs ${pid1})`)
await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)
await type('echo TAB2_$((9*9))'); await enter()
check(!!(await waitFor(r.q, `/TAB2_81/.test(${rows}) ? 1 : 0`, 6000)), 'typing lands in the second shell')
await r.q(`document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')[0].click()`)
const backTo1 = await waitFor(r.q, `${headerPid} === ${pid1} && /STILL_49/.test(${rows}) && !/TAB2_81/.test(${rows}) ? 1 : 0`, 8000)
check(!!backTo1, 'switching back to tab 1 re-attached its own pid + scrollback (and not tab 2\'s)')
// rename: double-click → input → Enter
await r.q(`document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
const renamed = await waitFor(r.q, `(() => { const i = document.querySelector('input[aria-label="Tab name"]'); if (!i) return 0; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'build box'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`, 4000)
check(!!renamed, 'double-click opened the rename input')
await r.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await r.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
check(!!(await waitFor(r.q, `${tabsExpr}[0].title === 'build box' ? 1 : 0`, 6000)), 'Enter committed the rename (tab reads "build box")', JSON.stringify(await r.q(tabsExpr)))
// an exiting shell stays as a tab and says why, in the pane
await r.q(`document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')[1].click()`)
await waitFor(r.q, `${headerPid} === ${pidTab2} ? 1 : 0`, 8000)
await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)
await type('exit 7'); await enter()
const why = await waitFor(r.q, `(() => { const s = document.querySelector('[role=status]'); return s && /zsh exited with code 7/.test(s.textContent) && ${tabsExpr}[1].state === 'exited' ? s.textContent : 0 })()`, 8000)
check(!!why, 'the exited tab stays, its dot reads "exited", and the pane says why', why)
// close the exited tab → back to one tab, tab 1 active
await r.q(`document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')[1].querySelector('button').click()`)
check(!!(await waitFor(r.q, `${tabsExpr}.length === 1 && ${headerPid} === ${pid1} ? 1 : 0`, 8000)), 'closing the exited tab leaves tab 1 active')

// ── 5c. tailnet peers (Phase 4): derived row; a not-ready peer reports why and opens nothing ──
const peersExpr = `[...document.querySelectorAll('[data-peer]')].map((b) => ({ name: b.dataset.peer, ready: b.dataset.ready, online: b.querySelector('span[aria-label]').getAttribute('aria-label') }))`
const peers = await waitFor(r.q, `(() => { const p = ${peersExpr}; return p.length ? JSON.stringify(p) : 0 })()`, 15000)
check(!!peers, 'the tailnet row rendered peer buttons from `tailscale status`', peers || await r.q(`document.querySelector('[aria-label="Tailnet peers"]')?.textContent`))
if (peers) {
  const list = JSON.parse(peers)
  console.log('  peers:', list.map((p) => `${p.name}:${p.online}:${p.ready}`).join(' '))
  const tabsBefore = await r.q(`${tabsExpr}.length`)
  const notReady = list.find((p) => p.online === 'online' && p.ready === 'no') ?? list.find((p) => p.ready === 'no')
  if (notReady) {
    await r.q(`document.querySelector('[data-peer=${JSON.stringify(notReady.name)}]').click()`)
    const why = await waitFor(r.q, `(() => { const a = document.querySelector('[role=alert]'); return a && /Beacon will not ask for a password|offline on the tailnet/.test(a.textContent) ? a.textContent : 0 })()`, 5000)
    check(!!why, `clicking ${notReady.name} (not ready) reported why and did nothing`, why)
    check((await r.q(`${tabsExpr}.length`)) === tabsBefore, 'no tab was opened for the refused peer')
  } else {
    console.log('  (every peer is ready on this Mac — refusal path not exercised here; the smoke covers it)')
  }
  const ready = list.find((p) => p.ready !== 'no')
  if (ready) {
    await r.q(`document.querySelector('[data-peer=${JSON.stringify(ready.name)}]').click()`)
    const sshTab = await waitFor(r.q, `(() => { const t = ${tabsExpr}; return t.length === ${tabsBefore} + 1 && t[t.length - 1].title === 'ssh ' + ${JSON.stringify(ready.name)} ? 1 : 0 })()`, 8000)
    check(!!sshTab, `clicking ${ready.name} (${ready.ready}) opened an "ssh ${ready.name}" tab`)
    // whatever ssh prints is ssh's; the pane must never show a password prompt
    await sleep(4000)
    const prompt = await r.q(`/password:|passphrase/i.test(${rows}) ? ${rows}.slice(-200) : ''`)
    check(!prompt, 'no password/passphrase prompt appeared in the pane', prompt)
    // close that tab (kills ssh if still connecting) and return to tab 1
    await r.q(`(() => { const t = [...document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')]; t[t.length - 1].querySelector('button').click() })()`)
    await waitFor(r.q, `${tabsExpr}.length === ${tabsBefore} ? 1 : 0`, 8000)
    await r.q(`document.querySelectorAll('[aria-label="Terminal tabs"] [role=tab]')[0].click()`)
    await waitFor(r.q, `${headerPid} === ${pid1} ? 1 : 0`, 8000)
  } else {
    console.log('  (no peer is ready on this Mac — Tailscale SSH not enabled anywhere and the agent is empty; nothing to open, by design)')
  }
}

if (process.env.PROBE_SHOT) {
  const { writeFileSync } = await import('node:fs')
  const shot = await r.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log('  screenshot:', process.env.PROBE_SHOT)
}
// ── 5b. pop-out / pop-in (Phase 2): the pty never moves ─────────────────────
const popBtn = (title) => `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith(${JSON.stringify(title)})); if (!b || b.disabled) return 0; b.click(); return 1 })()`
check(!!(await r.q(popBtn('Detach the terminal'))), 'clicked Pop out in the main window')
const popTarget = await attach(CDP, (t) => t.type === 'page' && t.url.endsWith('#terminal'))
check(!!popTarget, 'a #terminal window appeared', popTarget?.url)
let pop = null
if (popTarget) {
  pop = await client(popTarget.webSocketDebuggerUrl)
  await pop.send('Runtime.enable')
  const pidPop = await waitFor(pop.q, `!!document.querySelector('.xterm') && ${headerPid}`, 15000)
  check(pidPop === pid1, `the pop-out attached to the SAME pid (${pid1} → ${pidPop})`)
  check(!!(await waitFor(pop.q, `/STILL_49/.test(${rows}) ? 1 : 0`, 6000)), 'the pop-out shows the scrollback (replay)')
  const yielded = await waitFor(r.q, `/open in its own window/.test(document.body.innerText) && !document.querySelector('.xterm') ? 1 : 0`, 6000)
  check(!!yielded, 'the main window pane yielded: placeholder shown, its xterm detached')
  // The satellite may not hold OS focus when it has just been shown (a busy machine, another app
  // in front): CDP text goes to the focused element of a focused document, so front it first.
  await pop.send('Page.bringToFront')
  const popFocus = await waitFor(pop.q, `(() => { document.querySelector('.xterm-helper-textarea')?.focus(); return document.hasFocus() && document.activeElement?.classList.contains('xterm-helper-textarea') ? 1 : 0 })()`, 4000)
  check(popFocus === 1, 'the pop-out document has focus and xterm owns it', JSON.stringify(await pop.q(`({ hasFocus: document.hasFocus(), active: document.activeElement?.className, visibility: document.visibilityState })`)))
  await pop.send('Input.insertText', { text: 'echo POPPED_$((8*8))' })
  await pop.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await pop.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check(!!(await waitFor(pop.q, `/POPPED_64/.test(${rows}) ? 1 : 0`, 6000)), 'typing in the pop-out reaches the same shell')
  // Bounds remembered: resize the real pop-out window from inside it (Electron's CDP has no
  // Browser.setWindowBounds); trackWindowState must write the new size within its debounce.
  try {
    await pop.q(`window.resizeTo(777, 555); 1`)
    await sleep(900)
    const { readFileSync: rf } = await import('node:fs')
    const st = JSON.parse(rf(join(userData, 'terminal-window-state.json'), 'utf8'))
    check(st.width === 777 && st.height === 555, 'the pop-out window bounds were persisted to terminal-window-state.json', JSON.stringify(st))
  } catch (e) { check(false, 'window bounds persisted', e.message) }
  // A renderer-initiated window.close() DESTROYS the satellite (Electron skips the cancelable
  // 'close' for it — the red button / ⌘W go through 'close' and hide instead). Either way the
  // shell must survive and the main pane must get the pty back.
  fireAndForget(pop, `window.close()`)
  await sleep(1200)
  const stillListed = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).some((t) => t.url.endsWith('#terminal'))
  console.log(`  window.close() from the renderer → satellite ${stillListed ? 'HIDDEN (close event honoured)' : 'DESTROYED (close event bypassed)'}`)
  const back = await waitFor(r.q, `!!document.querySelector('.xterm') && ${headerPid}`, 10000)
  check(back === pid1, `after the pop-out window went away, the main pane re-attached to the same pid (${back})`)
  check(!!(await waitFor(r.q, `/POPPED_64/.test(${rows}) ? 1 : 0`, 6000)), 'and shows what was typed in the pop-out (replay)')
  // Hide-not-destroy is proven through the pane's own buttons: Pop out → Pop in hides; Pop out
  // again must bring back the SAME window (one satellite, reused), visible, re-attached.
  check(!!(await r.q(popBtn('Detach the terminal'))), 'Pop out (fresh satellite if the last one was destroyed)')
  const popA = await attach(CDP, (t) => t.type === 'page' && t.url.endsWith('#terminal'))
  check(!!popA, 'a #terminal window is up')
  const popAc = await client(popA.webSocketDebuggerUrl); await popAc.send('Runtime.enable')
  await waitFor(popAc.q, `!!document.querySelector('.xterm') && ${headerPid}`, 15000)
  fireAndForget(popAc, popBtn('Close this window and show'))
  check((await waitFor(popAc.q, `document.visibilityState === 'hidden' && !document.querySelector('.xterm') ? 1 : 0`, 6000)) === 1, 'Pop in: the satellite is HIDDEN (not destroyed) and its pane detached')
  await waitFor(r.q, `!!document.querySelector('.xterm') && ${headerPid} === ${pid1} ? 1 : 0`, 10000)
  // ── 5c. after pop-out → Pop in, EXACTLY ONE sink is attached (popout-window.ts contract §3) ──
  // The hidden satellite stays mounted, so a sink that was not detached keeps receiving every
  // byte with no visible symptom — the DOM check above cannot see that. Count where the bytes go:
  // a byte counter on both windows' bridges, a marker typed in the main pane, and the main window
  // must see it while the hidden satellite sees nothing.
  const counter = `(() => { window.__tbytes = 0; window.beacon.terminal.onData((m) => { window.__tbytes += (m.data || '').length }); return 1 })()`
  check((await r.q(counter)) === 1, 'byte counter installed on the main window bridge')
  check((await popAc.q(counter)) === 1, 'byte counter installed on the hidden satellite bridge (it still answers — contract §1)')
  await r.q(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  await r.send('Input.insertText', { text: 'echo ONE_SINK_$((6*7))' })
  await r.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await r.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check(!!(await waitFor(r.q, `/ONE_SINK_42/.test(${rows}) ? 1 : 0`, 6000)), 'the main pane received the marker')
  await sleep(500)
  const mainBytes = await r.q(`window.__tbytes`)
  const popBytes = await popAc.q(`window.__tbytes`)
  check(mainBytes > 0 && popBytes === 0, `exactly one sink after pop-out → Pop in: main ${mainBytes} bytes, hidden satellite ${popBytes} bytes — contract §3`)
  check(!!(await r.q(popBtn('Detach the terminal'))), 'Pop out again')
  const popB = await attach(CDP, (t) => t.type === 'page' && t.url.endsWith('#terminal'))
  check(!!popB && popB.id === popA.id, 'the SAME satellite window came back (one window, reused)')
  check((await waitFor(popAc.q, `document.visibilityState === 'visible' && !!document.querySelector('.xterm') && ${headerPid} === ${pid1} ? 1 : 0`, 10000)) === 1, 'visible again and re-attached to the same pid')
  fireAndForget(popAc, popBtn('Close this window and show'))
  await waitFor(r.q, `!!document.querySelector('.xterm') && ${headerPid} === ${pid1} ? 1 : 0`, 10000)
  // Pop out again, then Pop in from the pop-out's own button → main window shows the Terminal view.
  check(!!(await r.q(popBtn('Detach the terminal'))), 'clicked Pop out again')
  const popTarget2 = await attach(CDP, (t) => t.type === 'page' && t.url.endsWith('#terminal'))
  check(!!popTarget2, 'the #terminal window is up')
  if (popTarget2) {
    const pop2 = await client(popTarget2.webSocketDebuggerUrl)
    await pop2.send('Runtime.enable')
    await waitFor(pop2.q, `!!document.querySelector('.xterm') && ${headerPid}`, 15000)
    // Switch the main window to another view first, so pop-in has to bring the chat view + panel back.
    await r.q(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === 'Mission'); b && b.click() })()`)
    await sleep(300)
    check(!(await r.q(`!!document.querySelector('.xterm')`)), 'main window moved to Mission (no xterm mounted)')
    fireAndForget(pop2, popBtn('Close this window and show')) // pop-in destroys the window mid-call
    const again = await waitFor(r.q, `!!document.querySelector('.side-panel[data-pane="terminal"] .xterm') && ${headerPid}`, 10000)
    check(again === pid1, `pop-in: the main window came back to the chat view with the terminal pane open, re-attached to the same pid (${again})`)
    const hidden = await waitFor(pop2.q, `document.visibilityState === 'hidden' && !document.querySelector('.xterm') ? 1 : 0`, 6000)
    check(hidden === 1, 'after pop-in the satellite is hidden and its pane detached (never destroyed)')
  }
}

// ── 6. quit kills the shell ─────────────────────────────────────────────────
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
check(alive(pid1), 'shell pid is alive before quit')
// Quit the way the OS does (SIGTERM to the main process → Electron's before-quit), not via the
// inspector: dev main has no process.mainModule to reach `app` through.
const mainPid = Number(execSync(`pgrep -f -- '--user-data-dir=${userData}' | while read p; do ps -o command= -p $p | grep -qv -- '--type=' && echo $p; done | head -1`).toString().trim())
check(mainPid > 0, 'found the Electron main process', mainPid)
const exited = new Promise((res) => child.once('exit', (code, sig) => res(`exit ${code ?? sig}`)))
process.kill(mainPid, 'SIGTERM')
const gone = await (async () => { for (let i = 0; i < 40; i++) { if (!alive(pid1)) return true; await sleep(100) } return !alive(pid1) })()
check(gone, 'the shell pid is gone within 4 s of quit (no orphan)')
console.log('  app:', await Promise.race([exited, sleep(4000).then(() => 'still running after 4 s')]))
check(/\[terminal\] killed 1 shell\(s\) on quit/.test(mainLog.join('')), 'main logged the before-quit kill', mainLog.join('').match(/\[terminal\][^\n]*/)?.[0] ?? mainLog.join('').slice(-300))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await reap(); process.exit(failures === 0 ? 0 : 1)
