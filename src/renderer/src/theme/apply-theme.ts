import { coerceThemeChoice, THEMES, THEME_KEY, type Theme, type ThemeChoice } from '@shared/theme'
import { THEME_INSTANCE_KEY, skinForInstance, type FolderChange } from '@shared/theme-instance'
import { createThemeApplier } from '@shared/theme-applier'
import { syncTitlebarOverlay, syncWcoAttribute } from './window-chrome'

// Codex re-skin — DOM apply + persistence (renderer-only; no new IPC). Flipping `data-theme` on
// <html> swaps every Codex token, so the whole app re-skins at once. Persisted via b.settings.
//
// The choice → plate logic (and its ordering rules) lives in @shared/theme-applier so a smoke can
// drive it headless; this module wires it to the real document and window.beacon. <html> never
// carries data-theme="system" — the tokens have no such block, and putting one there would drop
// every var to the :root fallback and silently wear NOX.

/** Apply a theme PLATE to the document root, then repaint the OS window buttons to match.
 *
 *  The overlay sync lives HERE rather than in a caller because this is the one function every theme
 *  change passes through — boot (`loadAndApplyTheme`), the picker (`setThemeChoice`), and the OS-flip
 *  subscription all route via it. Putting it at either call site would leave the other one wearing
 *  the previous skin's buttons. */
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  syncWcoAttribute()
  syncTitlebarOverlay()
}

// Module state lives in the applier: per-renderer, which is right — each window (main, capture, HUD,
// popouts) runs its own copy and wears the same persisted choice.
const applier = createThemeApplier({
  wear: applyTheme,
  worn: () => (document.documentElement.getAttribute('data-theme') as Theme | null) ?? THEMES[0],
  isDark: () => window.beacon?.systemTheme.isDark() ?? Promise.resolve(true),
  onSystemChange: (cb) => window.beacon?.systemTheme.onChange(cb) ?? null,
  persist: async (choice) => {
    // Two places: this Prometheus's own (kept in its folder), and the skin last worn here, which is what a window paints before it
    // knows which Prometheus is open and what a Prometheus with none of its own starts on (@shared/theme-instance).
    await Promise.all([window.beacon?.settings.set(THEME_INSTANCE_KEY, choice), window.beacon?.settings.set(THEME_KEY, choice)].map((p) => p?.catch(() => undefined)))
  }
})

/** The choice this window last loaded/set — 'system' or a plate. null before load. The pickers read
 *  this to show SYSTEMA as worn; the DOM's data-theme only ever shows the resolved plate. */
export function currentThemeChoice(): ThemeChoice | null {
  return applier.currentChoice()
}

/** Read the persisted choice, apply it, return the PLATE actually worn. Defaults to NOX. Call once
 *  on app mount. An old-build-persisted garbage value coerces to the default plate, as before. */
export async function loadAndApplyTheme(): Promise<Theme> {
  // The open Prometheus's own skin, else the skin last worn (an existing Beacon's one skin, or a Prometheus with none yet).
  const [own, last] = await Promise.all([window.beacon?.settings.get(THEME_INSTANCE_KEY).catch(() => null), window.beacon?.settings.get(THEME_KEY).catch(() => null)])
  // Main settles a Prometheus's skin when its folder opens (instance-skin.ts), so its own is there to read; the skin last worn is
  // only the paint when no folder is open yet. The window never writes a skin for a Prometheus it did not pick on.
  const { choice } = skinForInstance(own, last == null ? null : coerceThemeChoice(last))
  return applier.applyChoice(choice)
}

/**
 * Another Prometheus's folder is open (main says so, with that one's skin and whether the OS is dark): wear its skin now, in the
 * same step as the remount, with no question to wait on, so the old Prometheus's skin is never painted over the new one. Main has
 * already kept a new Prometheus's starting skin as its own; a skin missing here (it cannot be) keeps the one showing.
 */
export function wearInstanceTheme(change: FolderChange): void {
  const { choice } = skinForInstance(change.theme, applier.currentChoice())
  void applier.applyChoice(choice, change.dark)
  // The skin last worn follows (a Beacon-wide setting, so it can land in no Prometheus's folder).
  void window.beacon?.settings.set(THEME_KEY, choice).catch(() => undefined)
}

/** Persist + apply a theme CHOICE (a plate, or 'system'). Resolves to the plate worn afterwards. */
export async function setThemeChoice(choice: ThemeChoice): Promise<Theme> {
  return applier.setThemeChoice(choice)
}

/** Persist + apply a fixed PLATE. Kept because it is the right call for every existing caller that
 *  picks a plate; 'system' goes through setThemeChoice. */
export async function setTheme(t: Theme): Promise<void> {
  await setThemeChoice(t)
}
