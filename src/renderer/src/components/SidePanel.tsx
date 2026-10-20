import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { fitPanelWidth, paneInfo, type PanelPane } from '@shared/side-panel'
import type { ApprovalDecision } from '@shared/ipc'
import { PreviewPane } from './PreviewPane'
import { BrowserPane } from '../browser/BrowserPane'
import { TerminalPanel } from './TerminalPanel'
import { ProgressPane } from './ProgressPane'
import { Icon, type IconName } from './Icon'

// The chat view's dock (@shared/side-panel, R3): a draggable divider, a header naming the pane and
// its chord, and ONE pane's surface. Sits after the conversation inside `.layout`, so the composer
// and the message list stay on screen beside whichever pane is up — that is the point. Which pane
// is up is chosen from the thread header's dock group (DockGroup.tsx), not from in here.
//
// Hidden means hidden, per pane:
//   • INSPECTOR — the Hermes preview (a tool call's args + result, a file, a render) embedded in
//     the dock instead of a second right-hand dock of its own. Unmounts when another pane shows;
//     the preview target lives in the store, so it is back when the inspector is.
//   • BROWSER — stays mounted with `hidden` while the terminal shows. Its chrome then stops
//     reporting a hole, which is the SAME main-side path an overlay takes (bounds null → the
//     WebContentsView gets a zero rect, not merely paint over it). The web contents never move
//     and never reload. Collapsing the panel unmounts the chrome, which reports null on cleanup —
//     same path again.
//   • TERMINAL — unmounts while the browser shows. xterm cannot measure itself inside display:none,
//     and the pane's own re-attach-with-replay is the one code path it already uses for a view
//     switch, a tab switch, and a pop-out; the pty in main keeps its pid throughout. Unmounting is
//     also what detaches this window's sink (popout-window.ts contract §3 in spirit: nothing
//     invisible keeps receiving bytes).
//
// The divider drag: pointer capture keeps the moves coming as long as the pointer stays over the
// shell's own document — but the browser's page is a NATIVE view, not DOM, and a pointer over it
// leaves the shell. So while dragging, a full-window shield covers everything; the browser chrome
// sees itself covered and hides the view (zero rect) until the pointer is released, when the view
// returns at the final width. One resize of the native view per drag, not sixty per second.

const ICON: Record<PanelPane, IconName> = { inspector: 'toolfeed', browser: 'globe', terminal: 'terminal', progress: 'check' }

export interface SidePanelProps {
  pane: PanelPane
  /** The user's DESIRED width (CSS px); what renders is this fitted to the room available. */
  width: number
  onWidth: (w: number) => void
  onClose: () => void
  /** Browser → composer (the reason the panel exists beside the chat). */
  onSendToChat: (text: string) => void
  /** Inspector: a compaction summary's "Open session" (the preview's one navigation). */
  onOpenSession?: (id: string) => void
  /**
   * The conversation the dock is sitting beside, or null.
   *
   * Null is a REAL state, not a missing prop: the dock also opens on chat Home (no session picked)
   * and beside a coding run (no conversation at all). The progress pane says which of those it is
   * rather than rendering blank, so `view` comes with it.
   */
  sessionId: string | null
  /** The surface the dock is open on — chat | coding | loop-manager. */
  view: string
  /**
   * The approval ids still in the daemon's queue, and how to answer one.
   *
   * The progress pane's desktop log needs both: a step names the approval it is waiting on, and
   * whether that request is still actionable is decided here — not in the pane — so there is one
   * source of truth beside the Approvals view rather than a second poll. Optional because the
   * dock also opens beside surfaces with no approval context at all; absent means the log shows
   * steps without an inline approve/deny control, which is honest rather than inventing one.
   */
  pendingApprovalIds?: ReadonlySet<string>
  onResolveApproval?: (requestId: string, decision: ApprovalDecision) => void
  /** What the conversation area beside the dock must keep (split panes: every pane's minimum). */
  conversationMin?: number
}

export function SidePanel({ pane, width, onWidth, onClose, onSendToChat, onOpenSession, sessionId, view, pendingApprovalIds, onResolveApproval, conversationMin }: SidePanelProps): ReactElement {
  const dividerRef = useRef<HTMLDivElement | null>(null)
  const [room, setRoom] = useState<number>(Number.POSITIVE_INFINITY)
  const [dragging, setDragging] = useState(false)
  // Live width while dragging (not committed until release), else the fitted desired width.
  const [liveWidth, setLiveWidth] = useState<number | null>(null)

  /** The room the conversation and the panel share: from the conversation's left edge to the
   *  layout's right edge. The conversation is always the divider's previous sibling (structure,
   *  not a class name), so a sidebar change never breaks this. */
  const measureRoom = useCallback((): number => {
    const div = dividerRef.current
    const layout = div?.parentElement
    const conversation = div?.previousElementSibling as HTMLElement | null
    if (!div || !layout || !conversation) return Number.POSITIVE_INFINITY
    return layout.getBoundingClientRect().right - conversation.getBoundingClientRect().left
  }, [])

  useLayoutEffect(() => {
    // The room is (layout width − sidebar), which the panel's own width does not change. A window
    // resize moves it, and so does the session list now that it has its own divider: observe the
    // conversation column too (its size changes when the list's width does). Setting the same room
    // twice is a no-op render, so the panel resizing the conversation cannot loop.
    const update = (): void => setRoom(measureRoom())
    update()
    window.addEventListener('resize', update)
    const conversation = dividerRef.current?.previousElementSibling
    const ro = typeof ResizeObserver !== 'undefined' && conversation ? new ResizeObserver(update) : null
    if (ro && conversation) ro.observe(conversation)
    return () => {
      window.removeEventListener('resize', update)
      ro?.disconnect()
    }
  }, [measureRoom])

  // A window narrower than the conversation's minimum plus the panel's minimum cannot be helped
  // here; the shared fit picks the panel's minimum in that case, by decision.
  const info = paneInfo(pane)
  const fitted = fitPanelWidth(width, room, pane, conversationMin)
  const shown = liveWidth ?? fitted

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const div = e.currentTarget
    const startX = e.clientX
    const startW = fitted
    const roomNow = measureRoom()
    setDragging(true)
    setLiveWidth(startW)
    try {
      div.setPointerCapture(e.pointerId)
    } catch {
      /* a synthetic pointer (a probe) has no capture; the listeners below still work */
    }
    let latest = startW
    const move = (ev: PointerEvent): void => {
      // The divider is on the panel's LEFT edge: dragging left widens the panel. Floored at 1: a drag
      // right by more than the panel's width asks for a negative width, which fitPanelWidth reads as
      // "unreadable" and answers with the DEFAULT, so the panel jumped back instead of stopping at its minimum.
      latest = fitPanelWidth(Math.max(1, startW + (startX - ev.clientX)), roomNow, pane, conversationMin)
      setLiveWidth(latest)
    }
    const up = (ev: PointerEvent): void => {
      div.removeEventListener('pointermove', move)
      div.removeEventListener('pointerup', up)
      div.removeEventListener('pointercancel', up)
      try {
        div.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      setDragging(false)
      setLiveWidth(null)
      // The desired width is what the user dragged to (fitted to the room at the time) — persisted
      // by the owner; a later narrower window fits it down without forgetting it.
      onWidth(latest)
    }
    div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', up)
    div.addEventListener('pointercancel', up)
  }

  // Keyboard resize on the focused divider: ← widens (the panel grows leftwards), → narrows.
  const onDividerKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') onWidth(fitPanelWidth(fitted + step, measureRoom(), pane, conversationMin))
    else if (e.key === 'ArrowRight') onWidth(fitPanelWidth(fitted - step, measureRoom(), pane, conversationMin))
    else if (e.key === 'Home') onWidth(paneInfo(pane).defaultWidth)
    else return
    e.preventDefault()
  }

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('is-resizing-panel')
    return () => document.body.classList.remove('is-resizing-panel')
  }, [dragging])

  return (
    <>
      <div
        ref={dividerRef}
        className={`side-panel-divider${dragging ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuenow={Math.round(shown)}
        aria-valuemin={0}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => onWidth(paneInfo(pane).defaultWidth)}
        onKeyDown={onDividerKey}
      />
      <aside
        className="side-panel"
        style={{ width: shown }}
        aria-label="Side panel"
        data-pane={pane}
        data-testid="side-panel"
      >
        <div className="side-panel-head">
          <span className="side-panel-name">
            <Icon name={ICON[pane]} size={13} />
            <span>{info.label}</span>
            <kbd className="side-panel-kbd">{info.shortcut}</kbd>
          </span>
          <button className="side-panel-x" title="Close the side panel (Esc)" aria-label="Close the side panel" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="side-panel-body">
          {pane === 'inspector' ? <PreviewPane embedded onOpenSession={onOpenSession} /> : null}
          <BrowserPane hidden={pane !== 'browser'} onSendToChat={onSendToChat} />
          {pane === 'terminal' ? <TerminalPanel /> : null}
          {pane === 'progress' ? (
            <ProgressPane
              sessionId={sessionId}
              view={view}
              pendingApprovalIds={pendingApprovalIds}
              onResolveApproval={onResolveApproval}
            />
          ) : null}
        </div>
      </aside>
      {dragging ? <div className="side-panel-drag-shield" aria-hidden /> : null}
    </>
  )
}
