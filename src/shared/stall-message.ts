/**
 * What Beacon is entitled to say when a session goes quiet.
 *
 * THE DEFECT THIS ENCODES AGAINST. ChatShell's reply watchdog can only ever
 * witness one thing: silence IN THE SESSION ON SCREEN. The session filter above
 * it drops every other session's frames by design. It nonetheless announced
 * "the turn itself may have died" — a claim about the DAEMON, drawn from
 * evidence about one conversation.
 *
 * It was wrong on 2026-08-16, three times in a row, and provably so. The daemon
 * emitted 36 progress pulses at an exact 3s cadence through an approval wait;
 * every one carried a session id the view was not displaying; every one was
 * dropped at the filter; the 30s timer never re-armed. Beacon told an operator
 * to go check a daemon that was healthy and pulsing.
 *
 * Pure and separate so the three branches can be pinned by a headless smoke.
 * Wording is the whole point here, so the wording is what the test asserts.
 */

export interface StallEvidence {
  /** Beacon's own socket dropped and reconnected inside the window (it knows; it did it). */
  droppedInWindow: boolean
  /** The gateway sent frames for OTHER sessions during the window — MainView's fact, not ChatShell's. */
  gatewaySpokeElsewhere: boolean
}

export type StallCause = 'socket-dropped' | 'session-quiet' | 'gateway-silent'

/**
 * Which of three situations the evidence supports, most-specific first.
 *
 * Order matters and is not arbitrary:
 *   1. WE dropped the socket — the most specific fact available, and ours.
 *   2. The gateway is demonstrably alive elsewhere — so this is not a
 *      connection fault, whatever else it is.
 *   3. Nothing was heard from anywhere — the only case that earns the
 *      alarming reading.
 */
export function stallCause(e: StallEvidence): StallCause {
  if (e.droppedInWindow) return 'socket-dropped'
  if (e.gatewaySpokeElsewhere) return 'session-quiet'
  return 'gateway-silent'
}

/** The operator-facing line. Each says only what its evidence supports. */
export function stallMessage(e: StallEvidence): string {
  switch (stallCause(e)) {
    case 'socket-dropped':
      return (
        'the connection dropped and reconnected during this turn, so Beacon stopped ' +
        'receiving for 30s. The turn most likely kept running on the daemon — its ' +
        'messages will fill in from history. Send again only if nothing appears.'
      )
    case 'session-quiet':
      return (
        'no activity in this session for 30s. The gateway is up and was active on other ' +
        'sessions the whole time, so this is not a connection problem — the turn may be ' +
        'waiting on something, such as an approval.'
      )
    case 'gateway-silent':
      return (
        'no signal from the gateway for 30s, on any session, and the connection stayed ' +
        'up the whole time — so the turn itself may have died. Check the daemon, or send again.'
      )
  }
}
