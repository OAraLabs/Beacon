// Setting Prometheus up on this Mac (path A of the v0.4.0 onboarding, A-inst): the pure half. What Beacon pins, how it reads
// the release manifest, the signing tools and the launcher, and what it accepts from the daemon when it connects. The main
// process does the downloading, the checking and the running (src/main/prometheus-install.ts); everything it decides with is
// here, so smoke:prometheus-install can hold it to the real tools' and the real daemon's recorded answers.
//
// The contract is Prometheus #695's design note (docs/design/macos-app-installer.md, "The contract for a client that installs
// and pairs the app"), and same-Mac pairing as merged in Prometheus #694 and #696. Where Beacon does something other than the
// note says, it is said where it happens.
//
// No Node/Electron imports (same rule as the rest of src/shared).
import type { Hello } from './discovery'
import { configuredRunning, setupStatusRunning } from './mac-check'

export const PROMETHEUS_BUNDLE_ID = 'com.oaralabs.prometheus'
/** The teams whose signature Beacon accepts on Prometheus.app. A LIST, so a new OAra Labs team can be added in a Beacon release
 *  before Prometheus ships builds signed with it (the certificate this team holds expires 2027-02-01). The manifest's `team_id`
 *  is shown, never trusted. */
export const PROMETHEUS_TEAM_IDS: readonly string[] = ['53JM8W47RL']
export const PROMETHEUS_APP = 'Prometheus.app'
export const LAUNCHER_IN_APP = 'Contents/MacOS/Prometheus'
/** Where the one-time secret is, relative to the home folder (the daemon and the launcher both resolve it from $HOME). */
export const PAIR_SECRET_IN_HOME = 'Library/Application Support/Prometheus/pairing/pair.secret'
/** The release Beacon gets Prometheus from. `releases/latest` resolves only to a full (not pre-release) release, which is what
 *  the first app-bearing release will be (owner decision, 2026-10-08). */
export const RELEASE_BASE = 'https://github.com/OAraLabs/Prometheus/releases/latest/download'
export const MANIFEST_ASSET = 'prometheus-mac.json'
export const ZIP_ALIAS = 'Prometheus-mac-arm64.zip'
/** The hosts a download may be redirected through (github.com hands the asset to its asset host). Anything else is refused. */
export const RELEASE_HOSTS: readonly string[] = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']
/** A github.com hop must stay inside this repository's releases. */
export const RELEASE_PATH_PREFIX = '/OAraLabs/Prometheus/releases/'
export const MAX_MANIFEST_BYTES = 16_384
/** A ceiling on the download, whatever the manifest says (the recommended bundle is about 63 MB). */
export const MAX_ZIP_BYTES = 512 * 1024 * 1024
/** How long Beacon waits for Prometheus to answer after the launcher registered it (the spec's 60 s). */
export const START_TIMEOUT_MS = 60_000
/** How long Beacon keeps watching after "requires approval": the person may take a while to find the switch. */
export const APPROVAL_WATCH_MS = 15 * 60_000
/** The name the daemon gives this Mac's credential on the same-Mac route (its own default, sent so the list says so). */
export const LOCAL_DEVICE_NAME = 'Beacon on this Mac'

// ── the manifest ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Manifest {
  version: string
  /** The versioned zip's name (Prometheus-<version>-arm64.zip), downloaded from the folder the manifest came from. */
  asset: string
  sha256: string
  size: number
  /** Display only. */
  teamId: string | null
  /** The oldest macOS the release runs on ("13.0"), or null when it does not say. */
  minMacos: string | null
}

const VERSIONED_ZIP = /^Prometheus-[0-9A-Za-z.+-]{1,64}-arm64\.zip$/

/** The release manifest, or null for anything that is not one. The checksum is lower-case hex, the size a whole number of bytes
 *  under the ceiling, and the asset a versioned zip name (never a path); a manifest without an asset falls back to the alias. */
export function parseManifest(v: unknown): Manifest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return null
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > MAX_ZIP_BYTES) return null
  const asset = m.asset === undefined ? ZIP_ALIAS : m.asset
  if (typeof asset !== 'string' || !(asset === ZIP_ALIAS || VERSIONED_ZIP.test(asset))) return null
  if (m.min_macos !== undefined && (typeof m.min_macos !== 'string' || !MACOS_VERSION.test(m.min_macos))) return null
  return { version: m.version, asset, sha256: m.sha256, size: m.size, teamId: typeof m.team_id === 'string' ? m.team_id : null, minMacos: typeof m.min_macos === 'string' ? m.min_macos : null }
}

// ── where a download may go ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a redirect may be followed. With no override: https, a release host, and (on github.com) this repository's releases.
 *  With a dev or probe build's override base: the override's own origin and nothing else. */
export function redirectAllowed(next: string, override: string | null): boolean {
  let u: URL
  try {
    u = new URL(next)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (override !== null) {
    try {
      return u.origin === new URL(override).origin
    } catch {
      return false
    }
  }
  if (u.protocol !== 'https:' || !RELEASE_HOSTS.includes(u.hostname) || (u.port !== '' && u.port !== '443')) return false
  return u.hostname !== 'github.com' || u.pathname.startsWith(RELEASE_PATH_PREFIX)
}

const MACOS_VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/

/** a < b, as macOS versions (each part a number: 10.15 is after 10.9). Null when either is not a version. */
export function macosOlder(have: string, need: string): boolean | null {
  if (!MACOS_VERSION.test(have.trim()) || !MACOS_VERSION.test(need.trim())) return null
  const a = have.trim().split('.').map(Number)
  const b = need.trim().split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

/** Where the release's files are asked for: the folder of the LAST hop on the release's own host (github.com, or a dev or probe
 *  build's override origin) in the manifest's redirect chain: .../releases/download/v0.9.7/. Never a folder on GitHub's asset host:
 *  its addresses are opaque and signed per file, and an address built there is refused (HTTP 618, Beacon 0.4.0's field failure).
 *  Null when no hop was on the release's host. */
export function releaseFolder(chain: readonly string[], override: string | null): string | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    let u: URL
    try {
      u = new URL(chain[i])
    } catch {
      continue
    }
    const own = override !== null ? (() => { try { return u.origin === new URL(override).origin } catch { return false } })() : u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(RELEASE_PATH_PREFIX)
    if (own) return folderOf(chain[i])
  }
  return null
}

/** The folder a URL is in (the release the manifest resolved to), with a trailing slash. */
export function folderOf(url: string): string {
  const u = new URL(url)
  u.search = ''
  u.hash = ''
  u.pathname = u.pathname.replace(/[^/]*$/, '')
  return u.toString()
}

// ── the signing checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const TEAM = /^[A-Z0-9]{10}$/

/** The code requirement Prometheus.app must satisfy, for `codesign --verify -R`: Apple's anchor, a Developer ID Application
 *  certificate issued under Apple's Developer ID CA, one of the pinned teams, and the bundle id. Built from constants; a team id
 *  that is not ten letters and digits is refused rather than spliced into the text. */
export function signingRequirement(teams: readonly string[] = PROMETHEUS_TEAM_IDS, bundleId: string = PROMETHEUS_BUNDLE_ID): string {
  if (teams.length === 0 || !teams.every((t) => TEAM.test(t))) throw new Error('a team id is ten upper-case letters and digits')
  if (!/^[A-Za-z0-9.-]{1,128}$/.test(bundleId)) throw new Error('not a bundle id')
  const team = teams.map((t) => `certificate leaf[subject.OU] = "${t}"`).join(' or ')
  return (
    `anchor apple generic and identifier "${bundleId}" and certificate 1[field.1.2.840.113635.100.6.2.6] ` +
    `and certificate leaf[field.1.2.840.113635.100.6.1.13] and (${team})`
  )
}

export interface SignatureInfo {
  identifier: string | null
  teamId: string | null
  /** `Notarization Ticket=stapled`: shown in the details. Not a check: Gatekeeper's verdict below is. */
  stapled: boolean
}

/** `codesign -d --verbose=2 <app>` (it writes to stderr). */
export function parseSignatureInfo(text: string): SignatureInfo {
  const line = (k: string): string | null => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim() ?? null
  const team = line('TeamIdentifier')
  return { identifier: line('Identifier'), teamId: team === 'not set' ? null : team, stapled: /^Notarization Ticket=stapled$/m.test(text) }
}

/** `spctl -a -t exec -vv <app>`: Gatekeeper accepts it AS NOTARIZED. Exit 0 alone is not enough: with assessments switched off
 *  spctl accepts anything ("override=security disabled"), and a Developer ID app that was never notarized is a different source. */
export function spctlNotarized(exit: number | null, text: string): boolean {
  return exit === 0 && /: accepted$/m.test(text) && /^source=Notarized Developer ID$/m.test(text)
}

/** `syspolicy_check distribution <app>` (macOS 14 and later): exit 0 and Apple's sentence. */
export function syspolicyPassed(exit: number | null, text: string): boolean {
  return exit === 0 && /passed all pre-distribution checks/.test(text)
}

// ── the launcher ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LauncherKind = 'registered' | 'requires-approval' | 'already-running' | 'port-busy' | 'failed' | 'unsupported-os'
export interface LauncherOutcome {
  kind: LauncherKind
  /** The launcher's own `state` and `detail`, for Copy details. */
  state: string
  detail: string
}

const BY_EXIT: Record<number, LauncherKind> = { 0: 'registered', 10: 'requires-approval', 11: 'already-running', 12: 'port-busy', 13: 'failed', 14: 'unsupported-os' }

/** What `Prometheus --register` said: the EXIT CODE decides (it is the contract's), the JSON line explains. Exit 0 counts only
 *  with a state that says so; a line that is not JSON, a code outside the table or a killed process is a failure. */
export function parseRegister(exit: number | null, stdout: string): LauncherOutcome {
  const j = lastJsonLine(stdout)
  const state = typeof j?.state === 'string' ? j.state : ''
  const detail = typeof j?.detail === 'string' ? j.detail : ''
  const kind = exit === null ? undefined : BY_EXIT[exit]
  if (kind === undefined) return { kind: 'failed', state: state || 'no_answer', detail: detail || `exit ${exit ?? 'signal'}` }
  if (kind === 'registered' && !(state === 'registered' || state === 'already_registered')) return { kind: 'failed', state: state || 'no_answer', detail: detail || 'exit 0 without a registered state' }
  return { kind, state, detail }
}

/** What `Prometheus --pair` said: the path of the fresh secret, only when it is the file Beacon expects. */
export function parsePairWritten(exit: number | null, stdout: string, expectedPath: string): string | null {
  const j = lastJsonLine(stdout)
  return exit === 0 && j?.ok === true && j.state === 'pair_secret_written' && j.path === expectedPath ? expectedPath : null
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'))
  if (lines.length === 0) return null
  try {
    const v = JSON.parse(lines[lines.length - 1]) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── waiting for the daemon, and connecting ─────────────────────────────────────────────────────────────────────────────────────

/** What is answering on this Mac's Prometheus port: setup mode (a new install), a configured daemon, or nothing that is ours. */
export function daemonStateFrom(setupStatus: { status: number; json: unknown } | null, status: { status: number; json: unknown } | null): 'setup' | 'configured' | null {
  if (setupStatus && setupStatusRunning(setupStatus.status, setupStatus.json)) return 'setup'
  // A configured daemon answers /api/setup/status with the bearer middleware's 401 as well; /api/status is asked when it does not.
  if (setupStatus && configuredRunning(setupStatus.status, setupStatus.json)) return 'configured'
  if (status && configuredRunning(status.status, status.json)) return 'configured'
  return null
}

/** Why the answer to GET /api/hello does not look like the Prometheus Beacon just started, or null when it does. Asked before the
 *  one-time secret is read or sent. Every hello must be one (Beacon's own reading: @shared/discovery helloFrom) with a version. In
 *  setup mode the daemon has no config, so it names its agent "Prometheus" and pairs by code, always. A configured daemon names the
 *  agent its owner chose (`system.name`), so there the name says nothing and is not asked. The fingerprint is compared with
 *  pair.fp (fingerprintMismatch), not required: a fresh install has no instance key, so its hello says fp "". */
export function helloRefusal(hello: Hello | null, daemon: 'setup' | 'configured'): string | null {
  if (!hello) return 'its answer to /api/hello is not a hello'
  if (!hello.version) return 'its hello has no version'
  if (daemon === 'setup' && hello.agent.toLowerCase() !== 'prometheus') return `its hello names the agent "${hello.agent}", and a Prometheus in setup mode is always "Prometheus"`
  if (daemon === 'setup' && hello.pair !== 'code') return `its hello says it pairs by "${hello.pair}", and a Prometheus in setup mode pairs by code`
  return null
}

/** The file the daemon writes beside pair.secret, saying the fingerprint its hello gives (Prometheus #695 from 3090556): written at
 *  boot from the key it has, and removed when it has none (a fresh install in setup mode). */
export const PAIR_FP_FILE = 'pair.fp'

/** Why hello's `fp` and pair.fp disagree, or null when they agree. Compared as plain strings, empty included: a missing pair.fp is
 *  "" (a fresh install's hello says fp "" too). A sanity check that the daemon answering is the one that wrote the files, not proof
 *  of identity: `fp` is public. `helloFp` is the hello's own field, as sent (not Beacon's cleaned reading of it). */
export function fingerprintMismatch(helloFp: unknown, pairFp: string): string | null {
  if (typeof helloFp !== 'string') return 'its hello gives no fp field'
  return helloFp === pairFp ? null : `pair.fp says "${pairFp}" and hello says "${helloFp}"`
}

/** The one-time secret's shape (the daemon reads 32 to 128 base64url characters; it writes 43). Anything else is not sent. */
export function isPairSecret(s: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(s)
}

export type SecretPairOutcome =
  | { kind: 'paired'; token: string; wsPort: number | null; revokedPrevious: number | null }
  | { kind: 'refused'; detail: string }

/** The answer of `POST /api/setup/pair` or `POST /api/pair/local` to the secret. Only a 200 with a non-empty token is a
 *  connection; the api port is the one Beacon reached (the same-Mac route reports its CONFIGURED port, which a daemon started on
 *  another one does not match), the WebSocket port is the daemon's to say. `revoked_previous` (Prometheus #696) is optional. */
export function parseSecretPair(status: number, body: unknown): SecretPairOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (status === 200 && typeof b.token === 'string' && b.token.length > 0 && b.token.length <= 1024) {
    const ws = b.ws_port
    const revoked = b.revoked_previous
    return {
      kind: 'paired',
      token: b.token,
      wsPort: typeof ws === 'number' && Number.isInteger(ws) && ws > 0 && ws < 65536 ? ws : null,
      revokedPrevious: typeof revoked === 'number' && Number.isInteger(revoked) && revoked >= 0 ? revoked : null
    }
  }
  const err = typeof b.error === 'string' ? b.error : ''
  return { kind: 'refused', detail: `HTTP ${status}${err ? ` ${err}` : ''}` }
}

// ── what the screen shows ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type InstallStep = 'get' | 'check' | 'place' | 'start' | 'connect'
export const INSTALL_STEPS: readonly InstallStep[] = ['get', 'check', 'place', 'start', 'connect']

/** The cards of the spec's A-inst table. */
export type InstallFailureKind = 'download' | 'unsafe' | 'place' | 'approval' | 'not-started' | 'in-the-way' | 'refused' | 'old-macos'

export interface InstallView {
  /** idle: nothing has started. running: a step is under way. done: connected. failed: a card. */
  phase: 'idle' | 'running' | 'done' | 'failed'
  step: InstallStep
  /** Bytes of the zip so far, and of the whole (0 until the manifest says). */
  received: number
  total: number
  /** The app is in Applications: from here on Back leaves it installed, and nothing is cleaned up. */
  placed: boolean
  /** Set when done: a new install still to be set up (on to A2), or a Prometheus that was already set up (on to F1). */
  daemon?: 'setup' | 'configured'
  failure?: { kind: InstallFailureKind; details: string }
}

export const IDLE_VIEW: InstallView = { phase: 'idle', step: 'get', received: 0, total: 0, placed: false }

/** Where each step stands on the screen. */
export function stepState(view: Pick<InstallView, 'phase' | 'step'>, step: InstallStep): 'todo' | 'doing' | 'done' | 'failed' {
  const at = INSTALL_STEPS.indexOf(view.step)
  const i = INSTALL_STEPS.indexOf(step)
  if (view.phase === 'done') return 'done'
  if (i < at) return 'done'
  if (i > at || view.phase === 'idle') return 'todo'
  return view.phase === 'failed' ? 'failed' : 'doing'
}

/** Megabytes the way the row says them: one decimal under 10, whole numbers above. */
export function formatMB(bytes: number): string {
  const mb = bytes / 1_000_000
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb))
}

// ── a dev or probe build's overrides ───────────────────────────────────────────────────────────────────────────────────────────

export interface InstallEnv {
  /** Where the manifest and the zip are asked for. */
  releaseBase: string
  /** True when releaseBase is an override: redirects then stay on its origin (redirectAllowed). */
  overridden: boolean
  /** The home folder Prometheus goes into (Applications, the secret); null = the person's own. */
  home: string | null
  /** A program run INSTEAD of the app's launcher; null = the app's own. */
  launcher: string | null
  startTimeoutMs: number
}

/** BEACON_PROMETHEUS_RELEASE (an http(s) base on this Mac's loopback, for a stub), BEACON_PROMETHEUS_HOME, BEACON_PROMETHEUS_LAUNCHER
 *  (absolute paths) and BEACON_PROMETHEUS_START_MS (1 to 600 s). Honoured only when `allowed`, which main sets from the build flavour:
 *  a release build always gets Prometheus from GitHub, puts it in the person's own Applications and runs the app's own launcher. */
export function installEnv(raw: Readonly<Record<string, string | undefined>>, allowed: boolean): InstallEnv {
  const defaults: InstallEnv = { releaseBase: RELEASE_BASE, overridden: false, home: null, launcher: null, startTimeoutMs: START_TIMEOUT_MS }
  if (!allowed) return defaults
  const out = { ...defaults }
  const base = raw.BEACON_PROMETHEUS_RELEASE ?? ''
  try {
    const u = new URL(base)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.username && !u.password) {
      out.releaseBase = base.replace(/\/+$/, '')
      out.overridden = true
    }
  } catch {
    /* not set, or not a URL: GitHub */
  }
  if (raw.BEACON_PROMETHEUS_HOME?.startsWith('/')) out.home = raw.BEACON_PROMETHEUS_HOME
  if (raw.BEACON_PROMETHEUS_LAUNCHER?.startsWith('/')) out.launcher = raw.BEACON_PROMETHEUS_LAUNCHER
  const ms = Number(raw.BEACON_PROMETHEUS_START_MS)
  if (Number.isInteger(ms) && ms >= 1_000 && ms <= 600_000) out.startTimeoutMs = ms
  return out
}
