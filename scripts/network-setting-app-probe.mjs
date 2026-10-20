#!/usr/bin/env node
// network-setting-app-probe — Settings → Other computers in the BUILT app, against REAL Prometheus daemons (macOS: app-driver).
//
//   export BEACON_SIGNED_PYTHON=<a python3.12 with Prometheus's dependencies, e.g. the notarized app's signed one>
//   export BEACON_NO_ROUTE_SRC=<prometheus tree with #700 and WITHOUT #724, e.g. main at 76134d6>/src
//   export BEACON_RESTART_SRC=<prometheus tree with #724, e.g. main>/src
//   npm run build && node scripts/network-setting-app-probe.mjs [screenshot.png]
//
// NEVER ON THE HOME NETWORK. 2026-10-11 this probe was run with a tree that HAS the restart route in part 1, its [Restart now]
// restarted a scratch daemon into home-network mode, and it listened on *:8006 and *:8011 for some seconds. Its safety had rested
// on the route not existing. Three guards now, each checked before it is relied on:
//   * the source: part 1 (which clicks [Restart now] with home_network pending) runs only a tree whose server has NO restart
//     route, read from the source before anything starts; the probe refuses otherwise;
//   * mDNS: every daemon runs under sandbox-exec denying multicast DNS (5353), so nothing is ever announced; a self-test proves a
//     sandboxed send to 224.0.0.251:5353 is refused before any daemon starts. (A bind cannot be held to loopback this way:
//     macOS's sandbox language lets "localhost" match a 0.0.0.0 bind, tested 2026-10-11.)
//   * a tripwire: every daemon's listening sockets are read every 150 ms; one on anything but 127.0.0.1 kills its process group
//     at once and fails the run.
//
// 1. Prometheus with #700's GET/PUT /api/network and no restart route, owner credential: the section, the switch clicked ON with
//    real mouse events (saved, "Restart Prometheus to finish.", [Restart now]), [Restart now] clicked (this Prometheus answers
//    405: "can't be restarted from Beacon", the button goes), the switch clicked OFF (live again, nothing to restart). The
//    daemon's file says this_mac at the end and it never listened anywhere but 127.0.0.1.
// 2. The same daemon, an ordinary approved device's credential: no section at all.
// 3. The restart (Prometheus #724, merged into main beside #700): Beacon's restart through its real IPC and main, observed from
//    outside: the daemon goes away, comes back with the same fp, Beacon says "back" and reads the setting again.
//
// WHAT IT CANNOT PROVE: [Restart now] bringing a daemon back in the UI. Only a pending change makes it appear, and the only
// pending change is home_network, whose restart listens on the home network, which this probe never does (home_network is saved
// and saved back to this_mac without a restart). Loopback has no other pending change: "localhost" canonicalises to 127.0.0.1,
// and any other loopback address cannot be bound on macOS or reached at 127.0.0.1. smoke:network-setting covers the UI's back
// path against the recorded answers; part 3 restarts through the same IPC the button calls.
//
// Scratch homes, an empty scratch Beacon profile, --use-mock-keychain, ephemeral ports (never 8005/8006/8010/8011).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'

const PY = process.env.BEACON_SIGNED_PYTHON
const NET = process.env.BEACON_NO_ROUTE_SRC
const RST = process.env.BEACON_RESTART_SRC
const SHOT = process.argv[2] ?? null
if (process.platform !== 'darwin' || !PY || !NET || !RST) {
  console.log('[probe] SKIPPED: macOS, with BEACON_SIGNED_PYTHON, BEACON_NO_ROUTE_SRC and BEACON_RESTART_SRC')
  process.exit(3)
}
// Guard 1, the source: part 1's tree must not have the restart route (its [Restart now] would restart onto the home network).
const hasRestartRoute = (src) => {
  try {
    return readFileSync(join(src, 'prometheus/web/server.py'), 'utf8').includes('@app.post("/api/restart")')
  } catch {
    return null
  }
}
if (hasRestartRoute(NET) !== false || hasRestartRoute(RST) !== true) {
  console.log(`[probe] REFUSED: BEACON_NO_ROUTE_SRC must be a tree without POST /api/restart (it has it: ${hasRestartRoute(NET)}), and BEACON_RESTART_SRC one with it (${hasRestartRoute(RST)})`)
  process.exit(2)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
// Guard 2, mDNS: every daemon runs under this profile; prove it refuses a multicast DNS send before relying on it.
const SANDBOX = join(tmpdir(), `beacon-probe-net-sandbox-${process.pid}.sb`)
writeFileSync(SANDBOX, '(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:5353"))\n')
const selfTest = spawnSync('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-c', 'import socket\ns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\ntry:\n    s.sendto(b"x", ("224.0.0.251", 5353)); print("sent")\nexcept OSError as e:\n    print("refused")'], { encoding: 'utf8' })
if (selfTest.stdout.trim() !== 'refused') {
  console.log(`[probe] REFUSED: the mDNS sandbox did not refuse a send (${selfTest.stdout.trim() || selfTest.stderr.trim()})`)
  process.exit(2)
}
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 600)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 23
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})

// ── real daemons ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(every)
  }
}
const procs = []
const homes = []
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return
  try { process.kill(-p.pid, 'SIGTERM') } catch { /* gone */ }
  if (!(await until(() => p.exitCode !== null || p.signalCode !== null, 15000))) try { process.kill(-p.pid, 'SIGKILL') } catch { /* gone */ }
}
async function configured(src) {
  const api = await freePort()
  const ws = await freePort()
  if ([api, ws].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
  const home = mkdtempSync(join(tmpdir(), 'beacon-probe-net-'))
  homes.push(home)
  mkdirSync(join(home, 'tmp'))
  const base = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: src, PROMETHEUS_INSTALL_KIND: 'app' }
  const start = (env) => {
    const p = spawn('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-m', 'prometheus', 'daemon'], { env: { ...base, ...env }, stdio: 'ignore', detached: true })
    procs.push(p)
    return p
  }
  const call = async (method, path, body, token) => {
    try {
      const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { status: res.status, json }
    } catch {
      return { status: 0, json: null }
    }
  }
  let p = start({ PROMETHEUS_WEB_BIND: '127.0.0.1', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws) })
  if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error(`setup mode did not answer (${src})`)
  const secret = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
  await until(() => existsSync(secret), 5000)
  const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secret, 'utf8').trim() })).json?.token
  await call('POST', '/api/setup/configure', { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'sk-ant-probe-placeholder-not-a-key' }, master)
  await call('POST', '/api/setup/complete', {}, master)
  if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not come up configured')
  await stop(p)
  p = start({}) // the way an installed daemon starts: the file decides the address
  if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not restart from its config')
  const device = (await call('POST', '/api/devices', { name: 'Probe phone', platform: 'ios' }, master)).json?.token
  return { p, api, ws, home, call, master, device }
}
/** Every TCP address the daemon's process group listens on (lsof), so "never beyond loopback" is observed, not assumed. */
function listening(pid) {
  const out = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(pid), '-Fn'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
}
// Guard 3, the tripwire: any daemon listening on anything but 127.0.0.1 is killed at once, and the run fails.
const tripped = []
const tripwire = setInterval(() => {
  for (const p of procs) {
    if (p.exitCode !== null || p.signalCode !== null) continue
    const wide = listening(p.pid).filter((n) => !n.startsWith('127.0.0.1:'))
    if (wide.length > 0) {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
      tripped.push(wide.join(' '))
      console.log(`[probe] TRIPWIRE: a daemon listened on ${wide.join(', ')}; killed`)
    }
  }
}, 150)
{
  // The tripwire proves itself first, with no home-network listen: a listener on [::1] is this Mac only, and not 127.0.0.1.
  const planted = spawn(PY, ['-B', '-c', 'import socket, time\ns = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)\ns.bind(("::1", 0)); s.listen(1); time.sleep(30)'], { stdio: 'ignore', detached: true })
  procs.push(planted)
  const end = Date.now() + 5000
  while (planted.exitCode === null && planted.signalCode === null && Date.now() < end) await sleep(100)
  const caught = planted.signalCode === 'SIGKILL' && tripped.length === 1 && tripped[0].startsWith('[::1]:')
  procs.splice(procs.indexOf(planted), 1)
  tripped.length = 0
  if (!caught) {
    try {
      process.kill(-planted.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
    clearInterval(tripwire)
    console.log('[probe] REFUSED: the tripwire did not catch a planted listener on [::1]')
    process.exit(2)
  }
  console.log('[probe] guards: source rule, mDNS sandbox and tripwire each proved before use')
}

// ── the app ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'beacon-probe-net-profile-'))
let app = null
const SECTION = '[data-testid="other-computers"]'
const SWITCH = '[data-testid="home-network-switch"]'
const LINE = '[data-testid="home-network-line"]'
const RESTART = '[data-testid="restart-prometheus"]'
const section = () => app.page.evaluate(`(() => {
  const s = document.querySelector(${JSON.stringify(SECTION)})
  if (!s) return null
  const sw = s.querySelector(${JSON.stringify(SWITCH)})
  return { text: s.innerText, on: sw ? sw.checked : null, line: s.querySelector(${JSON.stringify(LINE)})?.innerText ?? null, restart: !!s.querySelector(${JSON.stringify(RESTART)}) }
})()`)
/** A real click: the element scrolled into view, hit-tested at its centre (it must be what is on top there), then a mouse press. */
async function click(selector) {
  const at = await app.page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, hit: !!hit && (hit === el || el.contains(hit)) }
  })()`)
  if (!at?.hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
/** Settings opened fresh (closed first with its own Close button, so the section mounts and asks again). */
async function openSettings() {
  await app.page.evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close'); if (c) c.click(); return true })()`)
  await sleep(300)
  await app.page.evaluate(`window.dispatchEvent(new Event('beacon:open-settings')); true`)
}
const settle = (pred, ms = 8000) => until(async () => { const s = await section(); return pred(s) ? s : null }, ms, 150)

try {
  console.log('\n── 1. Prometheus main (#700), the owner ───────────────────────────────────────────')
  const a = await configured(NET)
  // Connect mode from the start (an empty profile otherwise lands on first-run setup, where Settings is not mounted).
  Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(a.api), BEACON_GATEWAY_WS_PORT: String(a.ws) })
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  const saved = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${a.api}, wsPort: ${a.ws}, token: ${JSON.stringify(a.master)} }).then((r) => r.ok)`)
  check(saved === true, 'Beacon saved the connection with the owner credential (through its own setup IPC; the mock keychain)')
  await openSettings()
  const s0 = await settle((s) => !!s && s.on !== null)
  check(!!s0 && s0.on === false && s0.line === 'Only this Mac can use Prometheus.' && !s0.restart, 'Settings → Other computers: the switch is there, off, "Only this Mac can use Prometheus.", no restart', JSON.stringify(s0))
  check((await click(SWITCH)) === true, 'the switch is what is on top at its centre, and was clicked')
  const s1 = await settle((s) => s?.on === true && s.restart)
  check(!!s1 && s1.line === 'Restart Prometheus to finish.' && s1.restart, 'ON: Prometheus saved it; the switch shows the saved choice, "Restart Prometheus to finish." and [Restart now]', JSON.stringify(s1))
  const g1 = await a.call('GET', '/api/network', undefined, a.master)
  check(g1.json?.pending_mode === 'home_network' && g1.json?.mode === 'this_mac' && g1.json?.applied === 'on_restart', 'the daemon agrees: running this_mac, pending_mode home_network', JSON.stringify(g1.json))
  check((await click(RESTART)) === true, '[Restart now] was clicked')
  const s2 = await settle((s) => !!s && /can't be restarted from Beacon/.test(s.text))
  check(!!s2 && !s2.restart && s2.on === true, "this Prometheus has no restart route (a real 405): \"can't be restarted from Beacon\", and [Restart now] is gone", JSON.stringify(s2))
  check((await a.call('GET', '/api/hello')).status === 200 && a.p.exitCode === null, 'and the daemon did not restart (still the same process, still answering)')
  check((await click(SWITCH)) === true, 'the switch was clicked again')
  const s3 = await settle((s) => s?.on === false)
  check(!!s3 && s3.line === 'Only this Mac can use Prometheus.' && !s3.restart, 'OFF before any restart: live again, nothing to restart', JSON.stringify(s3))
  const g3 = await a.call('GET', '/api/network', undefined, a.master)
  const file = readFileSync(join(a.home, '.prometheus/prometheus.yaml'), 'utf8')
  check(g3.json?.applied === 'live' && g3.json?.pending_mode === undefined && /^\s*bind:\s*["']?127\.0\.0\.1["']?\s*$/m.test(file) && /^\s*home_network:\s*false\s*$/m.test(file), "the daemon's file is back to 127.0.0.1 with home_network false, nothing pending", JSON.stringify({ g3: g3.json, lines: file.split('\n').filter((l) => /bind:|home_network:/.test(l)) }))
  const where = listening(a.p.pid)
  check(where.length > 0 && where.every((n) => n.startsWith('127.0.0.1:')), 'the daemon only ever listened on 127.0.0.1', JSON.stringify(where))
  if (SHOT) {
    const shot = await app.page.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))
  }

  console.log('\n── 2. the same Prometheus, an approved device that is not the owner ─────────────')
  const saved2 = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${a.api}, wsPort: ${a.ws}, token: ${JSON.stringify(a.device)} }).then((r) => r.ok)`)
  check(saved2 === true && typeof a.device === 'string', 'Beacon saved the connection with an ordinary device credential')
  const asIpc = await app.page.evaluate(`window.beacon.network.get()`)
  check(asIpc?.kind === 'hidden', 'the IPC says hidden (the daemon answered 403 operator_only)', JSON.stringify(asIpc))
  await openSettings()
  await sleep(1500)
  const settingsUp = await app.page.evaluate(`[...document.querySelectorAll('div')].some((d) => d.textContent === 'Startup' && d.children.length === 0)`)
  check(settingsUp === true && (await section()) === null, 'Settings is open and has no Other computers section', JSON.stringify(await section()))
  await stop(a.p)

  console.log('\n── 3. Prometheus #724 (the restart route), through Beacon\'s IPC ──────────────────')
  const b = await configured(RST)
  const fp = (await b.call('GET', '/api/hello')).json?.fp
  const saved3 = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${b.api}, wsPort: ${b.ws}, token: ${JSON.stringify(b.master)} }).then((r) => r.ok)`)
  check(saved3 === true && typeof fp === 'string' && fp.length === 16, 'Beacon saved the connection to the #724 daemon (owner credential); its fp is known', fp)
  // Watch from outside while Beacon restarts it: the gap is what proves a restart happened.
  let watching = true
  const seen = []
  const watcher = (async () => {
    while (watching) {
      const h = await b.call('GET', '/api/hello')
      seen.push(h.status === 200 ? `up:${h.json?.fp}` : 'down')
      await sleep(50)
    }
  })()
  const t0 = Date.now()
  const r = await app.page.evaluate(`window.beacon.network.restart()`)
  const took = Date.now() - t0
  watching = false
  await watcher
  const gap = seen.indexOf('down')
  check(r?.kind === 'back', 'Beacon says Prometheus is back', JSON.stringify(r))
  check(gap > 0 && seen.slice(gap).some((x) => x === `up:${fp}`), 'observed from outside: it answered, went away, and came back with the same fp', JSON.stringify(seen.slice(0, 40)))
  check(took < 20000 && b.p.exitCode === null, `and in ${took} ms, as the same process (re-exec in place)`)
  check(r?.read?.kind === 'shown' && r.read.view.line === 'Only this Mac can use Prometheus.', 'and the setting is read again from the daemon that came back (Prometheus main has both routes since #724 merged)', JSON.stringify(r?.read))
  await stop(b.p)
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  for (const p of procs) await stop(p)
  clearInterval(tripwire)
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null).length
  check(alive === 0, 'every daemon this probe started has stopped', `${alive} alive`)
  check(tripped.length === 0, 'no daemon ever listened beyond 127.0.0.1 (the tripwire read every 150 ms)', tripped.join(' | '))
  rmSync(SANDBOX, { force: true })
  for (const h of homes) rmSync(h, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
}
