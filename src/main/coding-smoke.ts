// Headless smoke for the Phase-C coding-surface pure helpers
// (ELECTRON_RUN_AS_NODE electron out/main/coding-smoke.js). Proves report parsing out of a managed
// task's output tail, the honest verdict labels, the review-only git-command builder, and the
// state-machine phase mapping — no daemon, no React.

import {
  CODING_DEFAULTS,
  CODING_TOOL_CAP,
  codingGitCommands,
  codingStateLabel,
  diffLineTone,
  elapsedSeconds,
  parseCodingReport,
  reduceCodingRuns,
  reportFromStatus,
  runPhase,
  type CodingRunReport,
  type CodingRunStatus,
  type CodingRuns
} from '@shared/coding'
// Imported, not read from disk: the bundler inlines it, so the smoke cannot be run against a
// fixture that failed to ship or against a stale copy in another tree.
import capture from './fixtures/coding-wire-c941664a6.json'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

const REPORT: CodingRunReport = {
  task_id: 't11',
  status: 'success',
  reason: 'acceptance command exited 0',
  rounds_used: 8,
  episodes: 2,
  wall_seconds: 91.3,
  acceptance_exit: 0,
  acceptance_output_tail: '1 passed in 0.4s',
  branch: 'coding/t11',
  diff_stat: ' src/marshmallow/utils.py | 2 +-',
  sandbox_root: '/home/demo/.prometheus/coding/t11-123'
}

console.log('parseCodingReport (extract report from managed-task output tail):')
check('clean report parses', parseCodingReport(JSON.stringify(REPORT))?.status === 'success')
check('report after leading log noise parses', parseCodingReport(`starting…\nworking\n${JSON.stringify(REPORT)}`)?.branch === 'coding/t11')
check('empty tail → null (still running)', parseCodingReport('') === null)
check('non-report stdout → null', parseCodingReport('just some logs, no json') === null)
check('pretty-printed report parses', parseCodingReport(JSON.stringify(REPORT, null, 2))?.episodes === 2)

// ── reportFromStatus (Beacon#130): prefer the daemon-parsed field, fall back to the tail ──
// The daemon now parses the FULL output and returns `report` (Prometheus#495), because the tail is
// the file's last 4000 bytes and the report is its LAST JSON object — a report larger than the cap
// began mid-object and parsing the tail returned null for a run that HAD finished. The fallback
// stays because Beacon must work against any daemon vintage.
console.log('\nreportFromStatus (prefer the daemon field, fall back to the tail):')
{
  const st = (over: Partial<CodingRunStatus>): CodingRunStatus => ({ task_id: 't', status: 'completed', ...over })
  // A daemon NEWER than #495: the field wins, and the tail is not consulted at all.
  const fieldOnly = reportFromStatus(st({ report: REPORT, output_tail: undefined }))
  check('the daemon-parsed report field is used when present', fieldOnly?.branch === 'coding/t11')
  // The bug case: field present AND a tail that would NOT have parsed. The field wins, so a report
  // larger than the 4000-byte tail is no longer lost. This is the assertion that fails if the
  // precedence is inverted back to tail-first.
  const big = { ...REPORT, diff_stat: 'x'.repeat(6000) }
  check('a report larger than the tail still arrives via the field',
    reportFromStatus(st({ report: big, output_tail: 'garbage with no json' }))?.diff_stat === big.diff_stat)
  // An EXPLICIT null field means "no report" and is honoured — the daemon read the whole file and
  // found nothing, so the tail must not be allowed to know better.
  check('an explicit report:null is honoured as no-report (not re-parsed from the tail)',
    reportFromStatus(st({ report: null, output_tail: JSON.stringify(REPORT) })) === null)
  // A daemon OLDER than #495: field absent (not null) → fall back to parsing the tail.
  check('an older daemon (field ABSENT) falls back to the tail',
    reportFromStatus(st({ output_tail: JSON.stringify(REPORT) }))?.episodes === 2)
  check('older daemon with no report yet → null (still running)',
    reportFromStatus(st({ output_tail: 'round 1: thinking' })) === null)
  // null/undefined status must not throw — the panel polls before the first response lands.
  check('a null status is null, not a throw', reportFromStatus(null) === null && reportFromStatus(undefined) === null)
}

console.log('codingStateLabel (honest verdicts):')
check('success → Converted (ok)', codingStateLabel(REPORT).text === 'Converted ✓' && codingStateLabel(REPORT).tone === 'ok')
check('failed_abandoned → Abandoned at cap (warn)', codingStateLabel({ status: 'failed_abandoned' }).text === 'Abandoned at cap')
check('failed_error → Failed (err)', codingStateLabel({ status: 'failed_error' }).tone === 'err')
check('no report + managed failed → Failed — no report', codingStateLabel(null, 'failed').text === 'Failed — no report')
// A SecurityGate refusal is not a failure: nothing ran, so there is nothing to debug and the
// repair is to approve or narrow the command (Prometheus issue 489). Both halves are checked —
// the wording AND the tone, because rendering a refusal in the error colour is the same mistake
// one layer down.
check('no report + managed blocked → Refused — nothing ran', codingStateLabel(null, 'blocked').text === 'Refused — nothing ran')
check('a refusal is not an error tone', codingStateLabel(null, 'blocked').tone === 'warn')
check('...and is still told apart from a plain missing report', codingStateLabel(null, undefined).text === 'No report')

console.log('codingGitCommands (review-only — never merge/push):')
{
  const cmds = codingGitCommands(REPORT)
  check('builds fetch/checkout/diff', cmds.length === 4 && cmds.some((c) => c.includes('git diff main..coding/t11')))
  check('cd into the sandbox root', cmds[0] === 'cd /home/demo/.prometheus/coding/t11-123')
  check('NO merge command', !cmds.some((c) => /\bgit\s+merge\b/.test(c)))
  check('NO push command', !cmds.some((c) => /\bgit\s+push\b/.test(c)))
  check('missing branch/root → no commands', codingGitCommands({ status: 'failed_error' }).length === 0)
}

console.log('runPhase (panel state machine):')
check('running status, no report → running', runPhase('running', false) === 'running')
check('completed status → review', runPhase('completed', false) === 'review')
check('killed status → review (Stop is terminal)', runPhase('killed', false) === 'review')
check('failed status → review', runPhase('failed', false) === 'review')
// `blocked` is terminal daemon-side, so a set without it leaves the panel waiting for an end
// state that already arrived — a spinner with nothing behind it.
check('blocked status → review (a refusal is terminal)', runPhase('blocked', false) === 'review')
check('report present overrides → review', runPhase('running', true) === 'review')

console.log('diffLineTone (artifact diff coloring):')
check('+ line → add', diffLineTone('+    return a + b') === 'add')
check('- line → del', diffLineTone('-    return a - b') === 'del')
check('@@ hunk → hunk', diffLineTone('@@ -1,3 +1,3 @@') === 'hunk')
check('+++ header → meta (not add)', diffLineTone('+++ b/calc.py') === 'meta')
check('--- header → meta (not del)', diffLineTone('--- a/calc.py') === 'meta')
check('diff --git → meta', diffLineTone('diff --git a/calc.py b/calc.py') === 'meta')
check('context line → context', diffLineTone(' unchanged') === 'context')

console.log('elapsedSeconds:')
check('started→ended', elapsedSeconds(1000, 1091) === 91)
check('started→now (ms)', elapsedSeconds(1000, null, 1_091_000) === 91)
check('no start → 0', elapsedSeconds(undefined) === 0)

console.log('CODING_DEFAULTS:')
check('defaults are 30 / 1200', CODING_DEFAULTS.maxRounds === 30 && CODING_DEFAULTS.maxWallSeconds === 1200)

console.log('reduceCodingRuns (live WS event fold — coding_round/complete/stream_error):')
{
  const sid = 'coding:t11'
  const round = (i: number, extra: Record<string, unknown> = {}) => ({
    type: 'coding_round',
    payload: { session_id: sid, round_index: i, outcome: 'success', input_tokens: 100 + i, output_tokens: 10 + i, thinking: true, duration_ms: 1200, stop_reason: 'tool_calls', ...extra }
  })
  let runs: CodingRuns = {}
  runs = reduceCodingRuns(runs, round(0))
  runs = reduceCodingRuns(runs, round(1))
  runs = reduceCodingRuns(runs, round(2))
  check('accumulates one round per event', runs[sid]?.rounds.length === 3)
  check('rounds in round_index order', runs[sid]?.rounds.map((r) => r.roundIndex).join(',') === '0,1,2')
  check('payload mapped (tokens/thinking/stop)', runs[sid]?.rounds[1]?.inputTokens === 101 && runs[sid]?.rounds[1]?.thinking === true && runs[sid]?.rounds[1]?.stopReason === 'tool_calls')

  const before = runs
  runs = reduceCodingRuns(runs, round(1)) // duplicate round_index
  check('duplicate round_index is a no-op (same ref, no dupe)', runs === before && runs[sid]?.rounds.length === 3)

  runs = reduceCodingRuns(runs, round(5))
  runs = reduceCodingRuns(runs, round(3)) // out of order
  check('out-of-order rounds are sorted', runs[sid]?.rounds.map((r) => r.roundIndex).join(',') === '0,1,2,3,5')

  check('non-coding event → same ref (no churn)', reduceCodingRuns(runs, { type: 'agent_state', payload: { state: 'idle' } }) === runs)
  check('coding event without session_id → same ref', reduceCodingRuns(runs, { type: 'coding_round', payload: { round_index: 9 } }) === runs)
  check('coding_round without round_index → same ref', reduceCodingRuns(runs, { type: 'coding_round', payload: { session_id: sid } }) === runs)

  runs = reduceCodingRuns(runs, { type: 'coding_complete', payload: { session_id: sid, outcome: 'success', exit_code: 0, task_status: 'completed' } })
  check('coding_complete sets the verdict', runs[sid]?.complete?.outcome === 'success' && runs[sid]?.complete?.exitCode === 0)
  runs = reduceCodingRuns(runs, { type: 'coding_stream_error', payload: { session_id: sid, error: 'boom' } })
  check('coding_stream_error sets streamError (rounds preserved)', runs[sid]?.streamError === 'boom' && runs[sid]?.rounds.length === 5)

  const r2 = reduceCodingRuns({}, { type: 'coding_round', payload: { session_id: 'coding:x', round_index: 0, outcome: 'success', thinking: null } })
  check('thinking null preserved (provider without the knob)', r2['coding:x']?.rounds[0]?.thinking === null)
}

// ── P9.9 (Prometheus#127): the multi-episode freeze ─────────────────────────────────────
// round_index RESTARTS at 0 every episode (run_loop is invoked once per episode), so de-duping on
// it alone made episode 2's round 0 collide with episode 1's round 0 and get dropped as a
// duplicate — the Live view froze while the daemon kept working. The daemon also sends `seq` (the
// subsystem_runs rowid), monotonic across the whole run; that is the honest de-dupe key.
console.log('\nreduceCodingRuns (multi-episode, seq de-dupe — P9.9):')
{
  const sid = 'coding:multi'
  // seq is run-monotonic; round_index restarts per episode. Episode 1: rowids 10,11 (rounds 0,1).
  // Episode 2: rowids 12,13 but round_index back to 0,1.
  const round = (roundIndex: number, seq: number, outcome = 'success') => ({
    type: 'coding_round',
    payload: { session_id: sid, round_index: roundIndex, seq, outcome, thinking: true, stop_reason: 'tool_calls' }
  })
  let runs: CodingRuns = {}
  runs = reduceCodingRuns(runs, round(0, 10))
  runs = reduceCodingRuns(runs, round(1, 11))
  // Episode 2 — the round_index values REPEAT. Before the fix these were dropped as duplicates.
  runs = reduceCodingRuns(runs, round(0, 12))
  runs = reduceCodingRuns(runs, round(1, 13))
  check('a second episode round_index:0 is NOT dropped as a dup of episode 1', runs[sid]?.rounds.length === 4)
  check('rounds carry their own seq', runs[sid]?.rounds.map((r) => r.seq).join(',') === '10,11,12,13')
  check('sorted by seq (run order), not the restarting round_index',
    runs[sid]?.rounds.map((r) => `${r.seq}:${r.roundIndex}`).join(',') === '10:0,11:1,12:0,13:1')

  // A WS reconnect replays a frame with the SAME seq — still correctly de-duped.
  const before = runs
  runs = reduceCodingRuns(runs, round(0, 12)) // replay of episode 2 round 0
  check('a reconnect replay (same seq) is still a no-op', runs === before && runs[sid]?.rounds.length === 4)

  // Display still shows the per-episode round index the daemon reported.
  check('roundIndex (display) survives alongside seq', runs[sid]?.rounds[2]?.roundIndex === 0 && runs[sid]?.rounds[2]?.seq === 12)
}
{
  // Older daemon that sends NO seq: the reducer falls back to round_index. Within one episode that
  // still de-dupes a reconnect replay correctly...
  const sid = 'coding:legacy'
  const round = (i: number) => ({ type: 'coding_round', payload: { session_id: sid, round_index: i, outcome: 'success', thinking: true } })
  let runs: CodingRuns = {}
  runs = reduceCodingRuns(runs, round(0))
  runs = reduceCodingRuns(runs, round(1))
  const before = runs
  runs = reduceCodingRuns(runs, round(1))
  check('no-seq daemon: a replay de-dupes on round_index (same ref)', runs === before && runs[sid]?.rounds.length === 2)
  check('no-seq daemon: seq is null', runs[sid]?.rounds[0]?.seq === null)
}
{
  // KNOWN GAP, PINNED ON PURPOSE (P9.9). The seq fix needs the daemon to SEND seq. Against a daemon
  // that does not, the original multi-episode collision is STILL FULLY PRESENT and cannot be fixed
  // client-side: round_index is episode-scoped, so episode 2's round 0 is indistinguishable from
  // episode 1's round 0 and is dropped as a duplicate. This is correct behaviour — you cannot
  // de-dupe on a key you were never sent — but it must NOT read as "old daemons are fine." A green
  // test that only exercised the within-episode fallback would let a reader conclude exactly that.
  // So the limitation is asserted as EXPECTED, and named so it reads as a pinned gap, not a pass.
  const sid = 'coding:legacy-multiepisode'
  // Two episodes, each with round_index 0 and 1, and NO seq on any frame.
  const ep1r0 = { type: 'coding_round', payload: { session_id: sid, round_index: 0, outcome: 'success', thinking: true } }
  const ep1r1 = { type: 'coding_round', payload: { session_id: sid, round_index: 1, outcome: 'success', thinking: true } }
  const ep2r0 = { type: 'coding_round', payload: { session_id: sid, round_index: 0, outcome: 'success', thinking: true } }
  const ep2r1 = { type: 'coding_round', payload: { session_id: sid, round_index: 1, outcome: 'success', thinking: true } }
  let runs: CodingRuns = {}
  runs = reduceCodingRuns(runs, ep1r0)
  runs = reduceCodingRuns(runs, ep1r1)
  runs = reduceCodingRuns(runs, ep2r0)
  runs = reduceCodingRuns(runs, ep2r1)
  // The 4 real rounds collapse to 2: episode 2 is dropped as a duplicate of episode 1. THIS IS THE
  // BUG, still live against a no-seq daemon, asserted as the expected current behaviour so the gap
  // is recorded rather than merely true. The fix for this case is daemon-side (send seq), not here.
  check('KNOWN GAP (no-seq daemon): episode 2 still collides and is dropped — 4 rounds render as 2',
    runs[sid]?.rounds.length === 2)
  check('KNOWN GAP (no-seq daemon): the dropped rounds are episode 2, not a crash',
    runs[sid]?.rounds.map((r) => r.roundIndex).join(',') === '0,1')
}

// ── Replay of a REAL captured wire ────────────────────────────────────────────────────────────
// fixtures/coding-wire-c941664a6.json was CAPTURED, not written: 21 frames taken at
// window.beacon.events.onGateway (upstream of every renderer filter) during run coding:c941664a6
// on 2026-09-18, fired from the Loop Manager board against a real repo. Re-capture it; never
// hand-edit it.
//
// It exists because the previous fixtures for this reducer were hand-written, and a hand-written
// frame cannot disagree with your belief about the wire. The belief was wrong twice: first that
// Beacon's reducer was dropping coding_tool/coding_acceptance, then that they were never emitted.
// Both were reasonable readings of producer and consumer. The truth — that they arrived wrapped as
// sentinel_signal because ws_server had no promotion entry — was only visible in a real frame.
console.log('\n[replay] captured wire — run coding:c941664a6')
{
  const frames = (capture as { frames: { ev: { type: string; payload: Record<string, unknown> } }[] })
    .frames.map((f) => f.ev)

  // The capture is itself the contract: after Prometheus#503 nothing coding-related may arrive
  // wrapped. If a re-capture ever brings sentinel_signal back, the promotion has regressed.
  check('captured wire carries NO sentinel_signal frame (the promotion holds)',
    !frames.some((e) => e.type === 'sentinel_signal'))
  check('captured wire carries coding_tool and coding_acceptance AS THEMSELVES',
    frames.some((e) => e.type === 'coding_tool') && frames.some((e) => e.type === 'coding_acceptance'))

  let runs: CodingRuns = {}
  for (const ev of frames) runs = reduceCodingRuns(runs, ev)
  const sid = 'coding:c941664a6'
  const run = runs[sid]

  check('replay folds into exactly one run', Object.keys(runs).length === 1 && !!run)
  check('10 rounds folded', run?.rounds.length === 10)
  check('8 tool frames folded', run?.tools.length === 8)
  check('1 acceptance verdict folded', run?.acceptance.length === 1)
  check('acceptance is ground truth: exit 0', run?.acceptance[0]?.exitCode === 0)
  check('terminal verdict present', run?.complete?.outcome === 'success')
  check('no stream error', run?.streamError === null)
  check('under the cap, so nothing is hidden', run?.toolsTruncated === false)
  check('every tool frame names its tool', run?.tools.every((t) => t.toolName.length > 0) === true)
  check('the daemon attributed each tool to a round',
    run?.tools.every((t) => t.roundIndex !== null) === true)
  check('rounds sort by the run-monotonic seq, not the per-episode round_index',
    run?.rounds.every((r, i, a) => i === 0 || (r.seq ?? 0) > (a[i - 1].seq ?? 0)) === true)

  // A WS reconnect replays frames; folding the whole capture twice must change nothing.
  let twice: CodingRuns = {}
  for (const ev of frames) twice = reduceCodingRuns(twice, ev)
  for (const ev of frames) twice = reduceCodingRuns(twice, ev)
  check('replaying the capture twice de-dupes to the same state',
    twice[sid]?.rounds.length === 10 && twice[sid]?.tools.length === 8 && twice[sid]?.acceptance.length === 1)
}

// ── The tool cap is visible, not silent ───────────────────────────────────────────────────────
console.log('\n[tool cap] newest-wins, and it SAYS so')
{
  let runs: CodingRuns = {}
  const sid = 'coding:capped'
  for (let i = 0; i < CODING_TOOL_CAP + 5; i++) {
    runs = reduceCodingRuns(runs, {
      type: 'coding_tool',
      payload: { session_id: sid, seq: i, round_index: 0, tool_name: `t${i}`, success: true }
    })
  }
  const run = runs[sid]
  check(`caps at ${CODING_TOOL_CAP}`, run?.tools.length === CODING_TOOL_CAP)
  check('toolsTruncated latches true — an invisible cap is a list that lies', run?.toolsTruncated === true)
  check('newest-wins: the LAST tool survives', run?.tools[run.tools.length - 1]?.toolName === `t${CODING_TOOL_CAP + 4}`)
  check('oldest was dropped', !run?.tools.some((t) => t.toolName === 't0'))
}

console.log(failures === 0 ? '\n[coding-smoke] PASS' : `\n[coding-smoke] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
