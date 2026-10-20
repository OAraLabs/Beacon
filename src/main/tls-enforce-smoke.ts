/**
 * TLS pinning, the connection's half (docs/MULTI-COMPUTER-v0.4.md §3.3) — headless, under ELECTRON_RUN_AS_NODE. Written before
 * the code. smoke:tls-pin proves the pin itself; this proves Beacon's ordinary traffic obeys it once a profile carries one:
 *
 *   - a profile: a TLS endpoint is https:// and wss:// and carries its pin; a pin that is not 64 lower-case hex is refused;
 *     the pin survives the cache (and a cache made before the column gains it on open, rows kept);
 *   - REST: Node's GLOBAL fetch (what rest.ts, requestSmall and every other caller use) reaches a pinned computer only when it
 *     presents the pin, a wrong key gets NO request, plain HTTP to that computer's Prometheus ports is refused before a TCP
 *     connection, and an unrelated service on the same host is untouched;
 *   - the WebSocket: the connection's socket goes through the pin, a wss:// URL with no pin applied is refused before a TCP
 *     connection (a credential is never offered over TLS that nothing checks), and ws:// on loopback is as before;
 *   - every caller: nothing in src/main makes its own `new WebSocket(` but tls-pin.ts, and the sockets to things that are not
 *     Prometheus, each named with its reason (OAra's VAD).
 *
 * Real P-256 certificates (openssl) and local servers that count every TCP connection, request and upgrade.
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { gatewayFromEndpoint } from './connection/config'
import { appliedPins, applyPins, installPinning, isConnectionMismatch, onPinMismatch, openGatewayWebSocket, routeFor } from './tls-pin'
import { mismatchCard } from '@shared/pin-mismatch'
import { pinnedEdit } from '@shared/pinned-edit'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[tls-enforce-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 20
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[tls-enforce-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[tls-enforce-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[tls-enforce-smoke] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'tls-enforce-smoke-'))
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

interface Counted {
  port: number
  tcp: () => number
  requests: () => number
  upgrades: () => number
  close: () => Promise<void>
}
/** A server that counts TCP connections, requests and WebSocket upgrades. */
async function counted(server: HttpServer): Promise<Counted> {
  let tcp = 0
  let requests = 0
  let upgrades = 0
  const sockets = new Set<Socket>()
  server.on('connection', (s: Socket) => {
    tcp++
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('request', (_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    upgrades++
    wss.handleUpgrade(req, socket, head, (ws) => ws.send('hi'))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    tcp: () => tcp,
    requests: () => requests,
    upgrades: () => upgrades,
    close: () =>
      new Promise<void>((r) => {
        wss.close()
        for (const s of sockets) s.destroy()
        server.close(() => r())
      })
  }
}
const settle = <T>(p: Promise<T>, ms: number): Promise<T | 'hung'> => Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])
const outcome = async <T>(f: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: string }> => {
  try {
    return { ok: true, v: await f() }
  } catch (e) {
    return { ok: false, e: String((e as Error)?.cause ?? (e as Error)?.message ?? e) }
  }
}
/** Open the connection's WebSocket and wait for it to open or fail (a refusal may be thrown at once). */
const wsOpens = (url: string): Promise<boolean> =>
  outcome(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const ws = openGatewayWebSocket(url)
        ws.once('open', () => (ws.close(), resolve(true)))
        ws.once('error', (e) => reject(e))
      })
  ).then((o) => o.ok && o.v === true)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  // ── the profile ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const tlsGw = gatewayFromEndpoint('192.168.1.20', { apiPort: 8006, wsPort: 8011 }, 'mini', { pin: A.pin })
  const badPin = gatewayFromEndpoint('192.168.1.20', { apiPort: 8006, wsPort: 8011 }, 'mini', { pin: A.pin.toUpperCase() })
  assert(
    tlsGw?.apiBase === 'https://192.168.1.20:8006' && tlsGw.wsUrl === 'wss://192.168.1.20:8011' && tlsGw.pin === A.pin && badPin === null,
    'profile: a TLS endpoint is https:// and wss:// and carries its pin; a pin that is not 64 lower-case hex is refused, not repaired',
    JSON.stringify({ tlsGw, badPin })
  )
  const plainGw = gatewayFromEndpoint('192.168.1.20', { apiPort: 8005, wsPort: 8010 })
  assert(plainGw?.apiBase === 'http://192.168.1.20:8005' && plainGw.wsUrl === 'ws://192.168.1.20:8010' && !plainGw.pin, 'profile: without TLS it is exactly as before (http://, ws://, no pin)', JSON.stringify(plainGw))
  const repo = new CacheRepo(openCache(join(dir, 'new.db')))
  repo.upsertGatewayProfile('mini', 'https://192.168.1.20:8006', 'wss://192.168.1.20:8011', true, A.pin)
  const saved = repo.getDefaultGatewayProfile()
  repo.upsertGatewayProfile('mini', 'http://127.0.0.1:8005', 'ws://127.0.0.1:8010', true)
  const plainSaved = repo.getDefaultGatewayProfile()
  assert(saved?.pin === A.pin && plainSaved?.pin === null, 'cache: the pin round-trips with the profile, and a profile saved without one has none', JSON.stringify({ saved, plainSaved }))
  // A cache made before the column existed: the old table, one row, then opened by today's code.
  const oldPath = join(dir, 'old.db')
  const old = new Database(oldPath)
  old.exec(`CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0)`)
  old.prepare(`INSERT INTO gateway_profiles VALUES ('mini', 'http://127.0.0.1:8005', 'ws://127.0.0.1:8010', 1)`).run()
  old.close()
  const migrated = new CacheRepo(openCache(oldPath))
  const kept = migrated.getDefaultGatewayProfile()
  let pinAfter: string | null | undefined
  try {
    migrated.upsertGatewayProfile('mini', 'https://192.168.1.20:8006', 'wss://192.168.1.20:8011', true, B.pin)
    pinAfter = migrated.getDefaultGatewayProfile()?.pin
  } catch (e) {
    pinAfter = `threw: ${(e as Error).message}`
  }
  assert(kept?.apiBase === 'http://127.0.0.1:8005' && kept.pin === null && pinAfter === B.pin, 'cache: a cache from before the pin gains the column on open, its row kept, and then holds a pin', JSON.stringify({ kept, pinAfter }))

  // ── REST: Node's global fetch, as every caller uses it ──────────────────────────────────────────────────────────────────
  installPinning()
  const tlsServer = await counted(createHttpsServer({ key: A.key, cert: A.cert }))
  const prometheusPlain = await counted(createHttpServer()) // stands for the pinned computer's plain Prometheus port
  const otherService = await counted(createHttpServer()) // something else on the same host (OAra, say)
  const profile = (pin: string): { apiBase: string; wsUrl: string; pin: string } => ({ apiBase: `https://127.0.0.1:${tlsServer.port}`, wsUrl: `wss://127.0.0.1:${prometheusPlain.port}`, pin })
  applyPins(profile(A.pin))
  const right = await outcome(() => settle(fetch(`https://127.0.0.1:${tlsServer.port}/api/status`, { headers: { authorization: 'Bearer T' } }), 4000))
  assert(right.ok && right.v !== 'hung' && right.v.status === 200 && tlsServer.requests() === 1, 'rest: with the pin applied, the global fetch reaches the pinned computer (its self-signed certificate accepted by key)', JSON.stringify(right.ok ? (right.v === 'hung' ? 'hung' : right.v.status) : right.e))
  applyPins(profile(B.pin))
  const before = tlsServer.requests()
  const wrong = await outcome(() => settle(fetch(`https://127.0.0.1:${tlsServer.port}/api/status`, { headers: { authorization: 'Bearer T' } }), 4000))
  assert(!wrong.ok && tlsServer.requests() === before, 'rest: a computer presenting another key gets NO request from the global fetch: the credential never reaches it', JSON.stringify({ wrong, requests: tlsServer.requests() - before }))
  applyPins(profile(A.pin))
  const tcpBefore = prometheusPlain.tcp()
  const plain = await outcome(() => settle(fetch(`http://127.0.0.1:${prometheusPlain.port}/api/status`, { headers: { authorization: 'Bearer T' } }), 3000))
  assert(!plain.ok && prometheusPlain.tcp() === tcpBefore, "rest: plain HTTP to the pinned computer's Prometheus ports is refused before a TCP connection", JSON.stringify({ plain, tcp: prometheusPlain.tcp() - tcpBefore }))
  applyPins({ apiBase: 'https://192.168.1.20:7006', wsUrl: 'wss://192.168.1.20:7011', pin: A.pin })
  const ports = appliedPins()
  assert(ports?.host === '192.168.1.20' && [7006, 7011, 8005, 8006, 8010, 8011].every((p) => ports.ports.includes(p)), "pins: the computer's profile ports AND Prometheus's own (8005/8010 plain, 8006/8011 TLS) are held, whatever ports the profile names", JSON.stringify(ports))
  applyPins(profile(A.pin))
  const other = await outcome(() => settle(fetch(`http://127.0.0.1:${otherService.port}/health`), 3000))
  assert(other.ok && other.v !== 'hung' && other.v.status === 200, 'rest: another service on the same host, on another port, is untouched', JSON.stringify(other.ok ? (other.v === 'hung' ? 'hung' : other.v.status) : other.e))

  // ── telling someone (§3.4) ──────────────────────────────────────────────────────────────────────────────────────────────
  const heard: { pinned: string; presented: string | null; port: number }[] = []
  const off = onPinMismatch((m) => heard.push({ pinned: m.pinned, presented: m.presented, port: m.port }))
  applyPins(profile(B.pin))
  await outcome(() => settle(fetch(`https://127.0.0.1:${tlsServer.port}/api/sessions`), 4000))
  const restHeard = heard.length
  applyPins({ apiBase: `https://127.0.0.1:${tlsServer.port}`, wsUrl: `wss://127.0.0.1:${tlsServer.port}`, pin: B.pin })
  await wsOpens(`wss://127.0.0.1:${tlsServer.port}/`)
  const wsHeard = heard.length - restHeard
  applyPins(profile(A.pin))
  await outcome(() => settle(fetch(`https://127.0.0.1:${tlsServer.port}/api/sessions`), 4000))
  off()
  assert(
    restHeard >= 1 && wsHeard >= 1 && heard.length === restHeard + wsHeard && heard.every((h) => h.pinned === B.pin && h.presented === A.pin && h.port === tlsServer.port),
    'a wrong key is reported — the pinned and the presented hashes — for REST from any caller and for the WebSocket; the right key reports nothing',
    JSON.stringify({ restHeard, wsHeard, heard: heard.map((h) => ({ ...h, pinned: h.pinned.slice(0, 8), presented: h.presented?.slice(0, 8) })) })
  )
  const card = mismatchCard({ state: 'reconnecting', gateway: '192.168.1.20:8006', wrongKey: { pinned: A.pin, presented: B.pin, name: "Alex's Mac mini" } })
  assert(
    card?.title === "This isn't the Prometheus you connected to" &&
      card.body === "Something on your network answered as Alex's Mac mini, but it isn't the same computer, so Beacon sent it nothing. If Prometheus was reinstalled there, connect to it again." &&
      card.details.includes(A.pin) && card.details.includes(B.pin) &&
      mismatchCard({ state: 'reconnecting', gateway: '192.168.1.20:8006' }) === null,
    'the card (§3.4): its title and body, Copy details carrying both hashes, and no card without a wrong key',
    JSON.stringify(card)
  )

  // ── Settings' Save on a pinned connection (review of PR 244, F1) ────────────────────────────────────────────────────────
  const keep = pinnedEdit(A.pin, 'https://mini.local:8006', 'wss://mini.local:8011')
  const moved = pinnedEdit(A.pin, 'https://192.168.1.21:8006', 'wss://192.168.1.21:8011')
  const plainRest = pinnedEdit(A.pin, 'http://mini.local:8005', 'wss://mini.local:8011')
  const plainWs = pinnedEdit(A.pin, 'https://mini.local:8006', 'ws://mini.local:8010')
  const junk = pinnedEdit(A.pin, 'mini.local:8006', 'wss://mini.local:8011')
  const unpinned = pinnedEdit(null, 'http://127.0.0.1:8005', 'ws://127.0.0.1:8010')
  assert(
    keep.ok && keep.pin === A.pin && moved.ok && moved.pin === A.pin && !plainRest.ok && !plainWs.ok && !junk.ok && /https:\/\//.test(plainRest.ok ? '' : plainRest.error) && unpinned.ok && unpinned.pin === null,
    "Settings' Save: a pinned connection keeps its pin (a new address included: the key decides), refuses http:// or ws:// (no way around the card), and an unpinned one is as before",
    JSON.stringify({ keep, moved, plainRest, plainWs, junk, unpinned })
  )
  applyPins({ apiBase: 'https://mini.local:8006', wsUrl: 'wss://mini.local:8011', pin: A.pin })
  const own = isConnectionMismatch({ pinned: A.pin, presented: B.pin, host: 'mini.local', port: 8006 })
  const joining = isConnectionMismatch({ pinned: B.pin, presented: A.pin, host: 'office.local', port: 8006 })
  applyPins(null)
  const none = isConnectionMismatch({ pinned: A.pin, presented: B.pin, host: 'mini.local', port: 8006 })
  assert(own && !joining && !none, "a refusal is the connection's card only when it was the connection's own pin (a join's pinned request to another computer is not)", JSON.stringify({ own, joining, none }))

  // ── a .local name, pinned or not ──────────────────────────────────────────────────────────────────────────────────────────
  applyPins({ apiBase: 'https://mini.local:8006', wsUrl: 'wss://mini.local:8011', pin: A.pin })
  const routes = [routeFor('https://mini.local:8006'), routeFor('http://mini.local:8005'), routeFor('http://office.local:8005'), routeFor('http://office.local.:8005'), routeFor('http://192.168.1.30:8005'), routeFor('https://example.com')]
  applyPins(null)
  assert(
    JSON.stringify(routes) === JSON.stringify(['pinned', 'refused', 'local', 'local', 'base', 'base']),
    'routes: the pinned computer by its key (and never in plain); any other .local name through the IPv4-first lookup (a plain join or a hello to a computer found by Bonjour); everything else as always',
    JSON.stringify(routes)
  )

  // ── the WebSocket ───────────────────────────────────────────────────────────────────────────────────────────────────────
  applyPins({ apiBase: `https://127.0.0.1:${tlsServer.port}`, wsUrl: `wss://127.0.0.1:${tlsServer.port}`, pin: A.pin })
  const wsRight = await wsOpens(`wss://127.0.0.1:${tlsServer.port}/`)
  assert(wsRight && tlsServer.upgrades() === 1, "ws: the connection's WebSocket opens to the computer presenting the applied pin", JSON.stringify({ wsRight, upgrades: tlsServer.upgrades() }))
  applyPins({ apiBase: `https://127.0.0.1:${tlsServer.port}`, wsUrl: `wss://127.0.0.1:${tlsServer.port}`, pin: B.pin })
  const upBefore = tlsServer.upgrades()
  const wsWrong = await wsOpens(`wss://127.0.0.1:${tlsServer.port}/`)
  assert(!wsWrong && tlsServer.upgrades() === upBefore, 'ws: another key is refused before the upgrade request', JSON.stringify({ wsWrong, upgrades: tlsServer.upgrades() - upBefore }))
  applyPins(null)
  const tcpWs = tlsServer.tcp()
  const wsNoPin = await wsOpens(`wss://127.0.0.1:${tlsServer.port}/`)
  await sleep(100)
  assert(!wsNoPin && tlsServer.tcp() === tcpWs, 'ws: a wss:// URL with no pin applied is refused before any TCP connection (a credential is never offered over TLS nothing checks)', JSON.stringify({ wsNoPin, tcp: tlsServer.tcp() - tcpWs }))
  applyPins(profile(A.pin)) // its wsUrl names prometheusPlain's port
  const tcpPlainWs = prometheusPlain.tcp()
  const wsToPinned = await wsOpens(`ws://127.0.0.1:${prometheusPlain.port}/`)
  await sleep(100)
  assert(!wsToPinned && prometheusPlain.tcp() === tcpPlainWs, "ws: plain ws:// to the pinned computer's Prometheus ports is refused before any TCP connection", JSON.stringify({ wsToPinned, tcp: prometheusPlain.tcp() - tcpPlainWs }))
  applyPins(null)
  const wsPlain = await wsOpens(`ws://127.0.0.1:${otherService.port}/`)
  assert(wsPlain, 'ws: ws:// with no pin (this Mac, loopback) opens as before', JSON.stringify({ wsPlain }))
  await Promise.all([tlsServer.close(), prometheusPlain.close(), otherService.close()])

  // ── every caller ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []))
  // A WebSocket to something that is not Prometheus, each with the reason. A new one fails here until someone says why.
  const NOT_PROMETHEUS: Record<string, string> = { 'src/main/vad-socket.ts': "hands-free's VAD socket: OAra's voice service, not Prometheus" }
  const makers = walk('src/main')
    .filter((f) => !/-smoke\.ts$|-invariant\.ts$/.test(f) && !f.endsWith('tls-pin.ts') && !(f in NOT_PROMETHEUS))
    .filter((f) => /\bnew WebSocket\s*\(/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')))
  const users = ['src/main/connection/ws.ts', 'src/main/connection/ws-probe.ts'].filter((f) => /\bopenGatewayWebSocket\(/.test(readFileSync(f, 'utf8')))
  assert(makers.length === 0 && users.length === 2, "every caller: nothing in src/main opens its own WebSocket but tls-pin.ts (and OAra's VAD socket, named); the connection and its test both use openGatewayWebSocket", JSON.stringify({ makers, users }))
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50)
  })
