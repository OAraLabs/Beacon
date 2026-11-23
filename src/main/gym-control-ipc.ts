import { IPC } from '@shared/ipc'
import type { GymControlSettings, GymOpRead, GymRunResult } from '@shared/gym-control'
import type { GymControl } from './gym-control'
import { handleFromShell } from './shell-windows'

// Activity › Gym › Promote and Roll back IPC (@shared/gym-control). The page can name an action (and, for Promote, a model the
// gym offered) and ask how it is going. It cannot send a plan, a hash or an apply: main asks the service for the plan, a window
// drawn by the OS shows it, and only that window's yes releases the apply. The write token goes one way only, as the read one does.
export function registerGymControlHandlers(control: GymControl): void {
  handleFromShell(IPC.GYM_CONTROL_SETTINGS_GET, (): GymControlSettings => control.settings())
  handleFromShell(IPC.GYM_CONTROL_ADDRESS_SET, (_e, raw: unknown) => control.setAddress(raw))
  handleFromShell(IPC.GYM_CONTROL_TOKEN_SET, (_e, raw: unknown) => control.setToken(raw))
  handleFromShell(IPC.GYM_CONTROL_RUN, (_e, action: unknown, candidate: unknown): Promise<GymRunResult> => control.run(action, candidate))
  handleFromShell(IPC.GYM_CONTROL_OP, (): Promise<GymOpRead> => control.op())
}
