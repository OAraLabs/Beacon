// Beacon's own windows: the Electron half of "only the shell page may hold the bridge". The
// decisions and their reasons are in @shared/shell-window; this file only feeds them.
//
// adoptShellWindow() is the ONE call every preload-bridged window makes. It does two things that
// must never come apart: it records the window as Beacon's (the identity half of the sender check),
// and it installs the navigation guard. A window that skips it has neither, so the terminal guard
// refuses it outright rather than trusting it with no guard. shell-window-smoke asserts that every
// `preload:` window in src/main makes the call.
import { app, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { isAbsolute, join } from 'path'
import { pathToFileURL } from 'node:url'
import { mayShellWindowNavigate, shellSenderRefusal } from '@shared/shell-window'

const adopted = new WeakSet<WebContents>()

// ── where Beacon's own page and preload are ──────────────────────────────────────────────────────
// From out/main (import.meta.mainOutDir), never from this module's `__dirname`. That is the directory
// of whichever chunk rollup put this file in. On 2026-09-24 a smoke's import moved it to
// out/main/chunks/, shellUrl() named out/main/renderer/index.html, and this check refused Beacon's
// own page until the app sat on "Loading…" (src/shared/main-out-dir.ts). smoke:shell-url tests it
// from a shared chunk on every build.

const NO_ANCHOR = 'Beacon cannot say where its own files are: main was built without the mainOutDir plugin (electron.vite.config.ts)'

/** out/main, or null when the build did not write an absolute one into this chunk (without the plugin,
 *  rollup emits `void 0` here). Never resolved against the working directory: a relative anchor would
 *  name whatever the cwd makes of it, so it names nothing. */
function outMain(): string | null {
  const dir: unknown = import.meta.mainOutDir
  return typeof dir === 'string' && isAbsolute(dir) ? dir : null
}

/** Where Beacon loads its renderer: the dev server under `npm run dev`, else the built index.html.
 *  It is both what every Beacon window is loaded with (loadShellPage) and what the sender check
 *  accepts, so the two cannot disagree. null when there is no anchor: then no page is the shell page,
 *  the sender check refuses every sender, and a top frame may go nowhere but about:blank. */
export function shellUrl(): string | null {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL
  const dir = outMain()
  return dir === null ? null : pathToFileURL(join(dir, '../renderer/index.html')).href
}

/** The preload every Beacon window is bridged with. Throws when there is no anchor. */
export function shellPreload(): string {
  const dir = outMain()
  if (dir === null) throw new Error(NO_ANCHOR)
  return join(dir, '../preload/index.js')
}

/** Load the shell page into a Beacon window, on `route` (its hash: capture, hud, terminal, browser;
 *  '' for the main window). The one load call for every Beacon window. */
export function loadShellPage(win: BrowserWindow, route = ''): Promise<void> {
  return win.loadURL(withRoute(shellUrl(), route))
}

/** `page` on `route`. With no page it throws: a loader loads Beacon's page or nothing, never a guess. */
function withRoute(page: string | null, route: string): string {
  if (page === null) throw new Error(NO_ANCHOR)
  return route ? `${page}#${route}` : page
}

/** Make `win` a Beacon window: trusted as an IPC sender (while it shows the shell page) and
 *  unable to navigate its top frame anywhere else. Call it right after `new BrowserWindow`.
 *
 *  will-redirect is guarded as well as will-navigate: a server-side redirect must not slip past a
 *  guard that only watches the first hop. They are written as two listeners because Electron's `on`
 *  is overloaded per event, and a union of the two names does not type-check. The refused URL is
 *  not logged. It is untrusted content, and a log someone later reads in a terminal is the wrong
 *  place for it. */
export function adoptShellWindow(win: BrowserWindow): void {
  const wc = win.webContents
  adopted.add(wc)
  wc.on('will-navigate', (e, url) => {
    if (!mayShellWindowNavigate(url, shellUrl())) {
      e.preventDefault()
      console.warn('[shell] refused will-navigate away from the shell page')
    }
  })
  wc.on('will-redirect', (e, url) => {
    if (!mayShellWindowNavigate(url, shellUrl())) {
      e.preventDefault()
      console.warn('[shell] refused will-redirect away from the shell page')
    }
  })
}

/** Is this IPC from the shell page in the top frame of a window Beacon created? A refused sender
 *  should get nothing: no throw, no reply beyond an empty value. */
export function isShellSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  try {
    const wc = e.sender
    const frame = e.senderFrame
    return (
      shellSenderRefusal({
        known: adopted.has(wc) && !wc.isDestroyed(),
        mainFrame: frame !== null && frame === wc.mainFrame,
        frameUrl: frame?.url ?? null,
        shellUrl: shellUrl()
      }) === null
    )
  } catch {
    // A frame disposed mid-message throws on access. Refuse, don't guess.
    return false
  }
}

// ── registering a handler the shell may call ─────────────────────────────────────────────────────
// Until 2026-09-24 only the terminal handlers checked the sender. Everything else (daemon writes with
// the bearer token, settings, setup and pairing, the gateway address, ~/Downloads writes, chat and
// approvals) answered ANY sender, so a foreign document at the top of a Beacon window, or a window
// Beacon never made, could drive them with nothing but the navigation guard in the way.
//
// These two are ipcMain.handle / ipcMain.on with the sender check in front. Being in front is the
// point: the handler cannot run, or read its arguments, before the check says yes. A handler that
// needs its own check (the terminal's typed refusals, the browser pane's host rule) registers raw and
// makes the check its first call. ipc-sender-smoke fails any registration in src/main that does
// neither.
//
// `any[]` matches ipcMain's own listener type, so each handler keeps its own parameter annotations.

/** ipcMain.handle, for the shell only. A refused sender gets `null`, and the handler never runs. */
export function handleFromShell(channel: string, handler: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => (isShellSender(e) ? handler(e, ...args) : null))
}

/** ipcMain.on, for the shell only. A refused sender's message is dropped before the listener runs. */
export function onFromShell(channel: string, listener: (e: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!isShellSender(e)) return
    listener(e, ...args)
  })
}
