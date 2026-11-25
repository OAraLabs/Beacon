// The skin per Prometheus. What a person picks while on one Prometheus stays with that one; switching to another
// swaps to the skin last chosen there, at once. Two Prometheus may wear the same skin, and nothing assigns one.
//
// Stored locally, in the Prometheus's own folder (so keyed by its identity, not its address: the folder is the one
// bound to the instance's fingerprint, and a Prometheus that moves address keeps it):
//
//   THEME_INSTANCE_KEY  this Prometheus's skin (a plate or 'system'). Scope 'prometheus' (@shared/daemon-profiles).
//   THEME_KEY           the skin last worn here, whichever Prometheus: what a window paints before it knows which one is open,
//                       and what a Prometheus with no skin of its own yet starts on. Scope 'beacon', as it always was.
//
// A Prometheus with no skin of its own starts on whatever is showing, and keeps it from then on ("adopts" it). An
// existing Beacon's one skin was every Prometheus's, so it is written into each one once, at the first launch of
// this version (seedPlan), and a Prometheus added after that starts on what is showing instead.
//
// Pure: nothing here talks to a window or a database.

import { SYSTEM_CHOICE, THEMES, coerceThemeChoice, type ThemeChoice } from './theme'

export const THEME_INSTANCE_KEY = 'theme:instance:v1'
/** app.db marker: the one-time seeding below has been done. */
export const THEME_SEEDED_KEY = 'theme:instances-seeded'

/** Whether a stored value is a skin choice Beacon knows: a plate, or 'system'. Anything else is "no skin of its own". */
export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === SYSTEM_CHOICE || (typeof v === 'string' && (THEMES as readonly string[]).includes(v))
}

/** What main tells every window when another Prometheus's folder opens: that one's skin (null: it has none yet) and whether the OS is dark now (so SYSTEMA resolves without asking). */
export interface FolderChange {
  theme: string | null
  dark: boolean
}

export function parseFolderChange(v: unknown): FolderChange {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { theme: typeof o.theme === 'string' ? o.theme : null, dark: o.dark !== false }
}

/**
 * The skin a Prometheus opens on, from what it stored and what is showing. `adopt`: it had none of its own, so the one
 * showing becomes its own (the caller writes it). A skin it stored is never replaced by the one showing.
 */
export function skinForInstance(stored: unknown, showing: ThemeChoice | null): { choice: ThemeChoice; adopt: boolean } {
  if (isThemeChoice(stored)) return { choice: stored, adopt: false }
  return { choice: showing ?? coerceThemeChoice(null), adopt: true }
}

/** Which Prometheus get the Beacon-wide skin written as their own, once: those with none. Empty when it has been done. */
export function seedPlan(done: boolean, legacy: unknown, ids: readonly string[], has: (id: string) => boolean): { ids: string[]; value: ThemeChoice } {
  if (done) return { ids: [], value: coerceThemeChoice(legacy) }
  return { ids: ids.filter((id) => !has(id)), value: coerceThemeChoice(legacy) }
}
