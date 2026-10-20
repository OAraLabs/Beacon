import { shell } from 'electron'
import { IPC, type MacCheckResult } from '@shared/ipc'
import { discoveryEnv } from '@shared/discovery'
import { evaluateMacCheck } from '@shared/mac-check'
import { debuggingAllowedHere } from './build-flavor'
import { gatherMacFacts } from './mac-check'
import type { PrometheusInstaller } from './prometheus-install'
import { handleFromShell } from './shell-windows'

/** System Settings → General → Storage (macOS 13 and later, which is all Prometheus runs on). */
export const STORAGE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.settings.Storage'
/** System Settings → General → Login Items (macOS 13 and later), where Prometheus is switched on. */
export const LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

// Path A IPC (v0.4.0 onboarding): the check of this Mac and the button on the "not enough room" card; then, after the person
// confirmed, setting Prometheus up (src/main/prometheus-install.ts) and the button on the "Login Items" card. The page names no
// URL and no path: main owns every one it opens, and the install's updates carry no secret and no credential.
export function registerPathAHandlers(installer: PrometheusInstaller): void {
  handleFromShell(IPC.PATHA_CHECK, async (): Promise<MacCheckResult> => {
    const allowed = debuggingAllowedHere()
    // The port a Prometheus answers on is the same one discovery uses (and a probe may point at a stub).
    const { port } = discoveryEnv(process.env, allowed)
    const facts = await gatherMacFacts({ port, systemVersion: process.getSystemVersion?.() ?? null, env: process.env, allowOverride: allowed })
    return { verdict: evaluateMacCheck(facts), freeBytes: facts.freeBytes, memoryBytes: facts.memoryBytes, port }
  })
  handleFromShell(IPC.PATHA_OPEN_STORAGE, async () => {
    if (process.platform !== 'darwin') return false
    await shell.openExternal(STORAGE_SETTINGS_URL)
    return true
  })
  handleFromShell(IPC.PATHA_INSTALL_START, async () => (process.platform === 'darwin' ? installer.start() : installer.current()))
  handleFromShell(IPC.PATHA_INSTALL_CANCEL, async () => installer.cancel())
  handleFromShell(IPC.PATHA_OPEN_LOGIN_ITEMS, async () => {
    if (process.platform !== 'darwin') return false
    await shell.openExternal(LOGIN_ITEMS_URL)
    return true
  })
}
