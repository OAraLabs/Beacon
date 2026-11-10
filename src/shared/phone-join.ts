// "Add a phone" (the phone-onboarding plan, desktop item 1): the QR a phone scans to ask a Prometheus to let it join. It holds no
// secret: only a name the phone can reach that Prometheus by, the node key Beacon pinned for it (so the phone pins it from its first
// connection and no token leaves the phone until that key signs), and the name to show. The phone then sends a join request
// (POST /api/pair/requests) that the owner approves in Beacon.
//
//   beacon://join?host=<name>&node=<64 lower-case hex>&name=<url-encoded name>
//
// The host is always a NAME iOS will use over plain HTTP: a short name (or .local). A full …ts.net name is shortened to its first
// label; localhost and Tailscale numbers are looked up in this Mac's `tailscale status --json`. A number address never goes in.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import { bareIpHost, nodeHex } from './devices'

export interface TailnetNode {
  /** The short MagicDNS name ("my-mini"), what a phone on the tailnet reaches it by. */
  name: string
  ips: string[]
}
export interface Tailnet {
  self: TailnetNode | null
  peers: TailnetNode[]
}

/** The port the phone dials for a plain join; the join answer then gives it the endpoints to use. */
export const PHONE_JOIN_PORT = 8005

/** The port, from BEACON_PHONE_JOIN_PORT in a build that allows debugging (the app probe's stand-in can't take 8005), else 8005. */
export function phoneJoinPort(env: Record<string, string | undefined>, debuggable: boolean): number {
  const m = debuggable ? /^(\d{1,5})$/.exec(env.BEACON_PHONE_JOIN_PORT ?? '') : null
  return m ? Number(m[1]) : PHONE_JOIN_PORT
}

/** A full MagicDNS name ("<name>.<tailnet>.ts.net.") → its first label. Null for something that is not a name. */
export function shortTailnetName(dnsName: string): string | null {
  const first = (dnsName ?? '').trim().replace(/\.$/, '').split('.')[0]?.toLowerCase() ?? ''
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(first) ? first : null
}

const node = (v: unknown): TailnetNode | null => {
  const n = v as { DNSName?: unknown; TailscaleIPs?: unknown } | null
  const name = typeof n?.DNSName === 'string' ? shortTailnetName(n.DNSName) : null
  const ips = Array.isArray(n?.TailscaleIPs) ? n.TailscaleIPs.filter((x): x is string => typeof x === 'string') : []
  return name ? { name, ips } : null
}

/** This Mac's tailnet, from `tailscale status --json`; null when Tailscale isn't running or the answer can't be read. */
export function parseTailnet(json: unknown): Tailnet | null {
  const j = json as { BackendState?: unknown; Self?: unknown; Peer?: unknown } | null
  if (!j || typeof j !== 'object' || j.BackendState !== 'Running') return null
  const peers = j.Peer && typeof j.Peer === 'object' ? Object.values(j.Peer as Record<string, unknown>).map(node).filter((x): x is TailnetNode => !!x) : []
  return { self: node(j.Self), peers }
}

export type JoinHost = { ok: true; host: string } | { ok: false; why: string }

const LOOPBACK = (h: string): boolean => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1'

/** The name a phone reaches the Prometheus at `apiBase` by, or why there is none, in words that say what to do. */
export function joinHost(apiBase: string, tailnet: Tailnet | null, port: number = PHONE_JOIN_PORT): JoinHost {
  let u: URL
  try {
    u = new URL(apiBase)
  } catch {
    return { ok: false, why: "Beacon doesn't have an address for this Prometheus. Connect to it first, then try again." }
  }
  if (u.protocol === 'https:') return { ok: false, why: "Adding a phone to a Prometheus Beacon reaches over its encrypted address isn't ready yet. Connect Beacon to it by its short Tailscale name (http, port 8005), then try again." }
  if (Number(u.port || 80) !== port) return { ok: false, why: `This Prometheus answers on port ${u.port || 80}, and the iPhone app connects on ${port} only. Set it back to ${port} to add a phone.` }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOOPBACK(host)) {
    return tailnet?.self
      ? { ok: true, host: tailnet.self.name }
      : { ok: false, why: "Beacon reaches this Prometheus as localhost, which on a phone means the phone. Turn on Tailscale on this Mac (the phone reaches it by this Mac's Tailscale name), then try again." }
  }
  if (bareIpHost(host)) {
    const known = [...(tailnet?.self ? [tailnet.self] : []), ...(tailnet?.peers ?? [])].find((n) => n.ips.includes(host))
    return known
      ? { ok: true, host: known.name }
      : { ok: false, why: `Beacon reaches this Prometheus by a number address (${host}), and the iPhone app only connects by name. Connect Beacon to it by its Tailscale name, then try again.` }
  }
  if (host.endsWith('.ts.net')) {
    const short = shortTailnetName(host)
    return short ? { ok: true, host: short } : { ok: false, why: `Beacon can't make a short name from ${host}. Connect to this Prometheus by its short Tailscale name, then try again.` }
  }
  if (!host.includes('.') || host.endsWith('.local')) return { ok: true, host }
  return { ok: false, why: `iOS won't use plain HTTP to ${host}. Connect Beacon to this Prometheus by its short Tailscale name (like my-mini), then try again.` }
}

const HEX64 = /^[0-9a-f]{64}$/

/** The code itself. Throws on anything the phone would refuse: it is never built wrong. */
export function joinUrl(host: string, nodeHexKey: string, name: string): string {
  if (!host || /[/:]/.test(host) || bareIpHost(host) || LOOPBACK(host)) throw new Error(`Not a name a phone can reach: ${host}`)
  if (!HEX64.test(nodeHexKey)) throw new Error('The node key is not 64 lower-case hex characters, so the phone would refuse the code.')
  const shown = name.trim()
  if (!shown || shown.length > 64) throw new Error('The name to show is empty or too long.')
  return `beacon://join?host=${host}&node=${nodeHexKey}&name=${encodeURIComponent(shown)}`
}

export type JoinCode = { ok: true; url: string; host: string } | { ok: false; why: string }

/**
 * The code for one Prometheus Beacon keeps: its address, the node key pinned for it (never one read at this moment), its name, this
 * Mac's tailnet, and the address it listens on when Beacon could read it (GET /api/network's `bind`): a loopback bind means only its
 * own computer reaches it. (Its mode alone doesn't say: a this_mac Prometheus bound to its Tailscale address is reachable there.)
 */
export function joinCode(o: { apiBase: string; nodePub: string | null; name: string; tailnet: Tailnet | null; bind: string | null; port?: number }): JoinCode {
  const key = nodeHex(o.nodePub)
  if (!key) return { ok: false, why: "This Prometheus can't prove who it is yet, so a phone can't join it safely. Update it to 0.9.18 or later, connect Beacon to it once, then try again." }
  if (o.bind && LOOPBACK(o.bind.trim().replace(/^\[|\]$/g, '').toLowerCase())) return { ok: false, why: "This Prometheus only listens to its own computer, so a phone can't reach it. Turn on Settings → Other computers, then try again." }
  const h = joinHost(o.apiBase, o.tailnet, o.port)
  if (!h.ok) return h
  try {
    return { ok: true, url: joinUrl(h.host, key, o.name || h.host), host: h.host }
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  }
}
