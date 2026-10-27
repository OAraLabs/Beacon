// probe:hardening: does a PACKAGED Beacon keep its doors shut? Drives built bundles, never dev.
//
//   npm run pack:mac && npm run pack:mac:probe && npm run probe:hardening
//
//   BEACON_RELEASE_BUNDLE  default dist/mac-arm64/Beacon.app        must refuse every door below
//   BEACON_PROBE_BUNDLE    default dist-probe/mac-arm64/Beacon.app  the release plus exactly what the
//                          other probes need (CDP and the Node inspector), signed the same way
//
// Pointing both at a build of main 9046521 is the red run: every release check fails there.
//
// RELEASE, read from the artifact: fuses (scripts/bundle-facts.mjs), the baked beaconBuild flag,
// the entitlements of every executable, the signature.
// RELEASE, launched once per door, each launch in its own scratch --user-data-dir with
// --use-mock-keychain (never the real profile, never a Keychain prompt):
//   --remote-debugging-port (both spellings), --remote-debugging-pipe   refused, port never opens
//   --inspect, --inspect-port + SIGUSR1                                 nothing listens
//   ELECTRON_RUN_AS_NODE, NODE_EXTRA_CA_CERTS                           ignored
//   DYLD_PRINT_LIBRARIES, DYLD_INSERT_LIBRARIES=<ad-hoc dylib>          ignored, the dylib never runs
//   app.asar edited after signing; a Resources/app/ folder instead      neither runs
// A "nothing happened" check means something only beside proof that the app DID come up in that
// launch: the [sqlite] line on stdout and app.db in the scratch profile. Every such check
// requires it.
// PROBE build: same fuses but one, same entitlements, same Team ID, its own bundle id and name;
// CDP and the inspector answer; through the inspector, better-sqlite3 and node-pty load and run in
// the signed process, and a copy of the SQLite addon re-signed ad hoc is REFUSED by library
// validation while the same bytes still carrying Beacon's signature load from the same directory.
// A persistent cookie set in the default session is on disk encrypted (the cookie-encryption fuse,
// which the release shares and must never lose: docs/DECISIONS.md D1).
// DEVTOOLS, from OUTSIDE the process (a release has no inspector to ask): a small Swift helper built
// here reads each build's live menu bar through the Accessibility API, brings the window to the
// front, and posts ⌥⌘I to that PID alone (never to whatever else is frontmost). A DevTools front end
// is a renderer process of its own, so "opened" is a new --type=renderer child. Release: no menu
// item, no renderer, while ⌘H posted the same way does hide it (the keystroke route works). Probe
// build: the item is there and ⌥⌘I opens DevTools, which main's isDevToolsOpened() confirms. Needs
// the Accessibility grant of whatever launched the probe (checked without prompting); the scratch
// Beacon takes focus for about three seconds.
// beacon://: the release declares the scheme (deep links), the probe build declares none, and the probe
// build's launch leaves LaunchServices' stored handler for beacon:// as it found it (read-only query).
// On 2026-10-06 a probe build that declared and claimed the scheme took it over from the installed app.
// The release launches above DO claim it (production behaviour, the release's own bundle id), so the
// handler check is taken around the probe launch alone.
//
// macOS only (codesign, lsof, clang, .app bundles).
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { createRequire } from 'node:module'
import { PROBE_FUSES, RELEASE_FUSES, readBuildFlavor, readFuses, readPackageName, readUrlSchemes } from './bundle-facts.mjs'

const REPO = join(fileURLToPath(import.meta.url), '../..')
const RELEASE = resolve(REPO, process.env.BEACON_RELEASE_BUNDLE ?? 'dist/mac-arm64/Beacon.app')
const PROBE = resolve(REPO, process.env.BEACON_PROBE_BUNDLE ?? 'dist-probe/mac-arm64/Beacon.app')
const TMP = mkdtempSync(join(tmpdir(), 'beacon-hardening-'))
const UP_LINE = '[sqlite] better-sqlite3 loaded OK'
const REFUSAL = '[release-gate] refused:'
const UP_TIMEOUT = 30_000 // a freshly signed bundle's first launch waits on the system's scan
const DOWN_WAIT = 8_000 // how long a launch that must NOT come up is watched
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bin = (app) => join(app, 'Contents/MacOS/Beacon')
const asarOf = (app) => join(app, 'Contents/Resources/app.asar')

// The Accessibility helper (scripts compile it at run time, like the test dylib: no binary in the repo).
const BEACON_AX_SWIFT = String.raw`// Drives one Beacon process from outside, by PID only: read its menu bar through the Accessibility
// API, bring it to the front, post a key chord to it alone, count its on-screen windows.
import Cocoa
import ApplicationServices

func ax(_ el: AXUIElement, _ attr: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}
func out(_ o: Any) { let d = try! JSONSerialization.data(withJSONObject: o); print(String(data: d, encoding: .utf8)!) }
let a = CommandLine.arguments
if a.count == 3 && a[1] == "handler" {
  // Read-only: the bundle id LaunchServices has stored as the default handler for a URL scheme.
  let handler: Any = (LSCopyDefaultHandlerForURLScheme(a[2] as CFString)?.takeRetainedValue() as String?) ?? NSNull()
  out(["scheme": a[2], "handler": handler] as [String: Any])
  exit(0)
}
if a.count == 2 && a[1] == "trusted" {
  out(["trusted": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)])
  exit(0)
}
guard a.count >= 3, let pid = pid_t(a[2]) else { out(["error": "usage: beacon-ax menu|front|key|onscreen <pid> …"]); exit(2) }
let app = AXUIElementCreateApplication(pid)
switch a[1] {
case "menu":
  let want = a.count > 3 ? a[3] : "View"
  guard let barRef = ax(app, kAXMenuBarAttribute) else { out(["error": "no menu bar"]); exit(0) }
  let bar = barRef as! AXUIElement
  for top in (ax(bar, kAXChildrenAttribute) as? [AXUIElement] ?? []) where (ax(top, kAXTitleAttribute) as? String) == want {
    var titles: [String] = []
    for menu in (ax(top, kAXChildrenAttribute) as? [AXUIElement] ?? []) {
      for item in (ax(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []) {
        if let t = ax(item, kAXTitleAttribute) as? String, !t.isEmpty { titles.append(t) }
      }
    }
    out(["menu": want, "items": titles]); exit(0)
  }
  out(["error": "no \(want) menu"])
case "front":
  let r = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let w = (ax(app, kAXWindowsAttribute) as? [AXUIElement])?.first {
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
  }
  usleep(500_000)
  out(["set": Int(r.rawValue), "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "focusedWindow": ax(app, kAXFocusedWindowAttribute) != nil])
case "key":
  guard a.count >= 4, let code = CGKeyCode(a[3]) else { out(["error": "key <pid> <virtual keycode> [cmd] [alt] [shift] [ctrl]"]); exit(2) }
  var flags = CGEventFlags()
  for m in a.dropFirst(4) {
    switch m { case "cmd": flags.insert(.maskCommand); case "alt": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); case "ctrl": flags.insert(.maskControl); default: break }
  }
  let src = CGEventSource(stateID: .hidSystemState)
  let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)!; down.flags = flags
  let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)!; up.flags = flags
  down.postToPid(pid); usleep(60_000); up.postToPid(pid)
  out(["posted": true])
case "onscreen":
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  out(["onscreen": list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }.count])
default:
  out(["error": "unknown command \(a[1])"])
}
`

// ── verdict: counted, and decided on exit so an early return cannot read as a pass ─────────
const EXPECTED = 64
let passed = 0, failed = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`)
  ok ? passed++ : failed++
}
process.on('exit', (code) => {
  const ran = passed + failed
  if (ran !== EXPECTED) console.log(`\nINCOMPLETE: ${ran} of ${EXPECTED} checks ran (${failed} failed)`)
  else console.log(failed === 0 ? `\nALL PASS (${passed}/${EXPECTED})` : `\n${failed} FAILURE(S) of ${EXPECTED}`)
  process.exitCode = ran === EXPECTED && failed === 0 && code === 0 ? 0 : 1
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.log(`note: scratch dir left behind: ${TMP} (${e.code ?? e})`) }
})

// ── launching ─────────────────────────────────────────────────────────────────────────────
const portOpen = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1')
  s.once('connect', () => { s.destroy(); res(true) })
  s.once('error', () => res(false))
})
let nextPort = 19400 + (process.pid % 400) * 2
async function freePort() {
  for (;;) { const p = nextPort++; if (!(await portOpen(p))) return p }
}
function listenSockets(pid) {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], { encoding: 'utf8' })
  return r.stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
}

/** Launch `app` once. Returns what happened: whether it came up, whether `port` ever accepted a
 *  connection, the LISTEN sockets its main process held once up, the marker file, its output. */
async function launch(app, { args = [], env = {}, port = null, expectUp = true, whileUp = null } = {}) {
  const profile = mkdtempSync(join(TMP, 'profile-'))
  const mark = join(profile, 'MARK')
  const child = spawn(bin(app), [...args, `--user-data-dir=${profile}`, '--use-mock-keychain'], {
    env: { ...process.env, BEACON_PROBE_MARK: mark, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Output is kept to its first 256 KB, with dyld lines counted as they stream: on main,
  // --remote-debugging-pipe without its file descriptors writes errors to stderr without end.
  let out = '', err = '', dyldLines = 0, errCarry = '', exit = null, listened = false, upAt = null
  const CAP = 256 * 1024
  child.stdout.on('data', (d) => { if (out.length < CAP) out += d })
  child.stderr.on('data', (d) => {
    const s = String(d)
    dyldLines += ((errCarry + s).match(/(?:^|\n)dyld\[/g) ?? []).length - ((errCarry).match(/(?:^|\n)dyld\[/g) ?? []).length
    errCarry = s.slice(-8)
    if (err.length < CAP) err += s
  })
  child.on('exit', (code, signal) => (exit = { code, signal }))
  const t0 = Date.now()
  const deadline = t0 + (expectUp ? UP_TIMEOUT : DOWN_WAIT)
  while (!exit && Date.now() < deadline) {
    if (port && (await portOpen(port))) listened = true
    if (upAt === null && out.includes(UP_LINE) && existsSync(join(profile, 'app.db'))) {
      upAt = Date.now() - t0
      if (expectUp) break
    }
    await sleep(20)
  }
  let listening = [], during = null
  if (upAt !== null && !exit) {
    const hold = Date.now() + 1500 // the window in which a debug port would have opened
    while (!exit && Date.now() < hold) { if (port && (await portOpen(port))) listened = true; await sleep(20) }
    if (whileUp && !exit) during = await whileUp(child)
    if (!exit) listening = listenSockets(child.pid)
  }
  const stillUp = !exit
  if (!exit) {
    child.kill('SIGTERM')
    for (let i = 0; i < 100 && !exit; i++) await sleep(100)
    if (!exit) { console.log(`note: pid ${child.pid} ignored SIGTERM for 10 s; SIGKILL`); child.kill('SIGKILL'); await sleep(500) }
  }
  return {
    up: upAt !== null, upAt, stillUp, exit, listened, listening, during, out, err, dyldLines, profile,
    mark: existsSync(mark) ? readFileSync(mark, 'utf8') : ''
  }
}
const upDetail = (r) => r.up ? `up in ${r.upAt} ms` : `did not come up (exit ${JSON.stringify(r.exit)}; stderr ${JSON.stringify(r.err.slice(-300))})`

// ── reading the artifact ──────────────────────────────────────────────────────────────────
function codesignInfo(path) {
  const r = spawnSync('codesign', ['-dvv', path], { encoding: 'utf8' })
  const text = r.stderr + r.stdout
  return {
    identifier: text.match(/^Identifier=(.*)$/m)?.[1] ?? null,
    team: text.match(/^TeamIdentifier=(.*)$/m)?.[1] ?? null,
    runtime: /flags=0x[0-9a-f]+\([^)]*runtime/.test(text)
  }
}
function entitlementsOf(path) {
  const r = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path], { encoding: 'utf8' })
  return [...(r.stdout ?? '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort()
}
/** The bundle's executables: the main binary, every helper app, node-pty's spawn-helper. */
function executablesOf(app) {
  const out = [bin(app)]
  const fw = join(app, 'Contents/Frameworks')
  for (const n of readdirSync(fw)) {
    if (!n.endsWith('.app')) continue
    const macos = join(fw, n, 'Contents/MacOS')
    for (const e of readdirSync(macos)) out.push(join(macos, e))
  }
  const helper = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper')
  if (existsSync(helper)) out.push(helper)
  return out
}
const FORBIDDEN = ['com.apple.security.cs.allow-dyld-environment-variables', 'com.apple.security.cs.disable-library-validation']
const STILL_NEEDED = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.device.audio-input']

// ── payloads, built here so the probe carries no binaries ─────────────────────────────────
const PAY = join(TMP, 'payloads')
mkdirSync(PAY)
writeFileSync(join(PAY, 'node-shell.js'), `require('fs').appendFileSync(process.env.BEACON_PROBE_MARK, 'node-shell ' + process.version + '\\n')\n`)
writeFileSync(join(PAY, 'mark.c'), `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void mark(void) {
  const char *p = getenv("BEACON_PROBE_MARK"); if (!p) return;
  FILE *f = fopen(p, "a"); if (f) { fprintf(f, "dylib-constructor pid=%d\\n", getpid()); fclose(f); }
}
`)
const clang = spawnSync('xcrun', ['clang', '-dynamiclib', '-arch', 'arm64', '-o', join(PAY, 'mark.dylib'), join(PAY, 'mark.c')], { encoding: 'utf8' })
const DYLIB = clang.status === 0 ? join(PAY, 'mark.dylib') : null
if (!DYLIB) console.log(`note: clang failed, the DYLD_INSERT_LIBRARIES check cannot run: ${clang.stderr}`)
writeFileSync(join(PAY, 'beacon-ax.swift'), BEACON_AX_SWIFT)
const swiftc = spawnSync('xcrun', ['swiftc', '-O', '-o', join(PAY, 'beacon-ax'), join(PAY, 'beacon-ax.swift')], { encoding: 'utf8' })
const AXBIN = swiftc.status === 0 ? join(PAY, 'beacon-ax') : null
const axTrusted = AXBIN ? axCall('trusted').trusted === true : false
if (!AXBIN) console.log(`note: swiftc failed, the DevTools checks cannot run: ${swiftc.stderr}`)
else if (!axTrusted) console.log('note: this process is not trusted for Accessibility, so the DevTools checks cannot read menus or post keys')

// ═════════════════════════════════════════════════════════════════════════════════════════
console.log(`release bundle: ${RELEASE}\nprobe bundle:   ${PROBE}\n`)
const haveRelease = existsSync(bin(RELEASE))
const haveProbe = existsSync(bin(PROBE))
check(haveRelease, 'release bundle exists', bin(RELEASE))
check(haveProbe, 'probe bundle exists', bin(PROBE))
if (!haveRelease || !haveProbe) process.exit(1)

// ── R1. release, read from the artifact ───────────────────────────────────────────────────
console.log('\n── release: the artifact')
const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', RELEASE], { encoding: 'utf8' })
const relSign = codesignInfo(RELEASE)
check(verify.status === 0 && relSign.runtime, 'release signature verifies (--deep --strict) with hardened runtime', `team ${relSign.team}, ${verify.stderr.trim() || 'valid'}`)
const relFuses = await readFuses(RELEASE)
console.log(`  fuses: ${JSON.stringify(relFuses)}`)
for (const [name, state] of Object.entries(RELEASE_FUSES)) check(relFuses[name] === state, `release fuse ${name} is ${state}`, `read back: ${relFuses[name] ?? relFuses.error}`)
const relFlavor = readBuildFlavor(asarOf(RELEASE))
check(relFlavor === 'release', "release asar's package.json says beaconBuild: release", JSON.stringify(relFlavor))
const relExes = executablesOf(RELEASE)
const leaky = relExes.map((p) => [p, entitlementsOf(p).filter((k) => FORBIDDEN.includes(k))]).filter(([, k]) => k.length)
check(leaky.length === 0, `no executable in the release (${relExes.length}) holds allow-dyld-environment-variables or disable-library-validation`, leaky.map(([p, k]) => `${p.replace(RELEASE + '/', '')}: ${k.join(', ')}`).join('; '))
const relEnt = entitlementsOf(bin(RELEASE))
check(STILL_NEEDED.every((k) => relEnt.includes(k)), 'the release keeps allow-jit, allow-unsigned-executable-memory and audio-input (voice needs the mic)', relEnt.join(', '))
const plist = readFileSync(join(RELEASE, 'Contents/Info.plist'), 'utf8')
check(plist.includes('<key>ElectronAsarIntegrity</key>'), 'Info.plist carries ElectronAsarIntegrity (what the integrity fuse checks app.asar against)')

// ── R2. release, launched once per door ───────────────────────────────────────────────────
console.log('\n── release: launched')
const control = await launch(RELEASE)
check(control.up, 'control: the release comes up with no door tried (the precondition for every "ignored" check below)', upDetail(control))
check(control.up && control.listening.length === 0, 'control: its main process listens on no TCP port', control.listening.join(', '))

for (const spelling of ['--remote-debugging-port', '-remote-debugging-port']) {
  const port = await freePort()
  const r = await launch(RELEASE, { args: [`${spelling}=${port}`], port, expectUp: false })
  check(!r.up && r.exit?.code === 1 && r.err.includes(`${REFUSAL} --remote-debugging-port`), `${spelling}=<port>: refused at startup, exit 1, with the gate's line`, `exit ${JSON.stringify(r.exit)}, up ${r.up}, stderr ${JSON.stringify(r.err.slice(0, 200))}`)
  check(!r.listened, `${spelling}=<port>: the port never accepted a connection (polled every 20 ms from spawn)`, `port ${port}`)
}
{
  const r = await launch(RELEASE, { args: ['--remote-debugging-pipe'], expectUp: false })
  check(!r.up && r.exit?.code === 1 && r.err.includes(`${REFUSAL} --remote-debugging-pipe`), '--remote-debugging-pipe: refused at startup, exit 1, with the gate\'s line', `exit ${JSON.stringify(r.exit)}, stderr ${JSON.stringify(r.err.slice(0, 200))}`)
}
{
  const port = await freePort()
  const r = await launch(RELEASE, { args: [`--inspect=${port}`], port })
  check(r.up, '--inspect=<port>: the app still comes up', upDetail(r))
  check(r.up && !r.listened && !r.err.includes('Debugger listening'), '--inspect=<port>: the inspector never listened', `listened ${r.listened}, stderr ${JSON.stringify(r.err.slice(0, 200))}`)
  check(r.up && r.listening.length === 0, '--inspect=<port>: the main process listens on no TCP port at all', r.listening.join(', '))
}
{
  const port = await freePort()
  const r = await launch(RELEASE, {
    args: [`--inspect-port=${port}`], port,
    whileUp: async (child) => { process.kill(child.pid, 'SIGUSR1'); await sleep(2000); return { alive: child.exitCode === null && child.signalCode === null, listening: listenSockets(child.pid) } }
  })
  check(r.up, 'SIGUSR1: the app was up when the signal was sent', upDetail(r))
  const opened = (r.during?.listening.length ?? 0) > 0 || r.listened || r.err.includes('Debugger listening')
  check(r.up && r.during !== null && !opened, 'SIGUSR1 to a running release opens no inspector (on --inspect-port or anywhere)', `during ${JSON.stringify(r.during)}, listened ${r.listened}, exit ${JSON.stringify(r.exit)}`)
}
{
  const r = await launch(RELEASE, { args: [join(PAY, 'node-shell.js')], env: { ELECTRON_RUN_AS_NODE: '1' } })
  check(!r.mark.includes('node-shell'), 'ELECTRON_RUN_AS_NODE=1 Beacon <script>: the script did not run as Node', JSON.stringify(r.mark))
  check(r.up, 'ELECTRON_RUN_AS_NODE=1: Beacon started as the app instead', upDetail(r))
}
{
  const r = await launch(RELEASE, { env: { NODE_EXTRA_CA_CERTS: join(TMP, 'no-such-ca.pem') } })
  check(r.up && !r.err.includes('Ignoring extra certs'), 'NODE_EXTRA_CA_CERTS is never read (no "Ignoring extra certs" for a missing file)', `${upDetail(r)}; stderr ${JSON.stringify(r.err.slice(0, 200))}`)
}
{
  const r = await launch(RELEASE, { env: { DYLD_PRINT_LIBRARIES: '1' } })
  check(r.up && r.dyldLines === 0, 'DYLD_PRINT_LIBRARIES=1: dyld ignores DYLD_* variables (0 lines)', `${upDetail(r)}; ${r.dyldLines} dyld lines`)
}
{
  const r = DYLIB ? await launch(RELEASE, { env: { DYLD_INSERT_LIBRARIES: DYLIB } }) : null
  check(!!r && r.up && !r.mark.includes('dylib-constructor'), 'DYLD_INSERT_LIBRARIES=<ad-hoc dylib>: its constructor never ran, in any Beacon process', r ? `${upDetail(r)}; mark ${JSON.stringify(r.mark)}` : 'clang failed, not run')
}
{
  // One byte of package.json inside app.asar, flipped in a copy after signing.
  const copy = join(TMP, 'edited', 'Beacon.app')
  mkdirSync(join(TMP, 'edited'))
  execFileSync('ditto', [RELEASE, copy])
  const flipped = flipPackageJsonByte(asarOf(copy))
  const r = await launch(copy, { expectUp: false })
  check(flipped && !r.up, 'app.asar edited after signing (one byte of package.json): the app does not run', `${flipped ? 'flipped' : 'COULD NOT FLIP'}; up ${r.up}, exit ${JSON.stringify(r.exit)}, stderr ${JSON.stringify(r.err.slice(-200))}`)
}
{
  // app.asar removed, a Resources/app/ folder with its own main in its place.
  const copy = join(TMP, 'appdir', 'Beacon.app')
  mkdirSync(join(TMP, 'appdir'))
  execFileSync('ditto', [RELEASE, copy])
  const res = join(copy, 'Contents/Resources')
  rmSync(join(res, 'app.asar'))
  mkdirSync(join(res, 'app'))
  writeFileSync(join(res, 'app/package.json'), '{ "name": "not-beacon", "main": "main.js" }\n')
  writeFileSync(join(res, 'app/main.js'), `require('fs').appendFileSync(process.env.BEACON_PROBE_MARK, 'app-folder-loaded\\n'); require('electron').app.quit()\n`)
  const r = await launch(copy, { expectUp: false })
  check(!r.mark.includes('app-folder-loaded'), 'a Resources/app/ folder in place of app.asar is never loaded', `mark ${JSON.stringify(r.mark)}, exit ${JSON.stringify(r.exit)}`)
}

{
  const r = await launch(RELEASE, { whileUp: (child) => devtoolsKeys(child.pid, { control: true }) })
  const dt = r.during ?? {}
  const items = dt.menu?.items
  check(Array.isArray(items) && items.includes('Reload') && !items.includes('Toggle Developer Tools'), "the release's live View menu has no Toggle Developer Tools (read over Accessibility)", JSON.stringify(dt.menu ?? dt.error ?? upDetail(r)))
  check(dt.front?.frontmost === true && dt.front?.focusedWindow === true && dt.before >= 1 && dt.after === dt.before, '⌥⌘I posted to the focused, frontmost release window opens no DevTools (no new renderer in 2.5 s)', JSON.stringify({ front: dt.front, renderers: [dt.before, dt.after], error: dt.error }))
  check(dt.onBefore >= 1 && dt.onAfter === 0, 'control: ⌘H posted the same way reaches the release (its windows leave the screen)', JSON.stringify({ onscreen: [dt.onBefore, dt.onAfter] }))
}

// ── P1. probe build, read from the artifact ───────────────────────────────────────────────
console.log('\n── probe build: the artifact')
const proVerify = spawnSync('codesign', ['--verify', '--deep', '--strict', PROBE], { encoding: 'utf8' })
const proSign = codesignInfo(PROBE)
check(proVerify.status === 0 && proSign.runtime, 'probe signature verifies (--deep --strict) with hardened runtime', proVerify.stderr.trim() || 'valid')
check(!!proSign.team && proSign.team === relSign.team && proSign.team !== 'not set', 'probe is signed by the same Team ID as the release (so its library-validation results hold for the release)', `${proSign.team} vs ${relSign.team}`)
check(!!proSign.identifier && proSign.identifier !== relSign.identifier, 'probe has its own code-signing identifier (no access to the release\'s Keychain item or mic grant)', `${proSign.identifier} vs ${relSign.identifier}`)
const proName = readPackageName(asarOf(PROBE)), relName = readPackageName(asarOf(RELEASE))
check(typeof proName === 'string' && proName !== relName, 'probe has its own package name (its own profile directory and Keychain item)', `${JSON.stringify(proName)} vs ${JSON.stringify(relName)}`)
const proFlavor = readBuildFlavor(asarOf(PROBE))
check(proFlavor === 'probe', "probe asar's package.json says beaconBuild: probe", JSON.stringify(proFlavor))
const proFuses = await readFuses(PROBE)
console.log(`  fuses: ${JSON.stringify(proFuses)}`)
for (const [name, state] of Object.entries(PROBE_FUSES)) check(proFuses[name] === state, `probe fuse ${name} is ${state}`, `read back: ${proFuses[name] ?? proFuses.error}`)
const proEnt = entitlementsOf(bin(PROBE))
check(proEnt.length > 0 && proEnt.join() === relEnt.join(), 'probe main binary has exactly the release\'s entitlements', `${proEnt.join(', ')} vs ${relEnt.join(', ')}`)
const relSchemes = readUrlSchemes(RELEASE), proSchemes = readUrlSchemes(PROBE)
check(Array.isArray(relSchemes) && relSchemes.includes('beacon'), "the release's Info.plist declares beacon:// (deep links stay with the release)", JSON.stringify(relSchemes))
check(Array.isArray(proSchemes) && !proSchemes.includes('beacon'), "the probe build's Info.plist declares no beacon:// scheme", JSON.stringify(proSchemes))

// ── P2. probe build, launched: CDP, the inspector, native modules, library validation ─────
console.log('\n── probe build: launched')
const cdp = await freePort(), insp = await freePort()
const handlerBefore = AXBIN ? axCall('handler', 'beacon').handler : undefined
const probeRun = await launch(PROBE, {
  args: [`--remote-debugging-port=${cdp}`, `--inspect=${insp}`],
  whileUp: async (child) => ({ ...(await inspectProbe(cdp, insp)), dt: await devtoolsKeys(child.pid, { inspectPort: insp }) })
})
const d = probeRun.during ?? {}
check(probeRun.up, 'probe build comes up with --remote-debugging-port and --inspect', upDetail(probeRun))
check(d.cdpVersion === true, 'CDP answers /json/version on the probe build', JSON.stringify(d.cdpError ?? ''))
check(typeof d.pageUrl === 'string' && d.pageUrl.endsWith('/Contents/Resources/app.asar/out/renderer/index.html'), 'CDP lists the shell page, loaded from inside app.asar', d.pageUrl)
check(d.attached === true, 'the Node inspector answers and attaches to main', d.attachError)
check(d.appName === 'beacon-desktop-probe', "main's app name is beacon-desktop-probe", JSON.stringify(d.appName))
check(d.sqlite?.ok === true && /^\d+\.\d+/.test(d.sqlite.version), 'better-sqlite3 loads in the signed probe process and runs a query', JSON.stringify(d.sqlite))
check(typeof d.sqlite?.addon === 'string' && d.sqlite.addon.includes('app.asar.unpacked'), 'the addon it loaded is the bundle\'s own, from app.asar.unpacked', d.sqlite?.addon)
check(d.pty?.ok === true && d.pty.exitCode === 0, 'node-pty loads and spawns through spawn-helper in the signed probe process', JSON.stringify(d.pty))
check(d.sameSig?.ok === true, 'control: a copy of the SQLite addon still carrying Beacon\'s signature loads from the scratch dir', JSON.stringify(d.sameSig))
const LV = /Team ID|not valid for use in process|library validation/i
check(d.adhoc?.ok === false && LV.test(d.adhoc?.error ?? ''), 'the same addon re-signed ad hoc is REFUSED by library validation', (d.adhoc?.error ?? '').match(/[^'(]*(Team ID|not valid for use in process|library validation)[^')]*/i)?.[0] ?? JSON.stringify(d.adhoc))

const handlerAfter = AXBIN ? axCall('handler', 'beacon').handler : undefined
check(AXBIN !== null && handlerAfter === handlerBefore, "the probe build's launch left LaunchServices' stored beacon:// handler as it found it", `${handlerBefore} → ${handlerAfter}`)
check(AXBIN !== null && typeof handlerAfter === 'string' && handlerAfter !== proSign.identifier, "beacon://'s stored handler is not the probe build", `${handlerAfter} (probe is ${proSign.identifier})`)
if (handlerAfter === proSign.identifier) {
  // The probe stays read-only toward LaunchServices; it says how to undo instead. A stored handler that
  // names the probe id (left by an older probe build's claim) routes beacon:// to ANY registered probe
  // build, scheme declared or not (measured 2026-10-06), until the release re-claims it at its launch.
  console.log(`note: beacon:// now opens the probe build. Undo: ${'/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'} -u '${PROBE}', then quit and reopen /Applications/Beacon.app (it re-claims beacon:// at launch).`)
}
const pdt = d.dt ?? {}
check(Array.isArray(pdt.menu?.items) && pdt.menu.items.includes('Toggle Developer Tools'), "the probe build's live View menu has Toggle Developer Tools", JSON.stringify(pdt.menu ?? pdt.error))
check(pdt.front?.frontmost === true && pdt.after === pdt.before + 1 && pdt.devToolsOpened === true, '⌥⌘I opens DevTools in the probe build (one new renderer, and main\'s isDevToolsOpened() agrees)', JSON.stringify({ front: pdt.front, renderers: [pdt.before, pdt.after], devToolsOpened: pdt.devToolsOpened, error: pdt.error }))
const jar = cookieOnDisk(probeRun.profile, 'beacon_probe_cookie')
check(d.cookieSet === 'ok' && jar?.found === true && jar.valueLength === 0 && jar.prefix === 'v10', 'a persistent cookie set in the default session is stored ENCRYPTED on disk (v10…, empty plaintext value)', JSON.stringify(jar ?? d.cookieSet))

// ═════════════════════════════════════════════════════════════════════════════════════════

function axCall(...args) {
  try { return JSON.parse(execFileSync(AXBIN, args.map(String), { encoding: 'utf8', timeout: 15_000 })) } catch (e) { return { error: String(e?.message ?? e) } }
}
/** --type=renderer children of Beacon's main process. */
function renderersOf(pid) {
  return execFileSync('ps', ['-Ao', 'ppid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.trim().startsWith(`${pid} `) && l.includes('--type=renderer')).length
}
/** Read the View menu, bring the window to the front, post ⌥⌘I to this PID alone and count renderers;
 *  with `control`, then post ⌘H and count on-screen windows; with `inspectPort`, ask main whether any
 *  web contents has DevTools open. */
async function devtoolsKeys(pid, { control = false, inspectPort = null } = {}) {
  if (!AXBIN || !axTrusted) return { error: AXBIN ? 'not trusted for Accessibility' : 'swiftc failed' }
  const out = { menu: axCall('menu', pid, 'View'), front: axCall('front', pid) }
  out.onBefore = axCall('onscreen', pid).onscreen
  out.before = renderersOf(pid)
  axCall('key', pid, 34, 'cmd', 'alt') // kVK_ANSI_I
  await sleep(2500)
  out.after = renderersOf(pid)
  if (inspectPort) {
    let ws
    try {
      const node = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()).find((t) => t.type === 'node')
      ws = await connect(node.webSocketDebuggerUrl)
      out.devToolsOpened = await ws.evaluate(`process.mainModule.require('electron').webContents.getAllWebContents().some((wc) => wc.isDevToolsOpened())`)
    } catch (e) { out.error = String(e) } finally { ws?.close() }
  }
  if (control) {
    axCall('key', pid, 4, 'cmd') // kVK_ANSI_H
    await sleep(1000)
    out.onAfter = axCall('onscreen', pid).onscreen
  }
  return out
}

/** The named cookie's row in the profile's Cookies database, read from a copy after the app has
 *  quit: whether it is there, its plaintext value's length, the first bytes of its encrypted value. */
function cookieOnDisk(profile, name) {
  try {
    const db = execFileSync('find', [profile, '-name', 'Cookies', '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)[0]
    if (!db) return { found: false, why: 'no Cookies database in the profile' }
    const copy = join(TMP, `cookies-${Date.now()}.db`)
    copyFileSync(db, copy)
    const row = execFileSync('sqlite3', [copy, `select length(value), cast(substr(encrypted_value, 1, 3) as text) from cookies where name = '${name}'`], { encoding: 'utf8' }).trim()
    if (!row) return { found: false, why: 'no row for the cookie' }
    const [valueLength, prefix] = row.split('|')
    return { found: true, valueLength: Number(valueLength), prefix }
  } catch (e) {
    return { found: false, why: String(e?.message ?? e) }
  }
}

/** Flip the case of one letter inside the asar's package.json, in place. True when it did. */
function flipPackageJsonByte(asarPath) {
  try {
    const asar = createRequire(import.meta.url)('@electron/asar')
    const { headerSize } = asar.getRawHeader(asarPath)
    const st = asar.statFile(asarPath, 'package.json')
    const text = asar.extractFile(asarPath, 'package.json').toString('latin1')
    // A letter inside the description VALUE: changing it alters nothing Beacon reads, so on a
    // build without the integrity fuse the edited app still runs (measured on main 9046521).
    // Flipping a key such as "name" could stop the app for an unrelated reason and fake a pass.
    const m = /"description"\s*:\s*"[^a-z"]*/.exec(text)
    const i = m ? m.index + m[0].length : -1
    if (i < 0 || !/[a-z]/.test(text[i])) return false
    const at = 8 + headerSize + Number(st.offset) + i
    const fd = openSync(asarPath, 'r+')
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, at)
    if (b[0] !== text.charCodeAt(i)) { closeSync(fd); return false } // the offset arithmetic is wrong; do not pretend
    b[0] ^= 0x20
    writeSync(fd, b, 0, 1, at)
    closeSync(fd)
    return true
  } catch (e) {
    console.log(`note: flip failed: ${e}`)
    return false
  }
}

/** Everything the probe build is asked while it is up. */
async function inspectProbe(cdpPort, inspectPort) {
  const out = {}
  try {
    out.cdpVersion = (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok
    let page = null
    for (let i = 0; i < 40 && !page; i++) {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#'))
      if (!page) await sleep(250)
    }
    out.pageUrl = page?.url ?? null
  } catch (e) { out.cdpError = String(e) }
  let ws = null
  try {
    const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
    const node = list.find((t) => t.type === 'node')
    ws = await connect(node.webSocketDebuggerUrl)
    // Retry until Electron's module loader is hooked; never return the module by value
    // (memory: linux-probes-race-mac-startup).
    for (let i = 0; i < 50; i++) {
      const ok = await ws.evaluate(`typeof process.mainModule?.require('electron').app === 'object'`)
      if (ok === true) break
      await sleep(200)
    }
    out.attached = true
    const REQ = `process.mainModule.require('module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json')`
    out.appName = await ws.evaluate(`process.mainModule.require('electron').app.getName()`)
    out.sqlite = await ws.evaluate(`(() => { try {
      const req = ${REQ}; const Database = req('better-sqlite3'); const db = new Database(':memory:')
      const { v } = db.prepare('select sqlite_version() as v').get(); db.close()
      // The file dyld actually mapped, not a module-cache key (which can name the asar path).
      const addon = process.report.getReport().sharedObjects.find((p) => p.includes('better-sqlite3') && p.endsWith('.node'))
      return { ok: true, version: v, addon }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`)
    out.pty = await ws.evaluate(`new Promise((resolve) => { try {
      const pty = (${REQ})('node-pty'); let data = ''
      const p = pty.spawn('/bin/echo', ['BEACON_PTY_' + (6 * 7)], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/', env: {} })
      p.onData((x) => { data += x })
      p.onExit(({ exitCode }) => resolve({ ok: /BEACON_PTY_42/.test(data), exitCode }))
      setTimeout(() => resolve({ ok: false, timeout: true, data }), 8000)
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }) } })`)
    // Library validation: the same bytes from the same scratch directory, once with Beacon's
    // signature (must load) and once re-signed ad hoc (must be refused).
    const addon = out.sqlite?.addon
    if (addon && existsSync(addon)) {
      const dir = mkdtempSync(join(TMP, 'addon-'))
      const same = join(dir, 'same-signature.node'), adhoc = join(dir, 'adhoc.node')
      copyFileSync(addon, same)
      copyFileSync(addon, adhoc)
      const s = spawnSync('codesign', ['--force', '--sign', '-', adhoc], { encoding: 'utf8' })
      const dl = (p) => ws.evaluate(`(() => { try { process.dlopen({ exports: {} }, ${JSON.stringify(p)}); return { ok: true } } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`)
      out.sameSig = await dl(same)
      out.adhoc = s.status === 0 ? await dl(adhoc) : { ok: null, error: `ad-hoc re-sign failed: ${s.stderr}` }
    } else {
      out.sameSig = { ok: null, error: `no addon path to copy (${addon})` }
      out.adhoc = { ok: null, error: 'not run' }
    }
    // A persistent cookie, flushed to disk now; the launch's teardown then quits the app, and the
    // row is read from the profile after it has exited (cookieOnDisk).
    out.cookieSet = await ws.evaluate(`(async () => { try {
      const { session } = process.mainModule.require('electron')
      await session.defaultSession.cookies.set({ url: 'https://hardening-probe.test/', name: 'beacon_probe_cookie', value: 'plaintext-would-show-here', expirationDate: Math.floor(Date.now() / 1000) + 3600 })
      await session.defaultSession.cookies.flushStore()
      return 'ok'
    } catch (e) { return String(e && e.message || e) } })()`)
  } catch (e) {
    out.attachError = String(e?.stack ?? e)
  } finally {
    ws?.close()
  }
  return out
}

function connect(url) {
  return new Promise((res, rej) => {
    const sock = new WebSocket(url)
    const pending = new Map()
    let id = 0
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
    const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text }
      return r.result?.result?.value
    }
    sock.onopen = () => res({ evaluate, close: () => sock.close() })
    sock.onerror = (e) => rej(new Error(`inspector websocket: ${e.message ?? e}`))
  })
}
