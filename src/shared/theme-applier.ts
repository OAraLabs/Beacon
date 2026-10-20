// Theme CHOICE → worn PLATE, with the document and the bridge passed in.
//
// The logic apply-theme.ts used to hold directly, lifted out so a headless smoke can drive it with
// fake dependencies: the interesting behaviour is an ORDERING one (two picks, one of them waiting on
// an IPC round trip), which a pure function of its inputs can express and a DOM module cannot be
// tested for without a window. apply-theme.ts wires this to the real document and window.beacon.
//
// CHOICE vs PLATE (audit #6). What PERSISTS is a ThemeChoice: one of the nine plates, or 'system'.
// What RENDERS is always a plate — effectiveTheme() resolves 'system' against the OS appearance
// (main proxies nativeTheme; the sandboxed renderer cannot read it). Resolution happens here, once.

import { effectiveTheme, SYSTEM_CHOICE, type Theme, type ThemeChoice } from './theme'

export interface ThemeApplierDeps {
  /** Put a plate on the document (data-theme + the OS window buttons). */
  wear(t: Theme): void
  /** The plate the document wears right now. */
  worn(): Theme
  /** Whether the OS is dark. Only asked for SYSTEMA. A rejection degrades to dark (NOX), the app's
   *  reference default, never to an unexpected light skin. */
  isDark(): Promise<boolean>
  /** Subscribe to OS appearance flips. Returns the unsubscribe, or null when there is no bridge. */
  onSystemChange(cb: (dark: boolean) => void): (() => void) | null
  /** Persist the choice. Failures are the caller's to swallow. */
  persist(choice: ThemeChoice): Promise<void>
}

export interface ThemeApplier {
  /** Apply a choice to the document. Resolves to the plate worn afterwards — its own, or, when a
   *  newer pick superseded it during the OS question, the newer pick's. */
  applyChoice(choice: ThemeChoice): Promise<Theme>
  /** Apply, then persist, a choice. Resolves to the plate worn afterwards. A pick superseded while
   *  it waited on the OS persists nothing. */
  setThemeChoice(choice: ThemeChoice): Promise<Theme>
  /** The choice last applied — 'system' or a plate; null before the first. */
  currentChoice(): ThemeChoice | null
  /** Whether an OS-flip subscription is live (it should be exactly while 'system' is worn). */
  following(): boolean
}

export function createThemeApplier(deps: ThemeApplierDeps): ThemeApplier {
  let current: ThemeChoice | null = null
  let unsubSystem: (() => void) | null = null

  /** Resolves to the plate put on, or null when a newer pick landed during the await. */
  async function applyChoiceOrStale(choice: ThemeChoice): Promise<Theme | null> {
    current = choice
    const osDark = choice === SYSTEM_CHOICE ? await deps.isDark().catch(() => true) : true
    // A SYSTEMA pick waits on an IPC round trip; a plate pick does not. If another pick landed during
    // that wait, this call is STALE: wearing its plate would re-skin over the newer choice, and
    // subscribing would follow the OS for a choice no longer worn (PR 183 review).
    if (current !== choice) return null
    const eff = effectiveTheme(choice, osDark)
    deps.wear(eff)

    // Subscribe exactly while 'system' is worn: an OS flip re-resolves and re-applies. Unsubscribe
    // when a fixed plate is picked, so a later OS flip cannot repaint over an explicit user choice.
    if (choice === SYSTEM_CHOICE && !unsubSystem) {
      unsubSystem = deps.onSystemChange((dark) => {
        // Re-check the choice at fire time, not subscribe time: a fixed pick and an OS flip racing
        // must not let the stale subscription win — the explicit pick is the newer intent.
        if (current === SYSTEM_CHOICE) deps.wear(effectiveTheme(SYSTEM_CHOICE, dark))
      })
    } else if (choice !== SYSTEM_CHOICE && unsubSystem) {
      unsubSystem()
      unsubSystem = null
    }
    return eff
  }

  async function applyChoice(choice: ThemeChoice): Promise<Theme> {
    return (await applyChoiceOrStale(choice)) ?? deps.worn()
  }

  async function setThemeChoice(choice: ThemeChoice): Promise<Theme> {
    const eff = await applyChoiceOrStale(choice)
    // Superseded: persist nothing (the newer pick persists itself) and report what is actually worn,
    // so a picker reading the result back shows the truth.
    if (eff === null) return deps.worn()
    await deps.persist(choice)
    return eff
  }

  return { applyChoice, setThemeChoice, currentChoice: () => current, following: () => unsubSystem !== null }
}
