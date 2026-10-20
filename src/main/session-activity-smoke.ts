/**
 * session-activity-smoke — the sidebar's per-session working indicator, driven by frames captured
 * OFF THE WIRE (live-frames.json), not by a sequence written to suit the reducer.
 *
 * The recorded 'steer' scenario is the one that matters: a /steer mid-turn produces command_done
 * while the turn is still streaming. A reducer that ended the turn on it would pass every
 * hand-built test and blank the spinner on a live session.
 *
 * Run: npm run smoke:session-activity
 */
import { readFileSync } from 'node:fs'
import type { GatewayEvent } from '@shared/gateway-events'
import {
  FORGET_AFTER_MS,
  STALL_AFTER_MS,
  pruneSessionActivity,
  reduceSessionActivity,
  rowIndicator,
  type SessionActivity
} from '@shared/session-activity'

let failures = 0
let checks = 0
function check(cond: boolean, label: string): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

// The verdict lives on 'exit', so an early return or throw cannot skip the count guard.
const MIN_CHECKS = 19
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`session-activity: only ${checks} of ${MIN_CHECKS} checks ran`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`session-activity: ${failures} failure(s)`)
    process.exitCode = 1
  } else console.log(`session-activity: ${checks} checks passed`)
})

interface Recorded {
  t: number
  type: string
  payload: Record<string, unknown>
}
const path = process.argv[2]
if (!path) throw new Error('usage: session-activity-smoke <live-frames.json>')
const cap = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { session_id: string; frames: Recorded[] }>

const T0 = 1_000_000
const ev = (type: string, payload: Record<string, unknown>, ts: number): GatewayEvent => ({ type, payload, ts })
// Replay a recorded scenario on the client clock. chat_delta is dropped because ws.ts never puts it
// on the gateway stream — replaying it here would test a path the app does not have.
function replay(frames: Recorded[], upTo = Infinity, start: SessionActivity = {}): SessionActivity {
  let s = start
  for (const f of frames) {
    if (f.t > upTo) break
    if (f.type === 'chat_delta') continue
    s = reduceSessionActivity(s, ev(f.type, f.payload, T0 + f.t * 1000))
  }
  return s
}

// ── 1. the recorded /steer turn ────────────────────────────────────────────────
const steer = cap.steer
check(!!steer && steer.frames.length > 0, 'the steer scenario is present in the capture')
const sid = steer.session_id
const cmdDone = steer.frames.find((f) => f.type === 'command_done')
const chatDone = steer.frames.find((f) => f.type === 'chat_done')
check(!!cmdDone && !!chatDone && cmdDone.t < chatDone.t, 'capture has command_done BEFORE chat_done (the mid-turn /steer)')

const afterCmd = replay(steer.frames, cmdDone!.t)
check(!!afterCmd[sid], 'working after the /steer command_done — a command terminator does not end the turn')
const midTurn = replay(steer.frames, chatDone!.t - 0.001)
check(!!midTurn[sid] && midTurn[sid].tick > afterCmd[sid].tick, 'each later progress pulse advances the tick')
const ind = rowIndicator(midTurn[sid], midTurn[sid].at + 1000)
check(ind?.kind === 'working', 'row shows working one second after a pulse')
check(!replay(steer.frames)[sid], 'idle once chat_done + agent_state{idle} land')

// ── 2. the recorded /help command: never a turn ───────────────────────────────────
const help = cap.help
check(!!help && !replay(help.frames)[help.session_id], '/help (chat_message + command_done only) never shows as working')

// ── 3. two sessions at once — the reason this is keyed and agentState is not ───────
let two: SessionActivity = {}
two = reduceSessionActivity(two, ev('agent_state', { state: 'thinking', session_id: 'a' }, T0))
two = reduceSessionActivity(two, ev('agent_state', { state: 'thinking', session_id: 'b' }, T0 + 10))
two = reduceSessionActivity(two, ev('chat_done', { session_id: 'b' }, T0 + 20))
check(!!two.a && !two.b, "b finishing does not stop a's spinner")
two = reduceSessionActivity(two, ev('error', { session_id: 'a', message: 'boom' }, T0 + 30))
check(!two.a, 'an error frame for the session ends its turn')
const idleOnly = reduceSessionActivity(
  reduceSessionActivity({}, ev('agent_state', { state: 'thinking', session_id: 'c' }, T0)),
  ev('agent_state', { state: 'idle', session_id: 'c' }, T0 + 5)
)
check(!idleOnly.c, 'agent_state{idle} alone ends the turn (in the capture chat_done always precedes it)')

// ── 4. frames without a session id are ignored, not guessed at ─────────────────
const base = reduceSessionActivity({}, ev('agent_state', { state: 'thinking', session_id: 'a' }, T0))
check(reduceSessionActivity(base, ev('agent_state', { state: 'idle' }, T0 + 1)) === base, 'unscoped agent_state{idle} changes nothing (same object)')
check(reduceSessionActivity(base, ev('tool_call_start', { call_id: 'x' }, T0 + 1)) === base, 'unscoped tool frame changes nothing')
check(!reduceSessionActivity({}, ev('agent_state', { state: 'thinking', session_id: '' }, T0))[''], 'an empty session_id is no session: nothing keyed under it')
check(reduceSessionActivity(base, ev('dream_started', { session_id: 'a' }, T0 + 1)) === base, 'an unrelated frame kind changes nothing (same object)')

// ── 5. a lost chat_done cannot leave a row spinning forever ────────────────────
const t = base.a
check(rowIndicator(t, t.at + STALL_AFTER_MS - 1)?.kind === 'working', 'still working just under the stall threshold')
check(rowIndicator(t, t.at + STALL_AFTER_MS + 1)?.kind === 'stalled', 'stalled past the threshold, not silently spinning')
check(rowIndicator(t, t.at + FORGET_AFTER_MS + 1) === null, 'dropped past the forget threshold')
check(pruneSessionActivity(base, t.at + 1000) === base, 'prune keeps a fresh turn (same object)')
check(!pruneSessionActivity(base, t.at + FORGET_AFTER_MS + 1).a, 'prune removes a long-silent turn')
