import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPTY_BROWSER_STATE, composeSendToChat, type BrowserState, type BrowserTab } from '@shared/browser-pane'
import { Icon } from '../components/Icon'
import { useViewBounds } from './use-view-bounds'

// The browser pane's CHROME: URL bar, back/forward/reload/stop, zoom, find, notices, the error page,
// and the hole the native view sits in (see use-view-bounds). A HUMAN viewer — every call into
// window.beacon.browser below is a control the user clicks or types into. Nothing in this file
// subscribes to chat frames, gateway events or daemon data; browser-invariant-smoke pins that.

export interface BrowserPaneProps {
  /** 'dock': inside the chat view's side panel. 'popout': the whole pop-out window. */
  mode?: 'dock' | 'popout'
  /** Renders a close control in the toolbar when given; the side panel has its own, so it omits this. */
  onClose?: () => void
  /** Dock only: the panel is showing another pane. The chrome stays mounted (its state survives)
   * but is not displayed and reports NO hole — main zeroes the view's rect, the same path an
   * overlay takes. The web contents never move and never reload. */
  hidden?: boolean
  /** Phase 2: put text into the composer. The USER then sends it — or not. (Dock only: from the
   * pop-out, main routes the block to the main window's composer itself.) */
  onSendToChat?: (text: string) => void
}

function activeTab(s: BrowserState): BrowserTab | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null
}

/** Tab caption: title, else host, else "New tab". */
function tabLabel(t: BrowserTab): string {
  if (t.title.trim()) return t.title.trim()
  if (t.url) {
    try {
      return new URL(t.url).host || t.url
    } catch {
      return t.url
    }
  }
  return 'New tab'
}

export function BrowserPane({ mode = 'dock', onClose, onSendToChat, hidden = false }: BrowserPaneProps) {
  const b = window.beacon
  const [state, setState] = useState<BrowserState>(EMPTY_BROWSER_STATE)
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [navError, setNavError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [sendState, setSendState] = useState<'idle' | 'busy' | 'empty' | 'sent'>('idle')
  const [dismissedNotice, setDismissedNotice] = useState(0)
  const urlRef = useRef<HTMLInputElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const holeRef = useRef<HTMLDivElement>(null)

  const tab = activeTab(state)
  // The dock while the view is popped out: a placeholder with Reattach, and no hole to report.
  const detached = mode === 'dock' && state.host === 'popout'
  const canSend = mode === 'popout' || !!onSendToChat

  useEffect(() => {
    if (!b) return
    let alive = true
    void b.browser.state().then((s) => alive && setState(s)).catch(() => undefined)
    const off = b.browser.onState((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [b])

  // The URL bar mirrors the page unless the user is typing in it.
  useEffect(() => {
    if (!editing) setInput(tab?.url ?? '')
  }, [tab?.url, editing])

  const focusUrl = useCallback(() => {
    const el = urlRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  useEffect(() => {
    if (!b) return
    return b.browser.onChromeKey((key) => {
      if (key === 'focus-url') focusUrl()
      else if (key === 'find') {
        setFindOpen(true)
        setTimeout(() => findRef.current?.focus(), 0)
      } else if (key === 'escape') {
        if (findOpen) closeFind()
        else if (tab?.loading) b.browser.stop()
      } else if (key === 'new-tab') {
        b.browser.newTab()
        setTimeout(focusUrl, 50)
      } else if (key === 'close-tab') {
        if (tab) b.browser.closeTab(tab.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, focusUrl, findOpen, tab?.loading])

  useEffect(() => {
    if (!tab) setTimeout(focusUrl, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reporting the hole is what mounts the native view; it is reported whenever the pane is on
  // screen, error page or not (main hides the view itself while a tab shows an error).
  useViewBounds(holeRef, !detached && !hidden)

  async function go(): Promise<void> {
    if (!b) return
    setNavError(null)
    const r = await b.browser.navigate(input)
    if (!r.ok) {
      setNavError(r.reason)
      return
    }
    setEditing(false)
    urlRef.current?.blur()
  }

  function closeFind(): void {
    setFindOpen(false)
    setFindText('')
    b?.browser.find({ text: '', stop: true })
  }

  function findNext(forward: boolean): void {
    if (!findText.trim()) return
    b?.browser.find({ text: findText, forward })
  }

  async function sendToChat(): Promise<void> {
    if (!b || !canSend || sendState === 'busy') return
    setSendState('busy')
    try {
      const ex = await b.browser.extract()
      if (!ex || (!ex.selection.trim() && !ex.text.trim())) {
        setSendState('empty')
        setTimeout(() => setSendState('idle'), 2200)
        return
      }
      // From the pop-out, main has already routed the block to the main window's composer.
      if (mode === 'dock') onSendToChat?.(composeSendToChat(ex))
      setSendState('sent')
      setTimeout(() => setSendState('idle'), 1600)
    } catch {
      setSendState('idle')
    }
  }

  const notices = state.notices.filter((n) => n.id > dismissedNotice)

  return (
    <aside className={`browser-pane${mode === 'popout' ? ' is-popout' : ''}${hidden ? ' is-hidden' : ''}`} aria-label="Browser" hidden={hidden || undefined}>
      {!detached ? (
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((t, i) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === state.activeTabId}
              className={`browser-tab${t.id === state.activeTabId ? ' is-active' : ''}${dragId === t.id ? ' is-dragging' : ''}`}
              title={t.url || 'New tab'}
              draggable
              data-tab-id={t.id}
              data-tab-index={i}
              onClick={() => b?.browser.selectTab(t.id)}
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                const id = dragId ?? e.dataTransfer.getData('text/plain')
                if (id && id !== t.id) b?.browser.moveTab(id, i)
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
            >
              {t.loading ? <Icon name="loader" size={11} /> : null}
              <span className="browser-tab-title">{tabLabel(t)}</span>
              <button
                className="browser-tab-x"
                aria-label={`Close tab: ${tabLabel(t)}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  b?.browser.closeTab(t.id)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          <button
            className="browser-btn browser-tab-new"
            title="New tab (⌘T in the page)"
            aria-label="New tab"
            onClick={() => {
              b?.browser.newTab()
              setTimeout(focusUrl, 50)
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      ) : null}
      <div className="browser-toolbar">
        <button className="browser-btn" title="Back (⌘[)" aria-label="Back" disabled={!tab?.canGoBack} onClick={() => b?.browser.back()}>
          <Icon name="chevron-left" size={15} />
        </button>
        <button className="browser-btn" title="Forward (⌘])" aria-label="Forward" disabled={!tab?.canGoForward} onClick={() => b?.browser.forward()}>
          <Icon name="chevron-right" size={15} />
        </button>
        {tab?.loading ? (
          <button className="browser-btn" title="Stop (Esc)" aria-label="Stop loading" onClick={() => b?.browser.stop()}>
            <Icon name="x" size={14} />
          </button>
        ) : (
          <button className="browser-btn" title="Reload (⌘R)" aria-label="Reload" disabled={!tab} onClick={() => b?.browser.reload()}>
            <Icon name="refresh" size={14} />
          </button>
        )}
        <form
          className="browser-urlbar"
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <input
            ref={urlRef}
            className="browser-url"
            type="text"
            value={input}
            placeholder="Type a web address… (⌘L)"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Address"
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => {
              setInput(e.target.value)
              if (navError) setNavError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setInput(tab?.url ?? '')
                urlRef.current?.blur()
              }
            }}
          />
        </form>
        <div className="browser-zoom" title="Zoom">
          <button className="browser-btn" aria-label="Zoom out" disabled={!tab} onClick={() => b?.browser.zoom('out')}>
            −
          </button>
          <button className="browser-btn browser-zoom-pct" aria-label="Reset zoom" disabled={!tab} onClick={() => b?.browser.zoom('reset')}>
            {tab ? `${tab.zoomPercent}%` : '100%'}
          </button>
          <button className="browser-btn" aria-label="Zoom in" disabled={!tab} onClick={() => b?.browser.zoom('in')}>
            +
          </button>
        </div>
        {mode === 'dock' && onClose ? (
          <button className="browser-btn" title="Close the browser pane" aria-label="Close browser" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        ) : null}
      </div>
      <div className={`browser-progress${tab?.loading ? ' is-loading' : ''}`} aria-hidden />
      {navError ? (
        <div className="browser-notice is-input" role="alert">
          {navError}
        </div>
      ) : null}
      {notices.map((n) => (
        <div key={n.id} className={`browser-notice is-${n.kind}`} role="status">
          <span>{n.text}</span>
          <button className="browser-notice-x" aria-label="Dismiss" onClick={() => setDismissedNotice(n.id)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {findOpen ? (
        <div className="browser-find">
          <input
            ref={findRef}
            className="browser-find-input"
            type="text"
            value={findText}
            placeholder="Find in page"
            aria-label="Find in page"
            onChange={(e) => {
              setFindText(e.target.value)
              if (e.target.value.trim()) b?.browser.find({ text: e.target.value, forward: true })
              else b?.browser.find({ text: '', stop: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                findNext(!e.shiftKey)
              } else if (e.key === 'Escape') closeFind()
            }}
          />
          <span className="browser-find-count">{state.find ? `${state.find.active} / ${state.find.total}` : findText ? '0 / 0' : ''}</span>
          <button className="browser-btn" aria-label="Previous match" onClick={() => findNext(false)}>
            <Icon name="chevron-up" size={13} />
          </button>
          <button className="browser-btn" aria-label="Next match" onClick={() => findNext(true)}>
            <Icon name="chevron-down" size={13} />
          </button>
          <button className="browser-btn" aria-label="Close find" onClick={closeFind}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}
      <div ref={holeRef} className="browser-hole" data-testid="browser-hole">
        {detached ? (
          <div className="browser-empty" data-testid="browser-detached">
            <div className="browser-empty-title">Popped out.</div>
            <div className="browser-empty-sub">The page is in its own window. Close that window, or reattach, to bring it back here.</div>
            <div className="browser-error-actions">
              <button className="browser-btn is-solid" onClick={() => b?.browser.reattach()}>
                Reattach
              </button>
            </div>
          </div>
        ) : !tab ? (
          <div className="browser-empty">
            <div className="browser-empty-title">A viewer with a URL bar.</div>
            <div className="browser-empty-sub">
              You drive it: type an address above. Prometheus cannot see, click or steer this pane — its own browsing goes
              through the daemon&apos;s audited browser tool.
            </div>
          </div>
        ) : tab.error ? (
          <div className="browser-error" role="alert">
            <div className="browser-error-headline">{tab.error.headline}</div>
            <div className="browser-error-detail">{tab.error.detail}</div>
            <div className="browser-error-code">
              {tab.error.description}
              {tab.error.code ? ` · ${tab.error.code}` : ''} · {tab.error.url}
            </div>
            <div className="browser-error-actions">
              <button className="browser-btn is-solid" onClick={() => b?.browser.reload()}>
                Try again
              </button>
              {tab.canGoBack ? (
                <button className="browser-btn" onClick={() => b?.browser.back()}>
                  Go back
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {/* The footer. Send-to-chat and pop-out used to live in the nav row, where their labels ate
          180 of the dock's 392px and squeezed the address field down to TWENTY-TWO pixels — too
          narrow to click into, which reads as "the browser doesn't work". They belong here anyway:
          the handoff's browser spec puts the address pill and zoom in the nav row and "Send to
          chat / pop-out" in a footer. Moving them is what gives the address bar its width back. */}
      <div className="browser-foot">
        <button
          className="browser-btn"
          title="Find in page (⌘F)"
          aria-label="Find in page"
          aria-pressed={findOpen}
          disabled={!tab}
          onClick={() => {
            if (findOpen) closeFind()
            else {
              setFindOpen(true)
              setTimeout(() => findRef.current?.focus(), 0)
            }
          }}
        >
          <Icon name="search" size={14} />
        </button>
        {canSend ? (
          <button
            className="browser-btn browser-send"
            title="Send this page (or your selection) to the composer — you send it from there"
            aria-label="Send to chat"
            disabled={!tab || !!tab.error || detached || sendState === 'busy'}
            onClick={() => void sendToChat()}
          >
            <Icon name="send" size={14} />
            <span>{sendState === 'busy' ? 'Reading…' : sendState === 'empty' ? 'Nothing to send' : sendState === 'sent' ? 'In the composer' : 'Send to chat'}</span>
          </button>
        ) : null}
        <span className="browser-foot-gap" />
        {mode === 'popout' || detached ? (
          <button className="browser-btn" title="Bring the browser back into the main window" aria-label="Reattach browser" onClick={() => b?.browser.reattach()}>
            <Icon name="popout" size={14} />
            <span>Reattach</span>
          </button>
        ) : (
          <button className="browser-btn" title="Pop the browser out into its own window" aria-label="Pop out browser" disabled={!tab} onClick={() => b?.browser.detach()}>
            <Icon name="popout" size={14} />
          </button>
        )}
      </div>
    </aside>
  )
}
