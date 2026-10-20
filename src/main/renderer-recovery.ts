// Main-side half of renderer recovery: the durable record and the act of reloading.
//
// The POLICY — reload while crashes are rare, stop when they are frequent — is pure and lives in
// @shared/renderer-recovery, where it is provable headless. This file owns the two things that need
// Electron and a filesystem: writing the crash record, and actually reloading or telling the user
// recovery has stopped.
//
// WHY THE RECORD IS A FILE AND NOT A CACHE TABLE. The cache is disposable and rebuilt from the
// daemon, so a crash record stored there is lost exactly when it is most worth keeping — after a bad
// enough crash that someone clears the cache to rule it out. Neither existing table fits either:
// socket_events describes the connection, watchdog_events describes reply stalls, and ui_events is
// dev-gated and dropped from packaged builds entirely (so the one build where a crash record matters
// most is the one with no ui_events).
//
// WHY A NATIVE DIALOG IS THE ONLY OPTION AT `stop`. When recovery stops, the renderer is dead and
// will not be reloaded, so nothing in src/renderer can render — #172's ErrorBoundary included, since
// it lives inside the renderer that just ended. `dialog.showMessageBox` is drawn by the OS, not by
// Chromium, so it is the one surface that still works.
import { app, dialog } from 'electron'
import { crashRecordPath, recordCrash } from './crash-record'
import {
  CRASH_RECORD_MAX,
  crashDecision,
  crashLoopNotice,
  pruneCrashTimes,
  type RendererGoneReason
} from '@shared/renderer-recovery'

export interface RecoveryDeps {
  /** Reload the main window. Passed in so the probe can watch it happen and the smoke can count it. */
  reload: () => void
  /** Show the "recovery stopped" dialog. Passed in for the same reason. */
  notifyStopped: (notice: { title: string; message: string; body: string }, detail: string) => Promise<void>
  /** Whether the app is quitting — main owns that flag. */
  isQuitting: () => boolean
  /** userData dir, for the durable record. */
  dir: () => string
  appVersion: () => string
  now?: () => number
}

/**
 * Crash-recovery state for the main window: one instance per window creation.
 *
 * `crashTimes` is in memory (it describes THIS app run's frequency) while the record is durable (it
 * describes the app's history). They answer different questions and are deliberately not merged:
 * a crash loop three launches ago must not disarm recovery today.
 */
export function createRendererRecovery(deps: RecoveryDeps) {
  let crashTimes: number[] = []

  const now = deps.now ?? (() => Date.now())

  return {
    /**
     * Handle the main window's renderer ending.
     *
     * Returns the decision it took, so the caller (and the probe) can assert on the branch rather
     * than infer it from side effects.
     */
    async onRendererGone(input: {
      reason: RendererGoneReason
      exitCode?: number
      /** Only the MAIN window. A pop-out crashing is its own window's business, and a policy for the
       *  shell must not start reloading satellites it does not own. */
      isMainWindow: boolean
    }): Promise<ReturnType<typeof crashDecision>> {
      const at = now()
      const decision = crashDecision({
        reason: input.reason,
        isQuitting: deps.isQuitting(),
        // The current crash is counted for this decision, so it is appended BEFORE deciding — the
        // alternative (decide then append) makes the threshold off by one, so the third crash in a
        // minute would reload and the fourth would stop.
        crashTimes: pruneCrashTimes([...crashTimes, at], at),
        now: at,
        isMainWindow: input.isMainWindow
      })

      if (decision.kind === 'ignore') return decision

      // A crash is worth recording whether or not recovery continues — the record is what someone
      // reads later to answer "did this start after the update?".
      recordCrash(deps.dir(), {
        at,
        reason: input.reason,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        appVersion: deps.appVersion()
      })

      // The in-memory window log, for the NEXT decision. The current crash was already counted into
      // the copy handed to crashDecision above; this is the same append applied to the retained
      // array, so the two cannot disagree about how many crashes there have been.
      crashTimes = pruneCrashTimes([...crashTimes, at], at)

      if (decision.kind === 'reload') {
        deps.reload()
        return decision
      }

      // `stop`: do NOT reload, and say so through the one surface that still works. The detail line
      // carries the raw facts a report needs — reason, count, and that the record exists on disk —
      // because a dialog that says "it crashed" gives someone nothing to paste into an issue.
      const notice = crashLoopNotice(decision.reason, decision.crashesInWindow)
      await deps.notifyStopped(
        notice,
        `reason=${decision.reason} · ${decision.crashesInWindow} crashes in the last minute · ` +
          `the last ${CRASH_RECORD_MAX} are recorded in ${crashRecordPath(deps.dir())}`
      )
      return decision
    },

    /** Test/diagnostic accessor: crashes counted in the current window. */
    crashesInRun(): readonly number[] {
      return crashTimes
    }
  }
}

/**
 * The default dialog binding, so index.ts wires one call rather than a modal by hand.
 *
 * `quit` is injectable for exactly one reason: a probe has to be able to assert the dialog appeared
 * WITHOUT the app tearing down underneath it mid-assertion. Production passes `app.quit`.
 */
export function dialogNotifyStopped(
  notice: { title: string; message: string; body: string },
  detail: string,
  quit: () => void = () => app.quit()
): Promise<void> {
  return dialog
    .showMessageBox({
      type: 'error',
      title: notice.title,
      message: notice.message,
      // macOS renders `message` as the headline and `detail` as the small text, and drops `title`,
      // so the explanation rides in `detail` above the record line (see crashLoopNotice).
      detail: `${notice.body}\n\n${detail}`,
      // One button, and it quits. "Reload anyway" is offered deliberately NOT: the policy just
      // concluded that reloading crashes the same way, so the button would be a way to re-enter the
      // loop by hand — and a person who clicks it three times gets three more crashes and a dialog
      // each time. Quitting is the honest exit; reopening starts a fresh window with no history.
      buttons: ['Quit Beacon'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    .then(() => {
      quit()
    })
}
