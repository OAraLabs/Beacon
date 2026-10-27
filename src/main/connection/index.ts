import { notEncrypted } from '@shared/plain-lan'
import { DEVICES_PATH, roleFromDevices, type DeviceRole } from '@shared/device-role'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ArtifactEntry,
  ChatInterruptResult,
  ChatSendRequest,
  ChatSendResult,
  ChatStreamFrame,
  ChatUploadRequest,
  ComputerTaskStopResult,
  ConnectionState,
  ConnectionStatus,
  DaemonWriteMethod,
  SessionSummary
} from '@shared/ipc'
import type { EventRow, GatewayEvent } from '@shared/gateway-events'
import { isAuthError, httpStatusFromError } from '@shared/daemon-api'
import type { BindingWire, DoorOutcome } from '@shared/computer-door'
import { resolveGateway, type GatewayConfig } from './config'
import { RestClient, type DaemonHistory } from './rest'
import { GatewaySocket } from './ws'
import type { SocketEvent } from '@shared/socket-log'
import type { IdentityNotice } from '@shared/identity-challenge'
import type { ProofControl } from '../identity'

/**
 * Owns the live link to one Prometheus gateway: REST (`:8005`) for reads/sends and the
 * direct WS (`:8010`) for streaming deltas. Single home for connection status. Lives in the
 * main process so it survives the renderer window closing (spec §3.2).
 *
 * Events:
 *   'status' (ConnectionStatus) — state transitions
 *   'stream' (ChatStreamFrame)  — normalized chat deltas, all sessions (filter by sessionId)
 */
export class ConnectionManager extends EventEmitter {
  private readonly rest: RestClient
  private readonly socket: GatewaySocket
  private status: ConnectionStatus
  private restAuth: 'unknown' | 'ok' | 'unauthorized' = 'unknown'
  private wsAuth: 'unknown' | 'ok' | 'unauthorized' = 'unknown'
  private wrongKey: ConnectionStatus['wrongKey'] | null = null
  /** Plain to the home network (a connection saved before that was refused): the one-line notice. */
  private readonly plainHome: boolean
  /** Owner or approved device (ConnectionStatus.role): the last answer for this address and key until GET /api/devices answers. */
  private role: DeviceRole | null
  private roleAsked = 0
  /** stop() was called: a gate that answers later starts nothing. */
  private halted = false
  /** The gate refused this address (ConnectionStatus.refused). */
  private refused: string | null = null
  /** What the identity challenge found, for ConnectionStatus.identity. */
  private identity: IdentityNotice | null = null

  constructor(
    cfg: GatewayConfig = resolveGateway(),
    token: string | null = null,
    _wsAuth = false,
    /**
     * Durable socket-lifecycle sink. Defaults to a no-op so every existing
     * call site (four smokes) keeps working unchanged; the app supplies one
     * backed by the cache repo. Passed straight through — the manager holds no
     * database and should not learn about one.
     */
    onSocketLifecycle: (e: SocketEvent) => void = () => {},
    /** Where the role is remembered between connections (the app keys it by address and key). Defaults to nowhere. */
    private readonly roles: RoleMemory = { recall: () => null, remember: () => undefined },
    /** Whether this address may be used at all (src/main/plain-public.ts): the words to refuse with, or null. Nothing is sent, REST
     *  or socket, until it answers; refused, nothing is sent at all and the status carries the words. */
    private readonly gate: Promise<string | null> = Promise.resolve(null),
    /** Proof of who answers at this address, asked before the key goes out (docs/MULTI-PROMETHEUS.md §8): null to go ahead, or the
     *  words to refuse with. Asked after the gate, on every start and reconnect; REST and the socket wait for the latest answer.
     *  Defaults to asking nothing. */
    private readonly prove: (control: ProofControl) => Promise<string | null> = () => Promise.resolve(null)
  ) {
    super()
    // The bearer token goes on BOTH transports now: REST as the Authorization header, and the WS
    // (:8010) as a first-frame auth message — the daemon (>= dbcce28) requires it on the socket
    // whenever a token is configured. No token => WS auth is off daemon-side, so we send none.
    // (The legacy `_wsAuth` capability flag is no longer a gate; kept only for call-site compat.)
    this.rest = new RestClient(cfg.apiBase, token, () => this.clearance())
    this.plainHome = notEncrypted(cfg.apiBase, cfg.wsUrl)
    this.role = roles.recall()
    this.status = { state: 'idle', gateway: gatewayLabel(cfg), ...(this.plainHome ? { notEncrypted: true } : {}), ...(this.role ? { role: this.role } : {}) }
    this.socket = new GatewaySocket(
      cfg.wsUrl,
      {
        onState: (state, meta) => this.setState(state, meta),
        onFrame: (frame: ChatStreamFrame) => this.emit('stream', frame),
        onGatewayEvent: (ev: GatewayEvent) => this.emit('gatewayEvent', ev),
        onAuthFailure: () => this.setWsAuth('unauthorized'),
        // A redial is a new connect: whoever answers now proves who it is first, and REST waits for the same answer.
        beforeRedial: async () => {
          this.cleared = null
          const refused = await this.clearance()
          if (this.halted) return false
          if (refused) {
            this.socket.stop()
            this.refuse(refused)
            return false
          }
          return true
        }
      },
      token ?? null,
      onSocketLifecycle
    )
  }

  /** The gate's answer and then the proof's, once per start: what every REST call and the socket wait for. */
  private cleared: Promise<string | null> | null = null
  private started = false

  private clearance(): Promise<string | null> {
    this.cleared ??= this.gate.then(
      (refused) =>
        refused ??
        this.prove({
          // No answer to the challenge yet: say so the way the socket's own retries do, so the banner reads the same.
          waiting: (attempt) => this.setState('reconnecting', { attempt }),
          stopped: () => this.halted
        })
    )
    return this.cleared
  }

  start(): void {
    this.halted = false
    if (this.started) this.cleared = null // a reconnect asks again: the Prometheus answering may not be the one that answered last
    this.started = true
    void this.clearance().then((refused) => {
      if (this.halted) return
      if (refused) this.refuse(refused)
      else this.socket.start()
    })
  }

  stop(): void {
    this.halted = true
    this.socket.stop()
  }

  /** Manual retry (the indicator's "Reconnect now"): drop + redial immediately, resetting backoff. A refused address stays refused. */
  reconnect(): void {
    this.socket.stop()
    this.start()
  }

  /** The address may not be used (the gate's words): no socket, no REST, and a status that says why. */
  private refuse(words: string): void {
    this.refused = words
    this.status = {
      state: 'failed',
      gateway: this.status.gateway,
      since: Date.now(),
      refused: words,
      ...(this.plainHome ? { notEncrypted: true } : {}),
      ...(this.role ? { role: this.role } : {}),
      ...(this.identity ? { identity: this.identity } : {})
    }
    this.emit('status', this.status)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  /**
   * Fold a REST outcome into the bearer-health signal (ConnectionStatus.restAuth): a 401 anywhere
   * flips it to 'unauthorized'; any non-401 HTTP response proves the token is accepted ('ok');
   * network drops leave it unchanged. Status is re-emitted only on transitions, so the offline-first
   * cache fallbacks can keep swallowing errors without ever silencing an auth failure.
   */
  private trackAuth<T>(p: Promise<T>): Promise<T> {
    return p.then(
      (v) => {
        this.setRestAuth('ok')
        return v
      },
      (e) => {
        if (isAuthError(e)) this.setRestAuth('unauthorized')
        else if (httpStatusFromError(e) !== null) this.setRestAuth('ok')
        throw e
      }
    )
  }

  private setRestAuth(next: 'ok' | 'unauthorized'): void {
    if (this.restAuth === next) return
    this.restAuth = next
    this.status = { ...this.status, restAuth: next }
    this.emit('status', this.status)
  }

  /** WS bearer health, the socket-side mirror of setRestAuth. The GatewaySocket reports a 4401
   * close (token rejected) via onAuthFailure; reaching the daemon's 'connected' welcome clears it
   * back to 'ok'. Either restAuth or wsAuth being 'unauthorized' lights the one auth-failure UX. */
  /** A pinned Prometheus answered with another key (docs/MULTI-COMPUTER-v0.4.md §3.4); null clears it. Cleared too when the
   *  connection next reaches 'connected' (the right key answered after all). */
  setWrongKey(next: ConnectionStatus['wrongKey'] | null): void {
    this.wrongKey = next ?? null
    const { wrongKey: _old, ...rest } = this.status
    this.status = { ...rest, ...(this.wrongKey ? { wrongKey: this.wrongKey } : {}) }
    this.emit('status', this.status)
  }

  /** What the identity challenge found (docs/MULTI-PROMETHEUS.md §8), for the card; null clears it. Kept across state changes. */
  setIdentity(next: IdentityNotice | null): void {
    this.identity = next
    const { identity: _old, ...rest } = this.status
    this.status = { ...rest, ...(next ? { identity: next } : {}) }
    this.emit('status', this.status)
  }

  private setWsAuth(next: 'ok' | 'unauthorized'): void {
    if (this.wsAuth === next) return
    this.wsAuth = next
    this.status = { ...this.status, wsAuth: next }
    this.emit('status', this.status)
  }

  async send(req: ChatSendRequest): Promise<ChatSendResult> {
    return this.trackAuth(
      this.rest.sendChat(
        req.sessionId,
        req.message,
        req.idempotencyKey ?? randomUUID(),
        req.clientMsgId,
        req.mode,
        req.forceSearch,
        req.references
      )
    )
  }

  /** Upload one file over the live WS (chat_upload). Returns false if the socket isn't open. */
  uploadFile(req: ChatUploadRequest): boolean {
    return this.socket.sendUpload(req)
  }

  /** Stop the running turn (P9.1) — POST /api/chat/interrupt. Idempotent at the daemon: a quiet
   *  session reports stopped:false rather than erroring. The terminal `chat_done{interrupted:true}`
   *  arrives on the broadcast, so every open window ends the turn, not just the one that pressed. */
  interruptChat(sessionId: string): Promise<ChatInterruptResult> {
    return this.trackAuth(this.rest.interruptChat(sessionId))
  }

  /** Stop ONE desktop task (Prometheus#663). Over the live WS when it is open — the ack then
   *  arrives as a `computer_task_stop_ack` frame — else over REST, whose answer comes back here.
   *  Either way the outcome reaches every client as `computer_task_ended {outcome: "stopped"}`. */
  async stopComputerTask(taskId: string): Promise<ComputerTaskStopResult> {
    if (this.socket.sendComputerTaskStop(taskId)) return { sent: true, via: 'ws' }
    const res = await this.trackAuth(this.rest.stopComputerTask(taskId))
    return { sent: true, via: 'rest', stopped: res.stopped }
  }

  // ── the desktop door (v1.1 PR 7) ────────────────────────────────────────
  // REST-only: unlike stop, these five routes have no socket twin, so there is
  // no WS-first path.
  //
  // ⚠ DELIBERATELY NOT WRAPPED IN trackAuth. Two reasons, and the second is
  // the one that matters:
  //   1. trackAuth detects a 401 in the REJECTION path (isAuthError(e)), and
  //      the REST layer's door() never rejects — it returns {ok:false,
  //      refusal} so the structured body survives. Wrapping it would record
  //      'ok' for every door refusal, silently.
  //   2. A door 401 is `not_a_person`: this device is not marked for computer
  //      use. That is a per-route authorization answer, NOT a credential
  //      failure. Feeding it to setRestAuth would flip the app-wide REST auth
  //      state and show an authentication failure across Beacon — every panel
  //      reading status.restAuth — because one desktop route refused. The
  //      refusal belongs to the door UI, which renders the daemon's own
  //      sentence; it is not a fact about the connection.
  listComputerApps(): Promise<DoorOutcome<{ apps?: string[] }>> {
    return this.rest.listComputerApps()
  }

  getComputerBinding(sessionId: string): Promise<DoorOutcome<BindingWire>> {
    return this.rest.getComputerBinding(sessionId)
  }

  setComputerBinding(sessionId: string, app: string): Promise<DoorOutcome<BindingWire>> {
    return this.rest.setComputerBinding(sessionId, app)
  }

  clearComputerBinding(sessionId: string): Promise<DoorOutcome<BindingWire>> {
    return this.rest.clearComputerBinding(sessionId)
  }

  startComputerTask(body: Record<string, string>): Promise<DoorOutcome<{ task_id?: string }>> {
    return this.rest.startComputerTask(body)
  }

  /** GET /api/events/recent — durable signal_events tail for the activity-feed backfill. */
  listRecentEvents(limit?: number): Promise<EventRow[]> {
    return this.trackAuth(this.rest.listRecentEvents(limit))
  }
  /** Scoped generic GET of a read-only /api/ path (the 5b panels' data). */
  getDaemon(path: string): Promise<unknown> {
    return this.trackAuth(this.rest.getDaemon(path))
  }

  listArtifacts(): Promise<ArtifactEntry[]> {
    return this.trackAuth(this.rest.listArtifacts())
  }

  downloadArtifact(id: string): Promise<Buffer> {
    return this.trackAuth(this.rest.downloadArtifact(id))
  }

  fetchMedia(sourcePath: string): Promise<{ bytes: Buffer; contentType: string }> {
    return this.trackAuth(this.rest.fetchMedia(sourcePath))
  }

  /** The owner's side of joining a Prometheus: who is waiting for a yes, and the answer. Not wrapped in trackAuth: a 403 from a device that is
   *  not an owner is an answer, not a sign of a bad token. */
  listPairRequests(): ReturnType<RestClient['listPairRequests']> {
    return this.rest.listPairRequests()
  }
  decidePairRequest(requestId: string, verb: 'approve' | 'deny', body?: Record<string, unknown>): Promise<{ status: number }> {
    return this.rest.decidePairRequest(requestId, verb, body)
  }

  /** Scoped generic write (POST/PUT/DELETE) of an /api/ path — the write counterpart to getDaemon. */
  writeDaemon(path: string, body?: unknown, method?: DaemonWriteMethod): Promise<unknown> {
    return this.trackAuth(this.rest.writeDaemon(path, body, method))
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.trackAuth(this.rest.listSessions())
  }

  /** Incremental history by the durable rowid cursor (rowId > sinceRowid) + the next watermark. */
  fetchHistory(sessionId: string, sinceRowid = 0): Promise<DaemonHistory> {
    return this.trackAuth(this.rest.fetchHistory(sessionId, sinceRowid))
  }

  /** The daemon's GLOBAL pending-approval queue (REST poll; approvals carry no session id). */
  listApprovals(): Promise<ApprovalRequest[]> {
    return this.trackAuth(this.rest.listApprovals())
  }

  /** Approve/deny one pending action (binary). */
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.trackAuth(this.rest.resolveApproval(requestId, decision))
  }

  /** Ask the daemon to forget a session (DELETE /api/sessions/{id}) so it drops out of the
   * in-memory list. Durable history is kept daemon-side. Rejects on a non-2xx response. */
  deleteSession(sessionId: string): Promise<void> {
    return this.trackAuth(this.rest.deleteSession(sessionId))
  }

  private setState(state: ConnectionState, meta?: { attempt?: number }): void {
    // Reaching the daemon's 'connected' welcome means the WS first-frame auth was accepted — clear
    // any prior wsAuth rejection so a manual reconnect with a fixed token recovers the UI.
    if (state === 'connected' && this.wsAuth === 'unauthorized') this.wsAuth = 'ok'
    if (state === 'connected') this.wrongKey = null
    if (state === 'connected') this.askRole()
    this.status = {
      state,
      gateway: this.status.gateway,
      attempt: meta?.attempt,
      since: Date.now(),
      ...(this.restAuth !== 'unknown' ? { restAuth: this.restAuth } : {}),
      ...(this.wsAuth !== 'unknown' ? { wsAuth: this.wsAuth } : {}),
      ...(this.wrongKey ? { wrongKey: this.wrongKey } : {}),
      ...(this.plainHome ? { notEncrypted: true } : {}),
      ...(this.role ? { role: this.role } : {}),
      ...(this.refused ? { refused: this.refused } : {}),
      ...(this.identity ? { identity: this.identity } : {})
    }
    this.emit('status', this.status)
  }

  /** GET /api/devices, which every device may read: its own row says owner or not (@shared/device-role). Asked on every connect (a
   *  device can be made an owner from elsewhere); an answer it cannot read changes nothing. Not wrapped in trackAuth: this is a
   *  question about the device, and the panels' own reads already report a refused key. */
  private askRole(): void {
    const asked = ++this.roleAsked
    this.rest
      .getDaemon(DEVICES_PATH)
      .then(
        (body) => roleFromDevices(200, body),
        (e) => roleFromDevices(httpStatusFromError(e) ?? 0, null)
      )
      .then((role) => {
        if (asked !== this.roleAsked || role === null) return
        this.roles.remember(role)
        if (role === this.role) return
        this.role = role
        this.status = { ...this.status, role }
        this.emit('status', this.status)
      })
      .catch(() => undefined)
  }
}

/** The last role per address and key, so an approved device opens on the note and not on a refusal it would read first. */
export interface RoleMemory {
  recall(): DeviceRole | null
  remember(role: DeviceRole): void
}

function gatewayLabel(cfg: GatewayConfig): string {
  return cfg.wsUrl.replace(/^wss?:\/\//, '')
}
