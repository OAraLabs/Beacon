/**
 * Provenance + trust, at the wire boundary (Prometheus#123, audit P9.3).
 *
 * The daemon persists WHO originated every turn — `provenance` — and whether its content is
 * trusted — `is_trusted` — and documents both for clients to badge on (`web/server.py`, the
 * `/api/messages` contract). `role` does not carry this: an assistant turn authored by a cron
 * re-engagement, a task supervisor or the file-mutation verifier has `role: "assistant"` exactly
 * like a reply to something Will typed. Dropping the marker made machinery output render as the
 * operator's own words, and untrusted third-party content (a fetched page, a harvested file)
 * indistinguishable from his.
 *
 * These helpers are the ONE place the wire vocabulary is decoded, the same way `session-pins.ts`
 * owns the pin vocabulary — so the mapper, the cache and the renderer cannot each invent a
 * slightly different rule for "is this not from the operator?".
 *
 * The daemon's known provenance values (as of 2026-09-16) are: user, compactor,
 * file_mutation_verifier, orchestrator, supervisor, task_supervisor, teacher_escalation. This is
 * NOT an allowlist — an unknown value is treated as machinery (the safe direction: a label we
 * cannot map still says "not you" rather than silently rendering as the operator's own).
 */

/** The wire value for "the operator typed this". Everything else is machinery. */
export const USER_PROVENANCE = 'user'

/**
 * True when a message did NOT originate from the operator. Drives the badge.
 *
 * Absent / null / '' all read as the daemon default — `provenance: "user"` — so an older daemon
 * that omits the key, and an optimistic local row that never round-tripped, both read as "from
 * the operator" rather than spuriously badging the operator's own messages as machinery. The safe
 * direction for a MISSING value is therefore the opposite of an UNKNOWN-but-present value:
 * absence means pre-feature daemon (treat as user), a present-but-unmapped string means a newer
 * daemon added a machinery source (treat as not-user).
 */
export function isMachineryProvenance(provenance: string | null | undefined): boolean {
  if (provenance === null || provenance === undefined || provenance === '') return false
  return provenance !== USER_PROVENANCE
}

/**
 * Decode the wire `is_trusted` field. The daemon sends a real boolean (`bool(getattr(...))`), but
 * the boundary has tolerated string and number junk for every other field, so this refuses them
 * the way `pinnedFromWire` refuses `'true'` and `1`: only a real boolean counts. Absent reads as
 * TRUE — the daemon's own default (`is_trusted: bool = True`) — so a pre-feature daemon does not
 * paint the operator's whole history as untrusted.
 */
export function isTrustedFromWire(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean') return value
  // A string 'false' or a number 0 is NOT the boolean false — the daemon never sends those, and
  // trusting them would let a malformed frame flip the trust state. Default to trusted.
  return true
}

/**
 * The badge label for a machinery turn, or null when the row needs no badge.
 *
 * Returns the human-readable source for a known provenance so the badge says WHAT wrote the turn
 * ("task supervisor", "compactor") rather than a generic "not you" — but falls back to a generic
 * label for an unmapped value rather than printing a raw snake_case token. An untrusted row gets
 * an untrusted marker regardless of provenance.
 */
export function provenanceLabel(provenance: string | null | undefined): string | null {
  if (!isMachineryProvenance(provenance)) return null
  const known: Record<string, string> = {
    compactor: 'compactor',
    file_mutation_verifier: 'file-mutation verifier',
    orchestrator: 'orchestrator',
    supervisor: 'supervisor',
    task_supervisor: 'task supervisor',
    teacher_escalation: 'teacher escalation'
  }
  return known[provenance as string] ?? 'automated'
}

/**
 * Did the OPERATOR type this row? The user role AND no machinery provenance.
 *
 * `role` alone cannot answer it: a background task's or a worker's report (`task_supervisor`), a
 * coding supervisor's inject (`supervisor`) and an orchestrator nudge all arrive with the user
 * role. Retry ("send the last user message again") and Edit ("copy it back into the composer")
 * must act only on what the operator typed — on a machine turn they would send its text, often
 * untrusted, as the operator's own words. Absent provenance reads as the operator's, for the same
 * reason the badge does (an older daemon, an optimistic row not yet echoed).
 */
export function isOperatorTurn(row: { role: string; provenance?: string | null }): boolean {
  return row.role === 'user' && !isMachineryProvenance(row.provenance)
}

/**
 * The newest row the operator typed that `hasText` accepts — what Retry re-sends and Edit copies
 * back. Undefined when there is none: never a machine turn in its place. ONE rule for the button's
 * placement and the text it sends, so the two cannot pick different rows.
 */
export function lastOperatorTurn<T extends { role: string; provenance?: string | null }>(
  rows: readonly T[],
  hasText: (row: T) => boolean
): T | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (isOperatorTurn(rows[i]) && hasText(rows[i])) return rows[i]
  return undefined
}
