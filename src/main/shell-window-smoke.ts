// Shell-window smoke: headless (ELECTRON_RUN_AS_NODE), no window. Two halves:
//
//   A. THE DECISIONS (@shared/shell-window), in both directions: where a Beacon window's top frame
//      may navigate on its own, and which IPC sender the terminal guard trusts. Fixtures cover the
//      built shell (file://, every hash route) and the dev server (http://localhost).
//   B. THE WIRING, on the SOURCE: every preload-bridged window in src/main is adopted (registered +
//      navigation-guarded) and has a window-open handler; the adoption installs both listeners with
//      the shared decision; the terminal guard IS the shared sender check.
//
// What it cannot prove: that Electron raises will-navigate for a given gesture, or that the check
// holds in a running app. scripts/window-guard-probe.mjs drives the built app for that.
//
// House rule (guards prove themselves): B's predicates run against embedded fixtures FIRST, and the
// smoke exits 2 if one cannot tell a wired window from an unwired one. The verdict runs on process
// 'exit' with a count guard, so an early return cannot report green.
//
// Run: npm run build && npm run smoke:shell-window
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isShellDocument, mayShellWindowNavigate, shellSenderRefusal, type ShellSenderFacts } from '@shared/shell-window'

const EXPECTED_CHECKS = 43
let checks = 0
let failures = 0
let reported = false
function assert(cond: boolean, what: string, detail = ''): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (reported) return
  reported = true
  if (checks !== EXPECTED_CHECKS) {
    console.log(`\n[smoke] RESULT: INCOMPLETE — ${checks} checks ran, expected ${EXPECTED_CHECKS}`)
    process.exitCode = 1
    return
  }
  console.log(`\n[smoke] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks}`)
  if (failures) process.exitCode = 1
})

// ── B's predicates (pure, on source text): defined first so the self-test runs first ─────────────
/** Code only: comments stripped, so an explanation that names a call can neither fake nor mask it. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** Per file: how many bridged windows it makes, how many it adopts, how many get a window-open handler. */
function wiring(src: string): { bridged: number; adopted: number; openHandlers: number } {
  const c = code(src)
  return {
    bridged: (c.match(/\bpreload\s*:/g) ?? []).length,
    adopted: (c.match(/\badoptShellWindow\(win\)/g) ?? []).length,
    openHandlers: (c.match(/\.setWindowOpenHandler\(/g) ?? []).length
  }
}
const wired = (w: ReturnType<typeof wiring>): boolean => w.adopted === w.bridged && w.openHandlers >= w.bridged
/** Does the adoption install BOTH listeners, each refusing with the shared decision? */
function guardsBothEvents(src: string): boolean {
  const c = code(src)
  return ['will-navigate', 'will-redirect'].every((ev) =>
    new RegExp(`\\.on\\('${ev}', \\(e, url\\) => \\{\\s*if \\(!mayShellWindowNavigate\\(url, shellUrl\\(\\)\\)\\) \\{\\s*e\\.preventDefault\\(\\)`).test(c)
  )
}

const DIRTY_WINDOW = `const win = new BrowserWindow({ webPreferences: { preload: join(__dirname, '../preload/index.js') } })
// adoptShellWindow(win) — a comment is not a call
win.loadFile(x)`
const CLEAN_WINDOW = `const win = new BrowserWindow({ webPreferences: { preload: join(__dirname, '../preload/index.js') } })
adoptShellWindow(win)
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`
const NO_OPEN_HANDLER = `const win = new BrowserWindow({ webPreferences: { preload: p } })\nadoptShellWindow(win)`
const ONE_EVENT = `wc.on('will-navigate', (e, url) => {\n    if (!mayShellWindowNavigate(url, shellUrl())) {\n      e.preventDefault()\n    }\n  })`
const BOTH_EVENTS = ONE_EVENT + '\n' + ONE_EVENT.replace('will-navigate', 'will-redirect')
const selfTest: Array<[boolean, string]> = [
  [!wired(wiring(DIRTY_WINDOW)), 'wiring flags a bridged window that is not adopted (and ignores the call named in a comment)'],
  [wired(wiring(CLEAN_WINDOW)), 'wiring passes an adopted window with a window-open handler'],
  [!wired(wiring(NO_OPEN_HANDLER)), 'wiring flags a bridged window with no window-open handler'],
  [!guardsBothEvents(ONE_EVENT), 'guardsBothEvents flags a guard on will-navigate alone'],
  [guardsBothEvents(BOTH_EVENTS), 'guardsBothEvents passes both listeners']
]
for (const [ok, what] of selfTest) {
  if (!ok) {
    console.error(`[smoke] SELF-TEST FAILED: ${what} — the wiring check cannot detect its own target; refusing to report.`)
    process.exit(2)
  }
}
console.log(`[smoke] self-test: ${selfTest.length}/${selfTest.length} predicates discriminate`)

function main(): void {
  const BUILT = 'file:///Applications/Beacon.app/Contents/Resources/app.asar/out/renderer/index.html'
  const DEV = 'http://localhost:5173'

  // ── A1. what is the shell page ─────────────────────────────────────────────────────────────────
  console.log('\n[smoke] === A1. the shell page, on every route ===')
  for (const route of ['', '#capture', '#hud', '#terminal', '#browser']) {
    assert(isShellDocument(BUILT + route, BUILT), `built shell ${route || '(main)'} is the shell page`)
  }
  assert(isShellDocument('http://localhost:5173/#hud', DEV), 'dev: the dev server root with a route is the shell page')
  assert(isShellDocument('file:///Users/me/Beacon%20Dev/out/renderer/index.html', 'file:///Users/me/Beacon Dev/out/renderer/index.html'), 'an encoded space and a literal one name the same file')
  assert(!isShellDocument('file:///Users/me/Downloads/index.html', BUILT), 'another file called index.html is not the shell page')
  assert(!isShellDocument('file:///etc/hosts', BUILT), 'a local file is not the shell page')
  assert(!isShellDocument('https://evil.example/out/renderer/index.html', BUILT), 'a web page with the same path is not the shell page')
  assert(!isShellDocument('http://localhost:5174/', DEV), 'dev: another port is not the shell page')
  assert(!isShellDocument('not a url', BUILT) && !isShellDocument('', BUILT), 'an unparseable URL is not the shell page')

  // ── A2. where a Beacon window may navigate on its own ─────────────────────────────────────────
  console.log('\n[smoke] === A2. navigation: nothing leaves the shell page ===')
  // THE FINDING. #120's guard (isAllowedNavigation) admitted every one of these web pages.
  for (const url of ['https://evil.example/', 'http://127.0.0.1:8080/x', 'http://localhost:5173/'])
    assert(!mayShellWindowNavigate(url, BUILT), `built: a web page (${url}) is refused`)
  for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,<p>x', 'beacon-artifact://render/x', 'chrome://settings'])
    assert(!mayShellWindowNavigate(url, BUILT), `built: ${url.slice(0, 26)} is refused (as under #120)`)
  // #186's ruling: the built shell's own file:// page is refused too; a link to it looks like a reload.
  assert(!mayShellWindowNavigate(BUILT, BUILT) && !mayShellWindowNavigate(BUILT + '#hud', BUILT), 'built: the shell\'s own file:// page is refused (not widened, per #186)')
  assert(mayShellWindowNavigate('about:blank', BUILT), 'about:blank stays allowed (#120)')
  assert(mayShellWindowNavigate('http://localhost:5173/', DEV) && mayShellWindowNavigate('http://localhost:5173/#capture', DEV), 'dev: the dev server\'s own reload stays allowed')
  assert(!mayShellWindowNavigate('https://evil.example/', DEV) && !mayShellWindowNavigate('http://localhost:5174/', DEV), 'dev: every other web page is refused')

  // ── A3. which sender the terminal guard trusts ────────────────────────────────────────────────
  console.log('\n[smoke] === A3. the sender: a Beacon window, its top frame, the shell page ===')
  const shell: ShellSenderFacts = { known: true, mainFrame: true, frameUrl: BUILT + '#terminal', shellUrl: BUILT }
  assert(shellSenderRefusal(shell) === null, 'the shell page in a Beacon window\'s top frame is accepted')
  assert(shellSenderRefusal({ ...shell, frameUrl: DEV + '/#hud', shellUrl: DEV }) === null, 'dev: the dev-server shell is accepted')
  // Each of the three conditions refuses on its own; together they are the old guard plus the URL.
  assert(shellSenderRefusal({ ...shell, frameUrl: 'http://127.0.0.1:8080/x' }) === 'not the shell page', 'a foreign page at the top of a Beacon window is refused (what the old guard accepted)')
  assert(shellSenderRefusal({ ...shell, frameUrl: 'about:blank' }) === 'not the shell page', 'about:blank at the top of a Beacon window is refused')
  assert(shellSenderRefusal({ ...shell, frameUrl: null }) === 'not the shell page', 'a sender whose frame is gone is refused')
  assert(shellSenderRefusal({ ...shell, known: false }) === 'not a Beacon window', 'a window Beacon did not create is refused even on the shell page (what the old guard accepted)')
  assert(shellSenderRefusal({ ...shell, mainFrame: false }) === 'not the top frame', 'an iframe is refused even on a shell URL')

  // ── B. the wiring ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[smoke] === B. every bridged window is adopted ===')
  const MAIN = join(fileURLToPath(import.meta.url), '../../../src/main')
  const read = (f: string): string => readFileSync(join(MAIN, f), 'utf8')
  const files = readdirSync(MAIN).filter((f) => f.endsWith('.ts') && !/-(smoke|invariant)\.ts$/.test(f))
  let bridgedTotal = 0
  const per: Record<string, ReturnType<typeof wiring>> = {}
  for (const f of files) {
    const w = wiring(read(f))
    if (w.bridged === 0) continue
    per[f] = w
    bridgedTotal += w.bridged
  }
  // Main, quick-capture and the HUD in index.ts; the pop-out in popout-window.ts (the terminal and
  // the browser both open it); a session window in session-windows.ts (one per popped-out
  // conversation, @shared/session-windows). A sixth window must be counted here on purpose, not slip in.
  assert(
    bridgedTotal === 5 && per['index.ts']?.bridged === 3 && per['popout-window.ts']?.bridged === 1 && per['session-windows.ts']?.bridged === 1,
    'the bridged windows are the five known ones',
    JSON.stringify(per)
  )
  for (const [f, w] of Object.entries(per)) {
    assert(w.adopted === w.bridged, `${f}: every bridged window is adopted (${w.adopted}/${w.bridged})`)
    assert(w.openHandlers >= w.bridged, `${f}: every bridged window has a window-open handler (${w.openHandlers}/${w.bridged})`)
  }
  const glue = read('shell-windows.ts')
  assert(guardsBothEvents(glue), 'adoptShellWindow refuses on will-navigate AND will-redirect with mayShellWindowNavigate')
  assert(/adopted\.add\(wc\)/.test(code(glue)) && /known: adopted\.has\(wc\)/.test(code(glue)), 'adoptShellWindow registers the window the sender check asks about')
  assert(/shellSenderRefusal\(\{/.test(code(glue)), 'isShellSender decides with the shared shellSenderRefusal')
  const term = code(read('terminal-ipc.ts'))
  assert(/export function isBeaconWindowFrame\([^)]*\): boolean \{\s*return isShellSender\(e\)\s*\}/.test(term), 'the terminal guard (isBeaconWindowFrame) IS the shared sender check')
  const index = code(read('index.ts'))
  assert(!/isAllowedNavigation/.test(index), 'the main window no longer guards with isAllowedNavigation (it admits every web page)')
}

main()
