/**
 * What an incoming frame does to the reply watchdog.
 *
 * Pure and shared for the same reason stall-message.ts is: the watchdog lives in
 * ChatShell, the renderer has no component-test framework, and a rule this
 * consequential must be pinned by something. ChatShell consumes these functions
 * rather than re-implementing them, so the smoke tests the code that ships.
 *
 * THE RULE THE WATCHDOG ENCODES. Assistant activity re-arms rather than merely
 * clearing: silence is measured from the last sign of life, not from the send,
 * so a slow-but-healthy turn never trips it while a turn that dies mid-flight
 * still does. Only a terminal frame stands it down.
 *
 * WHY command_done IS A DISTINCT KIND, AND NOT chat_done. A slash command's
 * reply is not a turn. It carries a synthetic transient `cmd-asst-<ms>` id, and
 * — the case that decides it — a /steer issued DURING a live turn produces a
 * terminator while that turn is still streaming. Routed through the `done`
 * branch that terminator would blank the activity readout for a turn still
 * running and stand its watchdog down for good, so a turn that then died would
 * never be reported. That is worse than the defect it fixes.
 *
 * HOW THE SCOPING IS DONE, AND HOW THE FIRST ATTEMPT WAS WRONG. The first
 * version stood the watchdog down when the terminator's `message_id` matched the
 * id the pending timer was armed for. A live capture (2026-08-17, daemon #256)
 * disproved it: the wire order is progress(t=3.0) -> cmd-asst message(t=6.0) ->
 * command_done(t=6.0), so the command reply ALWAYS re-arms with the cmd id an
 * instant before its own terminator and the match always succeeds — mid-turn
 * included. The unit test had asserted a sequence that never occurs, with the
 * pulse last and the reply frame omitted.
 *
 * The real discriminator needs no ids at all: a command reply is only ever
 * `chat_message` frames, so `delta` / `progress` / `tool_*` can only come from a
 * real turn. Track that, and a terminator simply declines to act while a turn is
 * streaming. */

/** The frame fields these decisions read. Structural, so a test can build one literally. */
export interface WatchdogFrame {
  kind: string
  sessionId?: string
  messageId?: string | number
  role?: string
}

/**
 * Does this frame belong to the session on screen?
 *
 * NOTE THE ASYMMETRY, WHICH IS LOAD-BEARING. A frame is dropped only when it
 * HAS a sessionId and that sessionId differs. A frame carrying none at all is
 * delivered — historically deliberate (tool_* frames predate session scoping),
 * but it means any new kind that omits sessionId reaches whichever session is
 * mounted. For command_done that would end the wrong exchange, so the daemon
 * emits session_id on every one (#256) and ws.ts maps it through.
 */
export function deliversToSession(f: WatchdogFrame, sessionId: string): boolean {
  if (typeof f.sessionId === 'string' && f.sessionId !== '' && f.sessionId !== sessionId) return false
  return true
}

/**
 * Frames that count as the agent being alive.
 *
 * The user echo (`message` with role 'user') deliberately does NOT: the daemon
 * echoes on accept even when it never generates, and that echo must not mask a
 * dead turn (live-walk finding 2026-07-12). `error` is absent for the same
 * reason it always was — it is handled on its own path.
 *
 * `command_done` is absent BY DESIGN. It is a terminator, not a sign of life,
 * and treating it as activity would re-arm the very timer it exists to end.
 */
export function isAssistantActivity(f: WatchdogFrame): boolean {
  return (
    f.kind === 'delta' ||
    f.kind === 'done' ||
    f.kind === 'tool_start' ||
    f.kind === 'tool_end' ||
    f.kind === 'progress' ||
    (f.kind === 'message' && f.role !== 'user')
  )
}

export type WatchdogAction =
  /** Clear any pending timer and start a fresh 30s window. */
  | 'rearm'
  /** Clear the pending timer and do NOT start another — the exchange is over. */
  | 'stand-down'
  /** Leave the timer exactly as it is. */
  | 'nothing'

/**
 * `armedFor` is the messageId the pending timer was armed for, or null when no
 * timer is pending. It is what makes command_done scopable to its own exchange.
 */
/**
 * Is a real agent turn streaming?
 *
 * Only turns emit these kinds — a slash-command reply is `chat_message` frames
 * and nothing else — so this needs no id parsing and cannot be fooled by the
 * synthetic `cmd-*` handles. `error` clears it because a turn that died is not
 * in flight, and leaving it set would make the next command_done decline
 * forever, quietly restoring the defect this file exists to fix.
 */
export function nextTurnInFlight(f: WatchdogFrame, current: boolean): boolean {
  if (f.kind === 'delta' || f.kind === 'progress' || f.kind === 'tool_start' || f.kind === 'tool_end') return true
  if (f.kind === 'done' || f.kind === 'error') return false
  return current
}

/** `turnInFlight` is the state BEFORE this frame is applied. */
export function watchdogAction(f: WatchdogFrame, turnInFlight: boolean): WatchdogAction {
  // A command terminator ends the wait for a COMMAND. While a turn is streaming
  // the pending timer is that turn's guard, and standing it down would leave a
  // turn that then died completely unreported — worse than the defect.
  if (f.kind === 'command_done') return turnInFlight ? 'nothing' : 'stand-down'
  if (!isAssistantActivity(f)) return 'nothing'
  // 'done' is terminal; everything else that proves life restarts the window.
  return f.kind === 'done' ? 'stand-down' : 'rearm'
}
