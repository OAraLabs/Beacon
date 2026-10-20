import { IPC } from '@shared/ipc'
import type { PairPin, PairPinDecision } from './pair-pin'
import { handleFromShell } from './shell-windows'

// Devices → Enrol IPC (0.4.3): the page asks, for the code's host, whether the code carries the daemon's TLS pin, BEFORE it mints the
// one-shot token. The decision is main's (src/main/pair-pin.ts); a host that is not a string is refused.
export function registerPairPinHandlers(pairPin: PairPin): void {
  handleFromShell(IPC.PAIR_PIN, async (_e, host: unknown): Promise<PairPinDecision> =>
    typeof host === 'string' && host ? pairPin.decide(host) : { kind: 'refused', message: 'No host to make a pairing code for.' }
  )
}
