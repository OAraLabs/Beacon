import { IPC } from '@shared/ipc'
import { keyStepFrom, pastedKeyLooksRight, type CloudChoice, type KeyStep, type ModelSetupView } from '@shared/model-setup'
import type { ModelSetup } from './model-setup'
import type { OpenRouterSignIn } from './openrouter'
import { handleFromShell } from './shell-windows'

// O9 IPC (docs/ONBOARDING-v0.4.0-O9.md): the OpenRouter sign-in and its key check, a pasted key and its check, and the finish. The
// key that a step accepts is held here, in main, for the finish; the page gets only "on" or a card. A pasted key is sent once and
// never returned; the setup credential never leaves main.
export function registerModelSetupHandlers(o: { setup: ModelSetup; newSignIn: () => Promise<OpenRouterSignIn>; tradeOwed: () => boolean }): void {
  let signIn: OpenRouterSignIn | null = null
  let held: { choice: CloudChoice; key: string } | null = null
  const accept = (choice: CloudChoice, key: string, step: KeyStep): KeyStep => {
    held = step.ok ? { choice, key } : null
    return step
  }
  handleFromShell(IPC.MODEL_SIGNIN, async (): Promise<KeyStep> => {
    signIn?.cancel()
    const mine = await o.newSignIn()
    signIn = mine
    const r = await mine.start()
    if (signIn === mine) signIn = null
    switch (r.kind) {
      case 'key':
        return accept('openrouter', r.key, keyStepFrom(await o.setup.check('openrouter', r.key)))
      case 'declined':
        return { ok: false, card: 'declined', details: 'OpenRouter called back without a code (the person did not authorize)' }
      case 'unreachable':
        return { ok: false, card: 'unreachable', details: `sign-in: ${r.detail}` }
      case 'failed':
        return { ok: false, card: 'not-finished', details: `sign-in: ${r.detail}` }
      case 'timed-out':
        return { ok: false, card: 'not-finished', details: 'sign-in: no answer from the browser within 30 minutes' }
      case 'canceled':
        return { ok: false, card: 'not-finished', details: 'sign-in: stopped' }
    }
  })
  handleFromShell(IPC.MODEL_SIGNIN_CANCEL, async (): Promise<void> => {
    signIn?.cancel()
    signIn = null
  })
  handleFromShell(IPC.MODEL_CHECK_KEY, async (_e, company: unknown, key: unknown): Promise<KeyStep> => {
    if (company !== 'anthropic' && company !== 'openai') return { ok: false, card: 'shape', details: 'not a company Beacon knows' }
    if (typeof key !== 'string' || !pastedKeyLooksRight(company, key)) return { ok: false, card: 'shape', details: 'not shaped like a key' }
    return accept(company, key.trim(), keyStepFrom(await o.setup.check(company, key.trim())))
  })
  handleFromShell(IPC.MODEL_FINISH, async (): Promise<ModelSetupView> => {
    // No key in hand: a relaunch part-way through the owner trade (A5 reopened at launch). The trade is all that is left.
    if (!held) return o.tradeOwed() ? o.setup.resumeTrade() : { phase: 'failed', step: 'check', failure: { kind: 'not-started', details: 'no checked key to set up with' } }
    const v = await o.setup.finish(held.choice, held.key)
    // Done: the key is Prometheus's now (its env file), and Beacon keeps no copy.
    if (v.phase === 'done') held = null
    return v
  })
}
