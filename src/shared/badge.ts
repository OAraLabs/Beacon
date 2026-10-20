// The dock/taskbar badge: how many waiting things it shows, and when it shows none.
//
// WHY A BADGE IS DIFFERENT FROM THE TRAY LINE. The tray already carries "⚠ N approvals waiting" —
// but only inside a right-click menu, and the tray ICON never changes. With the window hidden (and
// Beacon hides to tray on close, deliberately, so the connection survives), a pending exec approval
// — the agent is STOPPED, on a ~300s clock, waiting for a human — is invisible unless you happen to
// hover or right-click the tray. The OS badge is the channel that reaches a person who is not looking
// at the app: it is on the dock icon and the taskbar button, where the eye already goes.
//
// WHAT IT COUNTS, and why not unread messages. Pending APPROVALS: the case where doing nothing has a
// consequence, because a task is blocked on you. Unread chat is not the same — a background task that
// finished is worth a notification, not a persistent badge that nags until you open it, and main has
// no unread watermark to draw from anyway (that lives in the renderer's session list). Counting the
// actionable thing keeps the badge honest: when it is non-zero, there is something you should do.
//
// PURE. No Electron, no app.setBadgeCount: that is @platform linux,darwin only (NOT Windows), needs a
// matching .desktop name on Linux, and needs notification permission on macOS — three platform caveats
// that belong in the CALLER, not in the decision of what number to show. So this module answers "what
// count", and main answers "how to set it on this OS". Keeping them apart is what lets the count be
// proven headless while the platform mess stays where it has to be handled anyway.

/** The count to show on the OS badge. */
export interface BadgeState {
  /** The number. 0 means "show no badge" — Electron clears the badge on 0, it does not show a zero. */
  count: number
}

/**
 * Derive the badge from the state main already has.
 *
 * A function rather than a field so the rule has one home: today the badge IS the pending-approval
 * count, but the moment it becomes "approvals + something else" the arithmetic lives here and every
 * caller agrees, instead of three places each computing a slightly different number.
 */
export function badgeCount(pendingApprovals: number): BadgeState {
  // Clamp and floor exactly like the APPROVALS_COUNT ipc handler does, so a NaN, a negative, or a
  // fractional value from the renderer cannot reach app.setBadgeCount. A badge showing "-1" or "NaN"
  // would be worse than no badge: it is the OS surface, outside the app's own validation.
  const n = typeof pendingApprovals === 'number' && Number.isFinite(pendingApprovals)
    ? Math.max(0, Math.floor(pendingApprovals))
    : 0
  return { count: n }
}

/**
 * Whether a badge should be showing at all.
 *
 * Separated from the count so the caller asks one question. Electron clears the badge when you pass
 * 0, so "count is 0" and "no badge" are the same act — but stating it here means the intent is
 * recorded once and the platform call cannot drift into showing a literal zero on some OS.
 */
export function hasBadge(state: BadgeState): boolean {
  return state.count > 0
}

/**
 * Cap the number the badge DISPLAYS, separately from the number it counts.
 *
 * Some OSes render a large badge badly (a three-digit number overflows the dock icon). Electron
 * passes the raw integer through, so the caller decides what to hand the OS. This returns the number
 * to display: the real count, or — above `max` — exactly `max`, which a dock renders as a full dot
 * rather than an overflowing numeral. The TRAY line still shows the true count; only the badge is
 * capped, because the badge is an attention signal, not a readout.
 *
 * 0 is never capped (it is "no badge"), and a count at or below max is shown exactly.
 */
export function displayedBadgeCount(state: BadgeState, max = 99): number {
  if (state.count <= 0) return 0
  return state.count > max ? max : state.count
}
