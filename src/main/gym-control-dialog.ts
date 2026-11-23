// The Promote / Roll back confirmation: a window the OS draws, so nothing on the page can stand in for it, press it or restyle it.
// What it says comes from the plan main holds (@shared/gym-control confirmationText), never from text the page sent.
//
//   * CANCEL IS THE DEFAULT. Return and Space choose it; confirming takes a deliberate click on the action's own button.
//   * Escape cancels. Closing the window cancels. Nothing here times out into a yes.
import { dialog, type BrowserWindow } from 'electron'

export async function confirmationDialog(c: { title: string; button: string; detail: string }, parent: BrowserWindow | null): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: c.title,
    message: c.title,
    detail: c.detail,
    buttons: ['Cancel', c.button],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  try {
    const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return r.response === 1
  } catch {
    return false
  }
}
