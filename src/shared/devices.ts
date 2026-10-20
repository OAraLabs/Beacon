// Pure device-enrolment model — shared by the renderer panel and the headless smoke. No DOM.
//
// The daemon half is Prometheus #310 (GRAFT-MOBILE-BRIDGE Piece 1):
//   POST   /api/devices        mint — GLOBAL token only, returns the plaintext token ONCE
//   GET    /api/devices        list — any valid token; marks is_self
//   DELETE /api/devices/{id}   revoke — any valid token (a phone signs itself out)
//
// Minting is global-only BY DESIGN: a stolen phone must not be able to enrol a second attacker
// device. A device token presented to POST gets 401, and that is the contract, not a bug.
//
// Three facts drive this module:
//
//  1. The minted token is returned ONCE and never again — the store keeps only a SHA-256. So the
//     QR must be rendered from the mint response in memory, and the plaintext must never be
//     written to the cache, to settings, or to a log.
//  2. The iOS parser REJECTS rather than repairs. A host carrying a scheme, port or path, or a
//     token containing whitespace, is refused outright. So this side must mint clean values —
//     a payload that "looks close" fails at the phone with no diagnostic.
//  3. The name is free text and goes in a query string, so it is URL-encoded. The host and token
//     are NOT encoded: they are validated to be already-safe instead, because percent-encoding a
//     malformed host would smuggle it past the parser's check rather than surfacing it here.

/** One enrolled device, AS THE DAEMON RETURNS IT (snake_case — no per-field mapping). */
export interface DeviceDTO {
  id: string
  name: string
  platform: string
  created_at?: number
  last_seen_at?: number | null
  revoked_at?: number | null
  is_self?: boolean
}

/** The mint response. `token` is the ONLY copy that will ever exist. */
export interface MintedDevice extends DeviceDTO {
  token: string
}

export type DevicePlatform = 'ios' | 'macos' | 'other'

/** The daemon coerces anything else to 'other'; mirroring it here keeps the UI honest about what
 *  will actually be stored rather than showing a value the server silently changed. */
export function normalizePlatform(v: string): DevicePlatform {
  const p = (v || '').trim().toLowerCase()
  return p === 'ios' || p === 'macos' ? p : 'other'
}

/**
 * The host to put in a pairing URL, from the gateway address the desktop is configured with.
 *
 * Strips scheme, path and port — the same normalisation `gatewayFromAddress` does when the user
 * types an address at first-run setup. Duplicated deliberately rather than imported: that helper
 * lives in the MAIN process (`main/connection/config.ts`) and this module is shared with the
 * renderer, and a pairing payload must not depend on main-process module resolution.
 */
export function hostForPairing(apiBaseOrHost: string): string {
  return (apiBaseOrHost || '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/\/.*$/, '') // path
    .replace(/:\d+$/, '') // port
    .trim()
}

/**
 * Is this host a bare IP literal? `'ipv4' | 'ipv6' | null`.
 *
 * WHY THE DESKTOP CARES ABOUT AN iOS RULE. App Transport Security matches its exception list by
 * DOMAIN NAME, so an IP literal matches nothing and iOS refuses a plain-http connection to it
 * INSIDE the phone — no packet leaves. A pairing QR carrying an IP can therefore never work, and
 * the failure surfaces one scan later on a different device, with the one-shot token already
 * spent. Will hit exactly this on 2026-09-14; the iOS side hit it on 2026-08-30 and spent an hour
 * on it, because the symptom is indistinguishable from a sleeping daemon.
 *
 * The IPv4 predicate mirrors BeaconKit's `CleartextDiagnosis.isBareIPv4` exactly — four parts,
 * each non-empty, all digits, each <= 255 — so the two sides cannot disagree about what an
 * address is. IPv6 is covered too: it fails ATS for the same reason and looks nothing like the
 * v4 shape, so a check that only knew four octets would be half a check.
 */
export function bareIpHost(host: string): 'ipv4' | 'ipv6' | null {
  const h = (host ?? '').trim()
  if (!h) return null
  // Bracketed IPv6, with or without a port: [fd7a::1] / [fd7a::1]:8010
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(h)) return 'ipv6'
  // Raw IPv6. A DNS name can never contain a colon, and `host:port` has exactly one — so two or
  // more is unambiguous, and checking it BEFORE the port rule keeps `fd7a::1` from being reported
  // as "carries a port", which would send the reader to fix the wrong thing.
  if ((h.match(/:/g) ?? []).length >= 2 && /^[0-9a-f:.]+$/i.test(h)) return 'ipv6'
  const parts = h.split('.')
  if (parts.length === 4 && parts.every((x) => x !== '' && /^\d+$/.test(x) && Number(x) <= 255)) return 'ipv4'
  return null
}

/**
 * Why this host cannot REACH the daemon from the phone, even though the payload is well-formed.
 * '' when it can.
 *
 * DELIBERATELY SEPARATE FROM `pairPayloadProblem`, which answers a different question: can the
 * phone PARSE this payload. An IP host parses perfectly — beacon-ios pins exactly such a payload
 * in its own parser tests, and this repo pins the same literals as a cross-repo contract — and
 * then fails at connect time, inside the phone, because App Transport Security matches its
 * plain-http exceptions by domain name. Folding this into the parse check would have broken that
 * contract and made `pairUrl` refuse a string both repos assert it emits.
 *
 * So: the payload is buildable, and the panel still refuses to MINT one, because the credential
 * is one-shot and a QR that cannot connect costs a revoke-and-retry.
 */
export function pairHostUnusable(host: string): string {
  return bareIpHost(host) ? ipHostRefusal(host) : ''
}

/**
 * The refusal an IP host earns — named for the remedy, not just the fault, in plain words (the 0.4.5 sweep, E2: it read "iOS matches
 * its plain-http exceptions by name"). The iPhone app connects to a name only, so a code built on an address can never work, and
 * 127.0.0.1 is worse: on the phone it is the phone. This used to be worded to match BeaconKit's `CleartextDiagnosis.message(host:)`;
 * it no longer does, and iOS keeps its own wording until it gets the same plain pass.
 */
export function ipHostRefusal(host: string): string {
  const fix = 'To add a phone, connect Beacon to this Prometheus by its Tailscale name in Connection Settings, then try again.'
  if (/^127\./.test(host) || host === '::1' || host === '[::1]')
    return `${host} only reaches the computer it's typed on, so on a phone it means the phone, not this computer: adding a phone with it can never work. ${fix}`
  return `The iPhone app only connects to Prometheus by name, so adding a phone with a number address like ${host} can never work. ${fix}`
}

/** Why a payload cannot be built. '' when it can. Phrased for a human, not a log. */
export function pairPayloadProblem(host: string, token: string, name: string): string {
  if (!host) return 'No gateway host is configured — pair the desktop to a daemon first.'
  // These mirror the iOS parser's refusals. It rejects rather than repairs, so a value that gets
  // through here and fails there produces a scan that silently does nothing.
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(host)) return `Host still carries a scheme: ${host}`
  if (host.includes('/')) return `Host still carries a path: ${host}`
  // A raw IPv6 host ends in `:<digits>`, so it would be reported as carrying a port — the wrong
  // fix. It is not a PARSE problem though (the phone's parser takes it happily), so it is named
  // by pairHostUnusable, and only excluded from this rule.
  if (/:\d+$/.test(host) && bareIpHost(host) !== 'ipv6') return `Host still carries a port: ${host}`
  if (!token) return 'No token was minted.'
  if (/\s/.test(token)) return 'The minted token contains whitespace, which the phone will reject.'
  if (!name.trim()) return 'Give the device a name so you can revoke the right one later.'
  return ''
}

/**
 * The QR payload, verbatim per the Piece 1 spec:
 *   beacon://pair?host=<host>&token=<token>&name=<url-encoded name>
 * and, for a daemon serving TLS (0.4.3; beacon-ios #32, decision D22), the pin after the name:
 *   beacon://pair?host=<host>&token=<token>&name=<url-encoded name>&pin=<64 lower-case hex>
 * The pin is the SHA-256 of the daemon certificate's SPKI (the same 32 bytes as the desktop's own pinning, PR 244). With it the phone
 * goes https/wss on 8006/8011 and refuses any other key; without it, plain http/ws on 8005/8010 exactly as before.
 *
 * Throws on an invalid payload rather than returning something plausible — a malformed pairing
 * URL fails at the phone, away from anyone who could diagnose it. A pin that is not exactly 64 lower-case hex makes iOS refuse the
 * WHOLE code, so it is never emitted (and never repaired: no lower-casing, no trimming).
 */
export function pairUrl(host: string, token: string, name: string, pin?: string | null): string {
  const problem = pairPayloadProblem(host, token, name)
  if (problem) throw new Error(problem)
  if (pin !== undefined && pin !== null && !PIN_RE.test(pin)) throw new Error('The TLS pin is not 64 lower-case hex characters, so the phone would refuse the code.')
  const plain = `beacon://pair?host=${host}&token=${token}&name=${encodeURIComponent(name.trim())}`
  return pin ? `${plain}&pin=${pin}` : plain
}

const PIN_RE = /^[0-9a-f]{64}$/

/** The ports Beacon for iOS dials for a pinned code: fixed, like 8005/8010 for a plain one. The code carries none, and iOS ignores
 *  port parameters (it would pair, then dial 8006 and fail), so a daemon on other TLS ports gets no pinned code: non-default ports
 *  need an iOS change first. */
export const PAIR_TLS_PORTS = { api: 8006, ws: 8011 } as const

/** The TLS ports to check before minting. Always PAIR_TLS_PORTS in a release build; a dev or probe build may point them elsewhere with
 *  BEACON_PAIR_TLS_PORTS="<api>,<ws>" (a probe cannot take 8006/8011). */
export function pairTlsPorts(env: Record<string, string | undefined>, debuggable: boolean): { api: number; ws: number } {
  const m = debuggable ? /^(\d{1,5}),(\d{1,5})$/.exec(env.BEACON_PAIR_TLS_PORTS ?? '') : null
  return m ? { api: Number(m[1]), ws: Number(m[2]) } : { ...PAIR_TLS_PORTS }
}

export type PairPinSource = { kind: 'plain' } | { kind: 'check'; pin: string } | { kind: 'refused'; message: string }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Where a pairing code's pin comes from, decided BEFORE the one-shot token is minted:
 *   * the profile the desktop is connected with, when it is pinned (it joined over TLS: that is the key);
 *   * otherwise GET /api/network's `tls` block: `enabled` with `spki_sha256` is the pin; disabled, or no key, is a plain code.
 * A key that is not 64 lower-case hex is refused, never repaired. Not being able to ask is refused too: a guess either way could spend
 * the token on a code that cannot connect.
 */
export function pairPinSource(profilePin: string | null, network: { status: number; body: unknown } | 'unreachable'): PairPinSource {
  if (profilePin) return PIN_RE.test(profilePin) ? { kind: 'check', pin: profilePin } : { kind: 'refused', message: "This connection's saved key isn't a key Beacon can put in a pairing code, so no code was made." }
  if (network === 'unreachable') return { kind: 'refused', message: "Beacon couldn't ask Prometheus whether its connection is encrypted, so no code was made. Try again." }
  // A Prometheus without the network route (#700) has no TLS listener either.
  if (network.status === 404 || network.status === 405) return { kind: 'plain' }
  const tls = network.status === 200 && isObj(network.body) && isObj(network.body.tls) ? network.body.tls : null
  if (!tls) return { kind: 'refused', message: `Beacon couldn't read whether Prometheus's connection is encrypted (HTTP ${network.status}), so no code was made.` }
  if (tls.enabled !== true || tls.spki_sha256 === null || tls.spki_sha256 === undefined) return { kind: 'plain' }
  if (typeof tls.spki_sha256 !== 'string' || !PIN_RE.test(tls.spki_sha256)) return { kind: 'refused', message: "Prometheus reported a key that isn't 64 lower-case hex characters, so no code was made." }
  return { kind: 'check', pin: tls.spki_sha256 }
}

export type PairPinVerdict = { kind: 'pinned'; pin: string } | { kind: 'refused'; message: string }

/**
 * Does the code's host answer on the TLS ports iOS dials, with that key? `api` / `ws` are the SPKI SHA-256 each port presented, or
 * 'unreachable'. This is what catches a daemon on non-default TLS ports (GET /api/network does not report them), and a stale pin.
 */
export function pairPinVerdict(host: string, pin: string, api: string, ws: string): PairPinVerdict {
  const { api: A, ws: W } = PAIR_TLS_PORTS
  for (const [seen, port] of [[api, A], [ws, W]] as const) {
    if (seen === 'unreachable')
      return {
        kind: 'refused',
        message:
          `Prometheus's encrypted connection doesn't answer at ${host}:${port}. Beacon for iPhone connects on ports ${A} and ${W} only, so a ` +
          'pairing code for this Prometheus could not connect. If Prometheus uses other ports, iPhones need an update before they can use them.'
      }
    if (seen !== pin)
      return {
        kind: 'refused',
        message: `${host}:${port} answered with a different key than Prometheus reports (${seen.slice(0, 16)}… instead of ${pin.slice(0, 16)}…), so a phone paired with this code would refuse it.`
      }
  }
  return { kind: 'pinned', pin }
}

/** Devices that can still authenticate. A revoked row is kept as a tombstone by the daemon. */
export function activeDevices(rows: DeviceDTO[]): DeviceDTO[] {
  return rows.filter((d) => !d.revoked_at)
}

/**
 * The tombstones. `DELETE /api/devices/{id}` REVOKES — the daemon has no purge route, deliberately
 * ("revocation is a tombstone; the next request with that token fails auth"), so these rows are
 * the record of everything ever enrolled and cannot be deleted by any client.
 *
 * They accumulate fast in practice — every failed pairing attempt and every probe leaves one — and
 * nine dead rows above one live phone is the panel telling you about its own history instead of
 * your devices. So the panel collapses them behind a count (the sidebar's idiom): still reachable,
 * never deleted, out of the way. A collapsed group that STATES what it holds, never one that
 * silently omits it.
 */
export function revokedDevices(rows: DeviceDTO[]): DeviceDTO[] {
  return rows.filter((d) => !!d.revoked_at)
}

/** Sort for display: live devices first, newest first inside each group. */
export function sortDevices(rows: DeviceDTO[]): DeviceDTO[] {
  return [...rows].sort((a, b) => {
    const ar = a.revoked_at ? 1 : 0
    const br = b.revoked_at ? 1 : 0
    if (ar !== br) return ar - br
    return (b.created_at ?? 0) - (a.created_at ?? 0)
  })
}

/** Epoch SECONDS (float) — the same unit artifacts and wiki mtimes use, not milliseconds. */
export function fmtDeviceTime(seconds: number | null | undefined, now: number = Date.now()): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'never'
  const mins = Math.floor((now - seconds * 1000) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
