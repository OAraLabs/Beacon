import { judgeNewAddress, type NewAddress } from '@shared/edit-address'
import type { PinnedIdentity, Verdict } from '@shared/identity-challenge'
import { createProver } from './identity'
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
 * Who answers at `apiBase`, before Settings points the Prometheus Beacon is on there (docs/MULTI-PROMETHEUS.md §6), asked with no key:
 * the identity challenge with that Prometheus's pins (when it has some), and hello. Decided by @shared/edit-address. Asked once: an
 * address that doesn't answer is "can't tell", which saves as before (the connection then says it can't reach it).
 */
export async function whoIsAt(apiBase: string, deps: EditAddressDeps): Promise<NewAddress> {
  const seen: { verdict: Verdict | null } = { verdict: null }
  if (deps.pinned) {
    const prove = createProver({
      apiBase,
      request: deps.request,
      pinned: () => deps.pinned,
      tlsSpki: null, // a pinned TLS profile can't be pointed elsewhere at all (pinnedEdit): this is a plain one
      verify: deps.verify,
      nowS: deps.nowS,
      onVerdict: (v) => {
        seen.verdict = v
        return undefined
      }
    })
    await prove({ waiting: () => undefined, stopped: () => true })
  }
  const verdict = seen.verdict
  const helloFp = await deps.hello(apiBase).catch(() => null)
  let kept: { id: string; label: string } | null = null
  if (verdict && (verdict.kind === 'other' || verdict.kind === 'first')) kept = deps.keptWith({ nodePub: verdict.nodePub, instanceId: verdict.instanceId })
  if (!kept && helloFp && helloFp !== deps.folderFp) kept = deps.keptWith({ fp: helloFp })
  return judgeNewAddress({ verdict, folderFp: deps.folderFp, helloFp, kept })
}
