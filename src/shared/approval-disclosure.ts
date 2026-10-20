/**
 * "Remember this decision" — the disclosure that has to be OPENED before any
 * grant-creating option is reachable.
 *
 * TWO DEFECTS, ONE MOVE.
 *
 * 1. AFFORDANCE. The four grant options rendered as full-width bordered blocks
 *    with a neutral hairline border and dim text — the treatment this codebase
 *    uses for informational rows. They read as prose, and prose is safe to
 *    click. On 2026-08-16 an operator reaching to dismiss the card clicked one
 *    and created a remembered permission they believed they were dismissing.
 *
 * 2. VOLUME. Six options, four of them long, on every single prompt. That is
 *    the price of describing extents, and it is charged on the common case
 *    (approve once, or deny) to serve the rare one.
 *
 * Behind a disclosure, both go: nothing that creates a grant is reachable
 * without an explicit act, and the default prompt is three controls.
 *
 * ── THE LOAD-BEARING RULE ────────────────────────────────────────────────────
 *
 * CLOSED ON EVERY NEW REQUEST. NEVER PERSISTED. OPENING IS THE CONSENT ACT.
 *
 * This is not a preference and it must not become one. A disclosure that
 * remembers being open puts the grant options back under an accidental click
 * and restores the exact defect, silently, for anyone who opened it once.
 *
 * That mistake is EASY TO MAKE HERE: Beacon shipped a persisted-collapse
 * mechanism the day before this (sessions:groups:v1, settings KV, versioned
 * key), and "make the disclosure remember, like the sidebar does" is a natural,
 * well-intentioned change. It would be wrong.
 *
 * So the rule is encoded in the TYPE rather than left to discipline: the state
 * is WHICH REQUEST is open, not WHETHER something is open. A different request
 * is closed by construction — there is no boolean to persist, and making it
 * persistent would require changing this shape, which the smoke pins.
 */

/** The request id whose disclosure is open, or null. NOT a boolean, deliberately. */
export type DisclosureState = string | null

/**
 * Is this request's disclosure open?
 *
 * Returns false for a DIFFERENT request even when one is open — that is the
 * whole point, and it is a property of the data shape rather than of any reset
 * logic someone has to remember to write.
 */
export function isDisclosureOpen(state: DisclosureState, requestId: string): boolean {
  return state !== null && state === requestId
}

/** Open this request's disclosure, or close it if it is already the open one. */
export function toggleDisclosure(state: DisclosureState, requestId: string): DisclosureState {
  return isDisclosureOpen(state, requestId) ? null : requestId
}

/**
 * The summary label. States what is behind the disclosure and how much, so the
 * capability stays discoverable without being shouted on every prompt.
 */
export function disclosureLabel(count: number): string {
  return `Remember this decision (${count} option${count === 1 ? '' : 's'})`
}
