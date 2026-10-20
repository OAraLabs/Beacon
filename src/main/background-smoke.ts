/**
 * Headless smoke for the Mission background card. Pure model only.
 *
 * The card exists to answer "what is it doing while I'm away", and its hardest job is the EMPTY
 * case: "nothing is running", "nothing has ever run" and "I cannot see" are three different facts
 * and a blank card asserts whichever the reader assumes. Most of what follows defends that.
 *
 * Run: npm run smoke:background
 */
import {
  EMPTY_TASKS,
  REFUSED_TASKS_PATH,
  TASK_LIST_CAP,
  backgroundSummary,
  backgroundSummaryTitle,
  recentRefusals,
  refusedBadge,
  cronTrouble,
  fmtCountdown,
  fmtDuration,
  nextRuns,
  parseCron,
  parseTasks
} from '@shared/background'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────────────────────
// SHAPE captured from the deployed daemon (Prometheus bcc7b63, 2026-08-27). What the live read
// confirmed rather than what I assumed:
//   /api/tasks  {tasks, counts} with counts {"failed": 10, "completed": 14} — the histogram is
//               present even when the filtered list is empty, which is the whole point of it
//   /api/cron   a bare ARRAY (not {jobs: [...]}), and the job key is `name` — there is no `id`
//               field at all, so a client keying on id would render four rows keyed `undefined`
const TASKS_WIRE = {
  tasks: [
    { id: 'p1', type: 'poll', status: 'failed', description: 'watch the vault', running: false, duration_s: 0.0, error: 'timeout', session_id: null },
    { id: 'b1', type: 'local_bash', status: 'completed', description: 'build the dmg', running: false, duration_s: 184.2, error: null, session_id: 'beacon:1' }
  ],
  counts: { failed: 10, completed: 14 }
}
const CRON_WIRE = [
  { name: 'oara_heartbeat_watcher', schedule: '*/10 * * * *', enabled: true, last_status: 'success', last_run: '2026-08-27T17:40:00', next_run: '2026-08-27T17:50:00' },
  { name: 'eval_test', schedule: '0 * * * *', enabled: true, last_status: 'success', last_run: '2026-08-27T17:00:00', next_run: '2026-08-27T18:00:00' },
  { name: 'daily_news_briefing_pm', schedule: '30 19 * * *', enabled: true, last_status: 'success', last_run: '2026-08-26T19:30:00', next_run: '2026-08-27T19:30:00' },
  { name: 'retired_job', schedule: '0 0 * * *', enabled: false, last_status: 'failed', last_run: '2026-08-01T00:00:00', next_run: '2026-08-28T00:00:00' }
]

console.log('[smoke] === 1. the three empties are three different sentences ===')
assert(backgroundSummary(EMPTY_TASKS) === 'No background task has ever run', 'nothing recorded says exactly that')
const idle = parseTasks({ tasks: [], counts: { completed: 14, failed: 10 } })
assert(
  backgroundSummary(idle) === 'Nothing running · 14 completed, 10 failed',
  `idle-but-working says what EXISTS, so the card is visibly not broken (got "${backgroundSummary(idle)}")`
)
assert(backgroundSummary(EMPTY_TASKS) !== backgroundSummary(idle), 'and the two empties never read alike')
const busy = parseTasks({ tasks: [{ id: 'x', running: true, status: 'running' }], counts: { running: 1 } })
assert(backgroundSummary(busy) === '1 task running', 'one running task is singular')
const busier = parseTasks({ tasks: [{ id: 'x', running: true }, { id: 'y', running: true }], counts: { running: 2 } })
assert(backgroundSummary(busier) === '2 tasks running', 'two are plural')
// counts survive even when the LIST is filtered to nothing — the reason the daemon sends them
const filtered = parseTasks({ tasks: [], counts: { completed: 14 } })
assert(filtered.counts.completed === 14, 'a filtered-empty list still knows what exists')

console.log('[smoke] === 1b. a refusal is NAMED, never absorbed (Prometheus issue 489) ===')
// The daemon gained a distinct `blocked` status for a task the SecurityGate refused. This summary
// enumerated exactly `completed` and `failed` and folded everything else into `total`, so refusals
// arrived COUNTED and MENTIONED NOWHERE — the consumer half of that fix.
const withRefusals = parseTasks({ tasks: [], counts: { completed: 76, failed: 13, blocked: 7 } })
assert(
  backgroundSummary(withRefusals) === 'Nothing running · 76 completed, 13 failed, 7 refused',
  `a refusal is named, as REFUSED: not damage, and not waiting either (issue 278) (got "${backgroundSummary(withRefusals)}")`
)
assert(!backgroundSummary(withRefusals).includes('96'), 'the 7 are never folded into a bare total of 96')

// The degenerate case named in the issue: refusals ONLY. Before, completed=0 and failed=0 left the
// parts list empty and the card fell back to "3 on record" — the one state where it knows that
// something happened and cannot say what.
const refusalsOnly = parseTasks({ tasks: [], counts: { blocked: 3 } })
assert(
  backgroundSummary(refusalsOnly) === 'Nothing running · 3 refused',
  `a card holding only refusals still says what they are (got "${backgroundSummary(refusalsOnly)}")`
)

// THE RULE, NOT THE LIST. A status this client has never heard of must still appear, under its own
// name. Without this assertion the fix is one special case and the next vocabulary addition on the
// daemon side is a third instance of the same bug.
const unheardOf = parseTasks({ tasks: [], counts: { completed: 2, quarantined: 5 } })
assert(
  backgroundSummary(unheardOf) === 'Nothing running · 2 completed, 5 quarantined',
  `an unknown status is surfaced under its own name, not dropped (got "${backgroundSummary(unheardOf)}")`
)

// ...and the ordinary line is unchanged, so none of the above cost the common case anything.
assert(
  backgroundSummary(idle) === 'Nothing running · 14 completed, 10 failed',
  'the ordinary two-status line reads exactly as it did before'
)

console.log('[smoke] === 2. tasks parse ===')
const t = parseTasks(TASKS_WIRE)
assert(t.tasks.length === 2 && t.counts.failed === 10, 'captured wire parses')
assert(t.tasks[0].error === 'timeout', 'a failure keeps its reason')
assert(t.tasks[1].durationS === 184.2, 'duration survives as a number')
assert(parseTasks({ tasks: [{ type: 'x' }] }).tasks.length === 0, 'a task with no id is dropped — it could not be stopped')
assert(parseTasks(null).tasks.length === 0 && parseTasks('no' as unknown).counts.failed === undefined, 'junk payloads degrade')
assert(parseTasks({ tasks: [{ id: 'a' }] }).tasks[0].running === false, 'running defaults to FALSE — never claim work is happening on a missing field')
assert(parseTasks({ tasks: [{ id: 'a' }] }).tasks[0].durationS === null, 'a missing duration is null, not 0')

console.log('[smoke] === 3. cron parse (a bare array, keyed by name) ===')
const c = parseCron(CRON_WIRE)
assert(c.length === 4, 'a bare ARRAY parses — the cron wire is not {jobs: [...]}')
assert(c[0].name === 'oara_heartbeat_watcher', 'the job key is `name`; there is no id field on the wire')
assert(parseCron({ jobs: CRON_WIRE }).length === 4, 'a wrapped shape also parses, so the client survives either')
assert(parseCron([{ schedule: '* * * * *' }]).length === 0, 'a nameless job is dropped rather than rendered blank')
assert(parseCron(null).length === 0, 'null degrades')
assert(c[3].enabled === false, 'a disabled job still parses — it is a fact, just not upcoming')

console.log('[smoke] === 4. what is coming next ===')
const up = nextRuns(c, 3)
assert(up.length === 3, 'three upcoming shown')
assert(up[0].name === 'oara_heartbeat_watcher', 'soonest first')
assert(up.every((j) => j.enabled), 'a DISABLED job is never "upcoming" — it is not going to run')
assert(!up.some((j) => j.name === 'retired_job'), 'even though its next_run is the nearest in absolute terms')
assert(nextRuns(parseCron([{ name: 'x', enabled: true, next_run: 'not-a-date' }])).length === 0, 'an unparseable next_run is not upcoming')
assert(nextRuns([], 3).length === 0, 'no jobs, no rows')

console.log('[smoke] === 5. cron health ===')
assert(cronTrouble(c).length === 0, 'a disabled failing job is NOT trouble — it is not running')
const failing = parseCron([{ name: 'j', enabled: true, last_status: 'failed', next_run: '2026-08-27T19:00:00' }])
assert(cronTrouble(failing).length === 1, 'an ENABLED job whose last run failed is trouble')
assert(cronTrouble(parseCron([{ name: 'j', enabled: true, next_run: '2026-08-27T19:00:00' }])).length === 0, 'a job that has never run is not yet trouble')

console.log('[smoke] === 6. durations and countdowns ===')
assert(fmtDuration(42) === '42s' && fmtDuration(200) === '3m 20s' && fmtDuration(3840) === '1h 4m', 'durations read naturally')
assert(fmtDuration(null) === '—' && fmtDuration(-1) === '—', 'no duration is a dash, never "0s"')
const NOW = Date.parse('2026-08-27T17:38:00Z')
assert(fmtCountdown('2026-08-27T17:50:00Z', NOW) === 'in 12m', 'minutes ahead')
assert(fmtCountdown('2026-08-27T19:30:00Z', NOW) === 'in 2h', 'hours ahead')
assert(fmtCountdown('2026-08-27T17:38:30Z', NOW) === 'in 30s', 'seconds ahead')
// A past next_run means the scheduler has not fired it, which is worth SEEING.
assert(fmtCountdown('2026-08-27T17:37:30Z', NOW) === 'due now', 'a moment past due reads as due now')
assert(fmtCountdown('2026-08-27T16:00:00Z', NOW) === 'overdue', 'well past due reads as OVERDUE, not as a negative countdown')
assert(fmtCountdown(null, NOW) === '—' && fmtCountdown('nope', NOW) === '—', 'no next run is a dash')

console.log('[smoke] === 1c. the card\'s refused number is RECENT; all-time lives in the tooltip (issue 278) ===')
{
  const NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0)
  const DAY = 86_400
  const sec = (daysAgo: number): number => NOW_MS / 1000 - daysAgo * DAY
  // The wire shape, from Prometheus server.py _task_dict: created_at is epoch SECONDS (a float).
  const row = (id: string, daysAgo: number | null): Record<string, unknown> => ({ id, type: 'local_bash', status: 'blocked', description: 'x', running: false, created_at: daysAgo === null ? null : sec(daysAgo) })
  const parsed = parseTasks({ tasks: [row('a', 1)], counts: { blocked: 1 } })
  assert(parsed.tasks[0].createdAt === Math.round(sec(1) * 1000), 'created_at (epoch seconds) parses to epoch ms')
  assert(REFUSED_TASKS_PATH === '/api/tasks?status=blocked&limit=200', 'the second request asks for refusals only, at the daemon\'s own cap')

  // ISSUE 278's TEST: counts {blocked: 22}, every record older than the window.
  const allOld = parseTasks({ tasks: Array.from({ length: 22 }, (_, i) => row(`o${i}`, 8 + i * 3)), counts: { blocked: 22 } })
  const oldRecent = recentRefusals(allOld, NOW_MS)
  const oldBadge = refusedBadge(oldRecent, 22)
  assert(oldRecent.recent === 0 && !oldBadge.show, 'issue 278: 22 refusals, all older than 7 days → no recent refusals on the card')
  const card = parseTasks({ tasks: [], counts: { completed: 214, failed: 26, blocked: 22 } })
  assert(backgroundSummary(card).includes('22 refused') && /22 refused/.test(backgroundSummaryTitle(card)), 'issue 278: …and the all-time 22 is still named on the summary line and in its tooltip (refusals stay visible, issue 148)')
  assert(/All-time/.test(backgroundSummaryTitle(card)), 'the summary tooltip says its numbers are all-time')

  // A recent few: the number is the window's, the tooltip carries the all-time total.
  const mixed = parseTasks({ tasks: [row('n1', 0.5), row('n2', 3), row('n3', 6.9), row('x1', 7.1), row('x2', 40), row('nt', null)], counts: { blocked: 22 } })
  const r = recentRefusals(mixed, NOW_MS)
  const b = refusedBadge(r, 22)
  assert(r.recent === 3 && !r.capped, `three inside 7 days, two outside, one with no time (not counted as recent) → 3 (got ${r.recent})`)
  assert(b.show && b.text === '3 refused this week →', `the card says "3 refused this week" (got "${b.text}")`)
  assert(/nothing ran/.test(b.title) && /approve the command or narrow it/.test(b.title) && /3 in the last 7 days, 22 in all/.test(b.title), `the tooltip says what a refusal is, and gives both counts (got "${b.title}")`)
  assert(!/awaiting/i.test(b.text + b.title + backgroundSummary(card) + backgroundSummaryTitle(card)), 'nowhere says "awaiting": nothing is waiting on a refused record')
  const edge = recentRefusals(parseTasks({ tasks: [row('e', 7)], counts: { blocked: 1 } }), NOW_MS)
  assert(edge.recent === 1, 'exactly 7 days ago is inside the window')

  // The cap: a full list, all in the window, may be hiding more.
  const full = parseTasks({ tasks: Array.from({ length: TASK_LIST_CAP }, (_, i) => row(`f${i}`, 0.01 * i)), counts: { blocked: 500 } })
  const fr = recentRefusals(full, NOW_MS)
  assert(fr.capped && refusedBadge(fr, 500).text === '200+ refused this week →', `a full list inside the window reads "200+" (got "${refusedBadge(fr, 500).text}")`)
  const fullButOld = parseTasks({ tasks: Array.from({ length: TASK_LIST_CAP }, (_, i) => row(`g${i}`, i < 50 ? 1 : 30)), counts: { blocked: 200 } })
  const fo = recentRefusals(fullButOld, NOW_MS)
  assert(fo.recent === 50 && !fo.capped && refusedBadge(fo, 200).text === '50 refused this week →', 'a full list that reaches past the window is exact, not "+" (the window ended inside it)')
  assert(recentRefusals(EMPTY_TASKS, NOW_MS).recent === 0 && !refusedBadge(recentRefusals(EMPTY_TASKS, NOW_MS), 0).show, 'no refusals at all → no link')
  const otherStatus = parseTasks({ tasks: [{ ...row('c', 1), status: 'completed' }], counts: { completed: 1 } })
  assert(recentRefusals(otherStatus, NOW_MS).recent === 0, 'only blocked rows count (a list that is not the filtered one cannot inflate it)')
}

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (three empties, tasks, cron, upcoming, health, formatting)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
