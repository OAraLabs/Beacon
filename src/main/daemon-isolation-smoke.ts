/**
 * Daemon-isolation smoke (docs/MULTI-PROMETHEUS.md §1): what Beacon keeps for one Prometheus never shows up for, or goes
 * to, another. Headless (ELECTRON_RUN_AS_NODE): the real DaemonFolders, CacheRepo and CacheService over a temp folder,
 * with fake connections that record every send.
 *
 *   npm run build && npm run smoke:daemon-isolation
 *
 * The three bugs, each re-pointing Beacon from Prometheus A to B the way Settings or Set up again does:
 *   1. conversations: B's list holds none of A's (B at another address, and B behind A's own address);
 *   2. queued messages: a message queued for A while A was down is not sent to B, and is still A's when A is back;
 *   3. notification actions: Approve/Deny on A's notification never goes out on B's link.
 * Plus per-conversation settings (a draft) that stay with their Prometheus, and a Beacon-wide one (the theme) that doesn't.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSendRequest, ChatSendResult, ConnectionStatus, SessionSummary } from '@shared/ipc'
import { approvalActionTarget } from '@shared/approval-push'
import { DRAFT_PREFIX } from '@shared/drafts'
import { THEME_KEY } from '@shared/theme'
import type { ConnectionManager } from './connection'
import { DaemonFolders, type DaemonIdentity } from './cache/daemon-folders'
import { CacheService } from './cache/service'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

/** A stand-in for one Prometheus's ConnectionManager: its own sessions, and a record of every send it was asked to make. */
class FakeConnection extends EventEmitter {
  readonly sent: ChatSendRequest[] = []
  constructor(
    readonly label: string,
    private readonly sessions: string[],
    private state: ConnectionStatus['state']
  ) {
    super()
  }
  getStatus(): ConnectionStatus {
    return { state: this.state, gateway: this.label }
  }
  setState(state: ConnectionStatus['state']): void {
    this.state = state
    this.emit('status', this.getStatus())
  }
  async listSessions(): Promise<SessionSummary[]> {
    if (this.state !== 'connected') throw new Error('offline')
    return this.sessions.map((id) => ({ id, title: id, lastActive: Date.now(), messageCount: 1, watermark: 1 }))
  }
  async send(req: ChatSendRequest): Promise<ChatSendResult> {
    if (this.state !== 'connected') throw new Error('offline')
    this.sent.push(req)
    return { runId: req.clientMsgId ?? '', status: 'accepted' }
  }
  async fetchHistory(): Promise<{ messages: []; watermark: number }> {
    return { messages: [], watermark: 0 }
  }
  async deleteSession(): Promise<void> {}
}

const asConn = (f: FakeConnection): ConnectionManager => f as unknown as ConnectionManager
const ids = (list: SessionSummary[]): string[] => list.map((s) => s.id).sort()

const A: DaemonIdentity = { apiBase: 'http://127.0.0.1:18101', fp: 'a'.repeat(16) }
const B: DaemonIdentity = { apiBase: 'http://127.0.0.1:18102', fp: 'b'.repeat(16) }
/** A different Prometheus answering at A's own address (a reinstall, or another computer given that address). */
const C: DaemonIdentity = { apiBase: A.apiBase, fp: 'c'.repeat(16) }

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'beacon-daemon-isolation-'))
  const folders = new DaemonFolders(root)
  try {
    console.log('\n[smoke] === 1. conversations ===')
    const connA = new FakeConnection('A', ['desktop:a1', 'desktop:a2'], 'connected')
    const onA = await new CacheService(folders.open(A).repo, asConn(connA)).listSessions()
    assert(ids(onA).join() === 'desktop:a1,desktop:a2', `A lists its own two (got ${ids(onA).join()})`)
    folders.setSetting(`${DRAFT_PREFIX}desktop:a1`, 'half a thought for A')
    folders.setSetting(THEME_KEY, 'dusk')

    const connB = new FakeConnection('B', ['desktop:b1'], 'connected')
    const onB = await new CacheService(folders.open(B).repo, asConn(connB)).listSessions()
    assert(ids(onB).join() === 'desktop:b1', `B, at another address, lists only its own (got ${ids(onB).join()})`)

    const connC = new FakeConnection('C', ['desktop:c1'], 'connected')
    const onC = await new CacheService(folders.open(C).repo, asConn(connC)).listSessions()
    assert(ids(onC).join() === 'desktop:c1', `C, behind A's own address, lists only its own (got ${ids(onC).join()})`)

    console.log('\n[smoke] === settings: a draft stays with its Prometheus, the theme stays with Beacon ===')
    assert(folders.getSetting(`${DRAFT_PREFIX}desktop:a1`) === null, "A's draft is not there while C is open")
    assert(folders.getSetting(THEME_KEY) === 'dusk', 'the theme is the same on every Prometheus')

    console.log("\n[smoke] === 2. queued messages ===")
    const downA = new FakeConnection('A', ['desktop:a1', 'desktop:a2'], 'reconnecting')
    const queued = await new CacheService(folders.open(A).repo, asConn(downA)).send({ sessionId: 'desktop:a1', message: 'for A only' })
    assert(queued.status === 'queued', `with A down, the message is queued (got ${queued.status})`)
    assert(folders.getSetting(`${DRAFT_PREFIX}desktop:a1`) === 'half a thought for A', "back on A, A's draft is there again")

    const upB = new FakeConnection('B', ['desktop:b1'], 'connected')
    await new CacheService(folders.open(B).repo, asConn(upB)).drainOutbox()
    assert(upB.sent.length === 0, `B's connection was asked to send nothing (it was asked ${upB.sent.length}: ${upB.sent.map((r) => r.message).join(' | ')})`)

    const upA = new FakeConnection('A', ['desktop:a1', 'desktop:a2'], 'connected')
    await new CacheService(folders.open(A).repo, asConn(upA)).drainOutbox()
    assert(upA.sent.length === 1 && upA.sent[0].message === 'for A only', `A's message goes to A when A is back (A got ${upA.sent.length})`)

    console.log('\n[smoke] === a reply for A that lands after the switch to B ===')
    {
      let release: () => void = () => undefined
      const slowA = new FakeConnection('A', [], 'connected')
      slowA.listSessions = async (): Promise<SessionSummary[]> => {
        await new Promise<void>((r) => (release = r))
        return [{ id: 'desktop:a-late', title: 'late', lastActive: Date.now(), messageCount: 1, watermark: 1 }]
      }
      const late = new CacheService(folders.open(A).repo, asConn(slowA)).listSessions().catch(() => null)
      const onB = folders.open(B) // the switch: A's folder is closed under the reply still on its way
      release()
      await late
      const bNow = ids(await new CacheService(onB.repo, asConn(new FakeConnection('B', ['desktop:b1'], 'connected'))).listSessions())
      assert(!bNow.includes('desktop:a-late'), `nothing of A's late reply is in B's folder (${bNow.join()})`)
    }

    console.log('\n[smoke] === 3. notification actions ===')
    const raisedOnA = asConn(connA)
    assert(approvalActionTarget(raisedOnA, raisedOnA) === raisedOnA, "with A still connected, A's notification answers A")
    assert(approvalActionTarget(raisedOnA, asConn(connB)) === null, "after a switch to B, A's notification sends nothing on B's link")
    assert(approvalActionTarget(raisedOnA, null) === null, 'with nothing connected, it sends nothing')
  } finally {
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
