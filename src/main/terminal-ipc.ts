// Terminal pane — the IPC seam between Beacon windows and the pty sessions in main.
//
// THE INVARIANT: only a Beacon WINDOW's top-level frame, showing the shell page, may write into a
// pty. Every handler runs the same guard (isShellSender, src/main/shell-windows.ts): the sender must
// be a window Beacon created, its main frame, AND the shell page. A rendered artifact (model-authored
// HTML in a sandboxed beacon-artifact:// iframe) is a sub-frame and has no preload, but the guard
// makes that a checked fact rather than an assumption. Until 2026-09-24 the guard asked only
// "does SOME BrowserWindow own this, and is it the top frame": a foreign page at the top of a
// Beacon window, or a window Beacon never made, passed (scripts/window-guard-probe.mjs). Nothing here
// imports the connection, the cache, the chat path, or the daemon API; terminal-smoke asserts that
// on the source. Data flows back only to webContents that attached, never via broadcast.
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { IPC } from '@shared/ipc'
import { MAX_WRITE_CHARS, type TerminalOpenError, type TerminalOpenRequest, type TerminalPlacement, type TerminalSession } from '@shared/terminal'
import { TerminalSessions, type TerminalSink } from './terminal-sessions'
import { tailnetStatus } from './tailnet'
import { isShellSender } from './shell-windows'

/** What the pop-out needs from the app shell. `openPopout` is the app's ONE satellite-window
 *  mechanism (popout-window.ts, shared with the browser pane): created once, hidden on close,
 *  never destroyed. */
export interface TerminalWindowDeps {
  mainWindow: () => BrowserWindow | null
  openPopout: (onClose: () => void) => BrowserWindow
}

let sessions: TerminalSessions | null = null
const sinks = new Map<number, TerminalSink>() // webContents.id → its sink

function manager(): TerminalSessions {
  if (!sessions) {
    sessions = new TerminalSessions({
      shell: process.env.SHELL || '/bin/zsh',
      shellArgs: ['-l'], // a login shell, like Terminal.app
      home: homedir(),
      env: process.env
    })
  }
  return sessions
}

/** The guard. A refused sender gets nothing — no throw, no reply beyond `null`/`false`. */
export function isBeaconWindowFrame(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isShellSender(e)
}

function sinkFor(wc: WebContents): TerminalSink {
  let s = sinks.get(wc.id)
  if (s) return s
  s = {
    data: (id, chunk) => { if (!wc.isDestroyed()) wc.send(IPC.TERMINAL_DATA, { id, data: chunk }) },
    exit: (id, exit) => { if (!wc.isDestroyed()) wc.send(IPC.TERMINAL_EXIT, { id, exit }) }
  }
  sinks.set(wc.id, s)
  wc.once('destroyed', () => {
    const gone = sinks.get(wc.id)
    if (gone) manager().detachAll(gone)
    sinks.delete(wc.id)
  })
  return s
}

const dim = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)

// ── pop-out window (Phase 2) ──────────────────────────────────────────────────────────────
// The pty never moves: both the main window's pane and the detached window attach to the same
// session in main, so a pop-out / pop-in is a re-attach with replay, never a restart. The window
// itself is the app's shared satellite (popout-window.ts): made once, HIDDEN on close / pop-in,
// shown again on the next pop-out with its bounds intact — destroying satellites hung main once
// (browser-pane, 2026-09-03). `poppedOut` is the INTENT, not isVisible(): a freshly created
// window is not visible until ready-to-show, and the main pane must yield before that. Only the
// two Beacon windows are told about placement changes — no broadcast.
let terminalWindow: BrowserWindow | null = null
let poppedOut = false

function tellPlacement(deps: TerminalWindowDeps, cause: TerminalPlacement['cause']): void {
  const p: TerminalPlacement = { poppedOut, cause }
  for (const w of [deps.mainWindow(), terminalWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.TERMINAL_PLACEMENT, p)
  }
}

function showTerminalWindow(deps: TerminalWindowDeps): void {
  if (!terminalWindow || terminalWindow.isDestroyed()) {
    terminalWindow = deps.openPopout(() => {
      // Red button / ⌘W: the window hides; the shells are untouched; the main pane re-attaches.
      poppedOut = false
      terminalWindow?.hide()
      tellPlacement(deps, 'closed')
    })
    terminalWindow.on('closed', () => {
      // Normally only at quit (isQuitting lets the close through) — but a renderer-initiated
      // window.close() destroys a BrowserWindow WITHOUT the cancelable 'close' (measured
      // 2026-09-03), so a destroyed satellite must hand the pty back to the main pane too.
      terminalWindow = null
      poppedOut = false
      tellPlacement(deps, 'closed')
    })
  } else {
    terminalWindow.show()
  }
  terminalWindow.focus()
}

export function registerTerminalHandlers(deps: TerminalWindowDeps): void {
  ipcMain.handle(IPC.TERMINAL_POP_OUT, (e): boolean => {
    if (!isBeaconWindowFrame(e)) return false
    poppedOut = true
    showTerminalWindow(deps)
    tellPlacement(deps, 'pop-out')
    return true
  })
  ipcMain.on(IPC.TERMINAL_POP_IN, (e) => {
    if (!isBeaconWindowFrame(e)) return
    poppedOut = false
    if (terminalWindow && !terminalWindow.isDestroyed()) terminalWindow.hide()
    const main = deps.mainWindow()
    if (main && !main.isDestroyed()) {
      main.show()
      main.focus()
    }
    tellPlacement(deps, 'pop-in')
  })
  // Phase 4: the peer row. Derived from the tailscale CLI on every call; nothing is stored.
  ipcMain.handle(IPC.TERMINAL_PEERS, async (e) => {
    if (!isBeaconWindowFrame(e)) return { available: false, backendState: null, peers: [], agentIdentities: -1, error: 'refused' }
    return tailnetStatus(process.env, homedir())
  })
  ipcMain.handle(IPC.TERMINAL_PLACEMENT_GET, (e): TerminalPlacement | null =>
    isBeaconWindowFrame(e) ? { poppedOut, cause: 'query' } : null
  )

  ipcMain.handle(IPC.TERMINAL_OPEN, (e, req: TerminalOpenRequest): TerminalSession | TerminalOpenError | null => {
    if (!isBeaconWindowFrame(e)) return null
    const command = Array.isArray(req?.command) && req.command.every((s) => typeof s === 'string') ? req.command : undefined
    return manager().open({ cols: dim(req?.cols) ?? 80, rows: dim(req?.rows) ?? 24, command, title: typeof req?.title === 'string' ? req.title : undefined })
  })
  ipcMain.handle(IPC.TERMINAL_LIST, (e): TerminalSession[] => (isBeaconWindowFrame(e) ? manager().list() : []))
  ipcMain.handle(IPC.TERMINAL_ATTACH, (e, id: string, cols?: number, rows?: number) => {
    if (!isBeaconWindowFrame(e) || typeof id !== 'string') return null
    return manager().attach(id, sinkFor(e.sender), dim(cols), dim(rows))
  })
  ipcMain.on(IPC.TERMINAL_DETACH, (e, id: string) => {
    if (!isBeaconWindowFrame(e) || typeof id !== 'string') return
    const s = sinks.get(e.sender.id)
    if (s) manager().detach(id, s)
  })
  // THE input path: keystrokes (and pastes) from the pane's xterm. `send`, not `invoke` — a round
  // trip per keystroke would only add latency to the thing it measures.
  ipcMain.on(IPC.TERMINAL_WRITE, (e, id: string, data: string) => {
    if (!isBeaconWindowFrame(e)) return
    if (typeof id !== 'string' || typeof data !== 'string' || data.length === 0 || data.length > MAX_WRITE_CHARS) return
    manager().write(id, data)
  })
  ipcMain.on(IPC.TERMINAL_RESIZE, (e, id: string, cols: number, rows: number) => {
    if (!isBeaconWindowFrame(e) || typeof id !== 'string') return
    const c = dim(cols)
    const r = dim(rows)
    if (c && r) manager().resize(id, c, r)
  })
  ipcMain.handle(IPC.TERMINAL_RENAME, (e, id: string, title: string): boolean => {
    if (!isBeaconWindowFrame(e) || typeof id !== 'string' || typeof title !== 'string') return false
    return manager().rename(id, title)
  })
  ipcMain.handle(IPC.TERMINAL_CLOSE, (e, id: string): boolean => {
    if (!isBeaconWindowFrame(e) || typeof id !== 'string') return false
    return manager().close(id)
  })
}

/** App quit: no orphaned shells. Returns the number that were still running. */
export function killAllTerminals(): number {
  return sessions ? sessions.disposeAll() : 0
}
