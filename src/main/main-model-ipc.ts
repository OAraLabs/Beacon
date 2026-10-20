import { IPC } from '@shared/ipc'
import { MAIN_MODEL_COPY, type CheckOutcome, type MainModelRead, type MainModelSave } from '@shared/main-model'
import type { MainModelSetting } from './main-model'
import { handleFromShell } from './shell-windows'

// Config → Models → Main model IPC (@shared/main-model): the connected Prometheus's AI choice. The page sends a company, a version,
// a typed key once, or "sign in"; the address, the credential, a signed-in key and every request are main's (src/main/main-model.ts).
export function registerMainModelHandlers(setting: MainModelSetting): void {
  const str = (v: unknown): v is string => typeof v === 'string'
  const bad = { kind: 'refused', message: MAIN_MODEL_COPY.refused.other, detail: 'not a company, version or key' } as const
  handleFromShell(IPC.MAIN_MODEL_GET, (): Promise<MainModelRead> => setting.read())
  handleFromShell(IPC.MAIN_MODEL_CHECK, async (_e, provider: unknown, key: unknown, checkable: unknown): Promise<CheckOutcome> =>
    str(provider) && str(key) ? setting.check(provider, key, checkable !== false) : bad
  )
  handleFromShell(IPC.MAIN_MODEL_SIGNIN, (): Promise<CheckOutcome> => setting.signIn())
  handleFromShell(IPC.MAIN_MODEL_SIGNIN_CANCEL, async (): Promise<void> => setting.cancelSignIn())
  handleFromShell(IPC.MAIN_MODEL_SAVE, async (_e, provider: unknown, version: unknown, useNewKey: unknown): Promise<MainModelSave> =>
    str(provider) && str(version) && typeof useNewKey === 'boolean' ? setting.save(provider, version, useNewKey) : bad
  )
}
