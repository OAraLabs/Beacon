import { BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/ipc'
import { noChatProjects, refusal, validOp, type ChatProjectsResult, type ChatProjectsState } from '@shared/chat-projects'
import { validContentOp, type ContentResult } from '@shared/chat-projects-content'
import type { ChatProjectsHub } from './chat-projects'
import type { ChatProjectContent } from './chat-projects-content'
import { handleFromShell } from './shell-windows'

/** The window's ways in: what main knows, one change, and a project's instructions and files. `current` is the hub of the connection
 *  Beacon is on now (null before there is one): a change the window sends is made on that Prometheus and no other. */
export function registerChatProjectsHandlers(current: () => ChatProjectsHub | null, currentContent: () => ChatProjectContent | null): void {
  handleFromShell(IPC.CHAT_PROJECTS_STATE, (): ChatProjectsState => current()?.state() ?? noChatProjects())
  handleFromShell(IPC.CHAT_PROJECTS_DO, async (_e, raw: unknown): Promise<ChatProjectsResult> => {
    // A bad request is never forwarded: it is refused here, in the same words as any other that didn't work.
    const op = validOp(raw)
    if (!op) return refusal(400, null)
    const hub = current()
    return hub ? hub.run(op) : refusal(404, null)
  })
  handleFromShell(IPC.CHAT_PROJECTS_CONTENT, async (e, raw: unknown): Promise<ContentResult> => {
    const op = validContentOp(raw)
    if (!op) return refusal(400, null)
    const content = currentContent()
    if (!content) return refusal(404, null)
    // The panels belong to the window that asked. What they return never reaches the page: main reads and writes the files itself.
    const win = BrowserWindow.fromWebContents(e.sender)
    return content.run(op, {
      pickFiles: async (multiple) => {
        const opts: Electron.OpenDialogOptions = { title: multiple ? 'Add reference files' : 'Choose a file to put in its place', buttonLabel: multiple ? 'Add' : 'Replace', properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? null : res.filePaths
      },
      pickSaveAs: async (defaultName) => {
        const opts: Electron.SaveDialogOptions = { title: 'Save a copy', defaultPath: defaultName, buttonLabel: 'Save' }
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        return res.canceled || !res.filePath ? null : res.filePath
      }
    })
  })
}
