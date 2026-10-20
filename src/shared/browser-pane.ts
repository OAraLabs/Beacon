// The browser pane — a HUMAN viewer with a URL bar. Pure contract + helpers shared by main, the
// preload bridge, the renderer chrome and the headless smokes. No Electron/DOM imports here.
//
// THE INVARIANT. The user drives this browser. The agent must not be able to navigate it, click in
// it, read it autonomously, or inject script into it. Agent browsing is the daemon's own `browser`
// tool (Playwright), which is gated, audited and telemetried. Anything that routes model output into
// this view's navigation or execution is a gate bypass that would not look like a tool call — so
// nothing would catch it. browser-invariant-smoke.ts asserts, on the SOURCE, that no such wiring
// exists: every channel below is driven by a control in the pane's chrome and nothing else —
// with ONE amendment (2026-10-11, at the owner's request): a person's own click on a link to a
// local address in a chat message also drives it. That is the URL bar with the text supplied by the
// message, not a channel from the agent, and it is pinned by R9 (browser-invariant.ts) to a trusted
// plain click, a local http(s) address and a single call site. See pane-link.ts.

/** Session partition for the browsed pages. Deliberately NOT `persist:` — cookies and storage live
 * in memory and die with the app (login persistence is a later, deliberate decision). Distinct from
 * the app shell's default session, so a site can never see the shell's cookies or vice versa. */
export const BROWSER_PARTITION = 'browser-pane'

/** IPC channels. renderer → main unless marked. Each maps to ONE control in the pane chrome. */
export const BROWSER_IPC = {
  NAVIGATE: 'browser:navigate', // invoke: the URL bar's Enter
  BACK: 'browser:back',
  FORWARD: 'browser:forward',
  RELOAD: 'browser:reload',
  STOP: 'browser:stop',
  ZOOM: 'browser:zoom', // {dir: in|out|reset}
  FIND: 'browser:find', // find-in-page bar
  EXTRACT: 'browser:extract', // invoke: "Send to chat" — reads url/title/selection/text ONCE, on click
  BOUNDS: 'browser:bounds', // send: where the pane's placeholder sits (CSS px) or null when hidden
  STATE_GET: 'browser:state:get', // invoke: current state (mount)
  STATE: 'browser:state', // main → renderer: every state change
  DETACH: 'browser:detach', // pop the view out into its own window
  REATTACH: 'browser:reattach', // bring it back into the main window
  TAB_NEW: 'browser:tab:new',
  TAB_CLOSE: 'browser:tab:close',
  TAB_SELECT: 'browser:tab:select',
  TAB_MOVE: 'browser:tab:move',
  /** main → renderer: "the shell asked for the pane" — a keystroke inside the VIEW (⌘L, ⌘F, Esc)
   * forwarded to the chrome. Carries a key name only, never content. */
  CHROME_KEY: 'browser:chrome-key',
  /** main → the MAIN window only, from inside the extract handler: a Send-to-chat click made in
   * the pop-out lands in the composer it does not have. Text out of a page, never into one. */
  COMPOSE_INSERT: 'browser:compose-insert'
} as const

export type ZoomDirection = 'in' | 'out' | 'reset'

export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FindRequest {
  text: string
  forward?: boolean
  /** true → clear the highlights and close the search. */
  stop?: boolean
}

export type LoadErrorKind = 'dns' | 'refused' | 'cert' | 'offline' | 'timeout' | 'crash' | 'blocked' | 'other'

export interface BrowserLoadError {
  kind: LoadErrorKind
  /** Chromium net error code (negative), 0 for a renderer crash. */
  code: number
  /** Chromium's own token, e.g. ERR_NAME_NOT_RESOLVED — shown small, for the curious. */
  description: string
  url: string
  headline: string
  detail: string
}

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomPercent: number
  error: BrowserLoadError | null
}

export type NoticeKind = 'permission' | 'download' | 'popup' | 'navigation' | 'crash' | 'input'

/** Something the page asked for and did not get. Shown in the chrome, never silently dropped. */
export interface BrowserNotice {
  id: number
  kind: NoticeKind
  text: string
  at: number
}

export interface FindState {
  active: number
  total: number
}

export type BrowserHost = 'none' | 'main' | 'popout'

export interface BrowserState {
  tabs: BrowserTab[]
  activeTabId: string | null
  /** Which window currently holds the web contents. 'none' until the first navigation. */
  host: BrowserHost
  notices: BrowserNotice[]
  find: FindState | null
}

export const EMPTY_BROWSER_STATE: BrowserState = { tabs: [], activeTabId: null, host: 'none', notices: [], find: null }

export type NavigateResult = { ok: true; url: string } | { ok: false; reason: string }

export interface BrowserExtract {
  url: string
  title: string
  /** The user's selection, '' when nothing is selected. */
  selection: string
  /** The page's readable text (main/article when present, else body). */
  text: string
}

/** The preload's `browser` namespace. */
export interface BrowserBridge {
  navigate(input: string): Promise<NavigateResult>
  back(): void
  forward(): void
  reload(): void
  stop(): void
  zoom(dir: ZoomDirection): void
  find(req: FindRequest): void
  /** ONE read of the page, on the user's click. Resolves null when nothing is loaded. */
  extract(): Promise<BrowserExtract | null>
  /** Fire-and-forget geometry: the placeholder's rect in CSS px, or null while hidden/covered. */
  bounds(rect: ViewRect | null): void
  state(): Promise<BrowserState>
  onState(cb: (s: BrowserState) => void): () => void
  onChromeKey(cb: (key: ChromeKey) => void): () => void
  /** Pop the view out into its own window (bounds remembered) — no reload, history intact. */
  detach(): void
  /** Bring it back into the main window. Closing the pop-out does the same. */
  reattach(): void
  /** Main window only: a Send-to-chat block routed from the pop-out. */
  onComposeInsert(cb: (text: string) => void): () => void
  /** Tabs (Phase 4). A new tab is empty — the URL bar takes focus; the user types. */
  newTab(): void
  closeTab(id: string): void
  selectTab(id: string): void
  /** Reorder: move tab `id` to position `toIndex` (0-based, clamped). */
  moveTab(id: string, toIndex: number): void
}

export type ChromeKey = 'focus-url' | 'find' | 'escape' | 'new-tab' | 'close-tab'

// ── URL bar input ────────────────────────────────────────────────────────────

const HOSTISH = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?([/?#].*)?$/i

/**
 * Turn what the user typed into a URL, or refuse with a reason. Only http(s) opens here: there is
 * no search engine, no file:, no javascript: — a viewer with a URL bar, not a browser.
 */
export function normalizeUrlInput(raw: string): NavigateResult {
  const s = raw.trim()
  if (!s) return { ok: false, reason: 'Type a web address.' }
  // A scheme is `name:` NOT followed by a digit — `localhost:8005` and `10.0.0.1:3000` are host:port.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(s)
  if (scheme) {
    const proto = scheme[1].toLowerCase()
    if (proto !== 'http' && proto !== 'https') return { ok: false, reason: `Only http and https addresses open here (not ${proto}:).` }
    try {
      return { ok: true, url: new URL(s).href }
    } catch {
      return { ok: false, reason: 'That is not a valid web address.' }
    }
  }
  if (/\s/.test(s) || !HOSTISH.test(s)) {
    return { ok: false, reason: 'Enter a web address like example.com — there is no search engine here.' }
  }
  const local = /^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(s)
  try {
    return { ok: true, url: new URL(`${local ? 'http' : 'https'}://${s}`).href }
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' }
  }
}

/** The web-URL predicate, stated ONCE. Everything that decides whether a URL is
 * a page on the web derives from this, so the shell window, the browser pane and
 * the markdown renderer cannot drift into three different opinions.
 *
 * http(s) only. Deliberately NOT: `file:` (opens a local file — on Windows, with
 * an agent-chosen name in Downloads and no mark-of-the-web, that is the other
 * half of an execution primitive), `javascript:` (script in the opener's
 * context), `data:` (same), `beacon-artifact:` (the app's own privileged render
 * scheme), `chrome:`/`about:` (browser internals), and every custom app scheme a
 * registered handler would receive.
 *
 * Exported because the shell window's openExternal gate and the renderer's
 * urlTransform both need it, and a second copy of the regex is the next place
 * for it to be wrong. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Where a PAGE may take the view on its own (links, redirects, window.open).
 *  `about:blank` is a legal TARGET for a view — it is what a freshly opened tab
 *  is — but it is not a web URL, so it is added here rather than in isWebUrl:
 *  handing `about:blank` to the OS launcher would be meaningless at best. */
export function isAllowedNavigation(url: string): boolean {
  return isWebUrl(url) || url === 'about:blank'
}

/** A URL safe to hand to `shell.openExternal` — i.e. to the OPERATING SYSTEM.
 *
 * The distinction from isAllowedNavigation is the whole point: that one answers
 * "may a view show this", this one answers "may the OS open this". Only a real
 * web page qualifies. Returns the URL when allowed, or null when refused.
 *
 * WHY THIS EXISTS. The shell window passed every URL from a clicked link
 * straight to shell.openExternal with no check. react-markdown's default
 * urlTransform blanks schemes outside http/https/mailto/irc/xmpp, so an explicit
 * `file://` link was already dead — but a COLON-FREE href has no scheme for that
 * transform to reject, and in a packaged build the renderer is loaded with
 * loadFile, so `[the report](/Users/me/Downloads/report.bat)` resolved against
 * the `file://` base and the OS opened it. Artifact downloads land in Downloads
 * under an agent-chosen name with no extension policy, which supplies the other
 * half on Windows. It cannot reproduce under `npm run dev`, where the base is
 * http://localhost — which is why it survived.
 *
 * The repo already contained the allowlist this needed (the browser pane uses it
 * and a smoke asserts it refuses file:///x); the shell window simply never
 * imported it. The inconsistency was internal, not a design stance.
 */
export function safeExternalUrl(url: string): string | null {
  if (typeof url !== 'string' || !url) return null
  // Trim before testing: a leading newline or space is a known way to smuggle a
  // scheme past a ^-anchored regex in some parsers, and costs nothing to reject.
  const trimmed = url.trim()
  if (!trimmed) return null
  return isWebUrl(trimmed) ? trimmed : null
}

// ── Error page copy ──────────────────────────────────────────────────────────

/** Chromium net error → readable error page. null = not an error worth a page (ERR_ABORTED is what
 * a user's own Stop, or a navigation that superseded this one, looks like). */
export function describeLoadError(code: number, description: string, url: string): BrowserLoadError | null {
  if (code === -3) return null // ERR_ABORTED
  let host = url
  try {
    host = new URL(url).host || url
  } catch {
    /* keep the raw string */
  }
  const base = { code, description, url }
  if (code === -105 || code === -137) {
    return { ...base, kind: 'dns', headline: `${host} could not be found`, detail: 'The name did not resolve. Check the spelling, or whether the site is on a network you can reach from here (a Tailscale host needs Tailscale up).' }
  }
  if (code === -102) {
    return { ...base, kind: 'refused', headline: `${host} refused the connection`, detail: 'Something answered at that address but nothing is listening on that port.' }
  }
  if (code <= -200 && code > -300) {
    return { ...base, kind: 'cert', headline: `${host} has a certificate problem`, detail: `The site's certificate was rejected (${description}). This viewer does not offer a way to proceed past a bad certificate.` }
  }
  if (code === -106) {
    return { ...base, kind: 'offline', headline: 'You are offline', detail: 'No network connection was available to reach the site.' }
  }
  if (code === -7 || code === -118) {
    return { ...base, kind: 'timeout', headline: `${host} took too long to answer`, detail: 'The connection timed out before the page arrived.' }
  }
  if (code === -20 || code === -27 || code === -312) {
    return { ...base, kind: 'blocked', headline: 'That page was blocked', detail: code === -312 ? 'Chromium refuses that port as unsafe (it belongs to another protocol).' : `The request was refused (${description}).` }
  }
  return { ...base, kind: 'other', headline: `${host} could not be loaded`, detail: `${description} (${code})` }
}

export function crashError(url: string, reason: string): BrowserLoadError {
  return { kind: 'crash', code: 0, description: reason, url, headline: 'The page stopped responding', detail: `Its process ended (${reason}). Reload to try again.` }
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** CSS-px rect from the shell renderer → integer view bounds in the host window's DIP space,
 * clamped to the window's content area. The shell renderer may be zoomed (⌘+ is persisted), so a
 * CSS px is `zoomFactor` DIPs. */
export function viewBoundsFromRect(rect: ViewRect, zoomFactor: number, content: { width: number; height: number }): ViewRect | null {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const x = Math.max(0, Math.round(rect.x * z))
  const y = Math.max(0, Math.round(rect.y * z))
  const right = Math.min(content.width, Math.round((rect.x + rect.width) * z))
  const bottom = Math.min(content.height, Math.round((rect.y + rect.height) * z))
  const width = right - x
  const height = bottom - y
  if (width < 8 || height < 8) return null
  return { x, y, width, height }
}

export function zoomPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100)
}

export const ZOOM_MIN_LEVEL = -5
export const ZOOM_MAX_LEVEL = 5

export function nextZoomLevel(current: number, dir: ZoomDirection): number {
  if (dir === 'reset') return 0
  const next = dir === 'in' ? current + 1 : current - 1
  return Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, next))
}

// ── Send to chat ─────────────────────────────────────────────────────────────

/** Cap on what one click carries into the composer. Above this the text is cut and SAYS SO. */
export const EXTRACT_MAX_CHARS = 20_000

export function truncateExtract(text: string, max = EXTRACT_MAX_CHARS): { text: string; truncated: boolean } {
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (t.length <= max) return { text: t, truncated: false }
  return { text: `${t.slice(0, max)}\n\n[… truncated here: ${max.toLocaleString()} of ${t.length.toLocaleString()} characters shown]`, truncated: true }
}

/**
 * The message the user will see in the composer, and may edit or discard, before sending. The
 * page's words are untrusted content and are fenced as such: quoted, labelled by origin, never
 * presented as the user's own prose.
 */
export function composeSendToChat(ex: BrowserExtract, max = EXTRACT_MAX_CHARS): string {
  const useSelection = ex.selection.trim().length > 0
  const body = truncateExtract(useSelection ? ex.selection : ex.text, max)
  const title = ex.title.trim() || ex.url
  const label = useSelection ? 'Selected text' : 'Page text'
  return `From the browser: ${title}\n${ex.url}\n\n${label}:\n"""\n${body.text}\n"""`
}

/**
 * A block for the composer, delivered once. `n` increments per delivery so sending the same page
 * twice inserts twice — value equality would swallow the second (same shape as dictation).
 */
export interface ComposerInsert {
  text: string
  n: number
}

/** Put a browser block into a draft: on its own paragraph, never inside the user's sentence. */
export function appendComposerInsert(draft: string, text: string): string {
  const add = text.trim()
  if (!add) return draft
  const head = draft.replace(/\s+$/, '')
  return head ? `${head}\n\n${add}` : add
}

// ── Notices ──────────────────────────────────────────────────────────────────

export const MAX_NOTICES = 4

export function pushNotice(list: BrowserNotice[], n: BrowserNotice): BrowserNotice[] {
  return [...list, n].slice(-MAX_NOTICES)
}

export function permissionNoticeText(permission: string, origin: string): string {
  const what: Record<string, string> = {
    media: 'the camera or microphone',
    geolocation: 'your location',
    notifications: 'to show notifications',
    'display-capture': 'to capture your screen',
    midi: 'MIDI devices',
    midiSysex: 'MIDI devices',
    pointerLock: 'to lock the pointer',
    fullscreen: 'to go fullscreen',
    openExternal: 'to open another app',
    'clipboard-read': 'to read your clipboard'
  }
  return `${origin} asked for ${what[permission] ?? permission} — denied. This viewer grants no permissions.`
}
