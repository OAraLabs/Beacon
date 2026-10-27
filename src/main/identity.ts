import type { RequestFn } from './pairing/http'

/** What a Prometheus's node key is pinned as, per folder (docs/MULTI-PROMETHEUS.md §2 rule 1). */
export interface PinnedIdentity {
  instanceId: string | null
  nodePub: string
}

export interface ProverDeps {
  /** The REST base of the Prometheus to ask. */
  apiBase: string
  /** No key, no redirect: requestSmall, or a pinned one for a TLS profile. */
  request: RequestFn
  /** The pin for that Prometheus's folder, or null when none is kept yet. */
  pinned: () => PinnedIdentity | null
  /** The TLS SPKI digest Beacon pins for this connection (its profile's pin), or null for a plain one. */
  tlsSpki: string | null
  /** Ed25519 check of `signature` (base64) over `message` by `publicKey` (base64 raw 32 bytes). */
  verify: (message: string, signature: string, publicKey: string) => boolean
  /** Seconds since the epoch. */
  nowS: () => number
}

/**
 * The proof ConnectionManager asks for before the key goes out (docs/MULTI-PROMETHEUS.md §2 rule 3, §8): null to go ahead, or the
 * words to refuse with.
 *
 * TODAY: nothing is asked, and every Prometheus is let through. smoke:identity-challenge is red against this on purpose.
 */
export function createProver(_deps: ProverDeps): () => Promise<string | null> {
  return () => Promise.resolve(null)
}
