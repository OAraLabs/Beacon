// Finding a Prometheus without trusting it — the main-process half (the pure model is @shared/discovery).
//
// A search looks in up to three places and asks each computer one question:
//   GET /api/hello, with no credential, no cookie, no body, no redirect. Nothing else is ever sent to a
//   computer found this way. Finding it never connects to it: that takes an approval (docs/ONBOARDING-v0.4.0.md, S1).
//
//   loopback  this Mac, at 127.0.0.1                         no macOS permission involved
//   tailnet   online desktop peers from `tailscale status`   the CLI only: never the ssh-agent
//   bonjour   `dns-sd -Z _prometheus._tcp local`             may raise macOS's Local Network prompt
//
// A QUIET search is loopback only. It runs while the person is still reading Welcome, before Beacon has
// explained why it wants to look at the network, so it must not be able to trigger that prompt.
//
// Bonjour goes through the system's own `dns-sd`, run as Beacon's child, for two reasons: macOS attributes
// the Local Network permission to the app that runs it, and a refusal comes back as a plain error
// (kDNSServiceErr_PolicyDenied, -65570) that raw multicast sockets cannot report: with those, "denied"
// and "nothing there" look the same.
import { hostScope } from '@shared/plain-lan'
import { plainPublicRefusal } from './plain-public'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import {
  HELLO_TIMEOUT_MS,
  MAX_HELLO_BYTES,
  MAX_HELLOS,
  ZoneAssembler,
  helloUrl,
  isPolicyDenied,
  mergeSightings,
  parseHelloBody,
  sightingFromInstance,
  tailnetTargets,
  validEndpoint,
  type DiscoveryEnv,
  type DiscoveryUpdate,
  type Endpoint,
  type Hello,
  type LanState,
  type ProbeAddressResult,
  type Sighting
} from '@shared/discovery'
import { tailnetPeers } from './tailnet'
import { askHelloOverTls } from './tls-pin'

const SYSTEM_DNSSD = '/usr/bin/dns-sd'
/** How long past the search window a lookup process may live if Beacon dies without stopping it. */
const CHILD_GRACE_S = 25

export type HelloOutcome = Hello | 'unreachable' | 'not-prometheus'

/** One small answer from a computer that is not trusted. */
export type SmallResponse = { status: number; text: string } | 'unreachable' | 'too-big'

/** A GET with no credential, no cookie, no body and no redirect followed, that reads at most MAX_HELLO_BYTES of the
 *  answer: what answers is not trusted, and a hello is a few hundred bytes. The one way Beacon looks at a computer
 *  before anyone has approved it, shared by discovery (the hello) and the set-up check (is a Prometheus already
 *  here). `status` is whatever the computer answered, including 401 and 404. */
export async function fetchSmall(url: string, timeoutMs: number = HELLO_TIMEOUT_MS, signal?: AbortSignal): Promise<SmallResponse> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'error', // a redirect is somewhere else, and nobody asked to go there
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return 'unreachable'
  }
  if (!res.body) return { status: res.status, text: '' }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_HELLO_BYTES) {
        await reader.cancel().catch(() => undefined)
        return 'too-big'
      }
      chunks.push(value)
    }
  } catch {
    return 'unreachable'
  }
  return { status: res.status, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}

/** Ask one computer who it is. The whole of what discovery says to a computer: a GET, no credential. */
export async function askHello(ep: Endpoint, timeoutMs: number = HELLO_TIMEOUT_MS, signal?: AbortSignal): Promise<HelloOutcome> {
  const r = await fetchSmall(helloUrl(ep), timeoutMs, signal)
  if (r === 'unreachable') return 'unreachable'
  if (r === 'too-big' || r.status < 200 || r.status > 299) return 'not-prometheus'
  return parseHelloBody(r.text) ?? 'not-prometheus'
}

/** Ask a computer who it is the way it says it can be asked: hello in plain HTTP, or, for one that says it speaks TLS, hello OVER
 *  TLS with no pin and no credential, whose fp must be the key it presented (docs/MULTI-COMPUTER-v0.4.md §3.2, §4). A TLS
 *  computer is never asked in plain: that would be a downgrade. Null when it does not answer as a Prometheus. */
export async function confirmHello(ep: Endpoint, tls: boolean, timeoutMs: number = HELLO_TIMEOUT_MS, signal?: AbortSignal): Promise<Hello | null> {
  if (!tls) {
    const h = await askHello(ep, timeoutMs, signal)
    return typeof h === 'string' ? null : h
  }
  const met = await askHelloOverTls(ep.host, ep.port, timeoutMs, signal)
  if (!met.hello || !met.spkiHex || met.hello.fp !== met.spkiHex.slice(0, 16)) return null
  return { ...met.hello, tls: true }
}

export interface DiscoveryDeps {
  /** The (already gated) overrides: DISCOVERY_DEFAULTS in a release build. */
  env: () => DiscoveryEnv
  /** The process environment, for finding the tailscale CLI. */
  processEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home?: string
}

interface Run {
  session: number
  abort: AbortController
  sightings: Sighting[]
  lan: LanState
  pending: Set<string>
  child: ChildProcess | null
  timers: NodeJS.Timeout[]
  flush: NodeJS.Timeout | null
  onUpdate: (u: DiscoveryUpdate) => void
}

export class DiscoveryEngine {
  private session = 0
  private run: Run | null = null

  constructor(private readonly deps: DiscoveryDeps) {}

  /** Begin a search, replacing any search in progress. Returns its session number. */
  start(opts: { quiet: boolean }, onUpdate: (u: DiscoveryUpdate) => void): number {
    this.stop()
    const env = this.deps.env()
    const run: Run = {
      session: ++this.session,
      abort: new AbortController(),
      sightings: [],
      lan: 'off',
      pending: new Set(),
      child: null,
      timers: [],
      flush: null,
      onUpdate
    }
    this.run = run
    const want = (name: 'loopback' | 'tailnet' | 'bonjour'): boolean => env.sources.has(name) && (name === 'loopback' || !opts.quiet)
    for (const name of ['loopback', 'tailnet', 'bonjour'] as const) if (want(name)) run.pending.add(name)
    if (run.pending.size === 0) {
      this.emit(run, true)
      return run.session
    }
    this.emit(run, false)
    if (want('loopback')) void this.askLoopback(run, env)
    if (want('tailnet')) void this.askTailnet(run, env)
    if (want('bonjour')) this.browseBonjour(run, env)
    return run.session
  }

  /** End the search: no more updates, no more questions, and no lookup process left running. */
  stop(): void {
    const run = this.run
    if (!run) return
    this.run = null
    run.abort.abort()
    for (const t of run.timers) clearTimeout(t)
    if (run.flush) clearTimeout(run.flush)
    run.child?.kill('SIGTERM')
    run.child = null
  }

  /** Ask one typed address (Advanced). The port that was typed is the port that is asked: in plain HTTP first, and, when nothing
   *  answers that way, over TLS (a home-network Prometheus's TLS port), with the same rule about the key (§4). */
  async probeAddress(req: unknown): Promise<ProbeAddressResult> {
    if (!validEndpoint(req)) return { ok: false, reason: 'invalid' }
    const ep: Endpoint = { host: req.host, port: req.port }
    // TLS first. A home-network address is never asked in plain (src/shared/plain-lan.ts): what does not answer over TLS there is
    // an old Prometheus, or something pretending to be one, and either way Beacon will not connect to it in plain.
    const overTls = await confirmHello(ep, true)
    if (!overTls && hostScope(ep.host) === 'home-network') return { ok: false, reason: 'not-encrypted' }
    // Nor in plain to the internet (src/main/plain-public.ts): not asked, not even hello.
    const at = ep.host.includes(':') ? `[${ep.host}]` : ep.host
    if (!overTls && (await plainPublicRefusal(`http://${at}:${ep.port}`, `ws://${at}:${ep.port}`))) return { ok: false, reason: 'not-encrypted-public' }
    const plain = overTls ? null : await askHello(ep)
    const hello = overTls ?? (typeof plain !== 'string' ? plain : null)
    if (!hello) return { ok: false, reason: plain === 'unreachable' ? 'unreachable' : 'not-prometheus' }
    const [computer] = mergeSightings([{ source: 'typed', endpoint: ep, hello }])
    return { ok: true, computer }
  }

  private live(run: Run): boolean {
    return this.run === run
  }

  private see(run: Run, s: Sighting): void {
    if (!this.live(run)) return
    run.sightings.push(s)
    this.emit(run, false)
  }

  private finished(run: Run, source: string): void {
    if (!this.live(run)) return
    run.pending.delete(source)
    this.emit(run, run.pending.size === 0)
  }

  /** Debounced while a search is busy; immediate when it is done. */
  private emit(run: Run, done: boolean): void {
    if (!this.live(run)) return
    const send = (): void => {
      run.flush = null
      if (!this.live(run)) return
      run.onUpdate({ session: run.session, computers: mergeSightings(run.sightings), lan: run.lan, done: run.pending.size === 0 })
    }
    if (done) {
      if (run.flush) clearTimeout(run.flush)
      send()
    } else if (!run.flush) {
      run.flush = setTimeout(send, 40)
    }
  }

  private async askLoopback(run: Run, env: DiscoveryEnv): Promise<void> {
    const endpoint = { host: '127.0.0.1', port: env.port }
    const hello = await askHello(endpoint, HELLO_TIMEOUT_MS, run.abort.signal)
    if (typeof hello !== 'string') this.see(run, { source: 'loopback', endpoint, hello })
    this.finished(run, 'loopback')
  }

  private async askTailnet(run: Run, env: DiscoveryEnv): Promise<void> {
    try {
      const status = await tailnetPeers(this.deps.processEnv, this.deps.home ?? homedir())
      if (status.available && this.live(run)) {
        await Promise.all(
          tailnetTargets(status.peers, env.port).map(async (endpoint) => {
            const hello = await askHello(endpoint, HELLO_TIMEOUT_MS, run.abort.signal)
            if (typeof hello !== 'string') this.see(run, { source: 'tailnet', endpoint, hello })
          })
        )
      }
    } catch {
      // No tailnet is not an error: most people have none.
    }
    this.finished(run, 'tailnet')
  }

  private browseBonjour(run: Run, env: DiscoveryEnv): void {
    const tool = env.dnssd || SYSTEM_DNSSD
    if (this.deps.platform !== 'darwin' && !env.dnssd) {
      run.lan = 'unsupported'
      this.finished(run, 'bonjour')
      return
    }
    const lifetimeS = Math.ceil(env.windowMs / 1000) + CHILD_GRACE_S
    const child = spawn(tool, [...env.bonjourFlags, '-t', String(lifetimeS), '-Z', '_prometheus._tcp', 'local'], { stdio: ['ignore', 'pipe', 'pipe'] })
    run.child = child
    run.lan = 'searching'
    const zone = new ZoneAssembler()
    // #700: a record can outlive its daemon, so nothing is shown until hello answers at its address. Each record (address, port,
    // TLS or not) is asked once per search; what answered is shown in its own words, not its advertisement's.
    const confirmed = new Map<string, Sighting | null | 'asking'>()
    const asking = new Set<Promise<void>>()
    const keyOf = (s: Sighting): string => `${s.endpoint.host}|${s.endpoint.port}|${s.hello.tls ? 'tls' : 'plain'}`
    let present: Sighting[] = []
    // Set once the search's last word for Bonjour is said: nothing it hears afterwards is shown.
    let closed = false
    const show = (): void => {
      if (closed) return
      run.sightings = run.sightings.filter((x) => x.source !== 'bonjour')
      for (const s of present) {
        const c = confirmed.get(keyOf(s))
        if (c && c !== 'asking') run.sightings.push(c)
      }
      this.emit(run, false)
    }
    let failed = false
    const fail = (state: LanState): void => {
      if (failed || !this.live(run)) return
      failed = true
      closed = true
      run.lan = state
      child.kill('SIGTERM')
      this.finished(run, 'bonjour')
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (isPolicyDenied(chunk)) return fail('denied')
      if (closed) return
      zone.push(chunk)
      present = []
      for (const inst of zone.instances()) {
        const s = sightingFromInstance(inst)
        if (!s) continue
        present.push(s)
        const key = keyOf(s)
        if (confirmed.has(key) || confirmed.size >= MAX_HELLOS) continue
        confirmed.set(key, 'asking')
        const p = confirmHello(s.endpoint, s.hello.tls, HELLO_TIMEOUT_MS, run.abort.signal)
          .catch(() => null)
          .then((hello) => {
            confirmed.set(key, hello ? { source: 'bonjour', endpoint: s.endpoint, hello } : null)
            asking.delete(p)
            if (this.live(run)) show()
          })
        asking.add(p)
      }
      show()
    })
    child.stderr?.on('data', (chunk: string) => {
      if (isPolicyDenied(chunk)) fail('denied')
    })
    child.on('error', () => fail('unavailable')) // ENOENT, EACCES: the tool could not be run
    child.on('exit', (code) => {
      // An exit before the window closes, with nothing said about permission, is a tool that did not work.
      if (!failed && this.live(run) && code !== 0 && code !== null && run.lan === 'searching') fail('unavailable')
    })
    run.timers.push(
      setTimeout(() => {
        if (failed || !this.live(run)) return
        if (run.lan === 'searching') run.lan = 'ok'
        child.kill('SIGTERM')
        // A record seen just before the window closed is still being asked: wait for those answers (each is bounded by the
        // hello timeout), so the last word of the search includes them.
        void Promise.race([Promise.allSettled([...asking]), new Promise((r) => run.timers.push(setTimeout(r, HELLO_TIMEOUT_MS * 3)))]).then(() => {
          if (closed || !this.live(run)) return
          closed = true
          this.finished(run, 'bonjour')
        })
      }, env.windowMs)
    )
  }
}
