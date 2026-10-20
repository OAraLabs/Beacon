/**
 * Session windows: one conversation popped out of the main window into its own OS window, so it can
 * live on another monitor. Pure rules shared by main, the renderer, and a headless smoke.
 *
 * ONE PLACE AT A TIME (decided 2026-10-12). A session is either in the main window or in its own
 * window, never both: two composers on one session would fight over its draft, and each window keeps
 * its drafts in its own memory. Clicking a popped-out session in the sidebar brings its window to the
 * front instead of opening it a second time.
 */

/** The hash a session window loads on: `#session=<encoded id>`. */
export const SESSION_WINDOW_ROUTE_PREFIX = 'session='

/** Ids are opaque to Beacon (`beacon:…`, `telegram:123`, a bare harness id). Bounded so a hostile
 *  or corrupted value cannot become a giant file name or title. */
export const SESSION_ID_MAX = 256

/** How long main waits for a closing window to save its draft before closing it anyway. */
export const CLOSE_FLUSH_TIMEOUT_MS = 1500

export function isPlausibleSessionId(id: unknown): id is string {
  // No control characters: an id goes into a window title and a file name.
  return typeof id === 'string' && id.length > 0 && id.length <= SESSION_ID_MAX && !/[\u0000-\u001f\u007f]/.test(id)
}

export function sessionWindowRoute(sessionId: string): string {
  return `${SESSION_WINDOW_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
}

/**
 * The session a window's hash names, or null when the hash is not a session route (the main window,
 * the other pop-outs) or names nothing usable. Accepts the hash with or without its leading `#`.
 */
export function parseSessionWindowRoute(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string') return null
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h.startsWith(SESSION_WINDOW_ROUTE_PREFIX)) return null
  let id: string
  try {
    id = decodeURIComponent(h.slice(SESSION_WINDOW_ROUTE_PREFIX.length))
  } catch {
    return null
  }
  return isPlausibleSessionId(id) ? id : null
}

/**
 * A file name for one session window's remembered bounds. Readable where it can be, and always
 * unique: the readable part is lossy (`beacon:a/b` and `beacon_a_b` both read `beacon_a_b`), so a
 * hash of the whole id is appended. FNV-1a, 32-bit: this is a name, not a security boundary.
 */
export function sessionWindowStateName(sessionId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  return `${readable}-${h.toString(16).padStart(8, '0')}.json`
}

/** Where a "show me this session" request goes: its own window if it has one, else the main window. */
export function switchTarget(sessionId: string, popped: ReadonlySet<string> | readonly string[]): 'popout' | 'main' {
  const has = Array.isArray(popped) ? popped.includes(sessionId) : (popped as ReadonlySet<string>).has(sessionId)
  return has ? 'popout' : 'main'
}

/** The persisted list of open session windows (restored on the next launch). Garbage-safe. */
export function parseOpenSessionWindows(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const id of v) if (isPlausibleSessionId(id) && !out.includes(id)) out.push(id)
    return out
  } catch {
    return []
  }
}
