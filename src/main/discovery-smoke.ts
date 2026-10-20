/**
 * Discovery smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0 onboarding, O2a.
 *
 * Finding a Prometheus must be display-only: anyone on the Wi-Fi can advertise "Alex's Mac mini", so what
 * discovery reads is untrusted and what it says to a computer is one credential-free question. This holds
 * both halves to account without a window:
 *
 *   * the reading: a five-field allowlist, caps, control and bidirectional characters removed, a Bonjour
 *     feed bounded however it is chopped up, addresses that cannot carry a scheme or a second command;
 *   * the merging: one row per fingerprint, and two computers that share a NAME stay two rows;
 *   * the asking: a GET with no credential, no redirect followed, a body that cannot exceed its cap;
 *   * the gate: a release build ignores every override that could aim a search elsewhere;
 *   * the plist: the keys macOS needs before it will let Beacon look at the network.
 *
 * The Bonjour fixture is REAL `dns-sd -Z` output captured on macOS 15.6 (a local-only advertisement).
 * What it cannot prove: the app's IPC, real Bonjour and the tailnet. `npm run probe:onboarding-discovery`
 * does that in the built app. And a REAL refusal by macOS ("PolicyDenied") needs a packaged Beacon and a
 * click: the -65570 reading here is from Apple's documented error number, not from a captured refusal.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import {
  DEFAULT_PORT,
  DISCOVERY_DEFAULTS,
  MAX_COMPUTERS,
  MAX_INSTANCES,
  MAX_NAME,
  MAX_ZONE_LINE,
  MAX_TAILNET_PROBES,
  ZoneAssembler,
  cleanText,
  differsFromKnown,
  discoveryEnv,
  helloFrom,
  helloUrl,
  isLoopbackHost,
  isPolicyDenied,
  localityOf,
  mergeSightings,
  parseTypedAddress,
  parseHelloBody,
  sightingFromInstance,
  tailnetTargets,
  validEndpoint,
  validHost,
  validPort,
  type DiscoveryUpdate,
  type Hello,
  type Sighting
} from '@shared/discovery'
import { debuggingAllowed } from '@shared/release-gate'
import { askHello, DiscoveryEngine } from './discovery'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[discovery-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 70

const FP_A = '0123456789abcdef'
const FP_B = 'fedcba9876543210'
const BIDI = String.fromCharCode(0x202e)
const ZWSP = String.fromCharCode(0x200b)
const hello = (o: Partial<Hello> = {}): Hello => ({ version: '0.9.6', name: 'Mac mini', agent: 'Atlas', fp: FP_A, pair: 'approve', tls: false, ...o })

// ── 1. reading a hello ──────────────────────────────────────────────────────────────────────────
const h = helloFrom({ v: '0.9.6', name: ' Alex\'s Mac mini ', agent: 'Atlas', fp: FP_A.toUpperCase(), pair: 'approve', token: 'secret', extra: { a: 1 } })
assert(h?.name === "Alex's Mac mini" && h.agent === 'Atlas' && h.version === '0.9.6' && h.fp === FP_A && h.pair === 'approve' && h.tls === false, 'hello: the six facts are read, trimmed, with the fingerprint lower-cased')
assert(JSON.stringify(Object.keys(h ?? {}).sort()) === '["agent","fp","name","pair","tls","version"]', 'hello: the result has exactly those six fields (a field nobody asked for cannot ride along)', Object.keys(h ?? {}).join(','))
assert(helloFrom({ agent: 'x' }) === null && helloFrom({ name: '   ' }) === null && helloFrom({ name: 5 }) === null, 'hello: no usable name, no row')
assert(helloFrom(null) === null && helloFrom([]) === null && helloFrom('mac') === null && helloFrom(7) === null && helloFrom(undefined) === null, 'hello: something that is not an object is not a hello')
assert(helloFrom({ name: 'Mac' + BIDI + 'nim' + ZWSP + 'i\u0007' })?.name === 'Macnimi', 'hello: control, zero-width and bidirectional-override characters are removed from a name', JSON.stringify(helloFrom({ name: 'Mac' + BIDI + 'nim' })?.name))
assert(helloFrom({ name: 'a'.repeat(MAX_NAME + 1) }) === null && helloFrom({ name: 'a'.repeat(MAX_NAME) })?.name.length === MAX_NAME, 'hello: a name over the cap is not shown; one at the cap is')
const odd = helloFrom({ name: 'X', agent: 'y'.repeat(500), fp: 'NOTHEX', pair: 'root', v: 5 })
assert(odd?.agent === '' && odd.fp === '' && odd.pair === 'unknown' && odd.version === '', 'hello: an overlong, malformed or mistyped field reads as empty, never as itself')
assert(helloFrom({ name: 'X', fp: FP_A.slice(0, 15) })?.fp === '' && helloFrom({ name: 'X', fp: FP_A + 'a' })?.fp === '', 'hello: a fingerprint is exactly 16 hex characters')
assert(helloFrom({ name: 'X', pair: 'approve' })?.pair === 'approve' && helloFrom({ name: 'X', pair: 'code' })?.pair === 'code', 'hello: both pairing styles are understood')
assert(helloFrom({ name: 'X', pair: 'token' })?.pair === 'token' && helloFrom({ name: 'X', pair: 'none' })?.pair === 'none', 'hello: a Prometheus that can only be joined with its token ("token") or has no password at all ("none") is understood as that, not as unknown')
assert(helloFrom({ name: 'X', tls: true })?.tls === true && helloFrom({ name: 'X', tls: '1' })?.tls === true && helloFrom({ name: 'X', tls: false })?.tls === false && helloFrom({ name: 'X', tls: '0' })?.tls === false && helloFrom({ name: 'X' })?.tls === false && helloFrom({ name: 'X', tls: 'true' })?.tls === false && helloFrom({ name: 'X', tls: 1 })?.tls === false, 'hello: "speaks TLS" is the boolean true or the TXT text "1" and nothing else; absent means plain')
assert(helloFrom({}, 'From Bonjour')?.name === 'From Bonjour' && helloFrom({ name: 'Own' }, 'From Bonjour')?.name === 'Own', 'hello: a Bonjour instance name is the fallback, never the preference')
assert(parseHelloBody('{"name":"A"}')?.name === 'A' && parseHelloBody('') === null && parseHelloBody('nope') === null && parseHelloBody('[]') === null, 'body: JSON object only')
assert(parseHelloBody(JSON.stringify({ name: 'A', pad: 'x'.repeat(5000) })) === null, 'body: over 4 KiB is not a hello')
assert(cleanText(undefined, 5) === '' && cleanText({}, 5) === '' && cleanText('ab', 5) === 'ab' && cleanText('abcdef', 5) === '', 'cleanText: non-strings and over-long strings read as empty')

// ── 2. addresses ────────────────────────────────────────────────────────────────────────────────
const goodHosts = ['127.0.0.1', 'localhost', 'alex-mac-mini.local', 'a.example.internal', '::1', 'fe80::1']
const badHosts = ['', 'a b', 'http://x', 'x/y', 'x@y', 'x:8005', 'x?y', 'x#y', 'x;rm', '-x', 'x-', '$(x)', 'x'.repeat(254), 'x\ny', ':::g', 'x,y']
assert(goodHosts.every((x) => validHost(x)), 'host: names, IPv4 and IPv6 literals pass', goodHosts.filter((x) => !validHost(x)).join(' | '))
assert(badHosts.every((x) => !validHost(x)), 'host: a space, scheme, path, credential, port, query, fragment, shell fragment or newline is refused', badHosts.filter((x) => validHost(x)).join(' | '))
assert([1, 8005, 65535].every(validPort) && [0, 65536, -1, 1.5, '8005', null, NaN].every((x) => !validPort(x)), 'port: an integer 1 to 65535, and nothing that merely looks like one')
assert(validEndpoint({ host: '127.0.0.1', port: 8005 }) && !validEndpoint({ host: 'a b', port: 8005 }) && !validEndpoint(null) && !validEndpoint({ host: '127.0.0.1' }), 'endpoint: both halves, or not at all')
assert(helloUrl({ host: '127.0.0.1', port: 8123 }) === 'http://127.0.0.1:8123/api/hello' && helloUrl({ host: '::1', port: 8005 }) === 'http://[::1]:8005/api/hello', 'url: the typed port is the port asked; IPv6 is bracketed')
assert(isLoopbackHost('localhost') && isLoopbackHost('localhost.') && isLoopbackHost('127.0.0.5') && isLoopbackHost('::1') && !isLoopbackHost('alex-mac-mini.local') && !isLoopbackHost('127.evil.example.com') && !isLoopbackHost('127.0.0.1.evil.example.com') && !isLoopbackHost('localhost.evil.example.com'), 'loopback: localhost, a literal 127.x.y.z and ::1 only; a NAME that starts like one (an advertiser picks its own) is not this Mac')

const addr = (t: unknown): string => JSON.stringify(parseTypedAddress(t))
assert(addr('alex-mac-mini.local') === '{"host":"alex-mac-mini.local","port":8005}' && addr('  127.0.0.1:8123  ') === '{"host":"127.0.0.1","port":8123}' && addr('[::1]:9') === '{"host":"::1","port":9}' && addr('[::1]') === '{"host":"::1","port":8005}' && addr('fe80::1') === '{"host":"fe80::1","port":8005}', 'typed: a name, a name and a port, an IPv6 literal with and without one: the port that was typed is the port kept, and the standard one is used only when none was typed')
const badTyped = ['', '   ', 'a b', 'http://x', 'x/y', 'host:abc', 'host:', 'host:0', 'host:70000', 'host:8005:1', 'host:-1', 'host:1e3', 'host:0x50', 'host:+80', 'host:80.0', 'host: 80', ':8005', '[::1', '[x]:8005', 'x;rm -rf', null, undefined, 5, {}]
assert(badTyped.every((x) => parseTypedAddress(x) === null), 'typed: nothing that is not a host and an optional port is accepted (a scheme, a path, an empty or non-numeric or out-of-range port, a port written as 1e3, 0x50 or +80 which Number() would accept, a shell fragment, a non-string)', badTyped.filter((x) => parseTypedAddress(x) !== null).map(String).join(' | '))

// ── 3. Bonjour, from real dns-sd output ─────────────────────────────────────────────────────────
const ZONE = String.raw`Using LocalOnly
Using interface -1
Browsing for _prometheus._tcp.local
DATE: ---Wed 07 Oct 2026---
20:47:24.744  ...STARTING...

; To direct clients to browse a different domain, substitute that domain in place of '@'
lb._dns-sd._udp                                 PTR     @

; In the list of services below, the SRV records will typically reference dot-local Multicast DNS names.
; When transferring this zone file data to your unicast DNS server, you'll need to replace those dot-local
; names with the correct fully-qualified (unicast) domain name of the target host offering the service.

_prometheus._tcp                                PTR     Probe\032Mac\032mini's._prometheus._tcp
Probe\032Mac\032mini's._prometheus._tcp         SRV     0 0 18005 localhost. ; Replace with unicast FQDN of target host
Probe\032Mac\032mini's._prometheus._tcp         TXT     "v=0.9.6" "name=Probe Mac mini" "agent=Atlas" "fp=0123456789abcdef" "pair=approve"
`
const feed = (text: string, size = text.length): ZoneAssembler => {
  const z = new ZoneAssembler()
  for (let i = 0; i < text.length; i += size) z.push(text.slice(i, i + size))
  return z
}
const real = feed(ZONE).instances()
assert(real.length === 1 && real[0].instance === "Probe Mac mini's" && real[0].host === 'localhost' && real[0].port === 18005, 'zone: real dns-sd output yields one instance, its escapes (\\032 is a space) undone', JSON.stringify(real))
assert(real[0]?.txt.name === 'Probe Mac mini' && real[0].txt.fp === FP_A && real[0].txt.pair === 'approve' && real[0].txt.agent === 'Atlas' && real[0].txt.v === '0.9.6', 'zone: …with its TXT facts, a space inside a value intact')
const sight = real[0] ? sightingFromInstance(real[0]) : null
assert(sight?.source === 'bonjour' && sight.endpoint.port === 18005 && sight.hello.name === 'Probe Mac mini' && sight.hello.fp === FP_A, 'zone: an instance becomes a Bonjour sighting through the same allowlist as a hello')
const same = [1, 2, 3, 7, 50, 333].every((n) => JSON.stringify(feed(ZONE, n).instances()) === JSON.stringify(real))
assert(same, 'zone: the result is the same however the stream is chopped (1, 2, 3, 7, 50, 333 bytes at a time)')
const noTxt = feed(String.raw`Only\032SRV._prometheus._tcp  SRV 0 0 8005 box.local. ; x` + '\n').instances()
assert(noTxt.length === 1 && Object.keys(noTxt[0].txt).length === 0 && sightingFromInstance(noTxt[0]) !== null, 'zone: an instance with no TXT still has its name as a fallback')
const flood = Array.from({ length: MAX_INSTANCES + 40 }, (_v, i) => `Host${i}._prometheus._tcp SRV 0 0 8005 h${i}.local.\nHost${i}._prometheus._tcp TXT "name=Host${i}"\n`).join('')
assert(feed(flood).instances().length === MAX_INSTANCES, `zone: a flood of advertisements is capped (${MAX_INSTANCES} kept of ${MAX_INSTANCES + 40})`)
const hostile = [
  `X._prometheus._tcp SRV 0 0 0 box.local.`,
  `X._prometheus._tcp SRV 0 0 70000 box.local.`,
  `X._prometheus._tcp SRV 0 0 8005 box/evil.`,
  `X._prometheus._tcp SRV 0 0 8005 a b.`,
  `X._other._tcp SRV 0 0 8005 box.local.`,
  `${'A'.repeat(5000)}._prometheus._tcp SRV 0 0 8005 box.local.`,
  `._prometheus._tcp SRV 0 0 8005 box.local.`
].join('\n') + '\n'
assert(feed(hostile).instances().length === 0, 'zone: a port out of range, a host that is not a host, another service type, an oversized or empty name: each dropped, none repaired')
const keys = Array.from({ length: 40 }, (_v, i) => `"k${i}=v"`).join(' ')
const manyKeys = feed(`K._prometheus._tcp SRV 0 0 8005 box.local.\nK._prometheus._tcp TXT ${keys}\n`).instances()[0]
assert(Object.keys(manyKeys?.txt ?? {}).length === 16, 'zone: a TXT record with 40 keys keeps 16')
const dupe = feed(`D._prometheus._tcp SRV 0 0 8005 box.local.\nD._prometheus._tcp TXT "name=First" "name=Second" "FP=${FP_A}"\n`).instances()[0]
assert(dupe?.txt.name === 'First' && dupe.txt.fp === FP_A, 'zone: the first of a repeated key wins; keys are matched in lower case')
const unterminated = new ZoneAssembler()
unterminated.push('x'.repeat(100_000))
unterminated.push('\nOk._prometheus._tcp SRV 0 0 8005 box.local.\n')
const bufferCheck = new ZoneAssembler()
bufferCheck.push('x'.repeat(100_000))
assert(unterminated.instances().length === 1, 'zone: after a line too long to be a line, the next real line still reads')
assert(bufferCheck.pending() <= MAX_ZONE_LINE, 'zone: a stream that never ends a line cannot grow the buffer without end (the buffer itself is bounded, not only the line it would make)', String(bufferCheck.pending()))
assert(isPolicyDenied('DNSService call failed -65570') && isPolicyDenied('error: kDNSServiceErr_PolicyDenied') && isPolicyDenied('policydenied') && !isPolicyDenied(ZONE) && !isPolicyDenied('port 165570') && !isPolicyDenied(''), 'denied: the error number or its name, and not ordinary output')

// ── 4. merging ──────────────────────────────────────────────────────────────────────────────────
const S = (source: Sighting['source'], host: string, port: number, o: Partial<Hello> = {}): Sighting => ({ source, endpoint: { host, port }, hello: hello(o) })
const one = mergeSightings([S('loopback', '127.0.0.1', 8005), S('bonjour', 'alex-mini.local', 8005), S('tailnet', '10.0.0.9', 8005)])
assert(one.length === 1 && one[0].where === 'this-mac' && one[0].id === FP_A && one[0].endpoints.length === 3, 'merge: one computer seen three ways is one row, "this Mac", with all three ways to reach it', JSON.stringify(one.map((c) => [c.where, c.endpoints.length])))
assert(JSON.stringify(one[0].endpoints.map((e) => e.host)) === '["127.0.0.1","alex-mini.local","10.0.0.9"]', 'merge: ways to reach it are ordered this Mac, then the home network, then the private network')
const spoof = mergeSightings([S('bonjour', 'real.local', 8005, { name: "Alex's Mac mini", fp: FP_A }), S('bonjour', 'fake.local', 8005, { name: "Alex's Mac mini", fp: FP_B })])
assert(spoof.length === 2 && spoof.every((c) => c.name === "Alex's Mac mini"), 'merge: two computers with the SAME name and different fingerprints stay two rows (an impostor is not folded into the real one)')
const noFp = mergeSightings([S('bonjour', 'a.local', 8005, { fp: '', name: 'A' }), S('bonjour', 'a.local', 8005, { fp: '', name: 'A' }), S('bonjour', 'b.local', 8005, { fp: '', name: 'B' })])
assert(noFp.length === 2 && noFp[0].id === 'a.local:8005', 'merge: with no fingerprint, the same address is the same computer, and the row is identified by it', JSON.stringify(noFp.map((c) => c.id)))
const prefer = mergeSightings([S('bonjour', 'x.local', 8005, { name: 'Advertised', agent: 'Zed' }), S('tailnet', '10.0.0.8', 8005, { name: 'Asked', agent: '' })])
assert(prefer[0].name === 'Asked' && prefer[0].agent === 'Zed', "merge: a computer's own answer outranks what it advertised, and a blank answer does not erase a fact", JSON.stringify(prefer[0]))
assert(mergeSightings([S('bonjour', 'x.local', 8005, { tls: true }), S('loopback', '127.0.0.1', 8005, { tls: false })])[0].tls === true && mergeSightings([S('bonjour', 'x.local', 8005, {}), S('loopback', '127.0.0.1', 8005, {})])[0].tls === false, 'merge: if any way of asking says it speaks TLS, the row says so (the cautious reading)')
const order = mergeSightings([S('tailnet', '10.0.0.8', 8005, { fp: FP_A, name: 'Zed' }), S('bonjour', 'h.local', 8005, { fp: FP_B, name: 'Beta' }), S('loopback', '127.0.0.1', 8005, { fp: '0000000000000001', name: 'Mid' })])
assert(order.map((c) => c.where).join() === 'this-mac,home-network,private-network', 'merge: this Mac first, then the home network, then the private network', order.map((c) => c.where).join())
const many = mergeSightings(Array.from({ length: 50 }, (_v, i) => S('bonjour', `h${i}.local`, 8005, { fp: i.toString(16).padStart(16, '0'), name: `N${i}` })))
assert(many.length === MAX_COMPUTERS, `merge: no more than ${MAX_COMPUTERS} rows`)
assert(localityOf(S('bonjour', 'localhost', 8005)) === 'this-mac' && localityOf(S('bonjour', 'x.local', 8005)) === 'home-network' && localityOf(S('typed', '127.0.0.1', 8005)) === 'typed' && localityOf(S('typed', 'x.example', 8005)) === 'typed' && localityOf(S('tailnet', 'x', 8005)) === 'private-network', 'locality: Bonjour pointing at this Mac is this Mac; a typed address is always labelled as typed, so its port stays visible')
assert(differsFromKnown({ "Alex's Mac mini": FP_A }, { name: "Alex's Mac mini", fp: FP_B }) && !differsFromKnown({ "Alex's Mac mini": FP_A }, { name: "Alex's Mac mini", fp: FP_A }) && !differsFromKnown({}, { name: 'X', fp: FP_B }) && !differsFromKnown({ X: FP_A }, { name: 'X', fp: '' }), 'known: "this looks different from last time" only for a known name whose fingerprint changed')

// ── 5. the tailnet ──────────────────────────────────────────────────────────────────────────────
const peers = [
  { online: true, dnsName: 'one.example.internal', ips: ['10.1.1.1', 'fd00::1'] },
  { online: false, dnsName: 'off.example.internal', ips: ['10.1.1.2'] },
  { online: true, dnsName: 'named.example.internal', ips: [] },
  { online: true, dnsName: 'bad name', ips: ['x y'] }
]
const targets = tailnetTargets(peers, 8005)
assert(JSON.stringify(targets) === '[{"host":"10.1.1.1","port":8005},{"host":"named.example.internal","port":8005}]', 'tailnet: online peers only; the first address, or the name if there is none; an unusable one is skipped', JSON.stringify(targets))
assert(tailnetTargets(Array.from({ length: 80 }, (_v, i) => ({ online: true, dnsName: `p${i}.example.internal`, ips: [] })), 8005).length === MAX_TAILNET_PROBES, `tailnet: at most ${MAX_TAILNET_PROBES} peers are asked`)

// ── 6. the gate on overrides ────────────────────────────────────────────────────────────────────
const raw = { BEACON_DISCOVERY_PORT: '9123', BEACON_DISCOVERY_SOURCES: 'loopback,bonjour', BEACON_DISCOVERY_WINDOW_MS: '2500', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo -evil --also', BEACON_DISCOVERY_DNSSD: '/tmp/fake' }
const dev = discoveryEnv(raw, true)
assert(dev.port === 9123 && dev.windowMs === 2500 && dev.dnssd === '/tmp/fake' && [...dev.sources].join() === 'loopback,bonjour' && dev.bonjourFlags.join() === '-lo', 'env: a dev or probe build honours the overrides, and passes only "-lo" through as a lookup flag')
assert(discoveryEnv(raw, false) === DISCOVERY_DEFAULTS && DISCOVERY_DEFAULTS.port === DEFAULT_PORT && DISCOVERY_DEFAULTS.dnssd === '' && DISCOVERY_DEFAULTS.bonjourFlags.length === 0 && DISCOVERY_DEFAULTS.sources.size === 3, 'env: a release build ignores every override (port, sources, window, flags and tool)')
const junk = discoveryEnv({ BEACON_DISCOVERY_PORT: '99999', BEACON_DISCOVERY_SOURCES: 'nope,,x', BEACON_DISCOVERY_WINDOW_MS: '5' }, true)
assert(junk.port === DEFAULT_PORT && junk.sources.size === 3 && junk.windowMs === DISCOVERY_DEFAULTS.windowMs, 'env: junk values fall back to the defaults')
assert(debuggingAllowed('release', true) === false && debuggingAllowed(null, true) === false && debuggingAllowed('probe', true) === true && debuggingAllowed(null, false) === true, 'env: "allowed" is the same build-flavour decision that refuses DevTools in a release build')
assert(/discoveryEnv\(process\.env, debuggingAllowedHere\(\)\)/.test(readFileSync('src/main/discovery-ipc.ts', 'utf8').replace(/\/\/.*$/gm, '')), 'env: the IPC module passes the build-flavour decision, not a constant, into discoveryEnv')

const engineSrc = readFileSync('src/main/discovery.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
assert(/\btailnetPeers\b/.test(engineSrc) && !/\btailnetStatus\b/.test(engineSrc) && !/ssh-add/.test(engineSrc), 'tailnet: discovery asks the Tailscale CLI for peers and never reads the ssh-agent (it uses tailnetPeers, not tailnetStatus)')

// ── 7. the plist ────────────────────────────────────────────────────────────────────────────────
const yml = readFileSync('electron-builder.yml', 'utf8')
assert(/^\s+NSLocalNetworkUsageDescription:\s*\S.{20,}$/m.test(yml), 'plist: NSLocalNetworkUsageDescription is set, in plain words (it is the text of the macOS prompt)')
assert(/^\s+NSBonjourServices:\s*\n\s+-\s+_prometheus\._tcp\s*$/m.test(yml), 'plist: NSBonjourServices lists _prometheus._tcp')
const prompt = /NSLocalNetworkUsageDescription:\s*(.+)$/m.exec(yml)?.[1] ?? ''
assert(!/\b(daemon|gateway|token|port|localhost|mDNS|Bonjour|API)\b/i.test(prompt), 'plist: the prompt text uses none of the banned jargon', prompt)

// ── 8. asking a computer ────────────────────────────────────────────────────────────────────────
interface Seen { method: string; url: string; headers: IncomingMessage['headers'] }
function stubServer(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    handler(req, res)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        seen,
        close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r())))
      })
    )
  )
}

async function main(): Promise<void> {
  const ok = await stubServer((_q, res) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ v: '0.9.6', name: 'Stub', agent: 'Atlas', fp: FP_A, pair: 'approve' }))))
  const got = await askHello({ host: '127.0.0.1', port: ok.port })
  const first = ok.seen[0]
  assert(typeof got !== 'string' && got.name === 'Stub' && ok.seen.length === 1 && first?.method === 'GET' && first.url === '/api/hello', 'ask: one GET /api/hello, and nothing else')
  assert(first !== undefined && !('authorization' in first.headers) && !('cookie' in first.headers) && !('x-api-key' in first.headers) && !('content-length' in first.headers), 'ask: no Authorization, cookie, key or body goes with it', Object.keys(first?.headers ?? {}).join(','))
  await ok.close()

  const target = await stubServer((_q, res) => (res.writeHead(200), res.end('{"name":"Elsewhere"}')))
  const redirector = await stubServer((_q, res) => (res.writeHead(302, { location: `http://127.0.0.1:${target.port}/api/hello` }), res.end()))
  const red = await askHello({ host: '127.0.0.1', port: redirector.port })
  assert(typeof red === 'string' && target.seen.length === 0, 'ask: a redirect is not followed; the place it pointed at is never contacted', `${typeof red === 'string' ? red : 'a row'}, ${target.seen.length} requests to the target`)
  await Promise.all([target.close(), redirector.close()])

  const big = await stubServer((_q, res) => (res.writeHead(200), res.end(`{"name":"${'a'.repeat(200_000)}"}`)))
  assert((await askHello({ host: '127.0.0.1', port: big.port })) === 'not-prometheus', 'ask: a 200 KB answer is refused')
  await big.close()
  // The parser also refuses a long body, so only an ENDLESS one shows that the reader itself stops: it must
  // give up after a few KB and say "not a Prometheus", long before the timeout, with little sent.
  let sent = 0
  const endless = await stubServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const timer = setInterval(() => {
      sent += 8192
      res.write('a'.repeat(8192))
    }, 1)
    res.on('close', () => clearInterval(timer))
  })
  const tEndless = Date.now()
  const endlessOutcome = await askHello({ host: '127.0.0.1', port: endless.port }, 1500)
  assert(endlessOutcome === 'not-prometheus' && Date.now() - tEndless < 1000 && sent < 2_000_000, 'ask: an answer that never ends is cut off after a few KB, long before the timeout, not read until it gives up', `${String(endlessOutcome)} after ${Date.now() - tEndless} ms, ${sent} bytes sent`)
  await endless.close()
  const page = await stubServer((_q, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>router login</html>')))
  const bad = await stubServer((_q, res) => (res.writeHead(404), res.end('{}')))
  assert((await askHello({ host: '127.0.0.1', port: page.port })) === 'not-prometheus' && (await askHello({ host: '127.0.0.1', port: bad.port })) === 'not-prometheus', 'ask: a web page, or a 404, is "not a Prometheus"')
  await Promise.all([page.close(), bad.close()])
  const hang = await stubServer(() => undefined)
  const t0 = Date.now()
  assert((await askHello({ host: '127.0.0.1', port: hang.port }, 300)) === 'unreachable' && Date.now() - t0 < 2000, 'ask: one that never answers is given up on at the timeout')
  await hang.close()

  // the engine, with its seams
  const live = await stubServer((_q, res) => (res.writeHead(200), res.end(JSON.stringify({ name: 'Engine Stub', fp: FP_A }))))
  const env = (sources: string, port = live.port) => () => discoveryEnv({ BEACON_DISCOVERY_PORT: String(port), BEACON_DISCOVERY_SOURCES: sources, BEACON_DISCOVERY_WINDOW_MS: '300' }, true)
  const collect = (engine: DiscoveryEngine, quiet: boolean): Promise<DiscoveryUpdate[]> =>
    new Promise((resolve) => {
      const seen: DiscoveryUpdate[] = []
      engine.start({ quiet }, (u) => {
        seen.push(u)
        if (u.done) resolve(seen)
      })
      setTimeout(() => resolve(seen), 4000)
    })
  const quiet = await collect(new DiscoveryEngine({ env: env('loopback,tailnet,bonjour'), processEnv: {}, platform: 'darwin' }), true)
  const lastQuiet = quiet[quiet.length - 1]
  assert(lastQuiet?.done === true && lastQuiet.computers.length === 1 && lastQuiet.lan === 'off' && lastQuiet.computers[0].where === 'this-mac', 'engine: a quiet search looks at this Mac only, even when every source is allowed, and says the network scan was not run', JSON.stringify({ n: lastQuiet?.computers.length, lan: lastQuiet?.lan }))
  const linux = await collect(new DiscoveryEngine({ env: env('loopback,bonjour'), processEnv: {}, platform: 'linux' }), false)
  assert(linux[linux.length - 1]?.lan === 'unsupported' && linux[linux.length - 1]?.done === true && linux[linux.length - 1]?.computers.length === 1, 'engine: where there is no lookup tool wired up the scan is "unsupported", not "denied", and this Mac is still found')
  const nothing = await collect(new DiscoveryEngine({ env: env('tailnet'), processEnv: {}, platform: 'darwin' }), true)
  assert(nothing[nothing.length - 1]?.done === true && nothing[nothing.length - 1]?.computers.length === 0, 'engine: a quiet search with no source it may use finishes at once with nothing')
  const eng = new DiscoveryEngine({ env: env('loopback'), processEnv: {}, platform: 'darwin' })
  const sessions: number[] = []
  const s1 = eng.start({ quiet: true }, (u) => sessions.push(u.session))
  const s2 = eng.start({ quiet: true }, (u) => sessions.push(u.session))
  await new Promise((r) => setTimeout(r, 400))
  assert(s2 === s1 + 1 && sessions.length > 0 && sessions.every((s) => s === s2), 'engine: starting a second search silences the first (no update from a stale session reaches the page)', JSON.stringify({ s1, s2, sessions }))
  const afterStop: number[] = []
  eng.start({ quiet: true }, (u) => afterStop.push(u.session))
  eng.stop()
  await new Promise((r) => setTimeout(r, 400))
  assert(afterStop.length === 0, 'engine: after stop() nothing more is delivered', `${afterStop.length} updates`)
  const typed = await new DiscoveryEngine({ env: env('loopback'), processEnv: {}, platform: 'darwin' }).probeAddress({ host: '127.0.0.1', port: live.port })
  assert(typed.ok === true && typed.computer.where === 'typed' && typed.computer.endpoints[0].port === live.port, 'engine: a typed address is asked on the port typed')
  const refused = await Promise.all([{ host: 'a b', port: 1 }, { host: '127.0.0.1', port: 0 }, null, 'x', { host: '127.0.0.1', port: '8005' }].map((r) => new DiscoveryEngine({ env: env('loopback'), processEnv: {}, platform: 'darwin' }).probeAddress(r)))
  assert(refused.every((r) => !r.ok && r.reason === 'invalid') && live.seen.length > 0, 'engine: an address that is not an address is refused before anything is asked', JSON.stringify(refused.map((r) => (r.ok ? 'ok' : r.reason))))
  await live.close()

  if (checks !== EXPECTED) {
    console.error(`[discovery-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED} (a section was skipped, or one was added without updating EXPECTED)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[discovery-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exit(1)
  }
  console.log(`[discovery-smoke] OK — ${checks} checks passed`)
}

void main().catch((e) => {
  console.error('[discovery-smoke] FAIL — threw:', e)
  process.exit(1)
})
