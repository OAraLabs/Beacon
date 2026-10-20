// Session PURGE (Prometheus#353 → PR#354) — the DESTRUCTIVE verb, deliberately separate from
// forget.
//
// The distinction this file exists to keep visible:
//   DELETE /api/sessions/{id}   → a TOMBSTONE. Hides the session from the index; the append-only
//                                 LCM rows stay, and the session RESURFACES on newer activity.
//                                 That is Beacon's ✕ "Forget this session", and its label is
//                                 accurate.
//   POST   /api/sessions/{id}/purge → the rows actually go: messages + their FTS index, summaries
//                                 + FTS, titles/profiles/pins/forks/tombstones. No undo.
//
// A UI that wired purge to the ✕ would silently upgrade "tidy my sidebar" into "destroy the
// record", which is the single worst mistake available here.

/** The daemon route. POST, not DELETE — purge is deliberately not folded into the tombstone verb. */
export function purgePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/purge`
}

/**
 * The daemon requires the session id echoed back as `confirm` ("naming the session twice is
 * friction on purpose"). Beacon fills it from the row rather than making a human retype a UUID —
 * the daemon's guard defends against a stray API call, and a GUI needs its own human-scale guard
 * instead (see PURGE_TYPED_CONFIRM). Both exist; neither substitutes for the other.
 */
export function purgeBody(sessionId: string): { confirm: string } {
  return { confirm: sessionId }
}

/** What the operator must type to arm the button. Short enough to type, impossible to hit by
 *  accident, and it says what it does. */
export const PURGE_TYPED_CONFIRM = 'PURGE'

export function isPurgeConfirmed(typed: string): boolean {
  return typed.trim().toUpperCase() === PURGE_TYPED_CONFIRM
}

export interface PurgeResult {
  ok: boolean
  /** Per-table row counts the daemon actually deleted. */
  purged: Record<string, number>
  /** Branches forked FROM this session. They hold independent copies and SURVIVE the purge. */
  branches: string[]
  /** Always false on a real purge — carried so a UI can never imply otherwise. */
  reversible: boolean
  error?: string
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * Tolerant wire → model. `ok: true` alone is NOT evidence the rows went — the pre-#354 route
 * returned `ok` unconditionally even with no store (the #348/#349 shape) — so an `ok` with no
 * `purged` object is treated as a REFUSAL to claim success, not as success.
 */
export function parsePurgeResult(raw: unknown): PurgeResult {
  const empty: PurgeResult = { ok: false, purged: {}, branches: [], reversible: false }
  if (!raw || typeof raw !== 'object') return { ...empty, error: 'the daemon returned nothing' }
  const o = raw as Record<string, unknown>
  if (typeof o.error === 'string' && o.error) return { ...empty, error: o.error }
  const purgedRaw = o.purged
  if (!purgedRaw || typeof purgedRaw !== 'object')
    return { ...empty, error: 'the daemon reported ok without saying what it deleted — treating that as unproven' }
  const purged: Record<string, number> = {}
  for (const [k, v] of Object.entries(purgedRaw as Record<string, unknown>)) purged[k] = num(v)
  const branches = Array.isArray(o.branches) ? o.branches.filter((b): b is string => typeof b === 'string') : []
  return { ok: o.ok !== false, purged, branches, reversible: false }
}

/** Total rows removed across every table. */
export function purgedTotal(r: PurgeResult): number {
  return Object.values(r.purged).reduce((a, b) => a + b, 0)
}

/**
 * One sentence stating what happened — counts first, then the branch caveat, because a surviving
 * branch is the part a user would otherwise discover later and consider a failed purge.
 */
export function purgeSummary(r: PurgeResult): string {
  if (r.error) return `purge failed: ${r.error}`
  const parts = Object.entries(r.purged)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${n} ${table.replace(/^lcm_/, '').replace(/_/g, ' ')}`)
  const head = parts.length > 0 ? `purged ${parts.join(', ')}` : 'purged — the daemon reported no rows to delete'
  if (r.branches.length === 0) return `${head}. This cannot be undone.`
  const b = r.branches.length === 1 ? '1 branch keeps' : `${r.branches.length} branches keep`
  return `${head}. ${b} its own copy and survived — purge those separately if they must go too.`
}
