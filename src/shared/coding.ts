// Coding-surface DTOs + PURE helpers (Phase C). Shapes mirror the daemon's /api/code contract
// (POST + GET) and the coding subprocess's final JSON report, AS SHIPPED — see
// docs/CODING-SURFACE-PHASE-C.md for the citations. No React, no IO: the renderer panel and the
// headless smoke share one source of truth.

/** POST /api/code body. Caps default to the daemon's own (30 rounds / 1200 s) — see CODING_DEFAULTS. */
export interface CodingLaunchRequest {
  repo: string
  description: string
  acceptance_command: string
  task_id?: string
  max_rounds?: number
  max_wall_seconds?: number
}

/** POST /api/code response. `task_id` is the managed-task handle to POLL; `coding_task_id` names the
 * artifact branch `coding/<id>`. */
export interface CodingLaunchResult {
  task_id: string
  coding_task_id: string
  status: string
  output_file: string
}

/** GET /api/code/{task_id} response — the managed task's lifecycle.
 *
 * `report` is the run's terminal report, parsed DAEMON-SIDE from the full output (Prometheus#495).
 * Prefer it. `output_tail` is the diagnostic end of the log and is still parsed as a fallback for a
 * daemon that predates the `report` field — see reportFromStatus.
 */
export interface CodingRunStatus {
  task_id: string
  status: 'running' | 'completed' | 'failed' | string
  description?: string
  created_at?: number
  started_at?: number | null
  ended_at?: number | null
  return_code?: number | null
  error?: string | null
  /** The daemon-parsed terminal report, or null while running / when it printed none. Absent on a
   *  daemon older than Prometheus#495. */
  report?: CodingRunReport | null
  output_tail?: string
}

/** The coding subprocess's terminal report. Arrives as the daemon-parsed `report` field
 * (Prometheus#495), or is parsed out of `output_tail` for an older daemon — see reportFromStatus.
 * `status` is the run verdict (distinct from the managed-task `status` above). */
export interface CodingRunReport {
  task_id?: string
  status: 'success' | 'failed_abandoned' | 'failed_error' | string
  reason?: string
  rounds_used?: number
  episodes?: number
  wall_seconds?: number
  acceptance_exit?: number | null
  acceptance_output_tail?: string
  branch?: string
  diff_stat?: string
  sandbox_root?: string
}

export const CODING_DEFAULTS = { maxRounds: 30, maxWallSeconds: 1200 } as const

/** Extract the final JSON report from a managed task's output tail. The subprocess prints exactly
 * one JSON object (the report) to stdout at the end; we take the LAST balanced `{...}` so any
 * leading log noise is ignored. Returns null when no report has been emitted yet (still running). */
export function parseCodingReport(outputTail: string | undefined): CodingRunReport | null {
  if (!outputTail) return null
  const start = outputTail.lastIndexOf('\n{')
  // Either a report at the very start, or the last top-level object after a newline.
  const candidates: string[] = []
  if (outputTail.trimStart().startsWith('{')) candidates.push(outputTail.trim())
  if (start >= 0) candidates.push(outputTail.slice(start + 1).trim())
  for (const c of candidates.reverse()) {
    try {
      const obj = JSON.parse(c) as CodingRunReport
      if (obj && typeof obj === 'object' && typeof obj.status === 'string') return obj
    } catch {
      /* not the report */
    }
  }
  return null
}

/**
 * The run's terminal report, from whichever source the daemon provided.
 *
 * PREFERS the daemon-parsed `report` field (Prometheus#495) and falls back to parsing
 * `output_tail` for a daemon that predates it. The fallback is not dead weight: Beacon must work
 * against any daemon vintage, and an older daemon is the normal case during a rolling upgrade.
 *
 * WHY THE FIELD EXISTS AT ALL (Beacon#130 / audit P9.10). The report is the LAST JSON object in
 * the task's output, and `output_tail` is the file's last 4000 bytes — so a report larger than that
 * cap started mid-object and this function returned null for a run that HAD finished and printed a
 * valid report. Reachable, not theoretical: the report's `acceptance_output_tail` is capped at 3000
 * chars and `diff_stat` is uncapped (one line per changed file), so a run touching a few hundred
 * files overflows. The daemon now parses the full output and sends the object, so size no longer
 * matters; the tail stays what it should always have been — the diagnostic end of the log.
 *
 * A present `report` of null means "no report" and is honoured as such (still running, or killed
 * before printing) rather than re-parsed from the tail — the daemon read the whole file and found
 * nothing, so the tail cannot know better.
 */
export function reportFromStatus(status: CodingRunStatus | null | undefined): CodingRunReport | null {
  if (!status) return null
  if (status.report !== undefined) return status.report ?? null
  return parseCodingReport(status.output_tail)
}

export type CodingPhase = 'launching' | 'running' | 'review'

/** The daemon's terminal managed-task statuses — a run in any of these is done (completed/failed
 * naturally, killed by a Stop, or refused by the SecurityGate before anything was launched).
 *
 * `blocked` added with Prometheus #489. It is terminal daemon-side (it is in TERMINAL_STATUSES
 * there), so omitting it here would leave the panel waiting for an end state that already
 * arrived — a spinner with nothing behind it. Latent on the usual path, because a refused run is
 * answered as HTTP 400 at creation and never yields a task_id to poll; latent by a route's
 * behaviour is not the same as safe, and this set cannot see that route. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'blocked'])

/** Map a managed-task status (+ whether a report has parsed) to the panel's state machine. A
 * terminal managed status OR a parsed report means we can show the artifact. (A killed run is
 * terminal even though the SIGKILL'd subprocess never printed a report.) */
export function runPhase(status: string | undefined, hasReport: boolean): CodingPhase {
  if (hasReport) return 'review'
  if (status && TERMINAL_STATUSES.has(status)) return 'review'
  return 'running'
}

/** GET /api/code/{id}/diff response. `ready` is false while the run hasn't reported yet. */
export interface CodingDiffResult {
  ready: boolean
  branch?: string | null
  diff?: string
  truncated?: boolean
}

export type DiffLineTone = 'add' | 'del' | 'hunk' | 'meta' | 'context'

/** Classify a unified-diff line for coloring (pure — the renderer maps tone → token color). `+++`/
 * `---` file headers are 'meta', not add/del, so they don't read as content changes. */
export function diffLineTone(line: string): DiffLineTone {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export interface CodingStateLabel {
  text: string
  tone: 'ok' | 'warn' | 'err'
}

/** Honest verdict label for the artifact header. Converted (acceptance went green) vs abandoned at a
 * cap vs an error/crash — never "success" for a run that didn't actually pass. */
export function codingStateLabel(report: CodingRunReport | null, managedStatus?: string): CodingStateLabel {
  if (!report) {
    // A refusal is not a failure and must not wear the error tone: nothing ran, so there is
    // nothing to debug — the repair is to approve the command or narrow it (Prometheus #489).
    if (managedStatus === 'blocked') return { text: 'Refused — nothing ran', tone: 'warn' }
    if (managedStatus === 'failed') return { text: 'Failed — no report', tone: 'err' }
    return { text: 'No report', tone: 'warn' }
  }
  switch (report.status) {
    case 'success':
      return { text: 'Converted ✓', tone: 'ok' }
    case 'failed_abandoned':
      return { text: 'Abandoned at cap', tone: 'warn' }
    case 'failed_error':
      return { text: 'Failed (error)', tone: 'err' }
    default:
      return { text: report.status, tone: 'warn' }
  }
}

/** Copy-able git commands for the OWNER to review the artifact themselves — review-only by design:
 * Beacon never merges or pushes. The branch lives in the daemon-side sandbox clone (`sandbox_root`).
 * Returns [] when the report lacks the branch/root (e.g. an early error). */
export function codingGitCommands(report: CodingRunReport | null): string[] {
  if (!report?.branch || !report?.sandbox_root) return []
  const root = report.sandbox_root
  const branch = report.branch
  return [
    `cd ${root}`,
    `git log --oneline -1 ${branch}`,
    `git diff main..${branch}`,
    `git checkout ${branch}`
  ]
}

/** Whole-seconds elapsed between two epoch-second stamps (started → ended/now), clamped ≥ 0. */
export function elapsedSeconds(startedAt?: number | null, endedAt?: number | null, nowMs = 0): number {
  if (!startedAt) return 0
  const end = endedAt ?? (nowMs ? nowMs / 1000 : 0)
  return Math.max(0, Math.round(end - startedAt))
}

// ── Live-stream (feat/coding-live-view) — Phase A WS event contract ──────────
// The daemon's CodingLiveStream fans these over the authed WS as the run proceeds
// (Prometheus PR #48). Payload shapes mirror coding/livestream.py exactly. v1
// renders round-level progression; per-round tool name + test pass/fail are NOT on
// the wire (tool_calls has no session_id — survey finding), a daemon follow-up.

/** One `coding_round` event, normalized for the Live view. */
export interface CodingRoundLive {
  roundIndex: number
  /**
   * The daemon's rowid — monotonic across the WHOLE run, unlike `roundIndex` which restarts at 0
   * every EPISODE (`run_loop` is invoked once per episode). This is the de-dupe and sort key (P9.9,
   * Prometheus#127): de-duping on `roundIndex` alone made episode 2's round 0 collide with episode
   * 1's, so the reducer dropped it as a duplicate and the Live view froze while the daemon kept
   * working. `null` only for a daemon predating the `seq` field, where `roundIndex` is the
   * best-effort fallback (still wrong across episodes, but it is all such a daemon offers).
   */
  seq: number | null
  outcome: string
  inputTokens: number | null
  outputTokens: number | null
  thinking: boolean | null
  durationMs: number | null
  stopReason: string | null
}

/** The de-dupe + ordering key for a round: `seq` (run-monotonic) when the daemon sent it, else
 *  `roundIndex` (episode-scoped — collides across episodes, but the only thing an old daemon
 *  offers). Within one run a single daemon either always sends seq or never does, so the key space
 *  is consistent and comparing key-to-key is sound. */
export function roundKey(r: { seq: number | null; roundIndex: number }): number {
  return r.seq ?? r.roundIndex
}

/** The terminal `coding_complete` event (the run verdict). */
export interface CodingCompleteLive {
  outcome: string
  exitCode: number | null
  taskStatus: string | null
}

/** Live state for one coding run, accumulated from its WS events. */
/** One `coding_tool` frame — a tool_calls row the daemon's tailer attributed to a round.
 *
 * `roundIndex` is the daemon's attribution, not a guess: the loop commits round N's row BEFORE
 * round N's tools execute, so the tailer assigns each tool row to the last round it emitted. null
 * only for a row that somehow precedes every round. */
export interface CodingToolLive {
  seq: number | null
  roundIndex: number | null
  toolName: string
  success: boolean
  errorType: string | null
  latencyMs: number | null
}

/** The `coding_acceptance` frame — the GROUND-TRUTH verdict from `_run_acceptance`, never the
 * model's claim about whether it passed. */
export interface CodingAcceptanceLive {
  seq: number | null
  outcome: string
  exitCode: number | null
  timedOut: boolean | null
  outputTail: string | null
}

/**
 * How many tool frames one run keeps.
 *
 * Rounds are bounded by `max_rounds`; tools are NOT — a 30-round run with a dozen tools a round is
 * hundreds of frames. Newest-wins, and `toolsTruncated` MUST be rendered when it trips: a cap the
 * user cannot see is a list that quietly lies about how much work happened.
 */
export const CODING_TOOL_CAP = 200

export interface CodingRunLive {
  rounds: CodingRoundLive[]
  /** Newest-last, capped at CODING_TOOL_CAP. */
  tools: CodingToolLive[]
  /** True once the cap has dropped at least one tool frame. Surface it; never swallow it. */
  toolsTruncated: boolean
  /** Ground-truth acceptance verdicts, newest-last (one per round that ran the command). */
  acceptance: CodingAcceptanceLive[]
  complete: CodingCompleteLive | null
  /** Non-fatal: the daemon's tail hit an error. The run continues; the report still loads. */
  streamError: string | null
}

/** session_id (`coding:<id>`) → live run state. */
export type CodingRuns = Record<string, CodingRunLive>

const EMPTY_RUN: CodingRunLive = { rounds: [], tools: [], toolsTruncated: false, acceptance: [], complete: null, streamError: null }

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The coding frame kinds this reducer folds — ONE set, exported so the gateway store gates on the
 * same thing rather than a second hand-written list. Prometheus `coding/livestream.py` declares the
 * emitter side as CODING_FRAME_KINDS and `web/ws_server.py` promotes from it; this is the
 * consumer's half of that contract.
 *
 * `coding_acceptance` and `coding_tool` were emitted for months and never arrived as themselves:
 * ws_server had no promotion entry, so they shipped wrapped as `sentinel_signal` with the real kind
 * nested at `payload.kind`, and every gate keyed on `ev.type` matched nothing. Fixed in
 * Prometheus#503; the fixture in `src/main/fixtures/` is the first capture where they arrive
 * promoted.
 */
export const CODING_EVENT_KINDS: ReadonlySet<string> = new Set([
  'coding_round',
  'coding_acceptance',
  'coding_tool',
  'coding_complete',
  'coding_stream_error'
])

/** A gateway frame as surfaced to the renderer store (ws.ts `onGatewayEvent` shape). */
export interface CodingGatewayEvent {
  type: string
  payload: Record<string, unknown>
}

/** Fold one coding_* gateway event into the runs map. PURE — the store and the headless
 * smoke share it. Returns the SAME ref for non-coding / unkeyed / duplicate-round events so
 * unrelated frames don't churn React state. Rounds are kept sorted by round_index and
 * de-duped (Phase A guarantees no dupes, but a WS reconnect replay could repeat one). */
export function reduceCodingRuns(prev: CodingRuns, ev: CodingGatewayEvent): CodingRuns {
  if (!CODING_EVENT_KINDS.has(ev.type)) return prev
  const sid = typeof ev.payload.session_id === 'string' ? ev.payload.session_id : ''
  if (!sid) return prev
  const cur = prev[sid] ?? EMPTY_RUN

  if (ev.type === 'coding_round') {
    const idx = ev.payload.round_index
    if (typeof idx !== 'number') return prev
    // seq is the daemon's rowid — monotonic across the whole run. It, not round_index (which
    // restarts every episode), is the de-dupe and sort key. P9.9/Prometheus#127.
    const seq = numOrNull(ev.payload.seq)
    const key = seq ?? idx
    // De-dupe on the run-monotonic key. A WS reconnect replays a frame with the SAME seq, so this
    // still drops the replay — but episode 2's round 0 has a NEW seq and is correctly kept.
    if (cur.rounds.some((r) => roundKey(r) === key)) return prev
    const round: CodingRoundLive = {
      roundIndex: idx,
      seq,
      outcome: typeof ev.payload.outcome === 'string' ? ev.payload.outcome : '',
      inputTokens: numOrNull(ev.payload.input_tokens),
      outputTokens: numOrNull(ev.payload.output_tokens),
      thinking: ev.payload.thinking == null ? null : Boolean(ev.payload.thinking),
      durationMs: numOrNull(ev.payload.duration_ms),
      stopReason: ev.payload.stop_reason == null ? null : String(ev.payload.stop_reason)
    }
    // Sort by the same monotonic key so episode 2's rounds land AFTER episode 1's, not interleaved
    // by a round_index that restarted at 0.
    const rounds = [...cur.rounds, round].sort((a, z) => roundKey(a) - roundKey(z))
    return { ...prev, [sid]: { ...cur, rounds } }
  }

  if (ev.type === 'coding_tool') {
    const seq = numOrNull(ev.payload.seq)
    // De-dupe on the daemon's rowid, same reasoning as rounds: a WS reconnect replays frames.
    if (seq != null && cur.tools.some((t) => t.seq === seq)) return prev
    const tool: CodingToolLive = {
      seq,
      roundIndex: numOrNull(ev.payload.round_index),
      toolName: typeof ev.payload.tool_name === 'string' ? ev.payload.tool_name : '',
      success: ev.payload.success === true,
      errorType: ev.payload.error_type == null ? null : String(ev.payload.error_type),
      latencyMs: numOrNull(ev.payload.latency_ms)
    }
    // Newest-wins at the cap. `toolsTruncated` latches true and is rendered — an invisible cap is
    // a list that quietly lies about how much work happened.
    const all = [...cur.tools, tool]
    const overflowed = all.length > CODING_TOOL_CAP
    return {
      ...prev,
      [sid]: {
        ...cur,
        tools: overflowed ? all.slice(all.length - CODING_TOOL_CAP) : all,
        toolsTruncated: cur.toolsTruncated || overflowed
      }
    }
  }

  if (ev.type === 'coding_acceptance') {
    const seq = numOrNull(ev.payload.seq)
    if (seq != null && cur.acceptance.some((a) => a.seq === seq)) return prev
    const verdict: CodingAcceptanceLive = {
      seq,
      outcome: typeof ev.payload.outcome === 'string' ? ev.payload.outcome : '',
      exitCode: numOrNull(ev.payload.exit_code),
      timedOut: ev.payload.timed_out == null ? null : Boolean(ev.payload.timed_out),
      outputTail: ev.payload.output_tail == null ? null : String(ev.payload.output_tail)
    }
    return { ...prev, [sid]: { ...cur, acceptance: [...cur.acceptance, verdict] } }
  }

  if (ev.type === 'coding_complete') {
    const complete: CodingCompleteLive = {
      outcome: typeof ev.payload.outcome === 'string' ? ev.payload.outcome : '',
      exitCode: numOrNull(ev.payload.exit_code),
      taskStatus: ev.payload.task_status == null ? null : String(ev.payload.task_status)
    }
    return { ...prev, [sid]: { ...cur, complete } }
  }

  // coding_stream_error
  const error =
    typeof ev.payload.error === 'string' && ev.payload.error ? ev.payload.error : 'stream interrupted'
  return { ...prev, [sid]: { ...cur, streamError: error } }
}
