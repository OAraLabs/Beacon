import { BrowserWindow, app, screen, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debuggingAllowedHere } from './build-flavor'
import { builtinSpellcheck } from '@shared/spellcheck'
import { loadWindowState, trackWindowState } from './window-state'
import { installContextMenu } from './context-menu'
import { adoptShellWindow, loadShellPage, shellPreload } from './shell-windows'
import { safeExternalUrl } from '@shared/browser-pane'
import { IPC } from '@shared/ipc'
import {
  CLOSE_FLUSH_TIMEOUT_MS,
  isPlausibleSessionId,
  parseOpenSessionWindows,
  sessionWindowRoute,
  sessionWindowStateName
} from '@shared/session-windows'

// Session windows (@shared/session-windows): one conversation in its own OS window, for a second
// monitor. NOT the satellite pattern in popout-window.ts. Those hide on close and are reused because
// the browser pane MOVES a WebContentsView between windows, and destroying a window right after that
// move hung main (2026-09-03). A session window holds no moved view, so it is created per session and
// really closed; the hide-never-destroy contract is about the view, not about windows in general.
//
// CLOSING SAVES FIRST. The chat view writes its draft on a 400 ms debounce and again when it unmounts.
// A destroyed window never unmounts, so a plain close could lose the last words typed. Every close but
// a quit goes: main asks the page (SESSION_WINDOW_CLOSING) → the page unmounts its chat (the unmount
// writes the draft) → the page says ready (SESSION_WINDOW_CLOSE_READY) → main closes it. Invokes from
// one page reach main in order, so the draft write lands before the close. A page that never answers
// is closed anyway after CLOSE_FLUSH_TIMEOUT_MS.

export interface SessionWindowsDeps {
  isQuitting: () => boolean
  /** The set of popped-out sessions changed (opened, closed). Broadcast it. */
  onChange: (ids: string[]) => void
}

export interface SessionWindows {
  /** Open the session's window, or bring the existing one forward. */
  open(sessionId: string): BrowserWindow | null
  /** Ask the session's window to close (it saves its draft first). False when there is none. */
  requestClose(sessionId: string): boolean
  /** The page in `sender` has saved and may close. `after` runs once the window is gone. */
  closeReady(sender: WebContents, after?: (sessionId: string) => void): string | null
  /** Bring the session's window forward; false when it has none. */
  focus(sessionId: string): boolean
  /** The session whose window has focus, if one does. */
  focused(): string | null
  has(sessionId: string): boolean
  list(): string[]
  /** Reopen the windows that were open when Beacon last quit (only sessions `keep` accepts). */
  restore(keep?: (sessionId: string) => boolean): void
}

export function createSessionWindows(deps: SessionWindowsDeps): SessionWindows {
  const dir = (): string => join(app.getPath('userData'), 'session-windows')
  const openFile = (): string => join(dir(), 'open.json')
  const wins = new Map<string, BrowserWindow>()
  const ready = new Set<string>()
  const afterClose = new Map<string, (id: string) => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const list = (): string[] => [...wins.keys()]

  /** The open list, for the next launch. Not written while quitting: a quit closes every window, and
   *  recording that would forget exactly what the next launch is meant to bring back. */
  const persist = (): void => {
    try {
      mkdirSync(dir(), { recursive: true })
      writeFileSync(openFile(), JSON.stringify(list()))
    } catch (e) {
      console.warn('[session-windows] could not record the open windows:', e instanceof Error ? e.message : e)
    }
  }

  const focusWin = (win: BrowserWindow): void => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  function open(sessionId: string): BrowserWindow | null {
    if (!isPlausibleSessionId(sessionId)) return null
    const existing = wins.get(sessionId)
    if (existing && !existing.isDestroyed()) {
      focusWin(existing)
      return existing
    }
    mkdirSync(dir(), { recursive: true })
    const file = join(dir(), sessionWindowStateName(sessionId))
    // Clamped to the displays connected NOW: a window remembered on a monitor that is gone comes back
    // onto one that is there (sanitizeWindowState), rather than opening off-screen.
    const st = loadWindowState(file, screen.getAllDisplays().map((d) => d.workArea))
    const remembered = existsSync(file)
    const win = new BrowserWindow({
      width: remembered ? st.width : 760,
      height: remembered ? st.height : 860,
      ...(remembered && st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : {}),
      minWidth: 420,
      minHeight: 360,
      show: false,
      title: 'Beacon',
      backgroundColor: '#0b0d12',
      webPreferences: {
        devTools: debuggingAllowedHere(),
        preload: shellPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: builtinSpellcheck(process.platform)
      }
    })
    adoptShellWindow(win)
    trackWindowState(win, file)
    if (remembered && st.maximized) win.maximize()
    win.on('ready-to-show', () => win.show())
    // Links in a conversation open the way the main window opens them: http(s) in the system
    // browser, anything else refused.
    win.webContents.setWindowOpenHandler(({ url }) => {
      const safe = safeExternalUrl(url)
      if (safe) void shell.openExternal(safe)
      else console.warn('[session-windows] refused to open a non-web URL (see safeExternalUrl)')
      return { action: 'deny' }
    })
    win.on('close', (e) => {
      if (deps.isQuitting() || ready.has(sessionId)) return
      e.preventDefault()
      if (timers.has(sessionId)) return
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.SESSION_WINDOW_CLOSING)
      timers.set(
        sessionId,
        setTimeout(() => {
          console.warn('[session-windows] the window did not confirm its save in time; closing it anyway')
          ready.add(sessionId)
          if (!win.isDestroyed()) win.close()
        }, CLOSE_FLUSH_TIMEOUT_MS)
      )
    })
    win.on('closed', () => {
      const t = timers.get(sessionId)
      if (t) clearTimeout(t)
      timers.delete(sessionId)
      ready.delete(sessionId)
      if (wins.get(sessionId) === win) wins.delete(sessionId)
      if (!deps.isQuitting()) persist()
      deps.onChange(list())
      const after = afterClose.get(sessionId)
      afterClose.delete(sessionId)
      after?.(sessionId)
    })
    wins.set(sessionId, win)
    installContextMenu(win)
    void loadShellPage(win, sessionWindowRoute(sessionId))
    persist()
    deps.onChange(list())
    return win
  }

  function requestClose(sessionId: string): boolean {
    const win = wins.get(sessionId)
    if (!win || win.isDestroyed()) return false
    win.close() // → the 'close' handler asks the page to save first
    return true
  }

  function closeReady(sender: WebContents, after?: (sessionId: string) => void): string | null {
    for (const [id, win] of wins) {
      if (win.isDestroyed() || win.webContents !== sender) continue
      ready.add(id)
      if (after) afterClose.set(id, after)
      const t = timers.get(id)
      if (t) clearTimeout(t)
      timers.delete(id)
      win.close()
      return id
    }
    return null
  }

  function focus(sessionId: string): boolean {
    const win = wins.get(sessionId)
    if (!win || win.isDestroyed()) return false
    focusWin(win)
    return true
  }

  function focused(): string | null {
    for (const [id, win] of wins) if (!win.isDestroyed() && win.isFocused()) return id
    return null
  }

  function restore(keep?: (sessionId: string) => boolean): void {
    let ids: string[] = []
    try {
      ids = existsSync(openFile()) ? parseOpenSessionWindows(readFileSync(openFile(), 'utf8')) : []
    } catch {
      ids = []
    }
    for (const id of ids) if (!keep || keep(id)) open(id)
    // A session that no longer exists drops off the list here, instead of being retried every launch.
    persist()
  }

  return { open, requestClose, closeReady, focus, focused, has: (id) => wins.has(id), list, restore }
}
