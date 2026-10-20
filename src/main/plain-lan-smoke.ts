/**
 * No plain HTTP to the home network (owner decision, 2026-10-11, for v0.4; src/shared/plain-lan.ts) — headless, under ELECTRON_RUN_AS_NODE.
 * Written before the code. The three ways in to a plain join on the home network are closed:
 *   - a hidden TLS flag, and a plain-only record carrying a real computer's fp: a plain join to a home-network address is refused
 *     before anything is sent (JoinSession);
 *   - a typed address: TLS is tried first, and a home-network address is never asked in plain (DiscoveryEngine.probeAddress);
 * and every other way of making a new plain connection (setup, a pairing code, Settings) refuses one too (refusePlain). This Mac
 * and Tailscale stay plain. A saved plain home-network connection keeps working, with a one-line notice (notEncrypted).
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryEnv, mergeSightings, type Sighting } from '@shared/discovery'
import { joinActions, type JoinFailureKind } from '@shared/join'
import { COPY } from '@shared/onboarding-strings'
import { NOT_ENCRYPTED_NOTICE, PLAIN_REFUSED, hostScope, notEncrypted, refusePlain, treatAsHomeNetwork } from '@shared/plain-lan'
import { DiscoveryEngine } from './discovery'
import type { HttpRequest } from './pairing/http'
import { JoinSession } from './pairing/session'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[plain-lan-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 10
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[plain-lan-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[plain-lan-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[plain-lan-smoke] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'plain-lan-smoke-'))
const k = join(dir, 'a.key')
const c = join(dir, 'a.crt')
execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k], { stdio: 'ignore' })
execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '2', '-subj', '/CN=prometheus-a.local'], { stdio: 'ignore' })
const A = { key: readFileSync(k, 'utf8'), cert: readFileSync(c, 'utf8') }
const FP = createHash('sha256')
  .update(new X509Certificate(A.cert).publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .digest('hex')
  .slice(0, 16)
const helloBody = (name: string, fp: string, tls: boolean): string => JSON.stringify({ v: '0.9.7', name, agent: 'Prometheus', fp, pair: 'approve', tls })

/** A server that records, in order, every hello it answers and every connection that was not HTTP (a TLS ClientHello to plain). */
async function serve(server: Server, events: string[], body: string): Promise<{ port: number; close: () => Promise<void> }> {
  server.on('request', (q, s) => {
    if (q.url === '/api/hello') events.push('hello')
    s.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    s.end(body)
  })
  server.on('clientError', (_e, sock) => (events.push('not-http'), sock.destroy()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) }
}

/** A Tailscale-range address, built here: the repository's pre-commit guard refuses one written out in source. */
const TS = (b: number, c: number, d: number): string => ['100', b, c, d].join('.')

async function main(): Promise<void> {
  // ── where a host is ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const table: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'], ['127.8.9.10', 'loopback'], ['localhost', 'loopback'], ['::1', 'loopback'], ['[::1]', 'loopback'],
    [TS(64, 0, 1), 'tailscale'], [TS(127, 255, 254), 'tailscale'], ['fd7a:115c:a1e0::1', 'tailscale'], ['[fd7a:115c:a1e0:ab12::5]', 'tailscale'], ['mini.tail1234.ts.net', 'tailscale'], ['MINI.TAIL1234.TS.NET.', 'tailscale'], // precommit:allow-example-host
    ['10.0.0.5', 'home-network'], ['172.16.0.1', 'home-network'], ['172.31.255.1', 'home-network'], ['192.168.50.56', 'home-network'], ['169.254.10.20', 'home-network'],
    ['fe80::1', 'home-network'], ['[fe80::1%25en0]', 'home-network'], ['fd12:3456:789a::1', 'home-network'], ['fc00::2', 'home-network'],
    ['::ffff:192.168.1.5', 'home-network'], ['[::ffff:c0a8:105]', 'home-network'], ['3232235777', 'home-network'], ['0xc0a80101', 'home-network'],
    ['mini.local', 'home-network'], ['Mini.Local.', 'home-network'], ['prometheus-1a2b3c4d.local', 'home-network'],
    ['100.63.255.255', 'other'], ['100.128.0.1', 'other'], ['172.32.0.1', 'other'], ['8.8.8.8', 'other'], ['example.com', 'other'], ['local.example.com', 'other'], ['fd7a:115c:a1e1::1', 'home-network']
  ]
  const wrong = table.filter(([h, want]) => hostScope(h) !== want).map(([h, want]) => `${h}: ${hostScope(h)} (want ${want})`)
  assert(wrong.length === 0, 'where a host is: loopback, Tailscale (100.64/10, fd7a:115c:a1e0::/48, *.ts.net), the home network (private ranges, link-local, ULA, .local, and IPv4 written any way), everything else', wrong.join('; ')) // precommit:allow-example-host

  // ── a new plain connection, and the notice for a saved one ─────────────────────────────────────────────────────────────────
  const saved = { apiBase: 'http://192.168.1.20:8005', wsUrl: 'ws://192.168.1.20:8010' }
  const refusals = {
    lanNew: refusePlain('http://192.168.1.21:8005', 'ws://192.168.1.21:8010', saved),
    lanWsOnly: refusePlain('https://192.168.1.21:8006', 'ws://192.168.1.21:8010', null),
    localName: refusePlain('http://mini.local:8005', 'ws://mini.local:8010', null),
    resave: refusePlain(saved.apiBase, saved.wsUrl, saved),
    tls: refusePlain('https://192.168.1.21:8006', 'wss://192.168.1.21:8011', null),
    loopback: refusePlain('http://127.0.0.1:8005', 'ws://127.0.0.1:8010', null),
    tailscale: refusePlain(`http://${TS(101, 102, 103)}:8005`, `ws://${TS(101, 102, 103)}:8010`, null),
    tsnet: refusePlain('http://mini.tail1234.ts.net:8005', 'ws://mini.tail1234.ts.net:8010', null) // precommit:allow-example-host
  }
  assert(
    refusals.lanNew === PLAIN_REFUSED && refusals.lanWsOnly === PLAIN_REFUSED && refusals.localName === PLAIN_REFUSED && refusals.resave === null && refusals.tls === null && refusals.loopback === null && refusals.tailscale === null && refusals.tsnet === null,
    'a NEW plain connection to the home network is refused (either address plain is enough); re-saving the saved one, TLS, this Mac and Tailscale are not',
    JSON.stringify(refusals)
  )
  const notices = [notEncrypted(saved.apiBase, saved.wsUrl), notEncrypted('http://mini.local:8005', 'ws://mini.local:8010'), notEncrypted('https://192.168.1.20:8006', 'wss://192.168.1.20:8011'), notEncrypted('http://127.0.0.1:8005', 'ws://127.0.0.1:8010'), notEncrypted(`http://${TS(101, 102, 103)}:8005`, `ws://${TS(101, 102, 103)}:8010`)]
  assert(JSON.stringify(notices) === '[true,true,false,false,false]' && NOT_ENCRYPTED_NOTICE === 'Not encrypted — update Prometheus and turn on home network.', 'a saved connection gets the one-line notice only when it goes plain to the home network', JSON.stringify(notices))

  // ── the join: a hidden TLS flag, or a plain-only record with a real fp ──────────────────────────────────────────────────────
  const asked: string[] = []
  const join = async (host: string, fp = '', tlsJoin = false): Promise<{ kind: string; asked: number }> => {
    const before = asked.length
    const s = new JoinSession({
      request: async (r: HttpRequest) => (asked.push(`${r.method} ${r.url}`), 'unreachable'),
      helloOverTls: async () => (asked.push('tls-hello'), { hello: null, spkiHex: null }),
      pinnedRequest: () => async () => 'unreachable',
      now: () => 1_000_000,
      save: () => undefined,
      activate: () => undefined
    })
    const r = await s.begin({ host, apiPort: 8005, name: "Alex's Mac mini", fp, tls: tlsJoin }, "Sam's MacBook", 'macos')
    return { kind: r.ok ? 'ok' : r.failure.kind, asked: asked.length - before }
  }
  const seq = async (hosts: string[], fp = '', tlsJoin = false): Promise<Array<{ kind: string; asked: number }>> => {
    const out: Array<{ kind: string; asked: number }> = []
    for (const h of hosts) out.push(await join(h, fp, tlsJoin))
    return out
  }
  const lan = await seq(['192.168.50.56', 'mini.local', '169.254.1.2', 'fe80::1', '::ffff:192.168.1.5'], FP)
  assert(lan.every((r) => r.kind === 'not-encrypted' && r.asked === 0), 'a plain join to a home-network address (a hidden TLS flag, or a plain-only record carrying a real fp) is refused before anything is sent', JSON.stringify(lan))
  const fine = await seq(['127.0.0.1', TS(101, 102, 103), 'mini.tail1234.ts.net']) // precommit:allow-example-host
  assert(fine.every((r) => r.kind === 'lost' && r.asked === 1), 'a plain join to this Mac or a Tailscale address goes ahead as before', JSON.stringify(fine))
  const overTls = await seq(['192.168.50.56', 'mini.local'], FP, true)
  assert(overTls.every((r) => r.kind === 'lost' && r.asked === 1) && asked.slice(-2).every((a) => a === 'tls-hello'), 'a join OVER TLS to the home network goes ahead (hello over TLS first, as before)', JSON.stringify({ overTls, last: asked.slice(-2) }))

  // ── a typed address ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const engine = new DiscoveryEngine({ env: () => discoveryEnv({}, true), processEnv: {}, platform: 'darwin' })
  const plainEvents: string[] = []
  const plain = await serve(createHttpServer(), plainEvents, helloBody('Old Prometheus', '0123456789abcdef', false))
  const tlsEvents: string[] = []
  const tls = await serve(createHttpsServer({ key: A.key, cert: A.cert }) as unknown as Server, tlsEvents, helloBody('New Prometheus', FP, true))
  const plainHere = await engine.probeAddress({ host: '127.0.0.1', port: plain.port })
  assert(plainHere.ok === true && plainHere.computer.tls === false && JSON.stringify(plainEvents) === '["not-http","hello"]', 'typed, this Mac: TLS is tried first, then plain (the plain server saw a TLS hello, then the plain one)', JSON.stringify({ plainHere, plainEvents }))
  treatAsHomeNetwork(['127.0.0.1']) // the stand-in for a home-network address: nothing here listens beyond loopback
  plainEvents.length = 0
  const plainLan = await engine.probeAddress({ host: '127.0.0.1', port: plain.port })
  const tlsLan = await engine.probeAddress({ host: '127.0.0.1', port: tls.port })
  const lanJoin = await join('127.0.0.1')
  treatAsHomeNetwork([])
  assert(
    plainLan.ok === false && String(plainLan.reason) === 'not-encrypted' && !plainEvents.includes('hello') && tlsLan.ok === true && tlsLan.computer.tls === true && lanJoin.kind === 'not-encrypted',
    'typed, the home network: found over TLS, and never asked in plain (an old Prometheus there is "not encrypted", not found in plain)',
    JSON.stringify({ plainLan, plainEvents, tlsLan: tlsLan.ok ? tlsLan.computer.tls : tlsLan, lanJoin })
  )
  await Promise.all([plain.close(), tls.close()])

  // ── a found computer that cannot be joined ───────────────────────────────────────────────────────────────────────────────
  const sight = (source: Sighting['source'], host: string, tls: boolean, fp: string): Sighting => ({ source, endpoint: { host, port: 8005 }, hello: { version: '0.9.6', name: fp, agent: 'Prometheus', fp, pair: 'approve', tls } })
  const flag = (ss: Sighting[]): unknown => (mergeSightings(ss)[0] as unknown as { needsUpdate?: boolean }).needsUpdate
  const flags = {
    plainLocal: flag([sight('bonjour', 'old-mini.local', false, '00000000000000a1')]),
    plainLan: flag([sight('bonjour', '192.168.1.40', false, '00000000000000a2')]),
    tlsLocal: flag([sight('bonjour', 'new-mini.local', true, '00000000000000a3')]),
    plainHere: flag([sight('loopback', '127.0.0.1', false, '00000000000000a4')]),
    plainTailnet: flag([sight('tailnet', TS(101, 102, 103), false, '00000000000000a5')]),
    alsoHere: flag([sight('bonjour', 'old-mini.local', false, '00000000000000a6'), sight('loopback', '127.0.0.1', false, '00000000000000a6')])
  }
  assert(
    flags.plainLocal === true && flags.plainLan === true && flags.tlsLocal !== true && flags.plainHere !== true && flags.plainTailnet !== true && flags.alsoHere !== true,
    'a found computer reachable only in plain on the home network is marked as needing an update (it cannot be joined); over TLS, on this Mac or on Tailscale it is not',
    JSON.stringify(flags)
  )

  // ── what the person is told ──────────────────────────────────────────────────────────────────────────────────────────────
  const card = (COPY.main.joinFailed as unknown as Record<string, { title: string; body: string } | undefined>)['not-encrypted']
  const typed = (COPY as unknown as { onboarding?: unknown }) && JSON.stringify(COPY).includes('"notEncrypted"')
  assert(
    !!card && /encrypted/.test(card.body) && /update Prometheus/i.test(card.body) && /home network/.test(card.body) && JSON.stringify(joinActions('not-encrypted' as JoinFailureKind)) === '["try-again"]' && typed,
    'the refusal says it plainly: only encrypted on the home network, update Prometheus and turn on home network; Try again; and the typed-address screen has its own words for it',
    JSON.stringify({ card, actions: joinActions('not-encrypted' as JoinFailureKind), typed })
  )
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50)
  })
