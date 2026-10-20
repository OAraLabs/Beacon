/**
 * TLS pinning (docs/MULTI-COMPUTER-v0.4.md §3) — headless, under ELECTRON_RUN_AS_NODE. Written before the code, against
 * Prometheus #700's design for pairing PR 5 (docs/PAIRING-APPROVAL-API.md §7.3: a self-signed certificate over the instance key;
 * the pin is SHA-256 of the SPKI DER, all 32 bytes; hello's fp is its first 16 hex characters).
 *
 * Against REAL certificates: two self-signed P-256 certificates made by openssl, served by a local HTTPS server and a WSS
 * server on 127.0.0.1, which record every request and every upgrade they see. Pins:
 *   - the pin is SHA-256 of the SPKI DER, as Node's own X509Certificate computes it independently;
 *   - a right pin connects (REST and WebSocket), names and the self-signed issuer ignored;
 *   - a wrong pin is refused BEFORE THE SERVER SEES A REQUEST: no Authorization header ever reaches the wrong key;
 *   - a pinned connection never goes to http://;
 *   - discovery asks hello over TLS (it carries no credential) and reports the key it met;
 *   - first contact (§3.2): hello's fp must be the pin's first 16 hex characters, and the request answer's
 *     instance_public_key must be the key, each refusing on its own.
 *
 * And against PROMETHEUS'S OWN certificate (src/main/fixtures/tls_instance_721.json, scripts/record-tls-instance.mjs: made by
 * #721's code over its instance key, served by its own server context): Beacon's pin of it is the daemon's own pin
 * (instance_spki_sha256, what GET /api/network reports), and the daemon's fp and instance_public_key pass first contact.
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { askHelloOverTls, checkFirstContact, localLookupWith, openPinnedWebSocket, pinnedFetch, spkiSha256 } from './tls-pin'
import real from './fixtures/tls_instance_721.json'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[tls-pin-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 17
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[tls-pin-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[tls-pin-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[tls-pin-smoke] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'tls-pin-smoke-'))
/** A self-signed P-256 certificate, the shape pairing PR 5 is to serve (the name is deliberately not 127.0.0.1). */
function cert(name: string): { key: string; cert: string; der: Buffer; spkiDer: Buffer } {
  const k = join(dir, `${name}.key`)
  const c = join(dir, `${name}.crt`)
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '3', '-subj', `/CN=prometheus-${name}.local`], { stdio: 'ignore' })
  const pem = readFileSync(c, 'utf8')
  const x = new X509Certificate(pem)
  return { key: readFileSync(k, 'utf8'), cert: pem, der: x.raw, spkiDer: x.publicKey.export({ type: 'spki', format: 'der' }) as Buffer }
}
const A = cert('a')
const B = cert('b')
const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const PIN_A = hex(A.spkiDer)
const PIN_B = hex(B.spkiDer)

interface Seen {
  requests: { method: string; path: string; auth: boolean }[]
  upgrades: number
  tcp: number
}
async function tlsServer(c: { key: string; cert: string }): Promise<{ port: number; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = { requests: [], upgrades: 0, tcp: 0 }
  const server: Server = createHttpsServer({ key: c.key, cert: c.cert }, (req, res) => {
    seen.requests.push({ method: req.method ?? '', path: req.url ?? '', auth: 'authorization' in req.headers })
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ v: '0.9.7', name: "Alex's Mac mini", agent: 'Prometheus', fp: PIN_A.slice(0, 16), pair: 'approve', tls: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.on('connection', () => seen.tcp++)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades++
    wss.handleUpgrade(req, socket, head, (ws) => ws.send('hi'))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, seen, close: () =>
      new Promise<void>((r) => {
        // An upgraded socket is no longer the HTTP server's to close: end them here, or a WebSocket that should never have opened
        // keeps the server (and the smoke) alive instead of failing it.
        for (const c of wss.clients) c.terminate()
        wss.close()
        server.closeAllConnections()
        server.close(() => r())
      }) }
}
const settle = <T>(p: Promise<T>, ms: number): Promise<T | 'hung'> => Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])
const outcome = async <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: string }> => {
  try {
    return { ok: true, v: await p }
  } catch (e) {
    return { ok: false, e: String((e as Error)?.message ?? e) }
  }
}

async function main(): Promise<void> {
  // ── the pin ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  assert(spkiSha256(A.der) === PIN_A && /^[0-9a-f]{64}$/.test(PIN_A) && PIN_A !== PIN_B, 'pin: SHA-256 of the certificate\'s SPKI DER, all 32 bytes, as Node\'s X509Certificate computes it independently', spkiSha256(A.der))

  // ── REST ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const s = await tlsServer(A)
  const url = `https://127.0.0.1:${s.port}/api/status`
  const right = await outcome(settle(pinnedFetch(PIN_A)(url, { headers: { authorization: 'Bearer T' } }), 4000))
  assert(right.ok && right.v !== 'hung' && right.v.status === 200 && s.seen.requests.length === 1 && s.seen.requests[0].auth, 'rest: the right pin connects (a self-signed certificate whose name is not 127.0.0.1: names and issuer are ignored)', JSON.stringify(right.ok ? (right.v === 'hung' ? 'hung' : right.v.status) : right.e))
  const before = s.seen.requests.length
  const wrong = await outcome(settle(pinnedFetch(PIN_B)(url, { headers: { authorization: 'Bearer T' } }), 4000))
  assert(!wrong.ok && s.seen.requests.length === before, 'rest: a wrong pin is refused, and the server saw NO request: the credential never reached the wrong key', JSON.stringify({ wrong, seen: s.seen.requests.length - before }))
  const plain = createHttpServer((_req, res) => res.end('plain'))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  let plainHits = 0
  let plainTcp = 0
  plain.on('request', () => plainHits++)
  plain.on('connection', () => plainTcp++)
  const downgrade = await outcome(settle(pinnedFetch(PIN_A)(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/api/status`, { headers: { authorization: 'Bearer T' } }), 3000))
  assert(!downgrade.ok && plainHits === 0 && plainTcp === 0, 'rest: a pinned connection never goes to http:// (refused before a TCP connection: nothing is sent in the clear)', JSON.stringify({ downgrade, plainHits, plainTcp }))
  plain.close()

  // ── the WebSocket ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const wsRight = await outcome(settle(openPinnedWebSocket(`wss://127.0.0.1:${s.port}/`, PIN_A, { authorization: 'Bearer T' }), 4000))
  assert(wsRight.ok && wsRight.v !== 'hung' && s.seen.upgrades === 1, 'ws: the right pin opens the WebSocket', JSON.stringify({ ok: wsRight.ok, upgrades: s.seen.upgrades }))
  if (wsRight.ok && wsRight.v !== 'hung') wsRight.v.close()
  const tcpBefore = s.seen.tcp
  const malformed = (await outcome(settle(openPinnedWebSocket(`wss://127.0.0.1:${s.port}/`, PIN_A.toUpperCase()), 3000))).ok || (await outcome(settle((async () => pinnedFetch(PIN_A.toUpperCase())(url))(), 3000))).ok
  assert(!malformed && s.seen.tcp === tcpBefore, 'a pin that is not 64 lower-case hex is refused before any TCP connection (REST and WebSocket)', JSON.stringify({ malformed, tcp: s.seen.tcp - tcpBefore }))
  const upgradesBefore = s.seen.upgrades
  const wsWrong = await outcome(settle(openPinnedWebSocket(`wss://127.0.0.1:${s.port}/`, PIN_B, { authorization: 'Bearer T' }), 4000))
  assert(!wsWrong.ok && s.seen.upgrades === upgradesBefore, 'ws: a wrong pin is refused before the upgrade request is sent (the server saw no upgrade)', JSON.stringify({ wsWrong, upgrades: s.seen.upgrades - upgradesBefore }))

  // ── discovery: hello over TLS ───────────────────────────────────────────────────────────────────────────────────────────
  const h = await settle(askHelloOverTls('127.0.0.1', s.port), 4000)
  assert(h !== 'hung' && h.hello?.name === "Alex's Mac mini" && h.hello.tls === true && h.spkiHex === PIN_A, 'discovery: a tls=1 Prometheus is confirmed with hello OVER TLS, and the key it presented is reported', JSON.stringify(h))
  const helloReq = s.seen.requests.find((r) => r.path === '/api/hello')
  assert(!!helloReq && !helloReq.auth, 'discovery: hello over TLS carries no credential (it is asked before anything is pinned)', JSON.stringify(helloReq))
  await s.close()

  // ── first contact (§3.2) ────────────────────────────────────────────────────────────────────────────────────────────────
  const keyB64 = (der: Buffer): string => der.toString('base64url')
  assert(checkFirstContact({ spkiHex: PIN_A, helloFp: PIN_A.slice(0, 16), instancePublicKey: keyB64(A.spkiDer) }) === null, 'first contact: hello\'s fp is the pin\'s prefix and the request answer\'s key is the certificate\'s: accepted')
  assert(checkFirstContact({ spkiHex: PIN_A, helloFp: PIN_B.slice(0, 16), instancePublicKey: keyB64(A.spkiDer) }) !== null && checkFirstContact({ spkiHex: PIN_A, helloFp: '', instancePublicKey: keyB64(A.spkiDer) }) !== null, 'first contact: a hello fp that is not the key Beacon met (or none, which a TLS Prometheus always has) refuses')
  assert(checkFirstContact({ spkiHex: PIN_A, helloFp: PIN_A.slice(0, 16), instancePublicKey: keyB64(B.spkiDer) }) !== null && checkFirstContact({ spkiHex: PIN_A, helloFp: PIN_A.slice(0, 16), instancePublicKey: 'not-base64url!' }) !== null, 'first contact: a request answer naming another key (or no readable key) refuses on its own: the 4-digit code would be over a key Beacon never met')
  assert(checkFirstContact({ spkiHex: PIN_A.toUpperCase(), helloFp: PIN_A.slice(0, 16), instancePublicKey: keyB64(A.spkiDer) }) !== null, 'first contact: the pin is compared exactly (lower-case hex), not loosely')
  const none = checkFirstContact({ spkiHex: '', helloFp: '', instancePublicKey: keyB64(A.spkiDer) })
  assert(none === 'no readable key was presented', 'first contact: no key presented at all is said as that (Copy details), not as some other mismatch', String(none))

  // ── finding a .local computer: IPv4 first ───────────────────────────────────────────────────────────────────────────────
  // Measured on macOS 15 against a LocalOnly mDNS record: getaddrinfo with no family took 5,010 ms for an IPv4-only .local name
  // (waiting out the AAAA query); with family 4, 8 ms. #700 advertises IPv4 only, and hello over TLS gives up after 4 s.
  const asked: string[] = []
  const fakeDns = (answers: Record<string, string | null>) => (host: string, options: object, cb: (err: Error | null, address: unknown, family?: number) => void): void => {
    const fam = (options as { family?: number }).family ?? 0
    asked.push(`${host}/${fam}`)
    const a = answers[`${host}/${fam}`]
    setImmediate(() => (a ? cb(null, a, a.includes(':') ? 6 : 4) : cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), undefined)))
  }
  const got = (lk: ReturnType<typeof localLookupWith>, host: string): Promise<string> => new Promise((r) => lk(host, {}, (e, a) => r(e ? 'err' : String(a))))
  const lk = localLookupWith(fakeDns({ 'mini.local/4': '192.168.1.20', 'mini.local/0': 'fe80::1', 'v6only.local/0': 'fe80::2', 'example.com/0': '93.184.216.34' }))
  const r1 = await got(lk, 'mini.local')
  const r2 = await got(lk, 'v6only.local')
  const r3 = await got(lk, 'example.com')
  assert(
    r1 === '192.168.1.20' && r2 === 'fe80::2' && r3 === '93.184.216.34' && JSON.stringify(asked) === JSON.stringify(['mini.local/4', 'v6only.local/4', 'v6only.local/0', 'example.com/0']),
    'lookup: a .local name is asked for IPv4 first (5 s → 8 ms for an IPv4-only record), falls back to the usual lookup with no IPv4 answer, and any other name is untouched',
    JSON.stringify({ r1, r2, r3, asked })
  )

  // ── Prometheus's own certificate (recorded) ─────────────────────────────────────────────────────────────────────────────
  const realPin = spkiSha256(new X509Certificate(real.cert_pem).raw)
  assert(realPin === real.pin && real.fp === realPin.slice(0, 16) && real.handshake.presented_is_cert_pem, "Prometheus's own certificate: Beacon's pin of it is the daemon's own pin (instance_spki_sha256), and hello's fp is its prefix", JSON.stringify({ realPin, daemon: real.pin, fp: real.fp }))
  assert(checkFirstContact({ spkiHex: realPin, helloFp: real.fp, instancePublicKey: real.instance_public_key }) === null, "Prometheus's own fp and instance_public_key (unpadded base64url SPKI) pass first contact against the key its certificate carries", String(checkFirstContact({ spkiHex: realPin, helloFp: real.fp, instancePublicKey: real.instance_public_key })))
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50)
  })
