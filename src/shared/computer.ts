// The desktop action log (computer-use v1.1, Prometheus#663): decoders + live state for the
// daemon's computer_* frames. PURE: no React, no IO, so the renderer store and the headless smoke
// share one source of truth, like @shared/coding.
//
// Payload shapes mirror the daemon's builders in src/prometheus/computer/livestream.py
// (ComputerLiveStream.binding / task_started / step / task_ended, and the stream-error path in
// _emit) and the stop reply in src/prometheus/web/ws_server.py. Unknown extra keys are ignored, as
// the contract asks.

import { eventRowTs, type EventRow, type GatewayEvent } from './gateway-events'

/**
 * The daemon's tuple, copied in the daemon's order. ws_server promotes each of these to a
 * first-class frame type FROM that tuple, so a kind added there arrives as itself the same day.
 * smoke:computer pins this copy to fixtures/computer-frame-kinds.json, which is a verbatim copy of
 * the server's: a kind the daemon adds fails the smoke until it decodes here.
 */
export const COMPUTER_FRAME_KINDS = [
  'computer_binding',
  'computer_task_started',
  'computer_step',
  'computer_task_ended',
  'computer_stream_error'
] as const
export type ComputerFrameKind = (typeof COMPUTER_FRAME_KINDS)[number]

/**
 * ws_server's reply to our own `{type: "computer_task_stop"}`. Sent to the requesting socket only;
 * not a SignalBus kind, so it is not in the daemon's tuple and is never persisted or backfilled.
 */
export const COMPUTER_STOP_ACK = 'computer_task_stop_ack'

/**
 * The per-step thumbnail (Prometheus#701, design §5.2.5). DIRECT-ONLY, exactly like the stop ack
 * and for the same structural reason: it is NOT in the daemon's promoted tuple, never persisted to
 * signal_events, never in /api/events/recent, and never backfilled. A screenshot is the most
 * sensitive thing the cockpit puts on the wire, so it never enters the event log on either end (the
 * daemon's opt-in disk copy, thumbnails.persist, is off by default and no route serves it) — which is why
 * this kind sits BESIDE COMPUTER_FRAME_KINDS, never inside it (adding it there would break the
 * fixture pin AND lie about what the daemon persists).
 */
export const COMPUTER_STEP_THUMBNAIL = 'computer_step_thumbnail'

/**
 * The mimes this client will render as a thumbnail. Mirrors the daemon's own server-side allowlist
 * (thumbnails._EXT_FOR_MIME) and EXCLUDES svg on purpose: a `data:` URL of svg is scriptable, and
 * Beacon renders wire bytes it did not produce. The daemon already restricts to these three; this is
 * the SECOND gate, because "the daemon is ours" is not a reason to build a data URL from an
 * unvalidated mime — a compromised or buggy daemon must not get a scriptable image rendered.
 */
export const THUMBNAIL_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']

/** Every computer kind this client decodes: the daemon's tuple plus the two direct-only kinds. ONE
 *  set: the gateway store gates on it, so a gate cannot drift from what the reducer folds. The two
 *  direct-only kinds are here (so they decode and fold) but NOT in COMPUTER_FRAME_KINDS (so they are
 *  never backfilled). */
export const COMPUTER_EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  ...COMPUTER_FRAME_KINDS, COMPUTER_STOP_ACK, COMPUTER_STEP_THUMBNAIL
])

/** The person's app pick (the consent), as last seen for a session. */
export interface ComputerBinding {
  on: boolean
  /** The daemon's own word ('on' | 'off'), kept so an unexpected one is visible rather than coerced. */
  state: string
  target: string
  app: string
  /** 'session' | 'task' */
  scope: string
  /** Which surface set it: 'beacon' | 'telegram' | 'rest'. */
  setBy: string
  /** Epoch seconds. */
  expiresAt: number | null
  /** The daemon's sentence for what the pick allows. Only sent with state 'on'. */
  describes: string | null
  covers: string[]
  /** Daemon time of the frame, epoch ms (floored). Orders a backfill against the live stream. */
  at: number
}

export interface ComputerTaskStarted {
  target: string
  app: string
  goal: string
  chooser: string
  startedBy: string
  limits: { maxSteps: number | null; maxSeconds: number | null; maxApprovals: number | null }
  /** How many characters the task will type. The text itself never crosses the wire. */
  textChars: number
  at: number
}

export interface ComputerStepAction {
  verb: string
  /** The APP's own text (the chosen element's description), capped by the daemon at 120 chars.
   *  Render it as text the app wrote, never as markup and never as Beacon's words. */
  description: string
  appText: boolean
}

export interface ComputerStep {
  /** Per task, strictly increasing from 1: THE de-dupe key between a backfill and the live stream. */
  seq: number
  /** 'executed' | 'refused' | 'abstained' | 'reobserve' | 'blocked' | 'awaiting_approval' |
   *  'in_flight_at_stop'. Kept as a string so a new one renders rather than vanishing. */
  status: string
  action: ComputerStepAction | null
  extent: string | null
  /** 'binding' | 'prompt' | 'grant' */
  consent: string | null
  approvalRequestId: string | null
  chooser: { name: string; confidence: number | null; reason: string | null } | null
  /** 'CONFIRMED' | 'UNVERIFIABLE', only for a step that dispatched. */
  effect: string | null
  verified: boolean | null
  /** Dispatched before a Stop and may have landed. */
  afterStop: boolean
  candidatesOffered: number | null
  durationMs: number | null
  reason: string
  /** The OUTCOME of the thumbnail decision for this step: 'sent' | 'skipped' | null. Null means no
   *  decision was made (feature off, or the step did not execute) — NOT the same as 'skipped'. The
   *  image itself never rides on this frame; it arrives as its own direct-only computer_step_thumbnail. */
  thumbnail: string | null
  /** When thumbnail === 'skipped', the daemon's reason. */
  thumbnailSkipReason: string | null
  at: number
}

/**
 * One decoded thumbnail image. Built from a `computer_step_thumbnail` frame; the base64 is validated
 * against the mime allowlist before it ever reaches an <img>.
 */
export interface ComputerThumbnail {
  /** The computer_step this picture follows — the join key, since the frame arrives BEFORE its step. */
  seq: number
  /** The bound app, as the extent names it. Not a window title (page-authored text in a browser). */
  app: string | null
  /** A `data:` URL, built ONLY from a mime in THUMBNAIL_MIMES; null when the frame's mime is not
   *  one we render, so the pane can say "a picture we will not show" rather than showing it. */
  src: string | null
  /** The mime the daemon sent, verbatim — kept even when src is null, so a refused render is legible. */
  mimeType: string | null
  width: number | null
  height: number | null
  /** Daemon time of the capture, epoch ms — from its ISO `captured_at` (second precision), or the
   *  frame's own time when that is absent or unparsable. */
  at: number
}

export interface ComputerTaskEnded {
  /** 'done' | 'abstained' | 'stopped' | 'refused' | 'failed' | 'limit' */
  outcome: string
  reason: string
  /** The daemon's count of executed actions. */
  steps: number | null
  approvals: number | null
  inFlightAtStop: boolean
  durationMs: number | null
  at: number
}

/** One decoded frame. `unknown` is the sentinel for anything that is not a computer frame, or is
 *  one without the key needed to place it — always with the reason. */
export type ComputerEvent =
  | { kind: 'computer_binding'; sessionId: string; binding: ComputerBinding }
  | { kind: 'computer_task_started'; sessionId: string; taskId: string; started: ComputerTaskStarted }
  | { kind: 'computer_step'; sessionId: string; taskId: string; step: ComputerStep }
  | { kind: 'computer_task_ended'; sessionId: string; taskId: string; ended: ComputerTaskEnded }
  | { kind: 'computer_stream_error'; sessionId: string | null; taskId: string | null; detail: string }
  | { kind: 'computer_task_stop_ack'; taskId: string; stopped: boolean }
  | { kind: 'computer_step_thumbnail'; sessionId: string; taskId: string; thumb: ComputerThumbnail }
  | { kind: 'unknown'; type: string; why: string }

/** Live state for one desktop task. */
export interface ComputerTaskLive {
  taskId: string
  started: ComputerTaskStarted | null
  /** Sorted by seq, unique by seq. */
  steps: ComputerStep[]
  ended: ComputerTaskEnded | null
  /** The answer to THIS client's Stop: true = stopped, false = nothing was running under that id.
   *  null = no Stop sent from here, or not answered yet. */
  stopAck: boolean | null
  /** The daemon's log failed for this task (the task itself carries on). */
  streamError: string | null
  /** Earliest daemon time seen for this task, epoch ms. Orders a task whose start never arrived. */
  firstAt: number
  /** Thumbnails by step seq. Keyed, not merged into `steps`, because the daemon sends the image
   *  BEFORE the step frame it belongs to (the capture happens inside step(), then the step is
   *  emitted) — so on arrival there is no step to attach it to. The pane joins a step's row to
   *  `thumbs[row.seq]` at render, the same way it joins a pending approval by id. */
  thumbs: Record<number, ComputerThumbnail>
}

export interface ComputerSessionLive {
  binding: ComputerBinding | null
  tasks: Record<string, ComputerTaskLive>
  /** A stream error naming this session but no task. */
  streamError: string | null
}

export interface ComputerState {
  /** chat session_id → its desktop tasks and app pick. */
  sessions: Record<string, ComputerSessionLive>
  /** A stream error the daemon could not attribute to a session. */
  orphanStreamError: string | null
  /** Computer frames that could not be placed (no session_id / task_id / seq, or an ack for a
   *  task this client never saw). Counted, never silently dropped. */
  unplaced: number
}

export const EMPTY_COMPUTER: ComputerState = { sessions: {}, orphanStreamError: null, unplaced: 0 }
const EMPTY_SESSION: ComputerSessionLive = { binding: null, tasks: {}, streamError: null }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * Build the `data:` URL for a thumbnail, or null when it must not be rendered.
 *
 * THE SECOND GATE. The daemon already restricts its captures to png/jpeg/webp and refuses svg
 * (thumbnails._EXT_FOR_MIME), but Beacon builds a `data:` URL from bytes it did not produce and
 * renders it in an <img>. An unvalidated mime there is a scriptable surface — `data:image/svg+xml`
 * carries script — so the client re-checks against THUMBNAIL_MIMES. "The daemon is ours" is not a
 * reason to skip this: a compromised or buggy daemon must not get a scriptable image rendered.
 *
 * Also validates the base64 is non-empty and decodable-looking, so a truncated or empty frame does
 * not produce a broken `data:` URL that renders as a half image.
 */
export function thumbnailSrc(mimeType: unknown, dataBase64: unknown): string | null {
  if (typeof mimeType !== 'string' || !THUMBNAIL_MIMES.includes(mimeType)) return null
  if (typeof dataBase64 !== 'string' || !dataBase64) return null
  // A base64 body is [A-Za-z0-9+/] with optional = padding; reject anything else rather than
  // handing it to the browser, which would either error or (worse) reinterpret it.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) return null
  return `data:${mimeType};base64,${dataBase64}`
}
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * The frame's effective {type, payload}. A computer kind that arrives wrapped as sentinel_signal
 * (`{kind, payload, source}`) is unwrapped: that is how the daemon ships a kind its promotion list
 * lacks, and it is exactly how coding_tool and coding_acceptance went dark for months
 * (Prometheus#503). The daemon now promotes from its own tuple, so this should never fire; if it
 * does, the person still sees their task.
 */
function effective(ev: { type: string; payload: Record<string, unknown> }): { type: string; payload: Record<string, unknown> } {
  if (ev.type === 'sentinel_signal' && typeof ev.payload.kind === 'string' && COMPUTER_EVENT_KINDS.has(ev.payload.kind)) {
    const inner = obj(ev.payload.payload)
    if (inner) return { type: ev.payload.kind, payload: inner }
  }
  return ev
}

/** Whether a gateway frame is one this module folds (wrapped or not). The store's gate. */
export function isComputerEvent(ev: { type: string; payload: Record<string, unknown> }): boolean {
  return COMPUTER_EVENT_KINDS.has(effective(ev).type)
}

/** Decode one gateway frame into its typed computer event. Pure. `ts` is the frame's daemon time
 *  in epoch ms (ws.ts and eventRowTs both produce it); absent, `at` is 0. */
export function decodeComputerEvent(ev: { type: string; payload: Record<string, unknown>; ts?: number }): ComputerEvent {
  const { type, payload: p } = effective(ev)
  const at = typeof ev.ts === 'number' && Number.isFinite(ev.ts) ? Math.floor(ev.ts) : 0
  const unknown = (why: string): ComputerEvent => ({ kind: 'unknown', type, why })
  if (!COMPUTER_EVENT_KINDS.has(type)) return unknown('not a computer frame')

  if (type === COMPUTER_STOP_ACK) {
    const taskId = str(p.task_id)
    if (!taskId) return unknown(`${type} without task_id`)
    return { kind: 'computer_task_stop_ack', taskId, stopped: p.stopped === true }
  }
  if (type === 'computer_stream_error') {
    return {
      kind: 'computer_stream_error',
      sessionId: strOrNull(p.session_id),
      taskId: strOrNull(p.task_id),
      detail: str(p.detail) || 'the action log failed'
    }
  }

  const sessionId = str(p.session_id)
  if (!sessionId) return unknown(`${type} without session_id`)

  if (type === 'computer_binding') {
    const state = str(p.state)
    return {
      kind: 'computer_binding',
      sessionId,
      binding: {
        on: state === 'on',
        state,
        target: str(p.target),
        app: str(p.app),
        scope: str(p.scope),
        setBy: str(obj(p.set_by)?.surface),
        expiresAt: num(p.expires_at),
        describes: strOrNull(p.describes),
        covers: Array.isArray(p.covers) ? p.covers.filter((c): c is string => typeof c === 'string') : [],
        at
      }
    }
  }

  const taskId = str(p.task_id)
  if (!taskId) return unknown(`${type} without task_id`)

  if (type === 'computer_task_started') {
    const limits = obj(p.limits)
    return {
      kind: 'computer_task_started',
      sessionId,
      taskId,
      started: {
        target: str(p.target),
        app: str(p.app),
        goal: str(p.goal),
        chooser: str(p.chooser),
        startedBy: str(obj(p.started_by)?.surface),
        limits: { maxSteps: num(limits?.max_steps), maxSeconds: num(limits?.max_seconds), maxApprovals: num(limits?.max_approvals) },
        textChars: num(p.text_chars) ?? 0,
        at
      }
    }
  }

  if (type === 'computer_step') {
    const seq = num(p.seq)
    if (seq === null) return unknown(`${type} without seq`)
    const action = obj(p.action)
    const chooser = obj(p.chooser)
    return {
      kind: 'computer_step',
      sessionId,
      taskId,
      step: {
        seq,
        status: str(p.status),
        action: action ? { verb: str(action.verb), description: str(action.description), appText: action.app_text === true } : null,
        extent: strOrNull(p.extent),
        consent: strOrNull(p.consent),
        approvalRequestId: strOrNull(p.approval_request_id),
        chooser: chooser ? { name: str(chooser.name), confidence: num(chooser.confidence), reason: strOrNull(chooser.reason) } : null,
        effect: strOrNull(p.effect),
        verified: typeof p.verified === 'boolean' ? p.verified : null,
        afterStop: p.after_stop === true,
        candidatesOffered: num(p.candidates_offered),
        durationMs: num(p.duration_ms),
        reason: str(p.reason),
        thumbnail: strOrNull(p.thumbnail),
        thumbnailSkipReason: strOrNull(p.thumbnail_skip_reason),
        at
      }
    }
  }

  if (type === COMPUTER_STEP_THUMBNAIL) {
    // The image frame. Its seq is the join key to the step it follows — the frame arrives BEFORE
    // that step (the daemon captures inside step(), then emits the step), so this cannot be
    // attached to a step row here; the reducer keys it by seq on the task and the pane joins at
    // render. The base64 is validated against the mime allowlist now, so a scriptable or truncated
    // frame yields src:null rather than a data URL.
    const seq = num(p.seq)
    if (seq === null) return unknown(`${type} without seq`)
    const mime = strOrNull(p.mime_type)
    return {
      kind: COMPUTER_STEP_THUMBNAIL,
      sessionId,
      taskId,
      thumb: {
        seq,
        app: strOrNull(p.app),
        src: thumbnailSrc(p.mime_type, p.data_base64),
        mimeType: mime,
        width: num(p.width),
        height: num(p.height),
        // The daemon sends an ISO-8601 UTC string (second precision), not epoch — build_frame's
        // captured_at. Unparsable or absent falls back to the frame's own time.
        at: isoMs(p.captured_at) ?? at
      }
    }
  }

  // computer_task_ended
  return {
    kind: 'computer_task_ended',
    sessionId,
    taskId,
    ended: {
      outcome: str(p.outcome),
      reason: str(p.reason),
      steps: num(p.steps),
      approvals: num(p.approvals),
      inFlightAtStop: p.in_flight_at_stop === true,
      durationMs: num(p.duration_ms),
      at
    }
  }
}

const newTask = (taskId: string, at: number): ComputerTaskLive => ({
  taskId,
  started: null,
  steps: [],
  ended: null,
  stopAck: null,
  streamError: null,
  firstAt: at,
  thumbs: {}
})

/** Earlier of two epoch-ms stamps, ignoring 0 (no stamp). */
const earliest = (a: number, b: number): number => (a > 0 && b > 0 ? Math.min(a, b) : a > 0 ? a : b)

function putTask(prev: ComputerState, sessionId: string, task: ComputerTaskLive): ComputerState {
  const sess = prev.sessions[sessionId] ?? EMPTY_SESSION
  return { ...prev, sessions: { ...prev.sessions, [sessionId]: { ...sess, tasks: { ...sess.tasks, [task.taskId]: task } } } }
}

function putSession(prev: ComputerState, sessionId: string, sess: ComputerSessionLive): ComputerState {
  return { ...prev, sessions: { ...prev.sessions, [sessionId]: sess } }
}

const sameBinding = (a: ComputerBinding, b: ComputerBinding): boolean =>
  a.state === b.state && a.app === b.app && a.target === b.target && a.scope === b.scope && a.setBy === b.setBy && a.expiresAt === b.expiresAt

/** Structural equality for a thumbnail, so a reconnect replay or a duplicate frame is a no-op.
 *  Comparing by identity would never match — each decode builds a fresh object — and every fold
 *  would churn a new task, breaking the same-ref guarantee the whole reducer is built on. */
const sameThumb = (a: ComputerThumbnail, b: ComputerThumbnail): boolean =>
  a.seq === b.seq && a.app === b.app && a.src === b.src && a.mimeType === b.mimeType &&
  a.width === b.width && a.height === b.height && a.at === b.at

/**
 * Fold one gateway frame into the computer state. PURE. Returns the SAME ref for an unrelated
 * frame and for a duplicate, so a reconnect replay or an overlapping backfill churns nothing:
 *   - steps are keyed by (task_id, seq);
 *   - started / ended by task_id (the first one seen stands);
 *   - the binding by daemon time: an OLDER frame (a backfilled 'on') never overrides a newer one
 *     (the live 'off'), and an identical one is a no-op.
 * A computer frame that cannot be placed is counted in `unplaced`, never silently dropped.
 */
export function reduceComputer(prev: ComputerState, ev: GatewayEvent): ComputerState {
  if (!isComputerEvent(ev)) return prev
  const d = decodeComputerEvent(ev)
  const at = Number.isFinite(ev.ts) ? Math.floor(ev.ts) : 0

  switch (d.kind) {
    case 'unknown':
      return { ...prev, unplaced: prev.unplaced + 1 }

    case 'computer_task_stop_ack': {
      // The ack carries no session_id: find the task.
      for (const [sid, sess] of Object.entries(prev.sessions)) {
        const task = sess.tasks[d.taskId]
        if (!task) continue
        return task.stopAck === d.stopped ? prev : putTask(prev, sid, { ...task, stopAck: d.stopped })
      }
      return { ...prev, unplaced: prev.unplaced + 1 }
    }

    case 'computer_stream_error': {
      if (!d.sessionId) return prev.orphanStreamError === d.detail ? prev : { ...prev, orphanStreamError: d.detail }
      const sess = prev.sessions[d.sessionId] ?? EMPTY_SESSION
      if (!d.taskId) return sess.streamError === d.detail ? prev : putSession(prev, d.sessionId, { ...sess, streamError: d.detail })
      const task = sess.tasks[d.taskId] ?? newTask(d.taskId, at)
      return task.streamError === d.detail ? prev : putTask(prev, d.sessionId, { ...task, streamError: d.detail })
    }

    case 'computer_binding': {
      const sess = prev.sessions[d.sessionId] ?? EMPTY_SESSION
      const cur = sess.binding
      if (cur && (d.binding.at < cur.at || sameBinding(cur, d.binding))) return prev
      return putSession(prev, d.sessionId, { ...sess, binding: d.binding })
    }

    case 'computer_task_started': {
      const task = prev.sessions[d.sessionId]?.tasks[d.taskId] ?? newTask(d.taskId, at)
      if (task.started) return prev
      return putTask(prev, d.sessionId, { ...task, started: d.started, firstAt: earliest(task.firstAt, at) })
    }

    case 'computer_step': {
      const task = prev.sessions[d.sessionId]?.tasks[d.taskId] ?? newTask(d.taskId, at)
      if (task.steps.some((s) => s.seq === d.step.seq)) return prev
      const steps = [...task.steps, d.step].sort((a, z) => a.seq - z.seq)
      return putTask(prev, d.sessionId, { ...task, steps, firstAt: earliest(task.firstAt, at) })
    }

    case 'computer_task_ended': {
      const task = prev.sessions[d.sessionId]?.tasks[d.taskId] ?? newTask(d.taskId, at)
      if (task.ended) return prev
      return putTask(prev, d.sessionId, { ...task, ended: d.ended, firstAt: earliest(task.firstAt, at) })
    }

    case 'computer_step_thumbnail': {
      // Keyed by seq on the task, NOT merged into a step: the image arrives before its step frame
      // (the daemon captures inside step(), then emits the step), so there is no step row yet.
      // A later thumbnail for the same seq replaces the earlier one — the daemon sends at most one
      // per step, but a reconnect could replay, and the newest capture is the honest one to show.
      const task = prev.sessions[d.sessionId]?.tasks[d.taskId] ?? newTask(d.taskId, at)
      const cur = task.thumbs[d.thumb.seq]
      if (cur && sameThumb(cur, d.thumb)) return prev
      const thumbs = { ...task.thumbs, [d.thumb.seq]: d.thumb }
      return putTask(prev, d.sessionId, { ...task, thumbs, firstAt: earliest(task.firstAt, at) })
    }
  }
}

/** GET /api/events/recent for one session's action log. Every kind in the daemon's tuple (the
 *  contract's example omits computer_stream_error; a log failure for this session's task is worth
 *  seeing after a reconnect too). No `since`: the daemon keeps a bounded log per session
 *  (keep_per_session, 200 by default) and 500 is the route's own cap. */
export function computerBackfillPath(sessionId: string, limit = 500): string {
  const q = new URLSearchParams({ types: COMPUTER_FRAME_KINDS.join(','), session_id: sessionId, limit: String(limit) })
  return `/api/events/recent?${q.toString()}`
}

/** signal_events rows (newest first, ISO stamps) → gateway events, oldest first, ms stamps. Rows
 *  that are not a computer kind, or carry no payload object, are left out. Pure. */
export function computerEventsFromRows(rows: EventRow[]): GatewayEvent[] {
  const out: GatewayEvent[] = []
  for (const r of [...rows].reverse()) {
    const type = r.signal_type ?? ''
    const payload = obj(r.payload)
    if (!payload || !(COMPUTER_FRAME_KINDS as readonly string[]).includes(type)) continue
    out.push({ type, payload, ts: eventRowTs(r.timestamp) })
  }
  // Stable: rows that share a stamp keep the daemon's own order.
  return out.sort((a, z) => a.ts - z.ts)
}

/** Fold a backfill UNDER whatever the live socket already delivered. The reducer's keys do the
 *  de-dupe, so an overlap with live frames, or the same backfill twice, changes nothing. Pure. */
export function mergeComputerBackfill(prev: ComputerState, rows: EventRow[]): ComputerState {
  return computerEventsFromRows(rows).reduce(reduceComputer, prev)
}

/** The WS frame that stops ONE desktop task (ws_server.py). The daemon answers this socket only,
 *  with computer_task_stop_ack {task_id, stopped}; the outcome then arrives for everyone as
 *  computer_task_ended {outcome: "stopped"}. */
export function computerTaskStopFrame(taskId: string): { type: 'computer_task_stop'; payload: { task_id: string } } {
  return { type: 'computer_task_stop', payload: { task_id: taskId } }
}

const startKey = (t: ComputerTaskLive): number => t.started?.at ?? t.firstAt

/** The session's most recently started task, running or not. Pure. */
export function latestTask(sess: ComputerSessionLive | null | undefined): ComputerTaskLive | null {
  if (!sess) return null
  let best: ComputerTaskLive | null = null
  for (const t of Object.values(sess.tasks)) if (!best || startKey(t) > startKey(best)) best = t
  return best
}

/** Seqs below the highest one seen that never arrived (seq starts at 1). Non-empty means some of
 *  the task's log did not reach this client: a frame the daemon failed to deliver, or a backfill
 *  that has not landed. Pure. */
export function missingSeqs(task: ComputerTaskLive): number[] {
  const have = new Set(task.steps.map((s) => s.seq))
  const top = task.steps.length ? task.steps[task.steps.length - 1].seq : 0
  const out: number[] = []
  for (let i = 1; i < top; i++) if (!have.has(i)) out.push(i)
  return out
}

const STEP_LABELS: Record<string, string> = {
  executed: 'done',
  refused: 'not allowed',
  abstained: 'nothing to do',
  reobserve: 'looked again',
  blocked: 'could not act safely',
  awaiting_approval: 'waiting for your approval',
  in_flight_at_stop: 'in flight at the stop — may have landed'
}

/** Words for a step status. An unknown status renders as itself, never as a blank. */
export function computerStepLabel(status: string): string {
  return STEP_LABELS[status] ?? (status || 'unknown')
}

/** Honest words for a task outcome. Only 'done' wears the ok tone: a stop, a refusal or a limit is
 *  not a success, and a failure is an error. An unknown outcome renders as itself. */
export function computerOutcomeLabel(outcome: string): { text: string; tone: 'ok' | 'warn' | 'err' } {
  switch (outcome) {
    case 'done':
      return { text: 'Done', tone: 'ok' }
    case 'abstained':
      return { text: 'Nothing to do', tone: 'warn' }
    case 'stopped':
      return { text: 'Stopped', tone: 'warn' }
    case 'refused':
      return { text: 'Refused', tone: 'warn' }
    case 'limit':
      return { text: 'Stopped at a limit', tone: 'warn' }
    case 'failed':
      return { text: 'Failed', tone: 'err' }
    default:
      return { text: outcome || 'Ended', tone: 'warn' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The step-by-step log (v1.1 PR 7). #194 folded every computer_* frame into
// state and rendered ONE line — the latest step. This is the pure half of
// showing the whole log, with an approval that is still waiting rendered
// inline beside the step that asked for it.
//
// Pure on purpose, and per the house recipe: the pane renders these rows and
// decides nothing, so a smoke can assert the log's content and ordering
// without a window, a daemon or a frame on the wire.
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the desktop task's log. */
export interface ComputerLogRow {
  /** Per task, from 1. The de-dupe key the reducer already applied. */
  seq: number
  status: string
  /** Beacon's word for the status. An unknown status renders as itself. */
  label: string
  /** The APP's own words for the element it chose, verbatim, or null when the step names none.
   *  Render as text the app wrote — never as markup, never re-worded. */
  appText: string | null
  /** Beacon's words for why nothing happened, or null. Never both this and appText: appText wins
   *  when present, because the app's own description of the element is the better evidence. */
  reason: string | null
  /** How this step was consented to: 'binding' | 'prompt' | 'grant', or null. */
  consent: string | null
  /** 'CONFIRMED' | 'UNVERIFIABLE' for a step that dispatched, else null. */
  effect: string | null
  /** The approval this step is waiting on, WHEN IT IS STILL IN THE QUEUE — the pane renders the
   *  approve/deny control inline against this id. Null once answered: the log keeps the step and
   *  its outcome, but a resolved request has nothing left to act on. */
  pendingApprovalId: string | null
  /** Dispatched before a Stop, so it may have landed either way. */
  afterStop: boolean
  /** Daemon time, epoch ms. */
  at: number
}

const CONSENT_LABELS: Record<string, string> = {
  binding: 'covered by your pick',
  prompt: 'you approved it',
  grant: 'a remembered grant'
}

/** Words for how a step was consented to. An unknown value renders as itself rather than as a
 *  blank, and null stays null — the pane renders nothing, because "no consent term" is not the
 *  same claim as an unrecognised one. */
export function consentLabel(consent: string | null): string | null {
  if (consent === null) return null
  return CONSENT_LABELS[consent] ?? (consent || 'unknown')
}

/**
 * The whole log, oldest first, as rows the pane renders without deciding anything.
 *
 * `pendingApprovalIds` is the set of approval requests STILL in the daemon's queue, built by the
 * caller from the approval store. Passing the ids rather than the approval objects keeps this
 * module free of that dependency and makes the join explicit and testable: a step names the
 * request it is waiting on, and whether that request is still actionable is the store's business,
 * not the log's.
 *
 * The steps are already sorted by seq and unique by seq — the reducer guarantees both, and the
 * backfill merges under the live stream with the same keys. This does not re-sort or re-dedupe,
 * so a gap in the sequence stays a visible gap (missingSeqs reports it) rather than being
 * silently closed by a renumbering.
 */
export function computerLogRows(
  task: ComputerTaskLive,
  pendingApprovalIds: ReadonlySet<string>
): ComputerLogRow[] {
  return task.steps.map((s) => ({
    seq: s.seq,
    status: s.status,
    label: computerStepLabel(s.status),
    appText: s.action?.description ?? null,
    reason: s.action?.description ? null : s.reason || null,
    consent: s.consent,
    effect: s.effect,
    pendingApprovalId:
      s.approvalRequestId !== null && pendingApprovalIds.has(s.approvalRequestId)
        ? s.approvalRequestId
        : null,
    afterStop: s.afterStop,
    at: s.at
  }))
}

/** Does any row still have an actionable approval? The pane uses this to decide whether the log
 *  needs its approve/deny affordance at all. */
export function hasPendingApproval(rows: readonly ComputerLogRow[]): boolean {
  return rows.some((r) => r.pendingApprovalId !== null)
}
