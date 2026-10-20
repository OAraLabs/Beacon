/**
 * watchdog-log-smoke — the durable record of what the reply watchdog decided.
 *
 * THE PROPERTY THAT MAKES ALWAYS-ON AFFORDABLE is coalescing: a live turn pulses
 * every 3s and each pulse re-arms, so a five-minute turn re-arms ~100 times. One
 * `armed` row is written per COLD arm and the rest are counted. A regression
 * there does not lose information — it turns a diagnostic table into a disk-fill,
 * which is the failure mode the bound exists to prevent in the first place.
 *
 * Run: npm run smoke:watchdog-log
 */
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import {
  WATCHDOG_LOG_MAX_ROWS,
  describeWatchdogEvent,
  emptyWatchdogLog,
  onArm,
  onFire,
  onStandDown,
  type WatchdogEvent
} from '@shared/watchdog-log'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const SID = 'beacon:abc'

console.log('\n=== COALESCING: a pulse train writes ONE row, not a hundred ===')
// 100 re-arms is a ~5 minute turn at the daemon's 3s cadence.
let st = emptyWatchdogLog()
const written: WatchdogEvent[] = []
let t = 1_000_000
let s = onArm(st, t, SID)
st = s.state
if (s.event) written.push(s.event)
for (let i = 0; i < 100; i++) {
  t += 3_000
  const r = onArm(st, t, SID)
  st = r.state
  if (r.event) written.push(r.event)
}
check(written.length === 1, `100 re-arms after a cold arm wrote ${written.length} row (expected 1)`)
check(written[0].kind === 'armed', 'and it is the armed row')
check(st.rearms === 100, `the re-arms are COUNTED, not lost (rearms=${st.rearms})`)

t += 3_000
const closed = onStandDown(st, t, SID, 'done')
check(closed.event?.rearms === 100, 'the count rides on the row that closes the window')
check(closed.event?.armedForMs === 303_000, `and the window duration is carried (${closed.event?.armedForMs}ms)`)
check(closed.state.armedAt === null && closed.state.rearms === 0, 'closing resets the window')

console.log('\n=== the three kinds ===')
check(onArm(emptyWatchdogLog(), 1, SID).event?.kind === 'armed', 'a cold arm writes armed')
check(onStandDown(emptyWatchdogLog(), 1, SID, 'done').event === null, 'standing down with nothing open writes nothing')
const cd = onStandDown({ armedAt: 5, rearms: 2 }, 10, SID, 'command_done')
check(cd.event?.kind === 'stood-down' && cd.event.reason === 'command_done', 'command_done is a distinct stand-down reason')
// UNMOUNT IS THE FINDING THIS RECORD EXPOSES: the watchdog is per-ChatShell, so
// switching away from a stalled session cancels it and no stall is ever reported.
const un = onStandDown({ armedAt: 5, rearms: 0 }, 40, SID, 'unmount')
check(un.event?.reason === 'unmount', 'unmount is recorded — the silent cancellation becomes visible')

console.log('\n=== fired carries the RAW INPUTS, not just the verdict ===')
const fired = onFire({ armedAt: 100, rearms: 3 }, 30_100, SID, {
  cause: 'gateway-silent',
  socketDroppedAt: null,
  daemonLastSeenAt: 90,
  turnInFlight: false
})
const fe = fired.event
check(fe.kind === 'fired' && fe.cause === 'gateway-silent', 'the branch taken is recorded')
check(fe.daemonLastSeenAt === 90, 'daemonLastSeen is recorded — the value that was previously unrecordable')
check(fe.socketDroppedAt === null, 'a null socket-drop is recorded AS null, not omitted')
check(fe.turnInFlight === false, 'turn-in-flight is recorded')
check(fe.armedForMs === 30_000 && fe.rearms === 3, 'window duration and re-arm count ride along')
check(
  /daemonLastSeenAt=90/.test(describeWatchdogEvent(fe)) && /cause=gateway-silent/.test(describeWatchdogEvent(fe)),
  'a human reading the row back sees the inputs beside the verdict'
)
// The point of raw inputs: recompute rather than trust.
check(fe.at - (fe.daemonLastSeenAt as number) > 30_000, 'a reader can recompute the age that drove the branch')

console.log('\n=== durable + bounded (the socket_events contract) ===')
const dir = mkdtempSync(join(tmpdir(), 'wd-smoke-'))
const repo = new CacheRepo(openCache(join(dir, 'beacon.db')))
repo.recordWatchdogEvent(fe)
const back = repo.getWatchdogEvents()
check(back.length === 1, 'a decision survives a round-trip to SQLite')
check(back[0].cause === 'gateway-silent' && back[0].daemonLastSeenAt === 90, 'inputs survive the round-trip')
check(back[0].turnInFlight === false, 'the boolean survives as a boolean, not a 0')
check(repo.getWatchdogEventsBetween(30_000, 31_000).length === 1, 'window query works — the shape the investigation needed')
check(repo.getWatchdogEventsBetween(0, 100).length === 0, 'and excludes rows outside it')

for (let i = 0; i < WATCHDOG_LOG_MAX_ROWS + 80; i++) {
  repo.recordWatchdogEvent({ at: 40_000 + i, kind: 'armed', sessionId: SID })
}
check(
  repo.countWatchdogEvents() === WATCHDOG_LOG_MAX_ROWS,
  `capped at ${WATCHDOG_LOG_MAX_ROWS} (got ${repo.countWatchdogEvents()}) — diagnostic, not history`
)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
