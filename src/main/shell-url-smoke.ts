// Shell-url smoke: Beacon's own page is trusted, and nothing else is, WHICHEVER chunk the sender
// check lands in. Headless (ELECTRON_RUN_AS_NODE), no window.
//
// On 2026-09-24 (#190) a smoke's import moved shell-windows.ts out of out/main/index.js into a
// shared chunk. shellUrl() was `join(__dirname, '../renderer/index.html')`, so from out/main/chunks/
// it named out/main/renderer/. isShellSender refused the real shell page, every handleFromShell
// answered null, and the app sat on "Loading…" while typecheck and every smoke passed.
//
// This smoke puts shell-windows in a shared chunk ON PURPOSE: importing it here is what makes rollup
// split it out of index.js. The import is dynamic so that the stand-in for `electron` is installed
// before the chunk's own require('electron') runs. Then it asks THE chunk the app loads about senders:
//
//   1. the anchor as a pure function, over layouts rollup has not produced (yet)
//   2. the build: shell-windows really is in a chunk that index.js loads, and it is the module under
//      test. If rollup ever puts it back in index.js, this smoke fails rather than testing the wrong
//      layout.
//   3. (a) from that chunk, Beacon's own page is accepted on every route, through both helpers, and
//      the windows are loaded with exactly that page and the real preload
//   4. (b) from that chunk, everything else is still refused: a foreign page, the file the old code
//      named, other local files, a window Beacon did not make, an iframe, a gone frame, a dead
//      window, a frame that throws, and the dev-server URL in a packaged app
//   5. no anchor: the same chunk compiled with its build-time anchor as a build without the plugin
//      leaves it (`void 0`), and as '', '.' and a relative path. Every sender is refused, both
//      navigation listeners still refuse (no throw escapes them), and nothing is loaded or guessed.
//   6. the source: nothing in src/main derives a path from its own file, and only shell-windows names
//      the renderer or the preload
//
// What it cannot prove: what URL Electron reports for a real frame, or the real windows.
// scripts/window-guard-probe.mjs drives the built app for those.
//
// House rule (guards prove themselves): 5's predicates run against embedded fixtures FIRST, and the
// smoke exits 2 if one cannot tell a violation from clean code. The verdict runs on process 'exit'
// with a count guard, so an early return or a throw cannot report green.
//
// Run: npm run build && npm run smoke:shell-url
import { Module } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { mainOutDirExpression } from '@shared/main-out-dir'

const EXPECTED_CHECKS = 57
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

// ── 5's predicates (pure, on source text): defined first so the self-test runs first ─────────────
/** Code only: comments stripped, so an explanation that names a call can neither fake nor mask it. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** A path relative to the module's OWN file. That file is whichever chunk rollup chose, so the path
 *  moves when the module does. */
const selfRelative = (src: string): boolean => /\b__dirname\b|\b__filename\b|\bimport\.meta\.(?:url|dirname|filename)\b/.test(code(src))
/** Names Beacon's renderer page or preload file, i.e. computes where one of them is. */
const namesShellFiles = (src: string): boolean => /renderer\/index\.html|preload\/index\.js/.test(code(src))
/** Bridged windows whose preload is anything but shellPreload(). */
const otherPreloads = (src: string): number =>
  (code(src).match(/\bpreload\s*:/g) ?? []).length - (code(src).match(/\bpreload\s*:\s*shellPreload\(\)/g) ?? []).length

const selfTest: Array<[boolean, string]> = [
  [selfRelative(`const p = join(__dirname, '../renderer/index.html')`), 'selfRelative flags join(__dirname, …) (the #190 bug)'],
  [selfRelative(`const u = new URL('../renderer/index.html', import.meta.url)`), 'selfRelative flags new URL(…, import.meta.url)'],
  [!selfRelative(`// join(__dirname, …) is what broke #190\nconst p = join(import.meta.mainOutDir, 'x')`), 'selfRelative ignores a comment and passes import.meta.mainOutDir'],
  [namesShellFiles(`win.loadFile(join(root, '../renderer/index.html'))`) && namesShellFiles(`preload: join(root, '../preload/index.js')`), 'namesShellFiles flags the page and the preload'],
  [!namesShellFiles(`/* renderer/index.html */ loadShellPage(win)`), 'namesShellFiles ignores a comment'],
  [otherPreloads(`webPreferences: { preload: join(__dirname, '../preload/index.js') }`) === 1, 'otherPreloads flags a hand-built preload path'],
  [otherPreloads(`webPreferences: { preload: shellPreload(), sandbox: true }`) === 0, 'otherPreloads passes shellPreload()']
]
for (const [ok, what] of selfTest) {
  if (!ok) {
    console.error(`[smoke] SELF-TEST FAILED: ${what} — a source check cannot detect its own target; refusing to report.`)
    process.exit(2)
  }
}
console.log(`[smoke] self-test: ${selfTest.length}/${selfTest.length} predicates discriminate`)

// ── the stand-in for `electron` ──────────────────────────────────────────────────────────────────
// Only what shell-windows touches. isPackaged is flipped per case; a registered handler is kept so the
// smoke can call it the way ipcMain would.
type Invoke = (e: unknown, ...args: unknown[]) => unknown
const stub = {
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, fn: Invoke): void => void handles.set(channel, fn),
    on: (channel: string, fn: Invoke): void => void listeners.set(channel, fn)
  }
}
const handles = new Map<string, Invoke>()
const listeners = new Map<string, Invoke>()
const electronRequiredBy: string[] = []
const loader = Module as unknown as { _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown }
const realLoad = loader._load
loader._load = function (request, parent, isMain) {
  if (request === 'electron') {
    electronRequiredBy.push(parent?.filename ?? '(unknown)')
    return stub
  }
  return realLoad.call(this, request, parent, isMain)
}

/** A BrowserWindow as far as shell-windows can see one. Loading a URL puts it in the top frame, as
 *  Electron does. */
type NavListener = (e: { preventDefault(): void }, url: string) => void
function fakeWindow(url: string) {
  const mainFrame = { url }
  let destroyed = false
  const nav: Record<string, NavListener> = {}
  const wc: { mainFrame: unknown; isDestroyed: () => boolean; on: (ev: string, fn: NavListener) => unknown } = {
    mainFrame,
    isDestroyed: () => destroyed,
    on: (ev, fn) => {
      nav[ev] = fn
      return wc
    }
  }
  const loads: string[] = []
  const win = {
    webContents: wc,
    loadURL: (u: string): Promise<void> => {
      loads.push(u)
      mainFrame.url = u
      return Promise.resolve()
    }
  }
  return { win, wc, mainFrame, loads, nav, destroy: (): void => void (destroyed = true) }
}
type Fake = ReturnType<typeof fakeWindow>
/** What a call returned, or 'threw: …'. A throw fails the one check it belongs to instead of ending
 *  the run (built without the mainOutDir plugin, shellUrl() throws on an undefined anchor). */
const outcome = (f: () => unknown): unknown => {
  try {
    return f()
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`
  }
}
const event = (w: Fake, frame: unknown = w.mainFrame): IpcMainInvokeEvent & IpcMainEvent =>
  ({ sender: w.wc, senderFrame: frame }) as unknown as IpcMainInvokeEvent & IpcMainEvent

async function main(): Promise<void> {
  // ── 1. the anchor, for any layout ─────────────────────────────────────────────────────────────
  console.log('\n[smoke] === 1. out/main, from any chunk (the pure anchor) ===')
  const at = (chunk: string, dir: string): string => {
    const onlyPath = (id: string): unknown => {
      if (id !== 'path') throw new Error(`the anchor required ${id}`)
      return posix
    }
    return new Function('require', '__dirname', `return ${mainOutDirExpression(chunk)}`)(onlyPath, dir) as string
  }
  const ASAR = '/Applications/Beacon.app/Contents/Resources/app.asar/out/main'
  // While rendering, rollup names a chunk with a hash placeholder (the hook saw
  // 'chunks/shell-windows-!~{00r}~.js'). Built at runtime: rollup rewrites that pattern wherever it
  // appears in its output, this smoke's own string literals included.
  const RENDERING = `chunks/shell-windows-${['!~{', '00r', '}~'].join('')}.js`
  // [chunk file name, the directory it is written to, what the anchor must say, what it is]
  const layouts: Array<[string, string, string, string]> = [
    ['index.js', '/r/out/main', '/r/out/main', 'the entry itself'],
    [RENDERING, '/r/out/main/chunks', '/r/out/main', 'a chunk, named as rollup names it while rendering'],
    ['chunks/shell-windows-Ab12.js', `${ASAR}/chunks`, ASAR, 'a chunk inside the packaged asar'],
    ['a/b/deep-Cd34.js', '/r/out/main/a/b', '/r/out/main', 'a chunk two directories down']
  ]
  for (const [chunk, dir, want, what] of layouts) {
    const got = at(chunk, dir)
    assert(got === want, `${what} (${chunk}) → out/main`, `got ${got}`)
  }
  let climbs = 0
  for (const bad of ['../x.js', '/abs/x.js', 'chunks/../../x.js']) {
    try {
      mainOutDirExpression(bad)
    } catch {
      climbs++
    }
  }
  assert(climbs === 3, 'a file name outside out/main throws (it fails the build instead of guessing)', `${climbs}/3 threw`)

  // ── 2. the build: shell-windows is in a shared chunk, and that is what we test ─────────────────
  console.log('\n[smoke] === 2. the build puts shell-windows in a shared chunk ===')
  const OUT_MAIN = dirname(fileURLToPath(import.meta.url)) // this smoke is an entry, so this IS out/main
  const SHELL_FILE = join(OUT_MAIN, '../renderer/index.html')
  const PRELOAD_FILE = join(OUT_MAIN, '../preload/index.js')
  const SHELL = pathToFileURL(SHELL_FILE).href
  assert(basename(OUT_MAIN) === 'main' && existsSync(SHELL_FILE) && existsSync(PRELOAD_FILE), 'the built renderer page and preload exist beside out/main (control: the files this smoke calls real)', `${SHELL_FILE} / ${PRELOAD_FILE}`)
  const DEFINES = /\bfunction isShellSender\(/
  const chunks = readdirSync(join(OUT_MAIN, 'chunks')).filter((f) => f.endsWith('.js') && DEFINES.test(readFileSync(join(OUT_MAIN, 'chunks', f), 'utf8')))
  const entry = readFileSync(join(OUT_MAIN, 'index.js'), 'utf8')
  assert(!DEFINES.test(entry) && chunks.length === 1, 'isShellSender is in exactly one shared chunk, not in index.js', `index.js defines it: ${DEFINES.test(entry)}; chunks: ${chunks.join(', ') || 'none'}`)
  const CHUNK = chunks[0] ?? '(none)'
  assert(entry.includes(`require("./chunks/${CHUNK}")`), `the app entry loads that chunk (${CHUNK})`)

  const sw = await import('./shell-windows')
  assert(electronRequiredBy.length === 1 && electronRequiredBy[0] === join(OUT_MAIN, 'chunks', CHUNK), 'the module under test is that chunk (it is what asked for electron)', electronRequiredBy.join(', '))

  // ── 3. (a) Beacon's own page is accepted, from the chunk ──────────────────────────────────────
  console.log('\n[smoke] === 3. (a) from the chunk, Beacon\'s own page is accepted ===')
  delete process.env.ELECTRON_RENDERER_URL
  stub.app.isPackaged = true
  const ROUTES = ['', 'capture', 'hud', 'terminal', 'browser']
  const url = (route: string, base = SHELL): string => (route ? `${base}#${route}` : base)
  const packagedUrl = outcome(() => sw.shellUrl())
  assert(packagedUrl === SHELL, 'packaged: shellUrl() is the built page beside out/main', `got ${String(packagedUrl)}`)
  for (const route of ROUTES) {
    const w = fakeWindow(url(route))
    sw.adoptShellWindow(w.win as never)
    assert(sw.isShellSender(event(w)), `the shell page (#${route || '—'}) at the top of a Beacon window is accepted`)
  }
  let ran = 0
  sw.handleFromShell('smoke:ask', (_e, arg) => {
    ran++
    return `answer:${String(arg)}`
  })
  sw.onFromShell('smoke:tell', () => void ran++)
  const shellWin = fakeWindow(SHELL)
  sw.adoptShellWindow(shellWin.win as never)
  const answer = handles.get('smoke:ask')?.(event(shellWin), 'x')
  assert(answer === 'answer:x' && ran === 1, 'handleFromShell: the handler runs for the shell and its answer comes back (what setup.status() needs)', `answer ${String(answer)}, ran ${ran}`)
  listeners.get('smoke:tell')?.(event(shellWin))
  assert(ran === 2, 'onFromShell: the listener runs for the shell')
  stub.app.isPackaged = false
  const unpackagedUrl = outcome(() => sw.shellUrl())
  assert(unpackagedUrl === SHELL, 'unpackaged with no dev server (electron . on a build): the same built page', `got ${String(unpackagedUrl)}`)
  stub.app.isPackaged = true

  // The windows are loaded with exactly the page the check accepts, and bridged with the real preload.
  const hasLoader = typeof sw.loadShellPage === 'function'
  const loaded = ROUTES.map((route) => {
    const w = fakeWindow('about:blank')
    sw.adoptShellWindow(w.win as never)
    if (hasLoader) outcome(() => sw.loadShellPage(w.win as never, route))
    return { route, w }
  })
  const wrongLoads = loaded.filter(({ route, w }) => w.loads.length !== 1 || w.loads[0] !== url(route)).map(({ route, w }) => `#${route}: ${w.loads.join(', ') || 'nothing'}`)
  assert(hasLoader && wrongLoads.length === 0, 'loadShellPage loads the built page on each route, once', hasLoader ? wrongLoads.join('; ') : 'loadShellPage does not exist')
  assert(hasLoader && loaded.every(({ w }) => sw.isShellSender(event(w))), 'a window loaded by loadShellPage is accepted (the load and the check cannot disagree)')
  const preload = typeof sw.shellPreload === 'function' ? outcome(() => sw.shellPreload()) : '(shellPreload does not exist)'
  assert(preload === PRELOAD_FILE, 'shellPreload() is the built preload beside out/main', `got ${String(preload)}`)

  // ── 4. (b) everything else is still refused, from the chunk ───────────────────────────────────
  console.log('\n[smoke] === 4. (b) from the chunk, everything else is refused ===')
  const REPO = join(OUT_MAIN, '../..')
  const refused = (frameUrl: string): boolean => {
    const w = fakeWindow(frameUrl)
    sw.adoptShellWindow(w.win as never)
    return !sw.isShellSender(event(w))
  }
  const before = ran
  const foreign = fakeWindow('https://evil.example/')
  sw.adoptShellWindow(foreign.win as never)
  assert(!sw.isShellSender(event(foreign)), 'a foreign page at the top of a Beacon window is refused')
  const reply = handles.get('smoke:ask')?.(event(foreign), 'x')
  listeners.get('smoke:tell')?.(event(foreign))
  assert(reply === null && ran === before, 'through the helpers, it gets null and neither handler runs', `reply ${String(reply)}, ran ${ran - before}×`)
  const OLD = pathToFileURL(join(OUT_MAIN, 'chunks', '../renderer/index.html')).href
  assert(refused(OLD), `the file the old __dirname path named from this chunk (${relative(REPO, fileURLToPath(OLD))}) is refused`)
  assert(refused(pathToFileURL(join(dirname(SHELL_FILE), 'other.html')).href), 'another page beside the shell page is refused')
  assert(existsSync(join(REPO, 'index.html')) && refused(pathToFileURL(join(REPO, 'index.html')).href), 'another real index.html (the renderer source, repo root) is refused')
  assert(refused('file:///etc/hosts'), 'a local system file is refused')
  assert(refused('http://localhost:5173/'), 'packaged: a dev-server URL is refused')
  const stranger = fakeWindow(SHELL)
  assert(!sw.isShellSender(event(stranger)), 'a window Beacon did not adopt is refused on the shell page')
  const framed = fakeWindow(SHELL)
  sw.adoptShellWindow(framed.win as never)
  assert(!sw.isShellSender(event(framed, { url: SHELL })), 'an iframe is refused on the shell page')
  assert(!sw.isShellSender(event(framed, null)), 'a sender whose frame is gone is refused')
  // The top frame itself, disposed mid-message: reading its URL throws.
  const throwing = fakeWindow(SHELL)
  sw.adoptShellWindow(throwing.win as never)
  const disposed = {}
  Object.defineProperty(disposed, 'url', { get: () => { throw new Error('Render frame was disposed') } })
  throwing.wc.mainFrame = disposed
  assert(!sw.isShellSender(event(throwing, disposed)), 'a top frame that throws on access is refused (no throw escapes)')
  const dead = fakeWindow(SHELL)
  sw.adoptShellWindow(dead.win as never)
  dead.destroy()
  assert(!sw.isShellSender(event(dead)), 'a destroyed Beacon window is refused')

  // The dev-server branch: honoured only when unpackaged, and then the built file is not the shell.
  const DEV = 'http://localhost:5173'
  process.env.ELECTRON_RENDERER_URL = DEV
  const envUrl = outcome(() => sw.shellUrl())
  assert(envUrl === SHELL && refused(`${DEV}/#hud`), 'packaged with ELECTRON_RENDERER_URL set: still the built page, and the dev server is refused', `shellUrl ${String(envUrl)}`)
  stub.app.isPackaged = false
  const devWin = fakeWindow('about:blank')
  sw.adoptShellWindow(devWin.win as never)
  if (hasLoader) outcome(() => sw.loadShellPage(devWin.win as never, 'hud'))
  assert(hasLoader && devWin.loads[0] === `${DEV}#hud` && sw.isShellSender(event(devWin)) && refused(SHELL), 'npm run dev: the window loads the dev server, it is accepted, and the built file is refused', devWin.loads.join(', '))
  stub.app.isPackaged = true
  delete process.env.ELECTRON_RENDERER_URL

  // ── 5. no anchor ──────────────────────────────────────────────────────────────────────────────
  // import.meta.mainOutDir is written in at build time. Without the plugin rollup emits `void 0`; ''
  // and relative paths stand for a plugin that emits something wrong. None may make the check accept
  // a sender or resolve against the working directory. The chunk's own source is compiled in place
  // with the anchor replaced, so what runs is the shipped code, not a copy of its logic.
  console.log('\n[smoke] === 5. no anchor: every sender refused, nothing guessed ===')
  const chunkPath = join(OUT_MAIN, 'chunks', CHUNK)
  const chunkSrc = readFileSync(chunkPath, 'utf8')
  const ANCHOR = mainOutDirExpression(`chunks/${CHUNK}`)
  assert(chunkSrc.split(ANCHOR).length - 1 === 1, `the chunk carries the build-time anchor exactly once (${ANCHOR}), so each rewrite below has a target`)
  const compile = (src: string): typeof sw => {
    const m = new Module(chunkPath) as Module & { _compile(code: string, file: string): void }
    m.filename = chunkPath
    m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(dirname(chunkPath))
    m._compile(src, chunkPath)
    return m.exports as typeof sw
  }
  /** Both navigation listeners' verdict on `u`: refused, allowed, or the throw that escaped. */
  const fire = (w: Fake, ev: string, u: string): string => {
    const fn = w.nav[ev]
    if (!fn) return 'no listener'
    let prevented = false
    const r = outcome(() => fn({ preventDefault: () => void (prevented = true) }, u))
    return typeof r === 'string' && r.startsWith('threw') ? r : prevented ? 'refused' : 'allowed'
  }
  // What a cwd-relative anchor would name from here ('' and '.' give the first; 'out/main' gives the
  // real page itself when, as under npm, the cwd is the repo root).
  const GUESS = pathToFileURL(join(process.cwd(), '../renderer/index.html')).href
  const FOREIGN = 'https://evil.example/'
  /** Everything the module could accept, answer, allow or load, asked of `mod`, packaged. */
  const battery = (mod: typeof sw, tag: string) => {
    const warn = console.warn
    console.warn = (): void => undefined // the refusals log a line each; the verdicts below are the record
    try {
      delete process.env.ELECTRON_RENDERER_URL
      stub.app.isPackaged = false
      const unpackaged = outcome(() => mod.shellUrl())
      stub.app.isPackaged = true
      const packaged = outcome(() => mod.shellUrl())
      const accepted = [...ROUTES.map((r) => url(r)), GUESS, OLD, FOREIGN].filter((u) => {
        const w = fakeWindow(u)
        mod.adoptShellWindow(w.win as never)
        return outcome(() => mod.isShellSender(event(w))) === true
      })
      let answered = 0
      mod.handleFromShell(`smoke:no-anchor:${tag}`, () => {
        answered++
        return 'answer'
      })
      const shellWin = fakeWindow(SHELL)
      mod.adoptShellWindow(shellWin.win as never)
      const reply = handles.get(`smoke:no-anchor:${tag}`)?.(event(shellWin))
      const navWin = fakeWindow(SHELL)
      mod.adoptShellWindow(navWin.win as never)
      const navigation = ['will-navigate', 'will-redirect'].flatMap((ev) => [SHELL, FOREIGN, GUESS, 'about:blank'].map((u) => ({ ev, u, verdict: fire(navWin, ev, u) })))
      const loadWin = fakeWindow('about:blank')
      const load = outcome(() => mod.loadShellPage(loadWin.win as never, 'hud'))
      const preload = outcome(() => mod.shellPreload())
      return { unpackaged, packaged, accepted, reply, answered, navigation, loads: loadWin.loads, load, preload }
    } finally {
      console.warn = warn
    }
  }
  const threw = (v: unknown): boolean => typeof v === 'string' && v.startsWith('threw')
  // Control: the chunk as built, compiled the same way, accepts the shell page and loads it. Without
  // this, a compile that broke everything would make every refusal below pass.
  const asBuilt = battery(compile(chunkSrc), 'as-built')
  assert(
    asBuilt.packaged === SHELL && asBuilt.accepted.join() === ROUTES.map((r) => url(r)).join() && asBuilt.reply === 'answer' &&
      asBuilt.loads.join() === url('hud') && asBuilt.preload === PRELOAD_FILE && asBuilt.navigation.every((n) => n.verdict === (n.u === 'about:blank' ? 'allowed' : 'refused')),
    'control: the chunk as built, compiled in place, accepts the shell page on every route, answers it, and loads it',
    JSON.stringify(asBuilt)
  )
  for (const [anchor, what] of [
    ['void 0', 'void 0 (what a build without the plugin emits)'],
    ['""', "'' (empty)"],
    ['"."', "'.' (relative)"],
    ['"out/main"', "'out/main' (relative: resolved against the cwd it IS the real page)"]
  ]) {
    const r = battery(compile(chunkSrc.replace(ANCHOR, anchor)), anchor)
    assert(r.packaged === null && r.unpackaged === null, `anchor ${what}: shellUrl() names no page (packaged or not)`, `packaged ${String(r.packaged)}, unpackaged ${String(r.unpackaged)}`)
    assert(r.accepted.length === 0 && r.reply === null && r.answered === 0, `anchor ${what}: every sender is refused (the real page on each route, the cwd guess, the old path, a foreign page) and no handler runs`, `accepted: ${r.accepted.join(', ')}; reply ${String(r.reply)}`)
    const navWrong = r.navigation.filter((n) => n.verdict !== (n.u === 'about:blank' ? 'allowed' : 'refused'))
    assert(navWrong.length === 0, `anchor ${what}: both navigation listeners refuse everything but about:blank, and no throw escapes them`, navWrong.map((n) => `${n.ev} ${n.u}: ${n.verdict}`).join('; '))
    assert(r.loads.length === 0 && threw(r.load) && threw(r.preload), `anchor ${what}: loadShellPage and shellPreload throw, and nothing is loaded`, `loads ${r.loads.join(', ') || 'none'}; load ${String(r.load)}; preload ${String(r.preload)}`)
  }

  // ── 6. the source ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[smoke] === 6. the source: one place says where Beacon\'s files are ===')
  const SRC_MAIN = join(REPO, 'src/main')
  // Smokes and the invariant checkers are excluded: they read source text, and name these files in it.
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.ts$/.test(e.name) && !/-(smoke|invariant)\.ts$/.test(e.name) ? [join(d, e.name)] : []))
  const files = walk(SRC_MAIN).map((p) => ({ path: relative(REPO, p), text: readFileSync(p, 'utf8') }))
  assert(files.length >= 30 && files.some((f) => f.path === 'src/main/shell-windows.ts'), `read src/main (${files.length} files, smokes and invariants excluded)`)
  const selfRel = files.filter((f) => selfRelative(f.text)).map((f) => f.path)
  assert(selfRel.length === 0, 'no main-process file derives a path from its own file (__dirname and friends move with the chunk)', selfRel.join(', '))
  const namers = files.filter((f) => namesShellFiles(f.text)).map((f) => f.path)
  assert(namers.length === 1 && namers[0] === 'src/main/shell-windows.ts', 'only shell-windows.ts says where the renderer page and the preload are', namers.join(', '))
  const handBuilt = files.filter((f) => otherPreloads(f.text) > 0).map((f) => f.path)
  assert(handBuilt.length === 0, 'every bridged window takes its preload from shellPreload()', handBuilt.join(', '))
}

main().catch((err) => {
  console.error('[smoke] threw:', err instanceof Error ? err.stack : err)
  process.exitCode = 1
})
