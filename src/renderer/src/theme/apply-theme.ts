import { coerceThemeChoice, THEMES, THEME_KEY, type Theme, type ThemeChoice } from '@shared/theme'
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
    await window.beacon?.settings.set(THEME_KEY, choice).catch(() => undefined)
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
  const raw = await window.beacon?.settings.get(THEME_KEY).catch(() => null)
  return applier.applyChoice(coerceThemeChoice(raw))
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
