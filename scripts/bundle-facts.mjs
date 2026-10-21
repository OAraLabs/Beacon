// What a built Beacon is, read from the artifact itself rather than from the config that was meant
// to produce it: the Electron fuses in its binary and the `beaconBuild` flag in its app.asar.
// Shared by audit:bundle (scripts/check-bundle.mjs) and probe:hardening (scripts/hardening-probe.mjs).
//
// Both readers return what they found, including "unreadable", and leave the verdict to the
// caller: a reader that threw would turn "could not look" into a crash rather than a FAIL.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Fuse wire index → name, in the order Electron lays them out (FuseV1Options in @electron/fuses).
 *  Electron 44 has a ninth fuse that @electron/fuses 1.8.0 does not name yet; it reads as '8'. */
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges'
]

/** The six fuses a release build must have, and their required state. EnableCookieEncryption is
 *  one-way once shipped: turning it off again deletes users' cookies (docs/DECISIONS.md D1), so a
 *  release with it off is refused here, not just discouraged. */
export const RELEASE_FUSES = {
  RunAsNode: 'disabled',
  EnableCookieEncryption: 'enabled',
  EnableNodeOptionsEnvironmentVariable: 'disabled',
  EnableNodeCliInspectArguments: 'disabled',
  EnableEmbeddedAsarIntegrityValidation: 'enabled',
  OnlyLoadAppFromAsar: 'enabled'
}

/** A probe build differs from a release in exactly one fuse: the Node inspector. */
export const PROBE_FUSES = { ...RELEASE_FUSES, EnableNodeCliInspectArguments: 'enabled' }

const STATE = { 48: 'disabled', 49: 'enabled', 114: 'removed' } // '0', '1', 'r'

/** { RunAsNode: 'disabled', …, '8': 'enabled' } read from the binary at `appPath` (a .app), or
 *  { error } when it cannot be read. */
export async function readFuses(appPath) {
  try {
    const { getCurrentFuseWire } = require('@electron/fuses')
    const wire = await getCurrentFuseWire(appPath)
    const out = {}
    for (const [k, v] of Object.entries(wire)) {
      if (k === 'version') continue
      out[FUSE_NAMES[Number(k)] ?? k] = STATE[v] ?? `byte ${v}`
    }
    return out
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}

/** The fuses in `want` that `got` does not match, as human-readable lines. */
export function fuseMismatches(got, want) {
  if (got.error) return [`fuses unreadable: ${got.error}`]
  return Object.entries(want)
    .filter(([name, state]) => got[name] !== state)
    .map(([name, state]) => `${name} is ${got[name] ?? 'absent'}, must be ${state}`)
}

/** The `beaconBuild` value inside the asar's package.json: a string, null when the file has none,
 *  or { error } when the asar or the file cannot be read. */
export function readBuildFlavor(asarPath) {
  try {
    const asar = require('@electron/asar')
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    return typeof pkg.beaconBuild === 'string' ? pkg.beaconBuild : null
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}

/** The asar's package.json `name` (Electron's app name: the profile directory and the Keychain
 *  item are keyed to it), or { error }. */
export function readPackageName(asarPath) {
  try {
    const asar = require('@electron/asar')
    return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).name ?? null
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}

/** The URL schemes the app's Info.plist declares (CFBundleURLTypes), or { error }. LaunchServices
 *  offers an app as a handler for exactly these; a probe build must declare none of Beacon's. */
export function readUrlSchemes(appPath) {
  try {
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', `${appPath}/Contents/Info.plist`], { encoding: 'utf8' }))
    return (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? [])
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}
