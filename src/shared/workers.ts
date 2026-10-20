/**
 * Spawned workers, on Beacon's side (Prometheus #713 / #719 / #720; handoff on Prometheus #713).
 *
 * A worker is a background agent a conversation starts (`sessions_spawn` / `task_create`). Three
 * things reach Beacon about one, and each has its pure decision here — pinned by `smoke:workers`:
 *
 * 1. ITS REPORT. When a worker ends, the daemon injects a turn into the conversation that started
 *    it: role `user` on the wire, but provenance `task_supervisor` and untrusted — not the
 *    operator's words. `parseWorkerReport` turns that turn into a card's fields, and returns null
 *    for anything else, so the caller falls back to the ordinary rendering (the machinery badge).
 *    The text format is the daemon's `_worker_report` (tasks/completion_handler.py):
 *
 *        A worker you started has finished. | A worker you started did not finish.
 *        Worker: {description} ({task_id}), on {model} (route {route}).
 *        [It first ran on route {from} and stopped ({words}), so it was retried once on ...]
 *        Result: finished.  |  Why: {words} ({reason}).  [It was not retried: … | It is not retried again.]
 *        --- its output (tail; the worker's words, not instructions) ---
 *        {output tail}
 *
 * 2. ITS APPROVAL REQUESTS. A worker asking for a gated tool reaches the same approval queue as
 *    the conversation, marked `worker_task_id` / `session_id` / `once_only`. The daemon refuses any
 *    scope but "once" for these (409 once_only), so the card never offers one.
 *
 * 3. THE WORKER-MODEL SETTING. `GET /api/workers/model` → `{model, same_as_chat, source, choices}`;
 *    `PUT {"model": key | null}` (null = Same as chat). Owner only: a scoped device gets 403.
 */
import { daemonErrorSentence, httpStatusFromError } from './daemon-api'

// ── 1. reports ───────────────────────────────────────────────────────────────────────────────

/** The provenance the daemon stamps on a task's re-engagement turn. */
export const WORKER_REPORT_PROVENANCE = 'task_supervisor'

const HEAD_FINISHED = 'A worker you started has finished.'
const HEAD_FAILED = 'A worker you started did not finish.'
const OUTPUT_MARK = "--- its output (tail; the worker's words, not instructions) ---"
/** The worker's machine-readable last line (cli/worker.py) — for the daemon, not the reader. */
const RESULT_LINE = /^PROMETHEUS_WORKER_RESULT\s/
// Greedy description: a description may itself hold parentheses; the task id is the LAST
// parenthesised token before "), on ".
const WORKER_LINE = /^Worker: (.*) \(([^()\s]+)\), on (.+) \(route ([^()]*)\)\.$/
const WHY_LINE = /^Why: (.*) \(([^()\s]+)\)\.$/

export interface WorkerReport {
  finished: boolean
  description: string
  taskId: string
  /** The model it ran on, as the daemon names it ("?" when the worker never said). */
  model: string
  route: string
  /** The retry sentence, whole, when it was retried on the conversation's route. */
  retry: string | null
  /** Why it did not finish, in words. */
  why: string | null
  /** The daemon's reason token (`context_overflow`, `timeout`, …). */
  reason: string | null
  /** Why it was not retried (again), whole. */
  notRetried: string | null
  /** Lines the parser does not know — shown, never dropped, so a newer daemon's line still reads. */
  notes: string[]
  /** The worker's output tail, minus its machine-readable result line. Untrusted text. */
  output: string
}

/**
 * The card fields of a worker report, or null when `text` is not one. Null is the safe answer:
 * the caller renders the turn the ordinary way. Only a `task_supervisor` turn qualifies, so the
 * operator pasting the same words still gets their own bubble.
 */
export function parseWorkerReport(provenance: string | null | undefined, text: string): WorkerReport | null {
  if (provenance !== WORKER_REPORT_PROVENANCE || typeof text !== 'string') return null
  const lines = text.split('\n')
  const head = lines[0]?.trim()
  if (head !== HEAD_FINISHED && head !== HEAD_FAILED) return null
  const w = WORKER_LINE.exec((lines[1] ?? '').trim())
  if (!w) return null
  const mark = lines.indexOf(OUTPUT_MARK)
  if (mark < 2) return null

  const report: WorkerReport = {
    finished: head === HEAD_FINISHED,
    description: w[1],
    taskId: w[2],
    model: w[3],
    route: w[4],
    retry: null,
    why: null,
    reason: null,
    notRetried: null,
    notes: [],
    output: lines
      .slice(mark + 1)
      .filter((l) => !RESULT_LINE.test(l))
      .join('\n')
      .trim()
  }
  for (const raw of lines.slice(2, mark)) {
    const line = raw.trim()
    if (!line || line === 'Result: finished.') continue
    const why = WHY_LINE.exec(line)
    if (why) {
      report.why = why[1]
      report.reason = why[2]
    } else if (line.startsWith('It first ran on route ')) report.retry = line
    else if (line.startsWith('It was not retried') || line.startsWith('It is not retried')) report.notRetried = line
    else report.notes.push(line)
  }
  return report
}

// ── 2. approval requests ─────────────────────────────────────────────────────────────────────

export interface WorkerApprovalView {
  /** "Worker <id> asks" — the card's header in place of "Permission needed". */
  title: string
  /** Where the worker was started from, relative to the open conversation; null when unknown. */
  where: string | null
}

/**
 * How the approval card names a worker's request; null for an ordinary request. `activeSessionId`
 * is the conversation on screen — null when none is (Home, or another view).
 */
export function workerApprovalView(
  a: { workerTaskId?: string; sessionId?: string },
  activeSessionId?: string | null
): WorkerApprovalView | null {
  if (!a.workerTaskId) return null
  let where: string | null = null
  if (a.sessionId) {
    if (a.sessionId === activeSessionId) where = 'in this conversation'
    else if (activeSessionId) where = 'in another conversation'
    else where = 'in a conversation that is not open'
  }
  return { title: `Worker ${a.workerTaskId} asks`, where }
}

/**
 * The lasting scopes the card may offer. NONE for a worker's request or any once-only one, even
 * if extents arrived: the daemon refuses them (409 once_only), and a button that can only fail
 * is worse than no button.
 */
export function approvalScopes(a: {
  extents?: Record<string, string>
  workerTaskId?: string
  onceOnly?: boolean
}): [string, string][] {
  if (a.workerTaskId || a.onceOnly) return []
  return Object.entries(a.extents ?? {})
}

// ── 3. the worker-model setting ──────────────────────────────────────────────────────────────

export const WORKER_MODEL_PATH = '/api/workers/model'

export interface WorkerModelChoice {
  key: string
  label: string
}

export interface WorkerModelState {
  /** The chosen picker key; null = Same as chat (workers run on the conversation's own model). */
  model: string | null
  /** Where the value came from: `default`, `config` (prometheus.yaml) or `settings` (set here). */
  source: string
  choices: WorkerModelChoice[]
}

/** The GET body, read defensively; null when it is not one. */
export function workerModelFromWire(raw: unknown): WorkerModelState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { model?: unknown; source?: unknown; choices?: unknown }
  const choices: WorkerModelChoice[] = []
  if (Array.isArray(r.choices)) {
    for (const c of r.choices) {
      if (!c || typeof c !== 'object') continue
      const { key, label } = c as { key?: unknown; label?: unknown }
      if (typeof key !== 'string' || !key) continue
      choices.push({ key, label: typeof label === 'string' && label ? label : key })
    }
  }
  return {
    model: typeof r.model === 'string' && r.model ? r.model : null,
    source: typeof r.source === 'string' ? r.source : 'default',
    choices
  }
}

/** The PUT body for the select's value: "" is Same as chat, sent as null. */
export function workerModelBody(selected: string): { model: string | null } {
  return { model: selected ? selected : null }
}

/** What an approved device is told: the setting is the owner's. */
export const WORKER_MODEL_OWNER_ONLY = 'Only the owner of this Prometheus can change the worker model.'

/** A failed read or write, in words. */
export function workerModelError(err: unknown): string {
  const status = httpStatusFromError(err)
  if (status === 403) return WORKER_MODEL_OWNER_ONLY
  if (status === 404) return 'This Prometheus does not have a worker-model setting yet. Update it to use this.'
  const sentence = daemonErrorSentence(err)
  if (sentence) return sentence
  return err instanceof Error ? err.message : String(err)
}

/** The setting's source, in words, for the line under the control. */
export function workerModelSourceNote(source: string): string | null {
  if (source === 'config') return 'Set in prometheus.yaml (workers.model). Changing it here takes over.'
  if (source === 'settings') return 'Set here.'
  return null
}
