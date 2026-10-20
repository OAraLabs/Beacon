/**
 * Durable socket-lifecycle events.
 *
 * WHY THIS EXISTS. Beacon recorded its own socket lifecycle NOWHERE durable.
 * `ws.ts` had exactly two `console` lines, and one of the two `terminate()`
 * calls — the one in the catch when `ping()` throws — had none at all. State
 * transitions logged nothing. In a packaged app launched from the Dock, main
 * stdout goes nowhere, so all of it was discarded as it was written.
 *
 * The cost was concrete. An approval on 2026-08-16 produced six findings that
 * all reduce to one unanswered question — was the socket terminated, or did it
 * stay connected and never receive? — and NEITHER end had kept a record. The
 * daemon's `broadcast()` swallowed dead-client writes with a bare `except` and
 * no log, so it could not tell 36 delivered pulses from 36 written into a socket
 * nobody held; Beacon could not say whether it still held one. A dropped-frame
 * count on one side and silence on the other is still a coin flip.
 *
 * TIMESTAMPS ARE THE POINT, not a nicety. The only Beacon-side record that
 * existed at all was a redirected dev log with seven `ECONNREFUSED` lines and
 * ZERO timestamps — which is why it could not answer a question about a
 * fifteen-minute window. A log that cannot be placed in time is not evidence.
 */

/**
 * What happened to the socket. Both `terminated-*` kinds are distinct on
 * purpose: they are different code paths with different causes, and collapsing
 * them would lose exactly the distinction this table was added to capture.
 */
export type SocketEventKind =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  /** Liveness watchdog saw no inbound traffic for STALE_AFTER_MS and destroyed the socket. */
  | 'terminated-stale'
  /** `ws.ping()` threw on a socket we believed OPEN — it was not. THE PREVIOUSLY SILENT PATH. */
  | 'terminated-ping-failed'
  /**
   * A socket we REPLACED was detached and destroyed. Distinct from the terminated-* kinds: nothing
   * was wrong with it, we simply stopped holding it. Recorded because the alternative — replacing
   * the reference and walking away — is what produced the 2026-08-19 doubled-delta incident, and
   * an orphan that leaves no row is an orphan nobody can find afterwards.
   */
  | 'retired'
  | 'error'

export interface SocketEvent {
  /** Epoch ms. Without this the row cannot be placed in a window and proves nothing. */
  at: number
  kind: SocketEventKind
  /** Reconnect attempt number, where the kind carries one. */
  attempt?: number
  /** Error text, or the measured silence that triggered a terminate. The reason, in its own words. */
  detail?: string
}

/**
 * Rolling window. Diagnostic data, not history.
 *
 * A socket that cycled 42 times in one day writes roughly 130 rows/day, so this
 * holds about four days — enough to answer "what happened during that approval"
 * and bounded enough that it cannot become the thing it is diagnosing. The
 * daemon's own log reached 1.4 GB unrotated on the same box, on the same day,
 * for exactly the want of a bound.
 */
export const SOCKET_LOG_MAX_ROWS = 500

/** One-line rendering for a human reading the table back. Pure. */
export function describeSocketEvent(e: SocketEvent): string {
  const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 23)
  const attempt = typeof e.attempt === 'number' ? ` attempt=${e.attempt}` : ''
  const detail = e.detail ? ` — ${e.detail}` : ''
  return `${when}  ${e.kind}${attempt}${detail}`
}
