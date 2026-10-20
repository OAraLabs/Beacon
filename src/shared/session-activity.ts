/**
 * Which sessions have a turn running RIGHT NOW — the sidebar's per-row working indicator.
 *
 * Pure (no DOM / Electron) so session-activity-smoke can drive it with the recorded wire frames.
 *
 * WHY THIS IS NOT THE GATEWAY STORE'S `agentState`. That field is one global string: the latest
 * agent_state frame from ANY session wins, so two sessions working at once read as whichever spoke
 * last. Every frame this module reads carries `session_id` (captured in main/live-frames.json), so
 * the state is keyed by it and a frame without one is ignored rather than guessed at.
 *
 * WHAT A TURN LOOKS LIKE ON THE WIRE (live capture, daemon e3019a5+):
 *   agent_state{thinking} → agent_progress every ~3s → chat_done → agent_state{idle}
 * chat_delta never reaches here (ws.ts drops it from the gateway stream), and it does not need to:
 * the progress pulse keeps beating for the whole turn, tool calls included.
 *
 * WHAT IS NOT A TURN. command_done ends a slash command, and a /steer issued mid-turn produces one
 * while the turn is still streaming (see reply-watchdog.ts). Treating it as an end would blank the
 * indicator on a live turn, so it is not read at all.
 *
 * MOVEMENT MEANS LIVENESS (the ActivityLine rule). `tick` advances once per real frame and the
 * spinner turns by it, never by a CSS timer. A turn whose pulse stops is reported as `stalled` after
 * STALL_AFTER_MS — the same threshold the chat view's ActivityLine uses — and dropped after
 * FORGET_AFTER_MS, so a chat_done lost to a dead socket cannot leave a row spinning forever.
 *
 * WHAT THIS CANNOT SEE. A turn already running when Beacon connected shows nothing until its next
 * pulse (≤ ~3s). And approvals are GLOBAL on the daemon (no session id on PendingAction), so there is
 * no per-session "waiting for you" state to show; the approval overlay remains the one surface.
 */
import type { GatewayEvent } from './gateway-events'

export interface SessionTurn {
  /** Client clock (ms) of the first frame of this turn. */
  since: number
  /** Client clock (ms) of the latest frame — the stall clock runs from here. */
  at: number
  /** Increments per frame; the row's spinner turns by it. */
  tick: number
}

export type SessionActivity = Readonly<Record<string, SessionTurn>>

export const STALL_AFTER_MS = 20_000
export const FORGET_AFTER_MS = 120_000

/** Frames that mean "this session's turn is alive". */
const BEATS = new Set(['agent_progress', 'tool_call_start', 'tool_call_end'])
/** Frames that end this session's turn. */
const ENDS = new Set(['chat_done', 'error'])

/** Fold one gateway frame in. Returns the SAME object for frames that change nothing, so a
 * consumer's state setter skips the re-render. */
export function reduceSessionActivity(prev: SessionActivity, ev: GatewayEvent): SessionActivity {
  const sid = ev.payload.session_id
  if (typeof sid !== 'string' || sid === '') return prev

  const state = ev.type === 'agent_state' ? ev.payload.state : undefined
  const ends = ENDS.has(ev.type) || state === 'idle'
  const beats = BEATS.has(ev.type) || state === 'thinking'

  if (ends) {
    if (!(sid in prev)) return prev
    const next = { ...prev }
    delete next[sid]
    return next
  }
  if (!beats) return prev
  const cur = prev[sid]
  return { ...prev, [sid]: cur ? { since: cur.since, at: ev.ts, tick: cur.tick + 1 } : { since: ev.ts, at: ev.ts, tick: 0 } }
}

/** Drop turns whose pulse stopped long ago. Same object when nothing expired. */
export function pruneSessionActivity(prev: SessionActivity, now: number): SessionActivity {
  let next: Record<string, SessionTurn> | null = null
  for (const [sid, t] of Object.entries(prev)) {
    if (now - t.at > FORGET_AFTER_MS) {
      next ??= { ...prev }
      delete next[sid]
    }
  }
  return next ?? prev
}

export type RowIndicator =
  | { kind: 'working'; tick: number; label: string }
  | { kind: 'stalled'; label: string }
  | null

/** What the sidebar row shows for this session. null = no turn running (idle, or done — the
 * existing unread dot says whether a finished turn has been read). */
export function rowIndicator(turn: SessionTurn | undefined, now: number): RowIndicator {
  if (!turn) return null
  const quiet = now - turn.at
  if (quiet > FORGET_AFTER_MS) return null
  if (quiet > STALL_AFTER_MS) return { kind: 'stalled', label: `Working — no pulse for ${Math.round(quiet / 1000)}s` }
  const secs = Math.max(0, Math.round((now - turn.since) / 1000))
  return { kind: 'working', tick: turn.tick, label: `Working · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`}` }
}
