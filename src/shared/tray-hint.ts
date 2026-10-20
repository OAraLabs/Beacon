// Close-to-tray: what the ✕ button does, and teaching it the first time.
//
// WHY THIS EXISTS. Beacon hides to the tray on close rather than quitting — deliberate, so the
// daemon connection and the background-task stream survive while the window is gone. That is the
// RIGHT behavior for an agent cockpit, but today the first ✕ hides the app SILENTLY: no hint, no
// setting, nothing pointing at where it went. The first-time user reads it as "the app crashed /
// closed", hunts the dock, and either force-quits or assumes they lost their session. Every
// hide-to-tray app ships a first-run explanation for exactly this reason. This module is that
// explanation, plus the choice to make ✕ mean quit for people who hate tray apps.
//
// THREE DECISIONS, ONE PLACE. On a close event main needs to know: hide or actually quit? show the
// one-time coach? point at the tray? Those depend on (a) whether the app is already quitting, (b) the
// user's close-mode setting, and (c) whether we've taught them once already. Spelling the truth table
// here — pure, so a smoke can assert every cell — keeps main's handler to "do what planClose says"
// instead of re-deriving the conditions inline where a future change would miss one.
//
// PURE. No Electron, no settings I/O, no Notification. main owns the platform calls (preventDefault +
// hide, or app.quit; the tray-flash mechanism differs per OS; the coach is a native Notification).
// Same split as @shared/badge and @shared/notification-prefs: the decision is provable headless.

/** What the ✕ button means. A user setting, persisted app-globally; defaults to tray (today's behavior). */
export type CloseMode = 'tray' | 'quit'

/** The settings-table keys. App-global (NOT session-scoped) — absent from SESSION_SETTING_PREFIXES on
 *  purpose, so a forget or the startup prune never resets a window-behavior choice. */
export const CLOSE_MODE_KEY = 'window:close-mode'
export const TRAY_HINT_SHOWN_KEY = 'window:tray-hint-shown'

export interface CloseDecision {
  /** 'hide' = preventDefault the close and hide to tray (current behavior). 'quit' = let it close and
   *  bring the app down. Main acts on this; the model never touches a window. */
  action: 'hide' | 'quit'
  /** Show the one-time "Beacon moved to the tray" coach. True only the FIRST time a close actually
   *  hides — never on a real quit (teaching tray on the way out the door is noise). This is the ONE
   *  teaching signal: main raises the coach notification when it's true and stays silent thereafter,
   *  so the message fires once per install instead of on every close. */
  showHint: boolean
}

/**
 * Decide what a window close does.
 *
 * @param isQuitting   the app has already committed to quitting (tray Quit, ⌘Q, before-quit). When
 *                     true there is nothing to teach and nothing to hide — get out of the way.
 * @param closeToTray  the user's setting: ✕ hides (true) or ✕ quits (false).
 * @param hintShown    persisted: have we already shown the first-time coach?
 *
 * The order of the checks is the spec: quitting outranks the setting, the setting decides hide-vs-quit,
 * and the hint fires only on a hide that hasn't been taught yet.
 */
export function planClose(input: {
  isQuitting: boolean
  closeToTray: boolean
  hintShown: boolean
}): CloseDecision {
  // Already quitting (tray Quit / ⌘Q / before-quit): the window closing is part of the teardown, not a
  // user choice about the ✕ button. Nothing to hide, nothing to teach.
  if (input.isQuitting) return { action: 'quit', showHint: false }

  // ✕ means quit for this user. Respect it plainly — a tray-app apologist would still hide here, and
  // that is exactly the surprise this setting exists to remove.
  if (!input.closeToTray) return { action: 'quit', showHint: false }

  // ✕ hides to tray. Teach it the first time only.
  return { action: 'hide', showHint: !input.hintShown }
}

/**
 * The first-time coach copy. Returned only when CloseDecision.showHint is true; main raises it as a
 * native Notification (cheapest surface that reaches a user whose window just vanished, and main is
 * already the notification authority). Kept here so the wording has one home and a smoke can pin it —
 * the message's whole job is to be found, so "still running" + where + how to quit must all be present.
 */
export function trayHintNotification(): { title: string; body: string } {
  return {
    title: 'Beacon is still running',
    body: 'Closing the window hides Beacon to your tray — your connection and any running tasks stay live. Open it from the tray icon, or Quit from there to fully close.'
  }
}
