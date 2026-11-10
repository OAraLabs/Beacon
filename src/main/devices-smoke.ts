/**
 * Device-enrolment smoke — the desktop half of GRAFT-MOBILE-BRIDGE Piece 1 (Prometheus #310).
 *
 * The payload rules are the point of this file. The iOS parser REJECTS rather than repairs: a host
 * carrying a scheme, port or path, or a token with whitespace, is refused outright and the scan
 * silently does nothing. A malformed payload therefore fails at the PHONE, far from anyone who
 * could diagnose it — so it has to be impossible to build here.
 *
 * Run: npm run smoke:devices
 */
import {
  activeDevices,
  revokedDevices,
  fmtDeviceTime,
  hostForPairing,
  normalizePlatform,
  bareIpHost,
  pairHostUnusable,
  pairPayloadProblem,
  pairUrl,
  nodeHex,
  deviceErrorWords,
  pairPinSource,
  pairPinVerdict,
  PAIR_TLS_PORTS,
  sortDevices,
  type DeviceDTO
} from '@shared/devices'
import { NAV_VIEWS, NAV_TREE, flattenNavTree, resolveView, DEFAULT_VIEW } from '@shared/views'
import { CONFIG_TABS } from '@shared/daemon-api'
import { PairPin } from './pair-pin'
import type { HttpResult } from './pairing/http'

let failures = 0
let checks = 0
function assert(cond: boolean, what: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// A dotted-quad host of the same shape the desktop actually holds, using RFC 5737 TEST-NET-1.
// NEVER a real Tailscale CGNAT address: those in committed source are exactly what
// scripts/precommit-guard.sh refuses, and its refusal is not pragma-able. (Writing the range's
// CIDR here would itself trip the guard — it is a literal inside its own forbidden range.) The shape is what
// these assertions test; the value only has to be a plausible IPv4 host.
// beacon-ios pins these same emitted payloads byte-for-byte (f406fb3,
// testDesktopEmittedShapesParse), so these literals are a CONTRACT with that repo's parser tests.
// The two ends deliberately assert the SAME strings: pinning different literals on each side
// would look like a shared contract while proving only that each side agrees with itself.
// Change them in both repos or in neither.
const TS = '192.0.2.7'

console.log('[smoke] === 1. the host the phone must reach ===')
assert(hostForPairing(`http://${TS}:8005`) === TS, 'scheme AND port stripped from the configured apiBase')
assert(hostForPairing(`https://${TS}:8005/api`) === TS, 'and a path')
assert(hostForPairing(`ws://${TS}:8010`) === TS, 'a ws:// base normalises the same way')
assert(hostForPairing('my-mini.local') === 'my-mini.local', 'a bare hostname is already clean')
assert(hostForPairing('  my-mini  ') === 'my-mini', 'surrounding whitespace is trimmed')
assert(hostForPairing('') === '', 'nothing configured stays empty rather than becoming garbage')

console.log('')
console.log('[smoke] === 2. what the phone REFUSES — must be unbuildable here ===')
// Assert the MESSAGE, not merely that something was refused. `http://host` contains a slash, so
// the path check alone would reject it — deleting the scheme check leaves the refusal intact and
// only changes what the user is told. A "non-empty" assertion cannot see that, and mutation
// testing proved it: the scheme check survived until this assertion named the reason.
assert(/scheme/i.test(pairPayloadProblem(`http://${TS}`, 'tok', 'iPhone')), 'a host with a scheme is refused, and SAID to be')
assert(/port/i.test(pairPayloadProblem(`${TS}:8005`, 'tok', 'iPhone')), 'a host with a port is refused, and said to be')

// ── the IP-literal refusal (2026-09-14) ───────────────────────────────────────
//
// A pairing QR carrying an IP can NEVER work on iOS: App Transport Security matches its
// plain-http exceptions by DOMAIN NAME, so an IP matches none and the phone refuses the
// connection before a packet leaves. The desktop minted these happily, and the failure surfaced
// one scan later on another device with the one-shot token already spent — a revoke-and-retry
// every time. Addresses below are RFC 5737/3849 documentation ranges; the pre-commit guard
// refuses a live tailnet address in source, and the shape is all these assertions need.
assert(bareIpHost('192.0.2.7') === 'ipv4', 'a four-octet host is an IPv4 literal')
assert(bareIpHost('198.51.100.9') === 'ipv4', 'and so is another')
assert(bareIpHost('my-mini') === null, 'a short hostname is not')
// NOTE the trap in this file's own fixture: `TS` is NAMED like a tailnet host but holds a
// documentation IPv4 (the pre-commit guard refuses a live tailnet address in source). So the
// name case has to be spelled out rather than borrowed from TS.
assert(bareIpHost('my-mini.tail-example.invalid') === null, 'a DNS name is not an address — the thing we want people to use')
assert(bareIpHost(TS) === 'ipv4', 'and TS, despite its name, is an address')
// The predicate mirrors BeaconKit's CleartextDiagnosis.isBareIPv4 exactly; these are its own
// cases, so the two sides cannot drift about what counts as an address.
assert(bareIpHost('198.51.100') === null, 'too few octets')
assert(bareIpHost('999.1.1.1') === null, 'octet out of range')
assert(bareIpHost('192.0.2.7.5') === null, 'too many octets')
assert(bareIpHost('192.0.2.') === null, 'a trailing dot leaves an empty octet')
// IPv6 fails ATS for the same reason and looks nothing like the v4 shape — a check that only
// knew four octets would be half a check.
assert(bareIpHost('2001:db8::1') === 'ipv6', 'a raw IPv6 literal')
assert(bareIpHost('[2001:db8::1]') === 'ipv6', 'bracketed')
assert(bareIpHost('[2001:db8::1]:8010') === 'ipv6', 'bracketed with a port')
assert(bareIpHost('::1') === 'ipv6', 'loopback')
// Ordering: a raw IPv6 ends in `:<digits>`, so the port rule would claim it carries a port and
// send the reader to fix the wrong thing. The IP check runs first.
// THE TWO QUESTIONS ARE SEPARATE, and the cross-repo pin above is why. An IP payload PARSES —
// beacon-ios asserts it parses, and this file pins the same literal — so the parse check must
// keep accepting it, while the panel still refuses to mint one.
assert(pairPayloadProblem(TS, 'tok', 'iPhone') === '', 'an IP host is still a VALID payload — the pinned contract depends on it')
assert(pairHostUnusable(TS) !== '', 'and is still refused as unREACHABLE, which is the other question')
assert(pairHostUnusable('my-mini.local') === '', 'a name is reachable')
// A raw IPv6 must not be reported as carrying a port, which would name the wrong fix.
assert(!/port/i.test(pairPayloadProblem('2001:db8::1', 'tok', 'iPhone')), 'a raw IPv6 is not mistaken for a host:port')
assert(/port/i.test(pairPayloadProblem('my-mini.local:8005', 'tok', 'iPhone')), 'and a real host:port still reads as a port')
// The refusal must name the REMEDY, not just the fault — the same remedy the phone would name.
const ipMsg = pairHostUnusable('192.0.2.7')
assert(ipMsg.includes('192.0.2.7'), 'the refusal names the host')
assert(/tailscale name/i.test(ipMsg), 'and names the fix: use the Tailscale name')
assert(/never work|cannot/i.test(ipMsg), 'and says it can never work, so nobody retries it')
assert(pairPayloadProblem(TS, 'tok', 'iPhone') === '', 'a tailnet name still mints cleanly')
// pairUrl refuses to build one at all, so a payload that cannot work is never rendered.
// pairUrl keeps BUILDING an IP payload, because the pinned cross-repo cases assert exactly that
// string. What stops one reaching a QR is the panel, which checks pairHostUnusable before it
// spends the one-shot token — see DevicesPanel.
assert(/path/i.test(pairPayloadProblem(`${TS}/api`, 'tok', 'iPhone')), 'a host with a path is refused, and said to be')
assert(pairPayloadProblem(TS, 'to k', 'iPhone') !== '', 'a token containing a space is refused')
assert(pairPayloadProblem(TS, 'tok\n', 'iPhone') !== '', 'and one containing a newline')
assert(pairPayloadProblem('', 'tok', 'iPhone') !== '', 'no configured gateway is refused')
assert(pairPayloadProblem(TS, '', 'iPhone') !== '', 'no token is refused')
assert(pairPayloadProblem(TS, 'tok', '   ') !== '', 'a blank name is refused — you cannot revoke what you cannot identify')
assert(pairPayloadProblem(TS, 'tok', 'iPhone') === '', 'a clean payload has no problem')

console.log('')
console.log('[smoke] === 3. the payload, verbatim per the spec ===')
// CASE 1, pinned byte-for-byte against beacon-ios f406fb3 testDesktopEmittedShapesParse.
assert(
  pairUrl(TS, 'abc123', 'Alex iPhone') === 'beacon://pair?host=192.0.2.7&token=abc123&name=Alex%20iPhone',
  'case 1: the exact string beacon-ios asserts it can parse'
)
// CASE 2, same source. A bare hostname rather than a dotted quad, and a name whose & and = would
// break the query string if it were not encoded. beacon-ios asserts this decodes to "a&b=c".
assert(
  pairUrl('my-mini.local', 'abc', 'a&b=c') === 'beacon://pair?host=my-mini.local&token=abc&name=a%26b%3Dc',
  'case 2: the exact string beacon-ios asserts decodes back to a&b=c'
)
assert(pairUrl(TS, 'abc', ' padded ').endsWith('name=padded'), 'the name is trimmed before encoding')
// Throwing beats returning something plausible: a malformed URL fails at the phone, silently.
let threw = false
try { pairUrl(`http://${TS}`, 'abc', 'x') } catch { threw = true }
assert(threw, 'an invalid payload THROWS rather than producing a URL the phone will reject')

console.log('')
console.log('[smoke] === 4. platform coercion mirrors the daemon ===')
assert(normalizePlatform('ios') === 'ios' && normalizePlatform('macos') === 'macos', 'known platforms pass through')
assert(normalizePlatform('IOS') === 'ios', 'case-insensitive')
assert(normalizePlatform('android') === 'other', 'the daemon coerces anything else to other — so does the UI')
assert(normalizePlatform('') === 'other', 'and empty')

console.log('')
console.log('[smoke] === 5. the list ===')
const rows: DeviceDTO[] = [
  { id: 'a', name: 'old', platform: 'ios', created_at: 100, revoked_at: 200 },
  { id: 'b', name: 'newer', platform: 'ios', created_at: 300 },
  { id: 'c', name: 'oldest live', platform: 'macos', created_at: 50 }
]
assert(activeDevices(rows).length === 2, 'a revoked device is not active')
const s = sortDevices(rows)
assert(s[0].id === 'b' && s[1].id === 'c', 'live first, newest first within')
assert(s[2].id === 'a', 'revoked tombstones sort last rather than vanishing')
assert(sortDevices(rows) !== rows, 'sort does not mutate the caller array')

console.log('')
console.log('[smoke] === 6. last-seen is epoch SECONDS, not ms ===')
const now = 1_756_200_000_000
assert(fmtDeviceTime(now / 1000 - 120, now) === '2m ago', 'float seconds render as a recent time')
assert(fmtDeviceTime(null) === 'never', 'a device that has never connected says so')
assert(fmtDeviceTime(0) === 'never', 'and a zero is absence, not 1970')

console.log('')
// 2026-09-03: Devices left the rail. Enrolment is a SETTING — you go there to mint or revoke a
// token and leave — so it is a Config TAB now, not a view. These assertions flipped rather than
// being deleted: the surface must still be reachable, and it must be reachable exactly once, or
// the move quietly stranded it.
console.log('[smoke] === 7. devices is a Config tab, not a rail view ===')
assert(!NAV_VIEWS.some((v) => (v.id as string) === 'devices'), 'devices is NOT a rail view any more')
assert(!flattenNavTree().some((id) => (id as string) === 'devices'), 'the rail tree reaches no devices leaf')
const ws = NAV_TREE.find((e) => e.kind === 'group' && e.group.id === 'grp:workspace')
assert(ws !== undefined && ws.kind === 'group' && !ws.group.children.some((c) => (c as string) === 'devices'), 'and it is gone from Workspace')
assert(CONFIG_TABS.filter((t) => t.id === 'devices').length === 1, 'devices is a Config tab, exactly once')
assert(CONFIG_TABS.find((t) => t.id === 'devices')?.path === '/api/devices', 'the tab seeds from /api/devices')
assert(resolveView('devices') === DEFAULT_VIEW, 'a persisted "devices" view id (pre-move) falls back to the default, never a phantom')

console.log('[smoke] === tombstones: revoked rows are kept, counted, and collapsed ===')
{
  const rows = [
    { id: 'live', name: 'will-iphone', platform: 'ios', created_at: 3, last_seen_at: 9 },
    { id: 'r1', name: 'will-iphone', platform: 'ios', created_at: 2, revoked_at: 5 },
    { id: 'r2', name: 'will-iphone', platform: 'ios', created_at: 1, revoked_at: 4 }
  ]
  const live = activeDevices(rows)
  const dead = revokedDevices(rows)
  assert(live.length === 1 && live[0].id === 'live', 'the live device is the one that can still authenticate')
  assert(dead.length === 2, 'both tombstones are counted, not discarded — the daemon has NO purge route, so a client that hid them entirely would be lying about what exists')
  assert(live.length + dead.length === rows.length, 'every row lands in exactly one group (nothing vanishes)')
  assert(revokedDevices([]).length === 0 && activeDevices([]).length === 0, 'an empty list splits cleanly')
  // Ordering still puts the live device first, so the collapsed group sits below what you want.
  assert(sortDevices(rows)[0].id === 'live', 'sort keeps live devices above the tombstones')
}

console.log('')
console.log('[smoke] === 8. the pinned code (0.4.3, beacon-ios #32 / D22) ===')
{
  // THE AGREED LITERAL. beacon-ios pins this exact string in RouteTests, and this side pins it here: change it in both repos or in neither.
  const PIN = '93e4290f39594676e81c6213a1673294ba700af25b80ef2f9a004e47b1a418a1' // tls_instance_721.json's pin, the recording both repos hold
  const AGREED = 'beacon://pair?host=my-computer.tail0000.ts.net&token=abc123&name=My%20iPhone&pin=93e4290f39594676e81c6213a1673294ba700af25b80ef2f9a004e47b1a418a1' // precommit:allow-example-host
  assert(pairUrl('my-computer.tail0000.ts.net', 'abc123', 'My iPhone', PIN) === AGREED, 'the pinned code is the agreed string, byte for byte') // precommit:allow-example-host
  assert(pairUrl(TS, 'abc123', 'Alex iPhone', null) === 'beacon://pair?host=192.0.2.7&token=abc123&name=Alex%20iPhone' && pairUrl(TS, 'abc123', 'Alex iPhone', undefined) === pairUrl(TS, 'abc123', 'Alex iPhone'), 'no pin: today\'s plain code, unchanged (case 1 again)')
  const throws = (pin: string): boolean => {
    try {
      pairUrl('my-computer.tail0000.ts.net', 'abc123', 'My iPhone', pin) // precommit:allow-example-host
      return false
    } catch {
      return true
    }
  }
  const bad = [PIN.toUpperCase(), PIN.slice(1), PIN + '0', ` ${PIN}`, `${PIN}\n`, '', 'g'.repeat(64)]
  assert(bad.every(throws), 'a pin that is not exactly 64 lower-case hex is never emitted (iOS refuses the whole code; nothing here repairs it)')
  assert(PAIR_TLS_PORTS.api === 8006 && PAIR_TLS_PORTS.ws === 8011, 'the ports iOS dials for a pinned code: 8006 and 8011')

  // Where the pin comes from: the pinned profile, else GET /api/network's tls block.
  const net = (tls: unknown, status = 200): { status: number; body: unknown } => ({ status, body: { mode: 'home_network', tls } })
  const src = (profilePin: string | null, network: { status: number; body: unknown } | 'unreachable') => pairPinSource(profilePin, network)
  assert(JSON.stringify(src(PIN, 'unreachable')) === JSON.stringify({ kind: 'check', pin: PIN }), 'a pinned profile: its pin (the network setting is not needed)')
  assert(src('ABC', 'unreachable').kind === 'refused', 'a pinned profile with a pin that is not a pin: refused, never repaired')
  assert(JSON.stringify(src(null, net({ enabled: true, spki_sha256: PIN }))) === JSON.stringify({ kind: 'check', pin: PIN }), 'no profile pin: GET /api/network tls.enabled + tls.spki_sha256')
  assert(src(null, net({ enabled: false, spki_sha256: null })).kind === 'plain', 'TLS off (home network off): the plain code, unchanged')
  assert(src(null, net({ enabled: false, spki_sha256: PIN })).kind === 'plain', 'a key reported beside enabled: false is not used (the listener is not serving: a pinned code would dial nothing)')
  assert(src(null, net({ enabled: true, spki_sha256: null })).kind === 'plain', 'enabled but no key reported: plain, as agreed')
  assert(src(null, net({ enabled: true, spki_sha256: PIN.toUpperCase() })).kind === 'refused', 'a key Prometheus reports that is not 64 lower-case hex: refused (never lower-cased)')
  assert(src(null, { status: 404, body: null }).kind === 'plain' && src(null, { status: 405, body: null }).kind === 'plain', 'a Prometheus without the network route has no TLS: plain')
  assert(src(null, 'unreachable').kind === 'refused' && src(null, { status: 500, body: null }).kind === 'refused', 'could not ask: refused (a guess either way could spend the one-shot token on a dead code)')

  // Before the token is minted: the code's host must answer on 8006 AND 8011 with that key. That is how non-default TLS ports are
  // caught (GET /api/network does not report them, and iOS ignores port parameters: it would pair, then dial 8006 and fail).
  const v = (api: string, ws: string) => pairPinVerdict('my-computer.tail0000.ts.net', PIN, api, ws) // precommit:allow-example-host
  assert(JSON.stringify(v(PIN, PIN)) === JSON.stringify({ kind: 'pinned', pin: PIN }), 'both ports present the key: pinned')
  const ports = v('unreachable', PIN)
  assert(ports.kind === 'refused' && /8006/.test(ports.message) && /8011/.test(ports.message) && /iPhone/.test(ports.message), 'nothing on 8006: refused, saying iPhones dial 8006/8011 only (non-default ports need an iOS change first)')
  assert(v(PIN, 'unreachable').kind === 'refused', 'nothing on 8011: refused')
  const other = v('0'.repeat(64), PIN)
  assert(other.kind === 'refused' && /different key/.test(other.message), 'another key on 8006: refused (a phone paired with this code would refuse it)')
  assert(v(PIN, '1'.repeat(64)).kind === 'refused', 'another key on 8011: refused')
}

console.log('')
console.log('[smoke] === 9. the node key in the code (node=, for the phone to pin) ===')
{
  // THE AGREED LITERAL (the phone plan's §5 cross-repo vector): RFC 8032 test 1's public key, public and no real host's. The phone
  // pins the same string; change it in both repos or in neither.
  const PIN = '93e4290f39594676e81c6213a1673294ba700af25b80ef2f9a004e47b1a418a1'
  const NODE_B64 = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=' // the daemon's form of the same key (node_pub, standard base64)
  const NODE = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
  const AGREED = `beacon://pair?host=my-computer.tail0000.ts.net&token=abc123&name=My%20iPhone&pin=${PIN}&node=${NODE}` // precommit:allow-example-host
  assert(nodeHex(NODE_B64) === NODE, 'node_pub (standard base64) becomes the hex of its 32 raw bytes, lower-case')
  assert(pairUrl('my-computer.tail0000.ts.net', 'abc123', 'My iPhone', PIN, NODE) === AGREED, 'the code with a node key is the agreed string, byte for byte: node last, after pin') // precommit:allow-example-host
  assert(pairUrl(TS, 'abc123', 'Alex iPhone', null, NODE) === `beacon://pair?host=192.0.2.7&token=abc123&name=Alex%20iPhone&node=${NODE}`, 'a plain code carries it too (the challenge still proves the right Prometheus answered)')
  assert(pairUrl(TS, 'abc123', 'Alex iPhone', null, null) === pairUrl(TS, 'abc123', 'Alex iPhone'), 'no node key: no node, the code as before')
  const notKeys = [null, '', 'x', NODE_B64.slice(0, -4), Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), NODE_B64.replace(/\+|\//g, '-'), ` ${NODE_B64}`, NODE]
  assert(notKeys.every((k) => nodeHex(k) === null), 'anything but exactly 32 bytes of standard base64 is no node key (no node is emitted)')
  const throws = (node: string): boolean => {
    try {
      pairUrl(TS, 'abc123', 'Alex iPhone', null, node)
      return false
    } catch {
      return true
    }
  }
  assert([NODE.toUpperCase(), NODE.slice(1), NODE + '0', ` ${NODE}`, '', NODE_B64].every(throws), 'a node that is not exactly 64 lower-case hex is never emitted (the phone refuses the whole code)')
}

console.log('')
console.log('[smoke] === 11. what went wrong, in words that say what to do (never a raw HTTP code) ===')
{
  const ipc = (m: string): string => `Error invoking remote method 'daemon:write': Error: ${m}`
  const w = (m: string): string => deviceErrorWords(ipc(m))
  const mint401 = w('HTTP 401: POST /api/devices — {"detail":"minting a device token requires the global token"}')
  assert(/Add a phone/.test(mint401) && /approve/i.test(mint401), 'minting with a device key (401): use Add a phone, the phone asks and you approve', mint401)
  assert(/owner/.test(w('HTTP 403: POST /api/devices — {"error":"operator_only"}')), 'not an owner (403 operator_only): says this Beacon is not an owner')
  assert(/already/.test(w('HTTP 404: DELETE /api/devices/x — {"detail":"not found"}')), 'revoking one that is gone (404): already gone')
  assert(/Wait/.test(w('HTTP 429: POST /api/devices — {"error":"rate_limited"}')), 'too many (429): wait, then try again')
  assert(/reach Prometheus/.test(w('fetch failed')) && /reach Prometheus/.test(w('The operation was aborted due to timeout')), "nothing answered: couldn't reach Prometheus")
  const all = [mint401, w('HTTP 403: POST /api/devices — {"error":"operator_only"}'), w('HTTP 500: POST /api/devices — boom'), w('HTTP 418: x'), w('fetch failed')]
  assert(all.every((t) => !/HTTP \d{3}|Error invoking|\/api\//.test(t) && t.length > 15), 'never a status code, a route or an IPC wrapper on screen', all)
}

async function fromThePin(): Promise<void> {
  console.log('')
  console.log("[smoke] === 10. the node key comes from the instance's pinned identity, never from what answers now ===")
  const PINNED = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='
  const OTHER = Buffer.alloc(32, 7).toString('base64') // what a daemon at the address might say about itself right now
  const asked: string[] = []
  const pairPin = (nodePub: string | null): PairPin =>
    new PairPin({
      profilePin: () => null,
      base: () => 'http://192.0.2.7:8005',
      token: () => 'KEY',
      nodePub: () => nodePub,
      request: async (r): Promise<HttpResult> => {
        asked.push(r.url)
        if (r.url.endsWith('/api/network')) return { status: 200, json: { mode: 'home_network', tls: { enabled: false, spki_sha256: null } }, retryAfter: null }
        return { status: 200, json: { state: 'idle', node_pub: OTHER }, retryAfter: null }
      },
      ports: { api: 8006, ws: 8011 }
    })
  const d = await pairPin(PINNED).decide(TS)
  assert(d.kind === 'plain' && d.node === nodeHex(PINNED), `the pinned key, in the code's form (${JSON.stringify(d)})`)
  assert(!asked.some((u) => !u.endsWith('/api/network')), `nothing else was asked for it: no /api/status, no challenge (${asked.join(', ')})`)
  const none = await pairPin(null).decide(TS)
  assert(none.kind === 'plain' && none.node === null, 'nothing pinned (an older Prometheus): no node key, even though the daemon names one')
  const TLS_PIN = '93e4290f39594676e81c6213a1673294ba700af25b80ef2f9a004e47b1a418a1'
  const tls = await new PairPin({
    profilePin: () => TLS_PIN,
    base: () => 'https://192.0.2.7:8006',
    token: () => 'KEY',
    nodePub: () => PINNED,
    request: async () => 'unreachable',
    ports: { api: 8006, ws: 8011 },
    keyAt: async () => TLS_PIN
  }).decide(TS)
  assert(tls.kind === 'pinned' && tls.pin === TLS_PIN && tls.node === nodeHex(PINNED), `a TLS code carries both, the pin and the node key (${JSON.stringify(tls)})`)
  const bad = await pairPin('not a key').decide(TS)
  assert(bad.kind === 'plain' && bad.node === null, 'a pinned value that is not a 32-byte key: no node, never repaired')
}

void fromThePin().then(() => {
  const MIN_CHECKS = 98
  if (checks < MIN_CHECKS) {
    console.log(`[smoke] FAIL  only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    failures++
  }
  console.log('')
  console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (host, refusals, payload, platform, list, seconds, nav, pin, node; ${checks} checks)`)
  process.exit(failures === 0 ? 0 : 1)
}, (e) => {
  console.log(`[smoke] FAIL  crashed: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
