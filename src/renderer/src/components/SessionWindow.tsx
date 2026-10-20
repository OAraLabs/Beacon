import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { resolveSessionMode, type ChatMode } from '@shared/composer-controls'
import { pinBody } from '@shared/session-pins'
import { ChatShell } from './ChatShell'
import { ErrorBoundary } from './ErrorBoundary'
import { GatewayStoreProvider } from '../gateway-store'
import { PreviewProvider } from '../preview-store'
import { loadAndApplyTheme } from '../theme/apply-theme'

// A session window (@shared/session-windows): one conversation in its own OS window, so it can sit
// on another monitor. The same ChatShell the main window shows, with the parts that make sense on
// their own: the title, pin, rename, Agent/Chat mode, export. NOT here, on purpose: the dock (browser,
// terminal, inspector) and voice, which belong to the main window; and Delete, which would leave this
// window showing a conversation that no longer exists.
//
// CLOSING SAVES FIRST. Whether you press "Return to main window" or the window's close button, the
// chat is unmounted before the window goes (its unmount writes the draft), and only then is main told
// it may close. See src/main/session-windows.ts.

type Closing = null | 'return' | 'close'

function displayTitle(s: SessionSummary | undefined, sessionId: string): string {
  if (s?.title && s.title !== sessionId) return s.title
  return sessionId.includes(':') ? sessionId.slice(sessionId.indexOf(':') + 1) : sessionId
}

export function SessionWindow({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    void loadAndApplyTheme()
  }, [])
  const [summary, setSummary] = useState<SessionSummary | undefined>()
  const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null)
  const [mode, setMode] = useState<ChatMode>(() => resolveSessionMode({}, sessionId))
  const [closing, setClosing] = useState<Closing>(null)
  // Liveness of the whole connection, not of this conversation (ChatShell's quiet-timer reads it).
  const lastSeen = useRef(0)

  const refresh = useCallback(async () => {
    const list = await window.beacon?.sessions.list().catch(() => [] as SessionSummary[])
    setSummary(list?.find((s) => s.id === sessionId))
    setPinnedOverride(null)
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const off = window.beacon?.chat.onStream((f) => {
      lastSeen.current = Date.now()
      // A finished turn can retitle the session (auto-title); pick it up.
      if (f.kind === 'done' && 'sessionId' in f && f.sessionId === sessionId) void refresh()
    })
    return () => off?.()
  }, [refresh, sessionId])

  const title = displayTitle(summary, sessionId)
  useEffect(() => {
    document.title = `${title} — Beacon`
  }, [title])

  // Main closing this window (its close button, ⌘W, or "Return it here" in the main window).
  useEffect(() => window.beacon?.sessionWindows.onClosing(() => setClosing((c) => c ?? 'close')), [])
  // The chat has unmounted in the commit that set `closing`, so its draft write is already on its way
  // to main. Invokes from one page reach main in order: the close cannot overtake the save.
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => void window.beacon?.sessionWindows.closeReady(closing === 'return'), 0)
    return () => clearTimeout(t)
  }, [closing])

  const pinned = pinnedOverride ?? summary?.pinned === true
  const togglePin = useCallback(async () => {
    const next = !pinned
    setPinnedOverride(next)
    const ok = await window.beacon?.daemon
      .write(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, pinBody(next), 'PUT')
      .then(() => true)
      .catch(() => false)
    if (!ok) setPinnedOverride(null) // reverted: a pin that only this window believes in is worse than none
    else void refresh()
  }, [pinned, refresh, sessionId])

  const rename = useCallback(
    async (t: string) => {
      const b = window.beacon
      if (!b) return
      const ok = await b.daemon
        .write(`/api/sessions/${encodeURIComponent(sessionId)}/title`, { title: t }, 'PUT')
        .then(() => true)
        .catch(() => false)
      if (!ok) await b.settings.set(`title:${sessionId}`, t).catch(() => undefined)
      void refresh()
    },
    [refresh, sessionId]
  )

  return (
    <GatewayStoreProvider>
      <PreviewProvider>
        <div className="session-window" data-session-window={sessionId}>
          {closing ? (
            <div className="session-window-closing" role="status">
              {closing === 'return' ? 'Moving back to the main window…' : 'Closing…'}
            </div>
          ) : (
            <ErrorBoundary label="this conversation" hint="Return it to the main window with the button in its header, or close this window.">
              <ChatShell
                sessionId={sessionId}
                mode={mode}
                onModeChange={setMode}
                daemonLastSeen={() => lastSeen.current}
                sessionTitle={title}
                pinned={pinned}
                onTogglePin={() => void togglePin()}
                onRenameSession={(t) => void rename(t)}
                onPopIn={() => setClosing('return')}
              />
            </ErrorBoundary>
          )}
        </div>
      </PreviewProvider>
    </GatewayStoreProvider>
  )
}
