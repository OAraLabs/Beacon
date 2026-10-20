import { IPC } from '@shared/ipc'
import { isPlausibleSessionId } from '@shared/session-windows'
import { handleFromShell } from './shell-windows'
import type { SessionWindows } from './session-windows'

// The four requests a page may make about session windows (@shared/session-windows). Registered
// through handleFromShell, so only Beacon's own page in a window Beacon made can make them. Ids are
// checked here, at the boundary, not trusted from the page.
export function registerSessionWindowHandlers(deps: {
  windows: SessionWindows
  /** Show the main window and switch it to `sessionId` (a session coming back from its window). */
  showInMain: (sessionId: string) => void
}): void {
  handleFromShell(IPC.SESSION_WINDOW_OPEN, (_e, sessionId: unknown) => (isPlausibleSessionId(sessionId) ? deps.windows.open(sessionId) !== null : false))
  handleFromShell(IPC.SESSION_WINDOW_REQUEST_CLOSE, (_e, sessionId: unknown) =>
    isPlausibleSessionId(sessionId) ? deps.windows.requestClose(sessionId) : false
  )
  // The SENDER names the window, not an argument: a page can only close the window it is in.
  handleFromShell(IPC.SESSION_WINDOW_CLOSE_READY, (e, returnToMain: unknown) => {
    const id = deps.windows.closeReady(e.sender, returnToMain === true ? deps.showInMain : undefined)
    return id !== null
  })
  handleFromShell(IPC.SESSION_WINDOW_LIST, () => deps.windows.list())
}
