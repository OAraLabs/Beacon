import { IPC } from '@shared/ipc'
import { noChatProjects, refusal, validOp, type ChatProjectsResult, type ChatProjectsState } from '@shared/chat-projects'
import type { ChatProjectsHub } from './chat-projects'
import { handleFromShell } from './shell-windows'

/** The window's two ways in: what main knows, and one change. `current` is the hub of the connection Beacon is on now (null before
 *  there is one): a change the window sends is made on that Prometheus and no other. */
export function registerChatProjectsHandlers(current: () => ChatProjectsHub | null): void {
  handleFromShell(IPC.CHAT_PROJECTS_STATE, (): ChatProjectsState => current()?.state() ?? noChatProjects())
  handleFromShell(IPC.CHAT_PROJECTS_DO, async (_e, raw: unknown): Promise<ChatProjectsResult> => {
    // A bad request is never forwarded: it is refused here, in the same words as any other that didn't work.
    const op = validOp(raw)
    if (!op) return refusal(400, null)
    const hub = current()
    return hub ? hub.run(op) : refusal(404, null)
  })
}
