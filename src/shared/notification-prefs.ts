// Notification preferences — WHO is allowed to interrupt you, and when.
//
// WHY THIS EXISTS. Beacon notifies on every background-task completion, every finished reply, every
// lost connection, and every pending exec approval. On a sovereign agent that runs many things at
// once, the first three are frequent and the fourth is the one that MATTERS: an approval means the
// agent is STOPPED, on a ~300s clock, waiting for a human. A client that cries wolf on task
// completions gets muted at the OS level — and an OS-level mute kills the approval notification too,
// the exact one you cannot afford to miss. So the fix is not "notify less" globally; it is letting the
// user quiet the noisy kinds WITHOUT touching approvals. That needs per-kind control, which is this.
//
// THE TWO GATES, AND WHY THEY ARE SEPARATE. presence.ts already answers "given the window's focus and
// which session you're looking at, is this event even worth a notification?" (shouldNotify). This
// module answers a DIFFERENT question: "has the user asked for this KIND at all?" Both must pass — a
// reply that lands while you're focused on it fails the focus gate; a reply of a kind you've switched
// off fails this one. Folding them together would tangle a moment-to-moment focus computation with a
// durable stored preference, and the focus logic is already unit-tested on its own. Composition keeps
// each rule with one reason to change.
//
// PURE. No Electron, no settings I/O: main reads the stored row and the renderer writes it, but BOTH
// go through parse/serialize here so the on-disk shape has one definition and a corrupt row cannot
// reach Notification() as a half-built object. The same split as @shared/badge — the decision is
// provable headless, the platform call lives in the caller.

/** The settings-table key. App-global (NOT session-scoped), so it is deliberately absent from
 *  CacheRepo.SESSION_SETTING_PREFIXES — a forget or the startup prune must never clear it. */
export const NOTIFY_PREFS_KEY = 'notif:prefs'

/** The kinds a notification can belong to. One entry per channel the user can independently quiet.
 *  Exported as the single source of truth so main's gate sites, the settings UI, and the smoke all
 *  enumerate the SAME set — a new kind that forgets one of them fails the smoke, not silently. */
export const NOTIFY_PREF_KINDS = ['approval', 'reply', 'task', 'error'] as const
export type NotifyPrefKind = (typeof NOTIFY_PREF_KINDS)[number]

export interface NotifyPrefs {
  /** Master do-not-disturb. When true, NOTHING fires — not even approvals. It is the user reaching
   *  for silence explicitly, so it outranks the per-kind switches; the settings UI says so. */
  muted: boolean
  /** Exec approval pending — the agent is blocked on you. On by default and the one the UI flags as
   *  load-bearing; quieting it is allowed (it's your machine) but never implicit. */
  approval: boolean
  /** A chat reply finished for a session you're not looking at. */
  reply: boolean
  /** A background task completed or failed. The frequent, low-stakes one — the usual thing to mute. */
  task: boolean
  /** The connection to Prometheus was lost. */
  error: boolean
}

/** Everything on, nothing muted — i.e. today's behavior. The fallback for any unreadable row, so a
 *  corrupt preference can only ever restore the status quo, never silently mute you. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  muted: false,
  approval: true,
  reply: true,
  task: true,
  error: true
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Turn the stored row into prefs, defensively.
 *
 * Accepts null/undefined/empty (nothing stored yet → defaults), a JSON object (the normal case), and
 * anything hostile — malformed JSON, a non-object, an object missing fields, a field of the wrong
 * type — all of which fall back per-field rather than throwing. The direction of every fallback is
 * DEFAULT_NOTIFY_PREFS: a row we cannot trust must not be the thing that mutes approvals, so unknown
 * means "on", matching the behavior from before this feature existed.
 *
 * Per-field rather than all-or-nothing on purpose: a row written by an OLDER build (missing a kind
 * added later) still parses, defaulting only the field it lacks. That is what lets the kind set grow
 * without a migration.
 */
export function parseNotifyPrefs(raw: string | null | undefined): NotifyPrefs {
  if (raw === null || raw === undefined || raw === '') return { ...DEFAULT_NOTIFY_PREFS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_NOTIFY_PREFS }
  const o = parsed as Record<string, unknown>
  return {
    muted: boolOr(o.muted, DEFAULT_NOTIFY_PREFS.muted),
    approval: boolOr(o.approval, DEFAULT_NOTIFY_PREFS.approval),
    reply: boolOr(o.reply, DEFAULT_NOTIFY_PREFS.reply),
    task: boolOr(o.task, DEFAULT_NOTIFY_PREFS.task),
    error: boolOr(o.error, DEFAULT_NOTIFY_PREFS.error)
  }
}

/** The inverse of parse — what main and the renderer write to the settings row. Stable key order so
 *  two equal pref objects serialize byte-identical (a smoke can compare strings, and a diff is clean). */
export function serializeNotifyPrefs(prefs: NotifyPrefs): string {
  return JSON.stringify({
    muted: prefs.muted === true,
    approval: prefs.approval === true,
    reply: prefs.reply === true,
    task: prefs.task === true,
    error: prefs.error === true
  })
}

/**
 * May a notification of this kind fire, given the user's preferences?
 *
 * The mute check comes first and short-circuits: muted means silent, full stop, including approvals.
 * That is deliberate — a master mute the user has to second-guess ("does Do Not Disturb REALLY suppress
 * the blocked-agent alert?") is worse than one that means what it says. The settings UI is where we tell
 * them, not here by carving out a surprise exception.
 *
 * `prefs[kind]` is always a real boolean: the type requires every field, and the only ways to obtain a
 * NotifyPrefs are parseNotifyPrefs (which fills defaults) or a full literal. So there is no undefined
 * case to mis-default — which is exactly why notifyAllowed takes a NotifyPrefs and not a loose object.
 */
export function notifyAllowed(prefs: NotifyPrefs, kind: NotifyPrefKind): boolean {
  if (prefs.muted) return false
  return prefs[kind]
}
