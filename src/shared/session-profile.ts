// Pure per-session profile model — shared by the picker and the headless smoke. No DOM.
//
// The daemon half (Prometheus #347) makes a profile a property of a CONVERSATION rather than of
// the daemon. This module exists mostly to keep one distinction visible on the way to the screen:
//
//   inherited — this session follows the daemon-wide active profile. If that changes, so does this.
//   chosen    — someone picked a profile for THIS conversation. It stays put when the global moves.
//
// They can name the same profile and still be different facts, which is why the endpoint returns
// `source` at all and why "Automatic" is a distinct menu entry rather than just re-picking the
// default. A picker that collapsed them would make "reset to automatic" unofferable — you cannot
// reset something you cannot tell apart from a default.
//
// This is the OPPOSITE choice from the model switcher, deliberately: modelSelectAction treats
// picking the default as clearing the override. For a model that is harmless; for a profile it
// would silently re-point a pinned conversation the next time the daemon default moved.

/** The menu entry that clears the binding. Not a profile name — no profile may be called this. */
export const AUTOMATIC = '__automatic__'

export interface SessionProfile {
  sessionId: string
  /** The name bound to this session, or null when it follows the global. */
  profile: string | null
  /** What a turn will actually run under. Null only when the daemon has no profile store. */
  effective: string | null
  source: 'session' | 'global'
  /** Bound to a profile that no longer exists — the turn silently falls back to the global. */
  dangling: boolean
}

export const UNKNOWN_PROFILE: SessionProfile = {
  sessionId: '',
  profile: null,
  effective: null,
  source: 'global',
  dangling: false
}

/** Defensive parse; a wrong-shape payload degrades to "follows the global" rather than throwing. */
export function parseSessionProfile(data: unknown): SessionProfile {
  if (!data || typeof data !== 'object') return UNKNOWN_PROFILE
  const d = data as Record<string, unknown>
  const src = d.source === 'session' ? 'session' : 'global'
  return {
    sessionId: typeof d.session_id === 'string' ? d.session_id : '',
    profile: typeof d.profile === 'string' && d.profile ? d.profile : null,
    effective: typeof d.effective === 'string' && d.effective ? d.effective : null,
    // A row claiming source:session with no profile name is incoherent; trust the name.
    source: src === 'session' && typeof d.profile === 'string' && d.profile ? 'session' : 'global',
    dangling: d.dangling === true
  }
}

/**
 * The PUT body for a selection. Blank clears — matching the daemon's own contract, where absence
 * is what means "follow the global".
 */
export function profileSelectBody(choice: string): { profile: string } {
  return { profile: choice === AUTOMATIC ? '' : choice }
}

/** Which menu row should read as current. Automatic is current exactly when nothing is bound. */
export function selectedChoice(sp: SessionProfile): string {
  return sp.source === 'session' && sp.profile ? sp.profile : AUTOMATIC
}

/**
 * The button label. Shows what a turn will RUN under, plus whether that is this conversation's
 * choice or the daemon's. A bare name would leave "coder because I picked it" and "coder because
 * everything is coder today" looking identical.
 */
export function profileLabel(sp: SessionProfile): string {
  if (!sp.effective) return 'profile'
  if (sp.dangling) return `${sp.profile} · missing`
  return sp.source === 'session' ? sp.effective : `${sp.effective} · auto`
}

/** One sentence for the control's tooltip — the whole state, in words. */
export function profileTooltip(sp: SessionProfile): string {
  if (!sp.effective) return 'The daemon has no profile store — profile selection unavailable.'
  if (sp.dangling)
    return `This chat is pinned to "${sp.profile}", which no longer exists — turns run under "${sp.effective}" instead.`
  if (sp.source === 'session')
    return `This chat is pinned to "${sp.effective}". It will not follow the daemon default if that changes.`
  return `This chat follows the daemon default ("${sp.effective}"). Pick a profile to pin it.`
}

/** Menu rows: Automatic first, then every profile the daemon reports, in its own order. */
/** One profile as the daemon describes it: a name, and its own words for what it grants. */
export interface ProfileChoice {
  id: string
  label: string
  /** The daemon's `description`, or the follows-line for Automatic. Absent when it sent none. */
  hint?: string
}

/**
 * Rows for the autonomy menu.
 *
 * The descriptions are the DAEMON's (`GET /api/profiles[].description`), not a fixed three-row
 * permission ladder written here. The match spec draws `Read only` / `Ask first` / `full · auto`
 * with prose for each, but those are a mockup of a model this daemon does not have — its profiles
 * are whatever the operator defined. Substituting three invented rows would replace the real
 * grant the user is choosing with a plausible-looking fiction, which is worse than a shorter list.
 * A profile the daemon described gets its description; one it did not gets its name alone.
 */
export function profileChoices(
  names: (string | { name: string; description?: string })[],
  globalName: string | null
): ProfileChoice[] {
  return [
    { id: AUTOMATIC, label: 'Automatic', hint: globalName ? `follows ${globalName}` : 'follows the daemon' },
    ...names.map((n) => (typeof n === 'string' ? { id: n, label: n } : { id: n.name, label: n.name, hint: n.description }))
  ]
}
