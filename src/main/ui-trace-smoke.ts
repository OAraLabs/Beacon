/**
 * ui-trace-smoke — the breadcrumbs answer the question they were added for.
 *
 * Findings 2 and 5 are "the click and the daemon disagree". Everything below the
 * IPC boundary is already excluded: approval:resolve has never thrown, and
 * Electron auto-logs handler rejections, so a failed fetch / non-2xx / silent
 * success are all ruled out. The break is renderer-side, in three hops.
 *
 * These assert the two things the table has to get right: the verdict is correct
 * for every prefix of the path, and the bound holds.
 *
 * Run: npm run smoke:ui-trace
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { UI_TRACE_MAX_ROWS, describeUiTrace, traceVerdict, type UiTraceEvent, type UiTracePoint } from '@shared/ui-trace'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const PATH: UiTracePoint[] = ['card:click', 'mainview:resolve-enter', 'mainview:pre-invoke', 'main:handler-enter']

function row(point: UiTracePoint, i: number, scope = 'always here'): UiTraceEvent {
  return {
    point,
    at: 1_786_900_000_000 + i * 3,
    mono: 100 + i * 3.5,
    proc: point.startsWith('main:') ? 'main' : 'renderer',
    requestId: 'abc123',
    scope
  }
}

const dir = mkdtempSync(join(tmpdir(), 'beacon-uitrace-'))
const repo = new CacheRepo(openCache(join(dir, 'beacon.db')))

console.log('\n=== round-trip, oldest-first (the order the path is walked) ===')
PATH.forEach((p, i) => repo.recordUiTrace(row(p, i)))
const got = repo.getUiTrace()
check(got.length === 4, `four breadcrumbs persisted (got ${got.length})`)
check(
  got.map((r) => r.point).join(' → ') === PATH.join(' → '),
  'returned in path order, not newest-first — this is read as a walk'
)
check(got.every((r) => r.at > 0 && Number.isFinite(r.mono)), 'both clocks recorded on every row')
check(
  got.filter((r) => r.proc === 'renderer').length === 3 && got.filter((r) => r.proc === 'main').length === 1,
  'each row names the process whose monotonic clock it carries'
)
check(got[0].scope === 'always here', 'the verb is carried, which is the value whose drift is in question')
console.log('  sample: ' + describeUiTrace(got[0]))

console.log('\n=== the verdict, for every prefix of the path ===')
check(
  traceVerdict([]).includes('never fired'),
  'NO rows → the button never fired (the leading hypothesis: Finding 1)'
)
check(
  traceVerdict([row('card:click', 0)]).includes('handler prop was never invoked'),
  'card only → the prop hop broke'
)
check(
  traceVerdict([row('card:click', 0), row('mainview:resolve-enter', 1)]).includes('before invoking IPC'),
  'card + enter → returned before invoking'
)
check(
  traceVerdict(PATH.slice(0, 3).map((p, i) => row(p, i))).includes('nothing arrived in main'),
  'three rows → the invoke did not cross the boundary'
)
check(
  traceVerdict(PATH.map((p, i) => row(p, i))).includes('crossed the boundary intact'),
  'four rows → the break is downstream, not here'
)

console.log('\n=== scope drift is visible, not just presence ===')
const drifted = [row('card:click', 0, 'always here'), row('main:handler-enter', 1, 'once')]
check(
  drifted[0].scope !== drifted[1].scope,
  'a verb that changes between the card and the handler shows as two different values — Finding 2 in one comparison'
)

console.log('\n=== bounded ===')
for (let i = 0; i < UI_TRACE_MAX_ROWS + 60; i++) repo.recordUiTrace(row('card:click', i))
const n = repo.countUiTrace()
check(n === UI_TRACE_MAX_ROWS, `capped at ${UI_TRACE_MAX_ROWS} (got ${n})`)
check(
  repo.getUiTrace().length === UI_TRACE_MAX_ROWS,
  'reads back the full window and no more — instrumentation cannot become the thing it diagnoses'
)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
