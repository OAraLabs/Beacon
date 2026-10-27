import { originOf, sameOrigin } from '@shared/key-origin'
import { pinnedFromWire } from '@shared/session-pins'
import { isTrustedFromWire } from '@shared/provenance'
import type { ApprovalDecision, ApprovalRequest, ArtifactEntry, ChatInterruptResult, ChatReference, ChatSendResult, DaemonWriteMethod, SessionSummary } from '@shared/ipc'
import type { EventRow } from '@shared/gateway-events'
import { isAllowedDaemonPath, refusalCode } from '@shared/daemon-api'
import { rawToApproval, type RawApprovalPush } from '@shared/approval-push'
import { doorRefusal, type BindingWire, type DoorOutcome } from '@shared/computer-door'
import { extractText } from './text'

// Client-side ceiling for one artifact download (the daemon's own cap is 1 GiB).
const ARTIFACT_MAX_BYTES = 256 * 1024 * 1024

interface RawSession {
  session_id: string
  gateway?: string // authoritative (sessions-meta enrichment); absent on older daemons → derive
  /** Daemon-generated session title. Absent on older daemons, and on sessions too short to
   *  summarise — the display precedence falls through to a first-message snippet for those. */
  title?: string
  created_at: number
  last_active?: number
  message_count: number
  watermark?: number // per-session max rowid (cold-start unread)
  pinned?: boolean // daemon-owned pin (Prometheus#351)
}

interface RawMessage {
  message_id: number
  ordinal: number
  session_id: string
  role: string
  content: string
  content_json: string | null // lossless structured blocks (additive); null on older daemons / legacy rows
  // WHO originated the turn and whether its content is trusted (Prometheus P9.3). Both are emitted
  // by /api/messages (`web/server.py:949-950`) and persisted by session.py. Optional here because
  // an older daemon predating the managed-tasks sprint omits them; the decoder defaults absence to
  // (user, trusted) so a pre-feature daemon does not badge the owner's history as machinery.
  provenance?: string | null
  is_trusted?: boolean | null
  // The client correlation id the daemon recorded for this row (Prometheus#496, audit P9.6). Letting
  // reconcile retire an optimistic row whose WS echo was MISSED — without it, only the live echo
  // could re-key, and a dropped echo stranded the duplicate forever. Absent on an older daemon.
  client_msg_id?: string | null
  timestamp: number
}

interface RawHistory {
  messages: RawMessage[]
  watermark: number
}


export interface DaemonMessage {
  rowId: number
  ordinal: number
  role: string
  content: string
  /** Raw daemon content_json (JSON string of structured blocks), or null (legacy/older daemon). */
  contentJson?: string | null
  /**
   * WHO originated the turn (Prometheus P9.3): 'user' or a machinery source (compactor,
   * task_supervisor, file_mutation_verifier, …). Absent on a pre-feature daemon. Carried verbatim
   * — @shared/provenance decodes it for display. `role` cannot answer this question.
   */
  provenance?: string | null
  /**
   * Whether the turn's content is trusted, decoded at the wire (absent → true, the daemon's
   * default). false marks content from an untrusted source — visually distinct from the operator's
   * own words.
   */
  isTrusted?: boolean
  /** The daemon-recorded correlation id (Prometheus#496), or null on an older daemon / a row that
   *  never had one (assistant turns, injected turns). Drives optimistic-row retirement in reconcile. */
  clientMsgId?: string | null
  createdAt?: number
}

export interface DaemonHistory {
  messages: DaemonMessage[]
  watermark: number
}

/**
 * Thin REST client for the Prometheus daemon (`:8005`). Lives in the main process. Attaches the
 * optional bearer token (Step-0 survey: the daemon's only auth) as `Authorization: Bearer <token>`;
 * blank token → no-auth mode (works against a tokenless daemon).
 *
 * Every non-2xx throws `HTTP <status>: <METHOD> <path>` so httpStatusFromError/isAuthError can
 * classify ANY rest failure (the 401-everywhere contract) — keep that prefix on new endpoints.
 */
export class RestClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string | null = null,
    /** Whether this address may be used at all (src/main/plain-public.ts): the words to refuse with, or null. Every request waits for
     *  it, so a plain connection to the internet sends nothing, the key least of all. */
    private readonly gate: Promise<string | null> = Promise.resolve(null)
  ) {}

  /**
   * Every request of this client: after the gate, never before it, and only to this client's own Prometheus.
   *
   * A redirect is not followed by fetch (docs/MULTI-PROMETHEUS.md §8): one to another origin fails the call, so neither the key nor
   * the body (a 307 re-sends it: a message for this Prometheus) reaches anything else. One within the origin (a trailing slash) is
   * followed once, by hand, with the same request.
   */
  private async send(url: string, init?: RequestInit): Promise<Response> {
    const refused = await this.gate
    if (refused) throw new Error(refused)
    if (!sameOrigin(url, this.apiBase)) throw new Error(`refused: ${originOf(url) ?? 'that address'} is not this Prometheus`)
    const res = await fetch(url, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status > 399 || !res.headers.get('location')) return res
    const next = new URL(res.headers.get('location')!, url).toString()
    if (!sameOrigin(next, this.apiBase)) {
      throw new Error(`HTTP ${res.status}: redirect to another address (${originOf(next) ?? 'unknown'}) refused; nothing was sent there`)
    }
    return fetch(next, { ...init, redirect: 'error' })
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  /** POST /api/chat/send — carries client_msg_id so the WS echo can correlate it to the rowid. */
  async sendChat(
    sessionId: string,
    message: string,
    idempotencyKey: string,
    clientMsgId?: string,
    mode?: 'agent' | 'chat',
    forceSearch?: boolean,
    references?: ChatReference[]
  ): Promise<ChatSendResult> {
    const res = await this.send(`${this.apiBase}/api/chat/send`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        session_id: sessionId,
        message,
        idempotency_key: idempotencyKey,
        ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
        // Composer-controls: only 'chat' is sent; 'agent'/absent omits mode (byte-identical).
        ...(mode === 'chat' ? { mode } : {}),
        // Force-search: only an armed toggle adds tool_choice (Prometheus #76/#77);
        // absent/false emits no field at all (byte-identical default send).
        ...(forceSearch ? { tool_choice: { tool: 'web_search' } } : {}),
        // @-references (Prometheus PR 382): only a non-empty list adds the field (byte-identical default).
        ...(references && references.length > 0 ? { references } : {})
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: POST /api/chat/send — ${await safeText(res)}`)
    const data = (await res.json()) as { run_id?: string; status?: string }
    return { runId: data.run_id ?? idempotencyKey, status: data.status ?? 'sent' }
  }

  /** POST /api/chat/interrupt — the Stop button (P9.1). HTTP twin of the WS `interrupt` frame.
   *  Returns the daemon's own outcome: `stopped:false` when no turn was running is the documented
   *  idempotent case, NOT an error. The visible terminal state arrives separately, on the
   *  broadcast `chat_done{interrupted:true}` every client receives. */
  async interruptChat(sessionId: string): Promise<ChatInterruptResult> {
    const res = await this.send(`${this.apiBase}/api/chat/interrupt`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: POST /api/chat/interrupt — ${await safeText(res)}`)
    const data = (await res.json()) as { stopped?: boolean }
    return { stopped: data.stopped === true }
  }

  /** POST /api/computer/tasks/{task_id}/stop — the REST twin of the WS `computer_task_stop` frame
   *  (Prometheus#663), used when the socket is not open. Never refused to an authenticated client.
   *  `stopped:false` means nothing was running under that id, which is an answer, not an error. */
  async stopComputerTask(taskId: string): Promise<{ stopped: boolean }> {
    const res = await this.send(`${this.apiBase}/api/computer/tasks/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: '{}',
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: POST /api/computer/tasks/{id}/stop — ${await safeText(res)}`)
    const data = (await res.json()) as { stopped?: boolean }
    return { stopped: data.stopped === true }
  }

  // ── the desktop door (v1.1 PR 7) ────────────────────────────────────────
  // Five routes that START or CONSENT to a desktop task. Unlike stopComputerTask
  // above, these do NOT throw on a non-2xx: the door's refusals are structured
  // ({error, detail, options, describes, app}) and the UI both renders `detail`
  // verbatim and branches on `error` — `needs_app` opens the picker rather than
  // showing an error. Throwing the body away, as an Error message would, loses
  // exactly the thing the daemon wrote for the person. So each returns a
  // DoorOutcome and the shared helper parses the body either way.
  //
  // All five are person-only on the daemon (W3/D15): the global token gets 401.
  // Beacon authenticates with its device credential, so these are the routes
  // that fail if this device is not marked for computer use — a refusal the UI
  // must show, not retry into.

  /** One door call: fetch, parse the body whether or not it is ok, and classify.
   *  A network failure is a refusal with code `network`, never a thrown error —
   *  the caller renders it the same way as a daemon refusal. */
  private async door<T>(method: string, path: string, body?: unknown): Promise<DoorOutcome<T>> {
    let res: Response
    try {
      res = await this.send(`${this.apiBase}${path}`, {
        method,
        headers: this.headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      return { ok: false, refusal: doorRefusal(0, { error: 'network' }) }
    }
    // The daemon answers JSON on both paths; parse defensively because a proxy
    // or a 502 may return an HTML error page with no JSON in it.
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    if (res.ok) return { ok: true, value: parsed as T }
    return { ok: false, refusal: doorRefusal(res.status, parsed) }
  }

  /** GET /api/computer/apps — the picker's rows: running apps with an on-screen window. */
  listComputerApps(): Promise<DoorOutcome<{ apps?: string[] }>> {
    return this.door('GET', '/api/computer/apps')
  }

  /** GET /api/sessions/{id}/computer — this conversation's binding, or `{state:'off'}`. */
  getComputerBinding(sessionId: string): Promise<DoorOutcome<BindingWire>> {
    return this.door('GET', `/api/sessions/${encodeURIComponent(sessionId)}/computer`)
  }

  /** PUT /api/sessions/{id}/computer — pick the app; the pick IS the consent. */
  setComputerBinding(sessionId: string, app: string): Promise<DoorOutcome<BindingWire>> {
    return this.door('PUT', `/api/sessions/${encodeURIComponent(sessionId)}/computer`, { app })
  }

  /** DELETE /api/sessions/{id}/computer — clear the pick and stop any task in this session. */
  clearComputerBinding(sessionId: string): Promise<DoorOutcome<BindingWire>> {
    return this.door('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}/computer`)
  }

  /** POST /api/computer/tasks — start a task. Returns the task id at once (202); the steps then
   *  arrive as `computer_*` frames, which the gateway store already folds (#194). */
  startComputerTask(body: Record<string, string>): Promise<DoorOutcome<{ task_id?: string }>> {
    return this.door('POST', '/api/computer/tasks', body)
  }

  /** GET /api/sessions — consumes the daemon's authoritative gateway + per-session watermark. */
  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.send(`${this.apiBase}/api/sessions`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/sessions`)
    const raw = (await res.json()) as RawSession[]
    return raw.map((s) => ({
      id: s.session_id,
      // The daemon's OWN title, not the id. This line read `title: s.session_id` — so the
      // "daemon's session_id echo" that the cache layer documented and worked around was
      // manufactured HERE, at the wire boundary, by discarding the field and substituting the id.
      // Downstream then reasonably concluded the daemon had nothing to offer.
      // Undefined for sessions the daemon could not title (too short to summarise); the display
      // precedence in sessionDisplayTitle falls through to a first-message snippet for those.
      title: s.title,
      gateway: s.gateway, // authoritative; undefined falls back to id-prefix in the service
      messageCount: s.message_count,
      lastActive: s.last_active ? s.last_active * 1000 : s.created_at ? s.created_at * 1000 : undefined,
      watermark: s.watermark,
      // Carried, not dropped. The comment above records what happened the last time a field was
      // discarded at this boundary: downstream concluded the daemon had nothing to offer.
      pinned: pinnedFromWire(s.pinned)
    }))
  }

  /** GET /api/sessions/{id}/messages?since=<rowid> — durable-contract incremental read. */
  async fetchHistory(sessionId: string, sinceRowid = 0): Promise<DaemonHistory> {
    const qs = sinceRowid > 0 ? `?since=${sinceRowid}` : ''
    const res = await this.send(`${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}/messages${qs}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/sessions/${sessionId}/messages`)
    const raw = (await res.json()) as RawHistory
    return {
      watermark: raw.watermark ?? 0,
      messages: (raw.messages ?? []).map((m) => ({
        rowId: m.message_id,
        ordinal: m.ordinal,
        role: m.role,
        content: extractText(m.content),
        contentJson: m.content_json ?? null, // raw JSON — adapted to ContentPart[] in the renderer
        // Carried through, not dropped (Prometheus P9.3). is_trusted is decoded here so a string
        // 'false' or number 0 on the wire cannot flip it; provenance stays verbatim for the
        // shared decoder downstream.
        provenance: m.provenance ?? null,
        isTrusted: isTrustedFromWire(m.is_trusted),
        clientMsgId: m.client_msg_id ?? null,
        createdAt: m.timestamp ? m.timestamp * 1000 : undefined
      }))
    }
  }

  /**
   * GET /api/approvals — the daemon's GLOBAL pending-approval queue.
   *
   * MAPS VIA @shared/approval-push, the SAME function the WS push path uses. This method used to
   * snake→camel these fields inline, a second implementation of one contract, while two docstrings
   * claimed there was only one. They did not agree:
   *
   *   - `toolName: a.tool_name` with no fallback → `undefined` reached the card and rendered as
   *     the literal string "undefined"; rawToApproval yields 'tool'.
   *   - `description: a.description` with no fallback → same; rawToApproval yields ''.
   *   - a missing `request_id` emitted a row with `requestId: undefined`; rawToApproval drops it.
   *
   * The push path is the one that lands FIRST and that the operator can answer with the one-key
   * `A`, so any field the poll mapper knew about and the push mapper did not was invisible for up
   * to a full 3s poll interval — precisely the window push exists to close. One mapper removes the
   * class.
   *
   * THE DROP IS DELIBERATE, AND IT IS LOGGED. Adopting rawToApproval means the poll can now return
   * FEWER rows than the daemon sent. That is a real hazard on the reconciling path — the poll is
   * what clears ghosts, so a row it silently discards is a row no surface ever mentions again.
   * It is still the lesser harm: a row with no `request_id` cannot be ANSWERED (every resolve
   * POSTs to /api/approvals/<id>/approve, so an absent id 404s while the poll re-renders the card
   * every 3s), it inflates the OS dock badge with a count the operator cannot clear, and it
   * collides in React's reconciler because the card is keyed by requestId. So: drop it, and say so
   * out loud. `console.warn` on the transition — not on every poll — because a malformed daemon is
   * a standing condition and a 3s log would bury the signal it is meant to be.
   */
  async listApprovals(): Promise<ApprovalRequest[]> {
    const res = await this.send(`${this.apiBase}/api/approvals`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/approvals`)
    const raw = (await res.json()) as RawApprovalPush[]
    const mapped = raw.map((a) => rawToApproval(a))
    const kept = mapped.filter((a): a is ApprovalRequest => a !== null)
    this.noteDroppedApprovals(raw.length - kept.length)
    return kept
  }

  /**
   * Report unanswerable approval rows the mapper dropped, once per change in the number dropped.
   *
   * Deduped on the COUNT rather than logged unconditionally: listApprovals runs every 3 seconds
   * for the life of the process, so an unconditional warn would emit ~1200 identical lines an hour
   * and make the log useless for the thing it is reporting. A transition (0 → n, n → m, n → 0) is
   * the part that carries information. The recovery line matters too — without it the log would
   * show a problem starting and never show it stopping.
   */
  private lastDroppedApprovals = 0
  private noteDroppedApprovals(dropped: number): void {
    if (dropped === this.lastDroppedApprovals) return
    if (dropped > 0) {
      console.warn(
        `[rest] GET /api/approvals: dropped ${dropped} pending row(s) with no usable request_id — ` +
          'unanswerable (resolve would 404) so they are not shown; the daemon may still be blocked on them'
      )
    } else {
      console.warn('[rest] GET /api/approvals: no longer dropping rows — every pending row carries a request_id again')
    }
    this.lastDroppedApprovals = dropped
  }

  /**
   * POST /api/approvals/{id}/approve — with `{"scope": <verb>}`; or .../deny, which takes no body.
   *
   * The scope string is the extent KEY, forwarded untouched. Beacon validates nothing: the
   * daemon's `normalise_scope` is the sole authority on the verb vocabulary. If the two ever
   * drift, the daemon returns 400 and the RESPONSE BODY is carried into the thrown Error so the
   * operator sees the daemon's own list — which is the only thing that would reveal the drift.
   */
  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const verb = decision.kind === 'approve' ? 'approve' : 'deny'
    const res = await this.send(`${this.apiBase}/api/approvals/${encodeURIComponent(requestId)}/${verb}`, {
      method: 'POST',
      headers:
        decision.kind === 'approve'
          ? { ...this.headers(), 'Content-Type': 'application/json' }
          : this.headers(),
      body: decision.kind === 'approve' ? JSON.stringify({ scope: decision.scope }) : undefined,
      signal: AbortSignal.timeout(8_000)
    })
    // The refusal's code goes in the message (`HTTP 401 [not_a_person]: …`): the card answers a worker's request this Beacon may not
    // approve with a line of its own, and the body below is cut to 200 characters, which can cut the code off.
    if (!res.ok) {
      const text = await fullText(res)
      const code = refusalCode(text)
      throw new Error(`HTTP ${res.status}${code ? ` [${code}]` : ''}: POST /api/approvals/${requestId}/${verb} — ${text.slice(0, 200)}`)
    }
  }

  /** DELETE /api/sessions/{id} — "forget": the daemon drops the in-memory session so it stops
   * being listed by GET /api/sessions. Durable LCM history is append-only and left intact. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.send(`${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: DELETE /api/sessions/${sessionId} — ${await safeText(res)}`)
  }

  /** GET /api/events/recent?limit= — the daemon's durable signal_events tail (activity backfill). */
  async listRecentEvents(limit = 50): Promise<EventRow[]> {
    const res = await this.send(`${this.apiBase}/api/events/recent?limit=${encodeURIComponent(String(limit))}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/events/recent`)
    return (await res.json()) as EventRow[]
  }

  /** Scoped generic read: GET any same-origin /api/ path for the read-only panels. Path-guarded. */
  async getDaemon(path: string): Promise<unknown> {
    if (!isAllowedDaemonPath(path)) throw new Error(`blocked daemon path: ${path}`)
    const res = await this.send(`${this.apiBase}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET ${path} — ${await safeText(res)}`)
    return res.json()
  }

  /** GET /api/artifacts — the daemon outbox manifest (feat/artifacts-api). 404 on older daemons
   * surfaces as a throw; the caller treats any failure as "no artifacts" (feature detection). */
  async listArtifacts(): Promise<ArtifactEntry[]> {
    const res = await this.send(`${this.apiBase}/api/artifacts`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/artifacts — ${await safeText(res)}`)
    const body = (await res.json()) as { artifacts?: ArtifactEntry[] }
    return Array.isArray(body.artifacts) ? body.artifacts : []
  }

  /** GET /api/artifacts/{id} — the deliverable's bytes, by content id (never a path). Size-capped
   * client-side as well as daemon-side; the cap is a delivery-tray guard, not a streaming design. */
  async downloadArtifact(id: string): Promise<Buffer> {
    const res = await this.send(`${this.apiBase}/api/artifacts/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/artifacts/${id} — ${await safeText(res)}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > ARTIFACT_MAX_BYTES) throw new Error(`artifact too large (${declared} bytes > ${ARTIFACT_MAX_BYTES})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > ARTIFACT_MAX_BYTES) throw new Error(`artifact too large (${buf.byteLength} bytes > ${ARTIFACT_MAX_BYTES})`)
    return buf
  }

  /** Stored-media bytes by reference (Prometheus 343, Beacon B3): GET /api/media?path= with the
   * daemon's sniffed content type passed through. Same ceiling as artifacts — a runaway file must
   * not buffer main into the ground. The daemon path-confines source_path; a 403/404 throws and
   * the caller degrades to the description placeholder. */
  async fetchMedia(sourcePath: string): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.send(`${this.apiBase}/api/media?path=${encodeURIComponent(sourcePath)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET /api/media — ${await safeText(res)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > ARTIFACT_MAX_BYTES) throw new Error(`media too large (${buf.byteLength} bytes)`)
    return { bytes: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /** Scoped generic write: POST/PUT/DELETE/PATCH any same-origin /api/ path. Same path-allowlist as
   * the reads (writes still hit /api/…). Attaches the bearer; serializes `body` as JSON when provided
   * (with the matching Content-Type). Returns the parsed JSON response, or null on an empty body. */
  async writeDaemon(path: string, body?: unknown, method: DaemonWriteMethod = 'POST'): Promise<unknown> {
    if (!isAllowedDaemonPath(path)) throw new Error(`blocked daemon path: ${path}`)
    const hasBody = body !== undefined
    const res = await this.send(`${this.apiBase}${path}`, {
      method,
      headers: this.headers(hasBody ? { 'Content-Type': 'application/json' } : undefined),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${method} ${path} — ${await safeText(res)}`)
    if (res.status === 204) return null
    return res.json().catch(() => null)
  }

  /** GET /api/pair/requests: who is waiting for this Prometheus's owner to say yes. Owner only; a device that was itself approved is told 403. */
  async listPairRequests(): Promise<PairListReply> {
    const res = await this.send(`${this.apiBase}/api/pair/requests`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) })
    const date = Date.parse(res.headers.get('date') ?? '')
    return { status: res.status, body: await res.json().catch(() => null), serverNowSec: Number.isFinite(date) ? Math.floor(date / 1000) : null }
  }

  /** POST /api/pair/requests/{id}/approve | deny. The id is checked here too, so nothing but a request id can become part of the path. */
  async decidePairRequest(requestId: string, verb: 'approve' | 'deny', body?: Record<string, unknown>): Promise<{ status: number }> {
    if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error('not a request id')
    const res = await this.send(`${this.apiBase}/api/pair/requests/${requestId}/${verb}`, {
      method: 'POST',
      headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8_000)
    })
    await res.arrayBuffer().catch(() => undefined)
    return { status: res.status }
  }
}

/** The owner's side of joining (docs/PAIRING-APPROVAL-API.md, 4.2b). The HTTP status is RETURNED, not thrown: whether a 401 or a 403 means
 *  "stop asking" is the watcher's decision. Only a failure to reach the computer throws. */
export interface PairListReply {
  status: number
  body: unknown
  /** The daemon's own clock (its Date header, whole seconds), or null. */
  serverNowSec: number | null
}

async function safeText(res: Response): Promise<string> {
  return (await fullText(res)).slice(0, 200)
}
async function fullText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
