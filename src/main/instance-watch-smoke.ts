/**
 * Instance-watch smoke (docs/MULTI-PROMETHEUS.md §5, §7): every Prometheus Beacon keeps but isn't on is checked with its own key,
 * only after it has proved who it is, and its row says how it is doing and which AI it's on. Headless (ELECTRON_RUN_AS_NODE):
 * main's InstanceWatch with the real prover and requestSmall, against stand-in Prometheus that hold real Ed25519 node keys
 * (the PD-2 route, a stub until it lands) and record every request.
 *
 *   npm run build && npm run smoke:instance-watch
 */
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify as edVerify, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PinnedIdentity } from '@shared/identity-challenge'
import { InstanceWatch, type WatchTarget } from './instance-watch'
import { requestSmall } from './pairing/http'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

interface NodeKey {
  priv: KeyObject
  pub: string
}
function nodeKey(): NodeKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { priv: privateKey, pub: der.subarray(der.length - 32).toString('base64') }
}
const message = (nonce: string, id: string | null, pub: string, at: number): string =>
  ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${id ?? ''}`, `node_pub=${pub}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')
function verifyRaw(msg: string, sig: string, pub: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]), format: 'der', type: 'spki' })
    return edVerify(null, Buffer.from(msg), key, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}

interface StandIn {
  base: string
  seen: Array<{ path: string; auth: string | undefined }>
  srv: Server
}
/** A Prometheus: answers the challenge with `key` (or 404 without one), and /api/status to `token` only. */
async function standIn(key: NodeKey | null, instanceId: string, token: string): Promise<StandIn> {
  const seen: StandIn['seen'] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      const json = (status: number, v: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v))
      if (req.url === '/api/identity/challenge') {
        if (!key) return json(404, { detail: 'Not Found' })
        const nonce = (JSON.parse(body || '{}') as { nonce?: string }).nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        return json(200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64') })
      }
      if (req.url === '/api/status') {
        if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
        return json(200, { state: 'idle', provider: 'anthropic', model: 'claude-sonnet', instance_id: instanceId, node_pub: key?.pub ?? null })
      }
      json(404, {})
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, srv }
}

async function main(): Promise<void> {
  const K1 = nodeKey()
  const K2 = nodeKey()
  const K3 = nodeKey()
  const [I, J, L] = [randomUUID(), randomUUID(), randomUUID()]
  const good = await standIn(K1, I, 'KEY-GOOD') // proves with its pinned key; its key opens its status
  const other = await standIn(K2, J, 'KEY-OTHER') // something else answers where K1 is pinned
  const refused = await standIn(null, J, 'THE-REAL-ONE') // too old to be asked, and no longer takes this Beacon's key
  const first = await standIn(K3, L, 'KEY-FIRST') // nothing pinned yet, a good answer
  const plain = await standIn(K1, I, 'KEY-PLAIN') // an address Beacon may not use at all
  const gone = 'http://127.0.0.1:9' // nothing listens

  const t = (id: string, apiBase: string): WatchTarget => ({ id, apiBase, wsUrl: apiBase.replace('http', 'ws'), pin: null })
  const targets = [t('good', good.base), t('other', other.base), t('refused', refused.base), t('first', first.base), t('plain', plain.base), t('gone', gone)]
  const keys: Record<string, string> = { good: 'KEY-GOOD', other: 'KEY-FOR-THE-PINNED-ONE', refused: 'KEY-REFUSED', first: 'KEY-FIRST', plain: 'KEY-PLAIN', gone: 'KEY-GONE' }
  const pins: Record<string, PinnedIdentity | null> = { good: { instanceId: I, nodePub: K1.pub }, other: { instanceId: I, nodePub: K1.pub }, refused: null, first: null, plain: null, gone: { instanceId: I, nodePub: K1.pub } }
  let changes = 0
  const watch = new InstanceWatch({
    targets: () => targets,
    keyOf: (id) => keys[id] ?? null,
    pinsOf: (id) => pins[id] ?? null,
    pin: (id, p) => (pins[id] = p),
    requestFor: () => requestSmall,
    refusal: async (x) => (x.id === 'plain' ? 'plain to the internet' : null),
    verify: verifyRaw,
    now: () => Date.now(),
    onChange: () => changes++
  })
  try {
    await watch.checkAll()
    const h = (id: string): ReturnType<InstanceWatch['health']> => watch.health(id)

    console.log('\n[smoke] === proved with its pinned key ===')
    assert(h('good').state === 'connected', `connected (${h('good').state})`)
    assert(h('good').ai === 'Anthropic (Claude) · claude-sonnet', `and says which AI, in Beacon's words (${h('good').ai})`)
    assert(good.seen.some((r) => r.path === '/api/status' && r.auth === 'Bearer KEY-GOOD'), 'its status was read with its own key')

    console.log('\n[smoke] === something else answers where a key is pinned ===')
    assert(h('other').state === 'different', `"A different Prometheus answered" (${h('other').state})`)
    assert(!other.seen.some((r) => r.auth !== undefined), `and it was sent no key at all (${other.seen.filter((r) => r.auth).length} request(s) with one)`)

    console.log('\n[smoke] === an older Prometheus that no longer takes this Beacon ===')
    assert(h('refused').state === 'key-refused', `"No longer accepts this Beacon" (${h('refused').state})`)

    console.log('\n[smoke] === nothing pinned yet, a good answer ===')
    assert(h('first').state === 'connected' && pins.first?.nodePub === K3.pub, `connected, and its key is pinned now (${h('first').state})`)

    console.log('\n[smoke] === an address Beacon may not use ===')
    assert(h('plain').state === 'refused' && plain.seen.length === 0, `refused, and asked nothing at all (${h('plain').state}, ${plain.seen.length} request(s))`)

    console.log("\n[smoke] === can't be reached ===")
    assert(h('gone').state === 'unreachable' && typeof h('gone').since === 'number', `unreachable, since a time (${h('gone').state})`)

    assert(changes > 0, `the list was told it changed (${changes})`)
  } finally {
    watch.stop()
    for (const s of [good, other, refused, first, plain]) s.srv.close()
  }
  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
