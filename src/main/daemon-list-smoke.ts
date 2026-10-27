/**
 * Daemon-list smoke (docs/MULTI-PROMETHEUS.md §6 Add, §4 Switching): Beacon keeps every Prometheus it has connected to, each with
 * its own address, socket, pin and facts, and adding one never forgets another. Headless (ELECTRON_RUN_AS_NODE): the real
 * DaemonFolders over a temp folder; no daemon.
 *
 *   npm run build && npm run smoke:daemon-list
 *
 *   1. adding: saving B after A keeps A, address, socket and pin intact, and makes B the active one;
 *   2. switching: making A active again gives A's own record back;
 *   3. facts per Prometheus: the kind of credential written for A (before A's folder is open) is A's, B's is B's;
 *   4. saving A again (re-joined) adds nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREDENTIAL_KIND_KEY } from '@shared/model-setup'
import { DaemonFolders } from './cache/daemon-folders'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const PIN_A = 'aa'.repeat(32)
const PIN_B = 'bb'.repeat(32)
// The name every way of connecting has always saved under: the reason a second save overwrote the first.
const A = { name: 'mini', apiBase: 'https://127.0.0.1:18701', wsUrl: 'wss://127.0.0.1:18702', pin: PIN_A }
const B = { name: 'mini', apiBase: 'https://127.0.0.1:18711', wsUrl: 'wss://127.0.0.1:18712', pin: PIN_B }

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'beacon-daemon-list-'))
  const folders = new DaemonFolders(root)
  try {
    console.log('\n[smoke] === 1. adding ===')
    const a = folders.saveInstance(A)
    folders.setSettingFor(a, CREDENTIAL_KIND_KEY, 'master')
    const b = folders.saveInstance(B)
    folders.setSettingFor(b, CREDENTIAL_KIND_KEY, '')
    const list = folders.listInstances()
    assert(list.length === 2, `both are kept (${list.length}: ${list.map((i) => i.apiBase).join(', ')})`)
    const keptA = list.find((i) => i.id === a)
    assert(keptA?.apiBase === A.apiBase && keptA.wsUrl === A.wsUrl && keptA.pin === PIN_A, "A's address, socket and pin are as they were")
    assert(folders.activeInstance()?.id === b, `B, saved last, is the active one (${folders.activeInstance()?.id})`)

    console.log('\n[smoke] === 2. switching ===')
    folders.setActive(a)
    const active = folders.activeInstance()
    assert(active?.id === a && active.gateway.apiBase === A.apiBase && active.gateway.pin === PIN_A, `A is active again, with its own record (${active?.gateway.apiBase})`)
    assert(list.filter((i) => i.active).length <= 1, 'one active at a time')

    console.log('\n[smoke] === 3. facts per Prometheus ===')
    folders.open({ apiBase: A.apiBase, fp: PIN_A.slice(0, 16) })
    assert(folders.getSetting(CREDENTIAL_KIND_KEY) === 'master', `with A open, the credential is A's kind (${folders.getSetting(CREDENTIAL_KIND_KEY)})`)
    folders.open({ apiBase: B.apiBase, fp: PIN_B.slice(0, 16) })
    assert(folders.getSetting(CREDENTIAL_KIND_KEY) === '', `with B open, B's (${folders.getSetting(CREDENTIAL_KIND_KEY)})`)

    // Written for A while B's folder is the open one (a save of A while connected to B): it must land in A's folder, not B's.
    folders.setSettingFor(a, CREDENTIAL_KIND_KEY, 'owner')
    assert(folders.getSetting(CREDENTIAL_KIND_KEY) === '', `B's own kind is untouched (${folders.getSetting(CREDENTIAL_KIND_KEY)})`)
    folders.open({ apiBase: A.apiBase, fp: PIN_A.slice(0, 16) })
    assert(folders.getSetting(CREDENTIAL_KIND_KEY) === 'owner', `and A's became 'owner' (${folders.getSetting(CREDENTIAL_KIND_KEY)})`)

    console.log('\n[smoke] === 4. saving the same Prometheus again ===')
    assert(folders.saveInstance(A) === a && folders.listInstances().length === 2, 'adds nothing, and keeps its folder')

    console.log('\n[smoke] === 5. a new address for the same Prometheus (Settings) ===')
    const moved = { ...A, apiBase: 'https://127.0.0.1:18799', wsUrl: 'wss://127.0.0.1:18798' }
    folders.moveAddress(a, moved.apiBase)
    folders.saveInstance(moved, a)
    const after = folders.listInstances()
    assert(after.length === 2 && after.find((i) => i.id === a)?.apiBase === moved.apiBase, `still two kept, A at its new address (${after.map((i) => i.apiBase).join(', ')})`)
  } finally {
    folders.close()
    rmSync(root, { recursive: true, force: true })
  }
  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
