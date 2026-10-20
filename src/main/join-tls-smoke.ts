/**
 * Joining a home-network Prometheus over TLS (docs/MULTI-COMPUTER-v0.4.md §3.2) — headless, under ELECTRON_RUN_AS_NODE. Written
 * before the code. A fake computer behind HTTPS with a real P-256 certificate whose key IS its instance key (as #721 makes it:
 * the certificate is made over the instance key), counting every TLS connection and request.
 *
 *   1. hello over TLS first, with no pin and no credential: Beacon learns the key it was shown;
 *   2. hello's fp must be that key's first 16 hex characters, or nothing more is sent at all;
 *   3. the request goes on a connection that must present the SAME key (a key swapped in between gets no request);
 *   4. the 201's instance_public_key must be that key, or the request is withdrawn and no code is shown (the code is computed
 *      over the instance key, so a code over another key would be a code over a key Beacon never met);
 *   5. the polls and the collection go on the pinned connection (a key swapped mid-wait gets no poll, and stops the join);
 *   6. approved: the profile is https:// and wss:// at the ports the computer named, WITH the pin; plain endpoints from a
 *      computer joined over TLS are refused, and nothing is saved or acknowledged;
 *   7. the card for all of it is said plainly.
 *
 * The approve answer is not this file's reading of the contract: the fake sends the one a REAL Prometheus sent over its TLS
 * listener (src/main/fixtures/pair_tls.json, scripts/record-pair-tls.mjs), with only the recording's ports changed to the fake's.
 * Three more checks read that recording directly: what Beacon takes from the TLS answer, what it does with the plain one, and that
 * the recording's certificate, hello and 201 are one key.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { execFileSync } from 'node:child_process'
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { joinActions, portsFromEndpoints } from '@shared/join'
import { COPY } from '@shared/onboarding-strings'
import { requestWith } from './pairing/http'
import { JoinSession, type JoinDeps, type JoinTarget, type SavedConnection } from './pairing/session'
import { matchCode, privateKeyFromRaw, sealKey, sharedSecret, type Sealed } from './pairing/seal'
import { askHelloOverTls, pinnedFetch } from './tls-pin'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[join-tls-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 15
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[join-tls-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[join-tls-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[join-tls-smoke] OK — ${checks} checks passed`)
})

const dir = mkdtempSync(join(tmpdir(), 'join-tls-smoke-'))
interface Cert {
  key: string
  cert: string
  spkiDer: Buffer
  pin: string
}
function cert(name: string): Cert {
  const k = join(dir, `${name}.key`)
  const c = join(dir, `${name}.crt`)
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', k], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '3', '-subj', `/CN=prometheus-${name}.local`], { stdio: 'ignore' })
  const pem = readFileSync(c, 'utf8')
  const spkiDer = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return { key: readFileSync(k, 'utf8'), cert: pem, spkiDer, pin: createHash('sha256').update(spkiDer).digest('hex') }
}
const A = cert('a')
const B = cert('b')
const WS_PORT = 18011

interface Recorded {
  ports: { plain: number; ws: number; tls: number; tls_ws: number }
  pin: string
  fp: string
  exchanges: Array<{ name: string; listener: 'tls' | 'plain'; response: { status: number; body: Record<string, unknown> | null; pinned?: boolean } }>
}
const REC = JSON.parse(readFileSync('src/main/fixtures/pair_tls.json', 'utf8')) as Recorded
const recorded = (name: string): Record<string, unknown> => {
  const e = REC.exchanges.find((x) => x.name === name)
  if (!e?.response.body) throw new Error(`pair_tls.json has no ${name}`)
  return e.response.body
}
/** The real approved answer over TLS, its ports moved onto the fake's: the TLS REST port to `apiPort`, the TLS WebSocket port to
 *  WS_PORT. Nothing else in it is changed, so a plain address in the recording stays plain here. */
function realApproved(apiPort: number, pin: string): { endpoints: unknown; tls: unknown } {
  const body = recorded('poll_approved_tls')
  const move = (v: unknown): unknown => (typeof v === 'string' ? v.replace(`:${REC.ports.tls_ws}`, `:${WS_PORT}`).replace(`:${REC.ports.tls}`, `:${apiPort}`) : v)
  const e = body.endpoints as Record<string, unknown> | null
  const t = body.tls as Record<string, unknown> | null
  // The daemon's own pin in its answer (Prometheus #745) is the recording's key: moved to the fake's, like the ports.
  const tls = t && typeof t === 'object' ? { ...t, spki_sha256: t.spki_sha256 === REC.pin ? pin : t.spki_sha256 } : t
  return { endpoints: e && typeof e === 'object' ? { rest: move(e.rest), ws: move(e.ws) } : e, tls }
}

function sealTo(recipientPublicRaw: Buffer, plaintext: string, requestId: string): Sealed {
  const ephemeralPrivateRaw = randomBytes(32)
  const nonce = randomBytes(12)
  const ePriv = privateKeyFromRaw(ephemeralPrivateRaw)
  const raw = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), ephemeralPrivateRaw]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
  const k = sealKey(sharedSecret(ePriv, recipientPublicRaw), requestId)
  const body = Buffer.from(chacha20poly1305(k, nonce, Buffer.from(requestId, 'ascii')).encrypt(Buffer.from(plaintext, 'utf8')))
  return { alg: 'x25519-hkdf-sha256-chacha20poly1305', ephemeral_public_key: raw.toString('base64url'), nonce: nonce.toString('base64url'), ciphertext: body.toString('base64url') }
}

interface Mode {
  helloFp?: string
  /** The instance key the 201 names (default: the certificate's). */
  instanceDer?: Buffer
  /** Present B's certificate from the first request after the hello / after the 201. */
  swapAfterHello?: boolean
  swapAfterCreate?: boolean
  endpoints?: { rest: string; ws: string }
  /** The approved answer's own `tls` block (default: the recording's, its pin moved to the fake's key). */
  tlsBlock?: unknown
}
interface Fake {
  port: number
  seen: string[]
  mode: Mode
  approve: () => void
  status: () => string
  close: () => Promise<void>
}
async function fakeComputer(mode: Mode = {}): Promise<Fake> {
  const id = randomBytes(16).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  const seen: string[] = []
  let status = 'none'
  let devicePublic: Buffer | null = null
  let sealed: Sealed | null = null
  let port = 0
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify(body))
  }
  const server: Server = createServer({ key: A.key, cert: A.cert }, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? ''
      seen.push(`${req.method} ${url.replace(id, '{id}')}${req.headers.authorization ? ' AUTH' : ''}`)
      if (req.method === 'GET' && url === '/api/hello') {
        if (mode.swapAfterHello) server.setSecureContext({ key: B.key, cert: B.cert })
        return json(res, 200, { v: '0.9.7', name: "Alex's Mac mini", agent: 'Prometheus', fp: mode.helloFp ?? A.pin.slice(0, 16), pair: 'approve', tls: true })
      }
      if (req.method === 'POST' && url === '/api/pair/requests') {
        const b = JSON.parse(body) as { public_key: string }
        devicePublic = Buffer.from(b.public_key, 'base64url')
        status = 'pending'
        const der = mode.instanceDer ?? A.spkiDer
        if (mode.swapAfterCreate) server.setSecureContext({ key: B.key, cert: B.cert })
        return json(res, 201, { request_id: id, poll_secret: secret, match_code: matchCode(devicePublic, der, id), instance_public_key: der.toString('base64url'), expires_at: 1760000300, ttl_seconds: 300, poll_interval_seconds: 2, notified: true })
      }
      const m = /^\/api\/pair\/requests\/([0-9a-f]{32})$/.exec(url)
      if (m && m[1] === id && req.headers['x-pairing-secret'] === secret) {
        if (req.method === 'DELETE') {
          status = status === 'approved' ? 'delivered' : 'canceled'
          res.writeHead(204, { connection: 'close' })
          return res.end()
        }
        if (status === 'approved' && sealed) return json(res, 200, { status: 'approved', device_id: 'd'.repeat(32), sealed, ...(mode.endpoints ? { endpoints: mode.endpoints, tls: null } : realApproved(port, A.pin)), ...(mode.tlsBlock !== undefined ? { tls: mode.tlsBlock } : {}), approved_at: 1760000042 })
        return json(res, 200, { status, expires_at: 1760000300 })
      }
      json(res, 404, { detail: 'Not Found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return {
    port,
    seen,
    mode,
    approve: () => {
      if (!devicePublic) return // nothing was asked: nothing to approve
      sealed = sealTo(devicePublic, JSON.stringify({ token: 'tok-' + randomBytes(24).toString('base64url'), device_id: 'd'.repeat(32), name: "Sam's MacBook" }), id)
      status = 'approved'
    },
    status: () => status,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())))
  }
}

let clock = 1_000_000
const target = (f: Fake, fp = ''): JoinTarget => ({ host: '127.0.0.1', apiPort: f.port, name: "Alex's Mac mini", fp, tls: true })
function session(): { s: JoinSession; saved: SavedConnection[] } {
  const saved: SavedConnection[] = []
  const deps: JoinDeps = {
    // The plain helper is never the one used for a TLS computer: a request through it fails the smoke loudly.
    request: async (r) => {
      throw new Error(`a plain request was made to a TLS computer: ${r.method} ${r.url}`)
    },
    helloOverTls: askHelloOverTls,
    pinnedRequest: (pin) => requestWith(pinnedFetch(pin)),
    now: () => clock,
    save: (c) => void saved.push(c),
    activate: () => undefined
  }
  return { s: new JoinSession(deps), saved }
}
const poll = async (s: JoinSession): Promise<string> => {
  clock += 1100
  const o = await s.poll()
  return o.state === 'failed' ? `failed:${o.failure.kind}` : o.state
}
const begin = async (s: JoinSession, f: Fake, fp = ''): Promise<string> => {
  try {
    const r = await s.begin(target(f, fp), "Sam's MacBook", 'macos')
    return r.ok ? `ok:${r.matchCode}` : r.failure.kind
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}

async function main(): Promise<void> {
  // ── the whole way, over TLS ─────────────────────────────────────────────────────────────────────────────────────────────
  const f1 = await fakeComputer()
  const a1 = session()
  const r1 = await begin(a1.s, f1)
  assert(r1.startsWith('ok:') && JSON.stringify(f1.seen.slice(0, 2)) === JSON.stringify(['GET /api/hello', 'POST /api/pair/requests']), "begin: hello over TLS first (no credential), then the request; the code is shown", JSON.stringify({ r1, seen: f1.seen }))
  f1.approve()
  const o1 = await poll(a1.s)
  const g = a1.saved[0]?.gateway
  assert(
    o1 === 'connected' && g?.apiBase === `https://127.0.0.1:${f1.port}` && g.wsUrl === `wss://127.0.0.1:${WS_PORT}` && g.pin === A.pin && /^tok-/.test(a1.saved[0].token) && a1.saved[0].fp === A.pin.slice(0, 16) && f1.status() === 'delivered',
    "approved (the real daemon's answer over TLS): the profile is https:// and wss:// at the ports the computer named, WITH the pin of the key Beacon met, and the computer is remembered by the fp it proved (a typed address had none); then acknowledged",
    JSON.stringify({ o1, g, status: f1.status() })
  )
  assert(f1.seen.length >= 4 && f1.seen.every((l) => !l.endsWith(' AUTH')), 'nothing in the join (hello, request, polls, acknowledgement) carried a credential', JSON.stringify(f1.seen))
  await f1.close()

  // ── it will not be talked into trusting another key ─────────────────────────────────────────────────────────────────────
  const f2 = await fakeComputer({ helloFp: B.pin.slice(0, 16) })
  const a2 = session()
  const r2 = await begin(a2.s, f2)
  assert(r2 === 'not-same-computer' && JSON.stringify(f2.seen) === JSON.stringify(['GET /api/hello']) && !a2.s.active(), "hello's fp is not the key it presented: nothing more is sent at all", JSON.stringify({ r2, seen: f2.seen }))
  await f2.close()
  const f2b = await fakeComputer()
  const a2b = session()
  const r2b = await begin(a2b.s, f2b, B.pin.slice(0, 16))
  assert(r2b === 'not-same-computer' && JSON.stringify(f2b.seen) === JSON.stringify(['GET /api/hello']), 'found with one fp (its announcement), answering hello with another: nothing more is sent', JSON.stringify({ r2b, seen: f2b.seen }))
  await f2b.close()
  const f3 = await fakeComputer({ swapAfterHello: true })
  const a3 = session()
  const r3 = await begin(a3.s, f3)
  assert(r3 === 'not-same-computer' && !f3.seen.some((l) => l.startsWith('POST')), 'another key between the hello and the request: the request never reaches it', JSON.stringify({ r3, seen: f3.seen }))
  await f3.close()
  const f4 = await fakeComputer({ instanceDer: B.spkiDer })
  const a4 = session()
  const r4 = await begin(a4.s, f4)
  assert(r4 === 'not-same-computer' && f4.seen.includes('DELETE /api/pair/requests/{id}') && f4.status() === 'canceled' && !a4.s.active(), "the 201 names an instance key that is not the certificate's: withdrawn, and no code shown", JSON.stringify({ r4, seen: f4.seen }))
  await f4.close()
  const f5 = await fakeComputer({ swapAfterCreate: true })
  const a5 = session()
  const r5 = await begin(a5.s, f5)
  const o5 = r5.startsWith('ok:') ? await poll(a5.s) : `begin:${r5}`
  assert(o5 === 'failed:not-same-computer' && !f5.seen.some((l) => l.startsWith('GET /api/pair/requests/')), 'another key while waiting: the poll never reaches it, and the join stops', JSON.stringify({ o5, seen: f5.seen }))
  await f5.close()
  const f6 = await fakeComputer()
  const a6 = session()
  const r6 = await begin(a6.s, f6)
  f6.mode.endpoints = { rest: `http://127.0.0.1:${f6.port}`, ws: `ws://127.0.0.1:${WS_PORT}` }
  f6.approve()
  const o6 = r6.startsWith('ok:') ? await poll(a6.s) : `begin:${r6}`
  assert(o6 === 'failed:unreadable' && a6.saved.length === 0 && f6.status() === 'approved', 'plain endpoints from a computer joined over TLS: refused, nothing saved, nothing acknowledged', JSON.stringify({ o6, saved: a6.saved.length, status: f6.status() }))
  await f6.close()
  const f7 = await fakeComputer()
  const a7 = session()
  const r7 = await begin(a7.s, f7)
  f7.mode.tlsBlock = { spki_sha256: B.pin }
  f7.approve()
  const o7 = r7.startsWith('ok:') ? await poll(a7.s) : `begin:${r7}`
  assert(o7 === 'failed:not-same-computer' && a7.saved.length === 0 && f7.status() === 'approved', "approved, but the answer's own pin (tls.spki_sha256, #745) is not the key Beacon met: refused, nothing saved, nothing acknowledged", JSON.stringify({ o7, saved: a7.saved.length, status: f7.status() }))
  await f7.close()

  // ── the recording itself (pair_tls.json) ──────────────────────────────────────────────────────────────────────────────
  const overTls = portsFromEndpoints(recorded('poll_approved_tls').endpoints, REC.ports.tls, true)
  assert(
    overTls.ok && overTls.apiPort === REC.ports.tls && overTls.wsPort === REC.ports.tls_ws && !overTls.guessed,
    "the real daemon's approve answer over TLS names its TLS listeners (REST and WebSocket), and Beacon reads both",
    JSON.stringify({ read: overTls, endpoints: recorded('poll_approved_tls').endpoints, ports: REC.ports })
  )
  const plainForTls = portsFromEndpoints(recorded('poll_approved_plain').endpoints, REC.ports.plain, true)
  const plainForPlain = portsFromEndpoints(recorded('poll_approved_plain').endpoints, REC.ports.plain, false)
  assert(
    !plainForTls.ok && plainForTls.kind === 'unreadable' && plainForPlain.ok && plainForPlain.apiPort === REC.ports.plain && plainForPlain.wsPort === REC.ports.ws,
    "its answer over plain HTTP: refused for a join made over TLS, and read as its plain listeners for a plain join",
    JSON.stringify({ plainForTls, plainForPlain, endpoints: recorded('poll_approved_plain').endpoints, ports: REC.ports })
  )
  const der = Buffer.from(String(recorded('create_tls').instance_public_key), 'base64url')
  const tlsAnswers = REC.exchanges.filter((e) => e.listener === 'tls')
  assert(
    /^[0-9a-f]{64}$/.test(REC.pin) && createHash('sha256').update(der).digest('hex') === REC.pin && recorded('hello_tls').fp === REC.pin.slice(0, 16) && REC.fp === REC.pin.slice(0, 16) && tlsAnswers.length >= 4 && tlsAnswers.every((e) => e.response.pinned === true),
    "the recording is one key: the certificate on every TLS answer, the 201's instance key and hello's fp",
    JSON.stringify({ pin: REC.pin, fp: REC.fp, hello: recorded('hello_tls').fp, tlsAnswers: tlsAnswers.map((e) => [e.name, e.response.pinned]) })
  )

  const noPorts = portsFromEndpoints({ rest: 'https://mini.local', ws: 'wss://mini.local' }, 8006, true)
  assert(noPorts.ok && noPorts.apiPort === 443 && noPorts.wsPort === 443, 'an https:// or wss:// address without a port is port 443, not 80 (review of PR 244, F4)', JSON.stringify(noPorts))

  // ── what the person is told ────────────────────────────────────────────────────────────────────────────────────────────
  const card = (COPY.main.joinFailed as unknown as Record<string, { title: string; body: string } | undefined>)['not-same-computer']
  assert(card?.title === "Something on your network isn't the Prometheus it says it is" && /sent it nothing|before sending/.test(card.body) && JSON.stringify(joinActions('not-same-computer')) === '["try-again"]', 'the card: "Something on your network isn\'t the Prometheus it says it is", that nothing was sent, and Try again', JSON.stringify({ card, actions: joinActions('not-same-computer') }))
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(dir, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50)
  })
