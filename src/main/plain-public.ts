// No plain http/ws to an address that is not this computer, the home network or Tailscale (owner decision, 2026-10-17, for 0.4.6). There the
// key would cross the internet unencrypted, so Beacon refuses outright, saved connections included (unlike the home network's rule,
// src/shared/plain-lan.ts, which keeps a saved connection with a notice). The words say what to do instead: https, or Tailscale.
//
// A name is judged by where it resolves, not by how it looks: a Tailscale short name (`my-mini`, MagicDNS) and a router's name
// (`nas.lan`) look like any other name and are not public. A name that does not resolve now cannot be judged; it cannot be reached
// either, and every connect asks again.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { hostScope, PLAIN_PUBLIC_REFUSED } from '@shared/plain-lan'

export type Resolve = (host: string) => Promise<string[]>

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** The hosts of these URLs that go plain (http: or ws:), without IPv6 brackets. */
function plainHosts(urls: readonly string[]): string[] {
  const hosts = new Set<string>()
  for (const url of urls) {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'ws:') hosts.add(u.hostname.replace(/^\[|\]$/g, ''))
    } catch {
      /* not a URL: nothing goes there */
    }
  }
  return [...hosts]
}

/** The words to refuse a connection with when either URL goes plain to an address on the internet (or to a name that resolves to
 *  one, even among others), or null. */
export async function plainPublicRefusal(apiBase: string, wsUrl: string, resolve: Resolve = resolveAll): Promise<string | null> {
  for (const host of plainHosts([apiBase, wsUrl])) {
    if (hostScope(host) !== 'other') continue // this computer, the home network (F2's rule) or Tailscale
    if (isIP(host)) return PLAIN_PUBLIC_REFUSED // an address is where it says
    let addresses: string[]
    try {
      addresses = await resolve(host)
    } catch {
      continue // does not resolve now: it cannot be judged, or reached
    }
    if (addresses.some((a) => hostScope(a) === 'other')) return PLAIN_PUBLIC_REFUSED
  }
  return null
}
