/**
 * Split panes: several conversations side by side in the main window. Pure, so the main view and a
 * headless smoke share one model.
 *
 * THE MODEL. A row of panes, left to right, and one FOCUSED pane. The focused pane is what every
 * single-session feature already meant by "the open conversation": the browser's Send-to-chat, voice
 * and dictation, the dock, a search jump, Home's first message. So none of those change; they follow
 * focus. A pane holds a session id, or null for Home (the new-chat screen), and only the focused pane
 * may be Home: an unfocused Home pane would be an empty column nobody asked for.
 *
 * ONE PLACE AT A TIME, as with session windows (@shared/session-windows): a session is in at most one
 * pane. Asking to show a session that is already in a pane focuses that pane instead of opening it twice.
 *
 * WIDTH. Every pane keeps CONVERSATION_MIN_WIDTH. `maxPanesFor(room)` says how many fit; a split that
 * would not fit is refused, and the caller offers "Open in its own window" instead.
 */

import { CONVERSATION_MIN_WIDTH } from './side-panel'

export type PaneTarget = string | null

export interface PaneLayout {
  /** Left to right. Never empty. */
  panes: PaneTarget[]
  /** Index into `panes`. */
  focus: number
  /**
   * Each pane's share of the row (flex-grow), aligned with `panes`. Absent means equal shares, which
   * is also what a double-click on a divider goes back to. Kept normalised to a mean of 1, so the
   * numbers stay readable and a saved layout does not drift.
   */
  weights?: number[]
}

/** Hard cap, whatever the screen: past four, a column is a sliver even on an ultrawide. */
export const MAX_PANES = 4
export const PANE_MIN_WIDTH = CONVERSATION_MIN_WIDTH
/** The line between two panes (its grab area, if any, overlaps; this is its footprint). */
export const PANE_DIVIDER_WIDTH = 1
export const SPLIT_LAYOUT_KEY = 'chat:panes:v1'
/** The drag payload of a sidebar session row: projects, the chat area's split zones, all read it. */
export const SESSION_DRAG_TYPE = 'application/x-beacon-session'

export function single(target: PaneTarget): PaneLayout {
  return { panes: [target], focus: 0 }
}

export function focusedTarget(l: PaneLayout): PaneTarget {
  return l.panes[l.focus] ?? null
}

/** The sessions on screen (Home is not one). */
export function visibleSessions(l: PaneLayout): string[] {
  return l.panes.filter((p): p is string => typeof p === 'string')
}

/** Room the panes need: each its minimum, plus the lines between them. */
export function panesMinWidth(count: number): number {
  const n = Math.max(1, Math.floor(count))
  return n * PANE_MIN_WIDTH + (n - 1) * PANE_DIVIDER_WIDTH
}

/** How many panes fit in `room` CSS px (at least 1, at most MAX_PANES). */
export function maxPanesFor(room: number): number {
  if (!Number.isFinite(room) || room <= 0) return 1
  const n = Math.floor((room + PANE_DIVIDER_WIDTH) / (PANE_MIN_WIDTH + PANE_DIVIDER_WIDTH))
  return Math.max(1, Math.min(MAX_PANES, n))
}

/** Weights scaled to a mean of 1 and rounded, or undefined when they are (near enough) equal. */
function canonicalWeights(w: number[] | undefined, count: number): number[] | undefined {
  if (!w || w.length !== count || count < 2) return undefined
  if (!w.every((x) => Number.isFinite(x) && x > 0)) return undefined
  const mean = w.reduce((a, b) => a + b, 0) / count
  const out = w.map((x) => Math.round((x / mean) * 10_000) / 10_000)
  return out.every((x) => Math.abs(x - 1) < 0.001) ? undefined : out
}

/** The pane weights to render with: the layout's own, or equal shares. */
export function paneWeights(l: PaneLayout): number[] {
  return canonicalWeights(l.weights, l.panes.length) ?? l.panes.map(() => 1)
}

/** Keep the invariants: non-empty, no duplicate session, Home only where focus is, focus in range.
 *  Weights travel with their panes: a dropped pane takes its weight with it. */
function normalize(panes: PaneTarget[], focus: number, weights?: number[]): PaneLayout {
  const focusTarget = panes[focus]
  const out: PaneTarget[] = []
  const w: number[] = []
  let f = 0
  panes.forEach((p, i) => {
    if (p === null && i !== focus) return
    if (p !== null && out.includes(p)) return
    if (i === focus) f = out.length
    out.push(p)
    w.push(weights?.[i] ?? 1)
  })
  if (out.length === 0) return single(null)
  // The focused entry may have been a duplicate dropped above; then focus its surviving copy.
  if (out[f] !== focusTarget) {
    const at = out.indexOf(focusTarget ?? null)
    f = at >= 0 ? at : Math.min(f, out.length - 1)
  }
  const cw = weights ? canonicalWeights(w, out.length) : undefined
  return { panes: out, focus: Math.max(0, Math.min(f, out.length - 1)), ...(cw ? { weights: cw } : {}) }
}

/**
 * "Show me this": what a sidebar click, Home, a fork, a notification does. A session already in a
 * pane gets focus; anything else replaces what the FOCUSED pane shows.
 */
export function showIn(l: PaneLayout, target: PaneTarget): PaneLayout {
  if (target !== null) {
    const at = l.panes.indexOf(target)
    if (at >= 0) return at === l.focus ? l : { ...l, focus: at }
  }
  const panes = l.panes.slice()
  panes[l.focus] = target
  return normalize(panes, l.focus, l.weights)
}

export type OpenBesideResult = { layout: PaneLayout; outcome: 'opened' | 'focused' | 'replaced-home' | 'full' }

/**
 * Open `sessionId` in a new pane beside pane `at` (`side` of it), and focus it.
 *   - already in a pane → that pane is focused ('focused'), nothing opens twice;
 *   - the layout is a lone Home pane → it is replaced ('replaced-home'): there is nothing to sit beside;
 *   - `max` panes already → unchanged ('full'): the caller offers its own window instead.
 */
export function openBeside(l: PaneLayout, sessionId: string, side: 'left' | 'right', at: number = l.focus, max: number = MAX_PANES): OpenBesideResult {
  const existing = l.panes.indexOf(sessionId)
  if (existing >= 0) return { layout: { ...l, focus: existing }, outcome: 'focused' }
  if (l.panes.length === 1 && l.panes[0] === null) return { layout: single(sessionId), outcome: 'replaced-home' }
  if (l.panes.length >= Math.min(MAX_PANES, Math.max(1, max))) return { layout: l, outcome: 'full' }
  const anchor = Math.max(0, Math.min(at, l.panes.length - 1))
  const index = side === 'left' ? anchor : anchor + 1
  // A Home pane that is being left behind drops out (only the focused pane may be Home).
  const panes = l.panes.slice()
  panes.splice(index, 0, sessionId)
  // The new pane gets an average share; the others keep their proportions to each other.
  let weights: number[] | undefined
  if (l.weights) {
    const w = paneWeights(l)
    weights = w.slice()
    weights.splice(index, 0, w.reduce((a, b) => a + b, 0) / w.length)
  }
  return { layout: normalize(panes, index, weights), outcome: 'opened' }
}

/** Close pane `index`. Focus goes to its left neighbour (or the new first pane). The last pane never
 *  closes: it becomes Home. */
export function closePane(l: PaneLayout, index: number): PaneLayout {
  if (index < 0 || index >= l.panes.length) return l
  if (l.panes.length === 1) return single(null)
  const panes = l.panes.slice()
  panes.splice(index, 1)
  const weights = l.weights ? paneWeights(l).filter((_, i) => i !== index) : undefined
  let focus = l.focus
  if (index < focus) focus -= 1
  else if (index === focus) focus = Math.max(0, index - 1)
  return normalize(panes, focus, weights)
}

export function focusPane(l: PaneLayout, index: number): PaneLayout {
  if (index < 0 || index >= l.panes.length || index === l.focus) return l
  return { ...l, focus: index }
}

// ── Resizing: the dividers between panes ───────────────────────────────────────────────────────

/**
 * Move the boundary between pane `index` and pane `index + 1` by `dx` CSS px, given the panes'
 * rendered widths. Only those two change, and their sum does not: the boundary moves, nothing else
 * does. Each keeps `minPx`. Returns the new widths; an out-of-range index returns them unchanged.
 */
export function moveBoundary(widths: readonly number[], index: number, dx: number, minPx: number = PANE_MIN_WIDTH): number[] {
  const out = widths.slice()
  if (index < 0 || index >= widths.length - 1 || !Number.isFinite(dx)) return out
  const a = widths[index]
  const b = widths[index + 1]
  const pair = a + b
  // When the pair is already narrower than two minimums (a window shrunk after splitting), the
  // boundary cannot honour both: it stays where it is rather than squeezing one further.
  if (pair < 2 * minPx) return out
  const na = Math.max(minPx, Math.min(pair - minPx, a + dx))
  out[index] = na
  out[index + 1] = pair - na
  return out
}

/** The layout with weights taken from rendered widths (after a divider drag). */
export function withWidths(l: PaneLayout, widths: readonly number[]): PaneLayout {
  if (widths.length !== l.panes.length) return l
  const weights = canonicalWeights(widths.slice(), l.panes.length)
  const next: PaneLayout = { panes: l.panes, focus: l.focus }
  return weights ? { ...next, weights } : next
}

/** Equal shares again (a double-click on a divider). */
export function evenWidths(l: PaneLayout): PaneLayout {
  return l.weights ? { panes: l.panes, focus: l.focus } : l
}

/** Take a session off screen (forgotten, or popped out into its own window): its pane closes, unless
 *  it is the only pane, which the caller handles (Home, a fallback, or the pop-out placeholder). */
export function removeSession(l: PaneLayout, sessionId: string): PaneLayout {
  const at = l.panes.indexOf(sessionId)
  if (at < 0 || l.panes.length === 1) return l
  return closePane(l, at)
}

export function serializeLayout(l: PaneLayout): string {
  const weights = canonicalWeights(l.weights, l.panes.length)
  return JSON.stringify(weights ? { panes: l.panes, focus: l.focus, weights } : { panes: l.panes, focus: l.focus })
}

/**
 * Read a saved layout, or null when there is nothing usable (the caller falls back to the old
 * single-session restore). Sessions `known` does not accept are dropped (forgotten since); so are
 * duplicates, non-strings, extra panes past MAX_PANES, and Home anywhere but the focused pane.
 */
export function parseLayout(raw: string | null | undefined, known?: (id: string) => boolean): PaneLayout | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { panes?: unknown; focus?: unknown; weights?: unknown }
  if (!Array.isArray(o.panes)) return null
  const focus = typeof o.focus === 'number' && Number.isInteger(o.focus) ? o.focus : 0
  // Weights are only trusted whole: one per saved pane, all finite and positive. Anything else is
  // dropped and the panes come back equal, rather than half-sized by a garbled number.
  const rawW = Array.isArray(o.weights) && o.weights.length === o.panes.length && o.weights.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) ? (o.weights as number[]) : null
  const kept: PaneTarget[] = []
  const keptW: number[] = []
  let f = 0
  o.panes.forEach((p, i) => {
    const ok = p === null || (typeof p === 'string' && p.length > 0 && (!known || known(p)))
    if (!ok) return
    if (i === focus) f = kept.length
    kept.push(p as PaneTarget)
    keptW.push(rawW ? rawW[i] : 1)
  })
  const sessions = kept.filter((p) => p !== null)
  if (sessions.length === 0) return null
  const capped = kept.slice(0, MAX_PANES)
  const l = normalize(capped, Math.min(f, capped.length - 1), rawW ? keptW.slice(0, MAX_PANES) : undefined)
  return visibleSessions(l).length > 0 ? l : null
}
