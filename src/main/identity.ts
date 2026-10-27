import { createPublicKey, randomBytes, verify as edVerify } from 'node:crypto'
import { CHALLENGE_PATH, NONCE_BYTES, judge, keyMayGo, type PinnedIdentity, type Verdict } from '@shared/identity-challenge'
import type { RequestFn } from './pairing/http'

export type { PinnedIdentity } from '@shared/identity-challenge'

export interface ProverDeps {
  /** The REST base of the Prometheus to ask. */
  apiBase: string
  /** No key, no redirect: requestSmall, or a pinned one for a TLS profile (so the answer comes over the pinned channel). */
  request: RequestFn
  /** The pin for that Prometheus's folder, or null when none is kept yet. */
  pinned: () => PinnedIdentity | null
  /** The TLS SPKI digest Beacon pins for this connection (its profile's pin), or null for a plain one. */
  tlsSpki: string | null
  /** Ed25519 check of `signature` (base64) over `message` by `publicKey` (base64 raw 32 bytes). */
  verify: (message: string, signature: string, publicKey: string) => boolean
  /** Seconds since the epoch. */
  nowS: () => number
  /** What main does with a verdict (pin it, switch folder, say it on screen). Returns the words to refuse with, null to let the key
   *  go, or undefined to take the verdict's own answer (keyMayGo). */
  onVerdict?: (v: Verdict) => string | null | undefined
}

/** How ConnectionManager lets a proof report that it is waiting, and learn that it should stop. */
export interface ProofControl {
  /** No answer yet: attempt n. The connection shows it is trying again, as the socket's own retries do. */
  waiting: (attempt: number) => void
  stopped: () => boolean
}

/** Waits between asks while there is no answer at all (the computer asleep, Prometheus restarting): the socket's own pace, capped. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** The words a refusal carries in ConnectionStatus.refused (the card says more, from ConnectionStatus.identity). */
export const NOT_PROVED = 'Beacon sent this Prometheus nothing: it did not prove who it is.'

/**
 * The proof ConnectionManager asks for before the key goes out (docs/MULTI-PROMETHEUS.md §2 rule 3, §8): null to go ahead, or the
 * words to refuse with. A fresh nonce each time, the answer judged by @shared/identity-challenge. With no answer at all it asks
 * again, at the socket's pace, until there is one or the connection is stopped: nothing is sent meanwhile.
 */
export function createProver(deps: ProverDeps): (control?: ProofControl) => Promise<string | null> {
  return async (control) => {
    for (let attempt = 1; ; attempt++) {
      const nonce = randomBytes(NONCE_BYTES).toString('base64url')
      const r = await deps.request({ method: 'POST', url: `${deps.apiBase}${CHALLENGE_PATH}`, body: JSON.stringify({ v: 1, nonce }), timeoutMs: 5_000 })
      // A pinned TLS connection that met another certificate. The TLS pin is the earlier and stronger check here: it fails every
      // handshake to that server before a byte of the key is sent, REST and socket alike (src/main/tls-pin.ts), and reports it with
      // its own card (docs/MULTI-COMPUTER-v0.4.md §3.4, the pinned and the presented keys). So the proof steps aside for it.
      if (r === 'wrong-key') return null
      const reply = r === 'unreachable' || r === 'too-big' ? 'unreachable' : { status: r.status, json: r.json }
      const v = judge({ reply, nonce, nowS: deps.nowS(), pinned: deps.pinned(), tlsSpki: deps.tlsSpki, verify: deps.verify })
      if (v.kind === 'unreachable') {
        if (control?.stopped()) return NOT_PROVED
        control?.waiting(attempt)
        await new Promise((res) => setTimeout(res, RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)]))
        if (control?.stopped()) return NOT_PROVED
        continue
      }
      const said = deps.onVerdict?.(v)
      if (said !== undefined) return said
      return keyMayGo(v) ? null : NOT_PROVED
    }
  }
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo: with the raw 32 bytes after it, a key node:crypto can verify with. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Ed25519 signature check over UTF-8 `message`, with the raw public key Prometheus publishes as `node_pub`. */
export function verifyEd25519(message: string, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64')
    if (raw.length !== 32) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
