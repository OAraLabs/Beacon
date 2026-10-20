// Finding a Prometheus without trusting it (docs/ONBOARDING-v0.4.0.md, §4 path B and §7 S1) — the pure model.
//
// Anyone on the same Wi-Fi can advertise `_prometheus._tcp` under any name, including "My Mac mini". So
// what this file models is DISPLAY ONLY: three places to look, one question to ask (GET /api/hello, no
// credential), and a strict reading of every answer. Trust is established later, by an approval on a device
// the person already trusts (S1), never by what a computer says about itself here.
//
// Three sources, merged by fingerprint into one row per computer:
//   loopback  this Mac, asked at 127.0.0.1                  → "this Mac"
//   bonjour   _prometheus._tcp on the local network         → "your home network" (or this Mac, if it points here)
//   tailnet   online desktop peers of the Tailscale network → "your private network"
//
// Everything that arrives is untrusted text: an allowlist of five fields, length caps, control and
// bidirectional-override characters removed, counts capped. No Node/Electron imports (same rule as
// shared/setup-wizard.ts), so a headless smoke can hold all of it to account (smoke:discovery).
import { hostScope } from './plain-lan'
import type { TailnetPeer } from './tailscale'

export const DISCOVERY_SOURCES = ['loopback', 'bonjour', 'tailnet'] as const
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number]

export type Locality = 'this-mac' | 'home-network' | 'private-network' | 'typed'
/** What a client can do to join, as the computer says (docs/PAIRING-APPROVAL-API.md, 3.1): ask to be approved ('approve'), type the
 *  6-digit code it prints (setup mode only: 'code'), enter its API token ('token'), or nothing, because it has no password ('none'). */
export const PAIR_STYLES = ['approve', 'code', 'token', 'none'] as const
export type PairStyle = (typeof PAIR_STYLES)[number] | 'unknown'
const isPairStyle = (v: string): v is (typeof PAIR_STYLES)[number] => (PAIR_STYLES as readonly string[]).includes(v)

export interface Endpoint {
  host: string
  port: number
}

/** What a computer says about itself. Exactly these six facts, nothing else ever reaches the page. */
export interface Hello {
  version: string
  name: string
  agent: string
  /** First 16 hex characters of the instance key fingerprint, or '' when it gave none (or a bad one). */
  fp: string
  pair: PairStyle
  /** The port it advertises speaks TLS. Only the boolean true (or the TXT text "1") counts; Beacon cannot check a certificate yet. */
  tls: boolean
}

export interface DiscoveredComputer extends Hello {
  /** The fingerprint when there is one; otherwise where it answered ("127.0.0.1:8005"). */
  id: string
  where: Locality
  /** Every way it was reached, best first. */
  endpoints: Endpoint[]
  /** It can only be reached in plain on the home network, so Beacon cannot join it (src/shared/plain-lan.ts): an older Prometheus,
   *  or one without home network turned on. Not a row to choose; the search says so instead. */
  needsUpdate?: boolean
}

/** A search's three sources, plus 'typed': an address a person typed under Advanced. */
export type SightingSource = DiscoverySource | 'typed'

export interface Sighting {
  source: SightingSource
  endpoint: Endpoint
  hello: Hello
}

/** The network scan (Bonjour), reported honestly:
 *  off          not part of this search (a quiet one);
 *  searching    running;
 *  ok           ran, and its window has closed;
 *  denied       macOS refused Local Network access (kDNSServiceErr_PolicyDenied);
 *  unavailable  the lookup tool could not be run;
 *  unsupported  this platform has no such tool wired up yet. */
export type LanState = 'off' | 'searching' | 'ok' | 'denied' | 'unavailable' | 'unsupported'

/** What asking one typed address came to. */
export type ProbeAddressResult =
  | { ok: true; computer: DiscoveredComputer }
  | { ok: false; reason: 'invalid' | 'unreachable' | 'not-prometheus' | 'not-encrypted' | 'not-encrypted-public' }

export interface DiscoveryUpdate {
  /** Which search this is from; a stale one is ignored. */
  session: number
  computers: DiscoveredComputer[]
  lan: LanState
  done: boolean
}

export const DEFAULT_PORT = 8005
export const DEFAULT_WINDOW_MS = 8_000
/** A computer that has not answered in this long is given up on. */
export const HELLO_TIMEOUT_MS = 1_500
/** A hello larger than this is not a hello. */
export const MAX_HELLO_BYTES = 4_096
export const MAX_NAME = 64
export const MAX_COMPUTERS = 20
/** Bonjour is open to everyone on the Wi-Fi: how many advertised instances one search will keep. */
export const MAX_INSTANCES = 64
/** At most this many records are asked who they are in one search (each is one GET /api/hello): a network advertising more
 *  cannot make Beacon open more connections. */
export const MAX_HELLOS = 24
export const MAX_ZONE_LINE = 4_096
export const MAX_TXT_KEYS = 16
export const MAX_TAILNET_PROBES = 24

// ── reading untrusted text ──────────────────────────────────────────────────────────────────────

/** Control characters, zero-width characters and bidirectional overrides: none belong in a name shown to
 *  someone deciding whether to trust it, and the overrides can make "Mac mini" read as something else. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g

/** A string fact: a string, cleaned, trimmed, and not longer than `max` (longer reads as nothing). */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(UNSAFE_CHARS, '').trim()
  return t.length <= max ? t : ''
}

const FP = /^[0-9a-f]{16}$/

/** Hello facts from a record of untrusted values (JSON object or TXT map). `name` is required: a computer
 *  with no usable name is not worth showing, and `fallbackName` is what a Bonjour instance name offers. */
export function helloFrom(raw: unknown, fallbackName = ''): Hello | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const name = cleanText(r.name, MAX_NAME) || cleanText(fallbackName, MAX_NAME)
  if (!name) return null
  const fp = cleanText(r.fp, 32).toLowerCase()
  const pair = cleanText(r.pair, 16)
  return {
    version: cleanText(r.v, 32),
    name,
    agent: cleanText(r.agent, MAX_NAME),
    fp: FP.test(fp) ? fp : '',
    pair: isPairStyle(pair) ? pair : 'unknown',
    tls: r.tls === true || r.tls === '1'
  }
}

/** The body of GET /api/hello. */
export function parseHelloBody(text: string): Hello | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_HELLO_BYTES) return null
  try {
    return helloFrom(JSON.parse(text))
  } catch {
    return null
  }
}

// ── addresses ───────────────────────────────────────────────────────────────────────────────────

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const IPV6 = /^[0-9a-fA-F:]+$/

/** A host name, IPv4 address or IPv6 literal, and nothing that could carry a scheme, a path, a port, a
 *  credential or a second command into a URL or a shell. */
export function validHost(h: unknown): h is string {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false
  if (h.includes(':')) return IPV6.test(h) && (h.match(/:/g) ?? []).length >= 2
  return HOSTNAME.test(h)
}

export function validPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535
}

export function validEndpoint(e: unknown): e is Endpoint {
  return !!e && typeof e === 'object' && validHost((e as Endpoint).host) && validPort((e as Endpoint).port)
}

export function helloUrl(e: Endpoint): string {
  return `http://${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}/api/hello`
}

/** This machine: "localhost", the IPv6 loopback, or a literal 127.x.y.z. A NAME that merely starts with
 *  "127." is somebody's host name (a Bonjour advertiser picks its own), and is not this Mac. */
/** What a person typed under Advanced: "host", "host:port" or "[v6]:port". The port is kept as typed; with
 *  none the standard one is used, and the caller shows what was asked. null when it is not an address. */
export function parseTypedAddress(text: unknown): Endpoint | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(t)
  if (bracket) {
    // Brackets only make sense around an IPv6 literal; "[name]" is not an address.
    if (!bracket[1].includes(':')) return null
    const e = { host: bracket[1], port: bracket[2] === undefined ? DEFAULT_PORT : Number(bracket[2]) }
    return validEndpoint(e) ? e : null
  }
  const colons = (t.match(/:/g) ?? []).length
  if (colons >= 2) return validEndpoint({ host: t, port: DEFAULT_PORT }) ? { host: t, port: DEFAULT_PORT } : null
  const [host, port] = colons === 1 ? t.split(':') : [t, undefined]
  if (port !== undefined && !/^\d+$/.test(port)) return null
  const e = { host, port: port === undefined ? DEFAULT_PORT : Number(port) }
  return validEndpoint(e) ? e : null
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

// ── Bonjour, read through `dns-sd -Z` ───────────────────────────────────────────────────────────

/** `dns-sd` words a refusal by macOS as the error number, whatever else it says around it. */
export function isPolicyDenied(text: string): boolean {
  return /-65570\b|PolicyDenied/i.test(text)
}

/** Zone-file escapes: `\032` is a space, `\\` a backslash, `\"` a quote. */
function unescapeZone(s: string): string {
  return s.replace(/\\(\d{3}|.)/g, (_m, c: string) => (c.length === 3 ? String.fromCharCode(Number(c)) : c))
}

/** The quoted strings of a TXT record line: `"v=0.9.6" "name=Probe Mac mini"`. */
function quotedStrings(rest: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest)) !== null && out.length < 64) out.push(unescapeZone(m[1]))
  return out
}

export interface ZoneInstance {
  /** The instance name as advertised ("My Mac mini"), cleaned. */
  instance: string
  host: string
  port: number
  txt: Record<string, string>
}

const SERVICE_SUFFIX = '._prometheus._tcp'

/** Turns the streamed output of `dns-sd -Z _prometheus._tcp local` into advertised instances. Chunks may
 *  split anywhere; a line is read when it is complete. Everything is bounded, because anyone on the
 *  network can advertise: lines, instances and TXT keys are capped, and a record that fails validation is
 *  dropped instead of repaired. */
export class ZoneAssembler {
  private buf = ''
  private readonly srv = new Map<string, { host: string; port: number }>()
  private readonly txt = new Map<string, Record<string, string>>()

  push(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.line(line)
    }
    // A hostile peer cannot grow the buffer without end by never sending a newline.
    if (this.buf.length > MAX_ZONE_LINE) this.buf = ''
  }

  private owner(raw: string): string | null {
    if (!raw.endsWith(SERVICE_SUFFIX)) return null
    const name = cleanText(unescapeZone(raw.slice(0, -SERVICE_SUFFIX.length)), MAX_NAME)
    return name || null
  }

  private line(line: string): void {
    if (line.length === 0 || line.length > MAX_ZONE_LINE || line.startsWith(';')) return
    const srv = /^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+?)\.?(?:\s+;.*)?$/.exec(line)
    if (srv) {
      const name = this.owner(srv[1])
      const port = Number(srv[2])
      const host = srv[3].replace(/\.$/, '')
      if (name && validPort(port) && validHost(host) && (this.srv.has(name) || this.srv.size < MAX_INSTANCES)) this.srv.set(name, { host, port })
      return
    }
    const txt = /^(\S+)\s+TXT\s+(.*)$/.exec(line)
    if (txt) {
      const name = this.owner(txt[1])
      if (!name || (!this.txt.has(name) && this.txt.size >= MAX_INSTANCES)) return
      const map: Record<string, string> = {}
      let keys = 0
      for (const s of quotedStrings(txt[2])) {
        const eq = s.indexOf('=')
        if (eq <= 0) continue
        const k = s.slice(0, eq).toLowerCase()
        if (k in map || ++keys > MAX_TXT_KEYS) continue
        map[k] = s.slice(eq + 1)
      }
      this.txt.set(name, map)
    }
  }

  /** How many characters are buffered waiting for a newline. Bounded by MAX_ZONE_LINE: the bound is what
   *  keeps a peer that never ends a line from growing this process's memory, and nothing else observes it. */
  pending(): number {
    return this.buf.length
  }

  /** Instances that have said where they are (SRV). A missing TXT leaves an empty map. */
  instances(): ZoneInstance[] {
    return [...this.srv.entries()].map(([instance, at]) => ({ instance, host: at.host, port: at.port, txt: this.txt.get(instance) ?? {} }))
  }
}

/** A Bonjour instance as a sighting, or null when it does not describe a computer worth showing. */
export function sightingFromInstance(z: ZoneInstance): Sighting | null {
  const hello = helloFrom(z.txt, z.instance)
  if (!hello) return null
  return { source: 'bonjour', endpoint: { host: z.host, port: z.port }, hello }
}

// ── the tailnet ─────────────────────────────────────────────────────────────────────────────────

/** Where to ask each online desktop peer. Offline peers are not asked, and nor are phones (the peer list
 *  has already dropped them). The first address wins, a name is the fallback. */
export function tailnetTargets(peers: readonly Pick<TailnetPeer, 'online' | 'dnsName' | 'ips'>[], port: number): Endpoint[] {
  const out: Endpoint[] = []
  for (const p of peers) {
    if (!p.online || out.length >= MAX_TAILNET_PROBES) continue
    const host = (p.ips ?? []).find((ip) => validHost(ip)) ?? p.dnsName
    if (validHost(host)) out.push({ host, port })
  }
  return out
}

// ── merging ─────────────────────────────────────────────────────────────────────────────────────

const LOCALITY_RANK: Record<Locality, number> = { 'this-mac': 0, 'home-network': 1, 'private-network': 2, typed: 3 }
/** Whose words win when two sources describe one computer: the computer itself, asked directly, over what
 *  it advertised to the whole network. */
const SOURCE_PREFERENCE: Record<SightingSource, number> = { typed: 0, loopback: 0, tailnet: 1, bonjour: 2 }
const ENDPOINT_ORDER: Record<SightingSource, number> = { typed: 0, loopback: 0, bonjour: 1, tailnet: 2 }

export function localityOf(s: Sighting): Locality {
  if (s.source === 'loopback') return 'this-mac'
  if (s.source === 'bonjour') return isLoopbackHost(s.endpoint.host) ? 'this-mac' : 'home-network'
  if (s.source === 'typed') return 'typed' // shown as typed, so the port that was typed stays visible
  return 'private-network'
}

/** One row per computer. Two sightings are the same computer when they share a fingerprint; with none,
 *  when they share an address. */
export function mergeSightings(sightings: readonly Sighting[]): DiscoveredComputer[] {
  const groups = new Map<string, Sighting[]>()
  for (const s of sightings) {
    const key = s.hello.fp || `${s.endpoint.host}:${s.endpoint.port}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const out: DiscoveredComputer[] = []
  for (const [key, all] of groups) {
    // A computer seen over TLS proved its fp with its key. A plain record on the home network only claims it (anyone there can
    // answer hello with any fp), so it does not name that computer or give it an address. This Mac's own loopback still does.
    const group = all.some((s) => s.hello.tls) ? all.filter((s) => s.hello.tls || localityOf(s) !== 'home-network') : all
    const byPreference = [...group].sort((a, b) => SOURCE_PREFERENCE[a.source] - SOURCE_PREFERENCE[b.source])
    const pick = (f: (h: Hello) => string): string => byPreference.map((s) => f(s.hello)).find((v) => v !== '' && v !== 'unknown') ?? ''
    const byEndpoint = [...group].sort((a, b) => ENDPOINT_ORDER[a.source] - ENDPOINT_ORDER[b.source])
    const endpoints: Endpoint[] = []
    for (const s of byEndpoint) if (!endpoints.some((e) => e.host === s.endpoint.host && e.port === s.endpoint.port)) endpoints.push(s.endpoint)
    const pair = pick((h) => h.pair)
    out.push({
      id: key,
      name: pick((h) => h.name),
      agent: pick((h) => h.agent),
      version: pick((h) => h.version),
      fp: pick((h) => h.fp),
      pair: isPairStyle(pair) ? pair : 'unknown',
      // The cautious reading: if any way of asking says it speaks TLS, treat it as speaking TLS.
      tls: group.some((s) => s.hello.tls),
      where: group.map(localityOf).sort((a, b) => LOCALITY_RANK[a] - LOCALITY_RANK[b])[0],
      endpoints,
      ...(!group.some((s) => s.hello.tls) && endpoints.every((e) => hostScope(e.host) === 'home-network') ? { needsUpdate: true } : {})
    })
  }
  out.sort((a, b) => LOCALITY_RANK[a.where] - LOCALITY_RANK[b.where] || a.name.localeCompare(b.name))
  return out.slice(0, MAX_COMPUTERS)
}

/** S1: a computer this Mac connected to before, under this name, now showing a different fingerprint.
 *  `known` maps a name to the fingerprint it had. Nothing is known before the first connection. */
export function differsFromKnown(known: Readonly<Record<string, string>>, c: Pick<DiscoveredComputer, 'name' | 'fp'>): boolean {
  const was = known[c.name]
  return typeof was === 'string' && was !== '' && c.fp !== '' && was !== c.fp
}

// ── dev-only overrides ──────────────────────────────────────────────────────────────────────────

export interface DiscoveryEnv {
  /** The port a Prometheus answers on (8005). */
  port: number
  sources: ReadonlySet<DiscoverySource>
  /** How long the network scan listens before the search is done. */
  windowMs: number
  /** Extra `dns-sd` flags: only "-lo" (the local-only interface) is ever accepted. */
  bonjourFlags: readonly string[]
  /** The lookup tool to run, for tests that fake it. '' = the system's own. */
  dnssd: string
}

export const DISCOVERY_DEFAULTS: DiscoveryEnv = {
  port: DEFAULT_PORT,
  sources: new Set(DISCOVERY_SOURCES),
  windowMs: DEFAULT_WINDOW_MS,
  bonjourFlags: [],
  dnssd: ''
}

/** The overrides the probes use to point discovery at a stub. A release build ignores every one of them
 *  (`allowed` is the build-flavour decision, @shared/release-gate debuggingAllowed): an environment
 *  variable must not be able to aim a shipped Beacon's search at another port or another tool. */
export function discoveryEnv(raw: Readonly<Record<string, string | undefined>>, allowed: boolean): DiscoveryEnv {
  if (!allowed) return DISCOVERY_DEFAULTS
  const port = Number(raw.BEACON_DISCOVERY_PORT)
  const windowMs = Number(raw.BEACON_DISCOVERY_WINDOW_MS)
  const named = (raw.BEACON_DISCOVERY_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DiscoverySource => (DISCOVERY_SOURCES as readonly string[]).includes(s))
  return {
    port: validPort(port) ? port : DEFAULT_PORT,
    sources: named.length > 0 ? new Set(named) : DISCOVERY_DEFAULTS.sources,
    windowMs: Number.isInteger(windowMs) && windowMs >= 200 && windowMs <= 60_000 ? windowMs : DEFAULT_WINDOW_MS,
    bonjourFlags: (raw.BEACON_DISCOVERY_BONJOUR_FLAGS ?? '').split(/\s+/).filter((f) => f === '-lo'),
    dnssd: raw.BEACON_DISCOVERY_DNSSD ?? ''
  }
}
