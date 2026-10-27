// No key before proof (docs/MULTI-PROMETHEUS.md §2 rule 3, §8): before Beacon sends a Prometheus its key, the Prometheus signs a nonce
// of Beacon's with its Ed25519 node key, and Beacon checks the signature against the node key it pinned for that Prometheus. What the
// answer is, what each outcome means and what the screen says about it are decided here; src/main/identity.ts only asks.
//
// The route is Prometheus ask PD-2 (not built yet): POST /api/identity/challenge, no credential. Until it is, an older Prometheus
// answers 404, or 401 from its bearer middleware, and one Beacon never pinned a node key for is let through as before.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const CHALLENGE_PATH = '/api/identity/challenge'
/** The first line of the signed message: a challenge signature can never pass as an audit-record signature, or the reverse. */
export const CHALLENGE_DOMAIN = 'prometheus-identity-challenge/v1'
/** How far `signed_at` may be from this computer's clock. */
export const MAX_SKEW_S = 300
/** The nonce Beacon sends: this many random bytes, base64url. */
export const NONCE_BYTES = 32

export interface ChallengeAnswer {
  instanceId: string | null
  nodePub: string
  tlsSpki: string | null
  signedAt: number
  sig: string
}

/** The node key (and instance) Beacon pinned for a Prometheus's folder. */
export interface PinnedIdentity {
  instanceId: string | null
  nodePub: string
}

export type RefusedWhy = 'bad-signature' | 'stale' | 'channel' | 'downgrade' | 'malformed'

export type Verdict =
  /** The pinned key signed Beacon's nonce. */
  | { kind: 'proved' }
  /** Nothing pinned yet, and a good answer: pin this (trust on first use, until pairing hands the key over: PD-3). */
  | { kind: 'first'; instanceId: string | null; nodePub: string }
  /** The same instance_id, signed by another node key: moved to new hardware, or not. The person decides. */
  | { kind: 'moved'; instanceId: string; nodePub: string; was: string }
  /** Another Prometheus signed it (another node key, another instance_id). */
  | { kind: 'other'; instanceId: string | null; nodePub: string }
  /** It can't be asked (an older Prometheus) and nothing is pinned: as before the challenge existed. */
  | { kind: 'unproved' }
  | { kind: 'refused'; why: RefusedWhy }
  /** No answer at all: asked again. */
  | { kind: 'unreachable' }

const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The answer's fields, or null when it isn't one. */
export function parseAnswer(json: unknown): ChallengeAnswer | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const instanceId = j.instance_id === null || j.instance_id === undefined ? null : j.instance_id
  const tlsSpki = j.tls_spki_sha256 === null || j.tls_spki_sha256 === undefined ? null : j.tls_spki_sha256
  if (j.v !== 1) return null
  if (instanceId !== null && (typeof instanceId !== 'string' || !UUID.test(instanceId))) return null
  if (typeof j.node_pub !== 'string' || !B64.test(j.node_pub) || j.node_pub.length !== 44) return null
  if (tlsSpki !== null && (typeof tlsSpki !== 'string' || !/^[0-9a-f]{64}$/.test(tlsSpki))) return null
  if (typeof j.signed_at !== 'number' || !Number.isInteger(j.signed_at)) return null
  if (typeof j.sig !== 'string' || !B64.test(j.sig)) return null
  return { instanceId: instanceId as string | null, nodePub: j.node_pub, tlsSpki: tlsSpki as string | null, signedAt: j.signed_at, sig: j.sig }
}

/** The exact bytes the node key signs (as UTF-8): six lines, each ending in a newline. */
export function challengeMessage(nonce: string, a: Omit<ChallengeAnswer, 'sig'>): string {
  return [
    CHALLENGE_DOMAIN,
    `nonce=${nonce}`,
    `instance_id=${a.instanceId ?? ''}`,
    `node_pub=${a.nodePub}`,
    `tls_spki_sha256=${a.tlsSpki ?? ''}`,
    `signed_at=${a.signedAt}`,
    ''
  ].join('\n')
}

export interface JudgeInput {
  /** The answer to POST CHALLENGE_PATH, or 'unreachable'. */
  reply: { status: number; json: unknown } | 'unreachable'
  nonce: string
  nowS: number
  pinned: PinnedIdentity | null
  /** The TLS SPKI digest this connection is pinned to (what the handshake proved), or null for a plain connection. */
  tlsSpki: string | null
  verify: (message: string, signature: string, publicKey: string) => boolean
}

/** What one answer means. */
export function judge(input: JudgeInput): Verdict {
  const { reply, nonce, nowS, pinned, tlsSpki, verify } = input
  if (reply === 'unreachable' || reply.status === 429 || reply.status >= 500) return { kind: 'unreachable' }
  // An older Prometheus: no such route (404, 405), or its bearer middleware turning away a request with no key (401, 403).
  const unanswered = [401, 403, 404, 405].includes(reply.status)
  if (unanswered) return pinned ? { kind: 'refused', why: 'downgrade' } : { kind: 'unproved' }
  const a = reply.status === 200 ? parseAnswer(reply.json) : null
  if (!a) return pinned ? { kind: 'refused', why: 'malformed' } : { kind: 'unproved' }
  if (!verify(challengeMessage(nonce, a), a.sig, a.nodePub)) return { kind: 'refused', why: 'bad-signature' }
  if (Math.abs(nowS - a.signedAt) > MAX_SKEW_S) return { kind: 'refused', why: 'stale' }
  if (a.tlsSpki !== tlsSpki) return { kind: 'refused', why: 'channel' }
  if (!pinned) return { kind: 'first', instanceId: a.instanceId, nodePub: a.nodePub }
  if (a.nodePub === pinned.nodePub) {
    // The same machine. A different vault adopted there is a different Prometheus; a first instance_id is learned.
    if (pinned.instanceId !== null && a.instanceId !== pinned.instanceId) return { kind: 'other', instanceId: a.instanceId, nodePub: a.nodePub }
    return { kind: 'proved' }
  }
  if (a.instanceId !== null && a.instanceId === pinned.instanceId) return { kind: 'moved', instanceId: a.instanceId, nodePub: a.nodePub, was: pinned.nodePub }
  return { kind: 'other', instanceId: a.instanceId, nodePub: a.nodePub }
}

/** Whether the key may go, by verdict alone (main may still switch to another folder first). */
export function keyMayGo(v: Verdict): boolean {
  return v.kind === 'proved' || v.kind === 'first' || v.kind === 'unproved'
}

/** What ConnectionStatus.identity carries for the screen. */
export type IdentityNotice = { kind: 'moved' } | { kind: 'other' } | { kind: 'refused'; why: RefusedWhy } | { kind: 'unproved' }

export interface IdentityCard {
  title: string
  body: string
  /** Offer [It moved — trust the new key]. */
  trust: boolean
}

/** The card for a notice, about the Prometheus at `host` (null for 'unproved', which blocks nothing and shows no card). */
export function identityCard(host: string, n: IdentityNotice): IdentityCard | null {
  switch (n.kind) {
    case 'unproved':
      return null
    case 'moved':
      return {
        title: `The computer key of the Prometheus at ${host} has changed.`,
        body: "If it moved to a new computer, confirm it and Beacon will trust the new key. If it didn't move, don't connect: something else may be answering in its place. Beacon has sent it nothing.",
        trust: true
      }
    case 'other':
      return {
        title: `Something else is answering at ${host}.`,
        body: "It isn't the Prometheus Beacon knows there, so Beacon sent it nothing. If that Prometheus was set up again from scratch, connect to it again.",
        trust: false
      }
    case 'refused':
      return { title: `The Prometheus at ${host} couldn't prove who it is.`, body: REFUSED_BODY[n.why], trust: false }
  }
}

const REFUSED_BODY: Record<RefusedWhy, string> = {
  'bad-signature': "Its answer wasn't signed by the key Beacon knows for it. Beacon sent it nothing.",
  stale: 'Its answer was signed at a time too far from this computer’s clock. Check the date and time on both computers, then try again.',
  channel: 'Its answer was meant for a different connection than this one. Beacon sent it nothing.',
  downgrade: 'It used to prove who it is with its key, and now it doesn’t answer the question. Beacon sent it nothing.',
  malformed: "Its answer couldn't be read. Beacon sent it nothing."
}
