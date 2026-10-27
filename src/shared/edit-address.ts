// Settings → Connection, a new address for the Prometheus Beacon is on (docs/MULTI-PROMETHEUS.md §6, Edit address): who answers there
// decides what saving does. Asked with no key (the identity challenge, and hello); decided here; src/main/edit-address.ts only asks.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import type { Verdict } from './identity-challenge'

/** What the new address turned out to be. */
export type NewAddress =
  /** The same Prometheus (or one that can't be told apart, as before): save as always. */
  | { kind: 'same' }
  /** Another Prometheus: nothing is saved and no key is sent; it may be added as a new one. */
  | { kind: 'different' }
  /** A Prometheus Beacon already keeps, under another name: switch to it instead. */
  | { kind: 'kept'; id: string; label: string }

export interface NewAddressFacts {
  /** The identity challenge at the new address, with the current Prometheus's pins (null when it has none, or no answer). */
  verdict: Verdict | null
  /** The current Prometheus's folder fp, and hello's fp at the new address (null when unknown or unanswered). */
  folderFp: string | null
  helloFp: string | null
  /** Another folder Beacon keeps, pinned to what answered there (its node key, or its fp), if any. */
  kept: { id: string; label: string } | null
}

/** Decide. A proof wins over hello (hello is a mix-up guard, the node key a proof); what can't be told is 'same', as before. */
export function judgeNewAddress(f: NewAddressFacts): NewAddress {
  if (f.kept) return { kind: 'kept', ...f.kept }
  if (f.verdict) {
    if (f.verdict.kind === 'proved' || f.verdict.kind === 'moved') return { kind: 'same' }
    if (f.verdict.kind === 'other' || f.verdict.kind === 'refused') return { kind: 'different' }
  }
  if (f.folderFp && f.helloFp) return f.folderFp === f.helloFp ? { kind: 'same' } : { kind: 'different' }
  return { kind: 'same' }
}

export const EDIT_ADDRESS_COPY = {
  different: "That's a different Prometheus. Add it as a new one?",
  differentBody: 'Beacon saved nothing and sent it nothing. The Prometheus you are on stays as it is.',
  addIt: 'Add it',
  cancel: 'Cancel',
  kept: 'You already have this Prometheus, as {label}.',
  switchTo: 'Switch to {label}'
} as const
