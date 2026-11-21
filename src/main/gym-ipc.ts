import { IPC } from '@shared/ipc'
import type { GymRead, GymSettings } from '@shared/gym'
import type { GymStatusReader } from './gym-status'
import type { StatusServiceTransport } from './gym-transport'
import { handleFromShell } from './shell-windows'

// Activity › Gym IPC (@shared/gym). The page asks for the status, and may set where today's transport finds the gym and the token
// it is let in with. The token goes one way only: the page can give one and learn WHETHER one is kept, never read it back.
// Nothing here changes anything on the gym.
export function registerGymHandlers(reader: GymStatusReader, service: StatusServiceTransport): void {
  handleFromShell(IPC.GYM_READ, (): Promise<GymRead> => reader.read())
  handleFromShell(IPC.GYM_SETTINGS_GET, (): GymSettings => service.settings())
  // The kept status is forgotten only when a setting really changed: a refused address or token leaves what is on screen alone.
  handleFromShell(IPC.GYM_ADDRESS_SET, async (_e, raw: unknown) => {
    const kept = await service.setAddress(raw)
    if (kept.ok) reader.forget()
    return kept
  })
  handleFromShell(IPC.GYM_TOKEN_SET, (_e, raw: unknown) => {
    const kept = service.setToken(raw)
    if (kept.ok) reader.forget()
    return kept
  })
}
