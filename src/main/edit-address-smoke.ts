/**
 * Edit-address smoke (docs/MULTI-PROMETHEUS.md §6, Edit address): before Settings points the Prometheus Beacon is on at a new address,
 * Beacon asks who answers there, with no key. Headless (ELECTRON_RUN_AS_NODE): main's whoIsAt with the real prover, hello and
 * requestSmall, against stand-ins that hold real Ed25519 node keys (the PD-2 route, a stub until it lands) and answer hello.
 *
 *   npm run build && npm run smoke:edit-address
 *
 * And from main's source: a different Prometheus is saved nowhere and sent no key; "Add it" takes only a key typed for it.
 */
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify as edVerify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { PinnedIdentity } from '@shared/identity-challenge'
import { whoIsAt, type EditAddressDeps } from './edit-address'
import { askHello } from './discovery'
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
  keyed: number
  srv: Server
}
/** A Prometheus at an address: its node key (or none: the route is not there) and the fp its hello says (or none). */
async function standIn(key: NodeKey | null, instanceId: string, fp: string | null): Promise<StandIn> {
  const s: StandIn = { base: '', keyed: 0, srv: null as unknown as Server }
  s.srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.headers.authorization) s.keyed++
      const json = (status: number, v: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v))
      if (req.url === '/api/hello') return fp ? json(200, { v: '0.9.16', name: 'Stand-in', agent: 'Atlas', fp, pair: 'approve', tls: false }) : json(404, {})
      if (req.url === '/api/identity/challenge' && key) {
        const nonce = (JSON.parse(body || '{}') as { nonce?: string }).nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        return json(200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64') })
      }
      json(404, {})
    })
  })
  await new Promise<void>((r) => s.srv.listen(0, '127.0.0.1', r))
  s.base = `http://127.0.0.1:${(s.srv.address() as AddressInfo).port}`
  return s
}

async function main(): Promise<void> {
  const K1 = nodeKey()
  const K2 = nodeKey()
  const K3 = nodeKey()
  const [I, J, C] = [randomUUID(), randomUUID(), randomUUID()]
  const FA = 'a'.repeat(16)
  const FB = 'b'.repeat(16)
  const sameMoved = await standIn(K1, I, null) // the Prometheus Beacon is on, at its new address
  const other = await standIn(K2, J, FB) // another one
  const kept = await standIn(K3, C, null) // one Beacon already keeps as "Work box"
  const helloSame = await standIn(null, I, FA) // no node key anywhere: hello says the same fp
  const helloOther = await standIn(null, J, FB) // hello says another fp
  const silent = await standIn(null, J, null) // says nothing either way

  const deps = (pinned: PinnedIdentity | null, folderFp: string | null): EditAddressDeps => ({
    request: requestSmall,
    pinned,
    folderFp,
    hello: async (apiBase) => {
      const u = new URL(apiBase)
      const h = await askHello({ host: u.hostname, port: Number(u.port) })
      return typeof h === 'string' || !h.fp ? null : h.fp
    },
    keptWith: (q) => (q.nodePub === K3.pub ? { id: 'work-box', label: 'Work box' } : null),
    verify: verifyRaw,
    nowS: () => Math.floor(Date.now() / 1000)
  })
  const pinned: PinnedIdentity = { instanceId: I, nodePub: K1.pub }
  const all = [sameMoved, other, kept, helloSame, helloOther, silent]
  try {
    const cases: Array<[string, string, EditAddressDeps, string]> = [
      ['the same Prometheus at its new address (its pinned key signs)', sameMoved.base, deps(pinned, FA), 'same'],
      ['another Prometheus (another key)', other.base, deps(pinned, FA), 'different'],
      ['a Prometheus Beacon already keeps', kept.base, deps(pinned, FA), 'kept:Work box'],
      ['no node key pinned: hello says the same fp', helloSame.base, deps(null, FA), 'same'],
      ['no node key pinned: hello says another fp', helloOther.base, deps(null, FA), 'different'],
      ["no node key pinned, and the new address doesn't say: as before", silent.base, deps(null, FA), 'same'],
      ['nothing listens there: as before (the connection says it can’t reach it)', 'http://127.0.0.1:9', deps(pinned, FA), 'same']
    ]
    for (const [what, at, d, want] of cases) {
      const r = await whoIsAt(at, d)
      const got = r.kind === 'kept' ? `kept:${r.label}` : r.kind
      assert(got === want, `${what}: ${want} (got ${got})`)
    }
    assert(all.every((s) => s.keyed === 0), `no stand-in was sent a key while Beacon asked (${all.map((s) => s.keyed).join(',')})`)

    console.log("\n[smoke] === main's save path ===")
    const index = readFileSync(join(__dirname.replace(/out\/main.*$/, ''), 'src/main/index.ts'), 'utf8')
    const save = index.slice(index.indexOf('async function saveConnectionSettings('), index.indexOf('async function testConnection('))
    const asked = save.indexOf('whoIsAt(')
    assert(asked > 0, 'Settings asks who is at a new address before saving')
    assert(asked > 0 && asked < save.indexOf('saveInstance(') && asked < save.indexOf('moveAddress(') && asked < save.indexOf('bringUpConnection('), 'before it saves the address, moves the folder or connects')
    assert(!save.includes('upsertGatewayProfile('), "and it doesn't save through the old profile call, which filed a new address under a new folder")
    assert(/moveAddress\(open!, apiBase\)[\s\S]{0,200}saveInstance\(\{ name, apiBase, wsUrl, pin: edit\.pin \}, id\)/.test(save), 'the same Prometheus: its folder moves, then its record is saved onto that folder')
    const addIt = save.slice(save.indexOf('if (req.addAsNew && moving)'), save.indexOf('} else {', save.indexOf('if (req.addAsNew && moving)')))
    assert(addIt.length > 0 && /token = req\.token\?\.trim\(\) \|\| null/.test(addIt), '"Add it" keeps the new one with only a key typed for it')
    assert(addIt.length > 0 && !/keyFile\(open|nextToken\(|currentKey\(/.test(addIt), "and never with the key of the Prometheus Beacon was on")
  } finally {
    for (const s of all) s.srv.close()
  }
  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
