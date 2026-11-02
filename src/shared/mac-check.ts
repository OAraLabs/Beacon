// Can Prometheus be set up on THIS computer? (docs/ONBOARDING-v0.4.0.md, §4 A1) — the pure decision.
//
// Facts in, one verdict out, so a headless smoke can hold every branch to account (smoke:onboarding-mac-check).
// Main gathers the facts (the chip, macOS, free space, memory, and whether a Prometheus already answers here); a
// dev or probe build may override them. The order of the verdicts is the point:
//
//   1. A Prometheus is ALREADY here: nothing about installing another matters, and it is what to connect to.
//   2. Not a Mac, or not Apple silicon, or macOS older than 13: Prometheus for Mac cannot run here.
//   3. Too little room.
//   4. Otherwise: fine.
//
// A fact Beacon cannot read (free space, the macOS version) never blocks anyone: it reads as "unknown", which is
// not a reason to stop. No Node/Electron imports (same rule as shared/setup-wizard.ts).
import type { DiscoveredComputer } from './discovery'

/** What setting Prometheus up needs free on the volume it goes on. macOS shows storage in decimal GB, so so do we. */
export const REQUIRED_FREE_BYTES = 2_000_000_000
export const MIN_MACOS_MAJOR = 13
/** The release the fallback estimate comes from, and its zip's size in bytes (the size of that release's
 *  Prometheus-mac-arm64.zip asset; 0.9.17's, read 2026-10-27). The confirmation says the release manifest's own size when
 *  main can read it (downloadEstimateMB); this is only for when it cannot. To move it to a new release, change this line
 *  and the measured size in smoke:onboarding-mac-check. */
export const DOWNLOAD_ESTIMATE_FROM = { version: '0.9.17', zipBytes: 71_538_835 } as const
/** What the confirmation says the download is (decimal MB, as macOS shows sizes) when the manifest cannot be read; the
 *  progress row shows the manifest's own size once the download starts. */
export const DOWNLOAD_ESTIMATE_MB = Math.round(DOWNLOAD_ESTIMATE_FROM.zipBytes / 1e6)
/** How long main gives the release manifest before the confirmation keeps DOWNLOAD_ESTIMATE_MB. The screen never waits on
 *  it: it says the constant at once, and the manifest's size if that comes in time. */
export const DOWNLOAD_SIZE_TIMEOUT_MS = 3_000

/** The MB the confirmation says: the release manifest's size when main could read it, DOWNLOAD_ESTIMATE_MB when not. */
export function downloadEstimateMB(manifestBytes: number | null): number {
  return manifestBytes !== null && Number.isFinite(manifestBytes) && manifestBytes > 0 ? Math.max(1, Math.round(manifestBytes / 1e6)) : DOWNLOAD_ESTIMATE_MB
}

/** How a Prometheus already on this Mac showed itself, in the order Beacon asks (settled with the installer
 *  session): the discovery hello (P5), else setup mode (`GET /api/setup/status`, unauthenticated, with a `version`),
 *  else the 401 a configured daemon gives every route. */
export type RunningHere = { kind: 'hello'; computer: DiscoveredComputer } | { kind: 'setup'; version: string } | { kind: 'configured' }

export interface MacFacts {
  platform: string
  arch: string
  /** `15.6.1`, or null when it cannot be read. */
  macos: string | null
  freeBytes: number | null
  memoryBytes: number | null
  /** The port a Prometheus answers on here (8005; a probe may point it at a stub). */
  port: number
  running: RunningHere | null
}

export type MacVerdict =
  | { kind: 'ok' }
  | { kind: 'running'; computer: DiscoveredComputer }
  | { kind: 'low-space'; freeBytes: number }
  | { kind: 'old-macos'; macos: string }
  | { kind: 'intel' }
  | { kind: 'other-os' }

/** The major version of a macOS version string ("15.6.1" is 15, "10.15.7" is 10), or null. */
export function macMajor(version: string | null): number | null {
  const m = /^(\d{1,3})(?:\.\d+)*$/.exec((version ?? '').trim())
  return m ? Number(m[1]) : null
}

export function evaluateMacCheck(f: MacFacts): MacVerdict {
  if (f.running) return { kind: 'running', computer: computerFromRunning(f.running, f.port) }
  if (f.platform !== 'darwin') return { kind: 'other-os' }
  if (f.arch !== 'arm64') return { kind: 'intel' }
  const major = macMajor(f.macos)
  if (major !== null && major < MIN_MACOS_MAJOR) return { kind: 'old-macos', macos: f.macos ?? '' }
  if (f.freeBytes !== null && f.freeBytes < REQUIRED_FREE_BYTES) return { kind: 'low-space', freeBytes: f.freeBytes }
  return { kind: 'ok' }
}

/** "0.6 GB", "12 GB": one decimal under ten, whole numbers above. */
export function formatGB(bytes: number): string {
  const gb = Math.max(0, bytes) / 1e9
  return `${gb < 10 ? gb.toFixed(1) : String(Math.round(gb))} GB`
}

/** The row to show for a Prometheus already on this Mac. Only the hello says anything about it; the other two ways
 *  of recognising it say that something is there, so the row is "This Mac" at the port that answered. */
export function computerFromRunning(r: RunningHere, port: number): DiscoveredComputer {
  if (r.kind === 'hello') return r.computer
  return {
    id: `127.0.0.1:${port}`,
    name: 'This Mac',
    agent: '',
    version: r.kind === 'setup' ? r.version.slice(0, 32) : '',
    fp: '',
    pair: 'unknown',
    tls: false,
    where: 'this-mac',
    endpoints: [{ host: '127.0.0.1', port }]
  }
}

/** `GET /api/setup/status` on a daemon in setup mode: 200 with `setup_mode: true`. */
export function setupStatusRunning(status: number, body: unknown): RunningHere | null {
  if (status !== 200 || !body || typeof body !== 'object') return null
  const b = body as { setup_mode?: unknown; version?: unknown }
  return b.setup_mode === true ? { kind: 'setup', version: typeof b.version === 'string' ? b.version : '' } : null
}

/** What a configured daemon answers a route with no credential: 401 and a JSON error that says "unauthorized" and
 *  names the Bearer scheme. Stricter than "any 401", so someone else's login wall on that port is not mistaken
 *  for Prometheus; the wording is the installer session's to keep stable. */
export function configuredRunning(status: number, body: unknown): RunningHere | null {
  if (status !== 401 || !body || typeof body !== 'object') return null
  const err = (body as { error?: unknown }).error
  return typeof err === 'string' && /unauthori[sz]ed/i.test(err) && /bearer/i.test(err) ? { kind: 'configured' } : null
}

/** The overrides a dev or probe build may apply to this Mac's facts (BEACON_MAC_CHECK, a JSON object). A release
 *  build ignores it: an environment variable must not be able to make a shipped Beacon believe it is on an Intel Mac. */
export function macFactsOverride(raw: Readonly<Record<string, string | undefined>>, allowed: boolean): Partial<Omit<MacFacts, 'running' | 'port'>> {
  if (!allowed || !raw.BEACON_MAC_CHECK) return {}
  let v: unknown
  try {
    v = JSON.parse(raw.BEACON_MAC_CHECK)
  } catch {
    return {}
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const o = v as Record<string, unknown>
  const out: Partial<Omit<MacFacts, 'running' | 'port'>> = {}
  if (typeof o.platform === 'string') out.platform = o.platform
  if (typeof o.arch === 'string') out.arch = o.arch
  if (o.macos === null || typeof o.macos === 'string') out.macos = o.macos as string | null
  if (o.freeBytes === null || (typeof o.freeBytes === 'number' && o.freeBytes >= 0)) out.freeBytes = o.freeBytes as number | null
  if (o.memoryBytes === null || (typeof o.memoryBytes === 'number' && o.memoryBytes >= 0)) out.memoryBytes = o.memoryBytes as number | null
  return out
}
