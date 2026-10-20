/**
 * Pure presence/notification/unread logic — NO Electron imports, so it loads under
 * ELECTRON_RUN_AS_NODE and is unit-testable headless. The Electron GUI (tray, Notification)
 * in index.ts is a thin shell that feeds events in and renders the results out.
 */
import type { ConnectionState } from '@shared/ipc'

// ── tray status ──────────────────────────────────────────────────────────────
export type TrayStatus = 'idle' | 'connecting' | 'connected' | 'thinking' | 'tool-running' | 'error'

export interface PresenceState {
  conn: ConnectionState
  streaming: boolean
  toolsOpen: number
  error: boolean
}

export const INITIAL_PRESENCE: PresenceState = { conn: 'idle', streaming: false, toolsOpen: 0, error: false }

export type PresenceEvent =
  | { type: 'conn'; state: ConnectionState }
  | { type: 'delta' }
  | { type: 'done' }
  | { type: 'tool_start' }
  | { type: 'tool_end' }
  | { type: 'error' }

/** Reduce one event into presence state. Pure. */
export function applyPresenceEvent(s: PresenceState, e: PresenceEvent): PresenceState {
  switch (e.type) {
    case 'conn': {
      // A successful connect clears a prior error; a failure sets it; transient states keep it.
      const error = e.state === 'connected' ? false : e.state === 'failed' ? true : s.error
      return { ...s, conn: e.state, error }
    }
    case 'delta':
      return { ...s, streaming: true }
    case 'done':
      return { ...s, streaming: false }
    case 'tool_start':
      return { ...s, toolsOpen: s.toolsOpen + 1 }
    case 'tool_end':
      return { ...s, toolsOpen: Math.max(0, s.toolsOpen - 1) }
    case 'error':
      return { ...s, error: true }
  }
}

/** Map presence state to the tray status. Pure. Priority: error > connecting > idle > activity. */
export function deriveTrayStatus(s: PresenceState): TrayStatus {
  if (s.error || s.conn === 'failed') return 'error'
  if (s.conn === 'connecting' || s.conn === 'reconnecting') return 'connecting'
  if (s.conn !== 'connected') return 'idle'
  if (s.toolsOpen > 0) return 'tool-running'
  if (s.streaming) return 'thinking'
  return 'connected'
}

export const TRAY_TOOLTIP: Record<TrayStatus, string> = {
  idle: 'Beacon — idle',
  connecting: 'Beacon — connecting…',
  connected: 'Beacon — connected',
  thinking: 'Beacon — thinking…',
  'tool-running': 'Beacon — running a tool…',
  error: 'Beacon — disconnected'
}

// ── notifications ────────────────────────────────────────────────────────────
export type NotifyKind = 'chat_done' | 'user_echo' | 'error'

export interface NotifyDecisionInput {
  kind: NotifyKind
  sessionId: string
  /** The MAIN window has focus. */
  windowFocused: boolean
  activeSessionId: string | null
  /** The session whose own window (a pop-out, @shared/session-windows) has focus, if any. */
  focusedPopout?: string | null
  /** Every session on screen in the main window (split panes, @shared/split-panes). */
  visibleSessionIds?: readonly string[]
}

/**
 * Should a native notification fire? Pure, so the table is unit-testable headless.
 *   - user echo (the user's own message) → NEVER.
 *   - connection error → always.
 *   - chat_done (an assistant reply finished) → when the window is unfocused OR the reply is
 *     for a session other than the one the user is looking at; never when the session's own
 *     pop-out window is the focused one.
 */
export function shouldNotify(i: NotifyDecisionInput): boolean {
  if (i.kind === 'user_echo') return false
  if (i.kind === 'error') return true
  // Popped out and focused: the user is reading this conversation in its own window.
  if (i.focusedPopout && i.focusedPopout === i.sessionId) return false
  // Main window focused and the session on screen in it, focused pane or not: you can see the reply.
  if (i.windowFocused && (i.sessionId === i.activeSessionId || (i.visibleSessionIds?.includes(i.sessionId) ?? false))) return false
  return true
}

// ── unread ───────────────────────────────────────────────────────────────────
/** A session is unread when its durable watermark (max rowid) is past what was last viewed. */
export function isUnread(sessionWatermark: number, lastViewedWatermark: number): boolean {
  return sessionWatermark > lastViewedWatermark
}

/** Gateway label from a session id (`telegram:123` → `telegram`). The /api/sessions endpoint
 * doesn't return a gateway field, so we derive it from the id prefix. */
export function gatewayOf(sessionId: string): string {
  const i = sessionId.indexOf(':')
  return i > 0 ? sessionId.slice(0, i) : 'unknown'
}
