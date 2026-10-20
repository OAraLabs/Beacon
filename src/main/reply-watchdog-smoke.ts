/**
 * reply-watchdog-smoke — what a frame does to the reply watchdog.
 *
 * The case that decides the design: a /steer issued DURING a live turn produces
 * a terminator while that turn is still streaming. Routed through the `done`
 * branch it would blank the running turn's activity and stand its watchdog down
 * for good — so a turn that then died would never be reported. Worse than the
 * defect it fixes. That is why command_done is a distinct kind, and why it is
 * scoped to the exchange that armed the timer.
 *
 * Run: npm run smoke:reply-watchdog
 */
import { deliversToSession, isAssistantActivity, nextTurnInFlight, watchdogAction } from '@shared/reply-watchdog'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const SID = 'web:abc'

/** ChatShell's glue, mirrored exactly: decide against the state BEFORE the frame, then advance it. */
interface W {
  armed: boolean
  turnInFlight: boolean
}
function step(w: W, f: Parameters<typeof watchdogAction>[0] & { sessionId?: string }, sessionId = SID): W {
  if (!deliversToSession(f, sessionId)) return w
  const a = watchdogAction(f, w.turnInFlight)
  const turnInFlight = nextTurnInFlight(f, w.turnInFlight)
  if (a === 'stand-down') return { armed: false, turnInFlight }
  if (a === 'rearm') return { armed: true, turnInFlight }
  return { armed: w.armed, turnInFlight }
}
const SENT: W = { armed: true, turnInFlight: false } // a clean send arms the timer

console.log('\n=== existing behaviour is unchanged ===')
check(watchdogAction({ kind: 'delta', messageId: 'asst-1' }, false) === 'rearm', 'delta re-arms')
check(watchdogAction({ kind: 'progress' }, true) === 'rearm', 'progress pulse re-arms')
check(watchdogAction({ kind: 'tool_start' }, true) === 'rearm', 'tool_start re-arms')
check(watchdogAction({ kind: 'done', messageId: 'asst-1' }, true) === 'stand-down', 'done is terminal')
check(
  watchdogAction({ kind: 'message', role: 'user', messageId: 8280 }, false) === 'nothing',
  'the user echo does NOT stand it down — the daemon echoes on accept even when it never generates'
)
check(watchdogAction({ kind: 'message', role: 'assistant', messageId: 'a' }, false) === 'rearm', 'assistant message re-arms')
check(watchdogAction({ kind: 'error' }, true) === 'nothing', 'error is handled on its own path, not here')

console.log('\n=== command_done ends the exchange on an idle session (LIVE wire order) ===')
// Captured 2026-08-17 from daemon #256: chat_message(user, cmd-user-*) ->
// chat_message(assistant, cmd-asst-*) -> command_done(cmd-asst-*), all at t=0.0.
let w = SENT
w = step(w, { kind: 'message', role: 'user', messageId: 'cmd-user-1787012075497', sessionId: SID })
check(w.armed && !w.turnInFlight, 'the user echo leaves the send-armed timer alone and starts no turn')
w = step(w, { kind: 'message', role: 'assistant', messageId: 'cmd-asst-1787012075497', sessionId: SID })
check(w.armed && !w.turnInFlight, 'the command reply re-arms — and a chat_message NEVER marks a turn in flight')
w = step(w, { kind: 'command_done', messageId: 'cmd-asst-1787012075497', sessionId: SID })
check(!w.armed, 'command_done stands it down — no stall line can follow /help')

console.log('\n=== THE CASE THAT MADE chat_done WRONG, IN THE ORDER IT ACTUALLY ARRIVES ===')
// THE FIRST VERSION OF THIS TEST WAS FICTION. It put the progress pulse LAST and
// omitted the command reply, so a match on the armed id looked like it scoped
// correctly. The live wire is progress(3.0) -> cmd-asst(6.0) -> command_done(6.0):
// the reply always re-arms an instant before its own terminator, so id-matching
// always succeeded, mid-turn included. Only a live capture caught it.
let t: W = { armed: true, turnInFlight: false }
t = step(t, { kind: 'progress', sessionId: SID })
check(t.armed && t.turnInFlight, 'a progress pulse re-arms AND marks a turn in flight')
t = step(t, { kind: 'message', role: 'assistant', messageId: 'cmd-asst-999', sessionId: SID })
check(t.turnInFlight, 'the command reply does not clear the turn — it is only a chat_message')
t = step(t, { kind: 'command_done', messageId: 'cmd-asst-999', sessionId: SID })
check(t.armed, 'MID-TURN: the running turn KEEPS its watchdog')
check(
  watchdogAction({ kind: 'command_done', messageId: 'cmd-asst-999' }, true) === 'nothing',
  'a terminator declines to act while a turn is streaming'
)
check(
  !isAssistantActivity({ kind: 'command_done', messageId: 'cmd-asst-999' }),
  'command_done is not assistant activity — so it never reaches setActivity or clearStall'
)
t = step(t, { kind: 'delta', messageId: 'asst-turn-7', sessionId: SID })
t = step(t, { kind: 'done', messageId: 'asst-turn-7', sessionId: SID })
check(!t.armed && !t.turnInFlight, 'the turn ends on its OWN done — watchdog down, turn cleared')

console.log('\n=== a dead turn must not wedge the gate shut ===')
// If turnInFlight could never clear, every later command_done would decline and
// the original defect would be back. `error` clears it for exactly that reason.
check(!nextTurnInFlight({ kind: 'error' }, true), 'an error clears turn-in-flight')
check(!nextTurnInFlight({ kind: 'done', messageId: 'a' }, true), 'a done clears turn-in-flight')
check(nextTurnInFlight({ kind: 'message', role: 'assistant', messageId: 'cmd-asst-1' }, false) === false,
  'a command reply never sets it')

console.log('\n=== the session filter (the catch that would have shipped wrong) ===')
let x: W = { armed: true, turnInFlight: false }
x = step(x, { kind: 'command_done', messageId: 'cmd-asst-1', sessionId: 'telegram:8139235390' })
check(x.armed, "a command_done for ANOTHER session does not clear this one's watchdog")
check(!deliversToSession({ kind: 'command_done', sessionId: 'other' }, SID), 'mismatching sessionId is dropped')
check(deliversToSession({ kind: 'command_done', sessionId: SID }, SID), 'matching sessionId is delivered')
check(
  deliversToSession({ kind: 'command_done' }, SID),
  'a frame with NO sessionId is delivered — which is why the daemon must send one on every command_done'
)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
