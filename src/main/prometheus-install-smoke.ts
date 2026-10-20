/**
 * Setting Prometheus up on this Mac (path A, A-inst) — headless, under ELECTRON_RUN_AS_NODE.
 *
 * Two halves:
 *   1. The pure reading (@shared/prometheus-app), held to what the REAL tools and the REAL daemon said: the fixtures were recorded
 *      from the notarized Prometheus.app of Prometheus #695 (scripts/record-prometheus-app.mjs: codesign, spctl and syspolicy_check
 *      on it and on apps that must fail, and its daemon's answers) and from Prometheus main with #694 and #696
 *      (scripts/record-pair-local.mjs: the same-Mac route that hands out owner credentials).
 *   2. The installer (src/main/prometheus-install.ts) in a world of fakes: the release, the tools, the launcher and the daemon. What
 *      it pins is ORDER and REFUSAL: nothing is run before every check has passed, the app is checked before it is moved and where
 *      it lands, a check that fails moves and runs nothing and leaves nothing behind, every card of the spec's table is reached by
 *      what causes it, and no secret or token ever reaches what the page is sent.
 *
 * What it cannot prove: that the real tools judge a real app this way on another Mac, or that the screen shows it. The probe
 * (npm run probe:onboarding-install) runs the whole path in the real app against the real Prometheus.app.
 */
import { COPY } from '@shared/onboarding-strings'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INSTALL_STEPS,
  LOCAL_DEVICE_NAME,
  MAX_ZIP_BYTES,
  PAIR_SECRET_IN_HOME,
  PROMETHEUS_TEAM_IDS,
  RELEASE_BASE,
  START_TIMEOUT_MS,
  daemonStateFrom,
  folderOf,
  fingerprintMismatch,
  formatMB,
  helloRefusal,
  installEnv,
  isPairSecret,
  parseManifest,
  parsePairWritten,
  parseRegister,
  parseSecretPair,
  parseSignatureInfo,
  redirectAllowed,
  signingRequirement,
  spctlNotarized,
  stepState,
  syspolicyPassed,
  type InstallView
} from '@shared/prometheus-app'
import { PrometheusInstaller, type ExecFn, type ExecResult, type InstallDeps, type SavedLocal } from './prometheus-install'
import { checkZipEntries, unsafeEntryName, unsafeLinkTarget } from './zip-check'
import { helloFrom } from '@shared/discovery'
import type { HttpRequest, HttpResult } from './pairing/http'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[prometheus-install-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
// The count is checked on exit, so an early return or a throw cannot skip it.
const EXPECTED = 105
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[prometheus-install-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[prometheus-install-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[prometheus-install-smoke] OK — ${checks} checks passed`)
})

interface Tool {
  exit: number | null
  stdout: string
  stderr: string
}
interface AppFixture {
  requirement: string
  tools: Record<'real' | 'tampered' | 'adhoc' | 'calculator' | 'beacon', { verify: Tool; display: Tool; spctl: Tool; syspolicy: Tool }>
  daemon: Record<string, { status: number; json: Record<string, unknown> } & Record<string, unknown>>
}
const APP = JSON.parse(readFileSync('src/main/fixtures/prometheus_app_695.json', 'utf8')) as AppFixture
const LOCAL = JSON.parse(readFileSync('src/main/fixtures/pair_local_696.json', 'utf8')) as Record<string, { status: number; json: Record<string, unknown> }>
const out = (t: Tool): string => t.stdout + t.stderr

// ── 1. the pure reading ───────────────────────────────────────────────────────────────────────────────────────────────────────
const SHA = 'a'.repeat(64)
const base = { version: '0.9.6', asset: 'Prometheus-0.9.6-arm64.zip', alias: 'Prometheus-mac-arm64.zip', sha256: SHA, size: 63432262, team_id: '53JM8W47RL', bundle_id: 'com.oaralabs.prometheus', min_macos: '13.0', arch: 'arm64', python: { version: '3.12.13' }, extras: [], without: ['pymupdf'], lock_sha256: SHA }
const m = parseManifest(base)
assert(m?.version === '0.9.6' && m.asset === 'Prometheus-0.9.6-arm64.zip' && m.sha256 === SHA && m.size === 63432262 && m.teamId === '53JM8W47RL', 'manifest: the shape #695\'s build writes is read (version, the versioned asset, sha256, size; team for display)')
assert(parseManifest({ ...base, asset: undefined })?.asset === 'Prometheus-mac-arm64.zip', 'manifest: without an asset, the stable alias')
assert(
  [
    { ...base, sha256: SHA.toUpperCase() },
    { ...base, sha256: 'a'.repeat(63) },
    { ...base, size: 0 },
    { ...base, size: MAX_ZIP_BYTES + 1 },
    { ...base, size: 1.5 },
    { ...base, asset: '../Prometheus-0.9.6-arm64.zip' },
    { ...base, asset: 'https://evil.example/Prometheus-0.9.6-arm64.zip' },
    { ...base, asset: 'Prometheus-0.9.6-x86_64.zip' },
    { ...base, version: '0.9.6/../../x' },
    [base],
    null
  ].every((v) => parseManifest(v) === null),
  'manifest: upper-case or short checksums, an empty, oversized or fractional size, an asset that is a path, a URL or another arch, a version with a path in it, and things that are not manifests are refused'
)

const GH = 'https://github.com/OAraLabs/Prometheus/releases/download/v0.9.6/prometheus-mac.json'
const ASSETS = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x'
assert(redirectAllowed(GH, null) && redirectAllowed(ASSETS, null) && redirectAllowed('https://objects.githubusercontent.com/x', null), 'redirects: GitHub\'s own hops (the tagged release, then its asset host) are followed')
assert(
  ['http://github.com/OAraLabs/Prometheus/releases/download/v1/x', 'https://github.com/someone/else/releases/download/v1/x', 'https://github.com/OAraLabs/Prometheus/archive/main.zip', 'https://evil.example/x', 'https://user:pw@github.com/OAraLabs/Prometheus/releases/x', 'https://github.com:8443/OAraLabs/Prometheus/releases/x', 'https://release-assets.githubusercontent.com.evil.example/x', 'not a url'].every((u) => !redirectAllowed(u, null)),
  'redirects: plain http, another repository, a path outside the releases, another host, a look-alike host, credentials in the address and another port are refused'
)
assert(redirectAllowed('http://127.0.0.1:5555/rel/download/v1/x', 'http://127.0.0.1:5555/rel') && !redirectAllowed(GH, 'http://127.0.0.1:5555/rel') && !redirectAllowed('http://127.0.0.1:5556/x', 'http://127.0.0.1:5555/rel'), 'redirects: with a probe\'s release override, only its own origin (not even GitHub)')
assert(folderOf(GH) === 'https://github.com/OAraLabs/Prometheus/releases/download/v0.9.6/' && folderOf('http://127.0.0.1:1/rel/x.json?y=1') === 'http://127.0.0.1:1/rel/', 'redirects: the zip is asked for in the folder the manifest came from')

assert(signingRequirement() === APP.requirement, 'requirement: the text Beacon builds is the one recorded against the real app', signingRequirement())
assert(/certificate leaf\[subject\.OU\] = "53JM8W47RL" or certificate leaf\[subject\.OU\] = "AAAAAAAAAA"/.test(signingRequirement(['53JM8W47RL', 'AAAAAAAAAA'])), 'requirement: a list of teams is any one of them')
const refuses = (teams: string[]): boolean => {
  try {
    signingRequirement(teams)
    return false
  } catch {
    return true
  }
}
assert(refuses([]) && refuses(['53JM8W47R']) && refuses(['53jm8w47rl']) && refuses(['53JM8W47RL" or anchor apple']), 'requirement: no team, a short or lower-case one, or one carrying requirement syntax is refused, not spliced in')
assert(PROMETHEUS_TEAM_IDS.length === 1 && PROMETHEUS_TEAM_IDS[0] === '53JM8W47RL', 'requirement: the pinned team is OAra Labs\' (Example Developer, 53JM8W47RL)')

const T = APP.tools
assert(T.real.verify.exit === 0 && [T.tampered, T.adhoc, T.calculator, T.beacon].every((x) => x.verify.exit !== 0), 'tools (recorded): codesign accepts the real app against the requirement, and refuses a tampered copy, an ad-hoc copy, Calculator.app and Beacon.app')
assert(T.tampered.verify.exit === 1 && T.adhoc.verify.exit === 3 && T.beacon.verify.exit === 3, 'tools (recorded): a broken seal is exit 1; a valid signature that is not OAra Labs\' Prometheus is exit 3 (Beacon.app: the right team, the wrong bundle id)')
const real = parseSignatureInfo(out(T.real.display))
assert(real.identifier === 'com.oaralabs.prometheus' && real.teamId === '53JM8W47RL' && real.stapled, 'tools (recorded): codesign -d on the real app reads its bundle id, its team and a stapled ticket')
assert(parseSignatureInfo(out(T.adhoc.display)).teamId === null && parseSignatureInfo(out(T.beacon.display)).identifier === 'com.oaralabs.beacon', 'tools (recorded): the ad-hoc copy has no team ("not set"), Beacon.app is com.oaralabs.beacon')
assert(spctlNotarized(T.real.spctl.exit, out(T.real.spctl)) && !spctlNotarized(T.adhoc.spctl.exit, out(T.adhoc.spctl)) && !spctlNotarized(T.tampered.spctl.exit, out(T.tampered.spctl)), 'tools (recorded): Gatekeeper accepts the real app as notarized, and rejects the ad-hoc and tampered copies')
assert(T.calculator.spctl.exit === 0 && !spctlNotarized(T.calculator.spctl.exit, out(T.calculator.spctl)), 'tools (recorded): Calculator.app is accepted by Gatekeeper with exit 0, as "Apple System": exit 0 alone would have passed it')
assert(!spctlNotarized(0, 'x.app: accepted\nsource=Unnotarized Developer ID') && !spctlNotarized(0, 'x.app: accepted\noverride=security disabled') && !spctlNotarized(1, 'x.app: accepted\nsource=Notarized Developer ID'), 'tools: a Developer ID app that was never notarized, Gatekeeper switched off, and a failing exit are not "notarized"')
assert(syspolicyPassed(T.real.syspolicy.exit, out(T.real.syspolicy)) && [T.tampered, T.adhoc, T.calculator].every((x) => !syspolicyPassed(x.syspolicy.exit, out(x.syspolicy))) && !syspolicyPassed(0, ''), 'tools (recorded): syspolicy_check passes the real app and fails the others; exit 0 without Apple\'s sentence is not a pass')

const line = (o: Record<string, unknown>): string => JSON.stringify({ ok: true, agent: 'com.oaralabs.prometheus.daemon', app_version: '0.9.6', detail: '', ...o }) + '\n'
assert(parseRegister(0, line({ state: 'registered' })).kind === 'registered' && parseRegister(0, line({ state: 'already_registered' })).kind === 'registered', 'launcher: exit 0 registered or already registered')
assert(
  parseRegister(10, line({ state: 'requires_approval' })).kind === 'requires-approval' &&
    parseRegister(11, line({ state: 'already_running' })).kind === 'already-running' &&
    parseRegister(12, line({ state: 'port_busy' })).kind === 'port-busy' &&
    parseRegister(13, line({ state: 'registration_failed', detail: 'x' })).kind === 'failed' &&
    parseRegister(14, line({ state: 'unsupported_os' })).kind === 'unsupported-os',
  'launcher: every exit code of the contract means what the table says'
)
assert(parseRegister(0, line({ state: 'usage' })).kind === 'failed' && parseRegister(0, 'garbage').kind === 'failed' && parseRegister(null, '').kind === 'failed' && parseRegister(99, line({ state: 'registered' })).kind === 'failed', 'launcher: exit 0 without a registered state, no JSON, a killed process, and a code outside the table are failures')
const LP = APP.daemon.launcher_pair as unknown as { exit: number; lines: number; escapes_slashes: boolean; json: Record<string, unknown> }
const HOME = '/Users/someone'
const recordedLine = JSON.stringify({ ...LP.json, path: String(LP.json.path).replace('<home>', HOME) }).replace(/\//g, '\\/') + '\n'
const expected = join(HOME, PAIR_SECRET_IN_HOME)
assert(LP.exit === 0 && LP.lines === 1 && LP.escapes_slashes && parsePairWritten(LP.exit, recordedLine, expected) === expected, 'launcher (recorded): --pair prints one line (slashes escaped, as Foundation writes them) naming the file Beacon expects')
assert(parsePairWritten(0, recordedLine, '/Users/other/' + PAIR_SECRET_IN_HOME) === null && parsePairWritten(13, recordedLine, expected) === null && parsePairWritten(0, line({ state: 'pair_failed', path: expected }), expected) === null, 'launcher: a --pair that names another file, fails, or says something else is not used')

const D = APP.daemon
assert(daemonStateFrom({ status: D.setup_status.status, json: D.setup_status.json }, null) === 'setup', 'daemon (recorded): setup mode is recognised')
assert(daemonStateFrom({ status: D.configured_setup_status.status, json: D.configured_setup_status.json }, null) === 'configured' && daemonStateFrom(null, { status: D.configured_status.status, json: D.configured_status.json }) === 'configured', 'daemon (recorded): a configured daemon is recognised by its 401 (it says "unauthorized" and names Bearer)')
assert(daemonStateFrom({ status: 200, json: { setup_mode: 'true' } }, { status: 401, json: { error: 'unauthorized' } }) === null && daemonStateFrom({ status: 200, json: null }, { status: 200, json: null }) === null, 'daemon: a look-alike (a string where the boolean belongs, a login wall without Bearer, a plain page) is not Prometheus')
const shape = D.secret_shape as unknown as { trimmed: number; base64url: boolean }
assert(shape.trimmed === 43 && shape.base64url && isPairSecret('A'.repeat(43)) && !isPairSecret('A'.repeat(31)) && !isPairSecret('A'.repeat(42) + '+') && !isPairSecret('123456') && !isPairSecret(''), 'secret (recorded): 43 base64url characters; a short one, a "+", six digits (the typed code) and nothing are not sent')
const sp = parseSecretPair(200, { token: 'x'.repeat(43), api_base_port: 5, ws_port: 55723 })
assert(D.setup_pair.status === 200 && Object.keys(D.setup_pair.json).sort().join(',') === 'api_base_port,token,ws_port' && sp.kind === 'paired' && sp.wsPort === 55723 && sp.revokedPrevious === null, 'pair (recorded, #695): setup mode answers token, api_base_port, ws_port; Beacon keeps the token and the WebSocket port')
const first = LOCAL.first as unknown as { status: number; json: Record<string, unknown>; is_the_global_token: boolean }
const local1 = parseSecretPair(200, { ...first.json, token: 't'.repeat(43) })
const local2 = parseSecretPair(200, { ...(LOCAL.second as unknown as { json: Record<string, unknown> }).json, token: 'u'.repeat(43) })
assert(first.status === 200 && !first.is_the_global_token && local1.kind === 'paired' && local1.revokedPrevious === 0 && local2.kind === 'paired' && local2.revokedPrevious === 1, 'pair (recorded, main with #696): the same-Mac route answers an owner credential (not the daemon\'s own token) and how many earlier ones it replaced')
assert((LOCAL.after_repair_first_token_status as unknown as number) === 401 && (LOCAL.first_token_status as unknown as number) === 200, 'pair (recorded, #696): pairing again revokes the credential the last pairing gave (it then answers 401)')
const again = parseSecretPair(D.setup_pair_again.status, D.setup_pair_again.json)
assert(D.setup_pair_again.status === 401 && again.kind === 'refused' && again.detail.includes('invalid_code'), 'pair (recorded): a secret already used is refused (401 invalid_code)')
assert(parseSecretPair(200, { token: '' }).kind === 'refused' && parseSecretPair(200, {}).kind === 'refused' && parseSecretPair(500, { token: 'x' }).kind === 'refused', 'pair: an empty token, no token, and a token beside an error status are not a connection')
const badWs = parseSecretPair(200, { token: 'x', ws_port: 70000 })
assert(badWs.kind === 'paired' && badWs.wsPort === null, 'pair: a WebSocket port that is not a port is not used')

const rel = installEnv({ BEACON_PROMETHEUS_RELEASE: 'http://127.0.0.1:5555/rel', BEACON_PROMETHEUS_HOME: '/tmp/x', BEACON_PROMETHEUS_LAUNCHER: '/tmp/l', BEACON_PROMETHEUS_START_MS: '3000' }, false)
assert(rel.releaseBase === RELEASE_BASE && !rel.overridden && rel.home === null && rel.launcher === null && rel.startTimeoutMs === START_TIMEOUT_MS, 'overrides: a release build ignores every one (GitHub, the person\'s own Applications, the app\'s own launcher, 60 s)')
const dev = installEnv({ BEACON_PROMETHEUS_RELEASE: 'http://127.0.0.1:5555/rel/', BEACON_PROMETHEUS_HOME: '/tmp/x', BEACON_PROMETHEUS_LAUNCHER: '/tmp/l', BEACON_PROMETHEUS_START_MS: '3000' }, true)
assert(dev.releaseBase === 'http://127.0.0.1:5555/rel' && dev.overridden && dev.home === '/tmp/x' && dev.launcher === '/tmp/l' && dev.startTimeoutMs === 3000, 'overrides: a dev or probe build may point each one elsewhere')
const bad = installEnv({ BEACON_PROMETHEUS_RELEASE: 'https://evil.example/rel', BEACON_PROMETHEUS_HOME: 'relative', BEACON_PROMETHEUS_LAUNCHER: 'prometheus', BEACON_PROMETHEUS_START_MS: '5' }, true)
assert(bad.releaseBase === RELEASE_BASE && bad.home === null && bad.launcher === null && bad.startTimeoutMs === START_TIMEOUT_MS, 'overrides: even there, a release server off this Mac, a relative path or an absurd timeout is ignored')
assert(stepState({ phase: 'running', step: 'check' }, 'get') === 'done' && stepState({ phase: 'running', step: 'check' }, 'check') === 'doing' && stepState({ phase: 'running', step: 'check' }, 'start') === 'todo' && stepState({ phase: 'failed', step: 'check' }, 'check') === 'failed' && INSTALL_STEPS.every((x) => stepState({ phase: 'done', step: 'connect' }, x) === 'done'), 'screen: steps before the current one are done, the current one is under way (or the one that failed), the rest to come')
// main hands the installer the overrides through the build flavour, never a constant: an environment variable must not be able to
// point a release build's launcher, home folder or release elsewhere. Read with comments stripped, so a comment quoting it cannot pass.
const mainSrc = readFileSync('src/main/index.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
assert(/env: installEnv\(process\.env, debuggingAllowedHere\(\)\)/.test(mainSrc) && /port: discoveryEnv\(process\.env, debuggingAllowedHere\(\)\)\.port/.test(mainSrc) && /registerPathAHandlers\(prometheusInstaller\)/.test(mainSrc), 'main: the installer\'s overrides and port are gated by the build flavour, and its handlers are registered')
assert(formatMB(34_000_000) === '34' && formatMB(1_234_567) === '1.2' && formatMB(63_432_262) === '63', 'screen: sizes in megabytes, one decimal under 10')

// ── 2. the installer, in a world of fakes ─────────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'prometheus-install-smoke-'))
const BASE = 'http://127.0.0.1:5555/rel'
const TAG = `${BASE}/download/v0.9.6`
const PORT = 55001
interface ZipEntry {
  name: string
  data?: Buffer | string
  mode?: number
}
/** A minimal zip (stored entries, unix modes; no CRC, which nothing here reads): enough to build the zips these checks are about
 *  without a zip tool, so the smoke runs anywhere. */
function zipOf(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE((3 << 8) | 20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const APP_ENTRIES: ZipEntry[] = [{ name: 'Prometheus.app/' }, { name: 'Prometheus.app/Contents/' }, { name: 'Prometheus.app/Contents/MacOS/Prometheus', data: randomBytes(300_000) }, { name: 'Prometheus.app/Contents/Resources/python/bin/python3', data: 'python3.12', mode: 0o120755 }]
const ZIP = zipOf(APP_ENTRIES)
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex')
const TOKEN = 'TOKEN' + randomBytes(16).toString('hex')
const real3 = (k: 'display' | 'spctl' | 'syspolicy'): ExecResult => ({ exit: T.real[k].exit, stdout: T.real[k].stdout, stderr: T.real[k].stderr })

interface World {
  home: string
  tmp: string
  log: string[]
  views: InstallView[]
  saved: SavedLocal[]
  activated: number
  daemon: 'off' | 'setup' | 'configured'
  secret: string | null
  installer: PrometheusInstaller
  clock: { t: number }
}
interface Opts {
  manifest?: Record<string, unknown>
  zip?: Buffer
  contentLength?: number
  redirectTo?: string
  /** codesign --verify's exit, by which copy is being checked. */
  verify?: (path: string) => number
  spctl?: ExecResult
  syspolicyExit?: number
  macos?: number | null
  register?: ExecResult
  /** What starts when the launcher registers: the daemon in setup mode (default), a configured one, or nothing. */
  starts?: 'setup' | 'configured' | 'nothing'
  unpack?: 'ok' | 'two' | 'symlink'
  secretMode?: number
  pairStatus?: number
  saveThrows?: boolean
  stallZip?: boolean
  existingApp?: boolean
  /** What GET /api/hello answers: the daemon's own (default), nothing (a Prometheus before #697), another agent's name, no
   *  fingerprint, or something that is not a hello at all. */
  hello?: 'ok' | 'missing' | 'renamed' | 'stranger'
  /** pair.fp beside the secret. Undefined: what the daemon writes (its fingerprint when configured, nothing in setup mode); null:
   *  no file; a string: that content (a stale or foreign one). */
  pairFp?: string | null
  pairFpMode?: number
  /** The release as GitHub really serves it (RELEASE_BASE, no override): latest → the versioned folder → an opaque, signed URL on
   *  the asset host, which refuses any request without its token (HTTP 618 jwt-not-provided, as it answered Beacon 0.4.0). */
  github?: boolean
  /** macOS's version ("15.3"); undefined: unknown. */
  macosVersion?: string
}
const HELLO_CONFIGURED = (LOCAL.hello as unknown as { json: Record<string, unknown> }).json
// What setup mode really says (recorded from Prometheus #695, src/main/fixtures/pair_fp_695.json): no instance key yet, so fp "", and no pair.fp.
const HELLO_SETUP = { v: '0.9.6', name: 'Prometheus', agent: 'Prometheus', fp: '', pair: 'code', tls: false }

/** What the asset host answers a request without its token. The Response constructor only takes 200 to 599, and the network's own
 *  Response does carry 618: a real Response, reporting 618. */
function status618(): Response {
  const r = new Response('<title>618 jwt:jwt-not-provided</title>', { status: 400 })
  return new Proxy(r, { get: (t, k) => (k === 'status' ? 618 : k === 'ok' ? false : typeof Reflect.get(t, k) === 'function' ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k)) })
}

function world(o: Opts = {}): World {
  const dir = mkdtempSync(join(root, 'w-'))
  const home = join(dir, 'home')
  const tmp = join(dir, 'tmp')
  mkdirSync(home)
  mkdirSync(tmp)
  const w = { home, tmp, log: [] as string[], views: [] as InstallView[], saved: [] as SavedLocal[], activated: 0, daemon: 'off', secret: null, clock: { t: 0 } } as unknown as World
  const app = join(home, 'Applications/Prometheus.app')
  const secretPath = join(home, PAIR_SECRET_IN_HOME)
  const writeSecret = (): void => {
    const d = join(home, 'Library/Application Support/Prometheus/pairing')
    mkdirSync(d, { recursive: true })
    chmodSync(d, 0o700)
    w.secret = randomBytes(32).toString('base64url')
    writeFileSync(join(d, 'pair.secret'), w.secret + '\n')
    chmodSync(join(d, 'pair.secret'), o.secretMode ?? 0o600)
  }
  const makeApp = (at: string): void => {
    mkdirSync(join(at, 'Contents/MacOS'), { recursive: true })
    writeFileSync(join(at, 'Contents/MacOS/Prometheus'), '#!/bin/sh\n')
  }
  if (o.existingApp) makeApp(app)
  const manifest = { version: '0.9.6', asset: 'Prometheus-0.9.6-arm64.zip', sha256: ZIP_SHA, size: ZIP.length, team_id: '53JM8W47RL', ...o.manifest }
  const fetchFake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    w.log.push(`fetch ${u}`)
    if (o.github) {
      // GitHub's real chain (traced 2026-10-11 against v0.9.7): each hop answered only where GitHub answers it.
      const GH_REL = 'https://github.com/OAraLabs/Prometheus/releases'
      const ASSETS = 'https://release-assets.githubusercontent.com/github-production-release-asset/1216470012/'
      const signed: Record<string, string> = { [`${GH_REL}/download/v0.9.7/prometheus-mac.json`]: 'm-0f3c?sp=r&sig=TOKEN-M', [`${GH_REL}/download/v0.9.7/${manifest.asset}`]: 'z-9a71?sp=r&sig=TOKEN-Z' }
      if (u === `${GH_REL}/latest/download/prometheus-mac.json`) return new Response(null, { status: 302, headers: { location: `${GH_REL}/download/v0.9.7/prometheus-mac.json` } })
      if (u === `${GH_REL}/latest/download/${manifest.asset}`) return new Response(null, { status: 302, headers: { location: `${GH_REL}/download/v0.9.7/${manifest.asset}` } })
      if (signed[u]) return new Response(null, { status: 302, headers: { location: ASSETS + signed[u] } })
      if (u.startsWith(ASSETS)) {
        if (u === ASSETS + signed[`${GH_REL}/download/v0.9.7/prometheus-mac.json`]) return new Response(JSON.stringify(manifest), { status: 200 })
        if (u !== ASSETS + signed[`${GH_REL}/download/v0.9.7/${manifest.asset}`]) return status618()
      } else return new Response('Not Found', { status: 404 })
    }
    if (u === `${BASE}/prometheus-mac.json`) return new Response(null, { status: 302, headers: { location: o.redirectTo ?? `${TAG}/prometheus-mac.json` } })
    if (u === `${TAG}/prometheus-mac.json`) return new Response(JSON.stringify(manifest), { status: 200 })
    if (u === `${TAG}/${manifest.asset}` || (o.github && u.includes('sig=TOKEN-Z'))) {
      const bytes = o.zip ?? ZIP
      const signal = init?.signal
      let at = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (o.stallZip && at > 0) return new Promise<void>((_r, reject) => signal?.addEventListener('abort', () => (c.error(new Error('aborted')), reject(new Error('aborted')))))
          c.enqueue(new Uint8Array(bytes.subarray(at, at + 65536)))
          at += 65536
          if (at >= bytes.length) c.close()
          return undefined
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-length': String(o.contentLength ?? bytes.length) } })
    }
    return new Response('no', { status: 404 })
  }
  const exec: ExecFn = async (file, args) => {
    w.log.push(`exec ${file.split('/').pop()} ${args.filter((a) => !a.startsWith('-R=')).join(' ')}`)
    if (file === '/usr/bin/ditto' && args[0] === '-x') {
      if (!readFileSync(args[2]).equals(o.zip ?? ZIP)) return { exit: 1, stdout: '', stderr: 'not the bytes that were downloaded' }
      const dest = args[3]
      if (o.unpack === 'symlink') symlinkSync(join(root, 'elsewhere'), join(dest, 'Prometheus.app'))
      else makeApp(join(dest, 'Prometheus.app'))
      if (o.unpack === 'two') makeApp(join(dest, 'Other.app'))
      return { exit: 0, stdout: '', stderr: '' }
    }
    if (file === '/usr/bin/codesign' && args[0] === '--verify') return { exit: o.verify ? o.verify(args[args.length - 1]) : 0, stdout: '', stderr: 'codesign said so' }
    if (file === '/usr/bin/codesign') return real3('display')
    if (file === '/usr/sbin/spctl') return o.spctl ?? real3('spctl')
    if (file === '/usr/bin/syspolicy_check') return o.syspolicyExit === undefined ? real3('syspolicy') : { exit: o.syspolicyExit, stdout: '', stderr: '' }
    if (file.endsWith('Contents/MacOS/Prometheus') && args[0] === '--register') {
      const r = o.register ?? { exit: 0, stdout: line({ state: 'registered' }), stderr: '' }
      if (r.exit === 0) {
        const starts = o.starts ?? 'setup'
        if (starts !== 'nothing') w.daemon = starts
        if (starts === 'setup') writeSecret()
        // The daemon writes pair.fp at boot from its key: a configured one has a key, setup mode does not (and removes an old file).
        const fp = o.pairFp === undefined ? (starts === 'configured' ? String(HELLO_CONFIGURED.fp) : null) : o.pairFp
        if (starts !== 'nothing' && fp !== null) {
          const d = join(home, 'Library/Application Support/Prometheus/pairing')
          mkdirSync(d, { recursive: true })
          chmodSync(d, 0o700)
          writeFileSync(join(d, 'pair.fp'), fp + '\n')
          chmodSync(join(d, 'pair.fp'), o.pairFpMode ?? 0o600)
        }
      }
      return r
    }
    if (file.endsWith('Contents/MacOS/Prometheus') && args[0] === '--pair') {
      writeSecret()
      return { exit: 0, stdout: line({ state: 'pair_secret_written', path: secretPath }), stderr: '' }
    }
    return { exit: null, stdout: '', stderr: `no fake for ${file}` }
  }
  const request = async (r: HttpRequest): Promise<HttpResult> => {
    w.log.push(`request ${r.method} ${r.url}${r.body ? ` ${r.body}` : ''}`)
    const path = new URL(r.url).pathname
    if (!r.url.startsWith(`http://127.0.0.1:${PORT}/`)) return 'unreachable'
    if (w.daemon === 'off') return 'unreachable'
    if (r.method === 'GET' && path === '/api/hello') {
      if (o.hello === 'missing') return { status: 403, json: { error: 'setup_mode' }, retryAfter: null }
      if (o.hello === 'stranger') return { status: 200, json: { status: 'ok' }, retryAfter: null }
      const h = { ...(w.daemon === 'setup' ? HELLO_SETUP : HELLO_CONFIGURED), ...(o.hello === 'renamed' ? { agent: 'Atlas' } : {}) }
      return { status: 200, json: h, retryAfter: null }
    }
    if (r.method === 'GET' && path === '/api/setup/status') return w.daemon === 'setup' ? { status: 200, json: D.setup_status.json, retryAfter: null } : { status: 401, json: D.configured_status.json, retryAfter: null }
    if (r.method === 'GET' && path === '/api/status') return { status: 401, json: D.configured_status.json, retryAfter: null }
    if (r.method === 'POST' && (path === '/api/setup/pair' || path === '/api/pair/local')) {
      const code = (JSON.parse(r.body ?? '{}') as { code?: string }).code
      if (o.pairStatus && o.pairStatus !== 200) return { status: o.pairStatus, json: { error: 'invalid_code' }, retryAfter: null }
      if (!w.secret || code !== w.secret || (path === '/api/setup/pair') !== (w.daemon === 'setup')) return { status: 401, json: { error: 'invalid_code' }, retryAfter: null }
      w.secret = null
      rmSync(secretPath, { force: true })
      return { status: 200, json: { token: TOKEN, api_base_port: 8005, ws_port: 55002, ...(path === '/api/pair/local' ? { revoked_previous: 0 } : {}) }, retryAfter: null }
    }
    return { status: 404, json: null, retryAfter: null }
  }
  const deps: InstallDeps = {
    env: o.github ? { releaseBase: RELEASE_BASE, overridden: false, home: null, launcher: null, startTimeoutMs: 60_000 } : { releaseBase: BASE, overridden: true, home: null, launcher: null, startTimeoutMs: 60_000 },
    port: PORT,
    home,
    tmp,
    macosMajor: o.macos === undefined ? 15 : o.macos,
    macosVersion: o.macosVersion ?? null,
    fetch: fetchFake as typeof fetch,
    exec,
    request,
    now: () => w.clock.t,
    sleep: async (ms) => {
      w.clock.t += ms
      await new Promise((r) => setImmediate(r))
    },
    save: (c) => {
      w.log.push('save')
      if (o.saveThrows) throw new Error('the keychain said no')
      w.saved.push(c)
    },
    activate: () => {
      w.log.push('activate')
      w.activated++
    },
    publish: (v) => w.views.push(v)
  }
  w.installer = new PrometheusInstaller(deps)
  return w
}
async function settle(w: World, until: (v: InstallView) => boolean = (v) => v.phase === 'done' || v.phase === 'failed'): Promise<InstallView> {
  for (let i = 0; i < 4000; i++) {
    if (until(w.installer.current()) && !(w.installer as unknown as { running: unknown }).running) return w.installer.current()
    if (until(w.installer.current()) && w.installer.current().failure?.kind === 'approval') return w.installer.current()
    await new Promise((r) => setTimeout(r, 1))
  }
  return w.installer.current()
}
const appIn = (w: World): string => join(w.home, 'Applications/Prometheus.app')
const leftovers = (w: World): string[] => readdirSync(w.tmp)
const at = (w: World, needle: string): number => w.log.findIndex((l) => l.includes(needle))
const lastAt = (w: World, needle: string): number => w.log.map((l, i) => (l.includes(needle) ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
const ran = (w: World): boolean => w.log.some((l) => l.includes('Prometheus --register') || l.includes('Prometheus --pair'))
const kind = (v: InstallView): string => v.failure?.kind ?? v.phase

async function main(): Promise<void> {
  // ── the zip's table of contents, and the hello ──
  const TOP = 'Prometheus.app'
  assert(
    unsafeEntryName('Prometheus.app/', TOP) === null &&
      unsafeEntryName('Prometheus.app/Contents/MacOS/Prometheus', TOP) === null &&
      ['../escaped', 'Prometheus.app/../../escaped', 'Prometheus.app/a/../../../b', '/etc/escaped', 'C:/escaped', 'Prometheus.app\\..\\x', 'Other.app/x', 'Prometheus.appX/x', 'Prometheus.app/a\0b', ''].every((n) => unsafeEntryName(n, TOP) !== null),
    'zip: names inside the app pass; a "..", an absolute path, a drive letter, a backslash, a NUL, a look-alike or another folder do not'
  )
  assert(
    unsafeLinkTarget('Prometheus.app/Contents/Resources/python/bin/python3', 'python3.12', TOP) === null &&
      unsafeLinkTarget('Prometheus.app/Contents/a/b', '../c', TOP) === null &&
      ['/usr/bin/python3', '../../..', '../../../escaped', '', '..'].every((t) => unsafeLinkTarget('Prometheus.app/a', t, TOP) !== null),
    'zip: a link inside the app (the bundle\'s own python3 -> python3.12) passes; one that is absolute or climbs out of it does not'
  )
  const zdir = mkdtempSync(join(tmpdir(), 'prometheus-zip-smoke-'))
  writeFileSync(join(zdir, 'ok.zip'), ZIP)
  writeFileSync(join(zdir, 'junk.zip'), randomBytes(5000))
  const okToc = await checkZipEntries(join(zdir, 'ok.zip'), TOP)
  const junkToc = await checkZipEntries(join(zdir, 'junk.zip'), TOP)
  rmSync(zdir, { recursive: true, force: true })
  assert(okToc.ok && okToc.entries === APP_ENTRIES.length && okToc.links === 1 && !junkToc.ok, 'zip: the table of contents is read entry by entry (links counted and their targets read); bytes that are not a zip are refused', JSON.stringify([okToc, junkToc]))
  const H = (o: Record<string, unknown>, d: 'setup' | 'configured'): string | null => helloRefusal(helloFrom(o), d)
  assert(
    H(HELLO_SETUP, 'setup') === null &&
      H(HELLO_CONFIGURED, 'configured') === null &&
      H({ ...HELLO_CONFIGURED, agent: 'Atlas' }, 'configured') === null &&
      H({ ...HELLO_SETUP, agent: 'Atlas' }, 'setup') !== null &&
      H({ ...HELLO_SETUP, pair: 'token' }, 'setup') !== null &&
      H({ ...HELLO_SETUP, v: '' }, 'setup') !== null &&
      H(HELLO_SETUP, 'setup') === null &&
      helloRefusal(null, 'configured') !== null,
    'hello (recorded from a configured daemon): setup mode must say agent "Prometheus" and pair by code; any daemon must give a version; a configured one may name its agent anything; a fresh install\'s fp "" is fine'
  )
  const FPREC = JSON.parse(readFileSync('src/main/fixtures/pair_fp_695.json', 'utf8')) as { looks: { at: string; hello_fp: string; pair_fp_file: string | null }[] }
  const fileOf = (l: { pair_fp_file: string | null }): string => (l.pair_fp_file === null ? '' : (JSON.parse(l.pair_fp_file) as string).trim())
  assert(
    FPREC.looks.length === 4 && FPREC.looks[0].hello_fp === '' && FPREC.looks[0].pair_fp_file === null && /^[0-9a-f]{16}$/.test(FPREC.looks[2].hello_fp) && FPREC.looks.every((l) => fingerprintMismatch(l.hello_fp, fileOf(l)) === null) &&
      fingerprintMismatch('', 'abcdefabcdefabcd') !== null && fingerprintMismatch('abcdefabcdefabcd', '') !== null && fingerprintMismatch(undefined, '') !== null && fingerprintMismatch('ABCDEFABCDEFABCD', 'abcdefabcdefabcd') !== null,
    'fingerprint (recorded from Prometheus #695): a fresh install says fp "" with no pair.fp, a configured daemon says the same fingerprint in both, and every recorded stage agrees; a file without a hello fp, a hello fp without a file, no fp field, or another case is a mismatch',
    JSON.stringify(FPREC.looks.map((l) => [l.at, l.hello_fp, l.pair_fp_file]))
  )

  // ── the whole path ──
  const w = world()
  w.installer.start()
  const done = await settle(w)
  assert(done.phase === 'done' && done.daemon === 'setup' && done.placed, 'installer: the whole path ends connected to a new install (still to be set up)', JSON.stringify(done))
  const fetched = w.log.filter((l) => l.startsWith('fetch '))
  assert(JSON.stringify(fetched) === JSON.stringify([`fetch ${BASE}/prometheus-mac.json`, `fetch ${TAG}/prometheus-mac.json`, `fetch ${TAG}/Prometheus-0.9.6-arm64.zip`]), 'installer: the zip is asked for in the folder the manifest resolved to (one release, not "latest" twice)', JSON.stringify(fetched))
  const verifies = w.log.filter((l) => l.startsWith('exec codesign --verify'))
  assert(verifies.length === 2 && verifies[0].includes('/unpacked/Prometheus.app') && verifies[1].endsWith(appIn(w)), 'installer: the app is verified before it is moved, and again where it landed', JSON.stringify(verifies))
  assert(at(w, 'Prometheus --register') > lastAt(w, 'exec syspolicy_check') && at(w, 'Prometheus --register') > lastAt(w, 'exec codesign') && w.log.filter((l) => l.includes('--register')).length === 1, 'installer: the launcher runs once, after the last check has passed')
  assert(existsSync(appIn(w)) && leftovers(w).length === 0, 'installer: the app is in Applications and the download is gone from the temporary folder', JSON.stringify(leftovers(w)))
  const sent = w.log.filter((l) => l.startsWith('request POST'))
  assert(sent.length === 1 && sent[0].startsWith(`request POST http://127.0.0.1:${PORT}/api/setup/pair `) && !existsSync(join(w.home, PAIR_SECRET_IN_HOME)), 'installer: the secret goes to 127.0.0.1 only, to the setup-mode pairing route, and is used (the daemon deletes it)', JSON.stringify(sent.map((s) => s.slice(0, 60))))
  assert(w.saved.length === 1 && w.saved[0].token === TOKEN && w.saved[0].gateway.apiBase === `http://127.0.0.1:${PORT}` && w.saved[0].gateway.wsUrl === 'ws://127.0.0.1:55002' && at(w, 'activate') > at(w, 'save'), 'installer: the credential is kept with the port Beacon reached (not the 8005 the daemon named) and its WebSocket port, then brought up', JSON.stringify(w.saved.map((s) => s.gateway)))
  const gets = w.views.filter((v) => v.step === 'get' && v.total === ZIP.length).map((v) => v.received)
  assert(gets.length >= 2 && gets[gets.length - 1] === ZIP.length && gets.every((x, i) => i === 0 || x >= gets[i - 1]), 'installer: the download says how much of how much, rising to the whole', JSON.stringify(gets.slice(0, 6)))
  const seen = JSON.stringify(w.views)
  assert(!seen.includes(TOKEN) && !seen.includes(String(w.log.find((l) => l.includes('/api/setup/pair'))?.match(/"code":"([^"]+)"/)?.[1] ?? '@@')), 'installer: no update the page is sent carries the credential or the secret')
  const helloAt = at(w, `request GET http://127.0.0.1:${PORT}/api/hello`)
  assert(helloAt >= 0 && helloAt < at(w, 'request POST'), 'installer: before the secret is sent, the daemon is asked who it is (GET /api/hello)', JSON.stringify(w.log.filter((l) => l.startsWith('request')).map((l) => l.slice(0, 60))))
  w.installer.start()
  await new Promise((r) => setTimeout(r, 20))
  assert(w.log.filter((l) => l.includes('--register')).length === 1 && w.installer.current().phase === 'done', 'installer: start() after it is done does not run anything again')

  // ── a zip whose entries would land outside the folder it is unpacked into ──
  const inside: ZipEntry[] = [{ name: 'Prometheus.app/' }, { name: 'Prometheus.app/Contents/MacOS/Prometheus', data: 'x' }]
  for (const [label, extra, why] of [
    ['a ".." entry', { name: 'Prometheus.app/../../escaped' }, /climbs out/],
    ['an absolute path', { name: '/tmp/escaped' }, /absolute/],
    ['an entry outside the app', { name: 'Other.app/escaped' }, /not inside/],
    ['a link that points out of the app', { name: 'Prometheus.app/out', data: '../../..', mode: 0o120755 }, /points outside/]
  ] as const) {
    const z = zipOf([...inside, extra])
    const zw = world({ zip: z, manifest: { sha256: sha256Of(z), size: z.length } })
    zw.installer.start()
    const v = await settle(zw)
    assert(kind(v) === 'unsafe' && why.test(v.failure?.details ?? '') && at(zw, 'exec ditto') === -1 && !ran(zw) && !existsSync(appIn(zw)) && leftovers(zw).length === 0, `zip: ${label} is refused before anything is unpacked (ditto never runs)`, v.failure?.details)
  }

  // ── the secret goes only to a daemon that says it is one ──
  for (const [label, hello] of [
    ['a setup-mode daemon whose hello names another agent', 'renamed'],
    ['a daemon with no hello (403, as a Prometheus from before #697 answers)', 'missing'],
    ['a setup-mode daemon beside a pair.fp that is not its fingerprint (another daemon\'s, or a stale one)', 'stale'],
    ['an answer that is not a hello', 'stranger']
  ] as const) {
    const hw = hello === 'stale' ? world({ pairFp: '0123456789abcdef' }) : world({ hello })
    hw.installer.start()
    const v = await settle(hw)
    assert(kind(v) === 'refused' && /hello/.test(v.failure?.details ?? '') && !hw.log.some((l) => l.startsWith('request POST')) && hw.saved.length === 0 && existsSync(join(hw.home, PAIR_SECRET_IN_HOME)), `hello: ${label}: the secret is not sent, and stays where it is`, v.failure?.details)
  }
  // ── pair.fp beside the secret: compared with hello's fp as plain strings, a missing file being "" ──
  // Each case must be refused for ITS reason: a configured daemon's missing file mismatches anyway, so the details say which rule spoke.
  for (const [label, o, why] of [
    ['a configured daemon with no pair.fp (its hello has a fingerprint, the file says nothing)', { starts: 'configured', pairFp: null }, /pair\.fp says ""/],
    ['a configured daemon whose pair.fp names another fingerprint', { starts: 'configured', pairFp: 'ffffffffffffffff' }, /pair\.fp says "ffffffffffffffff"/],
    ['a pair.fp that others can read, beside a configured daemon', { starts: 'configured', pairFpMode: 0o644 }, /cannot be trusted/],
    ['an empty pair.fp that others can read, beside setup mode (read as "", it would have matched)', { pairFp: '', pairFpMode: 0o644 }, /cannot be trusted/]
  ] as const) {
    const fw = world(o as Opts)
    fw.installer.start()
    const fv = await settle(fw)
    assert(kind(fv) === 'refused' && why.test(fv.failure?.details ?? '') && !fw.log.some((l) => l.startsWith('request POST') || l.includes('Prometheus --pair')), `fingerprint: ${label}: no secret is written or sent`, fv.failure?.details)
  }
  const renamedConf = world({ starts: 'configured', hello: 'renamed' })
  renamedConf.installer.start()
  const rc = await settle(renamedConf)
  assert(rc.phase === 'done' && rc.daemon === 'configured' && renamedConf.saved.length === 1, 'hello: a configured daemon whose owner named the assistant is connected (its hello names the assistant, not the product)', JSON.stringify(rc.failure))

  // ── the checks refuse ──
  const sha = world({ manifest: { sha256: 'b'.repeat(64) } })
  sha.installer.start()
  const s1 = await settle(sha)
  assert(kind(s1) === 'unsafe' && /sha256/.test(s1.failure?.details ?? '') && at(sha, 'ditto') === -1 && !ran(sha) && !existsSync(appIn(sha)) && leftovers(sha).length === 0, 'refuse: bytes that do not match the manifest\'s sha256 are not even unpacked, and are deleted', s1.failure?.details)
  const len = world({ contentLength: ZIP.length + 5 })
  len.installer.start()
  assert(kind(await settle(len)) === 'unsafe' && at(len, 'ditto') === -1 && leftovers(len).length === 0, 'refuse: a download whose length is not the manifest\'s size is stopped before it is written')
  const longer = world({ zip: Buffer.concat([ZIP, Buffer.from('x')]), contentLength: ZIP.length })
  longer.installer.start()
  assert(kind(await settle(longer)) === 'unsafe' && at(longer, 'ditto') === -1, 'refuse: bytes beyond the manifest\'s size are refused as they arrive')
  // ── the release as GitHub serves it (the field failure of Beacon 0.4.0, 2026-10-11) ──
  const gh = world({ github: true, macosVersion: '15.3', manifest: { version: '0.9.7', asset: 'Prometheus-0.9.7-arm64.zip', min_macos: '13.0' } })
  gh.installer.start()
  const g1 = await settle(gh)
  const asked = gh.log.filter((l) => l.startsWith('fetch ')).map((l) => l.slice(6))
  const built = asked.filter((u) => u.includes('githubusercontent.com') && !u.includes('sig=TOKEN-'))
  assert(
    g1.phase === 'done' && built.length === 0 && asked.find((u) => u.includes('Prometheus-0.9.7-arm64.zip')) === 'https://github.com/OAraLabs/Prometheus/releases/download/v0.9.7/Prometheus-0.9.7-arm64.zip' && asked.some((u) => u.includes('sig=TOKEN-Z')),
    "GitHub's real chain: the zip is asked for in the github.com release folder and reached by its own signed redirect; no address is ever built on the asset host",
    JSON.stringify({ phase: g1.phase, failure: g1.failure, asked })
  )
  const oldMac = world({ github: true, macosVersion: '12.7.4', manifest: { version: '0.9.7', asset: 'Prometheus-0.9.7-arm64.zip', min_macos: '13.0' } })
  oldMac.installer.start()
  const o1 = await settle(oldMac)
  const oldCard = (COPY.main.aInst as unknown as Record<string, { title?: string; body?: string } | undefined>).oldMacos
  assert(
    String(kind(o1)) === 'old-macos' && /13\.0/.test(o1.failure?.details ?? '') && /12\.7\.4/.test(o1.failure?.details ?? '') && !oldMac.log.some((l) => l.startsWith('fetch') && l.includes('.zip')) && !!oldCard?.title && /macOS/.test(oldCard.body ?? ''),
    "min_macos: a Mac older than the release needs is told so (its own card; Copy details names both versions), before the zip is downloaded",
    JSON.stringify({ kind: kind(o1), details: o1.failure?.details, oldCard })
  )
  const mm = (v: unknown) => parseManifest({ version: '0.9.7', asset: 'Prometheus-0.9.7-arm64.zip', sha256: ZIP_SHA, size: 10, min_macos: v })
  assert(mm('13.0')?.minMacos === '13.0' && mm(undefined)?.minMacos === null && mm('thirteen') === null && mm(13) === null && mm('13.0; rm') === null, 'min_macos: read from the manifest when it is a version; a manifest with one that is not is not read at all', JSON.stringify([mm('13.0'), mm('thirteen')]))
  const newer = world({ github: true, macosVersion: '13.0', manifest: { version: '0.9.7', asset: 'Prometheus-0.9.7-arm64.zip', min_macos: '13.0' } })
  newer.installer.start()
  const tenTen = world({ github: true, macosVersion: '10.15.7', manifest: { version: '0.9.7', asset: 'Prometheus-0.9.7-arm64.zip', min_macos: '10.9' } })
  tenTen.installer.start()
  const n1 = await settle(newer)
  const t1 = await settle(tenTen)
  assert(n1.phase === 'done' && t1.phase === 'done', 'min_macos: exactly the version needed, or a later one (compared as numbers, 10.15 after 10.9), goes ahead', JSON.stringify({ n1: kind(n1), t1: kind(t1), d: t1.failure?.details }))
  const hop = world({ redirectTo: 'https://evil.example/prometheus-mac.json' })
  hop.installer.start()
  const h1 = await settle(hop)
  assert(kind(h1) === 'download' && hop.log.filter((l) => l.startsWith('fetch')).length === 1, 'refuse: a redirect off the release\'s origin is not followed (the download card)', h1.failure?.details)
  const broken = world({ verify: () => 1 })
  broken.installer.start()
  const b1 = await settle(broken)
  assert(kind(b1) === 'unsafe' && /signature is broken/.test(b1.failure?.details ?? '') && !ran(broken) && !existsSync(appIn(broken)) && leftovers(broken).length === 0, 'refuse: a broken signature: the safety card, nothing moved, nothing run, nothing left', b1.failure?.details)
  const stranger = world({ verify: () => 3 })
  stranger.installer.start()
  const st1 = await settle(stranger)
  assert(kind(st1) === 'unsafe' && /not signed by OAra Labs/.test(st1.failure?.details ?? '') && !ran(stranger), 'refuse: a valid signature that is not OAra Labs\' Prometheus: the details say whose it is not', st1.failure?.details)
  const unnot = world({ spctl: { exit: 3, stdout: '', stderr: out(T.adhoc.spctl) } })
  unnot.installer.start()
  assert(kind(await settle(unnot)) === 'unsafe' && !ran(unnot) && !existsSync(appIn(unnot)), 'refuse: Gatekeeper not accepting it as notarized is the safety card')
  const sysp = world({ syspolicyExit: 70 })
  sysp.installer.start()
  assert(kind(await settle(sysp)) === 'unsafe' && !ran(sysp), 'refuse: syspolicy_check failing is the safety card (macOS 14 and later)')
  const old = world({ syspolicyExit: 70, macos: 13 })
  old.installer.start()
  assert((await settle(old)).phase === 'done' && at(old, 'syspolicy_check') === -1 && at(old, 'spctl') >= 0, 'refuse: on macOS 13, which has no syspolicy_check, Gatekeeper\'s verdict is the notarization check')
  const two = world({ unpack: 'two' })
  two.installer.start()
  assert(kind(await settle(two)) === 'unsafe' && at(two, 'codesign') === -1 && !ran(two), 'refuse: a zip that holds more than the one app is not checked further')
  const link = world({ unpack: 'symlink' })
  link.installer.start()
  assert(kind(await settle(link)) === 'unsafe' && !ran(link) && !existsSync(appIn(link)), 'refuse: a Prometheus.app that is a link to somewhere else is not followed')
  const moved = world({ verify: (p) => (p.includes('/unpacked/') ? 0 : 1) })
  moved.installer.start()
  const mv = await settle(moved)
  assert(kind(mv) === 'unsafe' && /after the move/.test(mv.failure?.details ?? '') && !existsSync(appIn(moved)) && !ran(moved), 'refuse: an app that fails where it landed is removed again, and never run')

  // ── an app already there ──
  const there = world({ existingApp: true })
  there.installer.start()
  assert((await settle(there)).phase === 'done' && !there.log.some((l) => l.startsWith('fetch')) && there.log.filter((l) => l.startsWith('exec codesign --verify')).length === 1, 'existing: an app in Applications that passes every check is used, with nothing downloaded')
  const strangerThere = world({ existingApp: true, verify: () => 3 })
  strangerThere.installer.start()
  const sx = await settle(strangerThere)
  assert(kind(sx) === 'place' && existsSync(appIn(strangerThere)) && !strangerThere.log.some((l) => l.startsWith('fetch')) && !ran(strangerThere), 'existing: one that fails the checks is left alone (not removed, not replaced, not run): the Applications card', sx.failure?.details)

  // ── the launcher says no ──
  for (const [code, state, card] of [
    [12, 'port_busy', 'in-the-way'],
    [11, 'already_running', 'in-the-way'],
    [13, 'registration_failed', 'not-started'],
    [14, 'unsupported_os', 'not-started']
  ] as const) {
    const l = world({ register: { exit: code, stdout: line({ ok: false, state, detail: 'from the launcher' }), stderr: '' } })
    l.installer.start()
    const v = await settle(l)
    assert(kind(v) === card && v.placed && (v.failure?.details ?? '').includes(state) && (v.failure?.details ?? '').includes('from the launcher'), `launcher: exit ${code} (${state}) is the "${card}" card, with what it said in the details`, v.failure?.details)
  }
  const silent = world({ starts: 'nothing' })
  silent.installer.start()
  const sl = await settle(silent)
  assert(kind(sl) === 'not-started' && silent.clock.t >= 60_000 && /within 60 s/.test(sl.failure?.details ?? ''), 'launcher: registered, but nothing answers in 60 s: "Prometheus didn\'t start"', sl.failure?.details)
  const appr = world({ register: { exit: 10, stdout: line({ ok: false, state: 'requires_approval' }), stderr: '' } })
  appr.installer.start()
  const ap = await settle(appr, (v) => v.failure?.kind === 'approval')
  assert(kind(ap) === 'approval' && ap.phase === 'failed', 'launcher: "requires approval" is the Login Items card')
  appr.installer.start()
  await new Promise((r) => setTimeout(r, 20))
  assert(appr.log.filter((l) => l.includes('--register')).length === 1, 'launcher: while it waits for the switch, start() again does not start a second run')
  appr.daemon = 'setup'
  const d = join(appr.home, 'Library/Application Support/Prometheus/pairing')
  mkdirSync(d, { recursive: true })
  chmodSync(d, 0o700)
  ;(appr as unknown as { secret: string }).secret = randomBytes(32).toString('base64url')
  writeFileSync(join(d, 'pair.secret'), appr.secret + '\n', { mode: 0o600 })
  const after = await settle(appr, (v) => v.phase === 'done')
  assert(after.phase === 'done' && after.failure === undefined && appr.saved.length === 1, 'launcher: …and once the person turns it on, Beacon carries on by itself and connects')

  // ── a Prometheus that was set up before ──
  const conf = world({ starts: 'configured' })
  conf.installer.start()
  const cv = await settle(conf)
  const localPost = conf.log.find((l) => l.startsWith('request POST'))
  assert(cv.phase === 'done' && cv.daemon === 'configured' && at(conf, 'Prometheus --pair') > at(conf, 'Prometheus --register'), 'configured: a daemon that is already set up is connected with a fresh secret from --pair', JSON.stringify(cv))
  assert(!!localPost && localPost.startsWith(`request POST http://127.0.0.1:${PORT}/api/pair/local `) && JSON.parse(localPost.slice(localPost.indexOf('{'))).name === LOCAL_DEVICE_NAME && conf.saved[0]?.token === TOKEN, 'configured: …to the same-Mac route, naming this Mac\'s credential, and the credential it answers is kept')
  assert(w.saved[0]?.credential === 'master' && conf.saved[0]?.credential === 'owner', 'credential: what A-inst keeps from a setup-mode daemon is marked the master token (a relaunch resumes at the trade, never the app); from a configured daemon, an owner credential', JSON.stringify([w.saved[0]?.credential, conf.saved[0]?.credential]))

  // ── the secret file is not one to trust ──
  const loose = world({ secretMode: 0o644 })
  loose.installer.start()
  const lv = await settle(loose)
  assert(kind(lv) === 'refused' && !loose.log.some((l) => l.startsWith('request POST')) && /open to others/.test(lv.failure?.details ?? ''), 'secret: a secret file others can read is not sent anywhere', lv.failure?.details)
  const wrong = world({ pairStatus: 401 })
  wrong.installer.start()
  const wv = await settle(wrong)
  assert(kind(wv) === 'refused' && wrong.saved.length === 0 && wrong.activated === 0, '"Beacon couldn\'t connect": the pairing route refusing keeps nothing', wv.failure?.details)
  const nosave = world({ saveThrows: true })
  nosave.installer.start()
  const nv = await settle(nosave)
  assert(kind(nv) === 'refused' && nosave.activated === 0 && /could not be kept/.test(nv.failure?.details ?? ''), '"Beacon couldn\'t connect": a credential that could not be kept is not brought up')
  const noLeak = [w, conf, loose, wrong, nosave, appr].every((x) => !JSON.stringify(x.views).includes(TOKEN))
  assert(noLeak, 'no update to the page, on any path, carries the credential')

  // ── going Back ──
  const stall = world({ stallZip: true })
  stall.installer.start()
  await settle(stall, (v) => v.received > 0)
  const c = await stall.installer.cancel()
  assert(c.phase === 'idle' && leftovers(stall).length === 0 && !existsSync(appIn(stall)) && !ran(stall), 'Back: stopping while it downloads ends the run, deletes what came, and moves and runs nothing', JSON.stringify(leftovers(stall)))
  const late = world({ starts: 'nothing' })
  late.installer.start()
  await settle(late, (v) => v.step === 'start' && v.placed)
  const lc = await late.installer.cancel()
  assert(lc.phase === 'idle' && existsSync(appIn(late)), 'Back: once the app is in Applications, stopping only stops the waiting: Prometheus stays installed')
  const retry = world({ register: { exit: 12, stdout: line({ ok: false, state: 'port_busy' }), stderr: '' } })
  retry.installer.start()
  await settle(retry)
  retry.installer.start()
  await settle(retry)
  assert(retry.log.filter((l) => l.startsWith('fetch') && l.endsWith('.zip')).length === 1 && retry.log.filter((l) => l.includes('--register')).length === 2, 'Try again: the app already in place is checked and used; nothing is downloaded twice')
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => rmSync(root, { recursive: true, force: true }))
