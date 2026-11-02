// The sidebar list of Prometheus (docs/MULTI-PROMETHEUS.md §5): hidden while there is one; with two or more, a row each (its name,
// a dot and the same state in words, which AI it's on, a note when it can't prove who it is), and the name of the one Beacon is on
// in the window title, the composer and the unreachable banner. What each row says is decided here, from INSTANCES_LIST.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import type { InstanceSummary } from './ipc'

export type RowDot = 'green' | 'amber' | 'grey' | 'red'

export interface InstanceRowView {
  id: string
  name: string
  dot: RowDot
  words: string
  ai: string | null
  /** "Can't prove who it is": an older Prometheus that answered without proving it. */
  note: string | null
  /** The one Beacon is on. */
  current: boolean
}

export const ADD_PROMETHEUS = 'Add a Prometheus…'
export const UNPROVED_NOTE = "Can't prove who it is (an older Prometheus)"

/** "3:12 pm". */
export function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

/** Each one's name: its name in Beacon, or its address when it has none; two with the same name are told apart by address. */
function names(list: InstanceSummary[]): Map<string, string> {
  const base = (i: InstanceSummary): string => i.label.trim() || i.host
  const count = new Map<string, number>()
  for (const i of list) count.set(base(i), (count.get(base(i)) ?? 0) + 1)
  return new Map(list.map((i) => [i.id, (count.get(base(i)) ?? 0) > 1 && base(i) !== i.host ? `${base(i)} (${i.host})` : base(i)]))
}

function state(i: InstanceSummary, clock: (ms: number) => string): { dot: RowDot; words: string } {
  switch (i.state) {
    case 'connected':
      return { dot: 'green', words: 'Connected' }
    case 'unknown':
      return i.active ? { dot: 'amber', words: 'Connecting…' } : { dot: 'grey', words: 'Checking…' }
    case 'unreachable':
      return { dot: 'grey', words: i.since !== null ? `Can't reach it since ${clock(i.since)}` : "Can't reach it" }
    case 'key-refused':
      return { dot: 'red', words: 'No longer accepts this Beacon' }
    case 'different':
      return { dot: 'red', words: 'A different Prometheus answered' }
    case 'no-proof':
      return { dot: 'red', words: 'No longer proves who it is' }
    case 'refused':
      return { dot: 'red', words: 'Not encrypted' }
  }
}

/** The rows, in name order (a switch never moves one), or null while there are fewer than two: the list is hidden. */
export function instanceRows(list: InstanceSummary[], clock: (ms: number) => string = shortTime): InstanceRowView[] | null {
  if (list.length < 2) return null
  const named = names(list)
  return list
    .map((i) => ({
      id: i.id,
      name: named.get(i.id) ?? i.host,
      ...state(i, clock),
      ai: i.ai,
      note: i.state === 'connected' && !i.proved ? UNPROVED_NOTE : null,
      current: i.active
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The name of the one Beacon is on, with two or more; null otherwise (nothing new on screen). */
export function activeName(list: InstanceSummary[]): string | null {
  if (list.length < 2) return null
  const on = list.find((i) => i.active)
  return on ? (names(list).get(on.id) ?? null) : null
}

export function windowTitle(list: InstanceSummary[]): string {
  const n = activeName(list)
  return n ? `${n} — Beacon` : 'Beacon'
}

export function composerPlaceholder(list: InstanceSummary[]): string {
  return `Message ${activeName(list) ?? 'Prometheus'}…`
}

/** The unreachable banner's first line; `host` is what it said before there were two. */
export function unreachableLine(list: InstanceSummary[], host: string): string {
  const n = activeName(list)
  return n ? `Can't reach ${n}.` : `Can't reach Prometheus at ${host}.`
}

// Red first: the switcher in the title bar is not built yet.
export function titleSwitches(_list: InstanceSummary[]): boolean {
  return false
}
export function switcherKey(_key: string, _at: number, _count: number): { focus: number } | 'close' | null {
  return null
}
