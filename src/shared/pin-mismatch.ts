// The card for a pinned Prometheus that answered with another key (docs/MULTI-COMPUTER-v0.4.md §3.4): Beacon sent it nothing,
// and there is no "continue anyway". The way on is connecting again (a new approval, a new code, a new pin).
//
// No Node/Electron imports (same rule as the rest of src/shared).
import type { ConnectionStatus } from './ipc'

export interface MismatchCard {
  title: string
  body: string
  /** Copy details: the pinned and presented key hashes (technical words are allowed there). */
  details: string
}
export function mismatchCard(status: ConnectionStatus): MismatchCard | null {
  const w = status.wrongKey
  if (!w) return null
  return {
    title: "This isn't the Prometheus you connected to",
    body: `Something on your network answered as ${w.name}, but it isn't the same computer, so Beacon sent it nothing. If Prometheus was reinstalled there, connect to it again.`,
    details: [`Prometheus at ${status.gateway ?? 'the saved address'} presented a different TLS key.`, `pinned SPKI SHA-256:    ${w.pinned}`, `presented SPKI SHA-256: ${w.presented ?? '(none readable)'}`].join('\n')
  }
}
