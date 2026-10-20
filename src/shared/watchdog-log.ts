/**
 * Durable record of what the reply watchdog DECIDED.
 *
 * WHY THIS EXISTS. The watchdog's most consequential output is the line that
 * tells an operator to go check the daemon. On 2026-08-17 one of those fired and
 * could not be audited afterwards at all: the value it turns on — MainView's
 * `daemonLastSeen` — is a `useRef`, in memory, never written anywhere. The socket
 * half of that incident was answerable from `socket_events`; the frame half was
 * not answerable by any means. The quiet fact had a record and the loud one did
 * not.
 *
 * THIS IS NOT A FRAME LOG, AND MUST NOT BECOME ONE. A frame-arrival log would
 * answer "was there traffic at 16:56:40" at a cost of hundreds of rows a minute,
 * to serve a watchdog that asks exactly one question, rarely. What is recorded
 * here is the DECISION and its RAW INPUTS — so a later reader can recompute the
 * verdict rather than trust it, which is precisely what the 16:52-16:57
 * investigation could not do.
 *
 * RE-ARMS ARE COALESCED, and that is what makes always-on affordable. A live
 * turn pulses every 3s and each pulse re-arms; a five-minute turn is ~100
 * re-arms. Writing those would turn a diagnostic table into a disk-fill. One
 * `armed` row is written per COLD arm, the re-arms are counted, and the count
 * rides on the row that closes the window.
 */

export type WatchdogEventKind =
  /** A timer started where none was pending. Written once; re-arms are counted, not written. */
  | 'armed'
  /** The timer was cleared before firing. `reason` says what cleared it. */
  | 'stood-down'
  /** The timer expired and an operator-facing line was produced. */
  | 'fired'

/**
 * What cleared a pending timer.
 *
 * `unmount` IS A FINDING, not a housekeeping case. The watchdog is per-ChatShell
 * and one ChatShell is mounted at a time, so switching away from a stalled
 * session destroys its timer and the stall is never reported for that session.
 * Recording it does not fix it — it makes it visible, which is the first thing
 * that has ever been true of it.
 */
export type StandDownReason = 'done' | 'command_done' | 'unmount'

/** The branch the operator-facing message took (mirrors stall-message's StallCause). */
export type WatchdogCause = 'socket-dropped' | 'session-quiet' | 'gateway-silent'

export interface WatchdogEvent {
  /** Epoch ms. Without this the row cannot be placed in a window and proves nothing. */
  at: number
  kind: WatchdogEventKind
  sessionId: string
  /** 'stood-down' only. */
  reason?: StandDownReason
  /** Re-arms coalesced into this window. Carried on whichever row closes it. */
  rearms?: number
  /** ms from the cold arm to this event. */
  armedForMs?: number
  /** 'fired' only — the branch taken. */
  cause?: WatchdogCause
  // ── RAW INPUTS ('fired' only) ────────────────────────────────────────────────
  // The verdict is derived; these are what it was derived FROM. Recording both
  // means a later reader can check the arithmetic instead of believing the
  // conclusion — the whole point of the table.
  /** When Beacon's own socket last dropped, or null if it had not. */
  socketDroppedAt?: number | null
  /** MainView's daemonLastSeen at the moment of the decision — the unrecordable value. */
  daemonLastSeenAt?: number | null
  /** Whether a real agent turn was streaming. */
  turnInFlight?: boolean
}

/**
 * Rolling window. Diagnostic data, not history — the same contract as
 * socket_events, and the same reason: a diagnostic that can grow without bound
 * becomes the incident.
 *
 * At roughly two rows per exchange (one `armed`, one closing row) this holds
 * ~200 exchanges, comfortably more than any single investigation needs.
 */
export const WATCHDOG_LOG_MAX_ROWS = 400

/** Coalescing state. One open window at a time, mirroring the single timer. */
export interface WatchdogLogState {
  /** Epoch ms of the cold arm that opened the current window, or null if none is open. */
  armedAt: number | null
  /** Re-arms since that cold arm. Counted, never written individually. */
  rearms: number
}

export const emptyWatchdogLog = (): WatchdogLogState => ({ armedAt: null, rearms: 0 })

export interface LogStep {
  state: WatchdogLogState
  /** null when the transition writes nothing — which is the common case, by design. */
  event: WatchdogEvent | null
}

/** Arming. Writes a row ONLY when no window is open; otherwise counts a re-arm. */
export function onArm(s: WatchdogLogState, at: number, sessionId: string): LogStep {
  if (s.armedAt !== null) return { state: { armedAt: s.armedAt, rearms: s.rearms + 1 }, event: null }
  return { state: { armedAt: at, rearms: 0 }, event: { at, kind: 'armed', sessionId } }
}

/** Clearing before it fires. Writes nothing when no window was open. */
export function onStandDown(s: WatchdogLogState, at: number, sessionId: string, reason: StandDownReason): LogStep {
  if (s.armedAt === null) return { state: s, event: null }
  return {
    state: emptyWatchdogLog(),
    event: { at, kind: 'stood-down', sessionId, reason, rearms: s.rearms, armedForMs: at - s.armedAt }
  }
}

/**
 * Expiry. ALWAYS writes — this is the row the whole table exists for, so the
 * return type promises an event rather than `LogStep`'s nullable one.
 */
export function onFire(
  s: WatchdogLogState,
  at: number,
  sessionId: string,
  decision: { cause: WatchdogCause; socketDroppedAt: number | null; daemonLastSeenAt: number | null; turnInFlight: boolean }
): { state: WatchdogLogState; event: WatchdogEvent } {
  return {
    state: emptyWatchdogLog(),
    event: {
      at,
      kind: 'fired',
      sessionId,
      rearms: s.rearms,
      ...(s.armedAt === null ? {} : { armedForMs: at - s.armedAt }),
      cause: decision.cause,
      socketDroppedAt: decision.socketDroppedAt,
      daemonLastSeenAt: decision.daemonLastSeenAt,
      turnInFlight: decision.turnInFlight
    }
  }
}

/** One-line rendering for a human reading the table back. Pure. */
export function describeWatchdogEvent(e: WatchdogEvent): string {
  const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 23)
  const bits: string[] = []
  if (e.reason) bits.push(`reason=${e.reason}`)
  if (e.cause) bits.push(`cause=${e.cause}`)
  if (typeof e.rearms === 'number') bits.push(`rearms=${e.rearms}`)
  if (typeof e.armedForMs === 'number') bits.push(`armed=${e.armedForMs}ms`)
  if (e.kind === 'fired') {
    bits.push(`socketDroppedAt=${e.socketDroppedAt ?? 'none'}`)
    bits.push(`daemonLastSeenAt=${e.daemonLastSeenAt ?? 'never'}`)
    bits.push(`turnInFlight=${e.turnInFlight === true}`)
  }
  return `${when}  ${e.kind}  ${e.sessionId}${bits.length ? '  ' + bits.join(' ') : ''}`
}
