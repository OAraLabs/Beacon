// The build's flavour, read once from Beacon's own package.json (src/shared/release-gate.ts).
//
// app.getAppPath() is app.asar in a packaged build, where electron-builder wrote `beaconBuild` at
// package time and the asar-integrity fuse seals it; it is the repo root under `electron .`, where
// package.json has no flag. Every consumer asks here, so the startup gate, the View menu and every
// window's DevTools switch cannot disagree about what kind of build this is.
import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildFlavorOf, debuggingAllowed } from '@shared/release-gate'

let flavor: string | null | undefined

/** `beaconBuild` from the app's package.json, or null (no flag, or unreadable: a packaged build
 *  with no readable flag is refused, see debuggingAllowed). */
export function buildFlavor(): string | null {
  if (flavor === undefined) {
    let text: string | null = null
    try {
      text = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    } catch {
      // Unreadable reads as "no flag".
    }
    flavor = buildFlavorOf(text)
  }
  return flavor
}

/** May this process be debugged: DevTools (the View menu item, `webPreferences.devTools` on every
 *  window and view) and the remote-debugging switches. False in a release build. */
export function debuggingAllowedHere(): boolean {
  return debuggingAllowed(buildFlavor(), app.isPackaged)
}
