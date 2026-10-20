// No plain HTTP to the home network (owner decision, 2026-10-11, for v0.4). Prometheus serves the home network over TLS (#721); a plain
// address there is an old Prometheus, or something pretending to be one (a hidden TLS flag, a plain-only record carrying a real
// computer's fp, an answer to a typed address). So Beacon makes no NEW plain connection to a home-network address: private LAN
// ranges, link-local, and .local names. This Mac (loopback) and Tailscale (its 100.64/10 range, fd7a:115c:a1e0::/48, and *.ts.net names, which
// WireGuard already encrypts) stay plain as before. A connection saved before this keeps working, with a one-line notice.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export type HostScope = 'loopback' | 'tailscale' | 'home-network' | 'other'

export const NOT_ENCRYPTED_NOTICE = 'Not encrypted — update Prometheus and turn on home network.'
export const PLAIN_REFUSED =
  'Beacon only connects to computers on your home network over an encrypted connection. Update Prometheus on that computer and turn on home network, then connect to it again.'

let extraPublic: readonly string[] = []
/** Hosts to treat as public (a probe's loopback stand-in for an address on the internet). Main sets it only in a non-release build,
 *  from BEACON_PUBLIC_HOSTS. */
export function treatAsPublic(hosts: readonly string[]): void {
  extraPublic = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '')
}

let extraHome: readonly string[] = []
/** Hosts to treat as home-network as well (a probe's loopback stand-in for a LAN address). Main sets it only in a non-release
 *  build, from BEACON_HOME_NETWORK_HOSTS. */
export function treatAsHomeNetwork(hosts: readonly string[]): void {
  extraHome = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '')
}

/** The host as a URL writes it (lower case; IPv4 written any way made dotted; IPv6 compressed, in brackets), or null. */
function canonical(host: string): string | null {
  let h = host.trim().replace(/%25.*\]$|%[^\]]*\]$/, ']').replace(/%.*$/, '') // a zone (fe80::1%en0) names an interface, not a host
  if (h.includes(':') && !h.startsWith('[')) h = `[${h}]`
  try {
    return new URL(`http://${h}/`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** An IPv6 address (without brackets) as its eight 16-bit groups, or null. */
function groups6(a: string): number[] | null {
  const halves = a.split('::')
  if (halves.length > 2) return null
  const part = (x: string): number[] => (x === '' ? [] : x.split(':').map((g) => parseInt(g, 16)))
  const head = part(halves[0])
  const tail = halves.length === 2 ? part(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const all = [...head, ...Array<number>(Math.max(0, fill)).fill(0), ...tail]
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null
}

function scope4(o: number[]): HostScope {
  const [a, b] = o
  if (a === 127) return 'loopback'
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'home-network'
  return 'other'
}

/** Where a host is, for deciding whether plain HTTP may be used to it. */
export function hostScope(host: string): HostScope {
  const h = canonical(host)
  if (h === null) return 'other'
  const name = h.replace(/\.$/, '')
  if (extraPublic.includes(name) || extraPublic.includes(host.trim().toLowerCase())) return 'other'
  if (extraHome.includes(name) || extraHome.includes(host.trim().toLowerCase())) return 'home-network'
  if (name === 'localhost') return 'loopback'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (v4) return scope4(v4.slice(1).map(Number))
  if (name.startsWith('[')) {
    const g = groups6(name.slice(1, -1))
    if (!g) return 'other'
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return scope4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]) // IPv4-mapped
    if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return 'tailscale'
    if ((g[0] & 0xffc0) === 0xfe80) return 'home-network' // link-local
    if ((g[0] & 0xfe00) === 0xfc00) return 'home-network' // unique local (a private range)
    return 'other'
  }
  if (name.endsWith('.ts.net')) return 'tailscale'
  if (name.endsWith('.local')) return 'home-network'
  return 'other'
}

/** The host of an http/ws URL that goes plain to the home network, or null. */
function plainHome(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'ws:') && hostScope(u.hostname) === 'home-network'
  } catch {
    return false
  }
}

/** A new plain (http/ws) connection to these addresses is refused: the words to say, or null. Re-saving the addresses already
 *  saved is not new. */
export function refusePlain(apiBase: string, wsUrl: string, saved: { apiBase: string; wsUrl: string } | null): string | null {
  if (!plainHome(apiBase) && !plainHome(wsUrl)) return null
  if (saved && saved.apiBase === apiBase && saved.wsUrl === wsUrl) return null
  return PLAIN_REFUSED
}

/** A saved connection that goes plain to the home network: the one-line notice shows. */
export function notEncrypted(apiBase: string, wsUrl: string): boolean {
  return plainHome(apiBase) || plainHome(wsUrl)
}

/** What Beacon says when it will not go in plain to an address that is not this computer, the home network or Tailscale
 *  (src/main/plain-public.ts): the key would cross the internet unencrypted. Saved connections included (owner decision, 2026-10-17). */
export const PLAIN_PUBLIC_REFUSED =
  "Beacon only connects to a computer outside your home network over an encrypted connection. Use its https:// address, or connect to it over Tailscale."
