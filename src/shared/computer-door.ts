/**
 * The desktop door — starting a task and picking an app, as decisions (v1.1 PR 7, door routes).
 *
 * THE RULE THIS MODULE EXISTS FOR
 * -------------------------------
 * The daemon's door refuses in a small, stable vocabulary: `{error, detail}` plus, for
 * `needs_app`, the picker's own rows. `detail` is the daemon's sentence for a person — the
 * comment on `DoorRefused` says so, and Beacon must render it VERBATIM. Two surfaces computing
 * the same words is the exact defect the SPRINT-CONSENT work removed from the approval card
 * (`ipc.ts`: "Beacon never re-derives or re-words them"). So this module maps a refusal to what
 * the UI should DO, and only supplies words of its own where the daemon supplied none.
 *
 * The second rule is `text` vs `goal`. The daemon keeps them apart because `text_to_type` must
 * come from the caller and never from the chooser (`candidates.py`), and the design states it
 * plainly: "the ONLY text that may be typed; never extracted from goal". A UI that parsed a goal
 * like "type hello in the editor" into text="hello" would put words on the keyboard that nobody
 * approved — and the approval prompt would not have shown them, since it shows `arguments`, not
 * the goal. `computerTaskStartBody` therefore never derives one from the other, and a test
 * asserts the goal string does not appear in the text it sends.
 *
 * Pure: no fetch, no Electron, no React. The smoke tests it without a window.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The refusal vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** Every `error` code the door can answer with, from `computer/door.py` and the two `_door_*`
 *  helpers in `web/server.py`. Kept as a literal list so a new server code shows up here as an
 *  unmapped case rather than as a blank line in the UI. */
export const DOOR_CODES = [
  'computer_use_off', // 404 — the daemon has no runner: the feature is off
  'not_a_person', //     401 — the global token, or a device nobody marked (D15/W3)
  'in_tool_call', //     403 — a model tried to start a task from inside a tool
  'integration_down', // 503 — the driver is not ready
  'busy', //             409 — a task is already running in this session
  'once_only', //        409 — a desktop prompt was answered with a lasting scope
  'needs_app' //         409 — no binding covers this; the person must pick, and the pick IS consent
] as const

export type DoorCode = (typeof DOOR_CODES)[number]

/** What the daemon sent back on a refusal. Only `error` is required of it; everything else is
 *  what `needs_app` carries for the picker. */
export interface DoorRefusalBody {
  error?: string
  detail?: string
  /** The apps to choose from, as the daemon resolved them — never a list Beacon made up. */
  options?: string[]
  /** The daemon's own sentence describing what the pick will cover. */
  describes?: string
  /** The app the daemon thinks was meant, when one matched. */
  app?: string
}

export type DoorOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: DoorRefusal }

export interface DoorRefusal {
  /** The daemon's code, or `http_<status>` / `network` when there was none. */
  code: string
  /** The sentence to show. The daemon's own `detail` when it sent one. */
  message: string
  /** True when the daemon's words are being shown, so the UI can mark them as the app's text. */
  fromDaemon: boolean
  /** Whether trying again without changing anything could help. Drives whether a Retry is offered:
   *  a `not_a_person` will fail identically forever, and offering Retry there is a control that
   *  cannot work — the same reason Beacon's login-item switch renders disabled with a reason
   *  rather than as a dead control. */
  retryable: boolean
  /** `needs_app` only: the rows for the picker. */
  options: string[]
  /** `needs_app` only: the daemon's sentence for what the pick covers. */
  describes: string
  /** `needs_app` only: the app the daemon matched, pre-selected when it is in `options`. */
  app: string | null
}

const RETRYABLE: ReadonlySet<string> = new Set(['integration_down', 'busy', 'network'])

/**
 * Read one door answer — a parsed body plus its status — into a refusal.
 *
 * `detail` wins whenever the daemon sent one, verbatim and untrimmed-but-collapsed. The local
 * words below are a FALLBACK for a body that named a code with no sentence, and for the codes this
 * client knows the daemon does not send a body for at all (`network`, and an HTTP status with no
 * JSON). An unknown code is shown as itself with `fromDaemon:false`, never as a blank.
 */
export function doorRefusal(status: number, body: unknown): DoorRefusal {
  const b = (body && typeof body === 'object' ? body : {}) as DoorRefusalBody
  const raw = typeof b.error === 'string' && b.error ? b.error : `http_${status}`
  const detail = typeof b.detail === 'string' ? b.detail.replace(/\s+/g, ' ').trim() : ''
  // ONE rule for "what are picker rows" — the same trim + de-dupe the /api/computer/apps list
  // goes through, so a refusal's options and an app list cannot render differently.
  const options = pickerRows(Array.isArray(b.options) ? b.options : [])
  const describes = typeof b.describes === 'string' ? b.describes : ''
  const app = typeof b.app === 'string' && b.app ? b.app.trim() : null

  return {
    code: raw,
    message: detail || LOCAL_WORDS[raw] || LOCAL_WORDS.__unknown,
    fromDaemon: detail.length > 0,
    retryable: RETRYABLE.has(raw),
    options,
    describes,
    // Only pre-select an app the daemon actually offered: selecting something outside the list
    // would look like a pick the person never saw.
    app: app !== null && options.includes(app) ? app : null
  }
}

const LOCAL_WORDS: Record<string, string> = {
  computer_use_off: 'Computer use is off on this daemon.',
  not_a_person: 'Only a person may start a desktop task. This device is not marked for computer use.',
  in_tool_call: 'A desktop task cannot be started from inside a tool call.',
  integration_down: 'The desktop driver is not ready.',
  busy: 'A desktop task is already running in this conversation.',
  once_only: 'A desktop prompt cannot be answered with a lasting scope.',
  needs_app: 'Pick the app first — the pick is the consent.',
  network: 'Beacon could not reach the daemon.',
  __unknown: 'The daemon refused, and did not say why.'
}

/** True when the refusal is the one that asks for a pick, so the UI shows the picker instead of
 *  only an error line. Split out because that branch is the door's consent step, not an error. */
export function isNeedsApp(r: DoorRefusal): boolean {
  return r.code === 'needs_app'
}

// ─────────────────────────────────────────────────────────────────────────────
// The binding (the app pick that IS the consent)
// ─────────────────────────────────────────────────────────────────────────────

/** What `GET/PUT /api/sessions/{id}/computer` returns: `Binding.as_dict()`, or `{state:'off'}`. */
export interface BindingWire {
  state?: string
  session_id?: string
  app?: string
  target?: string
  scope?: string
  describes?: string
  covers?: string[]
  set_by?: { surface?: string }
  expires_at?: number
}

export interface BindingView {
  on: boolean
  app: string | null
  /** The daemon's sentence for what the pick covers. Rendered verbatim when present. */
  describes: string | null
  /** What the binding covers, as the daemon lists it ('click', 'press_key:tab', …). */
  covers: string[]
  scope: string | null
  /** Epoch ms, or null. Beacon never computes an expiry from a timeout it holds locally — that
   *  arithmetic is the same two-surfaces defect as re-deriving extents. */
  expiresAt: number | null
  /** Where the pick was made ('beacon' | 'telegram' | …), when the daemon says. */
  surface: string | null
}

export const EMPTY_BINDING: BindingView = {
  on: false, app: null, describes: null, covers: [], scope: null, expiresAt: null, surface: null
}

/**
 * Coerce a binding payload to the view. Anything missing or wrong-typed degrades to the off state
 * rather than throwing: a `GET` that returns `{state:'off'}` is the normal case for a session
 * that has never had a task, and a malformed one must render as off, not crash the pane.
 *
 * `state` is the daemon's word and only `'on'` counts as on — the code path returns
 * `{state:'off', session_id}` explicitly when there is no binding.
 */
export function bindingFromWire(w: unknown): BindingView {
  const b = (w && typeof w === 'object' ? w : {}) as BindingWire
  const on = b.state === 'on'
  if (!on) return EMPTY_BINDING
  const expires = typeof b.expires_at === 'number' && Number.isFinite(b.expires_at)
    ? b.expires_at * 1000 // the daemon's expiry is epoch SECONDS
    : null
  return {
    on: true,
    app: typeof b.app === 'string' && b.app ? b.app : null,
    describes: typeof b.describes === 'string' && b.describes ? b.describes : null,
    covers: Array.isArray(b.covers) ? b.covers.filter((c) => typeof c === 'string') : [],
    scope: typeof b.scope === 'string' && b.scope ? b.scope : null,
    expiresAt: expires,
    surface: typeof b.set_by?.surface === 'string' && b.set_by.surface ? b.set_by.surface : null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The start form
// ─────────────────────────────────────────────────────────────────────────────

export interface StartForm {
  goal: string
  /** The ONLY text that may be typed. Optional; never derived from the goal. */
  text: string
  /** An app to bind as part of starting. Empty means "use the existing binding, or be asked". */
  app: string
}

export const EMPTY_START_FORM: StartForm = { goal: '', text: '', app: '' }

/** Collapses runs of whitespace and trims, the same normalisation the daemon applies to a goal. */
function norm(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Can this form be sent? Returns the reason it cannot, or null.
 *
 * The goal is the only required field: the daemon's route 400s without it, and a blank goal is a
 * task with nothing to aim at. `text` and `app` are optional by design — an empty app means the
 * existing binding is used or the door asks (the `needs_app` refusal), which is a conversation,
 * not a validation error.
 */
export function startFormError(f: StartForm): string | null {
  if (!norm(f.goal)) return 'Say what the task should do.'
  return null
}

/**
 * The POST body for `/api/computer/tasks`.
 *
 * Only the fields the daemon reads are sent, and ONLY when non-empty: an empty `text` or `app`
 * must not arrive as `""`, because the route distinguishes "absent" from "a string" (`if body.get(k)
 * is not None and not isinstance(...)`). Sending `app:""` would be a string the runner then tries
 * to resolve as an app name, instead of the absent-means-use-the-binding case.
 *
 * ⚠ THE TEXT IS NEVER TAKEN FROM THE GOAL. See the module header. Nothing here reads `f.goal`
 * except to put it in `goal`.
 */
export function computerTaskStartBody(f: StartForm, sessionId: string): Record<string, string> {
  const body: Record<string, string> = { session_id: sessionId, goal: norm(f.goal) }
  const text = norm(f.text)
  if (text) body.text = text
  const app = norm(f.app)
  if (app) body.app = app
  return body
}

/** The picker's rows, de-duplicated and in the daemon's order. A refusal's `options` and the
 *  `/api/computer/apps` list are the same kind of thing — app names the daemon resolved — and
 *  either can be the source, so one function serves both. */
export function pickerRows(apps: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of apps) {
    if (typeof a !== 'string') continue
    const t = a.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
