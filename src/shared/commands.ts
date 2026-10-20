// Pure command-palette model (Makeover Slice 5) — ranking shared by the renderer palette and the
// headless smoke. NO DOM/React imports.

import { SEARCH_MIN_QUERY } from './search'

export interface PaletteEntry {
  id: string
  label: string
  /** Right-aligned hint (shortcut, session gateway, a timestamp, a diff count). */
  hint?: string
  group: 'view' | 'session' | 'action' | 'file'
}

/** The kind chip at the head of a row — mono, so it reads as a label, not a word. */
export const GROUP_CHIP: Record<PaletteEntry['group'], string> = {
  session: 'SESS',
  action: 'ACT',
  file: 'FILE',
  view: 'VIEW'
}

/** Group order in the list. Sessions first: the palette is opened to GO somewhere far more often
 *  than to DO something, and putting actions first would put a destructive row under the cursor. */
export const GROUP_ORDER: PaletteEntry['group'][] = ['session', 'action', 'file', 'view']

/** At most `max` rows per group.
 *
 *  A palette that lists 182 sessions is a list, not a palette — you scroll it instead of typing,
 *  which is the behaviour it exists to replace. Capping AFTER ranking means the five shown are the
 *  five best matches for what you typed, and narrowing the query is what reveals the rest.
 *  Order within a group is preserved, so an empty query shows the most recent five. */
export function capGroups<T extends { group: PaletteEntry['group'] }>(items: T[], max = 5): T[] {
  const seen = new Map<string, number>()
  const out: T[] = []
  for (const it of items) {
    const n = seen.get(it.group) ?? 0
    if (n >= max) continue
    seen.set(it.group, n + 1)
    out.push(it)
  }
  return out
}

/** Ranked rows regrouped so each group's rows are contiguous, in GROUP_ORDER.
 *
 *  Ranking interleaves groups (a session can outrank an action), which made the group HEADER
 *  reappear every few rows — the old list printed `SESSIONS` four separate times. Sorting by group
 *  after ranking keeps the best-match order INSIDE each group while giving each header one place. */
export function byGroup<T extends { group: PaletteEntry['group'] }>(items: T[]): T[] {
  const rank = new Map(GROUP_ORDER.map((g, i) => [g, i]))
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (rank.get(a.item.group)! - rank.get(b.item.group)!) || a.i - b.i)
    .map((x) => x.item)
}

/** True iff every char of `q` appears in `s` in order (case-insensitive subsequence). */
export function isSubsequence(q: string, s: string): boolean {
  const ql = q.toLowerCase()
  const sl = s.toLowerCase()
  let i = 0
  for (const ch of sl) {
    if (ch === ql[i]) i++
    if (i === ql.length) return true
  }
  return ql.length === 0
}

/**
 * Rank palette entries for a query: prefix match beats word-boundary match beats substring beats
 * subsequence; non-matches drop. Empty query → original order. Stable within a tier.
 */
export function rankCommands<T extends { label: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  const scored: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    const l = item.label.toLowerCase()
    let score: number | null = null
    if (l.startsWith(q)) score = 0
    else if (l.split(/[\s:/—·-]+/).some((w) => w.startsWith(q))) score = 1
    else if (l.includes(q)) score = 2
    else if (isSubsequence(q, l)) score = 3
    if (score !== null) scored.push({ item, score, i })
  })
  scored.sort((a, b) => a.score - b.score || a.i - b.i)
  return scored.map((s) => s.item)
}

/** The static shortcut map (Slice 5) — drives the ? cheat sheet and the palette's hints. */
export const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: '⌘K / Ctrl+K', does: 'Command palette' },
  { keys: '⌘⇧F / Ctrl+Shift+F', does: 'Search every conversation' },
  { keys: '⌘, / Ctrl+,', does: 'Connection settings' },
  { keys: '?', does: 'This shortcut sheet (outside inputs)' },
  { keys: 'Enter', does: 'Send message' },
  { keys: 'Shift+Enter', does: 'Newline in composer' },
  { keys: 'Esc', does: 'Close palette / sheet / popover / the dock' },
  { keys: '⌘1 / Ctrl+1', does: 'Open or close the inspector pane (the dock, beside the chat)' },
  { keys: '⌘2 / Ctrl+2', does: 'Open or close the browser pane (same dock)' },
  { keys: '⌘3 / Ctrl+3', does: 'Open or close the terminal pane (same dock)' },
  { keys: '⌘4 / Ctrl+4', does: 'Open or close the progress pane (same dock)' },
  { keys: '⌘⇧B / Ctrl+Shift+B', does: 'Summon Beacon from anywhere (global)' }
]

// ── The palette's one pinned row (global search, frozen spec §3) ──────────────────────────────
// The palette gains a hand-off to conversation search WITHOUT a content-dependent mode flip: no
// "no matches → become a search box" behaviour, which is jarring and would couple the palette's
// tested ranking contract to what the daemon happens to hold. The row is render-layer only —
// rankCommands, the command list, and its order/count are untouched.

/** The pinned row shows only once a query could actually be sent (same floor as the endpoint). */
export function shouldOfferSearch(query: string): boolean {
  return query.trim().length >= SEARCH_MIN_QUERY
}

/** Label for the pinned row. Quotes the query so it reads as a verb, not a category. */
export function searchRowLabel(query: string): string {
  return `Search conversations for “${query.trim()}”`
}
