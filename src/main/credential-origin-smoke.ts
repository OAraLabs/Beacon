/**
 * Credential-origin smoke (docs/MULTI-PROMETHEUS.md §2 rule 2, §8): a key Beacon holds for one Prometheus is only ever sent to that
 * Prometheus. Headless (ELECTRON_RUN_AS_NODE): the real DaemonFolders, CredentialStore (with a fake cipher, the keychain being a
 * GUI-only thing) and RestClient, against two local HTTP servers that record every request they get.
 *
 *   npm run build && npm run smoke:credential-origin
 *
 *   1. keys per Prometheus: the key saved for A is not the key Beacon would use with B, at another address or behind A's own;
 *   2. redirects: A answering with a redirect to B sends B no request carrying A's key (nor, here, any request at all); a redirect
 *      within A still works, key and all;
 *   3. a Prometheus that moved address keeps its own key (its folder moves with it).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type Cipher } from './credentials'
import { DaemonFolders } from './cache/daemon-folders'
import { RestClient } from './connection/rest'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

/** Reversible and keychain-free: what goes through it is still a secret to this smoke, only not an encrypted one. */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(`sealed:${plain}`),
  decrypt: (blob) => blob.toString().replace(/^sealed:/, '')
}

interface Seen {
  path: string
  authorization: string | undefined
}

/** A stand-in Prometheus that records each request and answers with `answer`. */
async function server(answer: (req: IncomingMessage, self: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ base: string; seen: Seen[]; srv: Server }> {
  const seen: Seen[] = []
  let base = ''
  const srv = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
    const a = answer(req, base)
    res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) })
    res.end(a.body ?? '')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  return { base, seen, srv }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'beacon-credential-origin-'))
  const folders = new DaemonFolders(root)
  const servers: Server[] = []
  try {
    console.log('\n[smoke] === 1. keys per Prometheus ===')
    const A = folders.open({ apiBase: 'http://127.0.0.1:18501', fp: 'a'.repeat(16) })
    new CredentialStore(folders.keyPath(A.id), fakeCipher).setToken('KEY-FOR-A')
    const B = folders.open({ apiBase: 'http://127.0.0.1:18502', fp: 'b'.repeat(16) })
    const keyB = new CredentialStore(folders.keyPath(B.id), fakeCipher).getToken()
    assert(keyB === null, `B, at another address, has no key of its own yet (Beacon would send it ${JSON.stringify(keyB)})`)
    const C = folders.open({ apiBase: 'http://127.0.0.1:18501', fp: 'c'.repeat(16) })
    const keyC = new CredentialStore(folders.keyPath(C.id), fakeCipher).getToken()
    assert(keyC === null, `C, behind A's own address, has no key of its own yet (Beacon would send it ${JSON.stringify(keyC)})`)
    const keyA = new CredentialStore(folders.keyPath(folders.open({ apiBase: 'http://127.0.0.1:18501', fp: 'a'.repeat(16) }).id), fakeCipher).getToken()
    assert(keyA === 'KEY-FOR-A', `A still has its own key (got ${JSON.stringify(keyA)})`)

    console.log('\n[smoke] === 2. redirects ===')
    const b = await server(() => ({ status: 200, body: '[]' }))
    servers.push(b.srv)
    const a = await server((req, self) =>
      req.url === '/api/sessions'
        ? { status: 307, headers: { location: `${b.base}/api/sessions` } }
        : req.url === '/api/events/recent?limit=5'
          ? { status: 307, headers: { location: `${self}/api/events/recent/?limit=5` } }
          : { status: 200, body: '[]' }
    )
    servers.push(a.srv)
    let refused = false
    await new RestClient(a.base, 'KEY-FOR-A').listSessions().catch(() => (refused = true))
    assert(!b.seen.some((r) => r.authorization), `B got no request carrying A's key (B saw: ${JSON.stringify(b.seen)})`)
    assert(b.seen.length === 0, `B got no request at all: a redirect elsewhere is not followed (B saw ${b.seen.length})`)
    assert(refused, 'the redirect to another Prometheus fails the call, loudly')
    const same = await new RestClient(a.base, 'KEY-FOR-A').listRecentEvents(5).then(
      () => true,
      () => false
    )
    const hop = a.seen.find((r) => r.path === '/api/events/recent/?limit=5')
    assert(same && hop?.authorization === 'Bearer KEY-FOR-A', `a redirect within A is followed with A's key (ok=${same}, the hop had ${hop ? (hop.authorization ? 'the key' : 'no key') : 'no request'})`)

    console.log('\n[smoke] === 3. a Prometheus that moved keeps its key ===')
    const moved = folders.open({ apiBase: 'http://127.0.0.1:18501', fp: 'a'.repeat(16) })
    folders.moveAddress(moved.id, 'http://127.0.0.1:18599')
    const there = folders.open({ apiBase: 'http://127.0.0.1:18599', fp: null })
    assert(there.id === moved.id, `before hello, the new address opens A's folder (${there.id})`)
    assert(new CredentialStore(folders.keyPath(there.id), fakeCipher).getToken() === 'KEY-FOR-A', "and A's key with it")
  } finally {
    for (const s of servers) s.close()
    folders.close()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
