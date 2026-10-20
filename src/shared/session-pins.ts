/**
 * Session pins — the pure core (Prometheus#351, Beacon half).
 *
 * A pin used to live in Beacon's own settings table as `pinned:<id>`, so it existed only on the
 * machine that set it: pin at the desk, pick up the phone, and the conversation is still buried.
 * A pin is a property OF THE CONVERSATION, like its title, so the daemon owns it now and every
 * client reads the same answer.
 *
 * This module holds the two decisions that are easy to get wrong when moving state across that
 * boundary: what to show while a write is in flight, and what to do with the pins that already
 * exist locally.
 */

/** The daemon's write shape. A plain bool — the route rejects `"true"` and `1` deliberately,
 *  because guessing which truthiness was meant is how a pin silently inverts. */
export function pinBody(pinned: boolean): { pinned: boolean } {
  return { pinned }
}

/**
 * Local pins that the daemon has not yet been told about.
 *
 * Beacon has been storing pins locally for months; switching the read to the daemon without this
 * would silently unpin everything the user already pinned. Migration is one PUT per stale row,
 * after which the local row is cleared — the same shape the title override already uses.
 *
 * A session the daemon ALREADY reports as pinned needs no PUT, so a re-run is a no-op rather than
 * a second write.
 */
export function needsPinMigration(daemonPinned: boolean | undefined, localPin: string | null): boolean {
  return localPin === '1' && daemonPinned !== true
}

/** A failed pin is not a no-op — the click did nothing and the user must be told which way it
 *  actually is. Named per direction, because "pin failed" reads the same for both. */
export function pinFailureNotice(pinned: boolean, detail?: string): string {
  const what = pinned ? 'Could not pin that conversation' : 'Could not unpin that conversation'
  return detail ? `${what} — ${detail}` : `${what} — the daemon did not accept the change`
}

/**
 * The wire value → a boolean, at the ONE place Beacon reads it.
 *
 * A pre-#351 daemon omits the key entirely; a sloppy client could send "true" or 1. Both must read
 * as NOT pinned: absence is not a pin, and only a real `true` is. This used to be an inline
 * `=== true` in rest.ts, which was correct and untestable — nothing could assert that an absent key
 * stays unpinned without spinning up a fetch.
 */
export function pinnedFromWire(v: unknown): boolean {
  return v === true
}
