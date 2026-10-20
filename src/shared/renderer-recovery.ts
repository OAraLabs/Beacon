// What main does when the MAIN window's renderer process dies.
//
// WHY THIS IS A MAIN-PROCESS CONCERN AT ALL. PR #172 added ErrorBoundaries, and they are the right
// answer for a React throw — but a boundary lives INSIDE the renderer. When the renderer PROCESS
// ends (OOM, a GPU fault, `forcefullyCrashRenderer`, the kernel's OOM killer picking Beacon) React
// is gone with it, so there is no boundary left to catch anything and no DOM left to render a
// fallback into. The window survives as a shell showing whatever was painted last, frozen; the tray
// keeps reporting the connection as alive; and the only exits are Alt+F4 and the tray menu. That is
// the second half of the blank-window defect #172 opened, and it cannot be fixed from the renderer.
//
// WHY A CRASH LOOP IS THE HARD PART. Reloading is one line, and reloading forever is the obvious
// mistake: a renderer that dies DETERMINISTICALLY — an OOM while rendering one huge conversation, a
// frame the bundle cannot parse — will crash again on the same content after every reload. The user
// then sees the app flicker and relaunch forever, burning CPU, with no message explaining any of it.
// A reload that cannot stop is not a recovery; it is a way of making the crash continuous.
//
// So the policy is: reload while crashes are RARE, and stop once they are FREQUENT — frequency
// being the only signal available, since main cannot tell a transient fault from a deterministic one
// and must not pretend to. When it stops, it has to say so out loud, because "the app stopped
// reloading itself" is otherwise indistinguishable from "the app hung".
//
// PURE ON PURPOSE. No Electron, no fs, no clock: main supplies the timestamp and the quitting flag,
// and calls this to get a decision. That is what makes it provable headless (scripts/recovery-smoke)
// instead of only observable by crashing a real app — the repo's standing convention, and the reason
// the policy's threshold can be asserted rather than trusted.

/** Electron's own vocabulary for why a renderer ended. `clean-exit` is not a crash. */
export type RendererGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | string

/** How many crashes within the window before reloading stops. */
export const CRASH_LOOP_THRESHOLD = 3

/** The window crashes are counted over. 60s: long enough to span three quick relaunches, short
 *  enough that a crash today does not disarm recovery next week. */
export const CRASH_LOOP_WINDOW_MS = 60_000

/**
 * The decision.
 *
 * `reload`   — recover: reload the window and carry on.
 * `stop`     — a crash loop: do NOT reload again; the caller must say so to the user.
 * `ignore`   — nothing to do: the app is quitting, or the renderer exited cleanly.
 */
export type CrashDecision =
  | { kind: 'reload'; crashesInWindow: number }
  | { kind: 'stop'; crashesInWindow: number; reason: RendererGoneReason }
  | { kind: 'ignore'; why: 'quitting' | 'clean-exit' | 'not-the-main-window' }

/**
 * Decide what to do about a renderer that just ended.
 *
 * `crashTimes` is the caller's log of crash timestamps, OLDEST LAST, including the one that just
 * happened — main owns the array so this stays pure. Passing the crash in rather than mutating here
 * is what lets the smoke drive a sequence deterministically instead of sleeping to manufacture one.
 */
export function crashDecision(input: {
  reason: RendererGoneReason
  isQuitting: boolean
  /** Timestamps of crashes in this app run, oldest last, INCLUDING the current one. */
  crashTimes: readonly number[]
  now: number
  /** Whether this window is the main one. The pop-outs are separate windows with their own lives;
   *  a policy for the shell must not start reloading satellites it does not own. */
  isMainWindow: boolean
}): CrashDecision {
  const { reason, isQuitting, crashTimes, now, isMainWindow } = input

  // Order matters: quitting first, so the last thing a closing app does is not a reload. A renderer
  // can end BECAUSE the app is tearing down, and reloading then would fight app.quit() — the window
  // comes back as the app closes, which is how a quit turns into a relaunch.
  if (isQuitting) return { kind: 'ignore', why: 'quitting' }
  if (!isMainWindow) return { kind: 'ignore', why: 'not-the-main-window' }
  // `clean-exit` is not a crash: it is a deliberate end with no failure behind it, and reloading
  // would resurrect a renderer that was meant to go. Nothing else in Electron's list means that.
  if (reason === 'clean-exit') return { kind: 'ignore', why: 'clean-exit' }

  const recent = crashTimes.filter((t) => now - t <= CRASH_LOOP_WINDOW_MS && t <= now).length
  if (recent >= CRASH_LOOP_THRESHOLD) {
    return { kind: 'stop', crashesInWindow: recent, reason }
  }
  return { kind: 'reload', crashesInWindow: recent }
}

/**
 * Prune a crash log to the window. Called before appending, so the array is bounded by the window
 * rather than growing for the life of the process.
 *
 * Without this a long-running app that crashed three times in a year would eventually look like a
 * crash loop on its fourth, because the count would never have dropped. The window is what makes
 * "frequent" mean frequent.
 */
export function pruneCrashTimes(times: readonly number[], now: number): number[] {
  return times.filter((t) => now - t <= CRASH_LOOP_WINDOW_MS && t <= now)
}

/**
 * The words shown when reloading has stopped.
 *
 * It must name three things or it is not actionable: that the app STOPPED trying (otherwise a dead
 * window and a paused one look the same), how often it crashed (the evidence, so the report is not
 * "it broke"), and that quitting is the way out — because at this point the window cannot render the
 * ErrorBoundary that would otherwise offer a reload, so the dialog is the only surface left.
 *
 * SPLIT FOR macOS, measured: an Electron message box on macOS does NOT render `title` at all. It
 * shows `message` as the large bold headline and `detail` as the small text below. With the whole
 * explanation in `message`, the macOS alert was two paragraphs of bold text opening "Its window
 * crashed…" with no title for "Its" to refer to. So `message` is one short, self-contained sentence
 * that stands alone as the headline, and the explanation is `body`, which the caller renders as the
 * detail. Linux and Windows still show `title` in the window's bar.
 *
 * The copy promises only what is true: conversations are on the daemon and in the local cache;
 * unsent text is not guaranteed (the new-chat box is not saved, and a dead renderer takes the
 * in-memory draft tier with it).
 */
export function crashLoopNotice(
  reason: RendererGoneReason,
  crashes: number
): { title: string; message: string; body: string } {
  return {
    title: 'Beacon stopped recovering',
    message: `Beacon's window crashed ${crashes} times in the last minute (${reason}), so it stopped reloading.`,
    body:
      `Reloading the same content would crash the same way. Your conversations are kept on the daemon ` +
      `and in the local cache, so reopening does not lose them; text you had not sent yet may not have ` +
      `been saved.\n\nQuit and reopen Beacon to try again. If it keeps happening, the last ` +
      `conversation you had open is the likely cause.`
  }
}

/**
 * One durable line per crash, for the record.
 *
 * Bounded by the caller to the last CRASH_RECORD_MAX entries. Written to a userData JSON file
 * rather than a cache table: the cache is disposable and rebuilt from the daemon, so a crash record
 * there would be lost exactly when it was most worth keeping (a cache reset after a bad crash), and
 * neither existing table fits — socket_events describes the connection, watchdog_events describes
 * reply stalls, and ui_events is dev-gated and dropped from packaged builds entirely.
 */
export interface CrashRecord {
  /** epoch ms */
  at: number
  reason: RendererGoneReason
  /** Electron's exitCode/exitStatus, kept raw: a guess at meaning here would be a fabrication. */
  exitCode?: number
  appVersion: string
}

export const CRASH_RECORD_MAX = 50

/** Newest-first, capped. Pure so the bound is assertable without touching a filesystem. */
export function appendCrashRecord(existing: readonly CrashRecord[], next: CrashRecord): CrashRecord[] {
  return [next, ...existing].slice(0, CRASH_RECORD_MAX)
}
