// Add a Prometheus (the title bar's switcher, docs/MULTI-PROMETHEUS.md §6): who answers at an address is asked with no key, the typed
// key is tried, and only then is a new Prometheus kept, in a folder of its own. The one Beacon is on, and every other one it keeps, is
// never touched: not its record, not its key, not its pin. A real folder list in a temp dir, stand-in Prometheus with real Ed25519 keys.
//
//   npm run build && npm run smoke:add-instance
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCheckWords, wsFor, type AddCheck } from '@shared/add-instance'
import { addInstance, checkNewInstance, type AddDeps } from './add-instance'
import { DaemonFolders } from './cache/daemon-folders'
import { verifyEd25519 } from './identity'
import { requestSmall } from './pairing/http'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!cond) failures++
}

interface NodeKey {
  pub: string
  priv: ReturnType<typeof generateKeyPairSync>['privateKey']
}
function nodeKey(): NodeKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'), priv: privateKey }
}
const message = (nonce: string, id: string | null, pub: string, at: number): string =>
  ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${id ?? ''}`, `node_pub=${pub}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')

interface StandIn {
  base: string
  seen: Array<{ path: string; auth: string | undefined }>
  srv: Server
}
/** A Prometheus: hello with `fp` and `name`, the challenge signed with `key` (404 without one), /api/status to `token` only. */
async function standIn(fp: string, name: string, key: NodeKey | null, instanceId: string | null, token: string, provider = 'anthropic'): Promise<StandIn> {
  const seen: StandIn['seen'] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      const json = (status: number, v: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v))
      if (req.url === '/api/hello') return json(200, { v: '0.9.20', name, agent: 'Atlas', fp, pair: 'approve', tls: false })
      if (req.url === '/api/identity/challenge') {
        if (!key) return json(404, { detail: 'Not Found' })
        const nonce = (JSON.parse(body || '{}') as { nonce?: string }).nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        return json(200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64') })
      }
      if (req.url === '/api/status') {
        if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
        return json(200, { state: 'idle', provider, model: 'stub-model' })
      }
      json(404, {})
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, srv }
}

async function main(): Promise<void> {
  console.log('\n[smoke] === the socket address, from the address ===')
  assert(wsFor('http://localhost:8005') === 'ws://localhost:8010', 'http://…:8005 → ws://…:8010')
  assert(wsFor('http://192.0.2.7:8005/') === 'ws://192.0.2.7:8010', 'a trailing slash is fine')
  assert(wsFor('http://localhost:9000') === null && wsFor('not a url') === null, 'other ports: typed by hand, never guessed')

  const [K1, K2] = [nodeKey(), nodeKey()]
  const [I1, I2] = [randomUUID(), randomUUID()]
  const mini = await standIn('a'.repeat(16), 'Mini', K1, I1, 'KEY-MINI')
  const local = await standIn('b'.repeat(16), 'Laptop', K2, I2, 'KEY-LOCAL', 'ollama')
  const older = await standIn('c'.repeat(16), 'Older', null, null, 'KEY-OLD')
  const gone = 'http://127.0.0.1:9'
  const ws = (base: string): string => base.replace('http://', 'ws://') // the stand-ins have no socket; the address is all Add keeps

  const root = mkdtempSync(join(tmpdir(), 'beacon-add-instance-'))
  const folders = new DaemonFolders(root)
  const keys = new Map<string, string>()
  try {
    // The mini: kept, active, its key and its pin.
    const miniId = folders.folderFor({ apiBase: mini.base, fp: 'a'.repeat(16) })
    folders.saveInstance({ name: 'mini', apiBase: mini.base, wsUrl: ws(mini.base), pin: null }, miniId)
    folders.setActive(miniId)
    folders.pinIdentity(miniId, { instanceId: I1, nodePub: K1.pub })
    keys.set(miniId, 'KEY-MINI')
    const miniBefore = JSON.stringify(folders.listInstances().find((i) => i.id === miniId))
    const count = (): number => folders.listInstances().length

    const deps: AddDeps = {
      request: requestSmall,
      refusal: async () => null,
      verify: verifyEd25519,
      nowS: () => Math.floor(Date.now() / 1000),
      kept: () => folders.listInstances(),
      folderForAdd: (apiBase, fp) => folders.folderForAdd(apiBase, fp),
      pinIdentity: (id, pin) => folders.pinIdentity(id, pin),
      setKey: (id, token) => keys.set(id, token),
      saveInstance: (gw, id) => folders.saveInstance(gw, id)
    }
    const req = (base: string, token: string, wsUrl = ws(base)) => ({ apiBase: base, wsUrl, token })

    console.log('\n[smoke] === a different Prometheus, its own key ===')
    const ok = await checkNewInstance(req(local.base, 'KEY-LOCAL'), deps)
    assert(ok.kind === 'ok' && ok.name === 'Laptop' && ok.proved === true && ok.ai === 'your own hardware · stub-model', 'Test: it answers, proves who it is, and the key works', ok)
    assert(!local.seen.some((r) => r.path !== '/api/status' && r.auth), 'who it is was asked with no key; only /api/status carried the typed one', local.seen)
    assert(!local.seen.some((r) => r.auth === 'Bearer KEY-MINI') && !mini.seen.some((r) => r.auth), "the mini's key went nowhere, and the mini was asked nothing")
    assert(count() === 1 && keys.size === 1, 'Test wrote nothing')

    const added = await addInstance(req(local.base, 'KEY-LOCAL'), deps)
    assert(added.added === true && added.id !== miniId, 'Add: kept, in a folder of its own', added)
    const newId = added.added ? added.id : ''
    const now = folders.listInstances()
    assert(now.length === 2 && now.find((i) => i.id === newId)?.active === true, 'two kept, the new one active (Beacon switches to it)', now.map((i) => [i.id, i.active]))
    assert(keys.get(newId) === 'KEY-LOCAL', 'the new one holds only the key typed for it')
    assert(folders.identityOf(newId)?.nodePub === K2.pub && folders.identityOf(newId)?.instanceId === I2, 'and its node key is pinned from the answer it gave')
    assert(JSON.stringify({ ...now.find((i) => i.id === miniId), active: false }) === JSON.stringify({ ...JSON.parse(miniBefore), active: false }), "the mini's record is exactly as it was", [miniBefore, now.find((i) => i.id === miniId)])
    assert(keys.get(miniId) === 'KEY-MINI' && folders.identityOf(miniId)?.nodePub === K1.pub && folders.identityOf(miniId)?.instanceId === I1, "the mini's key and pin are untouched")

    console.log('\n[smoke] === one Beacon already keeps ===')
    for (const [what, base] of [['the mini at its own address', mini.base], ['the mini by another name for the same computer', mini.base.replace('127.0.0.1', 'localhost')], ['the one just added', local.base]] as const) {
      const before = JSON.stringify(folders.listInstances())
      const c = await checkNewInstance(req(base, 'ANY-KEY'), deps)
      const a = await addInstance(req(base, 'ANY-KEY'), deps)
      assert(c.kind === 'kept' && !a.added && JSON.stringify(folders.listInstances()) === before, `${what}: "already kept", and nothing written`, c)
    }
    assert(keys.get(miniId) === 'KEY-MINI' && keys.get(newId) === 'KEY-LOCAL' && keys.size === 2, 'no key was replaced by any of those')
    assert(!mini.seen.some((r) => r.auth === 'Bearer ANY-KEY') && !local.seen.some((r) => r.auth === 'Bearer ANY-KEY'), "a key typed for one Beacon already keeps is never sent to it")

    console.log('\n[smoke] === refused, unreachable, wrong ===')
    const third = await standIn('d'.repeat(16), 'Third', nodeKey(), randomUUID(), 'KEY-THIRD')
    const wrong = await checkNewInstance(req(third.base, 'NOT-ITS-KEY'), deps)
    assert(wrong.kind === 'key-refused' && !(await addInstance(req(third.base, 'NOT-ITS-KEY'), deps)).added && count() === 2, 'a key it refuses: said so, nothing kept', wrong)
    const unreach = await checkNewInstance(req(gone, 'X'), deps)
    assert(unreach.kind === 'unreachable' && !(await addInstance(req(gone, 'X'), deps)).added && count() === 2, 'nothing answers: said so, nothing kept', unreach)
    for (const [what, r] of [
      ['no scheme', { apiBase: 'localhost:8005', wsUrl: 'ws://localhost:8010', token: 'X' }],
      ['an encrypted address (no pin to check it against here)', { apiBase: 'https://localhost:8006', wsUrl: 'wss://localhost:8011', token: 'X' }],
      ['a socket that is not ws://', { apiBase: third.base, wsUrl: third.base, token: 'X' }]
    ] as const) {
      const c = await checkNewInstance(r, deps)
      assert(c.kind === 'invalid' && !(await addInstance(r, deps)).added, `${what}: refused before anything is asked`, c)
    }
    const plain = await checkNewInstance(req(third.base, 'KEY-THIRD'), { ...deps, refusal: async () => 'plain to the internet' })
    assert(plain.kind === 'refused' && plain.message === 'plain to the internet', 'an address Beacon may not use: refused, in its own words', plain)

    console.log("\n[smoke] === an older Prometheus (can't prove who it is) ===")
    const old = await addInstance(req(older.base, 'KEY-OLD'), deps)
    assert(old.added === true && folders.identityOf(old.added ? old.id : '') === null && count() === 3, 'kept, with nothing pinned (as before the challenge existed)', old)

    console.log('\n[smoke] === the words ===')
    const kinds: AddCheck[] = [
      { kind: 'ok', name: 'Laptop', proved: true, ai: null, fp: null, pin: null },
      { kind: 'ok', name: 'Older', proved: false, ai: null, fp: null, pin: null },
      { kind: 'kept', id: 'x', label: 'mini' },
      { kind: 'invalid', message: 'Use an address like http://localhost:8005.' },
      { kind: 'refused', message: "Beacon won't use a plain address to the internet." },
      { kind: 'unreachable' },
      { kind: 'not-proved' },
      { kind: 'key-refused' }
    ]
    for (const k of kinds) assert(addCheckWords(k).text.length > 10, `${k.kind}: has its own words`, addCheckWords(k))
    assert(/mini/.test(addCheckWords(kinds[2]).text), 'already kept: names the one it is')
    assert(/can't prove who it is/i.test(addCheckWords(kinds[1]).text), "an older one: says it can't prove who it is")
    third.srv.close()
  } finally {
    folders.close()
    for (const s of [mini, local, older]) s.srv.close()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
