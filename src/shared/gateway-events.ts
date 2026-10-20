// Pure gateway-event model + aggregation — shared by the renderer store (panels) and the headless
// smoke. NO DOM / Node / ws imports. The daemon's :8010 frames (chat_*, tool_call_*, agent_state,
// sentinel_signal, dream_*/skill_*/memory_*/curator_*) are normalized here so ToolCallFeed / Activity
// / Status consume ONE model. Mirrors the web gateway-store aggregation; chat handling is untouched
// (ChatShell still rides CHAT_STREAM) — this is the parallel "surface the dropped frames" path.

/** A normalized inbound daemon frame: raw type + payload + receipt time (epoch ms). */
export interface GatewayEvent {
  type: string
  payload: Record<string, unknown>
  ts: number
}

/** A tool call, paired from tool_call_start (pending) → tool_call_end (success/result/error/latency). */
export interface ToolCallRecord {
  callId: string
  toolName: string
  inputs: unknown
  /** undefined = still running (start seen, no end yet). */
  success?: boolean
  result?: string
  error?: string
  startedAt: number
  latencyMs?: number
}

export type ActivityCategory = 'message' | 'tool' | 'agent' | 'session' | 'signal' | 'system'

export interface ActivityItem {
  id: string
  category: ActivityCategory
  type: string
  sessionId?: string
  summary: string
  ts: number
  payload: Record<string, unknown>
}

/** A durable signal_events row from GET /api/events/recent (backfill). The daemon serializes
 * `timestamp` as an ISO-8601 STRING (telemetry stores ISO text); older builds sent epoch seconds —
 * accept both (live-walk finding 2026-06-10: number-only parsing rendered every backfilled row as
 * "epoch 0" / ~494753h ago). */
export interface EventRow {
  id?: number | string
  timestamp?: number | string
  signal_type?: string
  payload?: Record<string, unknown>
  source_subsystem?: string
}

/** EventRow.timestamp → epoch ms: ISO string or epoch seconds; unparseable → 0. Pure. */
export function eventRowTs(raw: number | string | undefined): number {
  if (typeof raw === 'number') return raw * 1000
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Bucket a raw frame/signal type into an activity category (drives the feed's badge + filter). */
export function categorize(type: string): ActivityCategory {
  if (type.startsWith('chat_')) return 'message'
  if (type.startsWith('tool_call')) return 'tool'
  if (type === 'agent_state') return 'agent'
  // Coding frames are agent work, not a generic signal. Before Prometheus#503 the unpromoted ones
  // arrived as sentinel_signal and bucketed as 'signal' by the prefix rule below, which is how
  // per-tool frames reached this feed looking like housekeeping. The two high-frequency kinds are
  // now excluded upstream (gateway-store); the milestones that do arrive land here.
  if (type.startsWith('coding_')) return 'agent'
  // The desktop action log (Prometheus#663) is agent work too. Without this line every computer_*
  // kind fell through to 'system', the bucket an undecoded frame lands in.
  if (type.startsWith('computer_')) return 'agent'
  if (type === 'turn_completed') return 'session'
  if (type.startsWith('session')) return 'session'
  if (
    type.startsWith('sentinel') ||
    type.startsWith('dream') ||
    type.startsWith('skill') ||
    type.startsWith('memory') ||
    type.startsWith('curator')
  )
    return 'signal'
  return 'system'
}

/**
 * The frame kinds kept OUT of the general Activity feed: per-run streams that have a view of their
 * own and would drown everything else in it. ONE set, so the live path and the backfill seed in
 * gateway-store cannot disagree about it.
 *
 * computer_step is one frame per desktop action, and computer_binding the app pick turning on and
 * off around each task; both have the dock's computer-use section. A task's start and end, a log
 * failure and the stop ack are milestones and stay in the feed.
 *
 * computer_step_thumbnail is here for a different reason: not volume but CONTENT. Its payload is a
 * picture of someone's desktop, and the feed keeps every payload verbatim — rendered as JSON, behind
 * a copy button, and in the export download. Declaring `computer-thumbnails` to the daemon is this
 * client promising not to do that; this line is the promise.
 *
 * subscribed is the daemon's reply to the subscribe frame ws.ts sends on every open: protocol
 * housekeeping, not activity, and a row per reconnect would be noise.
 */
export const ACTIVITY_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  'coding_round',
  'coding_tool',
  'coding_acceptance',
  'computer_step',
  'computer_binding',
  'computer_step_thumbnail',
  'subscribed'
])

/** Whether a frame of this type belongs in the Activity feed. Pure. */
export function inActivityFeed(type: string): boolean {
  return !ACTIVITY_EXCLUDED_KINDS.has(type)
}

/**
 * Fold one GatewayEvent into the tool-call list. tool_call_start → prepend a PENDING record;
 * tool_call_end → pair it by call_id, set success/result/error and latency (daemon latency_ms if
 * present, else end.ts − start.ts). An end with no prior start (race / missed start) synthesizes a
 * record so nothing is lost. Newest-first, capped. Non-tool events pass through unchanged.
 */
export function reduceToolCalls(prev: ToolCallRecord[], ev: GatewayEvent, cap = 200): ToolCallRecord[] {
  const p = ev.payload
  if (ev.type === 'tool_call_start') {
    const callId = str(p.call_id)
    if (!callId) return prev
    const rec: ToolCallRecord = { callId, toolName: str(p.tool_name) || 'tool', inputs: p.inputs, startedAt: ev.ts }
    return [rec, ...prev.filter((r) => r.callId !== callId)].slice(0, cap)
  }
  if (ev.type === 'tool_call_end') {
    const callId = str(p.call_id)
    if (!callId) return prev
    const success = typeof p.success === 'boolean' ? p.success : !p.error
    const latency = typeof p.latency_ms === 'number' ? p.latency_ms : undefined
    const result = p.result != null ? str(p.result) : undefined
    const error = p.error != null ? str(p.error) : undefined
    const idx = prev.findIndex((r) => r.callId === callId)
    if (idx >= 0) {
      const rec = prev[idx]
      const next = prev.slice()
      next[idx] = {
        ...rec,
        success,
        result: result ?? rec.result,
        error,
        // Never manufacture a zero from a subtraction: when start and end land in the same
        // tick, the result is "unmeasurable", not "instant". Leaving it undefined renders `—`,
        // which is the same answer the daemon's own 0.0 placeholder deserves.
        latencyMs: latency ?? (ev.ts > rec.startedAt ? ev.ts - rec.startedAt : undefined)
      }
      return next
    }
    const synth: ToolCallRecord = { callId, toolName: str(p.tool_name) || 'tool', inputs: undefined, success, result, error, startedAt: ev.ts, latencyMs: latency }
    return [synth, ...prev].slice(0, cap)
  }
  return prev
}

/** One row of GET /api/tools/recent — the daemon's per-call `tool_calls` tail (Prometheus
 * `/api/tools/recent`). Distinct from EventRow: that is the SignalBus tail, which never carries a
 * tool call — `tool_call_*` frames are WS fan-out only and are never persisted, which is why the
 * Tool Feed needs this route rather than the events one. */
export interface ToolCallRowDTO {
  call_id?: string
  /** Epoch SECONDS (REAL) — this table predates the ISO-text convention signal_events uses. */
  timestamp?: number
  model?: string | null
  tool_name?: string
  success?: boolean
  retries?: number
  /** NULL on the wire means "no execution occurred, nothing was measured" — a call that was
   * denied, failed validation, or never ran. Distinct from a real 0.0, which is a measurement.
   * Prometheus schema v2 made `latency_ms` nullable for exactly this (Prometheus #307/#475), and
   * `recent_tool_calls` now passes the NULL through instead of collapsing it to 0.0. The mapper
   * below turns null → undefined → `fmtLatency` renders `—`. This is `| null` to match the wire
   * AND the convention already used by daemon-api.ts and composer-controls.ts; declaring it
   * `?: number` alone would tell the next contributor that `r.latency_ms ?? 0` is safe, which is
   * correct per that signature and wrong on the data — it would re-create the 0ms-lie #307 fixed. */
  latency_ms?: number | null
  error_type?: string | null
  error_detail?: string | null
  inputs?: unknown
}

/**
 * GET /api/tools/recent rows → the Tool Feed's seed. These describe COMPLETED calls only, so
 * there is no start/end pairing to redo and no pending state to model — unlike the live reducer.
 *
 * The daemon stamps `timestamp` with time.time() AT RECORD TIME, i.e. when the call finished, so
 * the start is that minus the measured latency. The feed sorts on startedAt and merges these
 * against live records whose startedAt is a real start, so deriving it keeps both consistent.
 *
 * Rows with no call_id are skipped: the id is the dedupe key against live frames, and without one
 * a backfilled call would double up with its own live copy. Pure.
 */
/**
 * Human latency for one tool call.
 *
 * Sub-millisecond calls render as `<1ms`, NOT `0ms`. The daemon reports float milliseconds and
 * the live tail's floor was 0.140ms, so `Math.round` turned 8 of 200 rows into "0ms" — which
 * reads as "this did not happen" rather than "this was fast".
 *
 * An EXACT zero renders `—`, because it never means "took no time". Measured against the live
 * tail (200 rows): all three zeros were `permission_denied` — tools the user declined, which
 * therefore never executed. The daemon times real work with `time.monotonic()`, which does not
 * produce an exact 0.0; every genuine fast call in that tail was 0.18–0.59ms. So 0.0 is a
 * PLACEHOLDER for "no execution", written by the record sites that pass no latency at all
 * (telemetry.record defaults it to 0.0, and the schema is NOT NULL DEFAULT 0.0, so "unset" and
 * "measured zero" are literally the same value).
 *
 * #83 shipped the opposite rule — "a genuine zero is a measurement, keep 0ms" — which was sound
 * reasoning about a case that does not occur. The live tail is what settled it.
 *
 * Lives here rather than in ToolCallFeed.tsx so it can be tested — it was a private component
 * function, which is why the floor shipped unnoticed.
 */
export function fmtLatency(ms?: number): string {
  if (ms === undefined) return '—'
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '—' // never ran — see above; not a duration
  if (ms < 1) return '<1ms'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function toolCallsFromApi(rows: ToolCallRowDTO[], cap = 200): ToolCallRecord[] {
  const out: ToolCallRecord[] = []
  for (const r of rows) {
    const callId = typeof r.call_id === 'string' ? r.call_id : ''
    if (!callId) continue
    const endedAt = typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) ? r.timestamp * 1000 : 0
    const latencyMs = typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms) ? r.latency_ms : undefined
    // error_type is the class, error_detail the message; the feed shows one string.
    const err = [r.error_type, r.error_detail].filter((v) => typeof v === 'string' && v).join(': ')
    out.push({
      callId,
      toolName: r.tool_name || 'tool',
      inputs: r.inputs ?? undefined,
      success: typeof r.success === 'boolean' ? r.success : undefined,
      error: err || undefined,
      startedAt: endedAt > 0 ? Math.max(0, endedAt - (latencyMs ?? 0)) : 0,
      latencyMs
    })
    if (out.length >= cap) break
  }
  return out
}

/** Earlier of two epoch-ms stamps, ignoring 0 (eventRowTs's unparseable sentinel). Pure. */
const earliest = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : a > 0 ? a : b)

/**
 * Fold a backfilled seed UNDER whatever the live socket already delivered. The two overlap by
 * construction — the backfill request is in flight while frames stream — so dedupe by call_id.
 * Live wins field by field (its frames carry the full payload); the seed only fills gaps, notably
 * `inputs` for a call whose start predates the socket, and contributes calls the socket never saw.
 * startedAt takes the earlier of the two: a live end-without-start synthesizes startedAt from the
 * END frame, so the seed's real start is the truthful one. Newest-first, capped. Pure.
 */
export function mergeToolCalls(live: ToolCallRecord[], seed: ToolCallRecord[], cap = 200): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>()
  for (const s of seed) byId.set(s.callId, s)
  for (const l of live) {
    const s = byId.get(l.callId)
    if (!s) {
      byId.set(l.callId, l)
      continue
    }
    byId.set(l.callId, {
      callId: l.callId,
      toolName: l.toolName || s.toolName,
      inputs: l.inputs !== undefined ? l.inputs : s.inputs,
      success: l.success !== undefined ? l.success : s.success,
      result: l.result !== undefined ? l.result : s.result,
      error: l.error !== undefined ? l.error : s.error,
      startedAt: earliest(l.startedAt, s.startedAt),
      latencyMs: l.latencyMs !== undefined ? l.latencyMs : s.latencyMs
    })
  }
  return [...byId.values()].sort((a, z) => z.startedAt - a.startedAt).slice(0, cap)
}

let _seq = 0
const nextId = (): number => ++_seq

/** One-line human summary for the activity feed, per frame type. */
export function summarize(ev: GatewayEvent): string {
  const p = ev.payload
  switch (ev.type) {
    case 'chat_message':
      return `${str(p.role) || 'msg'}: ${trunc(str(p.content), 80)}`
    case 'chat_done':
      return 'assistant finished'
    case 'tool_call_start':
      return `→ ${str(p.tool_name) || 'tool'}`
    case 'tool_call_end':
      return `${p.success === false || p.error ? '✗' : '✓'} ${str(p.tool_name) || 'tool'}`
    case 'agent_state':
      return `agent ${str(p.state) || '?'}`
    case 'coding_complete':
      return `coding run ${str(p.outcome) || '?'}${p.exit_code == null ? '' : ` (exit ${String(p.exit_code)})`}`
    case 'coding_stream_error':
      return `coding stream: ${trunc(str(p.error) || 'interrupted', 60)}`
    case 'coding_acceptance':
      return `acceptance ${p.exit_code === 0 ? '✓' : `✗ exit ${String(p.exit_code ?? '?')}`}`
    case 'coding_tool':
      return `${p.success === false ? '✗' : '✓'} ${str(p.tool_name) || 'tool'}`
    // The desktop action log (Prometheus#663). Goals and reasons are the daemon's/the person's
    // words; the step's description is the app's own text and is not repeated here.
    case 'computer_binding':
      return `desktop app ${p.state === 'on' ? 'picked' : 'released'}: ${str(p.app) || '?'}`
    case 'computer_task_started':
      return `desktop task in ${str(p.app) || '?'}: ${trunc(str(p.goal), 60)}`
    case 'computer_step':
      return `desktop step ${str(p.seq)}: ${str(p.status) || '?'}`
    case 'computer_task_ended':
      return `desktop task ${str(p.outcome) || 'ended'}${typeof p.steps === 'number' ? ` · ${p.steps} step${p.steps === 1 ? '' : 's'}` : ''}`
    case 'computer_stream_error':
      return `desktop log: ${trunc(str(p.detail) || 'interrupted', 60)}`
    case 'computer_task_stop_ack':
      return p.stopped === true ? 'desktop task stop accepted' : 'desktop task stop: nothing running under that id'
    case 'turn_completed':
      return `turn done${p.model ? ` · ${str(p.model)}` : ''}`
    case 'sentinel_signal':
      return `signal: ${str(p.kind) || str(p.state) || 'sentinel'}`
    case 'connected':
      return 'connected'
    case 'error':
      return `error: ${trunc(str(p.message), 80)}`
    default:
      return ev.type.replace(/_/g, ' ')
  }
}

/** Normalize a live GatewayEvent → ActivityItem (category + summary + session). */
export function toActivityItem(ev: GatewayEvent): ActivityItem {
  const sessionId = typeof ev.payload.session_id === 'string' ? ev.payload.session_id : undefined
  return { id: `ev-${nextId()}`, category: categorize(ev.type), type: ev.type, sessionId, summary: summarize(ev), ts: ev.ts, payload: ev.payload }
}

// ── Activity-feed controls (Tier 1, pure) ────────────────────────────────────

/** Unique session ids present in an activity list, sorted — drives the Activity session filter. */
export function activitySessions(items: ActivityItem[]): string[] {
  const set = new Set<string>()
  for (const it of items) if (it.sessionId) set.add(it.sessionId)
  return [...set].sort()
}

/** The Activity feed's filter, as a pure function: category set (empty/absent = all categories), a
 * free-text query matched against summary + type (case-insensitive), and an optional session id.
 * Display ordering (newest-first) stays the caller's concern. */
export function filterActivity(
  items: ActivityItem[],
  opts: { cats?: Set<ActivityCategory>; query?: string; sessionId?: string | null }
): ActivityItem[] {
  const { cats } = opts
  const ql = (opts.query ?? '').trim().toLowerCase()
  const sid = opts.sessionId ?? null
  return items.filter(
    (it) =>
      (!cats || cats.size === 0 || cats.has(it.category)) &&
      (!sid || it.sessionId === sid) &&
      (!ql || it.summary.toLowerCase().includes(ql) || it.type.toLowerCase().includes(ql))
  )
}

/** Serialize the activity feed to pretty JSON — the Export-JSON button's payload. */
export function activityToJson(items: ActivityItem[]): string {
  return JSON.stringify(items, null, 2)
}

/** Normalize a durable /api/events/recent row → ActivityItem (ISO string OR epoch seconds → ms). */
export function activityFromRow(row: EventRow): ActivityItem {
  const type = row.signal_type ?? 'event'
  const ts = eventRowTs(row.timestamp)
  const payload = row.payload ?? {}
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined
  return { id: `row-${row.id ?? nextId()}`, category: categorize(type), type, sessionId, summary: summarize({ type, payload, ts }), ts, payload }
}
