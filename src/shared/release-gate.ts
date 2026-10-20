// Does this build honour Chromium's remote-debugging switches? A release build must not.
//
// WHY. `Beacon --remote-debugging-port=9222` gives anything that can run a command as the user a
// CDP socket into the shell page, and the shell page holds the preload bridge: window.beacon can
// call the daemon with the stored token, read history, and send messages, all under Beacon's
// signature and Keychain trust. Measured on the packaged arm64 build of main 9046521: the port
// listened under both spellings, `--remote-debugging-port=` and `-remote-debugging-port=`
// (Chromium accepts a single dash on POSIX, so an argv scan for the double-dash form misses it).
// No Electron fuse covers this switch; the Node inspector has its own fuse (electron-builder.yml).
//
// THE FLAG. `beaconBuild` in the packaged package.json, written by electron-builder's
// extraMetadata at package time: electron-builder.yml writes 'release', electron-builder.probe.yml
// writes 'probe'. The file lives inside app.asar, which the asar-integrity fuse ties to the signed
// Info.plist, so it cannot be edited after signing. Never an environment variable: anyone who can
// set one can also pass the switch.
//
// The probes attach over CDP, so a probe build (npm run pack:mac:probe) and a dev run (`electron .`)
// keep the switch. A packaged build with no flag at all is refused: forgetting the flag must not
// produce a debuggable release.

/** The Chromium switches that open a remote-control channel into the browser process. */
export const REMOTE_DEBUGGING_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const

/** The `beaconBuild` value out of a package.json's text, or null when the file is unreadable,
 *  is not JSON, or has no string `beaconBuild`. */
export function buildFlavorOf(packageJsonText: string | null): string | null {
  if (packageJsonText === null) return null
  try {
    const flavor = (JSON.parse(packageJsonText) as { beaconBuild?: unknown } | null)?.beaconBuild
    return typeof flavor === 'string' ? flavor : null
  } catch {
    return null
  }
}

/** May this build be debugged at all: the remote-debugging switches here, DevTools in every window
 *  and view (src/main/build-flavor.ts). One decision for both, so a build cannot refuse one door
 *  and leave the other open. 'probe' allows. No flag allows only an unpackaged run (`electron .`,
 *  where the repo's own package.json has no flag). 'release', and any value this code does not
 *  know, refuses. */
export function debuggingAllowed(flavor: string | null, isPackaged: boolean): boolean {
  if (flavor === 'probe') return true
  if (flavor === null) return !isPackaged
  return false
}

/** The remote-debugging switches this process was given and must refuse. Empty means start
 *  normally. `hasSwitch` is Chromium's own parsed command line (app.commandLine.hasSwitch), so it
 *  agrees with Chromium about spellings. */
export function refusedSwitches(flavor: string | null, isPackaged: boolean, hasSwitch: (name: string) => boolean): string[] {
  if (debuggingAllowed(flavor, isPackaged)) return []
  return REMOTE_DEBUGGING_SWITCHES.filter((name) => hasSwitch(name))
}
