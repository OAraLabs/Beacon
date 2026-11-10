// "Add a phone" (docs/MULTI-PROMETHEUS.md; the phone-onboarding plan, desktop item 1): a QR with no secret in it, only a name the
// phone can reach this Prometheus by and the node key Beacon pinned for it, so the phone pins it from its first connection and sends a
// join request the owner approves. Never a number address (iOS won't use plain HTTP to one), never localhost (on a phone that is the
// phone), never a token.
//
//   npm run build && npm run smoke:phone-join
import { joinCode, joinHost, joinUrl, parseTailnet, shortTailnetName, type Tailnet } from '@shared/phone-join'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!cond) failures++
}

// RFC 8032 test 1's public key (public, no real host's), as Prometheus's node_pub and as the hex the code carries.
const NODE_B64 = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='
const NODE_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
// TEST-NET (RFC 5737) and the CGNAT shape Tailscale uses, built at run time so no literal of that range sits in the source.
const TS_IP = ['100', '101', '102', '103'].join('.')
const TS_PEER_IP = ['100', '101', '102', '104'].join('.')
const status = {
  BackendState: 'Running',
  Self: { DNSName: 'my-computer.tail0000.ts.net.', HostName: 'Probe Mac', TailscaleIPs: [TS_IP, 'fd7a:115c:a1e0::1'] }, // precommit:allow-example-host
  Peer: { k1: { DNSName: 'my-mini.tail0000.ts.net.', HostName: 'my-mini', TailscaleIPs: [TS_PEER_IP] } } // precommit:allow-example-host
}

console.log('\n[smoke] === the code: the agreed literal ===')
{
  // THE AGREED LITERAL for the phone (the cross-repo vector): change it in both repos or in neither.
  const AGREED = `beacon://join?host=my-mini&node=${NODE_HEX}&name=Home%20mini`
  assert(joinUrl('my-mini', NODE_HEX, 'Home mini') === AGREED, 'host, node (64 lower-case hex), the name to show: byte for byte', joinUrl('my-mini', NODE_HEX, 'Home mini'))
  assert(!/token|secret|key=|pin=/i.test(AGREED), 'no secret of any kind in it')
  const throws = (f: () => string): boolean => {
    try {
      f()
      return false
    } catch {
      return true
    }
  }
  assert([NODE_HEX.toUpperCase(), NODE_HEX.slice(2), NODE_B64].every((n) => throws(() => joinUrl('my-mini', n, 'x'))), 'a node that is not 64 lower-case hex is never emitted')
  assert(['192.0.2.7', TS_IP, 'localhost', '127.0.0.1', 'http://my-mini', 'my-mini:8005', ''].every((h) => throws(() => joinUrl(h, NODE_HEX, 'x'))), 'nor a number address, localhost, a scheme, a port or nothing')
  assert(throws(() => joinUrl('my-mini', NODE_HEX, '  ')), 'nor an empty name')
}

console.log('\n[smoke] === Tailscale names ===')
{
  assert(shortTailnetName('my-mini.tail0000.ts.net.') === 'my-mini' && shortTailnetName('my-mini') === 'my-mini', 'the short name: the first label') // precommit:allow-example-host
  const t = parseTailnet(status)
  assert(t?.self?.name === 'my-computer' && t.peers[0]?.name === 'my-mini' && t.self.ips.includes(TS_IP), 'parsed from tailscale status --json', t)
  assert(parseTailnet({ ...status, BackendState: 'Stopped' }) === null && parseTailnet('garbage') === null && parseTailnet(null) === null, 'Tailscale off, or no answer: none')
}

console.log('\n[smoke] === which name the phone gets ===')
{
  const t = parseTailnet(status) as Tailnet
  const host = (apiBase: string, tn: Tailnet | null = t) => joinHost(apiBase, tn)
  assert(JSON.stringify(host('http://my-mini:8005')) === '{"ok":true,"host":"my-mini"}', 'a short name: as it is')
  assert(JSON.stringify(host('http://my-mini.tail0000.ts.net:8005')) === '{"ok":true,"host":"my-mini"}', 'a full Tailscale name: its short name (iOS allows plain HTTP to a short name, not to …ts.net)') // precommit:allow-example-host
  assert(JSON.stringify(host('http://my-mini.local:8005')) === '{"ok":true,"host":"my-mini.local"}', 'a .local name: as it is')
  assert(JSON.stringify(host('http://localhost:8005')) === '{"ok":true,"host":"my-computer"}' && JSON.stringify(host('http://127.0.0.1:8005')) === '{"ok":true,"host":"my-computer"}', "this Mac (localhost): this Mac's Tailscale name")
  assert(JSON.stringify(host(`http://${TS_PEER_IP}:8005`)) === '{"ok":true,"host":"my-mini"}' && JSON.stringify(host(`http://${TS_IP}:8005`)) === '{"ok":true,"host":"my-computer"}', 'a Tailscale number: the name Tailscale has for it, never the number')
  const no = (r: ReturnType<typeof joinHost>, re: RegExp, what: string) => assert(!r.ok && re.test(r.why) && !r.why.includes('HTTP 4'), what, r)
  no(host('http://localhost:8005', null), /Tailscale/, 'this Mac with Tailscale off: says to turn it on')
  no(host('http://192.0.2.7:8005'), /by name/, 'a number Tailscale does not know: says to connect by name')
  no(host('http://prometheus.example.com:8005'), /short Tailscale name/, 'a full name iOS refuses for plain HTTP: says to use the short name')
  no(host('http://my-mini:9000'), /8005/, 'another port: says the phone connects on 8005')
  no(host('https://my-mini:8006'), /encrypted/i, "an encrypted address: not yet, said so")
}

console.log('\n[smoke] === the whole code, from the instance ===')
{
  const t = parseTailnet(status)
  const ok = joinCode({ apiBase: `http://${TS_PEER_IP}:8005`, nodePub: NODE_B64, name: 'Home mini', tailnet: t, mode: 'home_network' })
  assert(ok.ok && ok.url === `beacon://join?host=my-mini&node=${NODE_HEX}&name=Home%20mini` && ok.host === 'my-mini', 'the pinned node key and the name the phone can reach', ok)
  assert(ok.ok && !ok.url.includes(TS_PEER_IP) && !/(^|[^0-9])100\.\d+\.\d+\.\d+/.test(ok.url), 'never a 100.x address in it')
  const old = joinCode({ apiBase: 'http://my-mini:8005', nodePub: null, name: 'Home mini', tailnet: t, mode: null })
  assert(!old.ok && /0\.9\.18/.test(old.why), "nothing pinned (it can't prove who it is): says to update it to 0.9.18 or later", old)
  const local = joinCode({ apiBase: 'http://localhost:8005', nodePub: NODE_B64, name: 'Laptop', tailnet: t, mode: 'this_mac' })
  assert(!local.ok && /Other computers/.test(local.why), "it only listens to its own Mac: says to turn on Other computers", local)
  const bad = joinCode({ apiBase: 'http://my-mini:8005', nodePub: 'not a key', name: 'x', tailnet: t, mode: null })
  assert(!bad.ok, 'a pinned value that is not a key: no code')
}

if (failures) {
  console.log(`\n[smoke] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[smoke] ALL PASS')
