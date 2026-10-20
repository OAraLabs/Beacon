// Launch at login — whether Beacon registers itself with the OS to start on login.
//
// WHY THIS EXISTS. For a hide-to-tray agent cockpit, "start with my OS" is the single most-requested
// setting in every comparable app (Slack, 1Password, the rest): the connection is up and the agent is
// reachable by the time you sit down, instead of only after you remember to launch Beacon. Electron
// exposes it as app.setLoginItemSettings — one call — but almost all of the real content is in WHEN
// that call is honest, which is this module.
//
// WHAT THIS DOES NOT DO: start hidden. Electron 44 has no `openAsHidden` (it was removed), so a
// login-launched Beacon shows its window. That is a deliberate scope line, not an oversight: the
// connection coming up is the point of the feature, and "launch at login but stay out of the way" is
// a separate decision needing its own signal (a start-hidden argv flag on Windows, `wasOpenedAtLogin`
// on macOS) plus a call about whether a login-launch should show the window at all. It can be layered
// on later without changing anything here.
//
// WHY IT DOES NOT REGISTER ITSELF ON LINUX. app.setLoginItemSettings is @platform darwin,win32 — on
// Linux it is a silent no-op. A toggle that silently does nothing is a dead control (the same class of
// lie the Linux window-buttons fix existed to remove), so the UI asks this model whether the platform
// can honour the switch and renders the reason when it cannot. Writing an XDG autostart .desktop entry
// by hand is its own feature, not a stub to fake here.
//
// WHY THE OS IS THE SOURCE OF TRUTH, NOT A SETTINGS ROW. The user can flip this outside Beacon —
// System Settings → General → Login Items on macOS, Task Manager → Startup on Windows. A cached copy
// in our own DB would drift and show the switch in the wrong position, which is worse than not showing
// it. So GET always reads live from the OS, and SET returns the OS's readback AFTER the write —
// what the OS actually kept, not what we asked for. Same contract as notifications.setPrefs returning
// the stored result.
//
// PURE. No Electron: the platform call and the packaged-app gate live in main, and this decides the
// rules (which platforms can honour it, what the OS's report means, what the UI may say). Same split
// as @shared/badge and @shared/tray-hint — the decision is provable headless.

/** A platform whose OS has no login-item API Electron can drive, so the switch cannot be honoured. */
export const UNSUPPORTED_PLATFORM_REASON = 'not available on Linux yet'
/** A dev/unpackaged build: setLoginItemSettings would register the raw electron binary as a startup
 *  item, not Beacon. The updater gates on the same condition (app.isPackaged) and reports 'disabled'. */
export const UNPACKAGED_REASON = 'packaged builds only'

export type LoginItemPlatform = 'darwin' | 'win32' | 'linux'

export interface LoginItemState {
  /** Can this switch be honoured at all? False when the platform has no login-item API OR the build
   *  is unpackaged. When false, `enabled` is meaningless and `reason` says why — the UI renders the
   *  switch disabled with that reason rather than a control that silently does nothing. */
  supported: boolean
  /** The OS's current answer: is Beacon registered to launch at login? Only meaningful when
   *  `supported`. Read live from the OS on every get, never cached. */
  enabled: boolean
  /** Why it is unavailable, when it is. null when supported. */
  reason: string | null
  /** macOS: the login item is registered but needs the user's approval in System Settings. Surfaced
   *  because it reads as "I turned it on and nothing happens" otherwise. */
  needsApproval: boolean
  /** Windows: the executable is registered but its run key is deactivated (e.g. disabled in Task
   *  Manager). Same "I turned it on and it didn't launch" trap as needsApproval, different platform. */
  deactivated: boolean
}

/** Which platforms Electron's login-item API can actually drive. darwin,win32 per the Electron 44
 *  type's @platform tag; Linux is a silent no-op, so it is explicitly NOT here. */
export function platformSupported(platform: LoginItemPlatform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * The reason the switch cannot be honoured, or null when it can.
 *
 * Platform first, then packaging: a Linux dev build says "not available on Linux yet" rather than
 * "packaged builds only", because the platform is the more fundamental reason and the one the user
 * can't fix by installing differently. One home for the wording so every surface says the same thing.
 */
export function unavailableReason(platform: LoginItemPlatform, packaged: boolean): string | null {
  if (!platformSupported(platform)) return UNSUPPORTED_PLATFORM_REASON
  if (!packaged) return UNPACKAGED_REASON
  return null
}

/**
 * Fold the OS's login-item report into what the UI shows.
 *
 * @param platform   the host platform. An unsupported one yields supported:false regardless of `os` —
 *                   we never trust a report from a platform whose API is a no-op.
 * @param packaged   app.isPackaged. A dev build yields supported:false too: registering the raw
 *                   electron binary as a startup item is wrong, and the updater gates identically.
 * @param os         the raw shape of app.getLoginItemSettings(), or null when main could not read it.
 *                   A null report on a SUPPORTED platform yields enabled:false rather than throwing:
 *                   an unreadable registration must not crash the settings dialog, and "off" is the
 *                   safe default (the user can turn it on).
 *
 * The win32 readback rule is the load-bearing part: `openAtLogin` on Windows is true only if the
 * registered executable AND its args match what we'd write, so it can read false while the app really
 * does launch. `executableWillLaunchAtLogin` ignores args and is the honest "will it launch" answer.
 * We therefore prefer executableWillLaunchAtLogin on win32, and fall back to openAtLogin only when
 * the former is absent (a malformed report). Getting this backwards would show the switch OFF for a
 * user who has it on — the drift this whole module exists to prevent.
 */
export function describeLoginItem(
  platform: LoginItemPlatform,
  packaged: boolean,
  os: {
    openAtLogin?: boolean
    executableWillLaunchAtLogin?: boolean
    status?: string
  } | null
): LoginItemState {
  const reason = unavailableReason(platform, packaged)
  if (reason !== null) {
    return { supported: false, enabled: false, reason, needsApproval: false, deactivated: false }
  }

  // A supported, packaged build with no readable report → off, not an error.
  const report = os ?? {}
  // macOS: Electron reports openAtLogin as `status == "enabled"` (browser_mac.mm, v44.4.1), so a
  // registration waiting on the user's approval reads openAtLogin:false. It IS registered, though:
  // the switch reads on (beside a note that says why it will not launch yet), and unticking it
  // unregisters. Reading it off would show an unchecked box under "On — approve…", and ticking that
  // box would only register again into the same state.
  const enabled =
    platform === 'win32'
      ? typeof report.executableWillLaunchAtLogin === 'boolean'
        ? report.executableWillLaunchAtLogin
        : report.openAtLogin === true
      : report.openAtLogin === true || report.status === 'requires-approval'

  return {
    supported: true,
    enabled,
    reason: null,
    // macOS `requires-approval` and the Windows deactivated-run-key are the two ways "on" silently
    // doesn't launch. Surface both so the UI can say why, instead of the user concluding it's broken.
    needsApproval: platform === 'darwin' && report.status === 'requires-approval',
    deactivated: platform === 'win32' && report.openAtLogin === true && enabled === false
  }
}

/** The one line under the "Launch at login" switch. Pure, so a smoke can hold it against the
 *  switch's own state: a note that says "On" beside an unchecked box is a contradiction a user
 *  cannot resolve. */
export function loginItemNote(st: LoginItemState): string {
  return !st.supported ? st.reason ?? 'unavailable'
    : st.needsApproval ? 'On — approve Beacon in System Settings → Login Items to finish.'
    : st.deactivated ? 'Registered but deactivated — re-enable it in Task Manager → Startup.'
    : 'Start Beacon when you sign in, so the connection is up before you sit down.'
}
