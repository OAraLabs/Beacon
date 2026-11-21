// Where the gym's status document comes from. THE ONE PLACE THAT KNOWS.
//
// The panel (GymPanel.tsx) draws a GymStatus. The parser (@shared/gym, parseGymStatus) turns a `gym-status/1` document into one.
// Neither knows how the document was fetched: the reader (./gym-status.ts) asks a GymTransport for "the document, or why
// there is none", and that is all it knows.
//
//   TODAY: `statusServiceTransport` below. The gym's own status service, asked directly: Tailscale only, with this computer's
//   token for that service.
//
//   LATER: the Prometheus gateway Beacon is already paired with, serving the same document under a read-only gym scope. That
//   is a second GymTransport (the gateway's address and Beacon's existing pairing instead of an address and a token of its
//   own), chosen where main builds the reader (src/main/index.ts). Nothing in the panel, the parser or the reader changes,
//   and the address and token settings here go away with this transport.
//
// A transport's rules, whichever it is: GET only, nothing sent but what it needs to be let in, no redirect followed, a bounded
// read, and an answer that is data (never a thrown error).
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { GYM_ADDRESS_COPY, GYM_MAX_BYTES, gymAddress, gymToken, tailscaleOnly, type GymAddress, type GymSettings } from '@shared/gym'

/** The document, parsed from JSON but not yet read as a status; or why there is none. `same`: nothing changed since the last
 *  document this transport gave (the reader keeps that one). */
export type GymFetch =
  | { kind: 'document'; json: unknown }
  | { kind: 'same' }
  | { kind: 'unset' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable' }
  | { kind: 'no-token' }
  | { kind: 'denied'; why: 'token' | 'device' | 'rate' }
  | { kind: 'unreadable' }

export interface GymTransport {
  fetch(): Promise<GymFetch>
  /** Told when the last document it gave was not a status, so it does not answer `same` about it. Optional. */
  discardLast?(): void
}

// ── today's transport: the gym's status service, over Tailscale, with a per-device token ────────────────────────────────────
//   * The host is resolved here, every address it resolves to must be a Tailscale one (tailscaleOnly), and the connection is
//     made to the address that was checked (the request's own `lookup` answers it), so a name cannot be judged at one
//     address and then reached at another.
//   * The token goes in the Authorization header, only after that check, only to that address. With no token nothing is
//     sent at all. It is never logged, never put in a URL, and never given to the page.
//   * If-None-Match with the last ETag: an unchanged snapshot comes back as a 304 and no body.

export type GymResolve = (host: string) => Promise<string[]>
export interface GymHttpReply {
  status: number
  text: string
  etag: string | null
}
/** GET `url`, connecting to `address` whatever the URL's host resolves to now. */
export type GymGet = (url: string, address: string, headers: Record<string, string>) => Promise<GymHttpReply | 'unreachable' | 'too-big'>

export interface StatusServiceDeps {
  /** The saved address, or null. */
  address: () => string | null
  saveAddress: (url: string) => void
  /** The token, from where it is kept encrypted, or null. Reading it asks the OS keychain, which can ask the person: the
   *  transport calls this ONCE and keeps the answer in memory (see `token()` below). */
  readToken: () => string | null
  /** Keep a token ('' forgets it). False: it could not be kept (no keychain). */
  saveToken: (token: string) => boolean
  resolve?: GymResolve
  get?: GymGet
}

const resolveAll: GymResolve = async (host) => (isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address))

/** The longest a whole request may take, however slowly the answer drips in (the 8 s below only ends a silence). */
const DEADLINE_MS = 20_000

const getPinned: GymGet = (url, address, headers) =>
  new Promise((done) => {
    const u = new URL(url)
    const family = isIP(address)
    let req: http.ClientRequest
    const deadline = setTimeout(() => {
      req?.destroy()
      done('unreachable')
    }, DEADLINE_MS)
    const finish = (r: Awaited<ReturnType<GymGet>>): void => {
      clearTimeout(deadline)
      done(r)
    }
    try {
      req = start()
    } catch {
      return finish('unreachable') // a header node refuses, say: an answer, never a throw
    }
    req.on('timeout', () => req.destroy())
    req.on('error', () => finish('unreachable'))
    req.end()

    function start(): http.ClientRequest {
      return (u.protocol === 'https:' ? https : http).request(
      u,
      {
        method: 'GET',
        // A connection of its own, never one from the shared pool: the pool is keyed by name and port, not by the address
        // that was checked, so a socket somebody else opened to the same name could be reused. No pool, no proxy agent.
        agent: false,
        headers: { accept: 'application/json', ...headers },
        timeout: 8_000,
        // The checked address, whoever asks and however: nothing else is ever connected to.
        lookup: (_host, opts, cb) => {
          if (typeof opts === 'object' && opts.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }])
          else cb(null, address, family)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > GYM_MAX_BYTES) {
            req.destroy()
            finish('too-big')
          } else chunks.push(c)
        })
        const etag = res.headers.etag
        res.on('end', () => finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), etag: typeof etag === 'string' ? etag : null }))
        res.on('error', () => finish('unreachable'))
      }
      )
    }
  })

/** scheme://host:port of a URL, or '' when it is not one. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
/** An ETag that may be sent back in a header: a quoted run of visible ASCII, weak or strong, at most 200 long. */
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/

export class StatusServiceTransport implements GymTransport {
  /** The last document's ETag, with the URL and token it was given for: a change of either starts again. */
  private last: { etag: string; for: string } | null = null

  /** The token, in memory. `undefined`: not read yet. It is read from the keychain-sealed file once, the first time it is
   *  needed, and after that only this copy is used: a refresh every 30 s, the page asking whether one is kept, and a save
   *  must never each go back to the keychain (on macOS every such read can raise the system's prompt). Main's memory only:
   *  never the page's, never a log's. */
  private kept: string | null | undefined = undefined

  constructor(private readonly deps: StatusServiceDeps) {}

  private token(): string | null {
    if (this.kept === undefined) this.kept = gymToken(this.deps.readToken())
    return this.kept
  }

  /** What the page may know: the address, and whether there is a token. */
  settings(): GymSettings {
    return { address: this.deps.address() ?? '', hasToken: this.token() !== null }
  }

  /** Keep a new address ('' forgets it). It is checked the way a fetch checks it, so one Beacon would refuse is never saved. */
  async setAddress(raw: unknown): Promise<GymAddress | { ok: true; url: ''; host: '' }> {
    if (typeof raw !== 'string' || raw.length > 300) return { ok: false, reason: GYM_ADDRESS_COPY.notUrl }
    // Nothing kept is dropped until an address is really saved: a refused one changes nothing.
    const changed = (): void => {
      this.last = null
      this.flying = null // a request already on its way is the old settings': the next read starts its own
    }
    if (raw.trim() === '') {
      changed()
      this.deps.saveAddress('')
      return { ok: true, url: '', host: '' }
    }
    const parsed = gymAddress(raw)
    if (!parsed.ok) return parsed
    const where = await this.where(parsed.host)
    if (!where.ok) return where
    // THE TOKEN BELONGS TO THE COMPUTER IT WAS MADE FOR. A new address that is another computer or another port forgets the
    // token before it is saved, so a token is never sent anywhere but where the person gave it for: pointing Beacon at a
    // different Tailscale address (a shared node, a mistyped name) must not hand that address the gym's token.
    const before = this.deps.address()
    if (before && originOf(before) !== originOf(parsed.url) && this.token() !== null) {
      if (!this.deps.saveToken('')) return { ok: false, reason: GYM_ADDRESS_COPY.noKeychain }
      this.kept = null
    }
    changed()
    this.deps.saveAddress(parsed.url)
    return parsed
  }

  /** Keep a new token ('' forgets it). Answers only whether it was kept. */
  setToken(raw: unknown): { ok: true } | { ok: false; reason: string } {
    const forget = typeof raw === 'string' && raw.trim() === ''
    const token = forget ? null : gymToken(raw)
    if (!forget && token === null) return { ok: false, reason: GYM_ADDRESS_COPY.badToken }
    if (!this.deps.saveToken(token ?? '')) return { ok: false, reason: GYM_ADDRESS_COPY.noKeychain }
    this.kept = token // what was just sealed is what is used: it is not read back
    this.last = null
    this.flying = null
    return { ok: true }
  }

  private async where(host: string): Promise<ReturnType<typeof tailscaleOnly>> {
    let addresses: string[] = []
    try {
      addresses = await (this.deps.resolve ?? resolveAll)(host)
    } catch {
      /* does not resolve: tailscaleOnly says so */
    }
    return tailscaleOnly(addresses)
  }

  /** One request at a time: a poll that arrives while one is in flight is given that one's answer. */
  private flying: Promise<GymFetch> | null = null
  fetch(): Promise<GymFetch> {
    if (this.flying) return this.flying
    const p: Promise<GymFetch> = this.fetchOnce().finally(() => {
      if (this.flying === p) this.flying = null
    })
    this.flying = p
    return p
  }

  /** The document just handed out was not a status after all: forget its ETag, so "unchanged" is never said of it. */
  discardLast(): void {
    this.last = null
  }

  private async fetchOnce(): Promise<GymFetch> {
    const saved = this.deps.address()
    if (!saved) return { kind: 'unset' }
    const parsed = gymAddress(saved)
    if (!parsed.ok) return { kind: 'refused', reason: parsed.reason }
    const token = this.token()
    if (token === null) return { kind: 'no-token' } // nothing is sent without one: the service would only say no
    const where = await this.where(parsed.host)
    if (!where.ok) return { kind: 'refused', reason: where.reason }
    const tag = `${parsed.url}\n${token}`
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (this.last && this.last.for === tag) headers['if-none-match'] = this.last.etag
    const reply = await (this.deps.get ?? getPinned)(parsed.url, where.address, headers)
    if (reply === 'unreachable') return { kind: 'unreachable' }
    if (reply === 'too-big') return { kind: 'unreadable' }
    if (reply.status === 304 && headers['if-none-match']) return { kind: 'same' }
    if (reply.status === 401) return { kind: 'denied', why: 'token' }
    if (reply.status === 403) return { kind: 'denied', why: 'device' }
    if (reply.status === 429) return { kind: 'denied', why: 'rate' }
    if (reply.status !== 200) return { kind: 'unreadable' }
    let json: unknown
    try {
      json = JSON.parse(reply.text)
    } catch {
      return { kind: 'unreadable' }
    }
    this.last = reply.etag && ETAG.test(reply.etag) ? { etag: reply.etag, for: tag } : null
    return { kind: 'document', json }
  }
}
