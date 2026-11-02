/**
 * Mac-check smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0 onboarding, O6.
 *
 * "Set it up on this Mac" starts with a look at this Mac. This holds the decision and the look to account without a
 * window:
 *
 *   * the verdicts and their ORDER (a Prometheus already here beats everything; not-a-Mac beats Intel beats an old
 *     macOS beats too little room), at their exact boundaries, and a fact Beacon cannot read blocking no one;
 *   * recognising a Prometheus already here, the three ways settled with the installer session, against REAL local
 *     servers: the hello, setup mode, the 401 of a configured daemon; and look-alikes that must NOT match (a login wall
 *     that says "unauthorized" without naming Bearer, a setup_mode that is a string, an HTML page);
 *   * the look sends only credential-free GETs, in order, and stops at the first answer;
 *   * the overrides a probe uses are ignored by a release build.
 *
 * What it cannot prove: the screens and the real facts of a real Mac. `npm run probe:onboarding-path-a` drives the app.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  DOWNLOAD_ESTIMATE_FROM,
  DOWNLOAD_ESTIMATE_MB,
  MIN_MACOS_MAJOR,
  REQUIRED_FREE_BYTES,
  computerFromRunning,
  configuredRunning,
  evaluateMacCheck,
  formatGB,
  macFactsOverride,
  macMajor,
  setupStatusRunning,
  type MacFacts,
  type RunningHere
} from '@shared/mac-check'
import type { DiscoveredComputer } from '@shared/discovery'
import { detectRunningHere, gatherMacFacts } from './mac-check'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[mac-check-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 37

const GOOD: MacFacts = { platform: 'darwin', arch: 'arm64', macos: '15.6.1', freeBytes: 50e9, memoryBytes: 16e9, port: 8005, running: null }
const verdict = (o: Partial<MacFacts>): string => evaluateMacCheck({ ...GOOD, ...o }).kind
const HELLO: DiscoveredComputer = { id: '0123456789abcdef', name: 'Probe Mac', agent: 'Atlas', version: '0.9.6', fp: '0123456789abcdef', pair: 'approve', tls: false, where: 'this-mac', endpoints: [{ host: '127.0.0.1', port: 8123 }] }

// ── the verdicts ────────────────────────────────────────────────────────────────────────────────
assert(verdict({}) === 'ok', 'verdict: an Apple silicon Mac on a current macOS with room is fine')
assert(verdict({ platform: 'linux' }) === 'other-os' && verdict({ platform: 'win32' }) === 'other-os', 'verdict: another kind of computer is "not offered here"')
assert(verdict({ arch: 'x64' }) === 'intel' && verdict({ arch: 'ia32' }) === 'intel', 'verdict: a chip that is not Apple silicon is "intel"')
assert(verdict({ macos: '12.7.6' }) === 'old-macos' && verdict({ macos: '10.15.7' }) === 'old-macos' && verdict({ macos: '13.0' }) === 'ok' && verdict({ macos: '13' }) === 'ok' && verdict({ macos: '14.4.1' }) === 'ok', `verdict: macOS older than ${MIN_MACOS_MAJOR} is too old, ${MIN_MACOS_MAJOR} itself is fine`)
assert(verdict({ freeBytes: REQUIRED_FREE_BYTES }) === 'ok' && verdict({ freeBytes: REQUIRED_FREE_BYTES - 1 }) === 'low-space' && verdict({ freeBytes: 0 }) === 'low-space', 'verdict: exactly the room needed is enough; one byte less is not')
assert(verdict({ freeBytes: null, macos: null }) === 'ok', 'verdict: free space or a macOS version that cannot be read blocks no one')
assert(verdict({ platform: 'linux', arch: 'x64', macos: '12', freeBytes: 0 }) === 'other-os' && verdict({ arch: 'x64', macos: '12', freeBytes: 0 }) === 'intel' && verdict({ macos: '12', freeBytes: 0 }) === 'old-macos', 'verdict: the order is not-a-Mac, then Intel, then old macOS, then room')
const here: RunningHere = { kind: 'hello', computer: HELLO }
assert(verdict({ running: here, platform: 'linux', arch: 'x64', macos: '12', freeBytes: 0 }) === 'running', 'verdict: a Prometheus already here beats every reason this Mac could not install another')
const running = evaluateMacCheck({ ...GOOD, running: { kind: 'setup', version: '0.9.6' }, port: 8123 })
assert(running.kind === 'running' && running.computer.endpoints[0].port === 8123 && running.computer.where === 'this-mac' && running.computer.name === 'This Mac', 'verdict: a Prometheus that only showed itself (not a hello) is a "This Mac" row at the port that answered, not 8005')

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
assert(macMajor('15.6.1') === 15 && macMajor('10.15.7') === 10 && macMajor('13') === 13 && macMajor('') === null && macMajor(null) === null && macMajor('Sonoma') === null && macMajor('15.x') === null, 'macMajor: the major version of a version string, null for anything else')
assert(formatGB(0.6 * 1024 ** 3) === '0.6 GB' && formatGB(1.5e9) === '1.5 GB' && formatGB(12.4e9) === '12 GB' && formatGB(0) === '0.0 GB' && formatGB(-5) === '0.0 GB', 'formatGB: decimal gigabytes (what System Settings shows), one decimal under ten')
assert(computerFromRunning(here, 9) === HELLO && computerFromRunning({ kind: 'configured' }, 8005).version === '' && computerFromRunning({ kind: 'setup', version: 'v'.repeat(80) }, 8005).version.length === 32, 'computerFromRunning: a hello is passed through; setup mode and a configured daemon become a "This Mac" row; a version is capped')
assert(DOWNLOAD_ESTIMATE_MB > 0 && REQUIRED_FREE_BYTES === 2_000_000_000, 'constants: about 2 GB of room is what the confirmation and the check both mean')
// Prometheus 0.9.17's zip, as its release says (Prometheus-mac-arm64.zip, size 71538835 bytes, read 2026-10-27). macOS counts decimal MB.
const MEASURED_ZIP_BYTES = 71_538_835
assert(DOWNLOAD_ESTIMATE_FROM.version === '0.9.17' && DOWNLOAD_ESTIMATE_MB === Math.round(MEASURED_ZIP_BYTES / 1e6), `the confirmation says about ${Math.round(MEASURED_ZIP_BYTES / 1e6)} MB, the size of the zip Prometheus ships (it said 79, from 0.9.16)`, String(DOWNLOAD_ESTIMATE_MB))

// ── recognising a Prometheus: the pure readings ─────────────────────────────────────────────────
assert(setupStatusRunning(200, { setup_mode: true, version: '0.9.6' })?.kind === 'setup' && setupStatusRunning(200, { setup_mode: true }) !== null, 'setup mode: 200 with setup_mode true')
assert(setupStatusRunning(200, { setup_mode: 'true' }) === null && setupStatusRunning(200, { setup_mode: false }) === null && setupStatusRunning(403, { setup_mode: true }) === null && setupStatusRunning(200, null) === null && setupStatusRunning(200, 'x') === null, 'setup mode: a string, false, a non-200 or a non-object is not it')
assert(configuredRunning(401, { error: 'unauthorized — set Authorization: Bearer <token>' })?.kind === 'configured' && configuredRunning(401, { error: 'Unauthorised: send a Bearer token' }) !== null, 'configured daemon: 401 with an error that says unauthorized and names Bearer')
assert(configuredRunning(401, { error: 'unauthorized' }) === null && configuredRunning(401, { error: 'Please log in' }) === null && configuredRunning(200, { error: 'unauthorized Bearer' }) === null && configuredRunning(401, 'unauthorized Bearer') === null && configuredRunning(401, {}) === null, 'configured daemon: someone else\'s login wall (no Bearer), a 200, plain text or no error is not it')
assert(configuredRunning(401, { error: 'Bearer token required' }) === null && configuredRunning(401, { error: 'invalid Bearer credentials' }) === null && configuredRunning(401, { message: 'unauthorized Bearer' }) === null, 'configured daemon: naming Bearer is not enough either, it has to say unauthorized too, in an `error` field')

// ── the overrides ───────────────────────────────────────────────────────────────────────────────
const raw = { BEACON_MAC_CHECK: JSON.stringify({ platform: 'linux', arch: 'x64', macos: '12.1', freeBytes: 5, memoryBytes: 7, nonsense: 1 }) }
const ov = macFactsOverride(raw, true)
assert(ov.platform === 'linux' && ov.arch === 'x64' && ov.macos === '12.1' && ov.freeBytes === 5 && ov.memoryBytes === 7 && !('nonsense' in ov), 'override: a dev or probe build honours the facts it is given, and only those')
assert(Object.keys(macFactsOverride(raw, false)).length === 0, 'override: a release build ignores it entirely')
assert(macFactsOverride({ BEACON_MAC_CHECK: JSON.stringify({ macos: null, freeBytes: null }) }, true).freeBytes === null && Object.keys(macFactsOverride({ BEACON_MAC_CHECK: JSON.stringify({ freeBytes: -1, arch: 5, platform: [] }) }, true)).length === 0, 'override: null means "cannot be read"; a negative, mistyped or malformed value is dropped')
assert(Object.keys(macFactsOverride({ BEACON_MAC_CHECK: 'nope' }, true)).length === 0 && Object.keys(macFactsOverride({ BEACON_MAC_CHECK: '[1]' }, true)).length === 0 && Object.keys(macFactsOverride({}, true)).length === 0, 'override: junk, an array or nothing is no override')

// ── the look, against real local servers ────────────────────────────────────────────────────────
interface Seen { method: string; path: string; headers: IncomingMessage['headers'] }
function server(handler: (path: string, res: ServerResponse) => void): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const s = createServer((req, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    handler(req.url ?? '', res)
  })
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, seen, close: () => new Promise<void>((r) => (s.closeAllConnections?.(), s.close(() => r()))) }))
  )
}
function send(res: ServerResponse, code: number, body: unknown, type = 'application/json'): void {
  res.writeHead(code, { 'content-type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const UNAUTH = { error: 'unauthorized — set Authorization: Bearer <token>' }

async function main(): Promise<void> {
  const hello = await server((p, res) => (p === '/api/hello' ? send(res, 200, { name: 'Probe Mac', agent: 'Atlas', fp: '0123456789abcdef', pair: 'approve', v: '0.9.6' }) : send(res, 404, {})))
  const a = await detectRunningHere(hello.port)
  assert(a?.kind === 'hello' && a.computer.name === 'Probe Mac' && a.computer.where === 'this-mac' && a.computer.endpoints[0].port === hello.port, 'detect: a computer that answers the hello is recognised, with its own name')
  assert(hello.seen.length === 1 && hello.seen[0].path === '/api/hello', 'detect: …and the look stops at the first answer: nothing else is asked', JSON.stringify(hello.seen.map((x) => x.path)))
  await hello.close()

  const setup = await server((p, res) => (p === '/api/setup/status' ? send(res, 200, { setup_mode: true, configured: false, version: '0.9.6' }) : send(res, 404, {})))
  const b = await detectRunningHere(setup.port)
  assert(b?.kind === 'setup' && b.version === '0.9.6' && JSON.stringify(setup.seen.map((x) => x.path)) === '["/api/hello","/api/setup/status"]', 'detect: a daemon in setup mode is recognised after the hello says no, in that order', JSON.stringify(setup.seen.map((x) => x.path)))
  await setup.close()

  const configured = await server((_p, res) => send(res, 401, UNAUTH))
  const c = await detectRunningHere(configured.port)
  assert(c?.kind === 'configured' && JSON.stringify(configured.seen.map((x) => x.path)) === '["/api/hello","/api/setup/status","/api/status"]', 'detect: a configured daemon is recognised by the 401, as the third and last way', JSON.stringify(configured.seen.map((x) => x.path)))
  assert(configured.seen.every((x) => x.method === 'GET' && !('authorization' in x.headers) && !('cookie' in x.headers) && !('x-api-key' in x.headers) && !('content-length' in x.headers)), 'detect: every look is a GET with no credential, cookie or body')
  await configured.close()

  const wall = await server((_p, res) => send(res, 401, { error: 'unauthorized' }))
  const html = await server((_p, res) => send(res, 200, '<html>router login</html>', 'text/html'))
  const stringy = await server((p, res) => (p === '/api/setup/status' ? send(res, 200, { setup_mode: 'true' }) : send(res, 404, {})))
  const bare = await server((_p, res) => send(res, 404, {}))
  assert((await detectRunningHere(wall.port)) === null && (await detectRunningHere(html.port)) === null && (await detectRunningHere(stringy.port)) === null && (await detectRunningHere(bare.port)) === null, 'detect: a login wall that does not name Bearer, an HTML page, a string where a boolean belongs and a plain 404 are NOT a Prometheus')
  await Promise.all([wall.close(), html.close(), stringy.close(), bare.close()])
  const closed = await server(() => undefined)
  const deadPort = closed.port
  await closed.close()
  assert((await detectRunningHere(deadPort)) === null, 'detect: nothing listening is not a Prometheus, and the look comes back')

  // ── gathering the facts ───────────────────────────────────────────────────────────────────────
  const live = await server((p, res) => (p === '/api/hello' ? send(res, 200, { name: 'Gathered', fp: '0123456789abcdef' }) : send(res, 404, {})))
  const real = await gatherMacFacts({ port: live.port, systemVersion: '15.6.1', env: {}, allowOverride: false })
  assert(typeof real.freeBytes === 'number' && real.freeBytes > 0 && typeof real.memoryBytes === 'number' && real.memoryBytes > 0 && real.macos === '15.6.1' && real.port === live.port && real.running?.kind === 'hello', 'gather: the real free space and memory are read, with the macOS version, the port and a Prometheus already here')
  const over = await gatherMacFacts({ port: live.port, systemVersion: '15.6.1', env: { BEACON_MAC_CHECK: JSON.stringify({ freeBytes: 7, arch: 'x64' }) }, allowOverride: true })
  assert(over.freeBytes === 7 && over.arch === 'x64' && over.macos === '15.6.1', 'gather: a dev or probe build\'s override is laid over the real facts, leaving the rest')
  // Held to the override's own values, not to `real`: free space is read live, and anything writing to the disk between two
  // reads (the smokes running alongside this one) moves it. The chip is injected so its half bites on an Intel Mac too.
  const relFacts = await gatherMacFacts({ port: live.port, systemVersion: '15.6.1', env: { BEACON_MAC_CHECK: JSON.stringify({ freeBytes: 7, arch: 'x64' }) }, allowOverride: false, arch: 'arm64' })
  assert(relFacts.freeBytes !== 7 && relFacts.arch === 'arm64', 'gather: a release build ignores the override', `freeBytes ${relFacts.freeBytes}, arch ${relFacts.arch}`)
  const unreadable = await gatherMacFacts({ port: live.port, systemVersion: null, env: {}, allowOverride: false, home: '/no/such/folder/anywhere' })
  assert(unreadable.freeBytes === null && unreadable.macos === null && evaluateMacCheck({ ...unreadable, running: null }).kind === 'ok', 'gather: free space that cannot be read is null, and null blocks no one')
  await live.close()

  // ── main passes the build flavour, not a constant ─────────────────────────────────────────────
  const src = readFileSync('src/main/path-a-ipc.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  assert(/const allowed = debuggingAllowedHere\(\)/.test(src) && /allowOverride: allowed/.test(src) && /discoveryEnv\(process\.env, allowed\)/.test(src), 'main: the overrides are gated by the build flavour (debuggingAllowedHere), for the facts and for the port')
  assert(/evaluateMacCheck\(facts\)/.test(src) && /process\.platform !== 'darwin'\) return false/.test(src), 'main: the verdict is the pure decision on the gathered facts, and the Storage pane is opened on macOS only')
  assert(!/downloadFile|createWriteStream|writeFile|spawn\(|execFile|exec\(/.test(readFileSync('src/main/mac-check.ts', 'utf8') + src), 'main: looking at this Mac downloads, writes and runs nothing')

  if (checks !== EXPECTED) {
    console.error(`[mac-check-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED} (a section was skipped, or one was added without updating EXPECTED)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[mac-check-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exit(1)
  }
  console.log(`[mac-check-smoke] OK — ${checks} checks passed`)
}

void main().catch((e) => {
  console.error('[mac-check-smoke] FAIL — threw:', e)
  process.exit(1)
})
