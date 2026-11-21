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
  handleFromShell(IPC.GYM_ADDRESS_SET, (_e, raw: unknown) => {
    reader.forget()
    return service.setAddress(raw)
  })
  handleFromShell(IPC.GYM_TOKEN_SET, (_e, raw: unknown) => {
    reader.forget()
    return service.setToken(raw)
  })
}
