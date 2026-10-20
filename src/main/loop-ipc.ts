import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { IPC } from '@shared/ipc'
import { extractDaemonError, type LoopFileRead, type LoopFileWrite } from '@shared/loop'
import { loadLoopProjects, saveLoopProjects } from './loop-store'
import { isAllowedProjectFile } from './loop-fs'
import type { ConnectionManager } from './connection'
import { handleFromShell } from './shell-windows'

// Loop Manager IPC — registry CRUD + project-file read/write + a user-consented file picker.
// Project files route through the daemon's /api/project-file (Loop Manager remote-files): a REMOTE
// Beacon (e.g. on a Mac) edits TASKS.md/LOOP.md/PROGRESS.md that live on the daemon host. The daemon
// is the AUTHORITY (it re-validates the git repo + the narrow basename/top-level scope);
// isAllowedProjectFile stays as a fast CLIENT-side pre-check for instant feedback on obvious
// mistakes. The picker stays local — the dialog is the user's consent to read one local file.

export interface LoopIpcDeps {
  /** Absolute path to the registry JSON (join(userData, 'loop-projects.json')). */
  projectsFile: () => string
  /** The window to parent the file dialog to (or null before a window exists). */
  getWindow: () => BrowserWindow | null
  /** The live daemon connection — project files route through it. Null before a connection exists. */
  getConnection: () => ConnectionManager | null
}

const PICK_OPTS: OpenDialogOptions = {
  title: 'Choose a Markdown contract',
  properties: ['openFile'],
  filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
}

/** Current registered roots — re-read per call so a just-added project's files are reachable. */
function currentRoots(file: string): string[] {
  return loadLoopProjects(file).map((p) => p.rootPath)
}

/** Pull the daemon's specific `{ "error": … }` out of a thrown rest error
 * (`HTTP 400: PUT /api/project-file — {json}`) so the UI shows the real reason ("not a git
 * repository …") rather than the raw HTTP string. Falls back to the message itself. */
function daemonError(e: unknown): string {
  return extractDaemonError(e instanceof Error ? e.message : String(e))
}

export function registerLoopHandlers(deps: LoopIpcDeps): void {
  handleFromShell(IPC.LOOP_PROJECTS_GET, async () => loadLoopProjects(deps.projectsFile()))
  handleFromShell(IPC.LOOP_PROJECTS_SET, async (_e, projects: unknown) =>
    saveLoopProjects(deps.projectsFile(), projects)
  )

  // Read/write route through the daemon (/api/project-file) — co-located with the project repos.
  // Pre-check locally (fast), then let the daemon re-validate (authority) and surface its SPECIFIC
  // error verbatim. A read 404 is re-tagged ENOENT so the renderer's isMissing() shows "Create".
  handleFromShell(IPC.LOOP_FILE_READ, async (_e, path: string): Promise<LoopFileRead> => {
    if (!isAllowedProjectFile(currentRoots(deps.projectsFile()), path)) {
      throw new Error('path is not an allowed project file under a registered root')
    }
    const conn = deps.getConnection()
    if (!conn) throw new Error('not connected to the daemon')
    const query = `repo=${encodeURIComponent(dirname(path))}&name=${encodeURIComponent(basename(path))}`
    try {
      return (await conn.getDaemon(`/api/project-file?${query}`)) as LoopFileRead
    } catch (e) {
      if (e instanceof Error && e.message.includes('HTTP 404')) {
        throw new Error(`ENOENT: ${daemonError(e)}`)
      }
      throw new Error(daemonError(e))
    }
  })

  handleFromShell(
    IPC.LOOP_FILE_WRITE,
    async (_e, req: { path: string; content: string }): Promise<LoopFileWrite> => {
      if (!isAllowedProjectFile(currentRoots(deps.projectsFile()), req.path)) {
        throw new Error('path is not an allowed project file under a registered root')
      }
      const conn = deps.getConnection()
      if (!conn) throw new Error('not connected to the daemon')
      try {
        return (await conn.writeDaemon(
          '/api/project-file',
          { repo: dirname(req.path), name: basename(req.path), content: req.content },
          'PUT'
        )) as LoopFileWrite
      } catch (e) {
        throw new Error(daemonError(e))
      }
    }
  )

  // The picker reads ANY file the user explicitly chose (the dialog is the consent) — local + read-
  // only. Loading it AS a project's LOOP.md then goes through the daemon write path above.
  handleFromShell(IPC.LOOP_FILE_PICK, async () => {
    const win = deps.getWindow()
    const res = win ? await dialog.showOpenDialog(win, PICK_OPTS) : await dialog.showOpenDialog(PICK_OPTS)
    if (res.canceled || res.filePaths.length === 0) return null
    const path = res.filePaths[0]
    return { path, name: basename(path), content: readFileSync(path, 'utf8') }
  })

  console.log('[loop] handlers registered (registry + daemon-routed project files)')
}
