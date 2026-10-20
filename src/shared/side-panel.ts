// The dock — the chat view's right-hand companion region (design handoff 2026-09-03, R3): there
// is exactly ONE dock slot on the right of the thread, and ONE control group that fills it. Pure
// (no React, no Electron) so the renderer and the headless smoke share one model.
//
// WHY A DOCK. The inspector, the browser and the terminal are companions to a conversation, not
// destinations that replace it: the browser's Send-to-chat puts a draft in the composer, which is
// pointless if opening the browser hid the composer. So all three live HERE — beside the chat.
// They are opened from the thread header's dock group (adjacent to the pane they open), from the
// composer icon row (browser, terminal), from the palette, and by ⌘1 / ⌘2 / ⌘3; Esc closes. They
// must NOT be reachable from the navigation rail — a trigger at the far-left edge that opens a
// pane at the far-right edge is the defect R3 replaces.
//
// ONE pane at a time. At these window widths a three-way split (sidebar | chat | browser |
// terminal) is unusable, so the dock hosts one pane and the header group picks which. Switching
// never reloads the browser page (its WebContentsView stays in main; the chrome just stops
// reporting a hole, which zeroes the view's rect) and never restarts the pty (the xterm detaches
// and re-attaches with replay — the shell in main does not notice).

export type PanelPane = 'inspector' | 'browser' | 'terminal' | 'progress'

export interface PanelPaneInfo {
  id: PanelPane
  label: string
  /** The toggle chord, as shown in titles and the shortcut sheet. */
  shortcut: string
  /** The pane's width when the user has not dragged it (R3: 300 inspector, 392 browser/terminal). */
  defaultWidth: number
  /** The narrowest the divider will go for this pane. */
  minWidth: number
  /** R3: opening this pane collapses the session list (rail-only) so the thread keeps its width. */
  collapsesSessions: boolean
  /**
   * Which panes share this pane's remembered width.
   *
   * Browser and terminal are one spec width and always have been, so they share a group and a
   * settings row; the inspector keeps its own. This is DECLARED rather than derived from the id,
   * because the code that used to derive it was `pane === 'inspector' ? … : …` — a two-branch
   * guess that silently swept any NEW pane into the browser+terminal row. Dragging that pane's
   * divider would have resized the browser and the terminal and never itself: a control that
   * looks dead while quietly damaging its neighbours, with no compile error to catch it.
   */
  widthGroup: string
}

/** Display order of the dock group in the thread header; also the ⌘1/⌘2/⌘3 order. */
export const PANEL_PANES: readonly PanelPaneInfo[] = [
  { id: 'inspector', label: 'Run inspector', shortcut: '⌘1', defaultWidth: 300, minWidth: 260, collapsesSessions: false, widthGroup: 'inspector' },
  { id: 'browser', label: 'Browser', shortcut: '⌘2', defaultWidth: 392, minWidth: 320, collapsesSessions: true, widthGroup: 'shared' },
  { id: 'terminal', label: 'Terminal', shortcut: '⌘3', defaultWidth: 392, minWidth: 320, collapsesSessions: true, widthGroup: 'shared' },
  // APPENDED, never inserted: MainView dispatches ⌘n by POSITION into this array, so inserting
  // anywhere above would renumber every chord already in the user's fingers.
  //
  // collapsesSessions is TRUE, decided by measurement rather than by copying the inspector. With
  // it false, a 900px window put the conversation at 294px — under the 380 this module declares —
  // because the session list never yields and the panel's own minimum then wins. That is the
  // inspector's standing defect (see the handoff); inheriting it for symmetry would have been a
  // new instance of a known bug. `showSessions` collapses CONDITIONALLY, so a wide window still
  // keeps the list: the flag costs nothing until the room actually runs out.
  { id: 'progress', label: 'Progress', shortcut: '⌘4', defaultWidth: 320, minWidth: 280, collapsesSessions: true, widthGroup: 'progress' }
]

export function paneInfo(pane: PanelPane): PanelPaneInfo {
  return PANEL_PANES.find((p) => p.id === pane) ?? PANEL_PANES[1]
}

export function isPanelPane(v: unknown): v is PanelPane {
  return PANEL_PANES.some((p) => p.id === v)
}

export interface PanelState {
  open: boolean
  /** Which pane the dock shows (or would show, when closed). */
  pane: PanelPane
}

/** Collapsed by default; the browser is the first pane a fresh profile would see. */
export const DEFAULT_PANEL_STATE: PanelState = { open: false, pane: 'browser' }

/** The session list's DEFAULT width (a fresh profile, or a double-click on its divider). The user
 *  can drag it between SESSION_LIST_MIN_WIDTH and SESSION_LIST_MAX_WIDTH; see fitSessionListWidth. */
export const SESSION_LIST_WIDTH = 264
/** Narrowest the list goes: the badge, a few words of title, the time column, and the hover buttons. */
export const SESSION_LIST_MIN_WIDTH = 200
/** Widest: past this a list is a second document, not a list (and a widescreen gives it to the thread). */
export const SESSION_LIST_MAX_WIDTH = 520
/** Settings key for the dragged width (the DESIRED width; what renders is fitted to the window). */
export const SESSION_LIST_WIDTH_SETTING_KEY = 'sessions:width:v1'
/** The nav rail's width — always on screen, so it comes off the top of the room. */
export const RAIL_WIDTH = 60

/**
 * R3, derived not stored: whether the session list shows beside the thread.
 *
 * R3 says opening the browser or the terminal collapses the list "so the thread keeps its reading
 * width". That is the REASON, and the reason is what this encodes — not the gesture. When the
 * window is wide enough for the rail, the list, the dock AND a conversation at its minimum, there
 * is nothing to protect and taking the list away is pure loss: you lose your place in 182 sessions
 * to gain width the thread did not need. (The rule was written when the dock defaulted to 520px;
 * at the shipped 392 a 1360px window still leaves the conversation ~640px with the list up.)
 *
 * So: collapse only when keeping the list would actually squeeze the conversation below
 * CONVERSATION_MIN_WIDTH. `room` omitted means the caller cannot measure, and the conservative
 * answer — protect the thread — is the one R3 asks for.
 */
export function showSessions(view: string, state: PanelState, room?: { viewport: number; dock: number; list?: number; conversationMin?: number }): boolean {
  if (view !== 'chat') return false
  if (!state.open) return true
  if (!paneInfo(state.pane).collapsesSessions) return true
  if (!room || !Number.isFinite(room.viewport) || room.viewport <= 0) return false
  // The list's width is the user's now (it has a divider). Absent means the default, so a caller
  // that does not know it gets the old answer rather than a different one.
  const list = room.list !== undefined && Number.isFinite(room.list) && room.list > 0 ? room.list : SESSION_LIST_WIDTH
  const left = room.viewport - RAIL_WIDTH - list - room.dock - PANEL_DIVIDER_WIDTH
  // With split panes the conversation AREA needs every pane's minimum (@shared/split-panes).
  return left >= conversationMinOr(room.conversationMin)
}

/** The room the conversation area keeps: one conversation's minimum by default; with split panes the
 *  caller passes all of theirs (panesMinWidth). Never less than one conversation. */
function conversationMinOr(min: number | undefined): number {
  return min !== undefined && Number.isFinite(min) && min > CONVERSATION_MIN_WIDTH ? Math.round(min) : CONVERSATION_MIN_WIDTH
}

/**
 * Fit the session list's DESIRED width (what the user dragged to) to the window.
 *
 * Bounds, in order of precedence:
 *   1. never under SESSION_LIST_MIN_WIDTH: the list is useless narrower, and if the window is that
 *      small the list is not the thing to squeeze (the dock rule collapses it instead);
 *   2. never so wide that the conversation drops under CONVERSATION_MIN_WIDTH beside it (and beside
 *      the dock, when one is open: `dock` is its rendered width plus divider, 0 when closed);
 *   3. never over SESSION_LIST_MAX_WIDTH.
 * Like the dock, the desired width is kept when the window narrows, and given back when it grows.
 * `viewport` unknown (0, NaN) means no room limit, only the fixed bounds.
 */
export function fitSessionListWidth(desired: number, viewport: number, dock = 0, conversationMin?: number): number {
  const want = Number.isFinite(desired) && desired > 0 ? Math.round(desired) : SESSION_LIST_WIDTH
  let max = SESSION_LIST_MAX_WIDTH
  if (Number.isFinite(viewport) && viewport > 0) {
    const roomForList = Math.floor(viewport) - RAIL_WIDTH - Math.max(0, dock) - conversationMinOr(conversationMin)
    max = Math.min(max, roomForList)
  }
  return Math.max(SESSION_LIST_MIN_WIDTH, Math.min(max, want))
}

/**
 * The surfaces the dock may open BESIDE, rather than dragging you to the chat first.
 *
 * The dock started chat-only because its panes are companions to a conversation. Coding is the
 * other place that is plainly WORK: a shell next to a diff is the reason R3 exists at all, and
 * being thrown back to chat to get one is the same defect R3 names about the rail — a control in
 * one place that opens a pane somewhere you were not. Every other surface still routes to chat,
 * because there is nothing there to sit beside.
 */
export const DOCK_VIEWS: readonly string[] = ['chat', 'coding', 'loop-manager']
export function canDock(view: string): boolean {
  return DOCK_VIEWS.includes(view)
}

// ── Settings keys (the renderer-side KV; the analogue of window-state.ts) ────────────────────
export const PANEL_OPEN_KEY = 'panel:open:v1' // '1' | '0'
export const PANEL_PANE_KEY = 'panel:pane:v1' // PanelPane
export const PANEL_WIDTH_KEY = 'panel:width:v1' // integer CSS px, the user's DESIRED width (browser + terminal)

/**
 * The settings row a pane's width is remembered in — derived from its declared group, never from
 * its id. The shared group keeps the original unsuffixed key so existing profiles keep their
 * dragged browser/terminal width across this change.
 */
export function panelWidthKey(pane: PanelPane): string {
  const group = paneInfo(pane).widthGroup
  return group === 'shared' ? PANEL_WIDTH_KEY : `${PANEL_WIDTH_KEY}:${group}`
}

/**
 * The pane a ⌘n chord selects, or null when the key is not a chord for any registered pane.
 *
 * Derived from dock order, so a newly registered pane's chord is live the moment it is added and
 * an unregistered digit stays inert. The literal it replaces (`/^[1-3]$/`) had to be remembered
 * by hand, and forgetting it leaves the new pane's chord silently dead — no error, no test.
 */
export function paneForChord(key: string): PanelPane | null {
  if (!/^[0-9]$/.test(key)) return null
  const i = Number(key) - 1
  return i >= 0 && i < PANEL_PANES.length ? PANEL_PANES[i].id : null
}

/** Every pane that must move when THIS pane's divider is dragged. Always includes the pane itself. */
export function panesSharingWidth(pane: PanelPane): PanelPane[] {
  const group = paneInfo(pane).widthGroup
  return PANEL_PANES.filter((p) => p.widthGroup === group).map((p) => p.id)
}

/** One representative pane per width group — what a launch must hydrate, with no key spelled out. */
export function widthGroupRepresentatives(): PanelPane[] {
  const seen = new Set<string>()
  const reps: PanelPane[] = []
  for (const p of PANEL_PANES) {
    if (seen.has(p.widthGroup)) continue
    seen.add(p.widthGroup)
    reps.push(p.id)
  }
  return reps
}

/**
 * A toggle for one pane. Pressing the pane that is already showing CLOSES the panel; pressing
 * any pane otherwise opens the panel on that pane (a switch, when the other one was showing).
 *
 * "Showing" is the caller's word, not this function's: `open` persists as a property of the
 * chat view, and the app launches on Mission. A caller on any OTHER view must not route through
 * this toggle at all — it opens ({ open: true, pane }) and brings the chat view up — or a
 * persisted-open panel the user cannot see closes on the very press meant to reveal it. The
 * probe found that as "state did not survive a reload" before the rule was made explicit.
 */
export function togglePane(state: PanelState, pane: PanelPane): PanelState {
  if (state.open && state.pane === pane) return { open: false, pane }
  return { open: true, pane }
}

/** Persisted strings → state. Garbage-safe: anything unreadable falls back to the default. */
export function parsePanelState(openRaw: string | null | undefined, paneRaw: string | null | undefined): PanelState {
  return {
    open: openRaw === '1',
    pane: isPanelPane(paneRaw) ? paneRaw : DEFAULT_PANEL_STATE.pane
  }
}

// ── Width ────────────────────────────────────────────────────────────────────────────────────
// The user drags a divider; the DESIRED width is what persists. What renders is that width
// fitted to the room actually available, so a window that got narrower never squeezes the
// conversation below the width it needs, and a window that grows again gives the panel its
// desired width back without the user re-dragging.

/** The browser/terminal figures (the panes a fresh profile meets); per-pane values live in PANEL_PANES. */
export const PANEL_MIN_WIDTH = 320
export const PANEL_DEFAULT_WIDTH = 392
/** What the conversation (message list + composer) keeps beside an open panel. */
export const CONVERSATION_MIN_WIDTH = 380
/** The divider's footprint in the row (its grab area overlaps the neighbours; this is the line). */
export const PANEL_DIVIDER_WIDTH = 2

/** Persisted string → desired width, or null when unreadable (the caller uses the default). */
export function parsePanelWidth(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * Fit a desired width to the room shared by the conversation and the panel (CSS px). The panel
 * never goes under PANEL_MIN_WIDTH; it also never takes more than leaves the conversation its
 * minimum — unless the room is too small for both, in which case the panel's minimum wins (the
 * user opened it; the window is what is too small).
 */
export function fitPanelWidth(desired: number, room: number, pane: PanelPane = 'browser', conversationMin?: number): number {
  const { defaultWidth, minWidth } = paneInfo(pane)
  const want = Number.isFinite(desired) && desired > 0 ? Math.round(desired) : defaultWidth
  const max = Math.max(minWidth, Math.floor(room) - PANEL_DIVIDER_WIDTH - conversationMinOr(conversationMin))
  return Math.min(max, Math.max(minWidth, want))
}
