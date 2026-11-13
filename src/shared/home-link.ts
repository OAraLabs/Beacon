// "Open in Home Assistant": which links Beacon will open (docs/HA-UI-DATA-CONTRACT.md §7, Q3).
//
// The address comes from the daemon and is only ever opened in the person's browser; Beacon never calls it. It is opened when it is:
//   * https, to any host; or
//   * plain http, to a private or tailnet host only (a loopback or LAN address, a Tailscale 100.64/10 address, a `.local`, `.lan`,
//     `.home.arpa` or `.ts.net` name, or a bare one-word name). Plain http over the internet is refused.
// and it NEVER carries a credential: no name or password in the address, and no token, key, secret or session in its query or
// fragment. A link that does is dropped, not cleaned: someone put it there.

import { safeExternalUrl } from './browser-pane'

const MAX_LINK = 2048

/** A host that only the local network or a tailnet can reach. Expects what URL.hostname gives (IPv6 in brackets). */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1)
    return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h === 'localhost' || /\.(localhost|local|lan|localdomain|internal)$/.test(h) || h.endsWith('.home.arpa') || h.endsWith('.ts.net')) return true
  return !h.includes('.') // a one-word name resolves only on the local network
}

/** Parameter names that are a credential. Compared by whole word (split on _ - .), so "design" and "tab" are not caught by "sig". */
const SECRET_WORDS = new Set(['token', 'auth', 'authorization', 'key', 'apikey', 'accesstoken', 'password', 'passwd', 'pass', 'secret', 'bearer', 'sig', 'signature', 'session', 'sid', 'jwt', 'credential', 'credentials'])
const carriesSecret = (params: URLSearchParams): boolean =>
  [...params.keys()].some((k) => k.toLowerCase().split(/[_\-.]/).some((w) => SECRET_WORDS.has(w)))

/** The link as it will be opened, or null when it may not be. */
export function homeLinkOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t || t.length > MAX_LINK || !safeExternalUrl(t)) return null
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) return null
  if (carriesSecret(u.searchParams)) return null
  // A fragment that is itself a query (#access_token=…) is read the same way.
  if (u.hash.includes('=') && carriesSecret(new URLSearchParams(u.hash.slice(1)))) return null
  return u.href
}
