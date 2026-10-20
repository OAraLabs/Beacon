// Pure background-work model — shared by the Mission card and the headless smoke. No DOM.
//
// "What is it doing while I'm away" was the question. The live data says the answer is mostly
// CRON: on this box 24 ad-hoc tasks exist across two and a half months, none running, while four
// cron jobs run every day. A card built only on tasks would be empty almost always — technically
// correct and useless — so it shows both, and says which is which.
//
// The other rule this module exists to enforce: an empty list must say WHICH KIND of empty it is.
// "Nothing is running" and "nothing has ever run" and "I cannot see" are three different facts,
// and a blank card asserts the wrong one. That distinction is only trustworthy since the daemon
// started serving the durable task store (Prometheus #286) — before that, "nothing" could always
// have meant "nothing since the last restart".

export interface TaskRow {
  id: string
  type: string
  status: string
  description: string
  running: boolean
  /** Elapsed-so-far for a running task; total for a finished one. null = never started. */
  durationS: number | null
  error: string | null
  sessionId: string | null
  /** When the task was recorded, epoch MS (the wire carries epoch seconds). null = not given. */
  createdAt: number | null
}

export interface TaskSnapshot {
  tasks: TaskRow[]
  /** Full status histogram, independent of any filter — so "0 running" can still say what exists. */
  counts: Record<string, number>
}

export interface CronJob {
  name: string
  schedule: string
  enabled: boolean
  lastStatus: string | null
  lastRun: string | null
  nextRun: string | null
}

export const EMPTY_TASKS: TaskSnapshot = { tasks: [], counts: {} }

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function parseTasks(data: unknown): TaskSnapshot {
  if (!data || typeof data !== 'object') return EMPTY_TASKS
  const d = data as Record<string, unknown>
  const rawTasks = Array.isArray(d.tasks) ? d.tasks : []
  const counts: Record<string, number> = {}
  if (d.counts && typeof d.counts === 'object') {
    for (const [k, v] of Object.entries(d.counts as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v
    }
  }
  return {
    counts,
    tasks: rawTasks
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        id: str(r.id),
        type: str(r.type, 'task'),
        status: str(r.status, 'unknown'),
        description: str(r.description),
        running: r.running === true,
        durationS: num(r.duration_s),
        error: typeof r.error === 'string' && r.error ? r.error : null,
        sessionId: typeof r.session_id === 'string' ? r.session_id : null,
        // Epoch SECONDS on the wire (Prometheus _task_dict: "Timestamps stay epoch seconds").
        createdAt: typeof r.created_at === 'number' && Number.isFinite(r.created_at) && r.created_at > 0 ? Math.round(r.created_at * 1000) : null
      }))
      .filter((t) => t.id !== '')
  }
}

export function parseCron(data: unknown): CronJob[] {
  const rows = Array.isArray(data) ? data : Array.isArray((data as Record<string, unknown>)?.jobs) ? ((data as Record<string, unknown>).jobs as unknown[]) : []
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      // The cron wire calls it `name`; there is no separate id, so the name IS the key.
      name: str(r.name),
      schedule: str(r.schedule),
      enabled: r.enabled !== false,
      lastStatus: typeof r.last_status === 'string' ? r.last_status : null,
      lastRun: typeof r.last_run === 'string' ? r.last_run : null,
      nextRun: typeof r.next_run === 'string' ? r.next_run : null
    }))
    .filter((j) => j.name !== '')
}

/** Enabled jobs with a parseable next run, soonest first. Disabled jobs are not "upcoming". */
export function nextRuns(jobs: CronJob[], limit = 3): CronJob[] {
  return jobs
    .filter((j) => j.enabled && j.nextRun && Number.isFinite(Date.parse(j.nextRun)))
    .sort((a, z) => Date.parse(a.nextRun as string) - Date.parse(z.nextRun as string))
    .slice(0, limit)
}

/** "42s" / "3m 20s" / "1h 4m". null → "—", because a task that never started has no duration. */
export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * "in 12m" / "in 2h" / "due now". A next-run in the PAST is not rendered as a negative countdown —
 * it means the scheduler has not fired it yet, which is worth seeing as "overdue" rather than as
 * a stale-looking timestamp.
 */
export function fmtCountdown(nextRun: string | null, now: number = Date.now()): string {
  if (!nextRun) return '—'
  const t = Date.parse(nextRun)
  if (!Number.isFinite(t)) return '—'
  const delta = Math.round((t - now) / 1000)
  if (delta <= 0) return delta > -90 ? 'due now' : 'overdue'
  if (delta < 60) return `in ${delta}s`
  const m = Math.round(delta / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`
}

/**
 * Statuses named first, in this order, so the common line reads the way it always has.
 *
 * This is an ORDERING, not an allow-list. Every other key in `counts` is still named below — by
 * its own status string — because the previous version enumerated exactly two and folded
 * everything else into `total`. That is how `blocked` arrived counted and unmentioned, and
 * listing a third status here would have fixed one instance of a rule.
 */
const SUMMARY_FIRST: readonly string[] = ['completed', 'failed', 'blocked']

/**
 * Where a status's own name would put it in the wrong bucket in the reader's head.
 *
 * `blocked` is the SecurityGate refusing a command, and NOTHING RAN (Prometheus #489). It is not
 * breakage: "blocked" reads as trouble on a card someone scans for trouble. Nor is it waiting: the
 * record is finished, there is nothing left on it to approve (issue 278: "22 awaiting approval"
 * beside an empty approvals queue). It is REFUSED. To run it, approve the command or narrow it,
 * then ask again. Named, never folded into a total (issue 148).
 */
const STATUS_LABELS: Readonly<Record<string, string>> = { blocked: 'refused' }

/**
 * Live statuses, deliberately not named here: this line's own prefix already reports them, and
 * repeating them would contradict it — "Nothing running · 3 running". They can only be non-zero
 * in this branch when the caller filtered the task list, which this app never does (it GETs
 * `/api/tasks` unfiltered); the `N on record` fallback covers that case as it always did.
 */
const LIVE_STATUSES = new Set(['running', 'pending'])

/**
 * The one line at the top of the card. Distinguishes the three empties, because a blank card
 * asserts whichever the reader assumes and they are not the same fact:
 *   running > 0        — work is happening now
 *   nothing running    — but N tasks are on record, so the surface demonstrably works
 *   nothing at all     — no task has ever been recorded
 */
export function backgroundSummary(snap: TaskSnapshot): string {
  const running = snap.tasks.filter((t) => t.running).length
  const total = Object.values(snap.counts).reduce((a, b) => a + b, 0)
  if (running > 0) return `${running} task${running === 1 ? '' : 's'} running`
  if (total > 0) {
    // Known statuses in their fixed order, then anything else the daemon sent, sorted so the
    // line is deterministic. Nothing is dropped: a status this file has never heard of appears
    // under its own name rather than vanishing into the total.
    const rest = Object.keys(snap.counts)
      .filter((k) => !SUMMARY_FIRST.includes(k) && !LIVE_STATUSES.has(k))
      .sort()
    const parts = [...SUMMARY_FIRST, ...rest]
      .map((key) => {
        const n = snap.counts[key] ?? 0
        return n > 0 ? `${n} ${STATUS_LABELS[key] ?? key}` : ''
      })
      .filter(Boolean)
    return `Nothing running · ${parts.join(', ') || `${total} on record`}`
  }
  return 'No background task has ever run'
}

/** The summary line's tooltip: its numbers are ALL-TIME (the daemon's histogram, Prometheus #489),
 *  and a refusal is said in words, since the line itself only has room for the count. */
export function backgroundSummaryTitle(snap: TaskSnapshot): string {
  const refused = snap.counts.blocked ?? 0
  const base = 'All-time totals, since this Prometheus began recording tasks.'
  return refused > 0 ? `${base} ${refused} refused. ${REFUSAL_MEANING}` : base
}

// ── Recent refusals (issue 278) ─────────────────────────────────────────────────────────────────
// The card's refused NUMBER is recent, not lifetime: an all-time count beside "Nothing running"
// never goes down and reads like a growing backlog nobody is working. The all-time total stays in
// the tooltip (and in the summary line), so refusals stay visible (issue 148).

/** Issue 278's wording, verbatim. */
export const REFUSAL_MEANING = 'Refused by the SecurityGate, nothing ran. To run it, approve the command or narrow it, then ask again.'
export const REFUSED_WINDOW_DAYS = 7
/** The daemon caps a task list at 200 (Prometheus server.py list_tasks). */
export const TASK_LIST_CAP = 200
/** Newest first, refusals only: enough to count the window, and the cap is the daemon's own. */
export const REFUSED_TASKS_PATH = `/api/tasks?status=blocked&limit=${TASK_LIST_CAP}`

export interface RecentRefusals {
  /** Refusals recorded in the window. */
  recent: number
  /** The list came back full AND every row was in the window: there may be more ("200+"). */
  capped: boolean
}

/** Count the window from the `?status=blocked` list. Rows without a time are not counted as recent. */
export function recentRefusals(list: TaskSnapshot, now: number = Date.now(), days: number = REFUSED_WINDOW_DAYS): RecentRefusals {
  const since = now - days * 86_400_000
  const blocked = list.tasks.filter((t) => t.status === 'blocked')
  const recent = blocked.filter((t) => t.createdAt !== null && t.createdAt >= since).length
  return { recent, capped: list.tasks.length >= TASK_LIST_CAP && recent >= TASK_LIST_CAP }
}

/**
 * The card's refused link: shown only when something was refused in the window. The all-time total
 * is in its tooltip; when nothing is recent the link is absent, and the all-time count is still named
 * on the summary line (and in that line's tooltip).
 */
export function refusedBadge(r: RecentRefusals, allTime: number, days: number = REFUSED_WINDOW_DAYS): { show: boolean; text: string; title: string } {
  const n = `${r.recent}${r.capped ? '+' : ''}`
  const window = days === 7 ? 'this week' : `in ${days} days`
  return {
    show: r.recent > 0,
    text: `${n} refused ${window} →`,
    title: `${REFUSAL_MEANING} ${n} in the last ${days} days, ${allTime} in all.`
  }
}

/** Cron health for the card's accent: any enabled job whose LAST run failed is worth a colour. */
export function cronTrouble(jobs: CronJob[]): CronJob[] {
  return jobs.filter((j) => j.enabled && j.lastStatus !== null && j.lastStatus !== 'success')
}
