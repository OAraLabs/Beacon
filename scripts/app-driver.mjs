// Drive the REAL built Beacon from THIS checkout, with an explicit lifecycle — launch, drive, quit,
// relaunch the same profile. cdp-harness.mjs launches at import time, once, from a hard-coded REPO;
// a probe that has to observe a RELAUNCH (drafts) or plant a frame through main (the error
// boundary) needs both halves of the app and more than one launch, so it uses this instead.
//
// What it guarantees, each because its absence has already produced a false result here:
//   * the build it drives is THIS checkout's `out/`, and the attached page's URL is asserted to be
//     inside it — a harness that drives someone else's tree reports on code nobody changed;
//   * the build is not older than the source (same fail-closed guard as cdp-harness);
//   * nothing already answers on its ports, so it cannot attach to a stale Electron;
//   * it runs on a SCRATCH COPY of the user's profile (`--user-data-dir`), so the user's own Beacon
//     keeps its single-instance lock and its data. The copy's outbox is EMPTIED: replaying a pending
//     send from a copy would post the user's message to the daemon a second time.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LIVE_PROFILE = join(homedir(), 'Library/Application Support/beacon-desktop')
const LIVE_DB = join(LIVE_PROFILE, 'beacon.db')
// The Electron binary inside the driven checkout's own node_modules. It used to be one hard-coded
// checkout's path under the home folder: rename or move that checkout and every probe failed to
// launch, or drove another tree's Electron. A worktree has no node_modules until `npm ci` runs in it.
const electronBin = (repo) => join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

/** Why the live profile may be in use right now, or null when nothing holds it. Electron's
 *  single-instance lock keeps a `SingletonLock` symlink (`<host>-<pid>`) in userData for as long as
 *  the app that took it runs, packaged or a dev `electron .` on the default userData alike; `pgrep -x
 *  Beacon` names the packaged app. Doubt counts as in use: a false "in use" costs a loud CANTOPEN,
 *  a false "closed" costs an immutable read racing a writer. */
function liveProfileHolder() {
  try {
    const lock = readlinkSync(join(LIVE_PROFILE, 'SingletonLock'))
    const pid = Number(lock.slice(lock.lastIndexOf('-') + 1))
    try {
      process.kill(pid, 0)
      return `pid ${pid} holds SingletonLock`
    } catch (e) {
      if (e.code !== 'ESRCH') return `SingletonLock -> ${lock} (${e.code})`
    }
  } catch (e) {
    if (e.code !== 'ENOENT') return `SingletonLock unreadable (${e.code})`
  }
  const pg = spawnSync('pgrep', ['-x', 'Beacon'])
  if (pg.status === 0) return `Beacon is running (pid ${pg.stdout.toString().trim().replace(/\n/g, ', ')})`
  if (pg.status !== 1) return `pgrep failed (${pg.error?.code ?? pg.status})`
  // Side files mean a WAL connection is open, or a crash left a hot WAL that an immutable read
  // would silently skip, dropping committed rows. -readonly reads through them.
  const side = ['-wal', '-shm'].filter((s) => existsSync(LIVE_DB + s))
  return side.length ? `beacon.db${side.join(', beacon.db')} present` : null
}

/** Copy the live cache DB to `dest` through SQLite's backup API, so the copy is consistent. Never
 *  writes the live DB. beacon.db is in WAL mode, and a `-readonly` connection to a WAL database needs
 *  the -shm the running app keeps: with Beacon closed there is none, a read-only open cannot create
 *  one, and sqlite3 fails "unable to open database file". So: in use, `-readonly` (immutable would
 *  ignore a concurrent writer); closed, `immutable=1`, which takes no locks and opens no side files. */
function backupLiveDb(dest) {
  const holder = liveProfileHolder()
  const src = holder ? LIVE_DB : `file:${LIVE_DB.replace(/[%?#]/g, (c) => '%' + c.charCodeAt(0).toString(16))}?mode=ro&immutable=1`
  const how = holder ? `-readonly (${holder})` : 'immutable (Beacon is not running)'
  try {
    execFileSync('sqlite3', [...(holder ? ['-readonly'] : []), src, `.backup '${dest}'`], { stdio: 'pipe' })
  } catch (e) {
    throw new Error(`copying beacon.db ${how} failed: ${String(e.stderr ?? e.message).trim()}`)
  }
  // An immutable read is only consistent if nothing wrote during it.
  const after = holder ? null : liveProfileHolder()
  if (after) throw new Error(`the live profile came into use during the immutable copy (${after}) — rerun`)
  console.log(`[app-driver] beacon.db copied ${how}`)
}

/** A scratch profile cloned from the live one: the cache DB (see backupLiveDb) and window state.
 *  Returns its directory. */
export function scratchProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-probe-profile-'))
  backupLiveDb(join(dir, 'beacon.db'))
  // NOT the credential. Decrypting it goes through the macOS Keychain, whose permission prompt is a
  // system modal that blocks main's thread (the app never comes up) and asks the user for their
  // password on behalf of a scratch copy. Without it the app still starts in connect mode — the
  // token is optional — and reads everything these probes need from the cache. It also means a
  // probe CANNOT write to the daemon: the bearer middleware refuses every /api/ call.
  for (const f of ['window-state.json', 'loop-projects.json']) {
    if (existsSync(join(LIVE_PROFILE, f))) copyFileSync(join(LIVE_PROFILE, f), join(dir, f))
  }
  sql(dir, 'DELETE FROM outbox')
  return dir
}

/** Run one statement against a scratch profile's cache (only ever a scratch one). */
export function sql(profile, stmt) {
  if (resolve(profile) === resolve(LIVE_PROFILE)) throw new Error('refusing to write the live profile')
  return execFileSync('sqlite3', [join(profile, 'beacon.db'), stmt]).toString().trim()
}

function newestMtime(dir, exts) {
  let newest = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (exts.some((x) => e.name.endsWith(x))) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  walk(dir)
  return newest
}

async function answers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok
  } catch {
    return false
  }
}

function cdpSocket(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) for (const l of listeners) l(m)
  }
  const ready = new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  // Every call is bounded: a blocked main thread (a native modal, a Keychain prompt) otherwise
  // hangs the probe silently, which reads as nothing at all rather than as a failure.
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      const t = setTimeout(() => {
        pending.delete(n)
        rej(new Error(`CDP ${method} timed out — is a modal blocking the app's main thread?`))
      }, 20000)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      return { __error: d.exception?.description ?? d.text ?? 'exception' }
    }
    return r.result?.result?.value
  }
  return { ready, send, evaluate, on: (fn) => listeners.push(fn), close: () => ws.close() }
}

/**
 * Launch the built app from `repo` on `profile`. Resolves once the shell window's page target is
 * attached and the main-process inspector is connected.
 *
 * `page.evaluate(expr)` runs in the renderer; `mainEval(expr)` runs in main, where `electron` is
 * reachable as `__electron` (the inspector scope has no `require`; createRequire goes through
 * Electron's patched resolver).
 */
export async function launchApp({ repo = process.cwd(), profile, acceptDialogs = false, readySelector = 'nav[aria-label="Views"]' } = {}) {
  repo = resolve(repo)
  const built = join(repo, 'out/renderer/index.html')
  if (!existsSync(built)) throw new Error(`nothing built at ${built} — run npm run build first`)
  const src = newestMtime(join(repo, 'src'), ['.ts', '.tsx', '.css', '.html'])
  if (src > statSync(built).mtimeMs) throw new Error(`source is newer than ${built} — rebuild before probing`)

  const cdp = 9400 + Math.floor(Math.random() * 400) * 2
  const insp = cdp + 1
  if ((await answers(cdp)) || (await answers(insp))) throw new Error(`port ${cdp}/${insp} already serving CDP — a stale Electron is alive`)

  // This checkout's Electron binary (BEACON_ELECTRON names another), pointed at this checkout's app
  // directory (the argument is what decides whose `out/` runs; the page-URL assertion below proves
  // it). `--use-mock-keychain` keeps Chromium's own OSCrypt off the real Keychain too — see
  // scratchProfile for why that matters.
  const electron = process.env.BEACON_ELECTRON || electronBin(repo)
  if (!existsSync(electron)) throw new Error(`no Electron at ${electron} — run npm ci in ${repo}, or set BEACON_ELECTRON`)
  const child = spawn(electron, [repo, `--remote-debugging-port=${cdp}`, `--inspect=${insp}`, `--user-data-dir=${profile}`, '--use-mock-keychain'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  let exited = false
  child.on('exit', () => (exited = true))
  const kill = () => {
    if (!exited) try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  process.on('exit', kill)

  let target = null
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
    } catch { /* not up yet */ }
  }
  if (!target) {
    kill()
    throw new Error('no shell page target — main log tail:\n' + log.join('').slice(-1500))
  }
  // THE BUILD BEING DRIVEN IS THIS CHECKOUT'S. Anything else and every line below is about a stranger.
  const pagePath = decodeURIComponent(new URL(target.url).pathname)
  if (!pagePath.startsWith(join(repo, 'out/renderer'))) {
    kill()
    throw new Error(`attached page is not this checkout's build: ${pagePath}`)
  }

  const page = cdpSocket(target.webSocketDebuggerUrl)
  await page.ready
  const dialogs = []
  await page.send('Page.enable')
  page.on((m) => {
    if (m.method !== 'Page.javascriptDialogOpening') return
    dialogs.push(m.params.message)
    void page.send('Page.handleJavaScriptDialog', { accept: acceptDialogs })
  })

  const mainTargets = await (await fetch(`http://127.0.0.1:${insp}/json/list`, { signal: AbortSignal.timeout(5000) })).json()
  const main = cdpSocket(mainTargets[0].webSocketDebuggerUrl)
  await main.ready
  await main.evaluate(
    `globalThis.__electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron'); true`
  )

  // Wait for React to have mounted something real, not the loading placeholder. `readySelector` is
  // the main app's nav by default; a probe that expects first-run setup passes a selector that
  // matches either screen, so a launch that lands on the wrong one is reported by the probe rather
  // than spent waiting here.
  for (let i = 0; i < 60; i++) {
    const up = await page.evaluate(`!!document.querySelector(${JSON.stringify(readySelector)})`)
    if (up === true) break
    await sleep(250)
  }

  async function quit() {
    if (exited) return
    await main.evaluate('__electron.app.quit(); true').catch(() => undefined)
    for (let i = 0; i < 40 && !exited; i++) await sleep(150)
    kill()
    page.close()
    main.close()
  }

  return { page, mainEval: main.evaluate, dialogs, log, quit, pagePath }
}

/** Which React build the RUNNING renderer is — read from a live fiber, not guessed from a bundle:
 *  development fibers carry `_debugOwner`, production ones do not. StrictMode only double-invokes
 *  effects in development, so a claim about StrictMode needs this to say 'development'. */
export function reactMode(page) {
  return page.evaluate(`(() => {
    const root = document.getElementById('root')
    const k = root && Object.keys(root).find((x) => x.startsWith('__reactContainer$'))
    if (!k) return 'unknown'
    return '_debugOwner' in root[k] ? 'development' : 'production'
  })()`)
}

/** Which React build a checkout's renderer bundle carries (a static hint; prefer reactMode). */
export function reactBuild(repo = process.cwd()) {
  const dir = join(resolve(repo), 'out/renderer/assets')
  let prod = false
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const txt = readFileSync(join(dir, f), 'utf8')
    if (txt.includes('react-dom.development') || txt.includes('react.development')) return 'development'
    if (txt.includes('react.production') || txt.includes('react_production')) prod = true
  }
  return prod ? 'production' : 'unknown'
}
