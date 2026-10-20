/**
 * Step-5 smoke (headless / ELECTRON_RUN_AS_NODE). Verifies the LOGIC layer CC can prove without a
 * display + OS keyring: credential-store round-trip (with an injected cipher — the real safeStorage
 * is a hands-on run), the first-run decision, that the bearer token is attached to REST (and
 * NOT to a tokenless request), and gateway-address parsing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, decideStartup, type Cipher } from './credentials'
import { RestClient } from './connection/rest'
import { gatewayFromAddress, gatewayFromEndpoint } from './connection/config'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// TEST-ONLY reversible cipher (XOR) — production is Electron safeStorage (OS keychain).
const testCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8')
}

async function main(): Promise<void> {
  // ── 1. credential store round-trip ──────────────────────────────────────────
  console.log('[smoke] === 1. credential store round-trip ===')
  const dir = mkdtempSync(join(tmpdir(), 'beacon-cred-'))
  const file = join(dir, 'api-credential.bin')
  const store = new CredentialStore(file, testCipher)
  assert(store.getToken() === null && !store.hasToken(), 'empty store → no token')
  store.setToken('tok-ABC123')
  assert(existsSync(file), 'token persisted to disk')
  assert(!readFileSync(file).toString('utf8').includes('tok-ABC123'), 'on-disk blob is ciphertext, not plaintext')
  assert(store.getToken() === 'tok-ABC123' && store.hasToken(), 'round-trip: get() === set()')
  store.setToken('') // blank clears
  assert(store.getToken() === null && !existsSync(file), 'blank token clears the store')
  rmSync(dir, { recursive: true, force: true })

  // ── 2. first-run decision (pure) ────────────────────────────────────────────
  console.log('\n[smoke] === 2. decideStartup ===')
  assert(decideStartup({ hasStoredGateway: false, hasEnvGateway: false }) === 'setup', 'no profile + no env → setup')
  assert(decideStartup({ hasStoredGateway: true, hasEnvGateway: false }) === 'connect', 'stored profile → connect')
  assert(decideStartup({ hasStoredGateway: false, hasEnvGateway: true }) === 'connect', 'env override → connect')

  // ── 3. bearer token attached to REST (and omitted when tokenless) ───────────
  console.log('\n[smoke] === 3. bearer token on REST ===')
  const origFetch = globalThis.fetch
  let captured: Record<string, string> = {}
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    captured = init?.headers ?? {}
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  await new RestClient('http://gw', 'tok-XYZ').listSessions()
  assert(captured.Authorization === 'Bearer tok-XYZ', `Authorization: Bearer attached (got ${captured.Authorization})`)
  captured = {}
  await new RestClient('http://gw', null).listSessions()
  assert(!('Authorization' in captured), 'no token → no Authorization header (no-auth mode)')
  globalThis.fetch = origFetch

  // ── 4. gateway address parsing (no IP ever in source) ───────────────────────
  console.log('\n[smoke] === 4. gatewayFromAddress ===')
  const g1 = gatewayFromAddress('192.0.2.10') // RFC 5737 TEST-NET (not a real/Tailscale IP)
  assert(g1.apiBase === 'http://192.0.2.10:8005' && g1.wsUrl === 'ws://192.0.2.10:8010', 'bare IP → http :8005 / ws :8010')
  const exampleHost = 'my-mini.tailnet.ts.net' // precommit:allow-example-host — sanctioned tailnet example
  const g2 = gatewayFromAddress(`http://${exampleHost}:9999/foo`)
  assert(
    g2.apiBase === `http://${exampleHost}:8005` && g2.wsUrl === `ws://${exampleHost}:8010`,
    'strips scheme/port/path → host + fixed ports'
  )

  // ── 4b. an endpoint with its own ports ──────────────────────────────────────
  console.log('\n[smoke] === 4b. gatewayFromEndpoint ===')
  const e1 = gatewayFromEndpoint('192.0.2.10', { apiPort: 51931, wsPort: 51932 })
  assert(e1?.apiBase === 'http://192.0.2.10:51931' && e1.wsUrl === 'ws://192.0.2.10:51932', 'endpoint: the ports it was found on are the ports used, not 8005/8010')
  assert(JSON.stringify(gatewayFromEndpoint('192.0.2.10')) === JSON.stringify(gatewayFromAddress('192.0.2.10')), 'endpoint: with no ports it is exactly gatewayFromAddress')
  assert(gatewayFromEndpoint(`http://${exampleHost}:9999/foo`, { apiPort: 8123, wsPort: 8124 })?.apiBase === `http://${exampleHost}:8123`, 'endpoint: the host is cleaned as gatewayFromAddress cleans it (scheme, path, a typed port in the address)')
  assert(gatewayFromEndpoint('::1', { apiPort: 8123, wsPort: 8124 })?.apiBase === 'http://[::1]:8123', 'endpoint: an IPv6 host is bracketed')
  const refused = [{ apiPort: 8123 }, { wsPort: 8124 }, { apiPort: 0, wsPort: 8124 }, { apiPort: 70000, wsPort: 8124 }, { apiPort: '8123', wsPort: 8124 }, { apiPort: 1.5, wsPort: 8124 }]
  assert(refused.every((p) => gatewayFromEndpoint('192.0.2.10', p) === null), 'endpoint: half a pair, or a port that is not a port, is refused, never repaired')
  assert(gatewayFromEndpoint('bad host!', { apiPort: 8123, wsPort: 8124 }) === null && gatewayFromEndpoint('a/b?c', { apiPort: 8123, wsPort: 8124 })?.apiBase === 'http://a:8123', 'endpoint: a host that is not a host is refused')

  // main really keeps the ports: setup:save builds its gateway from the request's ports (comments stripped, so a
  // comment quoting the call cannot satisfy this)
  const indexSrc = readFileSync('src/main/index.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  assert(/gatewayFromEndpoint\(address, \{ apiPort: req\.apiPort, wsPort: req\.wsPort \}\)/.test(indexSrc), 'endpoint: setup:save passes the request\'s ports to gatewayFromEndpoint (a build that dropped them would dial 8005)')

  console.log('\n[smoke] ===================== RESULT =====================')
  console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓ (cred round-trip, first-run decision, Bearer-on-REST, address parse)' : `FAIL ✗ (${failures})`}`)
  console.log('[smoke] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
