#!/usr/bin/env node
// system-theme-probe — does wearing SYSTEMA actually re-skin LIVE when the OS appearance flips?
//
// smoke:theme proves the MODEL (the sentinel resolves to NOX/LVX, coercion degrades safely, the
// sentinel never survives to data-theme). It cannot prove the CONSEQUENCE that the whole design
// exists for: a window wearing SYSTEMA re-skins WHILE RUNNING when the OS flips light↔dark.
//
// That consequence is the part with history. Measured on Electron 44/Linux during design: the
// renderer's matchMedia('(prefers-color-scheme: dark)') TRACKS nativeTheme on read but its `change`
// event NEVER FIRES — a renderer-only listener resolves correctly at boot and then never re-skins
// again. So main owns nativeTheme, and 'updated' transitions are pushed over the system-theme:changed
// channel; apply-theme re-resolves the sentinel on each push. This probe drives that real chain:
// it persists choice='system' through the shipped settings handler, flips nativeTheme.themeSource
// from main, and reads the document's data-theme through the page target.
//
// RUN: npm run build && DISPLAY=:1 node scripts/system-theme-probe.mjs
// SANDBOXED: PROBE_ELECTRON_ARGS="--disable-dev-shm-usage --no-sandbox"
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${extra}` : ''}`); if (!ok) failures++ }
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 64 - t.length))}`)

const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s) }
const site = createServer((req, res) => { const u = req.url ?? ''; if (u.startsWith('/api/status')) return json(res, 200, { state: 'idle', model: 'stub', uptime: 1 }); json(res, 200, []) })
await new Promise((r) => site.listen(0, '127.0.0.1', r)); const API_PORT = site.address().port
const wsSite = createServer(); const { WebSocketServer } = await import('ws'); const wss = new WebSocketServer({ server: wsSite })
wss.on('connection', (s) => { try { s.send(JSON.stringify({ type: 'connected' })) } catch {} s.on('error', () => {}) })
await new Promise((r) => wsSite.listen(0, '127.0.0.1', r)); const WS_PORT = wsSite.address().port

const INSPECT = 9700 + ((process.pid + 73) % 200)
const CDP = INSPECT + 1
const USER_DATA = mkdtempSync(join(tmpdir(), 'beacon-systheme-'))
const extra = (process.env.PROBE_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
const child = spawn('npx', ['electron', '.', ...extra, `--inspect=${INSPECT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${USER_DATA}`], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(API_PORT), BEACON_GATEWAY_WS_PORT: String(WS_PORT) }
})
const mainLog = []; child.stdout.on('data', (d) => mainLog.push(String(d))); child.stderr.on('data', (d) => mainLog.push(String(d)))
let reaped = false
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} } }
const reap = () => { if (reaped) return; reaped = true; killGroup('SIGTERM') }
const closeStubs = () => { for (const c of [wss, wsSite, site]) { try { c.close() } catch {} } }
async function reapAndExit(code) { reap(); closeStubs(); for (let i = 0; i < 20; i++) { if (child.exitCode !== null || child.signalCode !== null) { try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {} process.exit(code) } await sleep(100) } killGroup('SIGKILL'); process.exit(code) }
process.on('exit', () => { reap(); closeStubs() })
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); reap(); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); reap(); process.exit(1) })
child.on('exit', (c, s) => { if (!reaped) { console.error(`[probe] app exited early (code=${c} signal=${s})\n${mainLog.join('').slice(-1500)}`); closeStubs(); process.exit(2) } })

async function list(port) { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json() } catch { return [] } }
async function attachTo(port, pick, tries = 80) { for (let i = 0; i < tries; i++) { await sleep(500); const t = (await list(port)).find(pick); if (t) return t } return null }
async function client(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`${method} timed out`)) } }, 20000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value }
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }) })
  return { send, evaluate, ws }
}

const nodeT = await attachTo(INSPECT, (t) => t.type === 'node')
check(!!nodeT, 'main-process inspector target found (--inspect)', nodeT ? '' : mainLog.join('').slice(-600))
if (!nodeT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
const M = await client(nodeT.webSocketDebuggerUrl); await M.send('Runtime.enable')
// Retry until electron's `app` is reachable, and never return the module by value. A one-shot
// createRequire(cwd)('electron') here threw "Internal error" intermittently on macOS: run too early
// it resolves the npm package's path string, and returning the module by value fails to serialize.
// Same loop as close-mode-probe.
for (let __i = 0; ; __i++) { const __t = await M.evaluate(`(() => { try { if (process.mainModule) globalThis.__electron = process.mainModule.require('electron') } catch {} return typeof globalThis.__electron?.app })()`); if (__t === 'object') break; if (__i > 80) throw new Error('electron API never became reachable in main'); await new Promise((r) => setTimeout(r, 250)) }

// The shell's page target lives on the CDP port (--remote-debugging-port), NOT the --inspect port:
// one serves the main-process node inspector, the other the Chromium targets. Conflating them finds
// only the node target and "no page" — learned building this.
const pageT = await attachTo(CDP, (t) => t.type === 'page' && (t.url || '').includes('index.html'))
check(!!pageT, 'shell page target found (--remote-debugging-port)', pageT ? '' : mainLog.join('').slice(-600))
if (!pageT) { console.error(mainLog.join('').slice(-2000)); await reapAndExit(2) }
let P = await client(pageT.webSocketDebuggerUrl); await P.send('Runtime.enable')

// Wait for the app to have mounted (React up, bridge exposed).
let up = false
for (let i = 0; i < 60; i++) { if (await P.evaluate(`!!window.beacon && !!window.beacon.systemTheme`).catch(() => false)) { up = true; break } await sleep(500) }
check(up, 'the app is up and the systemTheme bridge is exposed')

const dataTheme = () => P.evaluate(`document.documentElement.getAttribute('data-theme')`)
const setThemeSource = (src) => M.evaluate(`globalThis.__electron.nativeTheme.themeSource = ${JSON.stringify(src)}; true`)
const nativeDark = () => M.evaluate(`globalThis.__electron.nativeTheme.shouldUseDarkColors`)

/**
 * Reload the shell and re-attach. Driven from MAIN, not the page.
 *
 * `location.reload()` evaluated through the page target DOES NOTHING here, and it is not a mystery:
 * the packaged shell loads from file://, so location.reload() raises `will-navigate`, and the
 * navigation guard (adoptShellWindow, src/main/shell-windows.ts) refuses it (main logs `[shell]
 * refused will-navigate away from the shell page`). Observed symptom while building this: a marker set before the
 * call was still there after, while the persisted setting was correct — the shell never remounted,
 * loadAndApplyTheme never re-ran, and every subsequent assertion read the pre-reload document.
 * webContents.reload() from main does not raise that event, so it does reload, and that is what this
 * uses. See CLAUDE.md "Driving the real app" — this is a documented trap, not a local quirk.
 *
 * The caller asserts the marker is gone. That check is load-bearing: without it a no-op reload is
 * indistinguishable from a successful one, and — because the boot default is NOX/dark, exactly what
 * SYSTEMA-on-a-dark-OS also resolves to — the probe would report PASS for a path it never executed.
 */
async function reloadFromMain(marker) {
  await P.evaluate(`window.${marker} = 'set'; true`)
  await M.evaluate(`globalThis.__electron.BrowserWindow.getAllWindows()[0].webContents.reload(); true`)
  await sleep(2000)
  const t = await attachTo(CDP, (x) => x.type === 'page' && (x.url || '').includes('index.html'), 40)
  if (!t) throw new Error('page target did not come back after reload')
  P = await client(t.webSocketDebuggerUrl); await P.send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if (await P.evaluate(`!!window.beacon && !!window.beacon.systemTheme && document.documentElement.getAttribute('data-theme') !== null`).catch(() => false)) break
    await sleep(500)
  }
  // Prove the reload really happened: the marker must be GONE from the new document.
  return await P.evaluate(`window.${marker}`).catch(() => undefined)
}

section('the GET channel reflects nativeTheme')
{
  await setThemeSource('dark')
  const got = await P.evaluate(`window.beacon.systemTheme.isDark()`)
  check(got === true && (await nativeDark()) === true, `systemTheme.isDark() → true while the OS source is dark (got ${got})`)
  await setThemeSource('light')
  const got2 = await P.evaluate(`window.beacon.systemTheme.isDark()`)
  check(got2 === false && (await nativeDark()) === false, `...and false after flipping the source to light (got ${got2}) — the sandboxed renderer's only read of nativeTheme goes through this channel`)
}

section('wearing SYSTEMA: an OS flip re-skins the document LIVE')
{
  // Set the OS LIGHT before booting into SYSTEMA. This is what makes the boot assertion meaningful:
  // the app's default plate is NOX (dark), so if SYSTEMA were ignored the document would read
  // "dark" — asserting "light" can ONLY be satisfied by the sentinel actually resolving. Reading
  // the other way round (boot dark, assert dark) passes whether or not SYSTEMA is wired at all.
  await setThemeSource('light')
  // Persist the sentinel through the SHIPPED settings handler — the same call the picker makes.
  await P.evaluate(`window.beacon.settings.set('theme:v1', 'system')`)
  const marker = await reloadFromMain('__probeReload1')
  check(marker === undefined, `the shell really reloaded (marker gone) — an asserted reload, not an assumed one`)
  check((await dataTheme()) === 'light', `boots into SYSTEMA with the OS light → data-theme="light" (LVX), NOT the NOX default (got ${JSON.stringify(await dataTheme())})`)
  check((await dataTheme()) !== 'system', 'the sentinel itself never reaches data-theme — tokens.css has no block for it')

  await setThemeSource('dark'); await sleep(1200)
  const afterDark = await dataTheme()
  check(afterDark === 'dark', `OS flips to dark → data-theme re-resolves to "dark" (NOX) WITHOUT a reload (got ${JSON.stringify(afterDark)}) — the push channel did what matchMedia could not: its change event never fires on Electron 44 (measured), so a renderer-only listener would have left this on LVX`)

  await setThemeSource('light'); await sleep(1200)
  const afterLight = await dataTheme()
  // Assert the SEQUENCE, not just the endpoint. "ends at light" is satisfied by a document that never
  // moved — boot was already light, so a dead push channel would pass that check while failing the
  // one above. Only light→dark→light proves the subscription is durable across transitions rather
  // than one-shot, or stuck. (Caught by mutation: removing the nativeTheme push left this green.)
  const seq = ['light', afterDark, afterLight].join('→')
  check(seq === 'light→dark→light', `the worn plate tracked every transition (observed ${seq}) — durable across flips, not one-shot and not stuck`)
}

section('a pinned plate ignores OS flips')
{
  await P.evaluate(`window.beacon.settings.set('theme:v1', 'aervgo')`)
  const marker = await reloadFromMain('__probeReload2')
  check(marker === undefined, 'the shell really reloaded into the pinned plate')
  check((await dataTheme()) === 'aervgo', `a pinned plate is worn as-is (got ${JSON.stringify(await dataTheme())})`)
  await setThemeSource('dark'); await sleep(1200)
  check((await dataTheme()) === 'aervgo', `an OS flip does NOT repaint an explicit choice (got ${JSON.stringify(await dataTheme())}) — opting out of following is absolute`)
  await setThemeSource('light'); await sleep(800)
}

section('the picker UI: clicking SYSTEMA persists it and re-skins (the user-facing half)')
{
  // Drive the REAL Config → Skin grid, not the settings IPC. A wired model behind a picker that
  // throws or renders nothing would still pass every check above.
  //
  // SEQUENCING IS THE WHOLE TEST. A reload drops the app back to its default view, so the navigation
  // to Config → Skin must happen AFTER the reload that establishes the pinned starting plate — not
  // before it. Navigating first (the obvious order) leaves the grid absent after the reload, the
  // card lookup finds nothing, and the click silently no-ops. Caught by an aria-checked reading back
  // null, which is what told us the element was gone rather than the product being wrong.
  const openSkinTab = async () => {
    const nav = await P.evaluate(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] button')].find(x => /config/i.test(x.textContent || '')); if (b) b.click(); return !!b })()`)
    await sleep(900)
    const tab = await P.evaluate(`(() => { const t = [...document.querySelectorAll('button,[role="tab"]')].find(x => /^skin$/i.test((x.textContent || '').trim())); if (t) t.click(); return !!t })()`)
    await sleep(900)
    return nav && tab
  }
  const clickSystema = () =>
    P.evaluate(`(() => { const c = [...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => /SYSTEMA/i.test(x.textContent || '')); if (c) { c.click(); return true } return false })()`)

  // Establish the pinned starting state FIRST, then navigate to the grid in the reloaded document.
  await P.evaluate(`window.beacon.settings.set('theme:v1', 'aervgo')`)
  await setThemeSource('light')
  await reloadFromMain('__probeReload3')
  check((await dataTheme()) === 'aervgo', `starts pinned to AERVGO under a light OS (got ${JSON.stringify(await dataTheme())})`)

  check(await openSkinTab(), 'navigated to Config → Skin in the reloaded document')
  const cards = await P.evaluate(`document.querySelectorAll('.skin-grid [role="radio"]').length`)
  check(cards === 10, `the Skin grid renders TEN radios — nine plates plus SYSTEMA (got ${cards})`)
  const sysCard = await P.evaluate(`(() => { const c = [...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => /SYSTEMA/i.test(x.textContent || '')); return c ? { found: true, label: (c.textContent || '').trim().slice(0, 40) } : { found: false } })()`)
  check(sysCard.found === true, `a SYSTEMA card is present in the grid (${JSON.stringify(sysCard)})`)
  const pinnedChecked = await P.evaluate(`(() => { const c = [...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => /AERVGO/i.test(x.textContent || '')); return c ? c.getAttribute('aria-checked') : null })()`)
  check(pinnedChecked === 'true', `before clicking, AERVGO is the checked card — the grid reads the persisted CHOICE (got ${JSON.stringify(pinnedChecked)})`)

  if (sysCard.found) {
    check(await clickSystema() === true, 'clicked the SYSTEMA card (the element was there to click)')
    await sleep(1400)
    const afterClick = await dataTheme()
    check(afterClick === 'light', `clicking SYSTEMA persists the sentinel AND re-skins to LVX under a light OS (got ${JSON.stringify(afterClick)}) — the click reached setThemeChoice, not just local state`)
    check((await P.evaluate(`window.beacon.settings.get('theme:v1')`)) === 'system', 'and the sentinel is what got persisted')
    const checked = await P.evaluate(`(() => { const c = [...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => /SYSTEMA/i.test(x.textContent || '')); return c ? c.getAttribute('aria-checked') : null })()`)
    check(checked === 'true', `the SYSTEMA card reads aria-checked="true" — the picker tracks the CHOICE, not the resolved plate (got ${JSON.stringify(checked)})`)
    // The SYSTEMA card's bands preview the plate worn RIGHT NOW. They were read on mount and on OS
    // flips only, so right after the pick they still showed the plate worn BEFORE it (#183 review).
    const bands = await P.evaluate(`(() => { const c = [...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => /SYSTEMA/i.test(x.textContent || '')); return c?.querySelector('.skin-card-bands')?.getAttribute('data-theme') ?? null })()`)
    check(bands === 'light', `the SYSTEMA card's preview shows the plate now worn, LVX (got ${JSON.stringify(bands)}) — not the plate worn before the pick`)
  }
}

section('SYSTEMA, then a plate before the OS answers: the plate is the newer intent and wins')
{
  // Picking SYSTEMA asks main whether the OS is dark (an IPC round trip); a plate pick does not. So
  // SYSTEMA-then-plate in quick succession finishes SYSTEMA LAST, and whatever it does after its
  // await lands on the newer choice. Construct that order deterministically: hold main's
  // system-theme:get reply, click SYSTEMA, click AERVGO, then release.
  const card = (re) => `[...document.querySelectorAll('.skin-grid [role="radio"]')].find(x => ${re}.test(x.textContent || ''))`
  const click = (re) => P.evaluate(`(() => { const c = ${card(re)}; if (c) { c.click(); return true } return false })()`)
  check(await click('/AERVGO/i'), 'clicked AERVGO to start from a pinned plate')
  await sleep(800)
  check((await dataTheme()) === 'aervgo', `starts from AERVGO (got ${JSON.stringify(await dataTheme())})`)
  const held = await M.evaluate(`(() => {
    const { ipcMain } = globalThis.__electron
    const orig = ipcMain._invokeHandlers?.get('system-theme:get')
    if (!orig) return 'no handler map'
    let release
    globalThis.__osGate = new Promise((r) => (release = r))
    globalThis.__releaseOs = release
    globalThis.__osHeld = 0
    ipcMain._invokeHandlers.set('system-theme:get', async (e, ...a) => { globalThis.__osHeld++; await globalThis.__osGate; return orig(e, ...a) })
    globalThis.__restoreOs = () => ipcMain._invokeHandlers.set('system-theme:get', orig)
    return 'held'
  })()`)
  check(held === 'held', `main's system-theme:get reply is held (got ${JSON.stringify(held)})`)
  check(await click('/SYSTEMA/i'), 'clicked SYSTEMA (its OS question is now waiting at the gate)')
  await sleep(500)
  check(await click('/AERVGO/i'), 'then clicked AERVGO before the OS answered')
  await sleep(500)
  const waited = await M.evaluate('globalThis.__osHeld')
  check(waited >= 1, `SYSTEMA's isDark really went through the gate (held ${waited}) — the losing order happened`)
  await M.evaluate('globalThis.__releaseOs(); globalThis.__restoreOs(); true')
  await sleep(1200)
  check((await dataTheme()) === 'aervgo', `after the late OS answer the document still wears AERVGO (got ${JSON.stringify(await dataTheme())}) — the stale SYSTEMA resume must not re-skin over the newer pick`)
  check((await P.evaluate(`window.beacon.settings.get('theme:v1')`)) === 'aervgo', `and AERVGO is what is persisted (got ${JSON.stringify(await P.evaluate(`window.beacon.settings.get('theme:v1')`))}) — else the next launch wears SYSTEMA`)
  check((await P.evaluate(`${card('/AERVGO/i')}?.getAttribute('aria-checked') ?? null`)) === 'true', 'and the grid still shows AERVGO checked — the three agree')
  await setThemeSource('dark'); await sleep(900)
  check((await dataTheme()) === 'aervgo', `an OS flip afterwards leaves AERVGO alone (got ${JSON.stringify(await dataTheme())}) — nothing is still following the OS`)
  await setThemeSource('light'); await sleep(500)
}

section('result')
console.log(failures === 0 ? 'PASS — SYSTEMA re-skins live off the push channel; pinned plates do not move' : `FAIL — ${failures} check(s)`)
console.log('\nNOT VISIBLE FROM THIS PROBE (verify on the Mac):')
console.log('  * the flips here are driven via nativeTheme.themeSource (the API the OS itself uses). On the')
console.log('    MAC, flip System Settings → Appearance and watch a SYSTEMA-wearing Beacon follow.')
console.log('  * this drives the Config → Skin GRID (click SYSTEMA → persists, re-skins, aria-checked flips).')
console.log('    It does NOT exercise the status-bar SkinPicker pill or the live-preview tiles — those are')
console.log('    renderer visuals; eyeball them. And it asserts the document attribute, not the rendered')
console.log('    colours, so confirm NOX↔LVX actually LOOK right as the OS flips.')
await M.evaluate(`globalThis.__electron.nativeTheme.themeSource = 'system'; true`).catch(() => {})
await reapAndExit(failures === 0 ? 0 : 1)
