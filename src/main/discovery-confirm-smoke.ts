/**
 * Discovery confirms what it shows (docs/MULTI-COMPUTER-v0.4.md §4) — headless, under ELECTRON_RUN_AS_NODE. Written before the
 * code. #700's contract: an mDNS record can outlive its daemon (a SIGKILLed one lingers until its TTL), so a client always
 * confirms a sighting with GET /api/hello before showing it. Until now Beacon showed Bonjour sightings straight from their TXT.
 *
 * The real engine (DiscoveryEngine), its Bonjour source fed by a fake `dns-sd` (a script printing zone lines in chunks, the way
 * the real tool streams), against local servers that count every request:
 *   - a sighting is shown only once hello answers at its address, in the computer's own words (not its advertisement's);
 *   - a record whose computer is gone is not shown;
 *   - a tls=1 record is confirmed with hello OVER TLS, and shown speaking TLS at its TLS port; one whose port speaks plain is
 *     not shown (never downgraded), nor one whose hello names a key it did not present;
 *   - each record is asked once, not on every chunk of the stream;
 *   - a typed address that speaks TLS is confirmed over TLS, with the same rule about the key.
 * From the review of PR 246:
 *   - a search asks at most MAX_HELLOS records, however many are advertised;
 *   - a TLS hello has a deadline (a server dripping bytes cannot hold it), and nothing is said after the search's last word;
 *   - a plain record on the home network that claims a TLS-verified computer's fp does not shape that computer's row.
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_HELLOS, discoveryEnv, mergeSightings, type DiscoveryUpdate, type Sighting } from '@shared/discovery'
import { DiscoveryEngine } from './discovery'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[discovery-confirm-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 13
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[discovery-confirm-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[discovery-confirm-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[discovery-confirm-smoke] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'discovery-confirm-smoke-'))
function cert(name: string): { key: string; cert: string; pin: string } {
  const k = join(dir, `${name}.key`)
  const c = join(dir, `${name}.crt`)
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '3', '-subj', `/CN=prometheus-${name}.local`], { stdio: 'ignore' })
  const pem = readFileSync(c, 'utf8')
  const spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return { key: readFileSync(k, 'utf8'), cert: pem, pin: createHash('sha256').update(spki).digest('hex') }
}
const A = cert('a')
const B = cert('b')
const FP_PLAIN = '0123456789abcdef'

interface Stub {
  port: number
  hellos: () => number
  close: () => Promise<void>
}
const hello = (name: string, fp: string, tls: boolean) => JSON.stringify({ v: '0.9.7', name, agent: 'Prometheus', fp, pair: 'approve', tls })
async function stub(make: (h: (q: IncomingMessage, s: ServerResponse) => void) => ReturnType<typeof createHttpServer>, body: string, delayMs = 0): Promise<Stub> {
  let n = 0
  const server = make((q, s) => {
    if (q.url === '/api/hello') n++
    setTimeout(() => {
      s.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      s.end(body)
    }, delayMs)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, hellos: () => n, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) }
}
const plainStub = (body: string, delayMs = 0) => stub((h) => createHttpServer(h), body, delayMs)
const tlsStub = (c: { key: string; cert: string }, body: string) => stub((h) => createHttpsServer({ key: c.key, cert: c.cert }, h) as unknown as ReturnType<typeof createHttpServer>, body)
/** A port nothing listens on: bound, then closed. */
async function deadPort(): Promise<number> {
  const s = createNetServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}

const esc = (s: string): string => s.replace(/ /g, '\\032')
function record(name: string, port: number, txt: Record<string, string>): string {
  const inst = `${esc(name)}._prometheus._tcp`
  const t = Object.entries(txt)
    .map(([k, v]) => `"${k}=${v}"`)
    .join(' ')
  return [`_prometheus._tcp                                PTR     ${inst}`, `${inst}         SRV     0 0 ${port} localhost. ; Replace with unicast FQDN of target host`, `${inst}         TXT     ${t}`].join('\n') + '\n'
}
const HEADER = `Using LocalOnly\nUsing interface -1\nBrowsing for _prometheus._tcp.local\n\n; To direct clients to browse a different domain, substitute that domain in place of '@'\nlb._dns-sd._udp                                 PTR     @\n\n`

const collect = (engine: DiscoveryEngine): Promise<DiscoveryUpdate[]> =>
  new Promise((resolve) => {
    const seen: DiscoveryUpdate[] = []
    engine.start({ quiet: false }, (u) => {
      seen.push(u)
      if (u.done) resolve(seen)
    })
    setTimeout(() => resolve(seen), 8000)
  })

async function main(): Promise<void> {
  const livePlain = await plainStub(hello('Asked Plain', FP_PLAIN, false))
  const liveTls = await tlsStub(A, hello('Asked TLS', A.pin.slice(0, 16), true))
  const plainSaysTls = await plainStub(hello('Plain Says TLS', '1111111111111111', false))
  const tlsLies = await tlsStub(B, hello('TLS Lies', '2222222222222222', true)) // presents B's key, names another
  const late = await plainStub(hello('Asked Late', '3333333333333333', false), 700) // answers slowly
  const gone = await deadPort()
  const part1 = HEADER + record('Advertised Plain', livePlain.port, { v: '0.9.7', name: 'Advertised Plain', agent: 'Prometheus', fp: FP_PLAIN, pair: 'approve', tls: '0' }) + record('Gone', gone, { v: '0.9.7', name: 'Gone', agent: 'Prometheus', fp: 'fedcba9876543210', pair: 'approve', tls: '0' })
  const part2 = record('Advertised TLS', liveTls.port, { v: '0.9.7', name: 'Advertised TLS', agent: 'Prometheus', fp: A.pin.slice(0, 16), pair: 'approve', tls: '1' }) + record('Plain Says TLS', plainSaysTls.port, { v: '0.9.7', name: 'Plain Says TLS', agent: 'Prometheus', fp: '1111111111111111', pair: 'approve', tls: '1' }) + record('TLS Lies', tlsLies.port, { v: '0.9.7', name: 'TLS Lies', agent: 'Prometheus', fp: '2222222222222222', pair: 'approve', tls: '1' })
  const part3 = record('Late', late.port, { v: '0.9.7', name: 'Late', agent: 'Prometheus', fp: '3333333333333333', pair: 'approve', tls: '0' })
  writeFileSync(join(dir, 'part1'), part1)
  writeFileSync(join(dir, 'part2'), part2)
  writeFileSync(join(dir, 'part3'), part3)
  // The real tool streams: the first records, then more a moment later, then it keeps running until it is stopped.
  const tool = join(dir, 'dns-sd')
  writeFileSync(tool, `#!/bin/sh\ncat '${join(dir, 'part1')}'\nsleep 0.3\ncat '${join(dir, 'part1')}' >/dev/null\ncat '${join(dir, 'part2')}'\nsleep 1.9\ncat '${join(dir, 'part3')}'\nsleep 20\n`)
  chmodSync(tool, 0o755)
  const env = () => discoveryEnv({ BEACON_DISCOVERY_PORT: String(gone), BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_WINDOW_MS: '2500', BEACON_DISCOVERY_DNSSD: tool }, true)

  const updates = await collect(new DiscoveryEngine({ env, processEnv: {}, platform: 'darwin' }))
  const last = updates[updates.length - 1]
  const names = (last?.computers ?? []).map((c) => c.name).sort()
  const everShown = [...new Set(updates.flatMap((u) => u.computers.map((c) => c.name)))].sort()
  assert(!everShown.includes('Gone'), 'bonjour: a record whose computer is gone is never shown (hello did not answer)', JSON.stringify(everShown))
  assert(names.includes('Asked Plain') && !everShown.includes('Advertised Plain'), "bonjour: a live one is shown once hello answers, in the computer's own words, never the advertisement's", JSON.stringify({ names, everShown }))
  const tlsRow = last?.computers.find((c) => c.name === 'Asked TLS')
  assert(!!tlsRow && tlsRow.tls === true && tlsRow.endpoints.some((e) => e.port === liveTls.port) && liveTls.hellos() >= 1, 'bonjour: a tls=1 record is confirmed with hello OVER TLS, and shown speaking TLS at its TLS port', JSON.stringify(tlsRow))
  assert(!everShown.includes('Plain Says TLS') && plainSaysTls.hellos() === 0, 'bonjour: a tls=1 record whose port speaks plain HTTP is not shown, and is never asked in plain (no downgrade)', JSON.stringify({ everShown, plainHellos: plainSaysTls.hellos() }))
  assert(!everShown.includes('TLS Lies'), 'bonjour: a tls=1 record whose hello names a key it did not present is not shown', JSON.stringify(everShown))
  assert(livePlain.hellos() === 1 && liveTls.hellos() === 1, 'bonjour: each record is asked once, not again on every chunk of the stream', JSON.stringify({ plain: livePlain.hellos(), tls: liveTls.hellos() }))
  assert(names.includes('Asked Late'), "bonjour: a record seen just before the search window closes, whose hello answers slowly, is in the search's last word", JSON.stringify({ names, lateHellos: late.hellos() }))

  const engine = new DiscoveryEngine({ env, processEnv: {}, platform: 'darwin' })
  const typedTls = await engine.probeAddress({ host: '127.0.0.1', port: liveTls.port })
  assert(typedTls.ok === true && typedTls.computer.tls === true && typedTls.computer.name === 'Asked TLS', 'typed: an address that speaks TLS is confirmed over TLS (plain HTTP is refused there)', JSON.stringify(typedTls))
  const typedLies = await engine.probeAddress({ host: '127.0.0.1', port: tlsLies.port })
  assert(!typedLies.ok, 'typed: one whose hello names a key it did not present is refused', JSON.stringify(typedLies))

  await Promise.all([livePlain, liveTls, plainSaysTls, tlsLies, late].map((s) => s.close()))

  // ── the review of PR 246 ──────────────────────────────────────────────────────────────────────────────────────────────────
  // Many records: 40 computers advertised, each a live server counting its hellos.
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => plainStub(hello(`Many ${i}`, (i + 0x1000).toString(16).padStart(16, '0'), false))))
  writeFileSync(join(dir, 'many'), HEADER + many.map((s, i) => record(`Many ${i}`, s.port, { v: '0.9.7', name: `Many ${i}`, agent: 'Prometheus', fp: (i + 0x1000).toString(16).padStart(16, '0'), pair: 'approve', tls: '0' })).join(''))
  const manyTool = join(dir, 'dns-sd-many')
  writeFileSync(manyTool, `#!/bin/sh\ncat '${join(dir, 'many')}'\nsleep 20\n`)
  chmodSync(manyTool, 0o755)
  const manyEnv = () => discoveryEnv({ BEACON_DISCOVERY_PORT: String(gone), BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_WINDOW_MS: '1500', BEACON_DISCOVERY_DNSSD: manyTool }, true)
  await collect(new DiscoveryEngine({ env: manyEnv, processEnv: {}, platform: 'darwin' }))
  const asked = many.reduce((n, s) => n + s.hellos(), 0)
  assert(MAX_HELLOS >= 8 && MAX_HELLOS <= 32 && asked === MAX_HELLOS, `bonjour: however many records are advertised, a search asks at most ${MAX_HELLOS} of them`, JSON.stringify({ asked, MAX_HELLOS }))
  await Promise.all(many.map((s) => s.close()))

  // A TLS server that never finishes: it answers, then drips a space every 400 ms, and ends only at 9 s.
  const drip = createHttpsServer({ key: A.key, cert: A.cert }, (_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' })
    const t = setInterval(() => s.write(' '), 400)
    setTimeout(() => (clearInterval(t), s.end(hello('Drip', A.pin.slice(0, 16), true))), 9000)
    s.on('close', () => clearInterval(t))
  })
  await new Promise<void>((r) => drip.listen(0, '127.0.0.1', r))
  const dripPort = (drip.address() as AddressInfo).port
  const t0 = Date.now()
  const typedDrip = await Promise.race([new DiscoveryEngine({ env, processEnv: {}, platform: 'darwin' }).probeAddress({ host: '127.0.0.1', port: dripPort }), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 6000))])
  const tookDrip = Date.now() - t0
  assert(typedDrip !== 'hung' && !typedDrip.ok && tookDrip < 4000, `typed: a TLS server dripping bytes cannot hold the hello: given up in ${tookDrip} ms`, JSON.stringify({ typedDrip, tookDrip }))
  writeFileSync(join(dir, 'drip'), HEADER + record('Drip', dripPort, { v: '0.9.7', name: 'Drip', agent: 'Prometheus', fp: A.pin.slice(0, 16), pair: 'approve', tls: '1' }))
  const dripTool = join(dir, 'dns-sd-drip')
  writeFileSync(dripTool, `#!/bin/sh\ncat '${join(dir, 'drip')}'\nsleep 20\n`)
  chmodSync(dripTool, 0o755)
  const dripEnv = () => discoveryEnv({ BEACON_DISCOVERY_PORT: String(gone), BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_WINDOW_MS: '1500', BEACON_DISCOVERY_DNSSD: dripTool }, true)
  const after: DiscoveryUpdate[] = []
  let doneAt = 0
  await new Promise<void>((resolve) => {
    new DiscoveryEngine({ env: dripEnv, processEnv: {}, platform: 'darwin' }).start({ quiet: false }, (u) => {
      if (doneAt) after.push(u)
      else if (u.done) doneAt = Date.now()
    })
    setTimeout(resolve, 11000)
  })
  assert(doneAt > 0 && after.length === 0, 'bonjour: nothing is said after the search\'s last word (a TLS hello still dripping is given up, not shown later)', JSON.stringify({ done: doneAt > 0, after: after.map((u) => u.computers.map((c) => c.name)) }))
  await new Promise<void>((r) => (drip.closeAllConnections(), drip.close(() => r())))

  // One fp, two ways of being seen on the home network: over TLS (its key proved it) and in plain (only claimed).
  const X = A.pin.slice(0, 16)
  const sighting = (host: string, port: number, name: string, tls: boolean, source: Sighting['source'] = 'bonjour'): Sighting => ({ source, endpoint: { host, port }, hello: { version: '0.9.7', name, agent: 'Prometheus', fp: X, pair: 'approve', tls } })
  const rows = mergeSightings([sighting('192.168.1.66', 8005, 'Impostor', false), sighting('192.168.1.20', 8006, "Alex's Mac mini", true)])
  const local = mergeSightings([sighting('127.0.0.1', 8005, 'This Mac', false, 'loopback'), sighting('192.168.1.20', 8006, "Alex's Mac mini", true)])
  assert(
    rows.length === 1 && rows[0].name === "Alex's Mac mini" && rows[0].tls && JSON.stringify(rows[0].endpoints) === JSON.stringify([{ host: '192.168.1.20', port: 8006 }]) &&
      local.length === 1 && local[0].where === 'this-mac' && local[0].endpoints.some((e) => e.host === '127.0.0.1'),
    "merge: a plain home-network record claiming a TLS-verified computer's fp does not name it or give it an address (this Mac's own loopback still does)",
    JSON.stringify({ rows, local })
  )
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50)
  })
