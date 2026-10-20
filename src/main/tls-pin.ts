// TLS pinning (docs/MULTI-COMPUTER-v0.4.md §3): Beacon pins the SHA-256 of a home-network Prometheus's certificate public key
// (SPKI DER, all 32 bytes; the pairing contract §7.3), learns it at the first request, and refuses any connection that
// presents another key BEFORE a byte of the request is sent.
//
// Why the check lives in the connect step, not in checkServerIdentity: Prometheus's certificate is self-signed, and Node's TLS
// fails a self-signed chain before checkServerIdentity is ever called. So the socket is opened with chain checks off
// (rejectUnauthorized: false: names, dates and issuer mean nothing for a self-signed key), and handed to HTTP only after the
// key it presented is the pinned one. REST goes through an undici Agent whose `connect` does that (the same undici 7 that
// Electron's own fetch runs on); the WebSocket through an https.Agent whose createConnection does the same.
import { X509Certificate, createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import WebSocket from 'ws'
import { MAX_HELLO_BYTES, parseHelloBody, type Hello } from '@shared/discovery'

const PIN = /^[0-9a-f]{64}$/
const B64URL = /^[A-Za-z0-9_-]+$/
/** How long a TLS handshake may take before the connection is given up. */
const HANDSHAKE_MS = 8_000

/** Hex SHA-256 of a certificate's SubjectPublicKeyInfo (DER). */
export function spkiSha256(certDer: Buffer): string {
  const spki = new X509Certificate(certDer).publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('hex')
}

type LookupFn = (host: string, options: object, cb: (err: Error | null, address: unknown, family?: number) => void) => void
/** A lookup for the sockets opened here: a `.local` name is asked for IPv4 first. A home-network Prometheus is IPv4-only by its
 *  contract (#700), and macOS's resolver, asked with no family, waits out the AAAA query: measured 5,010 ms for an IPv4-only
 *  .local name, against 8 ms with family 4, while hello over TLS gives up at 4 s. No IPv4 answer: the usual lookup. Any other
 *  name: untouched. */
export function localLookupWith(base: LookupFn): LookupFn {
  return (host, options, cb) => {
    if (!/\.local\.?$/i.test(host)) return base(host, options, cb)
    base(host, { ...options, family: 4 }, (err, address, family) => (err ? base(host, options, cb) : cb(err, address, family)))
  }
}
const localLookup = localLookupWith(dnsLookup as unknown as LookupFn)

/** The pin of the key a connected TLS socket's peer presented, or null when it presented none Beacon can read. */
function presented(socket: tls.TLSSocket): string | null {
  try {
    const cert = socket.getPeerX509Certificate()
    return cert ? spkiSha256(cert.raw) : null
  } catch {
    return null
  }
}

/** Open a TLS socket and hand it over only once the handshake is done and (with `pin`) the presented key is the pinned one.
 *  Nothing is written to the socket before that. `seen` hears the presented key either way. */
function openTls(
  o: { host: string; port: number; servername?: string; alpn?: string[] },
  pin: string | null,
  done: (err: Error | null, socket?: tls.TLSSocket) => void,
  seen?: (spki: string | null) => void
): void {
  let settled = false
  const finish = (err: Error | null, socket?: tls.TLSSocket): void => {
    if (settled) return
    settled = true
    done(err, socket)
  }
  const socket = tls.connect({
    host: o.host,
    port: o.port,
    // SNI is a name, never an address (Node warns on an IP); the name is not checked either way.
    ...(o.servername && !isIP(o.servername) ? { servername: o.servername } : {}),
    rejectUnauthorized: false,
    lookup: localLookup as unknown as tls.ConnectionOptions['lookup'],
    ...(o.alpn ? { ALPNProtocols: o.alpn } : {})
  })
  socket.setTimeout(HANDSHAKE_MS, () => {
    socket.destroy()
    finish(new Error('the TLS handshake took too long'))
  })
  socket.once('secureConnect', () => {
    socket.setTimeout(0)
    const got = presented(socket)
    seen?.(got)
    if (pin !== null && got !== pin) {
      socket.destroy()
      for (const l of mismatchListeners) {
        try {
          l({ pinned: pin, presented: got, host: o.host, port: o.port })
        } catch {
          /* a listener's failure is not the connection's */
        }
      }
      finish(new PinMismatch(pin, got))
      return
    }
    finish(null, socket)
  })
  socket.once('error', (e) => finish(e))
}

export interface PinMismatchReport {
  pinned: string
  presented: string | null
  host: string
  port: number
}
const mismatchListeners = new Set<(m: PinMismatchReport) => void>()
/** Hear about every connection refused because the server presented another key than the pinned one (docs/MULTI-COMPUTER-v0.4.md
 *  §3.4): REST from any caller and the WebSocket alike, since every pinned socket is made by openTls. Returns the unsubscribe. */
export function onPinMismatch(listener: (m: PinMismatchReport) => void): () => void {
  mismatchListeners.add(listener)
  return () => void mismatchListeners.delete(listener)
}

/** The key presented is not the pinned one. Carries both hashes, for "Copy details". */
export class PinMismatch extends Error {
  constructor(
    readonly pinned: string,
    readonly presented: string | null
  ) {
    super(`the server presented another key (pinned ${pinned}, presented ${presented ?? 'none'})`)
    this.name = 'PinMismatch'
  }
}

const agents = new Map<string, Agent>()
/** The undici Agent for one pin (shared, so connections are reused): every socket it opens is checked against the pin. */
export function pinnedAgent(pin: string): Agent {
  if (!PIN.test(pin)) throw new Error('not a pin')
  let a = agents.get(pin)
  if (!a) {
    a = new Agent({
      connect: (opts, cb) =>
        openTls({ host: opts.hostname, port: Number(opts.port) || 443, servername: opts.servername ?? opts.hostname, alpn: ['http/1.1'] }, pin, (err, s) =>
          err ? cb(err, null) : cb(null, s as tls.TLSSocket)
        )
    })
    agents.set(pin, a)
  }
  return a
}

/** A fetch that only talks TLS to a server presenting the pinned key (names, dates and issuer ignored). Never http://. */
export function pinnedFetch(pinHex: string): typeof fetch {
  const dispatcher = pinnedAgent(pinHex)
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:') return Promise.reject(new Error('a pinned connection is https only'))
    // `dispatcher` is undici's own RequestInit field, which Node's fetch honours.
    return fetch(input, { ...init, redirect: 'error', dispatcher } as unknown as RequestInit)
  }) as typeof fetch
}

/** An https.Agent for `ws`: its sockets are checked against the pin before the upgrade request is written. */
class PinnedWsAgent extends https.Agent {
  constructor(private readonly pin: string) {
    super({ keepAlive: false })
  }
  createConnection(o: https.RequestOptions, cb?: (err: Error | null, stream: Duplex) => void): undefined {
    openTls({ host: String(o.host ?? o.hostname ?? ''), port: Number(o.port) || 443, servername: o.servername ?? String(o.host ?? '') }, this.pin, (err, s) => cb?.(err, s as Duplex))
    return undefined
  }
}

/** A WebSocket that only opens to a server presenting the pinned key. Never ws://. */
export function openPinnedWebSocket(url: string, pinHex: string, headers?: Record<string, string>): Promise<WebSocket> {
  if (!PIN.test(pinHex)) return Promise.reject(new Error('not a pin'))
  if (!url.startsWith('wss://')) return Promise.reject(new Error('a pinned connection is wss only'))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent: new PinnedWsAgent(pinHex), headers, followRedirects: false, handshakeTimeout: HANDSHAKE_MS })
    ws.once('open', () => resolve(ws))
    ws.once('error', (e) => reject(e))
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate()
      reject(new Error(`the WebSocket upgrade was answered ${res.statusCode}`))
    })
  })
}

/** GET /api/hello over TLS with no pin (it carries no credential, and nothing is pinned yet), and the key the server presented. */
export function askHelloOverTls(host: string, port: number, timeoutMs = 4_000, signal?: AbortSignal): Promise<{ hello: Hello | null; spkiHex: string | null }> {
  return new Promise((resolve) => {
    let spkiHex: string | null = null
    let settled = false
    // A deadline for the whole ask, handshake included, not only for silences: a server dripping a byte now and then cannot hold
    // it. Cancelling (a search stopped or started again) ends it too.
    const deadline = setTimeout(() => (req.destroy(), finish(null)), timeoutMs)
    const cancel = (): void => (req.destroy(), finish(null))
    const finish = (hello: Hello | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      resolve({ hello, spkiHex })
    }
    const agent = new (class extends https.Agent {
      createConnection(o: https.RequestOptions, cb?: (err: Error | null, stream: Duplex) => void): undefined {
        openTls({ host, port, servername: o.servername ?? host }, null, (err, s) => cb?.(err, s as Duplex), (seen) => (spkiHex = seen))
        return undefined
      }
    })({ keepAlive: false })
    const req = https.request({ host, port, path: '/api/hello', method: 'GET', agent, headers: { accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return finish(null)
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
        if (body.length > MAX_HELLO_BYTES) {
          req.destroy()
          finish(null)
        }
      })
      res.on('end', () => finish(parseHelloBody(body)))
      res.on('error', () => finish(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => finish(null))
    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    req.end()
  })
}

/** First contact (§3.2): why the key Beacon met is not the one hello and the request answer describe, or null. hello's fp is the
 *  pin's first 16 hex characters (a TLS Prometheus always has one), and the request answer's instance_public_key (base64url
 *  SPKI DER) is the very key the certificate carried: the 4-digit code is computed over that key. */
export function checkFirstContact(i: { spkiHex: string; helloFp: string; instancePublicKey: string }): string | null {
  if (!PIN.test(i.spkiHex)) return 'no readable key was presented'
  if (i.helloFp !== i.spkiHex.slice(0, 16)) return `hello's fp "${i.helloFp}" is not the key presented (${i.spkiHex.slice(0, 16)})`
  if (!B64URL.test(i.instancePublicKey)) return 'the request answer names no readable key'
  const named = createHash('sha256').update(Buffer.from(i.instancePublicKey, 'base64url')).digest('hex')
  if (named !== i.spkiHex) return `the request answer names another key (${named.slice(0, 16)})`
  return null
}

// ── the connection's half (docs/MULTI-COMPUTER-v0.4.md §3.3) ─────────────────────────────────────────────────────────────
//
// Every caller in main reaches Prometheus through Node's global fetch (rest.ts, requestSmall, the rest of index.ts), so the
// pin is enforced in ONE place: the global dispatcher. A pinned computer's Prometheus ports get the pinned Agent over https
// and a refusal over plain http; anything else (another host, another port on the same host) goes where it always went.

/** Prometheus's own ports, beside the profile's: plain REST and WebSocket, and their TLS twins (the pairing contract §7.3). */
const PROMETHEUS_PORTS = [8005, 8010, 8006, 8011]

interface Applied {
  host: string
  pin: string
  ports: Set<number>
}
let applied: Applied | null = null

const portOf = (u: URL): number => (u.port ? Number(u.port) : u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80)
/** The applied pin when `u` is one of the pinned computer's Prometheus ports, else null. */
function pinnedFor(u: URL): Applied | null {
  return applied && u.hostname === applied.host && applied.ports.has(portOf(u)) ? applied : null
}

/** An Agent that never connects: plain HTTP to a pinned computer, or a pin that is not a pin. Nothing is sent. */
const refusing = new Agent({ connect: (_o, cb) => cb(new Error('refused: this Prometheus is reached over TLS with its pinned key, never in the clear'), null) })

/** The usual Agent, but resolving `.local` names IPv4 first (localLookupWith): for computers found by Bonjour that are not pinned. */
const localAgent = new Agent({ connect: { lookup: localLookup as never } })

class PinningDispatcher extends Dispatcher {
  constructor(private readonly base: Dispatcher) {
    super()
  }
  private route(origin: unknown): Dispatcher {
    switch (routeFor(String(origin))) {
      case 'pinned':
        return pinnedAgent((applied as Applied).pin)
      case 'refused':
        return refusing
      case 'local':
        return localAgent
      default:
        return this.base
    }
  }
  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.route(opts.origin).dispatch(opts, handler)
  }
  close(): Promise<void> {
    return this.base.close()
  }
  destroy(): Promise<void> {
    return this.base.destroy()
  }
}

let installed = false
/** Route Node's global fetch through the pins: an https origin of a pinned computer only to a server presenting its pin, and
 *  never plain HTTP to its Prometheus ports. Once, at startup; again is a no-op. */
export function installPinning(): void {
  if (installed) return
  installed = true
  setGlobalDispatcher(new PinningDispatcher(getGlobalDispatcher()))
}

/** The pins of the profile Beacon is connected to (null, or a profile without a pin: none). Replaces whatever was applied
 *  before. A pin that is not 64 lower-case hex still marks the computer as pinned, so it is refused rather than reached in the
 *  clear. */
export function applyPins(gw: { apiBase: string; wsUrl: string; pin?: string | null } | null): void {
  if (!gw || !gw.pin) {
    applied = null
    return
  }
  let api: URL
  let ws: URL
  try {
    api = new URL(gw.apiBase)
    ws = new URL(gw.wsUrl)
  } catch {
    applied = null
    return
  }
  applied = { host: api.hostname, pin: gw.pin, ports: new Set([portOf(api), ...(ws.hostname === api.hostname ? [portOf(ws)] : []), ...PROMETHEUS_PORTS]) }
}

/** Where the global fetch sends a request for `origin` now: the pinned Agent for the pinned computer over https, a refusal for it
 *  in plain (or with a pin that is not a pin), the IPv4-first Agent for any other `.local` name (a plain join or a hello to a
 *  computer found by Bonjour), and the usual Agent for everything else. */
export function routeFor(origin: string): 'base' | 'local' | 'pinned' | 'refused' {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return 'base'
  }
  const a = pinnedFor(u)
  if (a) return u.protocol === 'https:' && PIN.test(a.pin) ? 'pinned' : 'refused'
  return /\.local\.?$/i.test(u.hostname) ? 'local' : 'base'
}

/** Whether a refusal was the connection's own pin (the computer Beacon is connected to), and not another pinned request, such as
 *  a join's to some other computer: only the connection's is the connection's card (§3.4). */
export function isConnectionMismatch(m: PinMismatchReport): boolean {
  return applied !== null && m.pinned === applied.pin
}

/** What is pinned now (host and ports), for a test to read; the pin itself is not repeated. */
export function appliedPins(): { host: string; ports: number[] } | null {
  return applied ? { host: applied.host, ports: [...applied.ports].sort((x, y) => x - y) } : null
}

/** The connection's WebSocket: wss:// only to a server presenting the applied pin, and refused (thrown, before any connection)
 *  when no pin applies to it; ws:// to a pinned computer's Prometheus ports refused the same way; any other ws:// as before. */
export function openGatewayWebSocket(url: string, options?: WebSocket.ClientOptions): WebSocket {
  const u = new URL(url)
  const a = pinnedFor(u)
  if (u.protocol === 'wss:') {
    if (!a || !PIN.test(a.pin)) throw new Error('refused: a TLS WebSocket needs the pin Beacon learned when it joined this Prometheus')
    return new WebSocket(url, { ...options, agent: new PinnedWsAgent(a.pin), followRedirects: false })
  }
  if (a) throw new Error('refused: this Prometheus is reached over TLS with its pinned key, never in the clear')
  return new WebSocket(url, options)
}


