// What changed the view, for the moment Settings opens. On a real Mac ⌘, from Chats left Mission Control behind the Settings sheet,
// and it couldn't be reproduced on a copy of that profile. Nothing in the renderer sets Mission Control except a fresh page (MainView
// keeps its view across remounts), so the line says how long the page has been up, each recent change of view (a mount is a fresh
// MainView) and the input just before it. Main appends it to <profile>/logs/view-trail.log (src/main/view-trail-log.ts).
//
// No Node/Electron imports (same rule as the rest of src/shared).

export interface ViewStep {
  at: number
  from: string | null
  to: string
  how: 'mount' | 'change'
  /** The last click or key before the change (inputLabel), or null when there was none. */
  input: string | null
  inputAgoMs: number | null
}

/** How many changes the line carries. */
export const VIEW_TRAIL_KEEP = 12
/** The log file is cut to its last whole lines within this many characters. */
export const VIEW_TRAIL_MAX_CHARS = 64 * 1024

export function pushStep(trail: ViewStep[], step: ViewStep): ViewStep[] {
  return [...trail, step].slice(-VIEW_TRAIL_KEEP)
}

export function trailLine(o: { at: number; opener: string; view: string; rendererUpMs: number; steps: ViewStep[] }): string {
  const steps = o.steps.map((s) => {
    const what = s.how === 'mount' ? `mount → ${s.to}` : `${s.from ?? '?'} → ${s.to}`
    const why = s.input ? ` after ${s.input} (${s.inputAgoMs ?? '?'} ms)` : ''
    return `${new Date(s.at).toISOString().slice(11, 23)} ${what}${why}`
  })
  return `${new Date(o.at).toISOString()} settings opened (${o.opener}) on ${o.view}; renderer up ${(o.rendererUpMs / 1000).toFixed(1)}s; views: ${steps.join(' | ') || 'none'}`.replace(/[\r\n]+/g, ' ')
}

type Input = { kind: 'key'; key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } | { kind: 'click'; label: string }

/** An input as the trail names it: a click by the control's label, a shortcut by its keys, typing never by what was typed. */
export function inputLabel(i: Input): string {
  if (i.kind === 'click') return `click ${i.label.replace(/\s+/g, ' ').trim().slice(0, 40) || '(unlabelled)'}`
  const mods = `${i.ctrl ? '⌃' : ''}${i.alt ? '⌥' : ''}${i.meta ? '⌘' : ''}`
  if (i.key.length === 1 && !i.meta && !i.ctrl && !i.alt) return 'key (typing)'
  return `key ${mods}${i.key}`
}

/** The end of a log, cut at a line boundary so it is at most `max` characters. */
export function keepTail(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = text.slice(text.length - max)
  const nl = tail.indexOf('\n')
  return nl < 0 ? '' : tail.slice(nl + 1)
}
