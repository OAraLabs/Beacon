import { IPC } from '@shared/ipc'
import { PUT_FAILED, type NetworkRead, type RestartOutcome, type SetOutcome } from '@shared/network-setting'
import type { NetworkSetting } from './network-setting'
import { handleFromShell } from './shell-windows'

// Settings → Other computers IPC (docs/MULTI-COMPUTER-v0.4.md §2): the home-network switch on the connected Prometheus, and its
// restart. The page sends only on/off; the address, the credential and every request are main's (src/main/network-setting.ts).
export function registerNetworkSettingHandlers(setting: NetworkSetting): void {
  handleFromShell(IPC.NETWORK_GET, (): Promise<NetworkRead> => setting.read())
  handleFromShell(IPC.NETWORK_SET, async (_e, on: unknown): Promise<SetOutcome> => (typeof on === 'boolean' ? setting.set(on) : { kind: 'refused', message: PUT_FAILED, detail: 'not on or off' }))
  handleFromShell(IPC.NETWORK_RESTART, (): Promise<RestartOutcome> => setting.restart())
}
