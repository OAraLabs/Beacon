import type { NewAddress } from '@shared/edit-address'
import type { PinnedIdentity } from '@shared/identity-challenge'
import type { RequestFn } from './pairing/http'

export interface EditAddressDeps {
  /** No key, no redirect. */
  request: RequestFn
  /** The current Prometheus's pins, and its folder fp. */
  pinned: PinnedIdentity | null
  folderFp: string | null
  /** hello's fp at an address, or null when it doesn't answer with one. */
  hello: (apiBase: string) => Promise<string | null>
  /** Another folder Beacon keeps that is pinned to this node key, or bound to this fp. */
  keptWith: (q: { nodePub?: string; instanceId?: string | null; fp?: string }) => { id: string; label: string } | null
  verify: (message: string, signature: string, publicKey: string) => boolean
  nowS: () => number
}

/**
 * Who answers at `apiBase`, before Settings points the Prometheus Beacon is on there (docs/MULTI-PROMETHEUS.md §6).
 *
 * TODAY: nothing is asked; every new address is taken as the same Prometheus. smoke:edit-address is red against this on purpose.
 */
export async function whoIsAt(_apiBase: string, _deps: EditAddressDeps): Promise<NewAddress> {
  return { kind: 'same' }
}
