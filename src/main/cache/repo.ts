import { randomUUID } from 'node:crypto'
import type { CacheDb } from './db'
import { forceSearchSendField, modeSendField, type ChatMode } from '@shared/composer-controls'
import { SOCKET_LOG_MAX_ROWS, type SocketEvent } from '@shared/socket-log'
import { WATCHDOG_LOG_MAX_ROWS, type WatchdogEvent } from '@shared/watchdog-log'
import { UI_TRACE_MAX_ROWS, type UiTraceEvent } from '@shared/ui-trace'

export interface MessageRow {
  id: string
  session_id: string
  row_id: number | null
  ordinal: number | null
  role: string
  content: string | null
  content_json: string | null
  provenance: string | null
  is_trusted: number | null
  tool_calls: string | null
  created_at: number
  client_msg_id: string | null
}

export interface OutboxRow {
  id: string
  session_id: string
  payload: string
  status: string
  attempts: number
  created_at: number
  message_id: string | null
}

export interface SessionRow {
  id: string
  gateway: string | null
  title: string | null
  last_active: number | null
  message_count: number
  watermark: number
  /** 0/1 from SQLite. Daemon-owned (Prometheus#351); cached so a pin survives an offline start. */
  pinned?: number
}

/** A daemon-authoritative message (from REST history) keyed by its durable rowid. */
export interface CanonicalMessage {
  rowId: number
  ordinal: number
  role: string
  content: string
  /** Raw daemon content_json (structured blocks), or null/undefined (legacy/older daemon). */
  contentJson?: string | null
  /** WHO originated the turn (Prometheus P9.3); null/undefined = legacy, reads as 'user'. */
  provenance?: string | null
  /** Whether the content is trusted; undefined = legacy, reads as trusted. Stored 0/1. */
  isTrusted?: boolean
  /** Daemon-recorded correlation id (Prometheus#496). null/undefined = none; lets reconcile retire
   *  an optimistic row whose WS echo was missed (audit P9.6). */
  clientMsgId?: string | null
  createdAt?: number
}

export interface ReconcileStats {
  sessionId: string
  pulled: number
  inserted: number
  updated: number
  fromWatermark: number
  toWatermark: number
}

/**
 * All cache reads/writes. The daemon is the source of truth; this never invents history.
 * Step 4: keyed by the durable rowid (`messages.row_id`), re-keyed from optimistic by
 * client_msg_id (NO content matching), reconciled by a rowid cursor.
 */
export class CacheRepo {
  constructor(private readonly db: CacheDb) {}

  // ── sessions ───────────────────────────────────────────────────────────────
  ensureSession(id: string, gateway?: string, title?: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, gateway, title, last_active)
         VALUES (@id, @gateway, @title, @ts)
         ON CONFLICT(id) DO UPDATE SET
           gateway = COALESCE(excluded.gateway, sessions.gateway),
           title   = COALESCE(excluded.title, sessions.title),
           last_active = excluded.last_active`
      )
      .run({ id, gateway: gateway ?? null, title: title ?? null, ts: Date.now() })
  }

  /** The session's known high-water rowid — drives the cold-start UNREAD dot. NOT the reconcile
   * cursor: the sessions-list upsert advances this from the daemon's reported watermark, so it can
   * run AHEAD of what's actually cached (see getMaxMessageRowId). */
  getSessionWatermark(sessionId: string): number {
    const row = this.db.prepare(`SELECT watermark FROM sessions WHERE id = ?`).get(sessionId) as
      | { watermark: number | null }
      | undefined
    return row?.watermark ?? 0
  }

  /** The TRUE reconcile cursor (?since=): the highest rowid actually CACHED for the session.
   * 0 = nothing cached → full fetch. Using the watermark column here made a never-cached session
   * render empty forever — the daemon list had already pushed its high-water mark into the column,
   * so the first reconcile asked for ?since=<max> and pulled nothing (live-walk finding, 2026-06-10;
   * pre-existing on main for any fresh install). */
  getMaxMessageRowId(sessionId: string): number {
    const row = this.db.prepare(`SELECT MAX(row_id) AS m FROM messages WHERE session_id = ?`).get(sessionId) as
      | { m: number | null }
      | undefined
    return row?.m ?? 0
  }

  private bumpWatermark(sessionId: string, rowId: number): void {
    this.db
      .prepare(`UPDATE sessions SET watermark = MAX(COALESCE(watermark, 0), @r), last_active = @ts WHERE id = @id`)
      .run({ id: sessionId, r: rowId, ts: Date.now() })
  }

  /** All cached sessions, most-recently-active first (the durable sidebar list). */
  getSessions(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY (last_active IS NULL), last_active DESC, id`)
      .all() as SessionRow[]
  }

  /** session_id → a stamp that changes whenever that session's cached messages do (max rowid and
   * row count). The project-hint memo re-reads a session only when its stamp moved. */
  messageStamps(): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT session_id AS sid, COALESCE(MAX(row_id), 0) AS m, COUNT(*) AS n FROM messages GROUP BY session_id`)
      .all() as Array<{ sid: string; m: number; n: number }>
    return new Map(rows.map((r) => [r.sid, `${r.m}:${r.n}`]))
  }

  /** The `input` of every tool_use block in one session's cached messages, as JSON text. SQLite's
   * JSON1 picks the blocks out, so a tool_result carrying a whole file is never parsed here. Only
   * object elements whose own `type` is tool_use are read: json_extract on a bare string element
   * THROWS, and one such row would fail every hint. (An object row, not an array, falls out of
   * the same two conditions: its members are not tool_use blocks.) */
  toolUseInputs(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(j.value, '$.input') AS input
         FROM messages m, json_each(m.content_json) j
         WHERE m.session_id = ?
           AND m.content_json LIKE '%"tool_use"%'
           AND json_valid(m.content_json)
           AND j.type = 'object'
           AND json_extract(j.value, '$.type') = 'tool_use'`
      )
      .all(sessionId) as Array<{ input: string | null }>
    const out: string[] = []
    for (const r of rows) if (typeof r.input === 'string' && r.input) out.push(r.input)
    return out
  }

  /** session_id → first confirmed user message content — the auto-title source ("name sessions by
   * what's inside"). Confirmed rows only (row_id set); optimistic-only sessions title up on echo. */
  firstUserSnippets(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT m.session_id AS sid, m.content AS content
         FROM messages m
         WHERE m.role = 'user' AND m.row_id IS NOT NULL AND TRIM(COALESCE(m.content, '')) != ''
           AND m.row_id = (
             SELECT MIN(row_id) FROM messages
             WHERE session_id = m.session_id AND role = 'user' AND row_id IS NOT NULL
               AND TRIM(COALESCE(content, '')) != ''
           )`
      )
      .all() as { sid: string; content: string }[]
    return new Map(rows.map((r) => [r.sid, r.content]))
  }

  /** Merge daemon session-list metadata into the cache, INCLUDING the per-session watermark
   * (max rowid) from the sessions-meta endpoint — this is what makes cold-start unread work for
   * listed sessions (watermark advances even before that session's messages are reconciled). */
  upsertSessionMeta(
    id: string,
    gateway: string,
    /** null = the daemon has no title for this session. NOT the id — writing the id here is what
     *  made a placeholder indistinguishable from a real title. */
    title: string | null,
    lastActiveMs: number,
    messageCount: number,
    watermark: number,
    /** Optional so the six-arg callers (smokes) keep compiling. The daemon list always passes it. */
    pinned = false
  ): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, gateway, title, last_active, message_count, watermark, pinned)
         VALUES (@id, @gw, @title, @la, @mc, @wm, @pin)
         ON CONFLICT(id) DO UPDATE SET
           gateway = COALESCE(excluded.gateway, sessions.gateway),
           -- INCOMING wins. This read COALESCE(sessions.title, excluded.title) -- existing
           -- first — so once a value landed it could never be corrected, and every cache that
           -- had stored a session id as its title kept showing the id forever even after the
           -- daemon started serving real ones. A NULL incoming still keeps what is there, so
           -- "the daemon has nothing to say" never erases a good title.
           -- (ensureSession above already used this order; the two writers disagreed.)
           title = COALESCE(excluded.title, sessions.title),
           last_active = MAX(COALESCE(sessions.last_active, 0), excluded.last_active),
           message_count = excluded.message_count,
           watermark = MAX(COALESCE(sessions.watermark, 0), excluded.watermark),
           -- INCOMING wins outright, and deliberately NOT a MAX/COALESCE: the daemon owns this
           -- value, so an unpin (1 -> 0) has to be able to travel. MAX would make a pin permanent.
           pinned = excluded.pinned`
      )
      .run({ id, gw: gateway, title, la: lastActiveMs, mc: messageCount, wm: watermark, pin: pinned ? 1 : 0 })
  }

  /** Forget a session locally: drop its messages, any queued outbox rows, and the session row
   * itself — in ONE transaction so the sidebar never shows a half-deleted session. `messages`
   * would cascade on the session delete (FK ON DELETE CASCADE), but `outbox` has no FK, so all
   * three deletes are explicit and order-independent. Idempotent: a no-op for an unknown id. */
  deleteSession(sessionId: string): void {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id)
      this.db.prepare(`DELETE FROM outbox WHERE session_id = ?`).run(id)
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
    })
    tx(sessionId)
  }

  /** The default gateway profile (set at first-run setup), or null on a fresh install. */
  getDefaultGatewayProfile(): { name: string; apiBase: string; wsUrl: string; pin: string | null } | null {
    const r = this.db
      .prepare(`SELECT name, api_base, ws_url, pin FROM gateway_profiles WHERE is_default = 1 ORDER BY name LIMIT 1`)
      .get() as { name: string; api_base: string; ws_url: string; pin: string | null } | undefined
    return r ? { name: r.name, apiBase: r.api_base, wsUrl: r.ws_url, pin: r.pin ?? null } : null
  }

  // ── messages ───────────────────────────────────────────────────────────────
  /** Confirmed rows in rowid order (durable, monotonic); optimistic rows (row_id NULL) last. */
  getMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ?
         ORDER BY (row_id IS NULL), row_id, created_at`
      )
      .all(sessionId) as MessageRow[]
  }

  getById(sessionId: string, id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE session_id = ? AND id = ?`).get(sessionId, id) as
      | MessageRow
      | undefined
  }

  /** Count rows with this exact content — used ONLY by the smoke to prove content-dedup is dead. */
  countByContent(sessionId: string, role: string, content: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = ? AND content = ?`)
      .get(sessionId, role, content) as { n: number }
    return row.n
  }

  // ── outbox (write-behind) ────────────────────────────────────────────────────
  /** Render an optimistic message immediately (every send, online or offline). Returns its
   * local id; the WS echo re-keys it to the rowid by client_msg_id. */
  addOptimisticMessage(sessionId: string, role: string, content: string, clientMsgId: string): string {
    const id = `local-${randomUUID()}`
    this.ensureSession(sessionId)
    this.insertOptimistic(id, sessionId, role, content, clientMsgId)
    return id
  }

  /** Drop an optimistic row that will never be echoed — a send the daemon REFUSED (e.g. an
   *  @-reference it would not resolve). Leaving it would render as a sent message that was not. */
  removeOptimisticMessage(sessionId: string, id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ? AND id = ? AND row_id IS NULL').run(sessionId, id)
  }

  /** Queue an outbox row for an EXISTING optimistic message (offline, or an online-send that
   * failed in flight). Links to the optimistic row by its local id so the drain can confirm it. */
  attachOutbox(
    sessionId: string,
    message: string,
    idempotencyKey: string,
    clientMsgId: string,
    optimisticId: string,
    mode?: ChatMode,
    forceSearch?: boolean
  ): string {
    const outboxId = randomUUID()
    this.db
      .prepare(
        `INSERT INTO outbox (id, session_id, payload, status, attempts, created_at, message_id)
         VALUES (@id, @session, @payload, 'pending', 0, @ts, @msgId)`
      )
      .run({
        id: outboxId,
        session: sessionId,
        // Carry the per-message mode AND force-search so an offline-queued send replays exactly
        // as composed (mode-honest). Both helpers omit their field on the default → byte-identical
        // to pre-mode/pre-force rows.
        payload: JSON.stringify({
          message,
          idempotency_key: idempotencyKey,
          client_msg_id: clientMsgId,
          ...modeSendField(mode ?? 'agent'),
          ...forceSearchSendField(forceSearch ?? false, mode ?? 'agent')
        }),
        ts: Date.now(),
        msgId: optimisticId
      })
    return outboxId
  }

  private insertOptimistic(id: string, sessionId: string, role: string, content: string, clientMsgId: string): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, id, row_id, ordinal, role, content, tool_calls, created_at, client_msg_id)
         VALUES (@s, @id, NULL, NULL, @role, @content, NULL, @ts, @cmid)
         ON CONFLICT(session_id, id) DO NOTHING`
      )
      .run({ s: sessionId, id, role, content, ts: Date.now(), cmid: clientMsgId })
  }

  getPendingOutbox(): OutboxRow[] {
    return this.db.prepare(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at`).all() as OutboxRow[]
  }

  markOutbox(id: string, status: string, attempts: number): void {
    this.db.prepare(`UPDATE outbox SET status = @status, attempts = @attempts WHERE id = @id`).run({ id, status, attempts })
  }

  outboxStatus(): { pending: number; failed: number; sent: number; confirmed: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM outbox GROUP BY status`).all() as Array<{
      status: string
      n: number
    }>
    const out = { pending: 0, failed: 0, sent: 0, confirmed: 0 }
    for (const r of rows) if (r.status in out) (out as Record<string, number>)[r.status] = r.n
    return out
  }

  /**
   * Drop the optimistic row for a slash command the daemon has just answered TRANSIENTLY.
   *
   * WHY THIS EXISTS. A slash command is not a turn and the daemon persists neither side of it.
   * Captured off the wire (live-frames.json, /help):
   *
   *   chat_message  role=user   message_id="cmd-user-<ms>"  client_msg_id=null  transient=true
   *   chat_message  role=asst   message_id="cmd-asst-<ms>"  transient=true  command=true
   *   command_done  command_name="help"  transient=true
   *
   * The user echo carries `client_msg_id: null` and a STRING id, so `relinkByClientMsgId` — which
   * requires both a client_msg_id and a numeric rowid — never matches, and the optimistic row is
   * left in the cache with `row_id IS NULL` forever. `getMessages` sorts null-rowid rows last, so
   * every reload re-renders that command at the BOTTOM of the thread, looking like the newest
   * message in the conversation, with no reply beside it (the reply was transient and never
   * stored). Found in the wild 2026-08-25: a `/reset` typed on the 23rd reappearing as the newest
   * message, two days later, alarming enough to look like the app had reset itself.
   *
   * Keyed on the command NAME from the daemon's own `command_done`, not on a content guess and not
   * on the catalog, so an unlisted command (`/qwen`) is covered and a real message in flight beside
   * it — a `/steer` during a live turn — is never touched.
   *
   * An outbox-backed row is left alone: that one is genuinely undelivered and still owed a retry,
   * which is the opposite of a phantom.
   */
  dropTransientCommandRow(sessionId: string, commandName: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM messages
          WHERE session_id = @s
            AND row_id IS NULL
            AND role = 'user'
            AND (content = @slash OR content LIKE @slashArgs)
            AND id NOT IN (
              SELECT message_id FROM outbox
               WHERE session_id = @s AND message_id IS NOT NULL AND status IN ('pending', 'failed')
            )`
      )
      .run({ s: sessionId, slash: `/${commandName}`, slashArgs: `/${commandName} %` })
    return res.changes
  }

  // ── live re-key by client_msg_id (DETERMINISTIC — content-dedup retired) ──────
  /**
   * Resolve the WS user echo `{client_msg_id, message_id: rowId}` against the optimistic row.
   * No content matching anywhere — purely by client_msg_id, so identical-content sends stay
   * distinct.
   *   - optimistic found, canonical absent → re-key local-<uuid> → str(rowId).
   *   - optimistic found, canonical already present (reconcile beat the echo) → drop the
   *     redundant optimistic row.
   *   - no optimistic (echo for a send we didn't originate) → insert the confirmed row.
   */
  relinkByClientMsgId(
    sessionId: string,
    clientMsgId: string,
    rowId: number,
    ordinal: number,
    role: string,
    content: string,
    createdAt?: number
  ): 'relinked' | 'merged' | 'inserted' {
    const canonicalId = String(rowId)
    const optimistic = this.db
      .prepare(
        `SELECT id FROM messages WHERE session_id = @s AND client_msg_id = @c AND row_id IS NULL
         ORDER BY created_at LIMIT 1`
      )
      .get({ s: sessionId, c: clientMsgId }) as { id: string } | undefined
    const canonicalExists = !!this.getById(sessionId, canonicalId)

    let result: 'relinked' | 'merged' | 'inserted'
    if (optimistic) {
      if (canonicalExists) {
        this.db.prepare(`DELETE FROM messages WHERE session_id = @s AND id = @old`).run({ s: sessionId, old: optimistic.id })
        result = 'merged'
      } else {
        this.db
          .prepare(`UPDATE messages SET id = @new, row_id = @rid, ordinal = @ord WHERE session_id = @s AND id = @old`)
          .run({ s: sessionId, new: canonicalId, rid: rowId, ord: ordinal, old: optimistic.id })
        result = 'relinked'
      }
      this.db
        .prepare(`UPDATE outbox SET status = 'confirmed', message_id = @new WHERE message_id = @old`)
        .run({ new: canonicalId, old: optimistic.id })
    } else if (!canonicalExists) {
      this.insertConfirmed(sessionId, rowId, ordinal, role, content, createdAt)
      result = 'inserted'
    } else {
      result = 'merged'
    }

    this.bumpWatermark(sessionId, rowId)
    return result
  }

  // ── reconcile (read-through, rowid cursor) ───────────────────────────────────
  /** Upsert the daemon's authoritative delta (rowId > cursor) by rowid. Idempotent. */
  reconcileSession(sessionId: string, messages: CanonicalMessage[], watermark: number): ReconcileStats {
    const fromWatermark = this.getSessionWatermark(sessionId)
    let inserted = 0
    let updated = 0

    const tx = this.db.transaction(() => {
      this.ensureSession(sessionId)
      for (const m of messages) {
        if (this.ingestCanonical(sessionId, m.rowId, m.ordinal, m.role, m.content, m.createdAt, m.contentJson, m.provenance, m.isTrusted, m.clientMsgId) === 'inserted') inserted++
        else updated++
      }
      // Advance the cursor to the daemon's reported high-water mark (covers the empty-delta case).
      this.bumpWatermark(sessionId, Math.max(watermark, fromWatermark))
    })
    tx()

    return { sessionId, pulled: messages.length, inserted, updated, fromWatermark, toWatermark: this.getSessionWatermark(sessionId) }
  }

  private ingestCanonical(
    sessionId: string,
    rowId: number,
    ordinal: number,
    role: string,
    content: string,
    createdAt?: number,
    contentJson?: string | null,
    provenance?: string | null,
    isTrusted?: boolean,
    clientMsgId?: string | null
  ): 'inserted' | 'updated' {
    const canonicalId = String(rowId)
    const exists = !!this.getById(sessionId, canonicalId)
    this.insertConfirmed(sessionId, rowId, ordinal, role, content, createdAt, contentJson, provenance, isTrusted)
    // Retire an optimistic row whose live WS echo was MISSED (audit P9.6 / Prometheus#496). The
    // confirmed row is now present under str(rowId); any still-pending optimistic row carrying the
    // SAME client_msg_id is the duplicate this exists to drop. relinkByClientMsgId does this for the
    // live-echo path; reconcile is the path that runs when the echo never arrived.
    this.retireStrandedOptimistic(sessionId, clientMsgId)
    this.bumpWatermark(sessionId, rowId)
    return exists ? 'updated' : 'inserted'
  }

  /**
   * Drop an optimistic (row_id IS NULL) row that the daemon has now confirmed, matched by
   * client_msg_id — the reconcile-time twin of relinkByClientMsgId's 'merged' branch.
   *
   * No content matching (retired on purpose: two identical sends are legitimately two messages). A
   * null/empty id is a no-op, so assistant turns, injected turns and rows from an older daemon
   * retire nothing.
   *
   * `row_id IS NULL` is what makes this both safe and idempotent, and it is the ONLY condition doing
   * that work: a confirmed row always has row_id set (insertConfirmed writes it) and always has
   * client_msg_id NULL (it is not in the confirmed INSERT), so the row reconcile just wrote cannot
   * match this predicate. Re-reconciling the same row therefore deletes nothing. An earlier version
   * carried an extra `id != canonicalId` guard for this and a comment claiming the guard was the
   * mechanism; mutation-testing it showed removing the guard changed no outcome — it was unreachable,
   * so it is gone rather than left as a control that names the wrong thing.
   */
  private retireStrandedOptimistic(sessionId: string, clientMsgId: string | null | undefined): void {
    if (!clientMsgId) return
    this.db
      .prepare(`DELETE FROM messages WHERE session_id = @s AND client_msg_id = @c AND row_id IS NULL`)
      .run({ s: sessionId, c: clientMsgId })
  }

  /**
   * Guarantee the FK parent for a message write, and NOTHING else.
   *
   * `messages.session_id REFERENCES sessions(id)` with `PRAGMA foreign_keys = ON`, so an insert
   * for a session this desktop never listed throws — and on the live-frame path that throw reached
   * the main process as an uncaught exception and killed the app (handed over by the beacon-ios
   * session 2026-08-30, their DECISIONS D2; on iOS SQLite's default swallowed the same hole).
   * iOS-created sessions fan out here because the desktop subscribes to the firehose for unread
   * state, so an echo for an unlisted session is ordinary, not exotic.
   *
   * INSERT-OR-IGNORE, deliberately NOT ensureSession(): this must not fabricate gateway/title for
   * a session the daemon owns, nor clobber them on one already listed. Ordering is untouched too —
   * `bumpWatermark` sets last_active on the very next line, which is the correct meaning of a live
   * frame ("this session is active"), and belongs to that call rather than to this one.
   */
  private ensureSessionRow(id: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO sessions (id, last_active) VALUES (?, ?)`).run(id, Date.now())
  }

  private insertConfirmed(
    sessionId: string,
    rowId: number,
    ordinal: number,
    role: string,
    content: string,
    createdAt?: number,
    contentJson?: string | null,
    provenance?: string | null,
    isTrusted?: boolean
  ): void {
    // At the choke point, not at one call site: every path that writes a confirmed row is covered,
    // including ones added later (reconcileSession ensures separately and is unaffected).
    this.ensureSessionRow(sessionId)
    this.db
      .prepare(
        `INSERT INTO messages (session_id, id, row_id, ordinal, role, content, content_json, provenance, is_trusted, tool_calls, created_at, client_msg_id)
         VALUES (@s, @id, @rid, @ord, @role, @content, @cj, @prov, @trust, NULL, @ts, NULL)
         ON CONFLICT(session_id, id) DO UPDATE SET
           row_id = excluded.row_id, ordinal = excluded.ordinal, role = excluded.role,
           content = excluded.content, content_json = excluded.content_json,
           provenance = excluded.provenance, is_trusted = excluded.is_trusted`
      )
      .run({
        s: sessionId,
        id: String(rowId),
        rid: rowId,
        ord: ordinal,
        role,
        content,
        cj: contentJson ?? null,
        // Stored verbatim / as 0|1. undefined (legacy daemon, or an optimistic row being confirmed)
        // → NULL, which the read path decodes to (user, trusted) — the daemon's own default, so a
        // pre-#123 cache and the owner's own typed rows both render unbadged.
        prov: provenance ?? null,
        trust: isTrusted === undefined ? null : isTrusted ? 1 : 0,
        ts: createdAt ?? Date.now()
      })
  }

  // ── settings + gateway profiles (spec §3.3 tables) ───────────────────────────
  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value)
  }

  /** Session-scoped settings rows: local per-session overrides keyed `<prefix><session_id>`.
   *  `draft:` is the composer text that survives a relaunch (@shared/drafts) — it is per-session
   *  state like the others, so forget-hygiene and the orphan sweep have to cover it too. Leaving it
   *  out would leak one row per forgotten session, which is the exact leak this list was written
   *  to stop; and because pruneSessionSettings also deletes empty values, sending a draft would
   *  clear the row rather than leaving a blank one behind. */
  static readonly SESSION_SETTING_PREFIXES = ['title:', 'viewed:', 'pinned:', 'draft:'] as const

  /** Forget hygiene (A6): a forgotten session takes its local overrides with it. Before this,
   * `title:<id>` rows persisted for sessions that no longer existed — the known leak. */
  deleteSessionSettings(sessionId: string): void {
    const del = this.db.prepare(`DELETE FROM settings WHERE key = ?`)
    for (const p of CacheRepo.SESSION_SETTING_PREFIXES) del.run(`${p}${sessionId}`)
  }

  /**
   * Startup sweep for the rows the leak already left behind: session-scoped settings whose
   * session is gone from the cache, plus empty-valued ones (clearing a title/pin writes '').
   * Returns how many rows went, so the caller can log a positive signal instead of silence.
   */
  pruneSessionSettings(): number {
    let n = 0
    for (const p of CacheRepo.SESSION_SETTING_PREFIXES) {
      const r = this.db
        .prepare(
          `DELETE FROM settings
           WHERE key LIKE ? || '%'
             AND (value = '' OR substr(key, length(?) + 1) NOT IN (SELECT id FROM sessions))`
        )
        .run(p, p)
      n += r.changes
    }
    return n
  }

  /** Save a profile. `pin` is a TLS Prometheus's key (docs/MULTI-COMPUTER-v0.4.md §3); a profile saved without one has none,
   *  so re-saving a computer as a plain connection forgets an old pin rather than keeping it beside a new address. */
  upsertGatewayProfile(name: string, apiBase: string, wsUrl: string, isDefault: boolean, pin: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO gateway_profiles (name, api_base, ws_url, is_default, pin)
         VALUES (@name, @api, @ws, @def, @pin)
         ON CONFLICT(name) DO UPDATE SET api_base = excluded.api_base, ws_url = excluded.ws_url, is_default = excluded.is_default, pin = excluded.pin`
      )
      .run({ name, api: apiBase, ws: wsUrl, def: isDefault ? 1 : 0, pin })
  }

  /** Forget every saved gateway (Start over / Set up again). The credential is the caller's to clear. */
  deleteGatewayProfiles(): void {
    this.db.prepare(`DELETE FROM gateway_profiles`).run()
  }

  listGatewayProfiles(): Array<{ name: string; apiBase: string; wsUrl: string; isDefault: boolean }> {
    const rows = this.db
      .prepare(`SELECT name, api_base, ws_url, is_default FROM gateway_profiles ORDER BY is_default DESC, name`)
      .all() as Array<{ name: string; api_base: string; ws_url: string; is_default: number }>
    return rows.map((r) => ({ name: r.name, apiBase: r.api_base, wsUrl: r.ws_url, isDefault: !!r.is_default }))
  }

  // ── Socket lifecycle (diagnostic, bounded) ────────────────────────────────

  /**
   * Append one lifecycle event and prune to the rolling window.
   *
   * Pruning on INSERT rather than on a timer: a socket that has stopped cycling
   * writes nothing and therefore needs no sweep, and a socket that is cycling
   * hard is exactly when the bound has to hold. There is no path where the
   * table grows without this running.
   *
   * NEVER THROWS. This is diagnostics: a failure to record must not take down
   * the connection it is recording. Losing a row is bad; losing the socket
   * because we could not describe it is worse.
   */
  recordSocketEvent(e: SocketEvent): void {
    try {
      this.db
        .prepare(`INSERT INTO socket_events (at, kind, attempt, detail) VALUES (@at, @kind, @attempt, @detail)`)
        .run({ at: e.at, kind: e.kind, attempt: e.attempt ?? null, detail: e.detail ?? null })
      this.db
        .prepare(
          `DELETE FROM socket_events WHERE id NOT IN (
             SELECT id FROM socket_events ORDER BY id DESC LIMIT @keep
           )`
        )
        .run({ keep: SOCKET_LOG_MAX_ROWS })
    } catch {
      // Deliberately swallowed — see above. The console line that used to be
      // the ONLY record is still emitted by the caller, so nothing gets quieter
      // than it was before this table existed.
    }
  }

  /** Newest-first. `limit` is capped by the window itself, so this cannot page off the end. */
  getSocketEvents(limit = SOCKET_LOG_MAX_ROWS): SocketEvent[] {
    const rows = this.db
      .prepare(`SELECT at, kind, attempt, detail FROM socket_events ORDER BY id DESC LIMIT @n`)
      .all({ n: Math.min(limit, SOCKET_LOG_MAX_ROWS) }) as Array<{
      at: number
      kind: string
      attempt: number | null
      detail: string | null
    }>
    return rows.map((r) => ({
      at: r.at,
      kind: r.kind as SocketEvent['kind'],
      ...(r.attempt === null ? {} : { attempt: r.attempt }),
      ...(r.detail === null ? {} : { detail: r.detail })
    }))
  }

  /**
   * Events inside a closed time window, oldest-first.
   *
   * This is the shape the question actually takes — "what happened to the
   * socket between 20:10 and 20:25" — and the shape the old console output
   * could not answer at all.
   */
  getSocketEventsBetween(fromMs: number, toMs: number): SocketEvent[] {
    const rows = this.db
      .prepare(`SELECT at, kind, attempt, detail FROM socket_events WHERE at >= @from AND at <= @to ORDER BY id ASC`)
      .all({ from: fromMs, to: toMs }) as Array<{
      at: number
      kind: string
      attempt: number | null
      detail: string | null
    }>
    return rows.map((r) => ({
      at: r.at,
      kind: r.kind as SocketEvent['kind'],
      ...(r.attempt === null ? {} : { attempt: r.attempt }),
      ...(r.detail === null ? {} : { detail: r.detail })
    }))
  }

  /**
   * Record a watchdog decision. NEVER THROWS — same contract as
   * recordSocketEvent: a failure to describe the watchdog must not disturb the
   * watchdog. Bounded on every insert.
   */
  recordWatchdogEvent(e: WatchdogEvent): void {
    try {
      this.db
        .prepare(
          `INSERT INTO watchdog_events
             (at, kind, session_id, reason, rearms, armed_for_ms, cause,
              socket_dropped_at, daemon_last_seen_at, turn_in_flight)
           VALUES (@at, @kind, @sessionId, @reason, @rearms, @armedForMs, @cause,
                   @socketDroppedAt, @daemonLastSeenAt, @turnInFlight)`
        )
        .run({
          at: e.at,
          kind: e.kind,
          sessionId: e.sessionId,
          reason: e.reason ?? null,
          rearms: e.rearms ?? null,
          armedForMs: e.armedForMs ?? null,
          cause: e.cause ?? null,
          socketDroppedAt: e.socketDroppedAt ?? null,
          daemonLastSeenAt: e.daemonLastSeenAt ?? null,
          turnInFlight: e.turnInFlight === undefined ? null : e.turnInFlight ? 1 : 0
        })
      this.db
        .prepare(
          `DELETE FROM watchdog_events WHERE id NOT IN (
             SELECT id FROM watchdog_events ORDER BY id DESC LIMIT @keep
           )`
        )
        .run({ keep: WATCHDOG_LOG_MAX_ROWS })
    } catch {
      // Deliberately swallowed — diagnostics must not break what they observe.
    }
  }

  private mapWatchdogRow(r: Record<string, unknown>): WatchdogEvent {
    return {
      at: r.at as number,
      kind: r.kind as WatchdogEvent['kind'],
      sessionId: r.session_id as string,
      ...(r.reason === null ? {} : { reason: r.reason as WatchdogEvent['reason'] }),
      ...(r.rearms === null ? {} : { rearms: r.rearms as number }),
      ...(r.armed_for_ms === null ? {} : { armedForMs: r.armed_for_ms as number }),
      ...(r.cause === null ? {} : { cause: r.cause as WatchdogEvent['cause'] }),
      ...(r.socket_dropped_at === null ? {} : { socketDroppedAt: r.socket_dropped_at as number }),
      ...(r.daemon_last_seen_at === null ? {} : { daemonLastSeenAt: r.daemon_last_seen_at as number }),
      ...(r.turn_in_flight === null ? {} : { turnInFlight: r.turn_in_flight === 1 })
    }
  }

  /** Newest-first. */
  getWatchdogEvents(limit = WATCHDOG_LOG_MAX_ROWS): WatchdogEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_events ORDER BY id DESC LIMIT @n`)
      .all({ n: Math.min(limit, WATCHDOG_LOG_MAX_ROWS) }) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapWatchdogRow(r))
  }

  /**
   * Events inside a closed window, oldest-first — the shape the question takes:
   * "what did the watchdog do between 16:52 and 16:57".
   */
  getWatchdogEventsBetween(fromMs: number, toMs: number): WatchdogEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_events WHERE at >= @from AND at <= @to ORDER BY id ASC`)
      .all({ from: fromMs, to: toMs }) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapWatchdogRow(r))
  }

  countWatchdogEvents(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM watchdog_events`).get() as { n: number } | undefined
    return row?.n ?? 0
  }

  countSocketEvents(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM socket_events`).get() as { n: number } | undefined
    return row?.n ?? 0
  }

  // ── Resolve-path breadcrumbs (dev-gated by the caller, bounded here) ──────

  /** Append one breadcrumb and prune. Never throws — see recordSocketEvent. */
  recordUiTrace(e: UiTraceEvent): void {
    try {
      this.db
        .prepare(
          `INSERT INTO ui_events (at, mono, proc, point, request_id, scope, detail)
           VALUES (@at, @mono, @proc, @point, @rid, @scope, @detail)`
        )
        .run({
          at: e.at,
          mono: e.mono,
          proc: e.proc,
          point: e.point,
          rid: e.requestId ?? null,
          scope: e.scope ?? null,
          detail: e.detail ?? null
        })
      this.db
        .prepare(
          `DELETE FROM ui_events WHERE id NOT IN (
             SELECT id FROM ui_events ORDER BY id DESC LIMIT @keep
           )`
        )
        .run({ keep: UI_TRACE_MAX_ROWS })
    } catch {
      /* diagnostics must never break the path they measure */
    }
  }

  /** Oldest-first — the order the path is walked, which is how it is read. */
  getUiTrace(limit = UI_TRACE_MAX_ROWS): UiTraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT at, mono, proc, point, request_id, scope, detail FROM ui_events
         ORDER BY id DESC LIMIT @n`
      )
      .all({ n: Math.min(limit, UI_TRACE_MAX_ROWS) }) as Array<{
      at: number
      mono: number
      proc: string
      point: string
      request_id: string | null
      scope: string | null
      detail: string | null
    }>
    return rows
      .map((r) => ({
        at: r.at,
        mono: r.mono,
        proc: r.proc as UiTraceEvent['proc'],
        point: r.point as UiTraceEvent['point'],
        ...(r.request_id === null ? {} : { requestId: r.request_id }),
        ...(r.scope === null ? {} : { scope: r.scope }),
        ...(r.detail === null ? {} : { detail: r.detail })
      }))
      .reverse()
  }

  countUiTrace(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ui_events`).get() as { n: number } | undefined
    return row?.n ?? 0
  }
}
