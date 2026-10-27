/**
 * Identity-challenge smoke (docs/MULTI-PROMETHEUS.md §2 rule 3, §8): no key goes out, on REST or the socket, until the Prometheus
 * at the address has signed Beacon's nonce with the node key pinned for it. Headless (ELECTRON_RUN_AS_NODE): the real
 * ConnectionManager, RestClient and GatewaySocket, with main's prover, against a stand-in Prometheus that holds a real Ed25519 key
 * and answers POST /api/identity/challenge as Prometheus is asked to (the stub for PD-2 until it lands), and a socket server that
 * records the first frame. The signed message is built HERE, from the spec, never by calling Beacon's builder.
 *
 *   npm run build && npm run smoke:identity-challenge
 *
 * Every case: does a request with the key reach the stand-in, does the socket get the auth frame, and does the challenge itself go
 * without the key (it always must).
 */
import { createHash, generateKeyPairSync, randomUUID, sign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { ConnectionManager } from './connection'
import { createProver, type PinnedIdentity } from './identity'
import { requestSmall } from './pairing/http'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface NodeKey {
  priv: KeyObject
  pub: string // base64 raw 32 bytes, as /api/status says node_pub
}
function nodeKey(): NodeKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { priv: privateKey, pub: der.subarray(der.length - 32).toString('base64') }
}

/** The signed message, exactly as docs/MULTI-PROMETHEUS.md §8 and the PD-2 ask write it. */
function message(nonce: string, instanceId: string | null, nodePub: string, tlsSpki: string | null, signedAt: number): string {
  return [
    'prometheus-identity-challenge/v1',
    `nonce=${nonce}`,
    `instance_id=${instanceId ?? ''}`,
    `node_pub=${nodePub}`,
    `tls_spki_sha256=${tlsSpki ?? ''}`,
    `signed_at=${signedAt}`,
    ''
  ].join('\n')
}

/** Ed25519 over the message with the raw public key, the way main checks it. */
function verifyRaw(msg: string, sigB64: string, pubB64: string): boolean {
  try {
    const raw = Buffer.from(pubB64, 'base64')
    if (raw.length !== 32) return false
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(msg), key, Buffer.from(sigB64, 'base64'))
  } catch {
    return false
  }
}

/** How the stand-in answers the challenge in one case. */
interface Behaviour {
  key: NodeKey | null // null: the route is not there (404, an older Prometheus)
  instanceId: string | null
  signedAtShift?: number // seconds off the true time
  replayNonce?: string // sign this nonce instead of the one asked (a recorded answer, replayed)
  corrupt?: boolean // flip the signature
}

interface Seen {
  path: string
  auth: string | undefined
}

async function standIn(b: Behaviour): Promise<{ base: string; seen: Seen[]; srv: Server }> {
  const seen: Seen[] = []
  const srv = createServer((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/api/identity/challenge' && req.method === 'POST') {
        if (!b.key) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"Not Found"}')
          return
        }
        const nonce = b.replayNonce ?? (JSON.parse(body || '{}') as { nonce?: string }).nonce ?? ''
        const signedAt = Math.floor(Date.now() / 1000) + (b.signedAtShift ?? 0)
        let sig = sign(null, Buffer.from(message(nonce, b.instanceId, b.key.pub, null, signedAt)), b.key.priv)
        if (b.corrupt) sig = Buffer.from(sig.map((x, i) => (i === 0 ? x ^ 1 : x)))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ v: 1, instance_id: b.instanceId, node_pub: b.key.pub, tls_spki_sha256: null, signed_at: signedAt, sig: sig.toString('base64') }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, srv }
}

/** One connection to the stand-in, with `pinned` kept for it: what reached it with the key, and whether the socket got the key. */
async function connectOnce(b: Behaviour, pinned: PinnedIdentity | null): Promise<{ restWithKey: number; wsAuth: boolean; challengeHadKey: boolean; asked: boolean }> {
  const http = await standIn(b)
  const frames: string[] = []
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (sock) => sock.on('message', (m) => frames.push(m.toString())))
  await new Promise<void>((r) => wss.on('listening', () => r()))
  const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  const prove = createProver({
    apiBase: http.base,
    request: requestSmall,
    pinned: () => pinned,
    tlsSpki: null,
    verify: verifyRaw,
    nowS: () => Math.floor(Date.now() / 1000)
  })
  const conn = new ConnectionManager({ name: 'smoke', apiBase: http.base, wsUrl }, 'THE-KEY', false, () => {}, undefined, Promise.resolve(null), prove)
  conn.start()
  await conn.listSessions().catch(() => null)
  await sleep(400)
  conn.stop()
  await new Promise<void>((r) => wss.close(() => r()))
  http.srv.close()
  const challenge = http.seen.filter((s) => s.path === '/api/identity/challenge')
  return {
    restWithKey: http.seen.filter((s) => s.auth === 'Bearer THE-KEY').length,
    wsAuth: frames.some((f) => f.includes('THE-KEY')),
    challengeHadKey: challenge.some((s) => s.auth !== undefined),
    asked: challenge.length > 0
  }
}

async function main(): Promise<void> {
  const K1 = nodeKey()
  const K2 = nodeKey()
  const I = randomUUID()
  const J = randomUUID()
  const pin: PinnedIdentity = { instanceId: I, nodePub: K1.pub }

  const cases: Array<{ label: string; b: Behaviour; pinned: PinnedIdentity | null; keyGoes: boolean }> = [
    { label: 'the pinned key signs: the key goes', b: { key: K1, instanceId: I }, pinned: pin, keyGoes: true },
    { label: 'another key, another instance_id (something else answers)', b: { key: K2, instanceId: J }, pinned: pin, keyGoes: false },
    { label: 'another key, the same instance_id (moved to new hardware, not confirmed yet)', b: { key: K2, instanceId: I }, pinned: pin, keyGoes: false },
    { label: 'the route is gone on a Prometheus pinned with a node key (no downgrade)', b: { key: null, instanceId: null }, pinned: pin, keyGoes: false },
    { label: 'a recorded answer, replayed (signed over another nonce)', b: { key: K1, instanceId: I, replayNonce: 'b2xkLW5vbmNl' }, pinned: pin, keyGoes: false },
    { label: 'an answer signed an hour ago', b: { key: K1, instanceId: I, signedAtShift: -3600 }, pinned: pin, keyGoes: false },
    { label: 'a signature that does not verify', b: { key: K1, instanceId: I, corrupt: true }, pinned: pin, keyGoes: false },
    { label: 'nothing pinned, the route not there (paired before it existed): the key goes, as before', b: { key: null, instanceId: null }, pinned: null, keyGoes: true },
    { label: 'nothing pinned, a good answer (pinned now, trust on first use)', b: { key: K1, instanceId: I }, pinned: null, keyGoes: true }
  ]
  for (const c of cases) {
    console.log(`\n[smoke] === ${c.label} ===`)
    const r = await connectOnce(c.b, c.pinned)
    assert(!r.challengeHadKey, 'the challenge itself carried no key')
    if (c.keyGoes) {
      assert(r.restWithKey > 0, `REST used the key (${r.restWithKey} request(s))`)
      assert(r.wsAuth, 'the socket got the auth frame')
    } else {
      assert(r.asked, 'Beacon asked the challenge before anything else')
      assert(r.restWithKey === 0, `no REST request carried the key (${r.restWithKey} did)`)
      assert(!r.wsAuth, 'the socket never got the key')
    }
  }
  // The signature check this smoke uses is itself checked: it accepts a real one and refuses a forged one.
  const probe = message('bm9uY2U=', I, K1.pub, null, 1)
  const good = sign(null, Buffer.from(probe), K1.priv).toString('base64')
  assert(verifyRaw(probe, good, K1.pub) && !verifyRaw(probe, good, K2.pub), "the smoke's own verifier tells K1's signature from K2's")
  assert(createHash('sha256').update(K1.pub).digest('hex') !== createHash('sha256').update(K2.pub).digest('hex'), 'K1 and K2 are different keys')

  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
