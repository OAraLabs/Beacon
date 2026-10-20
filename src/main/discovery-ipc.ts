import { app, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { discoveryEnv } from '@shared/discovery'
import { debuggingAllowedHere } from './build-flavor'
import { DiscoveryEngine } from './discovery'
import { handleFromShell } from './shell-windows'

/** System Settings → Privacy & Security → Local Network. */
export const LOCAL_NETWORK_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

// Discovery IPC (v0.4.0 onboarding, path B): start and stop a search, and ask one typed address.
// Updates go to the window that started the search, not to every window. The overrides the probes use
// are read per search and ignored by a release build (@shared/discovery discoveryEnv).
export function registerDiscoveryHandlers(): { stop: () => void } {
  const engine = new DiscoveryEngine({
    env: () => discoveryEnv(process.env, debuggingAllowedHere()),
    processEnv: process.env,
    platform: process.platform,
    home: app.getPath('home')
  })
  handleFromShell(IPC.DISCOVERY_START, (e, req?: { quiet?: boolean }) => {
    const sender = e.sender
    // Quiet unless the page says otherwise: the safe default is the search that cannot raise a prompt.
    const session = engine.start({ quiet: req?.quiet !== false }, (u) => {
      if (!sender.isDestroyed()) sender.send(IPC.DISCOVERY_UPDATE, u)
    })
    return { session }
  })
  handleFromShell(IPC.DISCOVERY_STOP, () => {
    engine.stop()
  })
  handleFromShell(IPC.DISCOVERY_PROBE, (_e, req: unknown) => engine.probeAddress(req))
  // The page names no URL: main owns the one it opens, and only on macOS, where the pane exists.
  handleFromShell(IPC.DISCOVERY_OPEN_SETTINGS, async () => {
    if (process.platform !== 'darwin') return false
    await shell.openExternal(LOCAL_NETWORK_SETTINGS_URL)
    return true
  })
  return { stop: () => engine.stop() }
}
