// The pin for Devices → Enrol's pairing code (0.4.3, @shared/devices pairPinSource / pairPinVerdict), decided in main BEFORE the page
// mints the one-shot token: the connected profile's pin, else GET /api/network's tls block; then a TLS handshake to the code's host on
// each port Beacon for iOS dials, reading the key it presents. Nothing is sent over those connections: the handshake is the question.
// The code also carries the node key Beacon pinned for this Prometheus (`node`), as pinned, not read again at pairing time.
import { connect } from 'node:tls'
import { nodeHex, pairPinSource, pairPinVerdict } from '@shared/devices'
import type { RequestFn } from './pairing/http'
import { spkiSha256 } from './tls-pin'

/** `node`: the pinned node key in the code's form (@shared/devices nodeHex), or null when none is pinned (an older Prometheus). */
export type PairPinDecision = { kind: 'plain'; node: string | null } | { kind: 'pinned'; pin: string; node: string | null } | { kind: 'refused'; message: string }

export interface PairPinDeps {
  profilePin: () => string | null
  /** The node key pinned for the connected Prometheus's folder (its identity, proved by the challenge), or null. */
  nodePub: () => string | null
  base: () => string | null
  token: () => string | null
  request: RequestFn
  ports: { api: number; ws: number }
  /** The SPKI SHA-256 the server at host:port presents, or 'unreachable'. */
  keyAt?: (host: string, port: number) => Promise<string>
}

/** One TLS handshake: the presented certificate's SPKI SHA-256 (hex), or 'unreachable'. The certificate is self-signed by design (the
 *  pin IS the trust), so it is not validated here: it is compared, by the caller, against the pin. */
export function tlsKeyAt(host: string, port: number, timeoutMs = 4_000): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    const sock = connect({ host, port, rejectUnauthorized: false, ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }) }, () => {
      const raw = sock.getPeerCertificate(false)?.raw
      finish(raw ? spkiSha256(raw) : 'unreachable')
    })
    sock.setTimeout(timeoutMs, () => finish('unreachable'))
    sock.on('error', () => finish('unreachable'))
  })
}

export class PairPin {
  constructor(private readonly deps: PairPinDeps) {}

  async decide(host: string): Promise<PairPinDecision> {
    const profilePin = this.deps.profilePin()
    let network: { status: number; body: unknown } | 'unreachable' = 'unreachable'
    if (!profilePin) {
      const base = this.deps.base()
      const token = this.deps.token()
      if (base) {
        const r = await this.deps.request({ method: 'GET', url: `${base}/api/network`, headers: token ? { authorization: `Bearer ${token}` } : {}, timeoutMs: 8_000 })
        network = typeof r === 'string' ? 'unreachable' : { status: r.status, body: r.json }
      }
    }
    const node = nodeHex(this.deps.nodePub())
    const source = pairPinSource(profilePin, network)
    if (source.kind === 'refused') return source
    if (source.kind === 'plain') return { kind: 'plain', node }
    const keyAt = this.deps.keyAt ?? tlsKeyAt
    const [api, ws] = await Promise.all([keyAt(host, this.deps.ports.api), keyAt(host, this.deps.ports.ws)])
    const verdict = pairPinVerdict(host, source.pin, api, ws)
    return verdict.kind === 'pinned' ? { ...verdict, node } : verdict
  }
}
