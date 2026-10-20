// Pure session-tree grouping (Phase 5b Sessions view) — root sessions with nested subagents. Shared
// with the headless smoke. Daemon ids look like `agent:main:main` (root) / `agent:main:subagent:<id>`.

export interface SessionLike {
  id: string
  gateway?: string
  messageCount?: number
  lastActive?: number
}

export interface SessionTreeNode<T extends SessionLike = SessionLike> {
  session: T
  children: T[]
}

export function isSubagent(id: string): boolean {
  return id.includes('subagent')
}

/** Parent key of a subagent id = everything before ':subagent'. A non-subagent id → itself. */
export function parentKeyOf(id: string): string {
  const i = id.indexOf(':subagent')
  return i >= 0 ? id.slice(0, i) : id
}

/**
 * Group sessions into roots with nested subagents. A subagent attaches to the root whose id matches
 * its parent key (exact, prefix, or the root being a prefix of the key); orphans (no matching root)
 * float to the top level. Roots and children sorted by lastActive desc.
 */
export function buildSessionTree<T extends SessionLike>(sessions: T[]): SessionTreeNode<T>[] {
  const byActive = (a: T, b: T): number => (b.lastActive ?? 0) - (a.lastActive ?? 0)
  const roots = sessions.filter((s) => !isSubagent(s.id)).sort(byActive)
  const subs = sessions.filter((s) => isSubagent(s.id))
  const nodes: SessionTreeNode<T>[] = roots.map((s) => ({ session: s, children: [] }))
  for (const sub of subs) {
    const pk = parentKeyOf(sub.id)
    const parent = nodes.find(
      (n) => n.session.id === pk || n.session.id.startsWith(`${pk}:`) || pk.startsWith(n.session.id)
    )
    if (parent) parent.children.push(sub)
    else nodes.push({ session: sub, children: [] })
  }
  for (const n of nodes) n.children.sort(byActive)
  return nodes
}

/**
 * The label for one session row, in precedence order:
 *
 *   1. the title the DAEMON serves — a real generated summary
 *   2. a snippet of the first user message
 *   3. the raw session id
 *
 * Rule 1 is new, and the reason it was previously absent is worth keeping. The old code chose
 * the snippet unconditionally, with the comment "the stored title is the daemon's session_id
 * echo" — which was CORRECT when written. The daemon echoed the id in that field, so a snippet
 * of the conversation genuinely was the better label.
 *
 * That stopped being true when the daemon began generating titles (Prometheus #308's backfill).
 * Nothing rotted here: the comment was accurate, the decision was deliberate, and the world moved
 * underneath both. Measured on the live daemon afterwards: 205 sessions, 190 with a title, and
 * ZERO of them equal to the id.
 *
 * The `served !== id` guard is therefore load-bearing rather than defensive dressing, for two
 * live reasons: an older daemon still echoes, and this client's own cache stores `title ?? id`
 * when the daemon sends none (cache/service.ts), so the id genuinely appears in that column.
 * Falling through to the snippet is the right answer in both cases.
 */
export function sessionDisplayTitle(
  servedTitle: string | null | undefined,
  firstUserContent: string | null | undefined,
  id: string
): string {
  const served = (servedTitle ?? '').trim()
  if (served && served !== id) return served
  return snippetTitle(firstUserContent) || id
}

/** Auto display-title from a session's first user message: collapse whitespace and cap at `max`
 * chars on a word boundary. '' when there is no usable content (caller falls back to the id). */
export function snippetTitle(content: string | null | undefined, max = 48): string {
  const flat = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}
