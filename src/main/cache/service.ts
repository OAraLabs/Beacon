import { randomUUID } from 'node:crypto'
import type {
  ChatSendRequest,
  ChatSendResult,
  ChatStreamFrame,
  ConnectionStatus,
  HistoryMessage,
  SessionSummary
} from '@shared/ipc'
import type { ConnectionManager } from '../connection'
import { gatewayOf } from '../presence'
import { sessionDisplayTitle } from '@shared/session-tree'
import { suggestProject, tallyToolInputs, type ProjectHint } from '@shared/session-projects'
import { CacheRepo, type MessageRow, type ReconcileStats, type SessionRow } from './repo'

const MAX_ATTEMPTS = 5

/**
 * Glue between the cache and the live connection. Re-keys optimistic rows on the WS echo
 * (by client_msg_id), drains the outbox + reconciles by the rowid cursor on reconnect, and
 * exposes cache rows to the renderer. The daemon stays the source of truth.
 */
export class CacheService {
  private prevState: ConnectionStatus['state'] = 'idle'
  /**
   * Held while it is not yet known that the Prometheus on this connection is the one this cache's folder belongs to (a plain
   * connection, before hello has answered: docs/MULTI-PROMETHEUS.md §2). Held, nothing it says is written here (no session list,
   * no history, no frame) and nothing queued here is sent to it: a new message is queued instead. `release` lifts it.
   */
  private held: boolean

  constructor(
    private readonly repo: CacheRepo,
    private readonly connection: ConnectionManager,
    opts: { held?: boolean } = {}
  ) {
    this.held = opts.held === true
  }

  /** The folder is confirmed as this Prometheus's: catch up as a reconnect would (drain the outbox, reconcile). */
  release(): void {
    if (!this.held) return
    this.held = false
    if (this.isConnected()) void this.onReconnect().catch(() => undefined)
  }

  isHeld(): boolean {
    return this.held
  }

  private refuseWhileHeld(): void {
    if (this.held) throw new Error('not yet confirmed that this is the Prometheus this cache belongs to')
  }

  attach(): void {
    this.connection.on('status', (s: ConnectionStatus) => {
      const reconnected = this.prevState !== 'connected' && s.state === 'connected'
      this.prevState = s.state
      if (reconnected && !this.held) void this.onReconnect()
    })
    this.connection.on('stream', (f: ChatStreamFrame) => this.onFrame(f))
  }

  /** Re-key the cache from the live WS user echo (deterministic, by client_msg_id); reconcile a
   * finished turn so assistant rows land by rowid. */
  private onFrame(f: ChatStreamFrame): void {
    if (this.held) return
    // CONTAINED, because this is a fire-and-forget listener on the socket's 'stream' event: a
    // throw here has no caller to catch it and reaches the main process as an uncaught exception —
    // Electron error dialog, app dead. That is what a single FK violation did on 2026-08-30. The
    // cache is a cache and never a second source of truth, so a failed cache write costs this
    // frame's local bookkeeping (the daemon still has it, and reconcile re-pulls it) — never the
    // session. LOUD, though: a silently swallowed write is the other way this goes wrong.
    try {
      if (f.kind === 'message' && f.role === 'user' && f.clientMsgId && typeof f.messageId === 'number') {
        this.repo.relinkByClientMsgId(f.sessionId, f.clientMsgId, f.messageId, f.ordinal ?? 0, 'user', f.content, f.createdAt)
      } else if (f.kind === 'command_done' && f.sessionId && f.commandName) {
        // The command was answered transiently — nothing durable will ever arrive to re-key the
        // optimistic row, so it is dropped rather than left to render as the newest message on every
        // reload. See CacheRepo.dropTransientCommandRow for the captured wire this reads from.
        this.repo.dropTransientCommandRow(f.sessionId, f.commandName)
      } else if (f.kind === 'done' && f.sessionId) {
        void this.reconcile(f.sessionId).catch(() => undefined)
      }
    } catch (err) {
      console.error(
        `[cache] frame write failed (kind=${f.kind} session=${f.sessionId}):`,
        err instanceof Error ? err.message : err
      )
    }
  }

  isConnected(): boolean {
    return this.connection.getStatus().state === 'connected'
  }

  /** Read-through: cache rows now (renderer paints immediately); reconcile happens async. */
  getHistory(sessionId: string): HistoryMessage[] {
    return this.repo.getMessages(sessionId).map(toHistory)
  }

  outboxStatus(): { pending: number; failed: number } {
    const s = this.repo.outboxStatus()
    return { pending: s.pending, failed: s.failed }
  }

  /** Per-session memo for projectHints(): the message stamp it was computed at, and the result. */
  private readonly hintMemo = new Map<string, { stamp: string; hint: ProjectHint | null }>()

  /**
   * sessionId → the project its tool calls point at (@shared/session-projects), for every cached
   * session that has a clear one. Read from the LOCAL cache, so only sessions whose history Beacon
   * has fetched can have a hint. A session is re-read only when its messages changed since the
   * last call; the first call over a full cache is one pass (~0.25 s on 28k messages).
   */
  projectHints(): Record<string, ProjectHint> {
    const stamps = this.repo.messageStamps()
    for (const sid of [...this.hintMemo.keys()]) if (!stamps.has(sid)) this.hintMemo.delete(sid)
    const out: Record<string, ProjectHint> = {}
    for (const [sid, stamp] of stamps) {
      let memo = this.hintMemo.get(sid)
      if (!memo || memo.stamp !== stamp) {
        memo = { stamp, hint: suggestProject(tallyToolInputs(this.repo.toolUseInputs(sid))) }
        this.hintMemo.set(sid, memo)
      }
      if (memo.hint) out[sid] = memo.hint
    }
    return out
  }

  /** The sidebar list: cache sessions (durable) reconciled with the daemon's in-memory list.
   * Offline → returns the cache as-is. */
  async listSessions(): Promise<SessionSummary[]> {
    try {
      this.refuseWhileHeld()
      for (const s of await this.connection.listSessions()) {
        this.repo.upsertSessionMeta(
          s.id,
          s.gateway ?? gatewayOf(s.id), // authoritative daemon gateway (sessions-meta); prefix only as fallback
          // NEVER substitute the id here: writing it into a title column is what made the
          // stored value indistinguishable from a real title, and forced the display layer
          // to compare against the id to tell them apart. null means "no title", honestly.
          s.title ?? null,
          s.lastActive ?? Date.now(),
          s.messageCount ?? 0,
          s.watermark ?? 0, // per-session max rowid → cold-start unread for listed sessions
          s.pinned === true // daemon-owned pin (Prometheus#351)
        )
      }
    } catch {
      // daemon list unavailable — fall back to the durable cache.
    }
    // Auto-title from each session's first user message (uniform "name = what's inside").
    const snippets = this.repo.firstUserSnippets()
    return this.repo.getSessions().map((r) => toSummary(r, snippets.get(r.id)))
  }

  /** Every send renders an optimistic row immediately; online → POST now, offline/failure →
   * outbox. The WS echo re-keys the optimistic row to the durable rowid by client_msg_id. */
  async send(req: ChatSendRequest): Promise<ChatSendResult> {
    const idempotencyKey = req.idempotencyKey ?? randomUUID()
    const clientMsgId = req.clientMsgId ?? randomUUID()
    // @-references are resolved by the daemon at send time against the workspace AS IT IS NOW; the
    // outbox replays a message later, and its payload has no references column. Queuing one would
    // silently drop the chips (a shorter prompt than the user believed they attached — the exact
    // failure PR 382 was built to prevent). So: not connected → refuse loudly, queue nothing.
    const hasRefs = Array.isArray(req.references) && req.references.length > 0
    const live = this.isConnected() && !this.held
    if (hasRefs && !live) {
      return { runId: clientMsgId, status: 'not-connected', error: 'not connected — a message with @-references is not queued (the daemon resolves them at send time)' }
    }
    this.repo.ensureSession(req.sessionId, this.connection.getStatus().gateway ?? undefined)
    const optimisticId = this.repo.addOptimisticMessage(req.sessionId, 'user', req.message, clientMsgId)

    if (live) {
      try {
        return await this.connection.send({ ...req, idempotencyKey, clientMsgId })
      } catch (err) {
        // Still outbox it (durable retry on reconnect), but DO NOT swallow: a send that fails while
        // connected must reach the user's eyes, or the app reads as "daemon ignoring me" (live-walk
        // finding 2026-07-12 — same silent-swallow class as the history reconcile fix).
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[cache] connected send failed (${req.sessionId}):`, msg)
        if (hasRefs) {
          // A refused reference (400/403/404/502/503) is the daemon's answer, not a transport blip:
          // replaying it later would re-refuse or, worse, resolve against a changed workspace.
          this.repo.removeOptimisticMessage(req.sessionId, optimisticId)
          return { runId: clientMsgId, status: 'refused', error: msg }
        }
        this.repo.attachOutbox(req.sessionId, req.message, idempotencyKey, clientMsgId, optimisticId, req.mode, req.forceSearch)
        return { runId: clientMsgId, status: 'queued', error: msg }
      }
    }
    this.repo.attachOutbox(req.sessionId, req.message, idempotencyKey, clientMsgId, optimisticId, req.mode, req.forceSearch)
    return { runId: clientMsgId, status: 'queued' }
  }

  async onReconnect(): Promise<{ drained: number; reconciled: ReconcileStats[] }> {
    if (this.held) return { drained: 0, reconciled: [] }
    const drainedSessions = await this.drainOutbox()
    const reconciled: ReconcileStats[] = []
    for (const sessionId of drainedSessions) reconciled.push(await this.reconcile(sessionId))
    return { drained: drainedSessions.length, reconciled }
  }

  /** Send every pending outbox row (with its client_msg_id). Returns distinct sessions drained. */
  async drainOutbox(): Promise<string[]> {
    if (this.held) return []
    const pending = this.repo.getPendingOutbox()
    const touched = new Set<string>()
    for (const row of pending) {
      const { message, idempotency_key, client_msg_id, mode, tool_choice } = JSON.parse(row.payload) as {
        message: string
        idempotency_key: string
        client_msg_id: string
        mode?: 'agent' | 'chat'
        tool_choice?: { tool: string }
      }
      try {
        await this.connection.send({
          sessionId: row.session_id,
          message,
          idempotencyKey: idempotency_key,
          clientMsgId: client_msg_id,
          mode,
          // Replay force-search exactly as composed (the payload stored tool_choice).
          forceSearch: !!tool_choice
        })
        this.repo.markOutbox(row.id, 'sent', row.attempts + 1)
        touched.add(row.session_id)
      } catch {
        const attempts = row.attempts + 1
        this.repo.markOutbox(row.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts)
      }
    }
    return [...touched]
  }

  /** "Forget session": ask the daemon to drop its in-memory session (best-effort — a forget must
   * still succeed locally when offline or the daemon errs), then purge the durable local cache so
   * the sidebar stops listing it. The daemon half is what makes it stick: without it, the next
   * GET /api/sessions poll would re-surface the session we just dropped from the cache. */
  async forgetSession(sessionId: string): Promise<void> {
    try {
      this.refuseWhileHeld() // a forget is not sent to a Prometheus this cache may not belong to; the local purge still runs
      await this.connection.deleteSession(sessionId)
    } catch {
      // Offline / daemon error — proceed with the local purge regardless. If the session still
      // lives in the daemon's memory it may reappear on a later list; the user can forget again.
    }
    this.repo.deleteSession(sessionId)
  }

  /**
   * Re-pull a session from rowid 0 and upsert every row. `reconcile` is a FORWARD cursor from the
   * highest cached rowid, so it can never fill a hole beneath one — and a session Beacon first met
   * over the socket has exactly that hole: everything said before the app was listening. A search
   * hit is the one path that reaches into it, so this exists for that path and is called only when
   * the target row is genuinely absent. Upsert-only: reconcileSession never deletes, so re-pulling
   * rows the cache already holds is a no-op beyond a watermark bump.
   */
  async backfill(sessionId: string): Promise<HistoryMessage[]> {
    this.refuseWhileHeld()
    const history = await this.connection.fetchHistory(sessionId, 0)
    this.repo.reconcileSession(sessionId, history.messages, history.watermark)
    return this.getHistory(sessionId)
  }

  /** Reconcile by the durable rowid cursor: GET rowId > max CACHED rowid, upsert, advance.
   * The cursor is the cached-message maximum, NOT the session watermark — the watermark column
   * tracks the daemon's high-water mark for unread dots and may run ahead of the cache. */
  async reconcile(sessionId: string): Promise<ReconcileStats> {
    this.refuseWhileHeld()
    const since = this.repo.getMaxMessageRowId(sessionId)
    const history = await this.connection.fetchHistory(sessionId, since)
    return this.repo.reconcileSession(sessionId, history.messages, history.watermark)
  }
}

function toSummary(r: SessionRow, firstUserContent?: string): SessionSummary {
  return {
    id: r.id,
    // Daemon title first, then the content snippet, then the id — see sessionDisplayTitle for
    // why the old snippet-first rule was right until the daemon started generating titles.
    title: sessionDisplayTitle(r.title, firstUserContent, r.id),
    gateway: r.gateway ?? gatewayOf(r.id),
    messageCount: r.message_count,
    lastActive: r.last_active ?? undefined,
    watermark: r.watermark,
    pinned: r.pinned === 1
  }
}

function toHistory(r: MessageRow): HistoryMessage {
  return {
    id: r.id,
    rowId: r.row_id,
    ordinal: r.ordinal,
    sessionId: r.session_id,
    role: r.role,
    content: r.content ?? '',
    contentJson: r.content_json ?? null,
    // Carried back out of the cache (Prometheus#123). NULL on a legacy/optimistic row reads as
    // (user, trusted) — the same default the wire decoder applies — so an existing cache renders
    // unbadged rather than flagging the owner's own history as machinery.
    provenance: r.provenance ?? null,
    isTrusted: r.is_trusted === null ? undefined : r.is_trusted === 1,
    pending: r.row_id === null,
    createdAt: r.created_at,
    clientMsgId: r.client_msg_id ?? undefined
  }
}
