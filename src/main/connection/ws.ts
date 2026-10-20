import WebSocket from 'ws'
import { openGatewayWebSocket } from '../tls-pin'
import type { ChatStreamFrame, ChatUploadRequest, ConnectionState } from '@shared/ipc'
import type { GatewayEvent } from '@shared/gateway-events'
import { chatUploadFrame } from '@shared/attachments'
import { computerTaskStopFrame } from '@shared/computer'
import { wsAuthFrame, wsSubscribeFrame, WS_CLOSE_UNAUTHORIZED } from '@shared/daemon-api'
import type { SocketEvent, SocketEventKind } from '@shared/socket-log'
import { extractText } from './text'
import { isCompactionStage } from '@shared/compaction-status'

export interface GatewaySocketHandlers {
  onState(state: ConnectionState, meta?: { attempt?: number }): void
  onFrame(frame: ChatStreamFrame): void
  /** Every inbound daemon frame (except the chat_delta token stream), for the panels' store. */
  onGatewayEvent(ev: GatewayEvent): void
  /** The daemon closed the socket 4401 — the first-frame auth token is missing or rejected. Distinct
   * from a normal drop: the manager flips wsAuth='unauthorized' and we STOP reconnecting (a bad
   * token won't self-heal, and retry-storming the daemon is worse than honest failure). */
  onAuthFailure(): void
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Liveness probing. WITHOUT this, a half-open socket is undetectable: when the
 * machine sleeps (or a NAT/Tailscale path drops), the TCP connection dies
 * without ever delivering a `close` event — so `scheduleReconnect()` never runs
 * and the UI sits on `state:'connected'` indefinitely. Observed live on
 * 2026-07-29: the daemon had been restarted ~53h earlier and Beacon had made
 * ZERO reconnect attempts since, while still displaying "Connected". Chat sends
 * (REST) kept returning 200, so replies were produced by the daemon and simply
 * never reached the UI — surfacing as "no reply from the gateway after 30s".
 *
 * PING_INTERVAL elicits traffic; STALE_AFTER must exceed it by enough to
 * tolerate one missed round-trip on a slow link (here: two probes).
 */
const PING_INTERVAL_MS = 20_000
const STALE_AFTER_MS = 45_000

/**
 * Direct subscription to the Prometheus daemon's WebSocket (`:8010`). GO DIRECT — no
 * GatewayBridge / connect.challenge handshake (the daemon doesn't speak it, and it carries
 * no event class the direct stream lacks; spec §3.2 / Step 0.C). Lives in the main process
 * and reconnects with exponential backoff so it survives the renderer window closing.
 */
export class GatewaySocket {
  private ws: WebSocket | null = null
  private backoff = RECONNECT_BASE_MS
  private attempt = 0
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Epoch ms of the last inbound sign of life (frame or pong) on the CURRENT socket. */
  private lastSeenAt = 0

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: GatewaySocketHandlers,
    /** Capability-flagged (SETTING_WS_AUTH): when set, present the bearer in an `auth` frame right
     * after open. The daemon ignores unknown frame types today, so this is forward plumbing only. */
    private readonly authToken: string | null = null,
    /**
     * Durable lifecycle sink. Optional so this class stays constructible without a
     * database (the smokes drive a real socket against a real server and pass a
     * recording array instead) — but wired to the cache repo in the app, because
     * a console line does not survive a packaged launch.
     */
    private readonly onLifecycle: (e: SocketEvent) => void = () => {}
  ) {}

  /** Record one lifecycle event. Never throws: diagnostics must not break the link they describe. */
  private log(kind: SocketEventKind, extra?: { attempt?: number; detail?: string }): void {
    try {
      this.onLifecycle({ at: Date.now(), kind, ...extra })
    } catch {
      /* a sink that throws must not take the socket with it */
    }
  }

  /**
   * THE ONLY WAY A SOCKET GETS DESTROYED. Both callers route through here so a
   * terminate cannot happen unrecorded.
   *
   * `terminate()` (not `close()`) is deliberate and pre-dates this: a half-open
   * socket never completes a closing handshake, so a graceful close can hang
   * forever. But destroying the socket also means a write into it raises
   * NOTHING on either end — which is precisely why the record has to be written
   * here, before it is gone, rather than inferred afterwards.
   */
  private destroy(ws: WebSocket, kind: SocketEventKind, detail: string): void {
    this.log(kind, { detail })
    ws.terminate()
  }

  /**
   * Let go of a socket we are replacing. Detach FIRST, destroy second — both halves matter, and
   * neither was here before.
   *
   * WHAT HAPPENED WITHOUT IT (2026-08-19). Replacing `this.ws` was the whole of the handover, so
   * the previous socket stayed OPEN with its handlers still wired into handleMessage. Two live
   * sockets, one daemon: every chat_delta was processed twice and a reply rendered with every
   * token doubled. Worse, the old socket's late `close` ran the LIVE socket's cleanup — nulling
   * `this.ws`, which by then pointed at the healthy new socket, and scheduling a phantom redial
   * that dialled a third. Detaching kills the second failure; destroying kills the first.
   *
   * terminate(), not close(): a half-open socket never completes the closing handshake, so a
   * graceful close can hang and leave precisely the lingering socket this exists to prevent —
   * the same reasoning the liveness probe already documents. (This drops the `1000 shutdown`
   * close frame `stop()` used to send; the daemon already survives abrupt drops, since that is
   * what every laptop sleep looks like to it.)
   *
   * WHICH HALF IS LOAD-BEARING, measured rather than assumed: mutation-testing ws-replace-smoke
   * shows the destroy is the half nothing else covers, while the detach and the close handler's
   * identity guard are redundant WITH EACH OTHER — removing either alone still passes, removing
   * both fails four checks. Kept as a pair on purpose: they fail in different directions.
   */
  private retire(ws: WebSocket | null, why: string): void {
    if (!ws) return
    ws.removeAllListeners()
    // An EventEmitter with NO 'error' listener THROWS when one is emitted, and a socket we just
    // detached can still emit ECONNRESET on its way out — which would take the main process with
    // it. Detaching a socket means detaching it from the app, not from Node's error contract.
    ws.on('error', () => {})
    // Through destroy(), NOT a second terminate() call site: socket-log-smoke asserts there is
    // exactly one, because a path that can destroy the socket without writing a row is how the
    // 2026-08-16 approval ended up unanswerable. Retirement is a destruction like any other and
    // owes the log the same row.
    this.destroy(ws, 'retired', why)
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = null // the live reference goes first, so nothing can act on it mid-teardown
    this.retire(ws, 'stop')
  }

  /**
   * Send one file to the daemon as a `chat_upload` frame — one of the desktop's two outbound WS
   * paths (text still goes over REST; the other is sendComputerTaskStop). Returns false if the
   * socket isn't OPEN (the caller surfaces a failure row); the daemon caches + vision/extracts the
   * file, then dispatches it as a text turn.
   */
  sendUpload(req: ChatUploadRequest): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(chatUploadFrame(req)))
    return true
  }

  /**
   * Stop ONE desktop task: `{type: "computer_task_stop", payload: {task_id}}` (Prometheus#663). The
   * daemon answers THIS socket with `computer_task_stop_ack {task_id, stopped}`, which reaches the
   * panels' store like any other frame, and then tells everyone with
   * `computer_task_ended {outcome: "stopped"}`. Returns false if the socket isn't OPEN, so the
   * caller can take the REST route instead: a stop that waits for a reconnect is a stop too late.
   */
  sendComputerTaskStop(taskId: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(computerTaskStopFrame(taskId)))
    return true
  }

  private connect(): void {
    if (this.stopped) return
    // Whatever we were holding must be GONE before the next dial. index.ts calls reconnect() on
    // every powerMonitor resume — "safe to call when already healthy" — and that promise is only
    // true if the healthy socket is actually let go rather than merely dropped from a field.
    this.retire(this.ws, 'replaced by a new dial')
    this.ws = null
    this.handlers.onState('connecting')
    this.log('connecting', { detail: this.wsUrl })

    let ws: WebSocket
    try {
      // Through the pin (src/main/tls-pin.ts): a TLS Prometheus only by the key Beacon learned when it joined.
      ws = openGatewayWebSocket(this.wsUrl)
    } catch (e) {
      // Refused before any connection: a wss:// URL with no pin, or plain ws:// to a pinned computer. Nothing will change by
      // retrying, so, like a rejected token, it is surfaced and not redialled.
      const detail = (e as Error)?.message ?? String(e)
      console.error(`[ws] ${detail}`)
      this.handlers.onState('failed')
      this.log('failed', { detail })
      return
    }
    this.ws = ws

    ws.on('open', () => {
      // 'connected' is emitted when the daemon's `{type:"connected"}` frame arrives, not on
      // socket open — the socket is up but the app-level handshake is the daemon's hello.
      this.backoff = RECONNECT_BASE_MS
      this.attempt = 0
      // First-frame auth: when a token is configured the daemon requires {type:"auth",token} as the
      // FIRST frame within 5s (else it closes 4401). Send it before anything else. When no token is
      // set the daemon's WS auth is off and we send nothing — unchanged.
      if (this.authToken) ws.send(JSON.stringify(wsAuthFrame(this.authToken)))
      // Declare this client's capabilities right after auth. The daemon gates per-step desktop
      // thumbnails (Prometheus#701) on the socket declaring `computer-thumbnails`: without this it
      // never sends one, because an undeclared client would render the frame's whole payload into
      // its exportable Activity feed. Sent whether or not a token is configured — capabilities are
      // about what this client can decode, not about auth.
      ws.send(JSON.stringify(wsSubscribeFrame()))
      this.startHeartbeat(ws)
    })

    ws.on('message', (data: WebSocket.RawData) => {
      // Second line of defence behind retire()'s removeAllListeners: a frame from a socket we no
      // longer hold is a DUPLICATE of one the live socket is also getting, and processing it is
      // exactly the doubling. Never let that depend on cleanup having run first.
      if (this.ws !== ws) return
      this.lastSeenAt = Date.now()
      this.handleMessage(data)
    })

    // A pong proves the peer is alive even when the daemon has nothing to say —
    // which is the normal case for an idle session.
    ws.on('pong', () => {
      this.lastSeenAt = Date.now()
    })

    ws.on('close', (code: number) => {
      // A REPLACED socket closing is not the live socket's business. Without this guard the old
      // socket's late close nulled `this.ws` — the healthy new socket — and scheduled a redial on
      // top of a connection that was already up. (startHeartbeat has always had this guard; the
      // close path never did, and that asymmetry is the whole incident.)
      if (this.ws !== ws) return
      this.stopHeartbeat()
      this.ws = null
      if (code === WS_CLOSE_UNAUTHORIZED) {
        // Token rejected. Surface it and do NOT reconnect — the user must fix the token in
        // Connection Settings; a retry loop would just hammer the daemon with the same bad cred.
        this.handlers.onAuthFailure()
        this.handlers.onState('failed')
        this.log('failed', { detail: `closed ${WS_CLOSE_UNAUTHORIZED} — token rejected; not reconnecting` })
        return
      }
      if (!this.stopped) this.scheduleReconnect()
    })

    ws.on('error', (err: Error) => {
      // A close event follows; reconnect is scheduled there.
      console.error(`[ws] error: ${err.message}`)
      // The console line above was the ONLY record of this, and it is discarded
      // in a packaged launch. The reason is carried verbatim, not summarised —
      // `ECONNREFUSED` and `other side closed` are different failures.
      this.log('error', { detail: err.message })
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }

    const type = raw.type as string | undefined
    const payload = (raw.payload ?? {}) as Record<string, unknown>

    // Surface EVERY frame (except the high-frequency chat_delta token stream) to the panels' store —
    // the "stop dropping non-chat frames" path. The chat handling below is unchanged.
    if (type && type !== 'chat_delta') {
      const ts = typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : Date.now()
      this.handlers.onGatewayEvent({ type, payload, ts })
    }

    if (type === 'connected') {
      this.handlers.onState('connected')
      // Recorded so a reconnect can be PAIRED with the terminate that caused it.
      // A terminate with no matching 'connected' after it is a link that never
      // came back — which no console line could ever have told you.
      this.log('connected')
      return
    }

    const frame = toFrame(type, payload)
    if (frame) this.handlers.onFrame(frame)
  }

  /**
   * Probe the socket on an interval and force a reconnect when it has gone
   * quiet. `terminate()` (not `close()`) is deliberate: a half-open socket will
   * never complete a closing handshake, so a graceful close can hang forever.
   * terminate() destroys it immediately and emits 'close', which routes into
   * the existing backoff path — so recovery and the honest 'reconnecting'
   * status both fall out of the normal flow.
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat()
    this.lastSeenAt = Date.now()
    this.pingTimer = setInterval(() => {
      // Ignore ticks for a socket that has already been replaced.
      if (this.ws !== ws) return
      if (ws.readyState !== WebSocket.OPEN) return
      const silentMs = Date.now() - this.lastSeenAt
      if (silentMs > STALE_AFTER_MS) {
        console.warn('[ws] no traffic within liveness window — assuming half-open, reconnecting')
        this.destroy(ws, 'terminated-stale', `no inbound traffic for ${silentMs}ms (limit ${STALE_AFTER_MS}ms)`)
        return
      }
      try {
        ws.ping()
      } catch (err) {
        // Send failed on a socket we believe is open → it is not. Next tick
        // trips the staleness check; terminate now to recover sooner.
        //
        // THIS PATH WAS COMPLETELY SILENT — no console line, nothing durable —
        // and it is the one most likely to have fired during the 2026-08-16
        // approval, because it is what a socket that died without a close frame
        // does. A terminate here left no trace on either end.
        this.destroy(ws, 'terminated-ping-failed', `ping threw on an OPEN socket: ${String(err)}`)
      }
    }, PING_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.attempt += 1
    this.handlers.onState('reconnecting', { attempt: this.attempt })
    this.log('reconnecting', { attempt: this.attempt })

    const jitter = Math.random() * 0.3 * this.backoff
    const delay = Math.min(this.backoff + jitter, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
      this.connect()
    }, delay)
  }
}

/**
 * Map a raw Prometheus `:8010` frame to a normalized renderer ChatStreamFrame (durable-id
 * contract). Returns null for non-chat frames (agent_state, lcm_update, sentinel_*, dream_*,
 * chat_upload) — those are handled elsewhere. `context_compaction` IS mapped: it drives the chat's
 * inline "Tidying up…" line (#283).
 *
 * - delta/done: messageId = the transient streaming handle (`asst-<ms>` string).
 * - chat_message (user echo): messageId = the durable rowid (number) + client_msg_id + ordinal.
 * - tool_*: call_id is now always on the wire (correlates start↔end).
 */
export function toFrame(type: string | undefined, p: Record<string, unknown>): ChatStreamFrame | null {
  const sessionId = (p.session_id as string | undefined) ?? ''
  const streamId = String(p.message_id ?? 'stream')

  switch (type) {
    case 'chat_delta':
      return { kind: 'delta', sessionId, messageId: streamId, content: (p.content as string) ?? '' }
    case 'chat_done': {
      // `interrupted` rides through (P9.1): the daemon broadcasts chat_done{interrupted:true} when
      // a turn was stopped — from ANY client — and an interrupted turn must not render identically
      // to a finished one. Absent on a normal finish → undefined, not false, so the frame stays
      // byte-identical to the old shape for older daemons that never send it.
      //
      // row_id is the assistant turn's durable rowid (GRAFT-MOBILE-BRIDGE 3b; P9.8). The daemon
      // OMITS it — never sends null — when persistence surfaced none, so reading it only when it is
      // a finite number keeps the frame byte-identical for older daemons and the omit case. The
      // renderer re-keys its streamed bubble to it directly, closing the null-rowId window that
      // otherwise waits on the reconcile re-read.
      const rowId = typeof p.row_id === 'number' && Number.isFinite(p.row_id) ? p.row_id : undefined
      return {
        kind: 'done',
        sessionId,
        messageId: streamId,
        ...(p.interrupted === true ? { interrupted: true } : {}),
        ...(rowId !== undefined ? { rowId } : {})
      }
    }
    case 'command_done':
      // Slash-command terminator (daemon #256). Kept a separate kind all the way
      // through — see the ChatStreamFrame doc and shared/reply-watchdog.ts.
      // session_id is REQUIRED here: ChatShell's session filter only drops a frame
      // that HAS a mismatching sessionId, so one arriving without it would reach
      // whichever session is on screen and end the wrong exchange.
      return {
        kind: 'command_done',
        sessionId,
        messageId: streamId,
        // `command_name`, NOT `command`: the daemon renamed it because `command` was a
        // BOOL on the adjacent assistant chat_message and a STRING here — same key,
        // consecutive frames, different types. Named commandName on this side too, so
        // the ambiguity is not quietly reintroduced one layer up.
        commandName: (p.command_name as string | undefined) ?? undefined,
        transient: p.transient === true
      }
    case 'chat_message':
      return {
        kind: 'message',
        sessionId,
        messageId: (p.message_id as number | string | undefined) ?? streamId,
        ordinal: typeof p.ordinal === 'number' ? p.ordinal : undefined,
        clientMsgId: (p.client_msg_id as string | undefined) ?? undefined,
        role: (p.role as string) ?? 'assistant',
        content: extractText(p.content),
        createdAt: typeof p.created_at === 'number' ? p.created_at * 1000 : undefined,
        // A non-operator turn (a worker's report, Prometheus #713) says so live, as the history
        // fetch already did — dropped here, the report rendered as the operator's own bubble
        // until a reload. Absent stays absent.
        provenance: typeof p.provenance === 'string' ? p.provenance : undefined,
        isTrusted: typeof p.is_trusted === 'boolean' ? p.is_trusted : undefined
      }
    case 'tool_call_start':
      return {
        kind: 'tool_start',
        sessionId: sessionId || undefined,
        callId: String(p.call_id ?? streamId),
        toolName: (p.tool_name as string) ?? 'tool',
        inputs: p.inputs
      }
    case 'agent_progress':
      return {
        kind: 'progress',
        sessionId,
        phase: (p.phase as string) ?? 'thinking',
        toolName: (p.tool_name as string | null) ?? null,
        round: typeof p.round === 'number' ? p.round : undefined,
        chars: typeof p.chars === 'number' ? p.chars : undefined,
        toolCalls: typeof p.tool_calls === 'number' ? p.tool_calls : undefined,
        elapsedS: typeof p.elapsed_s === 'number' ? p.elapsed_s : undefined
      }
    case 'context_compaction': {
      // #283: the daemon's session-scoped compaction frame, NOT the `sentinel_signal` telemetry
      // broadcast of the same name (unscoped, after the fact, still dropped above). A stage this
      // build does not know is dropped rather than guessed at. Each number rides through only when
      // it is one: an absent count must stay absent, because 0 of 0 and "unknown" draw different bars.
      if (!isCompactionStage(p.stage)) return null
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const progress = num(p.progress)
      const chunksDone = num(p.chunks_done)
      const chunksTotal = num(p.chunks_total)
      const tokensBefore = num(p.tokens_before)
      const tokensAfter = num(p.tokens_after)
      const threshold = num(p.threshold)
      return {
        kind: 'compaction',
        sessionId,
        stage: p.stage,
        ...(progress !== undefined ? { progress } : {}),
        ...(chunksDone !== undefined ? { chunksDone } : {}),
        ...(chunksTotal !== undefined ? { chunksTotal } : {}),
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(typeof p.reason === 'string' ? { reason: p.reason } : {})
      }
    }
    case 'error':
      // Session-scoped since daemon e3019a5; older daemons omit session_id, in
      // which case sessionId is '' and the chat view ignores it (the Activity
      // panel still shows it, as before).
      return {
        kind: 'error',
        sessionId,
        message: (p.message as string) ?? 'the turn failed',
        errKind: (p.kind as string | undefined) ?? undefined,
        provider: (p.provider as string | undefined) ?? undefined,
        status: (p.status as number | null | undefined) ?? null,
        hint: (p.hint as string | undefined) ?? undefined
      }
    case 'tool_call_end':
      return {
        kind: 'tool_end',
        sessionId: sessionId || undefined,
        callId: String(p.call_id ?? streamId),
        success: p.success as boolean | undefined,
        result: p.result as string | undefined,
        error: p.error as string | undefined
      }
    default:
      return null
  }
}
