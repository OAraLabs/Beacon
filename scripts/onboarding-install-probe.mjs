#!/usr/bin/env node
// onboarding-install-probe — path A's "Setting up Prometheus" (A-inst) IN THE REAL APP, against the REAL Prometheus.app from
// Prometheus #695: get it, check it is genuine, put it in Applications, start it, wait for it, and connect with the one-time secret.
//
// What it guards:
//   * the whole path with the real signed and notarized app: the manifest and the zip come from ONE release (the folder the manifest
//     resolved to), the bytes are checked, the app is verified before it is moved AND where it lands, the launcher is run once with
//     `--register`, Beacon waits for the daemon and pairs with the secret file, and the credential it keeps is the one the daemon issued;
//   * an app that is not genuine is never moved and never run: tampered bytes, an ad-hoc signature, a zip whose checksum is wrong;
//   * every card in the spec's table: the download failed, the safety check failed, the Login Items switch is off (and Beacon carries on
//     by itself once the person turns it on), something else is in the way (with Copy details), and Prometheus did not start;
//   * Back while it is still getting Prometheus asks "Stop setting up?" first, and Stop leaves nothing behind;
//   * a Prometheus that was already set up on this Mac (from the command line) is connected by `--pair` and the same-Mac route, and an
//     app already in Applications that passes the checks is used without downloading anything;
//   * a zip with an entry that would land outside its folder is refused before anything is unpacked;
//   * the secret goes only to a daemon that says who it is (GET /api/hello). A test app built before Prometheus had /api/hello (the
//     #695 build of 2026-10-08) cannot, so with one the scenarios that connect check Beacon's REFUSAL instead, and say so; with a
//     build from #695 at 66c3213 or later they run to the end;
//   * the scratch folder (a copy of the app per scenario, about 1.5 GB a run) is removed at the end.
//   * no banned word on any of it, in the RENDERED text.
//
// RUN (macOS; not part of verify — it launches the built app and the real Prometheus.app):
//   export BEACON_PROMETHEUS_TEST_ZIP=<a notarized Prometheus-<version>-arm64.zip built from Prometheus #695>
//   npm run build && npm run probe:onboarding-install
// Without BEACON_PROMETHEUS_TEST_ZIP it exits 3 and says it did NOT run (a skipped probe is not a passed one).
//
// SAFE BY CONSTRUCTION, and checked, not assumed:
//   * NEVER A REAL HOME. Beacon puts the app in <scratch>/home/Applications (BEACON_PROMETHEUS_HOME, honoured only by a non-release build)
//     and the daemon runs with HOME=<scratch>/home. The real ~/Applications, /Applications, ~/Library/Application Support/Prometheus,
//     ~/Library/Logs/Prometheus and ~/.prometheus are compared before and after every scenario.
//   * NEVER launchd. Beacon runs a stand-in launcher (BEACON_PROMETHEUS_LAUNCHER, non-release only) instead of the app's own: the real
//     `--register` registers a login item with THIS Mac's launchd, so it is never run here. The stand-in starts the placed app's real
//     `--run` (the daemon) the way launchd would, and passes `--pair` to the placed app's real launcher (it writes one file in HOME). The
//     real agent label is checked to be unknown to launchd before and after.
//   * Ephemeral ports only (the daemon's PROMETHEUS_WEB_API_PORT / _WS_PORT, Beacon's BEACON_DISCOVERY_PORT): never 8005 or 8010.
//   * The release server is a stub on an ephemeral loopback port (BEACON_PROMETHEUS_RELEASE, non-release only): nothing goes to GitHub.
//   * shell.openExternal and the page's clipboard are replaced before anything is clicked; a fresh profile and --use-mock-keychain per launch.
//   * Every daemon this starts is killed at the end, and the run fails if one is still alive.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'
import { bannedHits, clickText, pageText, press, startChecks, waitFor } from './lib/probe-kit.mjs'

const ZIP = process.env.BEACON_PROMETHEUS_TEST_ZIP
if (!ZIP || !existsSync(ZIP)) {
  console.log('[probe] onboarding-install: SKIPPED — set BEACON_PROMETHEUS_TEST_ZIP to a notarized Prometheus.app zip from Prometheus #695. It did NOT run.')
  process.exit(3)
}
if (process.platform !== 'darwin') {
  console.log('[probe] onboarding-install: SKIPPED — macOS only. It did NOT run.')
  process.exit(3)
}

const check = startChecks('onboarding-install', 79)
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words
const LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
const GB = 1024 ** 3
const AGENT = 'com.oaralabs.prometheus.daemon'
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k.startsWith('PROMETHEUS_')) delete process.env[k]

const root = mkdtempSync(join(tmpdir(), 'beacon-install-probe-'))
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
/** A tool's exit code and EVERYTHING it wrote: codesign -d, for one, answers on stderr. */
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status ?? -1, out: String(r.stdout ?? '') + String(r.stderr ?? '') }
}
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
async function ports() {
  for (;;) {
    const api = await freePort()
    const ws = await freePort()
    if (api !== ws && ![8005, 8006, 8010, 8011].includes(api) && ![8005, 8006, 8010, 8011].includes(ws)) return { api, ws }
  }
}

// ── the real machine, before ──────────────────────────────────────────────────────────────────────────────────────────────────────
const REAL = [join(homedir(), 'Applications/Prometheus.app'), '/Applications/Prometheus.app', join(homedir(), 'Library/Application Support/Prometheus'), join(homedir(), 'Library/Logs/Prometheus'), join(homedir(), '.prometheus')]
const realState = () =>
  REAL.map((p) => {
    try {
      const s = lstatSync(p)
      return `${p} ${s.isDirectory() ? 'dir' : 'file'} ${Math.round(s.mtimeMs)}`
    } catch {
      return `${p} absent`
    }
  }).join('\n')
const launchdKnows = () => run('/bin/launchctl', ['print', `gui/${process.getuid()}/${AGENT}`]).code === 0
const REAL_BEFORE = realState()
const LAUNCHD_BEFORE = launchdKnows()
check(!LAUNCHD_BEFORE, 'tripwire: launchd does not know the Prometheus agent before the run (so a registration here would show)')
function tripwires(label) {
  check(realState() === REAL_BEFORE && launchdKnows() === LAUNCHD_BEFORE, `${label}: the real ~/Applications, /Applications, ~/Library and ~/.prometheus are as they were, and launchd still does not know the agent`)
}

// ── the apps: the real one, and two that are not genuine ─────────────────────────────────────────────────────────────────────────
const src = join(root, 'src')
mkdirSync(src)
run('/usr/bin/ditto', ['-x', '-k', ZIP, src])
const APP = join(src, 'Prometheus.app')
const VERSION = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(APP, 'Contents/Info.plist')]).out.trim()
const ASSET = `Prometheus-${VERSION}-arm64.zip`
const cdhash = (app) => (run('/usr/bin/codesign', ['-d', '--verbose=4', app]).out.match(/^CDHash=(\w+)/m) ?? [])[1] ?? null
const REAL_CDHASH = cdhash(APP)
check(REAL_CDHASH !== null && run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]).code === 0, 'fixture: the test zip holds a validly signed Prometheus.app', `version ${VERSION}, CDHash ${REAL_CDHASH}`)
function variant(name, mutate) {
  const dir = join(root, `variant-${name}`)
  mkdirSync(dir)
  cpSync(APP, join(dir, 'Prometheus.app'), { recursive: true, verbatimSymlinks: true })
  mutate(join(dir, 'Prometheus.app'))
  const zip = join(root, `${name}.zip`)
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(dir, 'Prometheus.app'), zip])
  return zip
}
const pyInit = (app) => {
  const lib = join(app, 'Contents/Resources/python/lib')
  const py = readdirSync(lib).find((d) => d.startsWith('python3'))
  return join(lib, py, 'site-packages/prometheus/__init__.py')
}
const TAMPERED = variant('tampered', (app) => appendFileSync(pyInit(app), '\n# one byte too many\n'))
const ADHOC = variant('adhoc', (app) => run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]))
check(run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'variant-tampered/Prometheus.app')]).code !== 0, 'fixture: the tampered copy fails codesign (so a card for it is earned, not a coincidence)')
check(run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'variant-adhoc/Prometheus.app')]).code === 0 && !run('/usr/bin/codesign', ['-d', '--verbose=2', join(root, 'variant-adhoc/Prometheus.app')]).out.includes('TeamIdentifier=53JM8W47RL'), 'fixture: the ad-hoc copy is validly signed, by nobody (only the team and notarization checks can refuse it)')
/** A minimal zip (stored entries, unix modes), for a zip no tool would make. */
function zipOf(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data ?? '')
    const crc = crc32(data) >>> 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const manifestFor = (zip, over = {}) => {
  const bytes = readFileSync(zip)
  return { version: VERSION, asset: ASSET, alias: 'Prometheus-mac-arm64.zip', sha256: sha256(bytes), size: bytes.length, team_id: '53JM8W47RL', bundle_id: 'com.oaralabs.prometheus', min_macos: '13.0', arch: 'arm64', ...over }
}

// ── the release server stub ──────────────────────────────────────────────────────────────────────────────────────────────────────
// /rel/prometheus-mac.json answers 302 to /rel/download/v<version>/prometheus-mac.json, the way github.com's releases/latest/download does;
// the zip must then be asked for in THAT folder, so the manifest and the bytes are one release's.
const rel = { manifest: null, zip: null, zipStatus: 200, stall: false, chunks: 16, chunkDelayMs: 140, requests: [], closed: 0 }
const tagDir = () => `/rel/download/v${VERSION}`
const relServer = http.createServer((req, res) => {
  rel.requests.push({ method: req.method, path: req.url, auth: 'authorization' in req.headers, cookie: 'cookie' in req.headers })
  if (req.url === '/rel/prometheus-mac.json') {
    res.writeHead(302, { location: `${tagDir()}/prometheus-mac.json` })
    return res.end()
  }
  if (req.url === `${tagDir()}/prometheus-mac.json`) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(rel.manifest))
  }
  if (req.url === `${tagDir()}/${ASSET}`) {
    if (rel.zipStatus !== 200) {
      res.writeHead(rel.zipStatus)
      return res.end('no')
    }
    const bytes = readFileSync(rel.zip)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length })
    res.on('close', () => rel.closed++)
    const step = Math.ceil(bytes.length / rel.chunks)
    let at = 0
    const next = () => {
      if (res.destroyed) return
      if (rel.stall && at >= step) return // the first chunk, then nothing: a download that hangs
      res.write(bytes.subarray(at, at + step))
      at += step
      if (at >= bytes.length) return res.end()
      setTimeout(next, rel.chunkDelayMs)
    }
    return next()
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => relServer.listen(0, '127.0.0.1', r))
const REL_BASE = `http://127.0.0.1:${relServer.address().port}/rel`

// ── the stand-in launcher ────────────────────────────────────────────────────────────────────────────────────────────────────────
const LDIR = join(root, 'launcher')
mkdirSync(LDIR)
const STANDIN = join(LDIR, 'stand-in.cjs') // CommonJS: it uses require
const CALLS = join(LDIR, 'calls.jsonl')
const PIDS = join(LDIR, 'pids')
writeFileSync(
  STANDIN,
  `#!/usr/bin/env node
// The probe's stand-in for Prometheus.app/Contents/MacOS/Prometheus. It never registers anything with launchd.
const { appendFileSync, readFileSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const cfg = JSON.parse(readFileSync(${JSON.stringify(join(LDIR, 'mode.json'))}, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, mode: cfg.mode }) + '\\n')
const env = { HOME: cfg.home, PATH: '/usr/bin:/bin', TMPDIR: cfg.home + '/tmp', PROMETHEUS_WEB_API_PORT: String(cfg.api), PROMETHEUS_WEB_WS_PORT: String(cfg.ws) }
const real = cfg.home + '/Applications/Prometheus.app/Contents/MacOS/Prometheus'
const say = (code, state, detail = '') => { process.stdout.write(JSON.stringify({ ok: code === 0, state, detail, agent: '${AGENT}', app_version: 'stand-in' }) + '\\n'); process.exit(code) }
if (args[0] === '--pair') {
  const r = spawnSync(real, ['--pair'], { env, encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  process.exit(r.status === null ? 13 : r.status)
}
if (args[0] !== '--register') say(2, 'usage', 'the stand-in knows --register and --pair')
if (cfg.mode === 'approval') say(10, 'requires_approval', 'Allow Prometheus under System Settings > General > Login Items.')
if (cfg.mode === 'busy') say(12, 'port_busy', 'Something that is not Prometheus holds 127.0.0.1:8005.')
if (cfg.mode === 'silent') say(0, 'registered')
const child = spawn(real, ['--run'], { env, stdio: 'ignore', detached: true })
appendFileSync(${JSON.stringify(PIDS)}, child.pid + '\\n')
child.unref()
say(0, 'registered')
`
)
chmodSync(STANDIN, 0o755)
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : [])
const daemons = []
const pidsNow = () => (existsSync(PIDS) ? readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []).concat(daemons)
function killDaemons() {
  for (const pid of pidsNow()) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* gone */
      }
    }
  }
}
process.on('exit', killDaemons)
const alive = () => pidsNow().filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
/** The person turning Prometheus on in Login Items, played by the probe: launchd would now start --run. */
function startDaemonAs(home, p) {
  const launcher = join(home, 'Applications/Prometheus.app/Contents/MacOS/Prometheus')
  if (!existsSync(launcher)) return false // nothing was put in Applications: there is nothing to turn on
  const child = spawn(launcher, ['--run'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), PROMETHEUS_WEB_API_PORT: String(p.api), PROMETHEUS_WEB_WS_PORT: String(p.ws) },
    stdio: 'ignore',
    detached: true
  })
  child.on('error', () => undefined)
  child.unref()
  daemons.push(child.pid)
  return true
}

// ── one scenario's world ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let world = null
/** A scenario's world (a scratch home, ports, the stand-in's mode, Beacon's environment) without launching Beacon. */
async function prepare(name, mode, extra = {}) {
  const dir = join(root, name)
  const home = join(dir, 'home')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  mkdirSync(join(dir, 'beacon-tmp'))
  const p = await ports()
  writeFileSync(join(LDIR, 'mode.json'), JSON.stringify({ mode, home, api: p.api, ws: p.ws }))
  rmSync(CALLS, { force: true })
  rel.requests = []
  rel.closed = 0
  world = { dir, home, ...p }
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY') || k.startsWith('BEACON_PROMETHEUS') || k === 'BEACON_MAC_CHECK') delete process.env[k]
  Object.assign(process.env, {
    BEACON_ONBOARDING: 'v4',
    BEACON_DISCOVERY_SOURCES: 'loopback',
    BEACON_DISCOVERY_PORT: String(p.api),
    BEACON_DISCOVERY_WINDOW_MS: '1500',
    BEACON_MAC_CHECK: JSON.stringify({ platform: 'darwin', arch: 'arm64', macos: '15.6.1', freeBytes: 50 * GB, memoryBytes: 16 * GB }),
    BEACON_PROMETHEUS_RELEASE: REL_BASE,
    BEACON_PROMETHEUS_HOME: home,
    BEACON_PROMETHEUS_LAUNCHER: STANDIN,
    TMPDIR: join(dir, 'beacon-tmp'),
    ...extra
  })
}
/** Beacon, with shell.openExternal and the page's clipboard replaced before anything is clicked. */
async function launch() {
  const app = await launchApp({ profile: mkdtempSync(join(root, 'profile-')), readySelector: '[data-screen], .wiz-card, nav[aria-label="Views"]' })
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  await app.page.evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t) => { window.__copied.push(String(t)) } }); return true })()`)
  return app
}
async function scenario(name, mode, extra = {}) {
  await prepare(name, mode, extra)
  return launch()
}
const screenId = (app) => app.page.evaluate(`document.querySelector('[data-screen]')?.dataset.screen ?? 'none'`)
const onScreen = (app, id, ms = 8000) => waitFor(() => screenId(app), (v) => v === id, ms)
const h1 = async (app) => norm(await pageText(app, '[data-screen] h1'))
const screenText = async (app) => norm(await pageText(app, '[data-screen]'))
const failure = (app) => app.page.evaluate(`document.querySelector('[data-failure]')?.dataset.failure ?? null`)
const waitFailure = (app, ms = 30000) => waitFor(() => failure(app), (v) => v !== null, ms)
const hasButton = (app, text) => app.page.evaluate(`[...document.querySelectorAll('button, a[href]')].some((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && b.offsetParent !== null)`)
const helpLink = (app) => app.page.evaluate(`(() => { const a = [...document.querySelectorAll('[data-screen] a[href]')].find((x) => x.innerText.trim().startsWith('Get help')); return a ? { href: a.href, target: a.target } : null })()`)
const copied = (app) => app.page.evaluate(`window.__copied`)
/** What "Copy details" copies on the card that is showing. */
async function detailsOf(app) {
  await app.page.evaluate(`window.__copied = []`)
  await clickText(app, 'Copy details')
  return (await waitFor(() => copied(app), (c) => c.length > 0, 3000)).join('')
}
const opened = (app) => app.mainEval(`globalThis.__opened`)
async function noJargon(app, label, title) {
  const text = await pageText(app, '[data-screen]')
  const scan = norm(await app.page.evaluate(`(() => { const c = document.querySelector('[data-screen]')?.cloneNode(true); if (!c) return ''; c.querySelectorAll('[data-details]').forEach((n) => n.remove()); return c.innerText })()`))
  const hits = bannedHits(scan, WORDS)
  const t = await h1(app)
  check(norm(text).length > 30 && t.startsWith(title) && hits.length === 0, `${label} shows none of the banned words`, hits.length ? `FOUND ${JSON.stringify(hits)}` : t.startsWith(title) ? `${scan.length} characters checked` : `title is "${t}", not "${title}"`)
}
async function toSetUp(app) {
  await clickText(app, 'Get started')
  await onScreen(app, 'W2')
  await clickText(app, 'No, set it up on this Mac')
  await clickText(app, 'Continue')
  await onScreen(app, 'A-confirm', 8000)
  return clickText(app, 'Set up Prometheus')
}
const placed = () => join(world.home, 'Applications/Prometheus.app')
const secretFile = () => join(world.home, 'Library/Application Support/Prometheus/pairing/pair.secret')
const leftovers = () => readdirSync(join(world.dir, 'beacon-tmp')).filter((n) => n.startsWith('beacon-prometheus'))
/** The token Beacon kept, hashed inside main (it never leaves main in the clear), and the daemon's own. */
const keptTokenHash = (app) =>
  app.mainEval(`(() => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto')
    const f = path.join(__electron.app.getPath('userData'), 'api-credential.bin')
    if (!fs.existsSync(f)) return null
    return crypto.createHash('sha256').update(__electron.safeStorage.decryptString(fs.readFileSync(f))).digest('hex')
  })()`)
const daemonTokenHash = () => {
  const f = join(world.home, '.config/prometheus/env')
  if (!existsSync(f)) return null
  const m = readFileSync(f, 'utf8').match(/^PROMETHEUS_API_TOKEN=(.+)$/m)
  return m ? sha256(m[1].trim().replace(/^["']|["']$/g, '')) : null
}
async function finish(app) {
  await app.quit()
  killDaemons()
  await waitFor(async () => alive().length, (n) => n === 0, 8000)
}
/** A configured Prometheus in `home`, the way a command-line set-up leaves one: the real app's setup mode, paired, configured with a
 *  cloud AI and a placeholder key (no network probe), completed, then stopped. */
async function configuredHome(home, p) {
  startDaemonAs(home, p)
  const base = `http://127.0.0.1:${p.api}`
  await waitFor(async () => (await fetch(`${base}/api/setup/status`).catch(() => null))?.status ?? 0, (s) => s === 200, 20000)
  const secret = await waitFor(() => (existsSync(join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')) ? readFileSync(join(home, 'Library/Application Support/Prometheus/pairing/pair.secret'), 'utf8').trim() : ''), (s) => s.length > 0, 5000)
  const pair = await (await fetch(`${base}/api/setup/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: secret }) })).json()
  const auth = { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' }
  const conf = await fetch(`${base}/api/setup/configure`, { method: 'POST', headers: auth, body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-ant-probe-placeholder-not-a-key' }) })
  const done = await fetch(`${base}/api/setup/complete`, { method: 'POST', headers: auth, body: '{}' })
  const up = await waitFor(async () => (await fetch(`${base}/api/status`, { headers: auth }).catch(() => null))?.status ?? 0, (s) => s === 200, 30000)
  killDaemons()
  await waitFor(async () => alive().length, (n) => n === 0, 8000)
  daemons.length = 0
  return conf.status === 200 && done.status === 200 && up === 200
}

/** Does the test app's daemon answer GET /api/hello (Prometheus #697; in #695 from 66c3213)? Asked of the app itself, in a scratch home. */
async function appSaysHello() {
  const home = join(root, 'hello-check/home')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const p = await ports()
  const child = spawn(join(APP, 'Contents/MacOS/Prometheus'), ['--run'], { env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), PROMETHEUS_WEB_API_PORT: String(p.api), PROMETHEUS_WEB_WS_PORT: String(p.ws) }, stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${p.api}/api/setup/status`).catch(() => null))?.status ?? 0, (st) => st === 200, 20000)
    return (await fetch(`http://127.0.0.1:${p.api}/api/hello`).catch(() => null))?.status === 200
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
    await waitFor(async () => { try { process.kill(child.pid, 0); return true } catch { return false } }, (v) => !v, 8000)
  }
}
const HELLO = await appSaysHello()
console.log(`[probe] the test app's daemon ${HELLO ? 'answers' : 'does NOT answer'} GET /api/hello: the scenarios that connect ${HELLO ? 'run to the end' : "check Beacon's refusal to send it the secret"}`)

let app
try {
  // ── I1: the whole path, with the real app ────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I1: get it, check it, put it in Applications, start it, connect ===')
  rel.manifest = manifestFor(ZIP)
  rel.zip = ZIP
  rel.stall = false
  rel.zipStatus = 200
  app = await scenario('i1', 'real')
  check((await toSetUp(app)) === 'clicked' && (await onScreen(app, 'A-inst')) === 'A-inst', 'I1 confirming goes on to the set-up step (A-inst)', await screenId(app))
  check((await h1(app)) === 'Setting up Prometheus' && (await screenText(app)).includes('This takes about a minute. You can keep using your Mac.'), 'I1 …titled "Setting up Prometheus", saying it takes about a minute', await h1(app))
  const progress = await waitFor(() => screenText(app), (t) => /Getting Prometheus… [\d.]+ MB of [\d.]+ MB/.test(t), 8000)
  check(/Getting Prometheus… [\d.]+ MB of [\d.]+ MB/.test(progress), 'I1 while it downloads, it says how much of how much', progress.match(/Getting Prometheus…[^A-Z]*/)?.[0] ?? progress.slice(0, 120))
  await noJargon(app, 'I1 "Setting up Prometheus"', 'Setting up Prometheus')
  check(['Getting Prometheus', "Checking it's genuine", 'Putting it in your Applications folder', 'Starting it'].every((r) => progress.includes(r)), 'I1 every step is named up front: getting it, checking it is genuine, putting it in Applications, starting it')
  check(progress.includes('Login Items'), 'I1 the fine print says macOS will note Prometheus in Login Items, and that this is expected')
  const a2 = HELLO ? await onScreen(app, 'A2', 90000) : await waitFor(() => failure(app), (v) => v === 'refused', 90000)
  if (HELLO) check(a2 === 'A2', 'I1 when Prometheus answers and the connection is made, it goes on to how the assistant should think (A2)', a2)
  else check(a2 === 'refused' && (await h1(app)) === "Beacon couldn't connect to Prometheus" && /\/api\/hello/.test(await detailsOf(app)), 'I1 a daemon that cannot say who it is (no /api/hello) is sent no secret: "Beacon couldn\'t connect to Prometheus", the details naming /api/hello', a2)
  const relPaths = rel.requests.map((q) => `${q.method} ${q.path}`)
  check(JSON.stringify(relPaths) === JSON.stringify(['GET /rel/prometheus-mac.json', `GET ${tagDir()}/prometheus-mac.json`, `GET ${tagDir()}/${ASSET}`]), 'I1 the manifest and the zip came from ONE release: the zip was asked for in the folder the manifest resolved to', JSON.stringify(relPaths))
  check(rel.requests.length === 3 && rel.requests.every((q) => !q.auth && !q.cookie), 'I1 …with no credential and no cookie')
  check(existsSync(placed()) && lstatSync(placed()).isDirectory() && !lstatSync(placed()).isSymbolicLink() && cdhash(placed()) === REAL_CDHASH && run('/usr/bin/codesign', ['--verify', '--deep', '--strict', placed()]).code === 0, 'I1 the app is in (scratch) ~/Applications, a real folder, the very bytes that were signed', cdhash(placed()))
  check(JSON.stringify(calls()) === JSON.stringify([['--register']]), 'I1 the launcher was run once, with --register (no other mode)', JSON.stringify(calls()))
  if (HELLO) check(a2 === 'A2' && existsSync(join(world.home, '.config/prometheus/env')) && !existsSync(secretFile()), 'I1 the one-time secret was used: the daemon paired and deleted it')
  else check(a2 === 'refused' && existsSync(secretFile()) && !existsSync(join(world.home, '.config/prometheus/env')), 'I1 …the one-time secret is still there, unused, and the daemon was never paired')
  const kept = await keptTokenHash(app)
  if (HELLO) check(kept !== null && kept === daemonTokenHash(), 'I1 the credential Beacon kept is the one the daemon issued (compared as SHA-256, inside main)', kept === null ? 'nothing kept' : kept === daemonTokenHash() ? 'match' : 'DIFFERENT')
  else check(a2 === 'refused' && kept === null, 'I1 …and Beacon kept no credential', kept === null ? 'nothing kept' : 'SOMETHING KEPT')
  check(rel.requests.some((q) => q.path.endsWith('.zip')) && leftovers().length === 0, 'I1 it was downloaded, and nothing is left in Beacon\'s temporary folder', JSON.stringify(leftovers()))
  // Only with a daemon to ask about: lsof given no pid lists every process on the Mac.
  const ours = alive()
  const listeners = ours.length === 0 ? [] : run('/usr/sbin/lsof', ['-nP', '-a', '-p', ours.join(','), '-iTCP', '-sTCP:LISTEN']).out.split('\n').slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/)[8])
  check(ours.length > 0 && listeners.length > 0 && listeners.every((l) => l.startsWith('127.0.0.1:')), 'guard: the daemon this probe started listens on this Mac only', ours.length === 0 ? 'no daemon of ours is running' : JSON.stringify(listeners))
  if (HELLO) check((await clickText(app, 'Use the old setup')) === 'clicked' && (await waitFor(() => pageText(app, 'body'), (t) => t.includes('127.0.0.1'), 8000)).includes('127.0.0.1'), 'I1 the old setup picks up where this left off, at the saved address on this Mac (so the connection was kept)', norm(await pageText(app, 'body')).slice(0, 160))
  else await noJargon(app, "I1 the couldn't-connect card", "Beacon couldn't connect to Prometheus")
  await finish(app)
  tripwires('I1')

  // ── I2: tampered bytes ───────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I2: tampered bytes ===')
  rel.manifest = manifestFor(TAMPERED) // the checksum is right: only the signature can catch it
  rel.zip = TAMPERED
  app = await scenario('i2', 'real')
  await toSetUp(app)
  check((await waitFailure(app)) === 'unsafe' && (await h1(app)) === "Prometheus didn't pass our safety check", 'I2 a tampered app is "Prometheus didn\'t pass our safety check"', await h1(app))
  check((await screenText(app)).includes("We didn't open it. This can happen on a bad connection."), 'I2 …saying it was not opened')
  await noJargon(app, 'I2 the safety card', "Prometheus didn't pass our safety check")
  const help = await helpLink(app)
  check((await hasButton(app, 'Try again')) && help?.target === '_blank' && /^https:\/\//.test(help?.href ?? ''), 'I2 Try again, and Get help (a link that opens in the browser)', JSON.stringify(help))
  const i2card = (await failure(app)) === 'unsafe' && rel.requests.some((q) => q.path.endsWith('.zip'))
  check(i2card && !existsSync(placed()) && calls().length === 0, 'I2 it was downloaded, and then nothing was put in Applications and nothing was run')
  check(i2card && leftovers().length === 0, 'I2 what was downloaded is gone from the temporary folder', JSON.stringify(leftovers()))
  check((await clickText(app, 'Copy details')) === 'clicked' && /codesign/i.test((await waitFor(() => copied(app), (c) => c.length > 0, 3000)).join('')), 'I2 Copy details copies what failed, for someone helping', (await copied(app)).join('').slice(0, 160))
  const firstRound = rel.requests.length
  check((await clickText(app, 'Try again')) === 'clicked' && (await waitFor(async () => rel.requests.length > firstRound && (await failure(app)) === 'unsafe', (v) => v, 30000)), 'I2 Try again starts over (a second download), and the same bytes fail the same way')
  await finish(app)
  tripwires('I2')

  // ── I3: an ad-hoc signature ──────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I3: signed by nobody ===')
  rel.manifest = manifestFor(ADHOC)
  rel.zip = ADHOC
  app = await scenario('i3', 'real')
  await toSetUp(app)
  check((await waitFailure(app)) === 'unsafe', 'I3 an app signed by nobody (ad-hoc) does not pass the safety check', await failure(app))
  check((await failure(app)) === 'unsafe' && rel.requests.some((q) => q.path.endsWith('.zip')) && !existsSync(placed()) && calls().length === 0 && leftovers().length === 0, 'I3 …it was downloaded, then nothing was moved, nothing was run, nothing is left behind')
  await clickText(app, 'Copy details')
  check(/53JM8W47RL|team|requirement/i.test((await waitFor(() => copied(app), (c) => c.length > 0, 3000)).join('')), 'I3 the details say it was not signed by OAra Labs\' team', (await copied(app)).join('').slice(0, 200))
  await finish(app)
  tripwires('I3')

  // ── I4: the checksum is wrong ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I4: the checksum is wrong ===')
  rel.manifest = manifestFor(ZIP, { sha256: '0'.repeat(64) })
  rel.zip = ZIP
  app = await scenario('i4', 'real')
  await toSetUp(app)
  check((await waitFailure(app)) === 'unsafe', 'I4 bytes that do not match the manifest\'s checksum do not pass the safety check', await failure(app))
  await clickText(app, 'Copy details')
  check(/sha-?256/i.test((await waitFor(() => copied(app), (c) => c.length > 0, 3000)).join('')) && (await failure(app)) === 'unsafe' && rel.requests.some((q) => q.path.endsWith('.zip')) && !existsSync(placed()) && calls().length === 0 && leftovers().length === 0, 'I4 …the details name the checksum, and nothing was unpacked, moved or run', (await copied(app)).join('').slice(0, 160))
  await finish(app)
  tripwires('I4')

  // ── I5: the download fails; then the Login Items switch is off; then the person turns it on ──────────────────────────────────
  console.log('\n[probe] === I5: the download fails, then Login Items, then it carries on by itself ===')
  rel.manifest = manifestFor(ZIP)
  rel.zip = ZIP
  rel.zipStatus = 500
  app = await scenario('i5', 'approval')
  await toSetUp(app)
  check((await waitFailure(app)) === 'download' && (await h1(app)) === "We couldn't get Prometheus" && (await screenText(app)).includes('Check your internet connection, then try again.'), 'I5 a failed download is "We couldn\'t get Prometheus", asking to check the connection', await h1(app))
  await noJargon(app, 'I5 the download card', "We couldn't get Prometheus")
  check((await failure(app)) === 'download' && (await hasButton(app, 'Try again')) && !existsSync(placed()), 'I5 …with Try again, and nothing in Applications')
  rel.zipStatus = 200
  await clickText(app, 'Try again')
  // The card that is showing until the new run replaces it is the download card: wait for THE Login Items card, not for any card.
  check((await waitFor(() => failure(app), (v) => v === 'approval', 60000)) === 'approval' && (await h1(app)) === "Prometheus can't start at login yet", 'I5 Try again downloads it; a launcher that says "requires approval" is "Prometheus can\'t start at login yet"', await h1(app))
  check((await screenText(app)).includes('macOS is asking you to allow it. Open Login Items and turn Prometheus on.') && (await hasButton(app, 'Open Login Items')) && (await hasButton(app, 'Not now')), 'I5 …saying what to do, with Open Login Items and Not now')
  await noJargon(app, 'I5 the Login Items card', "Prometheus can't start at login yet")
  check((await clickText(app, 'Open Login Items')) === 'clicked' && JSON.stringify(await waitFor(() => opened(app), (v) => v.length > 0, 3000)) === JSON.stringify([LOGIN_ITEMS_URL]), 'I5 Open Login Items opens the Login Items pane of System Settings, and nothing else', JSON.stringify(await opened(app)))
  startDaemonAs(world.home, world) // the person turned it on: launchd starts the daemon
  if (HELLO) {
    check((await onScreen(app, 'A2', 60000)) === 'A2', 'I5 once Prometheus starts, Beacon notices by itself and connects (no button to press)', await screenId(app))
    check(daemonTokenHash() !== null && !existsSync(secretFile()) && (await keptTokenHash(app)) === daemonTokenHash() && JSON.stringify(calls()) === JSON.stringify([['--register']]), 'I5 …with the secret used, the daemon\'s credential kept, and the launcher run once')
  } else {
    check((await waitFor(() => failure(app), (v) => v === 'refused', 60000)) === 'refused', 'I5 once Prometheus starts, Beacon notices by itself, asks who it is, and sends no secret to a daemon that cannot say', await failure(app))
    check(existsSync(secretFile()) && (await keptTokenHash(app)) === null && JSON.stringify(calls()) === JSON.stringify([['--register']]), 'I5 …the secret unused, nothing kept, and the launcher run once')
  }
  await finish(app)
  tripwires('I5')

  // ── I6: something else is in the way ─────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I6: something else is in the way ===')
  app = await scenario('i6', 'busy')
  await toSetUp(app)
  check((await waitFailure(app, 60000)) === 'in-the-way' && (await h1(app)) === 'Something else is in the way', 'I6 a launcher that says the place is taken is "Something else is in the way"', await h1(app))
  check((await screenText(app)).includes('Another app on this Mac is using the spot Prometheus needs. Copy the details for whoever helps you.') && (await hasButton(app, 'Try again')) && (await helpLink(app)) !== null, 'I6 …saying so, with Try again and Get help')
  await noJargon(app, 'I6 the in-the-way card', 'Something else is in the way')
  await clickText(app, 'Copy details')
  check(/port_busy/.test((await waitFor(() => copied(app), (c) => c.length > 0, 3000)).join('')), 'I6 Copy details carries what the launcher said (port_busy), for whoever helps', (await copied(app)).join('').slice(0, 200))
  await clickText(app, 'Try again')
  check((await waitFor(() => calls().length, (n) => n === 2, 30000)) === 2 && (await waitFailure(app)) === 'in-the-way', 'I6 Try again runs the launcher again (the app is already there: nothing is downloaded twice)', JSON.stringify(calls()))
  check(rel.requests.filter((q) => q.path.endsWith('.zip')).length === 1, 'I6 …one download in all', JSON.stringify(rel.requests.map((q) => q.path)))
  await finish(app)
  tripwires('I6')

  // ── I7: it does not start ────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I7: registered, but nothing answers ===')
  app = await scenario('i7', 'silent', { BEACON_PROMETHEUS_START_MS: '4000' })
  await toSetUp(app)
  check((await waitFailure(app, 60000)) === 'not-started' && (await h1(app)) === "Prometheus didn't start", 'I7 nothing answering in time is "Prometheus didn\'t start"', await h1(app))
  check((await screenText(app)).includes("Try once more. If it still doesn't start, we'll help.") && (await hasButton(app, 'Try again')) && (await helpLink(app)) !== null, 'I7 …with Try again and Get help')
  await noJargon(app, 'I7 the did-not-start card', "Prometheus didn't start")
  await finish(app)
  tripwires('I7')

  // ── I8: Back while it is still downloading ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I8: Back while it is still getting Prometheus ===')
  rel.stall = true
  app = await scenario('i8', 'real')
  await toSetUp(app)
  await waitFor(() => screenText(app), (t) => /MB of/.test(t), 8000)
  check((await clickText(app, 'Back')) === 'clicked' && (await waitFor(() => screenText(app), (t) => t.includes('Stop setting up?'), 3000)).includes('Stop setting up?'), 'I8 Back while it is still getting Prometheus asks "Stop setting up?" first')
  check((await hasButton(app, 'Keep going')) && (await hasButton(app, 'Stop setting up')), 'I8 …with Keep going and Stop setting up')
  await noJargon(app, 'I8 the question', 'Setting up Prometheus')
  check((await clickText(app, 'Keep going')) === 'clicked' && (await screenId(app)) === 'A-inst' && !(await screenText(app)).includes('Stop setting up?'), 'I8 Keep going stays, and the question goes away')
  await press(app, 'Escape')
  check((await waitFor(() => screenText(app), (t) => t.includes('Stop setting up?'), 3000)).includes('Stop setting up?') && (await screenId(app)) === 'A-inst', 'I8 Esc asks the same question (it does not leave without asking)')
  check((await clickText(app, 'Stop setting up')) === 'clicked' && (await onScreen(app, 'W2')) === 'W2', 'I8 Stop setting up goes back to the question', await screenId(app))
  check(rel.requests.some((q) => q.path.endsWith('.zip')) && (await waitFor(() => rel.closed, (n) => n >= 1, 5000)) >= 1 && (await waitFor(() => leftovers().length, (n) => n === 0, 5000)) === 0 && !existsSync(placed()) && calls().length === 0, 'I8 …the download was stopped, what came is deleted, and nothing was moved or run', `closed ${rel.closed}, left ${JSON.stringify(leftovers())}`)
  rel.stall = false
  await finish(app)
  tripwires('I8')

  // ── I10: a zip whose entries would land outside its folder ─────────────────────────────────────────────────────────────────
  console.log('\n[probe] === I10: a zip with a ".." entry ===')
  const SLIP = join(root, 'slip.zip')
  writeFileSync(SLIP, zipOf([{ name: 'Prometheus.app/' }, { name: 'Prometheus.app/Contents/x', data: 'x' }, { name: 'Prometheus.app/../../SLIPPED.txt', data: 'escaped' }]))
  rel.manifest = manifestFor(SLIP) // the checksum is right: only the table of contents can refuse it
  rel.zip = SLIP
  app = await scenario('i10', 'real')
  await toSetUp(app)
  check((await waitFailure(app)) === 'unsafe' && /climbs out/.test(await detailsOf(app)), 'I10 a zip with a ".." entry does not pass the safety check, and the details say why', await failure(app))
  const slipped = run('/usr/bin/find', [root, '-name', 'SLIPPED.txt']).out.trim()
  check(rel.requests.some((q) => q.path.endsWith('.zip')) && !existsSync(placed()) && calls().length === 0 && leftovers().length === 0 && slipped === '', 'I10 …it was downloaded, then nothing was unpacked, moved or run, and the entry landed nowhere', slipped || 'nowhere')
  await finish(app)
  tripwires('I10')

  // ── I9: Prometheus was already set up on this Mac, and the app is already in Applications ────────────────────────────────────
  console.log('\n[probe] === I9: already set up, already in Applications ===')
  rel.manifest = manifestFor(ZIP)
  rel.zip = ZIP
  await prepare('i9', 'real') // the world first: a configured Prometheus and the app in place, before Beacon looks
  mkdirSync(join(world.home, 'Applications'), { recursive: true })
  cpSync(APP, placed(), { recursive: true, verbatimSymlinks: true })
  check(await configuredHome(world.home, world), 'I9 fixture: a Prometheus set up from the command line (configured, then stopped)')
  rmSync(CALLS, { force: true })
  rel.requests = []
  app = await launch()
  await toSetUp(app)
  const f1 = HELLO ? await onScreen(app, 'F1', 90000) : await waitFor(() => failure(app), (v) => v === 'refused', 90000)
  const end9 = HELLO ? 'F1' : 'refused'
  check(f1 === end9, HELLO ? 'I9 a Prometheus that is already set up is connected and goes straight to "Say hello" (nothing left to set up)' : 'I9 a set-up Prometheus that cannot say who it is (no /api/hello) is sent no secret', f1)
  check(f1 === end9 && rel.requests.every((q) => !q.path.endsWith('.zip')), 'I9 an app already in Applications that passes every check is used: nothing was downloaded', JSON.stringify(rel.requests.map((q) => q.path)))
  check(JSON.stringify(calls()) === JSON.stringify(HELLO ? [['--register'], ['--pair']] : [['--register']]), HELLO ? 'I9 the launcher was run with --register, then --pair (the way to a new secret for a daemon that is already set up)' : 'I9 the launcher was run with --register only: no secret is even written for a daemon that cannot say who it is', JSON.stringify(calls()))
  if (HELLO) check(f1 === 'F1' && calls().some((c) => c[0] === '--pair') && !existsSync(secretFile()), 'I9 the secret --pair wrote was used')
  else check(f1 === 'refused' && !existsSync(secretFile()), 'I9 …so there is no secret file at all')
  const k9 = await keptTokenHash(app)
  // The same-Mac route hands out an OWNER credential (Prometheus #696), never the master token. The daemon keeps each device token's
  // SHA-256 (devices.db, api_devices.token_sha256) and marks owners (owner_devices): the kept one must be there, unrevoked, as this Mac's.
  const devicesDb = run('/usr/bin/find', [world.home, '-name', 'devices.db']).out.trim().split('\n')[0]
  const ownerRow = HELLO && k9 && /^[0-9a-f]{64}$/.test(k9) && devicesDb ? run('/usr/bin/sqlite3', [`file:${devicesDb}?mode=ro`, `SELECT d.name || '|' || (d.revoked_at IS NULL) FROM api_devices d JOIN owner_devices o ON o.device_id = d.id WHERE d.token_sha256 = '${k9}'`]).out.trim() : ''
  if (HELLO) check(k9 !== null && k9 !== daemonTokenHash() && ownerRow === 'Beacon on this Mac|1', 'I9 the credential kept is the owner credential the daemon issued for this Mac (its SHA-256 is an unrevoked owner device "Beacon on this Mac" in the daemon\'s own registry), not the master token', k9 === null ? 'nothing kept' : `owner row: "${ownerRow}", master: ${k9 === daemonTokenHash()}`)
  else check(f1 === 'refused' && k9 === null, 'I9 …and nothing was kept', k9 === null ? 'nothing kept' : 'SOMETHING KEPT')
  await finish(app)
  tripwires('I9')
} catch (e) {
  check(false, 'the probe ran to the end', String(e?.stack ?? e).slice(0, 600))
} finally {
  try {
    await app?.quit()
  } catch {
    /* gone */
  }
  killDaemons()
  await waitFor(async () => alive().length, (n) => n === 0, 8000)
  relServer.close()
  check(alive().length === 0, 'cleanup: every daemon this probe started is stopped', JSON.stringify(alive()))
  tripwires('end')
  // The scratch folder holds a copy of the app for each scenario (about 1.5 GB a run). It goes, and the run says so if it could not.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* reported by the check */
  }
  check(!existsSync(root), "cleanup: the probe's scratch folder (the app copies, the homes, the profiles) is removed", root)
}
